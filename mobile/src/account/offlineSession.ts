import type { Session } from '@supabase/supabase-js';

export function getSupabaseAuthStorageKey(url: string): string {
  const projectRef = new URL(url).hostname.split('.')[0];
  return `sb-${projectRef}-auth-token`;
}

export function parsePersistedAccountSession(raw: string | null): Session | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Session>;
    if (
      typeof value.access_token !== 'string'
      || typeof value.refresh_token !== 'string'
      || !value.user
      || typeof value.user.id !== 'string'
    ) return null;
    return value as Session;
  } catch {
    return null;
  }
}
