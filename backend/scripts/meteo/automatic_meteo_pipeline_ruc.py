from __future__ import annotations

import argparse
import importlib
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import xarray as xr

from backend.config.meteo import (
    FINAL_METEO_DIR,
    ICON_D2_RAW_DIR,
    ICON_D2_RUN_HOURS,
    INTERMEDIATE_METEO_DIR,
    ROLLING_HOURLY_WINDOW_HOURS,
)
from backend.scripts.pipeline_logging import print_meteo_recent_coverage, run_logged_cmd, run_logged_main

download_ruc = importlib.import_module("backend.scripts.meteo.01_download_icon_d2_ruc_raw")
download_d2 = importlib.import_module("backend.scripts.meteo.01_download_icon_d2_raw")

UTC = timezone.utc
BUFFER_NC = INTERMEDIATE_METEO_DIR / "hourly_buffer.nc"
DEFAULT_SMI9_SUPPORT_NC = INTERMEDIATE_METEO_DIR / "icon_d2_smi9_support.nc"
EXPECTED_HOURLY_VARS = ("t2m", "rh2m", "gust10m", "precip", "tground", "smi9")
RUC_MISSING_VARS = ("smi9",)


def run_cmd(cmd: list[str], allow_failure: bool = False) -> int:
    returncode = run_logged_cmd(cmd)
    if returncode != 0 and not allow_failure:
        raise RuntimeError(f"Command failed with exit code {returncode}")
    return returncode


def parse_run(run: str) -> datetime:
    return datetime.strptime(run, "%Y%m%d%H").replace(tzinfo=UTC)


def format_run(dt: datetime) -> str:
    return dt.strftime("%Y%m%d%H")


def get_runs_in_buffer(buffer_path: Path) -> set[str]:
    if not buffer_path.is_file():
        return set()
    ds = xr.open_dataset(buffer_path)
    try:
        ds.load()
        if "run_time" not in ds.coords:
            return set()
        return {
            datetime.fromtimestamp(int(value.astype("int64")), tz=UTC).strftime("%Y%m%d%H")
            for value in ds["run_time"].values.astype("datetime64[s]")
        }
    finally:
        ds.close()


def get_candidate_runs(now: datetime, lookback_hours: int) -> list[str]:
    available = [run for run in download_ruc.list_available_runs() if run <= now + timedelta(hours=1)]
    if not available:
        latest = download_ruc.find_latest_available_run(now_utc=now)
        available = [latest]
    latest = max(available)
    cutoff = latest - timedelta(hours=lookback_hours - 1)
    return [format_run(run) for run in sorted(available) if run >= cutoff]


def hourly_path(run: str) -> Path:
    return INTERMEDIATE_METEO_DIR / f"icon_d2_ruc_hourly_{run}.nc"


def expected_valid_times(run: str, steps: list[int]) -> np.ndarray:
    run_dt = parse_run(run)
    return np.array(
        [np.datetime64((run_dt + timedelta(hours=step)).replace(tzinfo=None), "s") for step in steps],
        dtype="datetime64[s]",
    )


def hourly_nc_complete(run: str, steps: list[int]) -> bool:
    path = hourly_path(run)
    if not path.is_file():
        return False
    ds = xr.open_dataset(path)
    try:
        ds.load()
        if any(var_name not in ds.data_vars for var_name in EXPECTED_HOURLY_VARS):
            return False
        if "valid_time" not in ds.coords:
            return False
        actual = set(ds["valid_time"].values.astype("datetime64[s]"))
        if not set(expected_valid_times(run, steps)).issubset(actual):
            return False
        for var_name in EXPECTED_HOURLY_VARS:
            subset = ds[var_name].sel(valid_time=expected_valid_times(run, steps))
            if not np.isfinite(subset.values).all():
                return False
        return True
    finally:
        ds.close()


def classify_run(run: str, buffer_runs: set[str], steps: list[int] | None = None) -> str:
    expected_steps = steps or list(download_ruc.ICON_D2_RUC_DEFAULT_STEPS)
    complete_hourly = hourly_nc_complete(run, expected_steps)
    if run in buffer_runs and complete_hourly:
        return "DONE"
    if complete_hourly:
        return "HOURLY"
    if hourly_path(run).is_file():
        return "STALE_HOURLY"
    return "REMOTE"


def floor_to_d2_cycle(run_dt: datetime) -> datetime:
    cycle_hour = max(hour for hour in ICON_D2_RUN_HOURS if hour <= run_dt.hour)
    return run_dt.replace(hour=cycle_hour, minute=0, second=0, microsecond=0)


def required_d2_support_steps(ruc_runs: list[str], ruc_steps: list[int]) -> dict[str, list[int]]:
    out: dict[str, set[int]] = {}
    for ruc_run in ruc_runs:
        ruc_dt = parse_run(ruc_run)
        d2_dt = floor_to_d2_cycle(ruc_dt)
        offset_hours = int((ruc_dt - d2_dt).total_seconds() // 3600)
        d2_run = format_run(d2_dt)
        out.setdefault(d2_run, set()).update(step + offset_hours for step in ruc_steps)
    return {run: sorted(steps) for run, steps in sorted(out.items())}


def d2_smi9_available(run: str, step: int) -> bool:
    run_dt = download_d2.parse_run_yyyymmddhh(run)
    for url, rel_subpath in download_d2.build_download_items(run_dt, "smi9", step):
        local_path = ICON_D2_RAW_DIR / run / rel_subpath
        if download_d2.is_valid_bz2_file(local_path):
            continue
        if not download_d2.url_exists(url, timeout=10):
            return False
    return True


def ruc_raw_file_available(run: str, var_key: str, step: int) -> bool:
    run_dt = download_ruc.parse_run_yyyymmddhh(run)
    dwd_var = download_ruc.ICON_D2_RUC_RAW_VARIABLES[var_key]
    local_path = download_ruc.ICON_D2_RUC_RAW_DIR / run / dwd_var / download_ruc.step_filename(step)
    if download_ruc.is_valid_grib(local_path):
        return True
    return download_ruc.url_exists(download_ruc.build_url(run_dt, dwd_var, step), timeout=10)


def ruc_coords_available(run: str) -> bool:
    run_dt = download_ruc.parse_run_yyyymmddhh(run)
    for coord_var in download_ruc.ICON_D2_RUC_COORD_VARIABLES:
        local_path = download_ruc.ICON_D2_RUC_RAW_DIR / run / coord_var / download_ruc.step_filename(0)
        if download_ruc.is_valid_grib(local_path):
            continue
        if not download_ruc.url_exists(download_ruc.build_url(run_dt, coord_var, 0), timeout=10):
            return False
    return True


def ruc_run_available(run: str, steps: list[int]) -> tuple[bool, str]:
    if not ruc_coords_available(run):
        return False, "missing CLAT/CLON"

    missing: list[str] = []
    for var_key in download_ruc.ICON_D2_RUC_RAW_VARIABLES:
        required_steps = set(steps)
        if var_key == "precip":
            required_steps.update(step - 1 for step in steps if step > 0 and step - 1 not in steps)
        for step in sorted(required_steps):
            if not ruc_raw_file_available(run, var_key, step):
                missing.append(f"{var_key}+{step}")
                if len(missing) >= 8:
                    break
        if len(missing) >= 8:
            break

    if missing:
        suffix = "..." if len(missing) >= 8 else ""
        return False, "missing RUC files: " + ", ".join(missing) + suffix
    return True, "available"


def filter_ruc_available_runs(ruc_runs: list[str], ruc_steps: list[int]) -> tuple[list[str], dict[str, str]]:
    available: list[str] = []
    skipped: dict[str, str] = {}
    for run in ruc_runs:
        ok, reason = ruc_run_available(run, ruc_steps)
        if ok:
            available.append(run)
        else:
            skipped[run] = reason
    return available, skipped


def support_availability_for_runs(
    ruc_runs: list[str],
    ruc_steps: list[int],
) -> tuple[list[str], dict[str, str]]:
    supported: list[str] = []
    skipped: dict[str, str] = {}
    availability_cache: dict[tuple[str, int], bool] = {}

    for ruc_run in ruc_runs:
        missing: list[str] = []
        for d2_run, d2_steps in required_d2_support_steps([ruc_run], ruc_steps).items():
            for step in d2_steps:
                key = (d2_run, step)
                if key not in availability_cache:
                    availability_cache[key] = d2_smi9_available(d2_run, step)
                if not availability_cache[key]:
                    missing.append(f"{d2_run}+{step}")
        if missing:
            skipped[ruc_run] = "missing D2 smi9 support: " + ", ".join(missing[:6])
            if len(missing) > 6:
                skipped[ruc_run] += "..."
        else:
            supported.append(ruc_run)

    return supported, skipped


def run_step_specs(steps_by_run: dict[str, list[int]]) -> list[str]:
    return [f"{run}:{','.join(str(step) for step in steps)}" for run, steps in steps_by_run.items()]


def prepare_d2_smi9_support(
    py: str,
    steps_by_run: dict[str, list[int]],
    support_nc: Path,
    target_grid_nc: Path,
    force_download: bool,
) -> None:
    if not steps_by_run:
        raise RuntimeError("Nessuna run D2 di supporto calcolata")

    for run, steps in steps_by_run.items():
        cmd = [
            py,
            "-m",
            "backend.scripts.meteo.01_download_icon_d2_raw",
            "--run",
            run,
            "--vars",
            *RUC_MISSING_VARS,
            "--steps",
            *[str(step) for step in steps],
        ]
        if force_download:
            cmd.append("--overwrite")
        run_cmd(cmd)

    extract_cmd = [
        py,
        "-m",
        "backend.scripts.meteo.02_extract_icon_d2_smi9_support",
        "--out",
        str(support_nc),
        "--target-grid-nc",
        str(target_grid_nc),
        "--overwrite",
    ]
    for spec in run_step_specs(steps_by_run):
        extract_cmd.extend(["--run-step", spec])
    run_cmd(extract_cmd)


def variable_complete_horizon(buffer_path: Path) -> dict[str, str | None]:
    if not buffer_path.is_file():
        return {name: None for name in EXPECTED_HOURLY_VARS}

    ds = xr.open_dataset(buffer_path)
    try:
        ds.load()
        out: dict[str, str | None] = {}
        for var_name in EXPECTED_HOURLY_VARS:
            if var_name not in ds:
                out[var_name] = None
                continue
            complete = np.isfinite(ds[var_name]).all(dim=("lat", "lon"))
            complete_values = complete.values.astype(bool)
            if not np.any(complete_values):
                out[var_name] = None
                continue
            latest = ds["valid_time"].values.astype("datetime64[s]")[np.where(complete_values)[0][-1]]
            out[var_name] = np.datetime_as_string(latest, unit="s") + "Z"
        return out
    finally:
        ds.close()


def print_variable_coverage(buffer_path: Path) -> None:
    coverage = variable_complete_horizon(buffer_path)
    print("\n[HOURLY VAR COVERAGE]")
    for var_name in EXPECTED_HOURLY_VARS:
        print(f"{var_name}: {coverage.get(var_name) or '[missing]'}")


def main() -> None:
    run_logged_main("automatic_meteo_pipeline_ruc", _main)


def _main() -> None:
    parser = argparse.ArgumentParser(description="Automatic catch-up ICON-D2-RUC pipeline.")
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force-all", action="store_true")
    parser.add_argument("--steps", nargs="+", type=int, default=None)
    parser.add_argument("--lookback-hours", type=int, default=min(24, ROLLING_HOURLY_WINDOW_HOURS))
    parser.add_argument("--skip-d2-support", action="store_true", help="Usa un supporto smi9 gia' esistente senza riscaricarlo.")
    parser.add_argument("--force-d2-support", action="store_true", help="Riscarica anche i file smi9 D2 gia' presenti.")
    parser.add_argument("--allow-missing-smi9", action="store_true", help="Permette smi9 NaN in output RUC. Solo debug.")
    parser.add_argument("--smi9-support-nc", default=str(DEFAULT_SMI9_SUPPORT_NC))
    parser.add_argument("--buffer-nc", default=str(BUFFER_NC))
    parser.add_argument("--daily-candidates", default=str(INTERMEDIATE_METEO_DIR / "daily_candidates.nc"))
    parser.add_argument("--daily-target", default=str(INTERMEDIATE_METEO_DIR / "daily_003deg.nc"))
    parser.add_argument("--time-series-nc", default=None, help="Optional yearly ICON-RUC output override.")
    parser.add_argument("--recent-nc", dest="legacy_recent_nc", default=None, help=argparse.SUPPRESS)
    args = parser.parse_args()

    py = args.python
    now = datetime.now(UTC)
    buffer_path = Path(args.buffer_nc)
    support_nc = Path(args.smi9_support_nc)
    requested_steps = sorted(set(args.steps or download_ruc.ICON_D2_RUC_DEFAULT_STEPS))
    runs = get_candidate_runs(now, lookback_hours=args.lookback_hours)
    buffer_runs = get_runs_in_buffer(buffer_path)
    run_status = {run: classify_run(run, buffer_runs, requested_steps) for run in runs}
    runs_to_process = [
        run for run in runs
        if args.force_all or run_status[run] != "DONE"
    ]
    ruc_skipped: dict[str, str] = {}
    if runs_to_process:
        runs_to_process, ruc_skipped = filter_ruc_available_runs(runs_to_process, requested_steps)
    support_skipped: dict[str, str] = {}
    if runs_to_process and not args.skip_d2_support:
        runs_to_process, support_skipped = support_availability_for_runs(runs_to_process, requested_steps)
    d2_steps_by_run = required_d2_support_steps(runs_to_process, requested_steps) if runs_to_process else {}

    counts = Counter(run_status.values())
    status_summary = " ".join(f"{status}={counts[status]}" for status in sorted(counts))
    print("AUTOMATIC METEO PIPELINE RUC")
    print(
        f"now_utc={now.isoformat()} candidates={len(runs)} "
        f"range={runs[0] if runs else '[none]'}..{runs[-1] if runs else '[none]'} "
        f"steps={requested_steps}"
    )
    print(f"[RUN STATUS] {status_summary or 'none'}")
    print("[TO PROCESS] " + (", ".join(runs_to_process) if runs_to_process else "none"))
    if ruc_skipped:
        skipped_preview = [f"{run} ({reason})" for run, reason in ruc_skipped.items()]
        print("[SKIP RUC NOT READY] " + "; ".join(skipped_preview[:8]) + ("; ..." if len(skipped_preview) > 8 else ""))
    if support_skipped:
        skipped_preview = [f"{run} ({reason})" for run, reason in support_skipped.items()]
        print("[SKIP SUPPORT] " + "; ".join(skipped_preview[:8]) + ("; ..." if len(skipped_preview) > 8 else ""))
    if d2_steps_by_run:
        print("[D2 SMI9 SUPPORT] " + ", ".join(run_step_specs(d2_steps_by_run)))
    else:
        print("[D2 SMI9 SUPPORT] none")

    if args.dry_run:
        print("[DRY RUN] stop")
        print_variable_coverage(buffer_path)
        series_override = args.time_series_nc or args.legacy_recent_nc
        if series_override:
            print_meteo_recent_coverage(Path(series_override))
        return

    if runs_to_process and not args.skip_d2_support:
        prepare_d2_smi9_support(
            py=py,
            steps_by_run=d2_steps_by_run,
            support_nc=support_nc,
            target_grid_nc=buffer_path,
            force_download=args.force_d2_support,
        )

    results: dict[str, str] = {}
    for run in runs_to_process:
        cmd = [
            py,
            "-m",
            "backend.scripts.meteo.run_meteo_pipeline_ruc",
            "--run",
            run,
            "--buffer-nc",
            args.buffer_nc,
            "--target-grid-nc",
            args.buffer_nc,
            "--smi9-support-nc",
            str(support_nc),
            "--stop-after-buffer",
        ]
        cmd.extend(["--steps", *[str(step) for step in requested_steps]])
        if args.force_all or run_status[run] == "STALE_HOURLY":
            cmd.append("--overwrite-hourly")
        if args.allow_missing_smi9:
            cmd.append("--allow-missing-smi9")
        print(f"\n[PROCESS RUN] {run} status={run_status[run]}")
        rc = run_cmd(cmd, allow_failure=True)
        results[run] = "OK" if rc == 0 else "FAIL"

    ok_runs = [run for run, status in results.items() if status == "OK"]
    if ok_runs:
        latest_processed = max(ok_runs)
        print("\n[STEP 04] Build daily from hourly")
        rc04 = run_cmd([
            py,
            "-m",
            "backend.scripts.meteo.04_build_daily_from_hourly",
            "--hourly-buffer",
            args.buffer_nc,
            "--out",
            args.daily_candidates,
            "--overwrite",
        ], allow_failure=True)
        if rc04 == 0:
            print("\n[STEP 05] Regrid daily to target")
            rc05 = run_cmd([
                py,
                "-m",
                "backend.scripts.meteo.05_regrid_daily_to_target",
                "--daily",
                args.daily_candidates,
                "--out",
                args.daily_target,
                "--overwrite",
            ], allow_failure=True)
            if rc05 == 0:
                print("\n[STEP 06] Update yearly ICON-RUC time series")
                update_cmd = [
                    py,
                    "-m",
                    "backend.scripts.meteo.06_update_recent_meteo_nc",
                    "--daily",
                    args.daily_target,
                    "--run",
                    latest_processed,
                ]
                series_override = args.time_series_nc or args.legacy_recent_nc
                if series_override:
                    update_cmd.extend(["--out", series_override])
                run_cmd(update_cmd, allow_failure=True)
            else:
                print("[WARN] 05 non eseguito con successo. Recent non aggiornato.")
        else:
            print("[WARN] 04 non ha trovato nessun giorno completo. Recent non aggiornato.")

    result_counts = Counter(results.values())
    result_summary = " ".join(f"{status}={result_counts[status]}" for status in sorted(result_counts))
    print(f"\n[FINAL REPORT] {result_summary or 'no runs processed'}")
    failed = [run for run, status in results.items() if status != "OK"]
    if failed:
        print("[FAILED] " + ", ".join(failed))
    print_variable_coverage(buffer_path)
    series_override = args.time_series_nc or args.legacy_recent_nc
    if series_override:
        print_meteo_recent_coverage(Path(series_override))
    print("\nDone")


if __name__ == "__main__":
    main()
