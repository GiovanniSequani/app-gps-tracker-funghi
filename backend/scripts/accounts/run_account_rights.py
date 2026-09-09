from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

from backend.src.accounts.rights import (
    GmailImapCleaner,
    SupabaseAuthAdmin,
    SupabaseRightsStorage,
    SupabaseRightsStore,
    run_account_rights,
)
from backend.src.publication.supabase import SupabaseClient


DEFAULT_ENV_FILE = Path(__file__).resolve().parents[2] / ".env"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run account exports, deletion jobs and service-email cleanup")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--run", action="store_true")
    parser.add_argument("--env-file", type=Path, default=DEFAULT_ENV_FILE)
    parser.add_argument("--max-exports", type=int, default=3)
    parser.add_argument("--max-deletions", type=int, default=3)
    parser.add_argument("--email-cleanup-limit", type=int, default=20)
    parser.add_argument("--max-expired-exports", type=int, default=20)
    parser.add_argument("--max-expired-export-bytes", type=int, default=1073741824)
    parser.add_argument("--max-expired-export-seconds", type=float, default=120.0)
    return parser.parse_args()


def required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"missing backend secret/config: {name}")
    return value


def auth_subjects() -> list[str]:
    raw = required_env("ACCOUNT_AUTH_SERVICE_EMAIL_SUBJECTS_JSON")
    try:
        values = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError("ACCOUNT_AUTH_SERVICE_EMAIL_SUBJECTS_JSON must be a JSON array") from exc
    if not isinstance(values, list) or not values or not all(isinstance(item, str) and item.strip() for item in values):
        raise RuntimeError("ACCOUNT_AUTH_SERVICE_EMAIL_SUBJECTS_JSON must contain exact non-empty subjects")
    return [item.strip() for item in values]


def main() -> None:
    args = parse_args()
    if args.env_file.is_file():
        load_dotenv(args.env_file, override=False)
    try:
        client = SupabaseClient.from_env(args.env_file)
        now = datetime.now(timezone.utc)
        if args.dry_run:
            preview = client.rpc("preview_account_rights_daily", {"p_now": now.isoformat()})
            print(
                "[ACCOUNT RIGHTS PREVIEW] "
                f"enabled={preview.get('enabled')} exports={preview.get('pending_exports', 0)} "
                f"expired_exports={preview.get('expired_exports', 0)} "
                f"deletions={preview.get('pending_deletions', 0)} "
                f"overdue_deletions={preview.get('overdue_deletions', 0)} "
                f"email_cleanup={preview.get('due_lifecycle_email_cleanup', 0)}"
            )
            return

        gmail_password = (
            os.getenv("ACCOUNT_LIFECYCLE_IMAP_APP_PASSWORD", "").strip()
            or required_env("ACCOUNT_LIFECYCLE_SMTP_APP_PASSWORD")
        )
        mail = GmailImapCleaner(
            username=required_env("ACCOUNT_LIFECYCLE_SMTP_USERNAME"),
            app_password=gmail_password,
            auth_subjects=auth_subjects(),
            host=os.getenv("ACCOUNT_LIFECYCLE_IMAP_HOST", "imap.gmail.com"),
            port=int(os.getenv("ACCOUNT_LIFECYCLE_IMAP_PORT", "993")),
        )
        result = run_account_rights(
            SupabaseRightsStore(client),
            SupabaseRightsStorage(client),
            SupabaseAuthAdmin(client),
            mail,
            now=now,
            max_exports=args.max_exports,
            max_deletions=args.max_deletions,
            email_cleanup_limit=args.email_cleanup_limit,
            max_expired_exports=args.max_expired_exports,
            max_expired_export_bytes=args.max_expired_export_bytes,
            max_expired_export_seconds=args.max_expired_export_seconds,
        )
        print(
            "[ACCOUNT RIGHTS] "
            f"exports_ready={result.exports_ready} exports_cleaned={result.exports_cleaned} "
            f"deletions={result.deletions_completed} email_rows={result.email_rows_cleaned} "
            f"failures={result.failures}"
        )
        if result.failures:
            raise SystemExit(1)
    except SystemExit:
        raise
    except Exception as exc:
        print(f"[ACCOUNT RIGHTS] failed error={type(exc).__name__}")
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
