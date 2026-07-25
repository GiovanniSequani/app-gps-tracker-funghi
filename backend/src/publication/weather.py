from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Iterator

import numpy as np
from netCDF4 import Dataset, num2date

from backend.src.publication.common import (
    canonical_json_bytes,
    coordinate_to_index,
    require_ascending_regular_coordinate,
    sha256_bytes,
    validate_version,
)


PUBLIC_WEATHER_DAYS = 20
PUBLIC_WEATHER_STRIDE = 6
SOURCE_STEP_DEG = 0.003
PUBLIC_STEP_DEG = SOURCE_STEP_DEG * PUBLIC_WEATHER_STRIDE
WEATHER_NODATA = np.int16(-32768)
WEATHER_MIN_VALUE = -32767
WEATHER_MAX_VALUE = 32767

WEATHER_VARIABLES: dict[str, dict[str, object]] = {
    "t2m_min": {
        "unit": "degC",
        "accepted_units": ("degC",),
        "scale": 0.1,
        "offset": 0.0,
        "description": "daily minimum 2 m air temperature",
    },
    "t2m_max": {
        "unit": "degC",
        "accepted_units": ("degC",),
        "scale": 0.1,
        "offset": 0.0,
        "description": "daily maximum 2 m air temperature",
    },
    "precip_sum": {
        "unit": "mm",
        "accepted_units": ("mm",),
        "scale": 0.1,
        "offset": 0.0,
        "description": "daily precipitation sum; never spatially summed",
    },
    "rh_mean": {
        "unit": "%",
        "accepted_units": ("%", "percent"),
        "scale": 0.1,
        "offset": 0.0,
        "description": "daily mean 2 m relative humidity",
    },
    "gust_max": {
        "unit": "km h-1",
        "accepted_units": ("km h-1", "km/h"),
        "scale": 0.1,
        "offset": 0.0,
        "description": "daily maximum 10 m wind gust",
    },
}


@dataclass(frozen=True)
class WeatherDataset:
    version: str
    index_date: date
    dates: tuple[date, ...]
    latitudes: np.ndarray
    longitudes: np.ndarray
    values: dict[str, np.ndarray]
    metadata: dict[str, object]
    content_sha256: str

    @property
    def rows(self) -> int:
        return int(self.latitudes.size)

    @property
    def cols(self) -> int:
        return int(self.longitudes.size)

    @property
    def expected_cells(self) -> int:
        return self.rows * self.cols

    def cell_for_coordinate(self, latitude: float, longitude: float) -> tuple[int, int]:
        bbox = self.metadata["bbox"]
        assert isinstance(bbox, dict)
        row = coordinate_to_index(
            latitude,
            bbox_min=float(bbox["south"]),
            bbox_max=float(bbox["north"]),
            origin=float(self.metadata["origin_lat"]),
            step=float(self.metadata["step_deg"]),
            count=self.rows,
        )
        col = coordinate_to_index(
            longitude,
            bbox_min=float(bbox["west"]),
            bbox_max=float(bbox["east"]),
            origin=float(self.metadata["origin_lon"]),
            step=float(self.metadata["step_deg"]),
            count=self.cols,
        )
        return row, col

    def iter_cell_batches(self, batch_size: int) -> Iterator[list[dict[str, object]]]:
        if batch_size <= 0:
            raise ValueError("batch_size must be positive")
        batch: list[dict[str, object]] = []
        for row_idx in range(self.rows):
            for col_idx in range(self.cols):
                item: dict[str, object] = {
                    "version": self.version,
                    "row_idx": row_idx,
                    "col_idx": col_idx,
                }
                for name, values in self.values.items():
                    item[name] = [
                        int(value)
                        for value in values[:, row_idx, col_idx]
                    ]
                batch.append(item)
                if len(batch) >= batch_size:
                    yield batch
                    batch = []
        if batch:
            yield batch

    def save_local(self, output_dir: Path) -> tuple[Path, Path]:
        output_dir.mkdir(parents=True, exist_ok=True)
        metadata_path = output_dir / "metadata.json"
        values_path = output_dir / "weather_values.npz"
        metadata_path.write_bytes(canonical_json_bytes(self.metadata) + b"\n")
        np.savez_compressed(
            values_path,
            lat=self.latitudes.astype("<f4"),
            lon=self.longitudes.astype("<f4"),
            **{name: values.astype("<i2", copy=False) for name, values in self.values.items()},
        )
        return metadata_path, values_path


def quantize_tenths(
    values: np.ndarray,
    *,
    allow_nodata: bool = True,
) -> np.ndarray:
    source = np.asarray(values, dtype=np.float64)
    finite = np.isfinite(source)
    scaled = np.zeros(source.shape, dtype=np.float64)
    scaled[finite] = np.rint(source[finite] * 10.0)
    if finite.any():
        minimum = float(scaled[finite].min())
        maximum = float(scaled[finite].max())
        if minimum < WEATHER_MIN_VALUE or maximum > WEATHER_MAX_VALUE:
            raise ValueError(
                f"quantized weather value is outside smallint range: {minimum}..{maximum}"
            )
    if not allow_nodata and not finite.all():
        raise ValueError("weather dataset contains nodata values")
    out = np.full(source.shape, WEATHER_NODATA, dtype="<i2")
    out[finite] = scaled[finite].astype("<i2")
    return out


def decode_tenths(values: np.ndarray) -> np.ndarray:
    encoded = np.asarray(values, dtype=np.int16)
    out = encoded.astype(np.float32) / np.float32(10.0)
    out[encoded == WEATHER_NODATA] = np.nan
    return out


def _read_dates(time_var) -> tuple[date, ...]:
    if not hasattr(time_var, "units"):
        raise ValueError("time coordinate has no units")
    decoded = num2date(
        time_var[:],
        units=time_var.units,
        calendar=getattr(time_var, "calendar", "standard"),
        only_use_cftime_datetimes=False,
    )
    dates = tuple(datetime(item.year, item.month, item.day).date() for item in decoded)
    if len(set(dates)) != len(dates):
        raise ValueError("time coordinate contains duplicate dates")
    if tuple(sorted(dates)) != dates:
        raise ValueError("time coordinate must be ascending")
    return dates


def _required_dates(index_date: date, day_count: int) -> tuple[date, ...]:
    return tuple(index_date - timedelta(days=offset) for offset in range(day_count - 1, -1, -1))


def build_weather_dataset(
    source_path: Path,
    index_date: str | date,
    *,
    day_count: int = PUBLIC_WEATHER_DAYS,
    stride: int = PUBLIC_WEATHER_STRIDE,
) -> WeatherDataset:
    if isinstance(index_date, str):
        parsed_index_date = datetime.strptime(index_date, "%Y-%m-%d").date()
    else:
        parsed_index_date = index_date
    version = validate_version(parsed_index_date.isoformat())
    if day_count <= 0:
        raise ValueError("day_count must be positive")
    if stride <= 0:
        raise ValueError("stride must be positive")
    required_dates = _required_dates(parsed_index_date, day_count)

    with Dataset(source_path, "r") as ds:
        for coord_name in ("time", "lat", "lon"):
            if coord_name not in ds.variables:
                raise ValueError(f"weather source is missing coordinate {coord_name}")
        source_dates = _read_dates(ds.variables["time"])
        date_to_index = {item: idx for idx, item in enumerate(source_dates)}
        missing = [item.isoformat() for item in required_dates if item not in date_to_index]
        present_positions = [
            position
            for position, item in enumerate(required_dates)
            if item in date_to_index
        ]
        selected_time_indices = np.array(
            [date_to_index[required_dates[position]] for position in present_positions],
            dtype=np.int64,
        )
        if any(item > parsed_index_date for item in required_dates):
            raise ValueError("weather selection contains a future date")

        lat = np.asarray(ds.variables["lat"][:], dtype=np.float64)
        lon = np.asarray(ds.variables["lon"][:], dtype=np.float64)
        source_step = float(getattr(ds, "target_step_deg", SOURCE_STEP_DEG))
        if not np.isclose(source_step, SOURCE_STEP_DEG, rtol=0.0, atol=1e-9):
            raise ValueError(f"unexpected weather source step: {source_step}")
        require_ascending_regular_coordinate(
            lat,
            name="lat",
            expected_step=source_step,
        )
        require_ascending_regular_coordinate(
            lon,
            name="lon",
            expected_step=source_step,
        )
        lat_indices = np.arange(0, lat.size, stride, dtype=np.int64)
        lon_indices = np.arange(0, lon.size, stride, dtype=np.int64)
        public_lat = lat[lat_indices].astype("<f4")
        public_lon = lon[lon_indices].astype("<f4")
        public_step = source_step * stride
        require_ascending_regular_coordinate(
            public_lat,
            name="sampled lat",
            expected_step=public_step,
            tolerance=1e-5,
        )
        require_ascending_regular_coordinate(
            public_lon,
            name="sampled lon",
            expected_step=public_step,
            tolerance=1e-5,
        )

        quantized: dict[str, np.ndarray] = {}
        variable_contract: dict[str, dict[str, object]] = {}
        for name, contract in WEATHER_VARIABLES.items():
            if name not in ds.variables:
                raise ValueError(f"weather source is missing variable {name}")
            variable = ds.variables[name]
            if variable.dimensions != ("time", "lat", "lon"):
                raise ValueError(
                    f"{name} dimensions must be ('time', 'lat', 'lon'), got {variable.dimensions}"
                )
            source_unit = str(getattr(variable, "units", ""))
            accepted_units = tuple(str(item) for item in contract["accepted_units"])
            if source_unit not in accepted_units:
                raise ValueError(
                    f"{name} has unexpected unit {source_unit!r}; expected one of {accepted_units}"
                )
            sampled = np.full(
                (day_count, public_lat.size, public_lon.size),
                np.nan,
                dtype=np.float64,
            )
            if selected_time_indices.size:
                source_values = np.asarray(
                    np.ma.filled(variable[selected_time_indices, :, :], np.nan),
                    dtype=np.float64,
                )
                sampled_present = source_values[:, lat_indices, :][:, :, lon_indices]
                sampled[np.asarray(present_positions, dtype=np.int64)] = sampled_present
            quantized[name] = quantize_tenths(sampled, allow_nodata=True)
            variable_contract[name] = {
                "dtype": "int16",
                "scale": contract["scale"],
                "offset": contract["offset"],
                "unit": contract["unit"],
                "nodata": int(WEATHER_NODATA),
                "description": contract["description"],
                "source_unit_verified": source_unit,
            }

        bbox = {
            "west": float(getattr(ds, "bbox_west", lon[0] - source_step / 2.0)),
            "south": float(getattr(ds, "bbox_south", lat[0] - source_step / 2.0)),
            "east": float(getattr(ds, "bbox_east", lon[-1] + source_step / 2.0)),
            "north": float(getattr(ds, "bbox_north", lat[-1] + source_step / 2.0)),
        }
        metadata_core: dict[str, object] = {
            "contract_version": 1,
            "version": version,
            "index_date": parsed_index_date.isoformat(),
            "dates": [item.isoformat() for item in required_dates],
            "day_count": day_count,
            "available_day_count": day_count - len(missing),
            "missing_dates": missing,
            "crs": str(getattr(ds, "target_crs", "EPSG:4326")),
            "bbox": bbox,
            "rows": int(public_lat.size),
            "cols": int(public_lon.size),
            "expected_cells": int(public_lat.size * public_lon.size),
            "origin_lat": float(public_lat[0]),
            "origin_lon": float(public_lon[0]),
            "step_deg": public_step,
            "latitude_order": "ascending_south_to_north",
            "longitude_order": "ascending_west_to_east",
            "source_step_deg": source_step,
            "source_stride": stride,
            "sampling_method": (
                "direct representative-cell sampling at source indices 0,6,12,... "
                "on both axes; no interpolation, averaging or spatial precipitation sum"
            ),
            "cell_lookup": "nearest sampled center, clamped inside bbox",
            "missing_day_policy": (
                "missing source days and non-finite source values are encoded with "
                "the reserved nodata value in every affected variable array"
            ),
            "variables": variable_contract,
        }
        digest_parts = [canonical_json_bytes(metadata_core)]
        for name in WEATHER_VARIABLES:
            digest_parts.append(name.encode("ascii"))
            digest_parts.append(quantized[name].astype("<i2", copy=False).tobytes(order="C"))
        content_sha256 = sha256_bytes(b"".join(digest_parts))
        metadata = dict(metadata_core)
        metadata["content_sha256"] = content_sha256

    return WeatherDataset(
        version=version,
        index_date=parsed_index_date,
        dates=required_dates,
        latitudes=public_lat,
        longitudes=public_lon,
        values=quantized,
        metadata=metadata,
        content_sha256=content_sha256,
    )


def load_local_weather_metadata(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))
