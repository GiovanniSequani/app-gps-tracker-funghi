/**
 * IndiceLayers.tsx  — v5
 *
 * Layer indice funghi via tile PNG XYZ su react-native-maps.
 * Nessun Polygon, nessun bug Android, performance native.
 *
 * Le tile vengono servite da Supabase Storage e caricate da
 * react-native-maps tramite il componente UrlTile nativo.
 *
 * Per aggiornare l'URL delle tile (quando cambiano su Supabase),
 * modifica solo SUPABASE_URL qui sotto.
 */

import React from 'react';
import { UrlTile } from 'react-native-maps';
import type { ActiveLayer } from './IndiceScreen';

// ─── URL Supabase ─────────────────────────────────────────────────────────────
// Sostituisci con il tuo Project URL
const SUPABASE_URL    = 'https://ovdfsehovsrdzcoqdlfh.supabase.co';
const SUPABASE_BUCKET = 'tiles';

function tileUrl(species: 'porcini' | 'finferli'): string {
  return `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${species}/{z}/{x}/{y}.png`;
}

// ─── Componente ───────────────────────────────────────────────────────────────
interface Props {
  activeLayer: ActiveLayer;
}

export function IndiceLayerTiles({ activeLayer }: Props) {
  if (activeLayer === 'off') return null;

  const species = activeLayer as 'porcini' | 'finferli';

  return (
    <UrlTile
      key={species}
      urlTemplate={tileUrl(species)}
      opacity={0.75}
      zIndex={1}
      maximumZ={14}
      minimumZ={8}
      shouldReplaceMapContent={false}
      tileSize={256}
    />
  );
}
