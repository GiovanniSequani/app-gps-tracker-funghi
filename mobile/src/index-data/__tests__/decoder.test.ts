import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { PointDataError } from '../../point-details/errors';
import { decodeIndexCell, decodeIndexField, decompressIndexChunk } from '../decoder';
import { current, manifest, rawCell } from './fixtures';

describe('index-data decoder', () => {
  it('decomprime zlib e valida la lunghezza raw', () => {
    const raw = new Uint8Array(rawCell());
    const compressed = zlibSync(raw);
    const buffer = compressed.buffer.slice(
      compressed.byteOffset,
      compressed.byteOffset + compressed.byteLength,
    ) as ArrayBuffer;
    expect(new Uint8Array(decompressIndexChunk(buffer, 30))).toEqual(raw);
    expect(() => decompressIndexChunk(buffer, 29)).toThrow(PointDataError);
  });

  it('decodifica little-endian, dtype, offset, scale, nodata, score e labels', () => {
    const contract = manifest();
    const data = decodeIndexCell(rawCell(), contract, contract.chunks[0], 0, 0, current);
    expect(data.porciniScore).toBeCloseTo(78.5);
    expect(data.finferliScore).toBeCloseTo(41.25);
    expect(data.porciniBaseScore).toBeCloseTo(65.43);
    expect(data.diagnostics.habitat).toBeCloseTo(0.5);
    expect(data.diagnosticLabels.temporal_phase).toBe('fase_favorevole');
    expect(data.diagnosticLabels.temperature_band).toBe('ottimale');
    expect(data.diagnostics.presence_carryover).toBeCloseTo(4.25);
    expect(data.diagnostics.rain_recovery_seed).toBeNull();
  });

  it('rifiuta dtype e offset incompatibili', () => {
    const view = new DataView(rawCell());
    expect(() => decodeIndexField(view, 0, 30, {
      name: 'bad', dtype: 'complex64', offset_bytes: 0,
    })).toThrow(/Dtype/);
    expect(() => decodeIndexField(view, 0, 30, {
      name: 'bad', dtype: 'uint16', offset_bytes: 30,
    })).toThrow(/Offset/);
  });

  it('usa offset e dimensioni dichiarati per un chunk di bordo', () => {
    const contract = manifest();
    const edge = { ...contract.chunks[0], row: 9, col: 13, row_offset: 499, col_offset: 699 };
    const data = decodeIndexCell(rawCell(), contract, edge, 0, 0, current);
    expect(data.row).toBe(499);
    expect(data.col).toBe(699);
  });
});
