import React from 'react';
import {
  ActivityIndicator,
  BackHandler,
  type LayoutChangeEvent,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  ArrowLeft,
  Compass,
  Info,
  LandPlot,
  Mountain,
  RefreshCw,
  Trees,
} from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { formatAspect, formatItalianDate, formatItalianPeriod, tpiCategoryLabel } from './labels';
import {
  findLatestAvailableDateIndex,
  synchronizeSelectedDateIndex,
} from './selection';
import type {
  PointCoordinate,
  ResourceState,
  TerrainDetails,
  WeatherDay,
  WeatherDetails,
} from './types';
import { usePointDetailsData } from './usePointDetailsData';
import { WeatherCharts } from './WeatherCharts';

const COLORS = {
  background: '#0A0F0B',
  surface: '#111813',
  surfaceRaised: '#182019',
  text: '#ECF4EC',
  secondary: '#B3C0B5',
  muted: '#829085',
  border: '#2A382D',
  borderStrong: '#3D5141',
  green: '#63C27A',
  error: '#F08B7A',
  warning: '#E4B25D',
};

type PointDetailsScreenProps = {
  point: PointCoordinate;
  onClose: () => void;
};

type MetricProps = {
  label: string;
  value: string;
  width: number;
};

function Metric({ label, value, width }: MetricProps) {
  return (
    <View style={[styles.metric, { width }]}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
    </View>
  );
}

function formatValue(
  value: number | null,
  unit: string,
  digits = 1,
): string {
  return value === null ? 'N/D' : `${value.toFixed(digits)} ${unit}`;
}

function LoadingRow({ label }: { label: string }) {
  return (
    <View
      style={styles.stateRow}
      accessibilityLiveRegion="polite"
      accessibilityLabel={label}
    >
      <ActivityIndicator color={COLORS.green} size="small" />
      <Text style={styles.stateText}>{label}</Text>
    </View>
  );
}

function StateMessage({
  title,
  message,
  tone = 'normal',
}: {
  title: string;
  message: string;
  tone?: 'normal' | 'error';
}) {
  return (
    <View style={styles.stateBlock}>
      <Text
        style={[
          styles.stateTitle,
          tone === 'error' && styles.stateTitleError,
        ]}
      >
        {title}
      </Text>
      <Text style={styles.stateText}>{message}</Text>
    </View>
  );
}

function TerrainStrip({
  terrain,
}: {
  terrain: ResourceState<TerrainDetails>;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Terreno</Text>
      {terrain.status === 'loading' && (
        <LoadingRow label="Caricamento dati del terreno…" />
      )}
      {terrain.status === 'outside' && (
        <StateMessage
          title="Punto fuori copertura"
          message="I dati statici del terreno non coprono questa coordinata."
        />
      )}
      {terrain.status === 'unavailable' && (
        <StateMessage
          title="Terreno non disponibile"
          message={terrain.message}
        />
      )}
      {terrain.status === 'error' && (
        <StateMessage
          title="Errore terreno"
          message={terrain.message}
          tone="error"
        />
      )}
      {terrain.status === 'ready' && (
        <View style={styles.terrainGrid}>
          <View style={styles.terrainItem}>
            <Mountain size={18} color={COLORS.green} />
            <View style={styles.terrainText}>
              <Text style={styles.terrainLabel}>Quota</Text>
              <Text style={styles.terrainValue}>
                {terrain.data.elevation === null
                  ? 'N/D'
                  : `${Math.round(terrain.data.elevation)} m`}
              </Text>
            </View>
          </View>
          <View style={styles.terrainItem}>
            <Trees size={18} color={COLORS.green} />
            <View style={styles.terrainText}>
              <Text style={styles.terrainLabel}>Foresta</Text>
              <Text style={styles.terrainValue}>
                {terrain.data.forestPercent === null
                  ? 'N/D'
                  : `${Math.round(terrain.data.forestPercent)}%`}
              </Text>
            </View>
          </View>
          <View style={styles.terrainItem}>
            <Compass size={18} color={COLORS.green} />
            <View style={styles.terrainText}>
              <Text style={styles.terrainLabel}>Esposizione</Text>
              <Text style={styles.terrainValue}>
                {formatAspect(terrain.data.aspectDegrees)}
              </Text>
            </View>
          </View>
          <View style={styles.terrainItem}>
            <LandPlot size={18} color={COLORS.green} />
            <View style={styles.terrainText}>
              <Text style={styles.terrainLabel}>Topografia</Text>
              <Text style={styles.terrainValue}>
                {tpiCategoryLabel(terrain.data.tpiCategory)}
              </Text>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

function SelectedDaySummary({
  day,
  contentWidth,
}: {
  day: WeatherDay;
  contentWidth: number;
}) {
  const metricWidth = (Math.min(contentWidth, 720) - 32) / 3;

  return (
    <View style={styles.selectedDaySection}>
      <View style={styles.selectedDayHeader}>
        <View>
          <Text style={styles.sectionEyebrow}>Giorno selezionato</Text>
          <Text style={styles.selectedDate}>{formatItalianDate(day.date)}</Text>
        </View>
        {day.missing && (
          <Text style={styles.missingBadge}>DATI MANCANTI</Text>
        )}
      </View>
      <View style={styles.metricsGrid}>
        <Metric
          label="Minima"
          value={formatValue(day.temperatureMin, '°C')}
          width={metricWidth}
        />
        <Metric
          label="Massima"
          value={formatValue(day.temperatureMax, '°C')}
          width={metricWidth}
        />
        <Metric
          label="Pioggia"
          value={formatValue(day.precipitation, 'mm')}
          width={metricWidth}
        />
        <Metric
          label="Umidità"
          value={formatValue(day.humidity, '%')}
          width={metricWidth}
        />
        <Metric
          label="Raffiche"
          value={formatValue(day.gust, 'km/h')}
          width={metricWidth}
        />
      </View>
    </View>
  );
}

function WeatherContent({
  weather,
  selectedDateIndex,
  onSelectDateIndex,
  contentWidth,
}: {
  weather: ResourceState<WeatherDetails>;
  selectedDateIndex: number;
  onSelectDateIndex: (index: number) => void;
  contentWidth: number;
}) {
  if (weather.status === 'loading') {
    return (
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Meteo</Text>
        <LoadingRow label="Caricamento dati meteorologici…" />
      </View>
    );
  }
  if (weather.status === 'outside') {
    return (
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Meteo</Text>
        <StateMessage
          title="Punto fuori copertura"
          message="La griglia meteorologica non copre questa coordinata."
        />
      </View>
    );
  }
  if (weather.status === 'unavailable') {
    return (
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Meteo</Text>
        <StateMessage
          title="Meteo non disponibile"
          message={weather.message}
        />
      </View>
    );
  }
  if (weather.status === 'error') {
    return (
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Meteo</Text>
        <StateMessage
          title="Errore meteo"
          message={weather.message}
          tone="error"
        />
      </View>
    );
  }

  const selectedDay = weather.data.days[selectedDateIndex];
  if (!selectedDay) {
    return (
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Meteo</Text>
        <StateMessage
          title="Meteo non disponibile"
          message="Il dataset non contiene giorni utilizzabili."
        />
      </View>
    );
  }

  return (
    <>
      {weather.data.missingDates.length > 0 && (
        <View style={styles.availabilityNote}>
          <Info size={15} color={COLORS.warning} />
          <Text style={styles.availabilityText}>
            {weather.data.availableDayCount} giorni disponibili · mancanti:{' '}
            {weather.data.missingDates
              .map((date) =>
                formatItalianDate(date, { day: 'numeric', month: 'short' }),
              )
              .join(', ')}
          </Text>
        </View>
      )}
      <SelectedDaySummary day={selectedDay} contentWidth={contentWidth} />
      <View style={styles.chartsSection}>
        <WeatherCharts
          days={weather.data.days}
          selectedDateIndex={selectedDateIndex}
          onSelectDateIndex={onSelectDateIndex}
          contentWidth={contentWidth}
        />
      </View>
    </>
  );
}

function canRetry<T>(state: ResourceState<T>): boolean {
  return state.status === 'error' || state.status === 'unavailable';
}

export default function PointDetailsScreen({
  point,
  onClose,
}: PointDetailsScreenProps) {
  const { width: windowWidth } = useWindowDimensions();
  const { weather, terrain, retry } = usePointDetailsData(point);
  const [selectedDateIndex, setSelectedDateIndex] = React.useState(-1);
  const [contentWidth, setContentWidth] = React.useState(windowWidth);
  const initializedWeatherVersionRef = React.useRef<string | null>(null);

  const measureContent = React.useCallback((event: LayoutChangeEvent) => {
    const nextWidth = event.nativeEvent.layout.width;
    setContentWidth((current) =>
      Math.abs(current - nextWidth) < 0.5 ? current : nextWidth,
    );
  }, []);

  React.useEffect(() => {
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        onClose();
        return true;
      },
    );
    return () => subscription.remove();
  }, [onClose]);

  React.useEffect(() => {
    if (weather.status !== 'ready') {
      if (weather.status !== 'loading') setSelectedDateIndex(-1);
      return;
    }
    const selectionKey = `${weather.data.version}/${weather.data.cell.row}/${weather.data.cell.col}`;
    if (initializedWeatherVersionRef.current === selectionKey) return;
    initializedWeatherVersionRef.current = selectionKey;
    setSelectedDateIndex(findLatestAvailableDateIndex(weather.data.days));
  }, [weather]);

  const selectDateIndex = React.useCallback(
    (index: number) => {
      if (weather.status !== 'ready') return;
      setSelectedDateIndex((current) =>
        synchronizeSelectedDateIndex(
          current,
          index,
          weather.data.days.length,
        ),
      );
    },
    [weather],
  );

  const period =
    weather.status === 'ready'
      ? formatItalianPeriod(weather.data.dates)
      : weather.status === 'loading'
        ? 'Periodo in caricamento'
        : 'Periodo non disponibile';
  const retryVisible = canRetry(weather) || canRetry(terrain);
  const displayedDateIndex =
    weather.status === 'ready' && selectedDateIndex < 0
      ? findLatestAvailableDateIndex(weather.data.days)
      : selectedDateIndex;

  return (
    <SafeAreaView
      style={styles.root}
      edges={['top', 'bottom']}
      onLayout={measureContent}
    >
      <StatusBar barStyle="light-content" backgroundColor={COLORS.background} />
      <View style={styles.header}>
        <TouchableOpacity
          onPress={onClose}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel="Torna alla mappa"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <ArrowLeft size={22} color={COLORS.text} />
        </TouchableOpacity>
        <View style={styles.headerText}>
          <Text style={styles.headerTitle}>Dettagli del punto</Text>
          <Text style={styles.coordinates}>
            {point.latitude.toFixed(4)}, {point.longitude.toFixed(4)}
          </Text>
          <Text style={styles.period}>{period}</Text>
        </View>
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator
        keyboardShouldPersistTaps="handled"
      >
        <TerrainStrip terrain={terrain} />
        <WeatherContent
          weather={weather}
          selectedDateIndex={displayedDateIndex}
          onSelectDateIndex={selectDateIndex}
          contentWidth={contentWidth}
        />
        {retryVisible && (
          <TouchableOpacity
            onPress={retry}
            style={styles.retryButton}
            accessibilityRole="button"
            accessibilityLabel="Riprova il caricamento dei dettagli"
          >
            <RefreshCw size={17} color={COLORS.text} />
            <Text style={styles.retryText}>Riprova</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  header: {
    minHeight: 84,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
    backgroundColor: COLORS.surfaceRaised,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  headerTitle: {
    color: COLORS.text,
    fontSize: 20,
    lineHeight: 25,
    fontWeight: '900',
  },
  coordinates: {
    marginTop: 2,
    color: COLORS.secondary,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  period: {
    marginTop: 2,
    color: COLORS.muted,
    fontSize: 12,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    width: '100%',
    maxWidth: 720,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingBottom: 28,
  },
  section: {
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  sectionTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 12,
  },
  sectionEyebrow: {
    color: COLORS.muted,
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  stateRow: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  stateBlock: {
    minHeight: 60,
    justifyContent: 'center',
  },
  stateTitle: {
    color: COLORS.secondary,
    fontSize: 14,
    fontWeight: '800',
    marginBottom: 4,
  },
  stateTitleError: {
    color: COLORS.error,
  },
  stateText: {
    flexShrink: 1,
    color: COLORS.muted,
    fontSize: 13,
    lineHeight: 18,
  },
  terrainGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -6,
  },
  terrainItem: {
    minWidth: 140,
    flexBasis: '50%',
    flexGrow: 1,
    minHeight: 54,
    paddingHorizontal: 6,
    paddingVertical: 7,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  terrainText: {
    flex: 1,
    minWidth: 0,
  },
  terrainLabel: {
    color: COLORS.muted,
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  terrainValue: {
    color: COLORS.text,
    fontSize: 14,
    lineHeight: 19,
    fontWeight: '700',
  },
  availabilityNote: {
    marginTop: 14,
    paddingVertical: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  availabilityText: {
    flex: 1,
    color: COLORS.secondary,
    fontSize: 12,
    lineHeight: 17,
  },
  selectedDaySection: {
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  selectedDayHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    marginBottom: 10,
  },
  selectedDate: {
    color: COLORS.text,
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '800',
    textTransform: 'capitalize',
  },
  missingBadge: {
    color: COLORS.warning,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.7,
  },
  metricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -4,
  },
  metric: {
    flexGrow: 0,
    flexShrink: 0,
    minWidth: 0,
    paddingHorizontal: 4,
    paddingVertical: 6,
  },
  metricLabel: {
    color: COLORS.muted,
    fontSize: 10,
    lineHeight: 14,
    textTransform: 'uppercase',
    fontWeight: '800',
  },
  metricValue: {
    color: COLORS.text,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  chartsSection: {
    paddingTop: 2,
  },
  retryButton: {
    minHeight: 46,
    marginTop: 18,
    paddingHorizontal: 18,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: COLORS.surfaceRaised,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
  },
  retryText: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '800',
  },
});
