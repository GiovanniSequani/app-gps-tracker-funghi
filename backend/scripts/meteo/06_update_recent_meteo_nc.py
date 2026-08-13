from __future__ import annotations

import argparse
from pathlib import Path

from netCDF4 import Dataset, num2date

from backend.config.meteo import FINAL_METEO_DIR, INTERMEDIATE_METEO_DIR
from backend.config.paths import FINAL_METEO_HISTORIC_DIR, icon_ruc_recovery_path, icon_ruc_time_series_path
from backend.src.meteo.time_series import bootstrap_icon_series, merge_icon_daily


def input_year(path: Path) -> int:
    with Dataset(path, "r") as ds:
        if "time" not in ds.variables or not getattr(ds.variables["time"], "units", None):
            raise ValueError(f"invalid daily time coordinate: {path}")
        values = num2date(
            ds.variables["time"][:],
            ds.variables["time"].units,
            calendar=getattr(ds.variables["time"], "calendar", "standard"),
            only_use_cftime_datetimes=False,
        )
    years = {item.year for item in values}
    if len(years) != 1:
        raise ValueError("daily input must contain one calendar year")
    return years.pop()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Atomically update the yearly ICON-D2-RUC daily weather time series."
    )
    parser.add_argument(
        "--daily",
        default=str(INTERMEDIATE_METEO_DIR / "daily_003deg.nc"),
        help="Complete regridded daily input.",
    )
    parser.add_argument(
        "--out",
        default=None,
        help="Yearly output override. Default: icon_ruc_time_series_<year>.nc.",
    )
    parser.add_argument(
        "--recovery",
        default=None,
        help="Recovery output override. Default: recovery_icon_ruc_time_series_<year>.nc.",
    )
    parser.add_argument("--run", default=None, help="Source run YYYYmmddHH, for compact logging.")
    parser.add_argument(
        "--no-legacy-bootstrap",
        action="store_true",
        help="Do not initialize a missing yearly series from legacy historic snapshots.",
    )
    args = parser.parse_args()

    daily_path = Path(args.daily)
    if not daily_path.is_file():
        raise FileNotFoundError(daily_path)
    year = input_year(daily_path)
    out_path = Path(args.out) if args.out else icon_ruc_time_series_path(year)
    recovery_path = Path(args.recovery) if args.recovery else (
        icon_ruc_recovery_path(year)
        if args.out is None
        else out_path.with_name(f"recovery_{out_path.name}")
    )

    print("UPDATE ICON-RUC YEARLY TIME SERIES")
    print(f"daily={daily_path} output={out_path} recovery={recovery_path} run={args.run or '[unknown]'}")

    if not out_path.exists() and not args.no_legacy_bootstrap:
        legacy_sources = sorted(FINAL_METEO_HISTORIC_DIR.glob("meteo_recent_003deg_*.nc"))
        legacy_recent = FINAL_METEO_DIR / "meteo_recent_003deg.nc"
        if legacy_recent.exists():
            legacy_sources.append(legacy_recent)
        legacy_sources.append(daily_path)
        dates = bootstrap_icon_series(legacy_sources, out_path, recovery_path)
        action = "bootstrapped"
    else:
        dates = merge_icon_daily(daily_path, out_path, recovery_path)
        action = "updated"

    print(
        f"[OK] action={action} days={len(dates)} range={dates[0]}..{dates[-1]} "
        f"recovery_current=true snapshots_created=false"
    )
    print("Done OK")


if __name__ == "__main__":
    main()
