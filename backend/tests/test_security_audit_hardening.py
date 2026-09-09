from pathlib import Path


MIGRATION = Path(__file__).resolve().parents[1] / "supabase" / "migrations" / "202609090001_security_audit_backend_hardening.sql"


def sql() -> str:
    return MIGRATION.read_text(encoding="utf-8").lower()


def test_trusted_gpx_requires_backend_validation_and_server_only_rpcs() -> None:
    text = sql()
    assert "validation_status = 'validated'" in text
    assert "status = 'ready' and track.validation_status in ('pending', 'legacy_unverified')" in text
    assert "revoke all on function public.claim_gpx_admission(uuid, integer) from public, anon, authenticated" in text
    assert "grant execute on function public.claim_gpx_admission(uuid, integer) to service_role" in text
    assert "select 1 from storage.objects object" in text


def test_unknown_external_email_does_not_consume_global_quota() -> None:
    function = sql().split("create or replace function public.request_external_account_deletion", 1)[1]
    function = function.split("drop function if exists public.claim_expired_account_export", 1)[0]
    assert function.index("select id into target_user") < function.index("external_deletion_global_rate")
    assert function.index("if target_user is null") < function.index("insert into public.account_external_deletion_requests")


def test_lifecycle_uuid_oracle_is_removed_and_owner_wrapper_added() -> None:
    text = sql()
    assert "revoke all on function public.has_current_contributor_access(uuid) from authenticated" in text
    assert "public.has_current_contributor_access(auth.uid())" in text


def test_storage_ingress_and_export_budgets_are_server_enforced() -> None:
    text = sql()
    for name in ("max_user_total_compressed_bytes", "max_tenant_total_compressed_bytes",
                 "max_pending_uploads_per_user", "max_tenant_upload_bytes_24h",
                 "max_export_input_bytes", "max_tenant_export_input_bytes_24h"):
        assert name in text
    assert "before insert on public.user_gpx_tracks" in text
    assert "validation_status = 'validated'" in text


def test_expired_export_claim_has_byte_budget_and_service_role_only() -> None:
    text = sql()
    assert "claim_expired_account_export(p_owner_token uuid, p_max_size_bytes bigint)" in text
    assert "coalesce(size_bytes,0) <= greatest(p_max_size_bytes,0)" in text
    assert "to service_role" in text
