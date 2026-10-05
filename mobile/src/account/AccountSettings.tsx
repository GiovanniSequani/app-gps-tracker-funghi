import React from 'react';
import { Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { FileText, KeyRound, LogOut, Settings, UserRound } from 'lucide-react-native';
import type { AccountState } from './lifecycle';
import { AccountRightsPanel } from './AccountRightsPanel';

const COLORS = {
  panel: '#121b13', border: '#2d4030', text: '#eef5ee', muted: '#9aab9c',
  green: '#63c779', red: '#ef7474',
};

type ProfileProps = {
  username: string;
  email: string | null;
  onOpenSettings?: () => void;
};

export function AccountProfileHeader({ username, email, onOpenSettings }: ProfileProps) {
  return <View style={styles.profile}>
    <View style={styles.profileIdentityRow}>
      <View style={styles.avatar}><UserRound size={23} color={COLORS.green} /></View>
      <View style={styles.identity}>
        <Text style={styles.username}>{username}</Text>
        {email && <Text style={styles.email}>{email}</Text>}
      </View>
    </View>
    {onOpenSettings && <TouchableOpacity style={styles.settingsButton} onPress={onOpenSettings} accessibilityRole="button" accessibilityLabel="Apri impostazioni account">
      <Settings size={19} color={COLORS.text} />
      <Text style={styles.settingsButtonText}>Impostazioni</Text>
    </TouchableOpacity>}
  </View>;
}

export function AccountSettings(props: {
  username: string;
  email: string | null;
  accountState: AccountState | null;
  fullAccess: boolean;
  trackCount: number | null;
  maxTracks: number | null;
  maxFileSize: string | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
  onChangePassword: () => void;
  onSignOut: () => void;
}) {
  const deleting = props.accountState === 'deletion_pending';
  return <View style={styles.content}>
    <AccountProfileHeader username={props.username} email={props.email} />
    {props.error && <Text style={styles.error} accessibilityRole="alert">{props.error}</Text>}
    {props.notice && <Text style={styles.notice} accessibilityLiveRegion="polite">{props.notice}</Text>}

    {!deleting && <View style={styles.group}>
      <Text style={styles.heading}>Account</Text>
      <View style={styles.usage}>
        <Text style={styles.rowTitle}>Utilizzo account</Text>
        <View style={styles.metricRow}><Text style={styles.label}>Stato</Text><Text style={styles.value}>{props.fullAccess ? 'Attivo' : props.accountState === 'restricted' ? 'Limitato' : 'Da verificare'}</Text></View>
        {props.fullAccess && <>
          <View style={styles.metricRow}><Text style={styles.label}>Percorsi salvati</Text><Text style={styles.value}>{props.trackCount ?? '—'} / {props.maxTracks ?? '—'}</Text></View>
          <View style={styles.metricRow}><Text style={styles.label}>Massimo per file</Text><Text style={styles.value}>{props.maxFileSize ?? '—'}</Text></View>
        </>}
      </View>
      {props.fullAccess && <TouchableOpacity style={styles.action} onPress={props.onChangePassword} disabled={props.busy || !props.email} accessibilityRole="button" accessibilityState={{ disabled: props.busy || !props.email }}>
        <KeyRound size={18} color={COLORS.green} /><Text style={styles.actionText}>Cambia password</Text>
      </TouchableOpacity>}
      {props.fullAccess && <Text style={styles.hint}>Riceverai un link via email.</Text>}
    </View>}

    {props.accountState && (props.accountState !== 'active' || props.fullAccess) && <AccountRightsPanel accountState={props.accountState} settings />}

    <View style={styles.group}>
      <Text style={styles.heading}>Documenti</Text>
      <DocumentLink title="Termini" url="https://web-funghi-index.pages.dev/termini/" />
      <DocumentLink title="Privacy Policy" url="https://web-funghi-index.pages.dev/privacy/" />
      <DocumentLink title="Account e dati" url="https://web-funghi-index.pages.dev/account-e-dati/" />
    </View>

    <TouchableOpacity style={styles.logout} onPress={props.onSignOut} disabled={props.busy} accessibilityRole="button" accessibilityState={{ disabled: props.busy }}>
      <LogOut size={18} color={COLORS.text} /><Text style={styles.actionText}>Esci</Text>
    </TouchableOpacity>
  </View>;
}

function DocumentLink({ title, url }: { title: string; url: string }) {
  return <TouchableOpacity style={styles.action} onPress={() => void Linking.openURL(url)} accessibilityRole="link" accessibilityLabel={title}>
    <FileText size={18} color={COLORS.muted} /><Text style={styles.actionText}>{title}</Text>
  </TouchableOpacity>;
}

const styles = StyleSheet.create({
  content: { gap: 26 },
  profile: { gap: 8, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  profileIdentityRow: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  avatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: COLORS.panel, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  identity: { flex: 1, minWidth: 0, gap: 2 },
  username: { color: COLORS.text, fontSize: 18, fontWeight: '800', flexShrink: 1 },
  email: { color: COLORS.muted, fontSize: 13, lineHeight: 19, flexShrink: 1 },
  settingsButton: { minHeight: 44, alignSelf: 'flex-end', borderRadius: 8, borderWidth: 1, borderColor: COLORS.border, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 6 },
  settingsButtonText: { color: COLORS.text, fontSize: 12, fontWeight: '700' },
  group: { gap: 6 },
  heading: { color: COLORS.muted, fontSize: 14, fontWeight: '700', marginBottom: 7 },
  usage: { gap: 9, paddingVertical: 12, borderTopWidth: 1, borderBottomWidth: 1, borderColor: COLORS.border },
  rowTitle: { color: COLORS.text, fontSize: 15, fontWeight: '700', marginBottom: 3 },
  metricRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  label: { color: COLORS.muted, fontSize: 13, flexShrink: 1 },
  value: { color: COLORS.text, fontSize: 13, fontWeight: '700', textAlign: 'right', flexShrink: 1 },
  action: { minHeight: 49, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderBottomColor: COLORS.border, paddingHorizontal: 2 },
  actionText: { color: COLORS.text, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  hint: { color: COLORS.muted, fontSize: 12, marginLeft: 30 },
  logout: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 12, borderTopWidth: 1, borderTopColor: COLORS.border, paddingTop: 8 },
  error: { color: '#ffaaaa', fontSize: 14 },
  notice: { color: COLORS.green, fontSize: 14 },
});
