import { describe, it, expect, vi, beforeEach } from 'vitest';

const insertFilingIfNew = vi.fn();
const enqueueFilingNew = vi.fn();

vi.mock('../watcher.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../watcher.ts')>();
  return {
    ...actual,
    insertFilingIfNew: (...args: unknown[]) => insertFilingIfNew(...args),
    enqueueFilingNew: (...args: unknown[]) => enqueueFilingNew(...args),
  };
});

const recordDisclosureLatencyCandidate = vi.fn(async () => undefined);
vi.mock('../fmpDisclosureLatency.ts', () => ({
  recordDisclosureLatencyCandidate: (...args: unknown[]) => recordDisclosureLatencyCandidate(...args),
}));

import { buildDetectionRouter } from '../detectionRoutes.ts';

const app = buildDetectionRouter();
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
  beforeEach(() => {
    insertFilingIfNew.mockReset();
    enqueueFilingNew.mockReset();
    recordDisclosureLatencyCandidate.mockClear();
    insertFilingIfNew.mockResolvedValue('inserted');
    enqueueFilingNew.mockResolvedValue(true);
  });

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

  it('records latency and ingests a new filing by default when link is present', async () => {
    const res = await post('ingest-secret', {
      source: 'senate',
      docKey: 'S-abc123',
      link: 'https://efdsearch.senate.gov/search/view/ptr/abc123/',
      filerName: 'Jane Doe',
      detectedAt: '2026-07-01T00:00:00.000Z',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      docKey: string;
      detectedAt: string;
      insert: string;
      enqueued: boolean;
    };
    expect(body).toMatchObject({
      ok: true,
      docKey: 'S-abc123',
      detectedAt: '2026-07-01T00:00:00.000Z',
      insert: 'inserted',
      enqueued: true,
    });
    expect(insertFilingIfNew).toHaveBeenCalledTimes(1);
    const filing = insertFilingIfNew.mock.calls[0][1] as {
      docId: string;
      chamber: string;
      filerId: string | null;
      sourceUrl: string;
    };
    expect(filing).toMatchObject({
      docId: 'S-abc123',
      chamber: 'senate',
      filerId: 'senate-jane-doe',
      sourceUrl: 'https://efdsearch.senate.gov/search/view/ptr/abc123/',
    });
    expect(enqueueFilingNew).toHaveBeenCalledTimes(1);
    expect(recordDisclosureLatencyCandidate).toHaveBeenCalledTimes(1);
  });

  it('skips pipeline ingest when ingest:false (latency-only measurement)', async () => {
    const res = await post('ingest-secret', {
      source: 'house',
      docKey: 'H-2026-99',
      link: 'https://example.com/ptr.pdf',
      ingest: false,
      detectedAt: '2026-07-01T00:00:00.000Z',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { insert: string; enqueued: boolean };
    expect(body.insert).toBe('skipped');
    expect(body.enqueued).toBe(false);
    expect(insertFilingIfNew).not.toHaveBeenCalled();
    expect(enqueueFilingNew).not.toHaveBeenCalled();
    expect(recordDisclosureLatencyCandidate).toHaveBeenCalledTimes(1);
  });

  it('does not re-enqueue duplicates', async () => {
    insertFilingIfNew.mockResolvedValueOnce('duplicate');
    const res = await post('ingest-secret', {
      source: 'senate',
      docKey: 'S-dup',
      link: 'https://efdsearch.senate.gov/search/view/ptr/dup/',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { insert: string; enqueued: boolean };
    expect(body.insert).toBe('duplicate');
    expect(body.enqueued).toBe(false);
    expect(enqueueFilingNew).not.toHaveBeenCalled();
  });

  it('returns 503 when the D1 write governor defers the insert', async () => {
    insertFilingIfNew.mockResolvedValueOnce('deferred');
    const res = await post('ingest-secret', {
      source: 'senate',
      docKey: 'S-def',
      link: 'https://efdsearch.senate.gov/search/view/ptr/def/',
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body).toMatchObject({ ok: false, error: 'deferred' });
    expect(enqueueFilingNew).not.toHaveBeenCalled();
  });
});
