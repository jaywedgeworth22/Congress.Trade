import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from './types.ts';

/**
 * shared/monitorBudgetGate.ts: the read-side self-throttle feedback loop.
 * Covers the three contractual behaviors called out in its module doc:
 *   - a provider the monitor reports over budget -> throttle
 *   - a provider comfortably under budget -> no throttle
 *   - the monitor being unreachable/unconfigured -> fail OPEN (no throttle)
 */

async function loadGate(secretValues: Record<string, string | undefined>) {
  vi.resetModules();
  const resolveSecrets = vi.fn(async (_env: unknown, keys: string[]) =>
    Object.fromEntries(keys.map((key) => [key, secretValues[key]])),
  );
  vi.doMock('../secrets/infisical', () => ({ resolveSecrets }));
  const mod = await import('./monitorBudgetGate.ts');
  mod.__resetMonitorBudgetGateCacheForTests();
  return { ...mod, resolveSecrets };
}

function fakeEnv(over: Record<string, unknown> = {}): Env {
  return { ...over } as unknown as Env;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

const CONFIGURED_SECRETS = {
  USAGE_MONITOR_INGEST_URL: 'https://usage.jays.services/api/ingest/usage',
  // Both tokens configured: the gate must pick the read token and never use
  // the ingest token (the monitor denies ingest-token reads in production).
  USAGE_MONITOR_INGEST_TOKEN: 'ingest-token-abc',
  USAGE_MONITOR_READ_TOKEN: 'read-token-xyz',
};

function budgetStatusBody(providers: Array<Record<string, unknown>>) {
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    month: '2026-07',
    providers,
    summary: { percentUsed: 0.5, overBudget: false, warning: false },
  };
}

afterEach(() => {
  vi.doUnmock('../secrets/infisical');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getProviderThrottleDecision', () => {
  it('throttles a provider the monitor reports as exceeded (over budget -> backoff)', async () => {
    const { getProviderThrottleDecision } = await loadGate(CONFIGURED_SECRETS);
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        budgetStatusBody([
          { name: 'openrouter', status: 'exceeded', percentUsed: 1.12 },
        ]),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const decision = await getProviderThrottleDecision(fakeEnv(), 'openrouter');

    expect(decision.throttle).toBe(true);
    expect(decision.status).toBe('exceeded');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://usage.jays.services/api/budget-status');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer read-token-xyz');
  });

  it('fails open without a read token (the ingest token is never used for reads)', async () => {
    const { getProviderThrottleDecision } = await loadGate({
      USAGE_MONITOR_INGEST_URL: 'https://usage.jays.services/api/ingest/usage',
      USAGE_MONITOR_INGEST_TOKEN: 'ingest-token-abc',
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const decision = await getProviderThrottleDecision(fakeEnv(), 'openrouter');

    expect(decision.throttle).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throttles a provider over a configured fraction even before "exceeded"', async () => {
    const { getProviderThrottleDecision } = await loadGate({
      ...CONFIGURED_SECRETS,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(budgetStatusBody([{ name: 'anthropic', status: 'warning', percentUsed: 0.92 }])),
      ),
    );

    const decision = await getProviderThrottleDecision(
      fakeEnv({ USAGE_MONITOR_BUDGET_THROTTLE_THRESHOLD: '0.9' }),
      'anthropic',
    );

    expect(decision.throttle).toBe(true);
    expect(decision.percentUsed).toBeCloseTo(0.92);
  });

  it('does not throttle a provider comfortably under budget (under-budget -> normal)', async () => {
    const { getProviderThrottleDecision } = await loadGate(CONFIGURED_SECRETS);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(budgetStatusBody([{ name: 'xai', status: 'ok', percentUsed: 0.2 }])),
      ),
    );

    const decision = await getProviderThrottleDecision(fakeEnv(), 'xai');

    expect(decision.throttle).toBe(false);
    expect(decision.status).toBe('ok');
  });

  it('matches CT provider keys to the monitor alias (gemini -> googleai)', async () => {
    const { getProviderThrottleDecision } = await loadGate(CONFIGURED_SECRETS);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(budgetStatusBody([{ name: 'Google AI', displayName: 'Google AI', status: 'exceeded', percentUsed: 1.4 }])),
      ),
    );

    const decision = await getProviderThrottleDecision(fakeEnv(), 'gemini');

    expect(decision.throttle).toBe(true);
  });

  it('does not throttle a provider absent from the monitor response (unknown -> fail open)', async () => {
    const { getProviderThrottleDecision } = await loadGate(CONFIGURED_SECRETS);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(budgetStatusBody([]))));

    const decision = await getProviderThrottleDecision(fakeEnv(), 'openrouter');

    expect(decision.throttle).toBe(false);
  });

  it('does not throttle a provider with no monthly budget configured', async () => {
    const { getProviderThrottleDecision } = await loadGate(CONFIGURED_SECRETS);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(budgetStatusBody([{ name: 'mistral', status: 'unconfigured', percentUsed: null }])),
      ),
    );

    const decision = await getProviderThrottleDecision(fakeEnv(), 'mistral');

    expect(decision.throttle).toBe(false);
  });

  it('fails open when the monitor is not configured (no URL/token)', async () => {
    const { getProviderThrottleDecision } = await loadGate({});
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const decision = await getProviderThrottleDecision(fakeEnv(), 'openrouter');

    expect(decision.throttle).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails open when the monitor is unreachable (network error -> continue)', async () => {
    const { getProviderThrottleDecision } = await loadGate(CONFIGURED_SECRETS);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    const decision = await getProviderThrottleDecision(fakeEnv(), 'openrouter');

    expect(decision.throttle).toBe(false);
    expect(decision.reason).toMatch(/unavailable/i);
  });

  it('fails open on a timeout (aborts past USAGE_MONITOR_BUDGET_STATUS_TIMEOUT_MS)', async () => {
    const { getProviderThrottleDecision } = await loadGate(CONFIGURED_SECRETS);
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })),
    );

    const decision = await getProviderThrottleDecision(
      fakeEnv({ USAGE_MONITOR_BUDGET_STATUS_TIMEOUT_MS: '10' }),
      'openrouter',
    );

    expect(decision.throttle).toBe(false);
  });

  it('fails open on a non-2xx response', async () => {
    const { getProviderThrottleDecision } = await loadGate(CONFIGURED_SECRETS);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));

    const decision = await getProviderThrottleDecision(fakeEnv(), 'openrouter');

    expect(decision.throttle).toBe(false);
  });

  it('fails open on a malformed body', async () => {
    const { getProviderThrottleDecision } = await loadGate(CONFIGURED_SECRETS);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })));

    const decision = await getProviderThrottleDecision(fakeEnv(), 'openrouter');

    expect(decision.throttle).toBe(false);
  });

  it('respects an explicit disable switch even when the monitor is reachable and over budget', async () => {
    const { getProviderThrottleDecision } = await loadGate(CONFIGURED_SECRETS);
    const fetchMock = vi.fn(async () =>
      jsonResponse(budgetStatusBody([{ name: 'openrouter', status: 'exceeded', percentUsed: 2 }])),
    );
    vi.stubGlobal('fetch', fetchMock);

    const decision = await getProviderThrottleDecision(
      fakeEnv({ USAGE_MONITOR_BUDGET_THROTTLE_ENABLED: 'false' }),
      'openrouter',
    );

    expect(decision.throttle).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prefers a dedicated USAGE_MONITOR_READ_TOKEN over the ingest token', async () => {
    const { getProviderThrottleDecision } = await loadGate({
      ...CONFIGURED_SECRETS,
      USAGE_MONITOR_READ_TOKEN: 'read-only-token',
    });
    const fetchMock = vi.fn(async () => jsonResponse(budgetStatusBody([{ name: 'openrouter', status: 'ok', percentUsed: 0.1 }])));
    vi.stubGlobal('fetch', fetchMock);

    await getProviderThrottleDecision(fakeEnv(), 'openrouter');

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer read-only-token');
  });

  it('caches the budget-status response within the TTL (one poll services many callers)', async () => {
    const { getProviderThrottleDecision } = await loadGate(CONFIGURED_SECRETS);
    const fetchMock = vi.fn(async () =>
      jsonResponse(budgetStatusBody([{ name: 'openrouter', status: 'ok', percentUsed: 0.1 }])),
    );
    vi.stubGlobal('fetch', fetchMock);

    await getProviderThrottleDecision(fakeEnv(), 'openrouter');
    await getProviderThrottleDecision(fakeEnv(), 'anthropic');
    await getProviderThrottleDecision(fakeEnv(), 'openrouter');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('allProvidersThrottled', () => {
  it('is true only when every listed provider is throttled', async () => {
    const { allProvidersThrottled } = await loadGate(CONFIGURED_SECRETS);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          budgetStatusBody([
            { name: 'openrouter', status: 'exceeded', percentUsed: 1.1 },
            { name: 'anthropic', status: 'ok', percentUsed: 0.1 },
          ]),
        ),
      ),
    );

    const result = await allProvidersThrottled(fakeEnv(), ['openrouter', 'anthropic']);

    expect(result.throttled).toBe(false);
  });

  it('is true when every listed provider is over budget', async () => {
    const { allProvidersThrottled } = await loadGate(CONFIGURED_SECRETS);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          budgetStatusBody([
            { name: 'openrouter', status: 'exceeded', percentUsed: 1.1 },
            { name: 'anthropic', status: 'exceeded', percentUsed: 1.3 },
          ]),
        ),
      ),
    );

    const result = await allProvidersThrottled(fakeEnv(), ['openrouter', 'anthropic']);

    expect(result.throttled).toBe(true);
    expect(result.provider).toBe('openrouter');
  });

  it('fails open (false) when the monitor is unreachable, even for a multi-provider check', async () => {
    const { allProvidersThrottled } = await loadGate(CONFIGURED_SECRETS);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));

    const result = await allProvidersThrottled(fakeEnv(), ['openrouter', 'anthropic', 'gemini']);

    expect(result.throttled).toBe(false);
  });
});
