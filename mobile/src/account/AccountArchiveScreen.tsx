import React from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { File, Paths } from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import uuid from 'react-native-uuid';
import {
  AlertTriangle,
  Cloud,
  CloudDownload,
  FileUp,
  LogIn,
  LogOut,
  MapPinned,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UploadCloud,
  UserPlus,
  UserRound,
} from 'lucide-react-native';
import { deleteRoute, getAllRoutes, getRouteById, insertRoute } from '../../db';
import { AccountAuthForm, type AuthView } from './AccountAuthForm';
import {
  createTrackDownloadUrl,
  deleteTrack,
  getArchiveConfig,
  loadArchiveData,
  signIn,
  signOut,
  signUp,
  renameTrack,
} from './client';
import { parseGpxBytes } from './gpxParser';
import { routeSummary, uploadRouteToCloud } from './routeUpload';
import { TrackNameModal } from './TrackNameModal';
import type {
  AccountSessionState,
  ArchiveConfig,
  ArchiveData,
  ArchiveMapRoute,
  GpxMarker,
  GpxTrack,
  ParsedGpxRoute,
} from './types';
import { normalizeTrackName, safeGpxName, toAccountError, validateTrackName } from './validation';

type LocalRoute = { route_id: string; name: string; date: string };
type FullLocalRoute = LocalRoute & {
  path: Array<{ latitude: number; longitude: number; timestamp?: number | null }>;
  waypoints: Array<{ lat: number; lon: number; timestamp?: number | null; name: string; type: string }>;
};
type CloudDetail = { route?: ArchiveMapRoute; loading: boolean; error?: string };
type NameAction =
  | { kind: 'import'; route: ParsedGpxRoute }
  | { kind: 'localUpload'; route: ArchiveMapRoute }
  | { kind: 'rename'; track: GpxTrack };

const COLORS = {
  bg: '#0a110b', panel: '#121b13', panel2: '#18231a', border: '#2d4030',
  text: '#eef5ee', muted: '#9aab9c', green: '#63c779', red: '#ef7474', amber: '#e6b861',
};

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toLocaleString('it-IT', { maximumFractionDigits: 1 })} KB`;
  return `${(value / 1024 ** 2).toLocaleString('it-IT', { maximumFractionDigits: 1 })} MB`;
}

function formatDate(value: string | null): string {
  if (!value) return 'Data non disponibile';
  try {
    return new Date(value).toLocaleString('it-IT', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch { return value; }
}

function markersFromLocal(route: FullLocalRoute): GpxMarker[] {
  return route.waypoints.map((waypoint) => ({
    latitude: waypoint.lat,
    longitude: waypoint.lon,
    timestamp: waypoint.timestamp,
    name: waypoint.name,
    tipo: waypoint.type,
  }));
}

function TrackStats(props: {
  distanceM: number | null;
  pointCount: number | null;
  porciniCount?: number;
  finferliCount?: number;
  loadingSpecies?: boolean;
}) {
  const distance = props.distanceM === null
    ? '— km'
    : `${(props.distanceM / 1000).toLocaleString('it-IT', { maximumFractionDigits: 1 })} km`;
  const porcini = props.loadingSpecies && props.porciniCount === undefined ? '…' : props.porciniCount ?? '—';
  const finferli = props.loadingSpecies && props.finferliCount === undefined ? '…' : props.finferliCount ?? '—';
  return (
    <Text style={styles.muted} accessibilityLabel={`${distance}, ${props.pointCount ?? 'dato non disponibile'} punti, ${porcini} porcini, ${finferli} finferli`}>
      {distance} · {props.pointCount ?? '—'} punti · {porcini} porcini · {finferli} finferli
    </Text>
  );
}

function TrackRow(props: {
  source: 'cloud' | 'local';
  title: string;
  subtitle: string;
  stats: React.ReactNode;
  warning?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.trackRow}>
      <View style={styles.trackCopy}>
        <View style={styles.trackTitleRow}>
          <Text style={styles.trackName} numberOfLines={1}>{props.title}</Text>
          <Text style={[styles.sourceBadge, props.source === 'local' && styles.sourceBadgeLocal]}>
            {props.source === 'cloud' ? 'ARCHIVIO' : 'LOCALE'}
          </Text>
        </View>
        <Text style={styles.muted}>{props.subtitle}</Text>
        {props.stats}
        {props.warning && <Text style={styles.warning}>{props.warning}</Text>}
      </View>
      <View style={styles.trackActions}>{props.children}</View>
    </View>
  );
}

export default function AccountArchiveScreen(props: {
  sessionState: AccountSessionState;
  onShowTrackOnMap: (route: ArchiveMapRoute) => void;
  onLocalRouteArchived: (routeId: string) => void;
  onCloudRouteRenamed: (trackId: string, name: string) => void;
}) {
  const { sessionState } = props;
  const navigation = useNavigation<any>();
  const safeAreaInsets = useSafeAreaInsets();
  const [authVisible, setAuthVisible] = React.useState(false);
  const [authView, setAuthView] = React.useState<AuthView>('login');
  const [config, setConfig] = React.useState<ArchiveConfig | null>(null);
  const [archive, setArchive] = React.useState<ArchiveData | null>(null);
  const [localRoutes, setLocalRoutes] = React.useState<ArchiveMapRoute[]>([]);
  const [cloudDetails, setCloudDetails] = React.useState<Record<string, CloudDetail>>({});
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [authBusy, setAuthBusy] = React.useState(false);
  const [authError, setAuthError] = React.useState<string | null>(null);
  const [authNotice, setAuthNotice] = React.useState<string | null>(null);
  const [actions, setActions] = React.useState<Record<string, 'upload' | 'download' | 'delete' | 'map' | 'import'>>({});
  const [partialDeletes, setPartialDeletes] = React.useState<Set<string>>(() => new Set());
  const [nameAction, setNameAction] = React.useState<NameAction | null>(null);
  const [trackName, setTrackName] = React.useState('');
  const [trackNameError, setTrackNameError] = React.useState<string | null>(null);
  const [trackNameBusy, setTrackNameBusy] = React.useState(false);
  const loadSequence = React.useRef(0);
  const detailSequence = React.useRef(0);
  const cloudDetailsRef = React.useRef<Record<string, CloudDetail>>({});
  const noticeOpacity = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    if (!notice) return;
    noticeOpacity.setValue(0);
    Animated.timing(noticeOpacity, {
      toValue: 1,
      duration: 180,
      useNativeDriver: true,
    }).start();
    const timeout = setTimeout(() => {
      Animated.timing(noticeOpacity, {
        toValue: 0,
        duration: 220,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setNotice(null);
      });
    }, 3200);
    return () => clearTimeout(timeout);
  }, [notice, noticeOpacity]);

  const updateCloudDetails = React.useCallback((update: (current: Record<string, CloudDetail>) => Record<string, CloudDetail>) => {
    setCloudDetails((current) => {
      const next = update(current);
      cloudDetailsRef.current = next;
      return next;
    });
  }, []);

  React.useEffect(() => {
    let active = true;
    void getArchiveConfig().then((value) => { if (active) setConfig(value); })
      .catch((reason) => { if (active) setError(toAccountError(reason).message); });
    return () => { active = false; };
  }, []);

  const loadLocalRoutes = React.useCallback(async (): Promise<ArchiveMapRoute[]> => {
    const rows = await getAllRoutes().catch(() => []) as LocalRoute[];
    const fullRoutes = await Promise.all(rows.map((row) => getRouteById(row.route_id).catch(() => null)));
    return fullRoutes.flatMap((value) => {
      const route = value as FullLocalRoute | null;
      if (!route) return [];
      return [routeSummary({
        routeId: route.route_id,
        name: route.name,
        date: route.date,
        path: route.path,
        markers: markersFromLocal(route),
      })];
    });
  }, []);

  const refresh = React.useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError(null);
    if (!sessionState.session) {
      try {
        const local = await loadLocalRoutes();
        if (sequence === loadSequence.current) setLocalRoutes(local);
      } catch {
        if (sequence === loadSequence.current) setError('Impossibile leggere i percorsi conservati sul dispositivo.');
      } finally {
        if (sequence === loadSequence.current) setLoading(false);
      }
      return;
    }
    const [cloudResult, localResult] = await Promise.allSettled([loadArchiveData(), loadLocalRoutes()]);
    if (sequence !== loadSequence.current) return;
    if (cloudResult.status === 'fulfilled') {
      setArchive(cloudResult.value);
      setConfig(cloudResult.value.config);
    } else {
      setArchive(null);
      setError(toAccountError(cloudResult.reason).message);
    }
    if (localResult.status === 'fulfilled') {
      setLocalRoutes(localResult.value);
    } else if (cloudResult.status === 'fulfilled') {
      setError('Impossibile leggere i percorsi conservati sul dispositivo.');
    }
    setLoading(false);
  }, [loadLocalRoutes, sessionState.session]);

  const downloadTrackBytes = React.useCallback(async (track: GpxTrack): Promise<Uint8Array> => {
    const signedUrl = await createTrackDownloadUrl(track);
    const destination = new File(Paths.cache, `cloud-${track.id}.gpx.gz`);
    const downloaded = await File.downloadFileAsync(signedUrl, destination, { idempotent: true });
    return downloaded.bytes();
  }, []);

  const loadCloudDetail = React.useCallback(async (track: GpxTrack): Promise<ArchiveMapRoute> => {
    const existing = cloudDetailsRef.current[track.id]?.route;
    if (existing) return existing;
    if (!config) throw new Error('Configurazione archivio non ancora disponibile.');
    updateCloudDetails((current) => ({ ...current, [track.id]: { ...current[track.id], loading: true, error: undefined } }));
    try {
      const bytes = await downloadTrackBytes(track);
      const parsed = parseGpxBytes(bytes, track.original_filename || `${track.display_name}.gpx.gz`, config.max_uncompressed_bytes);
      const route = routeSummary({
        routeId: track.id,
        name: track.display_name,
        date: track.ready_at ?? track.created_at,
        path: parsed.path,
        markers: parsed.markers,
      });
      updateCloudDetails((current) => ({ ...current, [track.id]: { route, loading: false } }));
      return route;
    } catch (reason) {
      const message = toAccountError(reason).message;
      updateCloudDetails((current) => ({ ...current, [track.id]: { loading: false, error: message } }));
      throw reason;
    }
  }, [config, downloadTrackBytes, updateCloudDetails]);

  React.useEffect(() => {
    if (!archive || !config) return;
    const sequence = ++detailSequence.current;
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(3, archive.tracks.length) }, async () => {
      while (nextIndex < archive.tracks.length) {
        const track = archive.tracks[nextIndex++];
        if (cloudDetailsRef.current[track.id]?.route) continue;
        try { await loadCloudDetail(track); } catch { /* per-track state remains available */ }
        if (sequence !== detailSequence.current) return;
      }
    });
    void Promise.all(workers);
    return () => { detailSequence.current += 1; };
  }, [archive?.tracks, config, loadCloudDetail]);

  React.useEffect(() => {
    if (!sessionState.session) {
      loadSequence.current += 1;
      detailSequence.current += 1;
      setArchive(null);
      setCloudDetails({});
      cloudDetailsRef.current = {};
      setNameAction(null);
      setTrackName('');
      setTrackNameError(null);
      setTrackNameBusy(false);
      setLoading(false);
      return;
    }
    setAuthVisible(false);
  }, [sessionState.session]);

  useFocusEffect(React.useCallback(() => {
    void refresh();
  }, [refresh]));

  const runAuth = async (action: () => Promise<void>) => {
    setAuthBusy(true); setAuthError(null); setAuthNotice(null);
    try { await action(); } catch (reason) { setAuthError(toAccountError(reason).message); }
    finally { setAuthBusy(false); }
  };

  const openNameAction = (action: NameAction, initialName: string) => {
    setNameAction(action);
    setTrackName(initialName);
    setTrackNameError(null);
  };

  const closeNameAction = () => {
    if (trackNameBusy) return;
    setNameAction(null);
    setTrackName('');
    setTrackNameError(null);
  };

  const handleImport = async () => {
    if (!config) return;
    setActions((current) => ({ ...current, import: 'import' }));
    setError(null); setNotice(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/gpx+xml', 'application/gzip', 'application/x-gzip', 'application/xml', 'text/xml', 'application/octet-stream'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      const source = new File(asset.uri);
      const bytes = await source.bytes();
      const parsed = parseGpxBytes(bytes, asset.name, config.max_uncompressed_bytes);
      openNameAction({ kind: 'import', route: parsed }, parsed.name);
    } catch (reason) { setError(toAccountError(reason).message); }
    finally { setActions((current) => { const next = { ...current }; delete next.import; return next; }); }
  };

  const confirmNameAction = async () => {
    if (!nameAction || !config || trackNameBusy) return;
    const validationError = validateTrackName(trackName);
    if (validationError) { setTrackNameError(validationError); return; }
    const normalizedName = normalizeTrackName(trackName);
    setTrackNameBusy(true);
    setTrackNameError(null);
    setError(null);
    setNotice(null);
    try {
      if (nameAction.kind === 'rename') {
        const originalPath = nameAction.track.storage_path;
        const updated = await renameTrack(nameAction.track, normalizedName);
        setArchive((current) => current ? {
          ...current,
          tracks: current.tracks.map((item) => item.id === nameAction.track.id
            ? { ...item, ...updated, display_name: updated.display_name || normalizedName, storage_path: originalPath }
            : item),
        } : current);
        updateCloudDetails((current) => {
          const detail = current[nameAction.track.id];
          return detail?.route ? {
            ...current,
            [nameAction.track.id]: { ...detail, route: { ...detail.route, name: updated.display_name || normalizedName } },
          } : current;
        });
        props.onCloudRouteRenamed(nameAction.track.id, updated.display_name || normalizedName);
        setNotice(`Percorso rinominato in “${updated.display_name || normalizedName}”.`);
        setNameAction(null);
        await refresh();
      } else if (nameAction.kind === 'localUpload') {
        const route = { ...nameAction.route, name: normalizedName };
        await uploadRouteToCloud(route, config);
        await deleteRoute(route.routeId);
        props.onLocalRouteArchived(route.routeId);
        setLocalRoutes((current) => current.filter((item) => item.routeId !== route.routeId));
        setNotice(`“${normalizedName}” è stato salvato nell’archivio.`);
        setNameAction(null);
        await refresh();
      } else {
        const imported = nameAction.route;
        try {
          await uploadRouteToCloud({ name: normalizedName, path: imported.path, markers: imported.markers }, config);
          setNotice(`“${normalizedName}” è stato importato nell’archivio.`);
        } catch (uploadError) {
          const routeId = uuid.v4() as string;
          const date = imported.startedAt ?? new Date().toISOString();
          await insertRoute(
            routeId,
            normalizedName,
            date,
            imported.path.map((point) => ({ ...point, timestamp: point.timestamp ?? Date.now() })),
            imported.markers.map((marker) => ({ ...marker, timestamp: marker.timestamp ?? Date.now() })),
          );
          setNotice(`Upload non riuscito: “${normalizedName}” è stato conservato tra i percorsi locali.`);
        }
        setNameAction(null);
        await refresh();
      }
    } catch (reason) {
      const normalized = toAccountError(reason);
      setTrackNameError(normalized.message);
      if (normalized.code === 'track_not_found') void refresh();
      if (normalized.code === 'session_expired') void signOut();
    } finally {
      setTrackNameBusy(false);
    }
  };

  const performDeleteLocal = async (route: ArchiveMapRoute) => {
    setActions((current) => ({ ...current, [route.routeId]: 'delete' }));
    setError(null);
    try {
      await deleteRoute(route.routeId);
      setLocalRoutes((current) => current.filter((item) => item.routeId !== route.routeId));
      props.onLocalRouteArchived(route.routeId);
      setNotice(`Il percorso locale “${route.name}” è stato eliminato.`);
    } catch (reason) {
      setError(toAccountError(reason).message);
    } finally {
      setActions((current) => { const next = { ...current }; delete next[route.routeId]; return next; });
    }
  };

  const requestDeleteLocal = (route: ArchiveMapRoute) => {
    Alert.alert(
      'Elimina percorso locale',
      `Eliminare “${route.name}” dal dispositivo? La cancellazione non modifica l’archivio cloud.`,
      [
        { text: 'Annulla', style: 'cancel' },
        { text: 'Elimina locale', style: 'destructive', onPress: () => void performDeleteLocal(route) },
      ],
    );
  };

  const handleDownload = async (track: GpxTrack) => {
    setActions((current) => ({ ...current, [track.id]: 'download' }));
    setError(null);
    try {
      const bytes = await downloadTrackBytes(track);
      const file = new File(Paths.cache, `${safeGpxName(track.original_filename || track.display_name)}-${track.id}.gpx.gz`);
      try { file.create({ overwrite: true }); } catch { /* downloaded cache may already exist */ }
      file.write(bytes);
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { mimeType: 'application/gzip' });
      else Alert.alert('File scaricato', file.uri);
    } catch (reason) { setError(toAccountError(reason).message); }
    finally { setActions((current) => { const next = { ...current }; delete next[track.id]; return next; }); }
  };

  const handleShowOnMap = async (track: GpxTrack) => {
    setActions((current) => ({ ...current, [track.id]: 'map' }));
    setError(null);
    try {
      const route = await loadCloudDetail(track);
      props.onShowTrackOnMap(route);
      navigation.navigate('Mappa');
    } catch (reason) { setError(toAccountError(reason).message); }
    finally { setActions((current) => { const next = { ...current }; delete next[track.id]; return next; }); }
  };

  const performDelete = async (track: GpxTrack) => {
    setActions((current) => ({ ...current, [track.id]: 'delete' })); setError(null);
    try {
      await deleteTrack(track);
      setPartialDeletes((current) => { const next = new Set(current); next.delete(track.id); return next; });
      setArchive((current) => current ? { ...current, tracks: current.tracks.filter((item) => item.id !== track.id) } : current);
      updateCloudDetails((current) => { const next = { ...current }; delete next[track.id]; return next; });
    } catch (reason) {
      const normalized = toAccountError(reason); setError(normalized.message);
      if (normalized.partial) setPartialDeletes((current) => new Set(current).add(track.id));
    } finally { setActions((current) => { const next = { ...current }; delete next[track.id]; return next; }); }
  };

  const requestDelete = (track: GpxTrack) => {
    if (partialDeletes.has(track.id)) return void performDelete(track);
    Alert.alert('Elimina percorso', `Eliminare definitivamente “${track.display_name}”?`, [
      { text: 'Annulla', style: 'cancel' },
      { text: 'Elimina', style: 'destructive', onPress: () => void performDelete(track) },
    ]);
  };

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {notice && (
        <Animated.View
          pointerEvents="none"
          accessibilityLiveRegion="polite"
          style={[styles.noticeToast, { top: safeAreaInsets.top + 8, opacity: noticeOpacity }]}
        >
          <Text style={styles.noticeToastText}>{notice}</Text>
        </Animated.View>
      )}
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: safeAreaInsets.top + 16 }]} keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh()} enabled={Boolean(sessionState.session)} tintColor={COLORS.green} />}>
        <View style={styles.header}>
          <View><Text style={styles.eyebrow}>FUNGHI TRACKER</Text><Text style={styles.title}>Archivio</Text></View>
          {sessionState.session && <TouchableOpacity style={styles.iconButton} onPress={() => void refresh()} accessibilityLabel="Aggiorna archivio"><RefreshCw size={19} color={COLORS.text} /></TouchableOpacity>}
        </View>
        {sessionState.loading && <View style={styles.stateRow}><ActivityIndicator color={COLORS.green} /><Text style={styles.muted}>Ripristino sessione…</Text></View>}
        {sessionState.error && <Text style={styles.errorText}>{sessionState.error}</Text>}
        {error && <View style={styles.errorBox}><Text style={styles.errorText}>{error}</Text><TouchableOpacity onPress={() => void refresh()}><Text style={styles.retry}>Riprova</Text></TouchableOpacity></View>}

        {!sessionState.loading && !sessionState.session && (
          <View style={styles.signedOut}>
            <Cloud size={42} color={COLORS.green} />
            <Text style={styles.sectionTitle}>Archivio disponibile solo con account</Text>
            <Text style={styles.body}>Accedi o crea un account per salvare e gestire i tuoi percorsi GPX privati.</Text>
            {!authVisible && <View style={styles.buttonRow}>
              <TouchableOpacity style={styles.primaryButton} onPress={() => { setAuthView('login'); setAuthVisible(true); }}><LogIn size={17} color={COLORS.bg} /><Text style={styles.primaryButtonText}>Accedi</Text></TouchableOpacity>
              <TouchableOpacity style={styles.secondaryButton} onPress={() => { setAuthView('register'); setAuthVisible(true); }}><UserPlus size={17} color={COLORS.text} /><Text style={styles.secondaryButtonText}>Registrati</Text></TouchableOpacity>
            </View>}
            {authVisible && <AccountAuthForm view={authView} config={config} busy={authBusy} error={authError} notice={authNotice} onViewChange={(view) => { setAuthView(view); setAuthError(null); setAuthNotice(null); }} onLogin={(email, password) => runAuth(() => signIn(email, password).then(() => undefined))} onRegister={(email, password, username) => runAuth(async () => { const result = await signUp({ email, password, username }); if (!result.session) { setAuthView('login'); setAuthNotice('Account creato. Controlla l’email e confermala prima di accedere.'); } })} />}
          </View>
        )}

        {sessionState.session && <>
          <View style={styles.profileRow}>
            <View style={styles.avatar}><UserRound size={25} color={COLORS.green} /></View>
            <View style={styles.profileCopy}><Text style={styles.sectionTitle}>{archive?.profile.username ?? sessionState.username ?? 'Utente'}</Text><Text style={styles.muted}>{sessionState.session.user.email}</Text></View>
            <TouchableOpacity style={styles.secondaryButton} onPress={() => void runAuth(signOut)} disabled={authBusy}><LogOut size={16} color={COLORS.text} /><Text style={styles.secondaryButtonText}>Esci</Text></TouchableOpacity>
          </View>
          {archive && <View style={styles.usageRow}>
            <View><Text style={styles.metric}>{archive.tracks.length}/{archive.config.max_tracks_per_user}</Text><Text style={styles.muted}>percorsi salvati</Text></View>
            <View><Text style={styles.metric}>{formatBytes(archive.config.max_compressed_bytes)}</Text><Text style={styles.muted}>massimo per file</Text></View>
            <ShieldCheck size={23} color={COLORS.green} />
          </View>}
          <View style={styles.sectionHeaderRow}>
            <View><Text style={styles.sectionTitle}>Archivio</Text><Text style={styles.muted}>Percorsi salvati</Text></View>
            <TouchableOpacity style={styles.importButton} onPress={() => void handleImport()} disabled={actions.import === 'import'} accessibilityLabel="Importa un file GPX dal dispositivo">
              {actions.import === 'import' ? <ActivityIndicator size="small" color={COLORS.bg} /> : <FileUp size={17} color={COLORS.bg} />}
              <Text style={styles.uploadButtonText}>Importa GPX</Text>
            </TouchableOpacity>
          </View>
          {loading && !archive && <View style={styles.stateRow}><ActivityIndicator color={COLORS.green} /><Text style={styles.muted}>Caricamento archivio…</Text></View>}
          {archive && archive.tracks.length === 0 && <Text style={styles.empty}>Nessun percorso salvato.</Text>}
          {archive?.tracks.map((track) => {
            const detail = cloudDetails[track.id];
            return <TrackRow key={track.id} source="cloud" title={track.display_name} subtitle={`${formatDate(track.ready_at ?? track.created_at)} · ${formatBytes(track.compressed_size_bytes)}`} stats={<TrackStats distanceM={track.distance_m} pointCount={track.point_count} porciniCount={detail?.route?.porciniCount} finferliCount={detail?.route?.finferliCount} loadingSpecies={detail?.loading} />} warning={partialDeletes.has(track.id) ? 'File eliminato; completa la cancellazione dei metadati.' : detail?.error ? 'Dettagli GPX temporaneamente non disponibili.' : undefined}>
              <TouchableOpacity style={styles.iconButton} onPress={() => void handleShowOnMap(track)} disabled={Boolean(actions[track.id])} accessibilityLabel={`Mostra ${track.display_name} sulla mappa`}>{actions[track.id] === 'map' ? <ActivityIndicator size="small" color={COLORS.green} /> : <MapPinned size={19} color={COLORS.green} />}</TouchableOpacity>
              <TouchableOpacity style={styles.iconButton} onPress={() => void handleDownload(track)} disabled={Boolean(actions[track.id])} accessibilityLabel={`Scarica ${track.display_name}`}>{actions[track.id] === 'download' ? <ActivityIndicator size="small" color={COLORS.green} /> : <CloudDownload size={19} color={COLORS.text} />}</TouchableOpacity>
              <TouchableOpacity style={styles.iconButton} onPress={() => openNameAction({ kind: 'rename', track }, track.display_name)} disabled={Boolean(actions[track.id])} accessibilityLabel={`Rinomina ${track.display_name}`}><Pencil size={18} color={COLORS.amber} /></TouchableOpacity>
              <TouchableOpacity style={styles.iconButton} onPress={() => requestDelete(track)} disabled={Boolean(actions[track.id])} accessibilityLabel={`Elimina ${track.display_name}`}>{actions[track.id] === 'delete' ? <ActivityIndicator size="small" color={COLORS.red} /> : <Trash2 size={19} color={COLORS.red} />}</TouchableOpacity>
            </TrackRow>;
          })}

        </>}

        {localRoutes.length > 0 && <View style={styles.localWarningSection}>
          <View style={styles.localWarningHeader}><AlertTriangle size={22} color={COLORS.amber} /><View style={styles.profileCopy}><Text style={styles.sectionTitle}>Percorsi non salvati nell’archivio</Text><Text style={styles.warning}>{sessionState.session ? 'Salvare i percorsi nell’archivio' : 'Accedi per salvarli nell’archivio'}</Text></View></View>
          {localRoutes.map((route) => <TrackRow key={route.routeId} source="local" title={route.name} subtitle={formatDate(route.date)} stats={<TrackStats distanceM={route.distanceM} pointCount={route.pointCount} porciniCount={route.porciniCount} finferliCount={route.finferliCount} />}>
            {sessionState.session && <TouchableOpacity style={styles.uploadButton} onPress={() => openNameAction({ kind: 'localUpload', route }, route.name)} disabled={Boolean(actions[route.routeId])} accessibilityLabel={`Salva ${route.name} nell'archivio`}>
              {actions[route.routeId] === 'upload' ? <ActivityIndicator size="small" color={COLORS.bg} /> : <UploadCloud size={17} color={COLORS.bg} />}
              <Text style={styles.uploadButtonText}>Salva</Text>
            </TouchableOpacity>}
            <TouchableOpacity style={styles.iconButton} onPress={() => requestDeleteLocal(route)} disabled={Boolean(actions[route.routeId])} accessibilityLabel={`Elimina il percorso locale ${route.name}`}>
              {actions[route.routeId] === 'delete' ? <ActivityIndicator size="small" color={COLORS.red} /> : <Trash2 size={19} color={COLORS.red} />}
            </TouchableOpacity>
          </TrackRow>)}
        </View>}
      </ScrollView>
      <TrackNameModal
        visible={Boolean(nameAction)}
        title={nameAction?.kind === 'rename' ? 'Rinomina percorso' : nameAction?.kind === 'import' ? 'Importa percorso' : 'Salva nell’archivio'}
        description={nameAction?.kind === 'rename'
          ? 'Modifica soltanto il nome mostrato. Il file GPX e il suo percorso Storage restano invariati.'
          : 'Conferma o modifica il nome da usare nell’archivio.'}
        value={trackName}
        error={trackNameError}
        busy={trackNameBusy}
        confirmLabel={nameAction?.kind === 'rename' ? 'Rinomina' : 'Continua'}
        onChange={(value) => { setTrackName(value); setTrackNameError(null); }}
        onCancel={closeNameAction}
        onConfirm={() => void confirmNameAction()}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: 18, paddingBottom: 36, gap: 14 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8, paddingBottom: 10 },
  eyebrow: { color: COLORS.green, fontSize: 10, fontWeight: '800', letterSpacing: 2 },
  title: { color: COLORS.text, fontSize: 28, fontWeight: '800', marginTop: 3 },
  sectionTitle: { color: COLORS.text, fontSize: 17, fontWeight: '800' },
  body: { color: COLORS.muted, fontSize: 14, lineHeight: 21, textAlign: 'center' },
  muted: { color: COLORS.muted, fontSize: 12, lineHeight: 17 },
  signedOut: { alignItems: 'center', gap: 13, paddingVertical: 20 },
  buttonRow: { flexDirection: 'row', gap: 10, marginTop: 6 },
  primaryButton: { minHeight: 44, borderRadius: 9, backgroundColor: COLORS.green, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  primaryButtonText: { color: COLORS.bg, fontWeight: '800', fontSize: 14 },
  secondaryButton: { minHeight: 40, borderRadius: 9, borderWidth: 1, borderColor: COLORS.border, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  secondaryButtonText: { color: COLORS.text, fontWeight: '700', fontSize: 13 },
  profileRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: COLORS.panel2, alignItems: 'center', justifyContent: 'center' },
  profileCopy: { flex: 1 },
  usageRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: COLORS.panel, borderRadius: 10, padding: 14 },
  metric: { color: COLORS.text, fontSize: 17, fontWeight: '800' },
  sectionHeaderRow: { borderTopWidth: 1, borderTopColor: COLORS.border, paddingTop: 16, marginTop: 4, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  stateRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 18 },
  trackRow: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: COLORS.panel, borderRadius: 9, padding: 12 },
  trackCopy: { flex: 1, minWidth: 0, gap: 2 },
  trackTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  trackName: { flexShrink: 1, color: COLORS.text, fontWeight: '700', fontSize: 14 },
  sourceBadge: { color: COLORS.green, borderWidth: 1, borderColor: '#477d52', borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1, fontSize: 8, fontWeight: '900', letterSpacing: 0.6 },
  sourceBadgeLocal: { color: COLORS.amber, borderColor: '#735f30' },
  trackActions: { width: 85, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 5 },
  iconButton: { width: 40, height: 40, borderRadius: 8, borderWidth: 1, borderColor: COLORS.border, alignItems: 'center', justifyContent: 'center' },
  uploadButton: { minHeight: 38, paddingHorizontal: 11, borderRadius: 8, backgroundColor: COLORS.green, flexDirection: 'row', gap: 5, alignItems: 'center' },
  importButton: { minHeight: 40, paddingHorizontal: 12, borderRadius: 8, backgroundColor: COLORS.green, flexDirection: 'row', gap: 6, alignItems: 'center' },
  uploadButtonText: { color: COLORS.bg, fontWeight: '800', fontSize: 12 },
  localWarningSection: { gap: 10, borderWidth: 1, borderColor: '#735f30', backgroundColor: '#211d12', borderRadius: 11, padding: 12 },
  localWarningHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  empty: { color: COLORS.muted, fontSize: 13, paddingVertical: 12, textAlign: 'center' },
  errorBox: { backgroundColor: '#351d1d', borderRadius: 8, padding: 12, gap: 7 },
  errorText: { color: '#ffaaaa', fontSize: 12, lineHeight: 18 },
  noticeToast: { position: 'absolute', zIndex: 20, left: 16, right: 16, minHeight: 46, borderRadius: 10, borderWidth: 1, borderColor: '#477d52', backgroundColor: '#17351d', paddingHorizontal: 14, paddingVertical: 11, justifyContent: 'center', elevation: 8 },
  noticeToastText: { color: '#c7f4cf', fontSize: 13, lineHeight: 18, fontWeight: '700', textAlign: 'center' },
  warning: { color: COLORS.amber, fontSize: 11, lineHeight: 16 },
  retry: { color: COLORS.text, fontWeight: '800', textDecorationLine: 'underline' },
});
