import { describe, expect, it, vi } from 'vitest';
import { strFromU8 } from 'fflate';

vi.mock('expo-file-system', () => ({ File: class {} }));
vi.mock('expo-sharing', () => ({ isAvailableAsync: vi.fn(), shareAsync: vi.fn() }));
vi.mock('../../security/sensitiveTempFiles', () => ({
  createSensitiveTempFileUri: vi.fn(),
  deleteSensitiveTempFile: vi.fn(),
}));

import { createDerivedGpxExport } from '../gpxExport';
import { shareDerivedGpx, type ShareGpxDependencies } from '../shareGpx';
import type { GpxTrack, ParsedGpxRoute } from '../types';

const points = [
  { pointIndex: 0, latitude: 46, longitude: 11, timestamp: 1_600_000_000_000 },
  { pointIndex: 1, latitude: 46.01, longitude: 11.01, timestamp: 1_600_000_060_000 },
];
const parsed: ParsedGpxRoute = {
  name: 'Raw',
  path: points,
  markers: [],
  startedAt: '2020-09-13T12:26:40.000Z',
  porciniCount: 0,
  finferliCount: 0,
  trackPoints: points,
  trackSegments: [{ startPointIndex: 0, endPointIndex: 1, points }],
  rawTrackPointCount: 2,
  usesTrackPoints: true,
};
const track: GpxTrack = {
  id: 'traccia-usa-e-getta',
  storage_path: 'owner/traccia-usa-e-getta.gpx.gz',
  status: 'ready',
  display_name: 'Test Android',
  original_filename: 'raw.gpx.gz',
  compressed_size_bytes: 100,
  uncompressed_size_bytes: 200,
  started_at: parsed.startedAt,
  ended_at: null,
  point_count: 2,
  distance_m: 10,
  ready_at: '2026-09-23T10:00:00Z',
  created_at: '2026-09-23T10:00:00Z',
  trim_start_point_index: null,
  trim_end_point_index: null,
};

function dependencies(shareFile = vi.fn(async () => undefined)) {
  const calls = {
    writeFile: vi.fn(),
    deleteTempFile: vi.fn(async () => undefined),
    shareFile,
  };
  const value: ShareGpxDependencies = {
    createTempFile: vi.fn(async (name) => `cache://sensitive-temp/${name}`),
    writeFile: calls.writeFile,
    isSharingAvailable: vi.fn(async () => true),
    shareFile: calls.shareFile,
    deleteTempFile: calls.deleteTempFile,
  };
  return { calls, value };
}

describe('cloud GPX share Android', () => {
  it('scrive e condivide la copia derivata della traccia usa-e-getta', async () => {
    const derived = createDerivedGpxExport(track, parsed, []);
    const { calls, value } = dependencies();

    await shareDerivedGpx(derived, track.display_name, value);

    expect(calls.writeFile).toHaveBeenCalledWith(
      'cache://sensitive-temp/Test Android.gpx',
      derived.bytes,
    );
    expect(strFromU8(derived.bytes)).toContain('<name>Test Android</name>');
    expect(calls.shareFile).toHaveBeenCalledWith(
      'cache://sensitive-temp/Test Android.gpx',
      'Test Android',
    );
    expect(calls.deleteTempFile).toHaveBeenCalledWith('cache://sensitive-temp/Test Android.gpx');
  });

  it('pulisce il GPX temporaneo se la condivisione viene annullata', async () => {
    const shareFile = vi.fn(async () => { throw new Error('share cancelled'); });
    const { calls, value } = dependencies(shareFile);
    const derived = createDerivedGpxExport(track, parsed, []);

    await expect(shareDerivedGpx(derived, track.display_name, value)).rejects.toThrow('share cancelled');
    expect(calls.deleteTempFile).toHaveBeenCalledWith('cache://sensitive-temp/Test Android.gpx');
  });
});
