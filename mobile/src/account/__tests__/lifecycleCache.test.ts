import { describe, expect, it } from 'vitest';

import type { AccountAccess, AccountLifecyclePublicConfig } from '../lifecycle';
import {
  ACTIVE_ACCESS_OFFLINE_MAX_AGE_MS,
  isCachedFullAccessExpired,
  lifecycleCacheKey,
  parseAccountLifecycleSnapshot,
  type AccountLifecycleSnapshot,
} from '../lifecycleCache';

const config: AccountLifecyclePublicConfig = {
  api_available: true,
  lifecycle_enabled: true,
  current_terms_version: '1.0',
  current_privacy_version: '1.0',
  reaccept_days: 365,
};

const activeAccess: AccountAccess = {
  account_state: 'active',
  restriction_reason: null,
  terms_version: '1.0',
  privacy_version: '1.0',
  current_terms_version: '1.0',
  current_privacy_version: '1.0',
  legal_notice_first_seen_at: null,
  legal_notice_privacy_version: null,
  legal_reaccept_deadline_at: null,
  last_meaningful_activity_at: null,
  inactivity_delete_after: null,
  full_access: true,
  needs_terms_action: false,
};

function snapshot(overrides?: Partial<AccountLifecycleSnapshot>): AccountLifecycleSnapshot {
  return {
    schemaVersion: 1,
    userId: 'user-1',
    verifiedAt: 1_000_000,
    config,
    access: activeAccess,
    ...overrides,
  };
}

describe('cache lifecycle account', () => {
  it('accetta soltanto snapshot validi appartenenti allo stesso utente', () => {
    const raw = JSON.stringify(snapshot());
    expect(parseAccountLifecycleSnapshot(raw, 'user-1')).toEqual(snapshot());
    expect(parseAccountLifecycleSnapshot(raw, 'user-2')).toBeNull();
    expect(parseAccountLifecycleSnapshot('{', 'user-1')).toBeNull();
    expect(parseAccountLifecycleSnapshot(JSON.stringify({ ...snapshot(), schemaVersion: 2 }), 'user-1')).toBeNull();
    expect(parseAccountLifecycleSnapshot(raw, 'user-1', snapshot().verifiedAt - 10 * 60 * 1000)).toBeNull();
  });

  it('limita a 72 ore soltanto lo snapshot che concedeva accesso completo', () => {
    const active = snapshot();
    expect(isCachedFullAccessExpired(active, active.verifiedAt + ACTIVE_ACCESS_OFFLINE_MAX_AGE_MS)).toBe(false);
    expect(isCachedFullAccessExpired(active, active.verifiedAt + ACTIVE_ACCESS_OFFLINE_MAX_AGE_MS + 1)).toBe(true);

    const restricted = snapshot({
      access: { ...activeAccess, account_state: 'restricted', restriction_reason: 'security', full_access: false },
    });
    expect(isCachedFullAccessExpired(restricted, restricted.verifiedAt + ACTIVE_ACCESS_OFFLINE_MAX_AGE_MS * 10)).toBe(false);
  });

  it('usa una chiave separata per ogni utente', () => {
    expect(lifecycleCacheKey('user/one')).not.toBe(lifecycleCacheKey('user/two'));
    expect(lifecycleCacheKey('user/one')).toContain('user%2Fone');
  });
});
