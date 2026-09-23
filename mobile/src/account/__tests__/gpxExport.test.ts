import { describe, expect, it } from 'vitest';
import { strFromU8 } from 'fflate';
import { createDerivedGpxExport } from '../gpxExport';
import type { GpxMushroomMarker, GpxTrack, ParsedGpxRoute } from '../types';

const track: GpxTrack = {
  id: 'usa-e-getta',
  storage_path: 'owner/usa-e-getta.gpx.gz',
  status: 'ready',
  display_name: 'Valle rinominata',
  original_filename: 'traccia-storica.gpx.gz',
  compressed_size_bytes: 100,
  uncompressed_size_bytes: 200,
  started_at: null,
  ended_at: null,
  point_count: 5,
  distance_m: 100,
  trim_start_point_index: 1,
  trim_end_point_index: 3,
  ready_at: '2026-09-23T10:00:00Z',
  created_at: '2026-09-23T10:00:00Z',
};

const points = Array.from({ length: 5 }, (_, pointIndex) => ({
  pointIndex,
  latitude: 46 + pointIndex / 100,
  longitude: 11 + pointIndex / 100,
  timestamp: Date.parse(`2020-10-10T0${pointIndex}:00:00Z`),
}));

const parsed: ParsedGpxRoute = {
  name: 'Nome raw',
  path: points,
  markers: [{
    latitude: 46.2,
    longitude: 11.2,
    timestamp: null,
    name: 'Porcino storico 7',
    tipo: 'Porcino',
  }],
  startedAt: '2020-10-10T00:00:00.000Z',
  porciniCount: 1,
  finferliCount: 0,
  trackPoints: points,
  trackSegments: [{ startPointIndex: 0, endPointIndex: 4, points }],
  rawTrackPointCount: 5,
  usesTrackPoints: true,
};

const marker = (
  pointIndex: number,
  species: 'porcini' | 'finferli',
  count: number,
): GpxMushroomMarker => ({
  id: `${species}-${pointIndex}`,
  track_id: track.id,
  track_point_index: pointIndex,
  latitude: 0,
  longitude: 0,
  species,
  count,
  created_at: '2026-09-23T10:00:00Z',
  updated_at: '2026-09-23T10:00:00Z',
});

describe('derived cloud GPX export', () => {
  it('usa nome e trim correnti senza alterare il raw', () => {
    const original = JSON.stringify(parsed);
    const exported = createDerivedGpxExport(track, parsed, []);
    const xml = strFromU8(exported.bytes);

    expect(exported.filename).toBe('Valle rinominata.gpx');
    expect(xml).toContain('<name>Valle rinominata</name>');
    expect(xml).toContain('lon="11.01"');
    expect(xml).toContain('lon="11.02"');
    expect(xml).toContain('lon="11.03"');
    expect(xml).not.toContain('<trkpt lat="46" lon="11"');
    expect(xml).not.toContain('lon="11.04"');
    expect(JSON.stringify(parsed)).toBe(original);
  });

  it('preserva nomi storici e numera i nuovi marker per specie entro il trim', () => {
    const markers = [
      marker(0, 'porcini', 9),
      marker(2, 'finferli', 2),
      marker(3, 'porcini', 3),
      marker(3, 'finferli', 1),
    ];
    const xml = strFromU8(createDerivedGpxExport(track, parsed, markers).bytes);

    expect(xml).toContain('<name>Porcino storico 7</name>');
    expect(xml).toContain('<name>finferlo1</name>');
    expect(xml).toContain('<name>finferlo2</name>');
    expect(xml).toContain('<name>porcino1</name>');
    expect(xml).toContain('<funghitracker:count>2</funghitracker:count>');
    expect(xml).toContain('<funghitracker:count>3</funghitracker:count>');
    expect(xml).not.toContain('<funghitracker:count>9</funghitracker:count>');
    expect(xml).toContain('<wpt lat="46.02" lon="11.02">');
  });

  it('mantiene compatibili i percorsi storici di tipo route', () => {
    const historical = { ...parsed, usesTrackPoints: false };
    const xml = strFromU8(createDerivedGpxExport({
      ...track,
      trim_start_point_index: null,
      trim_end_point_index: null,
    }, historical, []).bytes);

    expect(xml).toContain('<rte>');
    expect(xml).toContain('<rtept lat="46" lon="11">');
    expect(xml).not.toContain('<trk>');
  });
});
