from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

from backend.scripts.accounts.preview_lifecycle_emails import (
    TEST_RECIPIENT,
    build_test_emails,
)
from backend.src.accounts.lifecycle import (
    ClaimedEmail,
    SmtpLifecycleSender,
    _format_deadline,
    _render_email_body,
    lifecycle_message_id,
    lifecycle_message_id_candidates,
    run_daily_lifecycle,
)


MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "supabase"
    / "migrations"
    / "202608310001_account_lifecycle_and_email_outbox.sql"
)
CONTRACT_MIGRATION = (
    Path(__file__).resolve().parents[1]
    / "supabase"
    / "migrations"
    / "202608290001_contributor_account_contract.sql"
)
SIGNUP_TRANSITION_FIX = (
    Path(__file__).resolve().parents[1]
    / "supabase"
    / "migrations"
    / "202609050001_fix_legacy_web_signup_contract.sql"
)
LIFECYCLE_V1_CUTOVER = (
    Path(__file__).resolve().parents[1]
    / "supabase"
    / "migrations"
    / "202609060001_enable_account_lifecycle_v1.sql"
)
PREPARE_RECORD_FIX = (
    Path(__file__).resolve().parents[1]
    / "supabase"
    / "migrations"
    / "202609060002_fix_lifecycle_prepare_record_name.sql"
)


def migration_sql() -> str:
    return MIGRATION.read_text(encoding="utf-8").lower()


def contract_migration_sql() -> str:
    return CONTRACT_MIGRATION.read_text(encoding="utf-8").lower()


def signup_transition_fix_sql() -> str:
    return SIGNUP_TRANSITION_FIX.read_text(encoding="utf-8").lower()


def lifecycle_v1_cutover_sql() -> str:
    return LIFECYCLE_V1_CUTOVER.read_text(encoding="utf-8").lower()


def prepare_record_fix_sql() -> str:
    return PREPARE_RECORD_FIX.read_text(encoding="utf-8").lower()


class FakeStore:
    def __init__(self, emails: list[dict[str, Any]], *, enabled: bool = True) -> None:
        self.emails = emails
        self.enabled = enabled
        self.runs: dict[date, dict[str, Any]] = {}
        self.sent_ids: list[int] = []
        self.failed_ids: list[int] = []
        self.prepare_calls = 0

    def preview(self, now: datetime) -> dict[str, Any]:
        return {"lifecycle_enabled": self.enabled, "dispatchable_emails": len(self.emails)}

    def claim_run(self, run_date: date, owner: str, lease_seconds: int) -> dict[str, Any]:
        for other in self.runs.values():
            if other["status"] == "running" and other["owner"] != owner:
                return {"claimed": False, "reason": "locked"}
        run = self.runs.setdefault(run_date, {"status": "available", "attempts": 0, "owner": None})
        if run["status"] == "completed":
            return {"claimed": False, "reason": "completed"}
        if run["status"] == "running" and run["owner"] != owner:
            return {"claimed": False, "reason": "locked"}
        run.update(status="running", owner=owner)
        return {"claimed": True}

    def prepare(self, now: datetime) -> dict[str, Any]:
        self.prepare_calls += 1
        return {"lifecycle_enabled": self.enabled, "changed": 0}

    def claim_email(self, run_date: date, owner: str, daily_limit: int) -> dict[str, Any]:
        run = self.runs[run_date]
        if run["attempts"] >= daily_limit:
            return {"claimed": False, "reason": "daily_limit"}
        for item in self.emails:
            if item["status"] in {"pending", "retry"} and item.get("available_date", run_date) <= run_date:
                item["status"] = "sending"
                item["claim_token"] = f"token-{item['id']}-{run_date}"
                item["attempt_count"] = item.get("attempt_count", 0) + 1
                run["attempts"] += 1
                return {
                    "claimed": True,
                    "id": item["id"],
                    "claim_token": item["claim_token"],
                    "recipient": "controlled-test@example.invalid",
                    "event_type": item.get("event_type", "terms_started"),
                    "payload": item.get("payload", {}),
                    "attempt_count": item["attempt_count"],
                }
        return {"claimed": False, "reason": "empty"}

    def complete_email(self, run_date: date, owner: str, email: ClaimedEmail) -> None:
        item = next(item for item in self.emails if item["id"] == email.id)
        if item["status"] == "sending" and item["claim_token"] == email.claim_token:
            item["status"] = "sent"
            self.sent_ids.append(email.id)

    def fail_email(self, email: ClaimedEmail, error_code: str) -> None:
        item = next(item for item in self.emails if item["id"] == email.id)
        item["status"] = "retry"
        item["available_date"] = date(2026, 9, 2)
        self.failed_ids.append(email.id)

    def finish_run(self, run_date: date, owner: str, success: bool) -> None:
        self.runs[run_date].update(status="completed" if success else "available", owner=None)


class FakeSender:
    def __init__(self, fail_ids: set[int] | None = None) -> None:
        self.fail_ids = fail_ids or set()
        self.calls: list[int] = []

    def send(self, email: ClaimedEmail) -> None:
        self.calls.append(email.id)
        if email.id in self.fail_ids:
            raise OSError("controlled SMTP failure")


NOW = datetime(2026, 9, 1, 8, tzinfo=timezone.utc)


def test_dispatch_is_idempotent_when_same_day_is_repeated() -> None:
    store = FakeStore([{"id": 1, "status": "pending"}])
    sender = FakeSender()
    first = run_daily_lifecycle(store, sender, now=NOW, pause_seconds=0)
    second = run_daily_lifecycle(store, sender, now=NOW, pause_seconds=0)

    assert first.sent == 1
    assert second.stop_reason == "completed"
    assert sender.calls == [1]


def test_global_lock_rejects_a_concurrent_run() -> None:
    store = FakeStore([])
    store.runs[NOW.date()] = {"status": "running", "attempts": 0, "owner": "other"}

    result = run_daily_lifecycle(store, FakeSender(), now=NOW, pause_seconds=0)

    assert not result.claimed_run
    assert result.stop_reason == "locked"
    assert store.prepare_calls == 0


def test_smtp_error_is_retried_next_day_without_losing_message() -> None:
    store = FakeStore([{"id": 4, "status": "pending"}])
    failed = run_daily_lifecycle(store, FakeSender({4}), now=NOW, pause_seconds=0)
    recovered = run_daily_lifecycle(
        store,
        FakeSender(),
        now=NOW + timedelta(days=1),
        pause_seconds=0,
    )

    assert failed.failed == 1
    assert store.runs[NOW.date()]["status"] == "available"
    assert recovered.sent == 1
    assert store.sent_ids == [4]


def test_daily_quota_leaves_remaining_email_for_next_day() -> None:
    store = FakeStore([{"id": 1, "status": "pending"}, {"id": 2, "status": "pending"}])

    first = run_daily_lifecycle(store, FakeSender(), now=NOW, daily_limit=1, pause_seconds=0)
    second = run_daily_lifecycle(
        store, FakeSender(), now=NOW + timedelta(days=1), daily_limit=1, pause_seconds=0
    )

    assert first.stop_reason == "daily_limit"
    assert second.sent == 1
    assert store.sent_ids == [1, 2]


def test_disabled_lifecycle_neither_claims_email_nor_calls_sender() -> None:
    store = FakeStore([{"id": 1, "status": "pending"}], enabled=False)
    sender = FakeSender()

    result = run_daily_lifecycle(store, sender, now=NOW, pause_seconds=0)

    assert result.stop_reason == "lifecycle_disabled"
    assert sender.calls == []


def test_dispatch_rejects_naive_clock() -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        run_daily_lifecycle(FakeStore([]), FakeSender(), now=datetime(2026, 9, 1))


def test_lifecycle_email_deadline_is_calendar_date_only() -> None:
    assert _format_deadline("2027-09-06T14:35:40.526437+00:00") == "2027-09-06"
    assert _format_deadline("2027-09-06") == "2027-09-06"
    assert _format_deadline("not-a-date") == ""


def test_lifecycle_email_body_explains_event_reason_and_action() -> None:
    terms = _render_email_body("terms_started", "https://example.test/account", "2027-09-06")
    reminder = _render_email_body("terms_7_days", "https://example.test/account", "2027-09-06")
    inactive = _render_email_body("inactive_started", "https://example.test/account", "2029-09-06")
    export = _render_email_body("export_ready", "https://example.test/account", "2026-09-08")

    assert "aggiornamento dei Termini" in terms
    assert "Scadenza per accettare: 2027-09-06" in terms
    assert "Mancano 7 giorni" in reminder
    assert "24 mesi" in inactive
    assert "https://example.test/account" in terms
    assert "non contiene percorsi" not in terms
    assert "2027-09-06T" not in terms
    assert "dati personali" in export
    assert "Disponibile fino al: 2026-09-08" in export
    assert "https://example.test/account" in export
    assert "storage" not in export.lower()


def test_lifecycle_sender_uses_a_recognizable_authenticated_identity() -> None:
    sender = SmtpLifecycleSender(
        host="smtp.gmail.com",
        port=587,
        username="funghitracker@gmail.com",
        password="test-only",
        from_address="funghitracker@gmail.com",
        public_account_url="https://web-funghi-index.pages.dev/mappa/?account=1",
    )
    message = sender.build_message(
        ClaimedEmail(
            id=42,
            claim_token="test-only",
            recipient="recipient@example.test",
            event_type="terms_started",
            payload={"deadline": "2027-09-06T14:35:40+00:00"},
            attempt_count=1,
        )
    )

    assert message["From"] == "FunghiTracker <funghitracker@gmail.com>"
    assert message["Reply-To"] == "funghitracker@gmail.com"
    assert message["Date"] is not None
    assert message["Message-ID"] == "<funghitracker-lifecycle-42@gmail.com>"
    assert message.get_content_charset() == "utf-8"


def test_lifecycle_message_cleanup_remains_compatible_with_old_sent_mail() -> None:
    assert lifecycle_message_id(42) == "<funghitracker-lifecycle-42@gmail.com>"
    assert lifecycle_message_id_candidates(42) == (
        "<funghitracker-lifecycle-42@gmail.com>",
        "<funghitracker-lifecycle-42@notifications.funghitracker>",
    )


def test_dispatcher_claims_and_completes_export_ready_like_other_outbox_events() -> None:
    store = FakeStore([
        {
            "id": 9,
            "status": "pending",
            "event_type": "export_ready",
            "payload": {"export_id": "controlled-job", "expires_at": "2026-09-09T10:00:00+00:00"},
        }
    ])
    sender = FakeSender()

    result = run_daily_lifecycle(store, sender, now=NOW, pause_seconds=0)

    assert result.sent == 1
    assert sender.calls == [9]
    assert store.sent_ids == [9]


def test_lifecycle_email_test_artifacts_cover_every_template_without_supabase() -> None:
    emails = build_test_emails()

    assert len(emails) == 12
    assert {email.event_type for email in emails} == {
        "terms_started",
        "terms_six_months",
        "terms_30_days",
        "terms_7_days",
        "terms_expired",
        "inactive_started",
        "inactive_six_months",
        "inactive_30_days",
        "inactive_7_days",
        "inactive_expired",
        "external_deletion_verify",
        "export_ready",
    }
    assert {email.recipient for email in emails} == {TEST_RECIPIENT}
    assert all(email.claim_token == "test-only" for email in emails)


def test_sql_gates_archive_storage_and_security_definer_mutations() -> None:
    sql = migration_sql()
    assert "create trigger enforce_contributor_track_mutation" in sql
    assert "create trigger enforce_contributor_marker_mutation" in sql
    assert "public.has_current_contributor_access((select auth.uid()))" in sql
    assert "create policy user_gpx_objects_select_own" in sql
    assert "create policy user_gpx_objects_delete_own" in sql
    assert "or not public.has_current_contributor_access(caller_id)" in sql


def test_sql_requires_active_current_profile_for_every_archive_access_path() -> None:
    sql = migration_sql()
    access = sql.split("create or replace function public.has_current_contributor_access", 1)[1]
    access = access.split("create or replace function public.require_current_contributor_access", 1)[0]
    assert "profile.account_state = 'active'" in access
    assert "profile.terms_version = cfg.current_terms_version" in access
    assert "profile.privacy_version = cfg.current_privacy_version" in access
    assert "profile.privacy_acknowledged_at is not null" in access
    assert "when not cfg.lifecycle_enabled then true" in access


def test_sql_keeps_gpx_rows_and_storage_owner_scoped_for_two_authenticated_users() -> None:
    sql = migration_sql()
    tracks_policy = sql.split("create policy user_gpx_tracks_read_own", 1)[1]
    tracks_policy = tracks_policy.split("create policy user_gpx_mushroom_markers_read_own", 1)[0]
    storage_policy = sql.split("create policy user_gpx_objects_select_own", 1)[1]
    storage_policy = storage_policy.split("create policy user_gpx_objects_delete_own", 1)[0]
    assert "(select auth.uid()) = user_id" in tracks_policy
    assert "public.has_current_contributor_access((select auth.uid()))" in tracks_policy
    assert "owner_id = (select auth.uid()::text)" in storage_policy
    assert "(storage.foldername(name))[1] = (select auth.uid()::text)" in storage_policy
    assert "track.user_id = (select auth.uid())" in storage_policy


def test_sql_starts_terms_deadline_only_from_authenticated_notice() -> None:
    sql = migration_sql()
    notice = sql.split("create or replace function public.record_my_legal_notice_seen", 1)[1]
    notice = notice.split("create or replace function public.accept_current_contributor_terms", 1)[0]
    assert "legal_reaccept_deadline_at = first_seen + make_interval(days => cfg.reaccept_days)" in notice
    assert "event_type, terms_version, privacy_version, source" in notice
    assert "on conflict (user_id, terms_version, privacy_version, event_type) do nothing" in notice
    preparer = sql.split("create or replace function public.prepare_account_lifecycle_daily", 1)[1]
    assert "material version change restricts access, but starts no deadline" in preparer
    assert "legal_notice_first_seen_at = null, legal_reaccept_deadline_at = null" in preparer


def test_sql_uses_meaningful_activity_for_24_and_36_month_transitions() -> None:
    sql = migration_sql()
    assert "inactivity_restrict_months integer not null default 24" in sql
    assert "inactivity_delete_months integer not null default 36" in sql
    assert "last_meaningful_activity_at" in sql
    assert "p_activity_kind not in ('interactive_login', 'foreground_session', 'account_action')" in sql
    assert "refresh" not in sql.split("create or replace function public.record_my_meaningful_activity", 1)[1].split("create or replace function public.enqueue_due_account_email", 1)[0]


def test_sql_outbox_has_dedupe_lock_retry_and_backoff() -> None:
    sql = migration_sql()
    assert "dedupe_key text not null unique" in sql
    assert "for update skip locked limit 1" in sql
    assert "claim_timeout" in sql
    assert "dispatcher_backoff_seconds * power(2" in sql
    assert "attempted_count >= least(p_daily_limit, cfg.dispatcher_daily_limit)" in sql
    assert "status = 'running' and lease_until > now()" in sql


def test_trusted_jobs_ignore_legacy_consent_and_fail_closed_before_cutover() -> None:
    sql = migration_sql()
    trusted = sql.split("create or replace function public.trusted_current_contributor_gpx_tracks", 1)[1]
    trusted = trusted.split("create or replace function public.account_lifecycle_setup_audit", 1)[0]
    assert "where cfg.lifecycle_enabled" in trusted
    assert "profile.account_state = 'active'" in trusted
    assert "raw_gpx_research_consent" not in trusted


def test_target_signup_uses_exact_versions_not_legacy_research_consent() -> None:
    sql = migration_sql()
    signup = sql.split("create or replace function public.handle_funghitracker_new_user", 1)[1]
    signup = signup.split("create or replace function public.enforce_current_contributor_mutation", 1)[0]
    target = signup.split("if not lifecycle_cfg.lifecycle_enabled", 1)[1].split("return new;", 1)[1]
    assert "privacy_acknowledged" in target
    assert "signup document version is not current" in target
    assert "raw_gpx_research_consent, raw_gpx_research_consent_at" in target
    assert "false, accepted_at, 'legacy-disabled', accepted_at" in target
    assert "raw_gpx_research_consent', 'false'" not in target


def test_disabled_lifecycle_signup_accepts_web_transition_without_manufacturing_consent() -> None:
    sql = signup_transition_fix_sql()

    assert "archive_contract_complete boolean" in sql
    assert "legacy_research_consent boolean" in sql
    assert "prepared_contract_complete boolean" in sql
    assert "privacy_accepted', 'false'" in sql
    assert "privacy_acknowledged', 'false'" in sql
    assert "acceptance_source in ('mobile', 'web')" in sql
    assert "if archive_contract_complete then" in sql
    assert "if not prepared_contract_complete then" in sql
    assert "raise exception 'signup contract is incomplete'" in sql
    assert "case when legacy_research_consent" in sql
    assert "else 'legacy-disabled'" in sql
    assert "accepted_at, 'legacy_signup'" in sql
    assert "false, accepted_at, 'legacy-disabled', accepted_at" in sql


def test_lifecycle_v1_cutover_is_atomic_idempotent_and_keeps_rights_disabled() -> None:
    sql = lifecycle_v1_cutover_sql()

    assert sql.startswith("-- controlled production cutover")
    assert "begin;" in sql and sql.rstrip().endswith("commit;")
    assert "for update" in sql
    assert "current_terms_version = '1.0'" in sql
    assert "current_privacy_version = '1.0'" in sql
    assert "lifecycle_enabled = true" in sql
    assert "account_rights_enabled = false" in sql
    assert "if cfg.account_rights_enabled then" in sql
    assert "pre-cutover legal notice timing is not empty" in sql
    assert "account_lifecycle_setup_audit()" in sql
    assert "account_rights_setup_audit()" in sql


def test_prepare_daily_uses_distinct_record_and_sql_alias_names() -> None:
    for sql in (migration_sql(), prepare_record_fix_sql()):
        prepare = sql.split(
            "create or replace function public.prepare_account_lifecycle_daily", 1
        )[1]
        prepare = prepare.split("$$;", 1)[0]
        assert "lifecycle_profile record;" in prepare
        assert "\n    profile record;" not in prepare
        assert "for lifecycle_profile in" in prepare
        assert "public.user_profiles restricted_profile" in prepare
        assert "restricted_profile.user_id = outbox.user_id" in prepare
        assert "public.user_profiles profile" not in prepare


def test_prepare_record_fix_is_atomic_and_idempotent() -> None:
    sql = prepare_record_fix_sql()

    assert sql.startswith("-- fix prepare_account_lifecycle_daily")
    assert "begin;" in sql and sql.rstrip().endswith("commit;")
    assert sql.count(
        "create or replace function public.prepare_account_lifecycle_daily"
    ) == 1
    assert "security definer" in sql
    assert "set search_path = ''" in sql
    assert "if not cfg.lifecycle_enabled then" in sql


def test_acceptance_and_real_activity_cancel_stale_reminders() -> None:
    sql = migration_sql()
    assert "last_error_code = 'terms_accepted'" in sql
    assert "last_error_code = 'activity_resumed'" in sql
    assert "when restriction_reason = 'inactive' then 'terms_outdated'" in sql


def test_migration_is_inert_until_coordinated_cutover() -> None:
    sql = migration_sql()
    assert "lifecycle_enabled boolean not null default false" in sql
    assert "insert into public.account_lifecycle_config (singleton_id)" in sql
    assert "if not cfg.lifecycle_enabled then" in sql


def test_preparatory_contract_migration_keeps_legacy_signup_valid_between_migrations() -> None:
    sql = contract_migration_sql()
    assert "alter column account_state set default 'restricted'" in sql
    assert "alter column restriction_reason set default 'terms_outdated'" in sql
    assert "alter column restricted_at set default now()" in sql
    assert "account_state = 'restricted'" in sql
    assert "restricted_at is not null" in sql
