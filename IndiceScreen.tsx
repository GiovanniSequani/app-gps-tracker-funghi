/**
 * IndiceScreen.tsx  — v2
 *
 * Pannello di controllo del layer indice funghi + legenda/info.
 * NON contiene più una mappa propria.
 *
 * Riceve:
 *   activeLayer   : 'off' | 'porcini' | 'finferli'
 *   setActiveLayer: (l: ActiveLayer) => void
 *
 * Queste props vengono sollevate in App.tsx e condivise con MainUI,
 * che usa activeLayer per mostrare/nascondere la WebView sovrapposta.
 */

import React from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ScrollView, StatusBar, Animated, Easing, TextInput
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// ─── Tipi ─────────────────────────────────────────────────────────────────────
export type ActiveLayer = 'off' | 'porcini' | 'finferli';

// ─── Palette ──────────────────────────────────────────────────────────────────
const UI = {
  bg0: '#0a110b', bg1: '#111a12', bg2: '#182019', bg3: '#1f2b20',
  border: '#2d4030', borderHi: '#3d5542',
  textPri: '#dde8cc', textSec: '#8ba67a', textMut: '#4d6352',
  green: '#4a8c3f', greenBri: '#6db85f', greenDim: '#2e5528',
  amber: '#c8832a', amberBri: '#e8a040',
  porcino: '#8B5E3C', porcinoHi: '#b07a50',
  finferlo: '#C9901A', finferloHi: '#e0aa30',
};

// ─── Config specie ─────────────────────────────────────────────────────────────
const SPECIES = {
  porcini: {
    label: 'Porcini', emoji: '🍄',
    color: UI.porcinoHi, colorDim: '#4a2010',
    sciName: 'Boletus edulis',
    altitudine: '800–1800 m', temperatura: '12–18 °C',
    vegetazione: 'Abete rosso, faggio',
    pioggia: '15–30 mm in 5–7 gg', latenza: '7–10 gg dopo pioggia',
    gradientColors: ['#1a0800', '#4a2010', '#8B5E3C', '#c8832a', '#e8c060'],
  },
  finferli: {
    label: 'Finferli', emoji: '🌼',
    color: UI.finferloHi, colorDim: '#2a2000',
    sciName: 'Cantharellus cibarius',
    altitudine: '300–1200 m', temperatura: '14–20 °C',
    vegetazione: 'Bosco misto, abete, faggio',
    pioggia: '20–40 mm in 7–10 gg', latenza: '5–8 gg dopo pioggia',
    gradientColors: ['#0a0a00', '#2a2000', '#6a5010', '#C9901A', '#ffe060'],
  },
} as const;

type SpeciesKey = keyof typeof SPECIES;

// ─── Props ────────────────────────────────────────────────────────────────────
interface Props {
  activeLayer: ActiveLayer;
  setActiveLayer: (l: ActiveLayer) => void;
  tileDate: string;
  setTileDate: (v: string) => void;
  tileVersion: string;
  setTileVersion: (v: string) => void;
}

// ─── Componente ───────────────────────────────────────────────────────────────
export default function IndiceScreen({
  activeLayer,
  setActiveLayer,
  tileDate,
  setTileDate,
  tileVersion,
  setTileVersion,
}: Props) {

  const [expandedSpecies, setExpandedSpecies] = React.useState<SpeciesKey | null>(null);
  const expandAnim = React.useRef<Record<SpeciesKey, Animated.Value>>({
    porcini: new Animated.Value(0),
    finferli: new Animated.Value(0),
  }).current;

  const toggleExpand = (sp: SpeciesKey) => {
    const isOpen = expandedSpecies === sp;
    const prev = expandedSpecies;
    if (prev && prev !== sp) {
      Animated.timing(expandAnim[prev], {
        toValue: 0, duration: 200, easing: Easing.out(Easing.cubic), useNativeDriver: false,
      }).start();
    }
    setExpandedSpecies(isOpen ? null : sp);
    Animated.timing(expandAnim[sp], {
      toValue: isOpen ? 0 : 1, duration: 250, easing: Easing.out(Easing.cubic), useNativeDriver: false,
    }).start();
  };

  const today = new Date();
  const updateDate = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;

  return (
    <SafeAreaView style={s.root} edges={['top']}>
      <StatusBar barStyle="light-content" backgroundColor={UI.bg0} />

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <View style={s.header}>
        <Text style={s.headerTitle}>INDICE FUNGHI</Text>
        <Text style={s.headerSub}>Trentino · Alto Adige · Alpi Venete</Text>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>

        {/* ── Sezione layer attivo ────────────────────────────────────── */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>LAYER SULLA MAPPA</Text>
          <Text style={s.sectionSub}>
            Seleziona una specie per sovrapporre l'indice di probabilità alla mappa principale
          </Text>

          {/* OFF */}
          <TouchableOpacity
            style={[s.layerBtn, activeLayer === 'off' && s.layerBtnActiveOff]}
            onPress={() => setActiveLayer('off')}
            activeOpacity={0.75}
          >
            <View style={[s.layerDot, { backgroundColor: UI.textMut }]} />
            <Text style={[s.layerLabel, activeLayer === 'off' && { color: UI.textPri }]}>
              NESSUN LAYER
            </Text>
            {activeLayer === 'off' && <Text style={s.checkmark}>✓</Text>}
          </TouchableOpacity>

          {/* Porcini / Finferli */}
          {(['porcini', 'finferli'] as SpeciesKey[]).map((sp) => {
            const cfg = SPECIES[sp];
            const isActive = activeLayer === sp;
            return (
              <TouchableOpacity
                key={sp}
                style={[s.layerBtn, isActive && {
                  backgroundColor: cfg.colorDim + 'cc',
                  borderColor: cfg.color,
                }]}
                onPress={() => setActiveLayer(isActive ? 'off' : sp)}
                activeOpacity={0.75}
              >
                <Text style={s.layerEmoji}>{cfg.emoji}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={[s.layerLabel, isActive && { color: cfg.color }]}>
                    {cfg.label.toUpperCase()}
                  </Text>
                  <Text style={s.layerSci}>{cfg.sciName}</Text>
                </View>
                {isActive
                  ? <Text style={[s.checkmark, { color: cfg.color }]}>✓ ATTIVO</Text>
                  : <Text style={s.tapHint}>TAP PER ATTIVARE</Text>
                }
              </TouchableOpacity>
            );
          })}
        </View>

        {/* ── Config tiles ─────────────────────────────────────────────── */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>CONFIGURAZIONE TILE</Text>
          <Text style={s.sectionSub}>
            Scegli data e versione del dataset da caricare da Supabase
          </Text>

          <View style={s.inputGroup}>
            <Text style={s.inputLabel}>DATA</Text>
            <TextInput
              style={s.textInput}
              value={tileDate}
              onChangeText={setTileDate}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={UI.textMut}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <View style={s.inputGroup}>
            <Text style={s.inputLabel}>VERSIONE</Text>
            <TextInput
              style={s.textInput}
              value={tileVersion}
              onChangeText={setTileVersion}
              placeholder="1"
              placeholderTextColor={UI.textMut}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="numeric"
            />
          </View>

          <View style={s.updateRow}>
            <Text style={s.updateLabel}>Path attuale</Text>
            <Text style={s.updateVal}>{tileDate}_v{tileVersion}</Text>
          </View>
        </View>

        {/* ── Legenda ─────────────────────────────────────────────────── */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>LEGENDA</Text>

          {(['porcini', 'finferli'] as SpeciesKey[]).map((sp) => {
            const cfg = SPECIES[sp];
            const heightAnim = expandAnim[sp].interpolate({ inputRange: [0, 1], outputRange: [0, 208] });
            const isOpen = expandedSpecies === sp;

            return (
              <View key={sp} style={s.legendCard}>
                <TouchableOpacity
                  style={s.legendCardHeader}
                  onPress={() => toggleExpand(sp)}
                  activeOpacity={0.75}
                >
                  <Text style={s.legendEmoji}>{cfg.emoji}</Text>
                  <Text style={[s.legendCardTitle, { color: cfg.color }]}>
                    {cfg.label.toUpperCase()}
                  </Text>
                  <Text style={s.chevron}>{isOpen ? '▲' : '▼'}</Text>
                </TouchableOpacity>

                {/* Barra gradiente */}
                <View style={s.gradientBar}>
                  {cfg.gradientColors.map((c, i) => (
                    <View key={i} style={[s.gradientSeg, { backgroundColor: c }]} />
                  ))}
                </View>
                <View style={s.gradientLabels}>
                  {['0', '25', '50', '75', '100'].map((l) => (
                    <Text key={l} style={s.gradientLabel}>{l}</Text>
                  ))}
                </View>

                {/* Dettagli espandibili */}
                <Animated.View style={{ height: heightAnim, opacity: expandAnim[sp], overflow: 'hidden' }}>
                  <View style={s.details}>
                    {[
                      { icon: '⛰', label: 'Altitudine', val: cfg.altitudine },
                      { icon: '🌡', label: 'Temperatura', val: cfg.temperatura },
                      { icon: '🌲', label: 'Vegetazione', val: cfg.vegetazione },
                      { icon: '🌧', label: 'Pioggia trigger', val: cfg.pioggia },
                      { icon: '⏱', label: 'Latenza crescita', val: cfg.latenza },
                    ].map(({ icon, label, val }) => (
                      <View key={label} style={s.detailRow}>
                        <Text style={s.detailIcon}>{icon}</Text>
                        <Text style={s.detailLabel}>{label}</Text>
                        <Text style={[s.detailVal, { color: cfg.color }]}>{val}</Text>
                      </View>
                    ))}
                  </View>
                </Animated.View>
              </View>
            );
          })}
        </View>

        {/* ── Fonti dati ──────────────────────────────────────────────── */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>FONTI DATI</Text>
          {[
            { icon: '🗺', name: 'DEM', src: 'Copernicus GLO-10', res: '25 m (output)' },
            { icon: '🌿', name: 'Vegetazione', src: 'ESA WorldCover', res: '10 m' },
            { icon: '📡', name: 'Meteo', src: 'Open-Meteo ICON-D2', res: '~1 km' },
            { icon: '🧭', name: 'Aspect / Slope', src: 'Calcolato da DEM', res: '25 m' },
          ].map(({ icon, name, src, res }) => (
            <View key={name} style={s.sourceRow}>
              <Text style={s.sourceIcon}>{icon}</Text>
              <View style={{ flex: 1 }}>
                <Text style={s.sourceName}>{name}</Text>
                <Text style={s.sourceSrc}>{src}</Text>
              </View>
              <Text style={s.sourceRes}>{res}</Text>
            </View>
          ))}
        </View>

        {/* ── Aggiornamento ───────────────────────────────────────────── */}
        <View style={[s.section, { marginBottom: 32 }]}>
          <Text style={s.sectionTitle}>AGGIORNAMENTO</Text>
          {[
            { label: '📅  Ultimo calcolo', val: updateDate },
            { label: '🔄  Frequenza', val: 'Giornaliera' },
            { label: '⏳  Lag meteo', val: '~5 giorni' },
          ].map(({ label, val }) => (
            <View key={label} style={s.updateRow}>
              <Text style={s.updateLabel}>{label}</Text>
              <Text style={s.updateVal}>{val}</Text>
            </View>
          ))}

          <View style={s.placeholderBanner}>
            <Text style={s.placeholderTitle}>⚙  DATI SIMULATI</Text>
            <Text style={s.placeholderBody}>
              Il layer attuale mostra dati placeholder generati algoritmicamente.
              L'indice reale sarà disponibile al completamento del pipeline Python.
            </Text>
          </View>
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Stili ────────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: UI.bg0 },
  header: {
    paddingHorizontal: 20, paddingTop: 8, paddingBottom: 14,
    borderBottomWidth: 1, borderBottomColor: UI.border,
  },
  headerTitle: { color: UI.textPri, fontSize: 22, fontWeight: '900', letterSpacing: 5 },
  headerSub: { color: UI.textMut, fontSize: 10, fontWeight: '600', letterSpacing: 1, marginTop: 2 },
  scroll: { padding: 16, gap: 16 },
  section: {
    backgroundColor: UI.bg1, borderRadius: 14, borderWidth: 1,
    borderColor: UI.border, padding: 16, gap: 10,
  },
  sectionTitle: { color: UI.textMut, fontSize: 10, fontWeight: '800', letterSpacing: 2.5 },
  sectionSub: { color: UI.textMut, fontSize: 11, lineHeight: 15 },

  // Layer buttons
  layerBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 12, paddingHorizontal: 14,
    borderRadius: 10, borderWidth: 1.5, borderColor: UI.border, backgroundColor: UI.bg2,
  },
  layerBtnActiveOff: { borderColor: UI.textSec, backgroundColor: UI.bg3 },
  layerDot: { width: 10, height: 10, borderRadius: 5 },
  layerEmoji: { fontSize: 18 },
  layerLabel: { color: UI.textMut, fontSize: 13, fontWeight: '800', letterSpacing: 1 },
  layerSci: { color: UI.textMut, fontSize: 10, fontStyle: 'italic', marginTop: 1 },
  checkmark: { color: UI.greenBri, fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  tapHint: { color: UI.textMut, fontSize: 9, fontWeight: '600', letterSpacing: 0.5 },

  // Legenda card
  legendCard: {
    backgroundColor: UI.bg2, borderRadius: 10,
    borderWidth: 1, borderColor: UI.border, overflow: 'hidden',
  },
  legendCardHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, paddingVertical: 12,
  },
  legendEmoji: { fontSize: 16 },
  legendCardTitle: { flex: 1, fontSize: 13, fontWeight: '800', letterSpacing: 1 },
  chevron: { color: UI.textMut, fontSize: 10 },
  gradientBar: { flexDirection: 'row', height: 8, marginHorizontal: 14 },
  gradientSeg: { flex: 1 },
  gradientLabels: {
    flexDirection: 'row', justifyContent: 'space-between',
    marginHorizontal: 14, marginTop: 3, marginBottom: 4,
  },
  gradientLabel: { color: UI.textMut, fontSize: 9, fontWeight: '600' },
  details: { paddingHorizontal: 14, paddingBottom: 12, paddingTop: 6, gap: 6 },
  detailRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  detailIcon: { fontSize: 12, width: 18 },
  detailLabel: { color: UI.textMut, fontSize: 11, flex: 1 },
  detailVal: { fontSize: 11, fontWeight: '700' },

  // Fonti
  sourceRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: UI.border,
  },
  sourceIcon: { fontSize: 14, width: 20 },
  sourceName: { color: UI.textPri, fontSize: 12, fontWeight: '700' },
  sourceSrc: { color: UI.textMut, fontSize: 10, marginTop: 1 },
  sourceRes: { color: UI.textSec, fontSize: 10, fontWeight: '600' },

  // Aggiornamento
  updateRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: UI.border,
  },
  updateLabel: { color: UI.textMut, fontSize: 12 },
  updateVal: { color: UI.textPri, fontSize: 12, fontWeight: '700' },

  // Placeholder banner
  placeholderBanner: {
    marginTop: 4, padding: 12, borderRadius: 8,
    backgroundColor: 'rgba(200,131,42,0.10)', borderWidth: 1, borderColor: UI.amber,
  },
  placeholderTitle: { color: UI.amberBri, fontSize: 11, fontWeight: '800', letterSpacing: 1.5, marginBottom: 5 },
  placeholderBody: { color: UI.amber, fontSize: 11, lineHeight: 16 },

  // Inputs
  inputGroup: {
    gap: 6,
    marginTop: 4,
  },
  inputLabel: {
    color: UI.textSec,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
  },
  textInput: {
    backgroundColor: UI.bg2,
    borderWidth: 1,
    borderColor: UI.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: UI.textPri,
    fontSize: 13,
    fontWeight: '600',
  },
});
