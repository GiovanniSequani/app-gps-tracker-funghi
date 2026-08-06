/**
 * Gifted Charts maps line values into an "extended" container that is 10 px
 * taller than the configured chart height. Custom backgrounds are positioned
 * in that same coordinate space, so overlays must include this offset.
 */
export const GIFTED_CHART_TOP_INSET = 10;

export function lineChartX(
  index: number,
  itemCount: number,
  plotWidth: number,
): number {
  return itemCount <= 1 ? plotWidth / 2 : (index / (itemCount - 1)) * plotWidth;
}

export function barChartX(
  index: number,
  barWidth: number,
  spacing: number,
): number {
  return barWidth / 2 + index * (barWidth + spacing);
}

export function giftedLineChartY(
  value: number,
  lower: number,
  upper: number,
  chartHeight: number,
): number {
  const span = Math.max(upper - lower, 1);
  return (
    chartHeight +
    GIFTED_CHART_TOP_INSET -
    ((value - lower) / span) * chartHeight
  );
}
