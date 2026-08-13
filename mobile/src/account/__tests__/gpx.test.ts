import { gunzipSync, strFromU8 } from 'fflate';
import { describe, expect, it, vi } from 'vitest';

const cryptoMocks = vi.hoisted(() => ({ digest: vi.fn() }));

vi.mock('expo-crypto', async () => {
  const { webcrypto } = await import('node:crypto');
  cryptoMocks.digest.mockImplementation((algorithm: string, data: ArrayBufferView) => (
    webcrypto.subtle.digest(
      algorithm,
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
    )
  ));
  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    digest: cryptoMocks.digest,
  };
});

import { buildGpxXml, calculateBbox, calculateDistanceM, prepareGpxUpload } from '../gpx';
import type { ArchiveConfig } from '../types';

const config: ArchiveConfig = {
  singleton_id: 1,
  max_tracks_per_user: 50,
  max_compressed_bytes: 1_000_000,
  max_uncompressed_bytes: 1_000_000,
  terms_version: 'v1',
  privacy_version: 'v1',
  research_consent_version: 'v1',
  updated_at: '2026-08-08T00:00:00Z',
};

const points = [
  { latitude: 45, longitude: 10, timestamp: 1_700_000_000_000 },
  { latitude: 45.001, longitude: 10.002, timestamp: 1_700_000_060_000 },
];

describe('GPX cloud preparation', () => {
  it('genera XML valido ed esegue escaping dei dati utente', () => {
    const xml = buildGpxXml('Bosco & sera', points, [{ ...points[0], name: '<porcino>', tipo: 'A&B' }]);
    expect(xml).toContain('Bosco &amp; sera');
    expect(xml).toContain('&lt;porcino&gt;');
    expect(xml).toContain('xmlns="http://www.topografix.com/GPX/1/1"');
  });

  it('calcola bbox e distanza senza valori hardcoded', () => {
    expect(calculateBbox(points)).toEqual({ west: 10, south: 45, east: 10.002, north: 45.001 });
    expect(calculateDistanceM(points)).toBeGreaterThan(180);
    expect(calculateDistanceM(points)).toBeLessThan(220);
  });

  it('comprime gzip e calcola hash sui byte compressi esatti', async () => {
    const prepared = await prepareGpxUpload('Test', points, [], config);
    expect(prepared.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(cryptoMocks.digest).toHaveBeenLastCalledWith('SHA-256', expect.any(Uint8Array));
    expect(cryptoMocks.digest.mock.lastCall?.[1]).not.toBeInstanceOf(ArrayBuffer);
    expect(prepared.compressedSizeBytes).toBe(prepared.bytes.byteLength);
    expect(strFromU8(gunzipSync(prepared.bytes))).toContain('<trkpt');
    expect(prepared.startedAt).toBe(new Date(points[0].timestamp).toISOString());
    expect(prepared.endedAt).toBe(new Date(points[1].timestamp).toISOString());
    expect(prepared.pointCount).toBe(2);
  });

  it('applica i limiti letti dalla configurazione', async () => {
    await expect(prepareGpxUpload('Test', points, [], { ...config, max_uncompressed_bytes: 10 }))
      .rejects.toMatchObject({ code: 'size_exceeded' });
  });
});
