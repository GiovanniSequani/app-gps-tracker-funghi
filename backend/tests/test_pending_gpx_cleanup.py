from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from backend.src.accounts.pending_uploads import cleanup_expired_pending_uploads


MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "supabase"
    / "migrations"
    / "202608310001_account_lifecycle_and_email_outbox.sql"
)
SCRIPTS = Path(__file__).resolve().parents[1] / "scripts" / "accounts"
NOW = datetime(2026, 9, 1, 12, tzinfo=timezone.utc)


class Store:
    def __init__(self) -> None:
        self.rows = [{"id": "track-1", "storage_path": "private/path.gpx.gz", "claim_token": "claim-1"}]
        self.completed: list[tuple[str, str]] = []
        self.released: list[tuple[str, str]] = []

    def preview(self, now):
        return {"ttl_hours": 24, "cleanup_limit": 50, "eligible": len(self.rows), "reclaimable_claims": 0}

    def claim(self, owner_token, now, limit):
        claimed, self.rows = self.rows, []
        return claimed

    def complete(self, track_id, claim_token):
        self.completed.append((track_id, claim_token))

    def fail(self, track_id, claim_token):
        self.released.append((track_id, claim_token))


class Storage:
    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.deleted: list[str] = []

    def delete(self, storage_path):
        if self.fail:
            raise OSError("controlled storage failure")
        self.deleted.append(storage_path)


def test_cleanup_deletes_only_claimed_pending_object_then_metadata() -> None:
    store = Store()
    storage = Storage()

    result = cleanup_expired_pending_uploads(store, storage, now=NOW)

    assert result.claimed == result.cleaned == 1
    assert result.failed == 0
    assert storage.deleted == ["private/path.gpx.gz"]
    assert store.completed == [("track-1", "claim-1")]
    assert store.released == []


def test_cleanup_releases_failed_claim_for_a_later_lease_recovery() -> None:
    store = Store()

    result = cleanup_expired_pending_uploads(store, Storage(fail=True), now=NOW)

    assert result.claimed == 1
    assert result.cleaned == 0
    assert result.failed == 1
    assert store.completed == []
    assert store.released == [("track-1", "claim-1")]


def test_sql_cleanup_is_service_role_only_and_never_selects_ready_tracks() -> None:
    sql = MIGRATION.read_text(encoding="utf-8").lower()
    claim = sql.split("create or replace function public.claim_expired_pending_gpx_uploads", 1)[1]
    claim = claim.split("create or replace function public.complete_expired_pending_gpx_upload_cleanup", 1)[0]
    assert "track.status = 'pending_upload'" in claim
    assert "track.status = 'cleanup_pending'" in claim
    assert "for update skip locked" in claim
    assert "status = 'ready'" not in claim
    assert "grant execute on function public.claim_expired_pending_gpx_uploads(uuid, timestamptz, integer) to service_role" in sql
    assert "grant execute on function public.claim_expired_pending_gpx_uploads(uuid, timestamptz, integer) to authenticated" not in sql


def test_account_command_logs_are_aggregate_only() -> None:
    for name in ("run_account_lifecycle.py", "run_account_rights.py", "cleanup_pending_gpx_uploads.py"):
        source = (SCRIPTS / name).read_text(encoding="utf-8")
        assert "type(exc).__name__" in source
        assert "{exc}" not in source
        assert "traceback" not in source
