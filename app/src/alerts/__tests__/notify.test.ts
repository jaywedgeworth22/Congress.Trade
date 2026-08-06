import { describe, it, expect, afterEach, vi } from 'vitest';
import { notifyAdmin } from '../notify.ts';
import type { Env } from '../../shared/types.ts';

function fakeEnv(over: Record<string, unknown> = {}): { env: Env; kv: Map<string, string> } {
  const kv = new Map<string, string>();
  const env = {
    CONFIG_KV: {
      get: async (k: string) => (kv.has(k) ? kv.get(k)! : null),
      put: async (k: string, v: string) => {
        kv.set(k, v);
      },
      delete: async (k: string) => {
        kv.delete(k);
      },
    },
    ...over,
  } as unknown as Env;
  return { env, kv };
}

const configured = {
  ALERT_EMAIL: 'admin@congress.trade',
  RESEND_API_KEY: 're_x',
  EMAIL_FROM: 'Congress.Trade <login@congress.trade>',
};

const alert = { subject: 'S', text: 'T', dedupeKey: 'fmp-tier-failure' };

describe('notifyAdmin', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('no-ops when ALERT_EMAIL is unset', async () => {
    const { env } = fakeEnv({ RESEND_API_KEY: 're_x', EMAIL_FROM: 'a@b.com' });
    expect(await notifyAdmin(env, alert)).toEqual({ sent: false, reason: 'ALERT_EMAIL not set' });
  });

  it('no-ops when email transport is not configured', async () => {
    const { env } = fakeEnv({ ALERT_EMAIL: 'admin@x.com' });
    const res = await notifyAdmin(env, alert);
    expect(res.sent).toBe(false);
    expect(res.reason).toMatch(/not configured/);
  });

  it('sends via Resend, stamps the throttle, then throttles the next call', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      calls++;
      expect(String(url)).toContain('api.resend.com');
      return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 });
    });
    const { env, kv } = fakeEnv(configured);

    const first = await notifyAdmin(env, alert);
    expect(first).toEqual({ sent: true });
    expect(calls).toBe(1);
    expect(kv.has('alert:fmp-tier-failure')).toBe(true);

    // Same dedupeKey within the window → throttled, no second send.
    const second = await notifyAdmin(env, alert);
    expect(second).toEqual({ sent: false, reason: 'throttled' });
    expect(calls).toBe(1);
  });

  it('reports the transport error when Resend fails', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }));
    const { env } = fakeEnv(configured);
    const res = await notifyAdmin(env, alert);
    expect(res.sent).toBe(false);
    expect(res.reason).toMatch(/email send failed/i);
  });
});
