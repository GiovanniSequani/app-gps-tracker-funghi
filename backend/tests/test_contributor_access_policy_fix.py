from pathlib import Path


MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "supabase"
    / "migrations"
    / "202609110001_fix_contributor_access_rls_policies.sql"
)


def migration_sql() -> str:
    return MIGRATION.read_text(encoding="utf-8").lower()


def test_policies_use_only_owner_wrapper() -> None:
    sql = migration_sql()
    policy_sql = sql.split("drop policy if exists user_profiles_update_username", 1)[1]
    policy_sql = policy_sql.split("do $$", 1)[0]
    assert policy_sql.count("public.has_my_current_contributor_access()") == 6
    assert "public.has_current_contributor_access(" not in policy_sql
    for policy in (
        "user_profiles_update_username",
        "user_gpx_tracks_read_own",
        "user_gpx_mushroom_markers_read_own",
        "user_gpx_objects_select_own",
        "user_gpx_objects_delete_own",
    ):
        assert f"create policy {policy}" in policy_sql


def test_arbitrary_uuid_helper_remains_server_only() -> None:
    sql = migration_sql()
    assert (
        "revoke all on function public.has_current_contributor_access(uuid)\n"
        "    from public, anon, authenticated"
    ) in sql
    assert (
        "grant execute on function public.has_current_contributor_access(uuid)\n"
        "    to service_role"
    ) in sql
    assert "grant execute on function public.has_my_current_contributor_access()\n    to authenticated, service_role" in sql


def test_migration_checks_security_definer_owner_and_effective_acl() -> None:
    sql = migration_sql()
    assert "if not helper_security_definer or not wrapper_security_definer" in sql
    assert "if helper_owner is distinct from wrapper_owner" in sql
    assert "has_function_privilege(" in sql
    assert "rls policy still invokes arbitrary-uuid contributor helper" in sql


def test_storage_policies_keep_owner_path_and_metadata_guards() -> None:
    sql = migration_sql()
    assert "bucket_id = 'user-gpx'" in sql
    assert "owner_id = (select auth.uid()::text)" in sql
    assert "(storage.foldername(name))[1] = (select auth.uid()::text)" in sql
    assert "track.user_id = (select auth.uid())" in sql
    assert "track.storage_path = name" in sql
