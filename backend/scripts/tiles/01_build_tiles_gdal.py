from __future__ import annotations

import argparse
import os
import random
import shutil
import socket
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Iterable
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv

from backend.config.index_config import INDEX_OUTPUT_TEMPLATE
from backend.config.paths import OUT_TILES_DIR, TMP_GDAL_DIR


ROOT_DIR = Path(__file__).resolve().parents[3]
SUPABASE_BUCKET = "tiles"
DEFAULT_SPECIES = ["porcini", "finferli"]
DEFAULT_ZOOMS = list(range(8, 15))
LOD_STEPS = {2: 0.003, 3: 0.008, 4: 0.02, 5: 0.05, 6: 0.12}
UPLOAD_RETRYABLE_STATUS_CODES = {408, 409, 425, 429, 500, 502, 503, 504}

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
    print("\n[CMD]", " ".join(str(c) for c in cmd), flush=True)
    result = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        text=True,
        capture_output=True,
    )
    if result.stdout.strip():
        print(result.stdout)
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
5   255 255 255 0
15  180 230 255 40
30  100 200 255 90
45  80 180 90 140
60  255 230 70 185
75  255 120 60 225
90  210 60 40 245
100 120 78 42 255
"""
    path.write_text(content, encoding="utf-8")


def check_environment(dry_run: bool) -> None:
    run_cmd(["gdalinfo", "--version"])
    run_cmd([*find_gdal2tiles_cmd(), "--help"])
    print(f"[ENV] Supabase URL        : {'ok' if SUPABASE_URL else 'missing'}")
    print(f"[ENV] Supabase upload key : {'ok' if SUPABASE_KEY else 'missing'}")
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


def iter_png_files(root: Path) -> Iterable[Path]:
    for path in root.rglob("*.png"):
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


def upload_tiles_to_supabase(date: str, version: str, species: str, species_tile_dir: Path, workers: int) -> None:
    png_files = sorted(iter_png_files(species_tile_dir))
    total = len(png_files)
    if total == 0:
        raise RuntimeError(f"No PNG tiles found in {species_tile_dir}")

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
        f"(workers={workers}, file_retries={max_file_retries}, rounds={max_rounds})"
    )

    for round_no in range(1, max_rounds + 1):
        wait_for_supabase_dns()
        round_total = len(pending)
        round_failures: list[tuple[Path, str, str]] = []
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
                if done % 250 == 0 or done == round_total:
                    print(
                        f"  round={round_no} {done}/{round_total} total_ok={ok_count} "
                        f"round_fail={len(round_failures)}",
                        flush=True,
                    )

        if not round_failures:
            failures = []
            pending = []
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
) -> None:
    species_work_dir = work_dir / f"{date}_v{version}" / species
    species_tile_dir = tile_dir / f"{date}_v{version}" / species
    species_work_dir.mkdir(parents=True, exist_ok=True)
    clean_dir(species_tile_dir)

    raw_tif = species_work_dir / f"{species}_score.tif"
    color_tif = species_work_dir / f"{species}_color.tif"
    colormap_txt = species_work_dir / "funghi_colormap.txt"

    print("\n" + "=" * 72)
    print(f"[{species.upper()}] source={source_mode} zooms={zooms}")
    print(f"Work dir : {species_work_dir}")
    print(f"Tiles dir: {species_tile_dir}")
    print("=" * 72)

    write_colormap_file(colormap_txt)

    print("\n[1/4] Build score GeoTIFF")
    if source_mode == "index-nc":
        translate_index_netcdf(index_nc, species, raw_tif)
    else:
        if source_lod not in LOD_STEPS:
            raise ValueError(f"Unsupported source LOD: {source_lod}")
        geojson_path = geojson_dir / f"{species}_lod{source_lod}.geojson"
        rasterize_geojson(geojson_path, raw_tif, LOD_STEPS[source_lod])

    print("\n[2/4] Apply RGBA colormap")
    colorize_tif(raw_tif, colormap_txt, color_tif)

    print("\n[3/4] Generate XYZ tiles")
    generate_xyz_tiles(color_tif, species_tile_dir, zooms, gdal_processes)

    if dry_run:
        print(f"\n[4/4] Dry run: upload skipped. Tiles at {species_tile_dir.resolve()}")
    else:
        print("\n[4/4] Upload Supabase")
        upload_tiles_to_supabase(date, version, species, species_tile_dir, upload_workers)

    if not keep_intermediate:
        for path in (raw_tif, color_tif, colormap_txt):
            if path.exists():
                path.unlink()


def main() -> None:
    parser = argparse.ArgumentParser(description="Build and upload mushroom index XYZ tiles.")
    parser.add_argument("--date", required=True, help="Dataset date YYYY-MM-DD")
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
    parser.add_argument("--keep-intermediate", action="store_true")
    args = parser.parse_args()

    refresh_env(args.env_file)
    index_nc = Path(args.index_nc) if args.index_nc else Path(str(INDEX_OUTPUT_TEMPLATE).format(date=args.date))
    geojson_dir = Path(args.geojson_dir)
    work_dir = Path(args.work_dir)
    tile_dir = Path(args.tile_dir)

    if args.upload_only:
        pass
    elif args.source_mode == "index-nc":
        ensure_exists(index_nc)
    else:
        ensure_exists(geojson_dir, "dir")
    work_dir.mkdir(parents=True, exist_ok=True)
    tile_dir.mkdir(parents=True, exist_ok=True)

    print("=" * 72)
    print("BUILD FUNGI INDEX TILES")
    print(f"Date/version  : {args.date}_v{args.version}")
    print(f"Species       : {args.species}")
    print(f"Source mode   : {args.source_mode}")
    print(f"Index NetCDF  : {index_nc.resolve() if args.source_mode == 'index-nc' else '[unused]'}")
    print(f"Zooms         : {args.zoom}")
    print(f"Tile dir      : {tile_dir.resolve()}")
    print(f"Dry run       : {args.dry_run}")
    print(f"Upload only   : {args.upload_only}")
    print("=" * 72)

    check_environment(dry_run=args.dry_run)

    if args.upload_only:
        if args.dry_run:
            raise SystemExit("--upload-only cannot be combined with --dry-run")
        for species in args.species:
            species_tile_dir = tile_dir / f"{args.date}_v{args.version}" / species
            ensure_exists(species_tile_dir, "dir")
            upload_tiles_to_supabase(args.date, args.version, species, species_tile_dir, args.upload_workers)
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
        )

    print("\nDone")


if __name__ == "__main__":
    main()
