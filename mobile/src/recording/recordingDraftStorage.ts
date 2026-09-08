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

async function readDraftCandidate(uri: string): Promise<RecordingDraft | null> {
  if (!(await exists(uri))) return null;
  const raw = await FileSystemLegacy.readAsStringAsync(uri);
  return parseRecordingDraft(raw);
}

export async function loadRecordingDraft(): Promise<RecordingDraft | null> {
  await storageQueue.catch(() => undefined);
  await ensureRecordingRecoveryDirectory();
  const primaryExists = await exists(RECORDING_DRAFT_FILE);
  const tempExists = await exists(RECORDING_DRAFT_TEMP_FILE);
  const backupExists = await exists(RECORDING_DRAFT_BACKUP_FILE);
  const primary = await readDraftCandidate(RECORDING_DRAFT_FILE);
  if (primary) return primary;
  const temp = await readDraftCandidate(RECORDING_DRAFT_TEMP_FILE);
  if (temp) return temp;
  const backup = await readDraftCandidate(RECORDING_DRAFT_BACKUP_FILE);
  if (backup) return backup;
  if (primaryExists || tempExists || backupExists) throw new CorruptRecordingDraftError();
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
