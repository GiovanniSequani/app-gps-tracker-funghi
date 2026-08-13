from __future__ import annotations

import argparse
import bz2
import shutil
import sys
import requests
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import xarray as xr

# ------------------------------------------------------------------------------
# CONFIG
# ------------------------------------------------------------------------------

from backend.config.meteo import (
    FINAL_METEO_DIR,
    ICON_D2_DEFAULT_STEPS,
    ICON_D2_RUN_HOURS,
    ICON_D2_RAW_DIR,
    ICON_D2_RAW_VARIABLES,
    INTERMEDIATE_METEO_DIR,
    PUBLICATION_DELAY_H,
    RAW_RUN_RETENTION_DAYS,
    ROLLING_HOURLY_WINDOW_HOURS,
)
from backend.scripts.pipeline_logging import (
    print_meteo_recent_coverage,
    run_logged_cmd,
    run_logged_main,
)
UTC = timezone.utc
RUN_CYCLE_HOURS = 3


# ------------------------------------------------------------------------------
# UTILS
# ------------------------------------------------------------------------------

def run_cmd(cmd: list[str]) -> int:
    return run_logged_cmd(cmd)


def format_run(dt: datetime) -> str:
    return dt.strftime("%Y%m%d%H")


def parse_run(run: str) -> datetime:
    return datetime.strptime(run, "%Y%m%d%H").replace(tzinfo=UTC)


# ------------------------------------------------------------------------------
# RUN GENERATION
# ------------------------------------------------------------------------------

def floor_to_previous_cycle(dt: datetime) -> datetime:
    """Trova la run ICON-D2 precedente (considerando ritardo pubblicazione)"""
    dt = dt - timedelta(hours=PUBLICATION_DELAY_H)

    hour = dt.hour
    valid_hour = max(h for h in ICON_D2_RUN_HOURS if h <= hour)

    return dt.replace(
        hour=valid_hour,
        minute=0,
        second=0,
        microsecond=0,
    )


def generate_candidate_runs(now: datetime, buffer_path: Path) -> list[str]:
    end = floor_to_previous_cycle(now)

    if not buffer_path.is_file() or get_latest_run_from_buffer(buffer_path) is None:
        # fallback iniziale: non recuperare due giorni di storico se il buffer non esiste ancora.
        start = end - timedelta(hours=12)
    else:
        # Se una run piu' recente e' entrata nel buffer dopo un errore parziale,
        # partire da latest_run+3 nasconde eventuali buchi precedenti. Riguardiamo
        # quasi tutta la finestra rolling: escludiamo l'estremo piu' vecchio,
        # che puo' essere gia' uscito dal buffer e comparire inutilmente come HOURLY.
        start = end - timedelta(hours=ROLLING_HOURLY_WINDOW_HOURS - RUN_CYCLE_HOURS)

    runs = []
    current = start

    while current <= end:
        runs.append(format_run(current))
        current += timedelta(hours=RUN_CYCLE_HOURS)

    return runs


def is_run_available_remote(run: str) -> bool:
    """
    Check minimale: prova un file sentinella (t2m step 1)
    """
    run_dt = parse_run(run)
    hour = run_dt.strftime("%H")

    url = (
        "https://opendata.dwd.de/weather/nwp/icon-d2/grib/"
        f"{hour}/t_2m/"
        f"icon-d2_germany_regular-lat-lon_single-level_{run}_001_2d_t_2m.grib2.bz2"
    )

    try:
        r = requests.head(url, timeout=5)
        return r.status_code == 200
    except Exception:
        return False


# ------------------------------------------------------------------------------
# LOCAL STATE CHECK
# ------------------------------------------------------------------------------

def is_valid_bz2_file(path: Path) -> bool:
    if not path.is_file() or path.stat().st_size <= 0:
        return False

    try:
        with bz2.open(path, "rb") as f:
            while f.read(1024 * 1024):
                pass
        return True
    except (EOFError, OSError):
        return False


def expected_raw_files(run: str) -> list[Path]:
    run_dir = ICON_D2_RAW_DIR / run
    files: list[Path] = []
    for spec in ICON_D2_RAW_VARIABLES.values():
        dwd_var_dir = spec["dwd_var_dir"]
        level_kind = spec["level_kind"]
        if level_kind == "single-level":
            for step in ICON_D2_DEFAULT_STEPS:
                filename = (
                    f"icon-d2_germany_regular-lat-lon_single-level_"
                    f"{run}_{step:03d}_2d_{dwd_var_dir}.grib2.bz2"
                )
                files.append(run_dir / dwd_var_dir / filename)
        elif level_kind == "soil-level":
            grid_type = spec.get("grid_type", "icosahedral")
            for step in ICON_D2_DEFAULT_STEPS:
                for level in spec["levels"]:
                    filename = (
                        f"icon-d2_germany_{grid_type}_soil-level_"
                        f"{run}_{step:03d}_{level}_{dwd_var_dir}.grib2.bz2"
                    )
                    files.append(run_dir / dwd_var_dir / f"level_{level}" / filename)
        else:
            raise ValueError(f"level_kind non supportato: {level_kind}")
    return files


def raw_any_exists(run: str) -> bool:
    run_dir = ICON_D2_RAW_DIR / run
    return run_dir.is_dir() and any(run_dir.rglob("*.grib2.bz2"))


def raw_complete(run: str) -> bool:
    files = expected_raw_files(run)
    return bool(files) and all(is_valid_bz2_file(path) for path in files)


def cleanup_old_raw_runs(now: datetime, retention_days: int, dry_run: bool) -> list[str]:
    if retention_days <= 0 or not ICON_D2_RAW_DIR.is_dir():
        return []

    cutoff = now - timedelta(days=retention_days)
    removed: list[str] = []

    for run_dir in sorted(ICON_D2_RAW_DIR.iterdir()):
        if not run_dir.is_dir():
            continue
        try:
            run_dt = parse_run(run_dir.name)
        except ValueError:
            continue
        if run_dt >= cutoff:
            continue

        removed.append(run_dir.name)
        if not dry_run:
            shutil.rmtree(run_dir)

    return removed


def hourly_nc_exists(run: str) -> bool:
    path = INTERMEDIATE_METEO_DIR / f"icon_d2_hourly_{run}.nc"
    return path.is_file()


def get_runs_in_buffer(buffer_path: Path) -> set[str]:
    if not buffer_path.is_file():
        return set()

    ds = xr.open_dataset(buffer_path)
    try:
        ds.load()
        run_times = ds["run_time"].values.astype("datetime64[s]")
    finally:
        ds.close()

    runs = {
        datetime.fromtimestamp(int(rt.astype("int64")), tz=UTC).strftime("%Y%m%d%H")
        for rt in run_times
    }

    return runs


def get_latest_run_from_buffer(buffer_path: Path) -> str | None:
    if not buffer_path.is_file():
        return None

    ds = xr.open_dataset(buffer_path)
    try:
        ds.load()
        latest = ds.attrs.get("latest_run_time_utc", None)
    finally:
        ds.close()

    if latest is None:
        return None

    # es: "2026-04-02T06:00:00Z"
    dt = datetime.fromisoformat(latest.replace("Z", "+00:00"))
    return format_run(dt)


# ------------------------------------------------------------------------------
# CLASSIFICATION
# ------------------------------------------------------------------------------

def classify_run(run: str, buffer_runs: set[str]) -> str:
    """
    Stati:
    - DONE → già nel buffer
    - HOURLY → hourly nc presente
    - RAW → raw presente
    - MISSING → niente
    """
    if run in buffer_runs:
        return "DONE"

    if hourly_nc_exists(run):
        return "HOURLY"

    if raw_complete(run):
        return "RAW"

    if raw_any_exists(run):
        return "PARTIAL_RAW"

    return "MISSING"


# ------------------------------------------------------------------------------
# MAIN LOGIC
# ------------------------------------------------------------------------------

def main():
    run_logged_main("automatic_meteo_pipeline", _main)


def _main():
    parser = argparse.ArgumentParser(
        description="Automatic catch-up ICON-D2 pipeline"
    )
    parser.add_argument(
        "--python",
        default=sys.executable,
        help="Python interpreter",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Non esegue pipeline, solo stampa",
    )
    parser.add_argument(
        "--force-all",
        action="store_true",
        help="Processa anche le run già presenti nell'hourly buffer",
    )
    parser.add_argument(
        "--skip-raw-cleanup",
        action="store_true",
        help="Non elimina le cartelle raw ICON-D2 piu' vecchie della retention configurata.",
    )
    args = parser.parse_args()

    py = args.python

    now = datetime.now(UTC)
    buffer_path = INTERMEDIATE_METEO_DIR / "hourly_buffer.nc"
    runs = generate_candidate_runs(now, buffer_path)

    buffer_path = INTERMEDIATE_METEO_DIR / "hourly_buffer.nc"
    buffer_runs = get_runs_in_buffer(buffer_path)

    print("AUTOMATIC METEO PIPELINE")
    print(
        f"now_utc={now.isoformat()} candidates={len(runs)} "
        f"range={runs[0] if runs else '[none]'}..{runs[-1] if runs else '[none]'} "
        f"force_all={args.force_all}"
    )

    if not args.skip_raw_cleanup:
        removed_raw = cleanup_old_raw_runs(
            now=now,
            retention_days=RAW_RUN_RETENTION_DAYS,
            dry_run=args.dry_run,
        )
        removed_suffix = f" ({', '.join(removed_raw)})" if removed_raw else ""
        print(f"[RAW CLEANUP] retention_days={RAW_RUN_RETENTION_DAYS} removed={len(removed_raw)}{removed_suffix}")

    # --- classificazione ---
    run_status = {}
    for run in runs:
        status = classify_run(run, buffer_runs)
        run_status[run] = status

    counts = Counter(run_status.values())
    status_summary = " ".join(f"{status}={counts[status]}" for status in sorted(counts))
    print(f"[RUN STATUS] {status_summary}")
    not_done = [run for run in runs if run_status[run] != "DONE"]
    if not_done:
        print("[NOT DONE] " + ", ".join(f"{run}:{run_status[run]}" for run in not_done))

    # --- selezione ---
    runs_to_process = [
        run for run in runs
        if (run_status[run] != "DONE" or args.force_all)
        and (hourly_nc_exists(run) or raw_complete(run) or is_run_available_remote(run))
    ]

    print("[TO PROCESS] " + (", ".join(runs_to_process) if runs_to_process else "none"))

    if args.dry_run:
        print("[DRY RUN] stop")
        yearly = sorted(FINAL_METEO_DIR.glob("icon_ruc_time_series_*.nc"))
        if yearly:
            print_meteo_recent_coverage(yearly[-1])
        return

    # --- esecuzione ---
    results = {}

    for run in runs_to_process:
        print(f"\n[PROCESS RUN] {run}")

        cmd = [
            py,
            "-m",
            "backend.scripts.meteo.run_meteo_pipeline",
            "--run",
            run,
            "--overwrite-hourly",
            "--overwrite-daily-candidates",
            "--overwrite-daily-target",
        ]

        rc = run_cmd(cmd)

        if rc == 0:
            results[run] = "OK"
        else:
            results[run] = "FAIL"

    # --- report finale ---
    result_counts = Counter(results.values())
    result_summary = " ".join(f"{status}={result_counts[status]}" for status in sorted(result_counts))
    print(f"\n[FINAL REPORT] {result_summary or 'no runs processed'}")
    failed = [run for run, status in results.items() if status != "OK"]
    if failed:
        print("[FAILED] " + ", ".join(failed))

    yearly = sorted(FINAL_METEO_DIR.glob("icon_ruc_time_series_*.nc"))
    if yearly:
        print_meteo_recent_coverage(yearly[-1])

    print("\nDone")


if __name__ == "__main__":
    main()
