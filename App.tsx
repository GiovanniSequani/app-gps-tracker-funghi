import React from 'react';
import {
  StyleSheet, Text, View, Button, useColorScheme, Alert, TextInput, Modal, Linking,
  TouchableOpacity, Animated, StatusBar, Platform, ScrollView, RefreshControl, PanResponder
} from 'react-native';
import MapLibreGL, {
  MapView,
  Camera,
  ShapeSource,
  LineLayer,
  CircleLayer,
} from '@maplibre/maplibre-react-native';
import { Trash2 } from 'lucide-react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { File, Paths } from 'expo-file-system';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { initDB, insertRoute, getAllRoutes, getRouteById, deleteRoute } from './db';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { NavigationContainer } from '@react-navigation/native';
import uuid from 'react-native-uuid';
import * as Updates from 'expo-updates';
import Constants from 'expo-constants';
import IndiceScreen, { ActiveLayer } from './IndiceScreen';
import { IndiceLayerTiles } from './IndiceLayers';

declare const process: {
  env?: {
    EXPO_PUBLIC_SUPABASE_URL?: string;
    EXPO_PUBLIC_SUPABASE_ANON_KEY?: string;
  };
};

// ─── MapLibre: disabilita token (non necessario per tile custom) ──────────────
MapLibreGL.setAccessToken(null);

// ─── Tipi ─────────────────────────────────────────────────────────────────────
type Coordinate = {
  latitude: number;
  longitude: number;
  timestamp: number;
};
type MarkerData = Coordinate & { tipo: 'Porcino' | 'Finferlo'; name: string };
type RouteData = {
  name: string;
  date: string;
  path: Coordinate[];
  markers: MarkerData[];
  route_id?: string;
};
type Route = {
  route_id: string;
  name: string;
  date: string;
  path: Coordinate[];
};
type Waypoint = {
  lat: number;
  lon: number;
  timestamp: number;
  name: string;
  type: string;
};

type TileSet = {
  date: string;
  version: string;
};

// ─── Costanti ─────────────────────────────────────────────────────────────────
const Tab = createBottomTabNavigator();
const LOCATION_TASK_NAME = 'background-location-task';
const BG_POSITIONS_FILE = `${FileSystemLegacy.cacheDirectory}bg_positions.json`;
const SUPABASE_URL =
  process.env?.EXPO_PUBLIC_SUPABASE_URL ??
  ((Constants.expoConfig?.extra?.supabaseUrl as string | undefined) ?? 'https://ovdfsehovsrdzcoqdlfh.supabase.co');
const SUPABASE_BUCKET = 'tiles';
const DEFAULT_TILE_SET: TileSet = { date: '2026-05-05', version: '1' };
const SUPABASE_ANON_KEY =
  process.env?.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
  ((Constants.expoConfig?.extra?.supabaseAnonKey as string | undefined) ?? '');
const TILE_SET_REGEX = /^(\d{4})([-_])(\d{2})\2(\d{2})_v(\d+)$/;

async function getLatestTileSet(): Promise<TileSet> {
  const candidates = await getAvailableTileSets();
  if (candidates.length === 0) {
    throw new Error('No valid tile set found under tiles/');
  }
  return candidates[0];
}

async function getAvailableTileSets(): Promise<TileSet[]> {
  const url = `${SUPABASE_URL}/storage/v1/object/list/${SUPABASE_BUCKET}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (SUPABASE_ANON_KEY) {
    headers.apikey = SUPABASE_ANON_KEY;
    headers.Authorization = `Bearer ${SUPABASE_ANON_KEY}`;
  }
  console.log('[tiles] Listing Supabase tile sets', {
    url,
    bucket: SUPABASE_BUCKET,
    hasAnonKey: Boolean(SUPABASE_ANON_KEY),
  });
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prefix: '', limit: 1000, offset: 0 }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.log('[tiles] Supabase list failed', { status: response.status, body });
    throw new Error(`Supabase list failed: ${response.status}`);
  }

  const items = (await response.json()) as Array<{ name?: string }>;
  const names = items.map((item) => item.name ?? '');
  console.log('[tiles] Supabase list result', { count: names.length, names: names.slice(0, 20) });
  const tileSets = names
    .map((name) => {
      const match = name.match(TILE_SET_REGEX);
      if (!match) return null;
      return {
        name,
        date: `${match[1]}${match[2]}${match[3]}${match[2]}${match[4]}`,
        year: Number(match[1]),
        month: Number(match[3]),
        day: Number(match[4]),
        versionNum: Number(match[5]),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => {
      if (a.year !== b.year) return b.year - a.year;
      if (a.month !== b.month) return b.month - a.month;
      if (a.day !== b.day) return b.day - a.day;
      return b.versionNum - a.versionNum;
    })
    .map((item) => ({ date: item.date, version: String(item.versionNum) }));
  console.log('[tiles] Parsed tile sets', tileSets);
  return tileSets;
}

// ─── Stile mappa: satellite Esri (gratuito, no API key) ───────────────────────
const SATELLITE_STYLE = {
  version: 8 as const,
  sources: {
    'esri-satellite': {
      type: 'raster' as const,
      tiles: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      attribution: 'Esri, DigitalGlobe, GeoEye',
    },
  },
  layers: [
    {
      id: 'esri-satellite-layer',
      type: 'raster' as const,
      source: 'esri-satellite',
    },
  ],
};

// ─── Palette UI (identica all'originale) ──────────────────────────────────────
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
  redBri: '#c44040',
  porcino: '#8B5E3C',
  porcinoHi: '#b07a50',
  finferlo: '#C9901A',
  finferloHi: '#e0aa30',
};

// ─── Helpers GeoJSON ──────────────────────────────────────────────────────────
function coordsToGeoJSONLine(path: Coordinate[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features:
      path.length > 1
        ? [
            {
              type: 'Feature',
              geometry: {
                type: 'LineString',
                coordinates: path.map((p) => [p.longitude, p.latitude]),
              },
              properties: {},
            },
          ]
        : [],
  };
}

function coordsToGeoJSONPoint(lat: number, lng: number): GeoJSON.Feature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lng, lat] },
    properties: {},
  };
}

function markersToGeoJSON(
  markers: MarkerData[],
  tipo: 'Porcino' | 'Finferlo'
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: markers
      .filter((m) => m.tipo === tipo)
      .map((m) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [m.longitude, m.latitude] },
        properties: { name: m.name },
      })),
  };
}

// ─── BACKGROUND TASK (identico all'originale) ─────────────────────────────────
TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) { console.error('Errore task location:', error); return; }
  if (data) {
    try {
      const { locations } = data as any;
      let arr: Coordinate[] = [];
      try {
        const info = await FileSystemLegacy.getInfoAsync(BG_POSITIONS_FILE);
        if (info.exists) {
          const raw = await FileSystemLegacy.readAsStringAsync(BG_POSITIONS_FILE);
          arr = JSON.parse(raw || '[]');
        }
      } catch { arr = []; }
      (locations as any[]).forEach((loc) => {
        arr.push({
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
          timestamp: typeof loc.timestamp === 'number' ? loc.timestamp : Date.now(),
        });
      });
      await FileSystemLegacy.writeAsStringAsync(BG_POSITIONS_FILE, JSON.stringify(arr));
    } catch (err) {
      console.error('Errore scrittura file bg positions:', err);
    }
  }
});

const checkAndOpenSettingsIfNeeded = async () => {
  if (Platform.OS !== 'android') return true;
  const fg = await Location.getForegroundPermissionsAsync();
  const bg = await Location.getBackgroundPermissionsAsync();
  if (fg.status !== 'granted' || bg.status !== 'granted') {
    Alert.alert(
      'Permessi mancanti',
      'Per tracciare la posizione in background devi concedere tutti i permessi. Aprire impostazioni?',
      [{ text: 'No', style: 'cancel' }, { text: 'Sì', onPress: () => Linking.openSettings() }]
    );
    return false;
  }
  return true;
};

// ══════════════════════════════════════════════════════════════════════════════
// App
// ══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [recording, setRecording] = React.useState(false);
  const [path, setPath] = React.useState<Coordinate[]>([]);
  const [markers, setMarkers] = React.useState<MarkerData[]>([]);
  const [saveVisible, setSaveVisible] = React.useState(false);
  const [fileName, setFileName] = React.useState('percorso');
  const [initialCenter, setInitialCenter] = React.useState<[number, number]>([10.9916, 45.4384]);
  const [showAll, setShowAll] = React.useState(false);
  const [addedRoutes, setAddedRoutes] = React.useState<string[]>([]);
  const [routesOnMap, setRoutesOnMap] = React.useState<RouteData[]>([]);
  const [highlightedRoute, setHighlightedRoute] = React.useState<string | null>(null);
  const [activeLayer, setActiveLayer] = React.useState<ActiveLayer>('off');
  const [tileDate, setTileDate] = React.useState(DEFAULT_TILE_SET.date);
  const [tileVersion, setTileVersion] = React.useState(DEFAULT_TILE_SET.version);
  const [tileSets, setTileSets] = React.useState<TileSet[]>([]);
  const [tileOpacity, setTileOpacity] = React.useState(0.85);
  const [indexPanelSide, setIndexPanelSide] = React.useState<'left' | 'right'>('right');
  const [indexPanelCollapsed, setIndexPanelCollapsed] = React.useState(false);
  const [tilesLoading, setTilesLoading] = React.useState(true);
  const [tilesError, setTilesError] = React.useState<string | null>(null);

  const followLocationRef = React.useRef(true);
  // Camera ref: tipo è il componente Camera stesso
  const cameraRef = React.useRef<React.ElementRef<typeof Camera>>(null);
  const recordingRef = React.useRef(recording);

  const visibleMarkers = showAll ? markers : markers.slice(0, 5);

  React.useEffect(() => { recordingRef.current = recording; }, [recording]);

  // check updates
  React.useEffect(() => {
    (async () => {
      try {
        const update = await Updates.checkForUpdateAsync();
        if (update.isAvailable) {
          await Updates.fetchUpdateAsync();
          Alert.alert(
            'Aggiornamento disponibile',
            'È disponibile una nuova versione. Vuoi aggiornare ora?',
            [{ text: 'Più tardi', style: 'cancel' }, { text: 'Aggiorna ora', onPress: () => Updates.reloadAsync() }]
          );
        }
      } catch (err) { console.log('Errore update:', err); }
    })();
  }, []);

  // init DB
  React.useEffect(() => {
    initDB().then(() => console.log('DB inizializzato')).catch(console.error);
  }, []);

  React.useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        console.log('[tiles] Bootstrap start', { fallback: DEFAULT_TILE_SET });
        setTilesLoading(true);
        setTilesError(null);
        const available = await getAvailableTileSets();
        if (available.length === 0) {
          throw new Error('No valid tile set found under tiles/');
        }
        const latest = available[0];
        if (!mounted) return;
        console.log('[tiles] Bootstrap selected latest tile set', latest);
        setTileSets(available);
        setTileDate(latest.date);
        setTileVersion(latest.version);
      } catch (err) {
        if (!mounted) return;
        const message = err instanceof Error ? err.message : 'Errore caricamento tiles';
        console.log('[tiles] Bootstrap failed, keeping fallback/manual tile set', {
          message,
          fallback: DEFAULT_TILE_SET,
        });
        setTilesError(message);
      } finally {
        if (mounted) setTilesLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  React.useEffect(() => {
    if (tileDate && tileVersion && tilesError) {
      console.log('[tiles] Clearing discovery error after valid tile selection', { tileDate, tileVersion });
      setTilesError(null);
    }
  }, [tileDate, tileVersion, tilesError]);

  React.useEffect(() => {
    console.log('[tiles] Selection changed', {
      activeLayer,
      tileDate,
      tileVersion,
      tileOpacity,
    });
  }, [activeLayer, tileDate, tileVersion, tileOpacity]);

  // posizione iniziale
  React.useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') { Alert.alert('Permesso GPS negato!'); return; }
      const location = await Location.getCurrentPositionAsync({});
      const center: [number, number] = [location.coords.longitude, location.coords.latitude];
      setInitialCenter(center);
      cameraRef.current?.flyTo(center, 1000);
    })();
  }, []);

  const handleDeleteMarker = (marker: MarkerData) => {
    Alert.alert('Conferma eliminazione', `Vuoi eliminare ${marker.name}?`, [
      { text: 'Annulla', style: 'cancel' },
      { text: 'Elimina', style: 'destructive', onPress: () => setMarkers((m) => m.filter((x) => x.name !== marker.name)) },
    ]);
  };

  const syncPathFromFile = React.useCallback(async (consume = false): Promise<Coordinate[]> => {
    try {
      const info = await FileSystemLegacy.getInfoAsync(BG_POSITIONS_FILE);
      if (!info.exists) return path;
      const raw = await FileSystemLegacy.readAsStringAsync(BG_POSITIONS_FILE);
      const arr = JSON.parse(raw || '[]') as Coordinate[];
      if (!Array.isArray(arr) || arr.length === 0) return path;
      let updated: Coordinate[] = [];
      setPath((prev) => {
        const lastTs = prev.length ? prev[prev.length - 1].timestamp : 0;
        const newPoints = arr.filter((p) => (p.timestamp ?? 0) > lastTs);
        updated = newPoints.length ? [...prev, ...newPoints] : prev;
        return updated;
      });
      if (consume) {
        try { await FileSystemLegacy.deleteAsync(BG_POSITIONS_FILE, { idempotent: true }); } catch { }
      }
      return updated.length ? updated : path;
    } catch { return path; }
  }, [path]);

  // polling GPS
  React.useEffect(() => {
    let mounted = true;
    const tick = async () => {
      if (!mounted) return;
      const currpath = await syncPathFromFile(false);
      if (recordingRef.current && currpath.length > 0 && followLocationRef.current) {
        const latest = currpath[currpath.length - 1];
        cameraRef.current?.moveTo([latest.longitude, latest.latitude], 500);
      }
    };
    void tick();
    const id = setInterval(() => { void tick(); }, 500);
    return () => { mounted = false; clearInterval(id); };
  }, [syncPathFromFile]);

  const highlightRoute = (routeId: string) => {
    setHighlightedRoute(routeId);
    setTimeout(() => setHighlightedRoute(null), 1000);
  };

  const startRecording = async () => {
    const ok = await checkAndOpenSettingsIfNeeded();
    if (!ok) return;
    const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
    if (fgStatus !== 'granted') { Alert.alert('Permesso GPS negato!'); return; }
    const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
    if (Platform.OS === 'android' && bgStatus !== 'granted') {
      Alert.alert('Permesso background non concesso', 'Per tracciare in background devi concedere "Consenti sempre".');
    }
    setRecording(true);
    setPath([]);
    setMarkers([]);
    try { await FileSystemLegacy.deleteAsync(BG_POSITIONS_FILE, { idempotent: true }); } catch { }
    const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
    if (!started) {
      await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: 2000,
        distanceInterval: 1,
        showsBackgroundLocationIndicator: true,
        foregroundService: {
          notificationTitle: 'GPS attivo',
          notificationBody: "L'app sta registrando la tua posizione",
        },
      });
    }
  };

  const saveCurrentRoute = async () => {
    const route_id = uuid.v4() as string;
    const date = new Date().toISOString();
    const name = `Percorso ${new Date().toLocaleDateString()}`;
    await insertRoute(route_id, name, date, path, markers);
  };

  const stopRecording = async () => {
    setRecording(false);
    try {
      const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
      if (started) await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
    } catch (err) { console.warn('Errore stop location updates:', err); }
    Alert.alert('Salva', 'Vuoi salvare il percorso registrato?', [
      { text: 'No', style: 'cancel' },
      { text: 'Sì', onPress: async () => {
        try { await saveCurrentRoute(); }
        catch { Alert.alert('Errore', 'Impossibile salvare il percorso nel database.'); }
      }},
    ]);
  };

  const addMarker = React.useCallback(
    async (tipo: 'Porcino' | 'Finferlo') => {
      try {
        const updated = await syncPathFromFile(false);
        const last = updated?.length ? updated[updated.length - 1] : path.length ? path[path.length - 1] : undefined;
        if (!last) { Alert.alert('Nessuna posizione disponibile'); return; }
        setMarkers((prev) => [
          ...prev,
          {
            latitude: last.latitude,
            longitude: last.longitude,
            timestamp: Date.now(),
            tipo,
            name: `${tipo}_${prev.filter((m) => m.tipo === tipo).length + 1}`,
          },
        ]);
      } catch { Alert.alert('Errore', 'Impossibile aggiungere il segnaposto.'); }
    },
    [syncPathFromFile, path]
  );

  const generateGPX = (pathData: Coordinate[], markersData: MarkerData[]): string => {
    const header = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Funghi Tracker">\n<trk><name>Percorso</name><trkseg>`;
    const trackPoints = pathData
      .map((pt) => {
        const time = pt.timestamp ? new Date(pt.timestamp).toISOString() : null;
        return `<trkpt lat="${pt.latitude}" lon="${pt.longitude}">${time ? `<time>${time}</time>` : ''}</trkpt>`;
      })
      .join('\n');
    const footer = `</trkseg></trk>`;
    const waypoints = markersData
      .map((m) => {
        const time = m.timestamp ? new Date(m.timestamp).toISOString() : null;
        return `<wpt lat="${m.latitude}" lon="${m.longitude}">${time ? `<time>${time}</time>` : ''}<name>${m.name}</name><type>${m.tipo}</type></wpt>`;
      })
      .join('\n');
    return `${header}\n${trackPoints}\n${footer}\n${waypoints}\n</gpx>`;
  };

  const handleShare = async (route_id: string) => {
    try {
      const route = (await getRouteById(route_id)) as Route & { waypoints: Waypoint[] };
      const wmarkers: MarkerData[] = route.waypoints.map((wp) => ({
        latitude: wp.lat,
        longitude: wp.lon,
        timestamp: wp.timestamp,
        tipo: wp.type as 'Porcino' | 'Finferlo',
        name: wp.name,
      }));
      const gpxData = generateGPX(route.path, wmarkers);
      let uri: string | undefined;
      try {
        const safeFileName = fileName?.trim() || `percorso_${Date.now()}`;
        const file = new File(Paths.cache, safeFileName + '.gpx');
        try { file.create(); } catch { }
        try { await (file.write(gpxData) as Promise<void> | void); } catch { }
        // @ts-ignore
        uri = file.uri ?? (file.getUri ? await file.getUri() : undefined);
      } catch { uri = undefined; }
      if (!uri) {
        const safeFileName = fileName?.trim() || `percorso_${Date.now()}`;
        const legacyUri = FileSystemLegacy.cacheDirectory + safeFileName + '.gpx';
        await FileSystemLegacy.writeAsStringAsync(legacyUri, gpxData, { encoding: 'utf8' });
        uri = legacyUri;
      }
      if (uri) {
        const available = await Sharing.isAvailableAsync();
        if (!available) Alert.alert('GPX salvato in: ' + uri);
        else await Sharing.shareAsync(uri);
      }
    } catch (error: any) {
      Alert.alert('Errore durante la condivisione', error?.message ?? String(error));
    } finally {
      setSaveVisible(false);
      setFileName('percorso');
    }
  };

  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <Tab.Navigator
          screenOptions={{
            headerShown: false,
            tabBarStyle: { height: 64, backgroundColor: UI.bg1, borderTopWidth: 1, borderTopColor: UI.border, paddingBottom: 6, paddingTop: 4 },
            tabBarActiveTintColor: UI.greenBri,
            tabBarInactiveTintColor: UI.textMut,
            tabBarLabelStyle: { fontSize: 10, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase' },
          }}
        >
          <Tab.Screen
            name="Mappa"
            children={() => (
              <MainUI
                recording={recording}
                startRecording={startRecording}
                stopRecording={stopRecording}
                addMarker={addMarker}
                path={path}
                markers={markers}
                cameraRef={cameraRef}
                followLocationRef={followLocationRef}
                initialCenter={initialCenter}
                showAll={showAll}
                visibleMarkers={visibleMarkers}
                handleDeleteMarker={handleDeleteMarker}
                setShowAll={setShowAll}
                addedRoutes={addedRoutes}
                setAddedRoutes={setAddedRoutes}
                setRoutesOnMap={setRoutesOnMap}
                routesOnMap={routesOnMap}
                highlightRoute={highlightRoute}
                highlightedRoute={highlightedRoute}
                activeLayer={activeLayer}
                setActiveLayer={setActiveLayer}
                tileDate={tileDate}
                setTileDate={setTileDate}
                tileVersion={tileVersion}
                setTileVersion={setTileVersion}
                tileSets={tileSets}
                tileOpacity={tileOpacity}
                setTileOpacity={setTileOpacity}
                indexPanelSide={indexPanelSide}
                setIndexPanelSide={setIndexPanelSide}
                indexPanelCollapsed={indexPanelCollapsed}
                setIndexPanelCollapsed={setIndexPanelCollapsed}
                tilesLoading={tilesLoading}
                tilesError={tilesError}
              />
            )}
            options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>🗺️</Text>, tabBarLabel: 'Mappa' }}
          />
          <Tab.Screen
            name="Archivio"
            children={() => (
              <ManageRoutesScreen
                addedRoutes={addedRoutes}
                setAddedRoutes={setAddedRoutes}
                handleShare={handleShare}
                saveVisible={saveVisible}
                setSaveVisible={setSaveVisible}
                fileName={fileName}
                setFileName={setFileName}
              />
            )}
            options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>📂</Text>, tabBarLabel: 'Archivio' }}
          />
          <Tab.Screen
            name="Indice"
            children={() => (
              <IndiceScreen
                activeLayer={activeLayer}
                setActiveLayer={setActiveLayer}
                tileDate={tileDate}
                setTileDate={setTileDate}
                tileVersion={tileVersion}
                setTileVersion={setTileVersion}
              />
            )}
            options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>🍄</Text>, tabBarLabel: 'Indice' }}
          />
        </Tab.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MainUI
// ══════════════════════════════════════════════════════════════════════════════
function MainUI(props: any) {
  const {
    recording, startRecording, stopRecording, addMarker,
    path, markers, cameraRef, followLocationRef, initialCenter,
    showAll, visibleMarkers, handleDeleteMarker, setShowAll,
    addedRoutes, setAddedRoutes, setRoutesOnMap, routesOnMap,
    highlightRoute, highlightedRoute, activeLayer, setActiveLayer,
    tileDate, setTileDate, tileVersion, setTileVersion, tileSets,
    tileOpacity, setTileOpacity,
    indexPanelSide, setIndexPanelSide, indexPanelCollapsed, setIndexPanelCollapsed,
    tilesLoading, tilesError
  } = props;

  // fetch percorsi salvati quando cambiano gli addedRoutes
  React.useEffect(() => {
    const fetchRoutes = async () => {
      const newRoutes: RouteData[] = [];
      for (const route_id of addedRoutes) {
        const route = (await getRouteById(route_id)) as Route & { waypoints: Waypoint[] };
        if (!route) continue;
        const wmarkers: MarkerData[] = route.waypoints.map((wp) => ({
          latitude: wp.lat, longitude: wp.lon, timestamp: wp.timestamp,
          tipo: wp.type as 'Porcino' | 'Finferlo', name: wp.name,
        }));
        newRoutes.push({ name: route.name, date: route.date, path: route.path, markers: wmarkers, route_id: route.route_id });
      }
      setRoutesOnMap(newRoutes);
    };
    fetchRoutes();
  }, [addedRoutes]);

  // REC pulse animation
  const recPulse = React.useRef(new Animated.Value(1)).current;
  React.useEffect(() => {
    if (recording) {
      const anim = Animated.loop(
        Animated.sequence([
          Animated.timing(recPulse, { toValue: 0.3, duration: 600, useNativeDriver: true }),
          Animated.timing(recPulse, { toValue: 1, duration: 600, useNativeDriver: true }),
        ])
      );
      anim.start();
      return () => anim.stop();
    } else {
      recPulse.setValue(1);
    }
  }, [recording]);

  const porciniCount = markers.filter((m: MarkerData) => m.tipo === 'Porcino').length;
  const finferliCount = markers.filter((m: MarkerData) => m.tipo === 'Finferlo').length;

  // GeoJSON memoizzati
  const currentPathGeoJSON = React.useMemo(() => coordsToGeoJSONLine(path), [path]);
  const porciniGeoJSON = React.useMemo(() => markersToGeoJSON(markers, 'Porcino'), [markers]);
  const finferliGeoJSON = React.useMemo(() => markersToGeoJSON(markers, 'Finferlo'), [markers]);

  const currentPos = path.length > 0 ? path[path.length - 1] : null;
  const currentPosGeoJSON = React.useMemo(
    () => currentPos ? coordsToGeoJSONPoint(currentPos.latitude, currentPos.longitude) : null,
    [currentPos?.latitude, currentPos?.longitude]
  );
  const activeTileIndex = tileSets.findIndex((tile: TileSet) => tile.date === tileDate && tile.version === tileVersion);
  const selectedTileLabel = tileDate && tileVersion ? `${tileDate.replace(/_/g, '/')}  v${tileVersion}` : 'Nessun dataset';
  const selectTileAt = (index: number) => {
    if (tileSets.length === 0) return;
    const normalized = ((index % tileSets.length) + tileSets.length) % tileSets.length;
    setTileDate(tileSets[normalized].date);
    setTileVersion(tileSets[normalized].version);
  };
  const opacitySteps = [0.25, 0.5, 0.75, 1];
  const cameraDefaultSettings = React.useMemo(() => ({
    centerCoordinate: initialCenter,
    zoomLevel: 15,
  }), []);
  const panelPanResponder = React.useMemo(
    () => PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 12 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
      onPanResponderRelease: (_, gesture) => {
        if (gesture.dx > 20) setIndexPanelSide('right');
        if (gesture.dx < -20) setIndexPanelSide('left');
      },
    }),
    [setIndexPanelSide]
  );
  const panelSideStyle = indexPanelSide === 'right'
    ? { right: 8, left: undefined }
    : { left: 8, right: undefined };

  return (
    <SafeAreaView style={mStyles.root}>
      <StatusBar barStyle="light-content" backgroundColor={UI.bg0} />

      {/* ── MAPPA ─────────────────────────────────────────────────────────── */}
      <MapView
        style={StyleSheet.absoluteFillObject}
        mapStyle={SATELLITE_STYLE}
        logoEnabled={false}
        attributionEnabled={false}
        // onRegionWillChange si triggera quando l'utente inizia a trascinare/zoomare
        onRegionWillChange={() => { followLocationRef.current = false; }}
      >
        <Camera
          ref={cameraRef}
          defaultSettings={cameraDefaultSettings}
        />

        {/* Layer indice funghi — RasterSource, nessun tile fantasma */}
        {!tilesLoading && tileDate && tileVersion && (
          <IndiceLayerTiles activeLayer={activeLayer} date={tileDate} version={tileVersion} opacity={tileOpacity} />
        )}

        {/* Dot posizione GPS corrente */}
        {currentPosGeoJSON && (
          <ShapeSource id="current-pos-source" shape={currentPosGeoJSON}>
            <CircleLayer
              id="current-pos-layer"
              style={{
                circleRadius: 8,
                circleColor: '#1988ff',
                circleStrokeWidth: 2,
                circleStrokeColor: '#0066d3',
              }}
            />
          </ShapeSource>
        )}

        {/* Tracciato sessione corrente */}
        {recording && path.length > 1 && (
          <ShapeSource id="current-path-source" shape={currentPathGeoJSON}>
            <LineLayer
              id="current-path-layer"
              style={{
                lineColor: UI.greenBri,
                lineWidth: 3,
                lineCap: 'round',
                lineJoin: 'round',
              }}
            />
          </ShapeSource>
        )}

        {/* Marker Porcini sessione corrente */}
        {recording && porciniCount > 0 && (
          <ShapeSource id="porcini-session-source" shape={porciniGeoJSON}>
            <CircleLayer
              id="porcini-session-layer"
              style={{ circleRadius: 10, circleColor: UI.porcino, circleStrokeWidth: 1.5, circleStrokeColor: '#000' }}
            />
          </ShapeSource>
        )}

        {/* Marker Finferli sessione corrente */}
        {recording && finferliCount > 0 && (
          <ShapeSource id="finferli-session-source" shape={finferliGeoJSON}>
            <CircleLayer
              id="finferli-session-layer"
              style={{ circleRadius: 10, circleColor: UI.finferlo, circleStrokeWidth: 1.5, circleStrokeColor: '#000' }}
            />
          </ShapeSource>
        )}

        {/* Percorsi salvati dall'archivio */}
        {routesOnMap.map((route: RouteData, idx: number) => {
          const isHighlighted = highlightedRoute === route.route_id;
          const lineGeoJSON = coordsToGeoJSONLine(route.path.filter((p) => p.latitude != null && p.longitude != null));
          const rPorcini = markersToGeoJSON(route.markers, 'Porcino');
          const rFinferli = markersToGeoJSON(route.markers, 'Finferlo');
          return (
            <React.Fragment key={route.route_id ?? idx}>
              <ShapeSource id={`saved-path-source-${idx}`} shape={lineGeoJSON}>
                <LineLayer
                  id={`saved-path-layer-${idx}`}
                  style={{
                    lineColor: isHighlighted ? '#003cff' : '#1e8fff',
                    lineWidth: isHighlighted ? 4 : 1.5,
                    lineCap: 'round',
                    lineJoin: 'round',
                    lineOpacity: isHighlighted ? 1 : 0.57,
                  }}
                />
              </ShapeSource>
              {rPorcini.features.length > 0 && (
                <ShapeSource id={`saved-porcini-source-${idx}`} shape={rPorcini}>
                  <CircleLayer
                    id={`saved-porcini-layer-${idx}`}
                    style={{ circleRadius: isHighlighted ? 12 : 8, circleColor: '#965123', circleStrokeWidth: 1, circleStrokeColor: '#000', circleOpacity: 0.73 }}
                  />
                </ShapeSource>
              )}
              {rFinferli.features.length > 0 && (
                <ShapeSource id={`saved-finferli-source-${idx}`} shape={rFinferli}>
                  <CircleLayer
                    id={`saved-finferli-layer-${idx}`}
                    style={{ circleRadius: isHighlighted ? 12 : 8, circleColor: '#ffd900', circleStrokeWidth: 1, circleStrokeColor: '#000', circleOpacity: 0.73 }}
                  />
                </ShapeSource>
              )}
            </React.Fragment>
          );
        })}
      </MapView>

      {/* ── HEADER PILL ──────────────────────────────────────────────────── */}
      <View style={mStyles.headerPill} pointerEvents="none">
        <Text style={mStyles.headerEmoji}>🍄</Text>
        <Text style={mStyles.headerTitle}>FUNGHI TRACKER</Text>
        {recording && <Animated.View style={[mStyles.recDot, { opacity: recPulse }]} />}
      </View>

      {tilesLoading && (
        <View style={mStyles.tileStatusPill}>
          <Text style={mStyles.tileStatusText}>Caricamento layer indice...</Text>
        </View>
      )}
      {!!tilesError && !tileDate && !tileVersion && (
        <View style={mStyles.tileStatusPillError}>
          <Text style={mStyles.tileStatusText}>Layer indice non disponibile</Text>
        </View>
      )}

      {activeLayer !== 'off' && !tilesLoading && tileDate && tileVersion && (
        <View
          style={[mStyles.indexPanel, panelSideStyle, indexPanelCollapsed && mStyles.indexPanelCollapsed]}
          {...panelPanResponder.panHandlers}
        >
          <View style={mStyles.indexPanelHeader}>
            <Text style={mStyles.indexPanelTitle}>INDICE</Text>
            <View style={mStyles.indexPanelActions}>
              <TouchableOpacity onPress={() => setIndexPanelCollapsed((value: boolean) => !value)} style={mStyles.indexCloseBtn}>
                <Text style={mStyles.indexCloseText}>{indexPanelCollapsed ? '+' : '−'}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setActiveLayer('off')} style={mStyles.indexCloseBtn}>
                <Text style={mStyles.indexCloseText}>×</Text>
              </TouchableOpacity>
            </View>
          </View>

          {!indexPanelCollapsed && (
            <>
              <View style={mStyles.indexSpeciesRow}>
                {(['porcini', 'finferli'] as ActiveLayer[]).map((layer) => {
                  const active = activeLayer === layer;
                  const color = layer === 'porcini' ? UI.porcinoHi : UI.finferloHi;
                  return (
                    <TouchableOpacity
                      key={layer}
                      onPress={() => setActiveLayer(layer)}
                      style={[mStyles.indexSpeciesBtn, active && { borderColor: color, backgroundColor: `${color}33` }]}
                    >
                      <Text style={[mStyles.indexSpeciesText, active && { color }]}>
                        {layer === 'porcini' ? 'P' : 'F'}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <View style={mStyles.indexDatasetRow}>
                <TouchableOpacity
                  onPress={() => selectTileAt(activeTileIndex + 1)}
                  style={[mStyles.indexArrowBtn, tileSets.length === 0 && mStyles.indexArrowBtnDisabled]}
                  disabled={tileSets.length === 0}
                >
                  <Text style={mStyles.indexArrowText}>‹</Text>
                </TouchableOpacity>
                <View style={mStyles.indexDatasetInfo}>
                  <Text style={mStyles.indexDatasetLabel}>DATA / VERSIONE</Text>
                  <Text style={mStyles.indexDatasetValue}>{selectedTileLabel}</Text>
                  {tileSets.length === 0 && (
                    <Text style={mStyles.indexDatasetHint}>Lista automatica non disponibile</Text>
                  )}
                </View>
                <TouchableOpacity
                  onPress={() => selectTileAt(activeTileIndex - 1)}
                  style={[mStyles.indexArrowBtn, tileSets.length === 0 && mStyles.indexArrowBtnDisabled]}
                  disabled={tileSets.length === 0}
                >
                  <Text style={mStyles.indexArrowText}>›</Text>
                </TouchableOpacity>
              </View>

              <View style={mStyles.indexOpacityRow}>
                <Text style={mStyles.indexDatasetLabel}>OPACITA'</Text>
                <View style={mStyles.indexOpacitySteps}>
                  {opacitySteps.map((value) => {
                    const active = Math.abs(tileOpacity - value) < 0.01;
                    return (
                      <TouchableOpacity
                        key={value}
                        onPress={() => setTileOpacity(value)}
                        style={[mStyles.indexOpacityBtn, active && mStyles.indexOpacityBtnActive]}
                      >
                        <Text style={[mStyles.indexOpacityText, active && mStyles.indexOpacityTextActive]}>
                          {Math.round(value * 100)}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            </>
          )}
        </View>
      )}

      {/* ── OVERLAY LISTA FUNGHI (destra) ────────────────────────────────── */}
      {recording && markers.length > 0 && (
        <View style={mStyles.overlayRight}>
          <View style={mStyles.overlayHeader}>
            <Text style={mStyles.overlayLabel}>TROVATI</Text>
            <View style={mStyles.overlayCount}><Text style={mStyles.overlayCountText}>{markers.length}</Text></View>
          </View>
          <ScrollView style={{ maxHeight: showAll ? 280 : 130 }} showsVerticalScrollIndicator={false}>
            {visibleMarkers.map((m: MarkerData) => (
              <View key={m.name} style={mStyles.markerRow}>
                <View style={[mStyles.markerBadge, { backgroundColor: m.tipo === 'Porcino' ? UI.porcino : UI.finferlo }]}>
                  <Text style={mStyles.markerBadgeLetter}>{m.tipo === 'Porcino' ? 'P' : 'F'}</Text>
                </View>
                <Text style={mStyles.markerName} numberOfLines={1}>{m.name}</Text>
                <TouchableOpacity onPress={() => handleDeleteMarker(m)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Trash2 size={14} color={UI.redBri} />
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>
          {markers.length > 5 && (
            <TouchableOpacity onPress={() => setShowAll(!showAll)} style={mStyles.showMoreBtn}>
              <Text style={mStyles.showMoreText}>{showAll ? '▲ MENO' : `▼ TUTTI (${markers.length})`}</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* ── OVERLAY PERCORSI IN MAPPA (sinistra) ─────────────────────────── */}
      {routesOnMap.length > 0 && (
        <View style={mStyles.overlayLeft}>
          <View style={mStyles.overlayHeader}>
            <Text style={mStyles.overlayLabel}>IN MAPPA</Text>
            <View style={mStyles.overlayCount}><Text style={mStyles.overlayCountText}>{routesOnMap.length}</Text></View>
          </View>
          <ScrollView style={{ maxHeight: 200 }} showsVerticalScrollIndicator={false}>
            {routesOnMap.map((route: RouteData, idx: number) => (
              <View key={idx} style={mStyles.routeRow}>
                <TouchableOpacity
                  style={mStyles.routeRowTouch}
                  onPress={() => {
                    const coordinates = route.path.filter((p) => p.latitude && p.longitude);
                    if (coordinates.length === 0) return;
                    const lats = coordinates.map((c) => c.latitude);
                    const lons = coordinates.map((c) => c.longitude);
                    // fitBounds(ne, sw, padding, duration)
                    cameraRef.current?.fitBounds(
                      [Math.max(...lons), Math.max(...lats)],
                      [Math.min(...lons), Math.min(...lats)],
                      50,
                      1000
                    );
                    highlightRoute(route.route_id!);
                  }}
                >
                  <View style={mStyles.routeTrackDot} />
                  <Text style={mStyles.routeRowName} numberOfLines={1} ellipsizeMode="tail">{route.name}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() =>
                    Alert.alert('Conferma rimozione', 'Vuoi rimuovere questa rotta dalla mappa?', [
                      { text: 'Annulla', style: 'cancel' },
                      { text: 'Rimuovi', style: 'destructive', onPress: () => setAddedRoutes((prev: string[]) => prev.filter((r) => r !== route.route_id)) },
                    ])
                  }
                  style={{ paddingLeft: 6 }}
                >
                  <Text style={{ color: UI.redBri, fontSize: 16 }}>✕</Text>
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      {/* ── STATS BAR ─────────────────────────────────────────────────────── */}
      {recording && (
        <View style={mStyles.statsBar}>
          <View style={mStyles.statItem}>
            <Text style={mStyles.statValue}>{path.length}</Text>
            <Text style={mStyles.statLabel}>GPS</Text>
          </View>
          <View style={mStyles.statDivider} />
          <View style={mStyles.statItem}>
            <Text style={[mStyles.statValue, { color: UI.porcinoHi }]}>{porciniCount}</Text>
            <Text style={mStyles.statLabel}>PORCINI</Text>
          </View>
          <View style={mStyles.statDivider} />
          <View style={mStyles.statItem}>
            <Text style={[mStyles.statValue, { color: UI.finferloHi }]}>{finferliCount}</Text>
            <Text style={mStyles.statLabel}>FINFERLI</Text>
          </View>
        </View>
      )}

      {/* ── PULSANTE CENTRA ───────────────────────────────────────────────── */}
      <TouchableOpacity
        style={recording ? mStyles.centerBtnRecording : mStyles.centerBtn}
        onPress={() => {
          followLocationRef.current = true;
          if (path.length > 0) {
            const latest = path[path.length - 1];
            cameraRef.current?.moveTo([latest.longitude, latest.latitude], 500);
          }
        }}
      >
        <Text style={{ fontSize: 18 }}>📍</Text>
      </TouchableOpacity>

      {/* ── CONTROLLI INFERIORI ───────────────────────────────────────────── */}
      <View style={mStyles.bottomControls}>
        <View style={mStyles.speciesRow}>
          <TouchableOpacity
            style={[mStyles.speciesBtn, mStyles.speciesBtnFinferlo, (!recording || path.length < 1) && mStyles.speciesBtnDisabled]}
            onPress={() => addMarker('Finferlo')}
            disabled={!recording || path.length < 1}
            activeOpacity={0.75}
          >
            <Text style={mStyles.speciesEmoji}>🌼</Text>
            <Text style={[mStyles.speciesBtnText, { color: UI.finferloHi }]}>FINFERLO</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[mStyles.speciesBtn, mStyles.speciesBtnPorcino, (!recording || path.length < 1) && mStyles.speciesBtnDisabled]}
            onPress={() => addMarker('Porcino')}
            disabled={!recording || path.length < 1}
            activeOpacity={0.75}
          >
            <Text style={mStyles.speciesEmoji}>🍄</Text>
            <Text style={[mStyles.speciesBtnText, { color: UI.porcinoHi }]}>PORCINO</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity
          style={[mStyles.mainBtn, recording ? mStyles.mainBtnStop : mStyles.mainBtnStart]}
          onPress={() => {
            if (recording) {
              Alert.alert('Conferma', 'Sei sicuro di voler terminare la registrazione?', [
                { text: 'Annulla', style: 'cancel' },
                { text: 'OK', onPress: stopRecording },
              ]);
            } else {
              startRecording();
            }
          }}
          activeOpacity={0.85}
        >
          <Text style={mStyles.mainBtnIcon}>{recording ? '⏹' : '▶'}</Text>
          <Text style={mStyles.mainBtnText}>{recording ? 'FERMA REGISTRAZIONE' : 'AVVIA REGISTRAZIONE'}</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ManageRoutesScreen — identico all'originale
// ══════════════════════════════════════════════════════════════════════════════
function ManageRoutesScreen(props: any) {
  const { addedRoutes, setAddedRoutes, handleShare, saveVisible, setSaveVisible, fileName, setFileName } = props;
  const [routes, setRoutes] = React.useState<any[]>([]);
  const [refreshing, setRefreshing] = React.useState(false);
  const [selectedRoute, setSelectedRoute] = React.useState<any>(null);
  const [modalVisible, setModalVisible] = React.useState(false);

  const fetchAllRoutes = React.useCallback(async () => {
    try { setRoutes(await getAllRoutes()); } catch { setRoutes([]); }
  }, []);

  React.useEffect(() => {
    let mounted = true;
    getAllRoutes().then((r) => { if (mounted) setRoutes(r); }).catch(() => { if (mounted) setRoutes([]); });
    return () => { mounted = false; };
  }, [fetchAllRoutes]);

  const toggleRoute = (route_id: string) => {
    if (addedRoutes.includes(route_id)) setAddedRoutes((prev: string[]) => prev.filter((r: string) => r !== route_id));
    else setAddedRoutes((prev: string[]) => [...prev, route_id]);
  };

  const handleDelete = async () => {
    if (!selectedRoute) return;
    Alert.alert('Conferma eliminazione', `Vuoi eliminare il percorso "${selectedRoute.name}"?`, [
      { text: 'Annulla', style: 'cancel' },
      { text: 'Elimina', style: 'destructive', onPress: async () => {
        try { await deleteRoute(selectedRoute.route_id); setModalVisible(false); await fetchAllRoutes(); } catch { }
      }},
    ]);
  };

  const formatDate = (isoDate: string) => {
    try { return new Date(isoDate).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' }); }
    catch { return isoDate; }
  };

  return (
    <SafeAreaView style={aStyles.root}>
      <StatusBar barStyle="light-content" backgroundColor={UI.bg0} />
      <View style={aStyles.header}>
        <Text style={aStyles.headerTitle}>ARCHIVIO</Text>
        <Text style={aStyles.headerSub}>{routes.length} percors{routes.length !== 1 ? 'i' : 'o'} salvat{routes.length !== 1 ? 'i' : 'o'}</Text>
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={aStyles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => { setRefreshing(true); await fetchAllRoutes(); setRefreshing(false); }}
            tintColor={UI.greenBri}
            colors={[UI.greenBri]}
          />
        }
      >
        {routes.length === 0 && (
          <View style={aStyles.emptyState}>
            <Text style={aStyles.emptyEmoji}>🌲</Text>
            <Text style={aStyles.emptyTitle}>Nessun percorso salvato</Text>
            <Text style={aStyles.emptySub}>Registra la tua prima uscita{'\n'}dalla schermata Mappa</Text>
          </View>
        )}
        {routes.map((r: any) => {
          const isAdded = addedRoutes.includes(r.route_id);
          return (
            <View key={r.route_id} style={aStyles.card}>
              <TouchableOpacity onPress={() => toggleRoute(r.route_id)} style={[aStyles.toggleBtn, isAdded && aStyles.toggleBtnActive]} activeOpacity={0.8}>
                <Text style={aStyles.toggleIcon}>{isAdded ? '−' : '+'}</Text>
              </TouchableOpacity>
              <View style={aStyles.cardInfo}>
                <Text style={aStyles.cardName} numberOfLines={1}>{r.name}</Text>
                <Text style={aStyles.cardDate}>{formatDate(r.date)}</Text>
              </View>
              <TouchableOpacity onPress={() => { setSelectedRoute(r); setModalVisible(true); }} style={aStyles.menuBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={aStyles.menuDots}>⋮</Text>
              </TouchableOpacity>
            </View>
          );
        })}
      </ScrollView>

      {/* Modal opzioni percorso */}
      <Modal visible={modalVisible} transparent animationType="fade" onRequestClose={() => setModalVisible(false)}>
        <TouchableOpacity style={aStyles.modalBackdrop} activeOpacity={1} onPressOut={() => setModalVisible(false)}>
          <View style={aStyles.modalCard}>
            <Text style={aStyles.modalTitle}>{selectedRoute?.name}</Text>
            <Text style={aStyles.modalDate}>{selectedRoute ? formatDate(selectedRoute.date) : ''}</Text>
            <View style={aStyles.modalDivider} />
            <TouchableOpacity style={aStyles.modalAction} onPress={() => { if (addedRoutes.includes(selectedRoute?.route_id)) toggleRoute(selectedRoute?.route_id); handleShare(selectedRoute.route_id); }}>
              <Text style={aStyles.modalActionIcon}>📤</Text>
              <Text style={aStyles.modalActionText}>Esporta GPX</Text>
            </TouchableOpacity>
            <TouchableOpacity style={aStyles.modalAction} onPress={() => { if (addedRoutes.includes(selectedRoute?.route_id)) toggleRoute(selectedRoute?.route_id); handleDelete(); }}>
              <Text style={aStyles.modalActionIcon}>🗑️</Text>
              <Text style={[aStyles.modalActionText, { color: UI.redBri }]}>Elimina da archivio</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[aStyles.modalAction, { borderBottomWidth: 0 }]} onPress={() => setModalVisible(false)}>
              <Text style={[aStyles.modalActionText, { color: UI.textSec }]}>Annulla</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Modal nome GPX */}
      <Modal visible={saveVisible} transparent animationType="slide">
        <View style={aStyles.modalBackdrop}>
          <View style={aStyles.modalCard}>
            <Text style={aStyles.modalTitle}>Nome file GPX</Text>
            <TextInput style={aStyles.textInput} value={fileName} onChangeText={setFileName} placeholder="Nome file" placeholderTextColor={UI.textMut} autoFocus />
            <Button title="Salva e Condividi" onPress={handleShare} color={UI.green} />
            <View style={{ height: 8 }} />
            <Button title="Annulla" onPress={() => setSaveVisible(false)} color={UI.textMut} />
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// STILI
// ══════════════════════════════════════════════════════════════════════════════
const mStyles = StyleSheet.create({
  root: { flex: 1, backgroundColor: UI.bg0 },
  headerPill: { position: 'absolute', top: 48, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(10,17,11,0.88)', borderWidth: 1, borderColor: UI.border, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 24 },
  headerEmoji: { fontSize: 16 },
  headerTitle: { color: UI.textPri, fontSize: 13, fontWeight: '800', letterSpacing: 2.5 },
  recDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: UI.redBri, marginLeft: 4 },
  tileStatusPill: { position: 'absolute', top: 86, alignSelf: 'center', backgroundColor: 'rgba(10,17,11,0.88)', borderWidth: 1, borderColor: UI.border, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6 },
  tileStatusPillError: { position: 'absolute', top: 86, alignSelf: 'center', backgroundColor: 'rgba(140,48,48,0.92)', borderWidth: 1, borderColor: UI.redBri, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6 },
  tileStatusText: { color: UI.textPri, fontSize: 11, fontWeight: '700' },
  indexPanel: { position: 'absolute', top: 96, right: 8, width: 210, backgroundColor: 'rgba(10,17,11,0.94)', borderWidth: 1, borderColor: UI.borderHi, borderRadius: 10, padding: 10, gap: 9 },
  indexPanelCollapsed: { width: 118 },
  indexPanelHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  indexPanelTitle: { color: UI.textPri, fontSize: 11, fontWeight: '900', letterSpacing: 2 },
  indexPanelActions: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  indexCloseBtn: { width: 26, height: 26, borderRadius: 6, backgroundColor: UI.bg3, alignItems: 'center', justifyContent: 'center' },
  indexCloseText: { color: UI.textSec, fontSize: 18, fontWeight: '800', lineHeight: 22 },
  indexSpeciesRow: { flexDirection: 'row', gap: 6 },
  indexSpeciesBtn: { flex: 1, height: 34, borderRadius: 7, borderWidth: 1, borderColor: UI.border, backgroundColor: UI.bg2, alignItems: 'center', justifyContent: 'center' },
  indexSpeciesText: { color: UI.textMut, fontSize: 13, fontWeight: '900' },
  indexDatasetRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  indexArrowBtn: { width: 30, height: 38, borderRadius: 7, backgroundColor: UI.bg3, borderWidth: 1, borderColor: UI.border, alignItems: 'center', justifyContent: 'center' },
  indexArrowBtnDisabled: { opacity: 0.35 },
  indexArrowText: { color: UI.textPri, fontSize: 24, fontWeight: '700', lineHeight: 28 },
  indexDatasetInfo: { flex: 1, minWidth: 0 },
  indexDatasetLabel: { color: UI.textMut, fontSize: 8, fontWeight: '900', letterSpacing: 1.2 },
  indexDatasetValue: { color: UI.textPri, fontSize: 12, fontWeight: '800', marginTop: 2 },
  indexDatasetHint: { color: UI.amberBri, fontSize: 9, fontWeight: '700', marginTop: 3 },
  indexOpacityRow: { gap: 5 },
  indexOpacitySteps: { flexDirection: 'row', gap: 5 },
  indexOpacityBtn: { flex: 1, height: 28, borderRadius: 6, backgroundColor: UI.bg2, borderWidth: 1, borderColor: UI.border, alignItems: 'center', justifyContent: 'center' },
  indexOpacityBtnActive: { backgroundColor: UI.greenDim, borderColor: UI.greenBri },
  indexOpacityText: { color: UI.textMut, fontSize: 10, fontWeight: '800' },
  indexOpacityTextActive: { color: UI.greenBri },
  overlayRight: { position: 'absolute', top: 110, right: 8, backgroundColor: 'rgba(10,17,11,0.92)', borderWidth: 1, borderColor: UI.border, borderRadius: 12, padding: 10, width: 168 },
  overlayLeft: { position: 'absolute', top: 110, left: 8, backgroundColor: 'rgba(10,17,11,0.92)', borderWidth: 1, borderColor: UI.border, borderRadius: 12, padding: 10, width: 176 },
  overlayHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  overlayLabel: { color: UI.textMut, fontSize: 9, fontWeight: '800', letterSpacing: 2 },
  overlayCount: { backgroundColor: UI.greenDim, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1 },
  overlayCountText: { color: UI.greenBri, fontSize: 10, fontWeight: '700' },
  markerRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 6 },
  markerBadge: { width: 20, height: 20, borderRadius: 4, justifyContent: 'center', alignItems: 'center' },
  markerBadgeLetter: { color: '#fff', fontSize: 10, fontWeight: '900' },
  markerName: { flex: 1, color: UI.textPri, fontSize: 11, fontWeight: '500' },
  showMoreBtn: { marginTop: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: UI.border, alignItems: 'center' },
  showMoreText: { color: UI.greenBri, fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  routeRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  routeRowTouch: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingVertical: 3, gap: 8 },
  routeTrackDot: { width: 14, height: 3, borderRadius: 2, backgroundColor: '#1e8fff' },
  routeRowName: { flex: 1, color: UI.textPri, fontSize: 11, fontWeight: '500' },
  statsBar: { position: 'absolute', bottom: 138, left: 12, right: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(10,17,11,0.50)', borderWidth: 1, borderColor: UI.border, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 8 },
  statItem: { flex: 1, alignItems: 'center' },
  statValue: { color: UI.textPri, fontSize: 20, fontWeight: '800', lineHeight: 24 },
  statLabel: { color: UI.textMut, fontSize: 9, fontWeight: '700', letterSpacing: 1.5, marginTop: 1 },
  statDivider: { width: 1, height: 28, backgroundColor: UI.border },
  centerBtn: { position: 'absolute', bottom: 146, left: 16, width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(10,17,11,0.90)', borderWidth: 1, borderColor: UI.border, justifyContent: 'center', alignItems: 'center' },
  centerBtnRecording: { position: 'absolute', bottom: 206, left: 16, width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(10,17,11,0.90)', borderWidth: 1, borderColor: UI.border, justifyContent: 'center', alignItems: 'center' },
  bottomControls: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingHorizontal: 12, paddingBottom: 16, paddingTop: 8, gap: 8 },
  speciesRow: { flexDirection: 'row', gap: 8 },
  speciesBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 11, borderRadius: 10, borderWidth: 1.5, backgroundColor: 'rgba(10,17,11,0.92)' },
  speciesBtnFinferlo: { borderColor: UI.finferlo },
  speciesBtnPorcino: { borderColor: UI.porcino },
  speciesBtnDisabled: { opacity: 0.35 },
  speciesEmoji: { fontSize: 15 },
  speciesBtnText: { fontSize: 12, fontWeight: '800', letterSpacing: 1 },
  mainBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 16, borderRadius: 12, borderWidth: 1.5 },
  mainBtnStart: { backgroundColor: UI.greenDim, borderColor: UI.greenBri },
  mainBtnStop: { backgroundColor: '#2a0a0a', borderColor: UI.redBri },
  mainBtnIcon: { fontSize: 16, color: '#fff' },
  mainBtnText: { color: '#fff', fontSize: 14, fontWeight: '800', letterSpacing: 2 },
});

const aStyles = StyleSheet.create({
  root: { flex: 1, backgroundColor: UI.bg0 },
  header: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: UI.border },
  headerTitle: { color: UI.textPri, fontSize: 24, fontWeight: '900', letterSpacing: 5 },
  headerSub: { color: UI.textMut, fontSize: 11, fontWeight: '600', letterSpacing: 0.5, marginTop: 2 },
  listContent: { padding: 12, paddingBottom: 24, gap: 8 },
  emptyState: { alignItems: 'center', paddingTop: 80, gap: 10 },
  emptyEmoji: { fontSize: 52 },
  emptyTitle: { color: UI.textPri, fontSize: 18, fontWeight: '700' },
  emptySub: { color: UI.textMut, fontSize: 13, textAlign: 'center', lineHeight: 20 },
  card: { flexDirection: 'row', alignItems: 'center', backgroundColor: UI.bg2, borderWidth: 1, borderColor: UI.border, borderRadius: 12, padding: 12, gap: 12 },
  toggleBtn: { width: 36, height: 36, borderRadius: 8, backgroundColor: UI.bg3, borderWidth: 1.5, borderColor: UI.border, justifyContent: 'center', alignItems: 'center' },
  toggleBtnActive: { backgroundColor: UI.greenDim, borderColor: UI.greenBri },
  toggleIcon: { color: UI.textPri, fontSize: 20, fontWeight: '700', lineHeight: 24 },
  cardInfo: { flex: 1 },
  cardName: { color: UI.textPri, fontSize: 15, fontWeight: '700' },
  cardDate: { color: UI.textMut, fontSize: 12, marginTop: 2 },
  menuBtn: { paddingHorizontal: 4 },
  menuDots: { color: UI.textSec, fontSize: 22, fontWeight: '900', lineHeight: 26 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  modalCard: { backgroundColor: UI.bg2, borderWidth: 1, borderColor: UI.border, borderRadius: 16, padding: 20, width: '100%', maxWidth: 360 },
  modalTitle: { color: UI.textPri, fontSize: 17, fontWeight: '800', marginBottom: 4 },
  modalDate: { color: UI.textMut, fontSize: 12, marginBottom: 4 },
  modalDivider: { height: 1, backgroundColor: UI.border, marginVertical: 12 },
  modalAction: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: UI.border },
  modalActionIcon: { fontSize: 18 },
  modalActionText: { color: UI.textPri, fontSize: 16, fontWeight: '600' },
  textInput: { backgroundColor: UI.bg3, borderWidth: 1, borderColor: UI.border, borderRadius: 8, padding: 12, color: UI.textPri, fontSize: 15, marginVertical: 12 },
});
