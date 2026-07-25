from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from netCDF4 import Dataset

from backend.src.publication.supabase import TerrainPublisher
from backend.src.publication.terrain import (
    TERRAIN_DTYPE,
    build_terrain_dataset,
    categorize_tpi,
    decode_terrain_chunk,
    encode_terrain_chunk,
)


def write_terrain_source(path: Path, *, rows: int = 53, cols: int = 52) -> None:
    lat = 45.6015 + np.arange(rows, dtype=np.float32) * np.float32(0.003)
    lon = 10.4015 + np.arange(cols, dtype=np.float32) * np.float32(0.003)
    yy, xx = np.meshgrid(np.arange(rows), np.arange(cols), indexing="ij")
    with Dataset(path, "w") as ds:
        ds.createDimension("lat", rows)
        ds.createDimension("lon", cols)
        ds.createVariable("lat", "f4", ("lat",))[:] = lat
        ds.createVariable("lon", "f4", ("lon",))[:] = lon
        specs = {
            "elevation": ("m", (yy * 10 + xx).astype(np.float32)),
            "pct_broadleaf": ("percent", np.full((rows, cols), 60.2, dtype=np.float32)),
            "pct_conifer": ("percent", np.full((rows, cols), 50.1, dtype=np.float32)),
            "aspect_deg": ("degree", np.mod(yy * 7 + xx, 360).astype(np.float32)),
            "tpi": ("m", (xx - 20).astype(np.float32)),
        }
        for name, (unit, values) in specs.items():
            var = ds.createVariable(name, "f4", ("lat", "lon"), fill_value=np.nan)
            var.units = unit
            var[:] = values
            if name == "tpi":
                var.radius_m = 300.0
        ds.target_crs = "EPSG:4326"
        ds.target_step_deg = 0.003
        ds.bbox_west = 10.4
        ds.bbox_south = 45.6
        ds.bbox_east = 10.4 + cols * 0.003
        ds.bbox_north = 45.6 + rows * 0.003
        ds.tpi_radius_m = 300.0


def test_tpi_categorization_includes_boundaries_and_nodata() -> None:
    values = np.array([-11.0, -10.0, 0.0, 10.0, 11.0, np.nan])
    np.testing.assert_array_equal(categorize_tpi(values), [1, 2, 2, 2, 3, 0])


def test_terrain_binary_round_trip_and_nodata() -> None:
    elevation = np.array([[123, -32768]], dtype=np.int16)
    forest = np.array([[78, 255]], dtype=np.uint8)
    aspect = np.array([[359, 65535]], dtype=np.uint16)
    category = np.array([[3, 0]], dtype=np.uint8)

    payload = encode_terrain_chunk(elevation, forest, aspect, category)
    decoded = decode_terrain_chunk(payload, 1, 2)

    assert len(payload) == 2 * TERRAIN_DTYPE.itemsize
    np.testing.assert_array_equal(decoded["elevation"], elevation)
    np.testing.assert_array_equal(decoded["forest_pct"], forest)
    np.testing.assert_array_equal(decoded["aspect_deg"], aspect)
    np.testing.assert_array_equal(decoded["tpi_category"], category)


def test_terrain_chunks_include_correct_edge_shapes_and_complete_manifest(tmp_path: Path) -> None:
    source = tmp_path / "terrain.nc"
    write_terrain_source(source)

    dataset = build_terrain_dataset(source, tmp_path / "out", version="v1")

    assert len(dataset.chunks) == 4
    assert {(item.rows, item.cols) for item in dataset.chunks} == {
        (50, 50),
        (50, 2),
        (3, 50),
        (3, 2),
    }
    assert dataset.total_chunk_bytes == 53 * 52 * 6
    manifest = dataset.manifest
    for key in (
        "version",
        "crs",
        "bbox",
        "rows",
        "cols",
        "step_deg",
        "latitude_order",
        "longitude_order",
        "chunk_size",
        "binary_layout",
        "tpi",
        "chunks",
        "dataset_sha256",
    ):
        assert key in manifest
    assert manifest["chunk_count"] == 4
    assert all(len(item["sha256"]) == 64 for item in manifest["chunks"])
    assert dataset.cell_for_coordinate(45.6, 10.4) == (0, 0)


class FakeStorageClient:
    def __init__(self, *, fail_path: str | None = None) -> None:
        self.objects: dict[tuple[str, str], bytes] = {}
        self.calls: list[tuple[str, str]] = []
        self.fail_path = fail_path

    def storage_get(self, bucket: str, remote_path: str) -> bytes | None:
        self.calls.append((bucket, remote_path))
        return self.objects.get((bucket, remote_path))

    def storage_upload(
        self,
        bucket: str,
        remote_path: str,
        payload: bytes,
        *,
        content_type: str,
        cache_control: str,
    ) -> None:
        self.calls.append((bucket, remote_path))
        if remote_path == self.fail_path:
            raise RuntimeError("temporary upload failure")
        self.objects[(bucket, remote_path)] = payload

    def storage_delete(self, bucket: str, remote_paths: list[str]) -> None:
        for path in remote_paths:
            self.calls.append((bucket, path))
            self.objects.pop((bucket, path), None)


def test_terrain_publication_is_idempotent_and_never_uses_tiles_bucket(tmp_path: Path) -> None:
    source = tmp_path / "terrain.nc"
    write_terrain_source(source)
    v1 = build_terrain_dataset(source, tmp_path / "out", version="v1")
    client = FakeStorageClient()
    publisher = TerrainPublisher(client, bucket="terrain")

    first = publisher.publish(v1)
    second = publisher.publish(v1)

    assert first.action == "published"
    assert second.action == "unchanged"
    assert all(bucket == "terrain" for bucket, _ in client.calls)
    assert all(not path.startswith("tiles/") for _, path in client.calls)
    with pytest.raises(ValueError, match="tiles"):
        TerrainPublisher(client, bucket="tiles")


def test_terrain_pointer_does_not_change_after_incomplete_upload(tmp_path: Path) -> None:
    source = tmp_path / "terrain.nc"
    write_terrain_source(source)
    dataset = build_terrain_dataset(source, tmp_path / "out", version="v2")
    first_chunk_path = f"v2/{dataset.chunks[0].relative_path}"
    client = FakeStorageClient(fail_path=first_chunk_path)
    old_pointer = b'{"version":"v1","manifest_path":"v1/manifest.json","dataset_sha256":"old"}\n'
    client.objects[("terrain", "current.json")] = old_pointer

    with pytest.raises(RuntimeError, match="upload failure"):
        TerrainPublisher(client).publish(dataset)

    assert client.objects[("terrain", "current.json")] == old_pointer


def test_terrain_cleanup_uses_only_paths_from_old_manifest(tmp_path: Path) -> None:
    source = tmp_path / "terrain.nc"
    write_terrain_source(source)
    v1 = build_terrain_dataset(source, tmp_path / "out", version="v1")
    v2 = build_terrain_dataset(source, tmp_path / "out", version="v2")
    client = FakeStorageClient()
    publisher = TerrainPublisher(client)
    publisher.publish(v1)
    client.objects[("tiles", "tile_sets.json")] = b"keep"

    result = publisher.publish(v2)

    assert result.deleted_objects == len(v1.chunks) + 1
    assert client.objects[("tiles", "tile_sets.json")] == b"keep"
    assert all(bucket == "terrain" for bucket, _ in client.calls)

