/**
 * GOVERNOR 2 unit tests — the D1 write governor extension of d1Budget.
 *
 * Pins the storm-degradation contract: oversized governed batches are
 * truncated to the cap with a quarantine marker (never an unbounded write
 * loop), and the per-invocation write-op budget denies grants once exhausted
 * until the invocation-tail reset.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../types.ts';
import type { SqlParam } from '../db.ts';
import {
  consumeGovernedD1Writes,
  governedD1Batch,
  resetD1WriteGovernor,
} from '../d1Budget.ts';

interface Executed {
  sql: string;
  params: unknown[];
}

function governorEnv(vars: Record<string, string> = {}): { env: Env; executed: Executed[] } {
  const executed: Executed[] = [];
  const prepare = (sql: string) => ({
    params: [] as unknown[],
    bind(...params: unknown[]) {
      this.params = params;
      return this;
    },
    async run() {
      executed.push({ sql, params: this.params });
      return { success: true, meta: { changes: 1, rows_written: 1 } };
    },
    async all() {
      return { results: [] };
    },
    async first() {
      return null;
    },
  });
  const env = {
    DB: {
      prepare,
      async batch(statements: Array<{ run: () => Promise<D1Result> }>) {
        const results: D1Result[] = [];
        for (const stmt of statements) results.push(await stmt.run());
        return results;
      },
    } as unknown as D1Database,
    ...vars,
  } as unknown as Env;
  return { env, executed };
}

const stmt = (i: number): [string, SqlParam[]] => [
  'INSERT OR IGNORE INTO delivery_outbox (tx_id) VALUES (?)',
  [`tx_${i}`],
];

beforeEach(() => resetD1WriteGovernor());
afterEach(() => resetD1WriteGovernor());

describe('governedD1Batch', () => {
  it('executes an in-cap batch whole with no quarantine', async () => {
    const { env, executed } = governorEnv({ D1_WRITE_BATCH_CAP: '10' });
    const result = await governedD1Batch(env, 'test-writer', [stmt(1), stmt(2)]);
    expect(result.executed).toBe(2);
    expect(result.quarantined).toBe(0);
    expect(executed).toHaveLength(2);
  });

  it('truncates an oversized batch to the cap and writes ONE quarantine marker', async () => {
    const { env, executed } = governorEnv({ D1_WRITE_BATCH_CAP: '3' });
    const statements = Array.from({ length: 10 }, (_, i) => stmt(i));
    const result = await governedD1Batch(env, 'delivery-outbox-flush', statements);
    expect(result.executed).toBe(3);
    expect(result.quarantined).toBe(7);
    const quarantine = executed.filter((e) => /d1_write_quarantine/i.test(e.sql));
    expect(quarantine).toHaveLength(1);
    expect(quarantine[0].params).toContain('delivery-outbox-flush');
    expect(quarantine[0].params).toContain(7);
    // 3 governed statements + 1 quarantine marker — bounded, never 10.
    expect(executed).toHaveLength(4);
  });

  it('respects the per-invocation write budget across successive batches', async () => {
    const { env } = governorEnv({
      D1_WRITE_BATCH_CAP: '100',
      D1_WRITE_OPS_PER_INVOCATION_CAP: '5',
    });
    const first = await governedD1Batch(env, 'w', Array.from({ length: 4 }, (_, i) => stmt(i)));
    expect(first.executed).toBe(4);
    const second = await governedD1Batch(env, 'w', Array.from({ length: 4 }, (_, i) => stmt(i)));
    expect(second.executed).toBe(1);
    expect(second.quarantined).toBe(3);
    const third = await governedD1Batch(env, 'w', [stmt(0)]);
    expect(third.executed).toBe(0);
    expect(third.quarantined).toBe(1);
  });
});

describe('consumeGovernedD1Writes', () => {
  it('grants up to the invocation cap, then denies until reset', () => {
    const { env } = governorEnv({ D1_WRITE_OPS_PER_INVOCATION_CAP: '3' });
    expect(consumeGovernedD1Writes(env, 'dead-letter', 1)).toBe(1);
    expect(consumeGovernedD1Writes(env, 'dead-letter', 1)).toBe(1);
    expect(consumeGovernedD1Writes(env, 'extraction_runs', 5)).toBe(1); // partial grant
    expect(consumeGovernedD1Writes(env, 'ingestion-discovery', 1)).toBe(0);
    resetD1WriteGovernor();
    expect(consumeGovernedD1Writes(env, 'ingestion-discovery', 1)).toBe(1);
  });

  it('rejects nonsense op counts', () => {
    const { env } = governorEnv();
    expect(consumeGovernedD1Writes(env, 'w', 0)).toBe(0);
    expect(consumeGovernedD1Writes(env, 'w', -5)).toBe(0);
    expect(consumeGovernedD1Writes(env, 'w', Number.NaN)).toBe(0);
  });
});
