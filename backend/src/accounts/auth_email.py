from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping
from urllib.parse import urlparse


EXPECTED_SMTP_HOST = "smtp.gmail.com"
EXPECTED_SMTP_PORT = 587
EXPECTED_SMTP_USER = "funghitracker@gmail.com"


@dataclass(frozen=True)
class PublicAuthEmailState:
    email_provider_enabled: bool
    signup_enabled: bool
    email_confirmation_required: bool


@dataclass(frozen=True)
class ManagedAuthEmailState:
    site_url: str
    redirect_urls: frozenset[str]
    smtp_enabled: bool
    smtp_host_matches: bool
    smtp_port_matches: bool
    smtp_identity_matches: bool
    email_confirmation_required: bool
    confirmation_template_valid: bool
    recovery_template_valid: bool
    production_templates_have_localhost: bool


def validate_supabase_project_url(value: str) -> str:
    normalized = value.strip().rstrip("/")
    parsed = urlparse(normalized)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or not parsed.hostname.endswith(".supabase.co")
        or parsed.path
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("SUPABASE_URL must be an HTTPS *.supabase.co project origin")
    return normalized


def parse_public_auth_email_state(payload: Mapping[str, Any]) -> PublicAuthEmailState:
    external = payload.get("external")
    if not isinstance(external, Mapping):
        raise ValueError("Supabase Auth settings have no external provider map")
    return PublicAuthEmailState(
        email_provider_enabled=external.get("email") is True,
        signup_enabled=payload.get("disable_signup") is False,
        email_confirmation_required=payload.get("mailer_autoconfirm") is False,
    )


def _redirect_urls(value: Any) -> frozenset[str]:
    if isinstance(value, str):
        return frozenset(item.strip().rstrip("/") for item in value.split(",") if item.strip())
    if isinstance(value, list):
        return frozenset(str(item).strip().rstrip("/") for item in value if str(item).strip())
    return frozenset()


def parse_managed_auth_email_state(payload: Mapping[str, Any]) -> ManagedAuthEmailState:
    # The Management API deliberately does not return smtp_pass. Never add it
    # to this model or to diagnostic output.
    site_url = str(payload.get("site_url") or "").strip().rstrip("/")
    smtp_host = str(payload.get("smtp_host") or "").strip().lower()
    smtp_user = str(payload.get("smtp_user") or "").strip().lower()
    smtp_admin = str(payload.get("smtp_admin_email") or "").strip().lower()
    try:
        smtp_port = int(payload.get("smtp_port"))
    except (TypeError, ValueError):
        smtp_port = 0
    confirmation_template = str(
        payload.get("mailer_templates_confirmation_content") or ""
    )
    recovery_template = str(payload.get("mailer_templates_recovery_content") or "")
    confirmation_lower = confirmation_template.lower()
    recovery_lower = recovery_template.lower()
    return ManagedAuthEmailState(
        site_url=site_url,
        redirect_urls=_redirect_urls(payload.get("uri_allow_list")),
        smtp_enabled=bool(smtp_host and smtp_user and smtp_port),
        smtp_host_matches=smtp_host == EXPECTED_SMTP_HOST,
        smtp_port_matches=smtp_port == EXPECTED_SMTP_PORT,
        smtp_identity_matches=(
            smtp_user == EXPECTED_SMTP_USER and smtp_admin == EXPECTED_SMTP_USER
        ),
        email_confirmation_required=payload.get("mailer_autoconfirm") is False,
        confirmation_template_valid=(
            "{{ .redirectto }}" in confirmation_lower
            and "{{ .tokenhash }}" in confirmation_lower
            and "type=email" in confirmation_lower
        ),
        recovery_template_valid=(
            "{{ .redirectto }}" in recovery_lower
            and "{{ .tokenhash }}" in recovery_lower
            and "type=recovery" in recovery_lower
        ),
        production_templates_have_localhost=(
            "localhost" in confirmation_lower or "localhost" in recovery_lower
        ),
    )


def missing_redirect_urls(
    configured: frozenset[str], expected: list[str] | tuple[str, ...]
) -> tuple[str, ...]:
    normalized = {item.rstrip("/") for item in configured}
    return tuple(item for item in expected if item.rstrip("/") not in normalized)
