import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { LogIn, UserPlus } from 'lucide-react-native';
import type { ArchiveConfig } from './types';
import { normalizeUsername, validateUsername } from './validation';

export type AuthView = 'login' | 'register';

const COLORS = { bg: '#0a110b', panel: '#121b13', panel2: '#18231a', border: '#2d4030', text: '#eef5ee', muted: '#9aab9c', green: '#63c779' };

function ConsentRow(props: { checked: boolean; onPress: () => void; children: React.ReactNode }) {
  return (
    <TouchableOpacity style={styles.consentRow} onPress={props.onPress} accessibilityRole="checkbox" accessibilityState={{ checked: props.checked }}>
      <View style={[styles.checkbox, props.checked && styles.checkboxChecked]}>{props.checked && <Text style={styles.checkmark}>✓</Text>}</View>
      <Text style={styles.consentText}>{props.children}</Text>
    </TouchableOpacity>
  );
}

export function AccountAuthForm(props: {
  view: AuthView;
  config: ArchiveConfig | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
  onViewChange: (view: AuthView) => void;
  onLogin: (email: string, password: string) => Promise<void>;
  onRegister: (email: string, password: string, username: string) => Promise<void>;
}) {
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [username, setUsername] = React.useState('');
  const [acceptTerms, setAcceptTerms] = React.useState(false);
  const [acceptPrivacy, setAcceptPrivacy] = React.useState(false);
  const [acceptResearch, setAcceptResearch] = React.useState(false);
  const [localError, setLocalError] = React.useState<string | null>(null);

  const submit = async () => {
    setLocalError(null);
    if (!email.trim() || !password) return setLocalError('Inserisci email e password.');
    if (props.view === 'register') {
      const usernameError = validateUsername(username);
      if (usernameError) return setLocalError(usernameError);
      if (!acceptTerms || !acceptPrivacy || !acceptResearch) {
        return setLocalError('Per registrarti devi accettare tutti e tre i consensi richiesti.');
      }
      await props.onRegister(email, password, normalizeUsername(username));
      return;
    }
    await props.onLogin(email, password);
  };

  return (
    <View style={styles.root}>
      <View style={styles.tabs} accessibilityRole="tablist">
        {(['login', 'register'] as AuthView[]).map((view) => (
          <TouchableOpacity key={view} style={[styles.tab, props.view === view && styles.tabActive]} onPress={() => props.onViewChange(view)} accessibilityRole="tab" accessibilityState={{ selected: props.view === view }}>
            {view === 'login' ? <LogIn size={16} color={COLORS.text} /> : <UserPlus size={16} color={COLORS.text} />}
            <Text style={styles.tabText}>{view === 'login' ? 'Accedi' : 'Registrati'}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {props.view === 'register' && (
        <>
          <Text style={styles.label}>Username</Text>
          <TextInput value={username} onChangeText={(value) => setUsername(value.toLowerCase())} style={styles.input} autoCapitalize="none" autoCorrect={false} maxLength={24} textContentType="username" accessibilityLabel="Username" />
          <Text style={styles.hint}>3-24 caratteri: lettere minuscole, numeri e underscore.</Text>
        </>
      )}
      <Text style={styles.label}>Email</Text>
      <TextInput value={email} onChangeText={setEmail} style={styles.input} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} textContentType="emailAddress" accessibilityLabel="Email" />
      <Text style={styles.label}>Password</Text>
      <TextInput value={password} onChangeText={setPassword} style={styles.input} secureTextEntry textContentType={props.view === 'login' ? 'password' : 'newPassword'} accessibilityLabel="Password" />
      {props.view === 'register' && (
        <View style={styles.consents}>
          {!props.config && <Text style={styles.hint}>Caricamento versioni legali…</Text>}
          <ConsentRow checked={acceptTerms} onPress={() => setAcceptTerms((value) => !value)}>Accetto i termini di utilizzo dell’archivio GPX{props.config ? ` · versione ${props.config.terms_version}` : ''}</ConsentRow>
          <ConsentRow checked={acceptPrivacy} onPress={() => setAcceptPrivacy((value) => !value)}>Ho letto e accetto il trattamento dei dati per account e archivio privato{props.config ? ` · versione ${props.config.privacy_version}` : ''}</ConsentRow>
          <ConsentRow checked={acceptResearch} onPress={() => setAcceptResearch((value) => !value)}>Acconsento all’uso per ricerca dei GPX raw in forma anonima, senza user ID, nome file o percorso Storage{props.config ? ` · versione ${props.config.research_consent_version}` : ''}</ConsentRow>
        </View>
      )}
      {(localError || props.error) && <Text style={styles.error} accessibilityRole="alert">{localError ?? props.error}</Text>}
      {props.notice && <Text style={styles.success}>{props.notice}</Text>}
      <TouchableOpacity style={[styles.primary, (props.busy || (props.view === 'register' && !props.config)) && styles.disabled]} disabled={props.busy || (props.view === 'register' && !props.config)} onPress={() => void submit()} accessibilityRole="button">
        {props.busy && <ActivityIndicator size="small" color={COLORS.bg} />}
        <Text style={styles.primaryText}>{props.busy ? 'Attendi…' : props.view === 'login' ? 'Accedi' : 'Crea account'}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignSelf: 'stretch', marginTop: 8, gap: 8, borderTopWidth: 1, borderTopColor: COLORS.border, paddingTop: 16 },
  tabs: { flexDirection: 'row', gap: 8, marginBottom: 5 },
  tab: { flex: 1, minHeight: 42, borderRadius: 8, borderWidth: 1, borderColor: COLORS.border, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center' },
  tabActive: { backgroundColor: COLORS.panel2, borderColor: COLORS.green },
  tabText: { color: COLORS.text, fontWeight: '700' },
  label: { color: COLORS.text, fontSize: 12, fontWeight: '700', marginTop: 4 },
  input: { minHeight: 44, borderWidth: 1, borderColor: COLORS.border, borderRadius: 8, backgroundColor: COLORS.panel, color: COLORS.text, paddingHorizontal: 12 },
  hint: { color: COLORS.muted, fontSize: 11, lineHeight: 16 },
  consents: { gap: 10, marginVertical: 8 },
  consentRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  checkbox: { width: 22, height: 22, borderRadius: 5, borderWidth: 1, borderColor: COLORS.border, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  checkboxChecked: { backgroundColor: COLORS.green, borderColor: COLORS.green },
  checkmark: { color: COLORS.bg, fontWeight: '900' },
  consentText: { flex: 1, color: COLORS.text, fontSize: 12, lineHeight: 18 },
  primary: { minHeight: 44, borderRadius: 9, backgroundColor: COLORS.green, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  primaryText: { color: COLORS.bg, fontWeight: '800', fontSize: 14 },
  disabled: { opacity: 0.5 },
  error: { color: '#ffaaaa', fontSize: 12, lineHeight: 18 },
  success: { color: '#9be9aa', fontSize: 12, lineHeight: 18 },
});
