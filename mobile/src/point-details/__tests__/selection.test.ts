import { describe, expect, it } from 'vitest';
import {
  clampSelectedDateIndex,
  findLatestAvailableDateIndex,
  synchronizeSelectedDateIndex,
} from '../selection';
import type { WeatherDay } from '../types';

function day(date: string, value: number | null, missing = false): WeatherDay {
  return {
    date,
    temperatureMin: value,
    temperatureMax: value,
    precipitation: value,
    humidity: value,
    gust: value,
    missing,
  };
}

describe('shared selected day', () => {
  it('opens on the latest available day, skipping trailing nodata', () => {
    const days = [
      day('2026-07-22', 10),
      day('2026-07-23', 11),
      day('2026-07-24', null, true),
    ];
    expect(findLatestAvailableDateIndex(days)).toBe(1);
  });

  it('uses the same bounded index for selections coming from any chart', () => {
    let selected = 19;
    selected = synchronizeSelectedDateIndex(selected, 3, 20);
    expect(selected).toBe(3);
    selected = synchronizeSelectedDateIndex(selected, 12, 20);
    expect(selected).toBe(12);
    selected = synchronizeSelectedDateIndex(selected, 99, 20);
    expect(selected).toBe(19);
  });

  it('handles empty datasets and invalid indices', () => {
    expect(clampSelectedDateIndex(4, 0)).toBe(-1);
    expect(clampSelectedDateIndex(Number.NaN, 20)).toBe(-1);
  });
});

