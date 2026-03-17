import React from 'react';
import {
  StyleSheet, Text, View, Button, useColorScheme, Alert, TextInput, Modal, Linking,
  TouchableOpacity, Animated, StatusBar, Platform, ScrollView, RefreshControl
} from 'react-native';
import MapView, { Region, Polyline, Marker, Circle } from 'react-native-maps';
import { Trash2 } from 'lucide-react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { File, Paths } from "expo-file-system";
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { initDB, insertRoute, getAllRoutes, getRouteById, deleteRoute } from './db';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { NavigationContainer } from '@react-navigation/native';
import uuid from 'react-native-uuid';
import * as Updates from 'expo-updates';
import IndiceScreen, { ActiveLayer } from './IndiceScreen';
import { IndiceLayerPolygons } from './IndiceLayers';

// ─── Tipi (IDENTICI ALL'ORIGINALE) ────────────────────────────────────────────
type Coordinate = {
  latitude: number;
  longitude: number;
  timestamp: number;
};
type MarkerData = Coordinate & { tipo: 'Porcino' | 'Finferlo', name: string };
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

// ─── Costanti (IDENTICHE ALL'ORIGINALE) ───────────────────────────────────────
const Tab = createBottomTabNavigator();
const LOCATION_TASK_NAME = "background-location-task";
const BG_POSITIONS_FILE = `${FileSystemLegacy.cacheDirectory}bg_positions.json`;

// ─── Palette UI ───────────────────────────────────────────────────────────────
const UI = {
  // Sfondi
  bg0:       '#0a110b',   // nero bosco
  bg1:       '#111a12',   // superficie primaria
  bg2:       '#182019',   // superficie elevata
  bg3:       '#1f2b20',   // card / overlay

  // Bordi
  border:    '#2d4030',
  borderHi:  '#3d5542',

  // Testi
  textPri:   '#dde8cc',   // crema chiaro
  textSec:   '#8ba67a',   // verde muted
  textMut:   '#4d6352',   // molto muted

  // Accenti
  green:     '#4a8c3f',
  greenBri:  '#6db85f',
  greenDim:  '#2e5528',

  amber:     '#c8832a',
  amberBri:  '#e8a040',

  red:       '#8c3030',
  redBri:    '#c44040',

  // Specie
  porcino:   '#8B5E3C',
  porcinoHi: '#b07a50',
  finferlo:  '#C9901A',
  finferloHi:'#e0aa30',

  // GPS dot
  gpsDot:    '#4a9eff',
};

// ─── BACKGROUND TASK (IDENTICO ALL'ORIGINALE) ─────────────────────────────────
TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.error("Errore task location:", error);
    return;
  }
  if (data) {
    console.log("Background location task:", JSON.stringify(data));
    try {
      const { locations } = data as any;
      let arr: Coordinate[] = [];
      try {
        const info = await FileSystemLegacy.getInfoAsync(BG_POSITIONS_FILE);
        if (info.exists) {
          const raw = await FileSystemLegacy.readAsStringAsync(BG_POSITIONS_FILE);
          arr = JSON.parse(raw || "[]");
        }
      } catch {
        arr = [];
      }
      (locations as any[]).forEach((loc) => {
        const ts = typeof loc.timestamp === "number" ? loc.timestamp : Date.now();
        arr.push({
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
          timestamp: ts,
        });
      });
      await FileSystemLegacy.writeAsStringAsync(BG_POSITIONS_FILE, JSON.stringify(arr));
    } catch (err) {
      console.error("Errore scrittura file bg positions:", err);
    }
  }
});

// ─── checkAndOpenSettingsIfNeeded (IDENTICA ALL'ORIGINALE) ────────────────────
const checkAndOpenSettingsIfNeeded = async () => {
  if (Platform.OS !== 'android') return;
  const fg = await Location.getForegroundPermissionsAsync();
  const bg = await Location.getBackgroundPermissionsAsync();
  if (fg.status !== 'granted' || bg.status !== 'granted') {
    Alert.alert(
      'Permessi mancanti',
      'Per tracciare la posizione in background devi concedere tutti i permessi. Aprire impostazioni?',
      [
        { text: 'No', style: 'cancel' },
        { text: 'Sì', onPress: () => Linking.openSettings() },
      ]
    );
    return false;
  }
  return true;
};

// ══════════════════════════════════════════════════════════════════════════════
// App — LOGICA 100% IDENTICA ALL'ORIGINALE
// ══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [recording, setRecording] = React.useState(false);
  const [path, setPath] = React.useState<Coordinate[]>([]);
  const [markers, setMarkers] = React.useState<MarkerData[]>([]);
  const [saveVisible, setSaveVisible] = React.useState(false);
  const [fileName, setFileName] = React.useState('percorso');
  const [region, setRegion] = React.useState<Region | null>(null);
  const [showAll, setShowAll] = React.useState(false);
  const [addedRoutes, setAddedRoutes] = React.useState<string[]>([]);
  const [routesOnMap, setRoutesOnMap] = React.useState<RouteData[]>([]);
  const [highlightedRoute, setHighlightedRoute] = React.useState<string | null>(null);
  const [activeLayer, setActiveLayer] = React.useState<ActiveLayer>('off');
  const [currentRegion, setCurrentRegion] = React.useState<Region | null>(null);

  const followLocationRef = React.useRef(true);
  const mapRef = React.useRef<MapView>(null);
  const recordingRef = React.useRef(recording);
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  const visibleMarkers = showAll ? markers : markers.slice(0, 5);

  // check updates (IDENTICO)
  React.useEffect(() => {
    const checkForUpdates = async () => {
      try {
        const update = await Updates.checkForUpdateAsync();
        if (update.isAvailable) {
          await Updates.fetchUpdateAsync();
          Alert.alert(
            'Aggiornamento disponibile',
            'È disponibile una nuova versione. Vuoi aggiornare ora?',
            [
              { text: 'Più tardi', style: 'cancel' },
              { text: 'Aggiorna ora', onPress: () => Updates.reloadAsync() },
            ]
          );
        } else {
          console.log('Nessun aggiornamento disponibile');
        }
      } catch (err) {
        console.log('Errore durante il controllo update:', err);
      }
    };
    checkForUpdates();
  }, []);

  // init DB (IDENTICO)
  React.useEffect(() => {
    const setupDB = async () => {
      try {
        await initDB();
        console.log('DB inizializzato');
      } catch (err) {
        console.error('Errore initDB:', err);
      }
    };
    setupDB();
  }, []);

  // recordingRef sync (IDENTICO)
  React.useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  // posizione iniziale (IDENTICO)
  React.useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permesso GPS negato!');
        return;
      }
      const location = await Location.getCurrentPositionAsync({});
      const initialRegion = {
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
        latitudeDelta: 0.001,
        longitudeDelta: 0.001,
      };
      setRegion(initialRegion);
      mapRef.current?.animateToRegion(initialRegion, 1000);
    })();
  }, []);

  // handleDeleteMarker (IDENTICO)
  const handleDeleteMarker = (marker: MarkerData) => {
    Alert.alert(
      'Conferma eliminazione',
      `Vuoi eliminare ${marker.name}?`,
      [
        { text: 'Annulla', style: 'cancel' },
        {
          text: 'Elimina',
          style: 'destructive',
          onPress: () => { setMarkers(markers.filter(m => m.name !== marker.name)); }
        }
      ]
    );
  };

  // syncPathFromFile (IDENTICO)
  const syncPathFromFile = React.useCallback(async (consume = false): Promise<Coordinate[]> => {
    try {
      const info = await FileSystemLegacy.getInfoAsync(BG_POSITIONS_FILE);
      if (!info.exists) { return path; }
      const raw = await FileSystemLegacy.readAsStringAsync(BG_POSITIONS_FILE);
      const arr = JSON.parse(raw || "[]") as Coordinate[];
      if (!Array.isArray(arr) || arr.length === 0) { return path; }
      let updated: Coordinate[] = [];
      setPath(prev => {
        const lastTs = prev.length ? prev[prev.length - 1].timestamp : 0;
        const newPoints = arr.filter(p => (p.timestamp ?? 0) > lastTs);
        updated = newPoints.length ? [...prev, ...newPoints] : prev;
        return updated;
      });
      if (consume) {
        try {
          await FileSystemLegacy.deleteAsync(BG_POSITIONS_FILE, { idempotent: true });
        } catch (e) {
          console.warn("syncPathFromFile → errore delete:", e);
        }
      }
      return updated.length ? updated : path;
    } catch (err) {
      console.warn("syncPathFromFile error, ritorna", path.length, "punti");
      return path;
    }
  }, [path]);

  // polling (IDENTICO)
  React.useEffect(() => {
    let mounted = true;
    const tick = async () => {
      try {
        if (!mounted) return;
        const currpath = await syncPathFromFile(false);
        if (recordingRef.current && currpath.length > 0 && mapRef.current && followLocationRef.current) {
          const latest = currpath[currpath.length - 1];
          mapRef.current.animateToRegion({
            latitude: latest.latitude,
            longitude: latest.longitude,
            latitudeDelta: 0.001,
            longitudeDelta: 0.001,
          }, 500);
        }
      } catch (err) {
        console.warn('polling sync error', err);
      }
    };
    void tick();
    const id = setInterval(() => { void tick(); }, 500);
    return () => { mounted = false; clearInterval(id); };
  }, [syncPathFromFile]);

  // highlightRoute (IDENTICO)
  const highlightRoute = (routeId: string) => {
    setHighlightedRoute(routeId);
    setTimeout(() => setHighlightedRoute(null), 1000);
  };

  // startRecording (IDENTICO)
  const startRecording = async () => {
    const ok = await checkAndOpenSettingsIfNeeded();
    if (!ok) return;
    const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
    if (fgStatus !== 'granted') {
      Alert.alert('Permesso GPS negato!');
      return;
    }
    const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
    if (Platform.OS === 'android' && bgStatus !== 'granted') {
      Alert.alert('Permesso background non concesso', 'Per tracciare la posizione in background devi concedere "Consenti sempre" nelle impostazioni.');
    }
    setRecording(true);
    setPath([]);
    setMarkers([]);
    try {
      await FileSystemLegacy.deleteAsync(BG_POSITIONS_FILE, { idempotent: true });
    } catch (e) {
      console.warn("Errore all'avvio durante il delete del file background path:", e);
    }
    const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
    if (!started) {
      await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: 2000,
        distanceInterval: 1,
        showsBackgroundLocationIndicator: true,
        foregroundService: {
          notificationTitle: "GPS attivo",
          notificationBody: "L'app sta registrando la tua posizione",
        },
      });
    }
  };

  // saveCurrentRoute (IDENTICO)
  const saveCurrentRoute = async () => {
    const route_id = uuid.v4();
    const date = new Date().toISOString();
    const name = `Percorso ${new Date().toLocaleDateString()}`;
    console.log(`chiamo insertRoute(${route_id}, ${name}, ${date}, ${path}, ${markers})`);
    await insertRoute(route_id, name, date, path, markers);
  };

  // stopRecording (IDENTICO)
  const stopRecording = async () => {
    setRecording(false);
    try {
      const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
      if (started) { await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME); }
    } catch (err) {
      console.warn("Errore stop location updates:", err);
    }
    Alert.alert(
      'Salva',
      'Vuoi salvare il percorso registrato?',
      [
        { text: 'No', style: 'cancel' },
        {
          text: 'Sì', onPress: async () => {
            try {
              await saveCurrentRoute();
              console.log('Percorso salvato nel DB');
            } catch (err) {
              console.error('Errore salvataggio percorso:', err);
              Alert.alert('Errore', 'Impossibile salvare il percorso nel database.');
            }
          },
        },
      ]
    );
  };

  // addMarker (IDENTICO)
  const addMarker = React.useCallback(async (tipo: 'Porcino' | 'Finferlo') => {
    try {
      const updated = await syncPathFromFile(false);
      const last = (updated && updated.length) ? updated[updated.length - 1]
        : (path.length ? path[path.length - 1] : undefined);
      if (!last) {
        Alert.alert('Nessuna posizione disponibile', 'Non ci sono ancora posizioni registrate.');
        return;
      }
      console.log(`Aggiungo marker ${tipo} con nome ${tipo}_${markers.length + 1}`);
      setMarkers(prev => [...prev, {
        latitude: last.latitude,
        longitude: last.longitude,
        timestamp: Date.now(),
        tipo: tipo === 'Porcino' ? 'Porcino' : 'Finferlo',
        name: `${tipo}_${prev.filter(m => m.tipo === tipo).length + 1}`
      }]);
    } catch (e) {
      console.warn('addMarker error', e);
      Alert.alert('Errore', 'Impossibile aggiungere il segnaposto.');
    }
  }, [syncPathFromFile, path]);

  // generateGPX (IDENTICO)
  const generateGPX = (path: Coordinate[], markers: MarkerData[]): string => {
    const header = `<?xml version="1.0" encoding="UTF-8"?>
                    <gpx version="1.1" creator="Funghi Tracker">
                    <trk><name>Percorso</name><trkseg>`;
    const trackPoints = path.map((pt) => {
      const time = pt.timestamp ? new Date(pt.timestamp).toISOString() : null;
      return `<trkpt lat="${pt.latitude}" lon="${pt.longitude}">${time ? `<time>${time}</time>` : ''}</trkpt>`;
    }).join('\n');
    const footer = `</trkseg></trk>`;
    const waypoints = markers.map((m) => {
      const time = m.timestamp ? new Date(m.timestamp).toISOString() : null;
      return `<wpt lat="${m.latitude}" lon="${m.longitude}">${time ? `<time>${time}</time>` : ''}
              <name>${m.name}</name><type>${m.tipo}</type></wpt>`;
    }).join('\n');
    return `${header}\n${trackPoints}\n${footer}\n${waypoints}\n</gpx>`;
  };

  // handleShare (IDENTICO)
  const handleShare = async (route_id: string) => {
    try {
      const route = await getRouteById(route_id) as Route & { waypoints: Waypoint[] };
      const markers: MarkerData[] = route.waypoints.map(wp => ({
        latitude: wp.lat,
        longitude: wp.lon,
        timestamp: wp.timestamp,
        tipo: wp.type as 'Porcino' | 'Finferlo',
        name: wp.name,
      }));
      const routeData: RouteData = {
        name: route.name,
        date: route.date,
        path: route.path,
        markers: markers,
        route_id: route.route_id,
      };
      console.log("updatedPath completo:", routeData.path);
      console.log("updatedPath length:", routeData.path.length);
      console.log(routeData.path.map(p => p.timestamp));
      const gpxData = generateGPX(routeData.path, routeData.markers);
      let uri: string | undefined;
      try {
        const safeFileName = fileName?.trim() || `percorso_${Date.now()}`;
        const file = new File(Paths.cache, safeFileName + '.gpx');
        try { file.create(); } catch (errCreate) { /* ignore */ }
        try { await (file.write(gpxData) as Promise<void> | void); } catch (errWrite) { /* ignore */ }
        // @ts-ignore
        uri = file.uri ?? (file.getUri ? await file.getUri() : undefined);
      } catch (errNewAPI) {
        uri = undefined;
      }
      if (!uri) {
        const safeFileName = fileName?.trim() || `percorso_${Date.now()}`;
        const legacyUri = FileSystemLegacy.cacheDirectory + safeFileName + '.gpx';
        await FileSystemLegacy.writeAsStringAsync(legacyUri, gpxData, { encoding: 'utf8' });
        uri = legacyUri;
      }
      if (uri) {
        const available = await Sharing.isAvailableAsync();
        if (!available) {
          Alert.alert('Condivisione non disponibile', 'GPX salvato in: ' + uri);
        } else {
          await Sharing.shareAsync(uri);
        }
      } else {
        throw new Error('Impossibile ottenere URI del file GPX');
      }
    } catch (error: any) {
      console.error('handleShare errore', error);
      Alert.alert('Errore durante il salvataggio o condivisione', error?.message ?? String(error));
    } finally {
      setSaveVisible(false);
      setFileName('percorso');
    }
  };

  // ─── TAB NAVIGATOR (UI aggiornata, struttura identica) ────────────────────
  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <Tab.Navigator
          screenOptions={{
            headerShown: false,
            tabBarStyle: {
              height: 64,
              backgroundColor: UI.bg1,
              borderTopWidth: 1,
              borderTopColor: UI.border,
              paddingBottom: 6,
              paddingTop: 4,
            },
            tabBarActiveTintColor: UI.greenBri,
            tabBarInactiveTintColor: UI.textMut,
            tabBarLabelStyle: {
              fontSize: 10,
              fontWeight: '700',
              letterSpacing: 1.5,
              textTransform: 'uppercase',
            },
          }}
        >
          <Tab.Screen
            name="Mappa"
            children={() =>
              <MainUI
                recording={recording}
                startRecording={startRecording}
                stopRecording={stopRecording}
                addMarker={addMarker}
                path={path}
                markers={markers}
                isDark={isDark}
                mapRef={mapRef}
                region={region}
                followLocationRef={followLocationRef}
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
                onRegionChange={setCurrentRegion}
              />}
            options={{
              tabBarIcon: ({ color }) => (
                <Text style={{ fontSize: 20, color }}>🗺️</Text>
              ),
              tabBarLabel: 'Mappa',
            }}
          />

          <Tab.Screen
            name="Archivio"
            children={() =>
              <ManageRoutesScreen
                addedRoutes={addedRoutes}
                setAddedRoutes={setAddedRoutes}
                handleShare={handleShare}
                saveVisible={saveVisible}
                setSaveVisible={setSaveVisible}
                fileName={fileName}
                setFileName={setFileName}
              />}
            options={{
              tabBarIcon: ({ color }) => (
                <Text style={{ fontSize: 20, color }}>📂</Text>
              ),
              tabBarLabel: 'Archivio',
            }}
          />

          <Tab.Screen
            name="Indice"
            children={() =>
              <IndiceScreen
                activeLayer={activeLayer}
                setActiveLayer={setActiveLayer}
              />}
            options={{
              tabBarIcon: ({ color }) => (
                <Text style={{ fontSize: 20, color }}>🍄</Text>
              ),
              tabBarLabel: 'Indice',
            }}
          />
        </Tab.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MainUI — LOGICA IDENTICA, solo JSX/stili ridisegnati
// ══════════════════════════════════════════════════════════════════════════════
function MainUI(props: any) {
  const {
    recording, startRecording, stopRecording, addMarker,
    path, markers, isDark, mapRef, region, followLocationRef, showAll, visibleMarkers,
    handleDeleteMarker, setShowAll, addedRoutes, setAddedRoutes, setRoutesOnMap, routesOnMap,
    highlightRoute, highlightedRoute, activeLayer, onRegionChange,
  } = props;

  // Stato locale per la regione corrente (per sincronizzare la WebView)
  const [currentRegion, setCurrentRegion] = React.useState<Region | null>(null);

  // fetchRoutes (IDENTICO)
  React.useEffect(() => {
    const fetchRoutes = async () => {
      const newRoutes: RouteData[] = [];
      for (const route_id of addedRoutes) {
        const route = await getRouteById(route_id) as Route & { waypoints: Waypoint[] };
        console.log(`Fetched route ${route_id}:`, route);
        const markers: MarkerData[] = route.waypoints.map(wp => ({
          latitude: wp.lat,
          longitude: wp.lon,
          timestamp: wp.timestamp,
          tipo: wp.type as 'Porcino' | 'Finferlo',
          name: wp.name,
        }));
        const routeData: RouteData = {
          name: route.name,
          date: route.date,
          path: route.path,
          markers: markers,
          route_id: route.route_id,
        };
        if (route) newRoutes.push(routeData);
      }
      setRoutesOnMap(newRoutes.filter(r => r !== null) as RouteData[]);
    };
    fetchRoutes();
  }, [addedRoutes]);

  // pulse animation (IDENTICO)
  const pulseValue = React.useRef(new Animated.Value(0)).current;
  const currentHighlightedRoute = React.useRef<string | null>(null);

  const triggerPulse = (route_id: string) => {
    pulseValue.setValue(0);
    currentHighlightedRoute.current = route_id;
    Animated.timing(pulseValue, { toValue: 1, duration: 500, useNativeDriver: false }).start(() => {
      Animated.timing(pulseValue, { toValue: 0, duration: 500, useNativeDriver: false }).start();
    });
  };

  const rowBackgroundColor = pulseValue.interpolate({
    inputRange: [0, 1],
    outputRange: ["transparent", "rgba(255, 255, 0, 0.3)"],
  });

  // Conteggi per stats bar
  const porciniCount = markers.filter((m: MarkerData) => m.tipo === 'Porcino').length;
  const finferliCount = markers.filter((m: MarkerData) => m.tipo === 'Finferlo').length;

  // Indicatore REC pulsante
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

  return (
    <SafeAreaView style={mStyles.root}>
      <StatusBar barStyle="light-content" backgroundColor={UI.bg0} />

      {/* ── MAPPA (fullscreen) ───────────────────────────────────────── */}
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFillObject}
        initialRegion={region || { latitude: 45.4384, longitude: 10.9916, latitudeDelta: 0.001, longitudeDelta: 0.001 }}
        mapType="satellite"
        onPanDrag={() => { followLocationRef.current = false; }}
        onRegionChangeComplete={(r) => {   // ← AGGIUNTA
          setCurrentRegion(r);
          onRegionChange?.(r);
        }}
      >
        <IndiceLayerPolygons activeLayer={activeLayer} region={currentRegion} />

        {/* Posizione corrente - cerchio GPS */}
        {(path.length < 1 && region) && (
          <Circle
            center={{ latitude: region.latitude, longitude: region.longitude }}
            radius={2}
            fillColor="rgba(25, 136, 255, 0.8)"
            strokeColor="rgba(0, 102, 211, 1)"
            strokeWidth={2}
          />
        )}
        {path.length > 0 && (
          <Circle
            center={path[path.length - 1]}
            radius={2}
            fillColor="rgba(25, 136, 255, 0.8)"
            strokeColor="rgba(0, 102, 211, 1)"
            strokeWidth={2}
          />
        )}

        {/* Traccia corrente */}
        {(path.length > 1 && recording) && (
          <Polyline
            coordinates={path}
            strokeColor={UI.greenBri}
            strokeWidth={3}
          />
        )}

        {/* Marker sessione corrente */}
        {recording && markers.map((m: MarkerData) => (
          <Marker
            key={m.name}
            coordinate={{ latitude: m.latitude, longitude: m.longitude }}
            title={m.name}
            anchor={{ x: 0.38, y: 0.38 }}
          >
            <View style={[
              mStyles.markerDot,
              { backgroundColor: m.tipo === 'Porcino' ? UI.porcino : UI.finferlo }
            ]} />
          </Marker>
        ))}

        {/* Percorsi salvati dall'archivio */}
        {routesOnMap.map((route: RouteData, idx: number) => (
          <React.Fragment key={idx}>
            <Polyline
              coordinates={route.path.filter(p => p.latitude != null && p.longitude != null)}
              strokeColor={highlightedRoute === route.route_id ? '#003cffff' : '#1e8fff91'}
              strokeWidth={highlightedRoute === route.route_id ? 4 : 1.5}
            />
            {route.markers
              .filter(m => m.latitude != null && m.longitude != null)
              .map(m => (
                <Marker
                  key={m.name}
                  coordinate={{ latitude: m.latitude, longitude: m.longitude }}
                  title={`${route.name} (${route.date})`}
                  anchor={{ x: 0.38, y: 0.38 }}
                >
                  <View style={{
                    width: highlightedRoute === route.route_id ? 28 : 20,
                    height: highlightedRoute === route.route_id ? 28 : 20,
                    borderRadius: highlightedRoute === route.route_id ? 14 : 10,
                    backgroundColor: m.tipo === 'Porcino' ? '#965123bb' : '#ffd900bb',
                    borderWidth: 1,
                    borderColor: '#000',
                    shadowColor: '#000',
                    shadowOffset: { width: 0, height: 2 },
                    shadowOpacity: 0.8,
                    shadowRadius: 4,
                    elevation: 6,
                  }} />
                </Marker>
              ))}
          </React.Fragment>
        ))}
      </MapView>


      {/* ── HEADER PILL (titolo + indicatore REC) ─────────────────────── */}
      <View style={mStyles.headerPill} pointerEvents="none">
        <Text style={mStyles.headerEmoji}>🍄</Text>
        <Text style={mStyles.headerTitle}>FUNGHI TRACKER</Text>
        {recording && (
          <Animated.View style={[mStyles.recDot, { opacity: recPulse }]} />
        )}
      </View>

      {/* ── OVERLAY LISTA FUNGHI (destra) ─────────────────────────────── */}
      {recording && markers.length > 0 && (
        <View style={mStyles.overlayRight}>
          {/* header overlay */}
          <View style={mStyles.overlayHeader}>
            <Text style={mStyles.overlayLabel}>TROVATI</Text>
            <View style={mStyles.overlayCount}>
              <Text style={mStyles.overlayCountText}>{markers.length}</Text>
            </View>
          </View>

          <ScrollView
            style={{ maxHeight: showAll ? 280 : 130 }}
            showsVerticalScrollIndicator={false}
          >
            {visibleMarkers.map((m: MarkerData) => (
              <View key={m.name} style={mStyles.markerRow}>
                <View style={[
                  mStyles.markerBadge,
                  { backgroundColor: m.tipo === 'Porcino' ? UI.porcino : UI.finferlo }
                ]}>
                  <Text style={mStyles.markerBadgeLetter}>
                    {m.tipo === 'Porcino' ? 'P' : 'F'}
                  </Text>
                </View>
                <Text style={mStyles.markerName} numberOfLines={1}>{m.name}</Text>
                <TouchableOpacity
                  onPress={() => handleDeleteMarker(m)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Trash2 size={14} color={UI.redBri} />
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>

          {markers.length > 5 && (
            <TouchableOpacity onPress={() => setShowAll(!showAll)} style={mStyles.showMoreBtn}>
              <Text style={mStyles.showMoreText}>
                {showAll ? '▲ MENO' : `▼ TUTTI (${markers.length})`}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* ── OVERLAY PERCORSI IN MAPPA (sinistra) ─────────────────────── */}
      {routesOnMap.length > 0 && (
        <View style={mStyles.overlayLeft}>
          <View style={mStyles.overlayHeader}>
            <Text style={mStyles.overlayLabel}>IN MAPPA</Text>
            <View style={mStyles.overlayCount}>
              <Text style={mStyles.overlayCountText}>{routesOnMap.length}</Text>
            </View>
          </View>

          <ScrollView style={{ maxHeight: 200 }} showsVerticalScrollIndicator={false}>
            {routesOnMap.map((route: RouteData, idx: number) => (
              <View key={idx} style={mStyles.routeRow}>
                <Animated.View style={{
                  flex: 1,
                  backgroundColor: currentHighlightedRoute.current === route.route_id
                    ? rowBackgroundColor : 'transparent',
                  borderRadius: 4,
                }}>
                  <TouchableOpacity
                    style={mStyles.routeRowTouch}
                    onPress={() => {
                      triggerPulse(route.route_id!);
                      const coordinates = route.path.filter(p => p.latitude && p.longitude);
                      if (coordinates.length === 0 || !mapRef.current) return;
                      const lats = coordinates.map(c => c.latitude);
                      const lons = coordinates.map(c => c.longitude);
                      const minLat = Math.min(...lats), maxLat = Math.max(...lats);
                      const minLon = Math.min(...lons), maxLon = Math.max(...lons);
                      mapRef.current.animateToRegion({
                        latitude: (minLat + maxLat) / 2,
                        longitude: (minLon + maxLon) / 2,
                        latitudeDelta: (maxLat - minLat) * 1.5 || 0.005,
                        longitudeDelta: (maxLon - minLon) * 1.5 || 0.005,
                      }, 1000);
                      highlightRoute(route.route_id!);
                    }}
                  >
                    <View style={mStyles.routeTrackDot} />
                    <Text style={mStyles.routeRowName} numberOfLines={1} ellipsizeMode="tail">
                      {route.name}
                    </Text>
                  </TouchableOpacity>
                </Animated.View>

                <TouchableOpacity
                  onPress={() => {
                    Alert.alert('Conferma rimozione', 'Vuoi rimuovere questa rotta dalla mappa?', [
                      { text: 'Annulla', style: 'cancel' },
                      {
                        text: 'Rimuovi', style: 'destructive',
                        onPress: () => {
                          setAddedRoutes((prev: string[]) => prev.filter(r => r !== route.route_id));
                        },
                      },
                    ]);
                  }}
                  style={{ paddingLeft: 6 }}
                >
                  <Text style={{ color: UI.redBri, fontSize: 16 }}>✕</Text>
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      {/* ── STATS BAR (durante registrazione) ────────────────────────── */}
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

      {/* ── PULSANTE CENTRA MAPPA ─────────────────────────────────────── */}
      <TouchableOpacity
        style={recording? mStyles.centerBtnRecording : mStyles.centerBtn}
        onPress={() => {
          followLocationRef.current = true;
          if (path.length > 0 && mapRef.current) {
            const latest = path[path.length - 1];
            mapRef.current.animateToRegion({
              latitude: latest.latitude,
              longitude: latest.longitude,
              latitudeDelta: 0.001,
              longitudeDelta: 0.001,
            }, 500);
          }
          if (region && mapRef.current) {
            mapRef.current.animateToRegion(region, 500);
          }
        }}
      >
        <Text style={{ fontSize: 18 }}>📍</Text>
      </TouchableOpacity>

      {/* ── CONTROLLI INFERIORI ───────────────────────────────────────── */}
      <View style={mStyles.bottomControls}>
        {/* Pulsanti specie — sempre visibili ma disabilitati se non in rec */}
        <View style={mStyles.speciesRow}>
          <TouchableOpacity
            style={[
              mStyles.speciesBtn,
              mStyles.speciesBtnFinferlo,
              (!recording || path.length < 1) && mStyles.speciesBtnDisabled,
            ]}
            onPress={() => addMarker('Finferlo')}
            disabled={!recording || path.length < 1}
            activeOpacity={0.75}
          >
            <Text style={mStyles.speciesEmoji}>🌼</Text>
            <Text style={[mStyles.speciesBtnText, { color: UI.finferloHi }]}>FINFERLO</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              mStyles.speciesBtn,
              mStyles.speciesBtnPorcino,
              (!recording || path.length < 1) && mStyles.speciesBtnDisabled,
            ]}
            onPress={() => addMarker('Porcino')}
            disabled={!recording || path.length < 1}
            activeOpacity={0.75}
          >
            <Text style={mStyles.speciesEmoji}>🍄</Text>
            <Text style={[mStyles.speciesBtnText, { color: UI.porcinoHi }]}>PORCINO</Text>
          </TouchableOpacity>
        </View>

        {/* Pulsante principale AVVIA/FERMA */}
        <TouchableOpacity
          style={[mStyles.mainBtn, recording ? mStyles.mainBtnStop : mStyles.mainBtnStart]}
          onPress={() => {
            if (recording) {
              Alert.alert(
                "Conferma",
                "Sei sicuro di voler terminare la registrazione?",
                [
                  { text: "Annulla", style: "cancel" },
                  { text: "OK", onPress: stopRecording },
                ],
                { cancelable: true }
              );
            } else {
              startRecording();
            }
          }}
          activeOpacity={0.85}
        >
          <Text style={mStyles.mainBtnIcon}>{recording ? '⏹' : '▶'}</Text>
          <Text style={mStyles.mainBtnText}>
            {recording ? 'FERMA REGISTRAZIONE' : 'AVVIA REGISTRAZIONE'}
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ManageRoutesScreen — LOGICA IDENTICA, solo UI ridisegnata
// ══════════════════════════════════════════════════════════════════════════════
function ManageRoutesScreen(props: any) {
  const { addedRoutes, setAddedRoutes, handleShare, saveVisible, setSaveVisible,
    fileName, setFileName } = props;

  const [routes, setRoutes] = React.useState<any[]>([]);
  const [refreshing, setRefreshing] = React.useState(false);
  const [selectedRoute, setSelectedRoute] = React.useState<any>(null);
  const [modalVisible, setModalVisible] = React.useState(false);

  // fetchAllRoutes (IDENTICO)
  const fetchAllRoutes = React.useCallback(async () => {
    try {
      console.log('Fetching routes from DB...');
      const fetched = await getAllRoutes();
      setRoutes(fetched);
      console.log(`Loaded ${fetched.length} routes`);
    } catch (err) {
      console.error('Errore getAllRoutes:', err);
      setRoutes([]);
    }
  }, []);

  React.useEffect(() => {
    let mounted = true;
    const fetch = async () => {
      try {
        console.log('Fetching routes from DB...');
        const fetched = await getAllRoutes();
        if (!mounted) return;
        setRoutes(fetched);
        console.log(`Loaded ${fetched.length} routes`);
      } catch (err) {
        console.error('Errore getAllRoutes:', err);
        if (mounted) setRoutes([]);
      }
    };
    void fetch();
    return () => { mounted = false; };
  }, [fetchAllRoutes]);

  // toggleRoute (IDENTICO)
  const toggleRoute = (route_id: string) => {
    if (addedRoutes.includes(route_id)) {
      setAddedRoutes((prev: string[]) => prev.filter((r: string) => r !== route_id));
    } else {
      setAddedRoutes((prev: string[]) => [...prev, route_id]);
    }
  };

  // handleDelete (IDENTICO)
  const handleDelete = async () => {
    if (!selectedRoute) return;
    Alert.alert(
      'Conferma eliminazione',
      `Vuoi eliminare il percorso "${selectedRoute.name}"?`,
      [
        { text: 'Annulla', style: 'cancel' },
        {
          text: 'Elimina',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteRoute(selectedRoute.route_id);
              console.log(`Route ${selectedRoute.route_id} eliminata`);
              setModalVisible(false);
              await fetchAllRoutes();
            } catch (err) {
              console.error('Errore deleteRoute:', err);
            }
          }
        }
      ]
    );
  };

  // Formatta data ISO in formato leggibile
  const formatDate = (isoDate: string) => {
    try {
      const d = new Date(isoDate);
      return d.toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch { return isoDate; }
  };

  return (
    <SafeAreaView style={aStyles.root}>
      <StatusBar barStyle="light-content" backgroundColor={UI.bg0} />

      {/* Header */}
      <View style={aStyles.header}>
        <Text style={aStyles.headerTitle}>ARCHIVIO</Text>
        <Text style={aStyles.headerSub}>{routes.length} percors{routes.length !== 1 ? 'i' : 'o'} salvat{routes.length !== 1 ? 'i' : 'o'}</Text>
      </View>

      {/* Lista percorsi */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={aStyles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              console.log('Aggiorno la lista dei percorsi salvati...');
              await fetchAllRoutes();
              setRefreshing(false);
            }}
            tintColor={UI.greenBri}
            colors={[UI.greenBri]}
          />
        }
      >
        {routes.length === 0 && (
          <View style={aStyles.emptyState}>
            <Text style={aStyles.emptyEmoji}>🌲</Text>
            <Text style={aStyles.emptyTitle}>Nessun percorso salvato</Text>
            <Text style={aStyles.emptySub}>
              Registra la tua prima uscita{'\n'}dalla schermata Mappa
            </Text>
          </View>
        )}

        {routes.map((r: any) => {
          const isAdded = addedRoutes.includes(r.route_id);
          return (
            <View key={r.route_id} style={aStyles.card}>
              {/* Toggle mappa */}
              <TouchableOpacity
                onPress={() => toggleRoute(r.route_id)}
                style={[aStyles.toggleBtn, isAdded && aStyles.toggleBtnActive]}
                activeOpacity={0.8}
              >
                <Text style={aStyles.toggleIcon}>{isAdded ? '−' : '+'}</Text>
              </TouchableOpacity>

              {/* Info percorso */}
              <View style={aStyles.cardInfo}>
                <Text style={aStyles.cardName} numberOfLines={1}>{r.name}</Text>
                <Text style={aStyles.cardDate}>{formatDate(r.date)}</Text>
              </View>

              {/* Menu tre puntini */}
              <TouchableOpacity
                onPress={() => { setSelectedRoute(r); setModalVisible(true); }}
                style={aStyles.menuBtn}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={aStyles.menuDots}>⋮</Text>
              </TouchableOpacity>
            </View>
          );
        })}
      </ScrollView>

      {/* Modal opzioni percorso */}
      <Modal
        visible={modalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setModalVisible(false)}
      >
        <TouchableOpacity
          style={aStyles.modalBackdrop}
          activeOpacity={1}
          onPressOut={() => setModalVisible(false)}
        >
          <View style={aStyles.modalCard}>
            {/* Nome percorso */}
            <Text style={aStyles.modalTitle}>{selectedRoute?.name}</Text>
            <Text style={aStyles.modalDate}>{selectedRoute ? formatDate(selectedRoute.date) : ''}</Text>
            <View style={aStyles.modalDivider} />

            <TouchableOpacity
              style={aStyles.modalAction}
              onPress={() => {
                if (addedRoutes.includes(selectedRoute?.route_id)) {
                  toggleRoute(selectedRoute?.route_id);
                }
                handleShare(selectedRoute.route_id);
              }}
            >
              <Text style={aStyles.modalActionIcon}>📤</Text>
              <Text style={aStyles.modalActionText}>Esporta GPX</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={aStyles.modalAction}
              onPress={() => {
                if (addedRoutes.includes(selectedRoute?.route_id)) {
                  toggleRoute(selectedRoute?.route_id);
                }
                handleDelete();
              }}
            >
              <Text style={aStyles.modalActionIcon}>🗑️</Text>
              <Text style={[aStyles.modalActionText, { color: UI.redBri }]}>
                Elimina da archivio
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[aStyles.modalAction, { borderBottomWidth: 0 }]}
              onPress={() => setModalVisible(false)}
            >
              <Text style={[aStyles.modalActionText, { color: UI.textSec }]}>Annulla</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Modal nome GPX (IDENTICO nella logica) */}
      <Modal visible={saveVisible} transparent animationType="slide">
        <View style={aStyles.modalBackdrop}>
          <View style={aStyles.modalCard}>
            <Text style={aStyles.modalTitle}>Nome file GPX</Text>
            <TextInput
              style={aStyles.textInput}
              value={fileName}
              onChangeText={setFileName}
              placeholder="Nome file"
              placeholderTextColor={UI.textMut}
              autoFocus
            />
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

// ── MainUI styles ─────────────────────────────────────────────────────────────
const mStyles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: UI.bg0,
  },

  // Header pill centrato
  headerPill: {
    position: 'absolute',
    top: 48,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(10,17,11,0.88)',
    borderWidth: 1,
    borderColor: UI.border,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 24,
  },
  headerEmoji: { fontSize: 16 },
  headerTitle: {
    color: UI.textPri,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 2.5,
  },
  recDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: UI.redBri,
    marginLeft: 4,
  },

  // Overlay comune
  overlayRight: {
    position: 'absolute',
    top: 110,
    right: 8,
    backgroundColor: 'rgba(10,17,11,0.92)',
    borderWidth: 1,
    borderColor: UI.border,
    borderRadius: 12,
    padding: 10,
    width: 168,
  },
  overlayLeft: {
    position: 'absolute',
    top: 110,
    left: 8,
    backgroundColor: 'rgba(10,17,11,0.92)',
    borderWidth: 1,
    borderColor: UI.border,
    borderRadius: 12,
    padding: 10,
    width: 176,
  },
  overlayHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  overlayLabel: {
    color: UI.textMut,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 2,
  },
  overlayCount: {
    backgroundColor: UI.greenDim,
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  overlayCountText: {
    color: UI.greenBri,
    fontSize: 10,
    fontWeight: '700',
  },

  // Riga marker
  markerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginBottom: 6,
  },
  markerBadge: {
    width: 20,
    height: 20,
    borderRadius: 4,
    justifyContent: 'center',
    alignItems: 'center',
  },
  markerBadgeLetter: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '900',
  },
  markerName: {
    flex: 1,
    color: UI.textPri,
    fontSize: 11,
    fontWeight: '500',
  },
  showMoreBtn: {
    marginTop: 6,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: UI.border,
    alignItems: 'center',
  },
  showMoreText: {
    color: UI.greenBri,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
  },

  // Riga percorso nell'overlay
  routeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  routeRowTouch: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 3,
    gap: 8,
  },
  routeTrackDot: {
    width: 14,
    height: 3,
    borderRadius: 2,
    backgroundColor: '#1e8fff',
  },
  routeRowName: {
    flex: 1,
    color: UI.textPri,
    fontSize: 11,
    fontWeight: '500',
  },

  // Stats bar
  statsBar: {
    position: 'absolute',
    bottom: 138,
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(10,17,11,0.50)',
    borderWidth: 1,
    borderColor: UI.border,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 8,
  },
  statItem: {
    flex: 1,
    alignItems: 'center',
  },
  statValue: {
    color: UI.textPri,
    fontSize: 20,
    fontWeight: '800',
    lineHeight: 24,
  },
  statLabel: {
    color: UI.textMut,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.5,
    marginTop: 1,
  },
  statDivider: {
    width: 1,
    height: 28,
    backgroundColor: UI.border,
  },

  // Pulsante centra mappa
  centerBtn: {
    position: 'absolute',
    bottom: 146,
    left: 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(10,17,11,0.90)',
    borderWidth: 1,
    borderColor: UI.border,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Pulsante centra mappa durante registrazione (posizione diversa)
  centerBtnRecording: {
    position: 'absolute',
    bottom: 206,
    left: 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(10,17,11,0.90)',
    borderWidth: 1,
    borderColor: UI.border,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Bottom controls container
  bottomControls: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 12,
    paddingBottom: 16,
    paddingTop: 8,
    gap: 8,
  },

  // Riga specie
  speciesRow: {
    flexDirection: 'row',
    gap: 8,
  },
  speciesBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 11,
    borderRadius: 10,
    borderWidth: 1.5,
    backgroundColor: 'rgba(10,17,11,0.92)',
  },
  speciesBtnFinferlo: {
    borderColor: UI.finferlo,
  },
  speciesBtnPorcino: {
    borderColor: UI.porcino,
  },
  speciesBtnDisabled: {
    opacity: 0.35,
  },
  speciesEmoji: { fontSize: 15 },
  speciesBtnText: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
  },

  // Pulsante principale
  mainBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 16,
    borderRadius: 12,
    borderWidth: 1.5,
  },
  mainBtnStart: {
    backgroundColor: UI.greenDim,
    borderColor: UI.greenBri,
  },
  mainBtnStop: {
    backgroundColor: '#2a0a0a',
    borderColor: UI.redBri,
  },
  mainBtnIcon: {
    fontSize: 16,
    color: '#fff',
  },
  mainBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 2,
  },

  // Marker dot sulla mappa
  markerDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: '#000',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.8,
    shadowRadius: 4,
    elevation: 6,
  },
});

// ── ManageRoutesScreen styles ──────────────────────────────────────────────────
const aStyles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: UI.bg0,
  },

  // Header sezione archivio
  header: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: UI.border,
  },
  headerTitle: {
    color: UI.textPri,
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: 5,
  },
  headerSub: {
    color: UI.textMut,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.5,
    marginTop: 2,
  },

  // Lista
  listContent: {
    padding: 12,
    paddingBottom: 24,
    gap: 8,
  },

  // Empty state
  emptyState: {
    alignItems: 'center',
    paddingTop: 80,
    gap: 10,
  },
  emptyEmoji: { fontSize: 52 },
  emptyTitle: {
    color: UI.textPri,
    fontSize: 18,
    fontWeight: '700',
  },
  emptySub: {
    color: UI.textMut,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 20,
  },

  // Card percorso
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: UI.bg2,
    borderWidth: 1,
    borderColor: UI.border,
    borderRadius: 12,
    padding: 12,
    gap: 12,
  },

  // Toggle mappa (+/-)
  toggleBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: UI.bg3,
    borderWidth: 1.5,
    borderColor: UI.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  toggleBtnActive: {
    backgroundColor: UI.greenDim,
    borderColor: UI.greenBri,
  },
  toggleIcon: {
    color: UI.textPri,
    fontSize: 20,
    fontWeight: '700',
    lineHeight: 24,
  },

  // Info card
  cardInfo: { flex: 1 },
  cardName: {
    color: UI.textPri,
    fontSize: 15,
    fontWeight: '700',
  },
  cardDate: {
    color: UI.textMut,
    fontSize: 12,
    marginTop: 2,
  },

  // Menu tre puntini
  menuBtn: { paddingHorizontal: 4 },
  menuDots: {
    color: UI.textSec,
    fontSize: 22,
    fontWeight: '900',
    lineHeight: 26,
  },

  // Modal backdrop
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },

  // Modal card
  modalCard: {
    backgroundColor: UI.bg2,
    borderWidth: 1,
    borderColor: UI.border,
    borderRadius: 16,
    padding: 20,
    width: '100%',
    maxWidth: 360,
  },
  modalTitle: {
    color: UI.textPri,
    fontSize: 17,
    fontWeight: '800',
    marginBottom: 4,
  },
  modalDate: {
    color: UI.textMut,
    fontSize: 12,
    marginBottom: 4,
  },
  modalDivider: {
    height: 1,
    backgroundColor: UI.border,
    marginVertical: 12,
  },
  modalAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: UI.border,
  },
  modalActionIcon: { fontSize: 18 },
  modalActionText: {
    color: UI.textPri,
    fontSize: 16,
    fontWeight: '600',
  },

  // Input GPX
  textInput: {
    backgroundColor: UI.bg3,
    borderWidth: 1,
    borderColor: UI.border,
    borderRadius: 8,
    padding: 12,
    color: UI.textPri,
    fontSize: 15,
    marginVertical: 12,
  },
});
