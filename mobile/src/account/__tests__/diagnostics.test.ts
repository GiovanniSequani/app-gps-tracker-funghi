import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportAccountOperationFailure } from '../diagnostics';

describe('account diagnostics', () => {
  afterEach(() => vi.restoreAllMocks());

  it('registra solo categorie tecniche e non dati sensibili', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    reportAccountOperationFailure('gpx_download_request', {
      name: 'StorageApiError',
      status: 403,
      statusCode: '403',
      code: 'access_denied',
      message: 'token=secret path=user-id/track-id.gpx.gz email=user@example.test',
    });

    expect(warn).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(warn.mock.calls[0]);
    expect(serialized).toContain('gpx_download_request');
    expect(serialized).toContain('session_expired');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('track-id');
    expect(serialized).not.toContain('example.test');
  });
});
