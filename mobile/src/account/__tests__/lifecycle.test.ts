import { describe, expect, it, vi } from 'vitest';
vi.mock('../supabase', () => ({ getAccountSupabaseClient: vi.fn() }));

import { bundledDocumentsMatch, canChangeLegalAcceptance, hasLifecycleFullAccess, LEGACY_LIFECYCLE_CONFIG, lifecycleStateCopy, type AccountAccess } from '../lifecycle';
import { acceptCurrentContributorTerms, getAccountLifecyclePublicConfig, getMyAccountAccess, recordMyLegalNoticeSeen, recordMyMeaningfulActivity, refuseCurrentContributorTerms } from '../lifecycleClient';

const access: AccountAccess = {
  account_state: 'active', restriction_reason: null, terms_version: '1.0', privacy_version: '1.0',
  current_terms_version: '1.0', current_privacy_version: '1.0', legal_notice_first_seen_at: null,
  legal_notice_privacy_version: null, legal_reaccept_deadline_at: null,
  last_meaningful_activity_at: null, inactivity_delete_after: null,
  full_access: true, needs_terms_action: false,
};
const enabled = { api_available: true, lifecycle_enabled: true, current_terms_version: '1.0', current_privacy_version: '1.0', reaccept_days: 365 };

describe('account lifecycle contract', () => {
  it('concede accesso completo solo alla risposta server full_access=true', () => {
    expect(hasLifecycleFullAccess(true, enabled, access)).toBe(true);
    expect(hasLifecycleFullAccess(true, enabled, { ...access, account_state: 'restricted', full_access: false })).toBe(false);
    expect(hasLifecycleFullAccess(true, enabled, null)).toBe(false);
    expect(hasLifecycleFullAccess(false, enabled, access)).toBe(false);
  });

  it('resta fail-closed quando API, rollout o stato autorevole non sono disponibili', () => {
    expect(hasLifecycleFullAccess(true, LEGACY_LIFECYCLE_CONFIG, null)).toBe(false);
    expect(hasLifecycleFullAccess(true, { ...enabled, lifecycle_enabled: false }, null)).toBe(false);
    expect(hasLifecycleFullAccess(true, null, null)).toBe(false);
  });

  it('blocca accettazione per security e deletion_pending e valida versioni bundled', () => {
    expect(canChangeLegalAcceptance({ ...access, account_state: 'deletion_pending' })).toBe(false);
    expect(canChangeLegalAcceptance({ ...access, restriction_reason: 'security' })).toBe(false);
    expect(canChangeLegalAcceptance({ ...access, account_state: 'restricted', restriction_reason: 'terms_outdated', full_access: false })).toBe(true);
    expect(bundledDocumentsMatch(enabled)).toBe(true);
    expect(bundledDocumentsMatch({ ...enabled, current_privacy_version: '1.1' })).toBe(false);
  });

  it('mantiene i messaggi web per stati limitati e non verificabili', () => {
    expect(lifecycleStateCopy(null).title).toBe('Accesso temporaneamente limitato');
    expect(lifecycleStateCopy({ ...access, account_state: 'deletion_pending', full_access: false }).title).toBe('Account in eliminazione');
    expect(lifecycleStateCopy({ ...access, account_state: 'restricted', restriction_reason: 'terms_outdated', full_access: false }).title).toBe('È richiesta una nuova accettazione');
    expect(lifecycleStateCopy({ ...access, account_state: 'restricted', restriction_reason: 'terms_refused', full_access: false }).title).toBe('Account con accesso limitato');
    expect(lifecycleStateCopy({ ...access, account_state: 'restricted', restriction_reason: 'inactive', full_access: false }).title).toBe('Accesso limitato per inattività');
    expect(lifecycleStateCopy({ ...access, account_state: 'restricted', restriction_reason: 'security', full_access: false }).title).toBe('Accesso limitato per sicurezza');
  });

  it('resta fail-closed se la RPC lifecycle manca o la rete non risponde', async () => {
    const missing = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'schema cache' } }) } as never;
    await expect(getAccountLifecyclePublicConfig(missing)).rejects.toBeTruthy();
    const network = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'Failed to fetch' } }) } as never;
    await expect(getAccountLifecyclePublicConfig(network)).rejects.toBeTruthy();
  });

  it('rifiuta risposte accesso incomplete o sconosciute', async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: { ...access, full_access: 'yes' }, error: null }) } as never;
    await expect(getMyAccountAccess(supabase)).rejects.toThrow('Risposta lifecycle account non valida');
  });

  it('invia source mobile e attività significative alle RPC corrette', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: access, error: null });
    const supabase = { rpc } as never;
    await recordMyLegalNoticeSeen('1.0', '1.0', supabase);
    await acceptCurrentContributorTerms('1.0', '1.0', supabase);
    await refuseCurrentContributorTerms('1.0', '1.0', supabase);
    await recordMyMeaningfulActivity('foreground_session', supabase);
    expect(rpc.mock.calls.slice(0, 3).map((call) => call[1])).toEqual(Array(3).fill({ p_terms_version: '1.0', p_privacy_version: '1.0', p_source: 'mobile' }));
    expect(rpc).toHaveBeenLastCalledWith('record_my_meaningful_activity', { p_activity_kind: 'foreground_session' });
  });
});
