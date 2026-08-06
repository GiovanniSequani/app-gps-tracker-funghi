import type { GridContract, PointCoordinate, ResourceState } from '../point-details/types';

export const INDEX_DIAGNOSTIC_NAMES = [
  'habitat',
  'potential',
  'trigger',
  'incubation',
  'moisture',
  'stress',
  'temp_score',
  'humidity_score',
  'post_rain_score',
  'drying_total',
  'drying_exposure_static',
  'retention_static',
  'rain_need_factor',
  'temporal_phase',
  'low_humidity_days',
  'temperature_band',
  'presence_carryover',
  'rain_recovery_seed',
] as const;

export type IndexDiagnosticName = (typeof INDEX_DIAGNOSTIC_NAMES)[number];
export type IndexSpecies = 'porcini' | 'finferli';

export type IndexCurrent = {
  contract_version: number;
  dataset_sha256: string;
  index_date: string;
  manifest_path: string;
  version: string;
};

export type IndexBinaryField = {
  name: string;
  dtype: string;
  offset_bytes: number;
  scale?: number;
  offset?: number;
  nodata?: number | string | null;
  unit?: string;
  exact?: boolean;
};

export type IndexChunk = {
  byte_length: number;
  raw_byte_length: number;
  col: number;
  col_offset: number;
  cols: number;
  path: string;
  row: number;
  row_offset: number;
  rows: number;
  sha256?: string;
};

export type IndexDiagnosticMetadata = {
  configured_lags_days?: number[];
  dynamic_weights?: Record<string, number>;
  formulas?: Record<string, string>;
  thresholds?: Record<string, unknown>;
  incubation_note?: string;
  temporal_phase_note?: string;
};

export type IndexManifest = GridContract & {
  contract_version: number;
  version: string;
  index_date: string;
  dataset_sha256: string;
  compression: { codec: string; level?: number };
  chunk_size: { rows: number; cols: number };
  chunks: IndexChunk[];
  binary_layout: {
    bytes_per_cell_uncompressed: number;
    endianness: string;
    layout: string;
    fields: IndexBinaryField[];
  };
  labels: Record<string, Record<string, string>>;
  porcini_diagnostics: IndexDiagnosticMetadata;
};

export type IndexDiagnosticContext = {
  configuredLagsDays: number[];
  dynamicWeights: Record<string, number>;
  formulas: Record<string, string>;
  thresholds: Record<string, unknown>;
  incubationNote: string | null;
  temporalPhaseNote: string | null;
};

export type IndexPointData = {
  version: string;
  indexDate: string;
  row: number;
  col: number;
  porciniScore: number | null;
  finferliScore: number | null;
  porciniBaseScore: number | null;
  diagnostics: Record<IndexDiagnosticName, number | null>;
  diagnosticLabels: Partial<Record<IndexDiagnosticName, string>>;
  context: IndexDiagnosticContext;
};

export type IndexPointLoader = (
  point: PointCoordinate,
  signal?: AbortSignal,
) => Promise<IndexPointData>;

export type IndexPointState = ResourceState<IndexPointData>;
