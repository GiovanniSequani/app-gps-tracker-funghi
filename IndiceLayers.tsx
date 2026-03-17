/**
 * IndiceLayers.tsx  — v4
 *
 * Layer indice funghi su react-native-maps con:
 *  - LOD adattivo: celle più piccole a zoom in, più grandi a zoom out
 *  - Cap hard a MAX_POLYGONS poligoni visibili contemporaneamente
 *  - Risoluzione massima ~25m (step 0.000225°) a zoom altissimo
 *  - Cache pre-calcolata per livello LOD (build lazy al primo uso)
 *
 * ─── COME MODIFICARE LE SOGLIE ───────────────────────────────────────────────
 *
 * Tutto si controlla con due costanti:
 *
 * 1. MAX_POLYGONS (riga ~30)
 *    Numero massimo di poligoni renderizzati contemporaneamente.
 *    Aumenta se il dispositivo regge, diminuisci se lag persiste.
 *    Default: 150
 *
 * 2. LOD_LEVELS (riga ~40)
 *    Array di livelli LOD, dal più dettagliato al più grossolano.
 *    Ogni livello ha:
 *      maxLatDelta : latitudeDelta massimo per cui questo livello è attivo
 *                    (se la mappa mostra meno di questo → usa questo step)
 *      step        : dimensione cella in gradi (lat ≈ lon a queste latitudini)
 *      label       : stringa descrittiva (solo per debug)
 *
 *    Esempi di conversione step → dimensione reale a lat 46°N:
 *      0.000225° ≈  25 m   (massima risoluzione)
 *      0.001°    ≈ 111 m
 *      0.003°    ≈ 333 m
 *      0.008°    ≈ 890 m
 *      0.02°     ≈ 2.2 km
 *      0.05°     ≈ 5.5 km
 *      0.12°     ≈  13 km  (minima risoluzione)
 *
 *    Per aggiungere un livello: inserisci un nuovo oggetto nell'array
 *    mantenendo l'ordine crescente di maxLatDelta.
 *    Per rimuovere un livello: elimina la riga corrispondente.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React from 'react';
import { Polygon } from 'react-native-maps';
import type { Region } from 'react-native-maps';
import type { ActiveLayer } from './IndiceScreen';

// ─── Parametri globali ────────────────────────────────────────────────────────

/** Numero massimo di poligoni renderizzati contemporaneamente */
const MAX_POLYGONS = 300;

/**
 * Livelli LOD — ordine: dal più dettagliato (step piccolo) al più grossolano.
 * maxLatDelta: se region.latitudeDelta < questo valore, usa questo livello.
 * L'ultimo livello (maxLatDelta: Infinity) è il fallback per zoom molto out.
 */
const LOD_LEVELS: Array<{ maxLatDelta: number; step: number; label: string }> = [
  { maxLatDelta: 0.005,  step: 0.000225, label: '25m'   },
  { maxLatDelta: 0.015,  step: 0.001,    label: '111m'  },
  { maxLatDelta: 0.05,   step: 0.003,    label: '333m'  },
  { maxLatDelta: 0.15,   step: 0.008,    label: '890m'  },
  { maxLatDelta: 0.40,   step: 0.02,     label: '2.2km' },
  { maxLatDelta: 1.0,    step: 0.05,     label: '5.5km' },
  { maxLatDelta: Infinity, step: 0.12,   label: '13km'  },
];

// ─── Area di copertura ────────────────────────────────────────────────────────
const COVERAGE = { south: 45.6, north: 47.1, west: 10.4, east: 12.5 };

// ─── Hotspot placeholder ──────────────────────────────────────────────────────
const HOTSPOTS: Record<'porcini' | 'finferli', Array<{ lat: number; lon: number; r: number; strength: number }>> = {
  porcini: [
    { lat: 46.12, lon: 11.05, r: 0.35, strength: 95 },
    { lat: 46.45, lon: 11.85, r: 0.30, strength: 90 },
    { lat: 46.25, lon: 10.85, r: 0.28, strength: 85 },
    { lat: 46.20, lon: 12.10, r: 0.32, strength: 88 },
    { lat: 46.55, lon: 11.35, r: 0.25, strength: 82 },
    { lat: 46.08, lon: 11.40, r: 0.22, strength: 78 },
    { lat: 46.38, lon: 12.55, r: 0.20, strength: 75 },
    { lat: 46.70, lon: 10.95, r: 0.28, strength: 80 },
  ],
  finferli: [
    { lat: 46.05, lon: 11.10, r: 0.40, strength: 92 },
    { lat: 46.40, lon: 11.90, r: 0.35, strength: 87 },
    { lat: 46.15, lon: 12.05, r: 0.38, strength: 90 },
    { lat: 46.28, lon: 10.90, r: 0.30, strength: 83 },
    { lat: 46.60, lon: 11.30, r: 0.28, strength: 79 },
    { lat: 45.85, lon: 11.55, r: 0.25, strength: 76 },
    { lat: 46.50, lon: 12.40, r: 0.22, strength: 72 },
    { lat: 46.75, lon: 10.80, r: 0.30, strength: 77 },
  ],
};

// ─── Tipi ─────────────────────────────────────────────────────────────────────
type Cell = { key: string; lat: number; lon: number; score: number };
type CacheKey = string; // `${species}_${step}`

// ─── Cache globale (sopravvive ai re-render) ──────────────────────────────────
// Le celle vengono calcolate una volta per (specie, step) e riutilizzate.
const CELL_CACHE = new Map<CacheKey, Cell[]>();

// ─── PRNG deterministico ──────────────────────────────────────────────────────
function makePRNG(speciesSeed: number) {
  let s = speciesSeed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// ─── Calcola score per una singola cella ──────────────────────────────────────
function calcScore(
  lat: number,
  lon: number,
  hotspots: typeof HOTSPOTS['porcini'],
  rand: () => number,
): number {
  let score = 0;
  for (const h of hotspots) {
    const dlat = lat - h.lat;
    const dlon = lon - h.lon;
    score += h.strength * Math.exp(-(dlat * dlat + dlon * dlon) / (2 * h.r * h.r));
  }
  return Math.min(100, Math.max(0, score + (rand() - 0.5) * 15));
}

// ─── Costruisce (o recupera dalla cache) le celle per (specie, step) ──────────
function getCells(species: 'porcini' | 'finferli', step: number): Cell[] {
  const key: CacheKey = `${species}_${step}`;
  if (CELL_CACHE.has(key)) return CELL_CACHE.get(key)!;

  const hotspots = HOTSPOTS[species];
  const rand = makePRNG(species === 'porcini' ? 42 : 137);
  const cells: Cell[] = [];
  const { south, north, west, east } = COVERAGE;

  // Per step molto piccoli (25m) costruiamo la griglia solo su richiesta
  // ma NON su tutta l'area — sarebbe troppo. La griglia fine viene
  // costruita "lazy per tile" in getVisibleCells() sotto.
  // Per step >= 0.003 costruiamo tutta l'area (max ~50k celle, gestibile).
  if (step >= 0.003) {
    for (let lat = south; lat < north; lat += step) {
      for (let lon = west; lon < east; lon += step) {
        const score = calcScore(lat, lon, hotspots, rand);
        if (score < 8) continue;
        const latR = Math.round(lat / step) * step;
        const lonR = Math.round(lon / step) * step;
        cells.push({ key: `${latR.toFixed(6)}_${lonR.toFixed(6)}`, lat: latR, lon: lonR, score: Math.round(score) });
      }
    }
    CELL_CACHE.set(key, cells);
  }
  // Per step < 0.003 (alta risoluzione) non pre-calcoliamo tutta l'area:
  // getCells restituisce [] e getVisibleCells calcola al volo solo il viewport.
  return cells;
}

// ─── Filtra/calcola le celle visibili nel viewport ────────────────────────────
function getVisibleCells(
  species: 'porcini' | 'finferli',
  step: number,
  region: Region,
): Cell[] {
  const margin = step * 1.5;
  const vSouth = region.latitude  - region.latitudeDelta  / 2 - margin;
  const vNorth = region.latitude  + region.latitudeDelta  / 2 + margin;
  const vWest  = region.longitude - region.longitudeDelta / 2 - margin;
  const vEast  = region.longitude + region.longitudeDelta / 2 + margin;

  if (step >= 0.003) {
    // Usa cache globale, filtra per viewport
    const all = getCells(species, step);
    return all.filter(c => c.lat >= vSouth && c.lat <= vNorth && c.lon >= vWest && c.lon <= vEast);
  }

  // Alta risoluzione (step < 0.003): calcola solo le celle del viewport
  // Cache per viewport (chiave = specie + step + viewport arrotondato)
  const vpKey: CacheKey = `${species}_${step}_${vSouth.toFixed(4)}_${vNorth.toFixed(4)}_${vWest.toFixed(4)}_${vEast.toFixed(4)}`;
  if (CELL_CACHE.has(vpKey)) return CELL_CACHE.get(vpKey)!;

  const hotspots = HOTSPOTS[species];
  const rand = makePRNG(species === 'porcini' ? 42 : 137);
  const cells: Cell[] = [];

  // Allinea il punto di partenza alla griglia globale
  const startLat = Math.floor(vSouth / step) * step;
  const startLon = Math.floor(vWest  / step) * step;

  for (let lat = startLat; lat <= vNorth; lat += step) {
    for (let lon = startLon; lon <= vEast; lon += step) {
      if (lat < COVERAGE.south || lat > COVERAGE.north) continue;
      if (lon < COVERAGE.west  || lon > COVERAGE.east)  continue;
      const score = calcScore(lat, lon, hotspots, rand);
      if (score < 8) continue;
      const latR = parseFloat(lat.toFixed(6));
      const lonR = parseFloat(lon.toFixed(6));
      cells.push({ key: `${latR}_${lonR}`, lat: latR, lon: lonR, score: Math.round(score) });
    }
  }

  // Cache viewport (max 200 entry per non sprecare memoria)
  if (CELL_CACHE.size > 200) {
    // Rimuovi le entry di viewport (contengono '_' multipli nella key)
    for (const k of CELL_CACHE.keys()) {
      if (k.split('_').length > 3) { CELL_CACHE.delete(k); break; }
    }
  }
  CELL_CACHE.set(vpKey, cells);
  return cells;
}

// ─── Seleziona il livello LOD in base a latitudeDelta ─────────────────────────
function selectStep(latitudeDelta: number): number {
  for (const level of LOD_LEVELS) {
    if (latitudeDelta < level.maxLatDelta) return level.step;
  }
  return LOD_LEVELS[LOD_LEVELS.length - 1].step;
}

// ─── Applica il cap MAX_POLYGONS (prendi le celle con score più alto) ─────────
function applyCapByScore(cells: Cell[]): Cell[] {
  if (cells.length <= MAX_POLYGONS) return cells;
  // Ordina per score decrescente, prendi le top MAX_POLYGONS
  return [...cells].sort((a, b) => b.score - a.score).slice(0, MAX_POLYGONS);
}

// ─── Colore cella ─────────────────────────────────────────────────────────────
function scoreToFillColor(score: number, species: 'porcini' | 'finferli'): string {
  const alpha = Math.round((0.28 + (score / 100) * 0.54) * 255)
    .toString(16).padStart(2, '0');
  if (species === 'porcini') {
    if (score < 20) return `#4a2010${alpha}`;
    if (score < 40) return `#8B5E3C${alpha}`;
    if (score < 60) return `#b07a50${alpha}`;
    if (score < 80) return `#c8832a${alpha}`;
    return `#e8c040${alpha}`;
  } else {
    if (score < 20) return `#2a2000${alpha}`;
    if (score < 40) return `#6a5010${alpha}`;
    if (score < 60) return `#C9901A${alpha}`;
    if (score < 80) return `#e0aa30${alpha}`;
    return `#ffe060${alpha}`;
  }
}

// ─── Coordinate del rettangolo cella ─────────────────────────────────────────
function cellCoords(lat: number, lon: number, half: number) {
  return [
    { latitude: lat - half, longitude: lon - half },
    { latitude: lat - half, longitude: lon + half },
    { latitude: lat + half, longitude: lon + half },
    { latitude: lat + half, longitude: lon - half },
  ];
}

// ─── Componente ───────────────────────────────────────────────────────────────
interface Props {
  activeLayer: ActiveLayer;
  region: Region | null;
}

export function IndiceLayerPolygons({ activeLayer, region }: Props) {
  if (activeLayer === 'off' || !region) return null;

  const species = activeLayer as 'porcini' | 'finferli';
  const step = selectStep(region.latitudeDelta);
  const half = step / 2;

  const rawVisible = getVisibleCells(species, step, region);
  const visible = applyCapByScore(rawVisible);

  return (
    <>
      {visible.map((cell) => (
        <Polygon
          key={`${species}_${cell.key}_${step}`}
          coordinates={cellCoords(cell.lat, cell.lon, half)}
          fillColor={scoreToFillColor(cell.score, species)}
          strokeColor="transparent"
          strokeWidth={0}
          tappable={false}
        />
      ))}
    </>
  );
}
