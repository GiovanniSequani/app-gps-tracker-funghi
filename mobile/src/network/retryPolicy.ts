export type RetryableError = Error & { retryAfterMs?: number; status?: number };

export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - now);
}

export function createRetryableError(message: string, response: Response): RetryableError {
  const error = new Error(message) as RetryableError;
  error.status = response.status;
  error.retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'));
  return error;
}

export function retryAfterFromError(error: unknown): number | undefined {
  const value = (error as RetryableError | null)?.retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function backoffDelayMs(options: {
  attempt: number;
  baseMs: number;
  maxMs: number;
  retryAfterMs?: number;
  jitterRatio?: number;
  random?: () => number;
}): number {
  const exponential = Math.min(options.maxMs, options.baseMs * (2 ** Math.max(0, options.attempt)));
  const retryAfter = Math.min(options.maxMs, Math.max(0, options.retryAfterMs ?? 0));
  const base = Math.max(exponential, retryAfter);
  const ratio = options.jitterRatio ?? 0.2;
  const random = options.random ?? Math.random;
  const jitter = base * ratio * ((random() * 2) - 1);
  return Math.max(retryAfter, Math.max(0, Math.round(Math.min(options.maxMs, base + jitter))));
}
