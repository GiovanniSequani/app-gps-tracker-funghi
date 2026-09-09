from __future__ import annotations

import gzip
import hashlib
from pathlib import Path

from backend.src.accounts.gpx_admission import validate_pending_gpx


GPX = b'<gpx><trk><trkseg><trkpt lat="46.1" lon="11.2"><time>2026-09-01T10:00:00Z</time></trkpt><trkpt lat="46.2" lon="11.3"><time>2026-09-01T10:05:00Z</time></trkpt></trkseg></trk></gpx>'


class Store:
    completed = rejected = retried = 0
    result = None
    def __init__(self, row): self.row = row
    def claim(self, owner_token, limit):
        self.row["claim_token"] = owner_token
        return [self.row]
    def complete(self, track_id, token, result): self.completed += 1; self.result = result
    def reject(self, track_id, token, error_code): self.rejected += 1
    def retry(self, track_id, token, error_code): self.retried += 1


class Storage:
    def __init__(self, payload: bytes, fail: bool = False): self.payload = payload; self.fail = fail; self.deleted = 0
    def download(self, storage_path: str, local_path: Path):
        if self.fail: raise OSError("controlled")
        local_path.write_bytes(self.payload)
    def delete(self, storage_path: str): self.deleted += 1


def archive(payload: bytes = GPX) -> bytes:
    import io
    target = io.BytesIO()
    with gzip.GzipFile(fileobj=target, mode="wb", mtime=0) as output: output.write(payload)
    return target.getvalue()


def row(payload: bytes):
    return {"id": "t", "storage_path": "u/t.gpx.gz", "expected_sha256": hashlib.sha256(payload).hexdigest(),
            "expected_compressed_size_bytes": len(payload), "max_compressed_bytes": 10000,
            "max_uncompressed_bytes": 10000}


def test_valid_archive_is_admitted_with_server_measurements() -> None:
    payload = archive(); store = Store(row(payload))
    result = validate_pending_gpx(store, Storage(payload))
    assert (result.validated, result.rejected, result.failed) == (1, 0, 0)
    assert store.result.track_point_count == 2
    assert store.result.started_at.isoformat() == "2026-09-01T10:00:00+00:00"


def test_hash_mismatch_is_rejected_and_exact_object_removed() -> None:
    payload = archive(); metadata = row(payload); metadata["expected_sha256"] = "0" * 64
    store, storage = Store(metadata), Storage(payload)
    result = validate_pending_gpx(store, storage)
    assert (result.rejected, storage.deleted, store.rejected) == (1, 1, 1)


def test_transient_download_error_is_retryable_not_rejected() -> None:
    payload = archive(); store = Store(row(payload))
    result = validate_pending_gpx(store, Storage(payload, fail=True))
    assert (result.failed, store.retried, store.rejected) == (1, 1, 0)
