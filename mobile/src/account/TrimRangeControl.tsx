import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

export function TrimRangeControl(props: {
  pointCount: number;
  start: number;
  end: number;
  onChange: (start: number, end: number) => void;
}) {
  const { pointCount, start, end, onChange } = props;
  const maximum = pointCount - 1;
  const jump = Math.max(1, Math.round(pointCount / 100));

  const setStart = (value: number) => onChange(Math.max(0, Math.min(value, end - 1)), end);
  const setEnd = (value: number) => onChange(start, Math.min(maximum, Math.max(value, start + 1)));

  return (
    <View style={styles.root}>
      <View style={styles.controls}>
        <View style={styles.side}>
          <Text style={styles.actionLabel}>ACCORCIA INIZIO</Text>
          <View style={styles.buttons}>
            <TouchableOpacity style={styles.button} onPress={() => setStart(start - jump)} accessibilityLabel="Espandi l'inizio"><Text style={styles.buttonText}>−</Text></TouchableOpacity>
            <TouchableOpacity style={styles.button} onPress={() => setStart(start + jump)} accessibilityLabel="Taglia dall'inizio"><Text style={styles.buttonText}>+</Text></TouchableOpacity>
          </View>
          <Text style={styles.label}>INIZIO · {start + 1}</Text>
        </View>
        <View style={[styles.side, styles.sideEnd]}>
          <Text style={styles.actionLabel}>ACCORCIA FINE</Text>
          <View style={styles.buttons}>
            <TouchableOpacity style={styles.button} onPress={() => setEnd(end - jump)} accessibilityLabel="Taglia dalla fine"><Text style={styles.buttonText}>−</Text></TouchableOpacity>
            <TouchableOpacity style={styles.button} onPress={() => setEnd(end + jump)} accessibilityLabel="Espandi la fine"><Text style={styles.buttonText}>+</Text></TouchableOpacity>
          </View>
          <Text style={styles.label}>FINE · {end + 1}</Text>
        </View>
      </View>
      <Text style={styles.keptCount} accessibilityLabel={`Intervallo mantenuto dal punto ${start + 1} al punto ${end + 1}`}>
        {end - start + 1} punti mantenuti
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 8 },
  controls: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14 },
  side: { flex: 1, gap: 6, alignItems: 'flex-start' },
  sideEnd: { alignItems: 'flex-end' },
  actionLabel: { color: '#eef5ee', fontSize: 10, fontWeight: '800', letterSpacing: 0.45 },
  label: { color: '#9aab9c', fontSize: 9, fontWeight: '800', letterSpacing: 0.7 },
  buttons: { flexDirection: 'row', gap: 5 },
  button: { width: 44, height: 38, borderRadius: 8, borderWidth: 1, borderColor: '#3b4b3e', backgroundColor: '#18231a', alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: '#eef5ee', fontSize: 22, fontWeight: '800', lineHeight: 25 },
  keptCount: { color: '#c7d5c9', fontSize: 10, textAlign: 'center' },
});
