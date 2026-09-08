import type { AccountAccess } from './account/lifecycle';
import type { IndexHistoryDay, IndexHistoryPointData } from './index-history/types';

export type IndexTileSet = { date: string; version: string };

const LIMITED_DELAY_DAYS = 7;
const HISTORY_WINDOW_DAYS = 27;

function parseDate(value: string): Date | null {
  const normalized = value.replace(/_/g, '-');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const date = new Date(`${normalized}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function shiftUtcDays(date: Date, days: number): number {
  const shifted = new Date(date);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.getTime();
}

export function filterTileSetsForIndexAccess<T extends IndexTileSet>(
  tileSets: T[],
  fullAccess: boolean,
): T[] {
  if (fullAccess || tileSets.length === 0) return tileSets;
  const currentDate = parseDate(tileSets[0].date);
  if (!currentDate) return [];
  const latestAllowed = shiftUtcDays(currentDate, -LIMITED_DELAY_DAYS);
  const earliestAllowed = shiftUtcDays(currentDate, -HISTORY_WINDOW_DAYS);
  return tileSets.filter((tileSet) => {
    const date = parseDate(tileSet.date)?.getTime();
    return date !== undefined && date >= earliestAllowed && date <= latestAllowed;
  });
}

export function selectLimitedIndexDay(data: IndexHistoryPointData): IndexHistoryDay | null {
  const currentDate = parseDate(data.indexDate);
  if (!currentDate) return null;
  const latestAllowed = shiftUtcDays(currentDate, -LIMITED_DELAY_DAYS);
  const earliestAllowed = shiftUtcDays(currentDate, -HISTORY_WINDOW_DAYS);
  const missing = new Set(data.missingDates);
  return [...data.days].reverse().find((day) => {
    const date = parseDate(day.date)?.getTime();
    return date !== undefined
      && date >= earliestAllowed
      && date <= latestAllowed
      && !missing.has(day.date);
  }) ?? null;
}

export function getIndexAccessNoticeCopy(authenticated: boolean, access: AccountAccess | null) {
  if (!authenticated) return {
    title: 'Accedi per usare tutti i servizi',
    description: 'Stai visualizzando l’indice pubblico con 7 giorni di ritardo.',
    action: 'Accedi o registrati',
  };
  if (!access) return {
    title: 'Accesso temporaneamente limitato',
    description: 'Non è stato possibile verificare lo stato dell’account. Le funzioni riservate restano bloccate.',
    action: 'Controlla il profilo',
  };
  if (access.account_state === 'deletion_pending') return {
    title: 'Account in eliminazione',
    description: 'Le funzioni riservate non sono più disponibili mentre la cancellazione è in corso.',
    action: 'Controlla lo stato',
  };
  switch (access.restriction_reason) {
    case 'terms_outdated':
    case 'terms_refused':
      return { title: 'Aggiorna i documenti del tuo account', description: 'Accetta i Termini correnti per riattivare l’accesso completo a FunghiTracker.', action: 'Leggi e accetta i documenti' };
    case 'inactive':
      return { title: 'Riattiva il tuo account', description: 'L’account è limitato per inattività. Apri il profilo per riattivarlo e controllare i documenti.', action: 'Apri il profilo' };
    case 'security':
      return { title: 'Account limitato per sicurezza', description: 'Le funzioni riservate sono bloccate. Apri il profilo per vedere lo stato e contattare l’assistenza.', action: 'Apri il profilo' };
    default:
      return { title: 'Account con accesso limitato', description: 'Apri il profilo per controllare lo stato dell’account e le azioni disponibili.', action: 'Apri il profilo' };
  }
}
