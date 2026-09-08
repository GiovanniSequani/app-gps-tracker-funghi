import { describe, expect, it, vi } from 'vitest';

vi.mock('../supabase', () => ({ getAccountSupabaseClient: vi.fn() }));

import {
  createTrackDownloadUrl,
  deleteTrack,
  deleteTrackMushroomMarker,
  listTrackMushroomMarkers,
  loadArchiveData,
  renameTrack,
  requestPasswordRecovery,
  saveTrackMushroomMarker,
  setTrackTrim,
  signUp,
  updateRecoveredPassword,
  uploadPreparedTrack,
  verifyAuthCallback,
} from '../client';
import type { GpxTrack, PreparedGpxUpload } from '../types';

const prepared: PreparedGpxUpload = {
  bytes: new Uint8Array([31, 139, 8, 0]),
  compressedSizeBytes: 4,
  contentSha256: 'a'.repeat(64),
  uncompressedSizeBytes: 20,
  startedAt: '2026-08-08T08:00:00Z',
  endedAt: '2026-08-08T09:00:00Z',
  pointCount: 2,
  distanceM: 123,
  bbox: { west: 10, south: 45, east: 10.1, north: 45.1 },
};

const readyTrack: GpxTrack = {
  id: 'track-id',
  storage_path: 'user-id/track-id.gpx.gz',
  status: 'ready',
  display_name: 'Bosco',
  original_filename: 'Bosco.gpx',
  compressed_size_bytes: 4,
  uncompressed_size_bytes: 20,
  started_at: null,
  ended_at: null,
  point_count: 2,
  distance_m: 123,
  ready_at: '2026-08-08T09:01:00Z',
  created_at: '2026-08-08T09:00:00Z',
  trim_start_point_index: null,
  trim_end_point_index: null,
};

describe('account archive client', () => {
  it('blocca la registrazione se il contratto lifecycle non è verificabile', async () => {
    await expect(signUp({
      email: 'mario@example.test', password: 'password', username: 'Mario_Rossi',
      lifecycleConfig: { api_available: false, lifecycle_enabled: false, current_terms_version: null, current_privacy_version: null, reaccept_days: 365 },
    }, { auth: { signUp: vi.fn() } } as never)).rejects.toMatchObject({ code: 'lifecycle_unavailable' });
  });

  it('registra le versioni lifecycle correnti con source mobile', async () => {
    const signUpMock = vi.fn().mockResolvedValue({ data: { session: null }, error: null });
    await signUp({
      email: 'mario@example.test', password: 'password', username: 'Mario_Rossi',
      lifecycleConfig: { api_available: true, lifecycle_enabled: true, current_terms_version: '1.0', current_privacy_version: '1.0', reaccept_days: 365 },
    }, { auth: { signUp: signUpMock } } as never);
    expect(signUpMock).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({ data: {
      username: 'mario_rossi', terms_accepted: true, privacy_acknowledged: true,
      terms_version: '1.0', privacy_version: '1.0', terms_acceptance_source: 'mobile',
    } }) }));
  });

  it('usa il redirect esplicito e non enumerativo per il recupero password', async () => {
    const resetPasswordForEmail = vi.fn().mockResolvedValue({ data: {}, error: null });
    await requestPasswordRecovery('  mario@example.test  ', {
      auth: { resetPasswordForEmail },
    } as never);
    expect(resetPasswordForEmail).toHaveBeenCalledWith('mario@example.test', {
      redirectTo: 'funghitracker://auth/recovery',
    });

    await expect(requestPasswordRecovery('mario@example.test', {
      auth: { resetPasswordForEmail: vi.fn().mockResolvedValue({ data: {}, error: new Error('User not found: mario@example.test') }) },
    } as never)).rejects.toMatchObject({
      message: 'Non è stato possibile inviare il messaggio. Attendi e riprova.',
    });
  });

  it('verifica il token solo con type validato e conclude il recovery con updateUser', async () => {
    const verifyOtp = vi.fn().mockResolvedValue({ data: {}, error: null });
    const updateUser = vi.fn().mockResolvedValue({ data: {}, error: null });
    const supabase = { auth: { verifyOtp, updateUser } } as never;
    await verifyAuthCallback({ kind: 'recovery', type: 'recovery', tokenHash: 'a'.repeat(32) }, supabase);
    await updateRecoveredPassword('nuova-password-sicura', supabase);
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'a'.repeat(32), type: 'recovery' });
    expect(updateUser).toHaveBeenCalledWith({ password: 'nuova-password-sicura' });
  });

  it('inoltra type signup e gestisce token scaduto, invalido o già usato senza esporlo', async () => {
    const verifyOtp = vi.fn()
      .mockResolvedValueOnce({ data: {}, error: null })
      .mockResolvedValueOnce({ data: null, error: new Error('otp_expired: token already used') });
    const supabase = { auth: { verifyOtp } } as never;
    await verifyAuthCallback({ kind: 'confirm', type: 'signup', tokenHash: 'token-signup' }, supabase);
    expect(verifyOtp).toHaveBeenNthCalledWith(1, {
      token_hash: 'token-signup',
      type: 'signup',
    });
    await expect(verifyAuthCallback({ kind: 'confirm', type: 'email', tokenHash: 'token-da-non-mostrare' }, supabase))
      .rejects.toMatchObject({
        message: 'Il link non è valido, è scaduto o è già stato usato. Richiedine uno nuovo.',
      });
  });

  it('rispetta reserve, upload non-upsert e finalize in ordine', async () => {
    const events: string[] = [];
    const rpc = vi.fn(async (name: string) => {
      events.push(name);
      if (name === 'reserve_my_gpx_track') return { data: { id: 'track-id', storage_path: readyTrack.storage_path, status: 'pending_upload', max_tracks_per_user: 50, remaining_slots: 49 }, error: null };
      return { data: readyTrack, error: null };
    });
    const upload = vi.fn(async (_path, _body, options) => { events.push('storage_upload'); return { error: null, options }; });
    const result = await uploadPreparedTrack({ displayName: 'Bosco', prepared }, {
      rpc,
      storage: { from: () => ({ upload, remove: vi.fn() }) },
    } as never);
    expect(events).toEqual(['reserve_my_gpx_track', 'storage_upload', 'finalize_my_gpx_track']);
    expect(upload).toHaveBeenCalledWith(readyTrack.storage_path, expect.any(ArrayBuffer), {
      contentType: 'application/gzip', upsert: false,
    });
    expect(result.status).toBe('ready');
  });

  it('usa nel reserve il nome scelto e normalizzato dall’utente', async () => {
    const rpc = vi.fn(async (name: string) => name === 'reserve_my_gpx_track'
      ? { data: { id: 'track-id', storage_path: readyTrack.storage_path }, error: null }
      : { data: readyTrack, error: null });
    await uploadPreparedTrack({ displayName: '  Bosco serale  ', prepared }, {
      rpc,
      storage: { from: () => ({ upload: vi.fn().mockResolvedValue({ error: null }) }) },
    } as never);
    expect(rpc).toHaveBeenCalledWith('reserve_my_gpx_track', expect.objectContaining({
      p_display_name: 'Bosco serale',
      p_original_filename: 'Bosco serale.gpx',
    }));
  });

  it('rifiuta un nome non valido prima di prenotare quota', async () => {
    const rpc = vi.fn();
    await expect(uploadPreparedTrack({ displayName: 'cartella/bosco', prepared }, { rpc } as never))
      .rejects.toMatchObject({ code: 'invalid_track_name' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('libera la prenotazione se upload Storage fallisce', async () => {
    const remove = vi.fn().mockResolvedValue({ error: null });
    const rpc = vi.fn(async (name: string) => name === 'reserve_my_gpx_track'
      ? { data: { id: 'track-id', storage_path: readyTrack.storage_path, status: 'pending_upload', max_tracks_per_user: 50, remaining_slots: 49 }, error: null }
      : { data: null, error: null });
    await expect(uploadPreparedTrack({ displayName: 'Bosco', prepared }, {
      rpc,
      storage: { from: () => ({ upload: vi.fn().mockResolvedValue({ error: new Error('upload failed') }), remove }) },
    } as never)).rejects.toMatchObject({ code: 'upload_failed', partial: false });
    expect(remove).toHaveBeenCalledWith([readyTrack.storage_path]);
    expect(rpc).toHaveBeenLastCalledWith('delete_my_gpx_track_metadata', { p_track_id: 'track-id' });
  });

  it('rimuove oggetto e prenotazione se finalize fallisce', async () => {
    const events: string[] = [];
    const rpc = vi.fn(async (name: string) => {
      events.push(name);
      if (name === 'reserve_my_gpx_track') return { data: { id: 'track-id', storage_path: readyTrack.storage_path, status: 'pending_upload', max_tracks_per_user: 50, remaining_slots: 49 }, error: null };
      if (name === 'finalize_my_gpx_track') return { data: null, error: new Error('finalize failed') };
      return { data: null, error: null };
    });
    const storage = {
      upload: vi.fn(async () => { events.push('storage_upload'); return { error: null }; }),
      remove: vi.fn(async () => { events.push('storage_remove'); return { error: null }; }),
    };
    await expect(uploadPreparedTrack({ displayName: 'Bosco', prepared }, {
      rpc, storage: { from: () => storage },
    } as never)).rejects.toMatchObject({ code: 'finalize_failed', partial: false });
    expect(events).toEqual([
      'reserve_my_gpx_track', 'storage_upload', 'finalize_my_gpx_track',
      'storage_remove', 'delete_my_gpx_track_metadata',
    ]);
  });

  it('lista esclusivamente le tracce ready in ordine decrescente', async () => {
    const eq = vi.fn().mockReturnValue({ order: vi.fn().mockResolvedValue({ data: [readyTrack], error: null }) });
    const from = vi.fn((table: string) => {
      if (table === 'gpx_archive_config') return { select: () => ({ eq: () => ({ single: vi.fn().mockResolvedValue({ data: { singleton_id: 1 }, error: null }) }) }) };
      if (table === 'user_profiles') return { select: () => ({ single: vi.fn().mockResolvedValue({ data: { username: 'mario' }, error: null }) }) };
      return { select: () => ({ eq }) };
    });
    const result = await loadArchiveData({ from } as never);
    expect(eq).toHaveBeenCalledWith('status', 'ready');
    expect(result.tracks).toEqual([readyTrack]);
  });

  it('cancella prima Storage e poi i metadati', async () => {
    const events: string[] = [];
    const remove = vi.fn(async () => { events.push('storage'); return { error: null }; });
    const rpc = vi.fn(async () => { events.push('metadata'); return { error: null }; });
    await deleteTrack(readyTrack, { storage: { from: () => ({ remove }) }, rpc } as never);
    expect(events).toEqual(['storage', 'metadata']);
  });

  it('rinomina solo i metadati tramite RPC e conserva il path Storage', async () => {
    const renamed = { ...readyTrack, display_name: 'Bosco serale' };
    const rpc = vi.fn().mockResolvedValue({ data: renamed, error: null });
    const result = await renameTrack(readyTrack, '  Bosco serale  ', { rpc } as never);
    expect(rpc).toHaveBeenCalledWith('rename_my_gpx_track', {
      p_track_id: readyTrack.id,
      p_new_name: 'Bosco serale',
    });
    expect(result.display_name).toBe('Bosco serale');
    expect(result.storage_path).toBe(readyTrack.storage_path);
  });

  it('crea un URL firmato breve per scaricare dal bucket privato', async () => {
    const createSignedUrl = vi.fn().mockResolvedValue({ data: { signedUrl: 'https://signed.example/track' }, error: null });
    const result = await createTrackDownloadUrl(readyTrack, {
      storage: { from: () => ({ createSignedUrl }) },
    } as never);
    expect(createSignedUrl).toHaveBeenCalledWith(readyTrack.storage_path, 60);
    expect(result).toBe('https://signed.example/track');
  });

  it('salva il trim inclusivo tramite la RPC prevista', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { ...readyTrack, trim_start_point_index: 1, trim_end_point_index: 8 },
      error: null,
    });
    await setTrackTrim(readyTrack.id, 1, 8, { rpc } as never);
    expect(rpc).toHaveBeenCalledWith('set_my_gpx_track_trim', {
      p_track_id: readyTrack.id,
      p_trim_start_point_index: 1,
      p_trim_end_point_index: 8,
    });
  });

  it('salva count maggiore di uno sul vero indice e sulle coordinate GPX', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: 'marker-id', count: 7 }, error: null });
    await saveTrackMushroomMarker(readyTrack.id, {
      pointIndex: 42,
      latitude: 45.123,
      longitude: 10.456,
    }, 'finferli', 7, { rpc } as never);
    expect(rpc).toHaveBeenCalledWith('save_my_gpx_mushroom_marker', {
      p_track_id: readyTrack.id,
      p_track_point_index: 42,
      p_latitude: 45.123,
      p_longitude: 10.456,
      p_species: 'finferli',
      p_count: 7,
    });
  });

  it('lista e rimuove i marker soltanto attraverso contratto pubblico e RPC', async () => {
    const order = vi.fn().mockResolvedValue({ data: [{ id: 'm1', track_point_index: 2, species: 'porcini', count: 3 }], error: null });
    const eq = vi.fn().mockReturnValue({ order });
    const from = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ eq }) });
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const markers = await listTrackMushroomMarkers(readyTrack.id, { from } as never);
    await deleteTrackMushroomMarker(readyTrack.id, 2, 'porcini', { rpc } as never);
    expect(from).toHaveBeenCalledWith('user_gpx_mushroom_markers');
    expect(eq).toHaveBeenCalledWith('track_id', readyTrack.id);
    expect(order).toHaveBeenCalledWith('track_point_index', { ascending: true });
    expect(markers[0].count).toBe(3);
    expect(rpc).toHaveBeenCalledWith('delete_my_gpx_mushroom_marker', {
      p_track_id: readyTrack.id,
      p_track_point_index: 2,
      p_species: 'porcini',
    });
  });
});
