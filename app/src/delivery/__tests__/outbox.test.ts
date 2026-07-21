import { describe, expect, it, vi } from 'vitest';
import {
  completeDeliveryOutbox,
  DELIVERY_ENQUEUED_STALE_MS,
  DELIVERY_TARGETED_ID_LIMIT,
  flushDeliveryOutbox,
  reconnectDeadLetteredOutbox,
} from '../outbox.ts';
import type { Env } from '../../shared/types.ts';

function makeEnv(sendFails = false) {
  const row = { tx_id: 'tx_1', status: 'pending', attempts: 0, dead_letter_cycles: 0, available_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', last_error: null as string | null };
  const boundParamCounts: number[] = [];
  const prepare = (sql: string) => ({ params: [] as unknown[], bind(...params: unknown[]) { this.params = params; boundParamCounts.push(params.length); return this; },
    async all<T>() {
      if (/WHERE tx_id = \?/i.test(sql)) return { results: [row] as T[] };
      const now = String(this.params[0]);
      const staleBefore = String(this.params[1]);
      const ready = (['pending', 'sending'].includes(row.status) && row.available_at <= now)
        || (row.status === 'enqueued' && row.updated_at <= staleBefore);
      return { results: ready ? [row] as T[] : [] as T[] };
    },
    async run() {
      if (/SET status = 'sending'/i.test(sql)) { row.status = 'sending'; row.attempts++; row.available_at = String(this.params[0]); row.updated_at = String(this.params[1]); }
      else if (/SET status = 'enqueued'/i.test(sql)) { row.status = 'enqueued'; row.available_at = String(this.params[0]); row.updated_at = String(this.params[1]); }
      else if (/SET status = 'completed'/i.test(sql)) {
        if (row.status === 'completed') return { success: true, meta: { changes: 0 } };
        row.status = 'completed'; row.available_at = String(this.params[0]); row.updated_at = String(this.params[1]);
      }
      else if (/SET status = 'pending'/i.test(sql)) {
        row.status = 'pending'; row.available_at = String(this.params[0]); row.last_error = String(this.params[1]); row.updated_at = String(this.params[2]);
        if (/dead_letter_cycles = dead_letter_cycles \+ 1/i.test(sql)) row.dead_letter_cycles += 1;
      }
      else if (/SET status = 'failed'/i.test(sql)) { row.status = 'failed'; row.last_error = String(this.params[0]); }
      return { success: true, meta: { changes: 1 } };
    },
  });
  const send = vi.fn(async () => { if (sendFails) throw new Error('queue unavailable'); });
  return { row, send, boundParamCounts, env: { DB: { prepare } as unknown as D1Database, DELIVERY_QUEUE: { send } } as unknown as Env };
}

describe('delivery outbox', () => {
  it('claims, enqueues, and completes a ready row', async () => {
    const { env, row, send } = makeEnv();
    expect(await flushDeliveryOutbox(env, { now: new Date('2026-07-01T00:00:00.000Z') })).toEqual({ claimed: 1, enqueued: 1, failed: 0 });
    expect(send).toHaveBeenCalledWith({ type: 'delivery.dispatch', txId: 'tx_1' });
    expect(row.status).toBe('enqueued');
    expect(await completeDeliveryOutbox(env, 'tx_1', new Date('2026-07-01T00:00:01.000Z'))).toBe('completed');
    expect(row.status).toBe('completed');
  });

  it('never replays a completed row', async () => {
    const { env, row, send } = makeEnv();
    row.status = 'enqueued'; row.updated_at = '2026-01-01T00:00:00.000Z';
    await completeDeliveryOutbox(env, 'tx_1', new Date('2026-01-01T01:00:00.000Z'));
    expect(await flushDeliveryOutbox(env, { now: new Date('2027-01-01T00:00:00.000Z') }))
      .toEqual({ claimed: 0, enqueued: 0, failed: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(row.status).toBe('completed');
    expect(await reconnectDeadLetteredOutbox(env, 'tx_1', 'late duplicate DLQ'))
      .toEqual({ status: 'completed', deadLetterCycles: 0 });
  });

  it('replays stale enqueued work after finite DLQ loss but ignores fresh enqueued work', async () => {
    const now = new Date('2026-07-01T04:00:00.000Z');
    const stale = makeEnv();
    stale.row.status = 'enqueued';
    stale.row.updated_at = new Date(now.getTime() - DELIVERY_ENQUEUED_STALE_MS - 1).toISOString();
    expect(await flushDeliveryOutbox(stale.env, { now })).toEqual({ claimed: 1, enqueued: 1, failed: 0 });
    expect(stale.send).toHaveBeenCalledOnce();

    const fresh = makeEnv();
    fresh.row.status = 'enqueued';
    fresh.row.updated_at = new Date(now.getTime() - DELIVERY_ENQUEUED_STALE_MS + 1).toISOString();
    expect(await flushDeliveryOutbox(fresh.env, { now })).toEqual({ claimed: 0, enqueued: 0, failed: 0 });
    expect(fresh.send).not.toHaveBeenCalled();
  });

  it('returns a failed send to pending with a durable error', async () => {
    const { env, row } = makeEnv(true);
    expect(await flushDeliveryOutbox(env, { now: new Date('2026-07-01T00:00:00.000Z') })).toEqual({ claimed: 1, enqueued: 0, failed: 1 });
    expect(row.status).toBe('pending');
    expect(row.last_error).toBe('queue unavailable');
  });

  it('pages a large targeted flush below the D1 bind-parameter ceiling', async () => {
    const { env, boundParamCounts } = makeEnv();
    const txIds = Array.from({ length: 223 }, (_, index) => `tx_${index}`);
    await flushDeliveryOutbox(env, { txIds, limit: txIds.length, now: new Date('2026-07-01T00:00:00.000Z') });
    expect(Math.max(...boundParamCounts)).toBeLessThanOrEqual(DELIVERY_TARGETED_ID_LIMIT + 2);
  });

  it('reconnects an unexpected dead-letter with backoff', async () => {
    const { env, row } = makeEnv();
    row.status = 'enqueued'; row.attempts = 99;
    expect(await reconnectDeadLetteredOutbox(env, 'tx_1', 'consumer crashed', new Date('2026-07-01T00:00:00.000Z')))
      .toEqual({ status: 'pending', deadLetterCycles: 1 });
    expect(row.status).toBe('pending');
    expect(row.last_error).toBe('consumer crashed');
    expect(row.available_at).toBe('2026-07-01T00:00:30.000Z');
    expect(await reconnectDeadLetteredOutbox(env, 'tx_1', 'same DLQ redelivery'))
      .toEqual({ status: 'pending', deadLetterCycles: 1 });
    expect(row.dead_letter_cycles).toBe(1);
  });

  it('caps poison dead-letter cycles in a failed state', async () => {
    const { env, row } = makeEnv();
    row.status = 'enqueued'; row.attempts = 0; row.dead_letter_cycles = 5;
    expect(await reconnectDeadLetteredOutbox(env, 'tx_1', 'poison'))
      .toEqual({ status: 'failed', deadLetterCycles: 5 });
    expect(row.status).toBe('failed');
  });
});
