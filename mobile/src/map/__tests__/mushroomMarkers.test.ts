import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { clusterMushroomFeatures, mushroomMarkersToGeoJSON } from '../mushroomMarkers';

describe('mushroomMarkersToGeoJSON', () => {
  it('usa lo stesso formato per marker registrati e aggiunti in modifica', () => {
    const shape = mushroomMarkersToGeoJSON([
      { latitude: 46.1, longitude: 11.1, species: 'porcini', count: 1 },
      { latitude: 46.1, longitude: 11.1, species: 'porcini', count: 3 },
      { latitude: 46.2, longitude: 11.2, species: 'finferli', count: 2 },
    ]);

    expect(shape.features).toHaveLength(2);
    expect(shape.features.map((feature) => feature.properties)).toEqual([
      { species: 'porcini', count: 4, label: 'P4', porciniCount: 4, finferliCount: 0 },
      { species: 'finferli', count: 2, label: 'F2', porciniCount: 0, finferliCount: 2 },
    ]);
  });

  it('ignora coordinate e conteggi non validi', () => {
    const shape = mushroomMarkersToGeoJSON([
      { latitude: Number.NaN, longitude: 11, species: 'porcini', count: 1 },
      { latitude: 46, longitude: 11, species: 'finferli', count: 0 },
    ]);

    expect(shape.features).toEqual([]);
  });

  it('usa marker nativi senza font o SymbolLayer remoti', () => {
    const app = readFileSync(resolve(process.cwd(), 'App.tsx'), 'utf8');
    expect(app.match(/<MushroomMarkerBadge/g)).toHaveLength(2);
    expect(app).not.toContain('demotiles.maplibre.org/font');
    expect(app).not.toContain('SymbolLayer');
  });

  it('accorpa marker vicini quando si riduce lo zoom e somma le specie', () => {
    const shape = mushroomMarkersToGeoJSON([
      { latitude: 46.1, longitude: 11.1, species: 'porcini', count: 2 },
      { latitude: 46.1004, longitude: 11.1004, species: 'finferli', count: 3 },
      { latitude: 46.4, longitude: 11.4, species: 'porcini', count: 1 },
    ]);

    const clustered = clusterMushroomFeatures(shape.features, 12);
    expect(clustered).toHaveLength(2);
    expect(clustered.find((feature) => feature.properties.count === 5)?.properties).toEqual({
      species: 'mixed', count: 5, label: 'P2 F3', porciniCount: 2, finferliCount: 3,
    });
  });

  it('mantiene separati i marker allo zoom ravvicinato', () => {
    const shape = mushroomMarkersToGeoJSON([
      { latitude: 46.1, longitude: 11.1, species: 'porcini', count: 1 },
      { latitude: 46.1004, longitude: 11.1004, species: 'finferli', count: 1 },
    ]);
    expect(clusterMushroomFeatures(shape.features, 16)).toBe(shape.features);
  });

  it('unisce specie diverse nello stesso punto senza sovrapporle', () => {
    const shape = mushroomMarkersToGeoJSON([
      { latitude: 46.1, longitude: 11.1, species: 'porcini', count: 2 },
      { latitude: 46.1, longitude: 11.1, species: 'finferli', count: 3 },
    ]);
    expect(shape.features).toHaveLength(1);
    expect(shape.features[0].properties).toEqual({
      species: 'mixed', count: 5, label: 'P2 F3', porciniCount: 2, finferliCount: 3,
    });
  });
});
