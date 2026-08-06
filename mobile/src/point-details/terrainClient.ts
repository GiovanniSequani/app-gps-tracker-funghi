import { PointDataError } from './errors';
import { coordinateToTerrainCell } from './geo';
import {
  fetchStorageBuffer,
  fetchStorageJson,
} from './supabasePublic';
import {
  decodeTerrainCell,
  terrainCellByteOffset,
  TERRAIN_BYTES_PER_CELL,
} from './terrainDecoder';
import type {
  PointCoordinate,
  PointDataResult,
  TerrainChunkDescriptor,
  TerrainCurrentPointer,
  TerrainDetails,
  TerrainManifest,
} from './types';

const TERRAIN_BUCKET = 'terrain';
const TERRAIN_CURRENT_TTL_MS = 5 * 60 * 1000;

let currentCache:
  | { expiresAt: number; value: TerrainCurrentPointer }
  | undefined;
const manifestCache = new Map<string, TerrainManifest>();
const chunkCache = new Map<string, ArrayBuffer>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateCurrent(value: TerrainCurrentPointer): TerrainCurrentPointer {
  if (
    !value ||
    typeof value.version !== 'string' ||
    typeof value.manifest_path !== 'string' ||
    value.manifest_path.length === 0
  ) {
    throw new PointDataError('contract', 'Invalid terrain current pointer');
  }
  return value;
}

function validateChunk(value: unknown): value is TerrainChunkDescriptor {
  if (!isRecord(value)) return false;
  return (
    Number.isInteger(value.row) &&
    Number.isInteger(value.col) &&
    Number.isInteger(value.row_offset) &&
    Number.isInteger(value.col_offset) &&
    Number.isInteger(value.rows) &&
    Number.isInteger(value.cols) &&
    typeof value.path === 'string' &&
    Number.isInteger(value.byte_length)
  );
}

function validateManifest(value: TerrainManifest): TerrainManifest {
  const bbox = value?.bbox;
  if (
    !value ||
    value.crs !== 'EPSG:4326' ||
    value.latitude_order !== 'ascending_south_to_north' ||
    value.longitude_order !== 'ascending_west_to_east' ||
    !Number.isInteger(value.rows) ||
    !Number.isInteger(value.cols) ||
    !Number.isFinite(value.step_deg) ||
    !Number.isFinite(value.origin_lat) ||
    !Number.isFinite(value.origin_lon) ||
    !isRecord(bbox) ||
    !(['west', 'east', 'south', 'north'] as const).every((key) =>
      Number.isFinite(bbox[key]),
    ) ||
    !Number.isInteger(value.chunk_size?.rows) ||
    !Number.isInteger(value.chunk_size?.cols) ||
    !Array.isArray(value.chunks) ||
    !value.chunks.every(validateChunk)
  ) {
    throw new PointDataError('contract', 'Invalid terrain manifest');
  }
  if (
    value.binary_layout?.bytes_per_cell !== undefined &&
    value.binary_layout.bytes_per_cell !== TERRAIN_BYTES_PER_CELL
  ) {
    throw new PointDataError('contract', 'Unsupported terrain cell size');
  }
  if (
    value.binary_layout?.endianness !== undefined &&
    value.binary_layout.endianness !== 'little'
  ) {
    throw new PointDataError('contract', 'Unsupported terrain byte order');
  }
  return value;
}

async function getTerrainCurrent(
  signal?: AbortSignal,
): Promise<TerrainCurrentPointer> {
  if (currentCache && currentCache.expiresAt > Date.now()) {
    return currentCache.value;
  }
  const current = validateCurrent(
    await fetchStorageJson<TerrainCurrentPointer>(
      TERRAIN_BUCKET,
      'current.json',
      signal,
    ),
  );
  currentCache = {
    value: current,
    expiresAt: Date.now() + TERRAIN_CURRENT_TTL_MS,
  };
  return current;
}

async function getTerrainManifest(
  current: TerrainCurrentPointer,
  signal?: AbortSignal,
): Promise<TerrainManifest> {
  const key = `${current.version}/${current.manifest_path}`;
  const cached = manifestCache.get(key);
  if (cached) return cached;
  const manifest = validateManifest(
    await fetchStorageJson<TerrainManifest>(
      TERRAIN_BUCKET,
      current.manifest_path,
      signal,
    ),
  );
  manifestCache.set(key, manifest);
  return manifest;
}

export function findTerrainChunk(
  manifest: TerrainManifest,
  chunkRow: number,
  chunkCol: number,
): TerrainChunkDescriptor | null {
  return (
    manifest.chunks.find(
      (chunk) => chunk.row === chunkRow && chunk.col === chunkCol,
    ) ?? null
  );
}

async function getTerrainChunkBuffer(
  version: string,
  chunk: TerrainChunkDescriptor,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const key = `${version}/${chunk.row}/${chunk.col}/${chunk.path}`;
  const cached = chunkCache.get(key);
  if (cached) return cached;
  const buffer = await fetchStorageBuffer(TERRAIN_BUCKET, chunk.path, signal);
  if (buffer.byteLength !== chunk.byte_length) {
    throw new PointDataError(
      'contract',
      `Terrain chunk byte length mismatch: ${buffer.byteLength}/${chunk.byte_length}`,
    );
  }
  chunkCache.set(key, buffer);
  return buffer;
}

export async function loadTerrainDetails(
  point: PointCoordinate,
  signal?: AbortSignal,
): Promise<PointDataResult<TerrainDetails>> {
  const current = await getTerrainCurrent(signal);
  const manifest = await getTerrainManifest(current, signal);
  const cell = coordinateToTerrainCell(point, manifest, manifest.chunk_size);
  if (!cell) return { status: 'outside' };

  const chunk = findTerrainChunk(manifest, cell.chunkRow, cell.chunkCol);
  if (!chunk) {
    return {
      status: 'unavailable',
      reason: 'Chunk terreno non disponibile per questo punto.',
    };
  }
  if (cell.localRow >= chunk.rows || cell.localCol >= chunk.cols) {
    throw new PointDataError('contract', 'Terrain edge chunk does not contain cell');
  }

  const buffer = await getTerrainChunkBuffer(current.version, chunk, signal);
  const byteOffset = terrainCellByteOffset(
    cell.localRow,
    cell.localCol,
    chunk.cols,
  );
  const values = decodeTerrainCell(buffer, byteOffset, chunk.byte_length);

  return {
    status: 'ready',
    data: {
      version: current.version,
      cell,
      chunk: {
        row: chunk.row,
        col: chunk.col,
        path: chunk.path,
      },
      ...values,
    },
  };
}

export function clearTerrainCachesForTests(): void {
  currentCache = undefined;
  manifestCache.clear();
  chunkCache.clear();
}
