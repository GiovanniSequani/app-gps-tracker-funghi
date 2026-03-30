"""
build_tiles_gdal.py
===================

Nuova pipeline tile basata su GDAL.

Flusso:
    GeoJSON (LOD sorgente, default lod2)
    -> GeoTIFF grayscale
    -> GeoTIFF colorato RGBA
    -> tiles XYZ PNG
    -> upload su Supabase

Uso tipico:
    python build_tiles_gdal.py --species porcini
    python build_tiles_gdal.py --species finferli
    python build_tiles_gdal.py
    python build_tiles_gdal.py --dry-run
    python build_tiles_gdal.py --zoom 8 9 10 11 12 13 14

Prerequisiti:
    - GDAL installato e disponibile nel PATH
    - Python con osgeo_utils.gdal2tiles disponibile
    - .env con:
        SUPABASE_URL=...
        SUPABASE_SERVICE_KEY=...

Note:
    - Questo script usa come sorgente SOLO il GeoJSON di un LOD, di default lod2.
    - L'output finale su Supabase è nel formato standard:
        tiles/{species}/{z}/{x}/{y}.png
"""

from __future__ import annotations

import argparse
import os
import time
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Iterable
import requests
from dotenv import load_dotenv


# ──────────────────────────────────────────────────────────────────────────────
# Config
# ──────────────────────────────────────────────────────────────────────────────

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY")
SUPABASE_BUCKET = "tiles"

DEFAULT_SPECIES = ["porcini", "finferli"]
DEFAULT_ZOOMS = list(range(8, 15))

DATE = '2026-03-30'
VERSION = '1'

# Step del LOD sorgente. Per ora useremo lod2 come base finale.
LOD_STEPS = {
    2: 0.003,
    3: 0.008,
    4: 0.02,
    5: 0.05,
    6: 0.12,
}


# ──────────────────────────────────────────────────────────────────────────────
# Utilità
# ──────────────────────────────────────────────────────────────────────────────

def run_cmd(cmd: list[str], cwd: Path | None = None) -> None:
    """Esegue un comando e fallisce con errore chiaro se qualcosa va storto."""
    print("\n[CMD]", " ".join(str(c) for c in cmd))
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
        raise RuntimeError(f"Comando fallito con exit code {result.returncode}")


def ensure_exists(path: Path, kind: str = "file") -> None:
    if kind == "file" and not path.is_file():
        raise FileNotFoundError(f"File non trovato: {path}")
    if kind == "dir" and not path.is_dir():
        raise FileNotFoundError(f"Directory non trovata: {path}")


def clean_dir(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def zooms_to_gdal_arg(zooms: list[int]) -> str:
    """
    Converte una lista di zoom in stringa per gdal2tiles.
    Esempi:
        [8,9,10,11,12,13,14] -> "8-14"
        [8,10,11,13] -> "8,10-11,13"
    """
    if not zooms:
        raise ValueError("Lista zoom vuota")

    zooms = sorted(set(zooms))
    ranges = []
    start = prev = zooms[0]

    for z in zooms[1:]:
        if z == prev + 1:
            prev = z
            continue
        ranges.append((start, prev))
        start = prev = z

    ranges.append((start, prev))

    parts = []
    for a, b in ranges:
        parts.append(str(a) if a == b else f"{a}-{b}")
    return ",".join(parts)


def write_colormap_file(path: Path) -> None:
    """
    Colormap richiesta:
    bianco -> azzurro -> verde -> giallo -> rosso -> marrone

    Nota:
    - 'nv' e score 0 hanno alpha 0, quindi background trasparente.
    - Il resto cresce gradualmente come opacità.
    """
    content = """nv 255 255 255 0
0   255 255 255 0
5   255 255 255 40
15  180 230 255 90
30  100 200 255 120
45  80 180 90 145
60  255 230 70 175
75  255 120 60 205
90  210 60 40 225
100 120 78 42 235
"""
    path.write_text(content, encoding="utf-8")


def check_environment(dry_run: bool) -> None:
    """Controlli minimi su GDAL e credenziali."""
    try:
        run_cmd(["gdalinfo", "--version"])
    except Exception as e:
        raise RuntimeError(
            "GDAL non disponibile nel PATH. Verifica che gdalinfo funzioni dal terminale."
        ) from e

    try:
        run_cmd([sys.executable, "-m", "osgeo_utils.gdal2tiles", "--help"])
    except Exception as e:
        raise RuntimeError(
            "gdal2tiles non disponibile nel Python corrente. "
            "Lancia lo script con il Python corretto (quello che vede osgeo_utils)."
        ) from e

    if not dry_run:
        if not SUPABASE_URL or not SUPABASE_KEY:
            raise RuntimeError(
                "SUPABASE_URL o SUPABASE_SERVICE_KEY mancanti nel .env"
            )


# ──────────────────────────────────────────────────────────────────────────────
# GDAL pipeline
# ──────────────────────────────────────────────────────────────────────────────

def rasterize_geojson(
    geojson_path: Path,
    tif_path: Path,
    step_deg: float,
) -> None:
    """
    Rasterizza il GeoJSON usando il campo 'score'.

    Salviamo in Float32 per preservare i decimali in questa fase.
    """
    cmd = [
        "gdal_rasterize",
        "-a", "score",
        "-of", "GTiff",
        "-tr", str(step_deg), str(step_deg),
        "-ot", "Float32",
        "-a_nodata", "0",
        "-co", "COMPRESS=DEFLATE",
        "-co", "PREDICTOR=2",
        "-co", "ZLEVEL=6",
        str(geojson_path),
        str(tif_path),
    ]
    run_cmd(cmd)


def colorize_tif(
    src_tif: Path,
    colormap_txt: Path,
    dst_tif: Path,
) -> None:
    """
    Applica la colormap e produce un TIFF RGBA con alpha.
    """
    cmd = [
        "gdaldem",
        "color-relief",
        str(src_tif),
        str(colormap_txt),
        str(dst_tif),
        "-alpha",
    ]
    run_cmd(cmd)


def generate_xyz_tiles(
    color_tif: Path,
    tile_output_dir: Path,
    zooms: list[int],
    processes: int,
) -> None:
    """
    Genera tiles XYZ nel formato:
        tile_output_dir/{z}/{x}/{y}.png
    """
    z_arg = zooms_to_gdal_arg(zooms)

    cmd = [
        sys.executable,
        "-m",
        "osgeo_utils.gdal2tiles",
        "--xyz",
        "-z", z_arg,
        "--processes", str(processes),
        "-w", "none",
        str(color_tif),
        str(tile_output_dir),
    ]
    run_cmd(cmd)


# ──────────────────────────────────────────────────────────────────────────────
# Upload Supabase
# ──────────────────────────────────────────────────────────────────────────────

def upload_one_file(
    local_path: Path,
    remote_path: str,
    max_retries: int = 10,
) -> tuple[bool, str]:
    """
    Carica un file nel bucket tiles.
    Restituisce (ok, msg).
    """
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

            # retry solo su errori temporanei
            if resp.status_code in (408, 409, 425, 429, 500, 502, 503, 504):
                if attempt < max_retries:
                    time.sleep(1.5 * attempt)
                    continue

            return False, f"{remote_path} HTTP {resp.status_code}: {resp.text[:500]}"

        except requests.RequestException as e:
            if attempt < max_retries:
                time.sleep(1.5 * attempt)
                continue
            return False, f"{remote_path}: {type(e).__name__}: {e}"

    return False, f"{remote_path}: errore sconosciuto"


def iter_png_files(root: Path) -> Iterable[Path]:
    for path in root.rglob("*.png"):
        if path.is_file():
            yield path


def upload_tiles_to_supabase(
    species: str,
    species_tile_dir: Path,
    workers: int,
) -> None:
    global DATE, VERSION

    ensure_exists(species_tile_dir, "dir")

    png_files = list(iter_png_files(species_tile_dir))
    total = len(png_files)
    if total == 0:
        print(f"[WARN] Nessuna tile PNG trovata in {species_tile_dir}")
        return

    print(f"\n[UPLOAD] {species}: {total} tile da caricare su Supabase...")

    ok_count = 0
    fail_count = 0
    failures: list[str] = []

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {}
        for local_path in png_files:
            rel = local_path.relative_to(species_tile_dir).as_posix()
            remote_path = f"{DATE}_v{VERSION}/{species}/{rel}"
            future = executor.submit(upload_one_file, local_path, remote_path)
            futures[future] = remote_path

        done = 0
        for future in as_completed(futures):
            done += 1
            ok, msg = future.result()
            if ok:
                ok_count += 1
            else:
                fail_count += 1
                failures.append(msg)
                print(f"[FAIL] {msg}")

            if done % 250 == 0 or done == total:
                print(f"  {done}/{total}... ok={ok_count}, fail={fail_count}", flush=True)

    if failures:
        err_file = species_tile_dir.parent / f"{species}_upload_failures.txt"
        err_file.write_text("\n".join(failures), encoding="utf-8")
        print(f"\n[UPLOAD ERRORS] salvati in: {err_file}")

    if fail_count > 0:
        raise RuntimeError(
            f"Upload incompleto per {species}: {ok_count} ok, {fail_count} fallite"
        )

    print(f"[UPLOAD OK] {species}: {ok_count} tile caricate")


# ──────────────────────────────────────────────────────────────────────────────
# Main pipeline
# ──────────────────────────────────────────────────────────────────────────────

def build_species_tiles(
    species: str,
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
    
    global DATE, VERSION

    if source_lod not in LOD_STEPS:
        raise ValueError(f"LOD sorgente non supportato: {source_lod}")

    step_deg = LOD_STEPS[source_lod]

    geojson_path = geojson_dir / f"{species}_lod{source_lod}.geojson"
    ensure_exists(geojson_path, "file")

    species_work_dir = work_dir / species
    species_tile_dir = tile_dir / f'{DATE}_v{VERSION}' / species
    species_work_dir.mkdir(parents=True, exist_ok=True)
    clean_dir(species_tile_dir)

    raw_tif = species_work_dir / f"{species}_lod{source_lod}.tif"
    color_tif = species_work_dir / f"{species}_lod{source_lod}_color.tif"
    colormap_txt = species_work_dir / "funghi_colormap.txt"

    print("\n" + "=" * 70)
    print(f"[{species.upper()}]")
    print(f"GeoJSON sorgente : {geojson_path}")
    print(f"LOD sorgente     : {source_lod}")
    print(f"Step raster      : {step_deg}")
    print(f"Zoom             : {zooms}")
    print(f"Tile output dir  : {species_tile_dir}")
    print("=" * 70)

    write_colormap_file(colormap_txt)

    print("\n[1/4] Rasterizzazione GeoJSON -> TIFF...")
    rasterize_geojson(geojson_path, raw_tif, step_deg)

    print("\n[2/4] Applicazione colormap...")
    colorize_tif(raw_tif, colormap_txt, color_tif)

    print("\n[3/4] Generazione tiles XYZ...")
    generate_xyz_tiles(color_tif, species_tile_dir, zooms, gdal_processes)

    if dry_run:
        print(f"\n[4/4] Dry run: upload saltato. Tile locali in: {species_tile_dir.resolve()}")
    else:
        print("\n[4/4] Upload su Supabase...")
        upload_tiles_to_supabase(species, species_tile_dir, upload_workers)

    if not keep_intermediate:
        for path in (raw_tif, color_tif, colormap_txt):
            if path.exists():
                path.unlink()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--species", nargs="+", choices=DEFAULT_SPECIES)
    parser.add_argument("--source-lod", type=int, default=2,
                        help="LOD GeoJSON sorgente da usare come base finale (default: 2)")
    parser.add_argument("--zoom", nargs="+", type=int, default=DEFAULT_ZOOMS,
                        help="Lista zoom da generare (default: 8 9 10 11 12 13 14)")
    parser.add_argument("--geojson-dir", default="output")
    parser.add_argument("--work-dir", default="tmp_gdal")
    parser.add_argument("--tile-dir", default="tiles_local")
    parser.add_argument("--gdal-processes", type=int, default=os.cpu_count() or 4,
                        help="Numero processi per gdal2tiles")
    parser.add_argument("--upload-workers", type=int, default=8,
                        help="Numero worker per upload Supabase")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--keep-intermediate", action="store_true")
    args = parser.parse_args()

    species_list = args.species if args.species else DEFAULT_SPECIES
    geojson_dir = Path(args.geojson_dir)
    work_dir = Path(args.work_dir)
    tile_dir = Path(args.tile_dir)

    ensure_exists(geojson_dir, "dir")
    work_dir.mkdir(parents=True, exist_ok=True)
    tile_dir.mkdir(parents=True, exist_ok=True)

    print("=" * 70)
    print("BUILD TILES GDAL")
    print(f"Specie           : {species_list}")
    print(f"Source LOD       : {args.source_lod}")
    print(f"Zoom             : {args.zoom}")
    print(f"GeoJSON dir      : {geojson_dir.resolve()}")
    print(f"Work dir         : {work_dir.resolve()}")
    print(f"Tile dir         : {tile_dir.resolve()}")
    print(f"GDAL processes   : {args.gdal_processes}")
    print(f"Upload workers   : {args.upload_workers}")
    print(f"Dry run          : {args.dry_run}")
    print("=" * 70)

    check_environment(dry_run=args.dry_run)

    for species in species_list:
        build_species_tiles(
            species=species,
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

    print("\nDone ✓")


if __name__ == "__main__":
    main()