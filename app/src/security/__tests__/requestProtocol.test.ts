import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { isSecureRequestParts, isSecureRequest } from '../requestProtocol.ts';
import { browserSecurityHeadersMiddleware } from '../headers.ts';

describe('isSecureRequestParts', () => {
  it('returns true when X-Forwarded-Proto is https', () => {
    expect(isSecureRequestParts('https', 'congress.trade', 'http://127.0.0.1:5000/')).toBe(true);
    expect(isSecureRequestParts('https,http', 'congress.trade', 'http://127.0.0.1:5000/')).toBe(true);
  });

  it('fails closed for non-loopback hosts when X-Forwarded-Proto is missing or http', () => {
    expect(isSecureRequestParts('http', 'congress.trade', 'http://127.0.0.1:5000/')).toBe(true);
    expect(isSecureRequestParts(undefined, 'congress.trade', 'http://127.0.0.1:5000/')).toBe(true);
    expect(isSecureRequestParts(undefined, 'admin.congress.trade', 'http://127.0.0.1:5000/')).toBe(true);
  });

  it('returns true for direct https URL', () => {
    expect(isSecureRequestParts(undefined, undefined, 'https://congress.trade/')).toBe(true);
  });

  it('returns false only for developer loopback hosts when unencrypted', () => {
    expect(isSecureRequestParts('http', 'localhost:8787', 'http://localhost:8787/')).toBe(false);
    expect(isSecureRequestParts(undefined, '127.0.0.1:5000', 'http://127.0.0.1:5000/')).toBe(false);
    expect(isSecureRequestParts(undefined, '::1', 'http://[::1]:5000/')).toBe(false);
    expect(isSecureRequestParts(undefined, 'app.localhost', 'http://app.localhost/')).toBe(false);
  });
});

describe('isSecureRequest Hono context integration', () => {
  it('correctly reads headers from Hono request context', async () => {
    const app = new Hono();
    let capturedSecure = false;

    app.get('/test', (c) => {
      capturedSecure = isSecureRequest(c);
      return c.text('ok');
    });

    await app.request('http://127.0.0.1:5000/test', {
      headers: {
        Host: 'congress.trade',
        'X-Forwarded-Proto': 'https',
      },
    });
    expect(capturedSecure).toBe(true);
  });
});

describe('browserSecurityHeadersMiddleware with proxy TLS', () => {
  it('adds Strict-Transport-Security when X-Forwarded-Proto is https', async () => {
    const app = new Hono();
    app.use('*', browserSecurityHeadersMiddleware);
    app.get('/test', (c) => c.text('ok'));

    const res = await app.request('http://127.0.0.1:5000/test', {
      headers: {
        Host: 'congress.trade',
        'X-Forwarded-Proto': 'https',
      },
    });

    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
  });

  it('adds Strict-Transport-Security for production domain even if container socket is http', async () => {
    const app = new Hono();
    app.use('*', browserSecurityHeadersMiddleware);
    app.get('/test', (c) => c.text('ok'));

    const res = await app.request('http://127.0.0.1:5000/test', {
      headers: {
        Host: 'congress.trade',
      },
    });

    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
  });
});
