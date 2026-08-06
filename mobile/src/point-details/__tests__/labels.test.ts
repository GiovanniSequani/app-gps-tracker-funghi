import { describe, expect, it } from 'vitest';
import {
  aspectDegreesToDirection,
  formatAspect,
  tpiCategoryLabel,
} from '../labels';

describe('aspect direction mapping', () => {
  it.each([
    [0, 'N'],
    [42, 'NE'],
    [90, 'E'],
    [135, 'SE'],
    [180, 'S'],
    [225, 'SO'],
    [270, 'O'],
    [315, 'NO'],
    [359, 'N'],
  ])('maps %s degrees to %s', (degrees, direction) => {
    expect(aspectDegreesToDirection(degrees)).toBe(direction);
  });

  it('shows direction and rounded degrees together', () => {
    expect(formatAspect(42.4)).toBe('NE · 42°');
    expect(formatAspect(null)).toBe('N/D');
  });
});

describe('TPI labels', () => {
  it.each([
    [1, 'Sottoelevato'],
    [2, 'In media'],
    [3, 'Sopraelevato'],
    [0, 'Non disponibile'],
    [99, 'Non disponibile'],
  ])('maps category %s', (category, label) => {
    expect(tpiCategoryLabel(category)).toBe(label);
  });
});

