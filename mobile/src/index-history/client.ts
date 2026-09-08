import { PointDataError } from '../point-details/errors';
import { coordinateToTerrainCell } from '../point-details/geo';
import { fetchStorageBuffer, fetchStorageJson } from '../point-details/supabasePublic';
import type { PointCoordinate } from '../point-details/types';
import { decodeIndexHistoryCell, decompressIndexHistoryChunk } from './decoder';
import { IndexHistoryOutsideCoverageError } from './errors';
import type {
  IndexHistoryBinaryField,
  IndexHistoryChunk,
  IndexHistoryCurrent,
  IndexHistoryManifest,
  IndexHistoryPointData,
} from './types';

const INDEX_HISTORY_BUCKET = 'index-history';
const CURRENT_CACHE_MS = 60_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

let activeVersion: string | null = null;
let currentCache: { value: IndexHistoryCurrent; fetchedAt: number } | null = null;
const manifestCache = new Map<string, IndexHistoryManifest>();
const chunkCache = new Map<string, ArrayBuffer>();

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PointDataError('aborted', 'Request aborted');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isDateArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && ISO_DATE.test(item));
}

function activateVersion(version: string): void {
  if (activeVersion !== null && activeVersion !== version) {
    manifestCache.clear();
    chunkCache.clear();
  }
  activeVersion = version;
}

function validateCurrent(value: IndexHistoryCurrent): IndexHistoryCurrent {
  if (
    !value ||
    value.contract_version !== 1 ||
    typeof value.version !== 'string' || !value.version ||
    typeof value.index_date !== 'string' || !ISO_DATE.test(value.index_date) ||
    typeof value.date_from !== 'string' || !ISO_DATE.test(value.date_from) ||
    typeof value.date_to !== 'string' || !ISO_DATE.test(value.date_to) ||
    !Number.isInteger(value.day_count) || value.day_count <= 0 ||
    typeof value.manifest_path !== 'string' || !value.manifest_path ||
    typeof value.dataset_sha256 !== 'string' || !value.dataset_sha256
  ) {
    throw new PointDataError('contract', 'Pointer current index-history non valido.');
  }
  return value;
}

function validateChunk(value: unknown): value is IndexHistoryChunk {
  if (!isRecord(value)) return false;
  return (
    Number.isInteger(value.row) && Number.isInteger(value.col) &&
    Number.isInteger(value.row_offset) && Number.isInteger(value.col_offset) &&
    Number.isInteger(value.rows) && Number(value.rows) > 0 &&
    Number.isInteger(value.cols) && Number(value.cols) > 0 &&
    typeof value.path === 'string' && !!value.path &&
    Number.isInteger(value.byte_length) && Number(value.byte_length) > 0 &&
    Number.isInteger(value.raw_byte_length) && Number(value.raw_byte_length) > 0 &&
    (value.sha256 === undefined || typeof value.sha256 === 'string')
  );
}

function validateField(
  value: unknown,
  dayCount: number,
  bytesPerCell: number,
): value is IndexHistoryBinaryField {
  if (!isRecord(value)) return false;
  return (
    (value.name === 'porcini_score' || value.name === 'finferli_score') &&
    value.dtype === 'float32' &&
    Array.isArray(value.shape) && value.shape.length === 1 && value.shape[0] === dayCount &&
    Number.isInteger(value.offset_bytes) && Number(value.offset_bytes) >= 0 &&
    Number(value.offset_bytes) + dayCount * 4 <= bytesPerCell &&
    (value.nodata === 'NaN' || value.nodata === undefined)
  );
}

function validateManifest(
  current: IndexHistoryCurrent,
  manifest: IndexHistoryManifest,
): IndexHistoryManifest {
  const bbox = manifest?.bbox;
  const bytesPerCell = manifest?.binary_layout?.bytes_per_cell_uncompressed;
  const datesValid = isDateArray(manifest?.dates) &&
    manifest.dates.length === current.day_count &&
    manifest.dates.every((date, index) => index === 0 || date > manifest.dates[index - 1]);
  const availabilityValid = isDateArray(manifest?.available_dates) &&
    isDateArray(manifest?.missing_dates) &&
    manifest.available_dates.length + manifest.missing_dates.length === current.day_count &&
    new Set([...manifest.available_dates, ...manifest.missing_dates]).size === current.day_count &&
    [...manifest.available_dates, ...manifest.missing_dates].every((date) => manifest.dates.includes(date));
  const fields = manifest?.binary_layout?.fields;
  const fieldNames = Array.isArray(fields) ? fields.map((field) => field?.name) : [];
  if (
    !manifest ||
    manifest.contract_version !== current.contract_version ||
    manifest.version !== current.version ||
    manifest.index_date !== current.index_date ||
    manifest.dataset_sha256 !== current.dataset_sha256 ||
    manifest.day_count !== current.day_count ||
    !datesValid ||
    manifest.dates[0] !== current.date_from ||
    manifest.dates[manifest.dates.length - 1] !== current.date_to ||
    !availabilityValid ||
    manifest.crs !== 'EPSG:4326' ||
    manifest.latitude_order !== 'ascending_south_to_north' ||
    manifest.longitude_order !== 'ascending_west_to_east' ||
    manifest.compression?.codec !== 'zlib' ||
    !Number.isInteger(manifest.rows) || manifest.rows <= 0 ||
    !Number.isInteger(manifest.cols) || manifest.cols <= 0 ||
    !Number.isFinite(manifest.step_deg) || manifest.step_deg <= 0 ||
    !Number.isFinite(manifest.origin_lat) || !Number.isFinite(manifest.origin_lon) ||
    !isRecord(bbox) ||
    !(['west', 'east', 'south', 'north'] as const).every((key) => Number.isFinite(bbox[key])) ||
    !Number.isInteger(manifest.chunk_size?.rows) || manifest.chunk_size.rows <= 0 ||
    !Number.isInteger(manifest.chunk_size?.cols) || manifest.chunk_size.cols <= 0 ||
    !Array.isArray(manifest.chunks) || !manifest.chunks.every(validateChunk) ||
    manifest.binary_layout?.endianness !== 'little' ||
    manifest.binary_layout?.layout !== 'row-major interleaved cells' ||
    !Number.isInteger(bytesPerCell) || bytesPerCell <= 0 ||
    !Array.isArray(fields) || fields.length !== 2 ||
    !fields.every((field) => validateField(field, current.day_count, bytesPerCell)) ||
    new Set(fieldNames).size !== 2 ||
    !fieldNames.includes('porcini_score') || !fieldNames.includes('finferli_score')
  ) {
    throw new PointDataError('contract', 'Manifest index-history incompatibile.');
  }
  return manifest;
}

async function getCurrent(signal?: AbortSignal): Promise<IndexHistoryCurrent> {
  throwIfAborted(signal);
  if (currentCache && Date.now() - currentCache.fetchedAt < CURRENT_CACHE_MS) {
    activateVersion(currentCache.value.version);
    return currentCache.value;
  }
  const current = validateCurrent(
    await fetchStorageJson<IndexHistoryCurrent>(INDEX_HISTORY_BUCKET, 'current.json', signal),
  );
  throwIfAborted(signal);
  activateVersion(current.version);
  currentCache = { value: current, fetchedAt: Date.now() };
  return current;
}

async function getManifest(
  current: IndexHistoryCurrent,
  signal?: AbortSignal,
): Promise<IndexHistoryManifest> {
  throwIfAborted(signal);
  const cached = manifestCache.get(current.version);
  if (cached) return cached;
  const manifest = validateManifest(
    current,
    await fetchStorageJson<IndexHistoryManifest>(INDEX_HISTORY_BUCKET, current.manifest_path, signal),
  );
  throwIfAborted(signal);
  manifestCache.set(current.version, manifest);
  return manifest;
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  try {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

async function getChunk(
  current: IndexHistoryCurrent,
  chunk: IndexHistoryChunk,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  throwIfAborted(signal);
  const key = `${current.version}/${chunk.row}/${chunk.col}/${chunk.path}`;
  const cached = chunkCache.get(key);
  if (cached) return cached;
  const compressed = await fetchStorageBuffer(INDEX_HISTORY_BUCKET, chunk.path, signal);
  if (compressed.byteLength !== chunk.byte_length) {
    throw new PointDataError('contract', 'Lunghezza compressa del chunk index-history non valida.');
  }
  if (chunk.sha256) {
    const digest = await sha256Hex(compressed);
    throwIfAborted(signal);
    if (digest && digest.toLowerCase() !== chunk.sha256.toLowerCase()) {
      throw new PointDataError('contract', 'Verifica SHA-256 del chunk index-history fallita.');
    }
  }
  const raw = decompressIndexHistoryChunk(compressed, chunk.raw_byte_length);
  throwIfAborted(signal);
  chunkCache.set(key, raw);
  return raw;
}

export async function loadIndexHistoryPoint(
  point: PointCoordinate,
  signal?: AbortSignal,
): Promise<IndexHistoryPointData> {
  const current = await getCurrent(signal);
  const manifest = await getManifest(current, signal);
  const cell = coordinateToTerrainCell(point, manifest, manifest.chunk_size);
  if (!cell) throw new IndexHistoryOutsideCoverageError();
  const chunk = manifest.chunks.find(
    (candidate) => candidate.row === cell.chunkRow && candidate.col === cell.chunkCol,
  );
  if (!chunk) throw new PointDataError('contract', 'Chunk index-history non presente nel manifest.');
  const localRow = cell.row - chunk.row_offset;
  const localCol = cell.col - chunk.col_offset;
  if (localRow < 0 || localCol < 0 || localRow >= chunk.rows || localCol >= chunk.cols) {
    throw new PointDataError('contract', 'Il chunk di bordo non contiene la cella index-history richiesta.');
  }
  const raw = await getChunk(current, chunk, signal);
  throwIfAborted(signal);
  return decodeIndexHistoryCell(raw, manifest, chunk, localRow, localCol, current);
}

export function clearIndexHistoryCachesForTests(): void {
  activeVersion = null;
  currentCache = null;
  manifestCache.clear();
  chunkCache.clear();
}
