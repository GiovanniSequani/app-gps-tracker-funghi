import React from 'react';
import { AppState } from 'react-native';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { downloadAccountExport, loadLatestAccountExport, requestMyAccountDeletionVerification, requestMyDataExport } from './rightsClient';
import type { AccountExportJob, DeletionVerificationResponse } from './rights';
import { isExportDownloadable } from './rights';
import { AccountArchiveError } from './types';
import { toAccountError } from './validation';

export type AccountRightsState = {
  job: AccountExportJob | null;
  loading: boolean;
  busy: 'request_export' | 'download' | 'request_deletion' | null;
  available: boolean | null;
  error: string | null;
  deletionNotice: DeletionVerificationResponse | null;
  refresh: () => Promise<void>;
  requestExport: () => Promise<void>;
  downloadExport: () => Promise<void>;
  requestDeletion: () => Promise<void>;
};

async function saveExportBlob(blob: Blob): Promise<void> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const file = new File(Paths.cache, `funghitracker-export-${Date.now()}.zip`);
  try { file.create({ overwrite: true }); } catch { /* cache entry may exist */ }
  file.write(bytes);
  if (!await Sharing.isAvailableAsync()) throw new AccountArchiveError('unknown', 'Il download è pronto ma la condivisione file non è disponibile su questo dispositivo.');
  await Sharing.shareAsync(file.uri, { mimeType: 'application/zip', dialogTitle: 'Salva export FunghiTracker' });
}

export function useAccountRights(enabled: boolean): AccountRightsState {
  const [job, setJob] = React.useState<AccountExportJob | null>(null);
  const [loading, setLoading] = React.useState(enabled);
  const [busy, setBusy] = React.useState<AccountRightsState['busy']>(null);
  const [available, setAvailable] = React.useState<boolean | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [deletionNotice, setDeletionNotice] = React.useState<DeletionVerificationResponse | null>(null);
  const sequenceRef = React.useRef(0);
  const [appActive, setAppActive] = React.useState(AppState.currentState === 'active');

  const refresh = React.useCallback(async () => {
    if (!enabled) return;
    const sequence = ++sequenceRef.current;
    setLoading(true); setError(null);
    try {
      const next = await loadLatestAccountExport();
      if (sequence !== sequenceRef.current) return;
      setJob(next); setAvailable(true);
    } catch (cause) {
      if (sequence !== sequenceRef.current) return;
      const normalized = toAccountError(cause);
      if (normalized.code === 'rights_unavailable') setAvailable(false);
      setError(normalized.message);
    } finally { if (sequence === sequenceRef.current) setLoading(false); }
  }, [enabled]);

  React.useEffect(() => {
    if (!enabled) {
      sequenceRef.current += 1;
      setJob(null); setLoading(false); setBusy(null); setAvailable(null); setError(null); setDeletionNotice(null);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  React.useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setAppActive(state === 'active'));
    return () => subscription.remove();
  }, []);

  React.useEffect(() => {
    if (!enabled || !appActive || !job || !['pending', 'building', 'retry'].includes(job.status)) return;
    const timer = setTimeout(() => void refresh(), 15_000);
    return () => clearTimeout(timer);
  }, [appActive, enabled, job, refresh]);

  const requestExport = React.useCallback(async () => {
    setBusy('request_export'); setError(null);
    try { setJob(await requestMyDataExport()); setAvailable(true); }
    catch (cause) { const normalized = toAccountError(cause); if (normalized.code === 'rights_unavailable') setAvailable(false); setError(normalized.message); throw normalized; }
    finally { setBusy(null); }
  }, []);

  const downloadExport = React.useCallback(async () => {
    if (!job || !isExportDownloadable(job)) {
      const err = new AccountArchiveError('export_expired', 'Questo export non è più disponibile. Richiedine uno nuovo.');
      setError(err.message); throw err;
    }
    setBusy('download'); setError(null);
    try { await saveExportBlob(await downloadAccountExport(job)); }
    catch (cause) { const normalized = toAccountError(cause); setError(normalized.message); throw normalized; }
    finally { setBusy(null); }
  }, [job]);

  const requestDeletion = React.useCallback(async () => {
    setBusy('request_deletion'); setError(null);
    try { setDeletionNotice(await requestMyAccountDeletionVerification()); setAvailable(true); }
    catch (cause) {
      const normalized = toAccountError(cause);
      if (normalized.code === 'deletion_rate_limited') { setDeletionNotice({ accepted: true }); return; }
      if (normalized.code === 'rights_unavailable') setAvailable(false);
      setError(normalized.message); throw normalized;
    } finally { setBusy(null); }
  }, []);

  return { job, loading, busy, available, error, deletionNotice, refresh, requestExport, downloadExport, requestDeletion };
}
