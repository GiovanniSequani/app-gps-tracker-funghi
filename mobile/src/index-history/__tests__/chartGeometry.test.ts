import { describe, expect, it } from 'vitest';
import { indexHistoryIndexForX, indexHistoryTickIndices } from '../chartGeometry';

describe('index-history chart geometry', () => {
  it('usa pochi tick leggibili su uno schermo compatto', () => {
    expect(indexHistoryTickIndices(28, 236)).toEqual([0, 9, 18, 27]);
  });

  it('distribuisce fino a cinque tick senza perdere gli estremi', () => {
    expect(indexHistoryTickIndices(28, 315)).toEqual([0, 7, 14, 20, 27]);
    expect(indexHistoryTickIndices(1, 315)).toEqual([0]);
    expect(indexHistoryTickIndices(0, 315)).toEqual([]);
  });

  it('segue anche salti rapidi del dito e limita la selezione ai bordi', () => {
    expect(indexHistoryIndexForX(0, 28, 315)).toBe(0);
    expect(indexHistoryIndexForX(315, 28, 315)).toBe(27);
    expect(indexHistoryIndexForX(1000, 28, 315)).toBe(27);
    expect(indexHistoryIndexForX(-100, 28, 315)).toBe(0);
  });
});
