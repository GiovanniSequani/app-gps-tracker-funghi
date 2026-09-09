import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('integrazione diritti account mobile', () => {
  const app = fs.readFileSync(path.resolve(__dirname, '../../../App.tsx'), 'utf8');
  const archive = fs.readFileSync(path.resolve(__dirname, '../AccountArchiveScreen.tsx'), 'utf8');
  const lifecyclePanel = fs.readFileSync(path.resolve(__dirname, '../AccountLifecyclePanel.tsx'), 'utf8');
  const rightsPanel = fs.readFileSync(path.resolve(__dirname, '../AccountRightsPanel.tsx'), 'utf8');
  const rightsHook = fs.readFileSync(path.resolve(__dirname, '../useAccountRights.ts'), 'utf8');

  it('mantiene diritti per account sospeso e non polla completion dopo deletion_pending', () => {
    expect(rightsPanel).toContain("props.accountState === 'restricted'");
    expect(rightsPanel).toContain("props.accountState === 'deletion_pending'");
    expect(rightsHook).toContain("['pending', 'building', 'retry']");
    expect(rightsHook).not.toContain('deletion_pending');
    expect(rightsHook).toContain('setAppActive');
    expect(rightsHook).toContain('[appActive, enabled, job, refresh]');
    expect(rightsPanel).toContain('non indica che il processo sia già completato');
  });

  it('purga soltanto UI privata e non aggiunge comandi camera o remount', () => {
    expect(app).toContain('setCloudRoutesOnMap([]);');
    expect(app).toContain('setCloudEditRequest(null);');
    expect(app).not.toContain('accountLifecycle.fullAccess) { runCameraCommand');
    expect(archive).toContain('<AccountRightsPanel');
    expect(lifecyclePanel).toContain('<AccountRightsPanel');
  });

  it('non registra o mostra token, email o URL di eliminazione', () => {
    const sources = [rightsPanel, rightsHook, fs.readFileSync(path.resolve(__dirname, '../rightsClient.ts'), 'utf8')].join('\n');
    expect(sources).not.toMatch(/console\.(?:log|info|warn|error|debug)/);
    expect(sources).not.toContain('AsyncStorage');
  });

  it('mantiene logout disponibile nella schermata limitata e non finge una cancellazione interrotta', () => {
    expect(lifecyclePanel).toContain('onSignOut');
    expect(archive).toContain('onSignOut={() => runLifecycle(signOut)}');
    expect(rightsPanel).toContain('Questa schermata non indica che il processo sia già completato');
  });

  it('informa sulla notifica export e mantiene disponibile il controllo manuale', () => {
    expect(rightsPanel).toContain('Riceverai un’email quando sarà pronto');
    expect(rightsPanel).toContain('puoi anche controllare qui con Aggiorna');
    expect(rightsPanel).not.toContain('La notifica email non è ancora attiva');
  });
});
