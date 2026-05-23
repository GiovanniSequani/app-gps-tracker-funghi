from __future__ import annotations

import argparse
import bz2
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

from backend.config.meteo import (
    DWD_ICON_D2_BASE_URL,
    ICON_D2_RAW_DIR,
    ICON_D2_RAW_VARIABLES,
    ICON_D2_RUN_HOURS,
    ICON_D2_DEFAULT_STEPS,
)

UTC = timezone.utc


def parse_run_yyyymmddhh(run_str: str) -> datetime:
    try:
        dt = datetime.strptime(run_str, "%Y%m%d%H")
    except ValueError as exc:
        raise ValueError(
            f"Formato run non valido: {run_str}. Atteso YYYYmmddHH"
        ) from exc

    if dt.hour not in ICON_D2_RUN_HOURS:
        raise ValueError(
            f"Ora run non valida per ICON-D2: {dt.hour:02d}. "
            f"Attese: {ICON_D2_RUN_HOURS}"
        )
    return dt.replace(tzinfo=UTC)


def format_run(dt: datetime) -> str:
    return dt.strftime("%Y%m%d%H")


def floor_to_latest_cycle(now_utc: datetime) -> datetime:
    hour = now_utc.hour
    valid_hour = max(h for h in ICON_D2_RUN_HOURS if h <= hour)
    return now_utc.replace(
        hour=valid_hour,
        minute=0,
        second=0,
        microsecond=0,
    )


def step_to_str(step: int) -> str:
    if step < 0:
        raise ValueError("Il lead time non può essere negativo")
    return f"{step:03d}"


def build_single_level_filename(run_dt: datetime, var_key: str, step: int) -> str:
    spec = ICON_D2_RAW_VARIABLES[var_key]
    dwd_var_dir = spec["dwd_var_dir"]
    return (
        f"icon-d2_germany_regular-lat-lon_single-level_"
        f"{run_dt.strftime('%Y%m%d%H')}_{step_to_str(step)}_2d_{dwd_var_dir}.grib2.bz2"
    )


def build_soil_level_filename(
    run_dt: datetime,
    var_key: str,
    step: int,
    level: int,
) -> str:
    spec = ICON_D2_RAW_VARIABLES[var_key]
    dwd_var_dir = spec["dwd_var_dir"]
    grid_type = spec.get("grid_type", "icosahedral")
    if grid_type not in {"icosahedral", "regular-lat-lon"}:
        raise ValueError(f"grid_type soil non supportato per {var_key}: {grid_type}")
    return (
        f"icon-d2_germany_{grid_type}_soil-level_"
        f"{run_dt.strftime('%Y%m%d%H')}_{step_to_str(step)}_{level}_{dwd_var_dir}.grib2.bz2"
    )


def build_download_items(run_dt: datetime, var_key: str, step: int) -> list[tuple[str, str]]:
    """
    Ritorna lista di tuple:
      (remote_url, relative_output_subpath)
    """
    spec = ICON_D2_RAW_VARIABLES[var_key]
    run_hour = run_dt.strftime("%H")
    dwd_var_dir = spec["dwd_var_dir"]

    items: list[tuple[str, str]] = []

    if spec["level_kind"] == "single-level":
        filename = build_single_level_filename(run_dt, var_key, step)
        url = f"{DWD_ICON_D2_BASE_URL}/{run_hour}/{dwd_var_dir}/{filename}"
        rel = f"{dwd_var_dir}/{filename}"
        items.append((url, rel))
        return items

    if spec["level_kind"] == "soil-level":
        for level in spec["levels"]:
            filename = build_soil_level_filename(run_dt, var_key, step, level)
            url = f"{DWD_ICON_D2_BASE_URL}/{run_hour}/{dwd_var_dir}/{filename}"
            # salvo ogni livello in una sottocartella propria
            rel = f"{dwd_var_dir}/level_{level}/{filename}"
            items.append((url, rel))
        return items

    raise ValueError(f"level_kind non supportato: {spec['level_kind']}")


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


def find_latest_available_run(
    now_utc: datetime | None = None,
    probe_var_key: str = "t2m",
    probe_step: int = 0,
    lookback_cycles: int = 16,
) -> datetime:
    if now_utc is None:
        now_utc = datetime.now(UTC)

    candidate = floor_to_latest_cycle(now_utc)

    for _ in range(lookback_cycles):
        probe_items = build_download_items(candidate, probe_var_key, probe_step)
        probe_url = probe_items[0][0]
        if url_exists(probe_url):
            return candidate
        candidate -= timedelta(hours=3)

    raise RuntimeError(
        "Impossibile trovare una run ICON-D2 disponibile nel lookback configurato"
    )


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


def download_file_legacy(
    url: str,
    out_path: Path,
    timeout: int = 120,
    overwrite: bool = False,
    dry_run: bool = False,
) -> None:
    if out_path.exists() and not overwrite:
        print(f"[SKIP] Esiste già: {out_path}")
        return

    print(f"[GET] {url}")
    print(f"      -> {out_path}")

    if dry_run:
        return

    out_path.parent.mkdir(parents=True, exist_ok=True)

    with requests.get(url, stream=True, timeout=timeout) as resp:
        resp.raise_for_status()
        with out_path.open("wb") as f:
            for chunk in resp.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    f.write(chunk)


def download_file(
    url: str,
    out_path: Path,
    timeout: int = 120,
    overwrite: bool = False,
    dry_run: bool = False,
    max_retries: int = 4,
) -> None:
    if out_path.exists() and not overwrite:
        if is_valid_bz2_file(out_path):
            print(f"[SKIP] Esiste gia': {out_path}")
            return
        print(f"[WARN] File locale bz2 corrotto o incompleto, riscarico: {out_path}")

    print(f"[GET] {url}")
    print(f"      -> {out_path}")

    if dry_run:
        return

    out_path.parent.mkdir(parents=True, exist_ok=True)
    part_path = out_path.with_name(f"{out_path.name}.part")
    if part_path.exists():
        part_path.unlink()

    for attempt in range(1, max_retries + 1):
        try:
            if part_path.exists():
                part_path.unlink()

            with requests.get(url, stream=True, timeout=timeout) as resp:
                resp.raise_for_status()
                expected_size = int(resp.headers.get("Content-Length", "0") or "0")
                bytes_written = 0
                with part_path.open("wb") as f:
                    for chunk in resp.iter_content(chunk_size=1024 * 1024):
                        if chunk:
                            f.write(chunk)
                            bytes_written += len(chunk)

            if expected_size and bytes_written != expected_size:
                raise RuntimeError(
                    f"Download incompleto: {bytes_written} byte su {expected_size}"
                )

            if not is_valid_bz2_file(part_path):
                raise RuntimeError("Download bz2 non valido")

            break
        except requests.HTTPError:
            part_path.unlink(missing_ok=True)
            raise
        except (requests.RequestException, RuntimeError) as exc:
            part_path.unlink(missing_ok=True)
            if attempt >= max_retries:
                raise RuntimeError(
                    f"Download fallito dopo {max_retries} tentativi per {url}: {exc}"
                ) from exc
            delay = min(2 ** attempt, 30)
            print(f"[RETRY] {attempt}/{max_retries} {type(exc).__name__}: {exc}. Riprovo tra {delay}s")
            time.sleep(delay)

    part_path.replace(out_path)


def normalize_variable_keys(var_keys: list[str] | None) -> list[str]:
    if not var_keys:
        return list(ICON_D2_RAW_VARIABLES.keys())

    unknown = [v for v in var_keys if v not in ICON_D2_RAW_VARIABLES]
    if unknown:
        raise ValueError(
            f"Variabili non supportate: {unknown}. "
            f"Supportate: {list(ICON_D2_RAW_VARIABLES.keys())}"
        )
    return var_keys


def normalize_steps(steps: list[int] | None) -> list[int]:
    if not steps:
        return list(ICON_D2_DEFAULT_STEPS)

    bad = [s for s in steps if s < 0]
    if bad:
        raise ValueError(f"Lead time negativi non validi: {bad}")

    return sorted(set(steps))


def ensure_run_dir(run_dt: datetime) -> Path:
    run_dir = ICON_D2_RAW_DIR / format_run(run_dt)
    run_dir.mkdir(parents=True, exist_ok=True)
    return run_dir


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Scarica i dati raw ICON-D2 open data DWD per una singola run."
    )
    parser.add_argument(
        "--run",
        type=str,
        default=None,
        help="Run target in formato YYYYmmddHH. Se omesso, usa l'ultima run disponibile.",
    )
    parser.add_argument(
        "--vars",
        nargs="+",
        default=None,
        help=(
            "Lista variabili interne da scaricare. "
            f"Supportate: {list(ICON_D2_RAW_VARIABLES.keys())}"
        ),
    )
    parser.add_argument(
        "--steps",
        nargs="+",
        type=int,
        default=None,
        help=f"Lead time orari da scaricare. Default: {list(ICON_D2_DEFAULT_STEPS)}",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Riscarica anche file già presenti.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Mostra cosa verrebbe scaricato senza eseguire il download.",
    )
    args = parser.parse_args()

    var_keys = normalize_variable_keys(args.vars)
    steps = normalize_steps(args.steps)

    if args.run:
        run_dt = parse_run_yyyymmddhh(args.run)
    else:
        run_dt = find_latest_available_run()

    run_dir = ensure_run_dir(run_dt)

    print("=" * 78)
    print("ICON-D2 RAW DOWNLOAD")
    print(f"Run                : {format_run(run_dt)} UTC")
    print(f"Variabili          : {var_keys}")
    print(f"Lead times         : {steps}")
    print(f"Output dir         : {run_dir.resolve()}")
    print(f"Overwrite          : {args.overwrite}")
    print(f"Dry run            : {args.dry_run}")
    print("=" * 78)

    failures: list[str] = []

    for var_key in var_keys:
        for step in steps:
            items = build_download_items(run_dt, var_key, step)

            for url, rel_subpath in items:
                out_path = run_dir / rel_subpath
                try:
                    download_file(
                        url=url,
                        out_path=out_path,
                        overwrite=args.overwrite,
                        dry_run=args.dry_run,
                    )
                except requests.HTTPError as exc:
                    msg = (
                        f"{var_key} step={step}: HTTP error per {url} "
                        f"-> {type(exc).__name__}: {exc}"
                    )
                    print(f"[FAIL] {msg}", file=sys.stderr)
                    failures.append(msg)
                except requests.RequestException as exc:
                    msg = (
                        f"{var_key} step={step}: request error per {url} "
                        f"-> {type(exc).__name__}: {exc}"
                    )
                    print(f"[FAIL] {msg}", file=sys.stderr)
                    failures.append(msg)
                except Exception as exc:
                    msg = (
                        f"{var_key} step={step}: errore inatteso per {url} "
                        f"-> {type(exc).__name__}: {exc}"
                    )
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
