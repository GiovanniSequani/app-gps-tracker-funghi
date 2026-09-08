import { describe, expect, it } from 'vitest';
import {
  canAppendRecordingPoint,
  isRecordingSession,
  isTimestampPaused,
  nextRecordingStatus,
  type RecordingStatus,
} from '../recordingState';

describe('recording pause state', () => {
  it('keeps one recording session across pause and resume', () => {
    let status: RecordingStatus = 'idle';
    status = nextRecordingStatus(status, 'start');
    expect(status).toBe('recording');
    expect(isRecordingSession(status)).toBe(true);
    status = nextRecordingStatus(status, 'pause');
    expect(status).toBe('paused');
    expect(isRecordingSession(status)).toBe(true);
    status = nextRecordingStatus(status, 'resume');
    expect(status).toBe('recording');
    status = nextRecordingStatus(status, 'stop');
    expect(status).toBe('idle');
    expect(isRecordingSession(status)).toBe(false);
  });

  it('accepts points only while actively recording', () => {
    expect(canAppendRecordingPoint('idle')).toBe(false);
    expect(canAppendRecordingPoint('paused')).toBe(false);
    expect(canAppendRecordingPoint('recording')).toBe(true);
  });

  it('excludes every point collected during a pause window', () => {
    const windows = [{ startedAt: 1_000, endedAt: 2_000 }];
    expect(isTimestampPaused(999, windows)).toBe(false);
    expect(isTimestampPaused(1_000, windows)).toBe(true);
    expect(isTimestampPaused(1_500, windows)).toBe(true);
    expect(isTimestampPaused(2_000, windows)).toBe(true);
    expect(isTimestampPaused(2_001, windows)).toBe(false);
    expect(isTimestampPaused(9_000, [{ startedAt: 8_000, endedAt: null }])).toBe(true);
  });

  it('ignores invalid or repeated transitions', () => {
    expect(nextRecordingStatus('idle', 'pause')).toBe('idle');
    expect(nextRecordingStatus('paused', 'pause')).toBe('paused');
    expect(nextRecordingStatus('recording', 'resume')).toBe('recording');
    expect(nextRecordingStatus('idle', 'stop')).toBe('idle');
  });
});
