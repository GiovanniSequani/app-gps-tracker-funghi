from __future__ import annotations

import pytest

from backend.src.accounts.auth_email import (
    missing_redirect_urls,
    parse_managed_auth_email_state,
    parse_public_auth_email_state,
    validate_supabase_project_url,
)


def test_public_auth_email_state_requires_confirmation() -> None:
    state = parse_public_auth_email_state(
        {
            "external": {"email": True},
            "disable_signup": False,
            "mailer_autoconfirm": False,
        }
    )
    assert state.email_provider_enabled
    assert state.signup_enabled
    assert state.email_confirmation_required


def test_managed_auth_email_state_checks_gmail_without_secret() -> None:
    state = parse_managed_auth_email_state(
        {
            "site_url": "https://web-funghi-index.pages.dev/",
            "uri_allow_list": "https://web-funghi-index.pages.dev/auth/confirm,http://localhost:5173/auth/confirm",
            "smtp_host": "smtp.gmail.com",
            "smtp_port": 587,
            "smtp_user": "funghitracker@gmail.com",
            "smtp_admin_email": "funghitracker@gmail.com",
            "smtp_pass": "must-not-be-read",
            "mailer_autoconfirm": False,
            "mailer_templates_confirmation_content": (
                '<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email">ok</a>'
            ),
            "mailer_templates_recovery_content": (
                '<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery">ok</a>'
            ),
        }
    )
    assert state.site_url == "https://web-funghi-index.pages.dev"
    assert state.smtp_enabled
    assert state.smtp_host_matches
    assert state.smtp_port_matches
    assert state.smtp_identity_matches
    assert state.email_confirmation_required
    assert state.confirmation_template_valid
    assert state.recovery_template_valid
    assert not state.production_templates_have_localhost
    assert not hasattr(state, "smtp_pass")


def test_managed_auth_email_state_rejects_wrong_or_local_templates() -> None:
    state = parse_managed_auth_email_state(
        {
            "mailer_templates_confirmation_content": (
                '<a href="http://localhost:3000?token_hash={{ .TokenHash }}&type=recovery">bad</a>'
            ),
            "mailer_templates_recovery_content": '<a href="{{ .ConfirmationURL }}">bad</a>',
        }
    )
    assert not state.confirmation_template_valid
    assert not state.recovery_template_valid
    assert state.production_templates_have_localhost


def test_missing_redirect_urls_uses_exact_normalized_values() -> None:
    configured = frozenset({"https://example.test/auth/confirm/"})
    assert missing_redirect_urls(
        configured,
        ["https://example.test/auth/confirm", "funghitracker://auth/complete"],
    ) == ("funghitracker://auth/complete",)


@pytest.mark.parametrize(
    "value",
    [
        "http://project.supabase.co",
        "https://supabase.co",
        "https://project.supabase.co/path",
        "https://example.com",
    ],
)
def test_project_url_rejects_non_project_origins(value: str) -> None:
    with pytest.raises(ValueError):
        validate_supabase_project_url(value)
