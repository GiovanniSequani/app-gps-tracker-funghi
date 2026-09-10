import { describe, expect, it, vi } from 'vitest';
const { getAccountSupabaseClient, getAccountSupabaseConfig } = vi.hoisted(() => ({
  getAccountSupabaseClient: vi.fn(),
  getAccountSupabaseConfig: vi.fn(),
}));
vi.mock('../supabase', () => ({ getAccountSupabaseClient, getAccountSupabaseConfig }));

import { AccountArchiveError } from '../types';
import { getExportStatusCopy, isExportDownloadable, type AccountExportJob } from '../rights';
import { confirmAccountDeletion, downloadAccountExport, loadLatestAccountExport, requestMyAccountDeletionVerification, requestMyDataExport } from '../rightsClient';
import { toAccountError } from '../validation';

const job: AccountExportJob = {
  id: 'job-1', status: 'ready', storage_path: 'user-1/job-1.zip', requested_at: '2026-09-01T08:00:00Z', ready_at: '2026-09-01T08:10:00Z', expires_at: '2099-09-02T08:10:00Z', size_bytes: 4096, last_error_code: null, updated_at: '2026-09-01T08:10:00Z',
};

describe('account rights client', () => {
  it('legge soltanto il job piu recente e richiede un export autenticato', async () => {
    const limit = vi.fn().mockResolvedValue({ data: [job], error: null });
    const order = vi.fn(() => ({ limit }));
    const select = vi.fn(() => ({ order }));
    const rpc = vi.fn().mockResolvedValue({ data: job, error: null });
    const supabase = { from: vi.fn(() => ({ select })), rpc } as never;
    await expect(loadLatestAccountExport(supabase)).resolves.toEqual(job);
    await expect(requestMyDataExport(supabase)).resolves.toEqual(job);
    expect(rpc).toHaveBeenCalledWith('request_my_data_export');
  });

  it('propaga Retry-After dal polling HTTP autenticato', async () => {
    getAccountSupabaseClient.mockReturnValue({ auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'private' } } }) } });
    getAccountSupabaseConfig.mockReturnValue({ url: 'https://project.supabase.co', anonKey: 'public-anon' });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'temporarily unavailable' }), {
      status: 503,
      headers: { 'Retry-After': '9', 'Content-Type': 'application/json' },
    }));
    try {
      await expect(loadLatestAccountExport()).rejects.toMatchObject({ status: 503, retryAfterMs: 9_000 });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('scarica dallo Storage privato senza URL firmati e non contatta Storage se scaduto', async () => {
    const blob = new Blob(['zip'], { type: 'application/zip' });
    const download = vi.fn().mockResolvedValue({ data: blob, error: null });
    const from = vi.fn(() => ({ download }));
    await expect(downloadAccountExport(job, { storage: { from } } as never)).resolves.toBe(blob);
    expect(from).toHaveBeenCalledWith('user-data-exports');
    await expect(downloadAccountExport({ ...job, expires_at: '2020-01-01T00:00:00Z' }, { storage: { from } } as never)).rejects.toMatchObject({ code: 'export_expired' });
    expect(isExportDownloadable({ ...job, expires_at: '2020-01-01T00:00:00Z' })).toBe(false);
  });

  it('propaga il fallimento export senza indicare un download riuscito', async () => {
    const download = vi.fn().mockResolvedValue({ data: null, error: new Error('network request failed') });
    await expect(downloadAccountExport(job, { storage: { from: () => ({ download }) } } as never)).rejects.toMatchObject({ code: 'network' });
  });

  it('richiede email di cancellazione e conferma il token solo come argomento RPC', async () => {
    const rpc = vi.fn(async (name: string) => name === 'confirm_account_deletion'
      ? { data: { confirmed: true, job_id: 'delete-1' }, error: null }
      : { data: { accepted: true, expires_in_minutes: 2880 }, error: null });
    const supabase = { rpc } as never;
    await expect(requestMyAccountDeletionVerification(supabase)).resolves.toMatchObject({ accepted: true });
    await expect(confirmAccountDeletion('a'.repeat(64), supabase)).resolves.toMatchObject({ confirmed: true });
    expect(rpc).toHaveBeenNthCalledWith(1, 'request_my_account_deletion_verification');
    expect(rpc).toHaveBeenNthCalledWith(2, 'confirm_account_deletion', { p_verification_token: 'a'.repeat(64) });
  });

  it('tratta token scaduto o gia usato come non ripetibile', async () => {
    const error = toAccountError(new Error('deletion verification token already used'));
    expect(error).toMatchObject({ code: 'deletion_token_invalid' });
    const rpc = vi.fn().mockResolvedValue({ data: null, error: new Error('verification token expired') });
    await expect(confirmAccountDeletion('b'.repeat(64), { rpc } as never)).rejects.toMatchObject({ code: 'deletion_token_invalid' });
  });

  it('espone una sessione scaduta senza aprire un export o proseguire una cancellazione', () => {
    expect(toAccountError({ status: 401, message: 'JWT expired' })).toMatchObject({ code: 'session_expired' });
  });

  it('classifica export scaduto e deletion_pending senza simulare il completamento', () => {
    expect(getExportStatusCopy({ ...job, expires_at: '2020-01-01T00:00:00Z' }).label).toBe('Download scaduto');
    expect(new AccountArchiveError('unknown', 'cancellazione interrotta').message).toBe('cancellazione interrotta');
  });
});
