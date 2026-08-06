import { PointDataError } from './errors';

declare const process: {
  env: {
    EXPO_PUBLIC_SUPABASE_URL?: string;
    EXPO_PUBLIC_SUPABASE_ANON_KEY?: string;
  };
};

type PublicSupabaseConfig = {
  url: string;
  anonKey: string;
};

let cachedConfig: PublicSupabaseConfig | null = null;

export function getPublicSupabaseConfig(): PublicSupabaseConfig {
  if (cachedConfig) return cachedConfig;

  const url = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim().replace(/\/+$/, '');
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !/^https:\/\/[a-z0-9]+\.supabase\.co$/i.test(url) || !anonKey) {
    throw new PointDataError(
      'configuration',
      'EXPO_PUBLIC Supabase configuration is missing or invalid',
    );
  }
  cachedConfig = { url, anonKey };
  return cachedConfig;
}

function publicHeaders(): Record<string, string> {
  const { anonKey } = getPublicSupabaseConfig();
  return {
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
  };
}

async function fetchPublic(
  url: string,
  signal?: AbortSignal,
): Promise<Response> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: publicHeaders(),
      signal,
    });
    if (!response.ok) {
      throw new PointDataError(
        'http',
        `Public Supabase request failed with ${response.status}`,
        response.status,
      );
    }
    return response;
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw new PointDataError('aborted', 'Request aborted');
    }
    if (error instanceof PointDataError) throw error;
    throw new PointDataError('network', 'Public Supabase network request failed');
  }
}

export async function fetchRestRows<T>(
  table: string,
  query: Record<string, string>,
  signal?: AbortSignal,
): Promise<T[]> {
  const { url } = getPublicSupabaseConfig();
  const params = new URLSearchParams(query);
  const response = await fetchPublic(
    `${url}/rest/v1/${table}?${params.toString()}`,
    signal,
  );
  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) {
    throw new PointDataError('contract', `${table} response is not an array`);
  }
  return payload as T[];
}

function encodeObjectPath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function publicStorageObjectUrl(bucket: string, path: string): string {
  const { url } = getPublicSupabaseConfig();
  return `${url}/storage/v1/object/public/${encodeURIComponent(bucket)}/${encodeObjectPath(path)}`;
}

export async function fetchStorageJson<T>(
  bucket: string,
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetchPublic(publicStorageObjectUrl(bucket, path), signal);
  return (await response.json()) as T;
}

export async function fetchStorageBuffer(
  bucket: string,
  path: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await fetchPublic(publicStorageObjectUrl(bucket, path), signal);
  return response.arrayBuffer();
}
