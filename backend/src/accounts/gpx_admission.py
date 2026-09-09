from __future__ import annotations

import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import quote

from backend.src.accounts.gpx_validation import GpxValidationResult, validate_gpx_gzip


class AdmissionStore(Protocol):
    def preview(self) -> dict[str, Any]: ...
    def claim(self, owner_token: str, limit: int | None) -> list[dict[str, Any]]: ...
    def complete(self, track_id: str, token: str, result: GpxValidationResult) -> None: ...
    def reject(self, track_id: str, token: str, error_code: str) -> None: ...
    def retry(self, track_id: str, token: str, error_code: str) -> None: ...


class AdmissionStorage(Protocol):
    def download(self, storage_path: str, local_path: Path) -> None: ...
    def delete(self, storage_path: str) -> None: ...


class SupabaseAdmissionStore:
    def __init__(self, client: Any) -> None:
        self.client = client

    def preview(self) -> dict[str, Any]:
        value = self.client.rpc("preview_gpx_admission")
        return value[0] if isinstance(value, list) else value

    def claim(self, owner_token: str, limit: int | None) -> list[dict[str, Any]]:
        payload: dict[str, Any] = {"p_owner_token": owner_token}
        if limit is not None:
            payload["p_limit"] = limit
        return list(self.client.rpc("claim_gpx_admission", payload) or [])

    def complete(self, track_id: str, token: str, result: GpxValidationResult) -> None:
        self.client.rpc("complete_gpx_admission", {
            "p_track_id": track_id,
            "p_claim_token": token,
            "p_compressed_size_bytes": result.compressed_size_bytes,
            "p_uncompressed_size_bytes": result.uncompressed_size_bytes,
            "p_content_sha256": result.content_sha256,
            "p_point_count": result.track_point_count,
            "p_started_at": result.started_at.isoformat() if result.started_at else None,
            "p_ended_at": result.ended_at.isoformat() if result.ended_at else None,
            "p_distance_m": result.distance_m,
            "p_bbox": result.bbox,
        })

    def reject(self, track_id: str, token: str, error_code: str) -> None:
        self.client.rpc("reject_gpx_admission", {
            "p_track_id": track_id, "p_claim_token": token, "p_error_code": error_code[:80]
        })

    def retry(self, track_id: str, token: str, error_code: str) -> None:
        self.client.rpc("retry_gpx_admission", {
            "p_track_id": track_id, "p_claim_token": token, "p_error_code": error_code[:80]
        })


class SupabaseAdmissionStorage:
    def __init__(self, client: Any) -> None:
        self.client = client

    def download(self, storage_path: str, local_path: Path) -> None:
        encoded = quote(storage_path.strip("/"), safe="/")
        response = self.client.request(
            "GET", f"/storage/v1/object/user-gpx/{encoded}", expected=(200,), stream=True
        )
        with local_path.open("wb") as target:
            for chunk in response.iter_content(chunk_size=64 * 1024):
                if chunk:
                    target.write(chunk)

    def delete(self, storage_path: str) -> None:
        self.client.storage_delete("user-gpx", [storage_path])


@dataclass(frozen=True)
class AdmissionResult:
    claimed: int
    validated: int
    rejected: int
    failed: int


def validate_pending_gpx(
    store: AdmissionStore,
    storage: AdmissionStorage,
    *,
    limit: int | None = None,
) -> AdmissionResult:
    if limit is not None and not 1 <= limit <= 100:
        raise ValueError("limit must be between 1 and 100")
    rows = store.claim(str(uuid.uuid4()), limit)
    validated = rejected = failed = 0
    for row in rows:
        track_id, token = str(row["id"]), str(row["claim_token"])
        try:
            with tempfile.TemporaryDirectory(prefix="funghitracker-gpx-") as temp_dir:
                local_path = Path(temp_dir) / "track.gpx.gz"
                storage.download(str(row["storage_path"]), local_path)
                result = validate_gpx_gzip(
                    local_path,
                    max_compressed_bytes=int(row["max_compressed_bytes"]),
                    max_uncompressed_bytes=int(row["max_uncompressed_bytes"]),
                )
            if result.content_sha256 != str(row["expected_sha256"]).lower():
                raise ValueError("uploaded GPX hash differs from reservation")
            if result.compressed_size_bytes != int(row["expected_compressed_size_bytes"]):
                raise ValueError("uploaded GPX size differs from reservation")
            store.complete(track_id, token, result)
            validated += 1
        except ValueError as exc:
            # Invalid content is removed from Storage and remains represented by
            # a non-trusted metadata row. Exact paths only; no bucket listing.
            try:
                storage.delete(str(row["storage_path"]))
                store.reject(track_id, token, type(exc).__name__)
                rejected += 1
            except Exception as cleanup_exc:
                store.retry(track_id, token, type(cleanup_exc).__name__)
                failed += 1
        except Exception as exc:
            store.retry(track_id, token, type(exc).__name__)
            failed += 1
    return AdmissionResult(len(rows), validated, rejected, failed)
