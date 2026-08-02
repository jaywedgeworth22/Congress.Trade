import { describe, it, expect } from 'vitest';
import { buildAdminRouter } from '../routes.ts';
import type { Env } from '../../shared/types.ts';

describe('POST /api/admin/migrate error handling', () => {
  it('runs migrations successfully and returns ok=true (HTTP 200)', async () => {
    const executedSql: string[] = [];
    const env = {
      ADMIN_TOKEN: 'admin-secret',
      DB: {
        prepare(sql: string) {
          executedSql.push(sql);
          return {
            async run() {
              return { success: true };
            },
            async first() {
              return { count: 1 };
            },
            async all() {
              return { results: [] };
            },
          };
        },
      },
    } as unknown as Env;

    const router = buildAdminRouter();
    const res = await router.request('/migrate', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ skipSchemaVerify: true }),
    }, env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; applied: string[]; skipped: string[]; failed: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.failed).toHaveLength(0);
    expect(executedSql.length).toBeGreaterThan(0);
  });

  it('fails with HTTP 500 when an unhandled SQL error occurs', async () => {
    const env = {
      ADMIN_TOKEN: 'admin-secret',
      DB: {
        prepare(sql: string) {
          return {
            async run() {
              if (sql.includes('transactions')) {
                throw new Error('UNIQUE constraint failed: transactions.doc_id');
              }
              return { success: true };
            },
            async first() {
              return { count: 1 };
            },
            async all() {
              return { results: [] };
            },
          };
        },
      },
    } as unknown as Env;

    const router = buildAdminRouter();
    const res = await router.request('/migrate', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ skipSchemaVerify: true }),
    }, env);

    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; failed: Array<{ sql: string; error: string }> };
    expect(body.ok).toBe(false);
    expect(body.failed.length).toBeGreaterThan(0);
    expect(body.failed[0].error).toContain('UNIQUE constraint failed');
  });

  it('treats duplicate column name errors as skipped (HTTP 200)', async () => {
    const env = {
      ADMIN_TOKEN: 'admin-secret',
      DB: {
        prepare(sql: string) {
          return {
            async run() {
              throw new Error('duplicate column name: test_col');
            },
            async first() {
              return { count: 1 };
            },
            async all() {
              return { results: [] };
            },
          };
        },
      },
    } as unknown as Env;

    const router = buildAdminRouter();
    const res = await router.request('/migrate', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ skipSchemaVerify: true }),
    }, env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; skipped: string[]; failed: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.skipped.length).toBeGreaterThan(0);
    expect(body.failed).toHaveLength(0);
  });
});
