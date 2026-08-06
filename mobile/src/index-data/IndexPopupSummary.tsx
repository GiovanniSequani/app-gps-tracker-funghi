import React from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { RefreshCw } from 'lucide-react-native';
import { formatItalianDate } from '../point-details/labels';
import type { PointCoordinate } from '../point-details/types';
import { useIndexPoint } from './useIndexPoint';

const COLORS = {
  text: '#DDE8CC',
  muted: '#8BA67A',
  border: '#2D4030',
  surface: '#111A12',
  surfaceRaised: '#18231A',
  error: '#F0AAA0',
  warning: '#EFC077',
  green: '#6DB85F',
};

const scoreFormatter = new Intl.NumberFormat('it-IT', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

function scoreLabel(value: number | null): string {
  return value === null ? 'N/D' : scoreFormatter.format(value);
}

export function IndexPopupSummary({ point }: { point: PointCoordinate }) {
  const { state, retry } = useIndexPoint(point, true);

  if (state.status === 'loading') {
    return (
      <View style={styles.loading} accessibilityLiveRegion="polite">
        <ActivityIndicator color={COLORS.green} size="small" />
        <Text style={styles.message}>Caricamento indice più recente…</Text>
      </View>
    );
  }

  if (state.status === 'ready') {
    return (
      <View style={styles.summary} accessibilityLiveRegion="polite">
        <View style={styles.dateRow}>
          <Text style={styles.label}>Indice</Text>
          <Text style={styles.date}>{formatItalianDate(state.data.indexDate)}</Text>
        </View>
        <View style={styles.scores}>
          <View style={styles.score}>
            <Text style={styles.label}>Porcini</Text>
            <Text style={styles.scoreValue}>{scoreLabel(state.data.porciniScore)}</Text>
          </View>
          <View style={styles.score}>
            <Text style={styles.label}>Finferli</Text>
            <Text style={styles.scoreValue}>{scoreLabel(state.data.finferliScore)}</Text>
          </View>
        </View>
      </View>
    );
  }

  const outside = state.status === 'outside';
  return (
    <View style={styles.errorRow} accessibilityLiveRegion="polite">
      <Text style={[styles.message, outside ? styles.warning : styles.error]} numberOfLines={2}>
        {outside
          ? 'Punto fuori copertura dell’indice.'
          : state.message ?? 'Indice non disponibile.'}
      </Text>
      {!outside && (
        <TouchableOpacity
          onPress={retry}
          style={styles.retry}
          accessibilityRole="button"
          accessibilityLabel="Riprova il caricamento dell’indice"
        >
          <RefreshCw size={13} color={COLORS.error} />
          <Text style={styles.retryText}>Riprova</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  summary: {
    minHeight: 70,
    gap: 7,
    padding: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 6,
    backgroundColor: COLORS.surface,
  },
  loading: {
    minHeight: 70,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    padding: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 6,
    backgroundColor: COLORS.surface,
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  label: {
    color: COLORS.muted,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  date: { color: '#CBD7C2', fontSize: 10, fontWeight: '700' },
  scores: { flexDirection: 'row', gap: 7 },
  score: {
    flex: 1,
    minWidth: 0,
    minHeight: 34,
    paddingHorizontal: 7,
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    borderRadius: 5,
    backgroundColor: COLORS.surfaceRaised,
  },
  scoreValue: {
    color: COLORS.text,
    fontSize: 15,
    lineHeight: 31,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  errorRow: {
    minHeight: 70,
    padding: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 6,
    backgroundColor: COLORS.surface,
  },
  message: { flex: 1, color: COLORS.muted, fontSize: 10, lineHeight: 14 },
  error: { color: COLORS.error },
  warning: { color: COLORS.warning },
  retry: {
    minHeight: 29,
    paddingHorizontal: 7,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: '#574341',
    borderRadius: 5,
    backgroundColor: '#281B1A',
  },
  retryText: { color: COLORS.error, fontSize: 9, fontWeight: '800' },
});
