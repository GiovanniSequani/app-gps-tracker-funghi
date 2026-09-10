from __future__ import annotations

import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
API_KEY_PATTERN = r"AIza[0-9A-Za-z_-]{30,}"


def git(*args: str) -> str:
    result = subprocess.run(
        ["git", *args], cwd=ROOT, text=True, encoding="utf-8", errors="replace",
        capture_output=True, check=False,
    )
    if result.returncode not in (0, 1):
        raise RuntimeError("Git history inspection failed")
    return result.stdout


def main() -> None:
    history = git(
        "log", "--all", "--format=commit:%H", "--name-only", "-G", API_KEY_PATTERN,
        "--", ".", ":(exclude)graphify-out"
    )
    commits = {line[7:] for line in history.splitlines() if line.startswith("commit:")}
    paths = {
        line for line in history.splitlines()
        if line and not line.startswith("commit:") and not re.fullmatch(r"[0-9a-f]{40}", line)
    }
    current = git("grep", "-I", "-l", "-E", API_KEY_PATTERN, "HEAD", "--", ".")
    current_paths = [line for line in current.splitlines() if line.strip()]
    print(
        "[HISTORICAL GOOGLE KEY] "
        f"history_commits={len(commits)} history_paths={len(paths)} "
        f"current_matches={len(current_paths)} console_status=manual_verification_required"
    )


if __name__ == "__main__":
    main()
