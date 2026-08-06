import { PointDataError } from '../point-details/errors';
import { coordinateToTerrainCell } from '../point-details/geo';
import {
  fetchStorageBuffer,
  fetchStorageJson,
} from '../point-details/supabasePublic';
import type { PointCoordinate } from '../point-details/types';
import { decodeIndexCell, decompressIndexChunk } from './decoder';
import { IndexOutsideCoverageError } from './errors';
import type { IndexChunk, IndexCurrent, IndexManifest, IndexPointData } from './types';

const INDEX_BUCKET = 'index-data';
const CURRENT_CACHE_MS = 60_000;

let activeVersion: string | null = null;
let currentCache: { value: IndexCurrent; fetchedAt: number } | null = null;
const manifestCache = new Map<string, IndexManifest>();
const chunkCache = new Map<string, ArrayBuffer>();

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new PointDataError('aborted', 'Request aborted');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function activateVersion(version: string): void {
  if (activeVersion !== null && activeVersion !== version) {
    manifestCache.clear();
    chunkCache.clear();
  }
  activeVersion = version;
}

function validateCurrent(current: IndexCurrent): IndexCurrent {
  if (
    !current ||
    current.contract_version !== 1 ||
    typeof current.version !== 'string' ||
    !current.version ||
    typeof current.index_date !== 'string' ||
    !current.index_date ||
    typeof current.manifest_path !== 'string' ||
    !current.manifest_path ||
    typeof current.dataset_sha256 !== 'string'
  ) {
    throw new PointDataError('contract', 'Pointer current index-data non valido.');
  }
  return current;
}

function validateChunk(value: unknown): value is IndexChunk {
  if (!isRecord(value)) return false;
  return (
    Number.isInteger(value.byte_length) &&
    Number.isInteger(value.raw_byte_length) &&
    Number.isInteger(value.row) &&
    Number.isInteger(value.col) &&
    Number.isInteger(value.row_offset) &&
    Number.isInteger(value.col_offset) &&
    Number.isInteger(value.rows) &&
    Number.isInteger(value.cols) &&
    typeof value.path === 'string'
  );
}

function validateManifest(current: IndexCurrent, manifest: IndexManifest): IndexManifest {
  const bbox = manifest?.bbox;
  if (
    !manifest ||
    manifest.contract_version !== current.contract_version ||
    manifest.version !== current.version ||
    manifest.dataset_sha256 !== current.dataset_sha256 ||
    manifest.compression?.codec !== 'zlib' ||
    !Number.isInteger(manifest.rows) ||
    manifest.rows <= 0 ||
    !Number.isInteger(manifest.cols) ||
    manifest.cols <= 0 ||
    !Number.isFinite(manifest.step_deg) ||
    manifest.step_deg <= 0 ||
    !Number.isFinite(manifest.origin_lat) ||
    !Number.isFinite(manifest.origin_lon) ||
    !isRecord(bbox) ||
    !(['west', 'east', 'south', 'north'] as const).every((key) => Number.isFinite(bbox[key])) ||
    !Number.isInteger(manifest.chunk_size?.rows) ||
    manifest.chunk_size.rows <= 0 ||
    !Number.isInteger(manifest.chunk_size?.cols) ||
    manifest.chunk_size.cols <= 0 ||
    !Array.isArray(manifest.chunks) ||
    !manifest.chunks.every(validateChunk) ||
    manifest.binary_layout?.endianness !== 'little' ||
    manifest.binary_layout?.layout !== 'row-major interleaved cells' ||
    !Number.isInteger(manifest.binary_layout?.bytes_per_cell_uncompressed) ||
    manifest.binary_layout.bytes_per_cell_uncompressed <= 0 ||
    !Array.isArray(manifest.binary_layout?.fields) ||
    !isRecord(manifest.labels) ||
    !isRecord(manifest.porcini_diagnostics)
  ) {
    throw new PointDataError('contract', 'Manifest index-data incompatibile.');
  }
  return manifest;
}

async function getCurrent(signal?: AbortSignal): Promise<IndexCurrent> {
  throwIfAborted(signal);
  if (currentCache && Date.now() - currentCache.fetchedAt < CURRENT_CACHE_MS) {
    activateVersion(currentCache.value.version);
    return currentCache.value;
  }
  const current = validateCurrent(
    await fetchStorageJson<IndexCurrent>(INDEX_BUCKET, 'current.json', signal),
  );
  throwIfAborted(signal);
  activateVersion(current.version);
  currentCache = { value: current, fetchedAt: Date.now() };
  return current;
}

async function getManifest(
  current: IndexCurrent,
  signal?: AbortSignal,
): Promise<IndexManifest> {
  throwIfAborted(signal);
  const cached = manifestCache.get(current.version);
  if (cached) return cached;
  const manifest = validateManifest(
    current,
    await fetchStorageJson<IndexManifest>(INDEX_BUCKET, current.manifest_path, signal),
  );
  throwIfAborted(signal);
  manifestCache.set(current.version, manifest);
  return manifest;
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  try {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return null;
  }
}

async function getChunk(
  current: IndexCurrent,
  chunk: IndexChunk,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  throwIfAborted(signal);
  const key = `${current.version}/${chunk.row}/${chunk.col}/${chunk.path}`;
  const cached = chunkCache.get(key);
  if (cached) return cached;
  const compressed = await fetchStorageBuffer(INDEX_BUCKET, chunk.path, signal);
  if (compressed.byteLength !== chunk.byte_length) {
    throw new PointDataError('contract', 'Lunghezza compressa del chunk index-data non valida.');
  }
  if (chunk.sha256) {
    const digest = await sha256Hex(compressed);
    throwIfAborted(signal);
    if (digest && digest.toLowerCase() !== chunk.sha256.toLowerCase()) {
      throw new PointDataError('contract', 'Verifica SHA-256 del chunk index-data fallita.');
    }
  }
  const raw = decompressIndexChunk(compressed, chunk.raw_byte_length);
  throwIfAborted(signal);
  chunkCache.set(key, raw);
  return raw;
}

export async function loadIndexPoint(
  point: PointCoordinate,
  signal?: AbortSignal,
): Promise<IndexPointData> {
  const current = await getCurrent(signal);
  const manifest = await getManifest(current, signal);
  const cell = coordinateToTerrainCell(point, manifest, manifest.chunk_size);
  if (!cell) throw new IndexOutsideCoverageError();
  const chunk = manifest.chunks.find(
    (candidate) => candidate.row === cell.chunkRow && candidate.col === cell.chunkCol,
  );
  if (!chunk) {
    throw new PointDataError('contract', 'Chunk index-data della cella non presente nel manifest.');
  }
  const localRow = cell.row - chunk.row_offset;
  const localCol = cell.col - chunk.col_offset;
  if (localRow < 0 || localCol < 0 || localRow >= chunk.rows || localCol >= chunk.cols) {
    throw new PointDataError('contract', 'Il chunk di bordo non contiene la cella richiesta.');
  }
  const raw = await getChunk(current, chunk, signal);
  throwIfAborted(signal);
  return decodeIndexCell(raw, manifest, chunk, localRow, localCol, current);
}

export function clearIndexDataCachesForTests(): void {
  activeVersion = null;
  currentCache = null;
  manifestCache.clear();
  chunkCache.clear();
}
