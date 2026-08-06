import { describe, expect, it } from 'vitest';
import {
  barChartX,
  GIFTED_CHART_TOP_INSET,
  giftedLineChartY,
  lineChartX,
} from '../chartGeometry';

describe('Gifted Charts overlay geometry', () => {
  it.each([
    { lower: -18, upper: -2, height: 96 },
    { lower: -5, upper: 35, height: 136 },
    { lower: 12, upper: 16, height: 220 },
  ])(
    'uses the library extended vertical container for $lower..$upper at $height px',
    ({ lower, upper, height }) => {
      expect(giftedLineChartY(upper, lower, upper, height)).toBe(
        GIFTED_CHART_TOP_INSET,
      );
      expect(giftedLineChartY(lower, lower, upper, height)).toBe(
        height + GIFTED_CHART_TOP_INSET,
      );
      expect(
        giftedLineChartY((lower + upper) / 2, lower, upper, height),
      ).toBe(height / 2 + GIFTED_CHART_TOP_INSET);
    },
  );

  it('aligns line overlays to the first, middle and last data points', () => {
    expect(lineChartX(0, 20, 304)).toBe(0);
    expect(lineChartX(19, 20, 304)).toBe(304);
    expect(lineChartX(1, 3, 304)).toBe(152);
  });

  it('aligns bar overlays to bar centers, including edge chunks', () => {
    expect(barChartX(0, 8, 7)).toBe(4);
    expect(barChartX(19, 8, 7)).toBe(289);
  });
});
