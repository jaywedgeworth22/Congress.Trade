import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { browserSecurityHeaders, browserSecurityHeadersMiddleware } from '../headers.ts';

describe('browserSecurityHeaders', () => {
  it('sets clickjacking, MIME, referrer, permissions, and CSP defenses', () => {
    const headers = browserSecurityHeaders('https://congress.trade/');
    expect(headers.get('x-frame-options')).toBe('DENY');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(headers.get('permissions-policy')).toContain('camera=()');
    expect(headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(headers.get('content-security-policy')).toContain("connect-src 'self'");
  });

  it('sets HSTS only for HTTPS requests', () => {
    expect(browserSecurityHeaders('https://congress.trade/').get('strict-transport-security')).toBe(
      'max-age=31536000',
    );
    expect(browserSecurityHeaders('http://localhost:8787/').get('strict-transport-security')).toBeNull();
  });

  it('documents only the current inline dashboard exceptions', () => {
    const csp = browserSecurityHeaders('https://congress.trade/').get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain('*');
  });

  it('attaches headers to a completed Hono response', async () => {
    const app = new Hono();
    app.use('*', browserSecurityHeadersMiddleware);
    app.get('/health', (c) => c.json({ ok: true }));
    const response = await app.request('https://congress.trade/health');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000');
  });
});
