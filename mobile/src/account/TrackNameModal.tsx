import React from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

export function TrackNameModal(props: {
  visible: boolean;
  title: string;
  description?: string;
  value: string;
  error: string | null;
  busy?: boolean;
  confirmLabel?: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal visible={props.visible} transparent animationType="fade" onRequestClose={props.busy ? undefined : props.onCancel}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.card} accessibilityViewIsModal>
          <Text style={styles.title}>{props.title}</Text>
          {props.description ? <Text style={styles.description}>{props.description}</Text> : null}
          <Text style={styles.label}>Nome percorso</Text>
          <TextInput
            autoFocus
            value={props.value}
            onChangeText={props.onChange}
            editable={!props.busy}
            maxLength={120}
            returnKeyType="done"
            onSubmitEditing={props.onConfirm}
            placeholder="Es. Bosco del Monte"
            placeholderTextColor="#6e7d70"
            style={[styles.input, props.error && styles.inputError]}
            accessibilityLabel="Nome del percorso"
          />
          {props.error ? <Text style={styles.error} accessibilityRole="alert">{props.error}</Text> : null}
          <View style={styles.actions}>
            <TouchableOpacity style={styles.secondaryButton} onPress={props.onCancel} disabled={props.busy} accessibilityRole="button">
              <Text style={styles.secondaryText}>Annulla</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.primaryButton} onPress={props.onConfirm} disabled={props.busy} accessibilityRole="button">
              {props.busy ? <ActivityIndicator size="small" color="#0a110b" /> : null}
              <Text style={styles.primaryText}>{props.confirmLabel ?? 'Salva'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { width: '100%', maxWidth: 420, borderRadius: 13, borderWidth: 1, borderColor: '#344a38', backgroundColor: '#121b13', padding: 18, gap: 10 },
  title: { color: '#eef5ee', fontSize: 20, fontWeight: '800' },
  description: { color: '#9aab9c', fontSize: 13, lineHeight: 19 },
  label: { color: '#cbd8cd', fontSize: 12, fontWeight: '700', marginTop: 3 },
  input: { minHeight: 46, borderRadius: 8, borderWidth: 1, borderColor: '#3a503e', backgroundColor: '#0a110b', color: '#eef5ee', paddingHorizontal: 12, fontSize: 15 },
  inputError: { borderColor: '#ef7474' },
  error: { color: '#ffaaaa', fontSize: 12, lineHeight: 17 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 5 },
  secondaryButton: { minHeight: 42, borderRadius: 8, borderWidth: 1, borderColor: '#344a38', paddingHorizontal: 15, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { color: '#eef5ee', fontSize: 13, fontWeight: '700' },
  primaryButton: { minHeight: 42, borderRadius: 8, backgroundColor: '#63c779', paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  primaryText: { color: '#0a110b', fontSize: 13, fontWeight: '800' },
});
