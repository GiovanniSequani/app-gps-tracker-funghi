from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import xarray as xr

from backend.config.meteo import (
    DUPLICATE_VALID_TIME_POLICY,
    INTERMEDIATE_METEO_DIR,
    ROLLING_HOURLY_WINDOW_HOURS,
)

UTC = timezone.utc
BASE_EXPECTED_VARS = ("t2m", "rh2m", "gust10m", "precip")
EXPECTED_VARS = (*BASE_EXPECTED_VARS, "tground", "smi9")


# ------------------------------------------------------------------------------
# Utility
# ------------------------------------------------------------------------------

def parse_run_yyyymmddhh(run_str: str) -> datetime:
    try:
        return datetime.strptime(run_str, "%Y%m%d%H").replace(tzinfo=UTC)
    except ValueError as exc:
        raise ValueError(
            f"Formato run non valido: {run_str}. Atteso YYYYmmddHH"
        ) from exc



def format_run(dt: datetime) -> str:
    return dt.strftime("%Y%m%d%H")



def ensure_output_dir() -> Path:
    INTERMEDIATE_METEO_DIR.mkdir(parents=True, exist_ok=True)
    return INTERMEDIATE_METEO_DIR



def default_hourly_run_path(run_dt: datetime) -> Path:
    return INTERMEDIATE_METEO_DIR / f"icon_d2_hourly_{format_run(run_dt)}.nc"



def default_buffer_path() -> Path:
    return INTERMEDIATE_METEO_DIR / "hourly_buffer.nc"



def parse_run_time_utc(value: str) -> datetime:
    try:
        return datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"run_time_utc non valido: {value}") from exc



def datetime_to_np64_seconds(dt: datetime) -> np.datetime64:
    dt_utc = dt.astimezone(UTC).replace(tzinfo=None)
    return np.datetime64(dt_utc, "s")


# ------------------------------------------------------------------------------
# Validation / normalization
# ------------------------------------------------------------------------------

def validate_hourly_dataset(ds: xr.Dataset, source_path: Path, allow_legacy_missing: bool = False) -> None:
    required_vars = BASE_EXPECTED_VARS if allow_legacy_missing else EXPECTED_VARS
    missing_vars = [name for name in required_vars if name not in ds.data_vars]
    if missing_vars:
        raise RuntimeError(
            f"Dataset orario incompleto in {source_path}. Variabili mancanti: {missing_vars}"
        )

    for coord_name in ("valid_time", "lat", "lon"):
        if coord_name not in ds.coords:
            raise RuntimeError(
                f"Coordinata mancante '{coord_name}' in {source_path}. Coords: {list(ds.coords)}"
            )

    expected_dims = ("valid_time", "lat", "lon")
    for var_name in required_vars:
        if ds[var_name].dims != expected_dims:
            raise RuntimeError(
                f"Variabile {var_name} con dims non attese in {source_path}: "
                f"{ds[var_name].dims} invece di {expected_dims}"
            )

    valid_time = ds["valid_time"].values
    if valid_time.ndim != 1:
        raise RuntimeError(f"valid_time deve essere 1D in {source_path}")
    if valid_time.size == 0:
        raise RuntimeError(f"Dataset orario vuoto in {source_path}")

    valid_time_s = valid_time.astype("datetime64[s]")
    if np.any(np.diff(valid_time_s) < np.timedelta64(0, "s")):
        raise RuntimeError(
            f"valid_time non monotono crescente in {source_path}. "
            "Ordina/sistema prima di aggiornare il buffer."
        )

    if "run_time_utc" not in ds.attrs:
        raise RuntimeError(
            f"Attributo globale run_time_utc mancante in {source_path}."
        )



def attach_run_time_coord(ds: xr.Dataset) -> xr.Dataset:
    run_dt = parse_run_time_utc(ds.attrs["run_time_utc"])
    run_np64 = datetime_to_np64_seconds(run_dt)
    n = ds.sizes["valid_time"]

    out = ds.copy()
    out = out.assign_coords(
        run_time=("valid_time", np.full(n, run_np64, dtype="datetime64[s]"))
    )
    out["run_time"].attrs.update(
        long_name="forecast run time in UTC used as tie-breaker for duplicate valid_time",
        timezone="UTC",
    )
    return out



def validate_compatible_grids(ds_old: xr.Dataset, ds_new: xr.Dataset) -> None:
    if not np.array_equal(ds_old["lat"].values, ds_new["lat"].values):
        raise RuntimeError("Griglia lat non coerente tra buffer esistente e nuova run")
    if not np.array_equal(ds_old["lon"].values, ds_new["lon"].values):
        raise RuntimeError("Griglia lon non coerente tra buffer esistente e nuova run")



def ensure_buffer_run_time_coord(ds: xr.Dataset) -> xr.Dataset:
    if "run_time" in ds.coords:
        return ds

    if "run_time_utc" not in ds.attrs:
        raise RuntimeError(
            "Il buffer esistente non ha coord run_time né attr run_time_utc: impossibile applicare latest_run_wins"
        )

    run_dt = parse_run_time_utc(ds.attrs["run_time_utc"])
    run_np64 = datetime_to_np64_seconds(run_dt)
    n = ds.sizes["valid_time"]

    out = ds.copy()
    out = out.assign_coords(
        run_time=("valid_time", np.full(n, run_np64, dtype="datetime64[s]"))
    )
    out["run_time"].attrs.update(
        long_name="forecast run time in UTC used as tie-breaker for duplicate valid_time",
        timezone="UTC",
    )
    return out


# ------------------------------------------------------------------------------
# Merge logic
# ------------------------------------------------------------------------------

def deduplicate_latest_run_wins(ds: xr.Dataset) -> xr.Dataset:
    valid = ds["valid_time"].values.astype("datetime64[s]")
    run_time = ds["run_time"].values.astype("datetime64[s]")

    order = np.lexsort((run_time, valid))
    ds_sorted = ds.isel(valid_time=order)

    valid_sorted = ds_sorted["valid_time"].values.astype("datetime64[s]")
    n = valid_sorted.size

    _, reverse_first_idx = np.unique(valid_sorted[::-1], return_index=True)
    keep_pos = (n - 1 - reverse_first_idx)
    keep_pos.sort()

    out = ds_sorted.isel(valid_time=keep_pos)
    return out



def trim_rolling_window(ds: xr.Dataset, window_hours: int) -> xr.Dataset:
    if window_hours <= 0:
        raise ValueError("ROLLING_HOURLY_WINDOW_HOURS deve essere > 0")

    valid = ds["valid_time"].values.astype("datetime64[s]")
    latest = valid.max()
    cutoff = latest - np.timedelta64(window_hours - 1, "h")
    mask = valid >= cutoff
    return ds.isel(valid_time=mask)



def merge_into_buffer(
    ds_buffer: xr.Dataset | None,
    ds_new: xr.Dataset,
    window_hours: int,
) -> xr.Dataset:
    ds_new = attach_run_time_coord(ds_new)

    if ds_buffer is None:
        merged = ds_new
    else:
        ds_buffer = ensure_buffer_run_time_coord(ds_buffer)
        validate_compatible_grids(ds_buffer, ds_new)
        for var_name in EXPECTED_VARS:
            if var_name not in ds_buffer.data_vars:
                fill = np.full(
                    (
                        ds_buffer.sizes["valid_time"],
                        ds_buffer.sizes["lat"],
                        ds_buffer.sizes["lon"],
                    ),
                    np.nan,
                    dtype=np.float32,
                )
                ds_buffer[var_name] = (("valid_time", "lat", "lon"), fill)
        merged = xr.concat([ds_buffer, ds_new], dim="valid_time", coords="minimal", compat="override")

    if DUPLICATE_VALID_TIME_POLICY != "latest_run_wins":
        raise NotImplementedError(
            f"Policy non supportata: {DUPLICATE_VALID_TIME_POLICY}"
        )

    merged = deduplicate_latest_run_wins(merged)
    merged = merged.sortby("valid_time")
    merged = trim_rolling_window(merged, window_hours)

    latest_run = merged["run_time"].values.astype("datetime64[s]").max()
    oldest_valid = merged["valid_time"].values.astype("datetime64[s]").min()
    newest_valid = merged["valid_time"].values.astype("datetime64[s]").max()

    merged.attrs.update(
        title="Rolling hourly weather buffer for mushroom index pipeline",
        summary=(
            "Short rolling hourly buffer built by merging ICON-D2 single-run hourly NetCDF files "
            "and resolving duplicate valid_time with latest_run_wins."
        ),
        source="DWD ICON-D2 open data",
        duplicate_valid_time_policy=DUPLICATE_VALID_TIME_POLICY,
        rolling_hourly_window_hours=int(window_hours),
        created_utc=datetime.now(UTC).isoformat(),
        latest_run_time_utc=np.datetime_as_string(latest_run, unit="s") + "Z",
        valid_time_start_utc=np.datetime_as_string(oldest_valid, unit="s") + "Z",
        valid_time_end_utc=np.datetime_as_string(newest_valid, unit="s") + "Z",
    )

    return merged


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



def save_buffer(ds: xr.Dataset, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)

    encoding: dict[str, dict] = {}
    for var_name in EXPECTED_VARS:
        if var_name in ds.data_vars:
            encoding[var_name] = {"zlib": True, "complevel": 4}

    if "run_time" in ds.coords:
        encoding["run_time"] = {"dtype": "i8"}
    if "valid_time" in ds.coords:
        encoding["valid_time"] = {"dtype": "i8"}

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


# ------------------------------------------------------------------------------
# Main
# ------------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Aggiorna il buffer orario rolling unendo una nuova run hourly e deduplicando per valid_time."
    )
    parser.add_argument(
        "--run",
        type=str,
        default=None,
        help="Run target in formato YYYYmmddHH. Serve per derivare l'input se --hourly-nc non è passato.",
    )
    parser.add_argument(
        "--hourly-nc",
        type=str,
        default=None,
        help="Path del NetCDF orario prodotto da 02_extract_hourly_fields.py",
    )
    parser.add_argument(
        "--buffer-nc",
        type=str,
        default=str(default_buffer_path()),
        help="Path del buffer rolling orario da aggiornare",
    )
    parser.add_argument(
        "--window-hours",
        type=int,
        default=ROLLING_HOURLY_WINDOW_HOURS,
        help="Ampiezza finestra rolling del buffer orario",
    )
    args = parser.parse_args()

    if args.hourly_nc is None and args.run is None:
        raise ValueError("Devi passare almeno --run oppure --hourly-nc")

    if args.hourly_nc is not None:
        hourly_path = Path(args.hourly_nc)
    else:
        run_dt = parse_run_yyyymmddhh(args.run)
        hourly_path = default_hourly_run_path(run_dt)

    buffer_path = Path(args.buffer_nc)

    print("=" * 78)
    print("UPDATE HOURLY BUFFER")
    print(f"Input hourly file  : {hourly_path}")
    print(f"Buffer file        : {buffer_path}")
    print(f"Window hours       : {args.window_hours}")
    print(f"Duplicate policy   : {DUPLICATE_VALID_TIME_POLICY}")
    print("=" * 78)

    ds_new = open_dataset(hourly_path)
    validate_hourly_dataset(ds_new, hourly_path)

    print(
        f"[NEW] run_time_utc={ds_new.attrs['run_time_utc']} | "
        f"n_valid={ds_new.sizes['valid_time']} | "
        f"range={str(ds_new['valid_time'].values[0])} -> {str(ds_new['valid_time'].values[-1])}"
    )

    ds_buffer: xr.Dataset | None = None
    if buffer_path.exists():
        ds_buffer = open_dataset(buffer_path)
        validate_hourly_dataset(ds_buffer, buffer_path, allow_legacy_missing=True)
        ds_buffer = ensure_buffer_run_time_coord(ds_buffer)
        print(
            f"[OLD] n_valid={ds_buffer.sizes['valid_time']} | "
            f"range={str(ds_buffer['valid_time'].values[0])} -> {str(ds_buffer['valid_time'].values[-1])}"
        )
    else:
        print("[OLD] buffer non trovato: verrà creato da zero")

    merged = merge_into_buffer(
        ds_buffer=ds_buffer,
        ds_new=ds_new,
        window_hours=args.window_hours,
    )

    save_buffer(merged, buffer_path)

    print("\n[OK] Buffer aggiornato")
    print(f"Output             : {buffer_path.resolve()}")
    print(f"n_valid            : {merged.sizes['valid_time']}")
    print(f"valid_time start   : {str(merged['valid_time'].values[0])}")
    print(f"valid_time end     : {str(merged['valid_time'].values[-1])}")
    print(f"latest_run_time    : {merged.attrs.get('latest_run_time_utc')}")
    print("\nDone OK")


if __name__ == "__main__":
    main()
