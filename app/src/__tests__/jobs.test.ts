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
  isD1RowBudgetExceeded: vi.fn(),
  dbRun: vi.fn(),
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
vi.mock('../shared/d1Budget', () => ({
  isD1RowBudgetExceeded: mocks.isD1RowBudgetExceeded,
}));
// Only `run` is stubbed (retention sweep DELETEs); everything else stays real
// so transitive importers of shared/db keep their actual helpers.
vi.mock('../shared/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/db')>()),
  run: mocks.dbRun,
}));

import {
  maybeRunDailyJobs,
  runRetentionSweep,
  RETENTION_POLICIES,
  RETENTION_DELETE_BATCH,
  RETENTION_MAX_BATCHES_PER_TABLE,
} from '../jobs';

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
    mocks.isD1RowBudgetExceeded.mockResolvedValue(false);
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
    mocks.dbRun.mockResolvedValue({ meta: { changes: 0 } });
  });

  it('runs the retention sweep as part of the daily pass, one bounded DELETE per table', async () => {
    const env = fakeEnv();

    await maybeRunDailyJobs(env, new Date('2026-07-10T00:00:00Z'));

    const sqls = mocks.dbRun.mock.calls.map(([, sql]) => sql as string);
    for (const policy of RETENTION_POLICIES) {
      const del = sqls.filter((s) => s.includes(`DELETE FROM ${policy.table}`));
      // changes:0 on the first batch → exactly one bounded DELETE per table.
      expect(del).toHaveLength(1);
      expect(del[0]).toContain(`${policy.column} < ?`);
      expect(del[0]).toContain('LIMIT ?');
    }
    // Cutoff + LIMIT params: ISO cutoff `days` before `now`, batch-size LIMIT.
    const [, dlqSql, dlqParams] = mocks.dbRun.mock.calls.find(([, sql]) =>
      (sql as string).includes('DELETE FROM dead_letter_events'),
    )!;
    expect(dlqSql).toContain('IN (SELECT id FROM dead_letter_events');
    expect(dlqParams).toEqual([
      new Date(Date.parse('2026-07-10T00:00:00Z') - 30 * 86_400_000).toISOString(),
      RETENTION_DELETE_BATCH,
    ]);
  });

  it('caps retention batches per table when the backlog never drains', async () => {
    // Every DELETE reports a full batch → the loop must stop at the cap
    // instead of spinning until the table is empty.
    mocks.dbRun.mockResolvedValue({ meta: { changes: RETENTION_DELETE_BATCH } });

    const deleted = await runRetentionSweep(fakeEnv(), new Date('2026-07-10T00:00:00Z'));

    expect(mocks.dbRun).toHaveBeenCalledTimes(
      RETENTION_POLICIES.length * RETENTION_MAX_BATCHES_PER_TABLE,
    );
    for (const policy of RETENTION_POLICIES) {
      expect(deleted[policy.table]).toBe(RETENTION_DELETE_BATCH * RETENTION_MAX_BATCHES_PER_TABLE);
    }
  });

  it('retention failure on one table does not abort the others or the daily run', async () => {
    mocks.dbRun.mockImplementation(async (_db: unknown, sql: string) => {
      if (sql.includes('ingest_log')) throw new Error('no such table: ingest_log');
      return { meta: { changes: 0 } };
    });

    const deleted = await runRetentionSweep(fakeEnv(), new Date('2026-07-10T00:00:00Z'));

    expect(deleted).toEqual({ dead_letter_events: 0, ingest_log: 0, source_attempts: 0 });
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

  it('re-checks the D1 budget between expensive daily stages', async () => {
    const env = fakeEnv();
    mocks.isD1RowBudgetExceeded
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await maybeRunDailyJobs(env, new Date('2026-07-10T00:00:00Z'));

    expect(mocks.runEnrichment).toHaveBeenCalledTimes(1);
    expect(mocks.runPriceRefresh).not.toHaveBeenCalled();
    expect(mocks.runBulkSnapshot).not.toHaveBeenCalled();
    expect(mocks.isD1RowBudgetExceeded).toHaveBeenCalledTimes(2);
  });
});
