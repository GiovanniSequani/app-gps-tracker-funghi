"""Bounded public ICON downloads. Forecast data never enter official directories."""
from __future__ import annotations

import bz2
import hashlib
import json
import re
import shutil
import time
from contextlib import contextmanager
from pathlib import Path

import numpy as np
import pandas as pd
import requests
import xarray as xr
from scipy.spatial import cKDTree

ITALY = "https://meteohub.agenziaitaliameteo.it/nwp/ICON-2I_SURFACE_PRESSURE_LEVELS/"
DWD = "https://opendata.dwd.de/weather/nwp/icon-eu/grib/"
VARIABLES = {"T_2M": "temperature", "TD_2M": "dewpoint", "TOT_PREC": "rain", "VMAX_10M": "gust"}


def archived_weather(root: Path | None, day: str, issued=None):
    """Verified completed forecast day for official and forecast composition alike."""
    from backend.src.meteo.time_series import SCORING_WEATHER_VARIABLES, CANONICAL_UNITS
    from backend.src.publication.common import sha256_file
    issued = pd.Timestamp.now(tz="UTC") if issued is None else issued
    if root is None or not root.exists():
        return None, None
    for directory in sorted(root.iterdir(), reverse=True):
        manifest_path = directory / "manifest.json"
        if not re.fullmatch(r"\d{8}T\d{6}Z", directory.name) or not manifest_path.is_file():
            continue
        manifest = json.loads(manifest_path.read_text())
        if day not in manifest["dates"] or pd.Timestamp(manifest["issued_at"]) >= issued:
            continue
        path = directory / f"weather_{day}.nc"
        expected = manifest.get("local_weather_sha256", {}).get(day)
        if not path.exists() or not expected or sha256_file(path) != expected:
            continue
        with xr.open_dataset(path) as ds:
            if ds.sizes.get("time") != 1 or str(ds.time.values[0])[:10] != day:
                raise ValueError("forecast fallback day mismatch")
            if any(ds[name].attrs.get("units") != CANONICAL_UNITS[name] for name in SCORING_WEATHER_VARIABLES):
                raise ValueError("forecast fallback units mismatch")
            if not all(np.isfinite(ds[name]).any() for name in SCORING_WEATHER_VARIABLES):
                continue
            result = ds[list(SCORING_WEATHER_VARIABLES)].load()
        quality = next(q for q in manifest["quality"] if q["date"] == day)
        return result, {"version": manifest["version"], "issued_at": manifest["issued_at"],
                        "models": {k: v["run"] for k, v in manifest["models"].items()},
                        "gust_partial": quality.get("gust_partial", True)}
    return None, None


class Downloads:
    def __init__(self, root: Path, max_bytes: int = 900_000_000):
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        self.max_bytes = max_bytes
        self.bytes = 0
        self.session = requests.Session()

    def listing(self, url: str) -> list[str]:
        for attempt in range(3):
            try:
                response = self.session.get(url, timeout=(10, 60))
                response.raise_for_status()
                return re.findall(r'href="([^"?]+)"', response.text)
            except requests.RequestException:
                if attempt == 2:
                    raise
                time.sleep(2 ** attempt)
        raise AssertionError("unreachable")

    def get(self, url: str, byte_range=None) -> Path:
        path = self.root / (hashlib.sha256((url + str(byte_range)).encode()).hexdigest()[:20] + ".grib")
        if path.exists():
            return path
        temp = path.with_suffix(".part")
        for attempt in range(3):
            try:
                headers = {"Range": f"bytes={byte_range[0]}-{byte_range[1]}"} if byte_range else {}
                with self.session.get(url, stream=True, headers=headers, timeout=(10, 90)) as response:
                    response.raise_for_status()
                    if byte_range and (response.status_code != 206 or not response.headers.get("Content-Range", "").startswith(f"bytes {byte_range[0]}-{byte_range[1]}/")):
                        raise ValueError("server ignored GRIB byte range; full download forbidden")
                    with temp.open("wb") as stream:
                        for block in response.iter_content(1024 * 1024):
                            self.bytes += len(block)
                            if self.bytes > self.max_bytes:
                                raise ValueError("forecast download budget exceeded")
                            stream.write(block)
                temp.replace(path)
                return path
            except (requests.RequestException, OSError):
                temp.unlink(missing_ok=True)
                if attempt == 2:
                    raise
                time.sleep(2 ** attempt)
        raise AssertionError("unreachable")


def local_hours(day: str) -> pd.DatetimeIndex:
    """Interval END timestamps for one civil day (23/24/25 hours)."""
    start = pd.Timestamp(day).tz_localize("Europe/Rome")
    end = (pd.Timestamp(day) + pd.Timedelta(days=1)).tz_localize("Europe/Rome")
    return pd.date_range(start, end, freq="h", inclusive="right").tz_convert("UTC")


def relative_humidity(temperature: np.ndarray, dewpoint: np.ndarray) -> np.ndarray:
    # Magnus over water; input degrees C, output percent.
    return (100 * np.exp(17.625 * dewpoint / (243.04 + dewpoint)
                         - 17.625 * temperature / (243.04 + temperature))).clip(0, 100)


def deaccumulate(current, previous, hours):
    delta = current - previous
    if hours <= 0 or np.any(delta < -0.05):
        raise ValueError("invalid accumulation interval or reset within model run")
    return np.maximum(delta, 0) / hours


def nearest_indices(lat, lon, target_lat, target_lon):
    # Regional metric, no smoothing/downscaling: repeated native weather cells.
    factor = np.cos(np.deg2rad(np.mean(target_lat)))
    xx, yy = np.meshgrid(target_lon, target_lat)
    distance, index = cKDTree(np.column_stack([lon * factor, lat])).query(
        np.column_stack([xx.ravel() * factor, yy.ravel()]))
    if float(distance.max()) > 0.20:
        raise ValueError("source grid does not cover target domain")
    return index.reshape(len(target_lat), len(target_lon))


@contextmanager
def grib_stream(path):
    with path.open("rb") as header:
        compressed = header.read(3) == b"BZh"
    decoded = path.with_suffix(".decoded")
    try:
        if compressed:
            with bz2.open(path, "rb") as source, decoded.open("wb") as target:
                shutil.copyfileobj(source, target, 1024 * 1024)
        with (decoded if compressed else path).open("rb") as stream:
            yield stream
    finally:
        decoded.unlink(missing_ok=True)


def decode(path: Path, run: str, bbox: tuple, variable: str):
    """Decode one message at a time, retaining only a regional native subset."""
    import eccodes as ec
    records, selected, lat, lon = [], None, None, None
    with grib_stream(path) as stream:
        while header := stream.read(16):
            if len(header) != 16 or header[:4] != b"GRIB" or header[7] != 2:
                raise ValueError("invalid GRIB2 message header")
            size = int.from_bytes(header[8:16], "big")
            if not 16 < size <= 32_000_000:
                raise ValueError("oversized GRIB message")
            body = stream.read(size - 16)
            if len(body) != size - 16:
                raise ValueError("truncated GRIB message")
            gid = ec.codes_new_from_message(header + body)
            try:
                ec.codes_set(gid, "stepUnits", 1)  # normalize providers encoding leads in minutes
                keys = {key: ec.codes_get(gid, key) for key in
                        ("dataDate", "dataTime", "startStep", "endStep", "stepType", "units", "gridType")}
                actual = f"{keys['dataDate']:08d}{keys['dataTime']:04d}"[:10]
                if actual != run:
                    raise ValueError(f"GRIB run mismatch: expected {run}, got {actual}")
                if ec.codes_get(gid, "stepUnits") != 1:
                    raise ValueError("only hour GRIB step units supported")
                if selected is None:
                    lat_all = ec.codes_get_array(gid, "latitudes")
                    lon_all = (ec.codes_get_array(gid, "longitudes") + 180) % 360 - 180
                    west, south, east, north = bbox
                    selected = np.flatnonzero((lat_all >= south - .15) & (lat_all <= north + .15)
                                             & (lon_all >= west - .15) & (lon_all <= east + .15))
                    if not selected.size:
                        raise ValueError("empty source subset")
                    lat, lon = lat_all[selected], lon_all[selected]
                values = ec.codes_get_values(gid)[selected].astype("float32")
                missing = ec.codes_get(gid, "missingValue")
                values[values == missing] = np.nan
                if variable in ("temperature", "dewpoint"):
                    if keys["units"] != "K":
                        raise ValueError("unexpected temperature unit")
                    values -= np.float32(273.15)
                elif variable == "gust":
                    if keys["units"] not in ("m s**-1", "m s-1"):
                        raise ValueError("unexpected gust unit")
                    values *= np.float32(3.6)
                elif variable == "rain":
                    if keys["units"] not in ("kg m**-2", "kg m-2", "mm", "m") or keys["stepType"] != "accum":
                        raise ValueError("expected accumulated precipitation in mm equivalent")
                    if keys["units"] == "m":
                        values *= np.float32(1000)
                    if keys["startStep"] != 0:
                        raise ValueError("precipitation must accumulate from model initialization")
                elif variable == "humidity" and keys["units"] != "%":
                    raise ValueError("unexpected relative humidity unit")
                records.append((keys, values))
            finally:
                ec.codes_release(gid)
    return lat, lon, records


def discover(downloads: Downloads, issued: pd.Timestamp):
    runs = sorted(x.strip("/") for x in downloads.listing(ITALY) if re.fullmatch(r"\d{10}/", x))
    eligible = [r for r in runs if pd.to_datetime(r, format="%Y%m%d%H", utc=True) <= issued]
    if not eligible:
        raise ValueError("no ICON-2I run available")
    italy = eligible[-1]
    files = downloads.listing(DWD + "00/t_2m/")
    matches = [re.search(r"_(\d{10})_120_T_2M", name) for name in files]
    runs = sorted({m[1] for m in matches if m})
    if not runs:
        raise ValueError("no ICON-EU 00 UTC run available through 120 hours")
    for run in (italy, runs[-1]):
        age = issued - pd.to_datetime(run, format="%Y%m%d%H", utc=True)
        if age < pd.Timedelta(0) or age > pd.Timedelta(hours=36):
            raise ValueError("forecast model run is stale or future")
    return italy, runs[-1]


def load_model(downloads: Downloads, model: str, run: str, bbox: tuple,
               first_lead: int = 0, last_lead: int = 120) -> xr.Dataset:
    output = downloads.root / f"{model}-{run}-{first_lead}-{last_lead}-v2.nc"
    if output.exists():
        return xr.load_dataset(output)
    variables = VARIABLES if model == "icon2i" else {
        "T_2M": "temperature", "RELHUM_2M": "humidity", "TOT_PREC": "rain", "VMAX_10M": "gust"}
    arrays, evidence, grid, common_leads = {}, {}, None, None
    download_start = downloads.bytes
    for raw_name, variable in variables.items():
        if model == "icon2i":
            base = f"{ITALY}{run}/{raw_name}/"
            urls = [base + name for name in downloads.listing(base) if name.endswith(".grib")]
            if len(urls) != 1:
                raise ValueError(f"expected exactly one ICON-2I surface file for {raw_name}")
        else:
            base = f"{DWD}{run[-2:]}/{raw_name.lower()}/"
            urls = []
            for name in downloads.listing(base):
                match = re.search(rf"_{run}_(\d{{3}})_{raw_name}\.grib2.bz2$", name)
                if match and first_lead <= int(match[1]) <= last_lead:
                    urls.append(base + name)
            urls.sort()
        records = []
        for number, url in enumerate(urls, 1):
            path = downloads.get(url)
            lat, lon, decoded = decode(path, run, bbox, variable)
            if grid is None:
                grid = lat, lon
            elif not (np.array_equal(lat, grid[0]) and np.array_equal(lon, grid[1])):
                raise ValueError("GRIB variable grids differ")
            records.extend(decoded)
            path.unlink()  # retain only compact regional decoded cache
            if number % 10 == 0:
                print(f"[FORECAST DOWNLOAD] model={model} field={variable} files={number}/{len(urls)} bytes={downloads.bytes}", flush=True)
        if not records:
            raise ValueError(f"missing forecast field {raw_name}")
        records.sort(key=lambda record: record[0]["endStep"])
        leads = np.array([r[0]["endStep"] for r in records], dtype=int)
        if len(np.unique(leads)) != len(leads):
            raise ValueError("duplicate GRIB leads")
        if common_leads is not None and not np.array_equal(leads, common_leads):
            raise ValueError("forecast fields have different leads")
        common_leads = leads
        values = np.stack([r[1] for r in records])
        arrays[variable] = xr.DataArray(values, dims=("lead", "point"), coords={"lead": leads})
        if variable == "gust":
            if any(r[0]["stepType"] != "max" for r in records):
                raise ValueError("gust is not an interval maximum")
            arrays["gust_start"] = xr.DataArray([r[0]["startStep"] for r in records], dims="lead", coords={"lead": leads})
        evidence[variable] = {"first": records[0][0], "last": records[-1][0], "messages": len(records)}
        print(f"[FORECAST SOURCE] model={model} run={run} field={variable} leads={leads[0]}..{leads[-1]} native_points={len(lat)} downloaded_bytes={downloads.bytes}", flush=True)
    ds = xr.Dataset(arrays, coords={"latitude": ("point", grid[0]), "longitude": ("point", grid[1])})
    ds.attrs.update(model=model, run=run, evidence=json.dumps(evidence), download_bytes=downloads.bytes - download_start,
                    spacing_lat=float(np.median(np.diff(np.unique(grid[0])))), spacing_lon=float(np.median(np.diff(np.unique(grid[1])))))
    temporary = output.with_suffix(".building")
    ds.to_netcdf(temporary)
    temporary.replace(output)
    return ds


def hourly_model(ds: xr.Dataset) -> xr.Dataset:
    """Explicit temporal approximation of coarse steps; no spatial interpolation."""
    leads = ds.lead.values.astype(int)
    if np.any(np.diff(leads) > 3):
        raise ValueError("forecast has missing leads")
    hours = np.arange(leads[0] + 1, leads[-1] + 1)
    output = {}
    for var in ("temperature", "humidity", "dewpoint"):
        if var in ds:
            output[var] = ds[var].interp(lead=hours).values.astype("float32")
    rain, gust = [], []
    for left, right in zip(leads[:-1], leads[1:]):
        amount = deaccumulate(ds.rain.sel(lead=right).values, ds.rain.sel(lead=left).values, right - left)
        # Only retain hours actually covered by the GRIB gust interval.
        maximum = ds.gust.sel(lead=right).values
        start = int(ds.gust_start.sel(lead=right)) if "gust_start" in ds else left
        for hour in range(left + 1, right + 1):
            rain.append(amount)
            gust.append(maximum if hour > start else np.full_like(maximum, np.nan))
    output["rain"], output["gust"] = np.stack(rain), np.stack(gust)
    if "humidity" not in output:
        output["humidity"] = relative_humidity(output["temperature"], output.pop("dewpoint"))
    elif np.nanmin(output["humidity"]) >= -.01 and np.nanmax(output["humidity"]) <= 100.01:
        output["humidity"] = output["humidity"].clip(0, 100)  # GRIB packing tolerance
    times = pd.to_datetime(ds.attrs["run"], format="%Y%m%d%H") + pd.to_timedelta(hours, unit="h")
    result = xr.Dataset({k: (("valid_time", "point"), v) for k, v in output.items()},
                        coords={"valid_time": times, "latitude": ds.latitude, "longitude": ds.longitude}, attrs=ds.attrs)
    for name, limits in {"temperature": (-90, 65), "humidity": (0, 100), "rain": (0, 500), "gust": (0, 400)}.items():
        values = result[name].values
        if (name != "gust" and not np.isfinite(values).all()) or not np.isfinite(values).any() or np.nanmin(values) < limits[0] or np.nanmax(values) > limits[1]:
            raise ValueError(f"missing or physically invalid {name}")
    return result
