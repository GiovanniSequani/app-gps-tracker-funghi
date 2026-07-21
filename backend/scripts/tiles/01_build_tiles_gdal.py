from __future__ import annotations

import argparse
import json
import os
import random
import re
import shutil
import socket
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv

from backend.config.index_config import INDEX_OUTPUT_TEMPLATE
from backend.config.paths import OUT_TILES_DIR, TMP_GDAL_DIR
from backend.scripts.pipeline_logging import compact_logs_enabled, format_cmd, is_superfluous_log_line


ROOT_DIR = Path(__file__).resolve().parents[3]
SUPABASE_BUCKET = "tiles"
DEFAULT_SPECIES = ["porcini", "finferli"]
DEFAULT_ZOOMS = list(range(3, 14))
DEFAULT_TILE_RETENTION_DAYS = 30
LOD_STEPS = {2: 0.003, 3: 0.008, 4: 0.02, 5: 0.05, 6: 0.12}
UPLOAD_RETRYABLE_STATUS_CODES = {408, 409, 425, 429, 500, 502, 503, 504}
TILE_SET_DIR_REGEX = re.compile(r"^(\d{4})([-_])(\d{2})\2(\d{2})_v(\d+)$")
MANIFEST_OBJECT = "tile_sets.json"

SUPABASE_URL = None
SUPABASE_KEY = None


def load_env(env_file: str | None = None) -> None:
    candidates = []
    if env_file:
        candidates.append(Path(env_file))
    candidates.extend(
        [
            ROOT_DIR / ".env",
            ROOT_DIR / "backend" / ".env",
            ROOT_DIR / "backend" / "scripts" / "tiles" / ".env",
            ROOT_DIR / "legacy-funghi-index" / ".env",
        ]
    )
    for path in candidates:
        if path.is_file():
            load_dotenv(path)


def refresh_env(env_file: str | None = None) -> None:
    global SUPABASE_URL, SUPABASE_KEY
    load_env(env_file)
    SUPABASE_URL = os.getenv("SUPABASE_URL") or os.getenv("EXPO_PUBLIC_SUPABASE_URL")
    SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY")


def run_cmd(cmd: list[str], cwd: Path | None = None) -> None:
    compact = compact_logs_enabled()
    print("\n[CMD]", format_cmd([str(c) for c in cmd]) if compact else " ".join(str(c) for c in cmd), flush=True)
    result = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        text=True,
        capture_output=True,
    )
    if result.stdout.strip() and not compact:
        print(result.stdout)
    elif result.stdout.strip():
        for line in result.stdout.splitlines():
            if not is_superfluous_log_line(line):
                print(line)
    if result.returncode != 0:
        if result.stderr.strip():
            print(result.stderr)
        raise RuntimeError(f"Command failed with exit code {result.returncode}")


def ensure_exists(path: Path, kind: str = "file") -> None:
    if kind == "file" and not path.is_file():
        raise FileNotFoundError(f"File not found: {path}")
    if kind == "dir" and not path.is_dir():
        raise FileNotFoundError(f"Directory not found: {path}")


def clean_dir(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def find_gdal2tiles_cmd() -> list[str]:
    configured = os.getenv("GDAL2TILES_EXE")
    if configured and Path(configured).exists():
        return [configured]

    found = shutil.which("gdal2tiles") or shutil.which("gdal2tiles.py") or shutil.which("gdal2tiles.exe")
    if found:
        return [found]

    osgeo_root = Path(os.getenv("OSGEO4W_ROOT", r"C:\Users\giova\AppData\Local\Programs\OSGeo4W"))
    exe = osgeo_root / "apps" / "Python312" / "Scripts" / "gdal2tiles.exe"
    py = osgeo_root / "apps" / "Python312" / "python.exe"
    if exe.exists():
        return [str(exe)]
    if py.exists():
        return [str(py), "-m", "osgeo_utils.gdal2tiles"]

    return [sys.executable, "-m", "osgeo_utils.gdal2tiles"]


def zooms_to_gdal_arg(zooms: list[int]) -> str:
    zooms = sorted(set(zooms))
    if not zooms:
        raise ValueError("Empty zoom list")

    ranges = []
    start = prev = zooms[0]
    for z in zooms[1:]:
        if z == prev + 1:
            prev = z
            continue
        ranges.append((start, prev))
        start = prev = z
    ranges.append((start, prev))
    return ",".join(str(a) if a == b else f"{a}-{b}" for a, b in ranges)


def write_colormap_file(path: Path) -> None:
    content = """nv 255 255 255 0
0   255 255 255 0
5   255 255 255 50
15  180 230 255 150
30  100 200 255 200
45  80 180 90 255
60  255 230 70 255
75  255 120 60 255
90  210 60 40 255
100 120 78 42 255
"""
    path.write_text(content, encoding="utf-8")


def check_environment(dry_run: bool) -> None:
    run_cmd(["gdalinfo", "--version"])
    print(f"[ENV] supabase_url={'ok' if SUPABASE_URL else 'missing'} upload_key={'ok' if SUPABASE_KEY else 'missing'}")
    if not dry_run and (not SUPABASE_URL or not SUPABASE_KEY):
        raise RuntimeError(
            "Supabase upload config missing. Add SUPABASE_URL or EXPO_PUBLIC_SUPABASE_URL, "
            "and SUPABASE_SERVICE_KEY or SUPABASE_SERVICE_ROLE_KEY to .env, or pass --env-file."
        )


def translate_index_netcdf(index_nc: Path, species: str, tif_path: Path) -> None:
    ensure_exists(index_nc)
    variable_name = f"{species}_score"
    src = f"NETCDF:{index_nc}:{variable_name}"
    cmd = [
        "gdal_translate",
        "-of",
        "GTiff",
        "-ot",
        "Float32",
        "-a_srs",
        "EPSG:4326",
        "-co",
        "COMPRESS=DEFLATE",
        "-co",
        "PREDICTOR=2",
        "-co",
        "ZLEVEL=6",
        src,
        str(tif_path),
    ]
    run_cmd(cmd)


def rasterize_geojson(geojson_path: Path, tif_path: Path, step_deg: float) -> None:
    ensure_exists(geojson_path)
    cmd = [
        "gdal_rasterize",
        "-a",
        "score",
        "-of",
        "GTiff",
        "-tr",
        str(step_deg),
        str(step_deg),
        "-ot",
        "Float32",
        "-a_nodata",
        "0",
        "-co",
        "COMPRESS=DEFLATE",
        "-co",
        "PREDICTOR=2",
        "-co",
        "ZLEVEL=6",
        str(geojson_path),
        str(tif_path),
    ]
    run_cmd(cmd)


def colorize_tif(src_tif: Path, colormap_txt: Path, dst_tif: Path) -> None:
    cmd = ["gdaldem", "color-relief", str(src_tif), str(colormap_txt), str(dst_tif), "-alpha"]
    run_cmd(cmd)


def generate_xyz_tiles(color_tif: Path, tile_output_dir: Path, zooms: list[int], processes: int) -> None:
    cmd = [
        *find_gdal2tiles_cmd(),
        "--xyz",
        "-z",
        zooms_to_gdal_arg(zooms),
        "--processes",
        str(processes),
        "-w",
        "none",
        str(color_tif),
        str(tile_output_dir),
    ]
    run_cmd(cmd)


def iter_png_files(root: Path, zooms: Iterable[int] | None = None) -> Iterable[Path]:
    search_roots = [root]
    if zooms is not None:
        search_roots = [root / str(zoom) for zoom in sorted(set(zooms))]

    for search_root in search_roots:
        if not search_root.exists():
            continue
        for path in search_root.rglob("*.png"):
            if path.is_file():
                yield path


def env_int(name: str, default: int, minimum: int = 1) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return max(minimum, int(raw))
    except ValueError:
        return default


def upload_retry_delay(attempt: int) -> float:
    base = min(60.0, 2.0 ** min(attempt, 6))
    return base + random.uniform(0.0, 1.5)


def wait_for_supabase_dns(max_retries: int = 6) -> None:
    if not SUPABASE_URL:
        return
    parsed = urlparse(SUPABASE_URL)
    host = parsed.hostname
    if not host:
        raise RuntimeError(f"Invalid SUPABASE_URL: {SUPABASE_URL}")

    for attempt in range(1, max_retries + 1):
        try:
            socket.getaddrinfo(host, 443)
            return
        except socket.gaierror as exc:
            if attempt == max_retries:
                raise RuntimeError(f"Cannot resolve Supabase host after {max_retries} attempts: {host}") from exc
            delay = min(45.0, 3.0 * attempt) + random.uniform(0.0, 1.5)
            print(f"[DNS] Cannot resolve {host}, retry {attempt}/{max_retries} in {delay:.1f}s", flush=True)
            time.sleep(delay)


def upload_one_file(local_path: Path, remote_path: str, max_retries: int) -> tuple[bool, str]:
    url = f"{SUPABASE_URL}/storage/v1/object/{SUPABASE_BUCKET}/{remote_path}"
    headers = {
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "image/png",
        "x-upsert": "true",
    }

    for attempt in range(1, max_retries + 1):
        try:
            with local_path.open("rb") as f:
                resp = requests.post(url, headers=headers, data=f, timeout=120)
            if resp.status_code in (200, 201):
                return True, remote_path
            if resp.status_code in UPLOAD_RETRYABLE_STATUS_CODES and attempt < max_retries:
                time.sleep(upload_retry_delay(attempt))
                continue
            return False, f"{remote_path} HTTP {resp.status_code}: {resp.text[:500]}"
        except requests.RequestException as exc:
            if attempt < max_retries:
                time.sleep(upload_retry_delay(attempt))
                continue
            return False, f"{remote_path}: {type(exc).__name__}: {exc}"

    return False, f"{remote_path}: unknown upload error"


def upload_text_object(remote_path: str, body: str, content_type: str, max_retries: int = 6) -> None:
    url = f"{SUPABASE_URL}/storage/v1/object/{SUPABASE_BUCKET}/{remote_path}"
    headers = {
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": content_type,
        "x-upsert": "true",
    }
    payload = body.encode("utf-8")
    last_error = "unknown upload error"

    for attempt in range(1, max_retries + 1):
        try:
            resp = requests.post(url, headers=headers, data=payload, timeout=120)
            if resp.status_code in (200, 201):
                return
            last_error = f"HTTP {resp.status_code}: {resp.text[:500]}"
            if resp.status_code not in UPLOAD_RETRYABLE_STATUS_CODES:
                break
        except requests.RequestException as exc:
            last_error = f"{type(exc).__name__}: {exc}"

        if attempt < max_retries:
            delay = upload_retry_delay(attempt)
            print(
                f"[MANIFEST] Upload retry {attempt}/{max_retries} for {remote_path}: "
                f"{last_error} | retry in {delay:.1f}s",
                flush=True,
            )
            time.sleep(delay)

    raise RuntimeError(f"{remote_path} upload failed after {max_retries} attempts: {last_error}")


def fetch_public_text_object(remote_path: str) -> str | None:
    if not SUPABASE_URL:
        return None
    url = f"{SUPABASE_URL}/storage/v1/object/public/{SUPABASE_BUCKET}/{remote_path}?t={int(time.time())}"
    try:
        resp = requests.get(url, timeout=60)
    except requests.RequestException as exc:
        print(f"[MANIFEST] Cannot fetch remote {remote_path}: {type(exc).__name__}: {exc}")
        return None
    if resp.status_code != 200:
        print(f"[MANIFEST] Remote {remote_path} unavailable: HTTP {resp.status_code}")
        return None
    return resp.text


def parse_tile_set_dir_name(name: str) -> dict[str, object] | None:
    match = TILE_SET_DIR_REGEX.match(name)
    if not match:
        return None
    year, separator, month, day, version = match.groups()
    return {
        "date": f"{year}{separator}{month}{separator}{day}",
        "version": version,
        "name": f"{year}-{month}-{day}_v{version}",
        "year": int(year),
        "month": int(month),
        "day": int(day),
        "versionNum": int(version),
    }


def tile_set_datetime(item: dict[str, object]) -> datetime:
    return datetime(
        int(item["year"]),
        int(item["month"]),
        int(item["day"]),
        tzinfo=timezone.utc,
    )


def tile_set_sort_key(item: dict[str, object]) -> tuple[int, int, int, int]:
    return (
        int(item["year"]),
        int(item["month"]),
        int(item["day"]),
        int(item["versionNum"]),
    )


def public_tile_set_item(item: dict[str, object]) -> dict[str, str]:
    return {"date": str(item["date"]), "version": str(item["version"])}


def parse_manifest_tile_sets(raw: str | None) -> list[dict[str, object]]:
    if not raw:
        return []
    try:
        manifest = json.loads(raw)
    except json.JSONDecodeError as exc:
        print(f"[MANIFEST] Invalid remote manifest JSON: {exc}")
        return []
    tile_sets = manifest.get("tileSets")
    if not isinstance(tile_sets, list):
        return []

    parsed: list[dict[str, object]] = []
    for entry in tile_sets:
        if not isinstance(entry, dict):
            continue
        date = entry.get("date")
        version = entry.get("version")
        if not isinstance(date, str) or version is None:
            continue
        item = parse_tile_set_dir_name(f"{date}_v{version}")
        if item is not None:
            parsed.append(item)
    parsed.sort(key=tile_set_sort_key, reverse=True)
    return parsed


def build_tile_sets_manifest(tile_dir: Path, retention_days: int | None = None) -> str:
    tile_sets = []
    cutoff = None
    if retention_days is not None and retention_days > 0:
        cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    if tile_dir.is_dir():
        for child in tile_dir.iterdir():
            if not child.is_dir():
                continue
            parsed = parse_tile_set_dir_name(child.name)
            if parsed is None:
                continue
            if cutoff is not None and tile_set_datetime(parsed) < cutoff:
                continue
            if not any((child / species).is_dir() for species in DEFAULT_SPECIES):
                continue
            tile_sets.append(parsed)

    return build_manifest_json(tile_sets)


def build_manifest_json(tile_sets: list[dict[str, object]]) -> str:
    tile_sets.sort(key=tile_set_sort_key, reverse=True)
    public_tile_sets = [public_tile_set_item(item) for item in tile_sets]
    return json.dumps(
        {
            "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "tileSets": public_tile_sets,
        },
        ensure_ascii=True,
        separators=(",", ":"),
    )


def upload_tile_sets_manifest(tile_dir: Path, retention_days: int | None = None) -> None:
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError("Supabase upload config missing; cannot upload tile_sets.json")
    manifest = build_tile_sets_manifest(tile_dir, retention_days=retention_days)
    upload_text_object(MANIFEST_OBJECT, manifest, "application/json; charset=utf-8")
    print(f"[MANIFEST] Uploaded {MANIFEST_OBJECT}")


def upload_manifest_from_tile_sets(tile_sets: list[dict[str, object]]) -> None:
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError(f"Supabase upload config missing; cannot upload {MANIFEST_OBJECT}")
    manifest = build_manifest_json(tile_sets)
    upload_text_object(MANIFEST_OBJECT, manifest, "application/json; charset=utf-8")
    print(f"[MANIFEST] Uploaded {MANIFEST_OBJECT} ({len(tile_sets)} tile sets)")


def supabase_headers(content_type: str = "application/json") -> dict[str, str]:
    return {
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "apikey": str(SUPABASE_KEY),
        "Content-Type": content_type,
    }


def list_storage_prefix(prefix: str, limit: int = 1000) -> list[dict[str, object]]:
    url = f"{SUPABASE_URL}/storage/v1/object/list/{SUPABASE_BUCKET}"
    offset = 0
    out: list[dict[str, object]] = []
    clean_prefix = prefix.strip("/")
    while True:
        payload = {"prefix": clean_prefix, "limit": limit, "offset": offset}
        page = None
        last_error = None
        for attempt in range(1, 7):
            try:
                resp = requests.post(url, headers=supabase_headers(), json=payload, timeout=120)
                if resp.status_code != 200:
                    last_error = f"HTTP {resp.status_code}: {resp.text[:500]}"
                else:
                    page = resp.json()
                    break
            except (requests.RequestException, ValueError) as exc:
                last_error = f"{type(exc).__name__}: {exc}"
            delay = min(30.0, 2.0 * attempt) + random.uniform(0.0, 1.0)
            print(
                f"[TILE CLEANUP] list retry {attempt}/6 prefix='{clean_prefix}' "
                f"offset={offset}: {last_error} | retry in {delay:.1f}s",
                flush=True,
            )
            time.sleep(delay)
        if page is None:
            raise RuntimeError(f"List prefix '{clean_prefix}' failed after retries: {last_error}")
        if not isinstance(page, list):
            raise RuntimeError(f"List prefix '{clean_prefix}' returned unexpected payload: {type(page).__name__}")
        out.extend(item for item in page if isinstance(item, dict))
        if len(page) < limit:
            break
        offset += limit
    return out


def join_storage_path(prefix: str, name: str) -> str:
    if "/" in name:
        return name.strip("/")
    clean_prefix = prefix.strip("/")
    return f"{clean_prefix}/{name}".strip("/")


def is_storage_file(item: dict[str, object]) -> bool:
    metadata = item.get("metadata")
    return isinstance(metadata, dict) and "size" in metadata


def list_storage_files_recursive(prefix: str) -> list[str]:
    files: list[str] = []
    stack = [prefix.strip("/")]
    while stack:
        current = stack.pop()
        for item in list_storage_prefix(current):
            name = item.get("name")
            if not isinstance(name, str) or not name:
                continue
            path = join_storage_path(current, name)
            if is_storage_file(item):
                files.append(path)
            else:
                stack.append(path)
    return sorted(set(files))


def list_remote_tile_sets_from_root() -> list[dict[str, object]]:
    tile_sets_by_name: dict[str, dict[str, object]] = {}
    for item in list_storage_prefix(""):
        name = item.get("name")
        if not isinstance(name, str) or not name:
            continue
        if is_storage_file(item):
            continue
        parsed = parse_tile_set_dir_name(name)
        if parsed is None:
            continue
        tile_sets_by_name[str(parsed["name"])] = parsed

    tile_sets = list(tile_sets_by_name.values())
    tile_sets.sort(key=tile_set_sort_key, reverse=True)
    return tile_sets


def delete_storage_objects(paths: list[str], batch_size: int = 1000) -> int:
    if not paths:
        return 0
    url = f"{SUPABASE_URL}/storage/v1/object/{SUPABASE_BUCKET}"
    deleted = 0
    for start in range(0, len(paths), batch_size):
        batch = paths[start:start + batch_size]
        resp = requests.delete(url, headers=supabase_headers(), json={"prefixes": batch}, timeout=120)
        if resp.status_code != 200:
            raise RuntimeError(f"Delete objects HTTP {resp.status_code}: {resp.text[:500]}")
        deleted += len(batch)
        print(f"[TILE CLEANUP] deleted {deleted}/{len(paths)} objects", flush=True)
    return deleted


def cleanup_remote_tile_sets(retention_days: int, dry_run: bool) -> list[str]:
    if retention_days <= 0:
        print("[TILE CLEANUP] skipped: retention_days <= 0")
        return []
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError("Supabase config missing; cannot clean remote tiles")

    tile_sets = list_remote_tile_sets_from_root()
    if not tile_sets:
        print("[TILE CLEANUP] No valid remote tile set directories; nothing to delete")
        if not dry_run:
            upload_manifest_from_tile_sets([])
        return []

    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    expired = [item for item in tile_sets if tile_set_datetime(item) < cutoff]
    kept = [item for item in tile_sets if item not in expired]

    print(
        f"[TILE CLEANUP] retention={retention_days} days | "
        f"remote_dirs={len(tile_sets)} kept={len(kept)} expired={len(expired)}"
    )

    removed: list[str] = []
    for item in expired:
        prefix = str(item["name"])
        print(f"[TILE CLEANUP] expired tile set: {prefix}")
        if dry_run:
            removed.append(prefix)
            continue
        files = list_storage_files_recursive(prefix)
        print(f"[TILE CLEANUP] {prefix}: remote files={len(files)}")
        if files:
            delete_storage_objects(files)
        removed.append(prefix)

    if not dry_run:
        upload_manifest_from_tile_sets(kept)
    else:
        print("[TILE CLEANUP] dry run: file listing, storage delete and manifest upload skipped")
    return removed


def parse_iso_date(value: str, label: str) -> datetime:
    try:
        return datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise ValueError(f"{label} must be YYYY-MM-DD, got: {value}") from exc


def cleanup_remote_tile_sets_by_date_range(date_from: str, date_to: str, dry_run: bool) -> list[str]:
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError("Supabase config missing; cannot clean remote tiles")

    start = parse_iso_date(date_from, "--delete-date-from")
    end = parse_iso_date(date_to, "--delete-date-to")
    if end < start:
        raise ValueError("--delete-date-to must be greater than or equal to --delete-date-from")

    tile_sets = list_remote_tile_sets_from_root()
    if not tile_sets:
        print("[TILE CLEANUP] No valid remote tile set directories; nothing to delete")
        if not dry_run:
            upload_manifest_from_tile_sets([])
        return []

    expired = [
        item
        for item in tile_sets
        if start <= tile_set_datetime(item) <= end
    ]
    kept = [item for item in tile_sets if item not in expired]

    print(
        f"[TILE CLEANUP] date range={date_from}..{date_to} | "
        f"remote_dirs={len(tile_sets)} kept={len(kept)} matched={len(expired)}"
    )

    removed: list[str] = []
    for item in expired:
        prefix = str(item["name"])
        print(f"[TILE CLEANUP] matched tile set: {prefix}")
        if dry_run:
            removed.append(prefix)
            continue
        files = list_storage_files_recursive(prefix)
        print(f"[TILE CLEANUP] {prefix}: remote files={len(files)}")
        if files:
            delete_storage_objects(files)
        removed.append(prefix)

    if not dry_run:
        upload_manifest_from_tile_sets(kept)
    else:
        print("[TILE CLEANUP] dry run: file listing, storage delete and manifest upload skipped")
    return removed


def upload_tiles_to_supabase(
    date: str,
    version: str,
    species: str,
    species_tile_dir: Path,
    workers: int,
    zooms: list[int] | None = None,
) -> None:
    png_files = sorted(iter_png_files(species_tile_dir, zooms=zooms))
    total = len(png_files)
    if total == 0:
        zoom_suffix = f" for zooms {zooms}" if zooms is not None else ""
        raise RuntimeError(f"No PNG tiles found in {species_tile_dir}{zoom_suffix}")

    max_file_retries = env_int("SUPABASE_UPLOAD_FILE_RETRIES", 10)
    max_rounds = env_int("SUPABASE_UPLOAD_ROUNDS", 3)
    round_delay = env_int("SUPABASE_UPLOAD_ROUND_DELAY_SECONDS", 30, minimum=0)
    pending = [
        (local_path, f"{date}_v{version}/{species}/{local_path.relative_to(species_tile_dir).as_posix()}")
        for local_path in png_files
    ]
    ok_count = 0
    failures: list[str] = []

    print(
        f"\n[UPLOAD] {species}: {total} PNG tiles "
        f"(zooms={zooms or 'all'}, workers={workers}, file_retries={max_file_retries}, rounds={max_rounds})"
    )

    compact = compact_logs_enabled()
    for round_no in range(1, max_rounds + 1):
        wait_for_supabase_dns()
        round_total = len(pending)
        round_failures: list[tuple[Path, str, str]] = []
        if round_no > 1 or not compact:
            print(f"[UPLOAD] {species}: round {round_no}/{max_rounds}, pending={round_total}", flush=True)

        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(upload_one_file, local_path, remote_path, max_file_retries): (local_path, remote_path)
                for local_path, remote_path in pending
            }

            for done, future in enumerate(as_completed(futures), start=1):
                local_path, remote_path = futures[future]
                ok, msg = future.result()
                if ok:
                    ok_count += 1
                else:
                    round_failures.append((local_path, remote_path, msg))
                    print(f"[FAIL] {msg}")
                if not compact and (done % 250 == 0 or done == round_total):
                    print(
                        f"  round={round_no} {done}/{round_total} total_ok={ok_count} "
                        f"round_fail={len(round_failures)}",
                        flush=True,
                    )

        if not round_failures:
            failures = []
            pending = []
            print(f"[UPLOAD] {species}: ok={ok_count}/{total}")
            break

        failures = [msg for _, _, msg in round_failures]
        pending = [(local_path, remote_path) for local_path, remote_path, _ in round_failures]
        if round_no < max_rounds:
            delay = round_delay * round_no
            print(f"[UPLOAD] {species}: retrying {len(pending)} failed tiles in {delay}s", flush=True)
            time.sleep(delay)

    if pending:
        failure_path = species_tile_dir.parent / f"{species}_upload_failures.txt"
        failure_path.write_text("\n".join(failures), encoding="utf-8")
        raise RuntimeError(f"Upload incomplete for {species}. Failure log: {failure_path}")


def build_species_tiles(
    date: str,
    version: str,
    species: str,
    source_mode: str,
    index_nc: Path,
    source_lod: int,
    zooms: list[int],
    geojson_dir: Path,
    work_dir: Path,
    tile_dir: Path,
    gdal_processes: int,
    upload_workers: int,
    dry_run: bool,
    keep_intermediate: bool,
    keep_existing_tiles: bool,
) -> None:
    species_work_dir = work_dir / f"{date}_v{version}" / species
    species_tile_dir = tile_dir / f"{date}_v{version}" / species
    species_work_dir.mkdir(parents=True, exist_ok=True)
    if keep_existing_tiles:
        species_tile_dir.mkdir(parents=True, exist_ok=True)
        for zoom in sorted(set(zooms)):
            clean_dir(species_tile_dir / str(zoom))
    else:
        clean_dir(species_tile_dir)

    raw_tif = species_work_dir / f"{species}_score.tif"
    color_tif = species_work_dir / f"{species}_color.tif"
    colormap_txt = species_work_dir / "funghi_colormap.txt"

    print(
        f"\n[TILES] species={species} source={source_mode} zooms={zooms} "
        f"keep_existing={keep_existing_tiles}"
    )

    write_colormap_file(colormap_txt)

    print("[1/4] Build score GeoTIFF")
    if source_mode == "index-nc":
        translate_index_netcdf(index_nc, species, raw_tif)
    else:
        if source_lod not in LOD_STEPS:
            raise ValueError(f"Unsupported source LOD: {source_lod}")
        geojson_path = geojson_dir / f"{species}_lod{source_lod}.geojson"
        rasterize_geojson(geojson_path, raw_tif, LOD_STEPS[source_lod])

    print("[2/4] Apply RGBA colormap")
    colorize_tif(raw_tif, colormap_txt, color_tif)

    print("[3/4] Generate XYZ tiles")
    generate_xyz_tiles(color_tif, species_tile_dir, zooms, gdal_processes)

    if dry_run:
        print(f"[4/4] Dry run: upload skipped. Tiles at {species_tile_dir.resolve()}")
    else:
        print("[4/4] Upload Supabase")
        upload_zooms = zooms if keep_existing_tiles else None
        upload_tiles_to_supabase(date, version, species, species_tile_dir, upload_workers, zooms=upload_zooms)

    if not keep_intermediate:
        for path in (raw_tif, color_tif, colormap_txt):
            if path.exists():
                path.unlink()


def main() -> None:
    parser = argparse.ArgumentParser(description="Build and upload mushroom index XYZ tiles.")
    parser.add_argument("--date", default=None, help="Dataset date YYYY-MM-DD")
    parser.add_argument("--version", default="1", help="Dataset version used in tile path")
    parser.add_argument("--species", nargs="+", choices=DEFAULT_SPECIES, default=DEFAULT_SPECIES)
    parser.add_argument("--source-mode", choices=["index-nc", "geojson"], default="index-nc")
    parser.add_argument("--index-nc", default=None)
    parser.add_argument("--source-lod", type=int, default=2)
    parser.add_argument("--zoom", nargs="+", type=int, default=DEFAULT_ZOOMS)
    parser.add_argument("--geojson-dir", default=str(ROOT_DIR / "backend" / "outputs" / "index_geojson"))
    parser.add_argument("--work-dir", default=str(TMP_GDAL_DIR))
    parser.add_argument("--tile-dir", default=str(OUT_TILES_DIR))
    parser.add_argument("--gdal-processes", type=int, default=max(1, (os.cpu_count() or 4) // 2))
    parser.add_argument("--upload-workers", type=int, default=8)
    parser.add_argument("--env-file", default=None)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--upload-only", action="store_true", help="Upload existing local tiles without rebuilding them.")
    parser.add_argument(
        "--keep-existing-tiles",
        action="store_true",
        help="Preserve existing local zoom folders and rebuild/upload only the zooms passed with --zoom.",
    )
    parser.add_argument("--manifest-only", action="store_true", help="Only rebuild and upload tile_sets.json from local tile directories.")
    parser.add_argument("--cleanup-only", action="store_true", help="Only delete remote tile sets older than the retention window and update tile_sets.json.")
    parser.add_argument("--retention-days", type=int, default=DEFAULT_TILE_RETENTION_DAYS)
    parser.add_argument("--delete-date-from", default=None, help="With --cleanup-only, delete remote tile sets from this date included, YYYY-MM-DD.")
    parser.add_argument("--delete-date-to", default=None, help="With --cleanup-only, delete remote tile sets up to this date included, YYYY-MM-DD.")
    parser.add_argument("--keep-intermediate", action="store_true")
    args = parser.parse_args()

    refresh_env(args.env_file)
    geojson_dir = Path(args.geojson_dir)
    work_dir = Path(args.work_dir)
    tile_dir = Path(args.tile_dir)

    if args.cleanup_only:
        if args.delete_date_from or args.delete_date_to:
            if not args.delete_date_from or not args.delete_date_to:
                raise SystemExit("--delete-date-from and --delete-date-to must be used together")
            removed = cleanup_remote_tile_sets_by_date_range(
                args.delete_date_from,
                args.delete_date_to,
                dry_run=args.dry_run,
            )
        else:
            removed = cleanup_remote_tile_sets(args.retention_days, dry_run=args.dry_run)
        print(f"\nDone. Removed tile sets: {removed}")
        return

    if args.manifest_only:
        work_dir.mkdir(parents=True, exist_ok=True)
        tile_dir.mkdir(parents=True, exist_ok=True)
        upload_tile_sets_manifest(tile_dir, retention_days=args.retention_days)
        print("\nDone")
        return

    if not args.date:
        raise SystemExit("--date is required unless --manifest-only is used")

    index_nc = Path(args.index_nc) if args.index_nc else Path(str(INDEX_OUTPUT_TEMPLATE).format(date=args.date))

    if args.upload_only:
        pass
    elif args.source_mode == "index-nc":
        ensure_exists(index_nc)
    else:
        ensure_exists(geojson_dir, "dir")
    work_dir.mkdir(parents=True, exist_ok=True)
    tile_dir.mkdir(parents=True, exist_ok=True)

    print("BUILD FUNGI INDEX TILES")
    print(
        f"tile_set={args.date}_v{args.version} species={args.species} zooms={args.zoom} "
        f"source={args.source_mode} dry_run={args.dry_run} upload_only={args.upload_only}"
    )

    check_environment(dry_run=args.dry_run)

    if args.upload_only:
        if args.dry_run:
            raise SystemExit("--upload-only cannot be combined with --dry-run")
        for species in args.species:
            species_tile_dir = tile_dir / f"{args.date}_v{args.version}" / species
            ensure_exists(species_tile_dir, "dir")
            upload_zooms = args.zoom if args.keep_existing_tiles else None
            upload_tiles_to_supabase(
                args.date,
                args.version,
                species,
                species_tile_dir,
                args.upload_workers,
                zooms=upload_zooms,
            )
        upload_tile_sets_manifest(tile_dir, retention_days=args.retention_days)
        print("\nDone")
        return

    for species in args.species:
        build_species_tiles(
            date=args.date,
            version=args.version,
            species=species,
            source_mode=args.source_mode,
            index_nc=index_nc,
            source_lod=args.source_lod,
            zooms=args.zoom,
            geojson_dir=geojson_dir,
            work_dir=work_dir,
            tile_dir=tile_dir,
            gdal_processes=args.gdal_processes,
            upload_workers=args.upload_workers,
            dry_run=args.dry_run,
            keep_intermediate=args.keep_intermediate,
            keep_existing_tiles=args.keep_existing_tiles,
        )

    if not args.dry_run:
        upload_tile_sets_manifest(tile_dir, retention_days=args.retention_days)

    print("\nDone")


if __name__ == "__main__":
    main()
