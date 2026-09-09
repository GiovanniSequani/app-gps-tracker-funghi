from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from backend.scripts.pipeline_logging import run_logged_cmd, run_logged_main


ROME = ZoneInfo("Europe/Rome")
LOG_DIR = Path(__file__).resolve().parents[1] / "logs" / "account-lifecycle"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run the local daily account maintenance pipeline"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="preview every step without transitions, email or deletion",
    )
    return parser.parse_args(argv)


def build_commands(*, dry_run: bool, python: str = sys.executable) -> list[tuple[str, list[str]]]:
    if dry_run:
        return [
            (
                "pending GPX preview",
                [python, "-m", "backend.scripts.accounts.cleanup_pending_gpx_uploads", "--dry-run"],
            ),
            (
                "GPX admission preview",
                [python, "-m", "backend.scripts.accounts.validate_pending_gpx", "--dry-run"],
            ),
            (
                "account lifecycle preview",
                [python, "-m", "backend.scripts.accounts.run_account_lifecycle", "--dry-run"],
            ),
            (
                "account rights preview",
                [python, "-m", "backend.scripts.accounts.run_account_rights", "--dry-run"],
            ),
        ]
    return [
        (
            "pending GPX cleanup",
            [python, "-m", "backend.scripts.accounts.cleanup_pending_gpx_uploads", "--run"],
        ),
        (
            "GPX admission",
            [python, "-m", "backend.scripts.accounts.validate_pending_gpx", "--run"],
        ),
        (
            "account lifecycle",
            [
                python,
                "-m",
                "backend.scripts.accounts.run_account_lifecycle",
                "--send",
                "--daily-limit",
                "100",
                "--pause-seconds",
                "5",
            ],
        ),
        (
            "account rights",
            [
                python,
                "-m",
                "backend.scripts.accounts.run_account_rights",
                "--run",
                "--max-exports",
                "20",
                "--max-deletions",
                "100",
                "--email-cleanup-limit",
                "20",
                "--max-expired-exports",
                "20",
                "--max-expired-export-bytes",
                "1073741824",
                "--max-expired-export-seconds",
                "120",
            ],
        ),
    ]


def run_pipeline(*, dry_run: bool) -> None:
    mode = "dry-run" if dry_run else "live"
    started = datetime.now(ROME)
    print(f"[ACCOUNT PIPELINE] started={started.isoformat(timespec='seconds')} mode={mode}")
    for step, command in build_commands(dry_run=dry_run):
        print(f"[ACCOUNT PIPELINE] step={step}")
        exit_code = run_logged_cmd(command)
        if exit_code != 0:
            raise RuntimeError(f"account pipeline step failed: {step} exit_code={exit_code}")
    finished = datetime.now(ROME)
    print(f"[ACCOUNT PIPELINE] completed={finished.isoformat(timespec='seconds')} mode={mode}")


def main() -> None:
    args = parse_args()
    run_logged_main(
        "daily_account_pipeline",
        lambda: run_pipeline(dry_run=args.dry_run),
        log_dir=LOG_DIR,
    )


if __name__ == "__main__":
    main()
