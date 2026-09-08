import type { SupabaseClient } from '@supabase/supabase-js';
import { getAccountSupabaseClient } from './supabase';
import {
  type AccountAccess,
  type AccountLifecyclePublicConfig,
  type AccountState,
  type MeaningfulActivityKind,
  type RestrictionReason,
} from './lifecycle';
import { toAccountError } from './validation';

const ACCOUNT_STATES: AccountState[] = ['active', 'restricted', 'deletion_pending'];
const REASONS: RestrictionReason[] = ['terms_outdated', 'terms_refused', 'inactive', 'security'];

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

export function requireAccountAccess(data: unknown): AccountAccess {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Risposta lifecycle account non valida.');
  }
  const value = data as Record<string, unknown>;
  if (
    !ACCOUNT_STATES.includes(value.account_state as AccountState)
    || !(value.restriction_reason === null || REASONS.includes(value.restriction_reason as RestrictionReason))
    || !nullableString(value.terms_version)
    || !nullableString(value.privacy_version)
    || typeof value.current_terms_version !== 'string'
    || typeof value.current_privacy_version !== 'string'
    || !nullableString(value.legal_notice_first_seen_at)
    || !nullableString(value.legal_notice_privacy_version)
    || !nullableString(value.legal_reaccept_deadline_at)
    || !nullableString(value.last_meaningful_activity_at)
    || !nullableString(value.inactivity_delete_after)
    || typeof value.full_access !== 'boolean'
    || typeof value.needs_terms_action !== 'boolean'
  ) throw new Error('Risposta lifecycle account non valida.');
  return value as AccountAccess;
}

export async function getAccountLifecyclePublicConfig(
  supabase: SupabaseClient = getAccountSupabaseClient(),
): Promise<AccountLifecyclePublicConfig> {
  const { data, error } = await supabase.rpc('get_account_lifecycle_public_config');
  if (error) throw toAccountError(error);
  const value = data as Record<string, unknown> | null;
  if (!value || typeof value.lifecycle_enabled !== 'boolean') {
    throw new Error('Configurazione lifecycle account non valida.');
  }
  const currentTerms = typeof value.current_terms_version === 'string' ? value.current_terms_version : null;
  const currentPrivacy = typeof value.current_privacy_version === 'string' ? value.current_privacy_version : null;
  if (value.lifecycle_enabled && (!currentTerms || !currentPrivacy)) {
    throw new Error('Configurazione lifecycle account incompleta.');
  }
  return {
    api_available: true,
    lifecycle_enabled: value.lifecycle_enabled,
    current_terms_version: currentTerms,
    current_privacy_version: currentPrivacy,
    reaccept_days: typeof value.reaccept_days === 'number' ? value.reaccept_days : 365,
  };
}

async function lifecycleRpc(
  name: string,
  params: Record<string, unknown> | undefined,
  supabase: SupabaseClient,
): Promise<AccountAccess> {
  const { data, error } = await supabase.rpc(name, params);
  if (error) throw toAccountError(error);
  return requireAccountAccess(data);
}

export function getMyAccountAccess(supabase: SupabaseClient = getAccountSupabaseClient()) {
  return lifecycleRpc('get_my_account_access', undefined, supabase);
}

function legalParams(termsVersion: string, privacyVersion: string) {
  return { p_terms_version: termsVersion, p_privacy_version: privacyVersion, p_source: 'mobile' };
}

export function recordMyLegalNoticeSeen(termsVersion: string, privacyVersion: string, supabase: SupabaseClient = getAccountSupabaseClient()) {
  return lifecycleRpc('record_my_legal_notice_seen', legalParams(termsVersion, privacyVersion), supabase);
}

export function acceptCurrentContributorTerms(termsVersion: string, privacyVersion: string, supabase: SupabaseClient = getAccountSupabaseClient()) {
  return lifecycleRpc('accept_current_contributor_terms', legalParams(termsVersion, privacyVersion), supabase);
}

export function refuseCurrentContributorTerms(termsVersion: string, privacyVersion: string, supabase: SupabaseClient = getAccountSupabaseClient()) {
  return lifecycleRpc('refuse_current_contributor_terms', legalParams(termsVersion, privacyVersion), supabase);
}

export function recordMyMeaningfulActivity(activityKind: MeaningfulActivityKind, supabase: SupabaseClient = getAccountSupabaseClient()) {
  return lifecycleRpc('record_my_meaningful_activity', { p_activity_kind: activityKind }, supabase);
}
