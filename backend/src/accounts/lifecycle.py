from __future__ import annotations

import smtplib
import ssl
import time
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timezone
from email.message import EmailMessage
from email.utils import format_datetime, formataddr, parseaddr
from typing import Any, Protocol
from urllib.parse import quote


@dataclass(frozen=True)
class ClaimedEmail:
    id: int
    claim_token: str
    recipient: str
    event_type: str
    payload: dict[str, Any]
    attempt_count: int


@dataclass(frozen=True)
class DispatchResult:
    claimed_run: bool
    sent: int
    failed: int
    stop_reason: str
    preparation: dict[str, Any] | None = None


class LifecycleStore(Protocol):
    def preview(self, now: datetime) -> dict[str, Any]: ...
    def claim_run(self, run_date: date, owner: str, lease_seconds: int) -> dict[str, Any]: ...
    def prepare(self, now: datetime) -> dict[str, Any]: ...
    def claim_email(self, run_date: date, owner: str, daily_limit: int) -> dict[str, Any]: ...
    def complete_email(self, run_date: date, owner: str, email: ClaimedEmail) -> None: ...
    def fail_email(self, email: ClaimedEmail, error_code: str) -> None: ...
    def finish_run(self, run_date: date, owner: str, success: bool) -> None: ...


class EmailSender(Protocol):
    def send(self, email: ClaimedEmail) -> None: ...


def _rpc_object(value: Any) -> dict[str, Any]:
    if isinstance(value, list) and len(value) == 1 and isinstance(value[0], dict):
        return value[0]
    if isinstance(value, dict):
        return value
    raise RuntimeError("unexpected lifecycle RPC response")


class SupabaseLifecycleStore:
    def __init__(self, client: Any) -> None:
        self.client = client

    def preview(self, now: datetime) -> dict[str, Any]:
        return _rpc_object(self.client.rpc("preview_account_lifecycle_daily", {"p_now": now.isoformat()}))

    def claim_run(self, run_date: date, owner: str, lease_seconds: int) -> dict[str, Any]:
        return _rpc_object(self.client.rpc("claim_account_lifecycle_daily_run", {
            "p_run_date": run_date.isoformat(),
            "p_owner_token": owner,
            "p_lease_seconds": lease_seconds,
        }))

    def prepare(self, now: datetime) -> dict[str, Any]:
        return _rpc_object(self.client.rpc("prepare_account_lifecycle_daily", {"p_now": now.isoformat()}))

    def claim_email(self, run_date: date, owner: str, daily_limit: int) -> dict[str, Any]:
        return _rpc_object(self.client.rpc("claim_next_account_lifecycle_email", {
            "p_run_date": run_date.isoformat(),
            "p_owner_token": owner,
            "p_daily_limit": daily_limit,
            "p_claim_timeout_seconds": 900,
        }))

    def complete_email(self, run_date: date, owner: str, email: ClaimedEmail) -> None:
        self.client.rpc("complete_account_lifecycle_email", {
            "p_run_date": run_date.isoformat(),
            "p_owner_token": owner,
            "p_email_id": email.id,
            "p_claim_token": email.claim_token,
        })

    def fail_email(self, email: ClaimedEmail, error_code: str) -> None:
        self.client.rpc("fail_account_lifecycle_email", {
            "p_email_id": email.id,
            "p_claim_token": email.claim_token,
            "p_error_code": error_code[:80],
        })

    def finish_run(self, run_date: date, owner: str, success: bool) -> None:
        self.client.rpc("finish_account_lifecycle_daily_run", {
            "p_run_date": run_date.isoformat(),
            "p_owner_token": owner,
            "p_success": success,
        })


SUBJECTS = {
    "terms_started": "Aggiornamento documenti richiesto - FunghiTracker",
    "terms_six_months": "Promemoria: aggiorna i documenti - FunghiTracker",
    "terms_30_days": "Mancano 30 giorni per aggiornare i documenti - FunghiTracker",
    "terms_7_days": "Ultimo promemoria: aggiorna i documenti - FunghiTracker",
    "terms_expired": "Account FunghiTracker in attesa di eliminazione",
    "inactive_started": "Account FunghiTracker inattivo",
    "inactive_six_months": "Promemoria account FunghiTracker inattivo",
    "inactive_30_days": "30 giorni prima dell'eliminazione account",
    "inactive_7_days": "7 giorni prima dell'eliminazione account",
    "inactive_expired": "Account FunghiTracker in attesa di eliminazione",
    "external_deletion_verify": "Conferma eliminazione account FunghiTracker",
    "export_ready": "Il tuo export FunghiTracker è pronto",
}


# The dispatcher initially sends through funghitracker@gmail.com. Keep the
# Message-ID domain aligned with that authenticated sender; an invented domain
# is a needless negative deliverability signal. The legacy value remains in
# ``lifecycle_message_id_candidates`` so retention can still remove mail sent
# before this correction.
LIFECYCLE_MESSAGE_ID_DOMAIN = "gmail.com"
LEGACY_LIFECYCLE_MESSAGE_ID_DOMAIN = "notifications.funghitracker"


def lifecycle_message_id(email_id: int, domain: str = LIFECYCLE_MESSAGE_ID_DOMAIN) -> str:
    return f"<funghitracker-lifecycle-{email_id}@{domain}>"


def lifecycle_message_id_candidates(email_id: int) -> tuple[str, ...]:
    """Return current and historical identifiers for exact IMAP cleanup."""
    return (
        lifecycle_message_id(email_id),
        lifecycle_message_id(email_id, LEGACY_LIFECYCLE_MESSAGE_ID_DOMAIN),
    )


def _mailbox(address: str) -> str:
    """Extract a valid mailbox without accepting a display-name injection."""
    _, mailbox = parseaddr(address)
    if not mailbox or "@" not in mailbox:
        raise ValueError("lifecycle sender address is invalid")
    return mailbox


def _format_deadline(value: Any) -> str:
    """Return a stable user-facing calendar date without exposing a timestamp."""
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        try:
            return date.fromisoformat(raw).isoformat()
        except ValueError:
            return ""


def _render_email_body(event_type: str, action_url: str, deadline: str) -> str:
    """Render instructions from the event code instead of generic prose."""
    link = f"Apri FunghiTracker: {action_url}"
    if event_type == "terms_started":
        return (
            "\u00c8 disponibile un aggiornamento dei Termini di utilizzo e "
            "dell'Informativa privacy di FunghiTracker.\n\n"
            "Accedi, leggi i documenti e scegli se accettarli. Fino alla tua "
            "scelta l'account resta limitato e l'archivio cloud non e' "
            "disponibile.\n\n"
            f"Scadenza per accettare: {deadline}.\n"
            "Se non accetti entro questa data, l'account e i dati potranno "
            "essere eliminati secondo i documenti pubblicati.\n\n"
            f"{link}"
        )
    if event_type in {"terms_six_months", "terms_30_days", "terms_7_days"}:
        urgency = {
            "terms_six_months": "Sono trascorsi sei mesi dalla prima comunicazione.",
            "terms_30_days": "Mancano 30 giorni alla scadenza.",
            "terms_7_days": "Mancano 7 giorni alla scadenza.",
        }[event_type]
        return (
            "Devi ancora accettare i Termini di utilizzo e l'Informativa privacy "
            "aggiornati di FunghiTracker.\n\n"
            f"{urgency} L'account resta limitato finche' non completi la scelta.\n\n"
            f"Scadenza: {deadline}.\n"
            f"{link}"
        )
    if event_type == "terms_expired":
        return (
            "Il termine per accettare i Termini di utilizzo e l'Informativa "
            "privacy aggiornati e' scaduto. L'account e' in attesa di "
            "eliminazione secondo i documenti pubblicati.\n\n"
            f"Scadenza: {deadline}.\n"
            f"{link}"
        )
    if event_type in {"inactive_started", "inactive_six_months", "inactive_30_days", "inactive_7_days"}:
        urgency = {
            "inactive_started": "Il tuo account non registra attivita' significativa da 24 mesi.",
            "inactive_six_months": "Il tuo account e' inattivo da oltre 30 mesi.",
            "inactive_30_days": "Mancano 30 giorni alla scadenza per inattivita'.",
            "inactive_7_days": "Mancano 7 giorni alla scadenza per inattivita'.",
        }[event_type]
        return (
            f"{urgency}\n\n"
            "L'account e' limitato e l'archivio cloud non e' disponibile. "
            "Accedi a FunghiTracker e completa un'azione autenticata per "
            "riprendere l'attivita'.\n\n"
            f"Scadenza prevista: {deadline}.\n"
            f"{link}"
        )
    if event_type == "inactive_expired":
        return (
            "Il periodo di inattivita' previsto e' terminato e l'account e' "
            "in attesa di eliminazione secondo i documenti pubblicati.\n\n"
            f"Scadenza: {deadline}.\n"
            f"{link}"
        )
    if event_type == "external_deletion_verify":
        return (
            "E' stata richiesta l'eliminazione del tuo account FunghiTracker.\n\n"
            "Se hai fatto tu la richiesta, apri il link per confermarla. Se non "
            "sei stato tu, ignora questa email.\n\n"
            f"{link}"
        )
    if event_type == "export_ready":
        return (
            "Il tuo archivio dei dati personali FunghiTracker è pronto.\n\n"
            "Accedi alla tua area account per scaricarlo. Il file è privato "
            "e può essere scaricato solo dopo l'accesso al tuo account.\n\n"
            f"Disponibile fino al: {deadline}.\n"
            f"{link}"
        )
    raise ValueError("unknown lifecycle email event")


class SmtpLifecycleSender:
    def __init__(
        self,
        *,
        host: str,
        port: int,
        username: str,
        password: str,
        from_address: str,
        public_account_url: str,
        external_deletion_url: str | None = None,
        timeout_seconds: int = 30,
        subject_prefix: str = "",
        from_name: str = "FunghiTracker",
        reply_to: str | None = None,
    ) -> None:
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.from_address = from_address
        self.public_account_url = public_account_url
        self.external_deletion_url = external_deletion_url
        self.timeout_seconds = timeout_seconds
        self.subject_prefix = subject_prefix
        self.from_name = from_name.strip() or "FunghiTracker"
        self.reply_to = reply_to

    def build_message(self, email: ClaimedEmail) -> EmailMessage:
        """Build a standards-complete transactional email with no tracking."""
        subject = SUBJECTS.get(email.event_type)
        if subject is None:
            raise ValueError("unknown lifecycle email event")
        deadline = _format_deadline(
            email.payload.get("deadline") or email.payload.get("expires_at")
        )
        action_url = self.public_account_url
        if email.event_type == "external_deletion_verify":
            token = str(email.payload.get("verification_token") or "")
            if not token or not self.external_deletion_url:
                raise ValueError("external deletion verification URL is not configured")
            # URL fragments are not sent to Cloudflare/origin access logs.
            action_url = f"{self.external_deletion_url.rstrip('#')}#token={quote(token, safe='')}"

        from_mailbox = _mailbox(self.from_address)
        reply_mailbox = _mailbox(self.reply_to or from_mailbox)
        message = EmailMessage()
        message["From"] = formataddr((self.from_name, from_mailbox))
        message["Reply-To"] = reply_mailbox
        message["To"] = email.recipient
        message["Subject"] = f"{self.subject_prefix}{subject}"
        message["Date"] = format_datetime(datetime.now(timezone.utc))
        message["Message-ID"] = lifecycle_message_id(email.id)
        message.set_content(_render_email_body(email.event_type, action_url, deadline), charset="utf-8")
        return message

    def send(self, email: ClaimedEmail) -> None:
        message = self.build_message(email)
        context = ssl.create_default_context()
        with smtplib.SMTP(self.host, self.port, timeout=self.timeout_seconds) as smtp:
            smtp.ehlo()
            smtp.starttls(context=context)
            smtp.ehlo()
            smtp.login(self.username, self.password)
            smtp.send_message(message)


def claimed_email_from_rpc(data: dict[str, Any]) -> ClaimedEmail:
    return ClaimedEmail(
        id=int(data["id"]),
        claim_token=str(data["claim_token"]),
        recipient=str(data["recipient"]),
        event_type=str(data["event_type"]),
        payload=dict(data.get("payload") or {}),
        attempt_count=int(data["attempt_count"]),
    )


def run_daily_lifecycle(
    store: LifecycleStore,
    sender: EmailSender,
    *,
    now: datetime | None = None,
    daily_limit: int = 20,
    pause_seconds: float = 5.0,
    lease_seconds: int = 3600,
    sleep: Any = time.sleep,
) -> DispatchResult:
    if daily_limit < 1:
        raise ValueError("daily_limit must be positive")
    if pause_seconds < 0:
        raise ValueError("pause_seconds cannot be negative")
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    run_date = current.astimezone(timezone.utc).date()
    owner = str(uuid.uuid4())
    claim = store.claim_run(run_date, owner, lease_seconds)
    if not claim.get("claimed"):
        return DispatchResult(False, 0, 0, str(claim.get("reason", "not_claimed")))

    sent = 0
    failed = 0
    stop_reason = "empty"
    preparation: dict[str, Any] | None = None
    run_success = False
    try:
        preparation = store.prepare(current)
        if not preparation.get("lifecycle_enabled"):
            stop_reason = "lifecycle_disabled"
            run_success = True
            return DispatchResult(True, sent, failed, stop_reason, preparation)
        while True:
            claimed = store.claim_email(run_date, owner, daily_limit)
            if not claimed.get("claimed"):
                reason = str(claimed.get("reason", "empty"))
                if reason == "recipient_missing":
                    continue
                stop_reason = reason
                break
            email = claimed_email_from_rpc(claimed)
            try:
                sender.send(email)
            except (OSError, smtplib.SMTPException, ValueError) as exc:
                failed += 1
                store.fail_email(email, type(exc).__name__)
            else:
                store.complete_email(run_date, owner, email)
                sent += 1
            if pause_seconds:
                sleep(pause_seconds)
        run_success = failed == 0
        return DispatchResult(True, sent, failed, stop_reason, preparation)
    finally:
        store.finish_run(run_date, owner, run_success)
