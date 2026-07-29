import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../shared/types.ts';

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
  DEFAULT_DAILY_CAP: 230,
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
vi.mock('../../vendor/congress-trading-shared/dist/index.mjs', () => ({
  createUsageTelemetryClient: mocks.createUsageTelemetryClient,
}));
vi.mock('../shared/d1Budget', () => ({
  isD1RowBudgetExceeded: mocks.isD1RowBudgetExceeded,
}));
// Only `run` is stubbed (retention sweep DELETEs); everything else stays real
// so transitive importers of shared/db keep their actual helpers.
vi.mock('../shared/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/db.ts')>()),
  run: mocks.dbRun,
}));

import {
  maybeRunDailyJobs,
  runRetentionSweep,
  RETENTION_POLICIES,
  RETENTION_DELETE_BATCH,
  RETENTION_MAX_BATCHES_PER_TABLE,
} from '../jobs.ts';

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

  describe('price-refresh budget floor vs enrichment', () => {
    // enrichment and price refresh share one daily FMP call counter; enrichment
    // runs first and (absent a cap) would happily spend the entire remaining
    // budget, leaving price refresh with 0. jobs.ts must reserve a floor by
    // capping enrichment's own `max` opt before calling it.
    it('caps enrichment max to reserve 20% of the daily cap for price refresh, when an FMP key is configured', async () => {
      const env = fakeEnv();
      mocks.resolveSecrets.mockResolvedValue({
        FMP_API_KEY: 'test-key',
        FMP_DAILY_CALL_CAP: '1000',
      });
      mocks.getDailyUsed.mockResolvedValue(100);

      await maybeRunDailyJobs(env, new Date('2026-07-10T00:00:00Z'));

      // cap=1000, used=100 -> remaining=900; floor=ceil(1000*0.2)=200;
      // enrichment max = 900 - 200 = 700.
      expect(mocks.runEnrichment).toHaveBeenCalledWith(env, expect.objectContaining({ max: 700 }));
    });

    it('does not cap enrichment max when no FMP key is configured (no shared-budget contention to guard)', async () => {
      const env = fakeEnv();
      mocks.resolveSecrets.mockResolvedValue({ FMP_DAILY_CALL_CAP: '1000' }); // no FMP_API_KEY
      mocks.getDailyUsed.mockResolvedValue(100);

      await maybeRunDailyJobs(env, new Date('2026-07-10T00:00:00Z'));

      expect(mocks.runEnrichment).toHaveBeenCalledWith(env, expect.objectContaining({ max: undefined }));
      expect(mocks.getDailyUsed).not.toHaveBeenCalled();
    });

    it('falls back to DEFAULT_DAILY_CAP (230) when FMP_DAILY_CALL_CAP is unset', async () => {
      const env = fakeEnv();
      mocks.resolveSecrets.mockResolvedValue({ FMP_API_KEY: 'test-key' });
      mocks.getDailyUsed.mockResolvedValue(0);

      await maybeRunDailyJobs(env, new Date('2026-07-10T00:00:00Z'));

      // cap=230 (default), used=0 -> remaining=230; floor=ceil(230*0.2)=46;
      // enrichment max = 230 - 46 = 184.
      expect(mocks.runEnrichment).toHaveBeenCalledWith(env, expect.objectContaining({ max: 184 }));
    });

    it('never reserves more than what remains today (floor clamped, never negative max)', async () => {
      const env = fakeEnv();
      mocks.resolveSecrets.mockResolvedValue({
        FMP_API_KEY: 'test-key',
        FMP_DAILY_CALL_CAP: '1000',
      });
      // Only 50 calls left today — less than the 20% (200) floor would otherwise be.
      mocks.getDailyUsed.mockResolvedValue(950);

      await maybeRunDailyJobs(env, new Date('2026-07-10T00:00:00Z'));

      expect(mocks.runEnrichment).toHaveBeenCalledWith(env, expect.objectContaining({ max: 0 }));
    });
  });
});
