import type { SupabaseClient } from '@supabase/supabase-js';
import { getAccountSupabaseClient, getAccountSupabaseConfig } from './supabase';
import { AccountArchiveError } from './types';
import type { AccountExportJob, DeletionConfirmationResponse, DeletionVerificationResponse } from './rights';
import { isExportDownloadable } from './rights';
import { toAccountError } from './validation';
import { createRetryableError } from '../network/retryPolicy';

const EXPORT_COLUMNS = ['id', 'status', 'storage_path', 'requested_at', 'ready_at', 'expires_at', 'size_bytes', 'last_error_code', 'updated_at'].join(',');

function requireObject<T>(data: unknown, message: string): T {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(message);
  return data as T;
}

export async function loadLatestAccountExport(supabase?: SupabaseClient, signal?: AbortSignal): Promise<AccountExportJob | null> {
  // L'iniezione resta disponibile per i test; il percorso runtime usa fetch per
  // poter rispettare Retry-After, non esposto dall'errore PostgREST del client.
  if (supabase) {
    const { data, error } = await supabase.from('account_export_jobs').select(EXPORT_COLUMNS).order('requested_at', { ascending: false }).limit(1);
    if (error) throw toAccountError(error);
    return ((data ?? [])[0] as unknown as AccountExportJob | undefined) ?? null;
  }

  const client = getAccountSupabaseClient();
  const { data: { session } } = await client.auth.getSession();
  if (!session) throw new AccountArchiveError('session_expired', 'La sessione è scaduta. Accedi di nuovo.');
  const { url, anonKey } = getAccountSupabaseConfig();
  const query = new URLSearchParams({ select: EXPORT_COLUMNS, order: 'requested_at.desc', limit: '1' });
  const response = await fetch(`${url}/rest/v1/account_export_jobs?${query.toString()}`, {
    signal,
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${session.access_token}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: unknown; code?: unknown } | null;
    const detail = typeof body?.message === 'string'
      ? body.message
      : typeof body?.code === 'string' ? body.code : 'Richiesta export non riuscita';
    throw createRetryableError(`${detail} (${response.status}).`, response);
  }
  const data = await response.json() as AccountExportJob[];
  return data[0] ?? null;
}

export async function requestMyDataExport(supabase: SupabaseClient = getAccountSupabaseClient()): Promise<AccountExportJob> {
  const { data, error } = await supabase.rpc('request_my_data_export');
  if (error) throw toAccountError(error);
  return requireObject<AccountExportJob>(data, 'Il server non ha restituito un job export valido.');
}

export async function downloadAccountExport(job: AccountExportJob, supabase: SupabaseClient = getAccountSupabaseClient()): Promise<Blob> {
  if (!isExportDownloadable(job)) throw new AccountArchiveError('export_expired', 'Questo export non è più disponibile. Richiedine uno nuovo.');
  const { data, error } = await supabase.storage.from('user-data-exports').download(job.storage_path);
  if (error) throw toAccountError(error);
  if (!data) throw new AccountArchiveError('unknown', 'Il file export non è disponibile. Aggiorna lo stato e riprova.');
  return data;
}

export async function requestMyAccountDeletionVerification(supabase: SupabaseClient = getAccountSupabaseClient()): Promise<DeletionVerificationResponse> {
  const { data, error } = await supabase.rpc('request_my_account_deletion_verification');
  if (error) throw toAccountError(error);
  return requireObject<DeletionVerificationResponse>(data, 'Risposta di verifica eliminazione non valida.');
}

// Reserved for the HTTPS confirmation boundary. Do not log, persist, or show
// the token; the ordinary mobile flow keeps confirmation on the public page.
export async function confirmAccountDeletion(token: string, supabase: SupabaseClient = getAccountSupabaseClient()): Promise<DeletionConfirmationResponse> {
  const { data, error } = await supabase.rpc('confirm_account_deletion', { p_verification_token: token });
  if (error) throw toAccountError(error);
  return requireObject<DeletionConfirmationResponse>(data, 'Risposta di conferma eliminazione non valida.');
}
