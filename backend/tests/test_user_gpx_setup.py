from __future__ import annotations

from pathlib import Path
import gzip

import pytest

from backend.src.accounts.gpx_setup import (
    EXPECTED_GPX_POLICIES,
    validate_gpx_setup_audit,
)
from backend.src.accounts.gpx_validation import validate_gpx_gzip


MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "supabase"
    / "migrations"
    / "202608060001_user_accounts_and_gpx_archive.sql"
)
FIX_FILENAME_MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "supabase"
    / "migrations"
    / "202608080001_fix_gpx_original_filename_regex.sql"
)
FIX_STORAGE_POLICY_MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "supabase"
    / "migrations"
    / "202608080002_fix_gpx_storage_insert_policy.sql"
)
DISPLAY_NAME_MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "supabase"
    / "migrations"
    / "202608130001_gpx_display_name_and_rename.sql"
)


def valid_audit() -> dict[str, object]:
    return {
        "config": {
            "max_tracks_per_user": 50,
            "max_compressed_bytes": 10_485_760,
            "max_uncompressed_bytes": 52_428_800,
        },
        "bucket": {
            "id": "user-gpx",
            "public": False,
            "file_size_limit": 10_485_760,
            "allowed_mime_types": ["application/gzip", "application/x-gzip"],
        },
        "rls": {"user_profiles": True, "user_gpx_tracks": True},
        "policies": sorted(EXPECTED_GPX_POLICIES),
        "profiles": 3,
        "tracks": 7,
    }


def test_gpx_setup_audit_accepts_complete_private_contract() -> None:
    summary = validate_gpx_setup_audit(valid_audit())

    assert summary.max_tracks_per_user == 50
    assert summary.max_compressed_bytes == 10_485_760
    assert summary.profile_count == 3
    assert summary.track_count == 7


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        (lambda value: value["bucket"].update(public=True), "must be private"),
        (lambda value: value["rls"].update(user_profiles=False), "RLS"),
        (lambda value: value.update(policies=[]), "policies are missing"),
        (
            lambda value: value["bucket"].update(file_size_limit=123),
            "does not match",
        ),
    ],
)
def test_gpx_setup_audit_rejects_unsafe_state(mutation, message: str) -> None:
    audit = valid_audit()
    mutation(audit)

    with pytest.raises(ValueError, match=message):
        validate_gpx_setup_audit(audit)


def test_user_gpx_migration_contains_security_and_quota_invariants() -> None:
    sql = MIGRATION.read_text(encoding="utf-8")
    lowered = sql.lower()

    assert "'user-gpx',\n    'user-gpx',\n    false" in lowered
    assert "references auth.users(id) on delete cascade" in lowered
    assert "pg_advisory_xact_lock" in lowered
    assert "max_tracks_per_user" in lowered
    assert "storage_path = user_id::text || '/' || id::text || '.gpx.gz'" in lowered
    assert "owner_id = (select auth.uid()::text)" in lowered
    assert "public.can_upload_user_gpx_object(name, owner_id, metadata)" in lowered
    assert "for update\n    to authenticated" not in lowered.split(
        "drop policy if exists user_gpx_objects_select_own"
    )[1]
    assert "password text" not in lowered
    assert "password_hash" not in lowered


def test_gpx_filename_regex_accepts_plain_and_compressed_extensions() -> None:
    expected = r"!~ '\.gpx(\.gz)?$'"
    overescaped = r"!~ '\\.gpx(\\.gz)?$'"

    for migration in (MIGRATION, FIX_FILENAME_MIGRATION):
        sql = migration.read_text(encoding="utf-8")
        assert expected in sql
        assert overescaped not in sql


def test_storage_insert_policy_uses_reservation_not_unavailable_metadata() -> None:
    for migration in (MIGRATION, FIX_STORAGE_POLICY_MIGRATION):
        sql = migration.read_text(encoding="utf-8")
        function_sql = sql.split(
            "create or replace function public.can_upload_user_gpx_object(", 1
        )[1].split("$$;", 1)[0]

        assert "track.status = 'pending_upload'" in function_sql
        assert "track.storage_path = p_name" in function_sql
        assert "p_owner_id is distinct from caller_id::text" in function_sql
        assert "p_metadata ->> 'size'" not in function_sql
        assert "p_metadata ->> 'mimetype'" not in function_sql


def test_finalize_still_verifies_stored_size_and_mime() -> None:
    sql = MIGRATION.read_text(encoding="utf-8")
    function_sql = sql.split(
        "create or replace function public.finalize_my_gpx_track(", 1
    )[1].split("$$;", 1)[0]

    assert "actual_size <> track.compressed_size_bytes" in function_sql
    assert "actual_mime not in ('application/gzip', 'application/x-gzip')" in function_sql


def test_gpx_display_name_has_one_shared_database_validator() -> None:
    sql = DISPLAY_NAME_MIGRATION.read_text(encoding="utf-8")
    normalized = sql.lower()

    assert "create or replace function public.normalize_gpx_display_name" in normalized
    assert "char_length(normalized_name) not between 1 and 120" in normalized
    assert "normalized_name ~ '[[:cntrl:]]'" in normalized
    assert "position('/' in normalized_name) > 0" in normalized
    assert "position(chr(92) in normalized_name) > 0" in normalized
    assert "user_gpx_tracks_display_name_format" in normalized

    reserve_sql = normalized.split(
        "create or replace function public.reserve_my_gpx_track(", 1
    )[1].split("$$;", 1)[0]
    rename_sql = normalized.split(
        "create or replace function public.rename_my_gpx_track(", 1
    )[1].split("$$;", 1)[0]
    assert "public.normalize_gpx_display_name(p_display_name)" in reserve_sql
    assert "public.normalize_gpx_display_name(p_new_name)" in rename_sql


def test_gpx_rename_is_owner_scoped_and_does_not_change_storage_path() -> None:
    sql = DISPLAY_NAME_MIGRATION.read_text(encoding="utf-8").lower()
    rename_sql = sql.split(
        "create or replace function public.rename_my_gpx_track(", 1
    )[1].split("$$;", 1)[0]

    assert "caller_id uuid := auth.uid()" in rename_sql
    assert "set display_name = normalized_name" in rename_sql
    assert "and user_id = caller_id" in rename_sql
    assert "set storage_path" not in rename_sql
    assert "update storage.objects" not in rename_sql
    assert "grant execute on function public.rename_my_gpx_track(uuid, text)" in sql
    assert "to authenticated" in sql


def test_gpx_gzip_validator_checks_real_content(tmp_path: Path) -> None:
    path = tmp_path / "walk.gpx.gz"
    content = (
        b'<?xml version="1.0"?><gpx version="1.1" '
        b'xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>'
        b'<trkpt lat="45.1" lon="10.2"/><trkpt lat="45.2" lon="10.3"/>'
        b"</trkseg></trk></gpx>"
    )
    with gzip.open(path, "wb") as target:
        target.write(content)

    result = validate_gpx_gzip(
        path,
        max_compressed_bytes=1024,
        max_uncompressed_bytes=2048,
    )

    assert result.uncompressed_size_bytes == len(content)
    assert result.track_point_count == 2
    assert len(result.content_sha256) == 64


def test_gpx_gzip_validator_rejects_fake_or_oversized_content(tmp_path: Path) -> None:
    fake = tmp_path / "fake.gpx.gz"
    fake.write_bytes(b"not gzip")
    with pytest.raises(ValueError, match="gzip"):
        validate_gpx_gzip(fake, max_compressed_bytes=1024, max_uncompressed_bytes=2048)

    oversized = tmp_path / "large.gpx.gz"
    with gzip.open(oversized, "wb") as target:
        target.write(b"<gpx><trk><trkseg><trkpt/>" + b" " * 4096 + b"</trkseg></trk></gpx>")
    with pytest.raises(ValueError, match="uncompressed"):
        validate_gpx_gzip(oversized, max_compressed_bytes=1024, max_uncompressed_bytes=512)

    invalid_point = tmp_path / "invalid-point.gpx.gz"
    with gzip.open(invalid_point, "wb") as target:
        target.write(b'<gpx><trk><trkseg><trkpt lat="91" lon="10"/></trkseg></trk></gpx>')
    with pytest.raises(ValueError, match="out of range"):
        validate_gpx_gzip(
            invalid_point,
            max_compressed_bytes=1024,
            max_uncompressed_bytes=2048,
        )
