import React from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { RecordingDraft } from './recordingDraft';

export function RecordingRecoveryModal(props: {
  draft: RecordingDraft | null;
  busy: boolean;
  error: string | null;
  onResume: () => void;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const { draft, busy, error, onResume, onSave, onDiscard } = props;
  const mushroomCount = draft?.markers.length ?? 0;
  return (
    <Modal
      visible={draft !== null}
      animationType="fade"
      transparent
      statusBarTranslucent
      onRequestClose={() => undefined}
    >
      <SafeAreaView style={styles.backdrop}>
        <View style={styles.card} accessibilityViewIsModal>
          <Text style={styles.eyebrow}>RECOVERY GPS</Text>
          <Text style={styles.title}>Registrazione interrotta senza salvataggio</Text>
          <Text style={styles.description}>
            È stata trovata una registrazione precedente. Puoi riprenderla oppure salvarla adesso.
          </Text>
          <View style={styles.summary}>
            <View style={styles.summaryItem}>
              <Text style={styles.summaryValue}>{draft?.path.length ?? 0}</Text>
              <Text style={styles.summaryLabel}>PUNTI GPS</Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.summaryItem}>
              <Text style={styles.summaryValue}>{mushroomCount}</Text>
              <Text style={styles.summaryLabel}>FUNGHI</Text>
            </View>
          </View>
          {!!error && <Text style={styles.error}>{error}</Text>}
          <TouchableOpacity
            style={[styles.action, styles.resumeAction, busy && styles.disabled]}
            onPress={onResume}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Riprendi la registrazione interrotta"
          >
            <Text style={styles.resumeText}>RIPRENDI</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.action, styles.saveAction, busy && styles.disabled]}
            onPress={onSave}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Salva la registrazione interrotta"
          >
            <Text style={styles.saveText}>SALVA</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.discardAction, busy && styles.disabled]}
            onPress={onDiscard}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Elimina la registrazione interrotta"
          >
            <Text style={styles.discardText}>ELIMINA REGISTRAZIONE</Text>
          </TouchableOpacity>
          {busy && <ActivityIndicator color="#78d98b" style={styles.activity} />}
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    padding: 20,
    backgroundColor: 'rgba(3, 8, 5, 0.82)',
  },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#38523e',
    backgroundColor: '#111a13',
    padding: 20,
    gap: 12,
  },
  eyebrow: { color: '#78d98b', fontSize: 10, fontWeight: '900', letterSpacing: 2 },
  title: { color: '#f2f6f2', fontSize: 22, fontWeight: '900', lineHeight: 28 },
  description: { color: '#b8c3ba', fontSize: 14, lineHeight: 20 },
  summary: {
    flexDirection: 'row',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2d3c30',
    backgroundColor: '#18221a',
    paddingVertical: 12,
  },
  summaryItem: { flex: 1, alignItems: 'center' },
  summaryValue: { color: '#f2f6f2', fontSize: 20, fontWeight: '900' },
  summaryLabel: { color: '#87948a', fontSize: 9, fontWeight: '800', letterSpacing: 1.2 },
  divider: { width: 1, backgroundColor: '#2d3c30' },
  error: { color: '#ff8d86', fontSize: 13, lineHeight: 18 },
  action: { minHeight: 48, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5 },
  resumeAction: { backgroundColor: '#173e22', borderColor: '#63c779' },
  saveAction: { backgroundColor: '#202b22', borderColor: '#526357' },
  resumeText: { color: '#8ce89e', fontSize: 13, fontWeight: '900', letterSpacing: 1.5 },
  saveText: { color: '#f2f6f2', fontSize: 13, fontWeight: '900', letterSpacing: 1.5 },
  discardAction: { minHeight: 40, alignItems: 'center', justifyContent: 'center' },
  discardText: { color: '#ff7770', fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  disabled: { opacity: 0.5 },
  activity: { position: 'absolute', right: 20, top: 20 },
});
