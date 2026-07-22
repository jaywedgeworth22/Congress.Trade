import { createClient } from '@libsql/client';
import { describe, expect, it, vi } from 'vitest';
import type { Env, QueueMessage } from '../../shared/types.ts';
import {
  drainDurableQueue,
  DurableQueueAdapter,
  type DurableQueueHandlers,
} from '../durableQueue.ts';
import { D1DatabaseShim } from '../shims.ts';

const START = new Date('2026-07-22T16:00:00.000Z');

async function createHarness() {
  const client = createClient({ url: 'file::memory:' });
  await client.execute(`
    CREATE TABLE deno_runtime_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_name TEXT NOT NULL,
      dedupe_key TEXT,
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
    CREATE UNIQUE INDEX idx_deno_runtime_queue_active_dedupe
      ON deno_runtime_queue(queue_name, dedupe_key)
      WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'processing')
  `);

  let current = new Date(START);
  const now = () => new Date(current);
  const setNow = (value: Date) => { current = new Date(value); };
  const db = new D1DatabaseShim(client as never) as unknown as D1Database;
  const ingest = new DurableQueueAdapter<QueueMessage>(db, 'ingest', now);
  const delivery = new DurableQueueAdapter<QueueMessage>(db, 'delivery', now);
  const env = {
    DB: db,
    INGEST_QUEUE: ingest,
    DELIVERY_QUEUE: delivery,
  } as unknown as Env;

  async function rows() {
    return (await client.execute(
      'SELECT id, queue_name, payload, status, attempts, dead_letter_pending, available_at, lease_until, last_error FROM deno_runtime_queue ORDER BY id',
    )).rows;
  }

  return { client, db, ingest, delivery, env, now, setNow, rows };
}

function createHandlers(overrides: Partial<DurableQueueHandlers> = {}): DurableQueueHandlers {
  return {
    handleIngestMessage: vi.fn(async () => {}),
    handleDeliveryMessage: vi.fn(async () => true),
    handleDeadLetterMessage: vi.fn(async () => {}),
    handleCorruptDeadLetterMessage: vi.fn(async () => {}),
    isTerminalDeadLetterError: vi.fn(() => false),
    completeIngestionOutbox: vi.fn(async () => 'completed'),
    completeDeliveryOutbox: vi.fn(async () => 'completed'),
    ...overrides,
  };
}

describe('Deno durable queue', () => {
  it('persists send/sendBatch messages and propagates database failures', async () => {
    const harness = await createHarness();
    try {
      await harness.ingest.send({
        type: 'filing.new',
        docId: 'doc-1',
        chamber: 'house',
        sourceUrl: 'https://example.test/doc-1.pdf',
      });
      await harness.ingest.sendBatch([
        { body: { type: 'filing.fetched', docId: 'doc-1' } },
        { body: { type: 'filing.extracted', docId: 'doc-1' }, delaySeconds: 60 },
      ]);

      const rows = await harness.rows();
      expect(rows).toHaveLength(3);
      expect(rows.map((row) => row.status)).toEqual(['pending', 'pending', 'pending']);
      expect(rows.map((row) => JSON.parse(String(row.payload)).type)).toEqual([
        'filing.new',
        'filing.fetched',
        'filing.extracted',
      ]);
      expect(rows[2].available_at).toBe('2026-07-22T16:01:00.000Z');

      await harness.ingest.send({
        type: 'filing.new',
        docId: 'doc-1',
        chamber: 'house',
        sourceUrl: 'https://example.test/doc-1.pdf',
      });
      expect(await harness.rows()).toHaveLength(3);

      await harness.client.execute('DROP TABLE deno_runtime_queue');
      await expect(harness.ingest.send({ type: 'filing.fetched', docId: 'doc-2' }))
        .rejects.toThrow('D1 statement error');
    } finally {
      harness.client.close();
    }
  });

  it('revalidates a guarded producer at the final batch write boundary', async () => {
    const harness = await createHarness();
    try {
      const guard = vi.fn(async () => {
        throw new Error('lease lost before queue persist');
      });
      const guarded = harness.ingest.withWriteGuard(guard);

      await expect(guarded.sendBatch([{
        body: { type: 'filing.fetched', docId: 'must-not-persist' },
      }])).rejects.toThrow('lease lost before queue persist');
      expect(guard).toHaveBeenCalledOnce();
      expect(await harness.rows()).toHaveLength(0);
    } finally {
      harness.client.close();
    }
  });

  it('maps libSQL write metadata to D1 changes semantics', async () => {
    const harness = await createHarness();
    try {
      const inserted = await harness.db.prepare(`
        INSERT INTO deno_runtime_queue
          (queue_name, payload, status, attempts, available_at, created_at, updated_at)
        VALUES ('ingest', '{}', 'pending', 0, ?, ?, ?)
      `).bind(START.toISOString(), START.toISOString(), START.toISOString()).run();
      expect(inserted.meta.changes).toBe(1);
      expect(inserted.meta.last_row_id).toBe(1);

      const missed = await harness.db.prepare(
        "UPDATE deno_runtime_queue SET status = 'completed' WHERE id = -1",
      ).run();
      expect(missed.meta.changes).toBe(0);
    } finally {
      harness.client.close();
    }
  });

  it('claims and completes a successful canonical ingest message', async () => {
    const harness = await createHarness();
    try {
      const message: QueueMessage = {
        type: 'filing.new',
        docId: 'doc-success',
        chamber: 'senate',
        sourceUrl: 'https://example.test/doc-success.pdf',
      };
      await harness.ingest.send(message);
      const handlers = createHandlers();

      await expect(drainDurableQueue(harness.env, 'ingest', handlers, { now: harness.now }))
        .resolves.toEqual({ claimed: 1, completed: 1, retried: 0, failed: 0 });
      expect(handlers.handleIngestMessage).toHaveBeenCalledWith(
        expect.objectContaining({ DB: expect.anything() }),
        message,
        1,
        expect.objectContaining({
          assertOwned: expect.any(Function),
          renew: expect.any(Function),
        }),
      );
      expect(handlers.completeIngestionOutbox).toHaveBeenCalledWith(
        expect.objectContaining({ DB: expect.anything() }),
        'doc-success',
      );
      expect((await harness.rows())[0]).toMatchObject({ status: 'completed', attempts: 1, lease_until: null });
    } finally {
      harness.client.close();
    }
  });

  it('retries handler failures with exponential availability backoff', async () => {
    const harness = await createHarness();
    try {
      await harness.ingest.send({ type: 'filing.fetched', docId: 'doc-retry' });
      const ingestHandler = vi.fn(async () => {});
      ingestHandler.mockRejectedValueOnce(new Error('provider unavailable'));
      const handlers = createHandlers({ handleIngestMessage: ingestHandler });

      await expect(drainDurableQueue(harness.env, 'ingest', handlers, { now: harness.now }))
        .resolves.toEqual({ claimed: 1, completed: 0, retried: 1, failed: 0 });
      expect((await harness.rows())[0]).toMatchObject({
        status: 'pending',
        attempts: 1,
        available_at: '2026-07-22T16:00:30.000Z',
        last_error: 'provider unavailable',
      });

      harness.setNow(new Date('2026-07-22T16:00:29.999Z'));
      expect(await drainDurableQueue(harness.env, 'ingest', handlers, { now: harness.now }))
        .toEqual({ claimed: 0, completed: 0, retried: 0, failed: 0 });

      harness.setNow(new Date('2026-07-22T16:00:30.000Z'));
      expect(await drainDurableQueue(harness.env, 'ingest', handlers, { now: harness.now }))
        .toEqual({ claimed: 1, completed: 1, retried: 0, failed: 0 });
      expect((await harness.rows())[0]).toMatchObject({ status: 'completed', attempts: 2, last_error: null });
    } finally {
      harness.client.close();
    }
  });

  it('honors finite handler-requested retry delays', async () => {
    const harness = await createHarness();
    try {
      await harness.ingest.send({ type: 'filing.fetched', docId: 'retry-after' });
      const handlers = createHandlers({
        handleIngestMessage: vi.fn(async () => {
          throw Object.assign(new Error('rate limited'), { delaySeconds: 123 });
        }),
      });

      expect(await drainDurableQueue(harness.env, 'ingest', handlers, {
        now: harness.now,
      })).toEqual({ claimed: 1, completed: 0, retried: 1, failed: 0 });
      expect((await harness.rows())[0]).toMatchObject({
        status: 'pending',
        available_at: '2026-07-22T16:02:03.000Z',
      });
    } finally {
      harness.client.close();
    }
  });

  it('reclaims an expired processing lease without touching a live lease', async () => {
    const harness = await createHarness();
    try {
      await harness.ingest.sendBatch([
        { body: { type: 'filing.fetched', docId: 'stale' } },
        { body: { type: 'filing.fetched', docId: 'live' } },
      ]);
      await harness.client.execute({
        sql: `UPDATE deno_runtime_queue
              SET status = 'processing', attempts = 1, lease_until = ?
              WHERE id = ?`,
        args: ['2026-07-22T15:59:59.000Z', 1],
      });
      await harness.client.execute({
        sql: `UPDATE deno_runtime_queue
              SET status = 'processing', attempts = 1, lease_until = ?
              WHERE id = ?`,
        args: ['2026-07-22T16:05:00.000Z', 2],
      });
      const handlers = createHandlers();

      expect(await drainDurableQueue(harness.env, 'ingest', handlers, { now: harness.now }))
        .toEqual({ claimed: 1, completed: 1, retried: 0, failed: 0 });
      expect(handlers.handleIngestMessage).toHaveBeenCalledWith(
        expect.objectContaining({ DB: expect.anything() }),
        { type: 'filing.fetched', docId: 'stale' },
        2,
        expect.any(Object),
      );
      expect(await harness.rows()).toEqual([
        expect.objectContaining({ status: 'completed', attempts: 2, lease_until: null }),
        expect.objectContaining({ status: 'processing', attempts: 1, lease_until: '2026-07-22T16:05:00.000Z' }),
      ]);
    } finally {
      harness.client.close();
    }
  });

  it('gives concurrent claimers disjoint jobs', async () => {
    const harness = await createHarness();
    try {
      await harness.ingest.sendBatch([
        { body: { type: 'filing.fetched', docId: 'concurrent-a' } },
        { body: { type: 'filing.fetched', docId: 'concurrent-b' } },
      ]);
      const seen: string[] = [];
      const handlers = createHandlers({
        handleIngestMessage: vi.fn(async (_env, message) => {
          if (message.type === 'filing.fetched') seen.push(message.docId);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }),
      });

      const results = await Promise.all([
        drainDurableQueue(harness.env, 'ingest', handlers, {
          now: harness.now,
          limit: 1,
          claimSize: 1,
        }),
        drainDurableQueue(harness.env, 'ingest', handlers, {
          now: harness.now,
          limit: 1,
          claimSize: 1,
        }),
      ]);
      expect(results).toEqual([
        { claimed: 1, completed: 1, retried: 0, failed: 0 },
        { claimed: 1, completed: 1, retried: 0, failed: 0 },
      ]);
      expect(seen.sort()).toEqual(['concurrent-a', 'concurrent-b']);
    } finally {
      harness.client.close();
    }
  });

  it('rejects completion from a stale lease token', async () => {
    const harness = await createHarness();
    try {
      await harness.ingest.send({ type: 'filing.fetched', docId: 'stale-worker' });
      let releaseHandler!: () => void;
      const handlerBlocked = new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      let handlerStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        handlerStarted = resolve;
      });
      const handlers = createHandlers({
        handleIngestMessage: vi.fn(async () => {
          handlerStarted();
          await handlerBlocked;
        }),
      });

      const drain = drainDurableQueue(harness.env, 'ingest', handlers, {
        now: harness.now,
        limit: 1,
      });
      await started;
      await harness.client.execute(`
        UPDATE deno_runtime_queue
           SET lease_token = 'replacement-owner',
               lease_until = '2026-07-22T16:20:00.000Z'
         WHERE id = 1
      `);
      releaseHandler();

      await expect(drain).resolves.toEqual({
        claimed: 1,
        completed: 0,
        retried: 0,
        failed: 0,
      });
      expect((await harness.rows())[0]).toMatchObject({
        status: 'processing',
        lease_until: '2026-07-22T16:20:00.000Z',
      });
    } finally {
      harness.client.close();
    }
  });

  it('fences handler side effects after lease ownership is lost', async () => {
    const harness = await createHarness();
    try {
      await harness.ingest.send({ type: 'filing.fetched', docId: 'fenced-worker' });
      let releaseHandler!: () => void;
      const handlerBlocked = new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      let handlerStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        handlerStarted = resolve;
      });
      let sideEffectCommitted = false;
      const handlers = createHandlers({
        handleIngestMessage: vi.fn(async (guardedEnv) => {
          handlerStarted();
          await handlerBlocked;
          await guardedEnv.INGEST_QUEUE.send({
            type: 'filing.fetched',
            docId: 'must-not-enqueue',
          });
          sideEffectCommitted = true;
        }),
      });

      const drain = drainDurableQueue(harness.env, 'ingest', handlers, {
        now: harness.now,
        limit: 1,
      });
      await started;
      await harness.client.execute(`
        UPDATE deno_runtime_queue
           SET lease_token = 'replacement-owner',
               lease_until = '2026-07-22T16:20:00.000Z'
         WHERE id = 1
      `);
      releaseHandler();

      await expect(drain).resolves.toEqual({
        claimed: 1,
        completed: 0,
        retried: 0,
        failed: 0,
      });
      expect(sideEffectCommitted).toBe(false);
      expect(await harness.rows()).toHaveLength(1);
    } finally {
      harness.client.close();
    }
  });

  it('fences R2 object body reads after lease ownership is lost', async () => {
    const harness = await createHarness();
    try {
      await harness.ingest.send({ type: 'filing.fetched', docId: 'fenced-r2-read' });
      const arrayBuffer = vi.fn(async () => new ArrayBuffer(1));
      (harness.env as Env & { RAW_FILES: unknown }).RAW_FILES = {
        get: vi.fn(async () => ({ arrayBuffer })),
      };
      const handlers = createHandlers({
        handleIngestMessage: vi.fn(async (guardedEnv) => {
          const object = await guardedEnv.RAW_FILES.get('raw/fenced-r2-read');
          await harness.client.execute(`
            UPDATE deno_runtime_queue
               SET lease_token = 'replacement-owner',
                   lease_until = '2026-07-22T16:20:00.000Z'
             WHERE id = 1
          `);
          await object?.arrayBuffer();
        }),
      });

      await expect(drainDurableQueue(harness.env, 'ingest', handlers, {
        now: harness.now,
        limit: 1,
      })).resolves.toEqual({ claimed: 1, completed: 0, retried: 0, failed: 0 });
      expect(arrayBuffer).not.toHaveBeenCalled();
      expect(await harness.rows()).toHaveLength(1);
    } finally {
      harness.client.close();
    }
  });

  it('fences R2 body stream reads after lease ownership is lost', async () => {
    const harness = await createHarness();
    try {
      await harness.ingest.send({ type: 'filing.fetched', docId: 'fenced-r2-stream' });
      const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      });
      (harness.env as Env & { RAW_FILES: unknown }).RAW_FILES = {
        get: vi.fn(async () => ({ body: new ReadableStream<Uint8Array>({ pull }) })),
      };
      const handlers = createHandlers({
        handleIngestMessage: vi.fn(async (guardedEnv) => {
          const object = await guardedEnv.RAW_FILES.get('raw/fenced-r2-stream');
          await harness.client.execute(`
            UPDATE deno_runtime_queue
               SET lease_token = 'replacement-owner',
                   lease_until = '2026-07-22T16:20:00.000Z'
             WHERE id = 1
          `);
          await object?.body.getReader().read();
        }),
      });

      await expect(drainDurableQueue(harness.env, 'ingest', handlers, {
        now: harness.now,
        limit: 1,
      })).resolves.toEqual({ claimed: 1, completed: 0, retried: 0, failed: 0 });
      expect(await harness.rows()).toHaveLength(1);
    } finally {
      harness.client.close();
    }
  });

  it('completes delivery outboxes only after successful canonical dispatch', async () => {
    const harness = await createHarness();
    try {
      await harness.delivery.send({ type: 'delivery.dispatch', txId: 'tx-retry' });
      const deliveryHandler = vi.fn(async () => true);
      deliveryHandler.mockRejectedValueOnce(new Error('webhook timeout'));
      const completeDelivery = vi.fn(async () => 'completed');
      const handlers = createHandlers({
        handleDeliveryMessage: deliveryHandler,
        completeDeliveryOutbox: completeDelivery,
      });

      expect(await drainDurableQueue(harness.env, 'delivery', handlers, { now: harness.now }))
        .toEqual({ claimed: 1, completed: 0, retried: 1, failed: 0 });
      expect(completeDelivery).not.toHaveBeenCalled();

      harness.setNow(new Date('2026-07-22T16:00:30.000Z'));
      expect(await drainDurableQueue(harness.env, 'delivery', handlers, { now: harness.now }))
        .toEqual({ claimed: 1, completed: 1, retried: 0, failed: 0 });
      expect(completeDelivery).toHaveBeenCalledOnce();
      expect(completeDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ DB: expect.anything() }),
        'tx-retry',
      );

      await harness.delivery.send({ type: 'delivery.dispatch', txId: 'tx-no-completion' });
      deliveryHandler.mockResolvedValueOnce(false);
      expect(await drainDurableQueue(harness.env, 'delivery', handlers, { now: harness.now }))
        .toEqual({ claimed: 1, completed: 1, retried: 0, failed: 0 });
      expect(completeDelivery).toHaveBeenCalledOnce();
    } finally {
      harness.client.close();
    }
  });

  it('marks exhausted messages failed after durable dead-letter handling', async () => {
    const harness = await createHarness();
    try {
      await harness.ingest.send({ type: 'filing.fetched', docId: 'doc-poison' });
      const deadLetter = vi.fn(async () => {});
      const handlers = createHandlers({
        handleIngestMessage: vi.fn(async () => { throw new Error('poison message'); }),
        handleDeadLetterMessage: deadLetter,
      });

      expect(await drainDurableQueue(harness.env, 'ingest', handlers, {
        now: harness.now,
        maxAttempts: 1,
      })).toEqual({ claimed: 1, completed: 0, retried: 0, failed: 1 });
      expect(deadLetter).toHaveBeenCalledWith(
        expect.objectContaining({ DB: expect.anything() }),
        'ingest-dlq',
        { type: 'filing.fetched', docId: 'doc-poison' },
        1,
        expect.any(Object),
      );
      expect((await harness.rows())[0]).toMatchObject({
        status: 'failed',
        attempts: 1,
        lease_until: null,
        last_error: 'poison message',
      });
      expect(handlers.completeIngestionOutbox).not.toHaveBeenCalled();
    } finally {
      harness.client.close();
    }
  });

  it('durably retries dead-letter recovery without rerunning primary work', async () => {
    const harness = await createHarness();
    try {
      await harness.ingest.send({ type: 'filing.fetched', docId: 'dlq-retry' });
      const primary = vi.fn(async () => {
        throw new Error('primary poison');
      });
      const deadLetter = vi.fn(async () => {});
      deadLetter.mockRejectedValueOnce(new Error('receipt unavailable'));
      const handlers = createHandlers({
        handleIngestMessage: primary,
        handleDeadLetterMessage: deadLetter,
      });

      expect(await drainDurableQueue(harness.env, 'ingest', handlers, {
        now: harness.now,
        maxAttempts: 1,
      })).toEqual({ claimed: 1, completed: 0, retried: 1, failed: 0 });
      expect((await harness.rows())[0]).toMatchObject({
        status: 'pending',
        dead_letter_pending: 1,
        attempts: 1,
      });

      harness.setNow(new Date('2026-07-22T16:00:30.000Z'));
      expect(await drainDurableQueue(harness.env, 'ingest', handlers, {
        now: harness.now,
        maxAttempts: 1,
      })).toEqual({ claimed: 1, completed: 0, retried: 0, failed: 1 });
      expect(primary).toHaveBeenCalledOnce();
      expect(deadLetter).toHaveBeenCalledTimes(2);
      expect((await harness.rows())[0]).toMatchObject({
        status: 'failed',
        dead_letter_pending: 0,
        attempts: 2,
      });
    } finally {
      harness.client.close();
    }
  });

  it('terminalizes deterministic primary telemetry rejects immediately', async () => {
    const harness = await createHarness();
    try {
      const telemetry = {
        type: 'usage.telemetry',
        event: { idempotencyKey: 'primary-terminal-event' },
      } as QueueMessage;
      await harness.ingest.send(telemetry);
      const terminal = Object.assign(new Error('invalid payload'), { status: 400 });
      const primary = vi.fn(async () => {
        throw terminal;
      });
      const deadLetter = vi.fn(async () => {});
      const handlers = createHandlers({
        handleIngestMessage: primary,
        handleDeadLetterMessage: deadLetter,
        isTerminalDeadLetterError: vi.fn((_message, error) => error === terminal),
      });

      expect(await drainDurableQueue(harness.env, 'ingest', handlers, {
        now: harness.now,
      })).toEqual({ claimed: 1, completed: 0, retried: 0, failed: 1 });
      expect(primary).toHaveBeenCalledOnce();
      expect(deadLetter).not.toHaveBeenCalled();
      expect((await harness.rows())[0]).toMatchObject({
        status: 'failed',
        dead_letter_pending: 0,
        last_error: 'invalid payload',
      });
    } finally {
      harness.client.close();
    }
  });

  it('terminalizes deterministic telemetry DLQ rejects without re-pending', async () => {
    const harness = await createHarness();
    try {
      const telemetry = {
        type: 'usage.telemetry',
        event: { idempotencyKey: 'terminal-event' },
      } as QueueMessage;
      await harness.ingest.send(telemetry);
      const terminal = Object.assign(new Error('invalid payload'), { status: 400 });
      const deadLetter = vi.fn(async () => {
        throw terminal;
      });
      const handlers = createHandlers({
        handleIngestMessage: vi.fn(async () => {
          throw new Error('primary delivery failed');
        }),
        handleDeadLetterMessage: deadLetter,
        isTerminalDeadLetterError: vi.fn((_message, error) => error === terminal),
      });

      expect(await drainDurableQueue(harness.env, 'ingest', handlers, {
        now: harness.now,
        maxAttempts: 1,
      })).toEqual({ claimed: 1, completed: 0, retried: 0, failed: 1 });
      expect(deadLetter).toHaveBeenCalledOnce();
      expect((await harness.rows())[0]).toMatchObject({
        status: 'failed',
        dead_letter_pending: 0,
        last_error: 'invalid payload',
      });
    } finally {
      harness.client.close();
    }
  });

  it('rejects malformed producer messages before persistence', async () => {
    const harness = await createHarness();
    try {
      await expect(harness.ingest.send({ type: 'filing.fetched' } as QueueMessage))
        .rejects.toThrow('docId is required');
      await expect(harness.delivery.send({
        type: 'filing.fetched',
        docId: 'wrong-queue',
      } as QueueMessage)).rejects.toThrow('invalid delivery queue message type');
      expect(await harness.rows()).toHaveLength(0);
    } finally {
      harness.client.close();
    }
  });

  it('durably receipts and terminalizes corrupt legacy messages', async () => {
    const harness = await createHarness();
    try {
      await harness.client.execute({
        sql: `INSERT INTO deno_runtime_queue
          (queue_name, payload, status, attempts, dead_letter_pending,
           available_at, created_at, updated_at)
          VALUES ('ingest', ?, 'pending', 0, 0, ?, ?, ?)`,
        args: [
          JSON.stringify({ type: 'filing.fetched' }),
          START.toISOString(),
          START.toISOString(),
          START.toISOString(),
        ],
      });
      const corruptReceipt = vi.fn(async () => {});
      const handlers = createHandlers({
        handleCorruptDeadLetterMessage: corruptReceipt,
      });

      expect(await drainDurableQueue(harness.env, 'ingest', handlers, {
        now: harness.now,
        maxAttempts: 1,
      })).toEqual({ claimed: 1, completed: 0, retried: 0, failed: 1 });
      expect(corruptReceipt).toHaveBeenCalledWith(
        expect.objectContaining({ DB: expect.anything() }),
        'ingest-dlq',
        { type: 'filing.fetched' },
        1,
        expect.stringContaining('docId is required'),
        expect.any(Object),
      );
      expect((await harness.rows())[0]).toMatchObject({
        status: 'failed',
        dead_letter_pending: 0,
      });
    } finally {
      harness.client.close();
    }
  });

  it('receipts malformed JSON when resuming a pending dead-letter receipt', async () => {
    const harness = await createHarness();
    try {
      await harness.client.execute({
        sql: `INSERT INTO deno_runtime_queue
          (queue_name, payload, status, attempts, dead_letter_pending,
           available_at, last_error, created_at, updated_at)
          VALUES ('ingest', ?, 'pending', 1, 1, ?, ?, ?, ?)`,
        args: [
          '{not-json',
          START.toISOString(),
          'initial corrupt receipt failed',
          START.toISOString(),
          START.toISOString(),
        ],
      });
      const corruptReceipt = vi.fn(async () => {});
      const handlers = createHandlers({
        handleCorruptDeadLetterMessage: corruptReceipt,
      });

      expect(await drainDurableQueue(harness.env, 'ingest', handlers, {
        now: harness.now,
        maxAttempts: 1,
      })).toEqual({ claimed: 1, completed: 0, retried: 0, failed: 1 });
      expect(corruptReceipt).toHaveBeenCalledWith(
        expect.anything(),
        'ingest-dlq',
        '{not-json',
        2,
        'initial corrupt receipt failed',
        expect.any(Object),
      );
      expect((await harness.rows())[0]).toMatchObject({
        status: 'failed',
        dead_letter_pending: 0,
      });
    } finally {
      harness.client.close();
    }
  });
});
