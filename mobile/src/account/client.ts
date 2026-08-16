import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { getAccountSupabaseClient } from './supabase';
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

export async function signUp(
  input: { email: string; password: string; username: string },
  supabase: SupabaseClient = getAccountSupabaseClient(),
): Promise<{ session: Session | null }> {
  const { data, error } = await supabase.auth.signUp({
    email: input.email.trim(),
    password: input.password,
    options: {
      data: {
        username: normalizeUsername(input.username),
        terms_accepted: true,
        privacy_accepted: true,
        raw_gpx_research_consent: true,
      },
    },
  });
  if (error) throw toAccountError(error);
  return { session: data.session };
}

export async function signOut(): Promise<void> {
  const { error } = await getAccountSupabaseClient().auth.signOut();
  if (error) throw toAccountError(error);
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

export async function createTrackDownloadUrl(
  track: GpxTrack,
  supabase: SupabaseClient = getAccountSupabaseClient(),
): Promise<string> {
  const { data, error } = await supabase.storage.from('user-gpx').createSignedUrl(track.storage_path, 60);
  if (error) throw toAccountError(error);
  if (!data?.signedUrl) throw new AccountArchiveError('unknown', 'URL temporaneo della traccia non disponibile.');
  return data.signedUrl;
}

export async function deleteTrack(
  track: GpxTrack,
  supabase: SupabaseClient = getAccountSupabaseClient(),
): Promise<void> {
  const { error: storageError } = await supabase.storage.from('user-gpx').remove([track.storage_path]);
  if (storageError && !isMissingStorageObject(storageError)) throw toAccountError(storageError);
  try {
    await deleteMetadata(track.id, supabase);
  } catch (error) {
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
