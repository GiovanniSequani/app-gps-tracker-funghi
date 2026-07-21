from __future__ import annotations

import argparse
import importlib
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import xarray as xr
from scipy.interpolate import griddata

from backend.config.domain import BBOX, TARGET_CRS, TARGET_STEP_DEG
from backend.config.meteo import INTERMEDIATE_METEO_DIR

download_ruc = importlib.import_module("backend.scripts.meteo.01_download_icon_d2_ruc_raw")
ICON_D2_RUC_DEFAULT_STEPS = download_ruc.ICON_D2_RUC_DEFAULT_STEPS
ICON_D2_RUC_RAW_DIR = download_ruc.ICON_D2_RUC_RAW_DIR
ICON_D2_RUC_RAW_VARIABLES = download_ruc.ICON_D2_RUC_RAW_VARIABLES
format_run = download_ruc.format_run
parse_run_yyyymmddhh = download_ruc.parse_run_yyyymmddhh
step_filename = download_ruc.step_filename

UTC = timezone.utc
EXPECTED_VARS = ("t2m", "rh2m", "gust10m", "precip", "tground", "smi9")
INTENSIVE_REGRID_METHOD = "linear"
PRECIP_REGRID_METHOD = "nearest"
DEFAULT_SMI9_SUPPORT_NC = INTERMEDIATE_METEO_DIR / "icon_d2_smi9_support.nc"


def build_target_grid(bbox: dict[str, float], step_deg: float) -> tuple[np.ndarray, np.ndarray]:
    west = bbox["west"]
    south = bbox["south"]
    east = bbox["east"]
    north = bbox["north"]
    width = int(round((east - west) / step_deg))
    height = int(round((north - south) / step_deg))
    lons = west + (np.arange(width, dtype=np.float64) + 0.5) * step_deg
    lats_desc = north - (np.arange(height, dtype=np.float64) + 0.5) * step_deg
    return lats_desc[::-1].copy().astype(np.float32), lons.astype(np.float32)


def load_target_grid(target_grid_nc: Path | None) -> tuple[np.ndarray, np.ndarray, str]:
    if target_grid_nc is not None and target_grid_nc.is_file():
        ds = xr.open_dataset(target_grid_nc)
        try:
            ds.load()
            if "lat" in ds.coords and "lon" in ds.coords:
                return (
                    ds["lat"].values.astype(np.float32),
                    ds["lon"].values.astype(np.float32),
                    str(target_grid_nc),
                )
        finally:
            ds.close()

    lats, lons = build_target_grid(BBOX, TARGET_STEP_DEG)
    return lats, lons, "project_bbox_target_grid"


def infer_step_deg(values: np.ndarray) -> np.float32:
    if values.size < 2:
        return np.float32(np.nan)
    diffs = np.diff(values.astype(np.float64))
    return np.float32(np.nanmedian(np.abs(diffs)))


def open_grib(path: Path) -> xr.Dataset:
    if not path.is_file():
        raise FileNotFoundError(f"File non trovato: {path}")
    ds = xr.open_dataset(path, engine="cfgrib", backend_kwargs={"indexpath": ""})
    try:
        ds.load()
        return ds.copy(deep=True)
    finally:
        ds.close()


def read_first_data_var(path: Path) -> tuple[str, xr.DataArray, xr.Dataset]:
    ds = open_grib(path)
    data_vars = list(ds.data_vars)
    if len(data_vars) != 1:
        raise RuntimeError(f"Attesa una sola variabile in {path}, trovate: {data_vars}")
    name = data_vars[0]
    return name, ds[name], ds


def read_values_1d(path: Path) -> tuple[np.ndarray, xr.Dataset, xr.DataArray]:
    _, da, ds = read_first_data_var(path)
    values = np.asarray(da.values).squeeze()
    if values.ndim != 1:
        raise RuntimeError(f"Attesa variabile RUC 1D su griglia non strutturata in {path}, shape={values.shape}")
    return values.astype(np.float32), ds, da


def normalize_geo_values(values: np.ndarray, is_lon: bool) -> np.ndarray:
    out = np.asarray(values, dtype=np.float64).copy()
    limit = 2 * np.pi + 0.1 if is_lon else np.pi + 0.1
    if np.nanmax(np.abs(out)) <= limit:
        out = np.degrees(out)
    if is_lon:
        out = np.where(out > 180.0, out - 360.0, out)
    return out.astype(np.float32)


def load_clat_clon(run_dir: Path) -> tuple[np.ndarray, np.ndarray]:
    lat, _, _ = read_values_1d(run_dir / "CLAT" / step_filename(0))
    lon, _, _ = read_values_1d(run_dir / "CLON" / step_filename(0))
    lat = normalize_geo_values(lat, is_lon=False)
    lon = normalize_geo_values(lon, is_lon=True)
    if lat.size != lon.size:
        raise RuntimeError(f"CLAT/CLON incompatibili: lat={lat.size}, lon={lon.size}")
    return lat, lon


def source_subset_mask(lat: np.ndarray, lon: np.ndarray, bbox: dict[str, float], margin_deg: float) -> np.ndarray:
    return (
        np.isfinite(lat)
        & np.isfinite(lon)
        & (lat >= bbox["south"] - margin_deg)
        & (lat <= bbox["north"] + margin_deg)
        & (lon >= bbox["west"] - margin_deg)
        & (lon <= bbox["east"] + margin_deg)
    )


def regrid_to_target(
    values: np.ndarray,
    lat: np.ndarray,
    lon: np.ndarray,
    source_mask: np.ndarray,
    target_lats: np.ndarray,
    target_lons: np.ndarray,
    method: str,
) -> np.ndarray:
    z = np.asarray(values, dtype=np.float64)
    valid = source_mask & np.isfinite(z)
    if np.count_nonzero(valid) < 3:
        raise RuntimeError("Punti sorgente validi insufficienti per il regridding RUC")

    lon2d, lat2d = np.meshgrid(target_lons, target_lats)
    points = np.column_stack([lon[valid], lat[valid]])
    interp = griddata(points, z[valid], (lon2d, lat2d), method=method)

    if method == "linear":
        nearest = griddata(points, z[valid], (lon2d, lat2d), method="nearest")
        interp = np.where(np.isfinite(interp), interp, nearest)

    return interp.astype(np.float32)


def infer_valid_time(ds: xr.Dataset, run_dt: datetime, step: int) -> datetime:
    expected = run_dt + timedelta(hours=step)
    if "valid_time" not in ds.coords:
        return expected
    raw = np.asarray(ds["valid_time"].values).ravel()[0]
    got = np.datetime64(raw).astype("datetime64[s]").tolist().replace(tzinfo=UTC)
    if abs((got - expected).total_seconds()) > 1:
        raise RuntimeError(f"valid_time inatteso per step {step}: cfgrib={got.isoformat()} atteso={expected.isoformat()}")
    return got


def ruc_file(run_dir: Path, var_key: str, step: int) -> Path:
    return run_dir / ICON_D2_RUC_RAW_VARIABLES[var_key] / step_filename(step)


def read_ruc_var(run_dir: Path, var_key: str, step: int) -> tuple[np.ndarray, xr.Dataset, xr.DataArray]:
    return read_values_1d(ruc_file(run_dir, var_key, step))


def load_smi9_from_support(
    support_path: Path,
    valid_times: list[np.datetime64],
    target_lats: np.ndarray,
    target_lons: np.ndarray,
    allow_missing: bool,
) -> np.ndarray:
    fill = np.full((len(valid_times), target_lats.size, target_lons.size), np.nan, dtype=np.float32)
    requested = np.asarray(valid_times, dtype="datetime64[s]")
    missing = [np.datetime_as_string(value, unit="s") + "Z" for value in requested]

    if not support_path.is_file():
        if allow_missing:
            print(f"[WARN] smi9 support non trovato: {support_path}. Uso NaN.")
            return fill
        raise FileNotFoundError(
            f"smi9 support non trovato: {support_path}. "
            "Esegui prima 02_extract_icon_d2_smi9_support.py o passa --allow-missing-smi9."
        )

    ds = xr.open_dataset(support_path)
    try:
        ds.load()
        if "smi9" not in ds or "valid_time" not in ds.coords:
            raise RuntimeError(f"smi9 support incompleto: {support_path}")
        if not np.array_equal(ds["lat"].values.astype(np.float32), target_lats):
            raise RuntimeError(f"Griglia lat smi9 support non coerente: {support_path}")
        if not np.array_equal(ds["lon"].values.astype(np.float32), target_lons):
            raise RuntimeError(f"Griglia lon smi9 support non coerente: {support_path}")

        available = ds["valid_time"].values.astype("datetime64[s]")
        missing = []
        for i, valid_time in enumerate(requested):
            matches = np.where(available == valid_time)[0]
            if not matches.size:
                missing.append(np.datetime_as_string(valid_time, unit="s") + "Z")
                continue
            values = ds["smi9"].isel(valid_time=int(matches[-1])).values.astype(np.float32)
            if not np.isfinite(values).all():
                missing.append(np.datetime_as_string(valid_time, unit="s") + "Z")
                continue
            fill[i] = values
    finally:
        ds.close()

    if missing and not allow_missing:
        preview = ", ".join(missing[:12])
        suffix = "..." if len(missing) > 12 else ""
        raise RuntimeError(f"smi9 support mancante/non finito per valid_time: {preview}{suffix}")
    if missing:
        preview = ", ".join(missing[:12])
        suffix = "..." if len(missing) > 12 else ""
        print(f"[WARN] smi9 mancante/non finito: {preview}{suffix}. Uso NaN.")
    return fill


def maybe_load_smi9_from_buffer(
    buffer_path: Path,
    valid_times: list[np.datetime64],
    target_lats: np.ndarray,
    target_lons: np.ndarray,
) -> np.ndarray:
    fill = np.full((len(valid_times), target_lats.size, target_lons.size), np.nan, dtype=np.float32)
    if not buffer_path.is_file():
        return fill

    ds = xr.open_dataset(buffer_path)
    try:
        ds.load()
        if "smi9" not in ds or "valid_time" not in ds.coords:
            return fill
        if not np.array_equal(ds["lat"].values.astype(np.float32), target_lats):
            return fill
        if not np.array_equal(ds["lon"].values.astype(np.float32), target_lons):
            return fill
        available = ds["valid_time"].values.astype("datetime64[s]")
        for i, valid_time in enumerate(np.asarray(valid_times, dtype="datetime64[s]")):
            matches = np.where(available == valid_time)[0]
            if matches.size:
                fill[i] = ds["smi9"].isel(valid_time=int(matches[-1])).values.astype(np.float32)
    finally:
        ds.close()
    return fill


def save_hourly_dataset(ds: xr.Dataset, out_path: Path, overwrite: bool) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.exists() and not overwrite:
        raise FileExistsError(f"Output gia' esistente: {out_path}. Usa --overwrite per sovrascrivere.")
    encoding: dict[str, dict] = {
        "valid_time": {"dtype": "i8"},
        "lat": {"dtype": "f4"},
        "lon": {"dtype": "f4"},
    }
    for var_name in EXPECTED_VARS:
        encoding[var_name] = {"zlib": True, "complevel": 4, "dtype": "f4"}
    ds.to_netcdf(out_path, encoding=encoding)


def main() -> None:
    parser = argparse.ArgumentParser(description="Estrae campi orari ICON-D2-RUC sulla griglia target del progetto.")
    parser.add_argument("--run", required=True, help="Run target YYYYmmddHH")
    parser.add_argument("--steps", nargs="+", type=int, default=None, help=f"Lead orari. Default: {list(ICON_D2_RUC_DEFAULT_STEPS)}")
    parser.add_argument("--raw-dir", default=str(ICON_D2_RUC_RAW_DIR))
    parser.add_argument("--out", default=None)
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--smi9-support-nc", default=str(DEFAULT_SMI9_SUPPORT_NC))
    parser.add_argument("--allow-missing-smi9", action="store_true", help="Permette NaN in smi9. Solo per debug.")
    parser.add_argument(
        "--allow-buffer-smi9-fallback",
        action="store_true",
        help="Usa smi9 dal buffer esistente per i valid_time mancanti nel supporto D2.",
    )
    parser.add_argument("--smi9-buffer-nc", default=str(INTERMEDIATE_METEO_DIR / "hourly_buffer.nc"))
    parser.add_argument(
        "--target-grid-nc",
        default=str(INTERMEDIATE_METEO_DIR / "hourly_buffer.nc"),
        help="NetCDF da cui copiare esattamente lat/lon target. Default: hourly_buffer.nc.",
    )
    args = parser.parse_args()

    run_dt = parse_run_yyyymmddhh(args.run)
    run_str = format_run(run_dt)
    run_dir = Path(args.raw_dir) / run_str
    steps = sorted(set(args.steps or ICON_D2_RUC_DEFAULT_STEPS))
    if not steps:
        raise RuntimeError("Nessun lead time richiesto")

    target_lats, target_lons, target_grid_source = load_target_grid(Path(args.target_grid_nc) if args.target_grid_nc else None)
    lat, lon = load_clat_clon(run_dir)
    mask = source_subset_mask(lat, lon, BBOX, margin_deg=max(0.08, TARGET_STEP_DEG * 8))
    if np.count_nonzero(mask) < 3:
        raise RuntimeError("Nessun punto RUC sufficiente nel BBOX del progetto")

    print("ICON-D2-RUC EXTRACT HOURLY FIELDS")
    print(
        f"run={run_str} steps={steps} target_grid={target_lats.size}x{target_lons.size} "
        f"target_source={target_grid_source} source_points={np.count_nonzero(mask)}"
    )

    time_list: list[np.datetime64] = []
    t2m_list: list[np.ndarray] = []
    rh2m_list: list[np.ndarray] = []
    gust_list: list[np.ndarray] = []
    precip_cumulative: list[np.ndarray] = []
    tground_list: list[np.ndarray] = []

    for step in steps:
        t2m_raw, t2m_ds, _ = read_ruc_var(run_dir, "t2m", step)
        rh_raw, rh_ds, _ = read_ruc_var(run_dir, "rh2m", step)
        gust_raw, gust_ds, _ = read_ruc_var(run_dir, "gust10m", step)
        precip_raw, precip_ds, _ = read_ruc_var(run_dir, "precip", step)
        tground_raw, tg_ds, _ = read_ruc_var(run_dir, "tground", step)

        vt = infer_valid_time(t2m_ds, run_dt, step)
        for label, ds in (("rh2m", rh_ds), ("gust10m", gust_ds), ("precip", precip_ds), ("tground", tg_ds)):
            other_vt = infer_valid_time(ds, run_dt, step)
            if other_vt != vt:
                raise RuntimeError(f"valid_time incoerente per {label} step={step}: {other_vt} != {vt}")

        time_list.append(np.datetime64(vt.replace(tzinfo=None), "s"))
        t2m_list.append(regrid_to_target(t2m_raw, lat, lon, mask, target_lats, target_lons, INTENSIVE_REGRID_METHOD) - np.float32(273.15))
        rh = regrid_to_target(rh_raw, lat, lon, mask, target_lats, target_lons, INTENSIVE_REGRID_METHOD)
        rh2m_list.append(np.clip(rh, 0.0, 100.0).astype(np.float32))
        gust = regrid_to_target(gust_raw, lat, lon, mask, target_lats, target_lons, INTENSIVE_REGRID_METHOD) * np.float32(3.6)
        gust_list.append(np.maximum(gust, 0.0).astype(np.float32))
        precip_cumulative.append(precip_raw.astype(np.float32))
        tground_list.append(regrid_to_target(tground_raw, lat, lon, mask, target_lats, target_lons, INTENSIVE_REGRID_METHOD) - np.float32(273.15))
        print(f"  step={step:03d} valid_time={vt.isoformat()}")

    precip_list: list[np.ndarray] = []
    previous_cumulative: np.ndarray | None = None
    if steps[0] > 0:
        previous_cumulative, _, _ = read_ruc_var(run_dir, "precip", steps[0] - 1)

    for index, cumulative in enumerate(precip_cumulative):
        if index == 0 and previous_cumulative is None:
            hourly_native = cumulative.copy()
        elif index == 0:
            hourly_native = cumulative - previous_cumulative
        else:
            hourly_native = cumulative - precip_cumulative[index - 1]
        hourly_native = np.maximum(hourly_native, 0.0)
        hourly = regrid_to_target(hourly_native, lat, lon, mask, target_lats, target_lons, PRECIP_REGRID_METHOD)
        precip_list.append(np.maximum(hourly, 0.0).astype(np.float32))

    try:
        smi9_data = load_smi9_from_support(
            Path(args.smi9_support_nc),
            time_list,
            target_lats,
            target_lons,
            allow_missing=args.allow_missing_smi9,
        )
        smi9_note = f"filled from ICON-D2 smi9 support file {Path(args.smi9_support_nc)}"
    except (FileNotFoundError, RuntimeError):
        if not args.allow_buffer_smi9_fallback:
            raise
        smi9_data = maybe_load_smi9_from_buffer(Path(args.smi9_buffer_nc), time_list, target_lats, target_lons)
        if not args.allow_missing_smi9 and not np.isfinite(smi9_data).all():
            raise RuntimeError(
                "smi9 fallback dal buffer incompleto. "
                "Esegui il supporto D2 esteso oppure passa --allow-missing-smi9."
            )
        smi9_note = "filled from existing hourly buffer fallback because ICON-D2 support file was not complete."

    ds_out = xr.Dataset(
        data_vars={
            "t2m": (("valid_time", "lat", "lon"), np.stack(t2m_list).astype(np.float32)),
            "rh2m": (("valid_time", "lat", "lon"), np.stack(rh2m_list).astype(np.float32)),
            "gust10m": (("valid_time", "lat", "lon"), np.stack(gust_list).astype(np.float32)),
            "precip": (("valid_time", "lat", "lon"), np.stack(precip_list).astype(np.float32)),
            "tground": (("valid_time", "lat", "lon"), np.stack(tground_list).astype(np.float32)),
            "smi9": (("valid_time", "lat", "lon"), smi9_data),
        },
        coords={
            "valid_time": np.array(time_list, dtype="datetime64[s]"),
            "lat": target_lats,
            "lon": target_lons,
        },
        attrs={
            "title": "ICON-D2-RUC hourly fields extracted on project target grid",
            "summary": "Intermediate hourly dataset built from DWD ICON-D2-RUC unstructured GRIB2 files.",
            "source": "DWD ICON-D2-RUC open data + DWD ICON-D2 smi9 support",
            "run_time_utc": run_dt.isoformat(),
            "target_crs": TARGET_CRS,
            "target_grid_source": target_grid_source,
            "target_lat_step_deg": infer_step_deg(target_lats),
            "target_lon_step_deg": infer_step_deg(target_lons),
            "bbox_south": np.float32(BBOX["south"]),
            "bbox_north": np.float32(BBOX["north"]),
            "bbox_west": np.float32(BBOX["west"]),
            "bbox_east": np.float32(BBOX["east"]),
            "regrid_intensive_method": INTENSIVE_REGRID_METHOD,
            "regrid_precip_method": PRECIP_REGRID_METHOD,
            "precip_mode": "native_cumulative_decumulated_then_nearest_to_target",
            "smi9_mode": smi9_note,
            "created_utc": datetime.now(UTC).isoformat(),
        },
    )
    ds_out = ds_out.sortby("valid_time")
    if np.unique(ds_out["valid_time"].values.astype("datetime64[s]")).size != ds_out.sizes["valid_time"]:
        raise RuntimeError("valid_time duplicati nell'output RUC")

    ds_out["valid_time"].attrs.update(long_name="forecast valid time", timezone="UTC")
    ds_out["lat"].attrs.update(long_name="latitude", units="degrees_north")
    ds_out["lon"].attrs.update(long_name="longitude", units="degrees_east")
    ds_out["t2m"].attrs.update(long_name="2 m air temperature", units="degC")
    ds_out["rh2m"].attrs.update(long_name="2 m relative humidity", units="%")
    ds_out["gust10m"].attrs.update(long_name="10 m maximum wind gust", units="km h-1")
    ds_out["precip"].attrs.update(long_name="hourly precipitation for the last hour", units="mm")
    ds_out["tground"].attrs.update(long_name="ground surface temperature", units="degC")
    ds_out["smi9"].attrs.update(long_name="soil moisture index, soil level 9", units="1", note=smi9_note)

    out_path = Path(args.out) if args.out else INTERMEDIATE_METEO_DIR / f"icon_d2_ruc_hourly_{run_str}.nc"
    save_hourly_dataset(ds_out, out_path, overwrite=args.overwrite)
    print(f"[OK] RUC hourly written: {out_path}")
    print(f"     valid_time={str(ds_out['valid_time'].values[0])}..{str(ds_out['valid_time'].values[-1])} grid={ds_out.sizes['lat']}x{ds_out.sizes['lon']}")


if __name__ == "__main__":
    main()
