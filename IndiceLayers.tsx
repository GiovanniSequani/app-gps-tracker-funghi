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


function tileUrl(species: 'porcini' | 'finferli', date: string, version: string): string {
  const url = `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${date}_v${version}/${species}/{z}/{x}/{y}.png`;
  console.log(`Caricamento tile con url: ${url}`);
  return url;
}

// ─── Componente ───────────────────────────────────────────────────────────────
interface Props {
  activeLayer: ActiveLayer;
  date: string;
  version: string;
  opacity?: number;
}

export function IndiceLayerTiles({ activeLayer, date, version, opacity = 0.85 }: Props) {
  if (activeLayer === 'off') return null;

  const species = activeLayer as 'porcini' | 'finferli';
  const sourceId = `funghi-source-${species}`;
  const layerId  = `funghi-layer-${species}`;

  return (
    <RasterSource
      key={`${date}-v${version}-${species}`}
      id={sourceId}
      tileUrlTemplates={[tileUrl(species, date, version)]}
      tileSize={256}
      minZoomLevel={8}
      maxZoomLevel={14}
    >
      <RasterLayer
        id={layerId}
        sourceID={sourceId}
        style={{ rasterOpacity: opacity }}
      />
    </RasterSource>
  );
}
