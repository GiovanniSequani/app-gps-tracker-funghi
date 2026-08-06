export function aspectDegreesToDirection(
  degrees: number | null | undefined,
): string | null {
  if (degrees === null || degrees === undefined || !Number.isFinite(degrees)) {
    return null;
  }
  const normalized = ((degrees % 360) + 360) % 360;
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'] as const;
  return directions[Math.floor((normalized + 22.5) / 45) % directions.length];
}

export function formatAspect(
  degrees: number | null | undefined,
): string {
  const direction = aspectDegreesToDirection(degrees);
  if (!direction || degrees === null || degrees === undefined) return 'N/D';
  const normalized = ((degrees % 360) + 360) % 360;
  return `${direction} · ${Math.round(normalized)}°`;
}

export function tpiCategoryLabel(category: number | null | undefined): string {
  if (category === 1) return 'Sottoelevato';
  if (category === 2) return 'In media';
  if (category === 3) return 'Sopraelevato';
  return 'Non disponibile';
}

function parseIsoDate(date: string): Date {
  return new Date(`${date}T12:00:00.000Z`);
}

export function formatItalianDate(
  date: string,
  options: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  },
): string {
  const parsed = parseIsoDate(date);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat('it-IT', {
    ...options,
    timeZone: 'UTC',
  }).format(parsed);
}

export function formatItalianPeriod(dates: string[]): string {
  if (dates.length === 0) return 'Periodo non disponibile';
  const first = formatItalianDate(dates[0], {
    day: 'numeric',
    month: 'short',
  });
  const last = formatItalianDate(dates[dates.length - 1], {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return `${first} – ${last}`;
}

