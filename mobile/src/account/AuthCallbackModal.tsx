import React from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { KeyRound, MailCheck, X } from 'lucide-react-native';
import { updateRecoveredPassword, verifyAuthCallback } from './client';
import type { AuthCallbackRequest } from './authCallbacks';
import type { AuthDeepLinkState } from './useAuthDeepLinks';
import { toAccountError } from './validation';

const COLORS = {
  bg: '#0a110b', panel: '#121b13', border: '#2d4030', text: '#eef5ee',
  muted: '#9aab9c', green: '#63c779', error: '#ffaaaa',
};

export function AuthCallbackModal(props: {
  state: AuthDeepLinkState;
  onAcquired: () => void;
  onDismiss: () => void;
  onComplete: () => void;
}) {
  const requestRef = React.useRef<AuthCallbackRequest | null>(null);
  const [callback, setCallback] = React.useState<
    { status: 'ready'; kind: AuthCallbackRequest['kind'] } | { status: 'invalid' } | null
  >(null);
  const [phase, setPhase] = React.useState<'approval' | 'password' | 'success'>('approval');
  const [password, setPassword] = React.useState('');
  const [passwordConfirm, setPasswordConfirm] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!props.state) return;
    requestRef.current = props.state.status === 'pending' ? props.state.request : null;
    setCallback(props.state.status === 'pending'
      ? { status: 'ready', kind: props.state.request.kind }
      : { status: 'invalid' });
    setPhase('approval');
    setPassword('');
    setPasswordConfirm('');
    setBusy(false);
    setError(null);
    // React Native non espone una history da riscrivere: il link grezzo non
    // viene conservato e lo stato esterno viene rimosso appena acquisito.
    props.onAcquired();
  }, [props.state, props.onAcquired]);

  const close = React.useCallback(() => {
    if (busy) return;
    requestRef.current = null;
    setCallback(null);
    props.onDismiss();
  }, [busy, props.onDismiss]);

  const complete = React.useCallback(() => {
    if (busy) return;
    requestRef.current = null;
    setCallback(null);
    props.onComplete();
  }, [busy, props.onComplete]);

  const approve = async () => {
    const request = requestRef.current;
    if (!request || busy) return;
    setBusy(true);
    setError(null);
    try {
      await verifyAuthCallback(request);
      requestRef.current = null;
      setPhase(request.kind === 'recovery' ? 'password' : 'success');
    } catch (reason) {
      setError(toAccountError(reason).message);
    } finally {
      setBusy(false);
    }
  };

  const savePassword = async () => {
    setError(null);
    if (password.length < 8) {
      setError('Usa una password di almeno 8 caratteri.');
      return;
    }
    if (password !== passwordConfirm) {
      setError('Le password non coincidono.');
      return;
    }
    setBusy(true);
    try {
      await updateRecoveredPassword(password);
      setPassword('');
      setPasswordConfirm('');
      setPhase('success');
    } catch (reason) {
      setError(toAccountError(reason).message);
    } finally {
      setBusy(false);
    }
  };

  const invalid = callback?.status === 'invalid'
    || (callback === null && props.state?.status === 'invalid');
  const visible = props.state !== null || callback !== null;
  const callbackKind = callback?.status === 'ready'
    ? callback.kind
    : props.state?.status === 'pending'
      ? props.state.request.kind
      : null;
  const isRecovery = callbackKind === 'recovery';

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={close}
    >
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={StyleSheet.absoluteFill} onPress={busy ? undefined : close} accessibilityLabel="Chiudi" />
        <View style={styles.card} accessibilityViewIsModal>
          <TouchableOpacity style={styles.close} onPress={close} disabled={busy} accessibilityRole="button" accessibilityLabel="Chiudi">
            <X size={20} color={COLORS.muted} />
          </TouchableOpacity>

          {isRecovery ? <KeyRound size={34} color={COLORS.green} /> : <MailCheck size={34} color={COLORS.green} />}
          <Text style={styles.title}>{isRecovery ? 'Reimposta password' : 'Conferma email'}</Text>

          {invalid && <>
            <Text style={styles.body}>Il link non è valido o non è completo. Richiedi un nuovo messaggio e riprova.</Text>
            <TouchableOpacity style={styles.secondary} onPress={close}><Text style={styles.secondaryText}>Chiudi</Text></TouchableOpacity>
          </>}

          {!invalid && phase === 'approval' && <>
            <Text style={styles.body}>
              {isRecovery
                ? 'Tocca il pulsante per verificare il link e scegliere una nuova password.'
                : 'Tocca il pulsante per completare la conferma del tuo indirizzo email.'}
            </Text>
            {error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
            <TouchableOpacity style={[styles.primary, busy && styles.disabled]} disabled={busy} onPress={() => void approve()} accessibilityRole="button">
              {busy && <ActivityIndicator size="small" color={COLORS.bg} />}
              <Text style={styles.primaryText}>{busy ? 'Verifica…' : isRecovery ? 'Verifica link' : 'Conferma email'}</Text>
            </TouchableOpacity>
          </>}

          {!invalid && phase === 'password' && <>
            <Text style={styles.body}>Scegli la nuova password per il tuo account.</Text>
            <Text style={styles.label}>Nuova password</Text>
            <TextInput style={styles.input} value={password} onChangeText={setPassword} secureTextEntry textContentType="newPassword" autoCapitalize="none" accessibilityLabel="Nuova password" />
            <Text style={styles.label}>Ripeti password</Text>
            <TextInput style={styles.input} value={passwordConfirm} onChangeText={setPasswordConfirm} secureTextEntry textContentType="newPassword" autoCapitalize="none" accessibilityLabel="Ripeti nuova password" />
            {error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
            <TouchableOpacity style={[styles.primary, busy && styles.disabled]} disabled={busy} onPress={() => void savePassword()} accessibilityRole="button">
              {busy && <ActivityIndicator size="small" color={COLORS.bg} />}
              <Text style={styles.primaryText}>{busy ? 'Salvataggio…' : 'Salva nuova password'}</Text>
            </TouchableOpacity>
          </>}

          {!invalid && phase === 'success' && <>
            <Text style={styles.body}>
              {isRecovery ? 'Password aggiornata. Ora puoi continuare a usare il tuo account.' : 'Email confermata. Il tuo account è pronto.'}
            </Text>
            <TouchableOpacity style={styles.primary} onPress={complete} accessibilityRole="button"><Text style={styles.primaryText}>Torna alla mappa</Text></TouchableOpacity>
          </>}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', alignItems: 'center', justifyContent: 'center', padding: 22 },
  card: { width: '100%', maxWidth: 390, borderRadius: 16, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.panel, padding: 22, gap: 12 },
  close: { position: 'absolute', top: 10, right: 10, width: 40, height: 40, alignItems: 'center', justifyContent: 'center', zIndex: 1 },
  title: { color: COLORS.text, fontSize: 21, fontWeight: '800', paddingRight: 34 },
  body: { color: COLORS.muted, fontSize: 14, lineHeight: 21 },
  label: { color: COLORS.text, fontSize: 12, fontWeight: '700', marginTop: 2 },
  input: { minHeight: 46, borderWidth: 1, borderColor: COLORS.border, borderRadius: 9, color: COLORS.text, paddingHorizontal: 12, backgroundColor: COLORS.bg },
  primary: { minHeight: 46, borderRadius: 9, backgroundColor: COLORS.green, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  primaryText: { color: COLORS.bg, fontSize: 14, fontWeight: '800' },
  secondary: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { color: COLORS.text, fontWeight: '700' },
  error: { color: COLORS.error, fontSize: 12, lineHeight: 18 },
  disabled: { opacity: 0.55 },
});
