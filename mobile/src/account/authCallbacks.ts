export const AUTH_CONFIRM_REDIRECT_URL = 'https://web-funghi-index.pages.dev/auth/mobile-confirm';
export const AUTH_CONFIRM_DEEP_LINK_URL = 'funghitracker://auth/confirm';
export const AUTH_RECOVERY_REDIRECT_URL = 'funghitracker://auth/recovery';

export type AuthCallbackRequest =
  | { kind: 'confirm'; type: 'email' | 'signup'; tokenHash: string }
  | { kind: 'recovery'; type: 'recovery'; tokenHash: string };

export type AuthCallbackParseResult =
  | { status: 'ignored' }
  | { status: 'invalid' }
  | { status: 'valid'; request: AuthCallbackRequest };

export function isUsedOrExpiredTokenError(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string };
  return /expired|invalid.*(?:token|otp)|(?:token|otp).*invalid|already.*used|otp_expired/i
    .test(`${candidate?.code ?? ''} ${candidate?.message ?? ''}`);
}

const CONFIRM_TYPES = new Set(['email', 'signup']);

function isValidTokenHash(value: string): boolean {
  return value.length > 0
    && value.length <= 2048
    && !/[\s\u0000-\u001f]/u.test(value);
}

export function parseAuthCallbackUrl(value: string): AuthCallbackParseResult {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value.toLowerCase().startsWith('funghitracker://auth/')
      ? { status: 'invalid' }
      : { status: 'ignored' };
  }

  if (url.protocol !== 'funghitracker:' || url.hostname !== 'auth') {
    return { status: 'ignored' };
  }

  if (url.pathname !== '/confirm' && url.pathname !== '/recovery') {
    return { status: 'invalid' };
  }
  if (url.hash || [...url.searchParams.keys()].some((key) => key !== 'type' && key !== 'token_hash')) {
    return { status: 'invalid' };
  }

  const types = url.searchParams.getAll('type');
  const tokenHashes = url.searchParams.getAll('token_hash');
  const tokenHash = tokenHashes[0]?.trim() ?? '';
  if (types.length !== 1 || tokenHashes.length !== 1 || !isValidTokenHash(tokenHash)) {
    return { status: 'invalid' };
  }

  if (url.pathname === '/confirm' && CONFIRM_TYPES.has(types[0])) {
    return {
      status: 'valid',
      request: { kind: 'confirm', type: types[0] as 'email' | 'signup', tokenHash },
    };
  }
  if (url.pathname === '/recovery' && types[0] === 'recovery') {
    return {
      status: 'valid',
      request: { kind: 'recovery', type: 'recovery', tokenHash },
    };
  }
  return { status: 'invalid' };
}
