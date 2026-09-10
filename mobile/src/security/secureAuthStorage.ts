import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

const CHUNK_SIZE = 1800;
const META_SUFFIX = '.meta';
const CHUNK_SUFFIX = '.chunk.';

type ChunkMetadata = { chunks: number };

const options: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

function metaKey(key: string): string { return `${key}${META_SUFFIX}`; }
function chunkKey(key: string, index: number): string { return `${key}${CHUNK_SUFFIX}${index}`; }

async function readMetadata(key: string): Promise<ChunkMetadata | null> {
  const raw = await SecureStore.getItemAsync(metaKey(key), options);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ChunkMetadata>;
    return Number.isInteger(parsed.chunks) && Number(parsed.chunks) > 0
      ? { chunks: Number(parsed.chunks) }
      : null;
  } catch {
    return null;
  }
}

async function removeSecureValue(key: string): Promise<void> {
  const metadata = await readMetadata(key);
  if (metadata) {
    await Promise.all(Array.from({ length: metadata.chunks }, (_, index) => (
      SecureStore.deleteItemAsync(chunkKey(key, index), options)
    )));
  }
  await Promise.all([
    SecureStore.deleteItemAsync(key, options),
    SecureStore.deleteItemAsync(metaKey(key), options),
  ]);
}

async function setSecureValue(key: string, value: string): Promise<void> {
  await removeSecureValue(key);
  const chunks = Math.ceil(value.length / CHUNK_SIZE) || 1;
  for (let index = 0; index < chunks; index += 1) {
    await SecureStore.setItemAsync(
      chunkKey(key, index),
      value.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
      options,
    );
  }
  await SecureStore.setItemAsync(metaKey(key), JSON.stringify({ chunks }), options);
}

async function getSecureValue(key: string): Promise<string | null> {
  const metadata = await readMetadata(key);
  if (!metadata) return SecureStore.getItemAsync(key, options);
  const chunks = await Promise.all(Array.from({ length: metadata.chunks }, (_, index) => (
    SecureStore.getItemAsync(chunkKey(key, index), options)
  )));
  return chunks.some((chunk) => chunk === null) ? null : chunks.join('');
}

export const secureAuthStorage = {
  async getItem(key: string): Promise<string | null> {
    const secureValue = await getSecureValue(key);
    if (secureValue !== null) return secureValue;

    // Migrazione una tantum dalla persistenza non cifrata usata dalle release precedenti.
    const legacyValue = await AsyncStorage.getItem(key);
    if (legacyValue === null) return null;
    await setSecureValue(key, legacyValue);
    await AsyncStorage.removeItem(key);
    return legacyValue;
  },

  async setItem(key: string, value: string): Promise<void> {
    await setSecureValue(key, value);
    await AsyncStorage.removeItem(key);
  },

  async removeItem(key: string): Promise<void> {
    await Promise.all([removeSecureValue(key), AsyncStorage.removeItem(key)]);
  },
};
