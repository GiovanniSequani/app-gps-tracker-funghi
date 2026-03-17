/**
 * IndiceScreen.tsx
 *
 * Schermata "Indice" — visualizza la heatmap di probabilità funghi
 * (porcini / finferli) su WebView + Leaflet.
 *
 * Architettura:
 *  • La WebView carica HTML inline con Leaflet 1.9
 *  • I tile dell'indice vengono caricati da un URL XYZ su Supabase Storage
 *    (quando disponibili) — per ora usa placeholder colorati generati on-the-fly
 *  • Un toggle Porcini / Finferli switcha il layer attivo
 *  • Un pannello info mostra la legenda e la data di aggiornamento
 *
 * Per passare dai placeholder ai tile reali, cambia solo TILE_URL_PORCINI
 * e TILE_URL_FINFERLI con gli URL Supabase del bucket.
 *
 * NESSUN rebuild necessario — aggiornabile via OTA.
 */

import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  StatusBar,
  ActivityIndicator,
  Animated,
  Easing,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { SafeAreaView } from 'react-native-safe-area-context';

// ─── Palette (identica all'app) ───────────────────────────────────────────────
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
  porcino: '#8B5E3C',
  porcinoHi: '#b07a50',
  finferlo: '#C9901A',
  finferloHi: '#e0aa30',
};

// ─── Configurazione tile ──────────────────────────────────────────────────────
// Quando i tile reali saranno pronti su Supabase, sostituisci questi URL.
// Formato atteso: tiles XYZ → {z}/{x}/{y}.png
// Esempio Supabase: https://<project>.supabase.co/storage/v1/object/public/tiles/porcini/{z}/{x}/{y}.png

const TILE_CONFIG = {
  porcini: {
    // URL placeholder: usa un tile server pubblico con colorazione verde
    // Sostituire con: 'https://<supabase-url>/storage/v1/object/public/tiles/porcini/{z}/{x}/{y}.png'
    url: 'PLACEHOLDER_PORCINI',
    label: 'Porcini',
    emoji: '🍄',
    color: UI.porcinoHi,
    colorHex: '#b07a50',
    description: 'Boletus edulis — 800–1800m, abete/faggio',
  },
  finferli: {
    // Sostituire con: 'https://<supabase-url>/storage/v1/object/public/tiles/finferli/{z}/{x}/{y}.png'
    url: 'PLACEHOLDER_FINFERLI',
    label: 'Finferli',
    emoji: '🌼',
    color: UI.finferloHi,
    colorHex: '#e0aa30',
    description: 'Cantharellus cibarius — 300–1200m, bosco misto',
  },
} as const;

type Species = 'porcini' | 'finferli';

// ─── HTML Leaflet (generato dinamicamente) ────────────────────────────────────
function buildLeafletHTML(species: Species): string {
  const cfg = TILE_CONFIG[species];
  const isPorcini = species === 'porcini';

  // Colori gradiente per la legenda e il placeholder
  const gradientColors = isPorcini
    ? ['#1a0a00', '#4a2010', '#8B5E3C', '#c8832a', '#e8c060']
    : ['#0a0a00', '#2a2000', '#6a5010', '#C9901A', '#ffe060'];

  // Bounding box: Trentino-Alto Adige + Alpi Venete
  const bounds = {
    south: 45.6,
    north: 47.1,
    west: 10.4,
    east: 12.5,
    centerLat: 46.35,
    centerLon: 11.45,
    zoom: 9,
  };

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; background: #0a110b; }
    #map { width: 100%; height: 100%; }

    /* Leaflet overrides */
    .leaflet-control-zoom a {
      background: #111a12 !important;
      color: #dde8cc !important;
      border-color: #2d4030 !important;
    }
    .leaflet-control-zoom a:hover {
      background: #1f2b20 !important;
    }
    .leaflet-control-attribution {
      background: rgba(10,17,11,0.75) !important;
      color: #4d6352 !important;
      font-size: 9px !important;
    }
    .leaflet-control-attribution a { color: #6db85f !important; }
    .leaflet-bar { border: 1px solid #2d4030 !important; }

    /* Popup personalizzato */
    .leaflet-popup-content-wrapper {
      background: #111a12;
      border: 1px solid #2d4030;
      border-radius: 10px;
      color: #dde8cc;
      box-shadow: 0 4px 20px rgba(0,0,0,0.6);
    }
    .leaflet-popup-tip { background: #111a12; }
    .leaflet-popup-content { margin: 12px 14px; font-family: monospace; }
    .popup-title { font-size: 13px; font-weight: 700; letter-spacing: 1px; margin-bottom: 6px; }
    .popup-row { font-size: 11px; color: #8ba67a; margin: 2px 0; }
    .popup-row span { color: #dde8cc; font-weight: 600; }
    .popup-score { font-size: 22px; font-weight: 900; margin: 8px 0 4px; }
    .popup-bar-wrap { background: #0a110b; border-radius: 4px; height: 6px; overflow: hidden; }
    .popup-bar { height: 100%; border-radius: 4px; transition: width 0.4s; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    // ── Inizializza mappa ─────────────────────────────────────────────────────
    var map = L.map('map', {
      center: [${bounds.centerLat}, ${bounds.centerLon}],
      zoom: ${bounds.zoom},
      minZoom: 7,
      maxZoom: 14,
      zoomControl: true,
    });

    // ── Basemap scura (CartoDB Dark Matter) ──────────────────────────────────
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '© OpenStreetMap © CARTO',
      subdomains: 'abcd',
      maxZoom: 19,
      opacity: 0.9,
    }).addTo(map);

    // ── Colore dall'indice (0–100) ────────────────────────────────────────────
    function indexToColor(v, species) {
      if (v < 5) return 'rgba(0,0,0,0)';
      if (species === 'porcini') {
        if (v < 20) return 'rgba(74,32,16,0.55)';
        if (v < 40) return 'rgba(139,94,60,0.65)';
        if (v < 60) return 'rgba(176,122,80,0.72)';
        if (v < 80) return 'rgba(200,131,42,0.80)';
        return 'rgba(232,160,64,0.88)';
      } else {
        if (v < 20) return 'rgba(42,32,0,0.55)';
        if (v < 40) return 'rgba(106,80,16,0.65)';
        if (v < 60) return 'rgba(201,144,26,0.72)';
        if (v < 80) return 'rgba(224,170,48,0.80)';
        return 'rgba(255,220,80,0.88)';
      }
    }

    // ── Genera griglia placeholder realisticamente distribuita ───────────────
    // Simula un pattern plausibile: alta probabilità in zone montane
    // del Trentino (Adamello, Brenta, Lagorai) e Alpi Venete (Bellunesi)
    var species = '${species}';
    var cells = [];

    // Centri di alta probabilità (zone boschive reali)
    var hotspots = ${isPorcini
      ? JSON.stringify([
          { lat: 46.12, lon: 11.05, r: 0.35, strength: 95 }, // Adamello
          { lat: 46.45, lon: 11.85, r: 0.30, strength: 90 }, // Lagorai
          { lat: 46.25, lon: 10.85, r: 0.28, strength: 85 }, // Val di Sole
          { lat: 46.20, lon: 12.10, r: 0.32, strength: 88 }, // Bellunesi N
          { lat: 46.55, lon: 11.35, r: 0.25, strength: 82 }, // Alto Adige S
          { lat: 46.08, lon: 11.40, r: 0.22, strength: 78 }, // Altopiani
          { lat: 46.38, lon: 12.55, r: 0.20, strength: 75 }, // Comelico
          { lat: 46.70, lon: 10.95, r: 0.28, strength: 80 }, // Val Venosta
        ])
      : JSON.stringify([
          { lat: 46.05, lon: 11.10, r: 0.40, strength: 92 }, // Adamello bassa
          { lat: 46.40, lon: 11.90, r: 0.35, strength: 87 }, // Lagorai media
          { lat: 46.15, lon: 12.05, r: 0.38, strength: 90 }, // Bellunesi
          { lat: 46.28, lon: 10.90, r: 0.30, strength: 83 }, // Val Giudicarie
          { lat: 46.60, lon: 11.30, r: 0.28, strength: 79 }, // Bolzano E
          { lat: 45.85, lon: 11.55, r: 0.25, strength: 76 }, // Asiago bordi
          { lat: 46.50, lon: 12.40, r: 0.22, strength: 72 }, // Cadore
          { lat: 46.75, lon: 10.80, r: 0.30, strength: 77 }, // Resia
        ])};

    var step = 0.04; // ~2.8 km a questa latitudine ≈ placeholder grossolano
    var south = ${bounds.south}, north = ${bounds.north};
    var west = ${bounds.west}, east = ${bounds.east};

    for (var lat = south; lat < north; lat += step) {
      for (var lon = west; lon < east; lon += step) {
        // Calcola score come somma gaussiana degli hotspot
        var score = 0;
        for (var i = 0; i < hotspots.length; i++) {
          var h = hotspots[i];
          var dlat = lat - h.lat, dlon = lon - h.lon;
          var dist = Math.sqrt(dlat*dlat + dlon*dlon);
          var gauss = h.strength * Math.exp(-(dist*dist) / (2*h.r*h.r));
          score += gauss;
        }
        score = Math.min(100, score);

        // Filtra celle con score troppo basso per non sovraffollare
        if (score < 8) continue;

        // Aggiunge un po' di noise per realismo
        score = Math.max(0, Math.min(100, score + (Math.random() - 0.5) * 15));

        cells.push({ lat: lat, lon: lon, score: Math.round(score) });
      }
    }

    // ── Disegna celle come rettangoli ─────────────────────────────────────────
    var halfStep = step / 2;
    cells.forEach(function(c) {
      var color = indexToColor(c.score, species);
      if (color === 'rgba(0,0,0,0)') return;

      var rect = L.rectangle(
        [[c.lat - halfStep, c.lon - halfStep], [c.lat + halfStep, c.lon + halfStep]],
        {
          color: 'transparent',
          fillColor: color,
          fillOpacity: 1,
          weight: 0,
        }
      );

      rect.on('click', function(e) {
        L.DomEvent.stopPropagation(e);
        var label = c.score >= 80 ? '🟢 Ottimo' : c.score >= 60 ? '🟡 Buono' : c.score >= 40 ? '🟠 Discreto' : '🔴 Scarso';
        var barColor = c.score >= 80 ? '#6db85f' : c.score >= 60 ? '#e8c060' : c.score >= 40 ? '#c8832a' : '#8c3030';
        var popup = L.popup({ maxWidth: 220 })
          .setLatLng(e.latlng)
          .setContent(
            '<div class="popup-title">${cfg.emoji} ${cfg.label.toUpperCase()}</div>' +
            '<div class="popup-score" style="color:' + barColor + '">' + c.score + '<small style="font-size:13px;color:#8ba67a"> / 100</small></div>' +
            '<div class="popup-bar-wrap"><div class="popup-bar" style="width:' + c.score + '%;background:' + barColor + '"></div></div>' +
            '<div style="margin-top:8px">' +
            '<div class="popup-row">Condizione: <span>' + label + '</span></div>' +
            '<div class="popup-row">Lat/Lon: <span>' + c.lat.toFixed(3) + ', ' + c.lon.toFixed(3) + '</span></div>' +
            '<div class="popup-row" style="margin-top:6px;font-size:10px;color:#4d6352">⚠ Dati placeholder — indice reale in sviluppo</div>' +
            '</div>'
          );
        map.openPopup(popup);
      });

      rect.addTo(map);
    });

    // ── Contorno area di copertura ────────────────────────────────────────────
    L.rectangle(
      [[${bounds.south}, ${bounds.west}], [${bounds.north}, ${bounds.east}]],
      { color: '#2d4030', weight: 1.5, fill: false, dashArray: '6,4', opacity: 0.6 }
    ).addTo(map);

    // Segnala a React Native che la mappa è pronta
    setTimeout(function() {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready', cells: cells.length }));
      }
    }, 500);
  </script>
</body>
</html>`;
}

// ─── Componente IndiceScreen ──────────────────────────────────────────────────
export default function IndiceScreen() {
  const [species, setSpecies] = React.useState<Species>('porcini');
  const [loading, setLoading] = React.useState(true);
  const [cellCount, setCellCount] = React.useState(0);
  const [legendVisible, setLegendVisible] = React.useState(false);
  const legendAnim = React.useRef(new Animated.Value(0)).current;

  // Quando cambia specie, ricarica la WebView
  const webviewKey = React.useRef(0);
  const [webviewVersion, setWebviewVersion] = React.useState(0);

  const switchSpecies = (s: Species) => {
    if (s === species) return;
    setLoading(true);
    setCellCount(0);
    webviewKey.current += 1;
    setWebviewVersion(webviewKey.current);
    setSpecies(s);
  };

  const toggleLegend = () => {
    const toValue = legendVisible ? 0 : 1;
    setLegendVisible(!legendVisible);
    Animated.timing(legendAnim, {
      toValue,
      duration: 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  };

  const handleMessage = (event: any) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'ready') {
        setLoading(false);
        setCellCount(msg.cells);
      }
    } catch {}
  };

  const cfg = TILE_CONFIG[species];

  const legendTranslate = legendAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [220, 0],
  });

  // Simulazione data aggiornamento (sarà reale con Python)
  const today = new Date();
  const updateDate = `${today.getDate().toString().padStart(2,'0')}/${(today.getMonth()+1).toString().padStart(2,'0')}/${today.getFullYear()}`;

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <StatusBar barStyle="light-content" backgroundColor={UI.bg0} />

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle}>INDICE FUNGHI</Text>
          <Text style={styles.headerSub}>
            Trentino · Alto Adige · Alpi Venete
          </Text>
        </View>
        <TouchableOpacity style={styles.legendBtn} onPress={toggleLegend}>
          <Text style={styles.legendBtnText}>ℹ</Text>
        </TouchableOpacity>
      </View>

      {/* ── Toggle specie ───────────────────────────────────────────────────── */}
      <View style={styles.toggleRow}>
        {(['porcini', 'finferli'] as Species[]).map((s) => {
          const c = TILE_CONFIG[s];
          const active = species === s;
          return (
            <TouchableOpacity
              key={s}
              style={[
                styles.toggleBtn,
                active && { backgroundColor: c.color + '22', borderColor: c.color },
              ]}
              onPress={() => switchSpecies(s)}
              activeOpacity={0.75}
            >
              <Text style={styles.toggleEmoji}>{c.emoji}</Text>
              <Text style={[styles.toggleLabel, active && { color: c.color }]}>
                {c.label.toUpperCase()}
              </Text>
              {active && <View style={[styles.toggleDot, { backgroundColor: c.color }]} />}
            </TouchableOpacity>
          );
        })}
      </View>

      {/* ── Mappa WebView ───────────────────────────────────────────────────── */}
      <View style={styles.mapWrap}>
        <WebView
          key={webviewVersion}
          source={{ html: buildLeafletHTML(species) }}
          style={styles.webview}
          onMessage={handleMessage}
          javaScriptEnabled
          domStorageEnabled
          originWhitelist={['*']}
          onLoadStart={() => setLoading(true)}
          scrollEnabled={false}
          bounces={false}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
        />

        {/* Spinner di caricamento */}
        {loading && (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator size="large" color={cfg.color} />
            <Text style={styles.loadingText}>Caricamento mappa…</Text>
          </View>
        )}

        {/* Badge celle caricate */}
        {!loading && cellCount > 0 && (
          <View style={styles.cellBadge}>
            <View style={[styles.cellDot, { backgroundColor: cfg.color }]} />
            <Text style={styles.cellBadgeText}>{cellCount} celle</Text>
          </View>
        )}

        {/* Badge PLACEHOLDER */}
        <View style={styles.placeholderBadge}>
          <Text style={styles.placeholderText}>⚙ DATI SIMULATI</Text>
        </View>
      </View>

      {/* ── Pannello legenda (slide-up) ─────────────────────────────────────── */}
      <Animated.View
        style={[
          styles.legendPanel,
          { transform: [{ translateY: legendTranslate }] },
          !legendVisible && { pointerEvents: 'none' },
        ]}
        pointerEvents={legendVisible ? 'auto' : 'none'}
      >
        <View style={styles.legendHandle} />
        <Text style={styles.legendTitle}>{cfg.emoji} {cfg.label} — Legenda indice</Text>
        <Text style={styles.legendDesc}>{cfg.description}</Text>

        <View style={styles.legendRows}>
          {[
            { range: '80–100', label: 'Eccellente', color: cfg.colorHex, opacity: '0.88' },
            { range: '60–79',  label: 'Buono',      color: cfg.colorHex, opacity: '0.72' },
            { range: '40–59',  label: 'Discreto',   color: cfg.colorHex, opacity: '0.56' },
            { range: '20–39',  label: 'Scarso',     color: cfg.colorHex, opacity: '0.40' },
            { range: '< 20',   label: 'Assente',    color: '#333',       opacity: '1' },
          ].map((row) => (
            <View key={row.range} style={styles.legendRow}>
              <View style={[styles.legendSwatch, { backgroundColor: row.color, opacity: parseFloat(row.opacity) }]} />
              <Text style={styles.legendRange}>{row.range}</Text>
              <Text style={styles.legendLabel}>{row.label}</Text>
            </View>
          ))}
        </View>

        <View style={styles.legendMeta}>
          <Text style={styles.legendMetaText}>
            📅 Aggiornamento: <Text style={{ color: UI.textPri }}>{updateDate}</Text>
          </Text>
          <Text style={styles.legendMetaText}>
            📡 Fonte meteo: <Text style={{ color: UI.textPri }}>Open-Meteo ICON-D2</Text>
          </Text>
          <Text style={styles.legendMetaText}>
            🗺 DEM: <Text style={{ color: UI.textPri }}>Copernicus GLO-10 (25m)</Text>
          </Text>
          <Text style={styles.legendMetaText}>
            🌿 Veg: <Text style={{ color: UI.textPri }}>ESA WorldCover 10m</Text>
          </Text>
          <Text style={[styles.legendMetaText, { marginTop: 8, color: UI.amber }]}>
            ⚠ Attualmente: dati placeholder simulati.{'\n'}
            L'indice reale sarà disponibile quando il{'\n'}
            pipeline Python sarà completato.
          </Text>
        </View>

        <TouchableOpacity style={styles.legendClose} onPress={toggleLegend}>
          <Text style={styles.legendCloseText}>CHIUDI</Text>
        </TouchableOpacity>
      </Animated.View>
    </SafeAreaView>
  );
}

// ─── Stili ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: UI.bg0,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: UI.border,
  },
  headerLeft: { gap: 2 },
  headerTitle: {
    color: UI.textPri,
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: 5,
  },
  headerSub: {
    color: UI.textMut,
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 1,
  },
  legendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: UI.bg3,
    borderWidth: 1,
    borderColor: UI.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  legendBtnText: {
    color: UI.textSec,
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 22,
  },

  // Toggle specie
  toggleRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  toggleBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: UI.border,
    backgroundColor: UI.bg2,
  },
  toggleEmoji: { fontSize: 16 },
  toggleLabel: {
    color: UI.textMut,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
  toggleDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginLeft: 2,
  },

  // Mappa
  mapWrap: {
    flex: 1,
    position: 'relative',
    backgroundColor: UI.bg0,
  },
  webview: {
    flex: 1,
    backgroundColor: 'transparent',
  },

  // Loading overlay
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: UI.bg0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  loadingText: {
    color: UI.textSec,
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 1,
  },

  // Badge celle
  cellBadge: {
    position: 'absolute',
    top: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(10,17,11,0.85)',
    borderWidth: 1,
    borderColor: UI.border,
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  cellDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  cellBadgeText: {
    color: UI.textSec,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },

  // Badge placeholder
  placeholderBadge: {
    position: 'absolute',
    bottom: 12,
    left: 12,
    backgroundColor: 'rgba(200,131,42,0.18)',
    borderWidth: 1,
    borderColor: UI.amber,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  placeholderText: {
    color: UI.amberBri,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.5,
  },

  // Pannello legenda
  legendPanel: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: UI.bg1,
    borderTopWidth: 1,
    borderTopColor: UI.borderHi,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 20,
    paddingBottom: 32,
    paddingTop: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 20,
  },
  legendHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: UI.border,
    alignSelf: 'center',
    marginBottom: 14,
  },
  legendTitle: {
    color: UI.textPri,
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 1,
    marginBottom: 4,
  },
  legendDesc: {
    color: UI.textMut,
    fontSize: 11,
    marginBottom: 14,
    letterSpacing: 0.3,
  },
  legendRows: { gap: 8, marginBottom: 16 },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  legendSwatch: {
    width: 28,
    height: 14,
    borderRadius: 3,
  },
  legendRange: {
    color: UI.textSec,
    fontSize: 12,
    fontWeight: '700',
    width: 52,
    letterSpacing: 0.5,
  },
  legendLabel: {
    color: UI.textPri,
    fontSize: 12,
    fontWeight: '500',
  },
  legendMeta: {
    gap: 4,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: UI.border,
    marginBottom: 16,
  },
  legendMetaText: {
    color: UI.textMut,
    fontSize: 11,
    lineHeight: 16,
  },
  legendClose: {
    alignItems: 'center',
    paddingVertical: 11,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: UI.border,
    backgroundColor: UI.bg3,
  },
  legendCloseText: {
    color: UI.textSec,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 2,
  },
});
