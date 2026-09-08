import { unzlibSync } from 'fflate';
import { PointDataError } from '../point-details/errors';
import type {
  IndexHistoryChunk,
  IndexHistoryCurrent,
  IndexHistoryManifest,
  IndexHistoryPointData,
} from './types';

const FLOAT32_BYTES = 4;

export function decompressIndexHistoryChunk(
  compressed: ArrayBuffer,
  expectedRawLength: number,
): ArrayBuffer {
  let uncompressed: Uint8Array;
  try {
    uncompressed = unzlibSync(new Uint8Array(compressed));
  } catch {
    throw new PointDataError('contract', 'Il chunk index-history non è un flusso zlib valido.');
  }
  if (uncompressed.byteLength !== expectedRawLength) {
    throw new PointDataError(
      'contract',
      `Chunk index-history decompresso incompleto: ${uncompressed.byteLength}/${expectedRawLength} byte.`,
    );
  }
  return uncompressed.buffer.slice(
    uncompressed.byteOffset,
    uncompressed.byteOffset + uncompressed.byteLength,
  ) as ArrayBuffer;
}

function decodeScoreSeries(
  view: DataView,
  cellOffset: number,
  bytesPerCell: number,
  manifest: IndexHistoryManifest,
  fieldName: 'porcini_score' | 'finferli_score',
): Array<number | null> {
  const field = manifest.binary_layout.fields.find((candidate) => candidate.name === fieldName);
  if (!field) throw new PointDataError('contract', `Campo ${fieldName} assente da index-history.`);
  const itemCount = field.shape?.[0];
  if (
    field.dtype !== 'float32' ||
    field.shape.length !== 1 ||
    itemCount !== manifest.day_count ||
    !Number.isInteger(field.offset_bytes) ||
    field.offset_bytes < 0 ||
    field.offset_bytes + itemCount * FLOAT32_BYTES > bytesPerCell
  ) {
    throw new PointDataError('contract', `Layout del campo ${fieldName} non compatibile.`);
  }
  return Array.from({ length: itemCount }, (_, index) => {
    const value = view.getFloat32(cellOffset + field.offset_bytes + index * FLOAT32_BYTES, true);
    if (Number.isNaN(value)) return null;
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new PointDataError('contract', `Score ${fieldName} fuori dall’intervallo 0-100.`);
    }
    return value;
  });
}

export function decodeIndexHistoryCell(
  rawBuffer: ArrayBuffer,
  manifest: IndexHistoryManifest,
  chunk: IndexHistoryChunk,
  localRow: number,
  localCol: number,
  current: IndexHistoryCurrent,
): IndexHistoryPointData {
  const bytesPerCell = manifest.binary_layout.bytes_per_cell_uncompressed;
  if (
    manifest.binary_layout.endianness !== 'little' ||
    manifest.binary_layout.layout !== 'row-major interleaved cells' ||
    !Number.isInteger(bytesPerCell) ||
    bytesPerCell <= 0
  ) {
    throw new PointDataError('contract', 'Layout binario index-history non supportato.');
  }
  if (
    rawBuffer.byteLength !== chunk.raw_byte_length ||
    chunk.raw_byte_length !== chunk.rows * chunk.cols * bytesPerCell
  ) {
    throw new PointDataError('contract', 'Lunghezza raw del chunk index-history non coerente.');
  }
  if (localRow < 0 || localRow >= chunk.rows || localCol < 0 || localCol >= chunk.cols) {
    throw new PointDataError('contract', 'Cella locale fuori dai limiti del chunk index-history.');
  }
  const cellOffset = (localRow * chunk.cols + localCol) * bytesPerCell;
  if (cellOffset + bytesPerCell > rawBuffer.byteLength) {
    throw new PointDataError('contract', 'Offset della cella index-history fuori dal chunk.');
  }
  const view = new DataView(rawBuffer);
  const porcini = decodeScoreSeries(view, cellOffset, bytesPerCell, manifest, 'porcini_score');
  const finferli = decodeScoreSeries(view, cellOffset, bytesPerCell, manifest, 'finferli_score');
  return {
    version: current.version,
    indexDate: current.index_date,
    dateFrom: current.date_from,
    dateTo: current.date_to,
    row: chunk.row_offset + localRow,
    col: chunk.col_offset + localCol,
    dates: [...manifest.dates],
    availableDates: [...manifest.available_dates],
    missingDates: [...manifest.missing_dates],
    days: manifest.dates.map((date, index) => ({
      date,
      porciniScore: porcini[index],
      finferliScore: finferli[index],
    })),
  };
}
