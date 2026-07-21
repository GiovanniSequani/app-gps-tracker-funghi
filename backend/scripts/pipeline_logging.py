from __future__ import annotations

import os
import re
import sys
import subprocess
import traceback
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
import xarray as xr


ROME = ZoneInfo("Europe/Rome")
DEFAULT_LOG_DIR = Path("backend") / "logs" / "pipelines"
GDAL_PROGRESS_RE = re.compile(r"^(?:\d{1,3}\.\.\.)+\d{1,3}(?: - done.*)?$")
UPLOAD_PROGRESS_RE = re.compile(r"^round=\d+\s+\d+/\d+\s+total_ok=\d+\s+round_fail=\d+$")
METEO_LEAD_STEP_RE = re.compile(r"^\[STEP \d{3}\]$")


class TeeTextIO:
    def __init__(self, *streams):
        self.streams = streams

    def write(self, text: str) -> int:
        for stream in self.streams:
            stream.write(text)
        return len(text)

    def flush(self) -> None:
        for stream in self.streams:
            stream.flush()

    def isatty(self) -> bool:
        return False


@contextmanager
def pipeline_log(name: str, log_dir: Path | str = DEFAULT_LOG_DIR):
    log_root = Path(log_dir)
    log_root.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(ROME).strftime("%Y%m%d_%H%M%S")
    log_path = log_root / f"{timestamp}_{name}.log"

    old_stdout = sys.stdout
    old_stderr = sys.stderr
    with log_path.open("w", encoding="utf-8", buffering=1) as log_file:
        sys.stdout = TeeTextIO(old_stdout, log_file)
        sys.stderr = TeeTextIO(old_stderr, log_file)
        try:
            print(f"[LOG] Writing terminal output to: {log_path.resolve()}")
            yield log_path
        finally:
            sys.stdout = old_stdout
            sys.stderr = old_stderr


def run_logged_main(name: str, func) -> None:
    with pipeline_log(name):
        try:
            func()
        except SystemExit:
            raise
        except Exception:
            traceback.print_exc()
            raise SystemExit(1)


def compact_logs_enabled() -> bool:
    return os.getenv("PIPELINE_COMPACT_LOGS", "1").strip().lower() not in {"0", "false", "no"}


def format_cmd(cmd: list[str]) -> str:
    parts = [str(part) for part in cmd]
    if len(parts) >= 3 and Path(parts[0]).name.lower().startswith("python") and parts[1] == "-m":
        return "python -m " + " ".join(parts[2:])
    if len(parts) >= 3 and Path(parts[0]).name.lower() in {"cmd", "cmd.exe"} and parts[1].lower() == "/c":
        return "cmd /c " + Path(parts[2]).name
    if not parts:
        return ""
    return " ".join([Path(parts[0]).name, *parts[1:]])


def is_superfluous_log_line(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return False
    if GDAL_PROGRESS_RE.match(stripped):
        return True
    if UPLOAD_PROGRESS_RE.match(stripped):
        return True
    if METEO_LEAD_STEP_RE.match(stripped):
        return True
    if stripped and set(stripped) == {"="}:
        return True
    if stripped.startswith("Input file size is "):
        return True
    if stripped.startswith("[GET] "):
        return True
    if stripped.startswith("-> "):
        return True
    if stripped.startswith("[SKIP] Esiste"):
        return True
    if stripped.startswith("valid_time"):
        return True
    if stripped.startswith("grid shape"):
        return True
    return False


def console_safe_text(text: str) -> str:
    encoding = getattr(sys.stdout, "encoding", None) or "utf-8"
    return text.encode(encoding, errors="replace").decode(encoding, errors="replace")


def run_logged_cmd(cmd: list[str]) -> int:
    compact = compact_logs_enabled()
    print("\n[CMD]", format_cmd(cmd) if compact else " ".join(cmd), flush=True)
    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    assert process.stdout is not None
    for line in process.stdout:
        if compact and is_superfluous_log_line(line):
            continue
        print(console_safe_text(line), end="")
    return process.wait()


def meteo_recent_missing_days(path: Path, today: datetime | None = None) -> tuple[list[str], str | None, str | None]:
    if not path.is_file():
        return [], None, None

    ds = xr.open_dataset(path)
    try:
        ds.load()
        if "time" not in ds.coords or ds.sizes.get("time", 0) == 0:
            return [], None, None

        available = {
            pd.Timestamp(value).strftime("%Y-%m-%d")
            for value in ds["time"].values
        }
    finally:
        ds.close()

    start = min(available)
    end = (today or datetime.now(ROME)).date().isoformat()
    expected = pd.date_range(start=start, end=end, freq="D")
    missing = [
        pd.Timestamp(day).strftime("%Y-%m-%d")
        for day in expected
        if pd.Timestamp(day).strftime("%Y-%m-%d") not in available
    ]
    return missing, start, end


def print_meteo_recent_coverage(path: Path) -> None:
    missing, start, end = meteo_recent_missing_days(path)
    print("\n[METEO RECENT]")
    if start is None or end is None:
        print(f"status=missing_or_invalid path={path}")
        return

    print(f"range={start}..{end}")
    if not missing:
        print("missing=none")
        return

    print(f"missing={len(missing)}")
    for day in missing:
        print(f"  {day}")
