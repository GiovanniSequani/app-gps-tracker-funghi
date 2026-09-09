from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Protocol


def _rpc_rows(value: Any) -> list[dict[str, Any]]:
    if value is None:
        return []
    if isinstance(value, list) and all(isinstance(item, dict) for item in value):
        return value
    raise RuntimeError("unexpected pending-upload cleanup RPC response")


def _rpc_object(value: Any) -> dict[str, Any]:
    if isinstance(value, list) and len(value) == 1 and isinstance(value[0], dict):
        return value[0]
    if isinstance(value, dict):
        return value
    raise RuntimeError("unexpected pending-upload cleanup preview")


class PendingUploadStore(Protocol):
    def preview(self, now: datetime) -> dict[str, Any]: ...
    def claim(self, owner_token: str, now: datetime, limit: int | None) -> list[dict[str, Any]]: ...
    def complete(self, track_id: str, claim_token: str) -> None: ...
    def fail(self, track_id: str, claim_token: str) -> None: ...


class PendingUploadStorage(Protocol):
    def delete(self, storage_path: str) -> None: ...


class SupabasePendingUploadStore:
    def __init__(self, client: Any) -> None:
        self.client = client

    def preview(self, now: datetime) -> dict[str, Any]:
        return _rpc_object(self.client.rpc("preview_expired_pending_gpx_uploads", {"p_now": now.isoformat()}))

    def claim(self, owner_token: str, now: datetime, limit: int | None) -> list[dict[str, Any]]:
        payload: dict[str, object] = {
            "p_owner_token": owner_token,
            "p_now": now.isoformat(),
        }
        if limit is not None:
            payload["p_limit"] = limit
        return _rpc_rows(self.client.rpc("claim_expired_pending_gpx_uploads", payload))

    def complete(self, track_id: str, claim_token: str) -> None:
        self.client.rpc(
            "complete_expired_pending_gpx_upload_cleanup",
            {"p_track_id": track_id, "p_claim_token": claim_token},
        )

    def fail(self, track_id: str, claim_token: str) -> None:
        self.client.rpc(
            "fail_expired_pending_gpx_upload_cleanup",
            {"p_track_id": track_id, "p_claim_token": claim_token},
        )


class SupabasePendingUploadStorage:
    def __init__(self, client: Any) -> None:
        self.client = client

    def delete(self, storage_path: str) -> None:
        self.client.storage_delete("user-gpx", [storage_path])


@dataclass(frozen=True)
class PendingUploadCleanupResult:
    claimed: int
    cleaned: int
    failed: int


def cleanup_expired_pending_uploads(
    store: PendingUploadStore,
    storage: PendingUploadStorage,
    *,
    now: datetime | None = None,
    limit: int | None = None,
) -> PendingUploadCleanupResult:
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    if limit is not None and not 1 <= limit <= 500:
        raise ValueError("limit must be between 1 and 500")

    claimed_rows = store.claim(str(uuid.uuid4()), current, limit)
    cleaned = failed = 0
    for row in claimed_rows:
        track_id = str(row["id"])
        claim_token = str(row["claim_token"])
        try:
            storage.delete(str(row["storage_path"]))
            store.complete(track_id, claim_token)
            cleaned += 1
        except Exception:
            failed += 1
            try:
                store.fail(track_id, claim_token)
            except Exception:
                # The expired lease makes a later run recoverable even if this
                # best-effort state release also fails.
                pass
    return PendingUploadCleanupResult(len(claimed_rows), cleaned, failed)
