from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import xarray as xr

from backend.config.meteo import (
    DAILY_AGGREGATIONS,
    DAILY_FINAL_VARIABLES,
    INTERMEDIATE_METEO_DIR,
    TIMEZONE_DAILY,
)

UTC = timezone.utc
EXPECTED_HOURLY_VARS = ("t2m", "rh2m", "gust10m", "precip", "tground", "smi9")
EXPECTED_DAILY_VARS = tuple(DAILY_FINAL_VARIABLES)


# ------------------------------------------------------------------------------
# Utility path
# ------------------------------------------------------------------------------

def ensure_output_dir() -> Path:
    INTERMEDIATE_METEO_DIR.mkdir(parents=True, exist_ok=True)
    return INTERMEDIATE_METEO_DIR


def default_hourly_buffer_path() -> Path:
    return INTERMEDIATE_METEO_DIR / "hourly_buffer.nc"


def default_daily_candidates_path() -> Path:
    return INTERMEDIATE_METEO_DIR / "daily_candidates.nc"


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


def save_daily_dataset(ds: xr.Dataset, out_path: Path, overwrite: bool) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if out_path.exists() and not overwrite:
        raise FileExistsError(
            f"Output già esistente: {out_path}. Usa --overwrite per sovrascrivere."
        )

    encoding: dict[str, dict] = {
        "time": {"dtype": "i8"},
        "lat": {"dtype": "f4"},
        "lon": {"dtype": "f4"},
    }

    for var_name in EXPECTED_DAILY_VARS:
        if var_name in ds.data_vars:
            encoding[var_name] = {"zlib": True, "complevel": 4, "dtype": "f4"}

    ds.to_netcdf(out_path, encoding=encoding)


# ------------------------------------------------------------------------------
# Validation
# ------------------------------------------------------------------------------

def validate_hourly_buffer(ds: xr.Dataset, source_path: Path) -> None:
    missing_vars = [name for name in EXPECTED_HOURLY_VARS if name not in ds.data_vars]
    if missing_vars:
        raise RuntimeError(
            f"Buffer orario incompleto in {source_path}. Variabili mancanti: {missing_vars}"
        )

    for coord_name in ("valid_time", "lat", "lon"):
        if coord_name not in ds.coords:
            raise RuntimeError(
                f"Coordinata mancante '{coord_name}' in {source_path}. "
                f"Coords disponibili: {list(ds.coords)}"
            )

    expected_dims = ("valid_time", "lat", "lon")
    for var_name in EXPECTED_HOURLY_VARS:
        if ds[var_name].dims != expected_dims:
            raise RuntimeError(
                f"Variabile {var_name} con dims non attese in {source_path}: "
                f"{ds[var_name].dims} invece di {expected_dims}"
            )

    valid_time = ds["valid_time"].values
    if valid_time.ndim != 1:
        raise RuntimeError(f"valid_time deve essere 1D in {source_path}")
    if valid_time.size == 0:
        raise RuntimeError(f"Buffer orario vuoto in {source_path}")

    valid_time_s = valid_time.astype("datetime64[s]")
    if np.any(np.diff(valid_time_s) < np.timedelta64(0, "s")):
        raise RuntimeError(
            f"valid_time non monotono crescente in {source_path}"
        )

    _, counts = np.unique(valid_time_s, return_counts=True)
    if np.any(counts > 1):
        raise RuntimeError(
            f"valid_time duplicati trovati in {source_path}. "
            "Il buffer dovrebbe già essere deduplicato da 03_update_hourly_buffer.py"
        )


# ------------------------------------------------------------------------------
# Time helpers
# ------------------------------------------------------------------------------

def valid_time_to_utc_index(ds: xr.Dataset) -> pd.DatetimeIndex:
    """
    Converte valid_time del NetCDF in DatetimeIndex timezone-aware UTC.
    Il buffer salva datetime64 naive ma semanticamente in UTC.
    """
    vt = pd.to_datetime(ds["valid_time"].values)
    if vt.tz is None:
        vt = vt.tz_localize("UTC")
    else:
        vt = vt.tz_convert("UTC")
    return pd.DatetimeIndex(vt)


def build_complete_local_days(
    valid_time_utc: pd.DatetimeIndex,
    tz_name: str,
) -> tuple[list[pd.Timestamp], dict[pd.Timestamp, pd.DatetimeIndex]]:
    """
    Ritorna:
      - lista ordinata dei giorni locali completi (Timestamp naive a mezzanotte locale)
      - mapping giorno_locale -> indice orario atteso in UTC per quel giorno

    Un giorno è completo se tutte le ore realmente appartenenti a quella data locale
    (23/24/25 a seconda del DST) sono presenti nel buffer.
    """
    valid_local = valid_time_utc.tz_convert(tz_name)
    local_day_labels = valid_local.normalize()

    unique_days = pd.DatetimeIndex(sorted(local_day_labels.unique()))
    available_utc_set = set(valid_time_utc)

    complete_days: list[pd.Timestamp] = []
    expected_hours_map: dict[pd.Timestamp, pd.DatetimeIndex] = {}

    for day_local in unique_days:
        next_day_local = day_local + pd.Timedelta(days=1)

        expected_local_hours = pd.date_range(
            start=day_local,
            end=next_day_local,
            freq="1h",
            inclusive="left",
            tz=tz_name,
        )
        expected_utc_hours = expected_local_hours.tz_convert("UTC")

        if all(ts in available_utc_set for ts in expected_utc_hours):
            day_naive = pd.Timestamp(day_local.date())
            complete_days.append(day_naive)
            expected_hours_map[day_naive] = expected_utc_hours

    return complete_days, expected_hours_map


# ------------------------------------------------------------------------------
# Aggregation
# ------------------------------------------------------------------------------

def aggregate_one_day(
    ds_hourly: xr.Dataset,
    valid_time_utc: pd.DatetimeIndex,
    expected_hours_utc: pd.DatetimeIndex,
) -> dict[str, np.ndarray]:
    """
    Estrae le ore attese del giorno e calcola i campi daily.
    """
    mask = valid_time_utc.isin(expected_hours_utc)
    if int(mask.sum()) != len(expected_hours_utc):
        raise RuntimeError(
            "Incoerenza interna: il giorno è stato marcato completo ma le ore estratte non coincidono"
        )

    ds_day = ds_hourly.isel(valid_time=np.asarray(mask, dtype=bool))

    out: dict[str, np.ndarray] = {}

    # t2m
    if "mean" in DAILY_AGGREGATIONS["t2m"]:
        out["t2m_mean"] = ds_day["t2m"].mean(dim="valid_time").values.astype(np.float32)
    if "min" in DAILY_AGGREGATIONS["t2m"]:
        out["t2m_min"] = ds_day["t2m"].min(dim="valid_time").values.astype(np.float32)
    if "max" in DAILY_AGGREGATIONS["t2m"]:
        out["t2m_max"] = ds_day["t2m"].max(dim="valid_time").values.astype(np.float32)

    # precip
    if "sum" in DAILY_AGGREGATIONS["precip"]:
        out["precip_sum"] = ds_day["precip"].sum(dim="valid_time").values.astype(np.float32)

    # rh2m
    if "mean" in DAILY_AGGREGATIONS["rh2m"]:
        out["rh_mean"] = ds_day["rh2m"].mean(dim="valid_time").values.astype(np.float32)
    if "min" in DAILY_AGGREGATIONS["rh2m"]:
        out["rh_min"] = ds_day["rh2m"].min(dim="valid_time").values.astype(np.float32)

    # gust10m
    if "mean" in DAILY_AGGREGATIONS["gust10m"]:
        out["gust_mean"] = ds_day["gust10m"].mean(dim="valid_time").values.astype(np.float32)
    if "max" in DAILY_AGGREGATIONS["gust10m"]:
        out["gust_max"] = ds_day["gust10m"].max(dim="valid_time").values.astype(np.float32)

    # tground
    if "mean" in DAILY_AGGREGATIONS["tground"]:
        out["tground_mean"] = ds_day["tground"].mean(dim="valid_time", skipna=False).values.astype(np.float32)
    if "min" in DAILY_AGGREGATIONS["tground"]:
        out["tground_min"] = ds_day["tground"].min(dim="valid_time", skipna=False).values.astype(np.float32)
    if "max" in DAILY_AGGREGATIONS["tground"]:
        out["tground_max"] = ds_day["tground"].max(dim="valid_time", skipna=False).values.astype(np.float32)

    # smi9
    if "mean" in DAILY_AGGREGATIONS["smi9"]:
        out["smi9_mean"] = ds_day["smi9"].mean(dim="valid_time", skipna=False).values.astype(np.float32)
    if "min" in DAILY_AGGREGATIONS["smi9"]:
        out["smi9_min"] = ds_day["smi9"].min(dim="valid_time", skipna=False).values.astype(np.float32)

    return out


def build_daily_candidates(ds_hourly: xr.Dataset, tz_name: str) -> xr.Dataset:
    valid_time_utc = valid_time_to_utc_index(ds_hourly)

    complete_days, expected_hours_map = build_complete_local_days(
        valid_time_utc=valid_time_utc,
        tz_name=tz_name,
    )

    if not complete_days:
        raise RuntimeError(
            "Nessun giorno locale completo disponibile nel buffer orario corrente"
        )

    day_results: dict[str, list[np.ndarray]] = {name: [] for name in EXPECTED_DAILY_VARS}
    n_hours_per_day: list[int] = []
    time_values: list[np.datetime64] = []

    for day_local_naive in complete_days:
        expected_hours_utc = expected_hours_map[day_local_naive]
        agg = aggregate_one_day(
            ds_hourly=ds_hourly,
            valid_time_utc=valid_time_utc,
            expected_hours_utc=expected_hours_utc,
        )

        for var_name in EXPECTED_DAILY_VARS:
            day_results[var_name].append(agg[var_name])

        n_hours_per_day.append(len(expected_hours_utc))
        time_values.append(np.datetime64(day_local_naive.strftime("%Y-%m-%dT00:00:00"), "s"))

    data_vars = {
        var_name: (
            ("time", "lat", "lon"),
            np.stack(day_results[var_name], axis=0).astype(np.float32),
        )
        for var_name in EXPECTED_DAILY_VARS
    }

    ds_daily = xr.Dataset(
        data_vars=data_vars,
        coords={
            "time": np.array(time_values, dtype="datetime64[s]"),
            "lat": ds_hourly["lat"].values.astype(np.float32),
            "lon": ds_hourly["lon"].values.astype(np.float32),
        },
        attrs={
            "title": "Daily candidate weather fields aggregated from rolling hourly buffer",
            "summary": (
                "Intermediate daily dataset built from hourly_buffer.nc using local-day "
                f"aggregation in {tz_name}. Only complete local days are included."
            ),
            "source": ds_hourly.attrs.get("source", "DWD ICON-D2 open data"),
            "timezone_daily": tz_name,
            "complete_day_rule": (
                "A local day is included only if all hourly valid_time values belonging to that "
                "local date are present in the buffer. Expected hours are derived in timezone-aware "
                "mode, so DST days may contain 23, 24, or 25 hours."
            ),
            "daily_aggregations": json.dumps(
                {
                    "t2m": ["mean", "min", "max"],
                    "precip": ["sum"],
                    "rh2m": ["mean", "min"],
                    "gust10m": ["mean", "max"],
                    "tground": ["mean", "min", "max"],
                    "smi9": ["mean", "min"],
                },
                ensure_ascii=False,
            ),
            "input_valid_time_start_utc": ds_hourly.attrs.get("valid_time_start_utc", ""),
            "input_valid_time_end_utc": ds_hourly.attrs.get("valid_time_end_utc", ""),
            "source_latest_run_time_utc": ds_hourly.attrs.get("latest_run_time_utc", ""),
            "created_utc": datetime.now(UTC).isoformat(),
        },
    )

    ds_daily["time"].attrs.update(
        long_name="local day label",
        timezone=tz_name,
        note="Timestamp stored as naive local midnight representing the Italy local date",
    )
    ds_daily["lat"].attrs.update(long_name="latitude", units="degrees_north")
    ds_daily["lon"].attrs.update(long_name="longitude", units="degrees_east")

    ds_daily["t2m_mean"].attrs.update(long_name="daily mean 2 m air temperature", units="degC")
    ds_daily["t2m_min"].attrs.update(long_name="daily minimum 2 m air temperature", units="degC")
    ds_daily["t2m_max"].attrs.update(long_name="daily maximum 2 m air temperature", units="degC")
    ds_daily["precip_sum"].attrs.update(long_name="daily precipitation sum", units="mm")
    ds_daily["rh_mean"].attrs.update(long_name="daily mean 2 m relative humidity", units="%")
    ds_daily["rh_min"].attrs.update(long_name="daily minimum 2 m relative humidity", units="%")
    ds_daily["gust_mean"].attrs.update(long_name="daily mean 10 m maximum wind gust", units="km h-1")
    ds_daily["gust_max"].attrs.update(long_name="daily maximum 10 m maximum wind gust", units="km h-1")
    ds_daily["tground_mean"].attrs.update(long_name="daily mean ground surface temperature", units="degC")
    ds_daily["tground_min"].attrs.update(long_name="daily minimum ground surface temperature", units="degC")
    ds_daily["tground_max"].attrs.update(long_name="daily maximum ground surface temperature", units="degC")
    ds_daily["smi9_mean"].attrs.update(long_name="daily mean soil moisture index, soil level 9", units="1")
    ds_daily["smi9_min"].attrs.update(long_name="daily minimum soil moisture index, soil level 9", units="1")

    ds_daily = ds_daily.assign_coords(
        n_hours=("time", np.array(n_hours_per_day, dtype=np.int16))
    )
    ds_daily["n_hours"].attrs.update(
        long_name="number of hourly records aggregated for the local day",
        note="Can be 23, 24, or 25 depending on DST",
    )

    return ds_daily


# ------------------------------------------------------------------------------
# Main
# ------------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Aggrega il buffer orario rolling in campi giornalieri locali "
            f"({TIMEZONE_DAILY}) includendo solo i giorni completi."
        )
    )
    parser.add_argument(
        "--hourly-buffer",
        type=str,
        default=str(default_hourly_buffer_path()),
        help="Path del buffer orario input. Default: backend/data/intermediate/meteo/hourly_buffer.nc",
    )
    parser.add_argument(
        "--out",
        type=str,
        default=str(default_daily_candidates_path()),
        help="Path output del NetCDF daily. Default: backend/data/intermediate/meteo/daily_candidates.nc",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Sovrascrive l'output se esiste già.",
    )
    args = parser.parse_args()

    hourly_buffer_path = Path(args.hourly_buffer)
    out_path = Path(args.out)

    print("=" * 78)
    print("BUILD DAILY FROM HOURLY BUFFER")
    print(f"Input buffer       : {hourly_buffer_path}")
    print(f"Output             : {out_path}")
    print(f"Timezone daily     : {TIMEZONE_DAILY}")
    print(f"Overwrite          : {args.overwrite}")
    print("=" * 78)

    ds_hourly = open_dataset(hourly_buffer_path)
    validate_hourly_buffer(ds_hourly, hourly_buffer_path)

    ds_daily = build_daily_candidates(ds_hourly, tz_name=TIMEZONE_DAILY)

    save_daily_dataset(ds_daily, out_path, overwrite=args.overwrite)

    print("\nOutput:")
    print(out_path.resolve())
    print(f"n_days             : {ds_daily.sizes['time']}")
    print(f"time start         : {str(ds_daily['time'].values[0])}")
    print(f"time end           : {str(ds_daily['time'].values[-1])}")
    print(f"n_hours per day    : {ds_daily['n_hours'].values.tolist()}")
    print("\nDone OK")


if __name__ == "__main__":
    main()
