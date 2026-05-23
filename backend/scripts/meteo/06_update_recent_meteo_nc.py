from __future__ import annotations

import argparse
import shutil
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import xarray as xr

from backend.config.meteo import (
    DAILY_FINAL_VARIABLES,
    FINAL_METEO_DIR,
    INTERMEDIATE_METEO_DIR,
    ROLLING_DAILY_WINDOW_DAYS,
)
from backend.config.paths import FINAL_METEO_HISTORIC_DIR

UTC = timezone.utc
BASE_EXPECTED_DAILY_VARS = (
    "t2m_mean",
    "t2m_min",
    "t2m_max",
    "precip_sum",
    "rh_mean",
    "rh_min",
    "gust_mean",
    "gust_max",
)
EXPECTED_DAILY_VARS = tuple(DAILY_FINAL_VARIABLES)


# ------------------------------------------------------------------------------
# Utility path
# ------------------------------------------------------------------------------

def ensure_output_dir() -> Path:
    FINAL_METEO_DIR.mkdir(parents=True, exist_ok=True)
    return FINAL_METEO_DIR


def default_daily_target_path() -> Path:
    return INTERMEDIATE_METEO_DIR / "daily_003deg.nc"


def default_final_recent_path() -> Path:
    return FINAL_METEO_DIR / "meteo_recent_003deg.nc"


# ------------------------------------------------------------------------------
# I/O
# ------------------------------------------------------------------------------

def open_dataset(path: Path) -> xr.Dataset:
    if not path.is_file():
        raise FileNotFoundError(f"File non trovato: {path}")

    ds = xr.open_dataset(path)
    try:
        ds.load()
        ds_mem = ds.copy(deep=True)
    finally:
        ds.close()

    return ds_mem


def save_dataset(ds: xr.Dataset, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)

    encoding: dict[str, dict] = {
        "time": {"dtype": "i8"},
        "lat": {"dtype": "f4"},
        "lon": {"dtype": "f4"},
    }

    if "n_hours" in ds.coords:
        encoding["n_hours"] = {"dtype": "i2"}

    for var_name in EXPECTED_DAILY_VARS:
        if var_name in ds.data_vars:
            encoding[var_name] = {"zlib": True, "complevel": 4, "dtype": "f4"}

    tmp_path = out_path.with_suffix(".tmp")
    try:
        ds.to_netcdf(tmp_path, encoding=encoding)
        if out_path.exists():
            out_path.unlink()
        tmp_path.rename(out_path)
    except Exception:
        if tmp_path.exists():
            tmp_path.unlink()
        raise


def parse_utc_iso(value: str) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def copy_historic_snapshot_if_complete(
    ds: xr.Dataset,
    rolling_path: Path,
    run: str | None,
) -> Path | None:
    """
    Salva un'istantanea del rolling recente solo quando il dataset termina con la run delle 21 UTC.
    In quel caso il giorno locale risultante è completo e vale la pena conservarne una copia storica.
    """
    if run is None or len(run) != 10 or not run.isdigit() or int(run[-2:]) != 21:
        return None

    time_end = parse_utc_iso(str(ds.attrs.get("time_end", "")))
    if time_end is None:
        return None

    FINAL_METEO_HISTORIC_DIR.mkdir(parents=True, exist_ok=True)
    snapshot_name = f"{rolling_path.stem}_{time_end.strftime('%Y%m%d')}{rolling_path.suffix}"
    snapshot_path = FINAL_METEO_HISTORIC_DIR / snapshot_name
    if snapshot_path.exists():
        return snapshot_path

    shutil.copy2(rolling_path, snapshot_path)
    return snapshot_path


# ------------------------------------------------------------------------------
# Validation
# ------------------------------------------------------------------------------

def validate_daily_dataset(ds: xr.Dataset, source_path: Path, allow_legacy_missing: bool = False) -> None:
    required_vars = BASE_EXPECTED_DAILY_VARS if allow_legacy_missing else EXPECTED_DAILY_VARS
    missing_vars = [name for name in required_vars if name not in ds.data_vars]
    if missing_vars:
        raise RuntimeError(
            f"Dataset daily incompleto in {source_path}. Variabili mancanti: {missing_vars}"
        )

    for coord_name in ("time", "lat", "lon"):
        if coord_name not in ds.coords:
            raise RuntimeError(
                f"Coordinata mancante '{coord_name}' in {source_path}. "
                f"Coords disponibili: {list(ds.coords)}"
            )

    expected_dims = ("time", "lat", "lon")
    for var_name in required_vars:
        if ds[var_name].dims != expected_dims:
            raise RuntimeError(
                f"Variabile {var_name} con dims non attese in {source_path}: "
                f"{ds[var_name].dims} invece di {expected_dims}"
            )

    time = ds["time"].values.astype("datetime64[s]")
    if time.ndim != 1:
        raise RuntimeError(f"time deve essere 1D in {source_path}")
    if time.size == 0:
        raise RuntimeError(f"Dataset daily vuoto in {source_path}")
    if np.any(np.diff(time) < np.timedelta64(0, "s")):
        raise RuntimeError(f"time non monotono crescente in {source_path}")

    lat = ds["lat"].values
    lon = ds["lon"].values

    if not (lat.ndim == 1 and lon.ndim == 1):
        raise RuntimeError(f"lat/lon devono essere 1D in {source_path}")


def validate_compatible_grids(ds_old: xr.Dataset, ds_new: xr.Dataset) -> None:
    if not np.array_equal(ds_old["lat"].values, ds_new["lat"].values):
        raise RuntimeError("Griglia lat non coerente tra dataset finale esistente e nuovo input")
    if not np.array_equal(ds_old["lon"].values, ds_new["lon"].values):
        raise RuntimeError("Griglia lon non coerente tra dataset finale esistente e nuovo input")


# ------------------------------------------------------------------------------
# Merge logic
# ------------------------------------------------------------------------------

def deduplicate_time_new_wins(ds: xr.Dataset) -> xr.Dataset:
    """
    Tiene l'ultima occorrenza per ogni time.
    Se concateniamo [old, new], allora il new vince sui duplicati.
    """
    time_vals = ds["time"].values.astype("datetime64[s]")
    n = time_vals.size

    _, reverse_first_idx = np.unique(time_vals[::-1], return_index=True)
    keep_pos = (n - 1 - reverse_first_idx)
    keep_pos.sort()

    out = ds.isel(time=keep_pos)
    out = out.sortby("time")
    return out


def trim_recent_days(ds: xr.Dataset, window_days: int) -> xr.Dataset:
    if window_days <= 0:
        raise ValueError("ROLLING_DAILY_WINDOW_DAYS deve essere > 0")

    time_vals = ds["time"].values.astype("datetime64[s]")
    latest = time_vals.max()
    cutoff = latest - np.timedelta64(window_days - 1, "D")
    mask = time_vals >= cutoff
    return ds.isel(time=mask)


def merge_recent_daily(
    ds_old: xr.Dataset | None,
    ds_new: xr.Dataset,
    window_days: int,
) -> xr.Dataset:
    if ds_old is None:
        merged = ds_new
    else:
        validate_compatible_grids(ds_old, ds_new)
        for var_name in EXPECTED_DAILY_VARS:
            if var_name not in ds_old.data_vars:
                fill = np.full(
                    (
                        ds_old.sizes["time"],
                        ds_old.sizes["lat"],
                        ds_old.sizes["lon"],
                    ),
                    np.nan,
                    dtype=np.float32,
                )
                ds_old[var_name] = (("time", "lat", "lon"), fill)
        merged = xr.concat([ds_old, ds_new], dim="time", coords="minimal", compat="override")

    merged = deduplicate_time_new_wins(merged)
    merged = trim_recent_days(merged, window_days)

    time_vals = merged["time"].values.astype("datetime64[s]")
    oldest = time_vals.min()
    latest = time_vals.max()

    merged.attrs.update(
        title="Recent rolling daily weather dataset for mushroom index pipeline",
        summary=(
            "Rolling daily meteorological dataset on the common 0.003 degree target grid. "
            "Built by merging regridded daily fields and keeping the most recent version for duplicate days."
        ),
        source=ds_new.attrs.get("source", "DWD ICON-D2 open data"),
        latest_run_time_utc=ds_new.attrs.get(
            "source_latest_run_time_utc",
            ds_old.attrs.get("latest_run_time_utc", "") if ds_old is not None else "",
        ),
        rolling_daily_window_days=int(window_days),
        duplicate_time_policy="new_input_wins",
        created_utc=datetime.now(UTC).isoformat(),
        time_start=str(oldest),
        time_end=str(latest),
    )

    return merged


# ------------------------------------------------------------------------------
# Main
# ------------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Aggiorna il dataset daily finale rolling degli ultimi "
            f"{ROLLING_DAILY_WINDOW_DAYS} giorni sulla griglia 0.003°."
        )
    )
    parser.add_argument(
        "--daily",
        type=str,
        default=str(default_daily_target_path()),
        help="Path input daily_003deg.nc",
    )
    parser.add_argument(
        "--out",
        type=str,
        default=str(default_final_recent_path()),
        help="Path output meteo_recent_003deg.nc",
    )
    parser.add_argument(
        "--run",
        type=str,
        default=None,
        help="Run YYYYmmddHH that produced the latest daily update. Used to gate the historic snapshot.",
    )
    args = parser.parse_args()

    daily_path = Path(args.daily)
    out_path = Path(args.out)

    print("=" * 78)
    print("UPDATE RECENT DAILY METEO NC")
    print(f"Input daily        : {daily_path}")
    print(f"Output final       : {out_path}")
    print(f"Window days        : {ROLLING_DAILY_WINDOW_DAYS}")
    print(f"Run                : {args.run if args.run else '[unknown]'}")
    print("=" * 78)

    ds_new = open_dataset(daily_path)
    validate_daily_dataset(ds_new, daily_path)

    if out_path.exists():
        ds_old = open_dataset(out_path)
        validate_daily_dataset(ds_old, out_path, allow_legacy_missing=True)
        print(
            f"[OLD] n_days={ds_old.sizes['time']} | "
            f"range={ds_old['time'].values[0]} -> {ds_old['time'].values[-1]}"
        )
    else:
        ds_old = None
        print("[OLD] nessun dataset finale esistente")

    print(
        f"[NEW] n_days={ds_new.sizes['time']} | "
        f"range={ds_new['time'].values[0]} -> {ds_new['time'].values[-1]}"
    )

    ds_out = merge_recent_daily(
        ds_old=ds_old,
        ds_new=ds_new,
        window_days=ROLLING_DAILY_WINDOW_DAYS,
    )

    save_dataset(ds_out, out_path)

    snapshot_path = copy_historic_snapshot_if_complete(ds_out, out_path, args.run)

    print("\n[OK] Dataset finale aggiornato")
    print(f"Output             : {out_path.resolve()}")
    print(f"n_days             : {ds_out.sizes['time']}")
    print(f"time start         : {str(ds_out['time'].values[0])}")
    print(f"time end           : {str(ds_out['time'].values[-1])}")
    if snapshot_path is not None:
        print(f"historic snapshot   : {snapshot_path.resolve()}")
    else:
        print("historic snapshot   : skipped (not a 21 UTC completion)")
    print("\nDone OK")


if __name__ == "__main__":
    main()
