import React from 'react';
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Activity, CalendarClock, FolderArchive, LockKeyhole, X } from 'lucide-react-native';
import type { AccountAccess } from './account/lifecycle';
import { getIndexAccessNoticeCopy } from './index-access';

const COLORS = { backdrop: 'rgba(4,10,5,0.78)', panel: '#101a12', border: '#a75c3e', text: '#eef5ee', muted: '#a8b7a9', green: '#68c77b', primary: '#b45f40' };

function Benefit(props: { icon: React.ReactNode; title: string; text: string }) {
  return <View style={styles.benefit}>{props.icon}<View style={styles.benefitCopy}><Text style={styles.benefitTitle}>{props.title}</Text><Text style={styles.benefitText}>{props.text}</Text></View></View>;
}

export function IndexAccessNoticeModal(props: {
  visible: boolean;
  authenticated: boolean;
  access: AccountAccess | null;
  onClose: () => void;
  onAction: () => void;
}) {
  const copy = getIndexAccessNoticeCopy(props.authenticated, props.access);
  return <Modal visible={props.visible} transparent animationType="fade" onRequestClose={props.onClose} statusBarTranslucent>
    <View style={styles.backdrop}>
      <Pressable style={StyleSheet.absoluteFillObject} onPress={props.onClose} accessibilityLabel="Chiudi avviso accesso" />
      <View style={styles.panel} accessibilityRole="summary" accessibilityViewIsModal>
        <View style={styles.topRow}><View style={styles.lock}><LockKeyhole size={19} color="#df8b62" /></View><TouchableOpacity style={styles.close} onPress={props.onClose} accessibilityLabel="Chiudi avviso accesso"><X size={25} color={COLORS.text} /></TouchableOpacity></View>
        <Text style={styles.title}>{copy.title}</Text>
        <Text style={styles.description}>{copy.description}</Text>
        <View style={styles.divider} />
        <Text style={styles.intro}>Con l’accesso completo puoi usare:</Text>
        <Benefit icon={<CalendarClock size={20} color={COLORS.green} />} title="Indice aggiornato" text="Ultimo giorno disponibile." />
        <Benefit icon={<Activity size={20} color={COLORS.green} />} title="Analisi dell’indice" text="Fattori favorevoli e sfavorevoli." />
        <Benefit icon={<FolderArchive size={20} color={COLORS.green} />} title="Archivio cloud" text="Percorsi e ritrovamenti personali." />
        <View style={styles.divider} />
        <TouchableOpacity style={styles.primary} onPress={props.onAction} accessibilityRole="button"><Text style={styles.primaryText}>{copy.action}</Text><Text style={styles.arrow}>→</Text></TouchableOpacity>
        <TouchableOpacity style={styles.secondary} onPress={props.onClose} accessibilityRole="button"><Text style={styles.secondaryText}>Continua con l’indice pubblico</Text></TouchableOpacity>
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'center', padding: 15, backgroundColor: COLORS.backdrop },
  panel: { width: '100%', maxWidth: 420, alignSelf: 'center', borderWidth: 1, borderColor: COLORS.border, borderRadius: 13, backgroundColor: COLORS.panel, padding: 17, gap: 9 },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  lock: { width: 35, height: 35, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: COLORS.border, borderRadius: 18 },
  close: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#6090aa', borderRadius: 10 },
  title: { color: COLORS.text, fontSize: 23, lineHeight: 27, fontWeight: '900', marginTop: 3 },
  description: { color: COLORS.muted, fontSize: 13, lineHeight: 19 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: '#334537', marginVertical: 5 },
  intro: { color: COLORS.text, fontSize: 12, fontWeight: '800', marginBottom: 2 },
  benefit: { minHeight: 39, flexDirection: 'row', alignItems: 'center', gap: 10 }, benefitCopy: { flex: 1 },
  benefitTitle: { color: COLORS.text, fontSize: 13, fontWeight: '800' }, benefitText: { color: COLORS.muted, fontSize: 11, lineHeight: 16 },
  primary: { minHeight: 46, borderRadius: 7, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: COLORS.primary },
  primaryText: { color: '#fff', fontSize: 13, fontWeight: '900' }, arrow: { color: '#fff', fontSize: 17 },
  secondary: { minHeight: 42, borderRadius: 7, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#405345' },
  secondaryText: { color: COLORS.text, fontSize: 12, fontWeight: '800' },
});
