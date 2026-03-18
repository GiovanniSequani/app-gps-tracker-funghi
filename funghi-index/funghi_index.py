"""
funghi_index.py
===============
Calcola l'indice di probabilità funghi (porcini e finferli).
Tutto il calcolo è vettoriale (numpy) — nessun loop Python per cella.
LOD 2-6 completano in ~10-30 secondi totali dopo il download meteo.

Dipendenze:
    pip install requests numpy python-dotenv

Uso:
    python funghi_index.py --dry-run          # calcola, non uploada
    python funghi_index.py                    # calcola e uploada
    python funghi_index.py --lod 3 4 5        # solo LOD specificati
    python funghi_index.py --species porcini  # solo una specie
"""

import argparse
import json
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import requests
from dotenv import load_dotenv

# ─── Credenziali ──────────────────────────────────────────────────────────────
load_dotenv()
SUPABASE_URL    = os.getenv("SUPABASE_URL")
SUPABASE_KEY    = os.getenv("SUPABASE_SERVICE_KEY")
SUPABASE_BUCKET = "indices"

# ─── Area di copertura ────────────────────────────────────────────────────────
BBOX = {"south": 45.6, "north": 47.1, "west": 10.4, "east": 12.5}

# ─── Livelli LOD (deve corrispondere a LOD_LEVELS in IndiceLayers.tsx) ────────
LOD_LEVELS = [
    {"lod": 0, "step": 0.000225, "label": "25m",   "max_lat_delta": 0.005 },
    {"lod": 1, "step": 0.001,    "label": "111m",  "max_lat_delta": 0.015 },
    {"lod": 2, "step": 0.003,    "label": "333m",  "max_lat_delta": 0.05  },
    {"lod": 3, "step": 0.008,    "label": "890m",  "max_lat_delta": 0.15  },
    {"lod": 4, "step": 0.02,     "label": "2.2km", "max_lat_delta": 0.40  },
    {"lod": 5, "step": 0.05,     "label": "5.5km", "max_lat_delta": 1.0   },
    {"lod": 6, "step": 0.12,     "label": "13km",  "max_lat_delta": 999.0 },
]

METEO_DAYS_BACK = 20
METEO_GRID_STEP = 0.10   # ~11 km
METEO_VARS = [
    "temperature_2m", "relative_humidity_2m", "precipitation",
    "soil_temperature_0cm", "soil_moisture_0_to_1cm",
    "wind_speed_10m", "cloud_cover",
]


# ══════════════════════════════════════════════════════════════════════════════
# 1. DOWNLOAD DATI GRIGLIA
# ══════════════════════════════════════════════════════════════════════════════

def download_meteo_grid() -> dict:
    """
    Scarica i dati meteo storici da Open-Meteo per una griglia di punti.
    Restituisce {(lat, lon): {variabile: np.ndarray}}.
    """
    end_date   = datetime.now(timezone.utc).date()
    start_date = end_date - timedelta(days=METEO_DAYS_BACK)

    lats = np.arange(BBOX["south"], BBOX["north"], METEO_GRID_STEP)
    lons = np.arange(BBOX["west"],  BBOX["east"],  METEO_GRID_STEP)
    total = len(lats) * len(lons)
    grid_data = {}
    done = 0

    print(f"  Scarico {total} punti meteo ({start_date} → {end_date})…")

    for lat in lats:
        for lon in lons:
            lat_r = round(float(lat), 2)
            lon_r = round(float(lon), 2)
            url = (
                "https://archive-api.open-meteo.com/v1/archive"
                f"?latitude={lat_r}&longitude={lon_r}"
                f"&start_date={start_date}&end_date={end_date}"
                f"&hourly={','.join(METEO_VARS)}"
                "&timezone=Europe%2FRome&models=best_match"
            )
            for attempt in range(3):
                try:
                    r = requests.get(url, timeout=30)
                    r.raise_for_status()
                    grid_data[(lat_r, lon_r)] = r.json().get("hourly", {})
                    break
                except Exception as e:
                    if attempt == 2:
                        print(f"    [warn] ({lat_r},{lon_r}): {e}")
                        grid_data[(lat_r, lon_r)] = {}
                    time.sleep(1 + attempt)
            done += 1
            if done % 10 == 0:
                print(f"    {done}/{total}…")
            time.sleep(0.12)

    for key_point in grid_data:
        grid_data[key_point] = {
            k: np.array([v if v is not None else np.nan for v in vals], dtype=np.float32)
            for k, vals in grid_data[key_point].items()
            if k != "time"
        }

    print(f"  OK — {len(grid_data)} punti scaricati")
    return grid_data


def download_elevation_grid() -> dict:
    """
    Scarica l'elevazione su griglia grossolana in batch da Open-Meteo.
    Restituisce {(lat, lon): float}.
    """
    lats = np.arange(BBOX["south"], BBOX["north"], METEO_GRID_STEP)
    lons = np.arange(BBOX["west"],  BBOX["east"],  METEO_GRID_STEP)
    points = [(round(float(la), 2), round(float(lo), 2)) for la in lats for lo in lons]
    elev_grid = {}

    BATCH = 100
    print(f"  Elevazione: {len(points)} punti in batch…", end=" ", flush=True)

    for i in range(0, len(points), BATCH):
        batch = points[i:i+BATCH]
        lat_s = ",".join(str(p[0]) for p in batch)
        lon_s = ",".join(str(p[1]) for p in batch)
        for attempt in range(3):
            try:
                r = requests.get(
                    f"https://api.open-meteo.com/v1/elevation?latitude={lat_s}&longitude={lon_s}",
                    timeout=20
                )
                r.raise_for_status()
                for (la, lo), elev in zip(batch, r.json().get("elevation", [])):
                    elev_grid[(la, lo)] = float(elev) if elev is not None else 900.0
                break
            except Exception:
                if attempt == 2:
                    for la, lo in batch:
                        elev_grid[(la, lo)] = 900.0
                time.sleep(1 + attempt)
        time.sleep(0.1)

    print(f"OK ({len(elev_grid)} punti)")
    return elev_grid


# ══════════════════════════════════════════════════════════════════════════════
# 2. INTERPOLAZIONE SU GRIGLIA LOD (vettoriale)
# ══════════════════════════════════════════════════════════════════════════════

def build_lod_grid(lod_step: float) -> tuple:
    """Costruisce le coordinate della griglia LOD come array 1D."""
    lats = np.arange(BBOX["south"], BBOX["north"], lod_step)
    lons = np.arange(BBOX["west"],  BBOX["east"],  lod_step)
    LON, LAT = np.meshgrid(lons, lats)
    return LAT.ravel(), LON.ravel()   # shape (N,)


def idw_interpolate(
    grid: dict,
    query_lats: np.ndarray,
    query_lons: np.ndarray,
    value_fn,
    default: float = 0.0,
) -> np.ndarray:
    """
    Interpolazione IDW vettoriale: per ogni punto query calcola
    la media pesata per distanza inversa dei K punti griglia più vicini.
    """
    K = 4
    raw_keys = list(grid.keys())                              # lista di tuple (float, float)
    keys     = np.array(raw_keys, dtype=np.float32)           # shape (M, 2)
    values   = np.array([value_fn(grid[k]) for k in raw_keys], dtype=np.float32)

    q    = np.stack([query_lats, query_lons], axis=1).astype(np.float32)  # (N, 2)
    dist = np.abs(q[:, None, :] - keys[None, :, :]).sum(axis=2)           # (N, M)

    k_idx  = np.argpartition(dist, K, axis=1)[:, :K]          # (N, K)
    k_dist = np.take_along_axis(dist, k_idx, axis=1)           # (N, K)
    k_vals = values[k_idx]                                     # (N, K)

    w      = 1.0 / np.maximum(k_dist, 1e-6)
    w_sum  = w.sum(axis=1, keepdims=True)
    result = (w * k_vals).sum(axis=1) / w_sum.squeeze(1)

    return np.where(np.isnan(result), default, result)


def aggregate_meteo_features(grid: dict, lats: np.ndarray, lons: np.ndarray) -> dict:
    """
    Calcola tutte le feature meteo aggregate su tutti i punti LOD in una volta.
    Restituisce {feature_name: ndarray shape (N,)}.

    ─── COME AGGIUNGERE UNA FEATURE ─────────────────────────────────────────
    1. Aggiungi la variabile a METEO_VARS in cima al file
    2. Definisci una funzione che aggrega hourly[var] → float
    3. Chiama idw_interpolate con la nuova funzione
    4. Aggiungi la chiave al dict restituito
    ─────────────────────────────────────────────────────────────────────────
    """
    N = 360  # ultimi 15 giorni = 360 ore

    def tail(arr):
        return arr[-N:] if len(arr) >= N else arr

    def safe_mean(arr, default):
        t = tail(arr)
        return float(np.nanmean(t)) if len(t) > 0 and not np.all(np.isnan(t)) else default

    def safe_min(arr, default):
        t = tail(arr)
        return float(np.nanmin(t)) if len(t) > 0 and not np.all(np.isnan(t)) else default

    def safe_max(arr, default):
        t = tail(arr)
        return float(np.nanmax(t)) if len(t) > 0 and not np.all(np.isnan(t)) else default

    def tail_mean(key, default=0.0):
        def fn(h): return safe_mean(h.get(key, np.array([])), default)
        return fn

    def tail_min(key, default=0.0):
        def fn(h): return safe_min(h.get(key, np.array([])), default)
        return fn

    def tail_max(key, default=0.0):
        def fn(h): return safe_max(h.get(key, np.array([])), default)
        return fn

    def precip_sum(h):
        arr = h.get("precipitation", np.array([]))
        t = tail(arr)
        return float(np.nansum(t)) if len(t) > 0 else 0.0

    def precip_days(h):
        arr = h.get("precipitation", np.array([]))
        t = tail(arr)
        if len(t) == 0:
            return 0.0
        daily = [np.nansum(t[i:i+24]) for i in range(0, len(t), 24)]
        return float(sum(1 for d in daily if d > 1.0))

    return {
        "temp_mean":          idw_interpolate(grid, lats, lons, tail_mean("temperature_2m",         15.0), 15.0),
        "temp_min":           idw_interpolate(grid, lats, lons, tail_min ("temperature_2m",         10.0), 10.0),
        "temp_max":           idw_interpolate(grid, lats, lons, tail_max ("temperature_2m",         20.0), 20.0),
        "precip_sum_15d":     idw_interpolate(grid, lats, lons, precip_sum,                                20.0),
        "precip_days_15d":    idw_interpolate(grid, lats, lons, precip_days,                                5.0),
        "soil_temp_mean":     idw_interpolate(grid, lats, lons, tail_mean("soil_temperature_0cm",   12.0), 12.0),
        "humidity_mean":      idw_interpolate(grid, lats, lons, tail_mean("relative_humidity_2m",   70.0), 70.0),
        "soil_moisture_mean": idw_interpolate(grid, lats, lons, tail_mean("soil_moisture_0_to_1cm",  0.30),  0.3),
        "wind_mean":          idw_interpolate(grid, lats, lons, tail_mean("wind_speed_10m",          5.0),  5.0),
        "cloud_cover_mean":   idw_interpolate(grid, lats, lons, tail_mean("cloud_cover",            50.0), 50.0),
    }


def interpolate_elevation_vec(elev_grid: dict, lats: np.ndarray, lons: np.ndarray) -> np.ndarray:
    """Interpolazione IDW vettoriale per l'elevazione."""
    return idw_interpolate(elev_grid, lats, lons, lambda x: x, 900.0)


def landcover_from_elevation(elev: np.ndarray) -> np.ndarray:
    """
    Stima landcover dalla quota (placeholder fino a integrazione ESA WorldCover).
    Classi ESA WorldCover: 10=Bosco, 20=Arbusti, 30=Prato alpino, 40=Pianura.
    """
    lc = np.full_like(elev, 40, dtype=np.int32)
    lc = np.where(elev > 500,  10, lc)
    lc = np.where(elev > 2200, 30, lc)
    return lc


# ══════════════════════════════════════════════════════════════════════════════
# 3. CALCOLO INDICE (vettoriale)
# ══════════════════════════════════════════════════════════════════════════════

def trapezoid_vec(x: np.ndarray, lo_bad, lo_ok, hi_ok, hi_bad) -> np.ndarray:
    """
    Funzione trapezoidale vettoriale.
    0 fuori da [lo_bad, hi_bad], 1 in [lo_ok, hi_ok], rampe lineari.

    ─── COME MODIFICARE ─────────────────────────────────────────────────────
    Cambia i 4 parametri per modificare range ottimale e tolleranze.
    Esempio temperatura ottimale 12-18°C con tolleranza 5-24°C:
      trapezoid_vec(temp, lo_bad=5, lo_ok=12, hi_ok=18, hi_bad=24)
    ─────────────────────────────────────────────────────────────────────────
    """
    result = np.zeros_like(x, dtype=np.float32)
    mask = (x > lo_bad) & (x <= lo_ok)
    result[mask] = (x[mask] - lo_bad) / (lo_ok - lo_bad)
    result[(x > lo_ok) & (x < hi_ok)] = 1.0
    mask = (x >= hi_ok) & (x < hi_bad)
    result[mask] = (hi_bad - x[mask]) / (hi_bad - hi_ok)
    return result


def compute_scores_vec(
    meteo: dict,
    elevation: np.ndarray,
    landcover: np.ndarray,
    species: str,
) -> np.ndarray:
    """
    Calcola gli score per tutti i punti in una volta sola.

    ─── COME MODIFICARE ─────────────────────────────────────────────────────
    Modifica i parametri di trapezoid_vec per cambiare gli optimum.
    Modifica WEIGHTS per cambiare l'importanza relativa (devono sommare a 1).
    Per aggiungere una variabile: aggiungi sub-score + peso + termine nella
    somma finale.
    ─────────────────────────────────────────────────────────────────────────
    """
    if species == "porcini":
        s_temp  = trapezoid_vec(meteo["temp_mean"],          5,    10,   18,   24)
        s_prec  = trapezoid_vec(meteo["precip_sum_15d"],     5,    15,   60,   120)
        s_pdays = trapezoid_vec(meteo["precip_days_15d"],    1,    3,    10,   15)
        s_prec  = 0.6 * s_prec + 0.4 * s_pdays
        s_soilm = trapezoid_vec(meteo["soil_moisture_mean"], 0.05, 0.15, 0.45, 0.70)
        s_soilt = trapezoid_vec(meteo["soil_temp_mean"],     4,    8,    16,   22)
        s_elev  = trapezoid_vec(elevation,                   400,  700,  1700, 2200)
        s_lc    = np.where(landcover == 10, 1.0,
                  np.where(landcover == 20, 0.5,
                  np.where(landcover == 30, 0.2, 0.1))).astype(np.float32)
        WEIGHTS = dict(temp=0.20, precip=0.30, soilm=0.15, soilt=0.10, elev=0.15, lc=0.10)

    else:  # finferli
        s_temp  = trapezoid_vec(meteo["temp_mean"],          8,    12,   20,   26)
        s_prec  = trapezoid_vec(meteo["precip_sum_15d"],     10,   20,   70,   140)
        s_pdays = trapezoid_vec(meteo["precip_days_15d"],    2,    4,    12,   15)
        s_prec  = 0.6 * s_prec + 0.4 * s_pdays
        s_soilm = trapezoid_vec(meteo["soil_moisture_mean"], 0.08, 0.20, 0.50, 0.75)
        s_soilt = trapezoid_vec(meteo["soil_temp_mean"],     6,    10,   18,   24)
        s_elev  = trapezoid_vec(elevation,                   200,  400,  1300, 1800)
        s_lc    = np.where(landcover == 10, 1.0,
                  np.where(landcover == 20, 0.7,
                  np.where(landcover == 30, 0.3, 0.1))).astype(np.float32)
        WEIGHTS = dict(temp=0.20, precip=0.28, soilm=0.17, soilt=0.10, elev=0.15, lc=0.10)

    score = (
        WEIGHTS["temp"]   * s_temp  +
        WEIGHTS["precip"] * s_prec  +
        WEIGHTS["soilm"]  * s_soilm +
        WEIGHTS["soilt"]  * s_soilt +
        WEIGHTS["elev"]   * s_elev  +
        WEIGHTS["lc"]     * s_lc
    )
    return np.round(score * 100, 1).astype(np.float32)


# ══════════════════════════════════════════════════════════════════════════════
# 4. EXPORT GEOJSON
# ══════════════════════════════════════════════════════════════════════════════

def generate_geojson_lod(species: str, lod: dict, meteo_grid: dict, elev_grid: dict) -> dict:
    """
    Genera il GeoJSON per un LOD. Tutto vettoriale — nessun loop Python per cella.
    """
    step = lod["step"]
    t0   = time.time()

    lats, lons = build_lod_grid(step)
    N = len(lats)
    print(f"  [{species} LOD{lod['lod']} {lod['label']}] {N} celle…", end=" ", flush=True)

    meteo     = aggregate_meteo_features(meteo_grid, lats, lons)
    elevation = interpolate_elevation_vec(elev_grid, lats, lons)
    landcover = landcover_from_elevation(elevation)
    scores    = compute_scores_vec(meteo, elevation, landcover, species)

    mask     = scores >= 5.0
    lats_f   = lats[mask];     lons_f  = lons[mask]
    scores_f = scores[mask];   elev_f  = elevation[mask]
    lc_f     = landcover[mask]

    features = [
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(float(lo), 6), round(float(la), 6)]},
            "properties": {
                "score": round(float(sc), 1),
                "elev":  int(round(float(el))),
                "lc":    int(lc),
            },
        }
        for la, lo, sc, el, lc in zip(lats_f, lons_f, scores_f, elev_f, lc_f)
    ]

    print(f"{len(features)} celle ({N - len(features)} skip) — {time.time()-t0:.1f}s")

    return {
        "type": "FeatureCollection",
        "properties": {
            "species":       species,
            "lod":           lod["lod"],
            "step_deg":      step,
            "label":         lod["label"],
            "max_lat_delta": lod["max_lat_delta"],
            "generated_at":  datetime.now(timezone.utc).isoformat(),
            "bbox":          BBOX,
        },
        "features": features,
    }


# ══════════════════════════════════════════════════════════════════════════════
# 5. UPLOAD SUPABASE
# ══════════════════════════════════════════════════════════════════════════════

def upload_to_supabase(filename: str, content: str):
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("  [skip] Credenziali Supabase mancanti — controlla .env")
        return
    url = f"{SUPABASE_URL}/storage/v1/object/{SUPABASE_BUCKET}/{filename}"
    headers = {
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type":  "application/geo+json",
        "x-upsert":      "true",
    }
    for attempt in range(3):
        try:
            r = requests.post(url, headers=headers, data=content.encode("utf-8"), timeout=60)
            if r.status_code in (200, 201):
                print(f"  [✓] {filename} ({len(content)//1024} KB)")
                return
            print(f"  [✗] {filename} HTTP {r.status_code}: {r.text[:120]}")
        except Exception as e:
            print(f"  [!] {filename}: {e}")
        time.sleep(2 ** attempt)
    print(f"  [FAIL] {filename}")


# ══════════════════════════════════════════════════════════════════════════════
# 6. MAIN
# ══════════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run",    action="store_true")
    parser.add_argument("--lod",        nargs="+", type=int)
    parser.add_argument("--species",    choices=["porcini", "finferli"])
    parser.add_argument("--output-dir", default="output")
    args = parser.parse_args()

    output_dir   = Path(args.output_dir)
    output_dir.mkdir(exist_ok=True)
    lod_filter   = set(args.lod) if args.lod else set(range(2, 7))
    species_list = [args.species] if args.species else ["porcini", "finferli"]
    active_lods  = [l for l in LOD_LEVELS if l["lod"] in lod_filter]

    print("=" * 55)
    print(f"FUNGHI INDEX  {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(f"Specie : {species_list}")
    print(f"LOD    : {[l['label'] for l in active_lods]}")
    print(f"Dry run: {args.dry_run}")
    print("=" * 55)

    print("\n[1/3] Download dati griglia…")
    meteo_grid = download_meteo_grid()
    elev_grid  = download_elevation_grid()

    print("\n[2/3] Calcolo indice…")
    generated = []
    for species in species_list:
        for lod in active_lods:
            geojson  = generate_geojson_lod(species, lod, meteo_grid, elev_grid)
            filename = f"{species}_lod{lod['lod']}.geojson"
            content  = json.dumps(geojson, separators=(",", ":"))
            (output_dir / filename).write_text(content, encoding="utf-8")
            print(f"    → output/{filename} ({len(content)//1024} KB)")
            generated.append((filename, content))

    if not args.dry_run:
        print("\n[3/3] Upload Supabase…")
        for filename, content in generated:
            upload_to_supabase(filename, content)
        upload_to_supabase("metadata.json", json.dumps({
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "species":    species_list,
            "lods":       [l["lod"] for l in active_lods],
            "version":    "1.0.0",
        }))
    else:
        print(f"\n[3/3] Dry run — file in: {output_dir.resolve()}")

    print("\nDone ✓")


if __name__ == "__main__":
    main()
