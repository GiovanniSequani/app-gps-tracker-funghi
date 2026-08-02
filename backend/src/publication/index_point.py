from __future__ import annotations

import shutil
import zlib
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import xarray as xr

from backend.config.index_config import TRIGGER_LAG_DAYS
from backend.config.species_config import SPECIES_CONFIG
from backend.src.index.scoring import _lag_candidate, _rain_need_factor
from backend.src.publication.common import (
    canonical_json_bytes,
    coordinate_to_index,
    require_ascending_regular_coordinate,
    sha256_bytes,
    sha256_file,
    validate_version,
)


INDEX_POINT_STEP_DEG = 0.003
INDEX_POINT_CHUNK_SIZE = 50
INDEX_POINT_DIAGNOSTIC_REVISION = 3
UNIT_NODATA = np.uint8(255)
SCORE100_NODATA = np.uint16(65535)
BYTE_NODATA = np.uint8(255)
TEMPERATURE_NODATA = np.uint8(0)
TEMPORAL_PHASE_UNDETERMINED = np.uint8(0)
TEMPORAL_PHASE_TOO_EARLY = np.uint8(1)
TEMPORAL_PHASE_FAVORABLE = np.uint8(2)
TEMPORAL_PHASE_TOO_LATE = np.uint8(3)
TEMPORAL_PROFILE_RESOLUTION = 1.0 / 254.0
INDEX_POINT_DTYPE = np.dtype(
    [
        ("porcini_score", "<f4"),
        ("finferli_score", "<f4"),
        ("porcini_base_score", "<u2"),
        ("habitat", "u1"),
        ("potential", "u1"),
        ("trigger", "u1"),
        ("incubation", "u1"),
        ("moisture", "u1"),
        ("stress", "u1"),
        ("temp_score", "u1"),
        ("humidity_score", "u1"),
        ("post_rain_score", "u1"),
        ("drying_total", "u1"),
        ("drying_exposure_static", "u1"),
        ("retention_static", "u1"),
        ("rain_need_factor", "u1"),
        ("temporal_phase", "u1"),
        ("low_humidity_days", "u1"),
        ("temperature_band", "u1"),
        ("presence_carryover", "<u2"),
        ("rain_recovery_seed", "<u2"),
    ],
    align=False,
)


@dataclass(frozen=True)
class IndexPointChunk:
    row: int
    col: int
    row_offset: int
    col_offset: int
    rows: int
    cols: int
    relative_path: str
    byte_length: int
    raw_byte_length: int
    sha256: str


@dataclass(frozen=True)
class IndexPointDataset:
    version: str
    index_date: str
    output_dir: Path
    manifest: dict[str, object]
    manifest_bytes: bytes
    chunks: tuple[IndexPointChunk, ...]
    dataset_sha256: str

    @property
    def total_chunk_bytes(self) -> int:
        return sum(item.byte_length for item in self.chunks)

    @property
    def total_raw_chunk_bytes(self) -> int:
        return sum(item.raw_byte_length for item in self.chunks)

    def cell_for_coordinate(self, latitude: float, longitude: float) -> tuple[int, int]:
        bbox = self.manifest["bbox"]
        assert isinstance(bbox, dict)
        row = coordinate_to_index(
            latitude,
            bbox_min=float(bbox["south"]),
            bbox_max=float(bbox["north"]),
            origin=float(self.manifest["origin_lat"]),
            step=float(self.manifest["step_deg"]),
            count=int(self.manifest["rows"]),
        )
        col = coordinate_to_index(
            longitude,
            bbox_min=float(bbox["west"]),
            bbox_max=float(bbox["east"]),
            origin=float(self.manifest["origin_lon"]),
            step=float(self.manifest["step_deg"]),
            count=int(self.manifest["cols"]),
        )
        return row, col


def _quantize_unit(values: np.ndarray) -> np.ndarray:
    source = np.asarray(values, dtype=np.float64)
    finite = np.isfinite(source)
    if finite.any() and (
        source[finite].min() < -1e-6 or source[finite].max() > 1.0 + 1e-6
    ):
        raise ValueError("unit diagnostic is outside 0..1")
    out = np.full(source.shape, UNIT_NODATA, dtype=np.uint8)
    out[finite] = np.rint(np.clip(source[finite], 0.0, 1.0) * 254.0).astype(np.uint8)
    return out


def _quantize_score100(values: np.ndarray) -> np.ndarray:
    source = np.asarray(values, dtype=np.float64)
    finite = np.isfinite(source)
    if finite.any() and (
        source[finite].min() < -1e-6 or source[finite].max() > 100.0 + 1e-6
    ):
        raise ValueError("score diagnostic is outside 0..100")
    out = np.full(source.shape, SCORE100_NODATA, dtype="<u2")
    out[finite] = np.rint(np.clip(source[finite], 0.0, 100.0) * 100.0).astype("<u2")
    return out


def _quantize_byte(values: np.ndarray, *, maximum: int) -> np.ndarray:
    source = np.asarray(values, dtype=np.float64)
    finite = np.isfinite(source)
    rounded = np.rint(source[finite])
    if finite.any() and (rounded.min() < 0 or rounded.max() > maximum):
        raise ValueError(f"byte diagnostic is outside 0..{maximum}")
    out = np.full(source.shape, BYTE_NODATA, dtype=np.uint8)
    out[finite] = rounded.astype(np.uint8)
    return out


def _quantize_rain_need(values: np.ndarray) -> np.ndarray:
    source = np.asarray(values, dtype=np.float64)
    finite = np.isfinite(source)
    if finite.any() and (
        source[finite].min() < 0.70 - 1e-6 or source[finite].max() > 1.65 + 1e-6
    ):
        raise ValueError("rain need factor is outside 0.70..1.65")
    out = np.full(source.shape, BYTE_NODATA, dtype=np.uint8)
    out[finite] = np.rint((np.clip(source[finite], 0.70, 1.65) - 0.70) / 0.005).astype(
        np.uint8
    )
    return out


def temperature_band(values: np.ndarray) -> np.ndarray:
    """Classify porcini mean temperature using its real trapezoid thresholds."""

    source = np.asarray(values, dtype=np.float64)
    lo_bad, lo_ok, hi_ok, hi_bad = SPECIES_CONFIG["porcini"]["temp_mean_c"]
    out = np.full(source.shape, TEMPERATURE_NODATA, dtype=np.uint8)
    finite = np.isfinite(source)
    out[finite & (source < lo_bad)] = 1
    out[finite & (source >= lo_bad) & (source < lo_ok)] = 2
    out[finite & (source >= lo_ok) & (source <= hi_ok)] = 3
    out[finite & (source > hi_ok) & (source <= hi_bad)] = 4
    out[finite & (source > hi_bad)] = 5
    return out


def temporal_phase_from_potential(potential: np.ndarray) -> np.ndarray:
    """Classify a resolved peak in the configured lag-potential profile.

    The first axis must follow ``TRIGGER_LAG_DAYS`` in ascending order. A peak
    is resolved only when it exceeds every competing lag by at least one public
    unit-diagnostic quantization step. Boundary peaks additionally need a
    coherent inward slope; flat, tied, noisy or incomplete profiles remain
    explicitly undetermined.
    """

    source = np.asarray(potential, dtype=np.float64)
    if source.ndim < 1 or source.shape[0] < 3:
        raise ValueError("temporal phase requires at least three lag candidates")

    out = np.full(source.shape[1:], TEMPORAL_PHASE_UNDETERMINED, dtype=np.uint8)
    finite = np.isfinite(source).all(axis=0)
    safe = np.where(np.isfinite(source), source, -np.inf)
    best_idx = np.argmax(safe, axis=0)
    ordered = np.sort(safe, axis=0)
    resolved = finite & (
        ordered[-1] - ordered[-2] >= TEMPORAL_PROFILE_RESOLUTION
    )

    first = safe[0]
    late = (
        resolved
        & (best_idx == 0)
        & (first - safe[1] >= TEMPORAL_PROFILE_RESOLUTION)
        & (safe[1] >= safe[2])
    )
    last_idx = source.shape[0] - 1
    early = (
        resolved
        & (best_idx == last_idx)
        & (safe[-1] - safe[-2] >= TEMPORAL_PROFILE_RESOLUTION)
        & (safe[-2] >= safe[-3])
    )

    left = np.take_along_axis(
        safe, np.maximum(best_idx - 1, 0)[None, ...], axis=0
    )[0]
    right = np.take_along_axis(
        safe, np.minimum(best_idx + 1, last_idx)[None, ...], axis=0
    )[0]
    interior = (
        resolved
        & (best_idx > 0)
        & (best_idx < last_idx)
        & (ordered[-1] - left >= TEMPORAL_PROFILE_RESOLUTION)
        & (ordered[-1] - right >= TEMPORAL_PROFILE_RESOLUTION)
    )

    out[early] = TEMPORAL_PHASE_TOO_EARLY
    out[interior] = TEMPORAL_PHASE_FAVORABLE
    out[late] = TEMPORAL_PHASE_TOO_LATE
    return out


def encode_index_point_chunk(fields: dict[str, np.ndarray]) -> bytes:
    names = INDEX_POINT_DTYPE.names or ()
    if set(fields) != set(names):
        raise ValueError(f"index point fields must be exactly {names}")
    shapes = {np.asarray(fields[name]).shape for name in names}
    if len(shapes) != 1:
        raise ValueError("index point chunk arrays must have identical shapes")
    shape = shapes.pop()
    encoded = np.empty(shape, dtype=INDEX_POINT_DTYPE)
    for name in names:
        encoded[name] = fields[name]
    return zlib.compress(encoded.tobytes(order="C"), level=9)


def decode_index_point_chunk(payload: bytes, rows: int, cols: int) -> dict[str, np.ndarray]:
    raw = zlib.decompress(payload)
    expected = rows * cols * INDEX_POINT_DTYPE.itemsize
    if len(raw) != expected:
        raise ValueError(f"index point payload expands to {len(raw)} bytes; expected {expected}")
    data = np.frombuffer(raw, dtype=INDEX_POINT_DTYPE).reshape(rows, cols)
    return {name: data[name].copy() for name in INDEX_POINT_DTYPE.names or ()}


def _binary_field_specs() -> list[dict[str, object]]:
    specs: list[dict[str, object]] = [
        {"name": "porcini_score", "dtype": "float32", "unit": "score_0_100", "nodata": "NaN", "exact": True},
        {"name": "finferli_score", "dtype": "float32", "unit": "score_0_100", "nodata": "NaN", "exact": True},
        {"name": "porcini_base_score", "dtype": "uint16", "scale": 0.01, "offset": 0.0, "nodata": 65535},
        *[
            {"name": name, "dtype": "uint8", "scale": 1.0 / 254.0, "offset": 0.0, "nodata": 255}
            for name in (
                "habitat",
                "potential",
                "trigger",
                "incubation",
                "moisture",
                "stress",
                "temp_score",
                "humidity_score",
                "post_rain_score",
                "drying_total",
                "drying_exposure_static",
                "retention_static",
            )
        ],
        {"name": "rain_need_factor", "dtype": "uint8", "scale": 0.005, "offset": 0.70, "nodata": 255},
        {"name": "temporal_phase", "dtype": "uint8", "scale": 1.0, "offset": 0.0, "nodata": None},
        {"name": "low_humidity_days", "dtype": "uint8", "scale": 1.0, "offset": 0.0, "unit": "day", "nodata": 255},
        {"name": "temperature_band", "dtype": "uint8", "scale": 1.0, "offset": 0.0, "nodata": 0},
        {"name": "presence_carryover", "dtype": "uint16", "scale": 0.01, "offset": 0.0, "unit": "score_point", "nodata": 65535},
        {"name": "rain_recovery_seed", "dtype": "uint16", "scale": 0.01, "offset": 0.0, "unit": "score_point", "nodata": 65535},
    ]
    for spec in specs:
        spec["offset_bytes"] = int(INDEX_POINT_DTYPE.fields[str(spec["name"])][1])
    return specs


def _selected_porcini_lag_diagnostics(features: xr.Dataset) -> xr.Dataset:
    target_idx = features.sizes["time"] - 1
    candidates = [
        candidate
        for lag in TRIGGER_LAG_DAYS
        if (candidate := _lag_candidate(features, "porcini", target_idx, lag)) is not None
    ]
    if not candidates:
        raise ValueError("not enough feature days for porcini lag diagnostics")
    lagged = xr.concat(candidates, dim="lag")
    best_idx = lagged["potential"].argmax("lag")
    selected = lagged.isel(lag=best_idx)
    drop_names = [name for name in selected.coords if name not in selected.dims]
    if drop_names:
        selected = selected.drop_vars(drop_names)
    selected["best_lag_days"] = lagged["lag"].isel(lag=best_idx).drop_vars("lag")
    selected["temporal_phase"] = xr.DataArray(
        temporal_phase_from_potential(lagged["potential"].values),
        dims=selected["potential"].dims,
        coords=selected["potential"].coords,
    )
    return selected


def build_index_point_dataset(
    index_path: Path,
    features_path: Path,
    output_root: Path,
    *,
    index_date: str,
    chunk_size: int = INDEX_POINT_CHUNK_SIZE,
) -> IndexPointDataset:
    if chunk_size <= 0:
        raise ValueError("chunk_size must be positive")
    index_sha256 = sha256_file(index_path)
    features_sha256 = sha256_file(features_path)
    version_seed = canonical_json_bytes(
        {
            "contract_version": 1,
            "diagnostic_revision": INDEX_POINT_DIAGNOSTIC_REVISION,
            "index_date": index_date,
            "index_sha256": index_sha256,
            "features_sha256": features_sha256,
        }
    )
    version = validate_version(f"{index_date}-{sha256_bytes(version_seed)[:12]}")
    version_dir = output_root / version
    if version_dir.exists():
        shutil.rmtree(version_dir)
    chunks_dir = version_dir / "chunks"
    chunks_dir.mkdir(parents=True)

    with xr.open_dataset(index_path) as index_source, xr.open_dataset(features_path) as feature_source:
        index = index_source.load()
        features = feature_source.load()

    required_index = (
        "porcini_score",
        "finferli_score",
        "porcini_base_score",
        "porcini_habitat",
        "porcini_trigger",
        "porcini_incubation",
        "porcini_moisture",
        "porcini_stress",
        "porcini_presence_carryover",
        "porcini_rain_recovery_seed",
        "porcini_best_lag_days",
    )
    missing = [name for name in required_index if name not in index]
    if missing:
        raise ValueError(f"index dataset is missing variables: {missing}")
    if str(index.attrs.get("target_date", "")) != index_date:
        raise ValueError("index target_date does not match requested index date")
    if str(features.attrs.get("target_date", "")) != index_date:
        raise ValueError("features target_date does not match requested index date")
    index, features = xr.align(index, features, join="exact")

    lat = np.asarray(index["lat"].values, dtype=np.float64)
    lon = np.asarray(index["lon"].values, dtype=np.float64)
    require_ascending_regular_coordinate(lat, name="lat", expected_step=INDEX_POINT_STEP_DEG)
    require_ascending_regular_coordinate(lon, name="lon", expected_step=INDEX_POINT_STEP_DEG)
    selected = _selected_porcini_lag_diagnostics(features).load()
    if not np.array_equal(
        np.asarray(selected["best_lag_days"].values, dtype=np.uint8),
        np.asarray(index["porcini_best_lag_days"].values, dtype=np.uint8),
    ):
        raise ValueError("recomputed porcini best lag does not match index output")

    arrays: dict[str, np.ndarray] = {
        "porcini_score": np.asarray(index["porcini_score"].values, dtype="<f4"),
        "finferli_score": np.asarray(index["finferli_score"].values, dtype="<f4"),
        "porcini_base_score": _quantize_score100(index["porcini_base_score"].values),
        "habitat": _quantize_unit(index["porcini_habitat"].values),
        "potential": _quantize_unit(selected["potential"].values),
        "trigger": _quantize_unit(index["porcini_trigger"].values),
        "incubation": _quantize_unit(index["porcini_incubation"].values),
        "moisture": _quantize_unit(index["porcini_moisture"].values),
        "stress": _quantize_unit(index["porcini_stress"].values),
        "temp_score": _quantize_unit(selected["temp_score"].values),
        "humidity_score": _quantize_unit(selected["humidity_score"].values),
        "post_rain_score": _quantize_unit(selected["post_rain_score"].values),
        "drying_total": _quantize_unit(selected["drying_total"].values),
        "drying_exposure_static": _quantize_unit(features["drying_exposure_static"].values),
        "retention_static": _quantize_unit(features["retention_static"].values),
        "rain_need_factor": _quantize_rain_need(_rain_need_factor(features).values),
        "temporal_phase": np.asarray(selected["temporal_phase"].values, dtype=np.uint8),
        "low_humidity_days": _quantize_byte(
            selected["low_humidity_days"].values, maximum=254
        ),
        "temperature_band": temperature_band(selected["temp_mean_c"].values),
        "presence_carryover": _quantize_score100(
            index["porcini_presence_carryover"].values
        ),
        "rain_recovery_seed": _quantize_score100(
            index["porcini_rain_recovery_seed"].values
        ),
    }
    shape = (lat.size, lon.size)
    if any(values.shape != shape for values in arrays.values()):
        raise ValueError("index point diagnostic arrays do not match the index grid")
    if not np.isfinite(arrays["porcini_score"]).all() or not np.isfinite(
        arrays["finferli_score"]
    ).all():
        raise ValueError("final score arrays must be complete and finite")

    chunks: list[IndexPointChunk] = []
    rows, cols = shape
    for row_offset in range(0, rows, chunk_size):
        for col_offset in range(0, cols, chunk_size):
            row_end = min(row_offset + chunk_size, rows)
            col_end = min(col_offset + chunk_size, cols)
            chunk_row = row_offset // chunk_size
            chunk_col = col_offset // chunk_size
            relative_path = f"chunks/r{chunk_row:02d}_c{chunk_col:02d}.bin.zlib"
            fields = {
                name: values[row_offset:row_end, col_offset:col_end]
                for name, values in arrays.items()
            }
            payload = encode_index_point_chunk(fields)
            path = version_dir / relative_path
            path.write_bytes(payload)
            chunks.append(
                IndexPointChunk(
                    row=chunk_row,
                    col=chunk_col,
                    row_offset=row_offset,
                    col_offset=col_offset,
                    rows=row_end - row_offset,
                    cols=col_end - col_offset,
                    relative_path=relative_path,
                    byte_length=len(payload),
                    raw_byte_length=(row_end - row_offset)
                    * (col_end - col_offset)
                    * INDEX_POINT_DTYPE.itemsize,
                    sha256=sha256_bytes(payload),
                )
            )

    step = INDEX_POINT_STEP_DEG
    manifest_core: dict[str, object] = {
        "contract_version": 1,
        "diagnostic_revision": INDEX_POINT_DIAGNOSTIC_REVISION,
        "version": version,
        "index_date": index_date,
        "crs": "EPSG:4326",
        "bbox": {
            "west": float(lon[0] - step / 2.0),
            "south": float(lat[0] - step / 2.0),
            "east": float(lon[-1] + step / 2.0),
            "north": float(lat[-1] + step / 2.0),
        },
        "rows": rows,
        "cols": cols,
        "step_deg": step,
        "origin_lat": float(lat[0]),
        "origin_lon": float(lon[0]),
        "latitude_order": "ascending_south_to_north",
        "longitude_order": "ascending_west_to_east",
        "chunk_size": {"rows": chunk_size, "cols": chunk_size},
        "chunk_grid": {
            "rows": (rows + chunk_size - 1) // chunk_size,
            "cols": (cols + chunk_size - 1) // chunk_size,
            "path_template": f"{version}/chunks/r{{chunk_row:02d}}_c{{chunk_col:02d}}.bin.zlib",
        },
        "compression": {"codec": "zlib", "level": 9},
        "binary_layout": {
            "layout": "row-major interleaved cells",
            "endianness": "little",
            "bytes_per_cell_uncompressed": INDEX_POINT_DTYPE.itemsize,
            "fields": _binary_field_specs(),
        },
        "labels": {
            "temporal_phase": {
                "0": "non_determinabile",
                "1": "troppo_precoce",
                "2": "fase_favorevole",
                "3": "troppo_tardi",
            },
            "temperature_band": {
                "0": "nodata",
                "1": "molto_fredda",
                "2": "fredda",
                "3": "ottimale",
                "4": "calda",
                "5": "molto_calda",
            }
        },
        "porcini_diagnostics": {
            "selected_lag_note": "potential and weather diagnostics use the lag that maximises trigger*incubation*moisture",
            "component_note": "trigger, incubation, moisture and stress are the maxima across configured lags used by scoring 0.2.0",
            "temporal_phase_note": (
                "derived from the complete potential profile over configured lags; "
                "best_lag_days is intentionally not published"
            ),
            "temporal_phase_rule": {
                "resolution": TEMPORAL_PROFILE_RESOLUTION,
                "too_early": (
                    "unique resolved maximum at the longest configured lag, "
                    "with potential non-decreasing over the previous two lags"
                ),
                "favorable": (
                    "unique resolved interior maximum, at least one resolution "
                    "unit above both adjacent lags"
                ),
                "too_late": (
                    "unique resolved maximum at the shortest configured lag, "
                    "with potential non-increasing over the next two lags"
                ),
                "undetermined": (
                    "flat, tied, unresolved, incomplete or otherwise unsupported profile"
                ),
            },
            "incubation_note": (
                "real scoring component, not a temporal phase: weighted suitability "
                "of temperature, humidity, post-trigger rain and low drying"
            ),
            "temperature_mean_thresholds_c": list(SPECIES_CONFIG["porcini"]["temp_mean_c"]),
            "low_humidity_definition": f"count of incubation days with rh_min < {SPECIES_CONFIG['porcini']['rh_min_pct'][1]} percent",
            "recovery_note": "recovery is upward-only; final score equals base score plus max(presence_carryover, rain_recovery_seed), clipped to 100",
            "configured_lags_days": list(TRIGGER_LAG_DAYS),
            "thresholds": {
                key: list(value) if isinstance(value, tuple) else value
                for key, value in SPECIES_CONFIG["porcini"].items()
                if key
                in {
                    "rain_trigger_mm",
                    "post_trigger_rain_mm",
                    "temp_mean_c",
                    "temp_min_c",
                    "temp_max_c",
                    "rh_mean_pct",
                    "rh_min_pct",
                    "gust_max_kmh",
                    "elevation_m",
                    "forest_mix",
                }
            },
            "formulas": {
                "temperature": "0.45*temp_mean_score + 0.25*temp_min_score + 0.30*temp_max_score",
                "humidity": "0.62*rh_mean_score + 0.38*rh_min_score",
                "drying_weather": "0.38*low_rh_penalty + 0.32*gust_penalty + 0.30*high_temp_penalty",
                "drying_total": "clip(0.62*drying_weather + 0.38*drying_exposure_static, 0, 1)",
                "moisture": "(0.48*post_rain_score + 0.30*retention_static + 0.22*humidity_score) * (1 - 0.55*drying_total)",
                "incubation": "clip(0.42*temp_score + 0.30*humidity_score + 0.18*post_rain_score + 0.10*(1-drying_total), 0, 1)",
                "stress": "clip(1-drying_total, 0, 1)",
                "potential": "clip(trigger*incubation*moisture, 0, 1)",
                "dynamic_mix": "weighted mean of trigger, incubation, moisture and stress using porcini weights",
                "base_score": "clip(100*(0.72*habitat*potential + 0.28*habitat*dynamic_mix*potential^0.45), 0, 100)",
                "final_score": "clip(base_score + max(presence_carryover, rain_recovery_seed), 0, 100)",
            },
            "dynamic_weights": SPECIES_CONFIG["porcini"]["weights"],
        },
        "source": {
            "index_path_name": index_path.name,
            "index_sha256": index_sha256,
            "features_path_name": features_path.name,
            "features_sha256": features_sha256,
            "scoring_version": str(index.attrs.get("scoring_version", "")),
        },
        "chunks": [
            {
                "row": item.row,
                "col": item.col,
                "row_offset": item.row_offset,
                "col_offset": item.col_offset,
                "rows": item.rows,
                "cols": item.cols,
                "path": f"{version}/{item.relative_path}",
                "byte_length": item.byte_length,
                "raw_byte_length": item.raw_byte_length,
                "sha256": item.sha256,
            }
            for item in chunks
        ],
        "chunk_count": len(chunks),
        "total_chunk_bytes": sum(item.byte_length for item in chunks),
        "total_raw_chunk_bytes": sum(item.raw_byte_length for item in chunks),
    }
    dataset_sha256 = sha256_bytes(canonical_json_bytes(manifest_core))
    manifest = dict(manifest_core)
    manifest["dataset_sha256"] = dataset_sha256
    manifest_bytes = canonical_json_bytes(manifest) + b"\n"
    (version_dir / "manifest.json").write_bytes(manifest_bytes)
    index.close()
    features.close()
    selected.close()
    return IndexPointDataset(
        version=version,
        index_date=index_date,
        output_dir=version_dir,
        manifest=manifest,
        manifest_bytes=manifest_bytes,
        chunks=tuple(chunks),
        dataset_sha256=dataset_sha256,
    )
