from __future__ import annotations

import argparse
import importlib
import json
import os
import shutil
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv

from backend.config.index_config import (
    INDEX_FEATURES_TEMPLATE,
    INDEX_FEATURE_WINDOW_DAYS,
    INDEX_OUTPUT_TEMPLATE,
)
from backend.config.paths import FINAL_METEO_DIR, hrs_time_series_path, icon_ruc_time_series_path
from backend.scripts.pipeline_logging import run_logged_cmd
from backend.src.meteo.time_series import import_hrs, validate_hrs
from backend.src.publication.supabase import SupabaseClient

ROOT_DIR = Path(__file__).resolve().parents[3]


def run_cmd(command: list[str]) -> None:
    code = run_logged_cmd(command)
    if code != 0:
        raise RuntimeError(f"command failed with exit code {code}: {' '.join(command)}")


def parse_index_date(path: Path) -> date | None:
    try:
        return datetime.strptime(path.stem.removeprefix("funghi_index_"), "%Y-%m-%d").date()
    except ValueError:
        return None


def local_index_dates(index_dir: Path) -> tuple[date, ...]:
    values = [item for path in index_dir.glob("funghi_index_*.nc") if (item := parse_index_date(path))]
    return tuple(sorted(values))


def affected_index_dates(changed_weather_dates: tuple[date, ...], available_indices: tuple[date, ...]) -> tuple[date, ...]:
    if not changed_weather_dates or not available_indices:
        return ()
    first = min(changed_weather_dates)
    latest = max(available_indices)
    if first > latest:
        return ()
    # Recovery consumes prior index outputs, so recompute sequentially through
    # the newest local index instead of stopping at the weather-window horizon.
    return tuple(item for item in available_indices if first <= item <= latest)


def load_remote_tile_sets(client: SupabaseClient) -> list[dict[str, object]]:
    payload = client.storage_get("tiles", "tile_sets.json")
    if payload is None:
        raise RuntimeError("tiles/tile_sets.json is missing")
    manifest = json.loads(payload.decode("utf-8"))
    entries = manifest.get("tileSets")
    if not isinstance(entries, list):
        raise RuntimeError("tiles/tile_sets.json has no tileSets array")
    return [entry for entry in entries if isinstance(entry, dict)]


def retained_versions(entries: list[dict[str, object]]) -> dict[date, int]:
    result: dict[date, int] = {}
    for entry in entries:
        try:
            item = datetime.strptime(str(entry["date"]).replace("_", "-"), "%Y-%m-%d").date()
            result[item] = int(entry["version"])
        except (KeyError, TypeError, ValueError):
            continue
    return result


def manifest_payload(entries: list[dict[str, object]], revisions: dict[date, int]) -> bytes:
    updated: list[dict[str, str]] = []
    for entry in entries:
        try:
            item = datetime.strptime(str(entry["date"]).replace("_", "-"), "%Y-%m-%d").date()
        except (KeyError, TypeError, ValueError):
            continue
        version = revisions.get(item, int(entry["version"]))
        updated.append({"date": item.isoformat(), "version": str(version)})
    updated.sort(key=lambda entry: (entry["date"], int(entry["version"])), reverse=True)
    return (json.dumps(
        {"updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "tileSets": updated},
        separators=(",", ":"),
    ) + "\n").encode("utf-8")


def promote_reanalysis_outputs(
    affected: tuple[date, ...],
    stage_indices: Path,
    stage_features: Path,
    index_dir: Path,
    feature_dir: Path,
    backup_dir: Path,
) -> None:
    """Replace each index together with the exact features used to compute it."""

    index_backup = backup_dir / "index_nc"
    feature_backup = backup_dir / "features"
    index_backup.mkdir(parents=True, exist_ok=True)
    feature_backup.mkdir(parents=True, exist_ok=True)
    feature_dir.mkdir(parents=True, exist_ok=True)

    promoted: list[tuple[Path, Path | None]] = []
    try:
        for item in affected:
            suffix = item.isoformat()
            pairs = (
                (
                    stage_features / f"index_features_{suffix}.nc",
                    feature_dir / f"index_features_{suffix}.nc",
                    feature_backup / f"index_features_{suffix}.nc",
                ),
                (
                    stage_indices / f"funghi_index_{suffix}.nc",
                    index_dir / f"funghi_index_{suffix}.nc",
                    index_backup / f"funghi_index_{suffix}.nc",
                ),
            )
            for source, destination, backup in pairs:
                if not source.is_file():
                    raise RuntimeError(f"missing staged output {source}")
                previous = backup if destination.exists() else None
                if previous is not None:
                    try:
                        os.link(destination, previous)
                    except OSError:
                        shutil.copy2(destination, previous)
                os.replace(source, destination)
                promoted.append((destination, previous))
    except Exception:
        for destination, previous in reversed(promoted):
            if previous is not None and previous.exists():
                os.replace(previous, destination)
            elif destination.exists():
                destination.unlink()
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description="Import HRS and optionally rebuild/re-publish affected indices.")
    parser.add_argument("--name", required=True, help="Manual HRS NetCDF path.")
    parser.add_argument("--merge-only", action="store_true", help="Only update the canonical HRS series.")
    parser.add_argument("--no-publish", action="store_true", help="Rebuild local indices without publishing tiles.")
    parser.add_argument("--dry-run", action="store_true", help="Validate and print the plan without changing files or Supabase.")
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--env-file", default=str(ROOT_DIR / "backend" / ".env"))
    parser.add_argument("--tiles-workers", type=int, default=8)
    parser.add_argument("--tile-zooms", nargs="+", type=int, default=list(range(3, 14)))
    args = parser.parse_args()
    if args.merge_only and args.no_publish:
        raise SystemExit("--merge-only and --no-publish are mutually exclusive")

    source = Path(args.name)
    first_validation = validate_hrs(source)
    year = first_validation.dates[0].year
    if any(item.year != year for item in first_validation.dates):
        raise ValueError("one HRS import may not span multiple calendar years")
    icon = icon_ruc_time_series_path(year)
    validation = validate_hrs(source, icon)
    active_hrs = hrs_time_series_path(year)
    # All supplied valid dates remain eligible on every run. This deliberately
    # makes recovery possible after a previous tile/publication failure, even
    # when the HRS file had already been merged successfully.
    changed_dates = validation.valid_dates
    index_dir = Path(str(INDEX_OUTPUT_TEMPLATE)).parent
    affected = affected_index_dates(changed_dates, local_index_dates(index_dir))
    print(
        f"[HRS PLAN] input={source} valid={len(validation.valid_dates)} "
        f"fallback_to_icon={len(validation.fallback_dates)} affected_indices={len(affected)}"
    )
    if affected:
        print(f"[HRS PLAN] rebuild={affected[0]}..{affected[-1]}")
    if args.dry_run:
        if not args.merge_only and not args.no_publish:
            try:
                env_file = Path(args.env_file)
                client = SupabaseClient.from_env(env_file)
                retained = retained_versions(load_remote_tile_sets(client))
                remote = [item for item in affected if item in retained]
                print(f"[HRS PLAN] retained_remote_indices={len(remote)}")
            except Exception as exc:
                print(f"[HRS PLAN] remote manifest not checked: {type(exc).__name__}: {exc}")
        print("[DRY RUN] no local or remote state changed")
        return

    staging_dir = FINAL_METEO_DIR / ".hrs_staging"
    if staging_dir.exists():
        shutil.rmtree(staging_dir)
    staging_dir.mkdir(parents=True, exist_ok=True)
    staging_hrs = staging_dir / active_hrs.name
    if active_hrs.exists():
        shutil.copy2(active_hrs, staging_hrs)
    elif staging_hrs.exists():
        staging_hrs.unlink()
    import_hrs(source, staging_hrs, icon)

    if args.merge_only:
        os.replace(staging_hrs, active_hrs)
        staging_dir.rmdir()
        print(f"[HRS MERGE] active={active_hrs} indices_unchanged=true published=false")
        return

    stage_indices = staging_dir / "index_nc"
    stage_features = staging_dir / "features"
    stage_indices.mkdir(parents=True, exist_ok=True)
    stage_features.mkdir(parents=True, exist_ok=True)
    os.link(icon, staging_dir / icon.name)
    for existing in index_dir.glob("funghi_index_*.nc"):
        item = parse_index_date(existing)
        if item and affected and item < affected[0] and item >= affected[0] - timedelta(days=6):
            shutil.copy2(existing, stage_indices / existing.name)

    try:
        for item in affected:
            text = item.isoformat()
            feature_path = stage_features / f"index_features_{text}.nc"
            index_path = stage_indices / f"funghi_index_{text}.nc"
            run_cmd([
                args.python, "-m", "backend.scripts.index.01_build_index_features",
                "--date", text, "--meteo-dir", str(staging_dir), "--output", str(feature_path),
            ])
            run_cmd([
                args.python, "-m", "backend.scripts.index.02_compute_funghi_index",
                "--date", text, "--features", str(feature_path),
                "--history-dir", str(stage_indices), "--output", str(index_path),
            ])

        for item in affected:
            staged = stage_indices / f"funghi_index_{item.isoformat()}.nc"
            if not staged.is_file():
                raise RuntimeError(f"missing staged index {staged}")
        promote_reanalysis_outputs(
            affected,
            stage_indices,
            stage_features,
            index_dir,
            Path(str(INDEX_FEATURES_TEMPLATE)).parent,
            staging_dir / "backup",
        )
    except Exception:
        raise

    if args.no_publish:
        os.replace(staging_hrs, active_hrs)
        shutil.rmtree(staging_dir)
        print(f"[HRS REBUILD] rebuilt={len(affected)} published=false")
        return

    os.replace(staging_hrs, active_hrs)
    env_file = Path(args.env_file)
    if env_file.exists():
        load_dotenv(env_file, override=False)
    client = SupabaseClient.from_env(env_file)
    entries = load_remote_tile_sets(client)
    retained = retained_versions(entries)
    publish_dates = tuple(item for item in affected if item in retained)
    revisions = {item: retained[item] + 1 for item in publish_dates}
    print(f"[HRS PUBLISH] retained_affected={len(publish_dates)}")
    latest = max(retained) if retained else None
    if latest is not None and latest in publish_dates:
        # Validate the exact active index/feature pair before any remote tile
        # pointer can be changed. The real publish below repeats the build and
        # performs its own atomic current.json switch.
        feature_path = Path(str(INDEX_FEATURES_TEMPLATE).format(date=latest.isoformat()))
        run_cmd([
            args.python, "-m", "backend.scripts.publication.publish_index_point",
            "--index-date", latest.isoformat(), "--features", str(feature_path),
            "--dry-run",
        ])
    for item in publish_dates:
        run_cmd([
            args.python, "-m", "backend.scripts.tiles.01_build_tiles_gdal",
            "--date", item.isoformat(), "--version", str(revisions[item]),
            "--skip-manifest", "--upload-workers", str(args.tiles_workers),
            "--zoom", *[str(value) for value in args.tile_zooms],
            "--env-file", str(env_file),
        ])
    if publish_dates:
        if latest is not None and latest in publish_dates:
            feature_path = Path(str(INDEX_FEATURES_TEMPLATE).format(date=latest.isoformat()))
            run_cmd([
                args.python, "-m", "backend.scripts.publication.publish_index_point",
                "--index-date", latest.isoformat(), "--features", str(feature_path),
                "--env-file", str(env_file),
            ])
            run_cmd([
                args.python, "-m", "backend.scripts.publication.publish_weather",
                "--index-date", latest.isoformat(), "--env-file", str(env_file),
            ])
        client.storage_upload(
            "tiles", "tile_sets.json", manifest_payload(entries, revisions),
            content_type="application/json; charset=utf-8", cache_control="0",
        )
        verified_entries = load_remote_tile_sets(client)
        verified = retained_versions(verified_entries)
        if any(verified.get(item) != revisions[item] for item in publish_dates):
            raise RuntimeError("remote tile_sets.json verification failed after atomic switch")
        for item in publish_dates:
            old_prefix = f"{item.isoformat()}_v{retained[item]}"
            run_cmd([
                args.python, "-m", "backend.scripts.tiles.01_build_tiles_gdal",
                "--delete-prefix", old_prefix, "--env-file", str(env_file),
            ])
    shutil.rmtree(staging_dir)
    print(f"[HRS DONE] merged=true rebuilt={len(affected)} published={len(publish_dates)}")


if __name__ == "__main__":
    main()
