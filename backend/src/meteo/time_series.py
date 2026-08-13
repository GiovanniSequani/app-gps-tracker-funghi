from __future__ import annotations

import os
import shutil
from contextlib import ExitStack
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Sequence

import numpy as np
import xarray as xr
from netCDF4 import Dataset, date2num, num2date

from backend.config.meteo import DAILY_FINAL_VARIABLES
from backend.config.paths import FINAL_METEO_DIR

UTC = timezone.utc
SCORING_WEATHER_VARIABLES = (
    "t2m_mean",
    "t2m_min",
    "t2m_max",
    "precip_sum",
    "rh_mean",
    "rh_min",
    "gust_max",
)
HRS_VARIABLE_MAP = {
    "TC2M_MEAN": ("t2m_mean", 1.0, "degC"),
    "TC2M_MIN": ("t2m_min", 1.0, "degC"),
    "TC2M_MAX": ("t2m_max", 1.0, "degC"),
    "PREC_DAILY": ("precip_sum", 1.0, "mm"),
    "RH2M_MEAN": ("rh_mean", 1.0, "%"),
    "RH2M_MIN": ("rh_min", 1.0, "%"),
    "GUST_MAX": ("gust_max", 3.6, "km h-1"),
}
EXPECTED_HRS_UNITS = {
    "TC2M_MEAN": {"C", "degC", "degree_Celsius"},
    "TC2M_MIN": {"C", "degC", "degree_Celsius"},
    "TC2M_MAX": {"C", "degC", "degree_Celsius"},
    "PREC_DAILY": {"mm"},
    "RH2M_MEAN": {"%", "percent"},
    "RH2M_MIN": {"%", "percent"},
    "GUST_MAX": {"ms-1", "m s-1", "m/s"},
}
CANONICAL_UNITS = {
    "t2m_mean": "degC",
    "t2m_min": "degC",
    "t2m_max": "degC",
    "precip_sum": "mm",
    "rh_mean": "%",
    "rh_min": "%",
    "gust_mean": "km h-1",
    "gust_max": "km h-1",
}


@dataclass(frozen=True)
class HrsValidation:
    path: Path
    dates: tuple[date, ...]
    valid_dates: tuple[date, ...]
    fallback_dates: tuple[date, ...]
    rows: int
    cols: int


def _decode_dates(ds: Dataset) -> tuple[date, ...]:
    if "time" not in ds.variables:
        raise ValueError("missing time coordinate")
    var = ds.variables["time"]
    if not getattr(var, "units", None):
        raise ValueError("time coordinate has no units")
    values = num2date(
        var[:],
        units=var.units,
        calendar=getattr(var, "calendar", "standard"),
        only_use_cftime_datetimes=False,
    )
    return tuple(date(item.year, item.month, item.day) for item in values)


def read_dates(path: Path) -> tuple[date, ...]:
    with Dataset(path, "r") as ds:
        return _decode_dates(ds)


def _require_grid(ds: Dataset, reference: Dataset | None = None) -> tuple[np.ndarray, np.ndarray]:
    for name in ("lat", "lon"):
        if name not in ds.variables:
            raise ValueError(f"missing {name} coordinate")
    lat = np.asarray(ds.variables["lat"][:], dtype=np.float64)
    lon = np.asarray(ds.variables["lon"][:], dtype=np.float64)
    if lat.ndim != 1 or lon.ndim != 1 or lat.size < 2 or lon.size < 2:
        raise ValueError("lat/lon must be non-empty one-dimensional coordinates")
    if not np.all(np.diff(lat) > 0.0) or not np.all(np.diff(lon) > 0.0):
        raise ValueError("lat/lon must be strictly ascending")
    if not np.allclose(np.diff(lat), 0.003, rtol=0.0, atol=3e-6):
        raise ValueError("latitude grid step must be 0.003 degrees")
    if not np.allclose(np.diff(lon), 0.003, rtol=0.0, atol=3e-6):
        raise ValueError("longitude grid step must be 0.003 degrees")
    if reference is not None:
        ref_lat = np.asarray(reference.variables["lat"][:], dtype=np.float64)
        ref_lon = np.asarray(reference.variables["lon"][:], dtype=np.float64)
        if not np.allclose(lat, ref_lat, rtol=0.0, atol=1e-7) or not np.allclose(lon, ref_lon, rtol=0.0, atol=1e-7):
            raise ValueError("weather grids do not match exactly")
    return lat, lon


def validate_icon_series(path: Path) -> tuple[date, ...]:
    with Dataset(path, "r") as ds:
        _require_grid(ds)
        dates = _decode_dates(ds)
        if not dates or tuple(sorted(dates)) != dates or len(set(dates)) != len(dates):
            raise ValueError(f"invalid or duplicate dates in {path}")
        for name in DAILY_FINAL_VARIABLES:
            if name not in ds.variables:
                raise ValueError(f"ICON-RUC series is missing variable {name}")
            if ds.variables[name].dimensions != ("time", "lat", "lon"):
                raise ValueError(f"invalid dimensions for {name}")
    return dates


def validate_hrs(path: Path, reference_path: Path | None = None) -> HrsValidation:
    if not path.is_file():
        raise FileNotFoundError(path)
    with ExitStack() as stack:
        ds = stack.enter_context(Dataset(path, "r"))
        reference = stack.enter_context(Dataset(reference_path, "r")) if reference_path else None
        lat, lon = _require_grid(ds, reference)
        dates = _decode_dates(ds)
        if not dates or tuple(sorted(dates)) != dates or len(set(dates)) != len(dates):
            raise ValueError("HRS dates must be unique and ascending")
        expected = tuple(dates[0] + timedelta(days=i) for i in range(len(dates)))
        if dates != expected:
            raise ValueError("HRS dates must be daily and contiguous")
        for source, (_, _, _) in HRS_VARIABLE_MAP.items():
            if source not in ds.variables:
                raise ValueError(f"HRS is missing variable {source}")
            var = ds.variables[source]
            if var.dimensions != ("time", "lat", "lon"):
                raise ValueError(f"{source} dimensions must be ('time', 'lat', 'lon')")
            unit = str(getattr(var, "units", ""))
            if unit not in EXPECTED_HRS_UNITS[source]:
                raise ValueError(f"{source} has unsupported unit {unit!r}")

        valid: list[date] = []
        fallback: list[date] = []
        for idx, item in enumerate(dates):
            arrays = {
                source: np.asarray(np.ma.filled(ds.variables[source][idx, :, :], np.nan), dtype=np.float32)
                for source in HRS_VARIABLE_MAP
            }
            complete = all(np.isfinite(values).all() for values in arrays.values())
            plausible = complete and (
                np.min(arrays["PREC_DAILY"]) >= 0.0
                and np.min(arrays["RH2M_MIN"]) >= 0.0
                and np.max(arrays["RH2M_MIN"]) <= 100.0
                and np.min(arrays["RH2M_MEAN"]) >= 0.0
                and np.max(arrays["RH2M_MEAN"]) <= 100.0
                and np.min(arrays["GUST_MAX"]) >= 0.0
                and np.min(arrays["TC2M_MIN"]) >= -80.0
                and np.max(arrays["TC2M_MAX"]) <= 70.0
                and np.all(arrays["TC2M_MIN"] <= arrays["TC2M_MEAN"])
                and np.all(arrays["TC2M_MEAN"] <= arrays["TC2M_MAX"])
            )
            (valid if complete and plausible else fallback).append(item)
    return HrsValidation(path, dates, tuple(valid), tuple(fallback), lat.size, lon.size)


def _copy_global_attrs(source: Dataset, target: Dataset) -> None:
    for name in source.ncattrs():
        if name not in {"time_start", "time_end", "created_utc", "updated_utc"}:
            target.setncattr(name, source.getncattr(name))


def _create_writer(path: Path, template: Dataset, variables: Sequence[str], title: str) -> Dataset:
    path.parent.mkdir(parents=True, exist_ok=True)
    out = Dataset(path, "w", format="NETCDF4")
    out.createDimension("time", None)
    out.createDimension("lat", len(template.dimensions["lat"]))
    out.createDimension("lon", len(template.dimensions["lon"]))
    time_var = out.createVariable("time", "i8", ("time",))
    time_var.units = "days since 1970-01-01 00:00:00"
    time_var.calendar = "standard"
    for coord in ("lat", "lon"):
        source = template.variables[coord]
        target = out.createVariable(coord, "f4", (coord,))
        target[:] = source[:]
        for attr in source.ncattrs():
            if attr != "_FillValue":
                target.setncattr(attr, source.getncattr(attr))
    for name in variables:
        target = out.createVariable(
            name,
            "f4",
            ("time", "lat", "lon"),
            zlib=True,
            complevel=4,
            chunksizes=(1, min(100, len(template.dimensions["lat"])), min(140, len(template.dimensions["lon"]))),
            fill_value=np.float32(np.nan),
        )
        target.units = CANONICAL_UNITS.get(name, str(getattr(template.variables.get(name), "units", "1")))
    _copy_global_attrs(template, out)
    out.title = title
    out.target_crs = str(getattr(template, "target_crs", "EPSG:4326"))
    out.target_step_deg = float(getattr(template, "target_step_deg", 0.003))
    return out


def _finish_writer(out: Dataset, dates: Sequence[date], source: str) -> None:
    out.variables["time"][:] = date2num(
        [datetime.combine(item, datetime.min.time()) for item in dates],
        out.variables["time"].units,
        calendar="standard",
    ).astype(np.int64)
    out.time_start = dates[0].isoformat()
    out.time_end = dates[-1].isoformat()
    out.updated_utc = datetime.now(UTC).isoformat()
    out.source = source


def _atomic_copy(source: Path, target: Path) -> None:
    temp = target.with_suffix(target.suffix + ".tmp")
    if temp.exists():
        temp.unlink()
    shutil.copy2(source, temp)
    os.replace(temp, target)


def merge_icon_daily(daily_path: Path, output_path: Path, recovery_path: Path) -> tuple[date, ...]:
    with Dataset(daily_path, "r") as incoming:
        _require_grid(incoming)
        incoming_dates = _decode_dates(incoming)
        if not incoming_dates:
            raise ValueError("daily ICON-RUC input is empty")
        if any(item.year != incoming_dates[0].year for item in incoming_dates):
            raise ValueError("one daily update may not span multiple years")
        for name in DAILY_FINAL_VARIABLES:
            if name not in incoming.variables:
                raise ValueError(f"daily ICON-RUC input is missing {name}")

    base_path: Path | None = None
    if output_path.exists():
        try:
            validate_icon_series(output_path)
            base_path = output_path
        except Exception:
            if recovery_path.exists():
                validate_icon_series(recovery_path)
                base_path = recovery_path
            else:
                raise

    temp = output_path.with_suffix(output_path.suffix + ".building")
    if temp.exists():
        temp.unlink()
    with ExitStack() as stack:
        incoming = stack.enter_context(Dataset(daily_path, "r"))
        base = stack.enter_context(Dataset(base_path, "r")) if base_path else None
        if base is not None:
            _require_grid(incoming, base)
        template = base or incoming
        base_dates = _decode_dates(base) if base is not None else ()
        incoming_dates = _decode_dates(incoming)
        all_dates = tuple(sorted(set(base_dates) | set(incoming_dates)))
        base_pos = {item: idx for idx, item in enumerate(base_dates)}
        new_pos = {item: idx for idx, item in enumerate(incoming_dates)}
        out = stack.enter_context(_create_writer(temp, template, DAILY_FINAL_VARIABLES, "ICON-D2-RUC yearly daily weather time series"))
        for out_idx, item in enumerate(all_dates):
            source = incoming if item in new_pos else base
            source_idx = new_pos[item] if item in new_pos else base_pos[item]
            assert source is not None
            for name in DAILY_FINAL_VARIABLES:
                if name in source.variables:
                    out.variables[name][out_idx, :, :] = source.variables[name][source_idx, :, :]
                else:
                    out.variables[name][out_idx, :, :] = np.nan
        _finish_writer(out, all_dates, "DWD ICON-D2-RUC")
        out.latest_run_time_utc = str(
            getattr(incoming, "source_latest_run_time_utc", getattr(incoming, "latest_run_time_utc", ""))
        )
    validate_icon_series(temp)
    os.replace(temp, output_path)
    _atomic_copy(output_path, recovery_path)
    return read_dates(output_path)


def bootstrap_icon_series(source_paths: Iterable[Path], output_path: Path, recovery_path: Path) -> tuple[date, ...]:
    sources = [Path(path) for path in source_paths if Path(path).is_file()]
    if not sources:
        raise ValueError("no ICON-RUC sources supplied for bootstrap")
    selected: dict[date, tuple[Path, int]] = {}
    template_path = sources[-1]
    with Dataset(template_path, "r") as template:
        _require_grid(template)
    for path in sources:
        with Dataset(path, "r") as ds, Dataset(template_path, "r") as template:
            _require_grid(ds, template)
            for idx, item in enumerate(_decode_dates(ds)):
                selected[item] = (path, idx)
    dates = tuple(sorted(selected))
    if any(item.year != dates[0].year for item in dates):
        raise ValueError("bootstrap sources must belong to one calendar year")
    temp = output_path.with_suffix(output_path.suffix + ".building")
    if temp.exists():
        temp.unlink()
    with Dataset(template_path, "r") as template, _create_writer(
        temp,
        template,
        DAILY_FINAL_VARIABLES,
        "ICON-D2-RUC yearly daily weather time series",
    ) as out:
        current_path: Path | None = None
        current: Dataset | None = None
        try:
            for out_idx, item in enumerate(dates):
                path, source_idx = selected[item]
                if path != current_path:
                    if current is not None:
                        current.close()
                    current = Dataset(path, "r")
                    current_path = path
                for name in DAILY_FINAL_VARIABLES:
                    if name in current.variables:
                        out.variables[name][out_idx, :, :] = current.variables[name][source_idx, :, :]
                    else:
                        out.variables[name][out_idx, :, :] = np.nan
        finally:
            if current is not None:
                current.close()
        _finish_writer(out, dates, "DWD ICON-D2-RUC; bootstrapped from legacy daily snapshots")
        last_path, _ = selected[dates[-1]]
        with Dataset(last_path, "r") as last_source:
            out.latest_run_time_utc = str(
                getattr(last_source, "latest_run_time_utc", getattr(last_source, "source_latest_run_time_utc", ""))
            )
    validate_icon_series(temp)
    os.replace(temp, output_path)
    _atomic_copy(output_path, recovery_path)
    return dates


def import_hrs(source_path: Path, output_path: Path, reference_path: Path) -> HrsValidation:
    validation = validate_hrs(source_path, reference_path)
    valid_set = set(validation.valid_dates)
    with ExitStack() as stack:
        incoming = stack.enter_context(Dataset(source_path, "r"))
        existing = stack.enter_context(Dataset(output_path, "r")) if output_path.exists() else None
        if existing is not None:
            _require_grid(incoming, existing)
        old_dates = _decode_dates(existing) if existing is not None else ()
        source_dates = _decode_dates(incoming)
        dates = tuple(sorted(set(old_dates) | valid_set))
        old_pos = {item: idx for idx, item in enumerate(old_dates)}
        source_pos = {item: idx for idx, item in enumerate(source_dates)}
        temp = output_path.with_suffix(output_path.suffix + ".building")
        if temp.exists():
            temp.unlink()
        out = stack.enter_context(_create_writer(temp, existing or incoming, SCORING_WEATHER_VARIABLES, "Validated HRS yearly reanalysis time series"))
        reverse_map = {target: (source, factor) for source, (target, factor, _) in HRS_VARIABLE_MAP.items()}
        for out_idx, item in enumerate(dates):
            use_new = item in valid_set
            for target in SCORING_WEATHER_VARIABLES:
                if use_new:
                    source, factor = reverse_map[target]
                    values = np.asarray(np.ma.filled(incoming.variables[source][source_pos[item], :, :], np.nan), dtype=np.float32)
                    out.variables[target][out_idx, :, :] = values * np.float32(factor)
                else:
                    assert existing is not None
                    out.variables[target][out_idx, :, :] = existing.variables[target][old_pos[item], :, :]
        if dates:
            _finish_writer(out, dates, "HRS reanalysis; canonical units")
        else:
            raise ValueError("HRS input has no complete valid day")
    validate_canonical_hrs(temp, reference_path)
    os.replace(temp, output_path)
    return validation


def validate_canonical_hrs(path: Path, reference_path: Path) -> tuple[date, ...]:
    with Dataset(reference_path, "r") as reference, Dataset(path, "r") as ds:
        _require_grid(ds, reference)
        dates = _decode_dates(ds)
        if tuple(sorted(dates)) != dates or len(set(dates)) != len(dates):
            raise ValueError("canonical HRS dates are invalid")
        for name in SCORING_WEATHER_VARIABLES:
            if name not in ds.variables:
                raise ValueError(f"canonical HRS is missing {name}")
            if ds.variables[name].dimensions != ("time", "lat", "lon"):
                raise ValueError(f"invalid canonical HRS dimensions for {name}")
    return dates


def _series_for_year(kind: str, year: int, meteo_dir: Path) -> Path:
    if kind == "icon":
        return meteo_dir / f"icon_ruc_time_series_{year}.nc"
    return meteo_dir / f"hrs_time_series_{year}.nc"


def compose_weather_window(
    target_date: str | date,
    window_days: int,
    meteo_dir: Path = FINAL_METEO_DIR,
) -> xr.Dataset:
    target = datetime.strptime(target_date, "%Y-%m-%d").date() if isinstance(target_date, str) else target_date
    required_dates = tuple(target - timedelta(days=offset) for offset in range(window_days - 1, -1, -1))
    years = sorted({item.year for item in required_dates})
    with ExitStack() as stack:
        icon_sets: dict[int, Dataset] = {}
        hrs_sets: dict[int, Dataset] = {}
        for year in years:
            icon_path = _series_for_year("icon", year, meteo_dir)
            if icon_path.exists():
                icon_sets[year] = stack.enter_context(Dataset(icon_path, "r"))
            hrs_path = _series_for_year("hrs", year, meteo_dir)
            if hrs_path.exists():
                hrs_sets[year] = stack.enter_context(Dataset(hrs_path, "r"))
        if not icon_sets:
            raise FileNotFoundError(f"no ICON-RUC yearly series covers {required_dates[0]}..{required_dates[-1]}")
        template = next(iter(icon_sets.values()))
        lat, lon = _require_grid(template)
        positions: dict[tuple[str, int], dict[date, int]] = {}
        for kind, sets in (("icon", icon_sets), ("hrs", hrs_sets)):
            for year, ds in sets.items():
                _require_grid(ds, template)
                positions[(kind, year)] = {item: idx for idx, item in enumerate(_decode_dates(ds))}

        data = {
            name: np.full((window_days, lat.size, lon.size), np.nan, dtype=np.float32)
            for name in SCORING_WEATHER_VARIABLES
        }
        source_codes = np.zeros(window_days, dtype=np.uint8)
        for day_idx, item in enumerate(required_dates):
            hrs = hrs_sets.get(item.year)
            icon = icon_sets.get(item.year)
            hrs_idx = positions.get(("hrs", item.year), {}).get(item)
            icon_idx = positions.get(("icon", item.year), {}).get(item)
            selected = hrs if hrs_idx is not None else icon if icon_idx is not None else None
            selected_idx = hrs_idx if hrs_idx is not None else icon_idx
            if selected is None or selected_idx is None:
                continue
            source_codes[day_idx] = 2 if hrs_idx is not None else 1
            for name in SCORING_WEATHER_VARIABLES:
                if name in selected.variables:
                    data[name][day_idx] = np.asarray(
                        np.ma.filled(selected.variables[name][selected_idx, :, :], np.nan),
                        dtype=np.float32,
                    )

    ds = xr.Dataset(
        {name: (("time", "lat", "lon"), values) for name, values in data.items()},
        coords={
            "time": np.asarray(required_dates, dtype="datetime64[D]"),
            "lat": lat.astype(np.float32),
            "lon": lon.astype(np.float32),
            "weather_source": ("time", source_codes),
        },
    )
    for name, unit in CANONICAL_UNITS.items():
        if name in ds:
            ds[name].attrs["units"] = unit
    ds["weather_source"].attrs.update(codes="0=missing,1=ICON-RUC,2=HRS")
    ds.attrs.update(
        target_date=target.isoformat(),
        feature_window_days=window_days,
        target_crs="EPSG:4326",
        target_step_deg=0.003,
        weather_source_policy="complete validated HRS day overrides ICON-RUC; otherwise ICON-RUC; missing source is NaN",
    )
    return ds


def save_composite_window(target_date: str, day_count: int, output: Path, meteo_dir: Path = FINAL_METEO_DIR) -> Path:
    target = datetime.strptime(target_date, "%Y-%m-%d").date()
    required_dates = tuple(target - timedelta(days=offset) for offset in range(day_count - 1, -1, -1))
    years = sorted({item.year for item in required_dates})
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_suffix(output.suffix + ".building")
    if temp.exists():
        temp.unlink()
    with ExitStack() as stack:
        icon_sets: dict[int, Dataset] = {}
        hrs_sets: dict[int, Dataset] = {}
        for year in years:
            icon_path = _series_for_year("icon", year, meteo_dir)
            if icon_path.exists():
                icon_sets[year] = stack.enter_context(Dataset(icon_path, "r"))
            hrs_path = _series_for_year("hrs", year, meteo_dir)
            if hrs_path.exists():
                hrs_sets[year] = stack.enter_context(Dataset(hrs_path, "r"))
        if not icon_sets:
            raise FileNotFoundError(f"no ICON-RUC yearly series covers {required_dates[0]}..{required_dates[-1]}")
        template = next(iter(icon_sets.values()))
        _require_grid(template)
        positions: dict[tuple[str, int], dict[date, int]] = {}
        for kind, sets in (("icon", icon_sets), ("hrs", hrs_sets)):
            for year, ds in sets.items():
                _require_grid(ds, template)
                positions[(kind, year)] = {item: idx for idx, item in enumerate(_decode_dates(ds))}
        out = stack.enter_context(_create_writer(temp, template, SCORING_WEATHER_VARIABLES, "HRS/ICON-RUC composed weather window"))
        source_var = out.createVariable("weather_source", "u1", ("time",))
        source_var.codes = "0=missing,1=ICON-RUC,2=HRS"
        source_codes = np.zeros(day_count, dtype=np.uint8)
        for out_idx, item in enumerate(required_dates):
            hrs = hrs_sets.get(item.year)
            icon = icon_sets.get(item.year)
            hrs_idx = positions.get(("hrs", item.year), {}).get(item)
            icon_idx = positions.get(("icon", item.year), {}).get(item)
            selected = hrs if hrs_idx is not None else icon if icon_idx is not None else None
            selected_idx = hrs_idx if hrs_idx is not None else icon_idx
            if selected is None or selected_idx is None:
                for name in SCORING_WEATHER_VARIABLES:
                    out.variables[name][out_idx, :, :] = np.nan
                continue
            source_codes[out_idx] = 2 if hrs_idx is not None else 1
            for name in SCORING_WEATHER_VARIABLES:
                out.variables[name][out_idx, :, :] = selected.variables[name][selected_idx, :, :]
        source_var[:] = source_codes
        _finish_writer(out, required_dates, "validated HRS days override ICON-D2-RUC; incomplete HRS falls back to ICON-D2-RUC")
        out.weather_source_policy = "complete validated HRS day overrides ICON-RUC; otherwise ICON-RUC; missing source is NaN"
    os.replace(temp, output)
    return output
