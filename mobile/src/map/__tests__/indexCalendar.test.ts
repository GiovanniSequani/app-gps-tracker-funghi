import { describe, expect, it } from 'vitest';

import { buildIndexCalendarDays, indexCalendarAvailability, newestTileForDate } from '../indexCalendar';

describe('calendario indice', () => {
  const all = [
    { date: '2026-09-08', version: '2' },
    { date: '2026-09-08', version: '1' },
    { date: '2026-09-01', version: '1' },
  ];
  const allowed = [all[2]];

  it('distingue date disponibili, riservate e assenti', () => {
    expect(indexCalendarAvailability('2026-09-01', allowed, all)).toBe('available');
    expect(indexCalendarAvailability('2026-09-08', allowed, all)).toBe('restricted');
    expect(indexCalendarAvailability('2026-09-02', allowed, all)).toBe('unavailable');
  });

  it('seleziona la versione più recente già ordinata per una data', () => {
    expect(newestTileForDate('2026-09-08', all)).toEqual(all[0]);
  });

  it('costruisce settimane complete da lunedì a domenica', () => {
    const days = buildIndexCalendarDays(new Date(2026, 8, 1));
    expect(days.length % 7).toBe(0);
    expect(days[0].date.getDay()).toBe(1);
    expect(days.at(-1)?.date.getDay()).toBe(0);
  });
});
