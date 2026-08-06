import { describe, expect, it } from 'vitest';
import {
  decodeTerrainCell,
  terrainCellByteOffset,
  TERRAIN_ASPECT_NODATA,
  TERRAIN_BYTES_PER_CELL,
  TERRAIN_ELEVATION_NODATA,
  TERRAIN_FOREST_NODATA,
} from '../terrainDecoder';
import { findTerrainChunk } from '../terrainClient';
import type { TerrainManifest } from '../types';

function terrainBuffer(
  elevation: number,
  forest: number,
  aspect: number,
  tpi: number,
): ArrayBuffer {
  const buffer = new ArrayBuffer(TERRAIN_BYTES_PER_CELL);
  const view = new DataView(buffer);
  view.setInt16(0, elevation, true);
  view.setUint8(2, forest);
  view.setUint16(3, aspect, true);
  view.setUint8(5, tpi);
  return buffer;
}

describe('terrain binary decoding', () => {
  it('decodes the little-endian six-byte cell layout', () => {
    expect(decodeTerrainCell(terrainBuffer(1543, 72, 42, 3), 0, 6)).toEqual({
      elevation: 1543,
      forestPercent: 72,
      aspectDegrees: 42,
      tpiCategory: 3,
    });
  });

  it('maps every terrain nodata sentinel without inventing zeroes', () => {
    expect(
      decodeTerrainCell(
        terrainBuffer(
          TERRAIN_ELEVATION_NODATA,
          TERRAIN_FOREST_NODATA,
          TERRAIN_ASPECT_NODATA,
          0,
        ),
        0,
        6,
      ),
    ).toEqual({
      elevation: null,
      forestPercent: null,
      aspectDegrees: null,
      tpiCategory: 0,
    });
  });

  it('validates byte_length before reading', () => {
    expect(() =>
      decodeTerrainCell(terrainBuffer(10, 20, 30, 1), 0, 12),
    ).toThrow(/byte length mismatch/i);
  });

  it('calculates the final cell offset in a 50 by 50 edge chunk', () => {
    expect(terrainCellByteOffset(49, 49, 50)).toBe(14_994);
    const chunk = new ArrayBuffer(15_000);
    expect(() => decodeTerrainCell(chunk, 14_994, 15_000)).not.toThrow();
  });

  it('finds an edge chunk from the manifest list without constructing its path', () => {
    const edgeChunk = {
      row: 9,
      col: 13,
      row_offset: 450,
      col_offset: 650,
      rows: 50,
      cols: 50,
      path: 'v1/arbitrary-layout/edge.bin',
      byte_length: 15_000,
    };
    const manifest = {
      contract_version: 1,
      version: 'v1',
      crs: 'EPSG:4326',
      latitude_order: 'ascending_south_to_north',
      longitude_order: 'ascending_west_to_east',
      rows: 500,
      cols: 700,
      step_deg: 0.003,
      origin_lat: 45.6015,
      origin_lon: 10.4015,
      bbox: { west: 10.4, east: 12.5, south: 45.6, north: 47.1 },
      chunk_size: { rows: 50, cols: 50 },
      chunks: [edgeChunk],
    } satisfies TerrainManifest;

    expect(findTerrainChunk(manifest, 9, 13)?.path).toBe(
      'v1/arbitrary-layout/edge.bin',
    );
    expect(findTerrainChunk(manifest, 0, 0)).toBeNull();
  });
});
