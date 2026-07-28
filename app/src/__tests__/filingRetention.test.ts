/**
 * src/__tests__/filingRetention.test.ts
 *
 * The 5-year filing retention sweep must (a) also remove the delivery
 * bookkeeping rows (deliveries / delivery_outbox) that reference the batch's
 * transactions so they are not orphaned, and (b) sweep filings whose
 * filed_date is NULL by falling back to the ingestion date instead of never
 * matching the age predicate.
 */
import { describe, it, expect } from 'vitest';
import { runFilingRetentionSweep } from '../jobs.ts';
import type { Env } from '../shared/types.ts';

function makeEnv(batchRows: Array<{ doc_id: string; raw_object_key: string | null }>) {
  const ranSql: string[] = [];
  const selectSql: string[] = [];
  let selectCalls = 0;
  const prepare = (sql: string) => ({
    params: [] as unknown[],
    bind(...params: unknown[]) {
      this.params = params;
      return this;
    },
    async first<T>() {
      return null as T | null;
    },
    async all<T>() {
      if (/SELECT doc_id, raw_object_key FROM filings/i.test(sql)) {
        selectSql.push(sql);
        selectCalls += 1;
        return { results: (selectCalls === 1 ? batchRows : []) as T[], meta: {} };
      }
      return { results: [] as T[], meta: {} };
    },
    async run() {
      ranSql.push(sql);
      return { success: true, meta: { changes: 1 } };
    },
  });
  const env = {
    DB: { prepare } as unknown as D1Database,
    RAW_FILES: { delete: async () => {} },
  } as unknown as Env;
  return { env, ranSql, selectSql };
}

describe('runFilingRetentionSweep', () => {
  it('sweeps NULL filed_date rows via the first_seen_at fallback', async () => {
    const { env, selectSql } = makeEnv([{ doc_id: 'H-1', raw_object_key: null }]);
    const deleted = await runFilingRetentionSweep(env, new Date('2026-07-28T00:00:00Z'));
    expect(deleted).toBe(1);
    expect(selectSql[0]).toContain('COALESCE(filed_date, substr(first_seen_at, 1, 10)) < ?');
  });

  it('deletes deliveries and delivery_outbox rows for the batch before the transactions', async () => {
    const { env, ranSql } = makeEnv([{ doc_id: 'H-1', raw_object_key: null }]);
    await runFilingRetentionSweep(env, new Date('2026-07-28T00:00:00Z'));
    const deliveriesIdx = ranSql.findIndex((s) => /DELETE FROM deliveries/i.test(s));
    const outboxIdx = ranSql.findIndex((s) => /DELETE FROM delivery_outbox/i.test(s));
    const txIdx = ranSql.findIndex((s) => /DELETE FROM transactions/i.test(s));
    const filingsIdx = ranSql.findIndex((s) => /DELETE FROM filings/i.test(s));
    expect(deliveriesIdx).toBeGreaterThanOrEqual(0);
    expect(outboxIdx).toBeGreaterThanOrEqual(0);
    expect(txIdx).toBeGreaterThan(deliveriesIdx);
    expect(txIdx).toBeGreaterThan(outboxIdx);
    expect(filingsIdx).toBeGreaterThan(txIdx);
    // Delivery deletes key off the batch's doc_ids via the transactions subquery.
    expect(ranSql[deliveriesIdx]).toContain('SELECT id FROM transactions WHERE doc_id IN');
    expect(ranSql[outboxIdx]).toContain('SELECT id FROM transactions WHERE doc_id IN');
  });

  it('is a no-op when nothing is expired', async () => {
    const { env, ranSql } = makeEnv([]);
    const deleted = await runFilingRetentionSweep(env, new Date('2026-07-28T00:00:00Z'));
    expect(deleted).toBe(0);
    expect(ranSql).toHaveLength(0);
  });
});
