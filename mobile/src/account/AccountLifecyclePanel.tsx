import React from 'react';
import { Alert, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { AlertTriangle, Clock3, FileText, LockKeyhole, RefreshCw, Trash2 } from 'lucide-react-native';
import { bundledDocumentsMatch, canChangeLegalAcceptance, lifecycleStateCopy, type AccountAccess, type AccountLifecyclePublicConfig } from './lifecycle';
import { AccountRightsPanel } from './AccountRightsPanel';

const COLORS = { panel: '#121b13', panel2: '#18231a', border: '#2d4030', text: '#eef5ee', muted: '#9aab9c', green: '#63c779', red: '#ef7474', amber: '#e6b861' };

function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
}

function CheckRow(props: { checked: boolean; label: string; onPress: () => void }) {
  return <TouchableOpacity style={styles.checkRow} onPress={props.onPress} accessibilityRole="checkbox" accessibilityState={{ checked: props.checked }}>
    <View style={[styles.checkbox, props.checked && styles.checkboxOn]}><Text style={styles.tick}>{props.checked ? '✓' : ''}</Text></View>
    <Text style={styles.checkText}>{props.label}</Text>
  </TouchableOpacity>;
}

export function AccountLifecyclePanel(props: {
  config: AccountLifecyclePublicConfig | null;
  access: AccountAccess | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  onNoticeSeen: () => Promise<void>;
  onAccept: () => Promise<void>;
  onRefuse: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onSignOut: () => Promise<void>;
}) {
  const [termsAccepted, setTermsAccepted] = React.useState(false);
  const [privacyAcknowledged, setPrivacyAcknowledged] = React.useState(false);
  const [localError, setLocalError] = React.useState<string | null>(null);
  const noticeKeyRef = React.useRef<string | null>(null);
  const copy = lifecycleStateCopy(props.access);
  const documentsMatch = bundledDocumentsMatch(props.config);
  const canReactivate = canChangeLegalAcceptance(props.access);
  const shouldRecordNotice = Boolean(props.access?.needs_terms_action && canReactivate && documentsMatch);

  React.useEffect(() => {
    if (!shouldRecordNotice) return;
    const key = `${props.config?.current_terms_version}:${props.config?.current_privacy_version}`;
    if (noticeKeyRef.current === key) return;
    noticeKeyRef.current = key;
    const frame = requestAnimationFrame(() => {
      void props.onNoticeSeen().catch((cause) => {
        noticeKeyRef.current = null;
        setLocalError(cause instanceof Error ? cause.message : 'Non è stato possibile registrare la visualizzazione dei documenti.');
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [props.config?.current_privacy_version, props.config?.current_terms_version, props.onNoticeSeen, shouldRecordNotice]);

  const run = async (action: () => Promise<void>) => {
    setLocalError(null);
    try { await action(); } catch (cause) { setLocalError(cause instanceof Error ? cause.message : 'Operazione non riuscita. Riprova.'); }
  };
  const deadline = formatDate(props.access?.legal_reaccept_deadline_at);
  const inactivityDeleteAfter = formatDate(props.access?.inactivity_delete_after);
  const icon = props.access?.account_state === 'deletion_pending'
    ? <Trash2 size={24} color={COLORS.red} />
    : copy.tone === 'danger' ? <LockKeyhole size={24} color={COLORS.red} /> : <AlertTriangle size={24} color={COLORS.amber} />;

  return <View style={styles.panel} accessibilityRole="summary">
    <View style={styles.header}>{icon}<View style={styles.headerText}><Text style={styles.eyebrow}>{copy.eyebrow.toUpperCase()}</Text><Text style={styles.title}>{copy.title}</Text></View></View>
    <Text style={styles.description}>{copy.description}</Text>
    {deadline && <View style={styles.deadline}><Clock3 size={15} color={COLORS.amber} /><Text style={styles.deadlineText}>Accetta entro il {deadline}.</Text></View>}
    {inactivityDeleteAfter && <View style={styles.deadline}><Clock3 size={15} color={COLORS.amber} /><Text style={styles.deadlineText}>Eliminazione prevista non prima del {inactivityDeleteAfter}, salvo nuova attività valida.</Text></View>}
    {(props.error || localError) && <Text style={styles.error} accessibilityRole="alert">{localError ?? props.error}</Text>}

    {!documentsMatch && <View style={styles.versionError} accessibilityRole="alert"><Text style={styles.versionTitle}>Documenti correnti non disponibili in questa versione dell’app</Text><Text style={styles.description}>Il server richiede Termini {props.config?.current_terms_version ?? '—'} e Privacy {props.config?.current_privacy_version ?? '—'}. Per sicurezza non è possibile accettare documenti diversi.</Text></View>}
    {documentsMatch && <View style={styles.documents}>
      <TouchableOpacity style={styles.documentButton} onPress={() => void Linking.openURL('https://web-funghi-index.pages.dev/termini/')} accessibilityRole="link" accessibilityLabel="Leggi i Termini di utilizzo correnti"><FileText size={18} color={COLORS.green} /><Text style={styles.documentText}>Termini · versione 1.0</Text></TouchableOpacity>
      <TouchableOpacity style={styles.documentButton} onPress={() => void Linking.openURL('https://web-funghi-index.pages.dev/privacy/')} accessibilityRole="link" accessibilityLabel="Leggi l'Informativa privacy corrente"><FileText size={18} color={COLORS.green} /><Text style={styles.documentText}>Privacy · versione 1.0</Text></TouchableOpacity>
    </View>}

    {documentsMatch && canReactivate && props.access?.needs_terms_action && <View style={styles.actions}>
      <CheckRow checked={termsAccepted} onPress={() => setTermsAccepted((value) => !value)} label="Accetto i Termini correnti e dichiaro di avere almeno 18 anni." />
      <CheckRow checked={privacyAcknowledged} onPress={() => setPrivacyAcknowledged((value) => !value)} label="Dichiaro di aver letto l’Informativa privacy corrente." />
      <TouchableOpacity style={[styles.primary, (props.busy || !termsAccepted || !privacyAcknowledged) && styles.disabled]} disabled={props.busy || !termsAccepted || !privacyAcknowledged} onPress={() => void run(props.onAccept)}><Text style={styles.primaryText}>{props.busy ? 'Salvataggio…' : 'Accetta e riattiva'}</Text></TouchableOpacity>
      <TouchableOpacity style={styles.refuse} disabled={props.busy} onPress={() => Alert.alert('Rifiuta i Termini', 'L’account resterà con accesso limitato.', [{ text: 'Annulla', style: 'cancel' }, { text: 'Rifiuta', style: 'destructive', onPress: () => void run(props.onRefuse) }])}><Text style={styles.refuseText}>Rifiuta e mantieni l’accesso limitato</Text></TouchableOpacity>
    </View>}
    {!canReactivate && <TouchableOpacity onPress={() => void Linking.openURL('mailto:funghitracker@gmail.com')} accessibilityRole="link"><Text style={styles.support}>Assistenza: funghitracker@gmail.com</Text></TouchableOpacity>}
    {props.access && <AccountRightsPanel accountState={props.access.account_state} />}
    <View style={styles.footer}><TouchableOpacity style={styles.secondary} disabled={props.loading || props.busy} onPress={() => void run(props.onRefresh)}><RefreshCw size={16} color={COLORS.text} /><Text style={styles.secondaryText}>Aggiorna stato</Text></TouchableOpacity><TouchableOpacity style={styles.secondary} disabled={props.busy} onPress={() => void run(props.onSignOut)}><Text style={styles.secondaryText}>Esci</Text></TouchableOpacity></View>
  </View>;
}

const styles = StyleSheet.create({
  panel: { backgroundColor: COLORS.panel, borderWidth: 1, borderColor: COLORS.border, borderRadius: 12, padding: 16, gap: 13 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 11 }, headerText: { flex: 1 },
  eyebrow: { color: COLORS.amber, fontSize: 10, fontWeight: '900', letterSpacing: 1.2 }, title: { color: COLORS.text, fontSize: 20, fontWeight: '800', marginTop: 2 },
  description: { color: COLORS.muted, fontSize: 15, lineHeight: 22 }, deadline: { flexDirection: 'row', alignItems: 'flex-start', gap: 7 }, deadlineText: { flex: 1, color: COLORS.amber, fontSize: 14, lineHeight: 21 },
  error: { color: '#ffaaaa', fontSize: 14, lineHeight: 21 }, versionError: { backgroundColor: '#2a1e13', borderRadius: 8, padding: 12, gap: 5 }, versionTitle: { color: COLORS.amber, fontWeight: '800' },
  documents: { gap: 8 }, documentButton: { minHeight: 44, borderWidth: 1, borderColor: COLORS.border, borderRadius: 8, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 9 }, documentText: { color: COLORS.text, fontWeight: '700' },
  actions: { gap: 10, borderTopWidth: 1, borderTopColor: COLORS.border, paddingTop: 13 }, checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 }, checkbox: { width: 24, height: 24, borderRadius: 5, borderWidth: 1, borderColor: COLORS.border, alignItems: 'center', justifyContent: 'center' }, checkboxOn: { backgroundColor: COLORS.green, borderColor: COLORS.green }, tick: { color: '#0a110b', fontWeight: '900' }, checkText: { flex: 1, color: COLORS.text, fontSize: 14, lineHeight: 21 },
  primary: { minHeight: 48, borderRadius: 9, backgroundColor: COLORS.green, alignItems: 'center', justifyContent: 'center' }, primaryText: { color: '#0a110b', fontWeight: '800', fontSize: 15 }, disabled: { opacity: 0.45 }, refuse: { minHeight: 44, alignItems: 'center', justifyContent: 'center' }, refuseText: { color: COLORS.red, fontWeight: '700', fontSize: 14 }, support: { color: COLORS.green, fontWeight: '700', fontSize: 14 },
  footer: { flexDirection: 'row', gap: 8 }, secondary: { flex: 1, minHeight: 48, borderWidth: 1, borderColor: COLORS.border, borderRadius: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 }, secondaryText: { color: COLORS.text, fontWeight: '700', fontSize: 14 },
});
