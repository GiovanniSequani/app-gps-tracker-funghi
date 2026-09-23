import { File } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { createSensitiveTempFileUri, deleteSensitiveTempFile } from '../security/sensitiveTempFiles';
import { AccountArchiveError } from './types';

export type ShareGpxDependencies = {
  createTempFile: (name: string) => Promise<string>;
  writeFile: (uri: string, bytes: Uint8Array) => void;
  isSharingAvailable: () => Promise<boolean>;
  shareFile: (uri: string, title: string) => Promise<void>;
  deleteTempFile: (uri: string | null) => Promise<void>;
};

const defaultDependencies: ShareGpxDependencies = {
  createTempFile: createSensitiveTempFileUri,
  writeFile: (uri, bytes) => {
    const file = new File(uri);
    try { file.create({ overwrite: true }); } catch { /* cache privata usa-e-getta */ }
    file.write(bytes);
  },
  isSharingAvailable: Sharing.isAvailableAsync,
  shareFile: (uri, title) => Sharing.shareAsync(uri, {
    mimeType: 'application/gpx+xml',
    dialogTitle: `Salva o condividi ${title}`,
  }),
  deleteTempFile: deleteSensitiveTempFile,
};

export async function shareDerivedGpx(
  file: { bytes: Uint8Array; filename: string },
  title: string,
  dependencies: ShareGpxDependencies = defaultDependencies,
): Promise<void> {
  let uri: string | null = null;
  try {
    uri = await dependencies.createTempFile(file.filename);
    dependencies.writeFile(uri, file.bytes);
    if (!await dependencies.isSharingAvailable()) {
      throw new AccountArchiveError(
        'unknown',
        'La condivisione file non è disponibile su questo dispositivo.',
      );
    }
    await dependencies.shareFile(uri, title);
  } finally {
    await dependencies.deleteTempFile(uri).catch(() => undefined);
  }
}
