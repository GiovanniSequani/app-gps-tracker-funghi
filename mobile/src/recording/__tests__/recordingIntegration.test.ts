import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const app = fs.readFileSync(path.resolve(__dirname, '../../../App.tsx'), 'utf8');

describe('recording pause integration', () => {
  it('gates both foreground and background points while paused', () => {
    expect(app).toContain('canAppendRecordingPoint(recordingStatusRef.current)');
    expect(app.match(/canAppendRecordingPoint\(.*RecordingStatus/g)?.length).toBeGreaterThanOrEqual(2);
    expect(app).toContain('isTimestampPaused(p.timestamp ?? 0, recordingPauseWindowsRef.current)');
    expect(app).toContain("await persistRecordingStatus('paused')");
    expect(app).toContain('await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME)');
  });

  it('restarts the same background task and keeps the current path on resume', () => {
    const resume = app.slice(app.indexOf('const resumeRecording'), app.indexOf('const saveCurrentRoute'));
    expect(resume).toContain('Location.startLocationUpdatesAsync(LOCATION_TASK_NAME');
    expect(resume).not.toMatch(/setPath\(\[\]\)|setMarkers\(\[\]\)/);
    expect(app).toContain('saveCurrentRoute(recordingName)');
  });

  it('shows clear pause, resume and finish actions without camera commands', () => {
    expect(app).toContain('REGISTRAZIONE ATTIVA');
    expect(app).toContain('REGISTRAZIONE IN PAUSA');
    expect(app).toContain('title="Registrazione terminata"');
    expect(app).toContain("recordingPaused ? 'RIPRENDI' : 'PAUSA'");
    expect(app).toContain('>TERMINA</Text>');
    const handlers = app.slice(app.indexOf('const pauseRecording'), app.indexOf('const saveCurrentRoute'));
    expect(handlers).not.toMatch(/runCameraCommand|centerCamera|setCameraCommand/);
    expect(app.match(/<MemoMapCanvas\b/g)).toHaveLength(1);
  });

  it('creates durable checkpoints every ten points and forces them at lifecycle boundaries', () => {
    expect(app).toContain('shouldCheckpointRecording(');
    expect(app).toContain("checkpointRecordingDraft('paused', { force: true");
    expect(app).toContain("checkpointRecordingDraft('interrupted', {");
    expect(app).toContain("AppState.addEventListener('change'");
    expect(app).toContain('RECORDING_BACKGROUND_POSITIONS_FILE');
    expect(app).not.toContain('cacheDirectory}bg_positions.json');
  });

  it('offers recovery save, resume and discard without moving the map', () => {
    const recovery = app.slice(
      app.indexOf('const resumeRecoveredRecording'),
      app.indexOf('const combinedRoutesOnMap'),
    );
    expect(app).toContain('<RecordingRecoveryModal');
    expect(recovery).toContain('hydrateRecordingDraft(recoveryDraft)');
    expect(recovery).toContain('await resumeRecording()');
    expect(recovery).toContain('setRecordingNameVisible(true)');
    expect(recovery).toContain('clearRecordingDraft()');
    expect(recovery).not.toMatch(/runCameraCommand|centerCamera|setCameraCommand/);
  });

  it('treats cancelling the final save as a deliberate discard', () => {
    const cancel = app.slice(
      app.indexOf('const cancelRecordingSave'),
      app.indexOf('const combinedRoutesOnMap'),
    );
    expect(app).toContain('onCancel={cancelRecordingSave}');
    expect(cancel).toContain('clearRecordingDraft()');
    expect(cancel).toContain('pendingFinishedDraftRef.current = null');
    expect(cancel).toContain('setPath([])');
    expect(cancel).not.toContain('setRecoveryDraft(pendingDraft)');
    expect(cancel).not.toMatch(/runCameraCommand|centerCamera|setCameraCommand/);
  });
});
