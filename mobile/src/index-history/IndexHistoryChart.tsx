import React from 'react';
import { Animated, PanResponder, StyleSheet, Text, View } from 'react-native';
import { LineChart, type lineDataItem } from 'react-native-gifted-charts';
import { GIFTED_CHART_TOP_INSET, lineChartX } from '../point-details/chartGeometry';
import { formatItalianDate } from '../point-details/labels';
import { indexHistoryIndexForX, indexHistoryTickIndices } from './chartGeometry';
import type {
  IndexHistoryForecastDay,
  IndexHistoryPointData,
} from './types';

const COLORS = {
  text: '#ECF4EC',
  muted: '#829085',
  border: '#2A382D',
  grid: '#2E3B31',
  axis: '#607064',
  current: '#F3F7F3',
  selection: '#69B7F1',
  selectionSurface: '#14212B',
  porcini: '#63C27A',
  finferli: '#E4B25D',
};

const CHART_HEIGHT = 150;
const Y_AXIS_LABEL_WIDTH = 38;
const MAX_CONTENT_WIDTH = 720;
const TICK_LABEL_WIDTH = 42;
const EMPTY_FORECAST: IndexHistoryForecastDay[] = [];
const scoreFormatter = new Intl.NumberFormat('it-IT', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export type IndexHistoryChartProps = {
  history: IndexHistoryPointData;
  contentWidth: number;
  /** Not supplied today. Future values render after the current day as dashed lines. */
  forecast?: IndexHistoryForecastDay[];
};

function shortNumericDate(date: string): string {
  const [, month, day] = date.split('-');
  return `${day}/${month}`;
}

function chartWidthForViewport(windowWidth: number): number {
  return Math.max(
    236,
    Math.min(windowWidth, MAX_CONTENT_WIDTH) - 32 - Y_AXIS_LABEL_WIDTH - 8,
  );
}

function formatAccessibleScore(value: number | null): string {
  return value === null ? 'non disponibile' : `${scoreFormatter.format(value)} su 100`;
}

function formatDisplayScore(value: number | null | undefined): string {
  return value === null || value === undefined ? 'N/D' : scoreFormatter.format(value);
}

const MemoLineChart = React.memo(LineChart);

export function IndexHistoryChart({
  history,
  contentWidth,
  forecast = EMPTY_FORECAST,
}: IndexHistoryChartProps) {
  const futureDays = React.useMemo(
    () => forecast.filter((day) => day.date > history.indexDate),
    [forecast, history.indexDate],
  );
  const axisDays = React.useMemo(
    () => [...history.days, ...futureDays],
    [futureDays, history.days],
  );
  const plotWidth = chartWidthForViewport(contentWidth);
  const currentIndex = Math.max(
    0,
    axisDays.findIndex((day) => day.date === history.indexDate),
  );
  const spacing = axisDays.length > 1 ? plotWidth / (axisDays.length - 1) : plotWidth;
  const currentX = lineChartX(currentIndex, axisDays.length, plotWidth);
  const [selectedIndex, setSelectedIndex] = React.useState(currentIndex);
  const selectedIndexRef = React.useRef(currentIndex);
  const gestureDirectionRef = React.useRef<'pending' | 'horizontal' | 'vertical'>('pending');
  const gestureLeftRef = React.useRef(0);
  const selectionX = React.useRef(new Animated.Value(currentX)).current;
  const frameRef = React.useRef<number | null>(null);
  const pendingIndexRef = React.useRef<number | null>(null);
  selectedIndexRef.current = selectedIndex;

  React.useEffect(() => {
    selectedIndexRef.current = currentIndex;
    pendingIndexRef.current = null;
    selectionX.setValue(currentX);
    setSelectedIndex(currentIndex);
  }, [currentIndex, currentX, history.col, history.row, history.version, selectionX]);

  React.useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  const commitSelection = React.useCallback((index: number) => {
    if (index === selectedIndexRef.current) return;
    selectedIndexRef.current = index;
    setSelectedIndex(index);
  }, []);

  const flushSelection = React.useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    const pendingIndex = pendingIndexRef.current;
    pendingIndexRef.current = null;
    if (pendingIndex !== null) commitSelection(pendingIndex);
  }, [commitSelection]);

  const scheduleSelection = React.useCallback((index: number) => {
    if (
      !Number.isInteger(index) || index < 0 || index >= axisDays.length ||
      index === selectedIndexRef.current || index === pendingIndexRef.current
    ) return;
    pendingIndexRef.current = index;
    if (frameRef.current === null) {
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        const pendingIndex = pendingIndexRef.current;
        pendingIndexRef.current = null;
        if (pendingIndex !== null) commitSelection(pendingIndex);
      });
    }
  }, [axisDays.length, commitSelection]);

  const porciniData = React.useMemo<lineDataItem[]>(
    () => axisDays.map((day, index) => ({
      value: index <= currentIndex ? day.porciniScore ?? undefined : undefined,
      label: '',
      hideDataPoint: true,
    })),
    [axisDays, currentIndex],
  );
  const finferliData = React.useMemo<lineDataItem[]>(
    () => axisDays.map((day, index) => ({
      value: index <= currentIndex ? day.finferliScore ?? undefined : undefined,
      hideDataPoint: true,
    })),
    [axisDays, currentIndex],
  );
  const forecastPorciniData = React.useMemo<lineDataItem[]>(
    () => axisDays.map((day, index) => ({
      value: index >= currentIndex
        ? (index === currentIndex ? history.days[currentIndex]?.porciniScore : day.porciniScore) ?? undefined
        : undefined,
      hideDataPoint: true,
    })),
    [axisDays, currentIndex, history.days],
  );
  const forecastFinferliData = React.useMemo<lineDataItem[]>(
    () => axisDays.map((day, index) => ({
      value: index >= currentIndex
        ? (index === currentIndex ? history.days[currentIndex]?.finferliScore : day.finferliScore) ?? undefined
        : undefined,
      hideDataPoint: true,
    })),
    [axisDays, currentIndex, history.days],
  );
  const safeSelectedIndex = Math.min(Math.max(selectedIndex, 0), Math.max(axisDays.length - 1, 0));
  const selectedDay = axisDays[safeSelectedIndex];
  const tickIndices = React.useMemo(
    () => indexHistoryTickIndices(axisDays.length, plotWidth),
    [axisDays.length, plotWidth],
  );
  const selectAtX = React.useCallback((x: number) => {
    const clampedX = Math.min(Math.max(x, 0), plotWidth);
    selectionX.setValue(clampedX);
    scheduleSelection(indexHistoryIndexForX(clampedX, axisDays.length, plotWidth));
  }, [axisDays.length, plotWidth, scheduleSelection, selectionX]);

  const finishGesture = React.useCallback(() => {
    flushSelection();
    selectionX.setValue(lineChartX(selectedIndexRef.current, axisDays.length, plotWidth));
  }, [axisDays.length, flushSelection, plotWidth, selectionX]);

  const panResponder = React.useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onStartShouldSetPanResponderCapture: () => true,
    onMoveShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponderCapture: () => true,
    onPanResponderGrant: (event) => {
      gestureDirectionRef.current = 'pending';
      gestureLeftRef.current = event.nativeEvent.pageX - event.nativeEvent.locationX;
      selectAtX(event.nativeEvent.locationX);
    },
    onPanResponderMove: (_event, gesture) => {
      const absX = Math.abs(gesture.dx);
      const absY = Math.abs(gesture.dy);
      if (gestureDirectionRef.current === 'pending') {
        if (absX >= 4) gestureDirectionRef.current = 'horizontal';
        else if (absY >= 12 && absY > absX * 1.5) gestureDirectionRef.current = 'vertical';
      }
      if (gestureDirectionRef.current !== 'vertical') {
        selectAtX(gesture.moveX - gestureLeftRef.current);
      }
    },
    onPanResponderRelease: finishGesture,
    onPanResponderTerminate: finishGesture,
    onPanResponderTerminationRequest: () => gestureDirectionRef.current === 'vertical',
    onShouldBlockNativeResponder: () => gestureDirectionRef.current !== 'vertical',
  }), [finishGesture, selectAtX]);
  const forecastProps = React.useMemo(() => futureDays.length > 0 ? {
    data3: forecastPorciniData,
    data4: forecastFinferliData,
    color3: COLORS.porcini,
    color4: COLORS.finferli,
    thickness3: 2,
    thickness4: 2,
    strokeDashArray3: [5, 4],
    strokeDashArray4: [5, 4],
  } : {}, [forecastFinferliData, forecastPorciniData, futureDays.length]);
  const hasAnyValue = history.days.some(
    (day) => day.porciniScore !== null || day.finferliScore !== null,
  );

  return (
    <View style={styles.section}>
      <View style={styles.headingRow}>
        <View>
          <Text style={styles.title}>Andamento recente</Text>
          <Text style={styles.period}>
            {formatItalianDate(history.dateFrom)} – {formatItalianDate(history.dateTo)}
          </Text>
        </View>
        <Text style={styles.unit}>score 0–100</Text>
      </View>
      <View style={styles.legend} accessible accessibilityLabel="Legenda: porcini verde, finferli ambra">
        <View style={styles.legendItem}>
          <View style={[styles.legendLine, { backgroundColor: COLORS.porcini }]} />
          <Text style={styles.legendText}>Porcini</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendLine, { backgroundColor: COLORS.finferli }]} />
          <Text style={styles.legendText}>Finferli</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={styles.currentLegendMark} />
          <Text style={styles.legendText}>Oggi</Text>
        </View>
      </View>
      <View style={styles.selectionSummary} accessibilityLiveRegion="polite">
        <View style={styles.selectionDateBlock}>
          <Text style={styles.selectionLabel}>GIORNO SELEZIONATO</Text>
          <Text style={styles.selectionDate}>{formatItalianDate(selectedDay?.date ?? history.indexDate)}</Text>
        </View>
        <View style={styles.selectionScore}>
          <Text style={[styles.selectionSpecies, { color: COLORS.porcini }]}>Porcini</Text>
          <Text style={styles.selectionValue}>{formatDisplayScore(selectedDay?.porciniScore)}</Text>
        </View>
        <View style={styles.selectionScore}>
          <Text style={[styles.selectionSpecies, { color: COLORS.finferli }]}>Finferli</Text>
          <Text style={styles.selectionValue}>{formatDisplayScore(selectedDay?.finferliScore)}</Text>
        </View>
      </View>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={`Grafico storico indice di ${history.days.length} giorni`}
        accessibilityHint="Scorri verso l'alto o il basso per cambiare il giorno selezionato"
        accessibilityValue={{
          text: `${formatItalianDate(selectedDay?.date ?? history.indexDate)}: porcini ${formatAccessibleScore(selectedDay?.porciniScore ?? null)}, finferli ${formatAccessibleScore(selectedDay?.finferliScore ?? null)}. I giorni senza dati sono mostrati come interruzioni.`,
        }}
        accessibilityActions={[
          { name: 'increment', label: 'Giorno successivo' },
          { name: 'decrement', label: 'Giorno precedente' },
        ]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === 'increment') {
            commitSelection(Math.min(safeSelectedIndex + 1, axisDays.length - 1));
          }
          if (event.nativeEvent.actionName === 'decrement') {
            commitSelection(Math.max(safeSelectedIndex - 1, 0));
          }
        }}
      >
        <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <View pointerEvents="none">
            <MemoLineChart
              height={CHART_HEIGHT}
              width={plotWidth}
              initialSpacing={0}
              endSpacing={0}
              spacing={spacing}
              disableScroll
              yAxisLabelWidth={Y_AXIS_LABEL_WIDTH}
              yAxisThickness={0}
              xAxisThickness={1}
              xAxisColor={COLORS.axis}
              rulesColor={COLORS.grid}
              rulesThickness={1}
              noOfSections={4}
              maxValue={100}
              stepValue={25}
              yAxisTextStyle={styles.axisText}
              xAxisLabelTextStyle={styles.axisText}
              xAxisTextNumberOfLines={1}
              labelsExtraHeight={0}
              data={porciniData}
              data2={finferliData}
              color1={COLORS.porcini}
              color2={COLORS.finferli}
              thickness1={2}
              thickness2={2}
              interpolateMissingValues={false}
              {...forecastProps}
            />
          </View>
          <View pointerEvents="none" style={[styles.selectionPlot, { left: Y_AXIS_LABEL_WIDTH, width: plotWidth }]}>
            <Animated.View style={[styles.selectionLine, { transform: [{ translateX: selectionX }] }]} />
          </View>
          <View
            collapsable={false}
            pointerEvents="box-only"
            accessible={false}
            testID="index-history-gesture-surface"
            style={[styles.gestureSurface, { left: Y_AXIS_LABEL_WIDTH, width: plotWidth }]}
            {...panResponder.panHandlers}
          />
        </View>
      </View>
      <View style={[styles.timeTicks, { marginLeft: Y_AXIS_LABEL_WIDTH, width: plotWidth }]}>
        {tickIndices.map((index) => {
          const x = lineChartX(index, axisDays.length, plotWidth);
          const labelLeft = Math.min(
            Math.max(x - TICK_LABEL_WIDTH / 2, 0),
            plotWidth - TICK_LABEL_WIDTH,
          );
          const markLeft = x - labelLeft;
          return (
            <View
              key={`${axisDays[index].date}-${index}`}
              style={[styles.timeTick, { left: labelLeft }]}
            >
              <View style={[styles.timeTickMark, { left: markLeft }, index === currentIndex && styles.timeTickMarkCurrent]} />
              <Text
                numberOfLines={1}
                ellipsizeMode="clip"
                style={[styles.timeTickLabel, index === currentIndex && styles.timeTickLabelCurrent]}
              >
                {shortNumericDate(axisDays[index].date)}
              </Text>
            </View>
          );
        })}
      </View>
      {!hasAnyValue && (
        <Text style={styles.emptyText}>Nessun valore disponibile per questo punto nel periodo.</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  headingRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  title: { color: COLORS.text, fontSize: 16, fontWeight: '800' },
  period: { marginTop: 2, color: COLORS.muted, fontSize: 13 },
  unit: { color: COLORS.muted, fontSize: 11, fontWeight: '700' },
  legend: { marginTop: 10, marginBottom: 4, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 14 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendLine: { width: 18, height: 3, borderRadius: 2 },
  currentLegendMark: { width: 7, height: 7, borderRadius: 1, backgroundColor: COLORS.current },
  legendText: { color: COLORS.muted, fontSize: 12, fontWeight: '700' },
  selectionSummary: { marginTop: 6, marginBottom: 8, minHeight: 54, paddingHorizontal: 10, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: COLORS.border, borderRadius: 8, backgroundColor: COLORS.selectionSurface },
  selectionDateBlock: { flex: 1, minWidth: 0 },
  selectionLabel: { color: COLORS.muted, fontSize: 11, fontWeight: '700' },
  selectionDate: { marginTop: 2, color: COLORS.text, fontSize: 14, fontWeight: '700' },
  selectionScore: { minWidth: 58, alignItems: 'flex-end' },
  selectionSpecies: { fontSize: 11, fontWeight: '700' },
  selectionValue: { marginTop: 1, color: COLORS.text, fontSize: 17, fontWeight: '800', fontVariant: ['tabular-nums'] },
  axisText: { color: COLORS.muted, fontSize: 9 },
  selectionPlot: { position: 'absolute', top: GIFTED_CHART_TOP_INSET, height: CHART_HEIGHT, overflow: 'visible', zIndex: 30 },
  selectionLine: { width: 1.5, height: CHART_HEIGHT, backgroundColor: COLORS.selection },
  gestureSurface: { position: 'absolute', top: GIFTED_CHART_TOP_INSET, height: CHART_HEIGHT, zIndex: 40, elevation: 2, backgroundColor: 'rgba(0,0,0,0.001)' },
  timeTicks: { position: 'relative', height: 24, marginTop: -1 },
  timeTick: { position: 'absolute', top: 0, width: TICK_LABEL_WIDTH },
  timeTickMark: { position: 'absolute', top: 0, width: 1, height: 4, backgroundColor: COLORS.axis },
  timeTickMarkCurrent: { height: 6, backgroundColor: COLORS.current },
  timeTickLabel: { width: TICK_LABEL_WIDTH, marginTop: 6, color: COLORS.muted, fontSize: 9, lineHeight: 11, textAlign: 'center', fontVariant: ['tabular-nums'] },
  timeTickLabelCurrent: { color: COLORS.current, fontWeight: '800' },
  emptyText: { marginTop: 4, color: COLORS.muted, fontSize: 11, textAlign: 'center' },
});
