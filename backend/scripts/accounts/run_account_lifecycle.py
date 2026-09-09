from __future__ import annotations

import argparse
import os
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

from backend.src.accounts.lifecycle import (
    SmtpLifecycleSender,
    SupabaseLifecycleStore,
    run_daily_lifecycle,
)
from backend.src.publication.supabase import SupabaseClient


DEFAULT_ENV_FILE = Path(__file__).resolve().parents[2] / ".env"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the idempotent account lifecycle and email outbox")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="preview only; no transitions or email")
    mode.add_argument("--send", action="store_true", help="apply transitions and dispatch queued email")
    parser.add_argument("--env-file", type=Path, default=DEFAULT_ENV_FILE)
    parser.add_argument("--daily-limit", type=int, default=None)
    parser.add_argument("--pause-seconds", type=float, default=None)
    parser.add_argument("--lease-seconds", type=int, default=3600)
    return parser.parse_args()


def required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"missing backend secret/config: {name}")
    return value


def main() -> None:
    args = parse_args()
    if args.env_file.is_file():
        load_dotenv(args.env_file, override=False)
    try:
        client = SupabaseClient.from_env(args.env_file)
        store = SupabaseLifecycleStore(client)
        now = datetime.now(timezone.utc)
        if args.dry_run:
            preview = store.preview(now)
            print(
                "[ACCOUNT LIFECYCLE PREVIEW] "
                f"enabled={preview.get('lifecycle_enabled')} "
                f"terms_restrict={preview.get('terms_to_restrict', 0)} "
                f"terms_expire={preview.get('terms_to_expire', 0)} "
                f"inactive_restrict={preview.get('inactivity_to_restrict', 0)} "
                f"inactive_expire={preview.get('inactivity_to_expire', 0)} "
                f"emails={preview.get('dispatchable_emails', 0)}"
            )
            return

        daily_limit = args.daily_limit or int(os.getenv("ACCOUNT_LIFECYCLE_DAILY_LIMIT", "20"))
        pause_seconds = (
            args.pause_seconds
            if args.pause_seconds is not None
            else float(os.getenv("ACCOUNT_LIFECYCLE_PAUSE_SECONDS", "5"))
        )
        sender = SmtpLifecycleSender(
            host=os.getenv("ACCOUNT_LIFECYCLE_SMTP_HOST", "smtp.gmail.com"),
            port=int(os.getenv("ACCOUNT_LIFECYCLE_SMTP_PORT", "587")),
            username=required_env("ACCOUNT_LIFECYCLE_SMTP_USERNAME"),
            password=required_env("ACCOUNT_LIFECYCLE_SMTP_APP_PASSWORD"),
            from_address=required_env("ACCOUNT_LIFECYCLE_SMTP_FROM"),
            public_account_url=required_env("ACCOUNT_LIFECYCLE_PUBLIC_ACCOUNT_URL"),
            external_deletion_url=os.getenv("ACCOUNT_EXTERNAL_DELETION_URL", "").strip() or None,
            from_name=os.getenv("ACCOUNT_LIFECYCLE_SMTP_FROM_NAME", "FunghiTracker"),
            reply_to=os.getenv("ACCOUNT_LIFECYCLE_SMTP_REPLY_TO", "").strip() or None,
        )
        result = run_daily_lifecycle(
            store,
            sender,
            now=now,
            daily_limit=daily_limit,
            pause_seconds=pause_seconds,
            lease_seconds=args.lease_seconds,
        )
        print(
            "[ACCOUNT LIFECYCLE] "
            f"claimed={result.claimed_run} sent={result.sent} failed={result.failed} "
            f"stop={result.stop_reason}"
        )
        if result.failed:
            raise SystemExit(1)
    except SystemExit:
        raise
    except Exception as exc:
        print(f"[ACCOUNT LIFECYCLE] failed error={type(exc).__name__}")
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
