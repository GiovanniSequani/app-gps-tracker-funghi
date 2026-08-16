from __future__ import annotations

from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
import pytest
from netCDF4 import Dataset, date2num

from backend.src.publication.supabase import (
    WeatherPublisher,
    latest_tile_index_date,
    weather_publication_decision,
)
from backend.src.publication.weather import (
    WEATHER_NODATA,
    build_weather_dataset,
    decode_tenths,
    quantize_tenths,
)


def write_weather_source(
    path: Path,
    *,
    start: date = date(2026, 1, 1),
    days: int = 21,
    missing_day: date | None = None,
) -> None:
    dates = [
        start + timedelta(days=offset)
        for offset in range(days)
        if start + timedelta(days=offset) != missing_day
    ]
    lat = 45.6015 + np.arange(12, dtype=np.float32) * np.float32(0.003)
    lon = 10.4015 + np.arange(18, dtype=np.float32) * np.float32(0.003)
    with Dataset(path, "w") as ds:
        ds.createDimension("time", len(dates))
        ds.createDimension("lat", len(lat))
        ds.createDimension("lon", len(lon))
        time_var = ds.createVariable("time", "i4", ("time",))
        time_var.units = "days since 2026-01-01 00:00:00"
        time_var.calendar = "proleptic_gregorian"
        time_var[:] = date2num(
            [datetime.combine(item, datetime.min.time()) for item in dates],
            time_var.units,
            time_var.calendar,
        )
        ds.createVariable("lat", "f4", ("lat",))[:] = lat
        ds.createVariable("lon", "f4", ("lon",))[:] = lon
        specs = {
            "t2m_min": ("degC", -2.0),
            "t2m_max": ("degC", 12.0),
            "precip_sum": ("mm", 4.0),
            "rh_mean": ("%", 71.0),
            "gust_max": ("km h-1", 33.0),
        }
        for name, (unit, base) in specs.items():
            var = ds.createVariable(name, "f4", ("time", "lat", "lon"))
            var.units = unit
            values = np.empty((len(dates), len(lat), len(lon)), dtype=np.float32)
            for time_idx in range(len(dates)):
                values[time_idx] = base + time_idx * 0.1
            var[:] = values
        ds.target_crs = "EPSG:4326"
        ds.target_step_deg = 0.003
        ds.bbox_west = 10.4
        ds.bbox_south = 45.6
        ds.bbox_east = 10.4 + len(lon) * 0.003
        ds.bbox_north = 45.6 + len(lat) * 0.003


def test_selects_last_20_days_without_future_dates(tmp_path: Path) -> None:
    source = tmp_path / "weather.nc"
    write_weather_source(source)

    dataset = build_weather_dataset(source, "2026-01-20")

    assert dataset.version.startswith("2026-01-20-")
    assert dataset.metadata["version"] == dataset.version
    assert len(dataset.dates) == 20
    assert dataset.dates[0] == date(2026, 1, 1)
    assert dataset.dates[-1] == date(2026, 1, 20)
    assert date(2026, 1, 21) not in dataset.dates


def test_missing_day_is_encoded_as_nodata_in_every_variable(tmp_path: Path) -> None:
    source = tmp_path / "weather.nc"
    write_weather_source(source, missing_day=date(2026, 1, 8))

    dataset = build_weather_dataset(source, "2026-01-20")

    assert dataset.metadata["missing_dates"] == ["2026-01-08"]
    assert dataset.metadata["available_day_count"] == 19
    missing_position = dataset.dates.index(date(2026, 1, 8))
    for values in dataset.values.values():
        assert np.all(values[missing_position] == WEATHER_NODATA)


def test_builds_aligned_point_zero_one_eight_degree_grid(tmp_path: Path) -> None:
    source = tmp_path / "weather.nc"
    write_weather_source(source)

    dataset = build_weather_dataset(source, "2026-01-20")

    assert dataset.rows == 2
    assert dataset.cols == 3
    np.testing.assert_allclose(np.diff(dataset.latitudes), 0.018, atol=1e-5)
    np.testing.assert_allclose(np.diff(dataset.longitudes), 0.018, atol=1e-5)
    assert dataset.metadata["sampling_method"].startswith("direct representative-cell")


def test_coordinate_to_weather_cell_uses_nearest_sampled_center(tmp_path: Path) -> None:
    source = tmp_path / "weather.nc"
    write_weather_source(source)
    dataset = build_weather_dataset(source, "2026-01-20")

    assert dataset.cell_for_coordinate(45.6015, 10.4015) == (0, 0)
    assert dataset.cell_for_coordinate(45.6195, 10.4375) == (1, 2)
    with pytest.raises(ValueError, match="outside"):
        dataset.cell_for_coordinate(40.0, 10.42)


def test_weather_quantization_round_trip_and_nodata() -> None:
    source = np.array([-3.26, 0.0, 12.34, np.nan], dtype=np.float32)

    encoded = quantize_tenths(source)
    decoded = decode_tenths(encoded)

    np.testing.assert_array_equal(encoded[:3], np.array([-33, 0, 123], dtype=np.int16))
    assert encoded[3] == WEATHER_NODATA
    np.testing.assert_allclose(decoded[:3], [-3.3, 0.0, 12.3], atol=1e-6)
    assert np.isnan(decoded[3])


class FakeWeatherClient:
    def __init__(self) -> None:
        self.current_version: str | None = None
        self.datasets: dict[str, dict[str, object]] = {}
        self.cells: dict[str, dict[tuple[int, int], dict[str, object]]] = {}
        self.fail_publish = False
        self.unrelated_tiles = {"keep": True}

    def rest_select(self, table: str, *, params: dict[str, str]):
        if table == "public_weather_state":
            return (
                [{"current_version": self.current_version}]
                if self.current_version is not None
                else []
            )
        version = params["version"].removeprefix("eq.")
        row = self.datasets.get(version)
        return [row] if row else []

    def rest_upsert(self, table: str, rows, *, on_conflict: str) -> None:
        assert table == "public_weather_cells"
        for row in rows:
            version = str(row["version"])
            self.cells.setdefault(version, {})[
                (int(row["row_idx"]), int(row["col_idx"]))
            ] = row

    def rpc(self, function: str, payload: dict[str, object]):
        if function == "public_weather_storage_stats":
            return {"relation_bytes": 4096}
        version = str(payload["p_version"])
        if function == "prepare_public_weather_version":
            self.datasets[version] = {
                "version": version,
                "index_date": str(payload["p_index_date"]),
                "status": "staging",
                "content_sha256": payload["p_content_sha256"],
                "expected_cells": int(payload["p_rows"]) * int(payload["p_cols"]),
            }
            self.cells[version] = {}
            return None
        if function == "publish_public_weather_version":
            if self.fail_publish:
                raise RuntimeError("incomplete upload")
            dataset = self.datasets[version]
            assert len(self.cells[version]) == dataset["expected_cells"]
            dataset["status"] = "current"
            self.current_version = version
            self.datasets = {version: dataset}
            self.cells = {version: self.cells[version]}
            return {"version": version, "relation_bytes": 8192}
        raise AssertionError(function)


def test_weather_publication_is_idempotent_and_cleans_only_old_version(tmp_path: Path) -> None:
    source = tmp_path / "weather.nc"
    write_weather_source(source)
    dataset = build_weather_dataset(source, "2026-01-20")
    client = FakeWeatherClient()
    client.datasets["2026-01-19"] = {
        "version": "2026-01-19",
        "status": "current",
        "content_sha256": "0" * 64,
        "expected_cells": 1,
    }
    client.cells["2026-01-19"] = {}
    client.current_version = "2026-01-19"
    client.datasets["2026-01-19"]["index_date"] = "2026-01-19"

    first = WeatherPublisher(client, batch_size=2).publish(dataset)
    second = WeatherPublisher(client, batch_size=2).publish(dataset)

    assert first.action == "published"
    assert second.action == "unchanged"
    assert set(client.datasets) == {dataset.version}
    assert client.unrelated_tiles == {"keep": True}


def test_weather_pointer_is_unchanged_when_final_validation_fails(tmp_path: Path) -> None:
    source = tmp_path / "weather.nc"
    write_weather_source(source)
    dataset = build_weather_dataset(source, "2026-01-20")
    client = FakeWeatherClient()
    client.current_version = "2026-01-19"
    client.datasets["2026-01-19"] = {
        "version": "2026-01-19",
        "index_date": "2026-01-19",
        "status": "current",
        "content_sha256": "0" * 64,
        "expected_cells": 1,
    }
    client.fail_publish = True

    with pytest.raises(RuntimeError, match="incomplete"):
        WeatherPublisher(client).publish(dataset)

    assert client.current_version == "2026-01-19"


def test_older_weather_never_replaces_newer_current_version(tmp_path: Path) -> None:
    source = tmp_path / "weather.nc"
    write_weather_source(source)
    dataset = build_weather_dataset(source, "2026-01-20")
    client = FakeWeatherClient()
    client.current_version = "2026-01-21"
    client.datasets["2026-01-21"] = {
        "version": "2026-01-21",
        "index_date": "2026-01-21",
        "status": "current",
        "content_sha256": "0" * 64,
        "expected_cells": 1,
    }

    result = WeatherPublisher(client).publish(dataset)

    assert result.action == "skipped_older"
    assert client.current_version == "2026-01-21"
    assert "2026-01-20" not in client.datasets


def test_same_date_weather_reanalysis_replaces_content_atomically(tmp_path: Path) -> None:
    source = tmp_path / "weather.nc"
    write_weather_source(source)
    original = build_weather_dataset(source, "2026-01-20")
    write_weather_source(source, missing_day=date(2026, 1, 8))
    revised = build_weather_dataset(source, "2026-01-20")
    assert original.version != revised.version

    client = FakeWeatherClient()
    WeatherPublisher(client, batch_size=2).publish(original)
    result = WeatherPublisher(client, batch_size=2).publish(revised)

    assert result.action == "published"
    assert client.current_version == revised.version
    assert client.datasets[revised.version]["index_date"] == "2026-01-20"
    assert set(client.datasets) == {revised.version}


class FakeTileManifestClient:
    def __init__(self, payload: bytes | None) -> None:
        self.payload = payload
        self.calls: list[tuple[str, str]] = []

    def storage_get(self, bucket: str, path: str) -> bytes | None:
        self.calls.append((bucket, path))
        return self.payload


def test_latest_index_date_comes_from_tile_manifest_without_listing() -> None:
    client = FakeTileManifestClient(
        b'{"tileSets":[{"date":"2026-07-23","version":"1"},'
        b'{"date":"2026-07-25","version":"1"},{"date":"2026_07_24","version":"2"}]}'
    )

    assert latest_tile_index_date(client) == "2026-07-25"
    assert client.calls == [("tiles", "tile_sets.json")]


def test_weather_publication_decision_skips_history_and_rejects_unpublished_future() -> None:
    assert weather_publication_decision("2026-07-24", "2026-07-25") == "skip_older"
    assert weather_publication_decision("2026-07-25", "2026-07-25") == "publish"
    with pytest.raises(RuntimeError, match="latest Supabase index"):
        weather_publication_decision("2026-07-26", "2026-07-25")
