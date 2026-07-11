import { describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/cloudflare', () => ({
  withSentry: (_opts: unknown, handler: unknown) => handler,
  setTags: vi.fn(), captureException: vi.fn(),
  withMonitor: (_slug: string, callback: () => unknown) => callback(),
  consoleLoggingIntegration: vi.fn(() => ({})),
}));

import worker from '../../index';
import type { Env, QueueMessage } from '../../shared/types';

function queueMessage(body: QueueMessage, attempts = 1) {
  return { body, attempts, ack: vi.fn(), retry: vi.fn() };
}

describe('authoritative dead-letter queue recovery', () => {
  it('leaves final main-queue recovery to the DLQ consumer, which records, reopens, then ACKs', async () => {
    const updates: Array<{ sql: string; params: unknown[] }> = [];
    const outbox = {
      tx_id: 'tx_1', status: 'enqueued', attempts: 99, dead_letter_cycles: 0,
      available_at: '2026-01-01T00:00:00.000Z',
    };
    const prepare = (sql: string) => ({
      params: [] as unknown[], bind(...params: unknown[]) { this.params = params; return this; },
      async first<T>() {
        if (/FROM transactions WHERE id/i.test(sql)) throw new Error('unexpected consumer poison');
        return null as T | null;
      },
      async all<T>() {
        if (/FROM delivery_outbox WHERE tx_id/i.test(sql)) return { results: [outbox] as T[] };
        return { results: [] as T[] };
      },
      async run() {
        updates.push({ sql, params: this.params });
        if (/UPDATE delivery_outbox/i.test(sql) && /dead_letter_cycles/i.test(sql)) {
          outbox.status = 'pending'; outbox.dead_letter_cycles += 1;
        }
        return { success: true, meta: { changes: 1 } };
      },
    });
    const env = {
      DB: { prepare } as unknown as D1Database,
      CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
    } as unknown as Env;
    const body = { type: 'delivery.dispatch', txId: 'tx_1' } as QueueMessage;

    const main = queueMessage(body, 9);
    await worker.queue(
      { queue: 'congress-feed-delivery', messages: [main] } as unknown as MessageBatch<QueueMessage>,
      env,
      {} as ExecutionContext,
    );
    expect(main.retry).toHaveBeenCalledOnce();
    expect(main.ack).not.toHaveBeenCalled();
    expect(updates.some((entry) => /UPDATE delivery_outbox/i.test(entry.sql))).toBe(false);

    const dlq = queueMessage(body);
    await worker.queue(
      { queue: 'congress-feed-delivery-dlq', messages: [dlq] } as unknown as MessageBatch<QueueMessage>,
      env,
      {} as ExecutionContext,
    );
    expect(updates.some((entry) => /INSERT INTO dead_letter_events/i.test(entry.sql))).toBe(true);
    expect(updates.some((entry) => /UPDATE delivery_outbox/i.test(entry.sql))).toBe(true);
    expect(outbox).toMatchObject({ status: 'pending', attempts: 99, dead_letter_cycles: 1 });
    expect(dlq.ack).toHaveBeenCalledOnce();
    expect(dlq.retry).not.toHaveBeenCalled();
  });

  it('reopens the ingestion outbox for a later-stage DLQ message', async () => {
    const updates: string[] = [];
    const outbox = {
      doc_id: 'doc_1', chamber: 'house', source_url: 'https://example.com/doc.pdf',
      status: 'enqueued', attempts: 7, dead_letter_cycles: 0,
      available_at: '2026-01-01T00:00:00.000Z',
    };
    const env = {
      DB: {
        prepare: (sql: string) => ({
          params: [] as unknown[], bind(...params: unknown[]) { this.params = params; return this; },
          async all<T>() {
            return { results: /FROM ingestion_outbox/i.test(sql) ? [outbox] as T[] : [] as T[] };
          },
          async run() {
            updates.push(sql);
            if (/UPDATE ingestion_outbox/i.test(sql)) {
              outbox.status = 'pending'; outbox.dead_letter_cycles += 1;
            }
            return { success: true, meta: { changes: 1 } };
          },
        }),
      } as unknown as D1Database,
      CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
    } as unknown as Env;
    const message = queueMessage({ type: 'filing.extracted', docId: 'doc_1' });
    await worker.queue(
      { queue: 'congress-feed-ingest-dlq', messages: [message] } as unknown as MessageBatch<QueueMessage>,
      env,
      {} as ExecutionContext,
    );
    expect(updates.some((sql) => /INSERT INTO dead_letter_events/i.test(sql))).toBe(true);
    expect(updates.some((sql) => /UPDATE ingestion_outbox/i.test(sql))).toBe(true);
    expect(outbox).toMatchObject({ status: 'pending', attempts: 7, dead_letter_cycles: 1 });
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('does not ACK when the durable terminal receipt cannot be written', async () => {
    const env = {
      DB: {
        prepare: () => ({ bind() { return this; }, async run() { throw new Error('D1 unavailable'); } }),
      } as unknown as D1Database,
      CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
    } as unknown as Env;
    const message = queueMessage({ type: 'delivery.dispatch', txId: 'tx_1' });
    await worker.queue(
      { queue: 'congress-feed-delivery-dlq', messages: [message] } as unknown as MessageBatch<QueueMessage>,
      env,
      {} as ExecutionContext,
    );
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
  });
});
