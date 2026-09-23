import { afterEach, describe, expect, it, vi } from 'vitest';
import { readNativeBlob, type NativeBlobReadErrors } from '../nativeBlob';

const errors: NativeBlobReadErrors = {
  invalidExpectedSize: 'invalid size',
  sizeMismatch: 'size mismatch',
  unreadable: 'unreadable',
  incomplete: 'incomplete',
};

const originalFileReader = globalThis.FileReader;

afterEach(() => {
  Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: originalFileReader });
});

describe('readNativeBlob', () => {
  it('usa FileReader sul Blob Android senza invocare arrayBuffer', async () => {
    const arrayBuffer = vi.fn(() => { throw new TypeError('undefined is not a function'); });
    const nativeBlob = { size: 4, arrayBuffer } as unknown as Blob;
    class AndroidFileReader {
      result: ArrayBuffer | string | null = null;
      error: Error | null = null;
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;
      readAsArrayBuffer() {
        this.result = new Uint8Array([80, 75, 3, 4]).buffer;
        this.onload?.();
      }
    }
    Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: AndroidFileReader });

    await expect(readNativeBlob(nativeBlob, 4, errors)).resolves.toEqual(new Uint8Array([80, 75, 3, 4]));
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('rifiuta dimensioni mancanti o discordanti prima della lettura', () => {
    const blob = new Blob(['zip']);
    expect(() => readNativeBlob(blob, 0, errors)).toThrow('invalid size');
    expect(() => readNativeBlob(blob, blob.size + 1, errors)).toThrow('size mismatch');
  });

  it('rifiuta una lettura nativa incompleta', async () => {
    const nativeBlob = { size: 4 } as Blob;
    class IncompleteFileReader {
      result: ArrayBuffer | string | null = null;
      error: Error | null = null;
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;
      readAsArrayBuffer() {
        this.result = new Uint8Array([80, 75]).buffer;
        this.onload?.();
      }
    }
    Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: IncompleteFileReader });
    await expect(readNativeBlob(nativeBlob, 4, errors)).rejects.toThrow('incomplete');
  });
});
