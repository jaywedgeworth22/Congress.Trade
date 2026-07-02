import { describe, it, expect } from 'vitest';
import { buildDetectionRouter } from '../detectionRoutes';

const app = buildDetectionRouter();
// Minimal D1 stand-in: recordDisclosureLatencyCandidate only does INSERTs.
const okDb = {
  prepare: () => ({
    bind: () => ({ run: async () => ({ meta: {} }), all: async () => ({ results: [] }), first: async () => null }),
  }),
};
const env = { INGEST_TOKEN: 'ingest-secret', DB: okDb } as unknown as Record<string, unknown>;

function post(token: string | null, body: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return app.request('/detection', { method: 'POST', headers, body: JSON.stringify(body) }, env as never);
}

describe('POST /api/ingest/detection', () => {
  it('401 without a token', async () => {
    expect((await post(null, { source: 'house', docKey: 'H-2026-1' })).status).toBe(401);
  });

  it('401 with a wrong token', async () => {
    expect((await post('nope', { source: 'house', docKey: 'H-2026-1' })).status).toBe(401);
  });

  it('400 when source or docKey is missing/invalid', async () => {
    expect((await post('ingest-secret', { source: 'house' })).status).toBe(400);
    expect((await post('ingest-secret', { docKey: 'H-2026-1' })).status).toBe(400);
    expect((await post('ingest-secret', { source: 'nope', docKey: 'H-2026-1' })).status).toBe(400);
  });

  it('records a valid detection and echoes the normalized detectedAt', async () => {
    const res = await post('ingest-secret', {
      source: 'senate',
      docKey: 'S-abc123',
      link: 'https://efdsearch.senate.gov/search/view/ptr/abc123/',
      detectedAt: '2026-07-01T00:00:00.000Z',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; docKey: string; detectedAt: string };
    expect(body).toMatchObject({ ok: true, docKey: 'S-abc123', detectedAt: '2026-07-01T00:00:00.000Z' });
  });
});
