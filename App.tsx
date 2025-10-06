// App.tsx — versione corretta per background tracking (Android)
// Note: richiede `expo install expo-task-manager expo-location expo-file-system expo-sharing`

import React from 'react';
import {
  StyleSheet, Text, View, Button, useColorScheme, Alert, TextInput, Modal, Linking,
  TouchableOpacity, Animated, StatusBar, Platform, Image, ScrollView
} from 'react-native';
import MapView, { Region, Polyline, Marker, Circle } from 'react-native-maps';
import { Trash2 } from 'lucide-react-native';
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
type MarkerData = Coordinate & { tipo?: 'Porcino' | 'Finferlo', name?: string };


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
  const [porciniMarkers, setPorciniMarkers] = React.useState<MarkerData[]>([]);
  const [finferliMarkers, setFinferliMarkers] = React.useState<MarkerData[]>([]);
  const [modalVisible, setModalVisible] = React.useState(false);
  const [fileName, setFileName] = React.useState('percorso');
  const [region, setRegion] = React.useState<Region | null>(null);
  const [showAll, setShowAll] = React.useState(false);

  const followLocationRef = React.useRef(true);
  const mapRef = React.useRef<MapView>(null);
  const recordingRef = React.useRef(recording);
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  const allMarkers = React.useMemo(() => {
    return [...porciniMarkers, ...finferliMarkers]
      .sort((a, b) => b.timestamp - a.timestamp);
  }, [porciniMarkers, finferliMarkers]);
  const visibleMarkers = showAll ? allMarkers : allMarkers.slice(0, 5);

  const handleDeleteMarker = (marker: MarkerData) => {
    Alert.alert(
      'Conferma eliminazione',
      `Vuoi eliminare ${marker.name}?`,
      [
        { text: 'Annulla', style: 'cancel' },
        { 
          text: 'Elimina', 
          style: 'destructive',
          onPress: () => {
            if (marker.tipo === 'Porcino') {
              setPorciniMarkers(porciniMarkers.filter(m => m.name !== marker.name ));
            } else {
              setFinferliMarkers(finferliMarkers.filter(m => m.name !== marker.name ));
            }
          }
        }
      ]
    );
  };

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
    setFinferliMarkers([]);
    setPorciniMarkers([]);

    // elimina file background location (se esiste)
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
  const addMarker = React.useCallback(async (tipo: 'Porcino' | 'Finferlo') => {
    try {
      const updated = await syncPathFromFile(false);
      const last = (updated && updated.length) ? updated[updated.length - 1]
                : (path.length ? path[path.length - 1] : undefined);

      if (!last) {
        Alert.alert('Nessuna posizione disponibile', 'Non ci sono ancora posizioni registrate.');
        return;
      }

      if (tipo === 'Porcino') {
        setPorciniMarkers(prev => [...prev, {latitude: last.latitude, longitude: last.longitude, timestamp: Date.now(), tipo: 'Porcino', name: `Porcino_${prev.length + 1}`}]);
      } else {
        setFinferliMarkers(prev => [...prev, {latitude: last.latitude, longitude: last.longitude, timestamp: Date.now(), tipo: 'Finferlo', name: `Finferlo_${prev.length + 1}`}]);
      }
    } catch (e) {
      console.warn('addMarker error', e);
      Alert.alert('Errore', 'Impossibile aggiungere il segnaposto.');
    }
  }, [syncPathFromFile, path]);



  // GENERATE GPX con due liste separate
  const generateGPX = (path: Coordinate[], allMarkers: MarkerData[]): string => {  
    const header = `<?xml version="1.0" encoding="UTF-8"?>
                    <gpx version="1.1" creator="Funghi Tracker">
                    <trk><name>Percorso</name><trkseg>`;

    const trackPoints = path.map((pt) => {
      const time = pt.timestamp ? new Date(pt.timestamp).toISOString() : null;
      return `<trkpt lat="${pt.latitude}" lon="${pt.longitude}">${time ? `<time>${time}</time>` : ''}</trkpt>`;
    }).join('\n');

    const footer = `</trkseg></trk>`;

    const waypoints = allMarkers.map((m) => {
      const time = m.timestamp ? new Date(m.timestamp).toISOString() : null;
      return `<wpt lat="${m.latitude}" lon="${m.longitude}">${time ? `<time>${time}</time>` : ''}
              <name>${m.name}</name></wpt>`;
    }).join('\n');

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
      
      const gpxData = generateGPX(updatedPath, allMarkers);
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
        porciniMarkers={porciniMarkers}
        finferliMarkers={finferliMarkers}
        modalVisible={modalVisible}
        setModalVisible={setModalVisible}
        fileName={fileName}
        setFileName={setFileName}
        saveAndShareGPX={saveAndShareGPX}
        isDark={isDark}
        mapRef={mapRef}
        region={region}
        followLocationRef={followLocationRef}
        showAll = {showAll}
        visibleMarkers = {visibleMarkers}
        handleDeleteMarker = {handleDeleteMarker}
        setShowAll = {setShowAll}
      />
    </SafeAreaProvider>
  );
}


function MainUI(props: any) {
  const {
    recording, startRecording, stopRecording, addMarker,
    path, porciniMarkers, finferliMarkers, modalVisible, setModalVisible,
    fileName, setFileName, saveAndShareGPX, isDark, 
    mapRef, region, followLocationRef, showAll, visibleMarkers,
    handleDeleteMarker, setShowAll
  } = props;

  const backgroundColor = isDark ? '#121212' : '#ffffff';
  const allMarkers: MarkerData[] = [
      ...porciniMarkers, ...finferliMarkers
    ].sort((a, b) => b.timestamp - a.timestamp);

  console.log("allMarkers:", allMarkers);

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor }]}>
      <StatusBar
        barStyle={isDark ? 'light-content' : 'dark-content'}
        backgroundColor={backgroundColor}
      />
      
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFillObject}
        initialRegion={region || {
          latitude: 45.4384,      // default fallback
          longitude: 10.9916,
          latitudeDelta: 0.001,
          longitudeDelta: 0.001,
        }}
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

        {/* Marker Porcino */}
        {recording && porciniMarkers.map((m: MarkerData) => (
          <Marker
            key={m.name}
            coordinate={{ 'latitude': m.latitude, 'longitude': m.longitude }}
            title={m.name}
            anchor={{ x: 0.38, y: 0.38 }}
          >
            <View style={{
              width: 28,
              height: 28,
              borderRadius: 14,
              backgroundColor: '#965123ff', // ARANCIONE ACCESO invece di marrone
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

        {/* Marker Finferlo */}
        {recording && finferliMarkers.map((m: MarkerData) => (
          <Marker
            key={m.name}
            coordinate={{ 'latitude': m.latitude, 'longitude': m.longitude }}
            title={m.name}
            anchor={{ x: 0.38, y: 0.38 }}
          >
            <View style={{
              width: 28,
              height: 28,
              borderRadius: 14,
              backgroundColor: '#ffd900ff', // GIALLO PURO al 100%
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


      </MapView>

      <View style={styles.titleContainer}>
        <Text style={styles.title}>Funghi Tracker</Text>
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
        >
          <Text style={styles.buttonText}>{recording ? 'Termina Registrazione' : 'Inizia Registrazione'}</Text>
        </TouchableOpacity>

        {/* Due bottoni affiancati per porcini e finferli */}
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 10 }}>
          <TouchableOpacity
            style={[styles.smallButton, styles.markerButton, !recording && { opacity: 0.5 }]}
            onPress={() => addMarker('Finferlo')}
            disabled={!recording}
          >
            <Text style={styles.buttonText}>Finferli</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.smallButton, styles.markerButton, !recording && { opacity: 0.5 }]}
            onPress={() => addMarker('Porcino')}
            disabled={!recording}
          >
            <Text style={styles.buttonText}>Porcino</Text>
          </TouchableOpacity>
        </View>
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
      
      {/* Overlay lista funghi */}
      {recording && allMarkers.length > 0 &&
        <View style={{
          position: 'absolute',
          top: 120, right: 10,
          backgroundColor: 'rgba(255,255,255,0.9)',
          borderRadius: 12,
          padding: 8,
          maxHeight: showAll ? 400 : 180,
          width: 170,
          shadowColor: '#000000ff',
          shadowOpacity: 0.1,
          shadowRadius: 3,
        }}>
          <Text style={{ fontSize: 15, fontWeight: 'bold', marginBottom: 4 }}>
            Funghi trovati ({allMarkers.length})
          </Text>

          <ScrollView>
            {visibleMarkers.map((m: MarkerData) => (
              <View key={m.name} style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 4,
              }}>
                <View style={{
                  width: 16,
                  height: 16,
                  borderRadius: 8,
                  backgroundColor: m.tipo === "Porcino" ? "#965123ff" : "#ffd900ff",
                  borderWidth: 1,
                  borderColor: "#2e2e2eff",
                  marginRight: 8,
                  shadowColor: '#000',
                  shadowOffset: { width: 0, height: 1 },
                  shadowOpacity: 0.3,
                  shadowRadius: 2,
                  elevation: 2,
                }} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 12 }}>{m.name}</Text>
                </View>
                <TouchableOpacity onPress={() => handleDeleteMarker(m)}>
                  <Trash2 size={16} color="red" />
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>

          <TouchableOpacity
            onPress={() => setShowAll(!showAll)}
            style={{ marginTop: 6, marginBottom: 2 }}
          >
            <Text style={{ color: 'blue', fontSize: 14 }}>
              {showAll ? 'Mostra meno ▲' : 'Mostra tutti ▼'}
            </Text>
          </TouchableOpacity>
        </View>
      }

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
          <Text style={{ color: isDark ? '#ffffff' : '#000000' }}>Porcini: {porciniMarkers.length} - Finferli: {finferliMarkers.length}</Text>
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
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 3, color: 'white',
  },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  modalContent: { backgroundColor: 'white', padding: 20, borderRadius: 10, width: '80%' },
  input: { borderWidth: 1, borderColor: '#ccc', padding: 10, marginVertical: 10, borderRadius: 5 },
  bigButton: { width: 290, paddingVertical: 15, borderRadius: 10, marginVertical: 8, alignItems: 'center', backgroundColor: '#4CAF50' },
  smallButton: { width: 140, paddingVertical: 15, borderRadius: 10, marginVertical: 8, alignItems: 'center', backgroundColor: '#4CAF50' },
  startButton: { backgroundColor: '#4CAF50' },
  stopButton: { backgroundColor: '#F44336' },
  markerButton: { backgroundColor: '#2196F3' },
  buttonText: { color: 'white', fontSize: 18, fontWeight: 'bold' },
  stats: { position: 'absolute', bottom: 10, alignItems: 'center' },
  centerButton: {
    position: 'absolute', bottom: 240, left: 40, width: 50, height: 50, borderRadius: 25,
    backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'center', alignItems: 'center',
},
});
