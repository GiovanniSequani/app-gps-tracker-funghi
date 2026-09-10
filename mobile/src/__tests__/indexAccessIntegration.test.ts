import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('integrazione accesso indice e mappa', () => {
  const app = fs.readFileSync(path.resolve(__dirname, '../../App.tsx'), 'utf8');
  const popup = fs.readFileSync(path.resolve(__dirname, '../index-data/IndexPopupSummary.tsx'), 'utf8');
  const archive = fs.readFileSync(path.resolve(__dirname, '../account/AccountArchiveScreen.tsx'), 'utf8');

  it('usa tile e valore puntuale ritardati senza full access', () => {
    expect(app).toContain('filterTileSetsForIndexAccess(available, fullIndexAccess)');
    expect(popup).toContain('useIndexHistory(point, !fullIndexAccess)');
    expect(popup).toContain('selectLimitedIndexDay');
  });

  it('non apre analisi e non mostra archivio locale al guest', () => {
    expect(app).toContain('if (!fullIndexAccess)');
    expect(app).toContain('onShowIndexAccessNotice()');
    expect(archive).toContain('localRoutes.length > 0 && canReadLocalArchive');
    expect(archive).toContain('sessionState.session\n    && !props.lifecycle.fullAccess');
    expect(archive).toContain('!props.lifecycle.authoritativeRestriction');
  });

  it('mantiene MapLibre montato mentre mostra l’avviso accesso', () => {
    expect(app.indexOf('<IndexAccessNoticeModal')).toBeGreaterThan(app.indexOf('<NavigationContainer'));
    expect(app).not.toContain('key={fullIndexAccess}');
  });

  it('non ricarica la selezione tile durante una semplice rivalidazione e rimuove il livello recente alla perdita di accesso', () => {
    expect(app).toContain('loadedTileAccessLevelRef.current === fullIndexAccess');
    expect(app).toContain("loadedTileAccessLevelRef.current === true && !fullIndexAccess");
    expect(app).toContain('fullIndexAccess, indexAccessReady, networkOnline, tileBootstrapRevision');
    expect(app).toContain("setTileDate('')");
    expect(app).toContain("setTileVersion('')");
  });

  it('ritenta il bootstrap delle tile dopo un errore di rete senza impartire comandi camera', () => {
    expect(app).toContain('networkOnline === false || tilesLoading || !tilesError');
    expect(app).toContain('setTileBootstrapRevision((current) => current + 1);');
    expect(app).toContain('TILE_BOOTSTRAP_MAX_ATTEMPTS');
    expect(app).toContain('backoffDelayMs');
    expect(app).not.toContain(`${'?' + 't='}${'${Date.now()}'}`);
    const retryEffect = app.slice(
      app.indexOf('if (!indexAccessReady || !appIsActive'),
      app.indexOf('// posizione iniziale'),
    );
    expect(retryEffect).not.toContain('runCameraCommand');
  });
});
