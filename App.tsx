import React from 'react';
import { StyleSheet, Text, View, Button, useColorScheme, Alert, TextInput, Modal, TouchableOpacity, Animated, StatusBar, Platform } from 'react-native';
import * as Location from 'expo-location';
import Constants from 'expo-constants';
import { File, Paths } from "expo-file-system";
import * as FileSystemLegacy from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';


type Coordinate = {
  latitude: number;
  longitude: number;
  timestamp: number;
};

export default function App() {
  const [recording, setRecording] = React.useState(false);
  const [path, setPath] = React.useState<Coordinate[]>([]);
  const [markers, setMarkers] = React.useState<Coordinate[]>([]);
  const [modalVisible, setModalVisible] = React.useState(false);
  const [fileName, setFileName] = React.useState('percorso');

  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  // animazioni
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

  // subscription ref
  const locationSubscription = React.useRef<Location.LocationSubscription | null>(null);

  // START RECORDING
  const startRecording = async () => {
    // se c'è una subscription precedente, la rimuovo (safety)
    if (locationSubscription.current) {
      try {
        locationSubscription.current.remove();
      } catch (e) {
        // ignore
      }
      locationSubscription.current = null;
    }

    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permesso GPS negato!');
      return;
    }

    setRecording(true);
    setPath([]);
    setMarkers([]);

    locationSubscription.current = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, timeInterval: 1000, distanceInterval: 0 },
      (loc) => {
        // protezioni: se manca timestamp, usa Date.now()
        const ts = typeof loc.timestamp === 'number' ? loc.timestamp : Date.now();
        // log per debug
        // console.log('nuova posizione', loc.coords.latitude, loc.coords.longitude, 'TIME:', ts);
        setPath((prev) => [...prev, {
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
          timestamp: ts,
        }]);
      }
    );
  };

  // STOP RECORDING
  const stopRecording = () => {
    setRecording(false);
    if (locationSubscription.current) {
      try {
        locationSubscription.current.remove();
      } catch (e) {
        // ignore
      }
      locationSubscription.current = null;
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
  const addMarker = () => {
    if (path.length > 0) {
      setMarkers((prev) => [...prev, path[path.length - 1]]);
    }
  };

  // GENERATE GPX
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

  // SAVE AND SHARE GPX (usa expo-file-system stabile)
  const saveAndShareGPX = async () => {
    try {
      const gpxData = generateGPX(path, markers);

      // --- 1) Nuova API: File + Paths.cache ---
      let uri: string | undefined;

      try {
        const safeFileName = fileName?.trim() || `percorso_${Date.now()}`;
        const file = new File(Paths.cache, safeFileName + '.gpx');

        try { file.create(); } catch (errCreate) {
          console.warn('[debug] file.create() errore (ignoro):', errCreate);
        }

        try { await (file.write(gpxData) as Promise<void> | void); } catch (errWrite) {
          console.warn('[debug] file.write() errore (ignoro):', errWrite);
        }

        // prova a ottenere URI
        // @ts-ignore
        uri = file.uri ?? (file.getUri ? await file.getUri() : undefined);

        if (uri) {
          console.log('[debug] Nuova API URI:', uri);
        }
      } catch (errNewAPI) {
        console.warn('[debug] nuova API fallita:', errNewAPI);
        uri = undefined;
      }

      // --- 2) fallback legacy ---
      if (!uri) {
        console.log('[debug] Fallback legacy');
        const safeFileName = fileName?.trim() || `percorso_${Date.now()}`;
        const legacyUri = FileSystemLegacy.cacheDirectory + safeFileName + '.gpx';
        await FileSystemLegacy.writeAsStringAsync(legacyUri, gpxData, { encoding: 'utf8' });
        uri = legacyUri;
      }

      // --- 3) Condivisione ---
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


  const saveAndShareGPX_debug = async () => {
    // genera GPX come fai tu
    const gpxData = generateGPX(path, markers);

    // raccolta debug
    const debugLines: string[] = [];
    const push = (k: string, v: any) =>
      debugLines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

    try {
      push('Platform.OS', Platform.OS);
      push('Constants.appOwnership', (Constants as any).appOwnership ?? 'undefined');
      push('FileSystem module typeof', typeof FileSystem);
      push('FileSystem.documentDirectory (raw)', String(FileSystem.documentDirectory));
      push('FileSystem.cacheDirectory (raw)', String(FileSystem.cacheDirectory));

      // getInfoAsync su documentDirectory e cacheDirectory se non null
      try {
        const doc = FileSystem.documentDirectory;
        if (doc) {
          const infoDoc = await FileSystem.getInfoAsync(doc);
          push('getInfoAsync(documentDirectory)', infoDoc);
        } else {
          push('getInfoAsync(documentDirectory)', 'documentDirectory === null/undefined');
        }
      } catch (e) {
        push('getInfoAsync(documentDirectory) error', (e as Error).toString());
      }

      try {
        const cache = FileSystem.cacheDirectory;
        if (cache) {
          const infoCache = await FileSystem.getInfoAsync(cache);
          push('getInfoAsync(cacheDirectory)', infoCache);
        } else {
          push('getInfoAsync(cacheDirectory)', 'cacheDirectory === null/undefined');
        }
      } catch (e) {
        push('getInfoAsync(cacheDirectory) error', (e as Error).toString());
      }

      // is Sharing available?
      try {
        const s = await Sharing.isAvailableAsync();
        push('Sharing.isAvailableAsync()', s);
      } catch (e) {
        push('Sharing.isAvailableAsync() error', (e as Error).toString());
      }

      // Prova a scegliere baseDir con priorità: documentDirectory -> cacheDirectory
      const baseDir = FileSystem.documentDirectory ?? FileSystem.cacheDirectory ?? null;
      push('resolved baseDir', baseDir);

      if (!baseDir) {
        // alert + console con debug completo
        console.log('DEBUG FILESYSTEM:\n' + debugLines.join('\n'));
        Alert.alert('DEBUG: Nessuna directory disponibile', debugLines.join('\n\n'));
        throw new Error('Nessuna directory disponibile per il salvataggio (baseDir null)');
      }

      // Path di test per scrivere: proviamo prima in cache (più permissiva) e poi document
      const safeFileName = fileName?.trim?.() ? fileName.trim() : `percorso_${Date.now()}`;
      const testPath = `${baseDir}${safeFileName}_debug_${Date.now()}.gpx`;
      push('testPath', testPath);

      // prova a scrivere
      try {
        await FileSystem.writeAsStringAsync(testPath, gpxData, {
          encoding: FileSystem.EncodingType.UTF8,
        });
        push('writeAsStringAsync', 'OK');
      } catch (e) {
        push('writeAsStringAsync error', (e as Error).toString());
        console.log('DEBUG FILESYSTEM:\n' + debugLines.join('\n'));
        Alert.alert('Errore writeAsStringAsync', debugLines.join('\n\n'));
        throw e;
      }

      // verifica file info
      try {
        const finfo = await FileSystem.getInfoAsync(testPath);
        push('getInfoAsync(testPath)', finfo);
        // prova a leggere una piccola porzione (readAsStringAsync)
        const read = await FileSystem.readAsStringAsync(testPath);
        push('readAsStringAsync length', read.length);
      } catch (e) {
        push('read/getInfo testPath error', (e as Error).toString());
      }

      // prova a condividere
      try {
        const available = await Sharing.isAvailableAsync();
        push('Sharing.available (again)', available);
        if (available) {
          await Sharing.shareAsync(testPath);
          push('shareAsync', 'invocato OK');
        } else {
          push('shareAsync', 'non disponibile');
        }
      } catch (e) {
        push('shareAsync error', (e as Error).toString());
      }

      // tutto ok: mostra i debug
      console.log('DEBUG FILESYSTEM:\n' + debugLines.join('\n'));
      Alert.alert('DEBUG FILESYSTEM (success)', debugLines.join('\n\n'));
    } catch (err: any) {
      console.error('saveAndShareGPX_debug errore', err);
      // assicurati di mostrare i debug raccolti insieme all'errore
      const msg = debugLines.length ? debugLines.join('\n\n') + '\n\nERR: ' + String(err) : String(err);
      Alert.alert('saveAndShareGPX_debug errore', msg);
    } finally {
      setModalVisible(false);
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

// UI separata per evitare remount quando App si aggiorna
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
  safeArea: {
    flex: 1,
  },
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  title: {
    fontSize: 30,
    fontWeight: 'bold',
    marginBottom: 20,
    marginTop: 10,
  },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  modalContent: { backgroundColor: 'white', padding: 20, borderRadius: 10, width: '80%' },
  input: { borderWidth: 1, borderColor: '#ccc', padding: 10, marginVertical: 10, borderRadius: 5 },
  bigButton: {
    width: 250,
    paddingVertical: 15,
    borderRadius: 10,
    marginVertical: 10,
    alignItems: 'center',
    backgroundColor: '#4CAF50',
  },
  startButton: { backgroundColor: '#4CAF50' },
  stopButton: { backgroundColor: '#F44336' },
  markerButton: { backgroundColor: '#2196F3' },
  buttonText: { color: 'white', fontSize: 18, fontWeight: 'bold' },
  stats: { position: 'absolute', bottom: 10, alignItems: 'center' },
});