/**
 * IndiceLayers.tsx  — v6 (MapLibre)
 *
 * Layer indice funghi via RasterSource + RasterLayer di MapLibre.
 * Nessun bug di tile fantasma: il motore OpenGL di MapLibre gestisce
 * tutto internamente, incluse invalidazione cache e zoom transitions.
 *
 * Usare dentro <MapView> di @maplibre/maplibre-react-native.
 */

import React from 'react';
import { RasterLayer, RasterSource } from '@maplibre/maplibre-react-native';
import type { ActiveLayer } from './IndiceScreen';

// ─── URL Supabase ─────────────────────────────────────────────────────────────
const SUPABASE_URL    = 'https://ovdfsehovsrdzcoqdlfh.supabase.co';
const SUPABASE_BUCKET = 'tiles';
const DATE            = '2026-03-30';
const VERSION         = '1';

function tileUrl(species: 'porcini' | 'finferli'): string {
  console.log(`Caricamento tile con url: ${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${DATE}_v${VERSION}/${species}/{z}/{x}/{y}.png`);
  return `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${DATE}_v${VERSION}/${species}/{z}/{x}/{y}.png`;
}

// ─── Componente ───────────────────────────────────────────────────────────────
interface Props {
  activeLayer: ActiveLayer;
}

export function IndiceLayerTiles({ activeLayer }: Props) {
  if (activeLayer === 'off') return null;

  const species = activeLayer as 'porcini' | 'finferli';
  const sourceId = `funghi-source-${species}`;
  const layerId  = `funghi-layer-${species}`;

  return (
    <RasterSource
      key={`${DATE}-v${VERSION}-${species}`}
      id={sourceId}
      tileUrlTemplates={[tileUrl(species)]}
      tileSize={256}
      minZoomLevel={8}
      maxZoomLevel={14}
    >
      <RasterLayer
        id={layerId}
        sourceID={sourceId}
        style={{ rasterOpacity: 0.85 }}
      />
    </RasterSource>
  );
}