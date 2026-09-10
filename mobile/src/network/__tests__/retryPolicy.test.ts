import { describe, expect, it } from 'vitest';
import { backoffDelayMs, parseRetryAfterMs } from '../retryPolicy';

describe('retry policy', () => {
  it('decodifica Retry-After in secondi o data HTTP', () => {
    expect(parseRetryAfterMs('12', 0)).toBe(12_000);
    expect(parseRetryAfterMs('Thu, 01 Jan 1970 00:00:20 GMT', 5_000)).toBe(15_000);
    expect(parseRetryAfterMs('invalid')).toBeUndefined();
  });

  it('applica backoff esponenziale, jitter controllato e tetto', () => {
    expect(backoffDelayMs({ attempt: 0, baseMs: 1_000, maxMs: 8_000, jitterRatio: 0, random: () => 0.5 })).toBe(1_000);
    expect(backoffDelayMs({ attempt: 3, baseMs: 1_000, maxMs: 8_000, jitterRatio: 0, random: () => 0.5 })).toBe(8_000);
    expect(backoffDelayMs({ attempt: 8, baseMs: 1_000, maxMs: 8_000, retryAfterMs: 30_000, jitterRatio: 0 })).toBe(8_000);
    expect(backoffDelayMs({ attempt: 1, baseMs: 1_000, maxMs: 8_000, jitterRatio: 0.2, random: () => 1 })).toBe(2_400);
    expect(backoffDelayMs({ attempt: 0, baseMs: 1_000, maxMs: 8_000, retryAfterMs: 5_000, jitterRatio: 0.2, random: () => 0 })).toBe(5_000);
  });
});
