import type { WeatherDay } from './types';

export function clampSelectedDateIndex(
  index: number,
  dayCount: number,
): number {
  if (!Number.isFinite(index) || dayCount <= 0) return -1;
  return Math.max(0, Math.min(dayCount - 1, Math.round(index)));
}

export function synchronizeSelectedDateIndex(
  currentIndex: number,
  requestedIndex: number,
  dayCount: number,
): number {
  const next = clampSelectedDateIndex(requestedIndex, dayCount);
  return next === -1 ? clampSelectedDateIndex(currentIndex, dayCount) : next;
}

export function findLatestAvailableDateIndex(days: WeatherDay[]): number {
  for (let index = days.length - 1; index >= 0; index -= 1) {
    const day = days[index];
    if (
      !day.missing &&
      [
        day.temperatureMin,
        day.temperatureMax,
        day.precipitation,
        day.humidity,
        day.gust,
      ].some((value) => value !== null)
    ) {
      return index;
    }
  }
  return days.length > 0 ? days.length - 1 : -1;
}

