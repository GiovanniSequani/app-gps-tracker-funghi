import { beforeEach, describe, expect, it, vi } from 'vitest';

const secure = new Map<string, string>();
const legacy = new Map<string, string>();

vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
  getItemAsync: vi.fn(async (key: string) => secure.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => { secure.set(key, value); }),
  deleteItemAsync: vi.fn(async (key: string) => { secure.delete(key); }),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => legacy.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { legacy.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { legacy.delete(key); }),
  },
}));

import { secureAuthStorage } from '../secureAuthStorage';

describe('secure Auth storage', () => {
  beforeEach(() => { secure.clear(); legacy.clear(); });

  it('salva e ricompone sessioni grandi in SecureStore', async () => {
    const session = 'x'.repeat(5_500);
    await secureAuthStorage.setItem('auth', session);
    await expect(secureAuthStorage.getItem('auth')).resolves.toBe(session);
    expect(legacy.has('auth')).toBe(false);
    expect([...secure.keys()].filter((key) => key.includes('.chunk.')).length).toBeGreaterThan(1);
  });

  it('migra una sessione legacy e la elimina da AsyncStorage', async () => {
    legacy.set('auth', 'legacy-session');
    await expect(secureAuthStorage.getItem('auth')).resolves.toBe('legacy-session');
    expect(legacy.has('auth')).toBe(false);
    await expect(secureAuthStorage.getItem('auth')).resolves.toBe('legacy-session');
  });

  it('rimuove sia copia sicura sia eventuale copia legacy', async () => {
    await secureAuthStorage.setItem('auth', 'session');
    legacy.set('auth', 'old');
    await secureAuthStorage.removeItem('auth');
    await expect(secureAuthStorage.getItem('auth')).resolves.toBeNull();
  });
});
