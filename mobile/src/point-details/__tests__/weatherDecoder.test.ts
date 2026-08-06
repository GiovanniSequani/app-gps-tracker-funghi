import { describe, expect, it } from 'vitest';
import {
  decodeWeatherDays,
  decodeWeatherSmallInt,
  WEATHER_NODATA,
} from '../weatherDecoder';
import type { WeatherCellRow, WeatherDatasetRow } from '../types';

describe('weather smallint decoding', () => {
  it('applies the 0.1 scale without rounding away precision', () => {
    expect(decodeWeatherSmallInt(168)).toBe(16.8);
    expect(decodeWeatherSmallInt(-12)).toBe(-1.2);
    expect(decodeWeatherSmallInt(0)).toBe(0);
  });

  it('maps nodata and absent values to null, never zero', () => {
    expect(decodeWeatherSmallInt(WEATHER_NODATA)).toBeNull();
    expect(decodeWeatherSmallInt(null)).toBeNull();
    expect(decodeWeatherSmallInt(undefined)).toBeNull();
  });

  it('keeps the dataset date aligned with every decoded array index', () => {
    const dataset = {
      version: 'v1',
      dates: ['2026-07-23', '2026-07-24'],
      available_day_count: 1,
      missing_dates: ['2026-07-23'],
      rows: 84,
      cols: 117,
      step_deg: 0.018,
      origin_lat: 45.6015,
      origin_lon: 10.4015,
      bbox: { west: 10.4, east: 12.5, south: 45.6, north: 47.1 },
    } satisfies WeatherDatasetRow;
    const cell = {
      version: 'v1',
      row_idx: 0,
      col_idx: 0,
      t2m_min: [WEATHER_NODATA, 142],
      t2m_max: [WEATHER_NODATA, 232],
      precip_sum: [WEATHER_NODATA, 0],
      rh_mean: [WEATHER_NODATA, 485],
      gust_max: [WEATHER_NODATA, 308],
    } satisfies WeatherCellRow;

    expect(decodeWeatherDays(dataset, cell)).toEqual([
      {
        date: '2026-07-23',
        temperatureMin: null,
        temperatureMax: null,
        precipitation: null,
        humidity: null,
        gust: null,
        missing: true,
      },
      {
        date: '2026-07-24',
        temperatureMin: 14.2,
        temperatureMax: 23.2,
        precipitation: 0,
        humidity: 48.5,
        gust: 30.8,
        missing: false,
      },
    ]);
  });
});

