import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiGet } from '../clientApi';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('client API response handling', () => {
  it('returns valid JSON responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ok: true })));
    await expect(apiGet<{ ok: boolean }>('/bootstrap')).resolves.toEqual({ ok: true });
  });

  it('preserves structured API error messages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(
      { error: 'Too many requests' },
      { status: 429 },
    )));
    await expect(apiGet('/feed')).rejects.toMatchObject({
      message: 'Too many requests',
      status: 429,
    });
  });

  it('turns an HTML error page into a readable availability message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      '<!DOCTYPE html><title>Not Found</title>',
      { status: 404, headers: { 'content-type': 'text/html' } },
    )));
    await expect(apiGet('/bootstrap')).rejects.toMatchObject({
      message: 'The Congress.Trade API is unavailable (HTTP 404).',
      status: 404,
    });
  });

  it('reports invalid JSON from an otherwise successful API response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not-json', { status: 200 })));
    await expect(apiGet('/bootstrap')).rejects.toMatchObject({
      message: 'The Congress.Trade API returned an invalid response.',
      status: 200,
    });
  });
});
