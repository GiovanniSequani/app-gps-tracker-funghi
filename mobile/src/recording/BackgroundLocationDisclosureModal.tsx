import React from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { MapPin } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export function BackgroundLocationDisclosureModal(props: {
  visible: boolean;
  onContinue: () => void;
  onCancel: () => void;
}) {
  const { visible, onContinue, onCancel } = props;

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      statusBarTranslucent
      onRequestClose={onCancel}
    >
      <SafeAreaView style={styles.backdrop}>
        <View style={styles.card} accessibilityViewIsModal>
          <View style={styles.iconBox} accessible={false}>
            <MapPin size={26} color="#78d98b" strokeWidth={2.2} />
          </View>

          <Text style={styles.title}>Posizione in background</Text>
          <Text style={styles.disclosure}>
            Funghi Tracker raccoglie dati sulla posizione per registrare il percorso anche quando l’app non è in uso.
          </Text>
          <Text style={styles.reason}>
            Serve per non interrompere la traccia quando blocchi lo schermo o passi a un’altra app. La registrazione parte solo quando la avvii e termina quando premi “Termina”.
          </Text>

          <View style={styles.actions}>
            <TouchableOpacity
              style={styles.continueButton}
              onPress={onContinue}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel="Continua alla richiesta della posizione in background"
            >
              <Text style={styles.continueText}>Continua</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.cancelButton}
              onPress={onCancel}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel="Non concedere ora la posizione in background"
            >
              <Text style={styles.cancelText}>Non ora</Text>
            </TouchableOpacity>
          </View>
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
    backgroundColor: 'rgba(3, 8, 5, 0.84)',
  },
  card: {
    width: '100%',
    maxWidth: 380,
    alignSelf: 'center',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#38523e',
    backgroundColor: '#111a13',
    padding: 20,
  },
  iconBox: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#38523e',
    backgroundColor: '#182a1c',
    marginBottom: 16,
  },
  title: {
    color: '#f2f6f2',
    fontSize: 22,
    fontWeight: '900',
    lineHeight: 28,
    marginBottom: 10,
  },
  disclosure: {
    color: '#dde8cc',
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 23,
  },
  reason: {
    color: '#aebcaf',
    fontSize: 14,
    lineHeight: 20,
    marginTop: 10,
  },
  actions: { marginTop: 22, gap: 8 },
  continueButton: {
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#63c779',
    backgroundColor: '#173e22',
  },
  continueText: { color: '#8ce89e', fontSize: 16, fontWeight: '800' },
  cancelButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: { color: '#b8c3ba', fontSize: 15, fontWeight: '700' },
});
