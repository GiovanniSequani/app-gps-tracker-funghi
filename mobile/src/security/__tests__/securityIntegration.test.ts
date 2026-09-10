import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('integrazione hardening mobile', () => {
  const app = fs.readFileSync(path.resolve(__dirname, '../../../App.tsx'), 'utf8');
  const archive = fs.readFileSync(path.resolve(__dirname, '../../account/AccountArchiveScreen.tsx'), 'utf8');
  const rights = fs.readFileSync(path.resolve(__dirname, '../../account/useAccountRights.ts'), 'utf8');
  const auth = fs.readFileSync(path.resolve(__dirname, '../../account/supabase.ts'), 'utf8');
  const logout = fs.readFileSync(path.resolve(__dirname, '../../account/client.ts'), 'utf8');

  it('usa SecureStore per la sessione e pulisce anche al logout', () => {
    expect(auth).toContain('storage: secureAuthStorage');
    expect(auth).not.toContain('storage: AsyncStorage');
    expect(logout).toContain('finally');
    expect(logout).toContain('purgeSensitiveTempFiles()');
  });

  it('elimina GPX ed export temporanei dopo successo, annullamento o errore', () => {
    for (const source of [app, archive, rights]) {
      expect(source).toContain('deleteSensitiveTempFile');
      expect(source).toContain('finally');
    }
    expect(app).toContain('purgeSensitiveTempFiles()');
  });

  it('sospende retry offline e in background senza aggiungere comandi camera', () => {
    const retryBlock = app.slice(app.indexOf('if (!indexAccessReady || !appIsActive'), app.indexOf('// posizione iniziale'));
    expect(retryBlock).toContain('networkOnline === false');
    expect(retryBlock).toContain('TILE_BOOTSTRAP_MAX_ATTEMPTS');
    expect(retryBlock).not.toContain('runCameraCommand');
    expect(rights).toContain('!appActive || online === false');
    expect(rights).toContain('EXPORT_POLL_MAX_ATTEMPTS');
  });
});
