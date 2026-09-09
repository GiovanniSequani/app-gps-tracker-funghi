export const AUTH_CALLBACK_ORIGIN = 'https://web-funghi-index.pages.dev';
export const AUTH_CONFIRM_REDIRECT_URL = `${AUTH_CALLBACK_ORIGIN}/auth/confirm`;
export const AUTH_RECOVERY_REDIRECT_URL = `${AUTH_CALLBACK_ORIGIN}/auth/recovery`;

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
  const match = value.match(/^https:\/\/web-funghi-index\.pages\.dev(\/auth\/(?:confirm|recovery))(\?[^#]*)?(?:#(.*))?$/);
  if (!match) {
    return { status: 'ignored' };
  }
  const pathname = match[1];
  const queryParams = new URLSearchParams((match[2] ?? '').replace(/^\?/, ''));
  const fragmentParams = new URLSearchParams(match[3] ?? '');
  const queryHasCredential = queryParams.has('type') || queryParams.has('token_hash');
  const fragmentHasCredential = fragmentParams.has('type') || fragmentParams.has('token_hash');
  if ((queryHasCredential && fragmentHasCredential)
    || [...queryParams.keys()].some((key) => key !== 'type' && key !== 'token_hash')
    || [...fragmentParams.keys()].some((key) => key !== 'type' && key !== 'token_hash')) {
    return { status: 'invalid' };
  }

  const params = fragmentHasCredential ? fragmentParams : queryParams;
  const types = params.getAll('type');
  const tokenHashes = params.getAll('token_hash');
  const tokenHash = tokenHashes[0]?.trim() ?? '';
  if (types.length !== 1 || tokenHashes.length !== 1 || !isValidTokenHash(tokenHash)) {
    return { status: 'invalid' };
  }

  if (pathname === '/auth/confirm' && CONFIRM_TYPES.has(types[0])) {
    return {
      status: 'valid',
      request: { kind: 'confirm', type: types[0] as 'email' | 'signup', tokenHash },
    };
  }
  if (pathname === '/auth/recovery' && types[0] === 'recovery') {
    return {
      status: 'valid',
      request: { kind: 'recovery', type: 'recovery', tokenHash },
    };
  }
  return { status: 'invalid' };
}
