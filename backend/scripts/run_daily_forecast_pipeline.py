"""Independent porcini forecast: local build by default, explicit remote opt-in."""
from __future__ import annotations

import argparse
import importlib
import json
import re
import shutil
import time
import zlib
from contextlib import ExitStack
from pathlib import Path

import numpy as np
import pandas as pd
import xarray as xr

from backend.config.index_config import INDEX_FEATURE_WINDOW_DAYS, RECOVERY_LOOKBACK_DAYS
from backend.config.paths import BACKEND_DIR, FINAL_METEO_DIR, FINAL_STATIC_DIR, OUT_INDEX_NC_DIR
from backend.src.forecast.weather import Downloads, discover, hourly_model, load_model, local_hours, nearest_indices, archived_weather
from backend.src.index.features import build_feature_dataset
from backend.src.index.scoring import compute_all_indices
from backend.src.meteo.time_series import compose_weather_window, SCORING_WEATHER_VARIABLES, CANONICAL_UNITS
from backend.src.publication.common import canonical_json_bytes, sha256_file

ROOT = BACKEND_DIR / "outputs" / "forecast"
CACHE = BACKEND_DIR / "data" / "forecast" / "cache"
BBOX = (10.4, 45.6, 12.5, 47.1)


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".building")
    temp.write_bytes(canonical_json_bytes(data))
    temp.replace(path)


def save_nc(ds, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".building")
    ds.to_netcdf(temporary, encoding={v: {"zlib": True, "complevel": 3} for v in ds.data_vars})
    temporary.replace(path)


def finite_range(values):
    values = np.asarray(values)
    finite = values[np.isfinite(values)]
    return [float(finite.min()), float(finite.max())] if finite.size else [None, None]


def model_overlap(models, lat, lon):
    short, long = models["icon2i"], models["iconeu"]
    common = np.intersect1d(short.valid_time.values, long.valid_time.values)
    if not len(common):
        return {"hours": 0}
    # Quantify same-valid-time differences, not a misleading consecutive-hour jump.
    maps = [nearest_indices(ds.latitude.values, ds.longitude.values, lat[::6], lon[::6]) for ds in (short, long)]
    result = {"hours": len(common), "sampling_stride": 6}
    for name in ("temperature", "humidity", "rain", "gust"):
        differences = []
        for timestamp in common:
            delta = long[name].sel(valid_time=timestamp).values[maps[1]] - short[name].sel(valid_time=timestamp).values[maps[0]]
            differences.extend(delta[np.isfinite(delta)].tolist())
        result[name] = {"mean_delta": float(np.mean(differences)), "mean_abs_delta": float(np.mean(np.abs(differences))), "max_abs_delta": float(np.max(np.abs(differences)))} if differences else None
    return result


def daily_forecast(day, issued, models, ruc, lat, lon):
    hours = local_hours(day)
    naive = hours.tz_localize(None).values
    available = {name: set(ds.valid_time.values) for name, ds in models.items()}
    # Prefer the short model for a whole day; do not splice model accumulations.
    chosen = "icon2i" if naive[-1] in available["icon2i"] else "iconeu"
    maps = {name: nearest_indices(ds.latitude.values, ds.longitude.values, lat, lon) for name, ds in models.items()}
    ruc_map = nearest_indices(*[a.ravel() for a in np.meshgrid(ruc.lat.values, ruc.lon.values, indexing="ij")], lat, lon)
    ruc_times = set(ruc.valid_time.values)
    shape = (len(lat), len(lon))
    sums = {k: np.zeros(shape, dtype="float32") for k in ("temperature", "humidity", "rain")}
    minima = {k: np.full(shape, np.inf, dtype="float32") for k in ("temperature", "humidity")}
    maxima = {k: np.full(shape, -np.inf, dtype="float32") for k in ("temperature", "gust")}
    valid = np.ones(shape, dtype=bool)
    counts = {"ruc": 0, "icon2i": 0, "iconeu": 0, "missing": 0}
    gust_hours = 0
    for timestamp in naive:
        if timestamp in ruc_times:
            source = "ruc"
            frame = ruc.sel(valid_time=timestamp)
            values = {out: frame[name].values.ravel()[ruc_map] for out, name in
                      (("temperature", "t2m"), ("humidity", "rh2m"), ("rain", "precip"), ("gust", "gust10m"))}
        else:
            source = chosen
            if timestamp not in available[source] and timestamp in available.get("icon2i_previous", set()):
                source = "icon2i_previous"
            if timestamp not in available[source]:
                counts["missing"] += 1
                valid[:] = False
                continue
            frame = models[source].sel(valid_time=timestamp)
            values = {name: frame[name].values[maps[source]] for name in ("temperature", "humidity", "rain", "gust")}
        counts[source] = counts.get(source, 0) + 1
        for name, value in values.items():
            if name == "gust":
                gust_hours += int(np.isfinite(value).all())
                maxima[name] = np.fmax(maxima[name], value)
                continue
            valid &= np.isfinite(value)
            if name in sums:
                sums[name] += value
            if name in minima:
                minima[name] = np.minimum(minima[name], value)
            if name in maxima:
                maxima[name] = np.maximum(maxima[name], value)
    arrays = {"t2m_mean": sums["temperature"] / len(hours), "t2m_min": minima["temperature"],
              "t2m_max": maxima["temperature"], "precip_sum": sums["rain"],
              "rh_mean": sums["humidity"] / len(hours), "rh_min": minima["humidity"], "gust_max": np.where(np.isfinite(maxima["gust"]), maxima["gust"], np.nan)}
    ds = xr.Dataset({k: (("time", "lat", "lon"), np.where(valid, v, np.nan)[None]) for k, v in arrays.items()},
                    coords={"time": [np.datetime64(day)], "lat": lat, "lon": lon})
    for name, unit in CANONICAL_UNITS.items():
        if name in ds:
            ds[name].attrs["units"] = unit
    return ds, {"date": day, "expected_hours": len(hours), "hours_by_source": counts,
                "incomplete_cells": int((~valid).sum()), "model": chosen,
                "gust_covered_hours": gust_hours, "gust_partial": gust_hours < len(hours)}


def compose_forecast_window(day, root, current, issued, meteo_dir=FINAL_METEO_DIR):
    composite = compose_weather_window(day, INDEX_FEATURE_WINDOW_DAYS, meteo_dir, forecast_root=None)
    weather = composite[list(SCORING_WEATHER_VARIABLES)].drop_vars("weather_source")
    provenance = []
    for idx, timestamp in enumerate(weather.time.values):
        date = str(timestamp)[:10]
        source = int(composite.weather_source.values[idx])
        if source:
            provenance.append({"date": date, "source": "hrs" if source == 2 else "ruc"})
            continue
        path = current / f"weather_{date}.nc"
        if path.exists():
            with xr.open_dataset(path) as ds:
                daily = ds[list(SCORING_WEATHER_VARIABLES)].load()
            detail = {"source": "current_forecast"}
        else:
            daily, archive = archived_weather(root, date, issued)
            detail = {"source": "archived_forecast", "archive": archive} if archive else {"source": "missing"}
        if daily is not None:
            if not np.array_equal(daily.lat, weather.lat) or not np.array_equal(daily.lon, weather.lon):
                raise ValueError("archived forecast grid mismatch")
            for variable in SCORING_WEATHER_VARIABLES:
                weather[variable][idx] = daily[variable].values[0]
        provenance.append({"date": date, **detail})
    return weather, provenance


def score_day(day, weather, terrain, official, local):
    """Stripe scoring bounds scratch RAM, preserving the official formula exactly."""
    history_paths = []
    missing_history = []
    for lag in range(1, RECOVERY_LOOKBACK_DAYS + 1):
        previous = (pd.Timestamp(day) - pd.Timedelta(days=lag)).strftime("%Y-%m-%d")
        forecast = local / f"funghi_index_{previous}.nc"
        real = official / f"funghi_index_{previous}.nc"
        path = forecast if forecast.exists() else real
        if path.exists():
            history_paths.append((lag, path))
        else:
            missing_history.append(previous)
    result = []
    with ExitStack() as stack:
        history = [(lag, stack.enter_context(xr.open_dataset(path))) for lag, path in history_paths]
        for row in range(0, terrain.sizes["lat"], 50):
            region = {"lat": slice(row, row + 50)}
            features = build_feature_dataset(weather.isel(**region), terrain.isel(**region), day, INDEX_FEATURE_WINDOW_DAYS).load()
            previous = {"porcini": [(lag, ds.isel(**region).load()) for lag, ds in history]}
            output = compute_all_indices(features, ["porcini"], recovery_history=previous)
            result.append(output)
    return xr.concat(result, dim="lat"), missing_history


def package(directory, dates, report, max_zoom):
    tile = importlib.import_module("backend.scripts.tiles.01_build_tiles_gdal")
    tile_root = directory / "tiles"
    for day in dates:
        work = directory / "work" / day
        work.mkdir(parents=True, exist_ok=True)
        raw, color, palette = work / "raw.tif", work / "color.tif", work / "colors.txt"
        tile.write_colormap_file(palette)
        tile.translate_index_netcdf(directory / f"funghi_index_{day}.nc", "porcini", raw)
        tile.colorize_tif(raw, palette, color)
        tile.generate_xyz_tiles(color, tile_root / day / "porcini", list(range(3, max_zoom + 1)), 1)
        for path in (raw, color, palette):
            path.unlink()
    chunks = []
    with ExitStack() as stack:
        datasets = [stack.enter_context(xr.open_dataset(directory / f"funghi_index_{d}.nc")) for d in dates]
        lat, lon = datasets[0].lat.values, datasets[0].lon.values
        for row in range(0, len(lat), 50):
            for col in range(0, len(lon), 50):
                values = np.stack([ds.porcini_score.isel(lat=slice(row, row + 50), lon=slice(col, col + 50)).values
                                   for ds in datasets], axis=-1).astype("<f4")
                relative = f"chunks/r{row // 50:02d}_c{col // 50:02d}.bin.zlib"
                path = directory / relative
                path.parent.mkdir(exist_ok=True)
                path.write_bytes(zlib.compress(values.tobytes(), 6))
                assert zlib.decompress(path.read_bytes()) == values.tobytes()
                chunks.append({"path": relative, "rows": values.shape[0], "cols": values.shape[1],
                               "bytes": path.stat().st_size, "sha256": sha256_file(path)})
    tiles = [{"path": p.relative_to(tile_root).as_posix(), "bytes": p.stat().st_size, "sha256": sha256_file(p)}
             for p in sorted(tile_root.rglob("*.png"))]
    if not tiles:
        raise ValueError("empty forecast tiles")
    manifest = {"schema_version": 1, "version": directory.name, "issued_at": report["issued_at"],
                "valid_until": report["valid_until"], "dates": dates, "species": ["porcini"],
                "official_index_date": report["official_index_date"], "crs": "EPSG:4326", "bbox": dict(zip(("west", "south", "east", "north"), BBOX)),
                "rows": len(lat), "cols": len(lon), "step_deg": .003, "origin_lat": float(lat[0]), "origin_lon": float(lon[0]),
                "latitude_order": "ascending", "longitude_order": "ascending", "chunk_size": 50,
                "layout": "C-order [row,col,date]", "dtype": "<f4", "nodata": "NaN", "compression": "zlib",
                "units": "score 0..100", "chunks": chunks, "tiles": tiles, "tile_scheme": "xyz", "tile_zooms": [3, max_zoom],
                "tile_url_template": f"forecast-tiles/{directory.name}/{{date}}/porcini/{{z}}/{{x}}/{{y}}.png",
                "models": report["models"], "quality": report["days"],
                "model_overlap": report.get("model_overlap", {}),
                "local_weather_sha256": {day: sha256_file(directory / f"weather_{day}.nc") for day in dates},
                "weather_sampling": "nearest native cell; 0.003 degree is score/terrain grid, not weather resolution",
                "coarse_time_steps": "linear T/RH; uniform precipitation rate within each GRIB interval; gust maximum of available samples only, uncovered gust hours remain missing",
                "access": "public URLs; active-account gate is UI/product only, not RLS",
                "attribution": ["Fonte: Agenzia nazionale per la meteorologia e climatologia ItaliaMeteo / Arpae; CC BY 4.0", "ICON-EU: Deutscher Wetterdienst (DWD), dati modificati da FunghiTracker"]}
    write_json(directory / "manifest.json", manifest)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--horizon", type=int, default=4, help="last day offset +T, clipped to complete local days (0..4)")
    parser.add_argument("--max-zoom", type=int, default=11, choices=range(3, 14))
    parser.add_argument("--publish", action="store_true", help="remote writes; first publication requires explicit approval")
    parser.add_argument("--publish-existing", type=Path, help="publish a completed local version without rebuilding")
    parser.add_argument("--cleanup-only", action="store_true", help="retention only; add --publish for remote retention")
    parser.add_argument("--env-file", type=Path, default=BACKEND_DIR / ".env")
    args = parser.parse_args()
    if not 0 <= args.horizon <= 4:
        parser.error("horizon must be between 0 and 4")
    started = time.monotonic()
    issued = pd.Timestamp.now(tz="UTC").floor("s")
    today = issued.tz_convert("Europe/Rome").date()
    ROOT.mkdir(parents=True, exist_ok=True)
    # OS lock released automatically on crash, no stale lock-file recovery needed.
    from backend.src.forecast.publish import local_lock, cleanup_local
    with local_lock(ROOT / "pipeline.lock"):
        if args.publish_existing:
            from backend.src.forecast.publish import publish
            if args.publish_existing.resolve().parent != ROOT.resolve():
                raise ValueError("publish-existing must be a forecast generation directory")
            publish(args.publish_existing, args.env_file)
            return
        cleanup_local(ROOT, CACHE, issued)
        if args.cleanup_only:
            if args.publish:
                from backend.src.forecast.publish import cleanup_remote
                from backend.src.publication.supabase import SupabaseClient
                cleanup_remote(SupabaseClient.from_env(args.env_file))
            print("[FORECAST] retention complete; no forecast generated")
            return
        used = sum(p.stat().st_size for base in (ROOT, CACHE) if base.exists() for p in base.rglob("*") if p.is_file())
        if used > 2_000_000_000 or shutil.disk_usage(ROOT).free < 1_500_000_000:
            raise ValueError("forecast disk budget exceeded or less than 1.5 GB free")
        index_files = sorted(p for p in OUT_INDEX_NC_DIR.glob("funghi_index_*.nc") if re.fullmatch(r"funghi_index_\d{4}-\d{2}-\d{2}", p.stem)
                             and p.stem[-10:] <= today.isoformat())
        if not index_files:
            raise ValueError("no previous official index available")
        last = index_files[-1].stem[-10:]
        if (today - pd.Timestamp(last).date()).days > 7:
            raise ValueError("official index older than 7 days; refresh official inputs first")
        directory = ROOT / issued.strftime("%Y%m%dT%H%M%SZ")
        directory.mkdir()
        downloads = Downloads(CACHE)
        italy_run, eu_run = discover(downloads, issued)
        short = load_model(downloads, "icon2i", italy_run, BBOX)
        first_eu = max(0, int((pd.to_datetime(italy_run, format="%Y%m%d%H") + pd.Timedelta(hours=48)
                              - pd.to_datetime(eu_run, format="%Y%m%d%H")).total_seconds() / 3600) // 3 * 3)
        long = load_model(downloads, "iconeu", eu_run, BBOX, first_eu, 120)
        models = {"icon2i": hourly_model(short), "iconeu": hourly_model(long)}
        report = {"issued_at": issued.isoformat(), "official_index_date": last, "models": {
            name: {"run": ds.attrs["run"], "spacing_lat": ds.attrs["spacing_lat"], "spacing_lon": ds.attrs["spacing_lon"], "grib": json.loads(ds.attrs["evidence"])} for name, ds in models.items()}, "days": []}
        with xr.open_dataset(FINAL_STATIC_DIR / "terrain_static_003deg.nc") as terrain, xr.open_dataset(BACKEND_DIR / "data/intermediate/meteo/hourly_buffer.nc") as ruc:
            if terrain.sizes["lat"] != 500 or terrain.sizes["lon"] != 700 or not np.allclose(np.diff(terrain.lat), .003, atol=5e-6) or not np.allclose(np.diff(terrain.lon), .003, atol=5e-6):
                raise ValueError("unexpected terrain grid")
            expected = {"t2m": "degC", "rh2m": "%", "gust10m": "km h-1", "precip": "mm"}
            if any(ruc[name].attrs.get("units") != unit for name, unit in expected.items()):
                raise ValueError("RUC hourly units do not match contract")
            ruc_run = ruc.attrs.get("latest_run_time_utc")
            if ruc_run and pd.Timestamp(ruc_run) > issued:
                raise ValueError("RUC buffer comes from a future model run")
            covered = set(models["icon2i"].valid_time.values) | set(ruc.valid_time.values)
            missing_hours = [h for h in local_hours(today.isoformat()).tz_localize(None).values if h not in covered]
            if missing_hours:
                # The preceding 00Z run cannot cover 23Z of the previous day.
                # Select a run initialized before the first missing interval.
                previous_run = (pd.Timestamp(missing_hours[0]) - pd.Timedelta(hours=1)).floor("12h").strftime("%Y%m%d%H")
                earlier = load_model(downloads, "icon2i", previous_run, BBOX)
                models["icon2i_previous"] = hourly_model(earlier)
                report["models"]["icon2i_previous"] = {"run": previous_run, "spacing_lat": earlier.attrs["spacing_lat"], "spacing_lon": earlier.attrs["spacing_lon"], "grib": json.loads(earlier.attrs["evidence"])}
            report["model_overlap"] = model_overlap(models, terrain.lat.values, terrain.lon.values)
            # Reconstruct missing recovery dates locally, never in index_nc.
            for past in pd.date_range(pd.Timestamp(last) + pd.Timedelta(days=1), pd.Timestamp(today) - pd.Timedelta(days=1)):
                day = past.strftime("%Y-%m-%d")
                weather, _ = compose_forecast_window(day, ROOT, directory, issued)
                result, _ = score_day(day, weather, terrain, OUT_INDEX_NC_DIR, directory)
                save_nc(result, directory / f"funghi_index_{day}.nc")
            dates = []
            for offset in range(args.horizon + 1):
                day = (pd.Timestamp(today) + pd.Timedelta(days=offset)).strftime("%Y-%m-%d")
                if local_hours(day)[-1].tz_localize(None).to_datetime64() > models["iconeu"].valid_time.values[-1]:
                    break
                daily, quality = daily_forecast(day, issued, models, ruc, terrain.lat.values, terrain.lon.values)
                # A validated HRS full day, if already present, remains authoritative.
                composite = compose_weather_window(day, INDEX_FEATURE_WINDOW_DAYS, FINAL_METEO_DIR, forecast_root=None)
                if int(composite.weather_source.values[-1]) in (1, 2):
                    daily = composite[list(SCORING_WEATHER_VARIABLES)].isel(time=slice(-1, None)).drop_vars("weather_source")
                    source = "hrs" if int(composite.weather_source.values[-1]) == 2 else "ruc"
                    quality.update(model=source, hours_by_source={source: len(local_hours(day))}, gust_partial=False, gust_covered_hours=len(local_hours(day)))
                save_nc(daily, directory / f"weather_{day}.nc")
                del composite
                weather, provenance = compose_forecast_window(day, ROOT, directory, issued)
                quality["weather_provenance"] = provenance
                missing = [str(t)[:10] for t, count in zip(weather.time.values, np.isfinite(weather.t2m_mean).any(("lat", "lon")).values) if not count]
                quality["historical_gap_dates"] = missing
                quality["quality_flag"] = "historical_gaps_skipna_bias" if missing else "forecast"
                quality["quality_flags"] = (["historical_gaps_skipna_bias"] if missing else []) + (["partial_gust_max"] if quality["gust_partial"] else [])
                if any(p["source"] == "archived_forecast" for p in provenance):
                    quality["quality_flags"].append("archived_forecast_in_history")
                result, missing_recovery = score_day(day, weather, terrain, OUT_INDEX_NC_DIR, directory)
                quality["missing_recovery_dates"] = missing_recovery
                values = result.porcini_score.values
                if np.isinf(values).any() or (np.isfinite(values).any() and (np.nanmin(values) < 0 or np.nanmax(values) > 100)):
                    raise ValueError("invalid forecast scores")
                if not np.isfinite(values).any():
                    raise ValueError("forecast score entirely nodata")
                quality["score"] = {"min": float(np.nanmin(values)), "max": float(np.nanmax(values)), "mean": float(np.nanmean(values)), "nodata_cells": int(np.isnan(values).sum())}
                quality["weather_ranges"] = {k: finite_range(daily[k]) for k in SCORING_WEATHER_VARIABLES}
                save_nc(result, directory / f"funghi_index_{day}.nc")
                report["days"].append(quality)
                dates.append(day)
                print(f"[FORECAST INDEX] date={day} sources={quality['hours_by_source']} gaps={len(missing)} score={quality['score']}", flush=True)
            if not dates:
                raise ValueError("no complete forecast day")
            report["valid_until"] = (pd.Timestamp(dates[-1]) + pd.Timedelta(days=1)).tz_localize("Europe/Rome").tz_convert("UTC").isoformat()
        manifest = package(directory, dates, report, args.max_zoom)
        report.update(download_bytes=downloads.bytes, seconds=round(time.monotonic() - started, 1),
                      source_download_bytes=sum(int(ds.attrs["download_bytes"]) for ds in models.values()),
                      publication_bytes=sum(x["bytes"] for x in manifest["chunks"] + manifest["tiles"]),
                      local_bytes=sum(p.stat().st_size for p in directory.rglob("*") if p.is_file()))
        write_json(directory / "report.json", report)
        print(f"[FORECAST BUILD] version={directory.name} dates={dates} bytes={report['publication_bytes']} seconds={report['seconds']}", flush=True)
        if args.publish:
            from backend.src.forecast.publish import publish
            publish(directory, args.env_file)


if __name__ == "__main__":
    from backend.scripts.pipeline_logging import run_logged_main
    run_logged_main("daily_forecast", main, BACKEND_DIR / "logs" / "forecast")
