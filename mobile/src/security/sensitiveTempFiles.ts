import * as FileSystem from 'expo-file-system/legacy';

export const SENSITIVE_TEMP_DIRECTORY = `${FileSystem.cacheDirectory}sensitive-temp/`;

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^\.+/, '').slice(0, 150) || 'temporary-file';
}

export async function createSensitiveTempFileUri(name: string): Promise<string> {
  await FileSystem.makeDirectoryAsync(SENSITIVE_TEMP_DIRECTORY, { intermediates: true });
  return `${SENSITIVE_TEMP_DIRECTORY}${Date.now()}-${safeName(name)}`;
}

export async function deleteSensitiveTempFile(uri: string | null | undefined): Promise<void> {
  if (!uri || !uri.startsWith(SENSITIVE_TEMP_DIRECTORY)) return;
  await FileSystem.deleteAsync(uri, { idempotent: true });
}

export async function purgeSensitiveTempFiles(): Promise<void> {
  await FileSystem.deleteAsync(SENSITIVE_TEMP_DIRECTORY, { idempotent: true });
}
