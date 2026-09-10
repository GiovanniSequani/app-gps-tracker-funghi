import { beforeEach, describe, expect, it, vi } from 'vitest';

const { files, deleteAsync } = vi.hoisted(() => {
  const state = new Set<string>();
  return { files: state, deleteAsync: vi.fn(async (uri: string) => { state.delete(uri); }) };
});
vi.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'cache://app/',
  makeDirectoryAsync: vi.fn(async () => undefined),
  deleteAsync,
}));

import { createSensitiveTempFileUri, deleteSensitiveTempFile, purgeSensitiveTempFiles, SENSITIVE_TEMP_DIRECTORY } from '../sensitiveTempFiles';

describe('file temporanei sensibili', () => {
  beforeEach(() => { files.clear(); deleteAsync.mockClear(); });

  it('usa una directory cache dedicata e nomi sanificati', async () => {
    const uri = await createSensitiveTempFileUri('../export privato.zip');
    expect(uri.startsWith(SENSITIVE_TEMP_DIRECTORY)).toBe(true);
    expect(uri).not.toContain('../');
  });

  it('elimina file dedicati e ignora percorsi esterni', async () => {
    const uri = await createSensitiveTempFileUri('track.gpx');
    await deleteSensitiveTempFile(uri);
    await deleteSensitiveTempFile('document://recording-recovery/draft.json');
    expect(deleteAsync).toHaveBeenCalledTimes(1);
  });

  it('purga la directory in modo idempotente', async () => {
    await purgeSensitiveTempFiles();
    expect(deleteAsync).toHaveBeenCalledWith(SENSITIVE_TEMP_DIRECTORY, { idempotent: true });
  });
});
