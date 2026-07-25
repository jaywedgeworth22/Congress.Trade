import { createClient } from '@libsql/client';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import { D1DatabaseShim } from '../shims.ts';
import {
  hasDrainableWork,
  probePendingWork,
  runScheduledTick,
} from '../scheduledTick.ts';
import type { DenoCostProfile } from '../costProfile.ts';
import type { DurableQueueHandlers } from '../durableQueue.ts';

const FREE: DenoCostProfile = {
  name: 'free',
  cronSchedule: '*/5 * * * *',
  drainLimit: 3,
  drainClaimSize: 1,
  outboxLimit: 20,
  disableInternalCron: false,
  idleShortCircuit: true,
};

async function makeDb() {
  const client = createClient({ url: 'file::memory:' });
  await client.execute(`
    CREATE TABLE deno_runtime_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_name TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      dead_letter_pending INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      lease_until TEXT,
      lease_token TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await client.execute(`
    CREATE TABLE ingestion_outbox (
      doc_id TEXT PRIMARY KEY,
      chamber TEXT,
      source_url TEXT,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      dead_letter_cycles INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_error TEXT
    )
  `);
  await client.execute(`
    CREATE TABLE delivery_outbox (
      tx_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      dead_letter_cycles INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_error TEXT
    )
  `);
  const db = new D1DatabaseShim(client as never) as unknown as D1Database;
  return { client, db };
}

function emptyHandlers(): DurableQueueHandlers {
  return {
    handleIngestMessage: vi.fn(async () => {}),
    handleDeliveryMessage: vi.fn(async () => true),
    handleDeadLetterMessage: vi.fn(async () => {}),
    handleCorruptDeadLetterMessage: vi.fn(async () => {}),
    isTerminalDeadLetterError: () => false,
    completeIngestionOutbox: vi.fn(async () => {}),
    completeDeliveryOutbox: vi.fn(async () => {}),
  };
}

describe('probePendingWork / hasDrainableWork', () => {
  it('reports no work on empty tables', async () => {
    const { db } = await makeDb();
    const env = { DB: db } as unknown as Env;
    const probe = await probePendingWork(env, new Date('2026-07-25T12:00:00.000Z'));
    expect(probe).toEqual({
      ingestQueue: false,
      deliveryQueue: false,
      ingestionOutbox: false,
      deliveryOutbox: false,
    });
    expect(hasDrainableWork(probe)).toBe(false);
  });

  it('detects pending queue and outbox rows', async () => {
    const { client, db } = await makeDb();
    const now = '2026-07-25T12:00:00.000Z';
    await client.execute({
      sql: `INSERT INTO deno_runtime_queue
        (queue_name, payload, status, available_at, created_at, updated_at)
        VALUES ('ingest', '{}', 'pending', ?, ?, ?)`,
      args: [now, now, now],
    });
    await client.execute({
      sql: `INSERT INTO delivery_outbox
        (tx_id, status, available_at, updated_at)
        VALUES ('tx1', 'pending', ?, ?)`,
      args: [now, now],
    });
    const env = { DB: db } as unknown as Env;
    const probe = await probePendingWork(env, new Date(now));
    expect(probe.ingestQueue).toBe(true);
    expect(probe.deliveryOutbox).toBe(true);
    expect(hasDrainableWork(probe)).toBe(true);
  });
});

function testEnv(db: D1Database, extra: Record<string, unknown> = {}): Env {
  // Stamp daily jobs done so maybeRunDailyJobs is a cheap no-op.
  const day = '2026-07-25';
  return {
    DB: db,
    CONFIG_KV: {
      get: vi.fn(async (key: string) => {
        if (key === 'jobs:daily:lastdate') return day;
        if (key === 'poll_config') {
          return {
            schedule: [
              { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startHourET: 0, endHourET: 24, intervalSec: 3600 },
            ],
            aggressiveMode: false,
            updatedAt: '2026-07-25T00:00:00.000Z',
          };
        }
        // last_poll:* stamps — treat as just polled so watcher skips sources.
        if (key.startsWith('last_poll:')) return new Date('2026-07-25T11:30:00.000Z').toISOString();
        return null;
      }),
      put: vi.fn(async () => {}),
    },
    ...extra,
  } as unknown as Env;
}

describe('runScheduledTick idle short-circuit', () => {
  it('skips drain path when idleShortCircuit and no pending work', async () => {
    const { db } = await makeDb();
    const handlers = emptyHandlers();
    const result = await runScheduledTick(
      testEnv(db),
      handlers,
      FREE,
      new Date('2026-07-25T12:00:00.000Z'),
    );
    expect(result.skippedDrain).toBe(true);
    expect(result.drained).toBeNull();
    expect(result.ingestionOutbox).toBeNull();
    expect(handlers.handleIngestMessage).not.toHaveBeenCalled();
  });

  it('does not skip when idleShortCircuit is off', async () => {
    const { db } = await makeDb();
    const handlers = emptyHandlers();
    const result = await runScheduledTick(
      testEnv(db, {
        INGEST_QUEUE: { send: vi.fn(async () => {}) },
        DELIVERY_QUEUE: { send: vi.fn(async () => {}) },
      }),
      handlers,
      { ...FREE, idleShortCircuit: false },
      new Date('2026-07-25T12:00:00.000Z'),
    );
    expect(result.skippedDrain).toBe(false);
    expect(result.drained).not.toBeNull();
    expect(result.drained?.ingest.claimed).toBe(0);
  });
});
