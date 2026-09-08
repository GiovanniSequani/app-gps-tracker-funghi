import { beforeEach, describe, expect, it, vi } from 'vitest';

const files = new Map<string, string>();

vi.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'document://app/',
  cacheDirectory: 'cache://app/',
  makeDirectoryAsync: vi.fn(async () => undefined),
  getInfoAsync: vi.fn(async (uri: string) => ({ exists: files.has(uri) })),
  readAsStringAsync: vi.fn(async (uri: string) => {
    const value = files.get(uri);
    if (value === undefined) throw new Error('missing');
    return value;
  }),
  writeAsStringAsync: vi.fn(async (uri: string, value: string) => { files.set(uri, value); }),
  deleteAsync: vi.fn(async (uri: string) => { files.delete(uri); }),
  moveAsync: vi.fn(async ({ from, to }: { from: string; to: string }) => {
    const value = files.get(from);
    if (value === undefined) throw new Error('missing');
    files.set(to, value);
    files.delete(from);
  }),
}));

import { createRecordingDraft } from '../recordingDraft';
import {
  clearRecordingDraft,
  CorruptRecordingDraftError,
  loadRecordingDraft,
  RECORDING_DRAFT_BACKUP_FILE,
  RECORDING_DRAFT_FILE,
  RECORDING_DRAFT_TEMP_FILE,
  RECORDING_RECOVERY_DIRECTORY,
  writeRecordingDraft,
} from '../recordingDraftStorage';

function draft(sessionId: string, timestamp: number) {
  return createRecordingDraft({
    sessionId,
    status: 'paused',
    startedAt: '2026-08-25T08:00:00.000Z',
    now: '2026-08-25T08:05:00.000Z',
    path: [{ latitude: 45, longitude: 11, timestamp }],
    markers: [],
    pauseWindows: [{ startedAt: timestamp + 1, endedAt: null }],
  });
}

describe('recording draft durable storage', () => {
  beforeEach(async () => {
    files.clear();
    await clearRecordingDraft();
  });

  it('uses the private persistent document directory, not cache', () => {
    expect(RECORDING_RECOVERY_DIRECTORY).toBe('document://app/recording-recovery/');
  });

  it('writes the current snapshot and retains the previous valid backup', async () => {
    const first = draft('one', 1_000);
    const second = draft('one', 2_000);
    await writeRecordingDraft(first);
    await writeRecordingDraft(second);
    expect(await loadRecordingDraft()).toEqual(second);
    expect(files.has(RECORDING_DRAFT_BACKUP_FILE)).toBe(true);
  });

  it('recovers from the temp file when replacement was interrupted', async () => {
    const recovered = draft('temp', 3_000);
    files.set(RECORDING_DRAFT_FILE, '{broken');
    files.set(RECORDING_DRAFT_TEMP_FILE, JSON.stringify(recovered));
    expect(await loadRecordingDraft()).toEqual(recovered);
  });

  it('falls back to the backup and reports fully corrupt storage', async () => {
    const recovered = draft('backup', 4_000);
    files.set(RECORDING_DRAFT_FILE, '{broken');
    files.set(RECORDING_DRAFT_BACKUP_FILE, JSON.stringify(recovered));
    expect(await loadRecordingDraft()).toEqual(recovered);
    files.set(RECORDING_DRAFT_BACKUP_FILE, '{broken too');
    await expect(loadRecordingDraft()).rejects.toBeInstanceOf(CorruptRecordingDraftError);
  });

  it('removes every recovery snapshot after save or discard', async () => {
    await writeRecordingDraft(draft('one', 1_000));
    await clearRecordingDraft();
    expect(await loadRecordingDraft()).toBeNull();
  });
});
