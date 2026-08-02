from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import requests
import xarray as xr

from backend.src.index.scoring import compute_all_indices
from backend.src.publication.index_point import (
    INDEX_POINT_DTYPE,
    build_index_point_dataset,
    decode_index_point_chunk,
    temporal_phase_from_potential,
    temperature_band,
)
from backend.src.publication.supabase import IndexPointPublisher, SupabaseClient


def write_sources(
    root: Path,
    *,
    date: str = "2026-07-26",
    temp_mean: float = 14.0,
) -> tuple[Path, Path]:
    rows, cols, days = 3, 4, 19
    lat = 45.6015 + np.arange(rows) * 0.003
    lon = 10.4015 + np.arange(cols) * 0.003
    time = np.arange(
        np.datetime64(date) - np.timedelta64(days - 1, "D"),
        np.datetime64(date) + np.timedelta64(1, "D"),
    )
    shape3 = (days, rows, cols)
    shape2 = (rows, cols)
    features = xr.Dataset(
        {
            "t2m_mean": (("time", "lat", "lon"), np.full(shape3, temp_mean, dtype=np.float32)),
            "t2m_min": (("time", "lat", "lon"), np.full(shape3, 8.0, dtype=np.float32)),
            "t2m_max": (("time", "lat", "lon"), np.full(shape3, 20.0, dtype=np.float32)),
            "precip_sum": (("time", "lat", "lon"), np.full(shape3, 5.0, dtype=np.float32)),
            "rh_mean": (("time", "lat", "lon"), np.full(shape3, 80.0, dtype=np.float32)),
            "rh_min": (("time", "lat", "lon"), np.full(shape3, 50.0, dtype=np.float32)),
            "gust_mean": (("time", "lat", "lon"), np.full(shape3, 12.0, dtype=np.float32)),
            "gust_max": (("time", "lat", "lon"), np.full(shape3, 20.0, dtype=np.float32)),
            "elevation": (("lat", "lon"), np.full(shape2, 900.0, dtype=np.float32)),
            "forest_pct": (("lat", "lon"), np.full(shape2, 75.0, dtype=np.float32)),
            "pct_broadleaf": (("lat", "lon"), np.full(shape2, 50.0, dtype=np.float32)),
            "pct_conifer": (("lat", "lon"), np.full(shape2, 25.0, dtype=np.float32)),
            "pct_non_forest": (("lat", "lon"), np.full(shape2, 25.0, dtype=np.float32)),
            "slope": (("lat", "lon"), np.full(shape2, 12.0, dtype=np.float32)),
            "slope_norm": (("lat", "lon"), np.full(shape2, 12.0 / 35.0, dtype=np.float32)),
            "ridge_exposure": (("lat", "lon"), np.zeros(shape2, dtype=np.float32)),
            "valley_shelter": (("lat", "lon"), np.zeros(shape2, dtype=np.float32)),
            "northness": (("lat", "lon"), np.full(shape2, 0.8, dtype=np.float32)),
            "southness": (("lat", "lon"), np.full(shape2, 0.2, dtype=np.float32)),
            "drying_exposure_static": (("lat", "lon"), np.full(shape2, 0.2, dtype=np.float32)),
            "retention_static": (("lat", "lon"), np.full(shape2, 0.7, dtype=np.float32)),
        },
        coords={"time": time, "lat": lat, "lon": lon},
        attrs={"target_date": date, "feature_window_days": days},
    )
    index = compute_all_indices(
        features,
        ["porcini", "finferli"],
        recovery_history=None,
        enable_recovery=False,
    )
    feature_path = root / f"features_{date}.nc"
    index_path = root / f"index_{date}.nc"
    features.to_netcdf(feature_path)
    index.to_netcdf(index_path)
    return index_path, feature_path


def test_temperature_band_uses_real_porcini_thresholds() -> None:
    np.testing.assert_array_equal(
        temperature_band(np.array([np.nan, 4.9, 5.0, 9.9, 10.0, 18.0, 18.1, 24.0, 24.1])),
        [0, 1, 2, 2, 3, 3, 4, 4, 5],
    )


def test_temporal_phase_requires_a_resolved_candidate_profile() -> None:
    profiles = np.asarray(
        [
            [1.00, 0.20, 0.10, 0.50, 1.000, 0.80],
            [0.80, 0.35, 0.20, 0.50, 0.998, 0.80],
            [0.70, 0.55, 0.30, 0.50, 0.20, np.nan],
            [0.60, 0.80, 0.40, 0.50, 0.10, 0.60],
            [0.50, 1.00, 0.50, 0.50, 0.05, 0.50],
            [0.40, 0.75, 0.60, 0.50, 0.04, 0.40],
            [0.30, 0.60, 0.70, 0.50, 0.03, 0.30],
            [0.20, 0.50, 0.80, 0.50, 0.02, 0.20],
            [0.10, 0.40, 0.90, 0.50, 0.01, 0.10],
            [0.05, 0.30, 1.00, 0.50, 0.00, 0.00],
        ],
        dtype=np.float32,
    )

    np.testing.assert_array_equal(
        temporal_phase_from_potential(profiles),
        [3, 2, 1, 0, 0, 0],
    )


def test_index_point_round_trip_preserves_exact_scores_and_manifest(tmp_path: Path) -> None:
    index_path, feature_path = write_sources(tmp_path)
    dataset = build_index_point_dataset(
        index_path,
        feature_path,
        tmp_path / "out",
        index_date="2026-07-26",
        chunk_size=2,
    )

    assert len(dataset.chunks) == 4
    assert dataset.total_raw_chunk_bytes == 3 * 4 * INDEX_POINT_DTYPE.itemsize
    first = dataset.chunks[0]
    decoded = decode_index_point_chunk(
        (dataset.output_dir / first.relative_path).read_bytes(),
        first.rows,
        first.cols,
    )
    with xr.open_dataset(index_path) as index:
        assert decoded["porcini_score"][0, 0].tobytes() == np.float32(
            index["porcini_score"].values[0, 0]
        ).tobytes()
        assert decoded["finferli_score"][0, 0].tobytes() == np.float32(
            index["finferli_score"].values[0, 0]
        ).tobytes()
    manifest = dataset.manifest
    assert manifest["index_date"] == "2026-07-26"
    assert manifest["diagnostic_revision"] == 3
    assert manifest["compression"]["codec"] == "zlib"
    assert manifest["labels"]["temperature_band"]["3"] == "ottimale"
    assert manifest["labels"]["temporal_phase"] == {
        "0": "non_determinabile",
        "1": "troppo_precoce",
        "2": "fase_favorevole",
        "3": "troppo_tardi",
    }
    fields = manifest["binary_layout"]["fields"]
    assert "best_lag_days" not in {item["name"] for item in fields}
    assert "incubation" in {item["name"] for item in fields}
    assert manifest["porcini_diagnostics"]["temporal_phase_rule"]["undetermined"]
    assert [item["offset_bytes"] for item in fields] == [
        INDEX_POINT_DTYPE.fields[item["name"]][1] for item in fields
    ]
    assert dataset.cell_for_coordinate(45.6015, 10.4015) == (0, 0)


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


def test_index_point_publication_is_atomic_idempotent_and_cleans_only_old_version(
    tmp_path: Path,
) -> None:
    index1, features1 = write_sources(tmp_path, temp_mean=14.0)
    v1 = build_index_point_dataset(
        index1, features1, tmp_path / "out", index_date="2026-07-26", chunk_size=2
    )
    index2, features2 = write_sources(tmp_path, temp_mean=16.0)
    v2 = build_index_point_dataset(
        index2, features2, tmp_path / "out", index_date="2026-07-26", chunk_size=2
    )
    assert v1.version != v2.version
    client = FakeStorageClient()
    client.objects[("tiles", "tile_sets.json")] = b"keep"
    publisher = IndexPointPublisher(client)

    first = publisher.publish(v1)
    second = publisher.publish(v1)
    replaced = publisher.publish(v2)

    assert first.action == "published"
    assert second.action == "unchanged"
    assert replaced.deleted_objects == len(v1.chunks) + 1
    assert client.objects[("tiles", "tile_sets.json")] == b"keep"
    current = json.loads(client.objects[("index-data", "current.json")])
    assert current["version"] == v2.version
    assert all(bucket == "index-data" for bucket, _ in client.calls if bucket != "tiles")


def test_index_point_incomplete_upload_does_not_change_pointer(tmp_path: Path) -> None:
    index_path, feature_path = write_sources(tmp_path)
    dataset = build_index_point_dataset(
        index_path,
        feature_path,
        tmp_path / "out",
        index_date="2026-07-26",
        chunk_size=2,
    )
    first_path = f"{dataset.version}/{dataset.chunks[0].relative_path}"
    client = FakeStorageClient(fail_path=first_path)
    old = b'{"version":"old","index_date":"2026-07-25","manifest_path":"old/manifest.json"}\n'
    client.objects[("index-data", "current.json")] = old
    client.objects[("index-data", "old/manifest.json")] = b'{"chunks":[]}\n'

    with pytest.raises(RuntimeError, match="upload failure"):
        IndexPointPublisher(client).publish(dataset)

    assert client.objects[("index-data", "current.json")] == old


def test_index_point_older_date_cannot_replace_current(tmp_path: Path) -> None:
    index_path, feature_path = write_sources(tmp_path, date="2026-07-25")
    dataset = build_index_point_dataset(
        index_path,
        feature_path,
        tmp_path / "out",
        index_date="2026-07-25",
        chunk_size=2,
    )
    client = FakeStorageClient()
    current = b'{"version":"newer","index_date":"2026-07-26","manifest_path":"newer/manifest.json"}\n'
    client.objects[("index-data", "current.json")] = current

    result = IndexPointPublisher(client).publish(dataset)

    assert result.action == "skipped_older"
    assert client.objects[("index-data", "current.json")] == current


def test_storage_verification_reads_bypass_stale_cdn_cache() -> None:
    class FakeSession:
        def __init__(self) -> None:
            self.calls: list[dict[str, object]] = []

        def request(self, method: str, url: str, **kwargs: object) -> requests.Response:
            self.calls.append({"method": method, "url": url, **kwargs})
            response = requests.Response()
            response.status_code = 200
            response._content = b'{}'
            return response

    session = FakeSession()
    client = SupabaseClient("https://example.supabase.co", "service-key", session=session)

    assert client.storage_get("index-data", "current.json") == b"{}"

    call = session.calls[0]
    assert "?verify=" in str(call["url"])
    headers = call["headers"]
    assert isinstance(headers, dict)
    assert headers["Cache-Control"] == "no-cache, no-store, max-age=0"
    assert headers["Pragma"] == "no-cache"
