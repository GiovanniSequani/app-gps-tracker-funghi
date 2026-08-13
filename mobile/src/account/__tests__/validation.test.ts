import { describe, expect, it } from 'vitest';
import {
  normalizeTrackName,
  normalizeUsername,
  safeGpxName,
  toAccountError,
  validateTrackName,
  validateUsername,
} from '../validation';

describe('account validation', () => {
  it('normalizza e valida lo username del contratto', () => {
    expect(normalizeUsername('  Mario_Rossi ')).toBe('mario_rossi');
    expect(validateUsername('mario_rossi')).toBeNull();
    expect(validateUsername('Mario-Rossi')).toContain('3-24');
    expect(validateUsername('ab')).toContain('3-24');
  });

  it('traduce gli errori account principali', () => {
    expect(toAccountError({ message: 'Invalid login credentials' }).code).toBe('invalid_credentials');
    expect(toAccountError({ code: 'weak_password', message: 'weak' }).code).toBe('weak_password');
    expect(toAccountError({ message: 'duplicate username' }).code).toBe('duplicate_username');
    expect(toAccountError({ message: 'GPX track quota exceeded' }).code).toBe('quota_exceeded');
    expect(toAccountError(new TypeError('Network request failed')).code).toBe('network');
  });

  it('rende sicuro il nome GPX senza consentire path', () => {
    expect(safeGpxName('../bosco:sera.gpx.gz')).toBe('..-bosco-sera');
  });

  it('applica il contratto condiviso del nome traccia', () => {
    expect(normalizeTrackName('  Bosco serale  ')).toBe('Bosco serale');
    expect(validateTrackName('Bosco serale')).toBeNull();
    expect(validateTrackName('')).toContain('1 a 120');
    expect(validateTrackName('cartella/bosco')).toContain('/');
    expect(validateTrackName('cartella\\bosco')).toContain('\\');
    expect(validateTrackName('x'.repeat(121))).toContain('1 a 120');
  });

  it('traduce gli errori di rename senza confonderli con username o rete', () => {
    expect(toAccountError({ message: 'invalid display_name' }).code).toBe('invalid_track_name');
    expect(toAccountError({ message: 'track not found' }).code).toBe('track_not_found');
    expect(toAccountError({ status: 401, message: 'JWT expired' }).code).toBe('session_expired');
  });
});
