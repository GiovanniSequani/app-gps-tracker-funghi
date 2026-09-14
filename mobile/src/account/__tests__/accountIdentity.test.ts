import { describe, expect, it } from 'vitest';
import { shouldClearPrivateLocalData } from '../accountIdentity';

describe('account identity boundaries', () => {
  it('non pulisce durante il bootstrap o il refresh dello stesso account', () => {
    expect(shouldClearPrivateLocalData(undefined, 'user-a')).toBe(false);
    expect(shouldClearPrivateLocalData('user-a', 'user-a')).toBe(false);
  });

  it('pulisce su logout, sessione scaduta e cambio account', () => {
    expect(shouldClearPrivateLocalData('user-a', null)).toBe(true);
    expect(shouldClearPrivateLocalData('user-a', 'user-b')).toBe(true);
    expect(shouldClearPrivateLocalData(null, 'user-b')).toBe(true);
  });
});
