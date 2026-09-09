import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTH_CONFIRM_REDIRECT_URL,
  AUTH_RECOVERY_REDIRECT_URL,
  isUsedOrExpiredTokenError,
  parseAuthCallbackUrl,
} from '../authCallbacks';

const tokenHash = 'AbCdEf0123456789_-AbCdEf0123456789';

describe('callback Auth mobile', () => {
  it('accetta soltanto le coppie callback e type previste', () => {
    expect(parseAuthCallbackUrl(`${AUTH_CONFIRM_REDIRECT_URL}#token_hash=${tokenHash}&type=email`))
      .toEqual({ status: 'valid', request: { kind: 'confirm', type: 'email', tokenHash } });
    expect(parseAuthCallbackUrl(`${AUTH_CONFIRM_REDIRECT_URL}#type=signup&token_hash=token-signup`))
      .toEqual({ status: 'valid', request: { kind: 'confirm', type: 'signup', tokenHash: 'token-signup' } });
    expect(parseAuthCallbackUrl(`${AUTH_RECOVERY_REDIRECT_URL}#type=recovery&token_hash=${tokenHash}`))
      .toEqual({ status: 'valid', request: { kind: 'recovery', type: 'recovery', tokenHash } });
    expect(parseAuthCallbackUrl(`${AUTH_CONFIRM_REDIRECT_URL}#token_hash=${tokenHash}&type=recovery`)).toEqual({ status: 'invalid' });
    expect(parseAuthCallbackUrl(`${AUTH_RECOVERY_REDIRECT_URL}?token_hash=${tokenHash}&type=email`)).toEqual({ status: 'invalid' });
  });

  it('rifiuta token mancanti, malformati, duplicati e parametri extra', () => {
    expect(parseAuthCallbackUrl(`${AUTH_CONFIRM_REDIRECT_URL}#type=email`)).toEqual({ status: 'invalid' });
    expect(parseAuthCallbackUrl(`${AUTH_CONFIRM_REDIRECT_URL}#type=email&token_hash=token%20con%20spazi`)).toEqual({ status: 'invalid' });
    expect(parseAuthCallbackUrl(`${AUTH_CONFIRM_REDIRECT_URL}#type=email&token_hash=${'a'.repeat(2049)}`)).toEqual({ status: 'invalid' });
    expect(parseAuthCallbackUrl(`${AUTH_CONFIRM_REDIRECT_URL}#type=email&type=email&token_hash=${tokenHash}`)).toEqual({ status: 'invalid' });
    expect(parseAuthCallbackUrl(`${AUTH_CONFIRM_REDIRECT_URL}#type=email&token_hash=${tokenHash}&access_token=secret`)).toEqual({ status: 'invalid' });
    expect(parseAuthCallbackUrl(`${AUTH_CONFIRM_REDIRECT_URL}?type=email&token_hash=query#type=email&token_hash=fragment`)).toEqual({ status: 'invalid' });
  });

  it('ignora link non Auth senza intercettare altre funzioni dell’app', () => {
    expect(parseAuthCallbackUrl('https://example.test/auth/confirm#type=email&token_hash=token')).toEqual({ status: 'ignored' });
    expect(parseAuthCallbackUrl('funghitracker://auth/confirm?type=email&token_hash=token')).toEqual({ status: 'ignored' });
    expect(parseAuthCallbackUrl('funghitracker://map/point?lat=45')).toEqual({ status: 'ignored' });
    expect(parseAuthCallbackUrl('funghitracker://auth/unknown')).toEqual({ status: 'ignored' });
  });

  it('riconosce gli errori di token scaduto, invalido o già usato', () => {
    expect(isUsedOrExpiredTokenError({ code: 'otp_expired' })).toBe(true);
    expect(isUsedOrExpiredTokenError(new Error('Token already used'))).toBe(true);
    expect(isUsedOrExpiredTokenError(new Error('Invalid OTP token'))).toBe(true);
    expect(isUsedOrExpiredTokenError(new Error('Internal server error'))).toBe(false);
  });

  it('gestisce sia cold start sia link ricevuti con app aperta senza verificare automaticamente', () => {
    const hook = fs.readFileSync(path.resolve(__dirname, '../useAuthDeepLinks.ts'), 'utf8');
    const modal = fs.readFileSync(path.resolve(__dirname, '../AuthCallbackModal.tsx'), 'utf8');
    expect(hook).toContain('Linking.getInitialURL()');
    expect(hook).toContain("Linking.addEventListener('url'");
    expect(hook).not.toContain('verifyOtp');
    expect(modal).toContain('onPress={() => void approve()}');
    expect(modal.indexOf('await verifyAuthCallback(request)')).toBeGreaterThan(modal.indexOf('const approve'));
  });

  it('non conserva il deep link grezzo e rimuove lo stato esterno dopo l’acquisizione', () => {
    const hook = fs.readFileSync(path.resolve(__dirname, '../useAuthDeepLinks.ts'), 'utf8');
    const modal = fs.readFileSync(path.resolve(__dirname, '../AuthCallbackModal.tsx'), 'utf8');
    expect(hook).not.toMatch(/setState\([^\n]*url/);
    expect(modal).toContain('props.onAcquired()');
    expect(modal).toContain('requestRef.current = null');
  });

  it('non scrive nei log URL Auth, token o email', () => {
    const directory = path.resolve(__dirname, '..');
    const authSources = ['authCallbacks.ts', 'useAuthDeepLinks.ts', 'AuthCallbackModal.tsx', 'client.ts']
      .map((name) => fs.readFileSync(path.join(directory, name), 'utf8'))
      .join('\n');
    expect(authSources).not.toMatch(/console\.(?:log|info|warn|error|debug)/);
  });

  it('dichiara App Links e Universal Links limitati alle callback Auth', () => {
    const config = fs.readFileSync(path.resolve(__dirname, '../../../app.config.js'), 'utf8');
    const appJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../app.json'), 'utf8'));
    expect(config).toContain("associatedDomains: ['applinks:web-funghi-index.pages.dev']");
    expect(config).toContain('autoVerify: true');
    expect(config).toContain("pathPrefix: '/auth/confirm'");
    expect(config).toContain("pathPrefix: '/auth/recovery'");
    expect(appJson.expo.version).toBe('1.8.0');
    expect(appJson.expo.android.versionCode).toBe(12);
    expect(appJson.expo.ios.buildNumber).toBe('12');
  });
});
