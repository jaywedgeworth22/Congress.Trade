import { describe, expect, it, vi } from 'vitest';
import { buildAdminRouter } from '../routes.ts';

const app = buildAdminRouter();

function makeEnv(docIds: string[], opts: { sendFails?: boolean } = {}) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const send = vi.fn(async () => {
    if (opts.sendFails) throw new Error('queue unavailable');
  });
  const env = {
    ADMIN_TOKEN: 'admin-secret',
    DB: {
      prepare: (sql: string) => ({
        params: [] as unknown[],
        bind(...params: unknown[]) { this.params = params; return this; },
        async all<T>() {
          queries.push({ sql, params: this.params });
          return { results: docIds.map((doc_id) => ({ doc_id })) as T[] };
        },
        async run() { return { success: true, meta: { changes: 0 } }; },
        async first<T>() { return null as T | null; },
      }),
    },
    INGEST_QUEUE: { send, sendBatch: vi.fn() },
  } as never;
  return { env, send, queries };
}

const AUTH = { Authorization: 'Bearer admin-secret', 'content-type': 'application/json' };

describe('POST /ingest-retry-errored (extraction-stage backlog drain)', () => {
  it('re-enqueues filing.fetched only for errored filings that have raw bytes', async () => {
    const { env, send, queries } = makeEnv(['doc_a', 'doc_b']);
    const res = await app.request(
      '/ingest-retry-errored',
      { method: 'POST', headers: AUTH, body: JSON.stringify({ chamber: 'house' }) },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, matched: 2, enqueued: 2, errors: [] });
    // The selection is scoped to errored-with-raw, oldest first, chamber-bound.
    expect(queries[0].sql).toContain("ingest_status = 'error' AND raw_object_key IS NOT NULL");
    expect(queries[0].sql).toContain('AND chamber = ?');
    expect(queries[0].sql).toContain('ORDER BY first_seen_at ASC');
    expect(queries[0].params).toEqual(['house', 500]);
    expect(send).toHaveBeenCalledWith({ type: 'filing.fetched', docId: 'doc_a' });
    expect(send).toHaveBeenCalledWith({ type: 'filing.fetched', docId: 'doc_b' });
  });

  it('dryRun counts without enqueueing; queue outages surface and bail early', async () => {
    const dry = makeEnv(['doc_a']);
    const dryRes = await app.request(
      '/ingest-retry-errored',
      { method: 'POST', headers: AUTH, body: JSON.stringify({ dryRun: true }) },
      dry.env,
    );
    expect(await dryRes.json()).toMatchObject({ ok: true, dryRun: true, matched: 1 });
    expect(dry.send).not.toHaveBeenCalled();

    const down = makeEnv(['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'], { sendFails: true });
    const downRes = await app.request(
      '/ingest-retry-errored',
      { method: 'POST', headers: AUTH, body: '{}' },
      down.env,
    );
    const body = (await downRes.json()) as { enqueued: number; errors: string[] };
    expect(body.enqueued).toBe(0);
    expect(body.errors).toHaveLength(5); // bails after 5 consecutive failures
  });

  it('rejects bad chambers and stays behind admin auth', async () => {
    const { env } = makeEnv([]);
    const bad = await app.request(
      '/ingest-retry-errored',
      { method: 'POST', headers: AUTH, body: JSON.stringify({ chamber: 'judiciary' }) },
      env,
    );
    expect(bad.status).toBe(400);
    const unauth = await app.request('/ingest-retry-errored', { method: 'POST' }, env);
    expect(unauth.status).toBe(401);
  });
});

describe('ADMIN_MAINTENANCE_TOKEN (scoped like INGEST_TOKEN)', () => {
  function envWithMaintenanceToken(docIds: string[]) {
    const base = makeEnv(docIds);
    (base.env as { ADMIN_MAINTENANCE_TOKEN?: string }).ADMIN_MAINTENANCE_TOKEN = 'maint-secret';
    return base;
  }
  const MAINT = { Authorization: 'Bearer maint-secret', 'content-type': 'application/json' };

  it('unlocks ONLY the maintenance endpoints', async () => {
    const a = envWithMaintenanceToken(['doc_a']);
    const retry = await app.request(
      '/ingest-retry-errored',
      { method: 'POST', headers: MAINT, body: '{"dryRun":true}' },
      a.env,
    );
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ ok: true, dryRun: true, matched: 1 });

    const requeue = await app.request(
      '/ingest-requeue-failed',
      { method: 'POST', headers: MAINT, body: '{"dryRun":true}' },
      a.env,
    );
    expect(requeue.status).toBe(200);
  });

  it('is rejected everywhere else and never escalates to full admin', async () => {
    const a = envWithMaintenanceToken([]);
    for (const path of ['/config-sources', '/poll-config']) {
      const res = await app.request(path, { headers: MAINT }, a.env);
      expect(res.status).toBe(401);
    }
    const wrong = await app.request(
      '/ingest-retry-errored',
      { method: 'POST', headers: { Authorization: 'Bearer not-the-token' }, body: '{}' },
      a.env,
    );
    expect(wrong.status).toBe(401);
  });
});
