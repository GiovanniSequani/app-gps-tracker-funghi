from __future__ import annotations

import io
import inspect
import json
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend.src.accounts.rights import (
    GmailImapCleaner,
    SupabaseAuthAdmin,
    SupabaseRightsStorage,
    run_account_rights,
)
from backend.src.accounts.lifecycle import SmtpLifecycleSender


MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "supabase"
    / "migrations"
    / "202609010001_account_rights_export_deletion.sql"
)
PGCRYPTO_FIX_MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "supabase"
    / "migrations"
    / "202609050002_fix_account_rights_pgcrypto_resolution.sql"
)
CALLBACK_GRANT_FIX_MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "supabase"
    / "migrations"
    / "202609060003_fix_account_deletion_callback_grant.sql"
)
RIGHTS_CUTOVER_MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "supabase"
    / "migrations"
    / "202609060004_enable_account_rights.sql"
)
EXPORT_READY_EMAIL_MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "supabase"
    / "migrations"
    / "202609070001_export_ready_email.sql"
)
NOW = datetime(2026, 9, 1, 10, tzinfo=timezone.utc)


def migration_sql() -> str:
    return MIGRATION.read_text(encoding="utf-8").lower()


def pgcrypto_fix_sql() -> str:
    return PGCRYPTO_FIX_MIGRATION.read_text(encoding="utf-8").lower()


def rights_cutover_sql() -> str:
    return RIGHTS_CUTOVER_MIGRATION.read_text(encoding="utf-8").lower()


def callback_grant_fix_sql() -> str:
    return CALLBACK_GRANT_FIX_MIGRATION.read_text(encoding="utf-8").lower()


def export_ready_email_sql() -> str:
    return EXPORT_READY_EMAIL_MIGRATION.read_text(encoding="utf-8").lower()


class Response:
    def __init__(self, content: bytes = b"", status_code: int = 200) -> None:
        self.content = content
        self.status_code = status_code

    def iter_content(self, chunk_size: int):
        yield self.content

    def json(self):
        return {"statusCode": str(self.status_code)}


class ExportClient:
    def __init__(self, *, full: bool) -> None:
        self.full = full
        self.uploaded = b""

    def rest_select(self, table: str, *, params: dict[str, str]):
        if table == "user_profiles":
            return [{"user_id": "user-1", "username": "test", "account_state": "restricted"}]
        if table == "user_gpx_tracks":
            return ([{"id": "track-1", "user_id": "user-1", "storage_path": "user-1/track-1.gpx.gz", "validation_status": "validated", "created_at": "2026-01-01"}] if self.full else [])
        if table == "user_gpx_mushroom_markers":
            return ([{"id": "marker-1", "user_id": "user-1", "latitude": 46.3, "longitude": 11.5, "created_at": "2026-01-01"}] if self.full else [])
        return []

    def _headers(self, content_type: str):
        return {"Content-Type": content_type}

    def request(self, method: str, path: str, *, expected, **kwargs):
        if method == "GET":
            return Response(b"controlled-gpx-gzip")
        self.uploaded = kwargs["data"].read()
        return Response()

    def storage_delete(self, bucket: str, paths: list[str]):
        pass


def export_claim() -> dict[str, Any]:
    return {
        "id": "job-1",
        "user_id": "user-1",
        "email": "controlled@example.invalid",
        "storage_path": "user-1/job-1.zip",
    }


def test_empty_account_export_contains_authenticated_account_and_metadata() -> None:
    client = ExportClient(full=False)
    size, digest = SupabaseRightsStorage(client).build_export(export_claim())

    assert size == len(client.uploaded)
    assert len(digest) == 64
    with zipfile.ZipFile(io.BytesIO(client.uploaded)) as archive:
        assert set(archive.namelist()) == {
            "account.json", "profile.json", "legal-events.json", "tracks.json",
            "mushroom-markers.json", "service-email-events.json",
            "export-requests.json", "deletion-verification-events.json",
        }
        assert json.loads(archive.read("tracks.json")) == []


def test_full_suspended_account_export_contains_raw_gpx_and_markers() -> None:
    client = ExportClient(full=True)
    SupabaseRightsStorage(client).build_export(export_claim())

    with zipfile.ZipFile(io.BytesIO(client.uploaded)) as archive:
        assert archive.read("gpx/track-1.gpx.gz") == b"controlled-gpx-gzip"
        assert json.loads(archive.read("profile.json"))[0]["account_state"] == "restricted"
        assert json.loads(archive.read("mushroom-markers.json"))[0]["latitude"] == 46.3


class Store:
    def __init__(self, stage: str = "storage_cleanup") -> None:
        self.stage = stage
        self.deletion_available = True
        self.failed: list[str] = []
        self.advanced: list[str] = []

    def prepare(self, now): return {"enabled": True}
    def claim_export(self, token): return {"claimed": False}
    def complete_export(self, *args): pass
    def fail_export(self, *args): pass
    def claim_expired_export(self, token, max_size_bytes): return {"claimed": False}
    def complete_expired_export(self, *args): pass
    def due_lifecycle_email_ids(self, before, limit): return []
    def mark_lifecycle_email_clean(self, ids): pass
    def prune_lifecycle_email(self, ids): pass

    def claim_deletion(self, token):
        if not self.deletion_available:
            return {"claimed": False}
        self.deletion_available = False
        return {
            "claimed": True, "id": "delete-1", "user_id": "user-1",
            "email": "controlled@example.invalid", "stage": self.stage,
            "storage_objects": [{"bucket": "user-gpx", "path": "user-1/a.gpx.gz"}],
            "lifecycle_message_ids": [10],
        }

    def mark_deletion_email_clean(self, job_id, token, ids):
        self.stage = "storage_cleanup"

    def advance_deletion(self, job_id, token, stage):
        self.advanced.append(stage)
        self.stage = {"storage_cleanup": "database_cleanup", "database_cleanup": "auth_cleanup", "auth_cleanup": "completed"}[stage]

    def fail_deletion(self, job_id, token, error_code):
        self.failed.append(error_code)


class Storage:
    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.deleted = 0

    def build_export(self, claim): return 1, "0" * 64
    def delete_export(self, path): pass
    def delete_objects(self, objects):
        if self.fail:
            raise OSError("controlled Storage error")
        self.deleted += len(objects)


class Auth:
    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.deleted = 0

    def delete_user(self, user_id):
        if self.fail:
            raise OSError("controlled Auth error")
        self.deleted += 1


class Mail:
    def delete_for_account(self, recipient, lifecycle_ids): pass
    def delete_lifecycle_ids(self, lifecycle_ids): pass
    def delete_auth_mail_before(self, before): pass


class FailingMail(Mail):
    def delete_for_account(self, recipient, lifecycle_ids):
        raise OSError("controlled IMAP error")


def test_storage_failure_keeps_deletion_resumable_at_same_stage() -> None:
    store = Store("storage_cleanup")
    result = run_account_rights(store, Storage(fail=True), Auth(), Mail(), now=NOW)

    assert result.failures == 1
    assert store.advanced == []
    assert store.failed == ["OSError"]


def test_auth_failure_retries_after_database_has_been_cleaned() -> None:
    store = Store("auth_cleanup")
    result = run_account_rights(store, Storage(), Auth(fail=True), Mail(), now=NOW)

    assert result.failures == 1
    assert store.advanced == []
    assert store.failed == ["OSError"]


def test_complete_deletion_runs_storage_database_then_auth() -> None:
    store = Store("email_cleanup")
    auth = Auth()
    storage = Storage()
    result = run_account_rights(store, storage, auth, Mail(), now=NOW)

    assert result.deletions_completed == 1
    assert store.advanced == ["storage_cleanup", "database_cleanup", "auth_cleanup"]
    assert storage.deleted == 1
    assert auth.deleted == 1


def test_partial_gmail_cleanup_stops_before_storage_and_retries() -> None:
    store = Store("email_cleanup")
    storage = Storage()
    result = run_account_rights(store, storage, Auth(), FailingMail(), now=NOW)

    assert result.failures >= 1
    assert storage.deleted == 0
    assert store.advanced == []
    assert "OSError" in store.failed


def test_deletion_runs_before_bounded_expired_export_cleanup() -> None:
    events: list[str] = []

    class OrderedStore(Store):
        expired = 0
        def claim_deletion(self, token):
            events.append("deletion")
            return super().claim_deletion(token)
        def claim_expired_export(self, token, max_size_bytes):
            events.append(f"cleanup:{max_size_bytes}")
            if self.expired >= 5 or max_size_bytes < 10:
                return {"claimed": False}
            self.expired += 1
            return {"claimed": True, "id": f"expired-{self.expired}", "storage_path": "x", "size_bytes": 10}

    result = run_account_rights(
        OrderedStore("auth_cleanup"), Storage(), Auth(), Mail(), now=NOW,
        max_exports=0, max_deletions=1, email_cleanup_limit=0,
        max_expired_exports=2, max_expired_export_bytes=15,
    )

    assert result.deletions_completed == 1
    assert result.exports_cleaned == 1
    assert events[0] == "deletion"
    assert events[1:] == ["cleanup:15", "cleanup:5"]


def test_export_omits_raw_object_until_server_validation() -> None:
    client = ExportClient(full=True)
    original = client.rest_select
    def untrusted(table: str, *, params: dict[str, str]):
        rows = original(table, params=params)
        if table == "user_gpx_tracks":
            rows[0]["validation_status"] = "legacy_unverified"
        return rows
    client.rest_select = untrusted  # type: ignore[method-assign]

    SupabaseRightsStorage(client).build_export(export_claim())
    with zipfile.ZipFile(io.BytesIO(client.uploaded)) as archive:
        assert "gpx/track-1.gpx.gz" not in archive.namelist()
        assert json.loads(archive.read("tracks.json"))[0]["validation_status"] == "legacy_unverified"


def test_rights_migration_is_disabled_and_private_by_default() -> None:
    sql = migration_sql()
    assert "account_rights_enabled boolean not null default false" in sql
    assert "values ('user-data-exports', 'user-data-exports', false" in sql
    assert "job.status = 'ready' and job.expires_at > now()" in sql
    assert "grant execute on function public.request_my_data_export() to authenticated" in sql
    assert "account_state = 'deletion_pending'" in sql


def test_external_deletion_is_non_enumerating_rate_limited_and_token_hashed() -> None:
    sql = migration_sql()
    function = sql.split("create or replace function public.request_external_account_deletion", 1)[1]
    function = function.split("create or replace function public.request_my_account_deletion_verification", 1)[0]
    assert function.count("jsonb_build_object('accepted', true)") >= 3
    assert "external_global_hourly_limit" in function
    assert "external_request_hourly_limit" in function
    assert "extensions.hmac(convert_to(normalized_email, 'utf8'), rate_key, 'sha256')" in function
    assert "encode(extensions.digest(raw_token, 'sha256'), 'hex')" in function
    assert "verification_token', raw_token" in function
    final_return = function.rsplit("return jsonb_build_object", 1)[1]
    assert "raw_token" not in final_return


def test_pgcrypto_fix_resolves_extension_functions_and_checks_gate_before_token_creation() -> None:
    sql = pgcrypto_fix_sql()
    external = sql.split("create or replace function public.request_external_account_deletion", 1)[1]
    external = external.split("create or replace function public.request_my_account_deletion_verification", 1)[0]

    assert "extensions.gen_random_bytes(32)" in external
    assert "extensions.hmac(" in external
    assert "extensions.digest(" in external
    assert external.index("if not cfg.account_rights_enabled") < external.index("extensions.gen_random_bytes(32)")
    assert "raw_token text :=" not in external

    authenticated = sql.split("create or replace function public.request_my_account_deletion_verification", 1)[1]
    authenticated = authenticated.split("create or replace function public.confirm_account_deletion", 1)[0]
    assert authenticated.index("if not cfg.account_rights_enabled") < authenticated.index("extensions.gen_random_bytes(32)")
    assert "extensions.hmac(" in authenticated
    assert "extensions.digest(" in authenticated

    confirmation = sql.split("create or replace function public.confirm_account_deletion", 1)[1]
    assert "extensions.digest(" in confirmation
    assert "grant execute on function public.confirm_account_deletion(text) to anon, authenticated, service_role" in sql


def test_rights_cutover_is_atomic_fail_closed_and_preserves_lifecycle() -> None:
    sql = rights_cutover_sql()

    assert "begin;" in sql and sql.rstrip().endswith("commit;")
    assert "for update" in sql
    assert "if not cfg.lifecycle_enabled then" in sql
    assert "current_terms_version is distinct from '1.0'" in sql
    assert "current_privacy_version is distinct from '1.0'" in sql
    assert "id = 'user-data-exports' and public = false" in sql
    assert "has_function_privilege('anon', 'public.confirm_account_deletion(text)', 'execute')" in sql
    assert "account rights worker rpc is exposed to clients" in sql
    assert "set account_rights_enabled = true" in sql
    assert "set lifecycle_enabled" not in sql


def test_public_deletion_callback_fix_preserves_switches_and_private_tables() -> None:
    sql = callback_grant_fix_sql()

    assert "grant execute on function public.confirm_account_deletion(text) to anon, authenticated, service_role" in sql
    assert "account deletion internals are exposed to anonymous clients" in sql
    assert "set account_rights_enabled" not in sql
    assert "set lifecycle_enabled" not in sql


def test_database_cleanup_requires_storage_and_email_stages_first() -> None:
    sql = migration_sql()
    advance = sql.split("create or replace function public.advance_account_deletion", 1)[1]
    advance = advance.split("create or replace function public.fail_account_deletion", 1)[0]
    assert "account storage cleanup is incomplete" in advance
    assert "email cleanup is incomplete" in advance
    assert advance.index("delete from public.account_email_outbox") < advance.index("delete from public.user_profiles")
    assert "stage = 'auth_cleanup'" in advance


def test_email_cleanup_is_exact_and_tokens_are_scrubbed() -> None:
    sql = migration_sql()
    assert "gmail_cleaned_at timestamptz" in sql
    assert "payload = payload - 'verification_token'" in sql
    assert "new.payload := new.payload - 'verification_token'" in sql
    assert "created_at < p_now - interval '30 days'" in sql
    assert "sent_at < p_now - interval '24 months'" in sql
    sender_source = inspect.getsource(SmtpLifecycleSender.build_message)
    assert "#token=" in sender_source
    assert "?token=" not in sender_source
    assert "should_soft_delete=false" in inspect.getsource(SupabaseAuthAdmin.delete_user)


def test_export_completion_atomically_enqueues_one_private_notification() -> None:
    sql = export_ready_email_sql()
    function = sql.split("create or replace function public.complete_account_export", 1)[1]
    function = function.split("revoke all on function public.complete_account_export", 1)[0]

    assert "'export_ready'" in sql
    assert "returning * into completed_job" in function
    assert function.index("status = 'ready'") < function.index("perform public.enqueue_account_email")
    assert "completed_job.user_id::text || ':export-ready:' || completed_job.id::text" in function
    assert "'export_id', completed_job.id" in function
    assert "'expires_at', completed_job.expires_at" in function
    assert "storage_path" not in function
    assert "verification_token" not in function
    assert "set lifecycle_enabled" not in sql
    assert "set account_rights_enabled" not in sql
    assert "\nbegin;\n" in sql
    assert "\ncommit;\n" in sql


class Imap:
    def __init__(self, host, port) -> None:
        self.mailbox = ""
        self.trashed: list[bytes] = []
        self.deleted: list[bytes] = []
        self.headers = {
            b"1": b"Subject: Conferma account\r\nTo: target@example.invalid\r\n\r\n",
            b"2": b"Subject: Re: Conferma account\r\nTo: target@example.invalid\r\n\r\n",
            b"3": b"Subject: Conferma account\r\nTo: other@example.invalid\r\n\r\n",
        }

    def login(self, username, password): return "OK", []
    def list(self):
        return "OK", [
            b'(\\HasNoChildren \\Sent) "/" "[Gmail]/Sent Mail"',
            b'(\\HasNoChildren \\Trash) "/" "[Gmail]/Trash"',
        ]
    def select(self, mailbox): self.mailbox = mailbox; return "OK", []
    def expunge(self): return "OK", []
    def logout(self): return "BYE", []

    def uid(self, command, *args):
        if command == "SEARCH":
            return "OK", [b"1 2 3"]
        uid = args[0]
        if command == "FETCH":
            return "OK", [(b"headers", self.headers[uid])]
        if command == "STORE" and "+X-GM-LABELS" in args:
            self.trashed.append(uid)
            return "OK", []
        if command == "STORE" and "+FLAGS" in args:
            self.deleted.append(uid)
            return "OK", []
        raise AssertionError((command, args))


def test_gmail_search_quotes_subject_recipient_and_header_values() -> None:
    calls: list[tuple[object, ...]] = []

    class SearchImap:
        def uid(self, command, *args):
            calls.append((command, *args))
            return "OK", [b""]

    GmailImapCleaner._search(
        SearchImap(), "TO", "user+test@example.invalid", "HEADER", "Subject", "Conferma account"
    )

    assert calls == [(
        "SEARCH", None, "TO", '"user+test@example.invalid"',
        "HEADER", "Subject", '"Conferma account"',
    )]


def test_gmail_mailbox_names_are_quoted() -> None:
    assert GmailImapCleaner._quoted("[Gmail]/Sent Mail") == '"[Gmail]/Sent Mail"'


def test_gmail_cleanup_never_deletes_partial_subject_or_other_recipient() -> None:
    instances: list[Imap] = []

    def factory(host, port):
        instance = Imap(host, port)
        instances.append(instance)
        return instance

    cleaner = GmailImapCleaner(
        username="sender@example.invalid",
        app_password="controlled-secret",
        auth_subjects=["Conferma account"],
        factory=factory,
    )
    cleaner.delete_for_account("target@example.invalid", [])

    assert instances[0].trashed == [b"1"]
    assert instances[0].deleted == [b"1"]
