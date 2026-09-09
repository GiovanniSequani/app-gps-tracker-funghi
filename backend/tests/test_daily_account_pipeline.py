from __future__ import annotations

from pathlib import Path

import pytest

from backend.scripts import run_daily_account_pipeline as pipeline


def test_live_account_pipeline_order_and_limits() -> None:
    commands = pipeline.build_commands(dry_run=False, python="python")

    assert [name for name, _ in commands] == [
        "pending GPX cleanup",
        "GPX admission",
        "account lifecycle",
        "account rights",
    ]
    assert commands[0][1][-1] == "--run"
    assert commands[1][1][-1] == "--run"
    assert commands[2][1][-4:] == ["--daily-limit", "100", "--pause-seconds", "5"]
    assert commands[3][1][-12:] == [
        "--max-exports", "20", "--max-deletions", "100", "--email-cleanup-limit", "20",
        "--max-expired-exports", "20", "--max-expired-export-bytes", "1073741824",
        "--max-expired-export-seconds", "120"
    ]


def test_dry_run_previews_every_step() -> None:
    commands = pipeline.build_commands(dry_run=True, python="python")

    assert len(commands) == 4
    assert all(command[-1] == "--dry-run" for _, command in commands)


def test_pipeline_stops_on_first_failed_step(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[str]] = []

    def controlled_run(command: list[str]) -> int:
        calls.append(command)
        return 1 if len(calls) == 2 else 0

    monkeypatch.setattr(pipeline, "run_logged_cmd", controlled_run)

    with pytest.raises(RuntimeError, match="GPX admission"):
        pipeline.run_pipeline(dry_run=False)

    assert len(calls) == 2


def test_batch_launcher_runs_module_from_repository_root() -> None:
    batch = (
        Path(__file__).resolve().parents[1]
        / "scripts"
        / "run_daily_account_pipeline.bat"
    ).read_text(encoding="utf-8").lower()

    assert 'cd /d "%~dp0\\..\\.."' in batch
    assert "python -m backend.scripts.run_daily_account_pipeline %*" in batch
    assert "exit /b %exit_code%" in batch


def test_operational_limit_migration_preserves_switches() -> None:
    sql = (
        Path(__file__).resolve().parents[1]
        / "supabase"
        / "migrations"
        / "202609060005_account_pipeline_operational_limits.sql"
    ).read_text(encoding="utf-8").lower()

    assert "dispatcher_daily_limit = 100" in sql
    assert "dispatcher_pause_seconds = 5" in sql
    assert "set lifecycle_enabled" not in sql
    assert "set account_rights_enabled" not in sql
