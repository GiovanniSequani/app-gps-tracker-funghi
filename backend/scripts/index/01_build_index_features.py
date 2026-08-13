from __future__ import annotations

import argparse

import xarray as xr

from backend.config.index_config import (
    INDEX_FEATURE_WINDOW_DAYS,
    INDEX_FEATURES_TEMPLATE,
    TERRAIN_STATIC_NC,
)
from backend.src.index.features import build_feature_dataset
from backend.src.meteo.time_series import save_composite_window
from backend.config.paths import FINAL_METEO_DIR, TMP_DIR


def main() -> None:
    parser = argparse.ArgumentParser(description="Build feature NetCDF for the mushroom index.")
    parser.add_argument("--date", default=None, help="Target date YYYY-MM-DD. Defaults to latest meteo date.")
    parser.add_argument("--meteo", default=None, help="Explicit prepared weather NetCDF override.")
    parser.add_argument("--meteo-dir", default=None, help="Directory containing yearly ICON-RUC/HRS series.")
    parser.add_argument("--terrain", default=str(TERRAIN_STATIC_NC), help="Input terrain static NetCDF.")
    parser.add_argument("--window-days", type=int, default=INDEX_FEATURE_WINDOW_DAYS)
    parser.add_argument("--output", default=None, help="Output feature NetCDF.")
    args = parser.parse_args()

    if args.date is None and args.meteo is None:
        raise SystemExit("--date is required when using yearly ICON-RUC/HRS time series")
    from pathlib import Path
    prepared_weather: Path | None = None
    if args.meteo:
        meteo = xr.open_dataset(args.meteo)
    else:
        prepared_weather = TMP_DIR / "meteo_windows" / f"index_weather_{args.date}.nc"
        save_composite_window(
            args.date,
            args.window_days,
            prepared_weather,
            Path(args.meteo_dir) if args.meteo_dir else FINAL_METEO_DIR,
        )
        meteo = xr.open_dataset(prepared_weather)
    terrain = xr.open_dataset(args.terrain)
    try:
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
    finally:
        meteo.close()
        terrain.close()
        if prepared_weather and prepared_weather.exists():
            prepared_weather.unlink()
    print(f"[OK] Feature dataset written: {features_path}")
    print(f"     target_date={target_date} time_steps={features.sizes['time']} grid={features.sizes['lat']}x{features.sizes['lon']}")


if __name__ == "__main__":
    main()

