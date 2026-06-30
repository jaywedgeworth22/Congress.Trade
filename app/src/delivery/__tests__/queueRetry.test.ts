/**
 * Regression coverage for delivery retry metadata flowing through the Worker
 * queue router. Retry messages must keep subscriptionId + attempt so a failed
 * webhook retry does not fan out to every subscriber again.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

// Sentry's queue instrumentation requires AsyncLocalStorage which isn't
// available in vitest. Mock withSentry as a pass-through so tests that call
// worker.queue() directly don't crash on isolation-scope setup.
vi.mock('@sentry/cloudflare', () => ({
  withSentry: (_opts: unknown, handler: unknown) => handler,
}));

import worker from '../../index';
import type { Env, QueueMessage } from '../../shared/types';

const txRow = {
  id: 'tx_1',
  doc_id: 'doc_1',
  filer_id: 'bio_1',
  tx_date: '2026-06-20',
  owner: 'self',
  asset_name: 'Apple Inc.',
  ticker: 'AAPL',
  asset_type: 'stock',
  tx_type: 'P',
  amount_min: 1001,
  amount_max: 15000,
  is_option: 0,
  cap_gains_over_200: 0,
  raw_text: 'AAPL purchase',
  confidence: 0.99,
  source: 'primary',
  created_at: '2026-06-20T00:00:00.000Z',
  cursor_seq: 42,
};

const subRow = {
  id: 'sub_retry',
  client_id: 'client_1',
  delivery: 'webhook',
  target_url: 'https://example.com/hook',
  secret: 'sub_secret',
  filters: '{}',
  cursor: 0,
  active: 1,
  created_at: '2026-06-20T00:00:00.000Z',
};

function fakeEnv(deliveryStatus: 'failed' | 'delivered' | null = 'failed') {
  const sent: Array<{ body: unknown; options: unknown }> = [];
  const prepares: string[] = [];

  const prepare = (sql: string) => {
    prepares.push(sql);
    return {
      params: [] as unknown[],
      bind(...params: unknown[]) {
        this.params = params;
        return this;
      },
      async first<T>() {
        if (/FROM transactions WHERE id = \?/i.test(sql)) return txRow as T;
        if (/SELECT chamber FROM filings WHERE doc_id = \?/i.test(sql)) {
          return { chamber: 'house' } as T;
        }
        if (/FROM subscriptions WHERE id = \?/i.test(sql)) return subRow as T;
        if (/FROM deliveries WHERE subscription_id = \? AND tx_id = \?/i.test(sql)) {
          return deliveryStatus
            ? ({ id: 'dlv_1', status: deliveryStatus, attempts: 2 } as T)
            : (null as T | null);
        }
        return null as T | null;
      },
      async all<T>() {
        if (/active = 1 AND delivery = 'webhook'/i.test(sql)) {
          throw new Error('retry metadata was dropped and fan-out path was used');
        }
        return { results: [] as T[] };
      },
      async run() {
        return { success: true };
      },
    };
  };

  const env = {
    DB: { prepare } as unknown as D1Database,
    DELIVERY_QUEUE: {
      send: vi.fn(async (body: unknown, options: unknown) => {
        sent.push({ body, options });
      }),
    },
    WEBHOOK_SIGNING_KEY: 'fallback_secret',
  } as unknown as Env;

  return { env, sent, prepares };
}

describe('delivery queue retry routing', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('preserves subscriptionId and attempt through index.queue', async () => {
    const { env, sent } = fakeEnv();
    const fetchMock = vi.fn(async () => new Response('nope', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const ack = vi.fn();
    const retry = vi.fn();
    const body = {
      type: 'delivery.dispatch',
      txId: 'tx_1',
      subscriptionId: 'sub_retry',
      attempt: 3,
    } as QueueMessage & { subscriptionId: string; attempt: number };
    const batch = {
      queue: 'congress-feed-delivery',
      messages: [{ body, ack, retry }],
    } as unknown as MessageBatch<QueueMessage>;

    await worker.queue(batch, env, {} as ExecutionContext);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({
      'X-Subscription-Id': 'sub_retry',
      'X-Delivery-Attempt': '3',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({
      type: 'delivery.dispatch',
      txId: 'tx_1',
      subscriptionId: 'sub_retry',
      attempt: 4,
    });
    expect(sent[0].options).toMatchObject({ delaySeconds: expect.any(Number) });
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it('skips webhook POST when delivery already succeeded', async () => {
    const { env, sent } = fakeEnv('delivered');
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const ack = vi.fn();
    const retry = vi.fn();
    const body = {
      type: 'delivery.dispatch',
      txId: 'tx_1',
      subscriptionId: 'sub_retry',
      attempt: 3,
    } as QueueMessage & { subscriptionId: string; attempt: number };
    const batch = {
      queue: 'congress-feed-delivery',
      messages: [{ body, ack, retry }],
    } as unknown as MessageBatch<QueueMessage>;

    await worker.queue(batch, env, {} as ExecutionContext);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });
});
