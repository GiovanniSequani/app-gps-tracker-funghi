import React from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Pause, Play, Plus } from 'lucide-react-native';

const COLORS = {
  panel: 'rgba(10,17,11,0.96)', border: '#2d4030', text: '#dde8cc', muted: '#8ba67a',
  red: '#c44040', redText: '#ffaaaa', amber: '#e8a040', green: '#6db85f',
  porcino: '#563821', porcinoBorder: '#b07a50', finferlo: '#e0aa30',
};

type SessionProps = {
  paused: boolean;
  busy: boolean;
  pointCount: number;
  onPause: () => void;
  onFinish: () => void;
};

/** Secondary controls live at the top of the map, away from the add buttons. */
export function RecordingSessionControls({ paused, busy, pointCount, onPause, onFinish }: SessionProps) {
  const confirmFinish = () => {
    if (busy) return;
    Alert.alert('Terminare la registrazione?', 'Potrai salvare il percorso nella schermata successiva.', [
      { text: 'Annulla', style: 'cancel' },
      { text: 'Termina', style: 'destructive', onPress: onFinish },
    ], { cancelable: true });
  };

  return (
    <View style={styles.session}>
      <View style={styles.summary}>
        <View style={styles.status} accessibilityLiveRegion="polite">
          <View style={[styles.dot, paused && styles.pausedDot]} />
          <Text style={[styles.statusText, paused && styles.pausedText]}>
            {paused ? 'In pausa' : 'Registrazione attiva'}
          </Text>
        </View>
        <Text style={styles.gps} accessibilityLabel={`${pointCount} punti GPS registrati`}>GPS {pointCount}</Text>
      </View>
      <View style={styles.sessionActions}>
        {!paused && <TouchableOpacity
          style={[styles.pauseButton, busy && styles.disabled]}
          onPress={onPause}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Metti in pausa la registrazione"
          accessibilityState={{ disabled: busy }}
          activeOpacity={0.75}
        >
          <Pause size={18} color={COLORS.amber} />
          <Text style={styles.pauseText}>Pausa</Text>
        </TouchableOpacity>}
        <TouchableOpacity
          style={[styles.finishButton, busy && styles.disabled]}
          onPress={confirmFinish}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Termina registrazione"
          accessibilityHint="Chiede conferma prima di terminare e passare al salvataggio"
          accessibilityState={{ disabled: busy }}
          activeOpacity={0.75}
        >
          <Text style={styles.finishText}>Termina</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

type FieldProps = {
  paused: boolean;
  busy: boolean;
  hasPoints: boolean;
  porciniCount: number;
  finferliCount: number;
  onAdd: (species: 'Porcino' | 'Finferlo') => void;
  onResume: () => void;
};

/** Only immediate field actions occupy the thumb area at the bottom. */
export function RecordingFieldControls(props: FieldProps) {
  if (props.paused) return (
    <TouchableOpacity
      style={[styles.resumeButton, props.busy && styles.disabled]}
      onPress={props.onResume}
      disabled={props.busy}
      accessibilityRole="button"
      accessibilityLabel="Riprendi registrazione"
      accessibilityState={{ disabled: props.busy }}
      activeOpacity={0.75}
    >
      <Play size={22} color={COLORS.text} />
      <Text style={styles.resumeText}>Riprendi</Text>
    </TouchableOpacity>
  );

  const disabled = props.busy || !props.hasPoints;
  return (
    <View style={styles.findingsRow}>
      <TouchableOpacity
        style={[styles.addButton, styles.porcinoButton, disabled && styles.disabled]}
        onPress={() => props.onAdd('Porcino')}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`Aggiungi porcino. Trovati finora: ${props.porciniCount}`}
        accessibilityState={{ disabled }}
        activeOpacity={0.75}
      >
        <Plus size={24} color="#fff4e8" />
        <Text style={styles.porcinoText}>Porcino</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.addButton, styles.finferloButton, disabled && styles.disabled]}
        onPress={() => props.onAdd('Finferlo')}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`Aggiungi finferlo. Trovati finora: ${props.finferliCount}`}
        accessibilityState={{ disabled }}
        activeOpacity={0.75}
      >
        <Plus size={24} color="#241b07" />
        <Text style={styles.finferloText}>Finferlo</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  session: { backgroundColor: COLORS.panel, borderColor: COLORS.border, borderWidth: 1, borderRadius: 12, padding: 10, gap: 10 },
  summary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
  status: { flexDirection: 'row', alignItems: 'center', gap: 7, flexShrink: 1 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.red },
  pausedDot: { backgroundColor: COLORS.amber },
  statusText: { color: COLORS.text, fontSize: 14, lineHeight: 20, fontWeight: '700', flexShrink: 1 },
  pausedText: { color: COLORS.amber },
  gps: { color: COLORS.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
  sessionActions: { flexDirection: 'row', justifyContent: 'space-between', gap: 28, flexWrap: 'wrap' },
  pauseButton: { minHeight: 48, borderRadius: 8, borderWidth: 1, borderColor: COLORS.border, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingHorizontal: 14, paddingVertical: 8 },
  pauseText: { color: COLORS.text, fontSize: 15, fontWeight: '600' },
  finishButton: { minHeight: 48, borderRadius: 8, borderWidth: 1, borderColor: '#74433e', paddingHorizontal: 16, paddingVertical: 8, alignItems: 'center', justifyContent: 'center', marginLeft: 'auto' },
  finishText: { color: COLORS.redText, fontSize: 15, fontWeight: '600' },
  findingsRow: { flexDirection: 'row', gap: 12 },
  addButton: { flex: 1, minHeight: 64, borderRadius: 12, borderWidth: 1.5, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, paddingHorizontal: 8 },
  porcinoButton: { backgroundColor: COLORS.porcino, borderColor: COLORS.porcinoBorder },
  finferloButton: { backgroundColor: COLORS.finferlo, borderColor: '#f3cc72' },
  porcinoText: { color: '#fff4e8', fontSize: 18, fontWeight: '700', flexShrink: 1 },
  finferloText: { color: '#241b07', fontSize: 18, fontWeight: '700', flexShrink: 1 },
  resumeButton: { minHeight: 64, borderRadius: 12, borderWidth: 1.5, borderColor: COLORS.green, backgroundColor: '#2e5528', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 12 },
  resumeText: { color: COLORS.text, fontSize: 18, fontWeight: '700' },
  disabled: { opacity: 0.45 },
});
