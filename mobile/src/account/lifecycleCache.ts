import AsyncStorage from '@react-native-async-storage/async-storage';

import type { AccountAccess, AccountLifecyclePublicConfig } from './lifecycle';

const CACHE_SCHEMA_VERSION = 1;
const CACHE_KEY_PREFIX = '@funghitracker/account-lifecycle/v1/';

export const ACTIVE_ACCESS_OFFLINE_MAX_AGE_MS = 72 * 60 * 60 * 1000;

export type AccountLifecycleSnapshot = {
  schemaVersion: typeof CACHE_SCHEMA_VERSION;
  userId: string;
  verifiedAt: number;
  config: AccountLifecyclePublicConfig;
  access: AccountAccess;
};

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isConfig(value: unknown): value is AccountLifecyclePublicConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  return typeof config.api_available === 'boolean'
    && typeof config.lifecycle_enabled === 'boolean'
    && nullableString(config.current_terms_version)
    && nullableString(config.current_privacy_version)
    && typeof config.reaccept_days === 'number'
    && Number.isFinite(config.reaccept_days);
}

function isAccess(value: unknown): value is AccountAccess {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const access = value as Record<string, unknown>;
  return ['active', 'restricted', 'deletion_pending'].includes(String(access.account_state))
    && (access.restriction_reason === null
      || ['terms_outdated', 'terms_refused', 'inactive', 'security'].includes(String(access.restriction_reason)))
    && nullableString(access.terms_version)
    && nullableString(access.privacy_version)
    && typeof access.current_terms_version === 'string'
    && typeof access.current_privacy_version === 'string'
    && nullableString(access.legal_notice_first_seen_at)
    && nullableString(access.legal_notice_privacy_version)
    && nullableString(access.legal_reaccept_deadline_at)
    && nullableString(access.last_meaningful_activity_at)
    && nullableString(access.inactivity_delete_after)
    && typeof access.full_access === 'boolean'
    && typeof access.needs_terms_action === 'boolean';
}

export function lifecycleCacheKey(userId: string): string {
  return `${CACHE_KEY_PREFIX}${encodeURIComponent(userId)}`;
}

export function parseAccountLifecycleSnapshot(
  raw: string | null,
  expectedUserId: string,
  now = Date.now(),
): AccountLifecycleSnapshot | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<AccountLifecycleSnapshot>;
    if (
      value.schemaVersion !== CACHE_SCHEMA_VERSION
      || value.userId !== expectedUserId
      || typeof value.verifiedAt !== 'number'
      || !Number.isFinite(value.verifiedAt)
      || value.verifiedAt <= 0
      || value.verifiedAt > now + 5 * 60 * 1000
      || !isConfig(value.config)
      || !isAccess(value.access)
    ) return null;
    return value as AccountLifecycleSnapshot;
  } catch {
    return null;
  }
}

export function isCachedFullAccessExpired(
  snapshot: AccountLifecycleSnapshot,
  now = Date.now(),
): boolean {
  return snapshot.access.full_access === true
    && now - snapshot.verifiedAt > ACTIVE_ACCESS_OFFLINE_MAX_AGE_MS;
}

export async function loadAccountLifecycleSnapshot(userId: string): Promise<AccountLifecycleSnapshot | null> {
  return parseAccountLifecycleSnapshot(
    await AsyncStorage.getItem(lifecycleCacheKey(userId)),
    userId,
  );
}

export async function saveAccountLifecycleSnapshot(
  userId: string,
  config: AccountLifecyclePublicConfig,
  access: AccountAccess,
  verifiedAt = Date.now(),
): Promise<void> {
  const snapshot: AccountLifecycleSnapshot = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    userId,
    verifiedAt,
    config,
    access,
  };
  await AsyncStorage.setItem(lifecycleCacheKey(userId), JSON.stringify(snapshot));
}

export async function removeAccountLifecycleSnapshot(userId: string): Promise<void> {
  await AsyncStorage.removeItem(lifecycleCacheKey(userId));
}
