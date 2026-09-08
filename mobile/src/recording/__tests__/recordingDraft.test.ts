import { describe, expect, it } from 'vitest';
import {
  createRecordingDraft,
  mergeRecordingDraftPoints,
  parseRecordingDraft,
  shouldCheckpointRecording,
} from '../recordingDraft';

const point = (timestamp: number, latitude = 45, longitude = 11) => ({
  latitude,
  longitude,
  timestamp,
});

describe('recording recovery draft', () => {
  it('checkpoints every ten newly accepted points', () => {
    expect(shouldCheckpointRecording(0, 9)).toBe(false);
    expect(shouldCheckpointRecording(0, 10)).toBe(true);
    expect(shouldCheckpointRecording(10, 19)).toBe(false);
    expect(shouldCheckpointRecording(10, 20)).toBe(true);
  });

  it('round-trips a versioned draft with markers and pause windows', () => {
    const draft = createRecordingDraft({
      sessionId: 'session-1',
      status: 'paused',
      startedAt: '2026-08-25T08:00:00.000Z',
      now: '2026-08-25T08:05:00.000Z',
      path: [point(1_000), point(2_000)],
      markers: [{ ...point(1_500), tipo: 'Porcino', name: 'Porcino_1' }],
      pauseWindows: [{ startedAt: 3_000, endedAt: null }],
    });
    expect(parseRecordingDraft(JSON.stringify(draft))).toEqual(draft);
  });

  it('rejects corrupt, incompatible and geographically invalid drafts', () => {
    expect(parseRecordingDraft('{broken')).toBeNull();
    expect(parseRecordingDraft(JSON.stringify({ schemaVersion: 99 }))).toBeNull();
    const draft = createRecordingDraft({
      sessionId: 'session-1',
      status: 'recording',
      startedAt: '2026-08-25T08:00:00.000Z',
      path: [point(1_000, 120)],
      markers: [],
      pauseWindows: [],
    });
    expect(parseRecordingDraft(JSON.stringify(draft))).toBeNull();
  });

  it('merges foreground and background points in timestamp order without duplicates', () => {
    expect(mergeRecordingDraftPoints(
      [point(2_000), point(4_000)],
      [point(1_000), point(2_000), point(3_000)],
    )).toEqual([point(1_000), point(2_000), point(3_000), point(4_000)]);
  });
});
