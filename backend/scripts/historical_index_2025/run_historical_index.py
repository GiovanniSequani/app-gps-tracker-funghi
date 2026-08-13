"""Rebuild a historical index locally from a daily weather NetCDF.

Run from the repository root. This script never publishes to Supabase.
"""

from __future__ import annotations

import argparse
import importlib
import shutil
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import xarray as xr

from backend.config.index_config import INDEX_FEATURE_WINDOW_DAYS
from backend.config.paths import OUT_INDEX_NC_DIR, TMP_DIR
from backend.config.index_config import TERRAIN_STATIC_NC
from backend.src.index.features import build_feature_dataset
from backend.src.index.scoring import compute_all_indices

load_recovery_history = importlib.import_module(
    "backend.scripts.index.02_compute_funghi_index"
).load_recovery_history


WEATHER_VARS = {
    "TC2M_MIN": "t2m_min",
    "TC2M_MAX": "t2m_max",
    "TC2M_MEAN": "t2m_mean",
    "PREC_DAILY": "precip_sum",
    "RH2M_MIN": "rh_min",
    "RH2M_MEAN": "rh_mean",
    "GUST_MAX": "gust_max",
}


def parse_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"data non valida: {value}") from exc


def normalize_weather(source: xr.Dataset) -> xr.Dataset:
    missing = [name for name in WEATHER_VARS if name not in source.data_vars]
    if missing:
        raise ValueError(f"variabili meteo mancanti: {', '.join(missing)}")
    if tuple(source["time"].dims) != ("time",):
        raise ValueError("time deve essere una coordinata 1D")
    if source.sizes.get("lat") != 500 or source.sizes.get("lon") != 700:
        raise ValueError(f"griglia inattesa: {source.sizes}")
    for coord in ("lat", "lon"):
        if coord not in source.coords or source[coord].ndim != 1:
            raise ValueError(f"coordinata {coord} mancante o non 1D")
        if np.any(np.diff(source[coord].values) <= 0):
            raise ValueError(f"coordinata {coord} non crescente")

    values = {
        target: source[original].astype("float32")
        for original, target in WEATHER_VARS.items()
    }
    # The HRS file declares GUST_MAX in m/s; the scoring configuration is km/h.
    values["gust_max"] = (values["gust_max"] * np.float32(3.6)).assign_attrs(
        units="km h-1", source_units="m s-1", conversion="value * 3.6"
    )
    # The feature contract also requires gust_mean, although scoring does not use it.
    values["gust_mean"] = values["gust_max"].copy(deep=False)
    normalized = xr.Dataset(values, coords={"time": source.time, "lat": source.lat, "lon": source.lon})
    normalized.attrs.update(source.attrs)
    normalized.attrs["historical_normalization"] = (
        "HRS names mapped to FunghiTracker daily names; GUST_MAX m/s converted to km/h; "
        "gust_mean aliases converted gust_max because scoring does not use gust_mean."
    )
    return normalized.sortby("time")


def write_index(index: xr.Dataset, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoding = {
        name: {"zlib": True, "complevel": 4, "dtype": "f4"}
        for name in index.data_vars
        if index[name].dtype.kind == "f"
    }
    index.to_netcdf(path, encoding=encoding)


def daterange(start: date, end: date):
    current = start
    while current <= end:
        yield current
        current += timedelta(days=1)


def main() -> None:
    parser = argparse.ArgumentParser(description="Ricrea localmente l'indice storico 2025.")
    parser.add_argument("--weather", type=Path, default=Path("backend/data/HRS_20250601_20251031.nc"))
    parser.add_argument("--terrain", type=Path, default=TERRAIN_STATIC_NC)
    parser.add_argument("--compute-start", type=parse_date, default=date(2025, 6, 19))
    parser.add_argument("--compute-end", type=parse_date, default=date(2025, 10, 31))
    parser.add_argument("--keep-start", type=parse_date, default=date(2025, 7, 1))
    parser.add_argument("--keep-end", type=parse_date, default=date(2025, 10, 31))
    parser.add_argument("--window-days", type=int, default=INDEX_FEATURE_WINDOW_DAYS)
    parser.add_argument("--no-recovery", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--staging-only", action="store_true", help="Calcola senza copiare nella cartella finale.")
    parser.add_argument("--copy-only", action="store_true", help="Copia nella cartella finale output già presenti nella staging.")
    args = parser.parse_args()

    if not args.copy_only and not args.staging_only and (args.compute_start > args.keep_start or args.keep_end > args.compute_end):
        raise SystemExit("l'intervallo da conservare deve essere contenuto nell'intervallo calcolato")
    if args.window_days < 8:
        raise SystemExit("--window-days deve essere almeno 8")
    staging = TMP_DIR / "historical_index_2025"
    final_dir = OUT_INDEX_NC_DIR
    print(f"[HISTORICAL] weather={args.weather} terrain={args.terrain}")
    print(f"[HISTORICAL] compute={args.compute_start}..{args.compute_end} keep={args.keep_start}..{args.keep_end}")
    if args.dry_run:
        print(f"[HISTORICAL] dry-run: {sum(1 for _ in daterange(args.compute_start, args.compute_end))} date da calcolare")
        return

    staging.mkdir(parents=True, exist_ok=True)
    if args.copy_only:
        copied = 0
        for target in daterange(args.keep_start, args.keep_end):
            source = staging / f"funghi_index_{target.isoformat()}.nc"
            if not source.exists():
                raise RuntimeError(f"output storico mancante: {source}")
            shutil.copy2(source, final_dir / source.name)
            copied += 1
        print(f"[HISTORICAL] copied={copied} destination={final_dir}")
        return
    weather = normalize_weather(xr.open_dataset(args.weather))
    terrain = xr.open_dataset(args.terrain).load()
    try:
        available = {str(value)[:10] for value in weather.time.values}
        for target in daterange(args.compute_start, args.compute_end):
            target_text = target.isoformat()
            if target_text not in available:
                raise ValueError(f"data meteo mancante: {target_text}")
            feature = build_feature_dataset(weather, terrain, target_text, args.window_days)
            history = None if args.no_recovery else load_recovery_history(staging, target_text, ["porcini", "finferli"])
            index = compute_all_indices(feature, ["porcini", "finferli"], history, enable_recovery=not args.no_recovery)
            index.attrs.update(source_weather=str(args.weather), historical_reconstruction="true")
            write_index(index, staging / f"funghi_index_{target_text}.nc")
            print(f"[HISTORICAL] {target_text} written")
    finally:
        weather.close()
        terrain.close()

    if args.staging_only:
        print(f"[HISTORICAL] staging-only completed: {staging}")
        return

    copied = 0
    for target in daterange(args.keep_start, args.keep_end):
        source = staging / f"funghi_index_{target.isoformat()}.nc"
        if not source.exists():
            raise RuntimeError(f"output storico mancante: {source}")
        destination = final_dir / source.name
        shutil.copy2(source, destination)
        copied += 1
    print(f"[HISTORICAL] copied={copied} destination={final_dir}")


if __name__ == "__main__":
    main()