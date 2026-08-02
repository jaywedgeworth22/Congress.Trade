import { describe, it, expect } from 'vitest';
import { buildAuthRouter } from '../routes.ts';

describe('/auth/google/start reverse proxy handling', () => {
  it('does not infinitely redirect to /auth/google/start when proxying behind HTTPS host', async () => {
    const router = buildAuthRouter();
    const env = {
      GOOGLE_OAUTH_CLIENT_ID: 'test-client-id',
      GOOGLE_OAUTH_CLIENT_SECRET: 'test-client-secret',
    } as any;

    const res = await router.request('http://127.0.0.1:5000/google/start', {
      headers: {
        'Host': 'congress.trade',
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'congress.trade',
      },
    }, env);

    expect(res.status).toBe(302);
    const location = res.headers.get('Location');
    expect(location).not.toBe('https://congress.trade/auth/google/start');
    expect(location).toContain('accounts.google.com');

    // Assert Set-Cookie attributes for proxy HTTPS traffic
    const setCookies = res.headers.getSetCookie();
    expect(setCookies.length).toBeGreaterThanOrEqual(2);

    const authOriginCookie = setCookies.find((c) => c.includes('ct_auth_origin'));
    const oauthStateCookie = setCookies.find((c) => c.includes('ct_oauth_state'));

    expect(authOriginCookie).toBeDefined();
    expect(authOriginCookie).toContain('__Host-ct_auth_origin=https%3A%2F%2Fcongress.trade');
    expect(authOriginCookie).toContain('Secure');

    expect(oauthStateCookie).toBeDefined();
    expect(oauthStateCookie).toContain('__Host-ct_oauth_state=');
    expect(oauthStateCookie).toContain('Secure');
  });
});
