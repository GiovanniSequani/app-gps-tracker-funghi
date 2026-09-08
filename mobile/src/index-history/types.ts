import type { GridContract, PointCoordinate, ResourceState } from '../point-details/types';

export type IndexHistoryCurrent = {
  contract_version: number;
  version: string;
  index_date: string;
  date_from: string;
  date_to: string;
  day_count: number;
  manifest_path: string;
  dataset_sha256: string;
};

export type IndexHistoryBinaryField = {
  name: string;
  dtype: string;
  shape: number[];
  date_axis?: string;
  unit?: string;
  nodata?: number | string | null;
  exact?: boolean;
  offset_bytes: number;
};

export type IndexHistoryChunk = {
  row: number;
  col: number;
  row_offset: number;
  col_offset: number;
  rows: number;
  cols: number;
  path: string;
  byte_length: number;
  raw_byte_length: number;
  sha256?: string;
};

export type IndexHistoryManifest = GridContract & {
  contract_version: number;
  version: string;
  index_date: string;
  dates: string[];
  day_count: number;
  available_dates: string[];
  missing_dates: string[];
  dataset_sha256: string;
  crs: string;
  latitude_order: string;
  longitude_order: string;
  chunk_size: { rows: number; cols: number };
  compression: { codec: string; level?: number };
  binary_layout: {
    layout: string;
    endianness: string;
    bytes_per_cell_uncompressed: number;
    fields: IndexHistoryBinaryField[];
  };
  chunks: IndexHistoryChunk[];
};

export type IndexHistoryDay = {
  date: string;
  porciniScore: number | null;
  finferliScore: number | null;
};

export type IndexHistoryPointData = {
  version: string;
  indexDate: string;
  dateFrom: string;
  dateTo: string;
  row: number;
  col: number;
  dates: string[];
  availableDates: string[];
  missingDates: string[];
  days: IndexHistoryDay[];
};

export type IndexHistoryLoader = (
  point: PointCoordinate,
  signal?: AbortSignal,
) => Promise<IndexHistoryPointData>;

export type IndexHistoryState = ResourceState<IndexHistoryPointData>;

/** Reserved UI seam for a future forecast without changing the observed contract. */
export type IndexHistoryForecastDay = IndexHistoryDay;
