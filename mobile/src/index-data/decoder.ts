import { unzlibSync } from 'fflate';
import { PointDataError } from '../point-details/errors';
import type {
  IndexBinaryField,
  IndexChunk,
  IndexCurrent,
  IndexDiagnosticName,
  IndexManifest,
  IndexPointData,
} from './types';
import { INDEX_DIAGNOSTIC_NAMES } from './types';

const dtypeReaders: Record<
  string,
  { bytes: number; read: (view: DataView, offset: number) => number }
> = {
  uint8: { bytes: 1, read: (view, offset) => view.getUint8(offset) },
  int8: { bytes: 1, read: (view, offset) => view.getInt8(offset) },
  uint16: { bytes: 2, read: (view, offset) => view.getUint16(offset, true) },
  int16: { bytes: 2, read: (view, offset) => view.getInt16(offset, true) },
  uint32: { bytes: 4, read: (view, offset) => view.getUint32(offset, true) },
  int32: { bytes: 4, read: (view, offset) => view.getInt32(offset, true) },
  float32: { bytes: 4, read: (view, offset) => view.getFloat32(offset, true) },
  float64: { bytes: 8, read: (view, offset) => view.getFloat64(offset, true) },
};

export function decompressIndexChunk(
  compressed: ArrayBuffer,
  expectedRawLength: number,
): ArrayBuffer {
  let uncompressed: Uint8Array;
  try {
    uncompressed = unzlibSync(new Uint8Array(compressed));
  } catch {
    throw new PointDataError('contract', 'Il chunk index-data non è un flusso zlib valido.');
  }
  if (uncompressed.byteLength !== expectedRawLength) {
    throw new PointDataError(
      'contract',
      `Chunk index-data decompresso incompleto: ${uncompressed.byteLength}/${expectedRawLength} byte.`,
    );
  }
  return uncompressed.buffer.slice(
    uncompressed.byteOffset,
    uncompressed.byteOffset + uncompressed.byteLength,
  ) as ArrayBuffer;
}

export function decodeIndexField(
  view: DataView,
  cellByteOffset: number,
  bytesPerCell: number,
  field: IndexBinaryField,
): number | null {
  const reader = dtypeReaders[field.dtype];
  if (!reader) {
    throw new PointDataError('contract', `Dtype index-data non supportato: ${field.dtype}.`);
  }
  if (
    !Number.isInteger(field.offset_bytes) ||
    field.offset_bytes < 0 ||
    field.offset_bytes + reader.bytes > bytesPerCell
  ) {
    throw new PointDataError('contract', `Offset non valido per il campo ${field.name}.`);
  }
  const encoded = reader.read(view, cellByteOffset + field.offset_bytes);
  if (!Number.isFinite(encoded)) {
    return field.nodata === 'NaN' || Number.isNaN(encoded) ? null : encoded;
  }
  if (typeof field.nodata === 'number' && encoded === field.nodata) return null;
  return encoded * (field.scale ?? 1) + (field.offset ?? 0);
}

function fieldValue(values: Map<string, number | null>, name: string): number | null {
  return values.has(name) ? (values.get(name) ?? null) : null;
}

export function decodeIndexCell(
  rawBuffer: ArrayBuffer,
  manifest: IndexManifest,
  chunk: IndexChunk,
  localRow: number,
  localCol: number,
  current: IndexCurrent,
): IndexPointData {
  const bytesPerCell = manifest.binary_layout.bytes_per_cell_uncompressed;
  if (
    manifest.binary_layout.endianness !== 'little' ||
    manifest.binary_layout.layout !== 'row-major interleaved cells' ||
    !Number.isInteger(bytesPerCell) ||
    bytesPerCell <= 0
  ) {
    throw new PointDataError('contract', 'Layout binario index-data non supportato.');
  }
  if (
    rawBuffer.byteLength !== chunk.raw_byte_length ||
    chunk.raw_byte_length !== chunk.rows * chunk.cols * bytesPerCell
  ) {
    throw new PointDataError('contract', 'Lunghezza raw del chunk index-data non coerente.');
  }
  if (localRow < 0 || localRow >= chunk.rows || localCol < 0 || localCol >= chunk.cols) {
    throw new PointDataError('contract', 'Cella locale fuori dai limiti del chunk index-data.');
  }
  const cellByteOffset = (localRow * chunk.cols + localCol) * bytesPerCell;
  if (cellByteOffset + bytesPerCell > rawBuffer.byteLength) {
    throw new PointDataError('contract', 'Offset della cella index-data fuori dal chunk.');
  }
  const view = new DataView(rawBuffer);
  const values = new Map(
    manifest.binary_layout.fields.map((field) => [
      field.name,
      decodeIndexField(view, cellByteOffset, bytesPerCell, field),
    ]),
  );
  const diagnostics = Object.fromEntries(
    INDEX_DIAGNOSTIC_NAMES.map((name) => [name, fieldValue(values, name)]),
  ) as Record<IndexDiagnosticName, number | null>;
  const diagnosticLabels: Partial<Record<IndexDiagnosticName, string>> = {};
  for (const name of INDEX_DIAGNOSTIC_NAMES) {
    const value = diagnostics[name];
    const labels = manifest.labels[name];
    if (value !== null && labels) diagnosticLabels[name] = labels[String(Math.round(value))];
  }
  return {
    version: current.version,
    indexDate: current.index_date || manifest.index_date,
    row: chunk.row_offset + localRow,
    col: chunk.col_offset + localCol,
    porciniScore: fieldValue(values, 'porcini_score'),
    finferliScore: fieldValue(values, 'finferli_score'),
    porciniBaseScore: fieldValue(values, 'porcini_base_score'),
    diagnostics,
    diagnosticLabels,
    context: {
      configuredLagsDays: manifest.porcini_diagnostics.configured_lags_days ?? [],
      dynamicWeights: manifest.porcini_diagnostics.dynamic_weights ?? {},
      formulas: manifest.porcini_diagnostics.formulas ?? {},
      thresholds: manifest.porcini_diagnostics.thresholds ?? {},
      incubationNote: manifest.porcini_diagnostics.incubation_note ?? null,
      temporalPhaseNote: manifest.porcini_diagnostics.temporal_phase_note ?? null,
    },
  };
}
