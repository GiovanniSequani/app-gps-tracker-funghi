import { zlibSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearIndexDataCachesForTests, loadIndexPoint } from '../client';
import { IndexOutsideCoverageError } from '../errors';
import type { IndexCurrent, IndexManifest } from '../types';
import { manifest as baseManifest, rawCell } from './fixtures';

function compressedScore(score: number): Uint8Array {
  const raw = new Uint8Array(rawCell());
  new DataView(raw.buffer).setFloat32(0, score, true);
  return zlibSync(raw);
}

function current(version: string): IndexCurrent {
  return {
    contract_version: 1,
    dataset_sha256: `dataset-${version}`,
    index_date: '2026-07-26',
    manifest_path: `${version}/manifest.json`,
    version,
  };
}

function manifest(version: string, compressedLength: number): IndexManifest {
  const value = baseManifest(compressedLength);
  value.version = version;
  value.dataset_sha256 = `dataset-${version}`;
  value.chunks[0].path = `${version}/chunks/r00_c00.bin.zlib`;
  return value;
}

describe('index-data public client', () => {
  beforeEach(() => {
    clearIndexDataCachesForTests();
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'public-anon-test';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-26T10:00:00Z'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('legge pointer, manifest e un solo chunk, poi invalida le cache alla nuova versione', async () => {
    const v1 = compressedScore(70);
    const v2 = compressedScore(82);
    let currentReads = 0;
    const requests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('/index-data/current.json')) {
        currentReads += 1;
        return new Response(JSON.stringify(current(currentReads === 1 ? 'v1' : 'v2')), { status: 200 });
      }
      if (url.endsWith('/index-data/v1/manifest.json')) {
        return new Response(JSON.stringify(manifest('v1', v1.byteLength)), { status: 200 });
      }
      if (url.endsWith('/index-data/v2/manifest.json')) {
        return new Response(JSON.stringify(manifest('v2', v2.byteLength)), { status: 200 });
      }
      if (url.endsWith('/index-data/v1/chunks/r00_c00.bin.zlib')) {
        return new Response(v1.buffer.slice(v1.byteOffset, v1.byteOffset + v1.byteLength) as ArrayBuffer);
      }
      if (url.endsWith('/index-data/v2/chunks/r00_c00.bin.zlib')) {
        return new Response(v2.buffer.slice(v2.byteOffset, v2.byteOffset + v2.byteLength) as ArrayBuffer);
      }
      throw new Error(`URL inatteso: ${url}`);
    });

    const point = { latitude: 46, longitude: 11 };
    await expect(loadIndexPoint(point)).resolves.toMatchObject({ version: 'v1', porciniScore: 70 });
    await expect(loadIndexPoint(point)).resolves.toMatchObject({ version: 'v1', porciniScore: 70 });
    expect(requests).toHaveLength(3);
    expect(requests.some((url) => url.includes('/storage/v1/object/list/'))).toBe(false);

    vi.setSystemTime(new Date('2026-07-26T10:01:01Z'));
    await expect(loadIndexPoint(point)).resolves.toMatchObject({ version: 'v2', porciniScore: 82 });
    expect(requests).toHaveLength(6);
  });

  it('controlla il bbox prima del clamp e non scarica un chunk di bordo', async () => {
    const compressed = compressedScore(70);
    const requests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('/current.json')) return new Response(JSON.stringify(current('v1')));
      if (url.endsWith('/manifest.json')) return new Response(JSON.stringify(manifest('v1', compressed.byteLength)));
      throw new Error('Il chunk non deve essere richiesto');
    });
    await expect(loadIndexPoint({ latitude: 46, longitude: 12 }))
      .rejects.toBeInstanceOf(IndexOutsideCoverageError);
    expect(requests).toHaveLength(2);
  });

  it('rifiuta una lunghezza compressa incoerente', async () => {
    const compressed = compressedScore(70);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/current.json')) return new Response(JSON.stringify(current('v1')));
      if (url.endsWith('/manifest.json')) return new Response(JSON.stringify(manifest('v1', compressed.byteLength + 1)));
      return new Response(compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength) as ArrayBuffer);
    });
    await expect(loadIndexPoint({ latitude: 46, longitude: 11 }))
      .rejects.toThrow(/Lunghezza compressa/);
  });
});
