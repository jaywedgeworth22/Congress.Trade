import { describe, expect, it, vi } from 'vitest';
import { probeResidentialProxyHealth } from '../residentialProxyHealth.ts';

describe('probeResidentialProxyHealth', () => {
  it('returns unconfigured when no proxy URL is given', async () => {
    const result = await probeResidentialProxyHealth(undefined);
    expect(result.configured).toBe(false);
    expect(result.reachable).toBe(false);
  });

  it('returns reachable true when proxy responds with 200 JSON', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, service: 'residential-proxy', uptime: 42 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await probeResidentialProxyHealth('http://100.113.106.39:3128', mockFetch);
    expect(result.configured).toBe(true);
    expect(result.reachable).toBe(true);
    expect(result.service).toBe('residential-proxy');
    expect(result.uptime).toBe(42);
    expect(result.status).toBe(200);
  });

  it('returns reachable false when proxy returns 502', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('Bad Gateway', { status: 502 }),
    );

    const result = await probeResidentialProxyHealth('http://100.113.106.39:3128', mockFetch);
    expect(result.configured).toBe(true);
    expect(result.reachable).toBe(false);
    expect(result.status).toBe(502);
  });

  it('handles network error / timeout gracefully', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

    const result = await probeResidentialProxyHealth('http://100.113.106.39:3128', mockFetch);
    expect(result.configured).toBe(true);
    expect(result.reachable).toBe(false);
    expect(result.error).toContain('Connection refused');
  });
});
