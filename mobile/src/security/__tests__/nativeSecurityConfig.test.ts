import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { addBackupExclusionToSwift } = require('../../../plugins/withSensitiveDataBackupExclusion');

describe('configurazione sicurezza nativa', () => {
  it('disabilita backup Android e OTA non firmati', () => {
    const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../app.json'), 'utf8'));
    expect(config.expo.android.allowBackup).toBe(false);
    expect(config.expo.updates.enabled).toBe(false);
    expect(config.expo.plugins).toContain('./plugins/withSensitiveDataBackupExclusion');
  });

  it('inietta esclusione backup per Documents e Application Support iOS', () => {
    const source = `import Expo\nclass AppDelegate: ExpoAppDelegate {\n  override func application() -> Bool {\n    let result = true\n    return result\n  }\n}`;
    const transformed = addBackupExclusionToSwift(source);
    expect(transformed).toContain('excludeSensitiveDataFromBackup()');
    expect(transformed).toContain('.documentDirectory');
    expect(transformed).toContain('.applicationSupportDirectory');
    expect(transformed).toContain('isExcludedFromBackup = true');
  });
});
