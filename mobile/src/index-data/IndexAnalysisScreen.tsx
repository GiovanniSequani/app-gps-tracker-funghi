import React from 'react';
import {
  ActivityIndicator,
  BackHandler,
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
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  HelpCircle,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { formatItalianDate } from '../point-details/labels';
import type { PointCoordinate } from '../point-details/types';
import { buildPorciniAnalysis, type IndexAnalysisFactor } from './analysis';
import {
  FINFERLI_DIAGNOSTICS_MESSAGE,
  FINFERLI_DIAGNOSTICS_TITLE,
} from './messages';
import type { IndexPointLoader, IndexSpecies } from './types';
import { useIndexPoint } from './useIndexPoint';

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
  greenSurface: '#14251A',
  greenBorder: '#477D56',
  coral: '#F09B87',
  coralSurface: '#2B1916',
  coralBorder: '#875246',
  warning: '#E4B25D',
};

const scoreFormatter = new Intl.NumberFormat('it-IT', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

function formatScore(value: number | null): string {
  return value === null ? 'N/D' : scoreFormatter.format(value);
}

function Score({ label, value }: { label: string; value: number | null }) {
  return (
    <View style={styles.scoreItem} accessible accessibilityLabel={`${label}: ${formatScore(value)} su 100`}>
      <Text style={styles.scoreLabel}>{label}</Text>
      <View style={styles.scoreValueRow}>
        <Text style={styles.scoreValue} numberOfLines={1} adjustsFontSizeToFit>
          {formatScore(value)}
        </Text>
        <Text style={styles.scoreUnit}>/100</Text>
      </View>
    </View>
  );
}

function Factor({ factor }: { factor: IndexAnalysisFactor }) {
  const [helpOpen, setHelpOpen] = React.useState(false);
  const favorable = factor.tone === 'favorable';
  const accent = favorable ? COLORS.green : COLORS.coral;
  return (
    <View style={styles.factor} accessible={false}>
      <View style={styles.factorHeading}>
        <View style={styles.factorTitleRow}>
          <Text style={styles.factorTitle}>{factor.title}</Text>
          <TouchableOpacity
            onPress={() => setHelpOpen((open) => !open)}
            style={styles.helpButton}
            accessibilityRole="button"
            accessibilityLabel={`Spiega ${factor.title}`}
            accessibilityState={{ expanded: helpOpen }}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          >
            <HelpCircle size={17} color={COLORS.secondary} />
          </TouchableOpacity>
        </View>
        <View
          style={[
            styles.rating,
            { borderColor: favorable ? COLORS.greenBorder : COLORS.coralBorder },
          ]}
        >
          <Text style={[styles.ratingText, { color: accent }]}>{factor.evidence}</Text>
        </View>
      </View>
      {helpOpen && (
        <View style={styles.helpDisclosure} accessibilityLiveRegion="polite">
          <Text style={styles.helpText}>{factor.help}</Text>
        </View>
      )}
      <View style={styles.detailList}>
        {factor.details.map((detail) => (
          <View key={detail} style={styles.detailRow}>
            <View style={[styles.detailBullet, { backgroundColor: accent }]} />
            <Text style={styles.detailText}>{detail}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function FactorSection({
  title,
  tone,
  factors,
}: {
  title: string;
  tone: 'favorable' | 'unfavorable';
  factors: IndexAnalysisFactor[];
}) {
  const favorable = tone === 'favorable';
  const Icon = favorable ? CheckCircle2 : TriangleAlert;
  const accent = favorable ? COLORS.green : COLORS.coral;
  return (
    <View
      style={[
        styles.factorSection,
        { backgroundColor: favorable ? COLORS.greenSurface : COLORS.coralSurface },
      ]}
    >
      <View
        style={[
          styles.factorSectionHeader,
          { borderLeftColor: accent },
        ]}
      >
        <View style={styles.factorSectionTitle}>
          <Icon size={18} color={accent} />
          <Text style={[styles.factorSectionTitleText, { color: accent }]}>{title}</Text>
        </View>
        <Text style={[styles.factorCount, { color: accent, borderColor: accent }]}>
          {factors.length}
        </Text>
      </View>
      {factors.length === 0 ? (
        <Text style={styles.emptyText}>Nessun fattore disponibile in questa categoria.</Text>
      ) : (
        factors.map((factor) => <Factor key={factor.id} factor={factor} />)
      )}
    </View>
  );
}

export default function IndexAnalysisScreen({
  point,
  initialSpecies,
  onClose,
  loader,
}: {
  point: PointCoordinate;
  initialSpecies: IndexSpecies;
  onClose: () => void;
  loader?: IndexPointLoader;
}) {
  const { state, retry } = useIndexPoint(point, true, loader);
  const { width: windowWidth } = useWindowDimensions();
  const [species, setSpecies] = React.useState<IndexSpecies>(initialSpecies);

  React.useEffect(() => {
    setSpecies(initialSpecies);
  }, [initialSpecies, point.latitude, point.longitude]);

  React.useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose]);

  const analysis = state.status === 'ready' ? buildPorciniAnalysis(state.data) : null;

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <StatusBar barStyle="light-content" backgroundColor={COLORS.background} />
      <View style={styles.header}>
        <TouchableOpacity
          onPress={onClose}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel="Torna alla mappa"
        >
          <ArrowLeft size={22} color={COLORS.text} />
        </TouchableOpacity>
        <View style={styles.headerText}>
          <Text style={styles.title}>Analisi indice</Text>
          <Text style={styles.coordinates}>
            {point.latitude.toFixed(5)}, {point.longitude.toFixed(5)}
          </Text>
          <Text style={styles.date}>
            {state.status === 'ready'
              ? `Indice del ${formatItalianDate(state.data.indexDate)}`
              : 'Ultimo indice disponibile'}
          </Text>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          { width: Math.min(windowWidth, 720) },
        ]}
      >
        {state.status === 'loading' && (
          <View style={styles.stateBlock} accessibilityLiveRegion="polite">
            <ActivityIndicator color={COLORS.green} />
            <Text style={styles.stateText}>Caricamento analisi dell’indice…</Text>
          </View>
        )}
        {state.status === 'outside' && (
          <View style={styles.stateBlock}>
            <Text style={styles.stateTitle}>Punto fuori copertura</Text>
            <Text style={styles.stateText}>La griglia dell’indice non copre questa coordinata.</Text>
          </View>
        )}
        {(state.status === 'error' || state.status === 'unavailable') && (
          <View style={styles.stateBlock}>
            <Text style={[styles.stateTitle, styles.stateError]}>Indice non disponibile</Text>
            <Text style={styles.stateText}>{state.message}</Text>
            <TouchableOpacity
              onPress={retry}
              style={styles.retryButton}
              accessibilityRole="button"
              accessibilityLabel="Riprova il caricamento dell’analisi indice"
            >
              <RefreshCw size={16} color={COLORS.text} />
              <Text style={styles.retryText}>Riprova</Text>
            </TouchableOpacity>
          </View>
        )}

        {state.status === 'ready' && (
          <>
            <View style={styles.scores} accessibilityRole="summary">
              <Score label="Porcini" value={state.data.porciniScore} />
              <View style={styles.scoreDivider} />
              <Score label="Finferli" value={state.data.finferliScore} />
            </View>

            <View style={styles.switch} accessibilityRole="tablist">
              {(['porcini', 'finferli'] as const).map((value) => {
                const selected = species === value;
                const label = value === 'porcini' ? 'Porcini' : 'Finferli';
                return (
                  <TouchableOpacity
                    key={value}
                    onPress={() => setSpecies(value)}
                    style={[styles.switchButton, selected && styles.switchButtonSelected]}
                    accessibilityRole="tab"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`Analisi ${label}`}
                  >
                    <Text style={[styles.switchText, selected && styles.switchTextSelected]}>
                      {label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {species === 'finferli' ? (
              <View style={styles.finferliNotice}>
                <Text style={styles.noticeTitle}>{FINFERLI_DIAGNOSTICS_TITLE}</Text>
                <Text style={styles.noticeText}>{FINFERLI_DIAGNOSTICS_MESSAGE}</Text>
              </View>
            ) : (
              <>
                <FactorSection
                  title="Fattori favorevoli"
                  tone="favorable"
                  factors={analysis?.favorable ?? []}
                />
                <FactorSection
                  title="Fattori sfavorevoli"
                  tone="unfavorable"
                  factors={analysis?.unfavorable ?? []}
                />
              </>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, overflow: 'hidden', backgroundColor: COLORS.background },
  header: {
    minHeight: 88,
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
    marginRight: 9,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    borderRadius: 20,
    backgroundColor: COLORS.surfaceRaised,
  },
  headerText: { flex: 1, minWidth: 0 },
  title: { color: COLORS.text, fontSize: 20, lineHeight: 25, fontWeight: '900' },
  coordinates: { marginTop: 2, color: COLORS.secondary, fontSize: 13, fontVariant: ['tabular-nums'] },
  date: { marginTop: 2, color: COLORS.muted, fontSize: 12 },
  scroll: { flex: 1 },
  content: { maxWidth: 720, alignSelf: 'center', paddingBottom: 24 },
  stateBlock: { minHeight: 160, padding: 24, alignItems: 'center', justifyContent: 'center', gap: 10 },
  stateTitle: { color: COLORS.text, fontSize: 16, fontWeight: '800', textAlign: 'center' },
  stateText: { color: COLORS.muted, fontSize: 13, lineHeight: 19, textAlign: 'center' },
  stateError: { color: COLORS.coral },
  retryButton: {
    minHeight: 40,
    marginTop: 4,
    paddingHorizontal: 15,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    borderRadius: 7,
    backgroundColor: COLORS.surfaceRaised,
  },
  retryText: { color: COLORS.text, fontSize: 13, fontWeight: '800' },
  scores: { minHeight: 88, flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: COLORS.border, backgroundColor: COLORS.surface },
  scoreItem: { flex: 1, minWidth: 0, paddingHorizontal: 16, paddingVertical: 15 },
  scoreDivider: { width: StyleSheet.hairlineWidth, backgroundColor: COLORS.border },
  scoreLabel: { color: COLORS.muted, fontSize: 10, fontWeight: '800', letterSpacing: 0.7, textTransform: 'uppercase' },
  scoreValueRow: { minWidth: 0, marginTop: 3, flexDirection: 'row', alignItems: 'baseline' },
  scoreValue: { flexShrink: 1, color: COLORS.text, fontSize: 27, fontWeight: '900', fontVariant: ['tabular-nums'] },
  scoreUnit: { marginLeft: 3, color: COLORS.muted, fontSize: 11 },
  switch: { marginHorizontal: 16, marginTop: 16, padding: 3, flexDirection: 'row', gap: 3, borderWidth: 1, borderColor: COLORS.borderStrong, borderRadius: 8, backgroundColor: COLORS.background },
  switchButton: { flex: 1, minWidth: 0, minHeight: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 5 },
  switchButtonSelected: { backgroundColor: '#26372A' },
  switchText: { color: COLORS.muted, fontSize: 13, fontWeight: '800' },
  switchTextSelected: { color: COLORS.text },
  finferliNotice: { marginTop: 16, padding: 18, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  noticeTitle: { color: COLORS.text, fontSize: 16, fontWeight: '800' },
  noticeText: { minWidth: 0, marginTop: 8, color: COLORS.secondary, fontSize: 13, lineHeight: 20 },
  factorSection: { marginTop: 16, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  factorSectionHeader: { minHeight: 48, paddingHorizontal: 14, paddingVertical: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderLeftWidth: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.border },
  factorSectionTitle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  factorSectionTitleText: { fontSize: 14, fontWeight: '900' },
  factorCount: { minWidth: 26, paddingHorizontal: 7, paddingVertical: 2, borderWidth: 1, borderRadius: 999, fontSize: 11, fontWeight: '800', textAlign: 'center' },
  factor: { marginHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.border },
  factorHeading: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  factorTitleRow: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 7 },
  factorTitle: { flexShrink: 1, color: COLORS.text, fontSize: 13, fontWeight: '800' },
  helpButton: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  rating: { maxWidth: '47%', paddingHorizontal: 7, paddingVertical: 4, borderWidth: 1, borderRadius: 999 },
  ratingText: { fontSize: 10, lineHeight: 13, fontWeight: '800', textAlign: 'center' },
  helpDisclosure: { marginTop: 8, padding: 11, borderWidth: 1, borderColor: COLORS.borderStrong, borderRadius: 7, backgroundColor: COLORS.background },
  helpText: { color: COLORS.secondary, fontSize: 12, lineHeight: 18 },
  detailList: { marginTop: 9, gap: 7 },
  detailRow: { flexDirection: 'row', alignItems: 'flex-start' },
  detailBullet: { width: 5, height: 5, marginTop: 7, marginRight: 8, borderRadius: 3 },
  detailText: { flex: 1, minWidth: 0, color: COLORS.secondary, fontSize: 12, lineHeight: 18 },
  emptyText: { padding: 16, color: COLORS.muted, fontSize: 12 },
});
