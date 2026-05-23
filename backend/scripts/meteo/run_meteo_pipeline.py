from __future__ import annotations

import argparse
import bz2
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from backend.config.meteo import ICON_D2_DEFAULT_STEPS, ICON_D2_RAW_DIR, ICON_D2_RAW_VARIABLES

UTC = timezone.utc


# ------------------------------------------------------------------------------
# Utility
# ------------------------------------------------------------------------------

def run_cmd(cmd: list[str], allow_failure: bool = False) -> int:
    print("\n[CMD]", " ".join(cmd), flush=True)
    result = subprocess.run(cmd)
    if result.returncode != 0 and not allow_failure:
        raise RuntimeError(f"Comando fallito con exit code {result.returncode}")
    return result.returncode


def normalize_run(run: str) -> str:
    if len(run) != 10 or not run.isdigit():
        raise ValueError(f"Run non valida: {run}. Atteso formato YYYYmmddHH")
    return run


def raw_run_dir(run: str) -> Path:
    return ICON_D2_RAW_DIR / run


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
    run_dir = raw_run_dir(run)
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


def raw_run_complete(run: str) -> bool:
    files = expected_raw_files(run)
    return bool(files) and all(is_valid_bz2_file(path) for path in files)


def raw_run_has_any_file(run: str) -> bool:
    run_dir = raw_run_dir(run)
    if not run_dir.is_dir():
        return False
    return any(run_dir.rglob("*.grib2.bz2"))


# ------------------------------------------------------------------------------
# Pipeline
# ------------------------------------------------------------------------------

def step_01_download(py: str, run: str | None, overwrite_raw: bool) -> int:
    cmd = [py, "-m", "backend.scripts.meteo.01_download_icon_d2_raw"]
    if run:
        cmd += ["--run", run]
    if overwrite_raw:
        cmd += ["--overwrite"]

    return run_cmd(cmd, allow_failure=True)


def step_02_extract(py: str, run: str, overwrite_hourly: bool) -> None:
    cmd = [py, "-m", "backend.scripts.meteo.02_extract_hourly_fields", "--run", run]
    if overwrite_hourly:
        cmd += ["--overwrite"]
    run_cmd(cmd)


def step_03_update_buffer(py: str, run: str) -> None:
    cmd = [py, "-m", "backend.scripts.meteo.03_update_hourly_buffer", "--run", run]
    run_cmd(cmd)


def step_04_build_daily(py: str, overwrite_daily_candidates: bool) -> int:
    cmd = [py, "-m", "backend.scripts.meteo.04_build_daily_from_hourly"]
    if overwrite_daily_candidates:
        cmd += ["--overwrite"]
    return run_cmd(cmd, allow_failure=True)


def step_05_regrid_daily(py: str, overwrite_daily_target: bool) -> int:
    cmd = [py, "-m", "backend.scripts.meteo.05_regrid_daily_to_target"]
    if overwrite_daily_target:
        cmd += ["--overwrite"]
    return run_cmd(cmd, allow_failure=True)


def step_06_update_recent(py: str, run: str) -> int:
    cmd = [py, "-m", "backend.scripts.meteo.06_update_recent_meteo_nc", "--run", run]
    return run_cmd(cmd, allow_failure=True)


# ------------------------------------------------------------------------------
# Main
# ------------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Orchestrator unico della pipeline meteo: "
            "01 download raw -> 02 extract hourly -> 03 update hourly buffer -> "
            "04 build daily -> 05 regrid daily -> 06 update recent final."
        )
    )
    parser.add_argument(
        "--run",
        type=str,
        default=None,
        help=(
            "Run target in formato YYYYmmddHH. "
            "Se omesso, 01 proverà a usare l'ultima run disponibile remota."
        ),
    )
    parser.add_argument(
        "--python",
        default=sys.executable,
        help="Interprete Python da usare per lanciare gli script",
    )
    parser.add_argument(
        "--overwrite-raw",
        action="store_true",
        help="Passa --overwrite a 01_download_icon_d2_raw",
    )
    parser.add_argument(
        "--overwrite-hourly",
        action="store_true",
        help="Passa --overwrite a 02_extract_hourly_fields",
    )
    parser.add_argument(
        "--overwrite-daily-candidates",
        action="store_true",
        help="Passa --overwrite a 04_build_daily_from_hourly",
    )
    parser.add_argument(
        "--overwrite-daily-target",
        action="store_true",
        help="Passa --overwrite a 05_regrid_daily_to_target",
    )
    args = parser.parse_args()

    py = args.python
    run = normalize_run(args.run) if args.run else None

    print("=" * 78)
    print("RUN METEO PIPELINE ONCE")
    print(f"Run target         : {run if run else '[auto via 01]'}")
    print(f"Python             : {py}")
    print(f"UTC now            : {datetime.now(UTC).isoformat()}")
    print("=" * 78)

    # 01) Download raw
    print("\n[STEP 01] Download raw")
    rc01 = step_01_download(py=py, run=run, overwrite_raw=args.overwrite_raw)

    if run is not None:
        local_raw_available = raw_run_complete(run)

        if rc01 != 0:
            if local_raw_available:
                print(
                    f"[WARN] 01 fallito per run {run}, ma i raw locali esistono già in "
                    f"{raw_run_dir(run)}. Continuo con 02->06."
                )
            else:
                detail = "raw locali parziali presenti" if raw_run_has_any_file(run) else "nessun raw locale"
                raise RuntimeError(
                    f"01 fallito per run {run} e i raw non sono completi/validi "
                    f"({detail}) in {raw_run_dir(run)}"
                )
        else:
            print(f"[OK] 01 completato per run {run}")

        # 02) Extract hourly
        print("\n[STEP 02] Extract hourly fields")
        step_02_extract(py=py, run=run, overwrite_hourly=args.overwrite_hourly)

        # 03) Update hourly buffer
        print("\n[STEP 03] Update hourly buffer")
        step_03_update_buffer(py=py, run=run)

    else:
        # modalità futura/auto: qui l'ideale sarebbe che 01 esponesse in output la run usata
        # Per ora, senza --run, l'orchestrator è pensato solo per il caso live "01 fa tutto".
        if rc01 != 0:
            raise RuntimeError("01 fallito in modalità auto e non è nota una run locale da riusare")

        raise RuntimeError(
            "Modalità auto senza --run non ancora completata nell'orchestrator: "
            "serve prima rendere esplicita la run effettivamente usata da 01."
        )

    # 04) Build daily from hourly
    print("\n[STEP 04] Build daily from hourly")
    rc04 = step_04_build_daily(py=py, overwrite_daily_candidates=args.overwrite_daily_candidates)

    if rc04 != 0:
        print("[WARN] 04 non ha prodotto daily candidates nuovi o ha trovato nessun giorno completo. Fine pipeline senza errore.")
        print("\nDone OK")
        return

    # 05) Regrid daily to target
    print("\n[STEP 05] Regrid daily to target")
    rc05 = step_05_regrid_daily(py=py, overwrite_daily_target=args.overwrite_daily_target)

    if rc05 != 0:
        print("[WARN] 05 non eseguito con successo. Fine pipeline senza aggiornare il file finale.")
        print("\nDone OK")
        return

    # 06) Update recent final dataset
    print("\n[STEP 06] Update recent daily final NetCDF")
    rc06 = step_06_update_recent(py=py, run=run)

    if rc06 != 0:
        print("[WARN] 06 non eseguito con successo.")
    else:
        print("[OK] 06 completato")

    print("\nDone OK")


if __name__ == "__main__":
    main()
