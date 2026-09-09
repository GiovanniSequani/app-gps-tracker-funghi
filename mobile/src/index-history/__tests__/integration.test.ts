import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const chart = fs.readFileSync(path.resolve(__dirname, '../IndexHistoryChart.tsx'), 'utf8');
const hook = fs.readFileSync(path.resolve(__dirname, '../useIndexHistory.ts'), 'utf8');
const screen = fs.readFileSync(path.resolve(__dirname, '../../index-data/IndexAnalysisScreen.tsx'), 'utf8');

describe('index-history UI integration', () => {
  it('rende due linee 0-100, mantiene nodata come gap ed evidenzia oggi', () => {
    expect(chart).toContain('data2={finferliData}');
    expect(chart).toContain('maxValue={100}');
    expect(chart).toContain('interpolateMissingValues={false}');
    expect(chart).toContain('styles.selectionLine');
    expect(chart).toContain('timeTickLabelCurrent');
    expect(chart).toContain('I giorni senza dati sono mostrati come interruzioni');
  });

  it('riserva serie forecast tratteggiate senza richiederle al client attuale', () => {
    expect(chart).toContain('forecast = EMPTY_FORECAST');
    expect(chart).toContain('strokeDashArray3: [5, 4]');
    expect(chart).toContain('strokeDashArray4: [5, 4]');
    expect(screen).not.toMatch(/forecastLoader|loadForecast|fetchForecast/);
  });

  it('mantiene il gesto orizzontale agganciato e aggiorna i valori al massimo una volta per frame', () => {
    expect(chart).toContain('requestAnimationFrame');
    expect(chart).toContain('pendingIndexRef');
    expect(chart).toContain('const MemoLineChart = React.memo(LineChart)');
    expect(chart).toContain('PanResponder.create');
    expect(chart).toContain('onStartShouldSetPanResponder: () => true');
    expect(chart).toContain("gestureDirectionRef.current === 'vertical'");
    expect(chart).toContain("gestureDirectionRef.current !== 'vertical'");
    expect(chart).toContain('gesture.moveX - gestureLeftRef.current');
    expect(chart).toContain('selectionX.setValue(clampedX)');
    expect(chart).toContain('panResponder.panHandlers');
    expect(chart).toContain('collapsable={false}');
    expect(chart).toContain('pointerEvents="box-only"');
    expect(chart).toContain('GIORNO SELEZIONATO');
  });

  it('non lascia una barra o punti bianchi statici sul giorno corrente', () => {
    expect(chart).not.toContain('showPointerStrip');
    expect(chart).not.toContain('dataPointColor: COLORS.current');
    expect(chart).not.toContain('<SvgLine');
    expect(chart).toContain('hideDataPoint: true');
    expect(chart).toContain('selectionX = React.useRef(new Animated.Value(currentX))');
    expect(chart).toContain('timeTickLabelCurrent');
  });

  it('usa tick numerici esterni e non le label compresse della libreria', () => {
    expect(chart).toContain("label: ''");
    expect(chart).toContain('indexHistoryTickIndices');
    expect(chart).toContain('shortNumericDate');
    expect(chart).toContain('ellipsizeMode="clip"');
  });

  it('carica lo storico stale-safe e non introduce comandi camera', () => {
    expect(hook).toContain('IndexRequestGate');
    expect(hook).toContain('controller.abort()');
    expect(screen).toContain('<IndexHistoryChart');
    expect(screen).toContain('Storico non disponibile');
    expect(screen).not.toMatch(/runCameraCommand|centerCamera|setCameraCommand/);
  });
});
