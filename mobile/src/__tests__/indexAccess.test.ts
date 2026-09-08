import { describe, expect, it } from 'vitest';
import { filterTileSetsForIndexAccess, getIndexAccessNoticeCopy, selectLimitedIndexDay } from '../index-access';
import type { IndexHistoryPointData } from '../index-history/types';

function isoDay(day: number): string {
  return `2026-09-${String(day).padStart(2, '0')}`;
}

describe('accesso indice mobile', () => {
  const tileSets = Array.from({ length: 28 }, (_, index) => ({ date: isoDay(28 - index), version: '1' }));

  it('lascia tutte le date all’account con full access', () => {
    expect(filterTileSetsForIndexAccess(tileSets, true)).toEqual(tileSets);
  });

  it('limita guest e account sospeso alla finestra D-27..D-7', () => {
    const allowed = filterTileSetsForIndexAccess(tileSets, false);
    expect(allowed[0].date).toBe('2026-09-21');
    expect(allowed.at(-1)?.date).toBe('2026-09-01');
    expect(allowed).toHaveLength(21);
  });

  it('sceglie l’ultimo giorno disponibile entro D-7 senza interpolare nodata', () => {
    const data: IndexHistoryPointData = {
      version: 'v1', indexDate: '2026-09-28', dateFrom: '2026-09-01', dateTo: '2026-09-28', row: 1, col: 1,
      dates: tileSets.map((item) => item.date).reverse(), availableDates: [], missingDates: ['2026-09-21'],
      days: tileSets.map((item) => ({ date: item.date, porciniScore: 10, finferliScore: 20 })).reverse(),
    };
    expect(selectLimitedIndexDay(data)?.date).toBe('2026-09-20');
  });

  it('usa messaggi distinti per guest e account limitato', () => {
    expect(getIndexAccessNoticeCopy(false, null).title).toBe('Accedi per usare tutti i servizi');
    expect(getIndexAccessNoticeCopy(true, null).title).toBe('Accesso temporaneamente limitato');
  });
});
