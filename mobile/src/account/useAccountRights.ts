import React from 'react';
import { AppState } from 'react-native';
import { File } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { downloadAccountExport, loadLatestAccountExport, requestMyAccountDeletionVerification, requestMyDataExport } from './rightsClient';
import type { AccountExportJob, DeletionVerificationResponse } from './rights';
import { isExportDownloadable } from './rights';
import { AccountArchiveError } from './types';
import { toAccountError } from './validation';
import { backoffDelayMs, retryAfterFromError } from '../network/retryPolicy';
import { useNetworkAvailability } from '../network/useNetworkAvailability';
import { createSensitiveTempFileUri, deleteSensitiveTempFile } from '../security/sensitiveTempFiles';

const EXPORT_POLL_BASE_MS = 15_000;
const EXPORT_POLL_MAX_MS = 120_000;
const EXPORT_POLL_MAX_ATTEMPTS = 8;

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
  const uri = await createSensitiveTempFileUri('funghitracker-export.zip');
  try {
    const file = new File(uri);
    try { file.create({ overwrite: true }); } catch { /* directory is private and disposable */ }
    file.write(bytes);
    if (!await Sharing.isAvailableAsync()) throw new AccountArchiveError('unknown', 'Il download è pronto ma la condivisione file non è disponibile su questo dispositivo.');
    await Sharing.shareAsync(file.uri, { mimeType: 'application/zip', dialogTitle: 'Salva export FunghiTracker' });
  } finally {
    await deleteSensitiveTempFile(uri).catch(() => undefined);
  }
}

export function useAccountRights(enabled: boolean): AccountRightsState {
  const [job, setJob] = React.useState<AccountExportJob | null>(null);
  const [loading, setLoading] = React.useState(enabled);
  const [busy, setBusy] = React.useState<AccountRightsState['busy']>(null);
  const [available, setAvailable] = React.useState<boolean | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [deletionNotice, setDeletionNotice] = React.useState<DeletionVerificationResponse | null>(null);
  const [pollRevision, setPollRevision] = React.useState(0);
  const sequenceRef = React.useRef(0);
  const [appActive, setAppActive] = React.useState(AppState.currentState === 'active');
  const online = useNetworkAvailability();
  const pollAttemptRef = React.useRef(0);
  const retryAfterRef = React.useRef<number | undefined>(undefined);
  const inFlightRef = React.useRef(false);
  const abortRef = React.useRef<AbortController | null>(null);

  const refreshInternal = React.useCallback(async (manual: boolean) => {
    if (!enabled || inFlightRef.current || (!manual && (!appActive || online === false))) return;
    if (manual) {
      pollAttemptRef.current = 0;
      retryAfterRef.current = undefined;
    }
    inFlightRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    const sequence = ++sequenceRef.current;
    setLoading(true); setError(null);
    try {
      const next = await loadLatestAccountExport(undefined, controller.signal);
      if (sequence !== sequenceRef.current) return;
      if (next?.status !== job?.status) pollAttemptRef.current = 0;
      setJob(next); setAvailable(true);
      retryAfterRef.current = undefined;
    } catch (cause) {
      if (sequence !== sequenceRef.current) return;
      retryAfterRef.current = retryAfterFromError(cause);
      const normalized = toAccountError(cause);
      if (normalized.code === 'rights_unavailable') setAvailable(false);
      setError(normalized.message);
    } finally {
      inFlightRef.current = false;
      if (abortRef.current === controller) abortRef.current = null;
      if (sequence === sequenceRef.current) {
        setLoading(false);
        setPollRevision((current) => current + 1);
      }
    }
  }, [appActive, enabled, job?.status, online]);

  const refresh = React.useCallback(() => refreshInternal(true), [refreshInternal]);

  React.useEffect(() => {
    if (!enabled) {
      sequenceRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      inFlightRef.current = false;
      setJob(null); setLoading(false); setBusy(null); setAvailable(null); setError(null); setDeletionNotice(null);
      return;
    }
    void refreshInternal(false);
  }, [appActive, enabled, online]);

  React.useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      const active = state === 'active';
      if (!active) {
        sequenceRef.current += 1;
        abortRef.current?.abort();
        abortRef.current = null;
        inFlightRef.current = false;
        setLoading(false);
      }
      setAppActive(active);
    });
    return () => { subscription.remove(); abortRef.current?.abort(); };
  }, []);

  React.useEffect(() => {
    if (!enabled || !appActive || online === false || !job || !['pending', 'building', 'retry'].includes(job.status)) return;
    if (pollAttemptRef.current >= EXPORT_POLL_MAX_ATTEMPTS) {
      setError((current) => current ?? 'Aggiornamento automatico sospeso. Tocca Riprova per controllare lo stato.');
      return;
    }
    const delay = backoffDelayMs({
      attempt: pollAttemptRef.current,
      baseMs: EXPORT_POLL_BASE_MS,
      maxMs: EXPORT_POLL_MAX_MS,
      retryAfterMs: retryAfterRef.current,
      jitterRatio: 0.15,
    });
    const timer = setTimeout(() => {
      pollAttemptRef.current += 1;
      void refreshInternal(false);
    }, delay);
    return () => clearTimeout(timer);
  }, [appActive, enabled, job, online, pollRevision, refreshInternal]);

  const requestExport = React.useCallback(async () => {
    setBusy('request_export'); setError(null);
    try {
      setJob(await requestMyDataExport());
      pollAttemptRef.current = 0;
      retryAfterRef.current = undefined;
      setAvailable(true);
    }
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
