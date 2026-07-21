from __future__ import annotations

import argparse
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

from backend.config.meteo import RAW_METEO_DIR

UTC = timezone.utc
DWD_ICON_D2_RUC_BASE_URL = "https://opendata.dwd.de/weather/nwp/v1/m/icon-d2-ruc/p"
ICON_D2_RUC_RAW_DIR = RAW_METEO_DIR / "icon_d2_ruc"
ICON_D2_RUC_RUN_HOURS = tuple(range(24))
ICON_D2_RUC_DEFAULT_STEPS = tuple(range(1, 8))
ICON_D2_RUC_RAW_VARIABLES = {
    "t2m": "T_2M",
    "rh2m": "RELHUM_2M",
    "gust10m": "VMAX_10M",
    "precip": "TOT_PREC",
    "tground": "T_G",
}
ICON_D2_RUC_COORD_VARIABLES = ("CLAT", "CLON")
RUN_DIR_RE = re.compile(r'href="(\d{4}-\d{2}-\d{2}T\d{2}%3A00)/"')


def parse_run_yyyymmddhh(run_str: str) -> datetime:
    try:
        dt = datetime.strptime(run_str, "%Y%m%d%H")
    except ValueError as exc:
        raise ValueError(f"Formato run non valido: {run_str}. Atteso YYYYmmddHH") from exc
    return dt.replace(tzinfo=UTC)


def format_run(dt: datetime) -> str:
    return dt.strftime("%Y%m%d%H")


def run_url_part(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H%%3A00")


def step_filename(step: int) -> str:
    if step < 0:
        raise ValueError("Il lead time non puo' essere negativo")
    return f"PT{step:03d}H00M.grib2"


def build_url(run_dt: datetime, dwd_var: str, step: int) -> str:
    return f"{DWD_ICON_D2_RUC_BASE_URL}/{dwd_var}/r/{run_url_part(run_dt)}/s/{step_filename(step)}"


def ensure_run_dir(run_dt: datetime) -> Path:
    run_dir = ICON_D2_RUC_RAW_DIR / format_run(run_dt)
    run_dir.mkdir(parents=True, exist_ok=True)
    return run_dir


def local_path(run_dir: Path, dwd_var: str, step: int) -> Path:
    return run_dir / dwd_var / step_filename(step)


def normalize_steps(steps: list[int] | None) -> list[int]:
    values = list(ICON_D2_RUC_DEFAULT_STEPS) if not steps else sorted(set(steps))
    bad = [step for step in values if step < 0]
    if bad:
        raise ValueError(f"Lead time negativi non validi: {bad}")
    return values


def normalize_variable_keys(var_keys: list[str] | None) -> list[str]:
    if not var_keys:
        return list(ICON_D2_RUC_RAW_VARIABLES.keys())
    unknown = [key for key in var_keys if key not in ICON_D2_RUC_RAW_VARIABLES]
    if unknown:
        raise ValueError(f"Variabili non supportate: {unknown}. Supportate: {list(ICON_D2_RUC_RAW_VARIABLES)}")
    return var_keys


def is_valid_grib(path: Path) -> bool:
    return path.is_file() and path.stat().st_size > 0


def url_exists(url: str, timeout: int = 20) -> bool:
    try:
        resp = requests.head(url, timeout=timeout, allow_redirects=True)
        if resp.status_code == 200:
            return True
        if resp.status_code == 405:
            resp = requests.get(url, stream=True, timeout=timeout)
            ok = resp.status_code == 200
            resp.close()
            return ok
        return False
    except requests.RequestException:
        return False


def list_available_runs(probe_var: str = "T_2M", timeout: int = 30) -> list[datetime]:
    url = f"{DWD_ICON_D2_RUC_BASE_URL}/{probe_var}/r/"
    resp = requests.get(url, timeout=timeout)
    resp.raise_for_status()
    runs = []
    for raw in RUN_DIR_RE.findall(resp.text):
        decoded = raw.replace("%3A", ":")
        runs.append(datetime.strptime(decoded, "%Y-%m-%dT%H:%M").replace(tzinfo=UTC))
    return sorted(set(runs))


def find_latest_available_run(now_utc: datetime | None = None, lookback_hours: int = 36) -> datetime:
    now_utc = now_utc or datetime.now(UTC)
    try:
        runs = [run for run in list_available_runs() if run <= now_utc + timedelta(hours=1)]
        if runs:
            return max(runs)
    except requests.RequestException:
        pass

    candidate = now_utc.replace(minute=0, second=0, microsecond=0)
    for _ in range(lookback_hours + 1):
        if url_exists(build_url(candidate, "T_2M", 1)):
            return candidate
        candidate -= timedelta(hours=1)
    raise RuntimeError("Impossibile trovare una run ICON-D2-RUC disponibile")


def download_file(url: str, out_path: Path, overwrite: bool, dry_run: bool, max_retries: int = 4) -> None:
    if out_path.exists() and not overwrite:
        if is_valid_grib(out_path):
            print(f"[SKIP] exists: {out_path}")
            return
        print(f"[WARN] file locale vuoto/corrotto, riscarico: {out_path}")

    print(f"[GET] {url}")
    print(f"      -> {out_path}")
    if dry_run:
        return

    out_path.parent.mkdir(parents=True, exist_ok=True)
    part_path = out_path.with_name(f"{out_path.name}.part")
    part_path.unlink(missing_ok=True)

    for attempt in range(1, max_retries + 1):
        try:
            with requests.get(url, stream=True, timeout=120) as resp:
                resp.raise_for_status()
                expected_size = int(resp.headers.get("Content-Length", "0") or "0")
                written = 0
                with part_path.open("wb") as handle:
                    for chunk in resp.iter_content(chunk_size=1024 * 1024):
                        if chunk:
                            handle.write(chunk)
                            written += len(chunk)

            if expected_size and written != expected_size:
                raise RuntimeError(f"Download incompleto: {written} byte su {expected_size}")
            if not is_valid_grib(part_path):
                raise RuntimeError("Download GRIB vuoto")
            part_path.replace(out_path)
            return
        except requests.HTTPError:
            part_path.unlink(missing_ok=True)
            raise
        except (requests.RequestException, RuntimeError) as exc:
            part_path.unlink(missing_ok=True)
            if attempt >= max_retries:
                raise RuntimeError(f"Download fallito dopo {max_retries} tentativi per {url}: {exc}") from exc
            delay = min(2 ** attempt, 30)
            print(f"[RETRY] {attempt}/{max_retries} {type(exc).__name__}: {exc}. Riprovo tra {delay}s")
            time.sleep(delay)


def main() -> None:
    parser = argparse.ArgumentParser(description="Scarica raw GRIB2 ICON-D2-RUC DWD per una singola run oraria.")
    parser.add_argument("--run", default=None, help="Run target YYYYmmddHH. Se omesso usa l'ultima run disponibile.")
    parser.add_argument("--vars", nargs="+", default=None, help=f"Variabili interne: {list(ICON_D2_RUC_RAW_VARIABLES)}")
    parser.add_argument("--steps", nargs="+", type=int, default=None, help=f"Lead orari. Default: {list(ICON_D2_RUC_DEFAULT_STEPS)}")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    run_dt = parse_run_yyyymmddhh(args.run) if args.run else find_latest_available_run()
    run_dir = ensure_run_dir(run_dt)
    var_keys = normalize_variable_keys(args.vars)
    steps = normalize_steps(args.steps)

    print("ICON-D2-RUC RAW DOWNLOAD")
    print(f"run={format_run(run_dt)} vars={var_keys} steps={steps} output={run_dir}")

    failures: list[str] = []
    items: list[tuple[str, Path, str, int]] = []
    for coord_var in ICON_D2_RUC_COORD_VARIABLES:
        items.append((build_url(run_dt, coord_var, 0), local_path(run_dir, coord_var, 0), coord_var, 0))
    for var_key in var_keys:
        dwd_var = ICON_D2_RUC_RAW_VARIABLES[var_key]
        for step in steps:
            items.append((build_url(run_dt, dwd_var, step), local_path(run_dir, dwd_var, step), var_key, step))
            if var_key == "precip" and step > 0 and step - 1 not in steps:
                items.append((build_url(run_dt, dwd_var, step - 1), local_path(run_dir, dwd_var, step - 1), var_key, step - 1))

    unique_items = []
    seen_paths = set()
    for item in items:
        if item[1] in seen_paths:
            continue
        seen_paths.add(item[1])
        unique_items.append(item)

    for url, out_path, label, step in unique_items:
        try:
            download_file(url, out_path, overwrite=args.overwrite, dry_run=args.dry_run)
        except Exception as exc:
            msg = f"{label} step={step}: {type(exc).__name__}: {exc}"
            print(f"[FAIL] {msg}", file=sys.stderr)
            failures.append(msg)

    if failures:
        print("\nDownload completato con errori:")
        for msg in failures:
            print(f" - {msg}")
        raise SystemExit(1)

    print("\nDone OK")


if __name__ == "__main__":
    main()
