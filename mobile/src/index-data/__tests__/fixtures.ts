import type { IndexCurrent, IndexManifest, IndexPointData } from '../types';
import { INDEX_DIAGNOSTIC_NAMES } from '../types';

export const current: IndexCurrent = {
  contract_version: 1,
  dataset_sha256: 'dataset-v1',
  index_date: '2026-07-26',
  manifest_path: 'v1/manifest.json',
  version: 'v1',
};

export function manifest(compressedLength = 0): IndexManifest {
  return {
    contract_version: 1,
    version: 'v1',
    index_date: '2026-07-26',
    dataset_sha256: 'dataset-v1',
    rows: 1,
    cols: 1,
    step_deg: 0.003,
    origin_lat: 46,
    origin_lon: 11,
    bbox: { west: 10.9985, south: 45.9985, east: 11.0015, north: 46.0015 },
    compression: { codec: 'zlib' },
    chunk_size: { rows: 50, cols: 50 },
    chunks: [{
      byte_length: compressedLength,
      raw_byte_length: 30,
      col: 0,
      col_offset: 0,
      cols: 1,
      path: 'v1/chunks/r00_c00.bin.zlib',
      row: 0,
      row_offset: 0,
      rows: 1,
    }],
    binary_layout: {
      bytes_per_cell_uncompressed: 30,
      endianness: 'little',
      layout: 'row-major interleaved cells',
      fields: [
        { name: 'porcini_score', dtype: 'float32', offset_bytes: 0, nodata: 'NaN' },
        { name: 'finferli_score', dtype: 'float32', offset_bytes: 4, nodata: 'NaN' },
        { name: 'porcini_base_score', dtype: 'uint16', offset_bytes: 8, scale: 0.01, nodata: 65535 },
        { name: 'habitat', dtype: 'uint8', offset_bytes: 10, scale: 1 / 254, nodata: 255 },
        { name: 'temporal_phase', dtype: 'uint8', offset_bytes: 23, nodata: null },
        { name: 'temperature_band', dtype: 'uint8', offset_bytes: 25, nodata: 0 },
        { name: 'presence_carryover', dtype: 'uint16', offset_bytes: 26, scale: 0.01, nodata: 65535 },
        { name: 'rain_recovery_seed', dtype: 'uint16', offset_bytes: 28, scale: 0.01, nodata: 65535 },
      ],
    },
    labels: {
      temporal_phase: {
        '0': 'non_determinabile',
        '1': 'troppo_precoce',
        '2': 'fase_favorevole',
        '3': 'troppo_tardi',
      },
      temperature_band: { '0': 'nodata', '3': 'ottimale' },
    },
    porcini_diagnostics: {
      configured_lags_days: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
      dynamic_weights: { habitat: 0.28, trigger: 0.3, incubation: 0.22, moisture: 0.16 },
      formulas: { final_score: 'base + recovery' },
      thresholds: { temp_mean_c: [5, 10, 18, 24] },
    },
  };
}

export function rawCell(): ArrayBuffer {
  const buffer = new ArrayBuffer(30);
  const view = new DataView(buffer);
  view.setFloat32(0, 78.5, true);
  view.setFloat32(4, 41.25, true);
  view.setUint16(8, 6543, true);
  view.setUint8(10, 127);
  view.setUint8(23, 2);
  view.setUint8(25, 3);
  view.setUint16(26, 425, true);
  view.setUint16(28, 65535, true);
  return buffer;
}

export function analysisPoint(
  overrides: Partial<IndexPointData['diagnostics']> = {},
): IndexPointData {
  const diagnostics = Object.fromEntries(
    INDEX_DIAGNOSTIC_NAMES.map((name) => [name, null]),
  ) as IndexPointData['diagnostics'];
  Object.assign(diagnostics, {
    habitat: 0.9,
    trigger: 0.85,
    moisture: 0.25,
    stress: 0.3,
    drying_total: 0.75,
    temp_score: 0.8,
    humidity_score: 0.35,
    post_rain_score: 0.7,
    drying_exposure_static: 0.8,
    retention_static: 0.4,
    rain_need_factor: 1.2,
    low_humidity_days: 3,
    presence_carryover: 5,
    rain_recovery_seed: 1.6,
    ...overrides,
  });
  return {
    version: 'v1',
    indexDate: '2026-07-26',
    row: 10,
    col: 20,
    porciniScore: 72,
    finferliScore: 40,
    porciniBaseScore: 67,
    diagnostics,
    diagnosticLabels: { temporal_phase: 'fase_favorevole', temperature_band: 'ottimale' },
    context: {
      configuredLagsDays: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
      dynamicWeights: { habitat: 0.28, trigger: 0.3, incubation: 0.22, moisture: 0.16 },
      formulas: {},
      thresholds: {},
      incubationNote: null,
      temporalPhaseNote: null,
    },
  };
}
