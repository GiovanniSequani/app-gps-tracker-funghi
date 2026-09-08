export type RecordingStatus = 'idle' | 'recording' | 'paused';

export type RecordingEvent = 'start' | 'pause' | 'resume' | 'stop';

export type RecordingPauseWindow = {
  startedAt: number;
  endedAt: number | null;
};

export function isRecordingSession(status: RecordingStatus): boolean {
  return status !== 'idle';
}

export function canAppendRecordingPoint(status: RecordingStatus): boolean {
  return status === 'recording';
}

export function isTimestampPaused(timestamp: number, windows: RecordingPauseWindow[]): boolean {
  return windows.some((window) => (
    timestamp >= window.startedAt
    && (window.endedAt === null || timestamp <= window.endedAt)
  ));
}

export function nextRecordingStatus(status: RecordingStatus, event: RecordingEvent): RecordingStatus {
  if (event === 'start' && status === 'idle') return 'recording';
  if (event === 'pause' && status === 'recording') return 'paused';
  if (event === 'resume' && status === 'paused') return 'recording';
  if (event === 'stop' && status !== 'idle') return 'idle';
  return status;
}
