import { describe, expect, it } from 'vitest';
import { buildAdminRouter } from '../routes';

describe('POST /analyze', () => {
  it('rejects an invalid present table name without running whole-database ANALYZE', async () => {
    const prepared: string[] = [];
    const response = await buildAdminRouter().request('/analyze', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ table: 'transactions-index' }),
    }, {
      ADMIN_TOKEN: 'admin-secret',
      DB: {
        prepare(sql: string) {
          prepared.push(sql);
          return { run: async () => ({}) };
        },
      },
    } as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'table must be a valid SQLite identifier' });
    expect(prepared).toEqual([]);
  });
});
