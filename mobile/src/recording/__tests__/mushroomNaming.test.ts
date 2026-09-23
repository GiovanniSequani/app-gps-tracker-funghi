import { describe, expect, it } from 'vitest';
import { nextMushroomMarkerName } from '../mushroomNaming';

describe('nextMushroomMarkerName', () => {
  it('numbers each species independently', () => {
    const markers = [] as Array<{ tipo: 'Porcino' | 'Finferlo'; name: string }>;
    markers.push({ tipo: 'Porcino', name: nextMushroomMarkerName('Porcino', markers) });
    markers.push({ tipo: 'Finferlo', name: nextMushroomMarkerName('Finferlo', markers) });
    markers.push({ tipo: 'Finferlo', name: nextMushroomMarkerName('Finferlo', markers) });
    markers.push({ tipo: 'Porcino', name: nextMushroomMarkerName('Porcino', markers) });
    expect(markers.map((marker) => marker.name)).toEqual([
      'porcino1',
      'finferlo1',
      'finferlo2',
      'porcino2',
    ]);
  });

  it('does not rename legacy markers and avoids reusing an existing number', () => {
    const markers = [
      { tipo: 'Porcino' as const, name: 'Porcino_1' },
      { tipo: 'Porcino' as const, name: 'porcino4' },
    ];
    expect(nextMushroomMarkerName('Porcino', markers)).toBe('porcino5');
    expect(markers.map((marker) => marker.name)).toEqual(['Porcino_1', 'porcino4']);
  });
});
