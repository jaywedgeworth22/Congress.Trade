import { describe, expect, it, vi } from 'vitest';
import { buildAdminRouter } from '../routes.ts';

const app = buildAdminRouter();

interface ErroredFilingRow {
  doc_id: string;
  chamber?: string | null;
  source_url?: string | null;
  raw_object_key?: string | null;
}

function makeEnv(rows: Array<string | ErroredFilingRow>, opts: { sendFails?: boolean } = {}) {
  const normalized: ErroredFilingRow[] = rows.map((r) =>
    // Default legacy string shorthand to a fetched row (raw bytes present),
    // matching the endpoint's original extraction-stage-only scope.
    typeof r === 'string' ? { doc_id: r, raw_object_key: 'raw/' + r } : r,
  );
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
          return { results: normalized as T[] };
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
    // The selection covers all errored filings, oldest first, chamber-bound;
    // the per-row stage split (fetched vs fetch-failed) happens at send time.
    expect(queries[0].sql).toContain("ingest_status = 'error'");
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

  it('restarts fetch-stage failures (no raw bytes) from filing.new', async () => {
    const { env, send } = makeEnv([
      { doc_id: 'doc_fetch_failed', chamber: 'house', source_url: 'https://x/doc.pdf', raw_object_key: null },
      { doc_id: 'doc_no_url', chamber: 'house', source_url: null, raw_object_key: null },
      { doc_id: 'doc_extract_failed', chamber: 'senate', source_url: 'https://y/doc', raw_object_key: 'raw/doc_extract_failed' },
    ]);
    const res = await app.request(
      '/ingest-retry-errored',
      { method: 'POST', headers: AUTH, body: '{}' },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, matched: 3, enqueued: 2, skipped: 1 });
    expect(send).toHaveBeenCalledWith({
      type: 'filing.new',
      docId: 'doc_fetch_failed',
      chamber: 'house',
      sourceUrl: 'https://x/doc.pdf',
    });
    expect(send).toHaveBeenCalledWith({ type: 'filing.fetched', docId: 'doc_extract_failed' });
    expect(send).toHaveBeenCalledTimes(2);
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

    // runtime-tick is on the maintenance allowlist so Coolify can drive
    // background work without full ADMIN_TOKEN (free-tier Deno plan).
    const tick = await app.request(
      '/runtime-tick',
      { method: 'POST', headers: MAINT, body: '{}' },
      a.env,
    );
    // Must authenticate; body may still error on a minimal stub env.
    expect(tick.status).not.toBe(401);
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
