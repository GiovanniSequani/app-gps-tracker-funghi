from __future__ import annotations

import argparse

import xarray as xr

from backend.config.index_config import (
    INDEX_FEATURE_WINDOW_DAYS,
    INDEX_FEATURES_TEMPLATE,
    METEO_RECENT_NC,
    TERRAIN_STATIC_NC,
)
from backend.src.index.features import build_feature_dataset


def main() -> None:
    parser = argparse.ArgumentParser(description="Build feature NetCDF for the mushroom index.")
    parser.add_argument("--date", default=None, help="Target date YYYY-MM-DD. Defaults to latest meteo date.")
    parser.add_argument("--meteo", default=str(METEO_RECENT_NC), help="Input meteo recent NetCDF.")
    parser.add_argument("--terrain", default=str(TERRAIN_STATIC_NC), help="Input terrain static NetCDF.")
    parser.add_argument("--window-days", type=int, default=INDEX_FEATURE_WINDOW_DAYS)
    parser.add_argument("--output", default=None, help="Output feature NetCDF.")
    args = parser.parse_args()

    meteo = xr.open_dataset(args.meteo)
    terrain = xr.open_dataset(args.terrain)
    features = build_feature_dataset(
        meteo=meteo,
        terrain=terrain,
        target_date=args.date,
        window_days=args.window_days,
    )

    target_date = features.attrs["target_date"]
    output = args.output or str(INDEX_FEATURES_TEMPLATE).format(date=target_date)
    features_path = output

    from pathlib import Path

    Path(features_path).parent.mkdir(parents=True, exist_ok=True)
    features.to_netcdf(features_path)
    print(f"[OK] Feature dataset written: {features_path}")
    print(f"     target_date={target_date} time_steps={features.sizes['time']} grid={features.sizes['lat']}x{features.sizes['lon']}")


if __name__ == "__main__":
    main()

