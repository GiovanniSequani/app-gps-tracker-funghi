import React from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Check, RotateCcw, Trash2, X } from 'lucide-react-native';
import {
  deleteTrackMushroomMarker,
  listTrackMushroomMarkers,
  saveTrackMushroomMarker,
  setTrackTrim,
} from './client';
import {
  applyCloudTrackEdit,
  effectiveTrim,
  planMushroomMarkerChanges,
  persistedTrim,
  snapMarkersToTrack,
} from './trackEdits';
import { TrimRangeControl } from './TrimRangeControl';
import type { ArchiveMapRoute, GpxMushroomMarker, MushroomSpecies } from './types';
import { toAccountError } from './validation';

const COLORS = {
  bg: '#0a110b', panel: '#121b13', panel2: '#18231a', border: '#344638',
  text: '#eef5ee', muted: '#9aab9c', green: '#63c779', red: '#ef7474', amber: '#e6b861',
  porcini: '#965123', finferli: '#ffd900',
};

function draftMarker(
  trackId: string,
  pointIndex: number,
  latitude: number,
  longitude: number,
  species: MushroomSpecies,
  count: number,
): GpxMushroomMarker {
  const now = new Date().toISOString();
  return {
    id: `draft:${pointIndex}:${species}`,
    track_id: trackId,
    track_point_index: pointIndex,
    latitude,
    longitude,
    species,
    count,
    created_at: now,
    updated_at: now,
  };
}

export default function CloudTrackEditor(props: {
  route: ArchiveMapRoute;
  selectedPointIndex: number | null;
  onDraftChange: (route: ArchiveMapRoute) => void;
  onCancel: (route: ArchiveMapRoute) => void;
  onSaved: (route: ArchiveMapRoute) => void;
}) {
  const edit = props.route.cloudEdit;
  if (!edit) return null;
  const initialTrim = React.useMemo(
    () => effectiveTrim(edit.rawPointCount, edit.trimStartPointIndex, edit.trimEndPointIndex),
    [edit.rawPointCount, edit.trimEndPointIndex, edit.trimStartPointIndex],
  );
  const initialMarkers = React.useRef(edit.mushroomMarkers);
  const [start, setStart] = React.useState(initialTrim.start);
  const [end, setEnd] = React.useState(initialTrim.end);
  const [markers, setMarkers] = React.useState(edit.mushroomMarkers);
  const [selectedSpecies, setSelectedSpecies] = React.useState<MushroomSpecies>('porcini');
  const [countText, setCountText] = React.useState('1');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const selectedPoint = props.selectedPointIndex === null
    || props.selectedPointIndex < start
    || props.selectedPointIndex > end
    ? null
    : edit.rawPoints.find((point) => point.pointIndex === props.selectedPointIndex) ?? null;
  const selectedMarker = selectedPoint
    ? markers.find((marker) => (
      marker.track_point_index === selectedPoint.pointIndex && marker.species === selectedSpecies
    )) ?? null
    : null;
  const markerTotals = React.useMemo(() => markers.reduce((totals, marker) => ({
    ...totals,
    [marker.species]: totals[marker.species] + marker.count,
  }), { porcini: 0, finferli: 0 }), [markers]);

  React.useEffect(() => {
    setCountText(selectedMarker ? String(selectedMarker.count) : '1');
    setError(null);
  }, [props.selectedPointIndex, selectedMarker?.count, selectedSpecies]);

  React.useEffect(() => {
    props.onDraftChange(applyCloudTrackEdit(props.route, start, end, markers));
  }, [end, markers, props.onDraftChange, props.route, start]);

  const updateRange = (nextStart: number, nextEnd: number) => {
    setStart(nextStart);
    setEnd(nextEnd);
  };

  const setSelectedMarker = () => {
    if (!selectedPoint) return;
    const count = Number(countText);
    if (!Number.isInteger(count) || count < 1 || count > 10000) {
      setError('Inserisci un numero intero da 1 a 10000.');
      return;
    }
    const next = draftMarker(
      props.route.routeId,
      selectedPoint.pointIndex,
      selectedPoint.latitude,
      selectedPoint.longitude,
      selectedSpecies,
      count,
    );
    setMarkers((current) => [...current.filter((marker) => !(
      marker.track_point_index === selectedPoint.pointIndex && marker.species === selectedSpecies
    )), next].sort((a, b) => (
      a.track_point_index - b.track_point_index || a.species.localeCompare(b.species)
    )));
    setError(null);
  };

  const removeSelectedMarker = () => {
    if (!selectedPoint) return;
    setMarkers((current) => current.filter((marker) => !(
      marker.track_point_index === selectedPoint.pointIndex && marker.species === selectedSpecies
    )));
    setError(null);
  };

  const resetTrim = () => updateRange(0, edit.rawPointCount - 1);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const trim = persistedTrim(edit.rawPointCount, start, end);
      const changes = planMushroomMarkerChanges(initialMarkers.current, markers);
      for (const marker of changes.deleteMarkers) {
        await deleteTrackMushroomMarker(props.route.routeId, marker.trackPointIndex, marker.species);
      }
      for (const marker of changes.saveMarkers) {
        const point = edit.rawPoints.find((item) => item.pointIndex === marker.track_point_index);
        if (!point) throw new Error('Il punto scelto non è disponibile nel GPX originale.');
        await saveTrackMushroomMarker(props.route.routeId, point, marker.species, marker.count);
      }
      const updatedTrack = await setTrackTrim(
        props.route.routeId,
        trim.trimStartPointIndex,
        trim.trimEndPointIndex,
      );
      const savedMarkers = snapMarkersToTrack(
        await listTrackMushroomMarkers(props.route.routeId),
        edit.rawPoints,
      );
      const normalized = effectiveTrim(
        edit.rawPointCount,
        updatedTrack.trim_start_point_index,
        updatedTrack.trim_end_point_index,
      );
      props.onSaved(applyCloudTrackEdit(props.route, normalized.start, normalized.end, savedMarkers));
    } catch (reason) {
      setError(`${toAccountError(reason).message} Puoi riprovare: le operazioni già confermate sono idempotenti.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined} pointerEvents="box-none">
      <View style={styles.panel}>
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>MODIFICA PERCORSO</Text>
            <Text style={styles.title} numberOfLines={1}>{props.route.name}</Text>
          </View>
          <TouchableOpacity style={styles.iconButton} disabled={busy} onPress={() => props.onCancel(props.route)} accessibilityLabel="Annulla modifiche"><X size={19} color={COLORS.text} /></TouchableOpacity>
        </View>

        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={styles.sectionHeader}>
            <View><Text style={styles.sectionTitle}>Taglio</Text><Text style={styles.hint}>Verde: parte mantenuta · Grigio: parte esclusa</Text></View>
            <TouchableOpacity style={styles.resetButton} onPress={resetTrim} disabled={busy}><RotateCcw size={14} color={COLORS.muted} /><Text style={styles.resetText}>Tutta</Text></TouchableOpacity>
          </View>
          <TrimRangeControl pointCount={edit.rawPointCount} start={start} end={end} onChange={updateRange} />

          <View style={styles.divider} />
          <Text style={styles.sectionTitle}>Marker funghi</Text>
          <Text style={styles.hint}>Tocca la traccia verde sulla mappa, poi imposta quanti funghi hai trovato in quel punto.</Text>
          {selectedPoint ? (
            <View style={styles.selectedPointEditor}>
              <View style={styles.speciesSelector} accessibilityRole="radiogroup" accessibilityLabel="Specie del marker">
                {(['porcini', 'finferli'] as const).map((species) => {
                  const active = selectedSpecies === species;
                  return (
                    <TouchableOpacity
                      key={species}
                      style={[
                        styles.speciesButton,
                        active && (species === 'porcini' ? styles.speciesButtonPorcini : styles.speciesButtonFinferli),
                      ]}
                      onPress={() => setSelectedSpecies(species)}
                      disabled={busy}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: active }}
                      accessibilityLabel={species === 'porcini' ? 'Porcini' : 'Finferli'}
                    >
                      <Text style={[
                        styles.speciesButtonText,
                        active && (species === 'porcini' ? styles.speciesButtonTextPorcini : styles.speciesButtonTextFinferli),
                      ]}>
                        {species === 'porcini' ? 'Porcini' : 'Finferli'}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <View style={styles.markerEditor}>
                <View style={styles.pointCopy}>
                  <Text style={styles.pointTitle}>Punto {selectedPoint.pointIndex + 1}</Text>
                  <Text style={styles.pointCoords}>{selectedPoint.latitude.toFixed(5)}, {selectedPoint.longitude.toFixed(5)}</Text>
                </View>
                <TextInput
                  style={styles.countInput}
                  value={countText}
                  onChangeText={setCountText}
                  keyboardType="number-pad"
                  selectTextOnFocus
                  maxLength={5}
                  accessibilityLabel={`Numero di ${selectedSpecies}`}
                />
                <TouchableOpacity style={styles.markerSave} onPress={setSelectedMarker} disabled={busy} accessibilityLabel={selectedMarker ? `Aggiorna marker ${selectedSpecies}` : `Aggiungi marker ${selectedSpecies}`}><Check size={17} color={COLORS.bg} /></TouchableOpacity>
                {selectedMarker && <TouchableOpacity style={styles.markerDelete} onPress={removeSelectedMarker} disabled={busy} accessibilityLabel={`Rimuovi marker ${selectedSpecies}`}><Trash2 size={17} color={COLORS.red} /></TouchableOpacity>}
              </View>
            </View>
          ) : <Text style={styles.emptySelection}>Nessun punto selezionato.</Text>}
          <Text style={styles.markerSummary}>{markerTotals.porcini} porcini · {markerTotals.finferli} finferli · quelli fuori dal taglio restano conservati ma nascosti</Text>
          {error && <Text style={styles.error}>{error}</Text>}
        </ScrollView>

        <View style={styles.actions}>
          <TouchableOpacity style={styles.cancelButton} onPress={() => props.onCancel(props.route)} disabled={busy}><Text style={styles.cancelText}>Annulla</Text></TouchableOpacity>
          <TouchableOpacity style={styles.saveButton} onPress={() => void save()} disabled={busy}>
            {busy ? <ActivityIndicator size="small" color={COLORS.bg} /> : <Check size={17} color={COLORS.bg} />}
            <Text style={styles.saveText}>{busy ? 'Salvataggio…' : 'Salva modifiche'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end', zIndex: 150, elevation: 150 },
  panel: { height: '58%', maxHeight: 520, backgroundColor: 'rgba(10,17,11,0.98)', borderTopWidth: 1, borderColor: COLORS.border, borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingTop: 12 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 10, gap: 10 },
  headerCopy: { flex: 1, minWidth: 0 },
  eyebrow: { color: COLORS.green, fontSize: 9, fontWeight: '900', letterSpacing: 1.6 },
  title: { color: COLORS.text, fontSize: 17, fontWeight: '800', marginTop: 2 },
  iconButton: { width: 38, height: 38, borderRadius: 8, borderWidth: 1, borderColor: COLORS.border, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1 },
  bodyContent: { paddingHorizontal: 16, paddingBottom: 12, gap: 8 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  sectionTitle: { color: COLORS.text, fontSize: 13, fontWeight: '800' },
  hint: { color: COLORS.muted, fontSize: 10, lineHeight: 15, marginTop: 2 },
  resetButton: { minHeight: 32, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderColor: COLORS.border, borderRadius: 7 },
  resetText: { color: COLORS.muted, fontSize: 10, fontWeight: '700' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: COLORS.border, marginVertical: 2 },
  selectedPointEditor: { gap: 7 },
  speciesSelector: { flexDirection: 'row', gap: 7 },
  speciesButton: { flex: 1, minHeight: 36, borderRadius: 8, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.panel2, alignItems: 'center', justifyContent: 'center' },
  speciesButtonPorcini: { backgroundColor: COLORS.porcini, borderColor: '#c57a43' },
  speciesButtonFinferli: { backgroundColor: COLORS.finferli, borderColor: '#ffe86a' },
  speciesButtonText: { color: COLORS.muted, fontSize: 11, fontWeight: '800' },
  speciesButtonTextPorcini: { color: '#fff' },
  speciesButtonTextFinferli: { color: '#111' },
  markerEditor: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: COLORS.panel2, borderRadius: 8, padding: 8 },
  pointCopy: { flex: 1, minWidth: 0 },
  pointTitle: { color: COLORS.text, fontSize: 12, fontWeight: '800' },
  pointCoords: { color: COLORS.muted, fontSize: 9, marginTop: 2 },
  countInput: { width: 58, height: 38, borderWidth: 1, borderColor: COLORS.border, borderRadius: 7, color: COLORS.text, backgroundColor: COLORS.bg, paddingHorizontal: 8, textAlign: 'center', fontWeight: '800' },
  markerSave: { width: 38, height: 38, borderRadius: 7, backgroundColor: COLORS.green, alignItems: 'center', justifyContent: 'center' },
  markerDelete: { width: 38, height: 38, borderRadius: 7, borderWidth: 1, borderColor: '#6c3c3c', alignItems: 'center', justifyContent: 'center' },
  emptySelection: { color: COLORS.amber, fontSize: 11, paddingVertical: 8 },
  markerSummary: { color: COLORS.muted, fontSize: 9, lineHeight: 14 },
  error: { color: '#ffaaaa', backgroundColor: '#351d1d', borderRadius: 7, padding: 9, fontSize: 10, lineHeight: 15 },
  actions: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 9, paddingBottom: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.border },
  cancelButton: { flex: 1, minHeight: 42, borderRadius: 8, borderWidth: 1, borderColor: COLORS.border, alignItems: 'center', justifyContent: 'center' },
  cancelText: { color: COLORS.text, fontWeight: '700' },
  saveButton: { flex: 1.5, minHeight: 42, borderRadius: 8, backgroundColor: COLORS.green, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center' },
  saveText: { color: COLORS.bg, fontWeight: '900' },
});
