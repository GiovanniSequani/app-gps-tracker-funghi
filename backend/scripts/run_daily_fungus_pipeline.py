from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import xarray as xr

from backend.config.meteo import FINAL_METEO_DIR, INTERMEDIATE_METEO_DIR
from backend.scripts.pipeline_logging import (
    print_meteo_recent_coverage,
    run_logged_cmd,
    run_logged_main,
)

ROOT_DIR = Path(__file__).resolve().parents[2]
METEO_BAT = ROOT_DIR / "backend" / "scripts" / "meteo" / "run_auto_meteo.bat"
RUC_METEO_BAT = ROOT_DIR / "backend" / "scripts" / "meteo" / "run_auto_meteo_ruc.bat"
LEGACY_ROLLING_METEO_NC = FINAL_METEO_DIR / "meteo_recent_003deg.nc"
# Compatibility alias for callers/tests that explicitly inject a weather file.
ROLLING_METEO_NC = LEGACY_ROLLING_METEO_NC
HOURLY_BUFFER_NC = INTERMEDIATE_METEO_DIR / "hourly_buffer.nc"
UTC = timezone.utc
LOCAL_TZ = ZoneInfo("Europe/Rome")


def run_cmd(cmd: list[str]) -> None:
    returncode = run_logged_cmd(cmd)
    if returncode != 0:
        raise RuntimeError(f"Command failed with exit code {returncode}")

def latest_icon_series() -> Path:
    if ROLLING_METEO_NC != LEGACY_ROLLING_METEO_NC:
        return ROLLING_METEO_NC
    paths = sorted(FINAL_METEO_DIR.glob("icon_ruc_time_series_*.nc"))
    if paths:
        return paths[-1]
    if LEGACY_ROLLING_METEO_NC.exists():
        return LEGACY_ROLLING_METEO_NC
    raise FileNotFoundError("no yearly ICON-RUC time series found")


def load_rolling_metadata(path: Path) -> tuple[str, str]:
    if not path.is_file():
        raise FileNotFoundError(f"Rolling meteo dataset not found: {path}")

    ds = xr.open_dataset(path)
    try:
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


def format_datetime64_run(value) -> str | None:
    raw = str(value)
    if raw == "NaT":
        return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC).strftime("%Y%m%d%H")


def load_processed_runs_from_hourly_buffer(path: Path) -> set[str]:
    if not path.is_file():
        return set()

    ds = xr.open_dataset(path)
    try:
        ds.load()
        if "run_time" not in ds.variables:
            return set()
        runs = {
            run
            for value in ds["run_time"].values.astype("datetime64[s]")
            if (run := format_datetime64_run(value)) is not None
        }
        return runs
    finally:
        ds.close()


def ruc_hourly_has_valid_time(run: str, min_lead_hours: int, root: Path = INTERMEDIATE_METEO_DIR) -> bool:
    path = root / f"icon_d2_ruc_hourly_{run}.nc"
    if not path.is_file():
        return False

    try:
        run_dt = datetime.strptime(run, "%Y%m%d%H").replace(tzinfo=UTC)
    except ValueError:
        return False
    expected_valid_time = (run_dt + timedelta(hours=min_lead_hours)).replace(tzinfo=None)
    expected_np = np.datetime64(expected_valid_time, "s")

    ds = xr.open_dataset(path)
    try:
        ds.load()
        if "valid_time" not in ds.coords or "smi9" not in ds.data_vars:
            return False
        valid_times = ds["valid_time"].values.astype("datetime64[s]")
        matches = np.where(valid_times == expected_np)[0]
        if not matches.size:
            return False
        return bool(np.isfinite(ds["smi9"].isel(valid_time=int(matches[-1])).values).all())
    finally:
        ds.close()


def load_processed_ruc_runs_from_hourly_files(
    root: Path = INTERMEDIATE_METEO_DIR,
    buffer_path: Path = HOURLY_BUFFER_NC,
    min_lead_hours: int = 1,
) -> set[str]:
    if not root.is_dir():
        return set()

    buffer_runs = load_processed_runs_from_hourly_buffer(buffer_path)
    runs: set[str] = set()
    prefix = "icon_d2_ruc_hourly_"
    for path in root.glob(f"{prefix}*.nc"):
        run = path.stem.removeprefix(prefix)
        if len(run) == 10 and run.isdigit() and run in buffer_runs and ruc_hourly_has_valid_time(run, min_lead_hours, root):
            runs.add(run)
    return runs


def publication_gate_icon_d2(date: str, processed_runs: set[str]) -> tuple[bool, str]:
    day = datetime.strptime(date, "%Y-%m-%d").strftime("%Y%m%d")
    run_18 = f"{day}18"
    run_21 = f"{day}21"

    if run_21 in processed_runs:
        return True, f"{run_21} processed"

    has_later_day_run = any(
        len(run) == 10 and run.isdigit() and run[:8] > day
        for run in processed_runs
    )
    if run_18 in processed_runs and has_later_day_run:
        return True, f"{run_18} fallback; {run_21} missing and a later-day run was processed"

    if run_18 in processed_runs:
        return False, f"{run_18} processed; waiting for {run_21} or a later-day fallback signal"

    return False, f"waiting for {run_21}"


def ruc_gate_run_for_date(date: str, min_lead_hours: int = 1) -> str:
    if min_lead_hours < 0:
        raise ValueError("min_lead_hours deve essere >= 0")
    day = datetime.strptime(date, "%Y-%m-%d")
    last_local_valid_time = day.replace(hour=23, minute=0, second=0, microsecond=0, tzinfo=LOCAL_TZ)
    gate_run = last_local_valid_time.astimezone(UTC) - timedelta(hours=min_lead_hours)
    return gate_run.strftime("%Y%m%d%H")


def publication_gate_icon_d2_ruc(
    date: str,
    processed_runs: set[str],
    min_lead_hours: int = 1,
) -> tuple[bool, str]:
    gate_run = ruc_gate_run_for_date(date, min_lead_hours=min_lead_hours)

    if gate_run in processed_runs:
        return True, f"{gate_run} RUC processed; updates local 23:00 with lead +{min_lead_hours}"

    later_run = min((run for run in processed_runs if len(run) == 10 and run.isdigit() and run > gate_run), default=None)
    if later_run is not None:
        return True, f"{gate_run} RUC missing; fallback enabled after later RUC run {later_run}"

    return False, f"waiting for RUC gate {gate_run}"


def publication_gate(
    date: str,
    processed_runs: set[str],
    model: str = "icon-d2",
    ruc_min_lead_hours: int = 1,
) -> tuple[bool, str]:
    if model == "icon-d2":
        return publication_gate_icon_d2(date, processed_runs)
    if model == "icon-d2-ruc":
        return publication_gate_icon_d2_ruc(date, processed_runs, min_lead_hours=ruc_min_lead_hours)
    raise ValueError(f"publication model non supportato: {model}")


def index_path_for(date: str) -> Path:
    return ROOT_DIR / "backend" / "outputs" / "index_nc" / f"funghi_index_{date}.nc"


def tiles_root_for(date: str) -> Path:
    return ROOT_DIR / "backend" / "outputs" / "tiles_local" / f"{date}_v1"


def index_data_publication_command(py: str, date: str, env_file: str | None) -> list[str]:
    command = [
        py,
        "-m",
        "backend.scripts.publication.publish_index_point",
        "--index-date",
        date,
    ]
    if env_file:
        command.extend(["--env-file", env_file])
    return command


def is_fully_published(date: str) -> bool:
    return index_path_for(date).exists() and tiles_root_for(date).exists()


def latest_fully_published_date() -> str | None:
    index_dir = ROOT_DIR / "backend" / "outputs" / "index_nc"
    if not index_dir.is_dir():
        return None

    published = []
    for index_path in index_dir.glob("funghi_index_*.nc"):
        raw = index_path.stem.removeprefix("funghi_index_")
        try:
            datetime.strptime(raw, "%Y-%m-%d")
        except ValueError:
            continue
        if is_fully_published(raw):
            published.append(raw)
    return max(published) if published else None


def complete_rolling_dates_until(path: Path, date_to: str) -> list[str]:
    if not path.is_file():
        return []

    ds = xr.open_dataset(path)
    try:
        if "time" not in ds.coords:
            return []
        dates = {
            str(value)[:10]
            for value in ds["time"].values
            if str(value) != "NaT" and str(value)[:10] <= date_to
        }
    finally:
        ds.close()

    valid_dates = []
    for date in dates:
        try:
            datetime.strptime(date, "%Y-%m-%d")
        except ValueError:
            continue
        valid_dates.append(date)
    return sorted(valid_dates)


def complete_candidate_dates_after(
    date_after: str | None,
    date_to: str,
    series_path: Path | None = None,
) -> list[str]:
    dates = set(complete_rolling_dates_until(series_path or latest_icon_series(), date_to))
    return sorted(
        date
        for date in dates
        if date_after is None or date > date_after
    )


def publishable_unpublished_dates_until(
    date_after: str | None,
    date_to: str,
    processed_runs: set[str],
    publication_model: str,
    ruc_min_lead_hours: int,
) -> list[str]:
    return [
        date
        for date in complete_candidate_dates_after(date_after, date_to)
        if not is_fully_published(date)
        if publication_gate(
            date,
            processed_runs,
            model=publication_model,
            ruc_min_lead_hours=ruc_min_lead_hours,
        )[0]
    ]


def main() -> None:
    run_logged_main("daily_fungus_pipeline", _main)


def _main() -> None:
    parser = argparse.ArgumentParser(description="Run meteo -> index -> tiles -> upload in one shot.")
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--date", default=None, help="Force pipeline date YYYY-MM-DD.")
    parser.add_argument("--skip-meteo", action="store_true", help="Skip run_auto_meteo.bat and use the current rolling file.")
    parser.add_argument("--force", action="store_true", help="Continue even if the publication gate is not ready.")
    parser.add_argument("--meteo-bat", default=str(METEO_BAT), help="Meteo wrapper .bat da eseguire prima di index/tiles.")
    parser.add_argument("--publication-model", choices=("icon-d2", "icon-d2-ruc"), default="icon-d2")
    parser.add_argument(
        "--ruc-output-min-lead-hours",
        type=int,
        default=1,
        help="Lead minimo prodotto dalla pipeline RUC. Default: 1.",
    )
    parser.add_argument("--upload-only-tiles", action="store_true", help="Only upload existing local tiles after index build.")
    parser.add_argument("--skip-tiles", action="store_true", help="Stop after recomputing the index NetCDF.")
    parser.add_argument(
        "--skip-weather-publication",
        action="store_true",
        help="Do not publish the public 20-day weather dataset to Supabase Postgres.",
    )
    parser.add_argument(
        "--skip-index-data-publication",
        action="store_true",
        help="Do not publish exact point scores and compact porcini diagnostics.",
    )
    parser.add_argument("--tiles-workers", type=int, default=12)
    parser.add_argument("--tile-zooms", nargs="+", type=int, default=[3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
    parser.add_argument("--tile-retention-days", type=int, default=30)
    parser.add_argument("--skip-tile-cleanup", action="store_true", help="Do not delete old remote tile sets from Supabase Storage.")
    parser.add_argument(
        "--env-file",
        default=str(ROOT_DIR / "backend" / ".env"),
        help="Env file passed to tile upload script.",
    )
    args = parser.parse_args()
    publication_errors: list[str] = []

    if not args.skip_meteo:
        meteo_bat = Path(args.meteo_bat)
        if not meteo_bat.is_absolute():
            meteo_bat = ROOT_DIR / meteo_bat
        if not meteo_bat.is_file():
            raise FileNotFoundError(f"Meteo wrapper not found: {meteo_bat}")
        run_cmd(["cmd", "/c", str(meteo_bat)])

    weather_series = latest_icon_series()
    rolling_date, latest_run_raw = load_rolling_metadata(weather_series)
    pipeline_date = args.date or rolling_date
    if args.publication_model == "icon-d2-ruc":
        processed_runs = load_processed_ruc_runs_from_hourly_files(
            INTERMEDIATE_METEO_DIR,
            HOURLY_BUFFER_NC,
            min_lead_hours=args.ruc_output_min_lead_hours,
        )
    else:
        processed_runs = load_processed_runs_from_hourly_buffer(HOURLY_BUFFER_NC)
    rolling_gate_ready, rolling_gate_reason = publication_gate(
        rolling_date,
        processed_runs,
        model=args.publication_model,
        ruc_min_lead_hours=args.ruc_output_min_lead_hours,
    )
    py = args.python

    should_publish = args.force or rolling_gate_ready

    print("DAILY FUNGUS PIPELINE")
    print(
        f"rolling_date={rolling_date} pipeline_date={pipeline_date} "
        f"latest_run_utc={latest_run_raw or '[missing]'} "
        f"publication_model={args.publication_model} processed_runs={len(processed_runs)}"
    )
    print(
        f"publish_gate={'ready' if should_publish else 'waiting'} "
        f"reason={'forced' if args.force else rolling_gate_reason} "
        f"weather_series={weather_series.name} force={args.force}"
    )

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

    def publish_date(date: str) -> None:
        run_cmd([py, "-m", "backend.scripts.index.run_index_pipeline", "--date", date])

        if not args.skip_tiles:
            tiles_cmd = [
                py,
                "-m",
                "backend.scripts.tiles.01_build_tiles_gdal",
                "--date",
                date,
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

        if not args.skip_index_data_publication:
            index_data_cmd = index_data_publication_command(py, date, args.env_file)
            try:
                run_cmd(index_data_cmd)
            except Exception as exc:
                message = f"index-data {date}: {type(exc).__name__}: {exc}"
                publication_errors.append(message)
                print(
                    f"[PUBLIC INDEX DATA ERROR] {message}. "
                    "The previous current point dataset remains unchanged.",
                    flush=True,
                )

        if not args.skip_weather_publication:
            weather_cmd = [
                py,
                "-m",
                "backend.scripts.publication.publish_weather",
                "--index-date",
                date,
            ]
            if args.env_file:
                weather_cmd.extend(["--env-file", args.env_file])
            try:
                run_cmd(weather_cmd)
            except Exception as exc:
                message = f"weather {date}: {type(exc).__name__}: {exc}"
                publication_errors.append(message)
                print(
                    f"[PUBLIC WEATHER ERROR] {message}. "
                    "The previous current weather version remains unchanged.",
                    flush=True,
                )

    if args.date:
        publish_dates = [pipeline_date] if args.force or not is_fully_published(pipeline_date) else []
    else:
        last_published = latest_fully_published_date()
        publish_dates = publishable_unpublished_dates_until(
            last_published,
            rolling_date,
            processed_runs,
            publication_model=args.publication_model,
            ruc_min_lead_hours=args.ruc_output_min_lead_hours,
        )

        if should_publish:
            if rolling_date not in publish_dates and (args.force or not is_fully_published(rolling_date)):
                publish_dates.append(rolling_date)

    publish_dates = sorted(set(publish_dates))

    if not publish_dates:
        if args.date:
            print("[SKIP] Requested day was already published: index NetCDF and tile root are both present.")
        elif not should_publish:
            print(f"[SKIP] Rolling meteo is complete but not publishable yet: {rolling_gate_reason}.")
        else:
            print("[SKIP] No unpublished complete day found.")
        run_tile_cleanup()
        print_meteo_recent_coverage(weather_series)
        return

    if not args.date and not should_publish and publish_dates:
        print(f"[SKIP] Rolling meteo is complete but still waiting: {rolling_gate_reason}.")
        print(f"[BACKFILL] Publishing eligible historic day(s): {publish_dates}")
    else:
        print(f"[PUBLISH] Publishing day(s): {publish_dates}")

    for date in publish_dates:
        publish_date(date)

    if args.skip_tiles:
        print_meteo_recent_coverage(weather_series)
        if publication_errors:
            raise RuntimeError(
                "Public data publication failed: "
                + "; ".join(publication_errors)
            )
        print("\nDone")
        return
    run_tile_cleanup()
    print_meteo_recent_coverage(weather_series)
    if publication_errors:
        raise RuntimeError(
            "Public data publication failed after index/tile publication and tile cleanup: "
            + "; ".join(publication_errors)
        )
    print("\nDone")


if __name__ == "__main__":
    main()
