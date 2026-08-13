from __future__ import annotations

from datetime import date
import importlib
from pathlib import Path

import numpy as np
import xarray as xr

from backend.scripts.meteo.run_hrs_reanalysis import affected_index_dates
from backend.scripts.meteo.run_hrs_reanalysis import manifest_payload, retained_versions
from backend.src.index.features import select_recent_window
from backend.src.meteo.time_series import (
    HRS_VARIABLE_MAP,
    compose_weather_window,
    import_hrs,
    merge_icon_daily,
    read_dates,
    save_composite_window,
    validate_hrs,
)

build_manifest_json = importlib.import_module(
    "backend.scripts.tiles.01_build_tiles_gdal"
).build_manifest_json


def canonical_dataset(dates: list[str], value: float = 1.0) -> xr.Dataset:
    shape = (len(dates), 2, 3)
    values = {
        name: (("time", "lat", "lon"), np.full(shape, value, dtype=np.float32))
        for name in (
            "t2m_mean", "t2m_min", "t2m_max", "precip_sum", "rh_mean", "rh_min",
            "gust_mean", "gust_max", "tground_mean", "tground_min", "tground_max",
            "smi9_mean", "smi9_min",
        )
    }
    ds = xr.Dataset(
        values,
        coords={
            "time": np.asarray(dates, dtype="datetime64[D]"),
            "lat": np.asarray([0.0015, 0.0045], dtype=np.float64),
            "lon": np.asarray([0.0015, 0.0045, 0.0075], dtype=np.float64),
        },
    )
    ds["t2m_min"][:] = value - 1
    ds["t2m_max"][:] = value + 1
    for name, unit in {
        "t2m_mean": "degC", "t2m_min": "degC", "t2m_max": "degC",
        "precip_sum": "mm", "rh_mean": "%", "rh_min": "%",
        "gust_mean": "km h-1", "gust_max": "km h-1",
    }.items():
        ds[name].attrs["units"] = unit
    ds.attrs.update(target_step_deg=0.003, target_crs="EPSG:4326")
    return ds


def hrs_dataset(dates: list[str], value: float = 10.0) -> xr.Dataset:
    shape = (len(dates), 2, 3)
    variables = {}
    for source in HRS_VARIABLE_MAP:
        current = value
        if source == "TC2M_MIN":
            current = value - 1
        elif source == "TC2M_MAX":
            current = value + 1
        elif source.startswith("RH"):
            current = 70.0
        elif source == "PREC_DAILY":
            current = 2.0
        variables[source] = (("time", "lat", "lon"), np.full(shape, current, dtype=np.float32))
    ds = xr.Dataset(
        variables,
        coords={
            "time": np.asarray(dates, dtype="datetime64[D]"),
            "lat": np.asarray([0.0015, 0.0045], dtype=np.float64),
            "lon": np.asarray([0.0015, 0.0045, 0.0075], dtype=np.float64),
        },
    )
    units = {
        "TC2M_MIN": "C", "TC2M_MAX": "C", "TC2M_MEAN": "C",
        "PREC_DAILY": "mm", "RH2M_MIN": "%", "RH2M_MEAN": "%", "GUST_MAX": "ms-1",
    }
    for name, unit in units.items():
        ds[name].attrs["units"] = unit
    return ds


def test_yearly_icon_merge_is_idempotent_and_updates_recovery(tmp_path: Path) -> None:
    daily = tmp_path / "daily.nc"
    output = tmp_path / "icon_ruc_time_series_2026.nc"
    recovery = tmp_path / "recovery_icon_ruc_time_series_2026.nc"
    canonical_dataset(["2026-06-01", "2026-06-02"]).to_netcdf(daily)
    merge_icon_daily(daily, output, recovery)
    canonical_dataset(["2026-06-02", "2026-06-03"], value=5.0).to_netcdf(daily)
    merge_icon_daily(daily, output, recovery)
    assert read_dates(output) == (date(2026, 6, 1), date(2026, 6, 2), date(2026, 6, 3))
    assert recovery.read_bytes() == output.read_bytes()
    with xr.open_dataset(output) as ds:
        assert float(ds["t2m_mean"].sel(time="2026-06-02").mean()) == 5.0


def test_corrupt_active_icon_series_recovers_from_last_valid_copy(tmp_path: Path) -> None:
    daily = tmp_path / "daily.nc"
    output = tmp_path / "icon_ruc_time_series_2026.nc"
    recovery = tmp_path / "recovery_icon_ruc_time_series_2026.nc"
    canonical_dataset(["2026-06-01"], value=1.0).to_netcdf(daily)
    merge_icon_daily(daily, output, recovery)
    output.write_bytes(b"not a netcdf")
    canonical_dataset(["2026-06-02"], value=2.0).to_netcdf(daily)
    dates = merge_icon_daily(daily, output, recovery)
    assert dates == (date(2026, 6, 1), date(2026, 6, 2))
    assert recovery.read_bytes() == output.read_bytes()


def test_exact_calendar_window_keeps_missing_day_as_nan() -> None:
    ds = canonical_dataset(["2026-06-01", "2026-06-03", "2026-06-04"])
    window = select_recent_window(ds, "2026-06-04", 4)
    assert [str(item)[:10] for item in window.time.values] == [
        "2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04",
    ]
    assert np.isnan(window["t2m_mean"].isel(time=1)).all()


def test_hrs_complete_day_overrides_icon_and_converts_gust(tmp_path: Path) -> None:
    icon = tmp_path / "icon_ruc_time_series_2026.nc"
    recovery = tmp_path / "recovery.nc"
    daily = tmp_path / "daily.nc"
    canonical_dataset(["2026-06-01", "2026-06-02"], value=1.0).to_netcdf(daily)
    merge_icon_daily(daily, icon, recovery)
    incoming = tmp_path / "hrs.nc"
    hrs_dataset(["2026-06-02"], value=10.0).to_netcdf(incoming)
    result = validate_hrs(incoming, icon)
    assert result.fallback_dates == ()
    canonical = tmp_path / "hrs_time_series_2026.nc"
    import_hrs(incoming, canonical, icon)
    window = compose_weather_window("2026-06-02", 2, tmp_path)
    assert window.weather_source.values.tolist() == [1, 2]
    assert float(window.t2m_mean.isel(time=1).mean()) == 10.0
    assert np.isclose(float(window.gust_max.isel(time=1).mean()), 36.0)
    prepared = tmp_path / "composite.nc"
    save_composite_window("2026-06-02", 2, prepared, tmp_path)
    with xr.open_dataset(prepared) as stored:
        assert stored.weather_source.values.tolist() == [1, 2]
        assert float(stored.t2m_mean.isel(time=1).mean()) == 10.0


def test_invalid_hrs_day_falls_back_entirely_to_icon(tmp_path: Path) -> None:
    icon = tmp_path / "icon_ruc_time_series_2026.nc"
    recovery = tmp_path / "recovery.nc"
    daily = tmp_path / "daily.nc"
    canonical_dataset(["2026-06-01"], value=3.0).to_netcdf(daily)
    merge_icon_daily(daily, icon, recovery)
    incoming = tmp_path / "hrs.nc"
    hrs = hrs_dataset(["2026-06-01"], value=10.0)
    hrs["PREC_DAILY"][0, 0, 0] = np.nan
    hrs.to_netcdf(incoming)
    result = validate_hrs(incoming, icon)
    assert result.fallback_dates == (date(2026, 6, 1),)
    assert result.valid_dates == ()


def test_reanalysis_continues_through_latest_index_for_recovery() -> None:
    available = tuple(date(2026, 6, day) for day in range(1, 11))
    assert affected_index_dates((date(2026, 6, 4),), available) == available[3:]


def test_reanalysis_publishes_only_manifest_dates_with_new_revision() -> None:
    entries = [
        {"date": "2026-06-03", "version": "1"},
        {"date": "2026-06-05", "version": "2"},
    ]
    retained = retained_versions(entries)
    affected = (date(2026, 6, 4), date(2026, 6, 5), date(2026, 6, 6))
    published = [item for item in affected if item in retained]
    assert published == [date(2026, 6, 5)]
    payload = manifest_payload(entries, {date(2026, 6, 5): 3}).decode("utf-8")
    assert '"date":"2026-06-05","version":"3"' in payload
    assert "2026-06-04" not in payload


def test_tile_manifest_keeps_only_newest_version_per_date() -> None:
    raw = build_manifest_json([
        {"date": "2026-06-05", "version": "1", "name": "2026-06-05_v1", "year": 2026, "month": 6, "day": 5, "versionNum": 1},
        {"date": "2026-06-05", "version": "2", "name": "2026-06-05_v2", "year": 2026, "month": 6, "day": 5, "versionNum": 2},
    ])
    assert raw.count('"date":"2026-06-05"') == 1
    assert '"version":"2"' in raw
