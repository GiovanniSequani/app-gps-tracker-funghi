from __future__ import annotations

import hashlib
import imaplib
import json
import re
import tempfile
import time
import uuid
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from email import policy
from email.parser import BytesParser
from email.utils import getaddresses
from email.header import decode_header, make_header
from pathlib import Path
from typing import Any, Callable, Protocol
from urllib.parse import quote

from backend.src.accounts.lifecycle import lifecycle_message_id_candidates

EXPORT_BUCKET = "user-data-exports"
GPX_BUCKET = "user-gpx"


def rpc_object(value: Any) -> dict[str, Any]:
    if isinstance(value, list) and len(value) == 1 and isinstance(value[0], dict):
        return value[0]
    if isinstance(value, dict):
        return value
    raise RuntimeError("unexpected account-rights RPC response")


class RightsStore(Protocol):
    def prepare(self, now: datetime) -> dict[str, Any]: ...
    def claim_export(self, token: str) -> dict[str, Any]: ...
    def complete_export(self, job_id: str, token: str, size: int, sha256: str) -> None: ...
    def fail_export(self, job_id: str, token: str, error_code: str) -> None: ...
    def claim_expired_export(self, token: str, max_size_bytes: int) -> dict[str, Any]: ...
    def complete_expired_export(self, job_id: str, token: str) -> None: ...
    def claim_deletion(self, token: str) -> dict[str, Any]: ...
    def mark_deletion_email_clean(self, job_id: str, token: str, ids: list[int]) -> None: ...
    def advance_deletion(self, job_id: str, token: str, stage: str) -> None: ...
    def fail_deletion(self, job_id: str, token: str, error_code: str) -> None: ...
    def due_lifecycle_email_ids(self, before: datetime, limit: int) -> list[int]: ...
    def mark_lifecycle_email_clean(self, ids: list[int]) -> None: ...
    def prune_lifecycle_email(self, ids: list[int]) -> None: ...


class RightsStorage(Protocol):
    def build_export(self, claim: dict[str, Any]) -> tuple[int, str]: ...
    def delete_objects(self, objects: list[dict[str, str]]) -> None: ...
    def delete_export(self, path: str) -> None: ...


class AuthAdmin(Protocol):
    def delete_user(self, user_id: str) -> None: ...


class ServiceMailCleaner(Protocol):
    def delete_for_account(self, recipient: str, lifecycle_ids: list[int]) -> None: ...
    def delete_lifecycle_ids(self, lifecycle_ids: list[int]) -> None: ...
    def delete_auth_mail_before(self, before: datetime) -> None: ...


@dataclass(frozen=True)
class RightsRunResult:
    exports_ready: int = 0
    exports_cleaned: int = 0
    deletions_completed: int = 0
    email_rows_cleaned: int = 0
    failures: int = 0


class SupabaseRightsStore:
    def __init__(self, client: Any) -> None:
        self.client = client

    def prepare(self, now: datetime) -> dict[str, Any]:
        return rpc_object(self.client.rpc("prepare_account_rights_daily", {"p_now": now.isoformat()}))

    def claim_export(self, token: str) -> dict[str, Any]:
        return rpc_object(self.client.rpc("claim_next_account_export", {"p_owner_token": token, "p_lease_seconds": 1800}))

    def complete_export(self, job_id: str, token: str, size: int, sha256: str) -> None:
        self.client.rpc("complete_account_export", {"p_job_id": job_id, "p_claim_token": token, "p_size_bytes": size, "p_sha256": sha256})

    def fail_export(self, job_id: str, token: str, error_code: str) -> None:
        self.client.rpc("fail_account_export", {"p_job_id": job_id, "p_claim_token": token, "p_error_code": error_code[:80]})

    def claim_expired_export(self, token: str, max_size_bytes: int) -> dict[str, Any]:
        return rpc_object(self.client.rpc("claim_expired_account_export", {
            "p_owner_token": token, "p_max_size_bytes": max_size_bytes
        }))

    def complete_expired_export(self, job_id: str, token: str) -> None:
        self.client.rpc("complete_expired_account_export", {"p_job_id": job_id, "p_claim_token": token})

    def claim_deletion(self, token: str) -> dict[str, Any]:
        return rpc_object(self.client.rpc("claim_next_account_deletion", {"p_claim_token": token}))

    def mark_deletion_email_clean(self, job_id: str, token: str, ids: list[int]) -> None:
        self.client.rpc("mark_deletion_email_cleanup_complete", {"p_job_id": job_id, "p_claim_token": token, "p_message_ids": ids})

    def advance_deletion(self, job_id: str, token: str, stage: str) -> None:
        self.client.rpc("advance_account_deletion", {"p_job_id": job_id, "p_claim_token": token, "p_completed_stage": stage})

    def fail_deletion(self, job_id: str, token: str, error_code: str) -> None:
        self.client.rpc("fail_account_deletion", {"p_job_id": job_id, "p_claim_token": token, "p_error_code": error_code[:80]})

    def due_lifecycle_email_ids(self, before: datetime, limit: int) -> list[int]:
        rows = self.client.rpc("list_due_lifecycle_email_cleanup", {"p_before": before.isoformat(), "p_limit": limit}) or []
        return [int(row["id"]) for row in rows]

    def mark_lifecycle_email_clean(self, ids: list[int]) -> None:
        self.client.rpc("mark_lifecycle_email_cleaned", {"p_ids": ids})

    def prune_lifecycle_email(self, ids: list[int]) -> None:
        self.client.rpc("complete_lifecycle_email_cleanup", {"p_ids": ids})


class SupabaseRightsStorage:
    def __init__(self, client: Any) -> None:
        self.client = client

    def _json_rows(
        self, table: str, user_id: str, select: str = "*", order: str = "created_at.asc"
    ) -> list[dict[str, Any]]:
        return self.client.rest_select(
            table, params={"select": select, "user_id": f"eq.{user_id}", "order": order}
        )

    def _stream_storage_into_zip(
        self, archive: zipfile.ZipFile, bucket: str, remote_path: str, archive_path: str
    ) -> bool:
        encoded = quote(remote_path.strip("/"), safe="/")
        response = self.client.request(
            "GET", f"/storage/v1/object/{quote(bucket, safe='')}/{encoded}",
            expected=(200, 400, 404), stream=True
        )
        if response.status_code == 404:
            return False
        if response.status_code == 400:
            try:
                missing = str(response.json().get("statusCode")) == "404"
            except ValueError:
                missing = False
            if missing:
                return False
            raise RuntimeError("GPX Storage download failed")
        info = zipfile.ZipInfo(archive_path)
        info.compress_type = zipfile.ZIP_STORED
        with archive.open(info, "w") as target:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    target.write(chunk)
        return True

    def _upload_file(self, path: Path, remote_path: str) -> None:
        headers = self.client._headers("application/zip")
        headers["x-upsert"] = "true"
        headers["cache-control"] = "private, no-store, max-age=0"
        encoded = quote(remote_path.strip("/"), safe="/")
        with path.open("rb") as source:
            self.client.request(
                "POST", f"/storage/v1/object/{EXPORT_BUCKET}/{encoded}",
                expected=(200, 201), headers=headers, data=source
            )

    def build_export(self, claim: dict[str, Any]) -> tuple[int, str]:
        user_id = str(claim["user_id"])
        tracks = self._json_rows("user_gpx_tracks", user_id)
        payloads = {
            "profile.json": self._json_rows("user_profiles", user_id),
            "legal-events.json": self._json_rows(
                "user_legal_events", user_id, order="occurred_at.asc"
            ),
            "tracks.json": tracks,
            "mushroom-markers.json": self._json_rows("user_gpx_mushroom_markers", user_id),
            "service-email-events.json": self._json_rows(
                "account_email_outbox", user_id,
                "event_type,status,created_at,sent_at,last_error_code"
            ),
            "export-requests.json": self._json_rows(
                "account_export_jobs", user_id,
                "id,status,requested_at,ready_at,expires_at,size_bytes",
                order="requested_at.asc",
            ),
            "deletion-verification-events.json": self._json_rows(
                "account_external_deletion_requests", user_id,
                "id,source,created_at,expires_at,consumed_at",
            ),
        }
        account = dict(claim.get("auth_metadata") or {"email": claim.get("email")})
        account["exported_at"] = datetime.now(timezone.utc).isoformat()
        with tempfile.TemporaryDirectory(prefix="funghitracker-export-") as temp_dir:
            zip_path = Path(temp_dir) / "personal-data.zip"
            with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
                archive.writestr("account.json", json.dumps(account, ensure_ascii=False, indent=2))
                for name, rows in payloads.items():
                    archive.writestr(name, json.dumps(rows, ensure_ascii=False, indent=2, default=str))
                for track in tracks:
                    # Raw objects are trusted only after the backend worker has
                    # parsed the gzip/XML and recomputed hash and statistics.
                    if track.get("validation_status") != "validated":
                        continue
                    storage_path = str(track.get("storage_path") or "")
                    if storage_path:
                        self._stream_storage_into_zip(archive, GPX_BUCKET, storage_path, f"gpx/{track['id']}.gpx.gz")
            digest = hashlib.sha256()
            with zip_path.open("rb") as source:
                for block in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(block)
            size = zip_path.stat().st_size
            self._upload_file(zip_path, str(claim["storage_path"]))
            return size, digest.hexdigest()

    def delete_objects(self, objects: list[dict[str, str]]) -> None:
        grouped: dict[str, list[str]] = {}
        for item in objects:
            grouped.setdefault(str(item["bucket"]), []).append(str(item["path"]))
        for bucket, paths in grouped.items():
            self.client.storage_delete(bucket, paths)

    def delete_export(self, path: str) -> None:
        self.client.storage_delete(EXPORT_BUCKET, [path])


class SupabaseAuthAdmin:
    def __init__(self, client: Any) -> None:
        self.client = client

    def delete_user(self, user_id: str) -> None:
        self.client.request(
            "DELETE",
            f"/auth/v1/admin/users/{quote(user_id, safe='')}?should_soft_delete=false",
            expected=(200, 204, 404),
        )


def _mailbox_name(raw: bytes) -> tuple[str, str] | None:
    text = raw.decode("utf-8", errors="replace")
    match = re.match(r"^\(([^)]*)\)\s+\"[^\"]*\"\s+(.+)$", text)
    if not match:
        return None
    return match.group(1), match.group(2).strip().strip('"')


class GmailImapCleaner:
    def __init__(
        self,
        *,
        username: str,
        app_password: str,
        auth_subjects: list[str],
        host: str = "imap.gmail.com",
        port: int = 993,
        factory: Callable[..., Any] = imaplib.IMAP4_SSL,
    ) -> None:
        if not auth_subjects:
            raise ValueError("at least one exact automated Auth subject is required")
        self.username = username
        self.app_password = app_password
        self.auth_subjects = auth_subjects
        self.host = host
        self.port = port
        self.factory = factory

    def _connect(self) -> tuple[Any, str, str]:
        client = self.factory(self.host, self.port)
        client.login(self.username, self.app_password)
        status, rows = client.list()
        if status != "OK":
            raise RuntimeError("IMAP mailbox discovery failed")
        sent = trash = None
        for row in rows or []:
            parsed = _mailbox_name(row)
            if not parsed:
                continue
            flags, name = parsed
            if "\\Sent" in flags:
                sent = name
            if "\\Trash" in flags:
                trash = name
        if not sent or not trash:
            raise RuntimeError("Gmail Sent/Trash special-use mailboxes are missing")
        return client, sent, trash

    @staticmethod
    def _quoted(value: str) -> str:
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'

    @staticmethod
    def _search(client: Any, *criteria: str) -> list[bytes]:
        # imaplib concatenates SEARCH arguments verbatim.  Values containing
        # spaces (notably localized email subjects) must therefore be quoted;
        # otherwise Gmail rejects the whole command with BAD.
        encoded: list[str] = []
        for index, criterion in enumerate(criteria):
            previous = criteria[index - 1].upper() if index >= 1 else ""
            two_back = criteria[index - 2].upper() if index >= 2 else ""
            if previous in {"TO", "BEFORE"} or two_back == "HEADER":
                encoded.append(GmailImapCleaner._quoted(criterion))
                continue
            encoded.append(criterion)
        status, data = client.uid("SEARCH", None, *encoded)
        if status != "OK":
            raise RuntimeError("IMAP search failed")
        return (data[0] or b"").split()

    @staticmethod
    def _matching_uids(client: Any, criteria: tuple[str, ...]) -> list[bytes]:
        uids = GmailImapCleaner._search(client, *criteria)
        expected_subject = None
        expected_recipient = None
        for index, value in enumerate(criteria[:-1]):
            if value == "Subject":
                expected_subject = criteria[index + 1]
            if value == "TO":
                expected_recipient = criteria[index + 1].lower()
        if expected_subject is None and expected_recipient is None:
            return uids
        exact: list[bytes] = []
        for uid in uids:
            status, response = client.uid(
                "FETCH", uid, "(BODY.PEEK[HEADER.FIELDS (SUBJECT TO)])"
            )
            if status != "OK":
                raise RuntimeError("IMAP header verification failed")
            raw = next(
                (item[1] for item in response or [] if isinstance(item, tuple) and len(item) > 1),
                b"",
            )
            message = BytesParser(policy=policy.default).parsebytes(raw)
            subject = str(make_header(decode_header(str(message.get("Subject", "")))))
            recipients = {address.lower() for _, address in getaddresses(message.get_all("To", []))}
            if expected_subject is not None and subject != expected_subject:
                continue
            if expected_recipient is not None and expected_recipient not in recipients:
                continue
            exact.append(uid)
        return exact

    @staticmethod
    def _trash_uids(client: Any, uids: list[bytes]) -> None:
        for uid in uids:
            status, _ = client.uid("STORE", uid, "+X-GM-LABELS", "(\\Trash)")
            if status != "OK":
                raise RuntimeError("IMAP move to Trash failed")

    def _purge_matches(self, client: Any, trash: str, searches: list[tuple[str, ...]]) -> None:
        client.select(self._quoted(trash))
        for criteria in searches:
            for uid in self._matching_uids(client, criteria):
                status, _ = client.uid("STORE", uid, "+FLAGS", "(\\Deleted)")
                if status != "OK":
                    raise RuntimeError("IMAP Trash delete failed")
        status, _ = client.expunge()
        if status != "OK":
            raise RuntimeError("IMAP expunge failed")

    def _delete(self, searches: list[tuple[str, ...]]) -> None:
        client, sent, trash = self._connect()
        try:
            client.select(self._quoted(sent))
            for criteria in searches:
                self._trash_uids(client, self._matching_uids(client, criteria))
            self._purge_matches(client, trash, searches)
        finally:
            try:
                client.logout()
            except Exception:
                pass

    def delete_for_account(self, recipient: str, lifecycle_ids: list[int]) -> None:
        searches = [
            ("HEADER", "Message-ID", message_id)
            for item in lifecycle_ids
            for message_id in lifecycle_message_id_candidates(item)
        ]
        searches.extend(("TO", recipient, "HEADER", "Subject", subject) for subject in self.auth_subjects)
        self._delete(searches)

    def delete_lifecycle_ids(self, lifecycle_ids: list[int]) -> None:
        self._delete([
            ("HEADER", "Message-ID", message_id)
            for item in lifecycle_ids
            for message_id in lifecycle_message_id_candidates(item)
        ])

    def delete_auth_mail_before(self, before: datetime) -> None:
        cutoff = before.astimezone(timezone.utc).strftime("%d-%b-%Y")
        self._delete([("BEFORE", cutoff, "HEADER", "Subject", subject) for subject in self.auth_subjects])


def run_account_rights(
    store: RightsStore,
    storage: RightsStorage,
    auth: AuthAdmin,
    mail: ServiceMailCleaner,
    *,
    now: datetime | None = None,
    max_exports: int = 3,
    max_deletions: int = 3,
    email_cleanup_limit: int = 20,
    max_expired_exports: int = 20,
    max_expired_export_bytes: int = 1073741824,
    max_expired_export_seconds: float = 120.0,
) -> RightsRunResult:
    current = now or datetime.now(timezone.utc)
    preparation = store.prepare(current)
    if not preparation.get("enabled"):
        return RightsRunResult()
    exports_ready = exports_cleaned = deletions_completed = email_rows_cleaned = failures = 0

    if min(max_exports, max_deletions, email_cleanup_limit, max_expired_exports) < 0:
        raise ValueError("account-rights limits cannot be negative")
    if max_expired_export_bytes < 0 or max_expired_export_seconds < 0:
        raise ValueError("expired export byte budget cannot be negative")

    # Deletion is the time-sensitive right: process it before export building
    # and maintenance so a large cleanup backlog cannot delay it.
    for _ in range(max_deletions):
        token = str(uuid.uuid4())
        claim = store.claim_deletion(token)
        if not claim.get("claimed"):
            break
        job_id = str(claim["id"])
        stage = str(claim["stage"])
        try:
            if stage == "email_cleanup":
                ids = [int(item) for item in claim.get("lifecycle_message_ids") or []]
                mail.delete_for_account(str(claim["email"]), ids)
                store.mark_deletion_email_clean(job_id, token, ids)
                stage = "storage_cleanup"
            if stage == "storage_cleanup":
                storage.delete_objects(list(claim.get("storage_objects") or []))
                store.advance_deletion(job_id, token, "storage_cleanup")
                stage = "database_cleanup"
            if stage == "database_cleanup":
                store.advance_deletion(job_id, token, "database_cleanup")
                stage = "auth_cleanup"
            if stage == "auth_cleanup":
                if claim.get("user_id"):
                    auth.delete_user(str(claim["user_id"]))
                store.advance_deletion(job_id, token, "auth_cleanup")
                deletions_completed += 1
        except Exception as exc:
            store.fail_deletion(job_id, token, type(exc).__name__)
            failures += 1

    for _ in range(max_exports):
        token = str(uuid.uuid4())
        claim = store.claim_export(token)
        if not claim.get("claimed"):
            break
        try:
            size, digest = storage.build_export(claim)
            store.complete_export(str(claim["id"]), token, size, digest)
            exports_ready += 1
        except Exception as exc:
            store.fail_export(str(claim["id"]), token, type(exc).__name__)
            failures += 1

    cleaned_bytes = 0
    cleanup_deadline = time.monotonic() + max_expired_export_seconds
    for _ in range(max_expired_exports):
        if time.monotonic() >= cleanup_deadline:
            break
        remaining_bytes = max_expired_export_bytes - cleaned_bytes
        if remaining_bytes < 0:
            break
        token = str(uuid.uuid4())
        claim = store.claim_expired_export(token, remaining_bytes)
        if not claim.get("claimed"):
            break
        try:
            storage.delete_export(str(claim["storage_path"]))
            store.complete_expired_export(str(claim["id"]), token)
            exports_cleaned += 1
            cleaned_bytes += int(claim.get("size_bytes") or 0)
        except Exception:
            failures += 1
            break

    try:
        retention_before = current.replace(year=current.year - 2)
    except ValueError:  # 29 February -> last valid day in the retention year.
        retention_before = current.replace(year=current.year - 2, day=28)
    due_ids = store.due_lifecycle_email_ids(retention_before, email_cleanup_limit)
    if due_ids:
        try:
            mail.delete_lifecycle_ids(due_ids)
            store.mark_lifecycle_email_clean(due_ids)
            store.prune_lifecycle_email(due_ids)
            email_rows_cleaned += len(due_ids)
        except Exception:
            failures += 1
    try:
        mail.delete_auth_mail_before(retention_before)
    except Exception:
        failures += 1

    return RightsRunResult(exports_ready, exports_cleaned, deletions_completed, email_rows_cleaned, failures)
