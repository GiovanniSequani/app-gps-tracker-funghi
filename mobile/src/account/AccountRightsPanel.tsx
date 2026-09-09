import React from 'react';
import { ActivityIndicator, Alert, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { ChevronDown, ChevronUp, Clock3, Download, FileArchive, FileText, MailCheck, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react-native';
import type { AccountState } from './lifecycle';
import type { AccountExportJob } from './rights';
import { getExportStatusCopy, isExportDownloadable } from './rights';
import { useAccountRights } from './useAccountRights';

const COLORS = { panel: '#121b13', panel2: '#18231a', border: '#2d4030', text: '#eef5ee', muted: '#9aab9c', green: '#63c779', red: '#ef7474', amber: '#e6b861' };

function formatDateTime(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' });
}
function formatBytes(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const formatter = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 });
  if (value < 1024) return `${formatter.format(value)} B`;
  if (value < 1024 ** 2) return `${formatter.format(value / 1024)} KB`;
  return `${formatter.format(value / 1024 ** 2)} MB`;
}

function CheckRow(props: { checked: boolean; onPress: () => void }) {
  return <TouchableOpacity style={styles.checkRow} onPress={props.onPress} accessibilityRole="checkbox" accessibilityState={{ checked: props.checked }}>
    <View style={[styles.checkbox, props.checked && styles.checkboxOn]}><Text style={styles.tick}>{props.checked ? '✓' : ''}</Text></View>
    <Text style={styles.checkText}>Ho compreso che la cancellazione è definitiva e che devo prima esportare ciò che voglio conservare.</Text>
  </TouchableOpacity>;
}

export function AccountRightsPanel(props: { accountState: AccountState }) {
  const canUseRights = props.accountState === 'active' || props.accountState === 'restricted';
  const rights = useAccountRights(canUseRights);
  const [deletionConfirmed, setDeletionConfirmed] = React.useState(false);
  const [deletionOpen, setDeletionOpen] = React.useState(false);

  if (props.accountState === 'deletion_pending') return <View style={[styles.panel, styles.pending]} accessibilityRole="summary">
    <View style={styles.header}><Trash2 size={24} color={COLORS.red} /><View><Text style={styles.eyebrow}>DIRITTI E CANCELLAZIONE</Text><Text style={styles.title}>Eliminazione in corso</Text></View></View>
    <Text style={styles.body}>L’account è già in eliminazione. Percorsi, ritrovamenti, profilo, export temporanei e dati ancora riconducibili all’account vengono rimossi dai nostri sistemi appena possibile; eventuali residui tecnici entro 30 giorni.</Text>
    <Text style={styles.body}>Questa schermata non indica che il processo sia già completato. L’accesso verrà invalidato definitivamente al termine.</Text>
  </View>;

  const status = rights.job ? getExportStatusCopy(rights.job) : null;
  const requestedAt = formatDateTime(rights.job?.requested_at ?? null);
  const expiresAt = formatDateTime(rights.job?.expires_at ?? null);
  const size = formatBytes(rights.job?.size_bytes ?? null);
  const isPreparing = Boolean(rights.job && ['pending', 'building', 'retry'].includes(rights.job.status));
  const requestDeletion = () => {
    if (!deletionConfirmed) return;
    Alert.alert('Elimina account e dati', 'Inviare l’email per confermare l’eliminazione definitiva di account e dati? Prima esporta i percorsi che vuoi conservare.', [
      { text: 'Annulla', style: 'cancel' },
      { text: 'Invia email', style: 'destructive', onPress: () => void rights.requestDeletion().catch(() => undefined) },
    ]);
  };

  return <View style={styles.panel} accessibilityRole="summary">
    <View style={styles.header}><ShieldAlert size={24} color={COLORS.amber} /><View style={styles.headerCopy}><Text style={styles.eyebrow}>PRIVACY E CONTROLLO DATI</Text><Text style={styles.title}>I tuoi dati</Text></View><TouchableOpacity onPress={() => void Linking.openURL('https://web-funghi-index.pages.dev/account-e-dati')} accessibilityRole="link"><Text style={styles.link}>Dettagli</Text></TouchableOpacity></View>
    {props.accountState === 'restricted' && <Text style={styles.limited}>Puoi ancora esportare i dati, eliminare l’account, leggere i documenti o uscire. L’archivio dei percorsi resta temporaneamente bloccato.</Text>}
    {rights.available === false && <Text style={styles.warning} accessibilityLiveRegion="polite">Le API di export e cancellazione non sono ancora attive in questo ambiente.</Text>}
    {rights.error && rights.available !== false && <Text style={styles.error} accessibilityRole="alert">{rights.error}</Text>}
    <View style={styles.section}>
      <View style={styles.sectionTitle}><FileArchive size={19} color={COLORS.green} /><View><Text style={styles.strong}>Export personale</Text><Text style={styles.muted}>Archivio ZIP privato e temporaneo</Text></View></View>
      <Text style={styles.body}>Include dati account e profilo, accettazioni, metadati delle tracce, modifiche, marker, eventi minimi di servizio e i file GPX ancora presenti.</Text>
      {rights.loading && <View style={styles.loading}><ActivityIndicator size="small" color={COLORS.green} /><Text style={styles.muted}>Verifica export…</Text></View>}
      {!rights.loading && status && <View style={[styles.status, status.tone === 'success' && styles.statusSuccess, status.tone === 'warning' && styles.statusWarning]}><Text style={styles.statusLabel}>STATO · {status.label.toUpperCase()}</Text><Text style={styles.body}>{status.description}</Text>{requestedAt && <Text style={styles.muted}>Richiesto · {requestedAt}</Text>}{expiresAt && <Text style={styles.muted}>Scadenza · {expiresAt}</Text>}{size && <Text style={styles.muted}>Dimensione · {size}</Text>}</View>}
      {!rights.loading && !rights.job && rights.available !== false && <Text style={styles.muted}>Nessun export richiesto.</Text>}
      {!rights.loading && isPreparing && <View style={styles.delivery} accessibilityLiveRegion="polite"><MailCheck size={16} color={COLORS.amber} /><Text style={styles.deliveryText}>Stiamo preparando il tuo archivio. Riceverai un’email quando sarà pronto; puoi anche controllare qui con Aggiorna.</Text></View>}
      <View style={styles.actions}>
        {rights.job && isExportDownloadable(rights.job)
          ? <TouchableOpacity style={[styles.primary, rights.busy !== null && styles.disabled]} disabled={rights.busy !== null} onPress={() => void rights.downloadExport().catch(() => undefined)} accessibilityRole="button"><Download size={16} color="#0a110b" /><Text style={styles.primaryText}>{rights.busy === 'download' ? 'Download…' : 'Scarica ZIP'}</Text></TouchableOpacity>
          : <TouchableOpacity style={[styles.primary, (rights.busy !== null || rights.loading || rights.available === false) && styles.disabled]} disabled={rights.busy !== null || rights.loading || rights.available === false} onPress={() => void rights.requestExport().catch(() => undefined)} accessibilityRole="button"><FileArchive size={16} color="#0a110b" /><Text style={styles.primaryText}>{rights.busy === 'request_export' ? 'Richiesta…' : 'Richiedi export'}</Text></TouchableOpacity>}
        <TouchableOpacity style={[styles.secondary, (rights.loading || rights.busy !== null || rights.available === false) && styles.disabled]} disabled={rights.loading || rights.busy !== null || rights.available === false} onPress={() => void rights.refresh()} accessibilityRole="button"><RefreshCw size={16} color={COLORS.text} /><Text style={styles.secondaryText}>Aggiorna</Text></TouchableOpacity>
      </View>
      <View style={styles.note}><Clock3 size={14} color={COLORS.amber} /><Text style={styles.noteText}>Il file è privato e temporaneo. Scaricalo prima della scadenza e prima di confermare la cancellazione.</Text></View>
    </View>
    <View style={styles.delete}>
      <TouchableOpacity style={styles.deleteSummary} onPress={() => setDeletionOpen((value) => !value)} accessibilityRole="button" accessibilityState={{ expanded: deletionOpen }}><View style={styles.sectionTitle}><Trash2 size={19} color={COLORS.red} /><Text style={styles.strong}>Elimina account e dati</Text></View>{deletionOpen ? <ChevronUp size={18} color={COLORS.muted} /> : <ChevronDown size={18} color={COLORS.muted} />}</TouchableOpacity>
      {deletionOpen && <>
        <Text style={styles.body}>L’operazione è definitiva. Verranno eliminati account, profilo, percorsi GPX, ritrovamenti, modifiche, export temporanei ed email automatiche riconducibili all’account.</Text>
        <Text style={styles.body}>La rimozione avviene appena possibile; eventuali residui tecnici entro 30 giorni. Possono restare solo modelli e risultati aggregati che non permettono di risalire all’account o ai luoghi.</Text>
        {rights.deletionNotice ? <Text style={styles.success} accessibilityLiveRegion="polite">Controlla l’email dell’account e apri il link di conferma. Il link è monouso{rights.deletionNotice.expires_in_minutes ? ` e scade tra ${Math.round(rights.deletionNotice.expires_in_minutes / 60)} ore.` : '.'}</Text> : <><CheckRow checked={deletionConfirmed} onPress={() => setDeletionConfirmed((value) => !value)} /><TouchableOpacity style={[styles.danger, (!deletionConfirmed || rights.busy !== null || rights.available === false) && styles.disabled]} disabled={!deletionConfirmed || rights.busy !== null || rights.available === false} onPress={requestDeletion} accessibilityRole="button"><Trash2 size={16} color="#fff" /><Text style={styles.dangerText}>{rights.busy === 'request_deletion' ? 'Invio…' : 'Invia email di conferma'}</Text></TouchableOpacity></>}
      </>}
    </View>
    <View style={styles.legalLinks}><FileText size={15} color={COLORS.muted} /><TouchableOpacity onPress={() => void Linking.openURL('https://web-funghi-index.pages.dev/termini/')} accessibilityRole="link"><Text style={styles.legalLink}>Termini</Text></TouchableOpacity><TouchableOpacity onPress={() => void Linking.openURL('https://web-funghi-index.pages.dev/privacy/')} accessibilityRole="link"><Text style={styles.legalLink}>Privacy</Text></TouchableOpacity><TouchableOpacity onPress={() => void Linking.openURL('https://web-funghi-index.pages.dev/account-e-dati/')} accessibilityRole="link"><Text style={styles.legalLink}>Account e dati</Text></TouchableOpacity></View>
  </View>;
}

const styles = StyleSheet.create({
  panel: { backgroundColor: COLORS.panel, borderWidth: 1, borderColor: COLORS.border, borderRadius: 12, padding: 16, gap: 13 }, pending: { borderColor: '#704039' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 }, headerCopy: { flex: 1 }, eyebrow: { color: COLORS.amber, fontSize: 10, fontWeight: '900', letterSpacing: 1.1 }, title: { color: COLORS.text, fontSize: 19, fontWeight: '800', marginTop: 2 }, link: { color: COLORS.green, fontSize: 12, fontWeight: '800' },
  body: { color: COLORS.muted, fontSize: 14, lineHeight: 21 }, muted: { color: COLORS.muted, fontSize: 13, lineHeight: 19 }, strong: { color: COLORS.text, fontSize: 16, fontWeight: '700' }, limited: { color: COLORS.amber, fontSize: 14, lineHeight: 21 }, warning: { color: COLORS.amber, fontSize: 14, lineHeight: 21 }, error: { color: '#ffaaaa', fontSize: 14, lineHeight: 21 }, success: { color: '#9be9aa', fontSize: 14, lineHeight: 21 },
  section: { borderTopWidth: 1, borderTopColor: COLORS.border, paddingTop: 13, gap: 10 }, sectionTitle: { flexDirection: 'row', alignItems: 'center', gap: 8 }, loading: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 30 }, status: { gap: 5, padding: 11, borderRadius: 8, backgroundColor: COLORS.panel2 }, statusSuccess: { borderWidth: 1, borderColor: '#315b3c' }, statusWarning: { borderWidth: 1, borderColor: '#735f30' }, statusLabel: { color: COLORS.text, fontSize: 10, fontWeight: '900', letterSpacing: .5 },
  actions: { flexDirection: 'row', gap: 8 }, primary: { flex: 1, minHeight: 48, borderRadius: 8, backgroundColor: COLORS.green, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }, primaryText: { color: '#0a110b', fontSize: 14, fontWeight: '800' }, secondary: { minHeight: 48, borderRadius: 8, paddingHorizontal: 12, borderWidth: 1, borderColor: COLORS.border, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }, secondaryText: { color: COLORS.text, fontSize: 14, fontWeight: '700' }, disabled: { opacity: .45 }, note: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 }, noteText: { flex: 1, color: COLORS.amber, fontSize: 13, lineHeight: 19 },
  delivery: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, padding: 10, borderRadius: 8, backgroundColor: '#292313' }, deliveryText: { flex: 1, color: COLORS.amber, fontSize: 11, lineHeight: 17 },
  delete: { borderTopWidth: 1, borderTopColor: COLORS.border, paddingTop: 13, gap: 10 }, deleteSummary: { minHeight: 38, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 9 }, checkbox: { width: 21, height: 21, borderRadius: 5, borderWidth: 1, borderColor: COLORS.border, alignItems: 'center', justifyContent: 'center' }, checkboxOn: { backgroundColor: COLORS.green, borderColor: COLORS.green }, tick: { color: '#0a110b', fontWeight: '900' }, checkText: { flex: 1, color: COLORS.text, fontSize: 12, lineHeight: 18 }, danger: { minHeight: 43, borderRadius: 8, backgroundColor: '#b84642', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }, dangerText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  legalLinks: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12, borderTopWidth: 1, borderTopColor: COLORS.border, paddingTop: 12 }, legalLink: { color: COLORS.green, fontSize: 11, fontWeight: '800' },
});
