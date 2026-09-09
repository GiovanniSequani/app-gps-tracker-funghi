export type IndexCalendarTile = { date: string; version: string };

export type IndexCalendarDay = {
  date: Date;
  key: string;
  inCurrentMonth: boolean;
};

export type IndexCalendarAvailability = 'available' | 'restricted' | 'unavailable';

export function normalizeIndexDate(date: string): string {
  return date.replace(/_/g, '-');
}

export function parseIndexDate(date: string): Date | null {
  const match = normalizeIndexDate(date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function indexCalendarKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

export function buildIndexCalendarDays(monthDate: Date): IndexCalendarDay[] {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const daysBefore = (first.getDay() + 6) % 7;
  const daysAfter = 6 - ((last.getDay() + 6) % 7);
  const start = new Date(year, month, 1 - daysBefore);

  return Array.from({ length: daysBefore + last.getDate() + daysAfter }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return { date, key: indexCalendarKey(date), inCurrentMonth: date.getMonth() === month };
  });
}

export function indexCalendarAvailability(
  date: string,
  allowedTileSets: IndexCalendarTile[],
  allTileSets: IndexCalendarTile[],
): IndexCalendarAvailability {
  const key = normalizeIndexDate(date);
  if (allowedTileSets.some((tile) => normalizeIndexDate(tile.date) === key)) return 'available';
  if (allTileSets.some((tile) => normalizeIndexDate(tile.date) === key)) return 'restricted';
  return 'unavailable';
}

export function newestTileForDate(
  date: string,
  tileSets: IndexCalendarTile[],
): IndexCalendarTile | null {
  const key = normalizeIndexDate(date);
  return tileSets.find((tile) => normalizeIndexDate(tile.date) === key) ?? null;
}
