import * as FileSystemLegacy from 'expo-file-system/legacy';
import { parseRecordingDraft, type RecordingDraft } from './recordingDraft';

const persistentBaseDirectory = FileSystemLegacy.documentDirectory;
if (!persistentBaseDirectory) {
  throw new Error('La directory persistente dell’app non è disponibile.');
}

export const RECORDING_RECOVERY_DIRECTORY = `${persistentBaseDirectory}recording-recovery/`;
export const RECORDING_DRAFT_FILE = `${RECORDING_RECOVERY_DIRECTORY}current.json`;
export const RECORDING_DRAFT_BACKUP_FILE = `${RECORDING_RECOVERY_DIRECTORY}current.backup.json`;
export const RECORDING_DRAFT_TEMP_FILE = `${RECORDING_RECOVERY_DIRECTORY}current.tmp.json`;
export const RECORDING_BACKGROUND_POSITIONS_FILE = `${RECORDING_RECOVERY_DIRECTORY}background-positions.json`;
export const RECORDING_STATUS_FILE = `${RECORDING_RECOVERY_DIRECTORY}status.txt`;

let storageQueue: Promise<void> = Promise.resolve();

export class CorruptRecordingDraftError extends Error {
  constructor() {
    super('La registrazione interrotta non è leggibile.');
    this.name = 'CorruptRecordingDraftError';
  }
}

export async function ensureRecordingRecoveryDirectory(): Promise<void> {
  await FileSystemLegacy.makeDirectoryAsync(RECORDING_RECOVERY_DIRECTORY, { intermediates: true });
}

async function exists(uri: string): Promise<boolean> {
  return (await FileSystemLegacy.getInfoAsync(uri)).exists;
}

async function readDraftCandidate(uri: string): Promise<{ draft: RecordingDraft | null; ownerUserId: string | null | undefined } | null> {
  if (!(await exists(uri))) return null;
  const raw = await FileSystemLegacy.readAsStringAsync(uri);
  let ownerUserId: string | null | undefined;
  try {
    const value = JSON.parse(raw) as { ownerUserId?: unknown };
    ownerUserId = value.ownerUserId === null || typeof value.ownerUserId === 'string'
      ? value.ownerUserId
      : undefined;
  } catch {
    ownerUserId = undefined;
  }
  return { draft: parseRecordingDraft(raw), ownerUserId };
}

export async function loadRecordingDraft(expectedOwnerUserId: string | null): Promise<RecordingDraft | null> {
  await storageQueue.catch(() => undefined);
  await ensureRecordingRecoveryDirectory();
  const primaryExists = await exists(RECORDING_DRAFT_FILE);
  const tempExists = await exists(RECORDING_DRAFT_TEMP_FILE);
  const backupExists = await exists(RECORDING_DRAFT_BACKUP_FILE);
  const backgroundExists = await exists(RECORDING_BACKGROUND_POSITIONS_FILE);
  const statusExists = await exists(RECORDING_STATUS_FILE);
  const candidates = await Promise.all([
    readDraftCandidate(RECORDING_DRAFT_FILE),
    readDraftCandidate(RECORDING_DRAFT_TEMP_FILE),
    readDraftCandidate(RECORDING_DRAFT_BACKUP_FILE),
  ]);
  for (const candidate of candidates) {
    if (candidate?.draft?.ownerUserId === expectedOwnerUserId) return candidate.draft;
  }
  const hasOwnedCorruption = candidates.some((candidate) => (
    candidate?.ownerUserId === expectedOwnerUserId && candidate.draft === null
  ));
  if (hasOwnedCorruption) throw new CorruptRecordingDraftError();
  if (primaryExists || tempExists || backupExists || backgroundExists || statusExists) {
    // Legacy, senza owner o appartenente a un'altra identita': non esporre
    // neppure il metadata di recovery e rimuovere tutti i file associati.
    await clearRecordingDraft();
  }
  return null;
}

export function writeRecordingDraft(draft: RecordingDraft): Promise<void> {
  const write = async () => {
    await ensureRecordingRecoveryDirectory();
    await FileSystemLegacy.writeAsStringAsync(RECORDING_DRAFT_TEMP_FILE, JSON.stringify(draft));
    await FileSystemLegacy.deleteAsync(RECORDING_DRAFT_BACKUP_FILE, { idempotent: true });
    if (await exists(RECORDING_DRAFT_FILE)) {
      await FileSystemLegacy.moveAsync({
        from: RECORDING_DRAFT_FILE,
        to: RECORDING_DRAFT_BACKUP_FILE,
      });
    }
    await FileSystemLegacy.moveAsync({
      from: RECORDING_DRAFT_TEMP_FILE,
      to: RECORDING_DRAFT_FILE,
    });
  };
  storageQueue = storageQueue.catch(() => undefined).then(write);
  return storageQueue;
}

export function clearRecordingDraft(): Promise<void> {
  const clear = async () => {
    await Promise.all([
      FileSystemLegacy.deleteAsync(RECORDING_DRAFT_FILE, { idempotent: true }),
      FileSystemLegacy.deleteAsync(RECORDING_DRAFT_BACKUP_FILE, { idempotent: true }),
      FileSystemLegacy.deleteAsync(RECORDING_DRAFT_TEMP_FILE, { idempotent: true }),
      FileSystemLegacy.deleteAsync(RECORDING_BACKGROUND_POSITIONS_FILE, { idempotent: true }),
      FileSystemLegacy.deleteAsync(RECORDING_STATUS_FILE, { idempotent: true }),
    ]);
  };
  storageQueue = storageQueue.catch(() => undefined).then(clear);
  return storageQueue;
}
