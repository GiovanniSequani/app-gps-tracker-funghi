from pathlib import Path


MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "supabase"
    / "migrations"
    / "202608290001_contributor_account_contract.sql"
)


def migration_sql() -> str:
    return MIGRATION.read_text(encoding="utf-8").lower()


def test_contributor_account_migration_has_minimal_states_and_reasons() -> None:
    sql = migration_sql()

    for state in ("active", "restricted", "deletion_pending"):
        assert f"'{state}'" in sql
    for reason in ("terms_outdated", "terms_refused", "inactive", "security"):
        assert f"'{reason}'" in sql

    assert "pending_reacceptance" not in sql
    assert "deletion_scheduled" not in sql
    assert "user_profiles_account_state_consistent" in sql


def test_existing_accounts_are_restricted_once_without_retrodated_deadline() -> None:
    sql = migration_sql()
    backfill = sql.split("update public.user_profiles", 1)[1].split(";", 1)[0]

    assert "account_state = 'restricted'" in backfill
    assert "restriction_reason = 'terms_outdated'" in backfill
    assert "last_meaningful_activity_at = coalesce(last_meaningful_activity_at, now())" in backfill
    assert "where account_state is null" in backfill
    assert "legal_reaccept_deadline_at" not in backfill


def test_legacy_consent_is_retained_but_not_used_as_target_authorization() -> None:
    sql = migration_sql()

    assert "legacy field retained for compatibility and audit only" in sql
    assert "raw_gpx_research_consent = true" not in sql
    assert "raw_gpx_research_consent and" not in sql


def test_account_audit_is_service_role_only() -> None:
    sql = migration_sql()
    signature = "public.user_account_contract_setup_audit()"

    assert f"create or replace function {signature}" in sql
    assert f"revoke all on function {signature} from public, anon, authenticated" in sql
    assert f"grant execute on function {signature} to service_role" in sql


def test_migration_uses_rerunnable_schema_operations() -> None:
    sql = migration_sql()

    assert "add column if not exists account_state" in sql
    assert "create index if not exists user_profiles_account_state_idx" in sql
    assert "select 1 from pg_constraint" in sql
    assert "where account_state is null" in sql
