import { describe, expect, it } from 'vitest';
import type { Env } from '../../shared/types';
import {
  claimStripeWebhookEvent,
  markStripeWebhookEventProcessed,
  releaseStripeWebhookEvent,
} from '../webhookEvents';

interface EventRow {
  eventType: string;
  receivedAt: string;
  processedAt: string | null;
  claimToken: string | null;
  claimExpiresAt: string | null;
}

function fakeEnv(): { env: Env; events: Map<string, EventRow> } {
  const events = new Map<string, EventRow>();
  const env = {
    DB: {
      prepare: (sql: string) => ({
        _params: [] as unknown[],
        bind(...params: unknown[]) {
          this._params = params;
          return this;
        },
        async first<T>() {
          if (/SELECT processed_at FROM stripe_webhook_events/i.test(sql)) {
            const row = events.get(this._params[0] as string);
            return (row ? { processed_at: row.processedAt } : null) as T | null;
          }
          return null as T | null;
        },
        async run() {
          const params = this._params;
          if (/INSERT OR IGNORE INTO stripe_webhook_events/i.test(sql)) {
            const [eventId, eventType, receivedAt, claimToken, claimExpiresAt] = params as [
              string, string, string, string, string,
            ];
            if (events.has(eventId)) return { success: true, meta: { changes: 0 } } as unknown as D1Result;
            events.set(eventId, { eventType, receivedAt, processedAt: null, claimToken, claimExpiresAt });
            return { success: true, meta: { changes: 1 } } as unknown as D1Result;
          }
          if (/SET event_type = \?, claim_token = \?/i.test(sql)) {
            const [eventType, claimToken, claimExpiresAt, eventId, now] = params as [
              string, string, string, string, string,
            ];
            const row = events.get(eventId);
            if (
              row
              && !row.processedAt
              && (!row.claimToken || !row.claimExpiresAt || row.claimExpiresAt <= now)
            ) {
              Object.assign(row, { eventType, claimToken, claimExpiresAt });
              return { success: true, meta: { changes: 1 } } as unknown as D1Result;
            }
            return { success: true, meta: { changes: 0 } } as unknown as D1Result;
          }
          if (/SET processed_at = \?, claim_token = NULL/i.test(sql)) {
            const [processedAt, eventId, claimToken] = params as [string, string, string];
            const row = events.get(eventId);
            if (row && !row.processedAt && row.claimToken === claimToken) {
              Object.assign(row, { processedAt, claimToken: null, claimExpiresAt: null });
              return { success: true, meta: { changes: 1 } } as unknown as D1Result;
            }
            return { success: true, meta: { changes: 0 } } as unknown as D1Result;
          }
          if (/SET claim_token = NULL, claim_expires_at = NULL/i.test(sql)) {
            const [eventId, claimToken] = params as [string, string];
            const row = events.get(eventId);
            if (row && !row.processedAt && row.claimToken === claimToken) {
              Object.assign(row, { claimToken: null, claimExpiresAt: null });
              return { success: true, meta: { changes: 1 } } as unknown as D1Result;
            }
            return { success: true, meta: { changes: 0 } } as unknown as D1Result;
          }
          return { success: true, meta: { changes: 0 } } as unknown as D1Result;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
      }),
    },
  } as unknown as Env;
  return { env, events };
}

describe('Stripe webhook claim leases', () => {
  it('reclaims an expired hard-crash claim and rejects the stale owner', async () => {
    const { env } = fakeEnv();
    const first = await claimStripeWebhookEvent(env, 'evt_1', 'invoice.paid', {
      now: new Date('2026-01-01T00:00:00.000Z'),
      leaseSeconds: 60,
      claimToken: 'worker-a',
    });
    expect(first).toEqual({ status: 'claimed', claimToken: 'worker-a' });

    const busy = await claimStripeWebhookEvent(env, 'evt_1', 'invoice.paid', {
      now: new Date('2026-01-01T00:00:30.000Z'),
      leaseSeconds: 60,
      claimToken: 'worker-b',
    });
    expect(busy).toEqual({ status: 'busy' });

    const reclaimed = await claimStripeWebhookEvent(env, 'evt_1', 'invoice.paid', {
      now: new Date('2026-01-01T00:01:01.000Z'),
      leaseSeconds: 60,
      claimToken: 'worker-b',
    });
    expect(reclaimed).toEqual({ status: 'claimed', claimToken: 'worker-b' });
    expect(await markStripeWebhookEventProcessed(env, 'evt_1', 'worker-a')).toBe(false);
    expect(await markStripeWebhookEventProcessed(env, 'evt_1', 'worker-b')).toBe(true);

    expect(await claimStripeWebhookEvent(env, 'evt_1', 'invoice.paid', {
      now: new Date('2026-01-01T00:01:02.000Z'),
      claimToken: 'worker-c',
    })).toEqual({ status: 'duplicate' });
  });

  it('releases only the current owner and permits an immediate retry', async () => {
    const { env, events } = fakeEnv();
    await claimStripeWebhookEvent(env, 'evt_2', 'invoice.paid', {
      now: new Date('2026-01-01T00:00:00.000Z'),
      claimToken: 'worker-a',
    });
    expect(await releaseStripeWebhookEvent(env, 'evt_2', 'worker-b')).toBe(false);
    expect(events.get('evt_2')?.claimToken).toBe('worker-a');
    expect(await releaseStripeWebhookEvent(env, 'evt_2', 'worker-a')).toBe(true);

    expect(await claimStripeWebhookEvent(env, 'evt_2', 'invoice.paid', {
      now: new Date('2026-01-01T00:00:01.000Z'),
      claimToken: 'worker-b',
    })).toEqual({ status: 'claimed', claimToken: 'worker-b' });
  });
});
