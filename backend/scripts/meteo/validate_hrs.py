from __future__ import annotations

import argparse
from pathlib import Path

from backend.config.paths import icon_ruc_time_series_path
from backend.src.meteo.time_series import validate_hrs


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate a manual HRS daily NetCDF before import.")
    parser.add_argument("--name", required=True, help="HRS NetCDF path.")
    parser.add_argument("--icon-reference", default=None, help="Optional ICON-RUC yearly grid reference.")
    args = parser.parse_args()

    path = Path(args.name)
    preliminary = validate_hrs(path)
    reference = Path(args.icon_reference) if args.icon_reference else icon_ruc_time_series_path(preliminary.dates[0].year)
    result = validate_hrs(path, reference if reference.exists() else None)
    print(
        f"[HRS VALID] file={path} days={len(result.dates)} "
        f"range={result.dates[0]}..{result.dates[-1]} grid={result.rows}x{result.cols}"
    )
    print(
        f"[HRS COVERAGE] usable_days={len(result.valid_dates)} "
        f"icon_fallback_days={len(result.fallback_dates)}"
    )
    if result.fallback_dates:
        print("[HRS FALLBACK] " + ",".join(item.isoformat() for item in result.fallback_dates))


if __name__ == "__main__":
    main()
