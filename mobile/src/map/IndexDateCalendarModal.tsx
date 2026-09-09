import React from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { ChevronLeft, ChevronRight, X } from 'lucide-react-native';

import {
  buildIndexCalendarDays,
  indexCalendarAvailability,
  newestTileForDate,
  normalizeIndexDate,
  parseIndexDate,
  type IndexCalendarTile,
} from './indexCalendar';

const COLORS = {
  bg: '#0a110b', panel: '#121b13', panel2: '#18231a', border: '#344638',
  text: '#eef5ee', muted: '#9aab9c', green: '#356b3d', red: '#6e2929', amber: '#d7aa65',
};

function monthLabel(date: Date): string {
  const label = date.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function IndexDateCalendarModal(props: {
  visible: boolean;
  selectedDate: string;
  allowedTileSets: IndexCalendarTile[];
  allTileSets: IndexCalendarTile[];
  onSelect: (tile: IndexCalendarTile) => void;
  onRestrictedDate: () => void;
  onClose: () => void;
}) {
  const selectedMonth = parseIndexDate(props.selectedDate) ?? new Date();
  const [month, setMonth] = React.useState(selectedMonth);

  React.useEffect(() => {
    if (props.visible) setMonth(selectedMonth);
  }, [props.visible, props.selectedDate]);

  const days = React.useMemo(() => buildIndexCalendarDays(month), [month]);
  const moveMonth = (delta: number) => setMonth((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1));

  return (
    <Modal visible={props.visible} transparent animationType="fade" onRequestClose={props.onClose}>
      <View style={styles.backdrop}>
        <TouchableOpacity style={StyleSheet.absoluteFillObject} onPress={props.onClose} accessibilityLabel="Chiudi calendario" />
        <View style={styles.card} accessibilityViewIsModal>
          <View style={styles.titleRow}>
            <View><Text style={styles.title}>Data indice</Text><Text style={styles.subtitle}>Scegli un giorno disponibile</Text></View>
            <TouchableOpacity style={styles.iconButton} onPress={props.onClose} accessibilityLabel="Chiudi calendario"><X size={20} color={COLORS.text} /></TouchableOpacity>
          </View>
          <View style={styles.monthRow}>
            <TouchableOpacity style={styles.iconButton} onPress={() => moveMonth(-1)} accessibilityLabel="Mese precedente"><ChevronLeft size={20} color={COLORS.text} /></TouchableOpacity>
            <Text style={styles.month}>{monthLabel(month)}</Text>
            <TouchableOpacity style={styles.iconButton} onPress={() => moveMonth(1)} accessibilityLabel="Mese successivo"><ChevronRight size={20} color={COLORS.text} /></TouchableOpacity>
          </View>
          <View style={styles.weekRow}>{['L', 'M', 'M', 'G', 'V', 'S', 'D'].map((label, index) => <Text key={`${label}-${index}`} style={styles.weekday}>{label}</Text>)}</View>
          <View style={styles.grid}>
            {days.map((day) => {
              const availability = indexCalendarAvailability(day.key, props.allowedTileSets, props.allTileSets);
              const selected = normalizeIndexDate(props.selectedDate) === day.key;
              const disabled = availability === 'unavailable';
              const choose = () => {
                if (availability === 'restricted') {
                  props.onClose();
                  props.onRestrictedDate();
                  return;
                }
                const tile = newestTileForDate(day.key, props.allowedTileSets);
                if (tile) {
                  props.onSelect(tile);
                  props.onClose();
                }
              };
              const dayContent = <Text style={[styles.dayText, disabled && styles.dayTextUnavailable]}>{day.date.getDate()}</Text>;
              return (
                <TouchableOpacity
                  key={day.key}
                  style={[styles.day, !day.inCurrentMonth && styles.dayMuted, selected && styles.daySelected, availability === 'available' && styles.dayAvailable, availability === 'unavailable' && styles.dayUnavailable]}
                  disabled={disabled}
                  onPress={choose}
                  accessibilityRole="button"
                  accessibilityState={{ selected, disabled }}
                  accessibilityLabel={`${day.date.toLocaleDateString('it-IT')}, ${availability === 'available' ? 'indice disponibile' : availability === 'restricted' ? 'disponibile con accesso completo' : 'indice non disponibile'}`}
                >
                  {availability === 'restricted' ? <LinearGradient colors={['#35643c', '#793535']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.restrictedFill}>{dayContent}</LinearGradient> : dayContent}
                </TouchableOpacity>
              );
            })}
          </View>
          <View style={styles.legend}>
            <View style={styles.legendItem}><View style={[styles.legendSwatch, styles.dayAvailable]} /><Text style={styles.legendText}>Disponibile</Text></View>
            <View style={styles.legendItem}><LinearGradient colors={['#35643c', '#793535']} style={styles.legendSwatch} /><Text style={styles.legendText}>Accesso completo</Text></View>
            <View style={styles.legendItem}><View style={[styles.legendSwatch, styles.dayUnavailable]} /><Text style={styles.legendText}>Non disponibile</Text></View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.68)', alignItems: 'center', justifyContent: 'center', padding: 18 },
  card: { width: '100%', maxWidth: 380, borderRadius: 14, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.panel, padding: 14, gap: 12 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: COLORS.text, fontSize: 19, fontWeight: '800' },
  subtitle: { color: COLORS.muted, fontSize: 12, marginTop: 2 },
  monthRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  month: { flex: 1, color: COLORS.text, fontSize: 15, fontWeight: '800', textAlign: 'center' },
  iconButton: { width: 44, height: 44, borderRadius: 8, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.panel2, alignItems: 'center', justifyContent: 'center' },
  weekRow: { flexDirection: 'row', gap: 5 },
  weekday: { flex: 1, color: COLORS.muted, fontSize: 10, fontWeight: '900', textAlign: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  day: { width: '12.45%', aspectRatio: 1, minHeight: 38, overflow: 'hidden', borderRadius: 7, borderWidth: 1, borderColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  dayAvailable: { backgroundColor: COLORS.green, borderColor: '#6db85f' },
  dayUnavailable: { backgroundColor: COLORS.red },
  daySelected: { borderColor: '#eef5ee', borderWidth: 2 },
  dayMuted: { opacity: 0.42 },
  restrictedFill: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  dayText: { color: COLORS.text, fontSize: 13, fontWeight: '900' },
  dayTextUnavailable: { color: '#e8a1a1' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, paddingTop: 2 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendSwatch: { width: 14, height: 14, borderRadius: 4, overflow: 'hidden', borderWidth: 1, borderColor: COLORS.border },
  legendText: { color: COLORS.muted, fontSize: 10, fontWeight: '700' },
});
