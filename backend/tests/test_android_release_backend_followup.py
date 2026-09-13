from pathlib import Path


MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "supabase"
    / "migrations"
    / "202609120001_harden_gpx_download_and_resume_lifecycle_outbox.sql"
)
DOWNLOAD_FIX = (
    Path(__file__).resolve().parents[1]
    / "supabase"
    / "migrations"
    / "202609120002_fix_gpx_authenticated_download_operations.sql"
)


def migration_sql() -> str:
    return MIGRATION.read_text(encoding="utf-8").lower()


def download_fix_sql() -> str:
    return DOWNLOAD_FIX.read_text(encoding="utf-8").lower()


def test_gpx_policy_allows_only_authenticated_object_downloads() -> None:
    sql = download_fix_sql()
    policy = sql.split("create policy user_gpx_objects_select_own", 1)[1]
    policy = policy.split("create or replace function", 1)[0]

    assert "storage.allow_any_operation(array[" in policy
    assert "'object.get_authenticated_info'" in policy
    assert "'object.get_authenticated'" in policy
    assert "object.create_signed" not in policy
    assert "object.list" not in policy
    assert "bucket_id = 'user-gpx'" in policy
    assert "owner_id = (select auth.uid()::text)" in policy
    assert "(storage.foldername(name))[1] = (select auth.uid()::text)" in policy
    assert "(select public.has_my_current_contributor_access())" in policy
    assert "track.user_id = (select auth.uid())" in policy
    assert "track.storage_path = name" in policy


def test_completed_run_reopens_only_for_due_dispatchable_email_under_budget() -> None:
    sql = migration_sql()
    claim = sql.split(
        "create or replace function public.claim_account_lifecycle_daily_run", 1
    )[1]
    claim = claim.split("revoke all on function", 1)[0]

    assert "if run_row.status = 'completed'" in claim
    assert "outbox.status in ('pending', 'retry')" in claim
    assert "outbox.available_at <= now()" in claim
    assert "outbox.attempt_count < cfg.dispatcher_max_attempts" in claim
    assert "run_row.attempted_count >= cfg.dispatcher_daily_limit" in claim
    assert "completed_at = null" in claim


def test_lifecycle_run_counters_are_not_reset_when_reopened() -> None:
    sql = migration_sql()
    update = sql.split("update public.account_lifecycle_job_runs", 1)[1]
    update = update.split("returning * into run_row", 1)[0]

    assert "attempted_count =" not in update
    assert "sent_count =" not in update


def test_lifecycle_claim_remains_service_role_only() -> None:
    sql = migration_sql()
    assert (
        "revoke all on function public.claim_account_lifecycle_daily_run(date, uuid, integer)\n"
        "    from public, anon, authenticated"
    ) in sql
    assert (
        "grant execute on function public.claim_account_lifecycle_daily_run(date, uuid, integer)\n"
        "    to service_role"
    ) in sql
