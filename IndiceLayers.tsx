/**
 * IndiceLayers.tsx
 *
 * WebView trasparente sovrapposta a react-native-maps che mostra
 * il layer dell'indice funghi (porcini o finferli).
 *
 * Logica:
 *  • Montata lazy al primo attivazione del layer, poi rimane viva
 *  • Visibile solo se activeLayer !== 'off'
 *  • Riceve la regione corrente via postMessage e aggiorna il viewport Leaflet
 *  • pointer-events: none tranne al tap su una cella (popup info)
 *
 * Utilizzo in MainUI:
 *
 *   import { IndiceLayerWebView } from './IndiceLayers';
 *
 *   // Nella MapView, aggiungi onRegionChangeComplete:
 *   <MapView
 *     ...
 *     onRegionChangeComplete={(r) => setCurrentRegion(r)}
 *   >
 *     ...
 *   </MapView>
 *
 *   // Dopo la MapView, sovrapposto:
 *   <IndiceLayerWebView
 *     activeLayer={activeLayer}
 *     region={currentRegion}
 *   />
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import type { Region } from 'react-native-maps';
import type { ActiveLayer } from './IndiceScreen';

// ─── URL tile Supabase (da sostituire quando Python è pronto) ─────────────────
// Formato: https://<project>.supabase.co/storage/v1/object/public/tiles/{specie}/{z}/{x}/{y}.png
const TILE_URLS: Record<'porcini' | 'finferli', string> = {
  porcini:  'PLACEHOLDER_PORCINI',
  finferli: 'PLACEHOLDER_FINFERLI',
};

// ─── Hotspot placeholder per area Trentino + Alpi Venete ─────────────────────
const HOTSPOTS: Record<'porcini' | 'finferli', Array<{ lat: number; lon: number; r: number; strength: number }>> = {
  porcini: [
    { lat: 46.12, lon: 11.05, r: 0.35, strength: 95 }, // Adamello
    { lat: 46.45, lon: 11.85, r: 0.30, strength: 90 }, // Lagorai
    { lat: 46.25, lon: 10.85, r: 0.28, strength: 85 }, // Val di Sole
    { lat: 46.20, lon: 12.10, r: 0.32, strength: 88 }, // Bellunesi N
    { lat: 46.55, lon: 11.35, r: 0.25, strength: 82 }, // Alto Adige S
    { lat: 46.08, lon: 11.40, r: 0.22, strength: 78 }, // Altopiani
    { lat: 46.38, lon: 12.55, r: 0.20, strength: 75 }, // Comelico
    { lat: 46.70, lon: 10.95, r: 0.28, strength: 80 }, // Val Venosta
  ],
  finferli: [
    { lat: 46.05, lon: 11.10, r: 0.40, strength: 92 },
    { lat: 46.40, lon: 11.90, r: 0.35, strength: 87 },
    { lat: 46.15, lon: 12.05, r: 0.38, strength: 90 },
    { lat: 46.28, lon: 10.90, r: 0.30, strength: 83 },
    { lat: 46.60, lon: 11.30, r: 0.28, strength: 79 },
    { lat: 45.85, lon: 11.55, r: 0.25, strength: 76 },
    { lat: 46.50, lon: 12.40, r: 0.22, strength: 72 },
    { lat: 46.75, lon: 10.80, r: 0.30, strength: 77 },
  ],
};

// ─── HTML Leaflet (sfondo trasparente, solo celle) ────────────────────────────
function buildHTML(species: 'porcini' | 'finferli'): string {
  const isPorcini = species === 'porcini';
  const hotspots = JSON.stringify(HOTSPOTS[species]);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    html, body { width:100%; height:100%; background:transparent; }
    #map { width:100%; height:100%; background:transparent; }
    .leaflet-container { background: transparent !important; }
    .leaflet-control-zoom, .leaflet-control-attribution { display:none !important; }
    .leaflet-popup-content-wrapper {
      background:#111a12; border:1px solid #2d4030; border-radius:10px;
      color:#dde8cc; box-shadow:0 4px 20px rgba(0,0,0,0.7);
    }
    .leaflet-popup-tip { background:#111a12; }
    .leaflet-popup-content { margin:12px 14px; font-family:monospace; font-size:12px; }
    .ptitle { font-size:13px; font-weight:700; letter-spacing:1px; margin-bottom:6px; }
    .pscore { font-size:22px; font-weight:900; margin:6px 0 4px; }
    .pbar-wrap { background:#0a110b; border-radius:4px; height:6px; overflow:hidden; }
    .pbar { height:100%; border-radius:4px; }
    .prow { font-size:11px; color:#8ba67a; margin:3px 0; }
    .prow span { color:#dde8cc; font-weight:600; }
    .pnote { font-size:9px; color:#4d6352; margin-top:8px; }
  </style>
</head>
<body>
<div id="map"></div>
<script>
  var map = L.map('map', {
    center:[46.35,11.45], zoom:9,
    zoomControl:false, attributionControl:false,
    minZoom:7, maxZoom:14,
  });

  // Sfondo trasparente: no tile layer base
  // Se i tile reali sono disponibili, aggiungili qui:
  // L.tileLayer('${TILE_URLS[species]}', { opacity:0.75, tms:false }).addTo(map);

  var species = '${species}';
  var isPorcini = ${isPorcini};
  var hotspots = ${hotspots};

  function indexToColor(v) {
    if (v < 8) return null;
    var a = Math.min(0.88, 0.35 + v / 100 * 0.53);
    if (isPorcini) {
      if (v < 20) return 'rgba(74,32,16,'+a+')';
      if (v < 40) return 'rgba(139,94,60,'+a+')';
      if (v < 60) return 'rgba(176,122,80,'+a+')';
      if (v < 80) return 'rgba(200,131,42,'+a+')';
      return 'rgba(232,160,64,'+a+')';
    } else {
      if (v < 20) return 'rgba(42,32,0,'+a+')';
      if (v < 40) return 'rgba(106,80,16,'+a+')';
      if (v < 60) return 'rgba(201,144,26,'+a+')';
      if (v < 80) return 'rgba(224,170,48,'+a+')';
      return 'rgba(255,220,80,'+a+')';
    }
  }

  var step = 0.04;
  var allCells = [];

  // Genera tutte le celle sull'area coperta
  var south=45.6, north=47.1, west=10.4, east=12.5;
  for (var lat=south; lat<north; lat+=step) {
    for (var lon=west; lon<east; lon+=step) {
      var score = 0;
      for (var i=0;i<hotspots.length;i++){
        var h=hotspots[i];
        var d=Math.sqrt(Math.pow(lat-h.lat,2)+Math.pow(lon-h.lon,2));
        score += h.strength * Math.exp(-(d*d)/(2*h.r*h.r));
      }
      score = Math.min(100, score + (Math.random()-0.5)*15);
      if (score < 8) continue;
      allCells.push({ lat:parseFloat(lat.toFixed(4)), lon:parseFloat(lon.toFixed(4)), score:Math.round(score) });
    }
  }

  var visibleRects = {};
  var halfStep = step / 2;

  function renderCells(bounds) {
    var s=bounds.getSouth()-step, n=bounds.getNorth()+step;
    var w=bounds.getWest()-step,  e=bounds.getEast()+step;

    // Rimuovi celle fuori viewport
    Object.keys(visibleRects).forEach(function(k){
      var c = visibleRects[k];
      if (c.lat < s || c.lat > n || c.lon < w || c.lon > e) {
        c.rect.remove();
        delete visibleRects[k];
      }
    });

    // Aggiungi celle nel viewport non ancora presenti
    allCells.forEach(function(c){
      if (c.lat < s || c.lat > n || c.lon < w || c.lon > e) return;
      var k = c.lat+'_'+c.lon;
      if (visibleRects[k]) return;

      var color = indexToColor(c.score);
      if (!color) return;

      var rect = L.rectangle(
        [[c.lat-halfStep, c.lon-halfStep],[c.lat+halfStep, c.lon+halfStep]],
        { color:'transparent', fillColor:color, fillOpacity:1, weight:0 }
      );

      rect.on('click', function(e){
        L.DomEvent.stopPropagation(e);
        var emoji = isPorcini ? '🍄' : '🌼';
        var label = isPorcini ? 'Porcini' : 'Finferli';
        var barColor = c.score>=80?'#6db85f':c.score>=60?'#e8c060':c.score>=40?'#c8832a':'#8c3030';
        var cond = c.score>=80?'🟢 Eccellente':c.score>=60?'🟡 Buono':c.score>=40?'🟠 Discreto':'🔴 Scarso';
        L.popup({maxWidth:220})
          .setLatLng(e.latlng)
          .setContent(
            '<div class="ptitle">'+emoji+' '+label.toUpperCase()+'</div>'+
            '<div class="pscore" style="color:'+barColor+'">'+c.score+'<small style="font-size:13px;color:#8ba67a"> / 100</small></div>'+
            '<div class="pbar-wrap"><div class="pbar" style="width:'+c.score+'%;background:'+barColor+'"></div></div>'+
            '<div class="prow" style="margin-top:8px">Condizione: <span>'+cond+'</span></div>'+
            '<div class="prow">Lat/Lon: <span>'+c.lat.toFixed(3)+', '+c.lon.toFixed(3)+'</span></div>'+
            '<div class="pnote">⚠ Dati placeholder — indice reale in sviluppo</div>'
          )
          .openOn(map);
      });

      rect.addTo(map);
      visibleRects[k] = { lat:c.lat, lon:c.lon, rect:rect };
    });
  }

  map.on('moveend', function(){ renderCells(map.getBounds()); });

  // Ascolta messaggi da React Native: { type:'setRegion', lat, lon, latDelta, lonDelta }
  document.addEventListener('message', handleMsg);
  window.addEventListener('message', handleMsg);
  function handleMsg(event) {
    try {
      var msg = JSON.parse(event.data);
      if (msg.type === 'setRegion') {
        map.setView([msg.lat, msg.lon], latDeltaToZoom(msg.latDelta), { animate:false });
      }
    } catch(e){}
  }

  function latDeltaToZoom(latDelta) {
    // Approssimazione: zoom = log2(360/latDelta) - 1
    var z = Math.round(Math.log(360/latDelta) / Math.LN2) - 1;
    return Math.max(7, Math.min(14, z));
  }

  // Render iniziale
  renderCells(map.getBounds());

  // Segnala pronto
  setTimeout(function(){
    if (window.ReactNativeWebView)
      window.ReactNativeWebView.postMessage(JSON.stringify({type:'ready'}));
  }, 600);
</script>
</body>
</html>`;
}

// ─── Componente ───────────────────────────────────────────────────────────────
interface Props {
  activeLayer: ActiveLayer;
  region: Region | null;
}

export function IndiceLayerWebView({ activeLayer, region }: Props) {
  const webviewRef = React.useRef<WebView>(null);
  // Montata lazy: una volta montata, rimane viva (solo si nasconde)
  const [mounted, setMounted] = React.useState(false);
  // Quale specie è attualmente caricata nella WebView
  const [loadedSpecies, setLoadedSpecies] = React.useState<'porcini' | 'finferli' | null>(null);

  const currentSpecies = activeLayer !== 'off' ? activeLayer : null;

  // Monta al primo attivazione
  React.useEffect(() => {
    if (currentSpecies && !mounted) {
      setMounted(true);
      setLoadedSpecies(currentSpecies);
    }
  }, [currentSpecies, mounted]);

  // Quando cambia specie, ricarica l'HTML (la WebView usa key)
  const webviewKey = React.useRef(0);
  const [webviewVersion, setWebviewVersion] = React.useState(0);
  React.useEffect(() => {
    if (!currentSpecies) return;
    if (currentSpecies !== loadedSpecies) {
      webviewKey.current += 1;
      setWebviewVersion(webviewKey.current);
      setLoadedSpecies(currentSpecies);
    }
  }, [currentSpecies, loadedSpecies]);

  // Sincronizza regione → WebView
  const lastRegionRef = React.useRef<Region | null>(null);
  React.useEffect(() => {
    if (!region || !webviewRef.current || activeLayer === 'off') return;
    // Throttle: manda solo se la regione è cambiata di almeno ~100m
    const prev = lastRegionRef.current;
    if (prev) {
      const dlat = Math.abs(region.latitude - prev.latitude);
      const dlon = Math.abs(region.longitude - prev.longitude);
      if (dlat < 0.0005 && dlon < 0.0005) return;
    }
    lastRegionRef.current = region;
    webviewRef.current.postMessage(JSON.stringify({
      type: 'setRegion',
      lat: region.latitude,
      lon: region.longitude,
      latDelta: region.latitudeDelta,
      lonDelta: region.longitudeDelta,
    }));
  }, [region, activeLayer]);

  if (!mounted) return null;

  const isVisible = activeLayer !== 'off';

  return (
    <View
      style={[StyleSheet.absoluteFillObject, !isVisible && { opacity: 0, pointerEvents: 'none' }]}
      pointerEvents={isVisible ? 'box-none' : 'none'}
    >
      <WebView
        key={webviewVersion}
        ref={webviewRef}
        source={{ html: buildHTML(loadedSpecies ?? 'porcini') }}
        style={styles.webview}
        javaScriptEnabled
        domStorageEnabled
        originWhitelist={['*']}
        scrollEnabled={false}
        bounces={false}
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        backgroundColor="transparent"
        // onMessage gestisce il popup tap (nessuna azione necessaria lato RN)
        onMessage={() => {}}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  webview: {
    flex: 1,
    backgroundColor: 'transparent',
  },
});
