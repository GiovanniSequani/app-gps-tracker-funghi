// App.tsx — versione corretta per background tracking (Android)
// Note: richiede `expo install expo-task-manager expo-location expo-file-system expo-sharing`

import React from 'react';
import {
  StyleSheet, Text, View, Button, useColorScheme, Alert, TextInput, Modal, Linking,
  TouchableOpacity, Animated, StatusBar, Platform, AppState, AppStateStatus
} from 'react-native';
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

  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  const titlePosition = React.useRef(new Animated.Value(0)).current;
  const buttonsPosition = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    Animated.timing(titlePosition, {
      toValue: recording ? -270 : 0,
      duration: 500,
      useNativeDriver: true,
    }).start();

    Animated.timing(buttonsPosition, {
      toValue: recording ? 225 : 0,
      duration: 500,
      useNativeDriver: true,
    }).start();
  }, [recording]);

  const locationSubscription = React.useRef<Location.LocationSubscription | null>(null);

  // Carica posizioni raccolte in background (file)
  const loadBackgroundPositions = React.useCallback(async () => {
    try {
      const exists = await FileSystemLegacy.getInfoAsync(BG_POSITIONS_FILE);
      if (!exists.exists) return;

      const raw = await FileSystemLegacy.readAsStringAsync(BG_POSITIONS_FILE);
      const arr = JSON.parse(raw || "[]") as Coordinate[];

      if (arr.length > 0) {
        setPath(prev => [...prev, ...arr]);
        await FileSystemLegacy.deleteAsync(BG_POSITIONS_FILE, { idempotent: true });
      }
    } catch (err) {
      console.warn("loadBackgroundPositions error", err);
    }
  }, []);


  // Ricarica posizioni quando l'app torna in foreground
  React.useEffect(() => {
    loadBackgroundPositions(); // all'avvio
    const sub = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      if (nextState === 'active') {
        loadBackgroundPositions();
      }
    });
    return () => sub.remove();
  }, [loadBackgroundPositions]);

  // START RECORDING
  const startRecording = async () => {
      const ok = await checkAndOpenSettingsIfNeeded();
      if (!ok) return;

    // safety: rimuovi eventuale subscription precedente
    if (locationSubscription.current) {
      try { locationSubscription.current.remove(); } catch (e) { /* ignore */ }
      locationSubscription.current = null;
    }

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
      // prosegui comunque: avrai tracking in foreground ma non in background
    }

    setRecording(true);
    setPath([]);
    setMarkers([]);

    // avvia il background location updates se non è già partito
    const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
    if (!started) {
      await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
        accuracy: Location.Accuracy.High,
        timeInterval: 5000,
        distanceInterval: 1,
        showsBackgroundLocationIndicator: true,
        foregroundService: {
          notificationTitle: "GPS attivo",
          notificationBody: "L'app sta registrando la tua posizione",
        },
      });
    }

    // avvia watcher foreground per aggiornare lo state UI immediatamente
    try {
      locationSubscription.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 },
        (loc) => {
          const ts = typeof loc.timestamp === 'number' ? loc.timestamp : Date.now();
          setPath(prev => [...prev, {
            latitude: loc.coords.latitude,
            longitude: loc.coords.longitude,
            timestamp: ts,
          }]);
        }
      );
    } catch (err) {
      console.warn("watchPositionAsync error", err);
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

    // rimuovi subscription foreground
    if (locationSubscription.current) {
      try { locationSubscription.current.remove(); } catch (e) { /* ignore */ }
      locationSubscription.current = null;
    }

    // se il task ha scritto posizioni in background, caricale ora
    await loadBackgroundPositions();

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
  const addMarker = () => {
    if (path.length > 0) {
      setMarkers((prev) => [...prev, path[path.length - 1]]);
    }
  };

  // --- la funzione generateGPX e saveAndShareGPX le lascio come le avevi, con piccole aggiunte per compatibilità ---
  const generateGPX = (path: Coordinate[], markers: Coordinate[]): string => {
    const header = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GPS Tracker App">
<trk><name>Percorso</name><trkseg>`;
    const trackPoints = path.map((pt) => {
      const time = new Date(pt.timestamp).toISOString();
      return `<trkpt lat="${pt.latitude}" lon="${pt.longitude}"><time>${time}</time></trkpt>`;
    }).join('\n');
    const footer = `</trkseg></trk>`;
    const waypoints = markers.map((m, i) => `<wpt lat="${m.latitude}" lon="${m.longitude}"><name>Segnaposto ${i+1}</name></wpt>`).join('\n');
    return `${header}\n${trackPoints}\n${footer}\n${waypoints}\n</gpx>`;
  };

  const saveAndShareGPX = async () => {
    try {
      const gpxData = generateGPX(path, markers);
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
        titlePosition={titlePosition}
        buttonsPosition={buttonsPosition}
      />
    </SafeAreaProvider>
  );
}

function MainUI(props: any) {
  const {
    recording, startRecording, stopRecording, addMarker,
    path, markers, modalVisible, setModalVisible,
    fileName, setFileName, saveAndShareGPX, isDark,
    titlePosition, buttonsPosition,
  } = props;

  const backgroundColor = isDark ? '#121212' : '#ffffff';
  const titleColor = isDark ? '#ffffff' : '#000000';

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor }]}>
      <StatusBar
        barStyle={isDark ? 'light-content' : 'dark-content'}
        backgroundColor={backgroundColor}
      />
      <View style={styles.container}>
        <Animated.Text style={[styles.title, { transform: [{ translateY: titlePosition }], color: titleColor }]}>
          GPS Tracker
        </Animated.Text>

        <Animated.View style={{ transform: [{ translateY: buttonsPosition }] }}>
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

        {recording && (
          <View style={[styles.stats]}>
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
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  title: { fontSize: 30, fontWeight: 'bold', marginBottom: 20, marginTop: 10 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  modalContent: { backgroundColor: 'white', padding: 20, borderRadius: 10, width: '80%' },
  input: { borderWidth: 1, borderColor: '#ccc', padding: 10, marginVertical: 10, borderRadius: 5 },
  bigButton: { width: 250, paddingVertical: 15, borderRadius: 10, marginVertical: 10, alignItems: 'center', backgroundColor: '#4CAF50' },
  startButton: { backgroundColor: '#4CAF50' },
  stopButton: { backgroundColor: '#F44336' },
  markerButton: { backgroundColor: '#2196F3' },
  buttonText: { color: 'white', fontSize: 18, fontWeight: 'bold' },
  stats: { position: 'absolute', bottom: 10, alignItems: 'center' },
});
