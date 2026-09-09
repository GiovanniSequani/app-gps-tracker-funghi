from __future__ import annotations

import argparse
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

from backend.src.accounts.lifecycle import (
    SUBJECTS,
    ClaimedEmail,
    SmtpLifecycleSender,
    _format_deadline,
    _render_email_body,
)


DEFAULT_ENV_FILE = Path(__file__).resolve().parents[2] / ".env"
TEST_RECIPIENT = "funghitracker@gmail.com"
TEST_ACCOUNT_URL = "https://web-funghi-index.pages.dev/mappa/?account=1"
TEST_DELETION_URL = "https://web-funghi-index.pages.dev/elimina-account/"


def required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"missing backend secret/config: {name}")
    return value


def build_test_emails() -> list[ClaimedEmail]:
    deadline = "2027-09-06T14:35:40.526437+00:00"
    events = [
        ("terms_started", {"deadline": deadline}),
        ("terms_six_months", {"deadline": deadline}),
        ("terms_30_days", {"deadline": deadline}),
        ("terms_7_days", {"deadline": deadline}),
        ("terms_expired", {"deadline": deadline}),
        ("inactive_started", {"deadline": deadline}),
        ("inactive_six_months", {"deadline": deadline}),
        ("inactive_30_days", {"deadline": deadline}),
        ("inactive_7_days", {"deadline": deadline}),
        ("inactive_expired", {"deadline": deadline}),
        ("external_deletion_verify", {"verification_token": "TEST-NON-VALID-TOKEN"}),
        ("export_ready", {"expires_at": deadline}),
    ]
    id_base = int(datetime.now(timezone.utc).timestamp()) * 100
    return [
        ClaimedEmail(
            id=id_base + index,
            claim_token="test-only",
            recipient=TEST_RECIPIENT,
            event_type=event_type,
            payload=payload,
            attempt_count=1,
        )
        for index, (event_type, payload) in enumerate(events, start=1)
    ]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Preview or send all lifecycle email templates without Supabase"
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--preview", action="store_true", help="print templates only")
    mode.add_argument("--send", action="store_true", help="send all templates to the fixed test inbox")
    parser.add_argument("--env-file", type=Path, default=DEFAULT_ENV_FILE)
    parser.add_argument("--pause-seconds", type=float, default=2.0)
    parser.add_argument(
        "--event",
        choices=sorted(SUBJECTS),
        help="preview or send only one template event",
    )
    return parser.parse_args()


def preview(emails: list[ClaimedEmail]) -> None:
    for email in emails:
        action_url = TEST_ACCOUNT_URL
        if email.event_type == "external_deletion_verify":
            action_url = f"{TEST_DELETION_URL}#token=[redacted-test-token]"
        deadline = _format_deadline(
            email.payload.get("deadline") or email.payload.get("expires_at")
        )
        print(f"\n[TEST EMAIL] event={email.event_type} subject=[TEST] {SUBJECTS[email.event_type]}")
        print(_render_email_body(email.event_type, action_url, deadline))


def main() -> None:
    args = parse_args()
    if args.pause_seconds < 0:
        raise SystemExit("--pause-seconds cannot be negative")
    if args.env_file.is_file():
        load_dotenv(args.env_file, override=False)

    emails = build_test_emails()
    if args.event:
        emails = [email for email in emails if email.event_type == args.event]
    if args.preview:
        preview(emails)
        print(f"\n[LIFECYCLE EMAIL TEST] previewed={len(emails)} recipient=fixed_test_inbox")
        return

    sender = SmtpLifecycleSender(
        host=os.getenv("ACCOUNT_LIFECYCLE_SMTP_HOST", "smtp.gmail.com"),
        port=int(os.getenv("ACCOUNT_LIFECYCLE_SMTP_PORT", "587")),
        username=required_env("ACCOUNT_LIFECYCLE_SMTP_USERNAME"),
        password=required_env("ACCOUNT_LIFECYCLE_SMTP_APP_PASSWORD"),
        from_address=required_env("ACCOUNT_LIFECYCLE_SMTP_FROM"),
        public_account_url=TEST_ACCOUNT_URL,
        external_deletion_url=TEST_DELETION_URL,
        subject_prefix="[TEST] ",
        from_name=os.getenv("ACCOUNT_LIFECYCLE_SMTP_FROM_NAME", "FunghiTracker"),
        reply_to=os.getenv("ACCOUNT_LIFECYCLE_SMTP_REPLY_TO", "").strip() or None,
    )
    sent = 0
    for email in emails:
        sender.send(email)
        sent += 1
        print(f"[LIFECYCLE EMAIL TEST] sent={sent}/{len(emails)} event={email.event_type}")
        if args.pause_seconds and sent < len(emails):
            time.sleep(args.pause_seconds)
    print(f"[LIFECYCLE EMAIL TEST] complete sent={sent} recipient=fixed_test_inbox")


if __name__ == "__main__":
    main()
