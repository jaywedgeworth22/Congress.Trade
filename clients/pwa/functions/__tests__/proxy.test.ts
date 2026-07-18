import { afterEach, describe, expect, it, vi } from 'vitest';
import { proxyToWorker } from '../_proxy';

describe('proxyToWorker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards to the worker origin and strips cookie domains from upstream responses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', {
        status: 302,
        headers: {
          Location: 'https://accounts.google.com/o/oauth2/v2/auth',
          'Set-Cookie': 'ct_oauth_state=abc; Domain=congress.trade; Path=/; HttpOnly; Secure; SameSite=Lax',
        },
      }),
    );

    const response = await proxyToWorker(
      new Request('https://pwa.congress.trade/auth/google/start?origin=https%3A%2F%2Fpwa.congress.trade', {
        headers: { cookie: 'ct_session=tok' },
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const forwarded = fetchMock.mock.calls[0][0] as Request;
    expect(new URL(forwarded.url).origin).toBe('https://congress.trade');
    expect(new URL(forwarded.url).pathname).toBe('/auth/google/start');
    expect(new URL(forwarded.url).search).toBe('?origin=https%3A%2F%2Fpwa.congress.trade');
    expect(response.status).toBe(302);
    expect(response.headers.get('set-cookie')).toBe(
      'ct_oauth_state=abc; Path=/; HttpOnly; Secure; SameSite=Lax',
    );
  });
});
