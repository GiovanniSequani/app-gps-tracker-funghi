export function indexHistoryTickIndices(itemCount: number, plotWidth: number): number[] {
  if (itemCount <= 0) return [];
  if (itemCount === 1) return [0];
  const tickCount = Math.min(itemCount, Math.max(3, Math.min(5, Math.floor(plotWidth / 58))));
  return Array.from(
    new Set(Array.from({ length: tickCount }, (_, index) => (
      Math.round((index * (itemCount - 1)) / (tickCount - 1))
    ))),
  );
}

export function indexHistoryIndexForX(
  x: number,
  itemCount: number,
  plotWidth: number,
): number {
  if (itemCount <= 1) return 0;
  const safeWidth = Math.max(plotWidth, 1);
  const clampedX = Math.min(Math.max(x, 0), safeWidth);
  return Math.round((clampedX / safeWidth) * (itemCount - 1));
}
