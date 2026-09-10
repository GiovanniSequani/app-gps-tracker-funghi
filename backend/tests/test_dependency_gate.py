from datetime import date
import json

import pytest

from backend.scripts.security.dependency_gate import allowed_advisories, extract_advisory_ids


def test_extracts_leaf_advisories_not_transitive_package_names() -> None:
    payload = {"vulnerabilities": {"meta": {"via": ["leaf"]}, "leaf": {"via": [
        {"url": "https://github.com/advisories/GHSA-aaaa-bbbb-cccc"}
    ]}}}
    assert extract_advisory_ids(payload) == {"GHSA-aaaa-bbbb-cccc"}


def test_exception_requires_owner_reason_and_unexpired_date(tmp_path) -> None:
    policy = tmp_path / "policy.json"
    policy.write_text(json.dumps({"exceptions": [{
        "component": "mobile", "advisories": ["GHSA-aaaa-bbbb-cccc"],
        "owner": "mobile", "reason": "controlled", "expires_on": "2026-10-10"
    }]}), encoding="utf-8")
    assert allowed_advisories(policy, "mobile", date(2026, 10, 10)) == {"GHSA-aaaa-bbbb-cccc"}
    with pytest.raises(RuntimeError, match="expired"):
        allowed_advisories(policy, "mobile", date(2026, 10, 11))


def test_exception_does_not_apply_to_another_component(tmp_path) -> None:
    policy = tmp_path / "policy.json"
    policy.write_text(json.dumps({"exceptions": [{
        "component": "mobile", "advisories": ["GHSA-aaaa-bbbb-cccc"],
        "owner": "mobile", "reason": "controlled", "expires_on": "2026-10-10"
    }]}), encoding="utf-8")
    assert allowed_advisories(policy, "web", date(2026, 9, 10)) == set()
