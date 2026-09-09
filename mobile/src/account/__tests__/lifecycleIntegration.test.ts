import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('integrazione lifecycle mobile', () => {
  const appSource = fs.readFileSync(path.resolve(__dirname, '../../../App.tsx'), 'utf8');
  const archiveSource = fs.readFileSync(path.resolve(__dirname, '../AccountArchiveScreen.tsx'), 'utf8');
  const hookSource = fs.readFileSync(path.resolve(__dirname, '../useAccountLifecycle.ts'), 'utf8');
  const cacheSource = fs.readFileSync(path.resolve(__dirname, '../lifecycleCache.ts'), 'utf8');

  it('non impartisce comandi camera e rimuove i percorsi privati solo dopo una restrizione autoritativa', () => {
    expect(appSource).toContain('const mustClearPrivateMapData = !accountSession.session || accountLifecycle.authoritativeRestriction;');
    expect(appSource).toContain('if (!indexAccessReady || !mustClearPrivateMapData) return;');
    expect(appSource).toContain('setCloudRoutesOnMap([]);');
    expect(appSource).toContain('setCloudEditRequest(null);');
    expect(appSource).toContain('setRoutesOnMap([]);');
    expect(appSource).toContain('setEditingCloudRoute(null);');
    expect(hookSource).not.toContain('camera');
  });

  it('non chiama il cloud senza full access ma mantiene disponibile il locale offline', () => {
    expect(archiveSource).toContain('!props.lifecycle.fullAccess');
    expect(archiveSource).toContain('sessionState.session && props.lifecycle.fullAccess');
    expect(archiveSource).toContain('canUseOfflineLocalArchive');
    expect(archiveSource).toContain('!props.lifecycle.authoritativeRestriction');
    expect(archiveSource).toContain('props.lifecycle.cachedFullAccessExpired');
    expect(archiveSource).toContain('<AccountLifecyclePanel');
  });

  it('verifica all avvio ma non al semplice ritorno in foreground o focus archivio', () => {
    expect(hookSource).toContain("refresh(firstResolution && userId ? 'foreground_session' : undefined)");
    expect(hookSource).not.toContain('AppState');
    expect(archiveSource).not.toContain('useFocusEffect');
    expect(hookSource).not.toContain('TOKEN_REFRESHED');
    expect(hookSource).not.toContain('deepLink');
  });

  it('mantiene lo snapshot su errore e persiste soltanto risposte server valide', () => {
    expect(hookSource).toContain("accessSource: 'cache'");
    expect(hookSource).toContain('saveAccountLifecycleSnapshot');
    expect(hookSource).toContain("accessSource: 'server'");
    expect(hookSource).toContain("conserva l'ultimo snapshot");
    expect(cacheSource).toContain('ACTIVE_ACCESS_OFFLINE_MAX_AGE_MS = 72 * 60 * 60 * 1000');
    expect(appSource).toContain('accountLifecycle.authoritativeRestriction');
  });

  it('registra il login interattivo dopo che Supabase ha applicato la sessione', () => {
    expect(archiveSource).toContain("recordMyMeaningfulActivity('interactive_login')");
    expect(archiveSource.indexOf('await signIn(email, password)')).toBeLessThan(archiveSource.indexOf("recordMyMeaningfulActivity('interactive_login')"));
    expect(archiveSource).toContain('signedInSession.user.id');
  });
});
