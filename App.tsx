// App.tsx — versione corretta per background tracking (Android)
// Note: richiede `expo install expo-task-manager expo-location expo-file-system expo-sharing`

import React from 'react';
import {
  StyleSheet, Text, View, Button, useColorScheme, Alert, TextInput, Modal, Linking,
  TouchableOpacity, Animated, StatusBar, Platform
} from 'react-native';
import MapView, { Region, Circle, Polyline, Marker } from 'react-native-maps';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { File, Paths } from "expo-file-system";
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

type Coordinate = {
  latitude: number;
  longitude: number;
  timestamp: number;
};


const LOCATION_TASK_NAME = "background-location-task";
const BG_POSITIONS_FILE = `${FileSystemLegacy.cacheDirectory}bg_positions.json`;

/**
 * Background task: viene eseguito in un contesto separato.
 * Qui salviamo le posizioni su un file JSON nella cache.
 */
TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.error("Errore task location:", error);
    return;
  }

  if (data) {
    console.log("LOCATION TASK DATA:", JSON.stringify(data));

    try {
      const { locations } = data as any;

      // leggi file esistente (se presente)
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

      // aggiungi le nuove posizioni
      (locations as any[]).forEach((loc) => {
        const ts = typeof loc.timestamp === "number" ? loc.timestamp : Date.now();
        arr.push({
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
          timestamp: ts,
        });
      });

      // scrivi indietro
      await FileSystemLegacy.writeAsStringAsync(
        BG_POSITIONS_FILE,
        JSON.stringify(arr)
      );

      //console.log("BACKGROUND FILE:", JSON.stringify(arr));

    } catch (err) {
      console.error("Errore scrittura file bg positions:", err);
    }
  }
});


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
        {
          text: 'Sì',
          onPress: () => Linking.openSettings(), // apre il pannello permessi dell'app
        },
      ]
    );
    return false;
  }
  return true;
};



export default function App() {
  const [recording, setRecording] = React.useState(false);
  const [path, setPath] = React.useState<Coordinate[]>([]);
  const [markers, setMarkers] = React.useState<Coordinate[]>([]);
  const [modalVisible, setModalVisible] = React.useState(false);
  const [fileName, setFileName] = React.useState('percorso');
  const [region, setRegion] = React.useState<Region | null>(null);

  const followLocationRef = React.useRef(true);
  const mapRef = React.useRef<MapView>(null);
  const recordingRef = React.useRef(recording);
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

    React.useEffect(() => {
      recordingRef.current = recording;
    }, [recording]);

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

      // facoltativo: centra la mappa
      mapRef.current?.animateToRegion(initialRegion, 1000);
    })();
  }, []);


  // Sincronizza il path leggendo il file di posizioni in background
  const syncPathFromFile = React.useCallback(async (consume = false): Promise<Coordinate[]> => {
    try {
      const info = await FileSystemLegacy.getInfoAsync(BG_POSITIONS_FILE);
      if (!info.exists) {
        return path;
      }

      const raw = await FileSystemLegacy.readAsStringAsync(BG_POSITIONS_FILE);
      const arr = JSON.parse(raw || "[]") as Coordinate[];
      if (!Array.isArray(arr) || arr.length === 0) {
        return path;
      }

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



  // Polling per aggiornare il path con eventuali posizioni salvate in background
  React.useEffect(() => {
    let mounted = true;

    const tick = async () => {
      try {
        // non eseguire se il componente è stato smontato
        if (!mounted) return;
        const currpath = await syncPathFromFile(false); // aggiorna lo state internamente
        // centra la mappa sull'ultimo punto
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

    // esegui subito una volta
    void tick();

    const id = setInterval(() => {
      void tick();
    }, 500);

    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [syncPathFromFile]);



  // START RECORDING
  const startRecording = async () => {
      const ok = await checkAndOpenSettingsIfNeeded();
      if (!ok) return;


    // chiedi permessi foreground
    const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
    if (fgStatus !== 'granted') {
      Alert.alert('Permesso GPS negato!');
      return;
    }

    // chiedi permessi background (utile su Android per tracking in standby)
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

    // avvia il background location updates se non è già partito
    const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
    if (!started) {
      await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: 5000,
        distanceInterval: 1,
        showsBackgroundLocationIndicator: true,
        foregroundService: {
          notificationTitle: "GPS attivo",
          notificationBody: "L'app sta registrando la tua posizione",
        },
      });
    }
  };



  // STOP RECORDING
  const stopRecording = async () => {
    setRecording(false);

    try {
      const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
      if (started) {
        await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
      }
    } catch (err) {
      console.warn("Errore stop location updates:", err);
    }

    Alert.alert(
      'Salvare GPX?',
      'Vuoi salvare il percorso registrato come file GPX?',
      [
        { text: 'No', style: 'cancel' },
        { text: 'Sì', onPress: () => setModalVisible(true) },
      ]
    );
  };


  // ADD MARKER
  const addMarker = React.useCallback(async () => {
    try {
      // sync path
      const updated = await syncPathFromFile(false);
      const last = (updated && updated.length) ? updated[updated.length - 1]
                : (path.length ? path[path.length - 1] : undefined);
      if (last) {
        setMarkers((prev) => [...prev, last]);
      } else {
        Alert.alert('Nessuna posizione disponibile', 'Non ci sono ancora posizioni registrate per aggiungere un segnaposto.');
      }
    } catch (e) {
      console.warn('addMarker error', e);
      Alert.alert('Errore', 'Impossibile aggiungere il segnaposto.');
    }
  }, [syncPathFromFile, path]);


  // GENERATE GPX
  const generateGPX = (path: Coordinate[], markers: Coordinate[]): string => {
    const header = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Funghi Tracker">
<trk><name>Percorso</name><trkseg>`;
    const trackPoints = path.map((pt) => {
      const time = new Date(pt.timestamp).toISOString();
      return `<trkpt lat="${pt.latitude}" lon="${pt.longitude}"><time>${time}</time></trkpt>`;
    }).join('\n');
    const footer = `</trkseg></trk>`;
    const waypoints = markers.map((m, i) => `<wpt lat="${m.latitude}" lon="${m.longitude}"><name>Segnaposto ${i+1}</name></wpt>`).join('\n');
    return `${header}\n${trackPoints}\n${footer}\n${waypoints}\n</gpx>`;
  };


  // SAVE AND SHARE GPX
  const saveAndShareGPX = async () => {
    try {
      // aggiorna path con i punti scritti in background (ma non consumare file qui)
      const updatedPath = await syncPathFromFile(true) ?? path;

      console.log("updatedPath completo:", updatedPath);
      console.log("updatedPath length:", updatedPath.length);
      console.log(updatedPath.map(p => p.timestamp));
      
      const gpxData = generateGPX(updatedPath, markers);
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
      console.error('saveAndShareGPX errore', error);
      Alert.alert('Errore durante il salvataggio o condivisione', error?.message ?? String(error));
    } finally {
      setModalVisible(false);
      setFileName('percorso');
    }
  };



  return (
    <SafeAreaProvider>
      <MainUI
        recording={recording}
        startRecording={startRecording}
        stopRecording={stopRecording}
        addMarker={addMarker}
        path={path}
        markers={markers}
        modalVisible={modalVisible}
        setModalVisible={setModalVisible}
        fileName={fileName}
        setFileName={setFileName}
        saveAndShareGPX={saveAndShareGPX}
        isDark={isDark}
        mapRef={mapRef}
        region={region}
        followLocationRef={followLocationRef}
      />
    </SafeAreaProvider>
  );
}


function MainUI(props: any) {
  const {
    recording, startRecording, stopRecording, addMarker,
    path, markers, modalVisible, setModalVisible,
    fileName, setFileName, saveAndShareGPX, isDark, 
    mapRef, region, followLocationRef
  } = props;

  const backgroundColor = isDark ? '#121212' : '#ffffff';

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor }]}>
      <StatusBar
        barStyle={isDark ? 'light-content' : 'dark-content'}
        backgroundColor={backgroundColor}
      />
      
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFillObject}
        initialRegion={region ?? undefined}
        mapType="satellite"
        onPanDrag={() => { followLocationRef.current = false; }} 
      >
        {/* Current position IF PATH < 1*/}
        {(path.length < 1 && region) && (
          <Circle
            center={{'latitude' : region.latitude, 'longitude' : region.longitude}}
            radius={2} // metres
            fillColor="rgba(25, 136, 255, 0.8)" // light blue
            strokeColor="rgba(0, 102, 211, 1)"  // blue
            strokeWidth={2}
          />
        )}
        {/* Current position IF PATH >= 1*/}
        {path.length > 0 && (
          <Circle
            center={path[path.length - 1]}
            radius={2} // metres
            fillColor="rgba(25, 136, 255, 0.8)" // light blue
            strokeColor="rgba(0, 102, 211, 1)"  // blue
            strokeWidth={2}
          />
        )}

        {/* Path polyline */}
        {(path.length > 1 && recording) && (
          <Polyline
            coordinates={path}
            strokeColor="#1E90FF"
            strokeWidth={3}
          />
        )}
      </MapView>

      <View style={styles.titleContainer}>
        <Text style={styles.title}>GPS Tracker</Text>
      </View>

      <Animated.View style={[
        {
          position: 'absolute',
          bottom: 50,    // distanza dal fondo
          left: 0,
          right: 0,
          alignItems: 'center',
        },
      ]}>
        <TouchableOpacity
          style={[styles.bigButton, recording ? styles.stopButton : styles.startButton]}
          onPress={recording ? stopRecording : startRecording}
        >
          <Text style={styles.buttonText}>{recording ? 'Termina Registrazione' : 'Inizia Registrazione'}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.bigButton, styles.markerButton, !recording && { opacity: 0.5 }]}
          onPress={addMarker}
          disabled={!recording}
        >
          <Text style={styles.buttonText}>Aggiungi Segnaposto</Text>
        </TouchableOpacity>
      </Animated.View>

      <TouchableOpacity
        style={styles.centerButton}
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
        }}
      >
        <Text style={{color: 'white'}}>📍</Text>
      </TouchableOpacity>

      {recording && (
        <View style={[
          styles.stats,
          {
            position: 'absolute',
            bottom: 10,    // distanza dal fondo
            left: 0,
            right: 0,
            alignItems: 'center',
          }]}>
          <Text style={{ color: isDark ? '#ffffff' : '#000000' }}>Coordinate registrate: {path.length}</Text>
          <Text style={{ color: isDark ? '#ffffff' : '#000000' }}>Segnaposti: {markers.length}</Text>
        </View>
      )}

      <Modal visible={modalVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text>Inserisci nome file GPX:</Text>
            <TextInput
              style={styles.input}
              value={fileName}
              onChangeText={setFileName}
              placeholder="Nome file"
              autoFocus
            />
            <Button title="Salva e Condividi" onPress={saveAndShareGPX} />
            <Button title="Annulla" onPress={() => setModalVisible(false)} />
          </View>
        </View>
      </Modal>
      {/*</View>*/}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  
  titleContainer: { 
    position: "absolute", top: 45, alignSelf: "center", backgroundColor: "rgba(0,0,0,0.5)", paddingHorizontal: 16,
    paddingVertical: 8, borderRadius: 8, alignItems: "center", justifyContent: "center",},
  title: {
    fontSize: 28, fontWeight: 'bold', borderRadius: 10, alignSelf: 'center',
    // ombra iOS:
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 3,
  },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  modalContent: { backgroundColor: 'white', padding: 20, borderRadius: 10, width: '80%' },
  input: { borderWidth: 1, borderColor: '#ccc', padding: 10, marginVertical: 10, borderRadius: 5 },
  bigButton: { width: 250, paddingVertical: 15, borderRadius: 10, marginVertical: 8, alignItems: 'center', backgroundColor: '#4CAF50' },
  startButton: { backgroundColor: '#4CAF50' },
  stopButton: { backgroundColor: '#F44336' },
  markerButton: { backgroundColor: '#2196F3' },
  buttonText: { color: 'white', fontSize: 18, fontWeight: 'bold' },
  stats: { position: 'absolute', bottom: 10, alignItems: 'center' },
  centerButton: {
    position: 'absolute', bottom: 20, right: 20, width: 50, height: 50, borderRadius: 25, 
    backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center',
},
});
