from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "backend" / "supabase" / "migrations" / (
    "202609160002_fix_gpx_storage_delete_many_operation.sql"
)


def sql() -> str:
    return " ".join(MIGRATION.read_text(encoding="utf-8").lower().split())


def test_storage_select_policy_allows_exact_download_and_delete_operations() -> None:
    text = sql()
    policy = text.split("create policy user_gpx_objects_select_own", 1)[1]
    policy = policy.split(";", 1)[0]

    assert "'object.get_authenticated_info'" in policy
    assert "'object.get_authenticated'" in policy
    assert "'storage.object.delete_many'" in policy
    assert "'object.delete'" not in policy
    assert "signed" not in policy


def test_storage_delete_remains_owner_path_lifecycle_and_metadata_bound() -> None:
    text = sql()
    policy = text.split("create policy user_gpx_objects_select_own", 1)[1]
    policy = policy.split(";", 1)[0]

    assert "bucket_id = 'user-gpx'" in policy
    assert "owner_id = (select auth.uid()::text)" in policy
    assert "(storage.foldername(name))[1] = (select auth.uid()::text)" in policy
    assert "has_my_current_contributor_access()" in policy
    assert "track.user_id = (select auth.uid())" in policy
    assert "track.storage_path = name" in policy


def test_policy_does_not_enable_listing_or_signed_url_operations() -> None:
    text = sql()
    assert "storage.object.list" not in text
    assert "storage.object.sign" not in text


def test_followup_is_policy_only_and_preserves_existing_tracks() -> None:
    text = sql()
    assert "insert into" not in text
    assert "update public.user_gpx_tracks" not in text
    assert "delete from" not in text
    assert "alter table public.user_gpx_tracks" not in text
