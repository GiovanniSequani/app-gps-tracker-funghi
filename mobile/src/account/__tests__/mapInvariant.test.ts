import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('account archive map invariants', () => {
  it('non introduce comandi camera nel modulo account', () => {
    const directory = path.resolve(__dirname, '..');
    const source = fs.readdirSync(directory)
      .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))
      .map((name) => fs.readFileSync(path.join(directory, name), 'utf8'))
      .join('\n');
    expect(source).not.toMatch(/runCameraCommand|centerCamera|setCameraCommand|MapView/);
  });

  it('non passa la sessione account al componente MapLibre', () => {
    const app = fs.readFileSync(path.resolve(__dirname, '../../../App.tsx'), 'utf8');
    const mainUiCall = app.match(/<MainUI[\s\S]*?\/>/)?.[0] ?? '';
    expect(mainUiCall).not.toContain('accountSession');
    expect(app).toContain('onShowTrackOnMap={showCloudTrackOnMap}');
    expect(app).not.toMatch(/showCloudTrackOnMap[\s\S]{0,800}runCameraCommand/);
  });

  it('usa la gerarchia archivio richiesta e un unico componente per le righe', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../AccountArchiveScreen.tsx'), 'utf8');
    expect(source).toContain('Percorsi salvati');
    expect(source).toContain('Percorsi non salvati nell’archivio');
    expect(source).toContain('Salvare i percorsi nell’archivio');
    expect(source).not.toContain('Tracce nel cloud');
    expect(source.match(/<TrackRow/g)?.length).toBe(2);
    expect(source).toContain("porcini} porcini");
    expect(source).toContain("finferli} finferli");
  });

  it('mostra gli esiti normali come toast temporanei e lascia inline solo gli errori', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../AccountArchiveScreen.tsx'), 'utf8');
    expect(source).toContain('styles.noticeToast');
    expect(source).toContain('setTimeout(() =>');
    expect(source).toContain('setNotice(null)');
    expect(source).not.toContain('{notice && <Text');
    expect(source).toContain('{error && <View style={styles.errorBox}>');
  });

  it('chiede il nome nei flussi di salvataggio e distingue le azioni locali dal cloud', () => {
    const app = fs.readFileSync(path.resolve(__dirname, '../../../App.tsx'), 'utf8');
    const source = fs.readFileSync(path.resolve(__dirname, '../AccountArchiveScreen.tsx'), 'utf8');
    expect(app).toContain('<TrackNameModal');
    expect(app).toContain('saveCurrentRoute(recordingName)');
    expect(source).toContain("openNameAction({ kind: 'import'");
    expect(source).toContain("openNameAction({ kind: 'rename'");
    expect(source).toContain("openNameAction({ kind: 'localUpload'");
    expect(source).toContain("source=\"cloud\"");
    expect(source).toContain("source=\"local\"");
    expect(source).toContain('La cancellazione non modifica l’archivio cloud.');
    expect(source).toContain('await deleteRoute(route.routeId)');
  });
});
