from pathlib import Path


MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "supabase"
    / "migrations"
    / "202609140001_gpx_parser_and_actual_storage_quotas.sql"
)


def sql() -> str:
    return MIGRATION.read_text(encoding="utf-8").lower()


def test_pending_reservations_are_charged_at_full_object_limit() -> None:
    migration = sql()
    trigger = migration.split(
        "create or replace function public.enforce_gpx_reservation_budgets", 1
    )[1].split("create or replace function public.finalize_my_gpx_track", 1)[0]

    assert "then cfg.max_compressed_bytes" in trigger
    assert "user_bytes + cfg.max_compressed_bytes" in trigger
    assert "tenant_bytes + cfg.max_compressed_bytes" in trigger
    assert "recent_tenant_bytes + cfg.max_compressed_bytes" in trigger
    assert "new.user_id, new.id, cfg.max_compressed_bytes" in trigger


def test_finalize_uses_actual_storage_metadata_and_updates_ledger() -> None:
    migration = sql()
    finalize = migration.split(
        "create or replace function public.finalize_my_gpx_track", 1
    )[1].split("revoke all on function", 1)[0]

    assert "actual_size := (object_metadata ->> 'size')::bigint" in finalize
    assert "actual_size > cfg.max_compressed_bytes" in finalize
    assert "set compressed_size_bytes = actual_size" in finalize
    assert "where track_id = track.id" in finalize
    assert "ready_at = now()" in finalize
    assert "actual_size <> track.compressed_size_bytes" not in finalize


def test_storage_and_lifecycle_boundaries_remain_owner_only() -> None:
    migration = sql()
    finalize = migration.split(
        "create or replace function public.finalize_my_gpx_track", 1
    )[1].split("revoke all on function", 1)[0]

    assert "caller_id uuid := auth.uid()" in finalize
    assert "perform public.require_current_contributor_access()" in finalize
    assert "and user_id = caller_id" in finalize
    assert "object_owner_id is distinct from caller_id::text" in finalize
    assert "where bucket_id = 'user-gpx'" in finalize
