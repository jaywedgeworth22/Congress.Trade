import { describe, expect, it, vi } from 'vitest';
import { trackedOperatorFetch } from '../usage-telemetry.mjs';

describe('trackedOperatorFetch', () => {
  it('reports one secret-safe request event', async () => {
    const credential = 'do-not-send-this-secret';
    const events = [];
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));

    const response = await trackedOperatorFetch(
      `https://www.sec.gov/files/company_tickers.json?token=${credential}`,
      { headers: { authorization: `Bearer ${credential}` } },
      { provider: 'sec-edgar', service: 'seed-maintenance', operation: 'fetch-company-tickers' },
      {
        env: { USAGE_MONITOR_ENVIRONMENT: 'test' },
        fetchImpl,
        now: () => 1234,
        sendUsage: async (event) => events.push(event),
      },
    );

    expect(response.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sourceApp: 'congress-trade',
      environment: 'test',
      provider: 'sec-edgar',
      service: 'seed-maintenance',
      label: 'fetch-company-tickers',
      quantity: 1,
      unit: 'request',
      requests: 1,
      metadata: { success: true, status: 200, rateLimited: false },
    });
    expect(JSON.stringify(events)).not.toContain(credential);
    expect(JSON.stringify(events)).not.toContain('sec.gov');
  });

  it('refuses an untracked provider call when Usage Monitor config is missing', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));

    await expect(trackedOperatorFetch(
      'https://www.sec.gov/files/company_tickers.json',
      undefined,
      { provider: 'sec-edgar', service: 'seed-maintenance', operation: 'fetch-company-tickers' },
      { env: {}, fetchImpl },
    )).rejects.toThrow('operator usage telemetry is required');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces Usage Monitor delivery failure without leaking provider data', async () => {
    const secret = 'provider-secret';
    await expect(trackedOperatorFetch(
      `https://www.sec.gov/files/company_tickers.json?key=${secret}`,
      undefined,
      { provider: 'sec-edgar', service: 'seed-maintenance', operation: 'fetch-company-tickers' },
      {
        env: { USAGE_MONITOR_ENVIRONMENT: 'test' },
        fetchImpl: async () => new Response('{}', { status: 200 }),
        sendUsage: async () => { throw new Error(secret); },
      },
    )).rejects.toThrow('operator usage telemetry delivery failed (Error)');
  });
});
