from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from netCDF4 import Dataset

from backend.src.publication.common import (
    canonical_json_bytes,
    coordinate_to_index,
    require_ascending_regular_coordinate,
    sha256_bytes,
    sha256_file,
    validate_version,
)


TERRAIN_STEP_DEG = 0.003
TERRAIN_CHUNK_SIZE = 50
ELEVATION_NODATA = np.int16(-32768)
FOREST_NODATA = np.uint8(255)
ASPECT_NODATA = np.uint16(65535)
TPI_NODATA = np.uint8(0)
TPI_LOWER_M = -10.0
TPI_UPPER_M = 10.0
TERRAIN_DTYPE = np.dtype(
    [
        ("elevation", "<i2"),
        ("forest_pct", "u1"),
        ("aspect_deg", "<u2"),
        ("tpi_category", "u1"),
    ],
    align=False,
)


@dataclass(frozen=True)
class TerrainChunk:
    row: int
    col: int
    row_offset: int
    col_offset: int
    rows: int
    cols: int
    relative_path: str
    byte_length: int
    sha256: str


@dataclass(frozen=True)
class TerrainDataset:
    version: str
    output_dir: Path
    manifest: dict[str, object]
    manifest_bytes: bytes
    chunks: tuple[TerrainChunk, ...]
    dataset_sha256: str

    @property
    def total_chunk_bytes(self) -> int:
        return sum(item.byte_length for item in self.chunks)

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


def categorize_tpi(
    values: np.ndarray,
    *,
    lower_m: float = TPI_LOWER_M,
    upper_m: float = TPI_UPPER_M,
) -> np.ndarray:
    if lower_m >= upper_m:
        raise ValueError("TPI lower threshold must be smaller than upper threshold")
    source = np.asarray(values, dtype=np.float64)
    out = np.full(source.shape, TPI_NODATA, dtype=np.uint8)
    finite = np.isfinite(source)
    out[finite & (source < lower_m)] = 1
    out[finite & (source >= lower_m) & (source <= upper_m)] = 2
    out[finite & (source > upper_m)] = 3
    return out


def encode_terrain_chunk(
    elevation: np.ndarray,
    forest_pct: np.ndarray,
    aspect_deg: np.ndarray,
    tpi_category: np.ndarray,
) -> bytes:
    shape = elevation.shape
    if any(np.asarray(item).shape != shape for item in (forest_pct, aspect_deg, tpi_category)):
        raise ValueError("terrain chunk arrays must have identical shapes")
    encoded = np.empty(shape, dtype=TERRAIN_DTYPE)
    encoded["elevation"] = np.asarray(elevation, dtype="<i2")
    encoded["forest_pct"] = np.asarray(forest_pct, dtype=np.uint8)
    encoded["aspect_deg"] = np.asarray(aspect_deg, dtype="<u2")
    encoded["tpi_category"] = np.asarray(tpi_category, dtype=np.uint8)
    return encoded.tobytes(order="C")


def decode_terrain_chunk(payload: bytes, rows: int, cols: int) -> dict[str, np.ndarray]:
    expected = rows * cols * TERRAIN_DTYPE.itemsize
    if len(payload) != expected:
        raise ValueError(f"terrain payload is {len(payload)} bytes; expected {expected}")
    data = np.frombuffer(payload, dtype=TERRAIN_DTYPE).reshape(rows, cols)
    return {name: data[name].copy() for name in TERRAIN_DTYPE.names or ()}


def _quantize_elevation(values: np.ndarray) -> np.ndarray:
    source = np.asarray(values, dtype=np.float64)
    finite = np.isfinite(source)
    rounded = np.zeros(source.shape, dtype=np.float64)
    rounded[finite] = np.rint(source[finite])
    if finite.any() and (
        rounded[finite].min() < -32767 or rounded[finite].max() > 32767
    ):
        raise ValueError("terrain elevation is outside int16 metre range")
    out = np.full(source.shape, ELEVATION_NODATA, dtype="<i2")
    out[finite] = rounded[finite].astype("<i2")
    return out


def _quantize_forest(broadleaf: np.ndarray, conifer: np.ndarray) -> np.ndarray:
    broad = np.asarray(broadleaf, dtype=np.float64)
    conif = np.asarray(conifer, dtype=np.float64)
    finite = np.isfinite(broad) & np.isfinite(conif)
    total = np.clip(broad + conif, 0.0, 100.0)
    out = np.full(total.shape, FOREST_NODATA, dtype=np.uint8)
    out[finite] = np.rint(total[finite]).astype(np.uint8)
    return out


def _quantize_aspect(values: np.ndarray) -> np.ndarray:
    source = np.asarray(values, dtype=np.float64)
    finite = np.isfinite(source)
    if finite.any() and (source[finite].min() < 0.0 or source[finite].max() > 360.0):
        raise ValueError("terrain aspect is outside 0..360 degrees")
    rounded = np.mod(np.rint(source[finite]), 360.0).astype("<u2")
    out = np.full(source.shape, ASPECT_NODATA, dtype="<u2")
    out[finite] = rounded
    return out


def _require_units(variable, expected: tuple[str, ...]) -> str:
    unit = str(getattr(variable, "units", ""))
    if unit not in expected:
        raise ValueError(
            f"{variable.name} has unexpected unit {unit!r}; expected one of {expected}"
        )
    return unit


def build_terrain_dataset(
    source_path: Path,
    output_root: Path,
    *,
    version: str = "v1",
    chunk_size: int = TERRAIN_CHUNK_SIZE,
    tpi_lower_m: float = TPI_LOWER_M,
    tpi_upper_m: float = TPI_UPPER_M,
) -> TerrainDataset:
    version = validate_version(version)
    if chunk_size <= 0:
        raise ValueError("chunk_size must be positive")
    version_dir = output_root / version
    chunks_dir = version_dir / "chunks"
    if version_dir.exists():
        shutil.rmtree(version_dir)
    chunks_dir.mkdir(parents=True, exist_ok=True)

    with Dataset(source_path, "r") as ds:
        required = ("lat", "lon", "elevation", "pct_broadleaf", "pct_conifer", "aspect_deg", "tpi")
        missing = [name for name in required if name not in ds.variables]
        if missing:
            raise ValueError(f"terrain source is missing variables: {missing}")
        lat = np.asarray(ds.variables["lat"][:], dtype=np.float64)
        lon = np.asarray(ds.variables["lon"][:], dtype=np.float64)
        step = float(getattr(ds, "target_step_deg", TERRAIN_STEP_DEG))
        crs = str(getattr(ds, "target_crs", ""))
        if crs != "EPSG:4326":
            raise ValueError(f"unexpected terrain CRS: {crs!r}")
        if not np.isclose(step, TERRAIN_STEP_DEG, rtol=0.0, atol=1e-9):
            raise ValueError(f"unexpected terrain step: {step}")
        require_ascending_regular_coordinate(lat, name="lat", expected_step=step)
        require_ascending_regular_coordinate(lon, name="lon", expected_step=step)

        elevation_var = ds.variables["elevation"]
        broadleaf_var = ds.variables["pct_broadleaf"]
        conifer_var = ds.variables["pct_conifer"]
        aspect_var = ds.variables["aspect_deg"]
        tpi_var = ds.variables["tpi"]
        _require_units(elevation_var, ("m",))
        _require_units(broadleaf_var, ("percent", "%"))
        _require_units(conifer_var, ("percent", "%"))
        _require_units(aspect_var, ("degree", "degrees"))
        _require_units(tpi_var, ("m",))
        for variable in (elevation_var, broadleaf_var, conifer_var, aspect_var, tpi_var):
            if variable.dimensions != ("lat", "lon"):
                raise ValueError(f"{variable.name} must have dimensions ('lat', 'lon')")

        elevation_source = np.asarray(np.ma.filled(elevation_var[:], np.nan), dtype=np.float64)
        broadleaf_source = np.asarray(np.ma.filled(broadleaf_var[:], np.nan), dtype=np.float64)
        conifer_source = np.asarray(np.ma.filled(conifer_var[:], np.nan), dtype=np.float64)
        aspect_source = np.asarray(np.ma.filled(aspect_var[:], np.nan), dtype=np.float64)
        tpi_source = np.asarray(np.ma.filled(tpi_var[:], np.nan), dtype=np.float64)

        elevation = _quantize_elevation(elevation_source)
        forest = _quantize_forest(broadleaf_source, conifer_source)
        aspect = _quantize_aspect(aspect_source)
        tpi_category = categorize_tpi(
            tpi_source,
            lower_m=tpi_lower_m,
            upper_m=tpi_upper_m,
        )

        rows, cols = elevation.shape
        chunks: list[TerrainChunk] = []
        for row_offset in range(0, rows, chunk_size):
            for col_offset in range(0, cols, chunk_size):
                row_end = min(row_offset + chunk_size, rows)
                col_end = min(col_offset + chunk_size, cols)
                chunk_row = row_offset // chunk_size
                chunk_col = col_offset // chunk_size
                relative_path = f"chunks/r{chunk_row:02d}_c{chunk_col:02d}.bin"
                payload = encode_terrain_chunk(
                    elevation[row_offset:row_end, col_offset:col_end],
                    forest[row_offset:row_end, col_offset:col_end],
                    aspect[row_offset:row_end, col_offset:col_end],
                    tpi_category[row_offset:row_end, col_offset:col_end],
                )
                path = version_dir / relative_path
                path.write_bytes(payload)
                chunks.append(
                    TerrainChunk(
                        row=chunk_row,
                        col=chunk_col,
                        row_offset=row_offset,
                        col_offset=col_offset,
                        rows=row_end - row_offset,
                        cols=col_end - col_offset,
                        relative_path=relative_path,
                        byte_length=len(payload),
                        sha256=sha256_bytes(payload),
                    )
                )

        bbox = {
            "west": float(getattr(ds, "bbox_west", lon[0] - step / 2.0)),
            "south": float(getattr(ds, "bbox_south", lat[0] - step / 2.0)),
            "east": float(getattr(ds, "bbox_east", lon[-1] + step / 2.0)),
            "north": float(getattr(ds, "bbox_north", lat[-1] + step / 2.0)),
        }
        source_sha256 = sha256_file(source_path)
        manifest_core: dict[str, object] = {
            "contract_version": 1,
            "version": version,
            "crs": crs,
            "bbox": bbox,
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
                "path_template": f"{version}/chunks/r{{chunk_row:02d}}_c{{chunk_col:02d}}.bin",
            },
            "binary_layout": {
                "layout": "row-major interleaved cells",
                "endianness": "little",
                "bytes_per_cell": TERRAIN_DTYPE.itemsize,
                "fields": [
                    {"name": "elevation", "offset_bytes": 0, "dtype": "int16", "scale": 1.0, "offset": 0.0, "unit": "m", "nodata": int(ELEVATION_NODATA)},
                    {"name": "forest_pct", "offset_bytes": 2, "dtype": "uint8", "scale": 1.0, "offset": 0.0, "unit": "%", "nodata": int(FOREST_NODATA)},
                    {"name": "aspect_deg", "offset_bytes": 3, "dtype": "uint16", "scale": 1.0, "offset": 0.0, "unit": "degree", "nodata": int(ASPECT_NODATA)},
                    {"name": "tpi_category", "offset_bytes": 5, "dtype": "uint8", "scale": 1.0, "offset": 0.0, "unit": "category", "nodata": int(TPI_NODATA)},
                ],
            },
            "tpi": {
                "source_definition": "cell elevation minus neighbourhood mean",
                "source_radius_m": float(getattr(tpi_var, "radius_m", getattr(ds, "tpi_radius_m", 300.0))),
                "thresholds_m": {"lower": tpi_lower_m, "upper": tpi_upper_m},
                "labels": {
                    "0": "nodata",
                    "1": "sottoelevato",
                    "2": "in_media",
                    "3": "sopraelevato",
                },
            },
            "source": {
                "path_name": source_path.name,
                "sha256": source_sha256,
                "elevation_unit_verified": str(elevation_var.units),
                "forest_units_verified": [str(broadleaf_var.units), str(conifer_var.units)],
                "aspect_unit_verified": str(aspect_var.units),
                "tpi_unit_verified": str(tpi_var.units),
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
                    "sha256": item.sha256,
                }
                for item in chunks
            ],
            "chunk_count": len(chunks),
            "total_chunk_bytes": sum(item.byte_length for item in chunks),
        }
        dataset_sha256 = sha256_bytes(canonical_json_bytes(manifest_core))
        manifest = dict(manifest_core)
        manifest["dataset_sha256"] = dataset_sha256
        manifest_bytes = canonical_json_bytes(manifest) + b"\n"
        (version_dir / "manifest.json").write_bytes(manifest_bytes)

    return TerrainDataset(
        version=version,
        output_dir=version_dir,
        manifest=manifest,
        manifest_bytes=manifest_bytes,
        chunks=tuple(chunks),
        dataset_sha256=dataset_sha256,
    )


def load_terrain_manifest(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))

