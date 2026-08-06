import React from 'react';
import {
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  BarChart,
  LineChart,
  type barDataItem,
  type lineDataItem,
} from 'react-native-gifted-charts';
import Svg, { Line as SvgLine, Polygon } from 'react-native-svg';
import {
  barChartX,
  GIFTED_CHART_TOP_INSET,
  giftedLineChartY,
  lineChartX,
} from './chartGeometry';
import { formatItalianDate } from './labels';
import { synchronizeSelectedDateIndex } from './selection';
import type { WeatherDay } from './types';

const COLORS = {
  text: '#ECF4EC',
  muted: '#91A394',
  border: '#2B3A2E',
  grid: '#2E3B31',
  axis: '#607064',
  cursor: '#F2F6F2',
  temperatureMin: '#55A9E8',
  temperatureMax: '#F47F6B',
  temperatureBand: '#7DA6B8',
  precipitation: '#5E9FD6',
  humidity: '#35B5A1',
  gust: '#E5A83B',
};

const CHART_HEIGHT = 136;
const Y_AXIS_LABEL_WIDTH = 42;
const MAX_CONTENT_WIDTH = 720;

type WeatherChartsProps = {
  days: WeatherDay[];
  selectedDateIndex: number;
  onSelectDateIndex: (index: number) => void;
  contentWidth: number;
};

type AccessibleChartProps = {
  title: string;
  unit: string;
  days: WeatherDay[];
  selectedDateIndex: number;
  onSelectDateIndex: (index: number) => void;
  selectedSummary: string;
  cursorX: number;
  children: React.ReactNode;
};

function shortDate(date: string): string {
  return formatItalianDate(date, { day: 'numeric', month: 'short' })
    .replace(/\./g, '')
    .toLocaleLowerCase('it-IT');
}

function axisLabel(day: WeatherDay, index: number, dayCount: number): string {
  return index % 4 === 0 || index === dayCount - 1 ? shortDate(day.date) : '';
}

function valueLabel(value: number | null, unit: string): string {
  return value === null ? 'non disponibile' : `${value.toFixed(1)} ${unit}`;
}

function niceUpperBound(values: Array<number | null>, minimum = 1): number {
  const valid = values.filter((value): value is number => value !== null);
  const maximum = Math.max(minimum, ...valid);
  const roughStep = maximum / 4;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(roughStep, 0.1)));
  const normalized = roughStep / magnitude;
  const niceNormalized =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = niceNormalized * magnitude;
  return Math.max(step, Math.ceil(maximum / step) * step);
}

function temperatureScale(days: WeatherDay[]): {
  lower: number;
  upper: number;
} {
  const values = days.flatMap((day) => [
    day.temperatureMin,
    day.temperatureMax,
  ]);
  const valid = values.filter((value): value is number => value !== null);
  if (valid.length === 0) return { lower: 0, upper: 1 };
  const rawMin = Math.min(...valid);
  const rawMax = Math.max(...valid);
  const span = Math.max(rawMax - rawMin, 4);
  const padding = Math.max(1, span * 0.12);
  const lower = Math.floor(rawMin - padding);
  const upper = Math.ceil(rawMax + padding);
  return upper > lower ? { lower, upper } : { lower, upper: lower + 1 };
}

function AccessibleChart({
  title,
  unit,
  days,
  selectedDateIndex,
  onSelectDateIndex,
  selectedSummary,
  cursorX,
  children,
}: AccessibleChartProps) {
  const selectedDay = days[selectedDateIndex];
  const moveSelection = React.useCallback(
    (delta: number) => {
      onSelectDateIndex(
        synchronizeSelectedDateIndex(
          selectedDateIndex,
          selectedDateIndex + delta,
          days.length,
        ),
      );
    },
    [days.length, onSelectDateIndex, selectedDateIndex],
  );

  return (
    <View style={styles.section}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.unit}>{unit}</Text>
      </View>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={`Grafico ${title.toLocaleLowerCase('it-IT')}, ${days.length} giorni`}
        accessibilityHint="Scorri verso l'alto o il basso per cambiare il giorno selezionato"
        accessibilityValue={{
          text: selectedDay
            ? `${formatItalianDate(selectedDay.date)}: ${selectedSummary}`
            : 'Nessun giorno disponibile',
        }}
        accessibilityActions={[
          { name: 'increment', label: 'Giorno successivo' },
          { name: 'decrement', label: 'Giorno precedente' },
        ]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === 'increment') moveSelection(1);
          if (event.nativeEvent.actionName === 'decrement') moveSelection(-1);
        }}
      >
        <View
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {children}
          <Svg
            pointerEvents="none"
            width={1}
            height={CHART_HEIGHT}
            style={[
              styles.selectedCursor,
              { left: Y_AXIS_LABEL_WIDTH + cursorX },
            ]}
          >
            <SvgLine
              x1={0.5}
              y1={0}
              x2={0.5}
              y2={CHART_HEIGHT}
              stroke={COLORS.cursor}
              strokeWidth={1}
              strokeDasharray="4 3"
            />
          </Svg>
        </View>
      </View>
    </View>
  );
}

type TemperatureRangeAreaProps = {
  days: WeatherDay[];
  width: number;
  lower: number;
  upper: number;
};

function TemperatureRangeArea({
  days,
  width,
  lower,
  upper,
}: TemperatureRangeAreaProps) {
  const xForIndex = (index: number) => lineChartX(index, days.length, width);
  const yForValue = (value: number) =>
    giftedLineChartY(value, lower, upper, CHART_HEIGHT);

  const segments: Array<
    Array<{ index: number; min: number; max: number }>
  > = [];
  let current: Array<{ index: number; min: number; max: number }> = [];
  days.forEach((day, index) => {
    if (day.temperatureMin === null || day.temperatureMax === null) {
      if (current.length > 0) segments.push(current);
      current = [];
      return;
    }
    current.push({
      index,
      min: day.temperatureMin,
      max: day.temperatureMax,
    });
  });
  if (current.length > 0) segments.push(current);

  return (
    <Svg width={width} height={CHART_HEIGHT + GIFTED_CHART_TOP_INSET}>
      {segments
        .filter((segment) => segment.length > 1)
        .map((segment) => {
          const upperPoints = segment.map(
            (point) => `${xForIndex(point.index)},${yForValue(point.max)}`,
          );
          const lowerPoints = [...segment]
            .reverse()
            .map(
              (point) => `${xForIndex(point.index)},${yForValue(point.min)}`,
            );
          return (
            <Polygon
              key={`${segment[0].index}-${segment[segment.length - 1].index}`}
              points={[...upperPoints, ...lowerPoints].join(' ')}
              fill={COLORS.temperatureBand}
              opacity={0.16}
            />
          );
        })}
    </Svg>
  );
}

function chartWidthForViewport(windowWidth: number): number {
  return Math.max(
    236,
    Math.min(windowWidth, MAX_CONTENT_WIDTH) - 32 - Y_AXIS_LABEL_WIDTH - 8,
  );
}

const MemoLineChart = React.memo(LineChart);
const MemoBarChart = React.memo(BarChart);

export function WeatherCharts({
  days,
  selectedDateIndex,
  onSelectDateIndex,
  contentWidth,
}: WeatherChartsProps) {
  const plotWidth = chartWidthForViewport(contentWidth);
  const selectedIndexRef = React.useRef(selectedDateIndex);
  const callbackRef = React.useRef(onSelectDateIndex);
  const frameRef = React.useRef<number | null>(null);
  const pendingIndexRef = React.useRef<number | null>(null);
  selectedIndexRef.current = selectedDateIndex;
  callbackRef.current = onSelectDateIndex;

  const flushSelection = React.useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    const pendingIndex = pendingIndexRef.current;
    pendingIndexRef.current = null;
    if (
      pendingIndex !== null &&
      pendingIndex !== selectedIndexRef.current
    ) {
      selectedIndexRef.current = pendingIndex;
      callbackRef.current(pendingIndex);
    }
  }, []);

  const scheduleSelection = React.useCallback((index: number) => {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index === selectedIndexRef.current ||
      index === pendingIndexRef.current
    ) {
      return;
    }
    pendingIndexRef.current = index;
    if (frameRef.current === null) {
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        const pendingIndex = pendingIndexRef.current;
        pendingIndexRef.current = null;
        if (
          pendingIndex !== null &&
          pendingIndex !== selectedIndexRef.current
        ) {
          selectedIndexRef.current = pendingIndex;
          callbackRef.current(pendingIndex);
        }
      });
    }
  }, []);

  React.useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  const shared = React.useMemo(
    () => ({
      height: CHART_HEIGHT,
      width: plotWidth,
      initialSpacing: 0,
      endSpacing: 0,
      spacing: days.length > 1 ? plotWidth / (days.length - 1) : plotWidth,
      disableScroll: true,
      yAxisLabelWidth: Y_AXIS_LABEL_WIDTH,
      yAxisThickness: 0,
      xAxisThickness: 1,
      xAxisColor: COLORS.axis,
      rulesColor: COLORS.grid,
      rulesThickness: 1,
      noOfSections: 4,
      yAxisTextStyle: styles.axisText,
      xAxisLabelTextStyle: styles.axisText,
      xAxisTextNumberOfLines: 1,
      labelsExtraHeight: 4,
      pointerConfig: {
        showPointerStrip: true,
        pointerStripColor: COLORS.cursor,
        pointerStripWidth: 1,
        pointerStripHeight: CHART_HEIGHT,
        strokeDashArray: [4, 3],
        hidePointers: true,
        hidePointerForMissingValues: false,
        hidePointerDataPointForMissingValues: true,
        activatePointersInstantlyOnTouch: true,
        activatePointersOnLongPress: false,
        pointerVanishDelay: 0,
        persistPointer: false,
        resetPointerIndexOnRelease: true,
        onResponderEnd: flushSelection,
      },
      getPointerProps: ({ pointerIndex }: { pointerIndex: number }) =>
        scheduleSelection(pointerIndex),
    }),
    [days.length, flushSelection, plotWidth, scheduleSelection],
  );
  const temperature = React.useMemo(() => temperatureScale(days), [days]);
  const temperatureSpan = temperature.upper - temperature.lower;

  const temperatureMinData = React.useMemo<lineDataItem[]>(
    () =>
      days.map((day, index) => ({
        value:
          day.temperatureMin === null
            ? undefined
            : day.temperatureMin - temperature.lower,
        label: axisLabel(day, index, days.length),
        hideDataPoint: true,
        onPress: () => scheduleSelection(index),
      })),
    [days, scheduleSelection, temperature.lower],
  );
  const temperatureMaxData = React.useMemo<lineDataItem[]>(
    () =>
      days.map((day, index) => ({
        value:
          day.temperatureMax === null
            ? undefined
            : day.temperatureMax - temperature.lower,
        hideDataPoint: true,
        onPress: () => scheduleSelection(index),
      })),
    [days, scheduleSelection, temperature.lower],
  );
  const precipitationMax = React.useMemo(
    () => niceUpperBound(days.map((day) => day.precipitation), 5),
    [days],
  );
  const precipitationData = React.useMemo<barDataItem[]>(
    () =>
      days.map((day, index) => ({
        value: day.precipitation ?? undefined,
        label: axisLabel(day, index, days.length),
        frontColor:
          day.precipitation === null ? 'transparent' : COLORS.precipitation,
        onPress: () => scheduleSelection(index),
      })),
    [days, scheduleSelection],
  );
  const humidityData = React.useMemo<lineDataItem[]>(
    () =>
      days.map((day, index) => ({
        value: day.humidity ?? undefined,
        label: axisLabel(day, index, days.length),
        hideDataPoint: true,
        onPress: () => scheduleSelection(index),
      })),
    [days, scheduleSelection],
  );
  const gustMax = React.useMemo(
    () => niceUpperBound(days.map((day) => day.gust), 10),
    [days],
  );
  const gustData = React.useMemo<lineDataItem[]>(
    () =>
      days.map((day, index) => ({
        value: day.gust ?? undefined,
        label: axisLabel(day, index, days.length),
        hideDataPoint: true,
        onPress: () => scheduleSelection(index),
      })),
    [days, scheduleSelection],
  );
  const selectedDay = days[selectedDateIndex];
  const barWidth = Math.max(3, Math.min(8, plotWidth / (days.length * 2.2)));
  const barSpacing =
    days.length > 1
      ? Math.max(1, (plotWidth - barWidth * days.length) / (days.length - 1))
      : plotWidth;
  const lineCursorX = lineChartX(selectedDateIndex, days.length, plotWidth);
  const precipitationCursorX = barChartX(
    selectedDateIndex,
    barWidth,
    barSpacing,
  );
  const temperatureBackground = React.useMemo(
    () => ({
      width: plotWidth,
      height: CHART_HEIGHT + GIFTED_CHART_TOP_INSET,
      component: () => (
        <TemperatureRangeArea
          days={days}
          width={plotWidth}
          lower={temperature.lower}
          upper={temperature.upper}
        />
      ),
    }),
    [days, plotWidth, temperature.lower, temperature.upper],
  );
  const formatTemperatureYLabel = React.useCallback(
    (label: string) => `${Math.round(Number(label) + temperature.lower)}`,
    [temperature.lower],
  );

  return (
    <View
      style={{
        width: Math.min(contentWidth, MAX_CONTENT_WIDTH) - 32,
        maxWidth: '100%',
      }}
    >
      <AccessibleChart
        title="Temperatura"
        unit="°C"
        days={days}
        selectedDateIndex={selectedDateIndex}
        onSelectDateIndex={onSelectDateIndex}
        cursorX={lineCursorX}
        selectedSummary={`minima ${valueLabel(
          selectedDay?.temperatureMin ?? null,
          '°C',
        )}, massima ${valueLabel(
          selectedDay?.temperatureMax ?? null,
          '°C',
        )}`}
      >
        <MemoLineChart
          {...shared}
          data={temperatureMinData}
          data2={temperatureMaxData}
          color1={COLORS.temperatureMin}
          color2={COLORS.temperatureMax}
          thickness1={2}
          thickness2={2}
          maxValue={temperatureSpan}
          stepValue={temperatureSpan / 4}
          formatYLabel={formatTemperatureYLabel}
          interpolateMissingValues={false}
          customBackground={temperatureBackground}
        />
      </AccessibleChart>

      <AccessibleChart
        title="Precipitazioni"
        unit="mm"
        days={days}
        selectedDateIndex={selectedDateIndex}
        onSelectDateIndex={onSelectDateIndex}
        cursorX={precipitationCursorX}
        selectedSummary={valueLabel(
          selectedDay?.precipitation ?? null,
          'mm',
        )}
      >
        <MemoBarChart
          {...shared}
          data={precipitationData}
          maxValue={precipitationMax}
          stepValue={precipitationMax / 4}
          barWidth={barWidth}
          spacing={barSpacing}
          frontColor={COLORS.precipitation}
          roundedTop
        />
      </AccessibleChart>

      <AccessibleChart
        title="Umidità"
        unit="%"
        days={days}
        selectedDateIndex={selectedDateIndex}
        onSelectDateIndex={onSelectDateIndex}
        cursorX={lineCursorX}
        selectedSummary={valueLabel(selectedDay?.humidity ?? null, '%')}
      >
        <MemoLineChart
          {...shared}
          data={humidityData}
          color={COLORS.humidity}
          thickness={2}
          maxValue={100}
          stepValue={25}
          interpolateMissingValues={false}
        />
      </AccessibleChart>

      <AccessibleChart
        title="Raffiche"
        unit="km/h"
        days={days}
        selectedDateIndex={selectedDateIndex}
        onSelectDateIndex={onSelectDateIndex}
        cursorX={lineCursorX}
        selectedSummary={valueLabel(selectedDay?.gust ?? null, 'km/h')}
      >
        <MemoLineChart
          {...shared}
          data={gustData}
          color={COLORS.gust}
          thickness={2}
          maxValue={gustMax}
          stepValue={gustMax / 4}
          interpolateMissingValues={false}
        />
      </AccessibleChart>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    paddingVertical: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  title: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '800',
  },
  unit: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '700',
  },
  axisText: {
    color: COLORS.muted,
    fontSize: 9,
  },
  selectedCursor: {
    position: 'absolute',
    top: GIFTED_CHART_TOP_INSET,
    zIndex: 30,
  },
});
