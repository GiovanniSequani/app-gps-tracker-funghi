import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('integrazione lifecycle mobile', () => {
  const appSource = fs.readFileSync(path.resolve(__dirname, '../../../App.tsx'), 'utf8');
  const archiveSource = fs.readFileSync(path.resolve(__dirname, '../AccountArchiveScreen.tsx'), 'utf8');
  const hookSource = fs.readFileSync(path.resolve(__dirname, '../useAccountLifecycle.ts'), 'utf8');

  it('non impartisce comandi camera e rimuove i percorsi privati solo dopo la verifica accesso', () => {
    expect(appSource).toContain('if (!indexAccessReady || fullIndexAccess) return;');
    expect(appSource).toContain('setCloudRoutesOnMap([]);');
    expect(appSource).toContain('setCloudEditRequest(null);');
    expect(appSource).toContain('setRoutesOnMap([]);');
    expect(appSource).toContain('setEditingCloudRoute(null);');
    expect(hookSource).not.toContain('camera');
  });

  it('non carica né mostra archivio privato senza full access', () => {
    expect(archiveSource).toContain('!props.lifecycle.fullAccess');
    expect(archiveSource).toContain('sessionState.session && props.lifecycle.fullAccess');
    expect(archiveSource).toContain('<AccountLifecyclePanel');
  });

  it('rivalida foreground senza classificare deep link o token refresh come attività', () => {
    expect(hookSource).toContain("refresh('foreground_session')");
    expect(hookSource).toContain("refresh(first && session ? 'foreground_session' : undefined)");
    expect(hookSource).not.toContain('TOKEN_REFRESHED');
    expect(hookSource).not.toContain('deepLink');
  });

  it('registra il login interattivo dopo che Supabase ha applicato la sessione', () => {
    expect(archiveSource).toContain("recordMyMeaningfulActivity('interactive_login')");
    expect(archiveSource.indexOf('await signIn(email, password)')).toBeLessThan(archiveSource.indexOf("recordMyMeaningfulActivity('interactive_login')"));
  });
});
