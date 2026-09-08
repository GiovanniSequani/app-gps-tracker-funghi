import type { RecordingPauseWindow, RecordingStatus } from './recordingState';

export const RECORDING_DRAFT_SCHEMA_VERSION = 1;
export const RECORDING_CHECKPOINT_POINT_INTERVAL = 10;

export type RecordingDraftPoint = {
  latitude: number;
  longitude: number;
  timestamp: number;
};

export type RecordingDraftMarker = RecordingDraftPoint & {
  tipo: 'Porcino' | 'Finferlo';
  name: string;
};

export type RecordingDraftStatus = Exclude<RecordingStatus, 'idle'> | 'interrupted';

export type RecordingDraft = {
  schemaVersion: typeof RECORDING_DRAFT_SCHEMA_VERSION;
  sessionId: string;
  status: RecordingDraftStatus;
  startedAt: string;
  updatedAt: string;
  path: RecordingDraftPoint[];
  markers: RecordingDraftMarker[];
  pauseWindows: RecordingPauseWindow[];
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parsePoint(value: unknown): RecordingDraftPoint | null {
  if (!value || typeof value !== 'object') return null;
  const point = value as Partial<RecordingDraftPoint>;
  if (!isFiniteNumber(point.latitude) || !isFiniteNumber(point.longitude) || !isFiniteNumber(point.timestamp)) {
    return null;
  }
  if (point.latitude < -90 || point.latitude > 90 || point.longitude < -180 || point.longitude > 180) {
    return null;
  }
  return { latitude: point.latitude, longitude: point.longitude, timestamp: point.timestamp };
}

function parseMarker(value: unknown): RecordingDraftMarker | null {
  const point = parsePoint(value);
  if (!point || !value || typeof value !== 'object') return null;
  const marker = value as Partial<RecordingDraftMarker>;
  if ((marker.tipo !== 'Porcino' && marker.tipo !== 'Finferlo') || typeof marker.name !== 'string') {
    return null;
  }
  return { ...point, tipo: marker.tipo, name: marker.name };
}

function parsePauseWindow(value: unknown): RecordingPauseWindow | null {
  if (!value || typeof value !== 'object') return null;
  const window = value as Partial<RecordingPauseWindow>;
  if (!isFiniteNumber(window.startedAt)) return null;
  if (window.endedAt !== null && !isFiniteNumber(window.endedAt)) return null;
  if (window.endedAt !== null && window.endedAt < window.startedAt) return null;
  return { startedAt: window.startedAt, endedAt: window.endedAt };
}

export function parseRecordingDraft(raw: string): RecordingDraft | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const draft = value as Partial<RecordingDraft>;
  if (
    draft.schemaVersion !== RECORDING_DRAFT_SCHEMA_VERSION
    || typeof draft.sessionId !== 'string'
    || draft.sessionId.length === 0
    || (draft.status !== 'recording' && draft.status !== 'paused' && draft.status !== 'interrupted')
    || typeof draft.startedAt !== 'string'
    || !Number.isFinite(Date.parse(draft.startedAt))
    || typeof draft.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(draft.updatedAt))
    || !Array.isArray(draft.path)
    || !Array.isArray(draft.markers)
    || !Array.isArray(draft.pauseWindows)
  ) {
    return null;
  }
  const path = draft.path.map(parsePoint);
  const markers = draft.markers.map(parseMarker);
  const pauseWindows = draft.pauseWindows.map(parsePauseWindow);
  if (path.some((point) => point === null) || markers.some((marker) => marker === null) || pauseWindows.some((window) => window === null)) {
    return null;
  }
  return {
    schemaVersion: RECORDING_DRAFT_SCHEMA_VERSION,
    sessionId: draft.sessionId,
    status: draft.status,
    startedAt: draft.startedAt,
    updatedAt: draft.updatedAt,
    path: path as RecordingDraftPoint[],
    markers: markers as RecordingDraftMarker[],
    pauseWindows: pauseWindows as RecordingPauseWindow[],
  };
}

export function mergeRecordingDraftPoints(
  ...collections: RecordingDraftPoint[][]
): RecordingDraftPoint[] {
  const unique = new Map<string, RecordingDraftPoint>();
  collections.flat().forEach((point) => {
    const parsed = parsePoint(point);
    if (!parsed) return;
    const key = `${parsed.timestamp}:${parsed.latitude}:${parsed.longitude}`;
    unique.set(key, parsed);
  });
  return [...unique.values()].sort((left, right) => left.timestamp - right.timestamp);
}

export function shouldCheckpointRecording(
  lastCheckpointPointCount: number,
  currentPointCount: number,
  interval = RECORDING_CHECKPOINT_POINT_INTERVAL,
): boolean {
  return currentPointCount - lastCheckpointPointCount >= interval;
}

export function createRecordingDraft(input: {
  sessionId: string;
  status: RecordingDraftStatus;
  startedAt: string;
  path: RecordingDraftPoint[];
  markers: RecordingDraftMarker[];
  pauseWindows: RecordingPauseWindow[];
  now?: string;
}): RecordingDraft {
  return {
    schemaVersion: RECORDING_DRAFT_SCHEMA_VERSION,
    sessionId: input.sessionId,
    status: input.status,
    startedAt: input.startedAt,
    updatedAt: input.now ?? new Date().toISOString(),
    path: input.path,
    markers: input.markers,
    pauseWindows: input.pauseWindows,
  };
}
