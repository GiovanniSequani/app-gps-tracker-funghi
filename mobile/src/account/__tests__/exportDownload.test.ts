import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  written: vi.fn(),
  share: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'android', Version: 35 },
  AppState: {
    currentState: 'active',
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
}));
vi.mock('expo-file-system', () => ({
  File: class {
    uri: string;
    constructor(uri: string) { this.uri = uri; }
    create() { return undefined; }
    write(bytes: Uint8Array) { mocks.written(this.uri, bytes); }
  },
}));
vi.mock('expo-sharing', () => ({
  isAvailableAsync: vi.fn(async () => true),
  shareAsync: mocks.share,
}));
vi.mock('../../security/sensitiveTempFiles', () => ({
  createSensitiveTempFileUri: vi.fn(async () => 'cache://sensitive-temp/export.zip'),
  deleteSensitiveTempFile: mocks.remove,
}));
vi.mock('../../network/useNetworkAvailability', () => ({ useNetworkAvailability: () => true }));
vi.mock('../rightsClient', () => ({
  downloadAccountExport: vi.fn(),
  loadLatestAccountExport: vi.fn(),
  requestMyAccountDeletionVerification: vi.fn(),
  requestMyDataExport: vi.fn(),
}));

import { saveExportBlob } from '../useAccountRights';

const originalFileReader = globalThis.FileReader;

describe('download export Android', () => {
  beforeEach(() => {
    mocks.written.mockReset();
    mocks.share.mockReset().mockResolvedValue(undefined);
    mocks.remove.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: originalFileReader });
  });

  function installNativeReader(bytes: number[]) {
    class NativeFileReader {
      result: ArrayBuffer | string | null = null;
      error: Error | null = null;
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;
      readAsArrayBuffer() {
        this.result = new Uint8Array(bytes).buffer;
        this.onload?.();
      }
    }
    Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: NativeFileReader });
  }

  it('scrive e condivide lo ZIP senza Blob.arrayBuffer', async () => {
    installNativeReader([80, 75, 3, 4]);
    const arrayBuffer = vi.fn(() => { throw new TypeError('undefined is not a function'); });
    const blob = { size: 4, arrayBuffer } as unknown as Blob;

    await saveExportBlob(blob, 4);

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(mocks.written).toHaveBeenCalledWith(
      'cache://sensitive-temp/export.zip',
      new Uint8Array([80, 75, 3, 4]),
    );
    expect(mocks.share).toHaveBeenCalledOnce();
    expect(mocks.remove).toHaveBeenCalledWith('cache://sensitive-temp/export.zip');
  });

  it('rimuove il temporaneo se il foglio di condivisione fallisce o viene annullato', async () => {
    installNativeReader([80, 75, 3, 4]);
    mocks.share.mockRejectedValueOnce(new Error('share cancelled'));
    const blob = { size: 4 } as Blob;

    await expect(saveExportBlob(blob, 4)).rejects.toThrow('share cancelled');
    expect(mocks.remove).toHaveBeenCalledWith('cache://sensitive-temp/export.zip');
  });
});
