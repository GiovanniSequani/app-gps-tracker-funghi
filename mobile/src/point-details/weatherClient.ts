import { PointDataError } from './errors';
import { coordinateToGridCell } from './geo';
import { fetchRestRows } from './supabasePublic';
import type {
  PointCoordinate,
  PointDataResult,
  WeatherCellRow,
  WeatherDatasetRow,
  WeatherDetails,
  WeatherStateRow,
} from './types';
import { decodeWeatherDays } from './weatherDecoder';

const WEATHER_STATE_TTL_MS = 2 * 60 * 1000;

let stateCache:
  | { expiresAt: number; value: WeatherStateRow }
  | undefined;
const datasetCache = new Map<string, WeatherDatasetRow>();
const cellCache = new Map<string, WeatherCellRow>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isBoundingBox(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return ['west', 'east', 'south', 'north'].every((key) =>
    Number.isFinite(value[key]),
  );
}

function validateDataset(value: WeatherDatasetRow): WeatherDatasetRow {
  if (
    !value ||
    typeof value.version !== 'string' ||
    !Array.isArray(value.dates) ||
    !value.dates.every((date) => typeof date === 'string') ||
    !Array.isArray(value.missing_dates) ||
    !Number.isInteger(value.rows) ||
    !Number.isInteger(value.cols) ||
    !Number.isFinite(value.step_deg) ||
    !Number.isFinite(value.origin_lat) ||
    !Number.isFinite(value.origin_lon) ||
    !isBoundingBox(value.bbox)
  ) {
    throw new PointDataError('contract', 'Invalid public weather dataset');
  }
  return value;
}

function isEncodedSeries(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => Number.isFinite(item));
}

function validateCell(value: WeatherCellRow): WeatherCellRow {
  if (
    !value ||
    typeof value.version !== 'string' ||
    !Number.isInteger(value.row_idx) ||
    !Number.isInteger(value.col_idx) ||
    !isEncodedSeries(value.t2m_min) ||
    !isEncodedSeries(value.t2m_max) ||
    !isEncodedSeries(value.precip_sum) ||
    !isEncodedSeries(value.rh_mean) ||
    !isEncodedSeries(value.gust_max)
  ) {
    throw new PointDataError('contract', 'Invalid public weather cell');
  }
  return value;
}

async function getCurrentWeatherState(
  signal?: AbortSignal,
): Promise<WeatherStateRow> {
  if (stateCache && stateCache.expiresAt > Date.now()) return stateCache.value;

  const rows = await fetchRestRows<WeatherStateRow>(
    'public_weather_state',
    {
      singleton_id: 'eq.1',
      select: 'singleton_id,current_version,updated_at',
      limit: '1',
    },
    signal,
  );
  const state = rows[0];
  if (!state || state.singleton_id !== 1 || typeof state.current_version !== 'string') {
    throw new PointDataError('contract', 'Current weather version is unavailable');
  }
  stateCache = {
    value: state,
    expiresAt: Date.now() + WEATHER_STATE_TTL_MS,
  };
  return state;
}

async function getWeatherDataset(
  version: string,
  signal?: AbortSignal,
): Promise<WeatherDatasetRow | null> {
  const cached = datasetCache.get(version);
  if (cached) return cached;

  const rows = await fetchRestRows<WeatherDatasetRow>(
    'public_weather_datasets',
    {
      version: `eq.${version}`,
      select:
        'version,dates,day_count,available_day_count,missing_dates,rows,cols,step_deg,bbox,origin_lat,origin_lon,variables',
      limit: '1',
    },
    signal,
  );
  if (!rows[0]) return null;
  const dataset = validateDataset(rows[0]);
  datasetCache.set(version, dataset);
  return dataset;
}

async function getWeatherCell(
  version: string,
  row: number,
  col: number,
  signal?: AbortSignal,
): Promise<WeatherCellRow | null> {
  const key = `${version}/${row}/${col}`;
  const cached = cellCache.get(key);
  if (cached) return cached;

  const rows = await fetchRestRows<WeatherCellRow>(
    'public_weather_cells',
    {
      version: `eq.${version}`,
      row_idx: `eq.${row}`,
      col_idx: `eq.${col}`,
      select:
        'version,row_idx,col_idx,t2m_min,t2m_max,precip_sum,rh_mean,gust_max',
      limit: '1',
    },
    signal,
  );
  if (!rows[0]) return null;
  const cell = validateCell(rows[0]);
  cellCache.set(key, cell);
  return cell;
}

export async function loadWeatherDetails(
  point: PointCoordinate,
  signal?: AbortSignal,
): Promise<PointDataResult<WeatherDetails>> {
  const state = await getCurrentWeatherState(signal);
  const dataset = await getWeatherDataset(state.current_version, signal);
  if (!dataset) {
    return { status: 'unavailable', reason: 'Dataset meteo non disponibile.' };
  }

  const cellAddress = coordinateToGridCell(point, dataset);
  if (!cellAddress) return { status: 'outside' };

  const cell = await getWeatherCell(
    state.current_version,
    cellAddress.row,
    cellAddress.col,
    signal,
  );
  if (!cell) {
    return {
      status: 'unavailable',
      reason: 'Dati meteo non disponibili per questa cella.',
    };
  }

  return {
    status: 'ready',
    data: {
      version: state.current_version,
      cell: cellAddress,
      dates: dataset.dates,
      availableDayCount: dataset.available_day_count,
      missingDates: dataset.missing_dates,
      days: decodeWeatherDays(dataset, cell),
    },
  };
}

export function clearWeatherCachesForTests(): void {
  stateCache = undefined;
  datasetCache.clear();
  cellCache.clear();
}

