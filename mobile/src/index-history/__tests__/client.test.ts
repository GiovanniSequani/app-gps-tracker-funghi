import { zlibSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearIndexHistoryCachesForTests, loadIndexHistoryPoint } from '../client';
import { IndexHistoryOutsideCoverageError } from '../errors';
import { historyCurrent, historyManifest, historyRawCell } from './fixtures';

function compressedHistory(score: number): Uint8Array {
  const raw = historyRawCell([score, Number.NaN, score + 1]);
  return zlibSync(new Uint8Array(raw));
}

describe('index-history public client', () => {
  beforeEach(() => {
    clearIndexHistoryCachesForTests();
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'public-anon-test';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T10:00:00Z'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('legge pointer, manifest e un solo chunk e invalida le cache al cambio versione', async () => {
    const v1 = compressedHistory(40);
    const v2 = compressedHistory(60);
    let pointerReads = 0;
    const requests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('/index-history/current.json')) {
        pointerReads += 1;
        return new Response(JSON.stringify(historyCurrent(pointerReads === 1 ? 'v1' : 'v2')));
      }
      const version = url.includes('/v2/') ? 'v2' : 'v1';
      const bytes = version === 'v2' ? v2 : v1;
      if (url.endsWith(`/${version}/manifest.json`)) {
        return new Response(JSON.stringify(historyManifest(version, bytes.byteLength)));
      }
      if (url.endsWith(`/${version}/chunks/r00_c00.bin.zlib`)) {
        return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      }
      throw new Error(`URL inatteso: ${url}`);
    });

    const point = { latitude: 46, longitude: 11 };
    const first = await loadIndexHistoryPoint(point);
    expect(first.version).toBe('v1');
    expect(first.days[0].porciniScore).toBe(40);
    await expect(loadIndexHistoryPoint(point)).resolves.toMatchObject({ version: 'v1' });
    expect(requests).toHaveLength(3);
    expect(requests.some((url) => url.includes('/storage/v1/object/list/'))).toBe(false);

    vi.setSystemTime(new Date('2026-08-25T10:01:01Z'));
    const updated = await loadIndexHistoryPoint(point);
    expect(updated.version).toBe('v2');
    expect(updated.days[0].porciniScore).toBe(60);
    expect(requests).toHaveLength(6);
  });

  it('controlla il bbox prima del clamp e non scarica chunk', async () => {
    const bytes = compressedHistory(40);
    const requests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('/current.json')) return new Response(JSON.stringify(historyCurrent()));
      if (url.endsWith('/manifest.json')) {
        return new Response(JSON.stringify(historyManifest('v1', bytes.byteLength)));
      }
      throw new Error('Il chunk non deve essere richiesto');
    });
    await expect(loadIndexHistoryPoint({ latitude: 46, longitude: 12 }))
      .rejects.toBeInstanceOf(IndexHistoryOutsideCoverageError);
    expect(requests).toHaveLength(2);
  });

  it('rifiuta lunghezza compressa e manifest incompatibili', async () => {
    const bytes = compressedHistory(40);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/current.json')) return new Response(JSON.stringify(historyCurrent()));
      if (url.endsWith('/manifest.json')) {
        return new Response(JSON.stringify(historyManifest('v1', bytes.byteLength + 1)));
      }
      return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    });
    await expect(loadIndexHistoryPoint({ latitude: 46, longitude: 11 }))
      .rejects.toThrow(/Lunghezza compressa/);
  });
});
