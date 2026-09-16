import { toAccountError } from './validation';

export type AccountOperation =
  | 'gpx_download_request'
  | 'gpx_download_decode'
  | 'gpx_delete_storage'
  | 'gpx_delete_metadata';

type ErrorShape = {
  name?: unknown;
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
};

function safeToken(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !/^[a-z0-9_-]{1,40}$/i.test(value)) return undefined;
  return value;
}

/**
 * Emits only bounded technical categories. Never include the original message,
 * request URL, account identity, object path, coordinates or GPX contents.
 */
export function reportAccountOperationFailure(operation: AccountOperation, error: unknown): void {
  const shape = (error ?? {}) as ErrorShape;
  const normalized = toAccountError(error);
  const diagnostic = {
    operation,
    category: normalized.code,
    errorType: safeToken(shape.name),
    status: safeToken(shape.status),
    statusCode: safeToken(shape.statusCode),
    providerCode: safeToken(shape.code),
  };
  console.warn('[FunghiTracker account operation]', diagnostic);
}
