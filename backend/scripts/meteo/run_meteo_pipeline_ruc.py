from __future__ import annotations

import argparse
import importlib
import sys
from datetime import datetime, timezone
from pathlib import Path

from backend.config.meteo import FINAL_METEO_DIR, INTERMEDIATE_METEO_DIR
from backend.scripts.pipeline_logging import run_logged_cmd

download_ruc = importlib.import_module("backend.scripts.meteo.01_download_icon_d2_ruc_raw")

UTC = timezone.utc
DEFAULT_SMI9_SUPPORT_NC = INTERMEDIATE_METEO_DIR / "icon_d2_smi9_support.nc"


def run_cmd(cmd: list[str], allow_failure: bool = False) -> int:
    returncode = run_logged_cmd(cmd)
    if returncode != 0 and not allow_failure:
        raise RuntimeError(f"Comando fallito con exit code {returncode}")
    return returncode


def normalize_run(run: str | None) -> str:
    if run is None:
        return download_ruc.format_run(download_ruc.find_latest_available_run())
    download_ruc.parse_run_yyyymmddhh(run)
    return run


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Pipeline parallela ICON-D2-RUC: 01_ruc -> 02_ruc -> 03/04/05/06 esistenti."
    )
    parser.add_argument("--run", default=None, help="Run target YYYYmmddHH. Default: ultima RUC disponibile.")
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--steps", nargs="+", type=int, default=None)
    parser.add_argument("--overwrite-raw", action="store_true")
    parser.add_argument("--overwrite-hourly", action="store_true")
    parser.add_argument("--overwrite-daily-candidates", action="store_true")
    parser.add_argument("--overwrite-daily-target", action="store_true")
    parser.add_argument("--buffer-nc", default=str(INTERMEDIATE_METEO_DIR / "hourly_buffer.nc"))
    parser.add_argument("--daily-candidates", default=str(INTERMEDIATE_METEO_DIR / "daily_candidates.nc"))
    parser.add_argument("--daily-target", default=str(INTERMEDIATE_METEO_DIR / "daily_003deg.nc"))
    parser.add_argument("--recent-nc", default=str(FINAL_METEO_DIR / "meteo_recent_003deg.nc"))
    parser.add_argument("--smi9-support-nc", default=str(DEFAULT_SMI9_SUPPORT_NC))
    parser.add_argument(
        "--target-grid-nc",
        default=str(INTERMEDIATE_METEO_DIR / "hourly_buffer.nc"),
        help="NetCDF da cui copiare lat/lon target per estrazione RUC.",
    )
    parser.add_argument("--allow-missing-smi9", action="store_true", help="Permette smi9 NaN in output RUC. Solo debug.")
    parser.add_argument(
        "--allow-buffer-smi9-fallback",
        action="store_true",
        help="Permette di riempire smi9 dal buffer esistente se il supporto D2 non basta.",
    )
    parser.add_argument("--stop-after-buffer", action="store_true")
    args = parser.parse_args()

    py = args.python
    run = normalize_run(args.run)
    hourly_nc = INTERMEDIATE_METEO_DIR / f"icon_d2_ruc_hourly_{run}.nc"

    print("RUN METEO PIPELINE RUC")
    print(f"run={run} steps={args.steps or list(download_ruc.ICON_D2_RUC_DEFAULT_STEPS)} utc_now={datetime.now(UTC).isoformat()}")
    print(f"buffer={args.buffer_nc}")
    print(f"smi9_support={args.smi9_support_nc}")

    download_cmd = [py, "-m", "backend.scripts.meteo.01_download_icon_d2_ruc_raw", "--run", run]
    if args.steps:
        download_cmd.extend(["--steps", *[str(step) for step in args.steps]])
    if args.overwrite_raw:
        download_cmd.append("--overwrite")
    print("\n[STEP 01 RUC] Download raw")
    run_cmd(download_cmd)

    extract_cmd = [
        py,
        "-m",
        "backend.scripts.meteo.02_extract_icon_d2_ruc_hourly_fields",
        "--run",
        run,
        "--out",
        str(hourly_nc),
        "--target-grid-nc",
        args.target_grid_nc,
    ]
    if args.steps:
        extract_cmd.extend(["--steps", *[str(step) for step in args.steps]])
    if args.overwrite_hourly:
        extract_cmd.append("--overwrite")
    extract_cmd.extend(["--smi9-support-nc", args.smi9_support_nc])
    if args.allow_missing_smi9:
        extract_cmd.append("--allow-missing-smi9")
    if args.allow_buffer_smi9_fallback:
        extract_cmd.append("--allow-buffer-smi9-fallback")

    print("\n[STEP 02 RUC] Extract hourly target-grid fields")
    if hourly_nc.exists() and not args.overwrite_hourly:
        print(f"[SKIP] hourly gia' presente: {hourly_nc}")
    else:
        run_cmd(extract_cmd)

    print("\n[STEP 03] Update hourly buffer")
    run_cmd([
        py,
        "-m",
        "backend.scripts.meteo.03_update_hourly_buffer",
        "--hourly-nc",
        str(hourly_nc),
        "--buffer-nc",
        args.buffer_nc,
    ])

    if args.stop_after_buffer:
        print("\nDone OK")
        return

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
    if rc04 != 0:
        print("[WARN] 04 non ha trovato nessun giorno completo nel buffer RUC. Fine pipeline senza errore.")
        print("\nDone OK")
        return

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
    if rc05 != 0:
        print("[WARN] 05 non eseguito con successo. Fine pipeline senza aggiornare il recent RUC.")
        print("\nDone OK")
        return

    print("\n[STEP 06] Update recent daily final NetCDF")
    rc06 = run_cmd([
        py,
        "-m",
        "backend.scripts.meteo.06_update_recent_meteo_nc",
        "--daily",
        args.daily_target,
        "--out",
        args.recent_nc,
        "--run",
        run,
    ], allow_failure=True)
    if rc06 != 0:
        print("[WARN] 06 non eseguito con successo.")
    else:
        print("[OK] 06 completato")

    print("\nDone OK")


if __name__ == "__main__":
    main()
