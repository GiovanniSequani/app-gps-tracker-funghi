import { describe, expect, it, vi } from 'vitest';
import { assertSafeGpxImportSize, readPickedGpxSafely } from '../gpxImport';
import type { ArchiveConfig } from '../types';

const config: ArchiveConfig = {
  singleton_id: 1,
  max_tracks_per_user: 50,
  max_compressed_bytes: 10,
  max_uncompressed_bytes: 50,
  terms_version: '1.0',
  privacy_version: '1.0',
  research_consent_version: '1.0',
  updated_at: '2026-09-14T00:00:00Z',
};

function dependencies(bytes = new Uint8Array([1, 2, 3])) {
  return {
    stage: vi.fn(async () => 'cache://staged.gpx'),
    statSize: vi.fn(async () => bytes.byteLength),
    readBytes: vi.fn(async () => bytes),
    cleanup: vi.fn(async () => undefined),
  };
}

describe('GPX import size preflight', () => {
  it('rifiuta un GPX troppo grande prima di copiarlo o leggerlo', async () => {
    const deps = dependencies();
    await expect(readPickedGpxSafely(
      { uri: 'content://large', name: 'large.gpx', size: 51, mimeType: 'application/gpx+xml' },
      config,
      deps,
    )).rejects.toThrow(/limite/);
    expect(deps.stage).not.toHaveBeenCalled();
    expect(deps.readBytes).not.toHaveBeenCalled();
  });

  it('applica il limite compresso a .gpx.gz e ai MIME gzip', () => {
    expect(() => assertSafeGpxImportSize(
      { uri: 'content://gzip', name: 'track.gpx.gz', size: 11 },
      config,
    )).toThrow(/limite/);
    expect(() => assertSafeGpxImportSize(
      { uri: 'content://gzip', name: 'track.gpx', mimeType: 'application/gzip', size: 11 },
      config,
    )).toThrow(/limite/);
  });

  it('fallisce chiuso se il provider non espone una dimensione attendibile', async () => {
    const deps = dependencies();
    await expect(readPickedGpxSafely(
      { uri: 'content://unknown', name: 'track.gpx' },
      config,
      deps,
    )).rejects.toThrow(/verificare/);
    expect(deps.stage).not.toHaveBeenCalled();
  });

  it('ricontrolla lo staging prima della lettura e pulisce sempre il temporaneo', async () => {
    const deps = dependencies(new Uint8Array(3));
    deps.statSize.mockResolvedValueOnce(51);
    await expect(readPickedGpxSafely(
      { uri: 'content://changed', name: 'track.gpx', size: 3 },
      config,
      deps,
    )).rejects.toThrow(/limite/);
    expect(deps.readBytes).not.toHaveBeenCalled();
    expect(deps.cleanup).toHaveBeenCalledWith('cache://staged.gpx');
  });

  it('mantiene invariato l import normale entro i limiti', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const deps = dependencies(bytes);
    await expect(readPickedGpxSafely(
      { uri: 'content://normal', name: 'track.gpx', size: bytes.byteLength },
      config,
      deps,
    )).resolves.toEqual(bytes);
    expect(deps.stage).toHaveBeenCalledOnce();
    expect(deps.readBytes).toHaveBeenCalledOnce();
    expect(deps.cleanup).toHaveBeenCalledOnce();
  });
});
