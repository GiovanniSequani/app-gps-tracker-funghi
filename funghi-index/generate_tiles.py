"""
generate_tiles.py
=================
Converte i GeoJSON dell'indice funghi in tile PNG XYZ con parallelizzazione.

Uso:
    python generate_tiles.py --dry-run
    python generate_tiles.py
    python generate_tiles.py --species porcini
    python generate_tiles.py --zoom 10 12
"""

import argparse
import io
import json
import math
import os
import time
import queue
import multiprocessing as mp
from datetime import datetime
from pathlib import Path
from tqdm import tqdm
from concurrent.futures import ThreadPoolExecutor
from functools import partial

import mercantile
import numpy as np
import requests
from dotenv import load_dotenv
from PIL import Image

# ─── Credenziali ──────────────────────────────────────────────────────────────
load_dotenv()
SUPABASE_URL    = os.getenv("SUPABASE_URL")
SUPABASE_KEY    = os.getenv("SUPABASE_SERVICE_KEY")
SUPABASE_BUCKET = "tiles"

# ─── Configurazione ───────────────────────────────────────────────────────────
TILE_SIZE    = 256
ZOOM_MIN     = 8
ZOOM_MAX     = 14
TILE_OPACITY = 0.75
MASTER_RESOLUTION = 0.001

# ─── Area di copertura ────────────────────────────────────────────────────────
BBOX = {"south": 45.6, "north": 47.1, "west": 10.4, "east": 12.5}


# ══════════════════════════════════════════════════════════════════════════════
# 1. GRIGLIA MASTER
# ══════════════════════════════════════════════════════════════════════════════

def build_master_grid(cells: list) -> tuple:
    """
    Rasterizza tutte le celle in una griglia numpy 2D (score 0-100).
    Restituisce (grid, lon_min, lat_max, resolution)
    """
    res = MASTER_RESOLUTION

    lon_min = BBOX["west"]
    lon_max = BBOX["east"]
    lat_min = BBOX["south"]
    lat_max = BBOX["north"]

    cols = int((lon_max - lon_min) / res) + 1
    rows = int((lat_max - lat_min) / res) + 1

    grid = np.zeros((rows, cols), dtype=np.float32)

    # Converti tutte le celle in indici griglia (vettoriale)
    lats   = np.array([c["lat"]   for c in cells], dtype=np.float32)
    lons   = np.array([c["lon"]   for c in cells], dtype=np.float32)
    scores = np.array([c["score"] for c in cells], dtype=np.float32)
    steps  = np.array([c["step"]  for c in cells], dtype=np.float32)

    # Coordinate pixel di ogni cella nel master grid
    col_center = ((lons - lon_min) / res).astype(np.int32)
    row_center = ((lat_max - lats) / res).astype(np.int32)

    # Raggio in pixel di ogni cella
    radius_col = np.maximum(1, (steps / 2 / res)).astype(np.int32)
    radius_row = np.maximum(1, (steps / 2 / res)).astype(np.int32)

    # Raggruppa per radius per minimizzare i loop
    unique_radii = np.unique(np.stack([radius_col, radius_row], axis=1), axis=0)

    for rc, rr in unique_radii:
        mask = (radius_col == rc) & (radius_row == rr)
        if not mask.any():
            continue

        c_centers = col_center[mask]
        r_centers = row_center[mask]
        s_values  = scores[mask]

        # Per ogni offset nel rettangolo, aggiorna la griglia vettorialmente
        for dc in range(-int(rc), int(rc) + 1):
            for dr in range(-int(rr), int(rr) + 1):
                c_idx = np.clip(c_centers + dc, 0, cols - 1)
                r_idx = np.clip(r_centers + dr, 0, rows - 1)
                # Prendi il massimo score tra celle sovrapposte
                np.maximum.at(grid, (r_idx, c_idx), s_values)

    print(f"    Griglia master: {rows}×{cols} px, {(grid > 0).sum()} pixel attivi")
    return grid, lon_min, lat_max, res


# ══════════════════════════════════════════════════════════════════════════════
# 2. COLORMAP
# ══════════════════════════════════════════════════════════════════════════════

def build_colormap(species: str) -> np.ndarray:
    """Costruisce lookup table score→RGBA"""
    lut = np.zeros((101, 4), dtype=np.uint8)

    for score in range(101):
        if score == 0:
            lut[score] = [0, 0, 0, 0]
            continue
        alpha = int((0.28 + (score / 100) * 0.54) * 255 * TILE_OPACITY)
        if species == "porcini":
            if score < 20: rgb = (74,  32,  16)
            elif score < 40: rgb = (139, 94,  60)
            elif score < 60: rgb = (176, 122, 80)
            elif score < 80: rgb = (200, 131, 42)
            else:            rgb = (232, 192, 64)
        else:
            if score < 20: rgb = (42,  32,  0)
            elif score < 40: rgb = (106, 80,  16)
            elif score < 60: rgb = (201, 144, 26)
            elif score < 80: rgb = (224, 170, 48)
            else:            rgb = (255, 224, 96)
        lut[score] = [rgb[0], rgb[1], rgb[2], alpha]

    return lut


# ══════════════════════════════════════════════════════════════════════════════
# 3. FUNZIONE PER WORKER (PROCESSA UNA TILE)
# ══════════════════════════════════════════════════════════════════════════════

def process_tile_worker(tile_info, grid, colormap, lon_min, lat_max, res, 
                        species, tile_dir, dry_run):
    """
    Funzione eseguita da ogni worker per processare una singola tile.
    Restituisce i byte PNG e le coordinate, oppure None se vuota.
    """
    z, x, y = tile_info
    tile = mercantile.Tile(x=x, y=y, z=z)
    
    # Estrai dalla griglia master
    bounds = mercantile.bounds(tile)
    
    col0 = (bounds.west - lon_min) / res
    col1 = (bounds.east - lon_min) / res
    row0 = (lat_max - bounds.north) / res
    row1 = (lat_max - bounds.south) / res
    
    c0 = max(0, int(col0) - 1)
    c1 = min(grid.shape[1], int(col1) + 2)
    r0 = max(0, int(row0) - 1)
    r1 = min(grid.shape[0], int(row1) + 2)
    
    if c0 >= c1 or r0 >= r1:
        return None
    
    region = grid[r0:r1, c0:c1]
    
    if region.max() == 0:
        return None
    
    # Converti in RGBA
    score_int = np.clip(region.astype(np.int32), 0, 100)
    rgba = colormap[score_int]
    
    # Crea immagine
    img_region = Image.fromarray(rgba.astype(np.uint8), "RGBA")
    img_tile = img_region.resize((TILE_SIZE, TILE_SIZE), Image.BILINEAR)
    
    # Converti in PNG bytes (compress_level=1 per velocità)
    buf = io.BytesIO()
    img_tile.save(buf, format="PNG", compress_level=1, optimize=False)
    png_bytes = buf.getvalue()
    
    return (z, x, y, png_bytes)


# ══════════════════════════════════════════════════════════════════════════════
# 4. FUNZIONI PER COLLEZIONARE RISULTATI
# ══════════════════════════════════════════════════════════════════════════════

def save_and_upload_tile(result, species, unused_arg):
    if result is None:
        return False

    z, x, y, png_bytes = result
    upload_tile(species, z, x, y, png_bytes)

    return True

def save_and_upload_tile_dry(result, species, tile_dir):
    if result is None:
        return False

    z, x, y, png_bytes = result

    # Solo locale
    out_path = tile_dir / species / str(z) / str(x)
    out_path.mkdir(parents=True, exist_ok=True)
    (out_path / f"{y}.png").write_bytes(png_bytes)

    return True


# ══════════════════════════════════════════════════════════════════════════════
# 5. UPLOAD SUPABASE
# ══════════════════════════════════════════════════════════════════════════════

def upload_tile(species: str, z: int, x: int, y: int, png_bytes: bytes):
    if not SUPABASE_URL or not SUPABASE_KEY:
        return
    path = f"{species}/{z}/{x}/{y}.png"
    url  = f"{SUPABASE_URL}/storage/v1/object/{SUPABASE_BUCKET}/{path}"
    headers = {
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type":  "image/png",
        "x-upsert":      "true",
    }
    for attempt in range(3):
        try:
            r = requests.post(url, headers=headers, data=png_bytes, timeout=30)
            if r.status_code in (200, 201):
                return
            print(f"  [✗] {path} HTTP {r.status_code}")
            return
        except Exception as e:
            if attempt == 2:
                print(f"  [!] {path}: {e}")
            time.sleep(1 + attempt)


# ══════════════════════════════════════════════════════════════════════════════
# 6. CARICAMENTO GEOJSON
# ══════════════════════════════════════════════════════════════════════════════

def load_cells(species: str, geojson_dir: Path) -> list:
    """Carica tutte le celle dai GeoJSON disponibili."""
    all_cells = []
    for lod in range(6, -1, -1):
        path = geojson_dir / f"{species}_lod{lod}.geojson"
        if not path.exists():
            continue
        with open(path, encoding="utf-8") as f:
            gj = json.load(f)
        step = gj["properties"]["step_deg"]
        for feat in gj["features"]:
            lon, lat = feat["geometry"]["coordinates"]
            all_cells.append({
                "lat":   lat,
                "lon":   lon,
                "score": feat["properties"]["score"],
                "step":  step,
            })
    print(f"  [{species}] {len(all_cells)} celle caricate")
    return all_cells


# ══════════════════════════════════════════════════════════════════════════════
# 7. MAIN CON PARALLELIZZAZIONE
# ══════════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run",     action="store_true")
    parser.add_argument("--species",     choices=["porcini", "finferli"])
    parser.add_argument("--zoom",        nargs="+", type=int)
    parser.add_argument("--geojson-dir", default="output")
    parser.add_argument("--tile-dir",    default="tiles")
    parser.add_argument("--processes",   type=int, default=None,
                       help="Numero di processi paralleli (default: CPU count)")
    args = parser.parse_args()

    geojson_dir  = Path(args.geojson_dir)
    tile_dir     = Path(args.tile_dir)
    species_list = [args.species] if args.species else ["porcini", "finferli"]
    zoom_range   = args.zoom if args.zoom else list(range(ZOOM_MIN, ZOOM_MAX + 1))
    
    # Numero di processi
    n_processes = args.processes or mp.cpu_count()
    
    print("=" * 55)
    print(f"TILE GENERATOR  {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(f"Specie : {species_list}")
    print(f"Zoom   : {zoom_range}")
    print(f"Processi: {n_processes}")
    print(f"Dry run: {args.dry_run}")
    print("=" * 55)

    for species in species_list:
        print(f"\n[{species.upper()}]")
        t_species = time.time()

        # 1. Carica celle
        cells = load_cells(species, geojson_dir)
        if not cells:
            print(f"  Nessun GeoJSON in {geojson_dir} — esegui prima funghi_index.py")
            continue

        # 2. Costruisci griglia master (una volta sola per specie)
        print(f"  Rasterizzazione griglia master…", end=" ", flush=True)
        t0 = time.time()
        grid, lon_min, lat_max, res = build_master_grid(cells)
        print(f"{time.time()-t0:.1f}s")

        # 3. Costruisci colormap
        colormap = build_colormap(species)

        # 4. Prepara lista di tutte le tile da generare
        all_tiles = []
        for zoom in zoom_range:
            tiles = list(mercantile.tiles(
                BBOX["west"], BBOX["south"], BBOX["east"], BBOX["north"],
                zooms=zoom,
            ))
            for tile in tiles:
                all_tiles.append((zoom, tile.x, tile.y))
        
        total_tiles = len(all_tiles)
        print(f"  Totale tile da generare: {total_tiles}")

        # 5. Decidi se usare parallelizzazione (soglia per evitare overhead)
        use_parallel = total_tiles > 100 and n_processes > 1

        if args.dry_run:
            func = save_and_upload_tile_dry
        else:
            func = save_and_upload_tile
        
        if use_parallel:
            print(f"  Generazione con {n_processes} processi...")
            
            # Prepara funzione parziale con i parametri fissi
            worker_func = partial(
                process_tile_worker,
                grid=grid,
                colormap=colormap,
                lon_min=lon_min,
                lat_max=lat_max,
                res=res,
                species=species,
                tile_dir=tile_dir,
                dry_run=args.dry_run
            )
            
            # Crea pool e processa in parallelo
            with mp.Pool(processes=n_processes) as pool:
                # imap_unordered restituisce risultati non appena pronti
                results = pool.imap_unordered(worker_func, all_tiles, chunksize=50)
                
                # Processa risultati con barra di progresso
                generated = 0
                with tqdm(total=total_tiles, desc=f"  {species} tiles") as pbar:
                    for result in results:
                        if result is not None:
                            # Salva e uploada
                            func(result, species, tile_dir)
                            generated += 1
                        pbar.update(1)
                        
        else:
            print(f"  Generazione sequenziale...")
            generated = 0
            for tile_info in tqdm(all_tiles, desc=f"  {species} tiles"):
                result = process_tile_worker(
                    tile_info, grid, colormap, lon_min, lat_max, res,
                    species, tile_dir, args.dry_run
                )
                if result is not None:
                    func(result, species, tile_dir)
                    generated += 1

        print(f"  Generate: {generated} tile, vuote: {total_tiles - generated}")
        print(f"  Tempo totale: {time.time()-t_species:.1f}s")

    print("\nDone ✓")
    if not args.dry_run:
        print("\nURL tile template:")
        for sp in species_list:
            print(f"  {sp}: {SUPABASE_URL}/storage/v1/object/public/tiles/{sp}/{{z}}/{{x}}/{{y}}.png")


if __name__ == "__main__":
    # Importante per Windows: proteggere l'entry point
    mp.freeze_support()
    main()