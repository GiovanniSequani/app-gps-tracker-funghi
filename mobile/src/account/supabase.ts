import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Constants from 'expo-constants';
import { AccountArchiveError } from './types';

declare const process: {
  env?: {
    EXPO_PUBLIC_SUPABASE_URL?: string;
    EXPO_PUBLIC_SUPABASE_ANON_KEY?: string;
  };
};

let accountClient: SupabaseClient | null = null;

export function getAccountSupabaseConfig(): { url: string; anonKey: string } {
  const url = (
    process.env?.EXPO_PUBLIC_SUPABASE_URL
    ?? Constants.expoConfig?.extra?.supabaseUrl
    ?? ''
  ).trim().replace(/\/+$/, '');
  const anonKey = (
    process.env?.EXPO_PUBLIC_SUPABASE_ANON_KEY
    ?? Constants.expoConfig?.extra?.supabaseAnonKey
    ?? ''
  ).trim();
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/i.test(url) || !anonKey) {
    throw new AccountArchiveError(
      'configuration',
      'Configurazione Supabase pubblica non disponibile.',
    );
  }
  return { url, anonKey };
}

export function getAccountSupabaseClient(): SupabaseClient {
  if (accountClient) return accountClient;
  const { url, anonKey } = getAccountSupabaseConfig();
  accountClient = createClient(url, anonKey, {
    auth: {
      storage: AsyncStorage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  return accountClient;
}

export function resetAccountSupabaseClientForTests(): void {
  accountClient = null;
}
