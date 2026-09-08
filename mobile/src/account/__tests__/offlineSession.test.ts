import { describe, expect, it } from 'vitest';
import { getSupabaseAuthStorageKey, parsePersistedAccountSession } from '../offlineSession';

describe('sessione account persistita per uso offline', () => {
  it('usa la stessa chiave predefinita del client Supabase', () => {
    expect(getSupabaseAuthStorageKey('https://projectref.supabase.co'))
      .toBe('sb-projectref-auth-token');
  });

  it('recupera solo una sessione locale strutturalmente valida', () => {
    const raw = JSON.stringify({
      access_token: 'access',
      refresh_token: 'refresh',
      user: { id: 'user-id' },
    });
    expect(parsePersistedAccountSession(raw)?.user.id).toBe('user-id');
    expect(parsePersistedAccountSession('{')).toBeNull();
    expect(parsePersistedAccountSession(JSON.stringify({ user: { id: 'user-id' } }))).toBeNull();
  });
});
