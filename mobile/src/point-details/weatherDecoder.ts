import type { WeatherCellRow, WeatherDatasetRow, WeatherDay } from './types';

export const WEATHER_NODATA = -32768;
export const WEATHER_SCALE = 0.1;

export function decodeWeatherSmallInt(
  encoded: number | null | undefined,
): number | null {
  if (
    encoded === null ||
    encoded === undefined ||
    !Number.isFinite(encoded) ||
    encoded === WEATHER_NODATA
  ) {
    return null;
  }
  return encoded / (1 / WEATHER_SCALE);
}

function valueAt(series: number[], index: number): number | null {
  return decodeWeatherSmallInt(series[index]);
}

export function decodeWeatherDays(
  dataset: WeatherDatasetRow,
  cell: WeatherCellRow,
): WeatherDay[] {
  const missingDates = new Set(dataset.missing_dates);
  return dataset.dates.map((date, index) => {
    const temperatureMin = valueAt(cell.t2m_min, index);
    const temperatureMax = valueAt(cell.t2m_max, index);
    const precipitation = valueAt(cell.precip_sum, index);
    const humidity = valueAt(cell.rh_mean, index);
    const gust = valueAt(cell.gust_max, index);
    return {
      date,
      temperatureMin,
      temperatureMax,
      precipitation,
      humidity,
      gust,
      missing:
        missingDates.has(date) ||
        [
          temperatureMin,
          temperatureMax,
          precipitation,
          humidity,
          gust,
        ].every((value) => value === null),
    };
  });
}
