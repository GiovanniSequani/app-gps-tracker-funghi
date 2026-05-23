from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from datetime import datetime
from zoneinfo import ZoneInfo
from pathlib import Path

import xarray as xr

from backend.config.meteo import FINAL_METEO_DIR
from backend.config.paths import FINAL_METEO_HISTORIC_DIR

ROOT_DIR = Path(__file__).resolve().parents[2]
METEO_BAT = ROOT_DIR / "backend" / "scripts" / "meteo" / "run_auto_meteo.bat"
ROLLING_METEO_NC = FINAL_METEO_DIR / "meteo_recent_003deg.nc"
ROME = ZoneInfo("Europe/Rome")


def run_cmd(cmd: list[str]) -> None:
    print("\n[CMD]", " ".join(cmd), flush=True)
    result = subprocess.run(cmd)
    if result.returncode != 0:
        raise RuntimeError(f"Command failed with exit code {result.returncode}")

def load_rolling_metadata(path: Path) -> tuple[str, str]:
    if not path.is_file():
        raise FileNotFoundError(f"Rolling meteo dataset not found: {path}")

    ds = xr.open_dataset(path)
    try:
        ds.load()
        time_end = str(ds.attrs.get("time_end", ""))
        latest_run = str(ds.attrs.get("latest_run_time_utc", ""))
        if not time_end:
            raise RuntimeError(f"Missing time_end in {path}")
        return time_end[:10], latest_run
    finally:
        ds.close()


def parse_run_hour(value: str) -> int | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt.hour


def main() -> None:
    parser = argparse.ArgumentParser(description="Run meteo -> index -> tiles -> upload in one shot.")
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--date", default=None, help="Force pipeline date YYYY-MM-DD.")
    parser.add_argument("--skip-meteo", action="store_true", help="Skip run_auto_meteo.bat and use the current rolling file.")
    parser.add_argument("--force", action="store_true", help="Continue even if rolling meteo is not completed by the 21 UTC run.")
    parser.add_argument("--upload-only-tiles", action="store_true", help="Only upload existing local tiles after index build.")
    parser.add_argument("--skip-tiles", action="store_true", help="Stop after recomputing the index NetCDF.")
    parser.add_argument("--tiles-workers", type=int, default=12)
    parser.add_argument("--tile-zooms", nargs="+", type=int, default=[6, 7, 8, 9, 10, 11, 12, 13])
    parser.add_argument("--tile-retention-days", type=int, default=30)
    parser.add_argument("--skip-tile-cleanup", action="store_true", help="Do not delete old remote tile sets from Supabase Storage.")
    parser.add_argument("--env-file", default=str(ROOT_DIR / ".env"), help="Env file passed to tile upload script.")
    args = parser.parse_args()

    if not args.skip_meteo:
        if not METEO_BAT.is_file():
            raise FileNotFoundError(f"Meteo wrapper not found: {METEO_BAT}")
        run_cmd(["cmd", "/c", str(METEO_BAT)])

    rolling_date, latest_run_raw = load_rolling_metadata(ROLLING_METEO_NC)
    snapshot_name = f"meteo_recent_003deg_{rolling_date.replace('-', '')}.nc"
    snapshot_path = FINAL_METEO_HISTORIC_DIR / snapshot_name
    pipeline_date = args.date or rolling_date
    latest_run_hour = parse_run_hour(latest_run_raw)
    current_local_date = datetime.now(ROME).date()
    rolling_local_date = datetime.strptime(rolling_date, "%Y-%m-%d").date()
    snapshot_exists = snapshot_path.exists()
    index_path = ROOT_DIR / "backend" / "outputs" / "index_nc" / f"funghi_index_{pipeline_date}.nc"
    tiles_root = ROOT_DIR / "backend" / "outputs" / "tiles_local" / f"{pipeline_date}_v1"
    already_published = snapshot_exists and index_path.exists() and tiles_root.exists()
    py = args.python

    should_publish = args.force or (
        (latest_run_hour == 21) or (current_local_date > rolling_local_date)
    )

    print("=" * 80)
    print("DAILY FUNGUS PIPELINE")
    print(f"Rolling date      : {rolling_date}")
    print(f"Latest run UTC    : {latest_run_raw or '[missing]'}")
    print(f"Historic snapshot : {snapshot_path}")
    print(f"Pipeline date     : {pipeline_date}")
    print(f"Force             : {args.force}")
    print("=" * 80)

    def run_tile_cleanup() -> None:
        if args.skip_tiles or args.skip_tile_cleanup:
            return
        cleanup_cmd = [
            py,
            "-m",
            "backend.scripts.tiles.01_build_tiles_gdal",
            "--cleanup-only",
            "--retention-days",
            str(args.tile_retention_days),
        ]
        if args.env_file:
            cleanup_cmd.extend(["--env-file", args.env_file])
        run_cmd(cleanup_cmd)

    if already_published and not args.force:
        print("[SKIP] This rolling day was already published: snapshot, index NetCDF, and tile root are all present.")
        run_tile_cleanup()
        return

    if not should_publish:
        print("[SKIP] Rolling meteo is still provisional (typically after the 18 UTC run). Index and tiles not updated.")
        run_tile_cleanup()
        return

    if not snapshot_exists:
        FINAL_METEO_HISTORIC_DIR.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROLLING_METEO_NC, snapshot_path)
        print(f"[SNAPSHOT] created: {snapshot_path}")

    run_cmd([py, "-m", "backend.scripts.index.run_index_pipeline", "--date", pipeline_date])

    if args.skip_tiles:
        print("\nDone")
        return

    tiles_cmd = [
        py,
        "-m",
        "backend.scripts.tiles.01_build_tiles_gdal",
        "--date",
        pipeline_date,
        "--upload-workers",
        str(args.tiles_workers),
        "--zoom",
        *[str(z) for z in args.tile_zooms],
    ]
    if args.upload_only_tiles:
        tiles_cmd.append("--upload-only")
    if args.env_file:
        tiles_cmd.extend(["--env-file", args.env_file])

    run_cmd(tiles_cmd)
    run_tile_cleanup()
    print("\nDone")


if __name__ == "__main__":
    main()
