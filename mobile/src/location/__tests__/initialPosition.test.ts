import { describe, expect, it } from 'vitest';
import {
  isApproximatePosition,
  isUsableProvisionalPosition,
  PROVISIONAL_POSITION_MAX_AGE_MS,
} from '../initialPosition';

const NOW = 2_000_000;

function sample(ageMs: number, accuracy: number | null) {
  return {
    timestamp: NOW - ageMs,
    coords: { latitude: 46.07, longitude: 11.12, accuracy },
  };
}

describe('initial position', () => {
  it('accepts a recent last-known fix only as a provisional position', () => {
    const recent = sample(60_000, 35);
    expect(isUsableProvisionalPosition(recent, NOW)).toBe(true);
    expect(isApproximatePosition(recent, true)).toBe(true);
  });

  it('rejects stale or excessively imprecise last-known fixes', () => {
    expect(isUsableProvisionalPosition(sample(PROVISIONAL_POSITION_MAX_AGE_MS + 1, 20), NOW)).toBe(false);
    expect(isUsableProvisionalPosition(sample(1_000, 900), NOW)).toBe(false);
  });

  it('marks a fresh low-accuracy fix as approximate', () => {
    expect(isApproximatePosition(sample(1_000, 160))).toBe(true);
    expect(isApproximatePosition(sample(1_000, 25))).toBe(false);
  });
});
