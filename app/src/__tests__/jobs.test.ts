import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../shared/types';

// Every collaborator maybeRunDailyJobs calls out to is mocked so this test is
// purely about how the daily-jobs entry point resolves + wires
// FMP_MAX_PER_MINUTE / EDGAR_MAX_PER_MINUTE, not about enrichment/price/share
// business logic (those have their own test suites).
const mocks = vi.hoisted(() => ({
  resolveSecrets: vi.fn(),
  getDailyUsed: vi.fn(),
  runEnrichment: vi.fn(),
  runPriceRefresh: vi.fn(),
  hasFmpTierFailure: vi.fn(),
  notifyAdmin: vi.fn(),
  shareWithPeer: vi.fn(),
  runFreshnessCheck: vi.fn(),
  runPhotoEnrichment: vi.fn(),
  runTickerBackfill: vi.fn(),
  runBulkSnapshot: vi.fn(),
  createUsageTelemetryClient: vi.fn(),
}));

vi.mock('../secrets/infisical', () => ({
  resolveSecrets: mocks.resolveSecrets,
}));
vi.mock('../enrichment/service', () => ({
  getDailyUsed: mocks.getDailyUsed,
  runEnrichment: mocks.runEnrichment,
}));
vi.mock('../prices/service', () => ({
  runPriceRefresh: mocks.runPriceRefresh,
}));
vi.mock('../shared/fmpStatus', () => ({
  hasFmpTierFailure: mocks.hasFmpTierFailure,
}));
vi.mock('../alerts/notify', () => ({
  notifyAdmin: mocks.notifyAdmin,
}));
vi.mock('../share/outbound', () => ({
  shareWithPeer: mocks.shareWithPeer,
}));
vi.mock('../share/freshness', () => ({
  runFreshnessCheck: mocks.runFreshnessCheck,
}));
vi.mock('../admin/routes', () => ({
  runPhotoEnrichment: mocks.runPhotoEnrichment,
  runTickerBackfill: mocks.runTickerBackfill,
}));
vi.mock('../export/snapshot', () => ({
  runBulkSnapshot: mocks.runBulkSnapshot,
}));
vi.mock('@jaywedgeworth22/congress-trading-shared', () => ({
  createUsageTelemetryClient: mocks.createUsageTelemetryClient,
}));

import { maybeRunDailyJobs } from '../jobs';

function fakeEnv(): Env {
  const kv = new Map<string, string>();
  return {
    CONFIG_KV: {
      async get(key: string) {
        return kv.get(key) ?? null;
      },
      async put(key: string, value: string) {
        kv.set(key, value);
      },
    },
  } as unknown as Env;
}

describe('maybeRunDailyJobs secret resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveSecrets.mockResolvedValue({});
    mocks.getDailyUsed.mockResolvedValue(0);
    mocks.runEnrichment.mockResolvedValue({
      hasFmpKey: false,
      dailyCap: null,
      fmpCalls: 0,
      errors: [],
      shareRefs: [],
      scanned: 0,
      enriched: 0,
    });
    mocks.runPriceRefresh.mockResolvedValue({
      hasFmpKey: false,
      fmpCalls: 0,
      errors: [],
      sharePrices: [],
      shareSpx: [],
    });
    mocks.hasFmpTierFailure.mockReturnValue(false);
    mocks.shareWithPeer.mockResolvedValue({ sent: false, reason: 'not configured' });
    mocks.runFreshnessCheck.mockResolvedValue([]);
    mocks.runBulkSnapshot.mockResolvedValue({ tables: {} });
    mocks.runPhotoEnrichment.mockResolvedValue(undefined);
    mocks.runTickerBackfill.mockResolvedValue(undefined);
  });

  it('folds FMP_MAX_PER_MINUTE and EDGAR_MAX_PER_MINUTE into the same resolveSecrets call as the USAGE_MONITOR_* vars', async () => {
    const env = fakeEnv();

    await maybeRunDailyJobs(env, new Date('2026-07-10T00:00:00Z'));

    // Exactly one resolveSecrets call for the whole daily run confirms
    // FMP_MAX_PER_MINUTE / EDGAR_MAX_PER_MINUTE were folded into the existing
    // USAGE_MONITOR_* resolveSecrets call rather than resolved via a second,
    // separate resolveSecrets call.
    expect(mocks.resolveSecrets).toHaveBeenCalledTimes(1);
    const [, keys] = mocks.resolveSecrets.mock.calls[0];
    expect(keys).toEqual(
      expect.arrayContaining([
        'FMP_MAX_PER_MINUTE',
        'EDGAR_MAX_PER_MINUTE',
        'USAGE_MONITOR_ENABLED',
        'USAGE_MONITOR_INGEST_URL',
        'USAGE_MONITOR_INGEST_TOKEN',
        'USAGE_MONITOR_ENVIRONMENT',
      ]),
    );
  });

  it('passes the resolved FMP_MAX_PER_MINUTE / EDGAR_MAX_PER_MINUTE through to runEnrichment/runPriceRefresh as maxPerMinute/edgarMaxPerMinute', async () => {
    const env = fakeEnv();
    mocks.resolveSecrets.mockResolvedValue({
      FMP_MAX_PER_MINUTE: '123',
      EDGAR_MAX_PER_MINUTE: '456',
    });

    await maybeRunDailyJobs(env, new Date('2026-07-10T00:00:00Z'));

    expect(mocks.runEnrichment).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ maxPerMinute: 123, edgarMaxPerMinute: 456 }),
    );
    expect(mocks.runPriceRefresh).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ maxPerMinute: 123 }),
    );
  });

  it('falls back to undefined (no pacing) when resolveSecrets yields nothing for either var, matching prior unset behavior', async () => {
    const env = fakeEnv();
    mocks.resolveSecrets.mockResolvedValue({});

    await maybeRunDailyJobs(env, new Date('2026-07-10T00:00:00Z'));

    expect(mocks.runEnrichment).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ maxPerMinute: undefined, edgarMaxPerMinute: undefined }),
    );
  });
});
