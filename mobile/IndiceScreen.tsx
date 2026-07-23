import React from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, StatusBar, TextInput,
} from 'react-native';
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
  textSec: '#8ba67a',
  textMut: '#4d6352',
  green: '#4a8c3f',
  greenBri: '#6db85f',
  greenDim: '#2e5528',
  amber: '#c8832a',
  amberBri: '#e8a040',
  red: '#8c3030',
  porcino: '#8B5E3C',
  porcinoHi: '#b07a50',
  finferlo: '#C9901A',
  finferloHi: '#e0aa30',
};

const TILE_COLORMAP = [
  { value: 'nv', score: null, label: 'No data', name: 'bianco', alpha: 0, transparency: 100, color: 'rgba(255,255,255,0)', border: 'rgba(255,255,255,0.25)' },
  { value: '0', score: 0, label: '0', name: 'bianco', alpha: 0, transparency: 100, color: 'rgba(255,255,255,0)', border: 'rgba(255,255,255,0.25)' },
  { value: '5', score: 5, label: '5', name: 'bianco', alpha: 50, transparency: 80, color: 'rgba(255,255,255,0.20)', border: 'rgba(255,255,255,0.35)' },
  { value: '15', score: 15, label: '15', name: 'azzurro chiaro', alpha: 150, transparency: 41, color: 'rgba(180,230,255,0.59)' },
  { value: '30', score: 30, label: '30', name: 'azzurro', alpha: 200, transparency: 22, color: 'rgba(100,200,255,0.78)' },
  { value: '45', score: 45, label: '45', name: 'verde', alpha: 255, transparency: 0, color: 'rgba(80,180,90,1)' },
  { value: '60', score: 60, label: '60', name: 'giallo', alpha: 255, transparency: 0, color: 'rgba(255,230,70,1)' },
  { value: '75', score: 75, label: '75', name: 'arancione', alpha: 255, transparency: 0, color: 'rgba(255,120,60,1)' },
  { value: '90', score: 90, label: '90', name: 'rosso', alpha: 255, transparency: 0, color: 'rgba(210,60,40,1)' },
  { value: '100', score: 100, label: '100', name: 'marrone', alpha: 255, transparency: 0, color: 'rgba(120,78,42,1)' },
];

const TILE_STOPS = TILE_COLORMAP.filter((step) => step.score !== null);
const TILE_INTERVALS = TILE_STOPS.slice(0, -1).map((from, index) => {
  const to = TILE_STOPS[index + 1];
  return {
    key: `${from.value}-${to.value}`,
    from,
    to,
    flex: Math.max(1, (to.score ?? 0) - (from.score ?? 0)),
  };
});

const ADVICE_BANDS = [
  { range: '0-30', label: 'assenza', color: UI.textMut },
  { range: '30-60', label: 'presenza debole', color: '#64c8ff' },
  { range: '60-75', label: 'presenza moderata', color: '#ffe646' },
  { range: '75-100', label: 'presenza intensa', color: '#ff783c' },
];

const SPECIES = {
  porcini: {
    label: 'Porcini',
    scientific: 'Boletus edulis',
    color: UI.porcinoHi,
    dim: '#4a2010',
    elevation: '700-1700 m ottimale, 350-2250 m utile',
    rain: 'Trigger 16-45 mm in 3 giorni, tolleranza 4-95 mm',
    postRain: 'Pioggia post-trigger 4-28 mm, tolleranza 0-75 mm',
    temp: 'T media 10-18 C, min 5-13 C, max 15-24 C',
    humidity: 'UR media 68-95%, UR minima 42-78%',
    forest: 'Mix bosco: latifoglie 55%, conifere 45%',
    weights: [
      ['Trigger', '30%'],
      ['Incubazione', '22%'],
      ['Umidita', '16%'],
      ['Stress', '4%'],
    ],
  },
  finferli: {
    label: 'Finferli',
    scientific: 'Cantharellus cibarius',
    color: UI.finferloHi,
    dim: '#2a2000',
    elevation: '400-1300 m ottimale, 200-1850 m utile',
    rain: 'Trigger 20-55 mm in 3 giorni, tolleranza 6-115 mm',
    postRain: 'Pioggia post-trigger 6-35 mm, tolleranza 0-90 mm',
    temp: 'T media 12-20 C, min 7-15 C, max 17-26 C',
    humidity: 'UR media 72-96%, UR minima 46-80%',
    forest: 'Mix bosco: latifoglie 60%, conifere 40%',
    weights: [
      ['Trigger', '30%'],
      ['Incubazione', '24%'],
      ['Umidita', '18%'],
      ['Stress', '4%'],
    ],
  },
} as const;

const FACTORS = [
  ['Habitat statico', 'quota, copertura forestale, mix latifoglie/conifere, pendenza, ritenzione'],
  ['Trigger pioggia', 'somma precipitazioni nella finestra trigger di 3 giorni'],
  ['Incubazione', 'temperatura, umidita e pioggia dopo il trigger'],
  ['Moisture', 'pioggia post-trigger, ritenzione e umidita'],
  ['Stress', 'penalita da secco, vento, caldo, esposizione e crinali'],
];

interface Props {
  activeLayer: ActiveLayer;
  setActiveLayer: (layer: ActiveLayer) => void;
  tileDate: string;
  setTileDate: (value: string) => void;
  tileVersion: string;
  setTileVersion: (value: string) => void;
}

export default function IndiceScreen({
  activeLayer,
  setActiveLayer,
  tileDate,
  setTileDate,
  tileVersion,
  setTileVersion,
}: Props) {
  const activeSpecies = activeLayer === 'off' ? null : SPECIES[activeLayer];

  return (
    <SafeAreaView style={s.root} edges={['top']}>
      <StatusBar barStyle="light-content" backgroundColor={UI.bg0} />

      <View style={s.header}>
        <Text style={s.headerTitle}>INDICE FUNGHI</Text>
        <Text style={s.headerSub}>Score giornaliero 0-100 da meteo, terreno e vegetazione</Text>
      </View>

      <ScrollView style={s.body} contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
        <View style={s.section}>
          <View style={s.sectionHead}>
            <Text style={s.sectionTitle}>LAYER MAPPA</Text>
            <Text style={s.statusText}>{activeSpecies ? activeSpecies.label : 'Nessun indice'}</Text>
          </View>

          <TouchableOpacity
            style={[s.layerBtn, activeLayer === 'off' && s.layerBtnOffActive]}
            onPress={() => setActiveLayer('off')}
            activeOpacity={0.78}
          >
            <View style={[s.layerDot, { backgroundColor: UI.textMut }]} />
            <View style={s.layerTextBox}>
              <Text style={s.layerLabel}>NESSUN INDICE</Text>
              <Text style={s.layerSub}>Rimuove il raster dalla mappa</Text>
            </View>
            {activeLayer === 'off' && <Text style={s.activeMark}>ATTIVO</Text>}
          </TouchableOpacity>

          {(['porcini', 'finferli'] as const).map((key) => {
            const item = SPECIES[key];
            const selected = activeLayer === key;
            return (
              <TouchableOpacity
                key={key}
                style={[
                  s.layerBtn,
                  selected && { borderColor: item.color, backgroundColor: item.dim },
                ]}
                onPress={() => setActiveLayer(selected ? 'off' : key)}
                activeOpacity={0.78}
              >
                <View style={[s.layerDot, { backgroundColor: item.color }]} />
                <View style={s.layerTextBox}>
                  <Text style={[s.layerLabel, selected && { color: item.color }]}>{item.label.toUpperCase()}</Text>
                  <Text style={s.layerSub}>{item.scientific}</Text>
                </View>
                {selected && <Text style={[s.activeMark, { color: item.color }]}>ATTIVO</Text>}
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={s.section}>
          <Text style={s.sectionTitle}>DATASET TILE</Text>
          <Text style={s.sectionSub}>
            Il percorso pubblico e' `tiles/{tileDate}_v{tileVersion}/species/z/x/y.png`.
          </Text>
          <View style={s.datasetGrid}>
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
            <View style={s.inputGroupSmall}>
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
          </View>
        </View>

        <View style={s.section}>
          <Text style={s.sectionTitle}>LEGENDA TILE</Text>
          <Text style={s.sectionSub}>
            Scala RGBA esatta generata da `backend/scripts/tiles/01_build_tiles_gdal.py`.
            I colori sono interpolati fra i tick: vicino allo zero prevale la trasparenza,
            da 45 in poi l'alpha e' pieno.
          </Text>

          <View style={s.axisBox}>
            <View style={s.legendBar}>
              {TILE_INTERVALS.map((item) => (
                <View
                  key={item.key}
                  style={[
                    s.legendSegment,
                    {
                      flex: item.flex,
                      backgroundColor: item.from.color,
                      borderColor: item.from.border ?? item.from.color,
                    },
                  ]}
                />
              ))}
            </View>
            <View style={s.tickTrack}>
              {TILE_INTERVALS.map((item) => (
                <View key={item.key} style={[s.tickInterval, { flex: item.flex }]}>
                  <View style={s.tickLine} />
                  <Text style={s.tickText}>{item.from.label}</Text>
                </View>
              ))}
              <View style={s.lastTick}>
                <View style={s.tickLine} />
                <Text style={s.tickText}>100</Text>
              </View>
            </View>
          </View>

          <View style={s.intervalTable}>
            {TILE_INTERVALS.map((item) => (
              <View key={item.key} style={s.intervalRow}>
                <View style={[s.swatch, { backgroundColor: item.from.color, borderColor: item.from.border ?? item.from.color }]} />
                <Text style={s.intervalRange}>{item.from.label}-{item.to.label}</Text>
                <Text style={s.intervalDesc}>
                  {item.from.name}
                  {item.from.name !== item.to.name ? ` -> ${item.to.name}` : ''}
                  {'  '}trasparenza {item.from.transparency}-{item.to.transparency}%
                </Text>
              </View>
            ))}
          </View>

          <View style={s.adviceBox}>
            <Text style={s.adviceTitle}>CONSIGLIO DI LETTURA</Text>
            {ADVICE_BANDS.map((band) => (
              <View key={band.range} style={s.adviceRow}>
                <Text style={[s.adviceRange, { color: band.color }]}>{band.range}</Text>
                <Text style={s.adviceLabel}>{band.label}</Text>
              </View>
            ))}
          </View>
        </View>

        <View style={s.section}>
          <Text style={s.sectionTitle}>COME VIENE CALCOLATO</Text>
          <Text style={s.sectionSub}>
            Il backend usa una finestra meteo recente di 19 giorni. Per ogni specie valuta trigger di pioggia
            con lag da 7 a 16 giorni, poi combina habitat statico e condizioni dinamiche.
          </Text>
          {FACTORS.map(([name, desc]) => (
            <View key={name} style={s.factorRow}>
              <Text style={s.factorName}>{name}</Text>
              <Text style={s.factorDesc}>{desc}</Text>
            </View>
          ))}
          <View style={s.formulaBox}>
            <Text style={s.formulaText}>
              Score finale = 100 * (0.72 * habitat * potential + 0.28 * habitat * dynamic_mix * potential^0.45)
            </Text>
          </View>
        </View>

        {(['porcini', 'finferli'] as const).map((key) => {
          const item = SPECIES[key];
          return (
            <View key={key} style={s.section}>
              <View style={s.speciesHead}>
                <View>
                  <Text style={[s.speciesTitle, { color: item.color }]}>{item.label.toUpperCase()}</Text>
                  <Text style={s.speciesSci}>{item.scientific}</Text>
                </View>
                <View style={[s.speciesBadge, { borderColor: item.color, backgroundColor: item.dim }]}>
                  <Text style={[s.speciesBadgeText, { color: item.color }]}>{activeLayer === key ? 'MAPPA' : 'INFO'}</Text>
                </View>
              </View>

              <View style={s.paramGrid}>
                <InfoLine label="Quota" value={item.elevation} />
                <InfoLine label="Pioggia trigger" value={item.rain} />
                <InfoLine label="Pioggia dopo trigger" value={item.postRain} />
                <InfoLine label="Temperature" value={item.temp} />
                <InfoLine label="Umidita" value={item.humidity} />
                <InfoLine label="Bosco" value={item.forest} />
              </View>

              <Text style={s.weightsTitle}>Pesi dinamici</Text>
              <View style={s.weightRow}>
                {item.weights.map(([label, value]) => (
                  <View key={label} style={s.weightPill}>
                    <Text style={s.weightValue}>{value}</Text>
                    <Text style={s.weightLabel}>{label}</Text>
                  </View>
                ))}
              </View>
            </View>
          );
        })}

        <View style={[s.section, { marginBottom: 28 }]}>
          <Text style={s.sectionTitle}>DATI USATI</Text>
          <DataLine name="Meteo giornaliero" value="t2m mean/min/max, precipitazione, umidita, raffiche vento" />
          <DataLine name="Terreno" value="quota, pendenza, TPI, esposizione nord/sud/est/ovest" />
          <DataLine name="Vegetazione" value="percentuale latifoglie, conifere e non bosco" />
          <DataLine name="Derivati statici" value="ritenzione, esposizione al secco, crinali e ripari di valle" />
          <DataLine name="Output" value="NetCDF con score 0-100 e PNG tiles XYZ zoom 8-14" />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.infoLine}>
      <Text style={s.infoLabel}>{label}</Text>
      <Text style={s.infoValue}>{value}</Text>
    </View>
  );
}

function DataLine({ name, value }: { name: string; value: string }) {
  return (
    <View style={s.dataLine}>
      <Text style={s.dataName}>{name}</Text>
      <Text style={s.dataValue}>{value}</Text>
    </View>
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
    borderRadius: 8,
    borderWidth: 1,
    borderColor: UI.border,
    padding: 14,
    gap: 10,
  },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  sectionTitle: { color: UI.textMut, fontSize: 10, fontWeight: '900', letterSpacing: 2 },
  sectionSub: { color: UI.textSec, fontSize: 11, lineHeight: 16 },
  statusText: { color: UI.textPri, fontSize: 11, fontWeight: '800' },
  layerBtn: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: UI.border,
    backgroundColor: UI.bg2,
  },
  layerBtnOffActive: { borderColor: UI.textSec, backgroundColor: UI.bg3 },
  layerDot: { width: 12, height: 12, borderRadius: 6 },
  layerTextBox: { flex: 1, minWidth: 0 },
  layerLabel: { color: UI.textPri, fontSize: 13, fontWeight: '900', letterSpacing: 0.8 },
  layerSub: { color: UI.textMut, fontSize: 10, marginTop: 2 },
  activeMark: { color: UI.greenBri, fontSize: 10, fontWeight: '900' },
  datasetGrid: { flexDirection: 'row', gap: 10 },
  inputGroup: { flex: 1, gap: 5 },
  inputGroupSmall: { width: 92, gap: 5 },
  inputLabel: { color: UI.textMut, fontSize: 9, fontWeight: '900', letterSpacing: 1.2 },
  textInput: {
    color: UI.textPri,
    backgroundColor: UI.bg2,
    borderWidth: 1,
    borderColor: UI.border,
    borderRadius: 7,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    fontWeight: '700',
  },
  axisBox: { gap: 6 },
  legendBar: {
    height: 22,
    flexDirection: 'row',
    borderRadius: 6,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: UI.borderHi,
    backgroundColor: UI.bg0,
  },
  legendSegment: { flex: 1, borderRightWidth: 1 },
  tickTrack: { flexDirection: 'row', paddingRight: 10 },
  tickInterval: { alignItems: 'flex-start', gap: 2 },
  lastTick: { width: 20, alignItems: 'flex-end', gap: 2, marginLeft: -10 },
  tickLine: { width: 1, height: 6, backgroundColor: UI.borderHi },
  tickText: { color: UI.textMut, fontSize: 9, fontWeight: '700' },
  intervalTable: { gap: 6 },
  intervalRow: {
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 3,
    borderBottomWidth: 1,
    borderBottomColor: UI.border,
  },
  intervalRange: { width: 46, color: UI.textPri, fontSize: 11, fontWeight: '900' },
  intervalDesc: { flex: 1, color: UI.textSec, fontSize: 11, lineHeight: 15 },
  swatch: { width: 22, height: 18, borderRadius: 4, borderWidth: 1, backgroundColor: UI.bg0 },
  adviceBox: { borderWidth: 1, borderColor: UI.borderHi, borderRadius: 7, padding: 10, gap: 6, backgroundColor: UI.bg2 },
  adviceTitle: { color: UI.textMut, fontSize: 10, fontWeight: '900', letterSpacing: 1.4 },
  adviceRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  adviceRange: { width: 48, fontSize: 12, fontWeight: '900' },
  adviceLabel: { flex: 1, color: UI.textSec, fontSize: 12, fontWeight: '700' },
  factorRow: {
    borderLeftWidth: 2,
    borderLeftColor: UI.green,
    paddingLeft: 10,
    gap: 2,
  },
  factorName: { color: UI.textPri, fontSize: 12, fontWeight: '900' },
  factorDesc: { color: UI.textSec, fontSize: 11, lineHeight: 15 },
  formulaBox: {
    borderRadius: 7,
    borderWidth: 1,
    borderColor: UI.borderHi,
    backgroundColor: UI.bg2,
    padding: 10,
  },
  formulaText: { color: UI.textSec, fontSize: 11, lineHeight: 16, fontWeight: '700' },
  speciesHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  speciesTitle: { fontSize: 14, fontWeight: '900', letterSpacing: 1 },
  speciesSci: { color: UI.textMut, fontSize: 10, fontStyle: 'italic', marginTop: 2 },
  speciesBadge: { borderWidth: 1, borderRadius: 7, paddingHorizontal: 8, paddingVertical: 5 },
  speciesBadgeText: { fontSize: 10, fontWeight: '900' },
  paramGrid: { gap: 8 },
  infoLine: { gap: 2 },
  infoLabel: { color: UI.textMut, fontSize: 10, fontWeight: '900', letterSpacing: 0.8 },
  infoValue: { color: UI.textSec, fontSize: 11, lineHeight: 15 },
  weightsTitle: { color: UI.textMut, fontSize: 10, fontWeight: '900', letterSpacing: 1.4, marginTop: 2 },
  weightRow: { flexDirection: 'row', gap: 6 },
  weightPill: {
    flex: 1,
    minHeight: 44,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: UI.border,
    backgroundColor: UI.bg2,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  weightValue: { color: UI.textPri, fontSize: 13, fontWeight: '900' },
  weightLabel: { color: UI.textMut, fontSize: 8, fontWeight: '800', marginTop: 2 },
  dataLine: {
    borderBottomWidth: 1,
    borderBottomColor: UI.border,
    paddingBottom: 8,
    gap: 2,
  },
  dataName: { color: UI.textPri, fontSize: 12, fontWeight: '900' },
  dataValue: { color: UI.textSec, fontSize: 11, lineHeight: 15 },
});
