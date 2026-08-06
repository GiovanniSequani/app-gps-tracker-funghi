export type PointCoordinate = {
  latitude: number;
  longitude: number;
};

export type BoundingBox = {
  west: number;
  east: number;
  south: number;
  north: number;
};

export type GridContract = {
  rows: number;
  cols: number;
  step_deg: number;
  origin_lat: number;
  origin_lon: number;
  bbox: BoundingBox;
};

export type GridCell = {
  row: number;
  col: number;
};

export type TerrainCellAddress = GridCell & {
  chunkRow: number;
  chunkCol: number;
  localRow: number;
  localCol: number;
};

export type WeatherStateRow = {
  singleton_id: number;
  current_version: string;
  updated_at?: string;
};

export type WeatherVariableMetadata = {
  unit?: string;
  dtype?: string;
  scale?: number;
  nodata?: number;
  offset?: number;
  description?: string;
};

export type WeatherDatasetRow = GridContract & {
  version: string;
  dates: string[];
  day_count?: number;
  available_day_count: number;
  missing_dates: string[];
  variables?: Record<string, WeatherVariableMetadata>;
};

export type EncodedWeatherSeries = number[];

export type WeatherCellRow = {
  version: string;
  row_idx: number;
  col_idx: number;
  t2m_min: EncodedWeatherSeries;
  t2m_max: EncodedWeatherSeries;
  precip_sum: EncodedWeatherSeries;
  rh_mean: EncodedWeatherSeries;
  gust_max: EncodedWeatherSeries;
};

export type WeatherDay = {
  date: string;
  temperatureMin: number | null;
  temperatureMax: number | null;
  precipitation: number | null;
  humidity: number | null;
  gust: number | null;
  missing: boolean;
};

export type WeatherDetails = {
  version: string;
  cell: GridCell;
  dates: string[];
  availableDayCount: number;
  missingDates: string[];
  days: WeatherDay[];
};

export type TerrainCurrentPointer = {
  contract_version: number;
  version: string;
  manifest_path: string;
  dataset_sha256?: string;
};

export type TerrainChunkDescriptor = {
  row: number;
  col: number;
  row_offset: number;
  col_offset: number;
  rows: number;
  cols: number;
  path: string;
  byte_length: number;
  sha256?: string;
};

export type TerrainManifest = GridContract & {
  contract_version: number;
  version: string;
  crs: string;
  latitude_order: string;
  longitude_order: string;
  chunk_size: {
    rows: number;
    cols: number;
  };
  chunks: TerrainChunkDescriptor[];
  binary_layout?: {
    bytes_per_cell?: number;
    endianness?: string;
  };
};

export type TerrainValues = {
  elevation: number | null;
  forestPercent: number | null;
  aspectDegrees: number | null;
  tpiCategory: 0 | 1 | 2 | 3;
};

export type TerrainDetails = TerrainValues & {
  version: string;
  cell: TerrainCellAddress;
  chunk: {
    row: number;
    col: number;
    path: string;
  };
};

export type PointDataResult<T> =
  | { status: 'ready'; data: T }
  | { status: 'outside' }
  | { status: 'unavailable'; reason?: string };

export type ResourceState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'outside' }
  | { status: 'unavailable'; message: string }
  | { status: 'error'; message: string };

