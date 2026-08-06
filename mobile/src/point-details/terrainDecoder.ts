import { PointDataError } from './errors';
import type { TerrainValues } from './types';

export const TERRAIN_BYTES_PER_CELL = 6;
export const TERRAIN_ELEVATION_NODATA = -32768;
export const TERRAIN_FOREST_NODATA = 255;
export const TERRAIN_ASPECT_NODATA = 65535;

export function terrainCellByteOffset(
  localRow: number,
  localCol: number,
  chunkCols: number,
): number {
  if (
    !Number.isInteger(localRow) ||
    localRow < 0 ||
    !Number.isInteger(localCol) ||
    localCol < 0 ||
    !Number.isInteger(chunkCols) ||
    chunkCols <= 0 ||
    localCol >= chunkCols
  ) {
    throw new PointDataError('contract', 'Invalid terrain cell offset');
  }
  return (localRow * chunkCols + localCol) * TERRAIN_BYTES_PER_CELL;
}

export function decodeTerrainCell(
  buffer: ArrayBuffer,
  byteOffset: number,
  expectedByteLength?: number,
): TerrainValues {
  if (
    expectedByteLength !== undefined &&
    buffer.byteLength !== expectedByteLength
  ) {
    throw new PointDataError(
      'contract',
      `Terrain chunk byte length mismatch: ${buffer.byteLength}/${expectedByteLength}`,
    );
  }
  if (
    !Number.isInteger(byteOffset) ||
    byteOffset < 0 ||
    byteOffset + TERRAIN_BYTES_PER_CELL > buffer.byteLength
  ) {
    throw new PointDataError('contract', 'Terrain cell exceeds chunk bounds');
  }

  const view = new DataView(buffer);
  const rawElevation = view.getInt16(byteOffset, true);
  const rawForest = view.getUint8(byteOffset + 2);
  const rawAspect = view.getUint16(byteOffset + 3, true);
  const rawTpi = view.getUint8(byteOffset + 5);

  return {
    elevation:
      rawElevation === TERRAIN_ELEVATION_NODATA ? null : rawElevation,
    forestPercent: rawForest === TERRAIN_FOREST_NODATA ? null : rawForest,
    aspectDegrees: rawAspect === TERRAIN_ASPECT_NODATA ? null : rawAspect,
    tpiCategory:
      rawTpi === 1 || rawTpi === 2 || rawTpi === 3 ? rawTpi : 0,
  };
}

