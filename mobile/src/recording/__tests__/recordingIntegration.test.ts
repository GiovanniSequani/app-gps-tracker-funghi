import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const app = fs.readFileSync(path.resolve(__dirname, '../../../App.tsx'), 'utf8');
const backgroundDisclosure = fs.readFileSync(
  path.resolve(__dirname, '../BackgroundLocationDisclosureModal.tsx'),
  'utf8',
);

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
    expect(app).toContain('Registrazione attiva');
    expect(app).toContain('In pausa');
    expect(app).toContain('title="Registrazione terminata"');
    expect(app).toContain("recordingPaused ? 'Riprendi' : 'Pausa'");
    expect(app).toContain('>Termina</Text>');
    const handlers = app.slice(app.indexOf('const pauseRecording'), app.indexOf('const saveCurrentRoute'));
    expect(handlers).not.toMatch(/runCameraCommand|centerCamera|setCameraCommand/);
    expect(app.match(/<MemoMapCanvas\b/g)).toHaveLength(1);
  });

  it('shows the prominent disclosure before requesting background location', () => {
    const start = app.slice(app.indexOf('const startRecording'), app.indexOf('const pauseRecording'));
    const disclosureIndex = start.indexOf('await showBackgroundLocationDisclosure()');
    const permissionRequestIndex = start.indexOf('Location.requestBackgroundPermissionsAsync()');

    expect(start).toContain('Location.getBackgroundPermissionsAsync()');
    expect(disclosureIndex).toBeGreaterThan(-1);
    expect(permissionRequestIndex).toBeGreaterThan(disclosureIndex);
    expect(backgroundDisclosure).toContain('raccoglie dati sulla posizione');
    expect(backgroundDisclosure).toContain('anche quando l’app non è in uso');
    expect(backgroundDisclosure).toContain('registrare il percorso');
    expect(backgroundDisclosure).toContain('onRequestClose={onCancel}');
    expect(start).not.toMatch(/runCameraCommand|centerCamera|setCameraCommand/);
  });

  it('keeps the species totals out of the add buttons and in the compact findings panel', () => {
    const recordingControls = app.slice(
      app.indexOf('<View style={mStyles.bottomControls}>'),
      app.indexOf('{coordinateSelection && ('),
    );
    const findingsPanel = app.slice(
      app.indexOf('{recording && markers.length > 0 && ('),
      app.indexOf('{!editingCloudRoute && routesOnMap.length > 0 && ('),
    );
    expect(recordingControls).not.toContain('mStyles.speciesCount');
    expect(findingsPanel).toContain('mStyles.markerTotals');
    expect(findingsPanel).toContain('P {porciniCount}');
    expect(findingsPanel).toContain('F {finferliCount}');
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
