import { AccountArchiveError } from './types';

export type NativeBlobReadErrors = {
  invalidExpectedSize: string;
  sizeMismatch: string;
  unreadable: string;
  incomplete: string;
};

export function readNativeBlob(
  blob: Blob,
  expectedBytes: number,
  errors: NativeBlobReadErrors,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
    throw new AccountArchiveError('unknown', errors.invalidExpectedSize);
  }
  if (blob.size !== expectedBytes) {
    throw new AccountArchiveError('unknown', errors.sizeMismatch);
  }

  // Blob.arrayBuffer() non e' disponibile in modo affidabile nelle build
  // React Native release. FileReader usa il Blob manager nativo Android/iOS.
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new AccountArchiveError(
        'unknown',
        errors.unreadable,
        { cause: reader.error },
      ));
      reader.onload = () => {
        if (!(reader.result instanceof ArrayBuffer) || reader.result.byteLength !== expectedBytes) {
          reject(new AccountArchiveError('unknown', errors.incomplete));
          return;
        }
        resolve(new Uint8Array(reader.result));
      };
      reader.readAsArrayBuffer(blob);
    });
  }

  // Fallback per runtime non nativi, inclusi i test Node.
  if (typeof blob.arrayBuffer !== 'function') {
    return Promise.reject(new AccountArchiveError('unknown', errors.unreadable));
  }
  return blob.arrayBuffer().then((buffer) => {
    if (buffer.byteLength !== expectedBytes) {
      throw new AccountArchiveError('unknown', errors.incomplete);
    }
    return new Uint8Array(buffer);
  });
}
