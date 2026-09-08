import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { PointDataError } from '../../point-details/errors';
import { decodeIndexHistoryCell, decompressIndexHistoryChunk } from '../decoder';
import { historyCurrent, historyManifest, historyRawCell } from './fixtures';

function compressed(buffer: ArrayBuffer): ArrayBuffer {
  const value = zlibSync(new Uint8Array(buffer));
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

describe('index-history decoder', () => {
  it('decomprime zlib e verifica la lunghezza raw', () => {
    const raw = historyRawCell();
    expect(new Uint8Array(decompressIndexHistoryChunk(compressed(raw), raw.byteLength)))
      .toEqual(new Uint8Array(raw));
    expect(() => decompressIndexHistoryChunk(compressed(raw), raw.byteLength - 1))
      .toThrow(PointDataError);
  });

  it('usa little-endian, shape e offset del manifest e conserva i gap nodata', () => {
    const manifest = historyManifest('v1', 1);
    const result = decodeIndexHistoryCell(
      historyRawCell(),
      manifest,
      manifest.chunks[0],
      0,
      0,
      historyCurrent(),
    );
    expect(result.days).toEqual([
      { date: '2026-08-23', porciniScore: 10.5, finferliScore: 20.25 },
      { date: '2026-08-24', porciniScore: null, finferliScore: null },
      { date: '2026-08-25', porciniScore: 75.25, finferliScore: 52.5 },
    ]);
  });

  it('supporta un chunk di bordo tramite gli offset reali', () => {
    const manifest = historyManifest('v1', 1);
    const edge = { ...manifest.chunks[0], row: 9, col: 13, row_offset: 499, col_offset: 699 };
    const result = decodeIndexHistoryCell(
      historyRawCell(), manifest, edge, 0, 0, historyCurrent(),
    );
    expect(result.row).toBe(499);
    expect(result.col).toBe(699);
  });

  it('rifiuta dtype, shape, valori e lunghezze incompatibili', () => {
    const badDtype = historyManifest('v1', 1);
    badDtype.binary_layout.fields[0].dtype = 'float64';
    expect(() => decodeIndexHistoryCell(
      historyRawCell(), badDtype, badDtype.chunks[0], 0, 0, historyCurrent(),
    )).toThrow(/Layout del campo/);

    const invalidScore = historyRawCell([101, Number.NaN, 50]);
    const manifest = historyManifest('v1', 1);
    expect(() => decodeIndexHistoryCell(
      invalidScore, manifest, manifest.chunks[0], 0, 0, historyCurrent(),
    )).toThrow(/0-100/);
    expect(() => decodeIndexHistoryCell(
      invalidScore.slice(0, invalidScore.byteLength - 1),
      manifest,
      manifest.chunks[0],
      0,
      0,
      historyCurrent(),
    )).toThrow(/Lunghezza raw/);
  });
});
