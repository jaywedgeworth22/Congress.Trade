import { describe, expect, it } from 'vitest';
import {
  isPoisonDlqError,
  isTransientDlqError,
  requeueTransientFailedDurableJobs,
  requeueTransientFailedIngestionOutbox,
} from '../transientDlq.ts';
import type { Env } from '../../shared/types.ts';

describe('transient vs poison DLQ classification', () => {
  it('treats retry-budget, rate-limit, and transient 403 as replayable', () => {
    expect(isTransientDlqError('consumer retry budget exhausted; received by ingest-dlq')).toBe(true);
    expect(isTransientDlqError('Usage telemetry ingest failed: Too many requests. Slow down.')).toBe(true);
    expect(isTransientDlqError('filing.extracted HTTP 403')).toBe(true);
    expect(isTransientDlqError('fetcher: Unauthorized')).toBe(true);
    expect(isTransientDlqError('usage telemetry circuit is open; live delivery suppressed')).toBe(true);
  });

  it('leaves poison payloads failed', () => {
    expect(isPoisonDlqError('invalid ingest queue message type: filing.local_wait_check')).toBe(true);
    expect(isTransientDlqError('invalid ingest queue message type: filing.local_wait_check')).toBe(false);
    expect(isPoisonDlqError('Please enable R2 through the Cloudflare Dashboard.')).toBe(true);
    expect(isTransientDlqError('Please enable R2 through the Cloudflare Dashboard.')).toBe(false);
  });
});

function memoryOutbox(rows: Array<{ doc_id: string; status: string; last_error: string }>) {
  const store = rows.map((row) => ({ ...row, attempts: 6, dead_letter_cycles: 2 }));
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          params: [] as unknown[],
          bind(...params: unknown[]) { this.params = params; return this; },
          async all() {
            const limit = Number(this.params[0] ?? 100);
            return {
              results: store.filter((row) => row.status === 'failed').slice(0, limit),
              meta: { changes: 0 },
            };
          },
          async run() {
            if (/UPDATE ingestion_outbox/.test(sql)) {
              const ids = new Set(this.params.slice(2).map(String));
              let changes = 0;
              for (const row of store) {
                if (row.status === 'failed' && ids.has(row.doc_id)) {
                  row.status = 'pending';
                  changes += 1;
                }
              }
              return { success: true, meta: { changes } };
            }
            return { success: true, meta: { changes: 0 } };
          },
        };
      },
    },
  } as unknown as Env;
  return { env, store };
}

describe('requeueTransientFailedIngestionOutbox', () => {
  it('requeues exhausted retries and leaves poison', async () => {
    const { env, store } = memoryOutbox([
      { doc_id: 'H-1', status: 'failed', last_error: 'consumer retry budget exhausted; received by ingest-dlq' },
      { doc_id: 'H-2', status: 'failed', last_error: 'invalid ingest queue message type: filing.local_wait_check' },
      { doc_id: 'H-3', status: 'failed', last_error: 'consumer retry budget exhausted; received by ingest-dlq' },
    ]);
    const dry = await requeueTransientFailedIngestionOutbox(env, { dryRun: true, limit: 10 });
    expect(dry).toMatchObject({
      dryRun: true, matchedTransient: 2, requeued: 0, skippedPoison: 1,
    });
    expect(store.filter((row) => row.status === 'failed')).toHaveLength(3);

    const applied = await requeueTransientFailedIngestionOutbox(env, {
      now: new Date('2026-08-14T00:00:00.000Z'),
      limit: 10,
    });
    expect(applied.requeued).toBe(2);
    expect(store.find((row) => row.doc_id === 'H-2')?.status).toBe('failed');
    expect(store.find((row) => row.doc_id === 'H-1')?.status).toBe('pending');
    expect(store.find((row) => row.doc_id === 'H-3')?.status).toBe('pending');
  });

  it('bounds the apply batch', async () => {
    const { env, store } = memoryOutbox(
      Array.from({ length: 5 }, (_, i) => ({
        doc_id: `H-${i}`,
        status: 'failed',
        last_error: 'consumer retry budget exhausted; received by ingest-dlq',
      })),
    );
    const applied = await requeueTransientFailedIngestionOutbox(env, { limit: 2 });
    expect(applied.requeued).toBe(2);
    expect(store.filter((row) => row.status === 'pending')).toHaveLength(2);
    expect(store.filter((row) => row.status === 'failed')).toHaveLength(3);
  });
});

function memoryDurable(rows: Array<{
  id: number;
  last_error: string;
  status?: string;
  dedupe_key?: string | null;
}>) {
  const store = rows.map((row) => ({
    queue_name: 'ingest',
    status: row.status ?? 'failed',
    attempts: 9,
    dead_letter_cycles: 2,
    dead_letter_pending: 0,
    ...row,
  }));
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          params: [] as unknown[],
          bind(...params: unknown[]) { this.params = params; return this; },
          async all() {
            const limit = Number(this.params[1] ?? 100);
            return {
              results: store
                .filter((row) => row.queue_name === this.params[0] && row.status === 'failed')
                .slice(0, limit),
              meta: { changes: 0 },
            };
          },
          async run() {
            if (!/UPDATE deno_runtime_queue/.test(sql)) {
              return { success: true, meta: { changes: 0 } };
            }
            const ids = new Set(this.params.slice(2).map(Number));
            let changes = 0;
            for (const row of store) {
              if (row.status !== 'failed' || !ids.has(row.id)) continue;
              if (row.dedupe_key && store.some((other) =>
                other !== row
                && other.dedupe_key === row.dedupe_key
                && (other.status === 'pending' || other.status === 'processing'))) {
                continue;
              }
              row.status = 'pending';
              changes += 1;
            }
            return { success: true, meta: { changes } };
          },
        };
      },
    },
  } as unknown as Env;
  return { env, store };
}

describe('requeueTransientFailedDurableJobs', () => {
  it('requeues rate-limit / 403 and leaves invalid message types', async () => {
    const { env, store } = memoryDurable([
      { id: 1, last_error: 'filing.extracted HTTP 403' },
      { id: 2, last_error: 'invalid ingest queue message type: filing.local_wait_check' },
      { id: 3, last_error: 'Usage telemetry ingest failed: Too many requests. Slow down.' },
    ]);
    const applied = await requeueTransientFailedDurableJobs(env, { limit: 10 });
    expect(applied.requeued).toBe(2);
    expect(applied.skippedPoison).toBe(1);
    expect(store.find((row) => row.id === 2)?.status).toBe('failed');
    expect(store.find((row) => row.id === 1)?.status).toBe('pending');
  });
});
