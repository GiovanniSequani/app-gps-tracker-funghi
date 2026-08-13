import { describe, expect, it, vi } from 'vitest';
import { saveRecordingCloudFirst, type RecordedRoute } from '../recordingSave';
import type { GpxTrack } from '../types';

const route: RecordedRoute = {
  routeId: 'local-id', name: 'Bosco', date: '2026-08-08T08:00:00Z',
  path: [{ latitude: 45, longitude: 10, timestamp: 1 }], markers: [],
};
const track = { id: 'cloud-id', status: 'ready' } as GpxTrack;

describe('salvataggio registrazione cloud-first', () => {
  it('non scrive in locale quando il cloud riesce', async () => {
    const upload = vi.fn().mockResolvedValue(track);
    const saveLocal = vi.fn();
    await expect(saveRecordingCloudFirst(route, true, { upload, saveLocal }))
      .resolves.toMatchObject({ location: 'cloud', track });
    expect(upload).toHaveBeenCalledOnce();
    expect(saveLocal).not.toHaveBeenCalled();
  });

  it('salva in locale se il cloud fallisce', async () => {
    const failure = new Error('offline');
    const saveLocal = vi.fn().mockResolvedValue(undefined);
    await expect(saveRecordingCloudFirst(route, true, {
      upload: vi.fn().mockRejectedValue(failure), saveLocal,
    })).resolves.toEqual({ location: 'local', cloudError: failure });
    expect(saveLocal).toHaveBeenCalledWith(route);
  });

  it('senza account usa direttamente il fallback locale', async () => {
    const upload = vi.fn();
    const saveLocal = vi.fn().mockResolvedValue(undefined);
    await expect(saveRecordingCloudFirst(route, false, { upload, saveLocal }))
      .resolves.toEqual({ location: 'local', cloudError: undefined });
    expect(upload).not.toHaveBeenCalled();
    expect(saveLocal).toHaveBeenCalledOnce();
  });
});
