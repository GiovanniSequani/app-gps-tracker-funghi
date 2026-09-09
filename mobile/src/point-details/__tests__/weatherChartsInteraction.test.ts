import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const chart = fs.readFileSync(path.resolve(__dirname, '../WeatherCharts.tsx'), 'utf8');

describe('grafici meteo mobile', () => {
  it('disegna banda e linee temperatura nello stesso sistema di coordinate', () => {
    expect(chart).toContain('function TemperatureRangePlot');
    expect(chart).toContain('<Polygon');
    expect(chart.match(/<Polyline/g)).toHaveLength(2);
    expect(chart).toContain('yForValue(point.max)');
    expect(chart).toContain('yForValue(point.min)');
    expect(chart).toContain('color1="transparent"');
    expect(chart).toContain('color2="transparent"');
  });

  it('usa date esterne alla libreria con spazio stabile anche ai bordi', () => {
    expect(chart).toContain("label: ''");
    expect(chart).toContain('tickIndices(days.length)');
    expect(chart).toContain('plotWidth - labelWidth');
    expect(chart).toContain('timeTickLabel');
    expect(chart).toContain('timeTickMark');
    expect(chart).toContain('(index * (dayCount - 1)) / (tickCount - 1)');
  });

  it('mantiene il responder agganciato e non aggiorna React a ogni pixel', () => {
    expect(chart).not.toContain('pointerConfig:');
    expect(chart).toContain('PanResponder.create');
    expect(chart).toContain('gesture.moveX - gestureLeftRef.current');
    expect(chart).toContain("onPanResponderTerminationRequest: () => gestureDirectionRef.current === 'vertical'");
    expect(chart).toContain('selectionX.setValue(clamped)');
    expect(chart).toContain('onGestureXRef.current(clamped)');
    expect(chart).toContain('onGestureEndRef.current()');
    expect(chart).toContain('requestAnimationFrame');
    expect(chart).toContain('pendingIndexRef');
  });
});
