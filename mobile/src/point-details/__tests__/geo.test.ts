import { describe, expect, it } from 'vitest';
import {
  coordinateToGridCell,
  coordinateToTerrainCell,
  isPointInsideBoundingBox,
} from '../geo';
import type { GridContract } from '../types';

const WEATHER_GRID: GridContract = {
  rows: 84,
  cols: 117,
  step_deg: 0.018,
  origin_lat: 45.6015,
  origin_lon: 10.4015,
  bbox: {
    west: 10.4,
    east: 12.5,
    south: 45.6,
    north: 47.1,
  },
};

const TERRAIN_GRID: GridContract = {
  rows: 500,
  cols: 700,
  step_deg: 0.003,
  origin_lat: 45.6015,
  origin_lon: 10.4015,
  bbox: {
    west: 10.4,
    east: 12.5,
    south: 45.6,
    north: 47.1,
  },
};

describe('coordinate to weather cell', () => {
  it('uses nearest-cell rounding for a valid coordinate', () => {
    expect(
      coordinateToGridCell(
        { latitude: 46, longitude: 11 },
        WEATHER_GRID,
      ),
    ).toEqual({ row: 22, col: 33 });
  });

  it('clamps only after confirming that the point is covered', () => {
    expect(
      coordinateToGridCell(
        { latitude: 47.1, longitude: 12.5 },
        WEATHER_GRID,
      ),
    ).toEqual({ row: 83, col: 116 });
  });
});

describe('coordinate to terrain cell and chunk', () => {
  it('calculates grid, chunk and local coordinates', () => {
    expect(
      coordinateToTerrainCell(
        { latitude: 46, longitude: 11 },
        TERRAIN_GRID,
        { rows: 50, cols: 50 },
      ),
    ).toEqual({
      row: 133,
      col: 199,
      chunkRow: 2,
      chunkCol: 3,
      localRow: 33,
      localCol: 49,
    });
  });

  it('resolves the final cell in an edge chunk', () => {
    expect(
      coordinateToTerrainCell(
        { latitude: 47.1, longitude: 12.5 },
        TERRAIN_GRID,
        { rows: 50, cols: 50 },
      ),
    ).toEqual({
      row: 499,
      col: 699,
      chunkRow: 9,
      chunkCol: 13,
      localRow: 49,
      localCol: 49,
    });
  });
});

describe('out-of-coverage coordinates', () => {
  it('rejects points outside the bbox before clamping', () => {
    const point = { latitude: 46, longitude: 10.399 };
    expect(isPointInsideBoundingBox(point, WEATHER_GRID.bbox)).toBe(false);
    expect(coordinateToGridCell(point, WEATHER_GRID)).toBeNull();
    expect(
      coordinateToTerrainCell(point, TERRAIN_GRID, { rows: 50, cols: 50 }),
    ).toBeNull();
  });
});
