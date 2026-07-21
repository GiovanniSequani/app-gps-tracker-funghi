from backend.scripts.run_daily_fungus_pipeline import publication_gate


def test_publication_gate_accepts_day_21_run() -> None:
    ready, reason = publication_gate("2026-06-29", {"2026062918", "2026062921"})

    assert ready is True
    assert "2026062921 processed" in reason


def test_publication_gate_waits_after_day_18_run_only() -> None:
    ready, reason = publication_gate("2026-06-29", {"2026062918"})

    assert ready is False
    assert "waiting for 2026062921" in reason


def test_publication_gate_accepts_18_run_after_later_day_run() -> None:
    ready, reason = publication_gate("2026-06-29", {"2026062918", "2026063000"})

    assert ready is True
    assert "fallback" in reason


def test_publication_gate_does_not_treat_later_same_day_run_as_fallback() -> None:
    ready, reason = publication_gate("2026-06-29", {"2026062918", "2026062922"})

    assert ready is False
    assert "waiting for 2026062921" in reason
