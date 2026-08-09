/**
 * The blind spot the PR #1579 verifier found: every other sweep and the
 * stranded_filings health check EXCLUDE review-resolved rows, so the 562
 * production rows that were resolved=1 with a stale non-terminal
 * ingest_status could never be seen or fixed by any of them.
 */
import { describe, it, expect } from 'vitest';

import { sweepResolvedStatusDesync } from '../autonomySweeps.ts';
import type { Env } from '../../shared/types.ts';

interface Row {
  doc_id: string;
  ingest_status: string;
  has_tx: number;
}

function makeEnv(rows: Row[]) {
  const updates: Array<{ docId: string; status: string }> = [];
  const prepare = (sql: string) => ({
    params: [] as unknown[],
    bind(...params: unknown[]) {
      this.params = params;
      return this;
    },
    async all<T>() {
      return { results: rows as unknown as T[] };
    },
    async first<T>() {
      return null as T | null;
    },
    async run() {
      if (/UPDATE filings/i.test(sql)) {
        const [status, , , docId] = this.params as string[];
        updates.push({ docId, status });
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 0 } };
    },
  });
  return { env: { DB: { prepare } as unknown as D1Database } as unknown as Env, updates };
}

describe('sweepResolvedStatusDesync', () => {
  it('stamps published when a resolved filing produced transactions', async () => {
    const { env, updates } = makeEnv([
      { doc_id: 'H-1', ingest_status: 'classified', has_tx: 1 },
    ]);
    const res = await sweepResolvedStatusDesync(env);
    expect(res.reconciled).toBe(1);
    expect(updates[0]).toEqual({ docId: 'H-1', status: 'published' });
  });

  it('stamps a terminal error when a resolved filing yielded no transactions', async () => {
    const { env, updates } = makeEnv([
      { doc_id: 'H-2', ingest_status: 'extraction_pending_local', has_tx: 0 },
    ]);
    const res = await sweepResolvedStatusDesync(env);
    expect(res.reconciled).toBe(1);
    expect(updates[0]).toEqual({ docId: 'H-2', status: 'error' });
  });

  it('covers needs_review, which the strandable-status sweeps deliberately skip', async () => {
    const { env, updates } = makeEnv([
      { doc_id: 'H-3', ingest_status: 'needs_review', has_tx: 0 },
    ]);
    await sweepResolvedStatusDesync(env);
    expect(updates.map((u) => u.docId)).toContain('H-3');
  });

  it('is a no-op when nothing is desynced', async () => {
    const { env, updates } = makeEnv([]);
    const res = await sweepResolvedStatusDesync(env);
    expect(res).toEqual({ scanned: 0, reconciled: 0 });
    expect(updates).toHaveLength(0);
  });
});
