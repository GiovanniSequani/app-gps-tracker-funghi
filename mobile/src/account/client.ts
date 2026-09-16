import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { getAccountSupabaseClient } from './supabase';
import { purgeSensitiveTempFiles } from '../security/sensitiveTempFiles';
import {
  AccountArchiveError,
  type ArchiveConfig,
  type ArchiveData,
  type GpxTrack,
  type GpxMushroomMarker,
  type MushroomSpecies,
  type GpxTrackPoint,
  type PreparedGpxUpload,
  type ReserveTrackResult,
  type UserProfile,
} from './types';
import {
  isMissingStorageObject,
  normalizeTrackName,
  normalizeUsername,
  safeGpxName,
  toAccountError,
  validateTrackName,
} from './validation';
import {
  AUTH_CONFIRM_REDIRECT_URL,
  AUTH_RECOVERY_REDIRECT_URL,
  isUsedOrExpiredTokenError,
  type AuthCallbackRequest,
} from './authCallbacks';
import type { AccountLifecyclePublicConfig } from './lifecycle';
import { reportAccountOperationFailure } from './diagnostics';

const TRACK_COLUMNS = [
  'id', 'storage_path', 'status', 'display_name', 'original_filename',
  'compressed_size_bytes', 'uncompressed_size_bytes', 'started_at', 'ended_at',
  'point_count', 'distance_m', 'ready_at', 'created_at',
  'trim_start_point_index', 'trim_end_point_index',
].join(',');

const MUSHROOM_MARKER_COLUMNS = [
  'id', 'track_id', 'track_point_index', 'latitude', 'longitude', 'species', 'count', 'created_at', 'updated_at',
].join(',');

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function getArchiveConfig(supabase = getAccountSupabaseClient()): Promise<ArchiveConfig> {
  const { data, error } = await supabase
    .from('gpx_archive_config')
    .select('*')
    .eq('singleton_id', 1)
    .single();
  if (error) throw toAccountError(error);
  return data as ArchiveConfig;
}

export async function getMyProfile(supabase = getAccountSupabaseClient()): Promise<UserProfile> {
  const { data, error } = await supabase.from('user_profiles').select('*').single();
  if (error) throw toAccountError(error);
  return data as UserProfile;
}

export async function signIn(email: string, password: string): Promise<Session> {
  const { data, error } = await getAccountSupabaseClient().auth.signInWithPassword({
    email: email.trim(),
    password,
  });
  if (error) throw toAccountError(error);
  if (!data.session) throw new AccountArchiveError('session_expired', 'Accesso non completato. Riprova.');
  return data.session;
}

export type SignUpInput = {
  email: string;
  password: string;
  username: string;
  lifecycleConfig: AccountLifecyclePublicConfig;
};

export function buildSignUpMetadata(input: SignUpInput): Record<string, unknown> {
  const username = normalizeUsername(input.username);
  if (!input.lifecycleConfig.api_available || !input.lifecycleConfig.lifecycle_enabled) {
    throw new AccountArchiveError('lifecycle_unavailable', 'Configurazione account non disponibile. Riprova più tardi.');
  }
  const termsVersion = input.lifecycleConfig.current_terms_version;
  const privacyVersion = input.lifecycleConfig.current_privacy_version;
  if (!termsVersion || !privacyVersion) {
    throw new AccountArchiveError(
      'lifecycle_unavailable',
      'Le versioni correnti dei documenti non sono disponibili. Riprova più tardi.',
    );
  }
  return {
    username,
    terms_accepted: true,
    privacy_acknowledged: true,
    terms_version: termsVersion,
    privacy_version: privacyVersion,
    terms_acceptance_source: 'mobile',
  };
}

export async function signUp(
  input: SignUpInput,
  supabase: SupabaseClient = getAccountSupabaseClient(),
): Promise<{ session: Session | null }> {
  const { data, error } = await supabase.auth.signUp({
    email: input.email.trim(),
    password: input.password,
    options: {
      emailRedirectTo: AUTH_CONFIRM_REDIRECT_URL,
      data: buildSignUpMetadata(input),
    },
  });
  if (error) throw toAccountError(error);
  return { session: data.session };
}

export async function requestPasswordRecovery(
  email: string,
  supabase: SupabaseClient = getAccountSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
    redirectTo: AUTH_RECOVERY_REDIRECT_URL,
  });
  if (!error) return;
  const normalized = toAccountError(error);
  if (normalized.code === 'network' || normalized.code === 'configuration') throw normalized;
  throw new AccountArchiveError(
    'unknown',
    'Non è stato possibile inviare il messaggio. Attendi e riprova.',
    { cause: error },
  );
}

export async function verifyAuthCallback(
  request: AuthCallbackRequest,
  supabase: SupabaseClient = getAccountSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.auth.verifyOtp({
    token_hash: request.tokenHash,
    type: request.type,
  });
  if (!error) return;
  const normalized = toAccountError(error);
  if (normalized.code === 'network' || normalized.code === 'configuration') throw normalized;
  if (!isUsedOrExpiredTokenError(error)) {
    throw new AccountArchiveError(
      'unknown',
      'Non è stato possibile verificare il link. Controlla la rete e riprova.',
      { cause: error },
    );
  }
  throw new AccountArchiveError(
    'unknown',
    'Il link non è valido, è scaduto o è già stato usato. Richiedine uno nuovo.',
    { cause: error },
  );
}

export async function updateRecoveredPassword(
  password: string,
  supabase: SupabaseClient = getAccountSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw toAccountError(error);
}

export async function signOut(): Promise<void> {
  try {
    const { error } = await getAccountSupabaseClient().auth.signOut();
    if (error) throw toAccountError(error);
  } finally {
    await purgeSensitiveTempFiles().catch(() => undefined);
  }
}

export async function loadArchiveData(
  supabase: SupabaseClient = getAccountSupabaseClient(),
): Promise<ArchiveData> {
  const [configResult, profileResult, tracksResult] = await Promise.all([
    supabase.from('gpx_archive_config').select('*').eq('singleton_id', 1).single(),
    supabase.from('user_profiles').select('*').single(),
    supabase.from('user_gpx_tracks').select(TRACK_COLUMNS).eq('status', 'ready')
      .order('created_at', { ascending: false }),
  ]);
  const error = configResult.error ?? profileResult.error ?? tracksResult.error;
  if (error) throw toAccountError(error);
  return {
    config: configResult.data as ArchiveConfig,
    profile: profileResult.data as UserProfile,
    tracks: (tracksResult.data ?? []) as unknown as GpxTrack[],
  };
}

async function deleteMetadata(trackId: string, supabase: SupabaseClient): Promise<void> {
  const { error } = await supabase.rpc('delete_my_gpx_track_metadata', { p_track_id: trackId });
  if (error) throw error;
}

async function rollbackReservation(
  reservation: ReserveTrackResult,
  supabase: SupabaseClient,
  removeObject: boolean,
): Promise<boolean> {
  try {
    if (removeObject) {
      const { error } = await supabase.storage.from('user-gpx').remove([reservation.storage_path]);
      if (error && !isMissingStorageObject(error)) return false;
    }
    await deleteMetadata(reservation.id, supabase);
    return true;
  } catch {
    return false;
  }
}

export async function uploadPreparedTrack(
  input: { displayName: string; prepared: PreparedGpxUpload },
  supabase: SupabaseClient = getAccountSupabaseClient(),
): Promise<GpxTrack> {
  const nameError = validateTrackName(input.displayName);
  if (nameError) throw new AccountArchiveError('invalid_track_name', nameError);
  const displayName = normalizeTrackName(input.displayName);
  const originalFilename = `${safeGpxName(displayName)}.gpx`;
  const prepared = input.prepared;
  const { data: reservedData, error: reserveError } = await supabase.rpc('reserve_my_gpx_track', {
    p_display_name: displayName,
    p_original_filename: originalFilename,
    p_compressed_size_bytes: prepared.compressedSizeBytes,
    p_content_sha256: prepared.contentSha256,
    p_uncompressed_size_bytes: prepared.uncompressedSizeBytes,
    p_started_at: prepared.startedAt,
    p_ended_at: prepared.endedAt,
    p_point_count: prepared.pointCount,
    p_distance_m: prepared.distanceM,
    p_bbox: prepared.bbox,
  });
  if (reserveError) throw toAccountError(reserveError);
  const reservation = reservedData as ReserveTrackResult;
  if (!reservation?.id || !reservation.storage_path) {
    throw new AccountArchiveError('unknown', 'Il server non ha restituito una prenotazione valida.');
  }

  const { error: uploadError } = await supabase.storage.from('user-gpx').upload(
    reservation.storage_path,
    exactArrayBuffer(prepared.bytes),
    { contentType: 'application/gzip', upsert: false },
  );
  if (uploadError) {
    // A network error can be ambiguous: remove the canonical path first in case
    // Storage accepted the bytes before the client lost the response.
    const released = await rollbackReservation(reservation, supabase, true);
    throw new AccountArchiveError(
      'upload_failed',
      released
        ? 'Caricamento non riuscito. La prenotazione è stata annullata: riprova.'
        : 'Caricamento non riuscito e la prenotazione non è stata liberata. Riprova più tardi.',
      { cause: uploadError, partial: !released },
    );
  }

  const { data: finalizedData, error: finalizeError } = await supabase.rpc('finalize_my_gpx_track', {
    p_track_id: reservation.id,
  });
  if (finalizeError) {
    const rolledBack = await rollbackReservation(reservation, supabase, true);
    throw new AccountArchiveError(
      'finalize_failed',
      rolledBack
        ? 'Il caricamento non è stato finalizzato ed è stato annullato. Riprova.'
        : 'Il file è stato caricato, ma la finalizzazione non è completa. Aggiorna l’archivio prima di riprovare.',
      { cause: finalizeError, partial: !rolledBack },
    );
  }
  return finalizedData as GpxTrack;
}

export async function renameTrack(
  track: GpxTrack,
  newName: string,
  supabase: SupabaseClient = getAccountSupabaseClient(),
): Promise<GpxTrack> {
  const nameError = validateTrackName(newName);
  if (nameError) throw new AccountArchiveError('invalid_track_name', nameError);
  const { data, error } = await supabase.rpc('rename_my_gpx_track', {
    p_track_id: track.id,
    p_new_name: normalizeTrackName(newName),
  });
  if (error) throw toAccountError(error);
  if (!data) throw new AccountArchiveError('track_not_found', 'Traccia non trovata. Aggiorna l’archivio e riprova.');
  return data as GpxTrack;
}

export async function downloadTrack(
  track: GpxTrack,
  supabase: SupabaseClient = getAccountSupabaseClient(),
): Promise<Uint8Array> {
  let data: Blob | null = null;
  try {
    const result = await supabase.storage.from('user-gpx').download(track.storage_path);
    if (result.error) throw result.error;
    data = result.data;
  } catch (error) {
    reportAccountOperationFailure('gpx_download_request', error);
    throw toAccountError(error);
  }
  if (!data) throw new AccountArchiveError('unknown', 'Il file GPX non è disponibile. Aggiorna l’archivio e riprova.');
  try {
    return await readDownloadedBlob(data, track.compressed_size_bytes);
  } catch (error) {
    reportAccountOperationFailure('gpx_download_decode', error);
    throw error;
  }
}

export function readDownloadedBlob(blob: Blob, expectedBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
    throw new AccountArchiveError('unknown', 'La dimensione del GPX non è valida. Aggiorna l’archivio e riprova.');
  }
  if (blob.size !== expectedBytes) {
    throw new AccountArchiveError('unknown', 'Il GPX scaricato non corrisponde ai metadati dell’archivio.');
  }

  // React Native's native Blob does not reliably implement Blob.arrayBuffer()
  // in release builds. FileReader is backed by the native Blob manager and is
  // the supported conversion path on Android/iOS. The fallback is only for the
  // non-native test/web runtime.
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new AccountArchiveError(
        'unknown',
        'Il GPX scaricato non può essere letto su questo dispositivo.',
        { cause: reader.error },
      ));
      reader.onload = () => {
        if (!(reader.result instanceof ArrayBuffer) || reader.result.byteLength !== expectedBytes) {
          reject(new AccountArchiveError('unknown', 'Il GPX scaricato è incompleto. Riprova.'));
          return;
        }
        resolve(new Uint8Array(reader.result));
      };
      reader.readAsArrayBuffer(blob);
    });
  }

  return blob.arrayBuffer().then((buffer) => {
    if (buffer.byteLength !== expectedBytes) {
      throw new AccountArchiveError('unknown', 'Il GPX scaricato è incompleto. Riprova.');
    }
    return new Uint8Array(buffer);
  });
}

const DELETE_METADATA_DELAYS_MS = [0, 120, 300] as const;

function wait(delayMs: number): Promise<void> {
  return delayMs === 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isRetryableMetadataDeleteError(error: unknown): boolean {
  const normalized = toAccountError(error);
  const message = String((error as { message?: unknown } | null)?.message ?? '').toLowerCase();
  return normalized.code === 'network'
    || /delete the gpx storage object before its metadata/.test(message);
}

async function deleteMetadataWithRetry(trackId: string, supabase: SupabaseClient): Promise<void> {
  let lastError: unknown;
  for (const delayMs of DELETE_METADATA_DELAYS_MS) {
    await wait(delayMs);
    try {
      await deleteMetadata(trackId, supabase);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableMetadataDeleteError(error)) throw error;
    }
  }
  throw lastError;
}

export async function deleteTrack(
  track: GpxTrack,
  supabase: SupabaseClient = getAccountSupabaseClient(),
): Promise<void> {
  const { error: storageError } = await supabase.storage.from('user-gpx').remove([track.storage_path]);
  if (storageError && !isMissingStorageObject(storageError)) {
    reportAccountOperationFailure('gpx_delete_storage', storageError);
    throw toAccountError(storageError);
  }
  try {
    // The metadata RPC is idempotent. Retrying covers both a short Storage
    // visibility delay and an ambiguous native network response after the
    // server has already completed the first call.
    await deleteMetadataWithRetry(track.id, supabase);
  } catch (error) {
    reportAccountOperationFailure('gpx_delete_metadata', error);
    throw new AccountArchiveError(
      'partial_delete',
      'Il file è stato eliminato, ma la cancellazione dei metadati non è completa. Riprova per terminarla.',
      { cause: error, partial: true },
    );
  }
}

export async function listTrackMushroomMarkers(
  trackId: string,
  supabase: SupabaseClient = getAccountSupabaseClient(),
): Promise<GpxMushroomMarker[]> {
  const { data, error } = await supabase
    .from('user_gpx_mushroom_markers')
    .select(MUSHROOM_MARKER_COLUMNS)
    .eq('track_id', trackId)
    .order('track_point_index', { ascending: true });
  if (error) throw toAccountError(error);
  return (data ?? []) as unknown as GpxMushroomMarker[];
}

export async function setTrackTrim(
  trackId: string,
  trimStartPointIndex: number | null,
  trimEndPointIndex: number | null,
  supabase: SupabaseClient = getAccountSupabaseClient(),
): Promise<GpxTrack> {
  const { data, error } = await supabase.rpc('set_my_gpx_track_trim', {
    p_track_id: trackId,
    p_trim_start_point_index: trimStartPointIndex,
    p_trim_end_point_index: trimEndPointIndex,
  });
  if (error) throw toAccountError(error);
  if (!data) throw new AccountArchiveError('track_not_found', 'Traccia non trovata. Aggiorna l’archivio e riprova.');
  return data as GpxTrack;
}

export async function saveTrackMushroomMarker(
  trackId: string,
  point: GpxTrackPoint,
  species: MushroomSpecies,
  count: number,
  supabase: SupabaseClient = getAccountSupabaseClient(),
): Promise<GpxMushroomMarker> {
  if (!Number.isInteger(count) || count < 1 || count > 10000) {
    throw new AccountArchiveError('invalid_track_edit', 'Il numero di funghi deve essere compreso tra 1 e 10000.');
  }
  const { data, error } = await supabase.rpc('save_my_gpx_mushroom_marker', {
    p_track_id: trackId,
    p_track_point_index: point.pointIndex,
    p_latitude: point.latitude,
    p_longitude: point.longitude,
    p_species: species,
    p_count: count,
  });
  if (error) throw toAccountError(error);
  if (!data) throw new AccountArchiveError('unknown', 'Il marker non è stato salvato. Riprova.');
  return data as GpxMushroomMarker;
}

export async function deleteTrackMushroomMarker(
  trackId: string,
  trackPointIndex: number,
  species: MushroomSpecies,
  supabase: SupabaseClient = getAccountSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc('delete_my_gpx_mushroom_marker', {
    p_track_id: trackId,
    p_track_point_index: trackPointIndex,
    p_species: species,
  });
  if (error) throw toAccountError(error);
}
