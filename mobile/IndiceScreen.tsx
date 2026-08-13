import React from 'react';
import {
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';

export type ActiveLayer = 'off' | 'porcini' | 'finferli';

const UI = {
  bg0: '#0a110b',
  bg1: '#111a12',
  bg2: '#182019',
  bg3: '#1f2b20',
  border: '#2d4030',
  borderHi: '#3d5542',
  textPri: '#dde8cc',
  textSec: '#9aaf8d',
  textMut: '#647768',
  greenBri: '#6db85f',
  porcinoHi: '#b07a50',
  finferloHi: '#e0aa30',
};

const TILE_STOPS = [
  { score: 0, label: '0', color: 'rgba(255,255,255,0)' },
  { score: 5, label: '5', color: 'rgba(255,255,255,0.196)' },
  { score: 15, label: '15', color: 'rgba(180,230,255,0.588)' },
  { score: 30, label: '30', color: 'rgba(100,200,255,0.784)' },
  { score: 45, label: '45', color: 'rgb(80,180,90)' },
  { score: 60, label: '60', color: 'rgb(255,230,70)' },
  { score: 75, label: '75', color: 'rgb(255,120,60)' },
  { score: 90, label: '90', color: 'rgb(210,60,40)' },
  { score: 100, label: '100', color: 'rgb(120,78,42)' },
] as const;

const TILE_GRADIENT_COLORS = TILE_STOPS.map((stop) => stop.color) as unknown as readonly [
  string,
  string,
  ...string[],
];
const TILE_GRADIENT_LOCATIONS = TILE_STOPS.map((stop) => stop.score / 100) as unknown as readonly [
  number,
  number,
  ...number[],
];

const ADVICE_BANDS = [
  { range: '0-30', label: 'assenza', color: 'rgba(180,230,255,0.588)' },
  { range: '30-60', label: 'presenza debole', color: 'rgb(80,180,90)' },
  { range: '60-75', label: 'presenza moderata', color: 'rgb(255,230,70)' },
  { range: '75-100', label: 'presenza intensa', color: 'rgb(255,120,60)' },
] as const;

const LAYERS = [
  { key: 'off', label: 'Nessuno', color: UI.textMut },
  { key: 'porcini', label: 'Porcini', color: UI.porcinoHi },
  { key: 'finferli', label: 'Finferli', color: UI.finferloHi },
] as const;

const CALCULATION_STEPS = [
  {
    title: 'Terreno e bosco',
    text: 'Quota, copertura forestale, latifoglie e conifere, pendenza e posizione fra valle e crinale descrivono quanto il luogo è adatto e quanto riesce a trattenere acqua.',
  },
  {
    title: 'Pioggia e avvio del ciclo',
    text: 'Viene cercata una pioggia concentrata in tre giorni, avvenuta da 7 a 16 giorni prima. Si considera anche quanta pioggia è caduta nei giorni successivi.',
  },
  {
    title: 'Temperatura e umidità',
    text: 'Temperature minime, medie e massime e umidità media e minima indicano se, dopo la pioggia, le condizioni sono rimaste favorevoli alla crescita.',
  },
  {
    title: 'Rischio di asciugamento',
    text: 'Aria secca, raffiche, temperature elevate e terreni più esposti al sole o sui crinali riducono il risultato. Zone riparate e capaci di trattenere acqua lo sostengono.',
  },
  {
    title: 'Indice finale',
    text: 'Le condizioni del luogo e quelle meteorologiche devono funzionare insieme. Il risultato viene riportato su una scala da 0 a 100; un periodo recente favorevole può lasciare un effetto limitato nei giorni successivi.',
  },
] as const;

interface Props {
  activeLayer: ActiveLayer;
  setActiveLayer: (layer: ActiveLayer) => void;
}

export default function IndiceScreen({ activeLayer, setActiveLayer }: Props) {
  const activeLabel = LAYERS.find((layer) => layer.key === activeLayer)?.label ?? 'Nessuno';

  return (
    <SafeAreaView style={s.root} edges={['top']}>
      <StatusBar barStyle="light-content" backgroundColor={UI.bg0} />

      <View style={s.header}>
        <Text style={s.headerTitle}>INDICE FUNGHI</Text>
        <Text style={s.headerSub}>Condizioni giornaliere per porcini e finferli, da 0 a 100</Text>
      </View>

      <ScrollView style={s.body} contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
        <View style={s.section}>
          <View style={s.sectionHead}>
            <Text style={s.sectionTitle}>INDICE SULLA MAPPA</Text>
            <Text style={s.statusText}>{activeLabel}</Text>
          </View>
          <View style={s.layerRow}>
            {LAYERS.map((layer) => {
              const selected = activeLayer === layer.key;
              return (
                <TouchableOpacity
                  key={layer.key}
                  style={[
                    s.layerButton,
                    selected && { borderColor: layer.color, backgroundColor: `${layer.color}22` },
                  ]}
                  onPress={() => setActiveLayer(layer.key)}
                  activeOpacity={0.78}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`${layer.label}${selected ? ', attivo' : ''}`}
                >
                  <View style={[s.layerDot, { backgroundColor: layer.color }]} />
                  <Text style={[s.layerLabel, selected && { color: layer.color }]}>{layer.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text style={s.sectionSub}>La scelta aggiorna solo il livello colorato visibile sulla mappa.</Text>
        </View>

        <View style={s.section}>
          <Text style={s.sectionTitle}>LEGENDA</Text>
          <Text style={s.sectionSub}>
            I valori bassi sono quasi trasparenti. Il colore diventa più evidente al crescere dell'indice.
          </Text>

          <View style={s.legendBox} accessible accessibilityRole="image" accessibilityLabel="Scala dell'indice da zero a cento, da trasparente e azzurro fino a verde, giallo, arancione, rosso e marrone">
            <LinearGradient
              colors={TILE_GRADIENT_COLORS}
              locations={TILE_GRADIENT_LOCATIONS}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              style={s.legendGradient}
            />
            <View style={s.tickTrack}>
              {TILE_STOPS.slice(0, -1).map((stop, index) => {
                const next = TILE_STOPS[index + 1];
                return (
                  <View key={stop.score} style={[s.tickInterval, { flex: next.score - stop.score }]}>
                    <View style={s.tickLine} />
                    <Text style={s.tickText}>{stop.label}</Text>
                  </View>
                );
              })}
              <View style={s.lastTick}>
                <View style={s.tickLine} />
                <Text style={s.tickText}>100</Text>
              </View>
            </View>
          </View>

          <View style={s.adviceBox}>
            <Text style={s.adviceTitle}>COME LEGGERLO</Text>
            {ADVICE_BANDS.map((band) => (
              <View key={band.range} style={[s.adviceRow, { borderLeftColor: band.color }]}>
                <Text style={s.adviceRange}>{band.range}</Text>
                <Text style={s.adviceLabel}>{band.label}</Text>
              </View>
            ))}
          </View>
        </View>

        <View style={[s.section, s.lastSection]}>
          <Text style={s.sectionTitle}>COME VIENE CALCOLATO</Text>
          <Text style={s.calculationIntro}>
            L'indice confronta le caratteristiche del luogo con il meteo degli ultimi 19 giorni. Cerca le condizioni che possono aver avviato e sostenuto il ciclo dei funghi, con criteri specifici per ogni specie.
          </Text>
          {CALCULATION_STEPS.map((step) => (
            <View key={step.title} style={s.factorRow}>
              <Text style={s.factorName}>{step.title}</Text>
              <Text style={s.factorDesc}>{step.text}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: UI.bg0 },
  header: {
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: UI.border,
    backgroundColor: UI.bg0,
  },
  headerTitle: { color: UI.textPri, fontSize: 21, fontWeight: '900', letterSpacing: 3 },
  headerSub: { color: UI.textMut, fontSize: 11, fontWeight: '600', marginTop: 4 },
  body: { flex: 1 },
  scroll: { padding: 14, gap: 12 },
  section: {
    backgroundColor: UI.bg1,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: UI.border,
    padding: 13,
    gap: 11,
  },
  lastSection: { marginBottom: 28 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  sectionTitle: { color: UI.textMut, fontSize: 10, fontWeight: '900', letterSpacing: 2 },
  sectionSub: { color: UI.textSec, fontSize: 11, lineHeight: 16 },
  statusText: { color: UI.textPri, fontSize: 11, fontWeight: '800' },
  layerRow: { flexDirection: 'row', gap: 7 },
  layerButton: {
    flex: 1,
    minHeight: 43,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 7,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: UI.border,
    backgroundColor: UI.bg2,
  },
  layerDot: { width: 9, height: 9, borderRadius: 5 },
  layerLabel: { color: UI.textPri, fontSize: 11, fontWeight: '900' },
  legendBox: { gap: 5 },
  legendGradient: {
    height: 24,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: UI.borderHi,
    backgroundColor: UI.bg3,
  },
  tickTrack: { flexDirection: 'row', paddingRight: 10 },
  tickInterval: { alignItems: 'flex-start', gap: 2 },
  lastTick: { width: 20, alignItems: 'flex-end', gap: 2, marginLeft: -10 },
  tickLine: { width: 1, height: 5, backgroundColor: UI.borderHi },
  tickText: { color: UI.textMut, fontSize: 8, fontWeight: '800' },
  adviceBox: {
    borderWidth: 1,
    borderColor: UI.borderHi,
    borderRadius: 8,
    padding: 10,
    gap: 7,
    backgroundColor: UI.bg2,
  },
  adviceTitle: { color: UI.textMut, fontSize: 10, fontWeight: '900', letterSpacing: 1.4 },
  adviceRow: {
    minHeight: 29,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderLeftWidth: 4,
    paddingLeft: 9,
  },
  adviceRange: { width: 50, color: UI.textPri, fontSize: 12, fontWeight: '900' },
  adviceLabel: { flex: 1, color: UI.textSec, fontSize: 12, fontWeight: '700' },
  calculationIntro: { color: UI.textSec, fontSize: 12, lineHeight: 18 },
  factorRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: UI.border,
    paddingTop: 11,
    gap: 4,
  },
  factorName: { color: UI.textPri, fontSize: 12, fontWeight: '900' },
  factorDesc: { color: UI.textSec, fontSize: 11, lineHeight: 17 },
});
