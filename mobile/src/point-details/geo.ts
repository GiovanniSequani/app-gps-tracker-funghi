import type {
  BoundingBox,
  GridCell,
  GridContract,
  PointCoordinate,
  TerrainCellAddress,
} from './types';

export function isPointInsideBoundingBox(
  point: PointCoordinate,
  bbox: BoundingBox,
): boolean {
  return (
    Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude) &&
    point.latitude >= bbox.south &&
    point.latitude <= bbox.north &&
    point.longitude >= bbox.west &&
    point.longitude <= bbox.east
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function validateGrid(grid: GridContract): void {
  if (
    !Number.isInteger(grid.rows) ||
    grid.rows <= 0 ||
    !Number.isInteger(grid.cols) ||
    grid.cols <= 0 ||
    !Number.isFinite(grid.step_deg) ||
    grid.step_deg <= 0 ||
    !Number.isFinite(grid.origin_lat) ||
    !Number.isFinite(grid.origin_lon)
  ) {
    throw new Error('Invalid grid contract');
  }
}

export function coordinateToGridCell(
  point: PointCoordinate,
  grid: GridContract,
): GridCell | null {
  validateGrid(grid);
  if (!isPointInsideBoundingBox(point, grid.bbox)) return null;

  const row = clamp(
    Math.floor((point.latitude - grid.origin_lat) / grid.step_deg + 0.5),
    0,
    grid.rows - 1,
  );
  const col = clamp(
    Math.floor((point.longitude - grid.origin_lon) / grid.step_deg + 0.5),
    0,
    grid.cols - 1,
  );
  return { row, col };
}

export function coordinateToTerrainCell(
  point: PointCoordinate,
  grid: GridContract,
  chunkSize: { rows: number; cols: number },
): TerrainCellAddress | null {
  if (
    !Number.isInteger(chunkSize.rows) ||
    chunkSize.rows <= 0 ||
    !Number.isInteger(chunkSize.cols) ||
    chunkSize.cols <= 0
  ) {
    throw new Error('Invalid chunk size');
  }

  const cell = coordinateToGridCell(point, grid);
  if (!cell) return null;

  return {
    ...cell,
    chunkRow: Math.floor(cell.row / chunkSize.rows),
    chunkCol: Math.floor(cell.col / chunkSize.cols),
    localRow: cell.row % chunkSize.rows,
    localCol: cell.col % chunkSize.cols,
  };
}

