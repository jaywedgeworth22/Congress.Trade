import { createClient } from '@libsql/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import { D1DatabaseShim } from '../shims.ts';

const mocks = vi.hoisted(() => ({
  marketData: vi.fn(async () => 'ran' as const),
  snapshot: vi.fn(async () => 'ran' as const),
  filer: vi.fn(async () => 'ran' as const),
  retention: vi.fn(async () => 'ran' as const),
}));

vi.mock('../../jobs.ts', () => ({
  maybeRunDailyMarketDataJobs: mocks.marketData,
  maybeRunDailySnapshotJob: mocks.snapshot,
  maybeRunDailyFilerJobs: mocks.filer,
  maybeRunDailyRetentionJobs: mocks.retention,
}));

import {
  DAILY_LANE_CRONS,
  DAILY_LANE_DEFAULT_DEADLINE_MS,
  resolveDailyLaneDeadlineMs,
  runDailyLane,
  type DailyLaneCron,
} from '../cronLanes.ts';

async function makeEnv(): Promise<{ env: Env; client: ReturnType<typeof createClient> }> {
  const client = createClient({ url: 'file::memory:' });
  await client.execute(`
    CREATE TABLE deno_runtime_kv (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      expires_at INTEGER,
      PRIMARY KEY (namespace, key)
    )
  `);
  const env = { DB: new D1DatabaseShim(client) } as unknown as Env;
  return { env, client };
}

describe('daily lane cron windows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has four lanes with unique names, hourly schedules, off-peak minutes, and snapshot after market data', () => {
    expect(DAILY_LANE_CRONS).toHaveLength(4);
    const names = DAILY_LANE_CRONS.map((l) => l.name);
    expect(new Set(names).size).toBe(4);
    const minuteOf = (schedule: string) => Number(schedule.split(' ')[0]);
    const minutes = DAILY_LANE_CRONS.map((l) => minuteOf(l.schedule));
    // Every lane is hourly with a fixed minute.
    for (const lane of DAILY_LANE_CRONS) {
      expect(lane.schedule).toMatch(/^\d{1,2} \* \* \* \*$/);
    }
    // Fleet scheduling policy: avoid :00/:30 congestion (7-23 or 37-53).
    for (const m of minutes) {
      expect((m >= 7 && m <= 23) || (m >= 37 && m <= 53)).toBe(true);
    }
    // Snapshot must fire after the market-data lane it captures.
    expect(minuteOf('22 * * * *')).toBeGreaterThan(minuteOf('7 * * * *'));
    const order = ['daily-market-data', 'daily-snapshot', 'daily-filer', 'daily-retention'];
    expect(names).toEqual(order);
  });

  it('maps each lane to the matching jobs.ts lane function', async () => {
    const { env } = await makeEnv();
    for (const lane of DAILY_LANE_CRONS) {
      const result = await runDailyLane(lane, env, new Date(), 10_000);
      expect(result.status).toBe('ran');
    }
    expect(mocks.marketData).toHaveBeenCalledTimes(1);
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
    expect(mocks.filer).toHaveBeenCalledTimes(1);
    expect(mocks.retention).toHaveBeenCalledTimes(1);
  });
});

describe('runDailyLane guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips with skipped-overlap when another isolate holds the lane lock', async () => {
    const { env, client } = await makeEnv();
    // Pre-plant a live lock for this lane.
    await client.execute({
      sql: `INSERT INTO deno_runtime_kv (namespace, key, value, expires_at) VALUES ('locks', 'daily-snapshot', 'other-token', ?)`,
      args: [Date.now() + 60_000],
    });
    const lane = DAILY_LANE_CRONS.find((l) => l.name === 'daily-snapshot')!;
    const result = await runDailyLane(lane, env, new Date(), 10_000);
    expect(result.status).toBe('skipped-overlap');
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });

  it('aborts a lane that overruns its deadline', async () => {
    const { env } = await makeEnv();
    const hanging: DailyLaneCron = {
      name: 'daily-hanging',
      schedule: '9 * * * *',
      run: () => new Promise<'ran'>((resolve) => setTimeout(() => resolve('ran'), 5_000)),
    };
    const result = await runDailyLane(hanging, env, new Date(), 50);
    expect(result.status).toBe('aborted');
  });

  it('reports error when the lane throws', async () => {
    const { env } = await makeEnv();
    const failing: DailyLaneCron = {
      name: 'daily-failing',
      schedule: '11 * * * *',
      run: async () => {
        throw new Error('boom');
      },
    };
    const result = await runDailyLane(failing, env, new Date(), 10_000);
    expect(result.status).toBe('error');
  });
});

describe('resolveDailyLaneDeadlineMs', () => {
  it('defaults to 10 minutes', () => {
    expect(DAILY_LANE_DEFAULT_DEADLINE_MS).toBe(600_000);
    expect(resolveDailyLaneDeadlineMs({})).toBe(600_000);
  });
  it('honors CT_DAILY_LANE_DEADLINE_MS with clamps', () => {
    expect(resolveDailyLaneDeadlineMs({ CT_DAILY_LANE_DEADLINE_MS: '120000' })).toBe(120_000);
    // Below the 10s floor → default; above the 30min ceiling → clamped.
    expect(resolveDailyLaneDeadlineMs({ CT_DAILY_LANE_DEADLINE_MS: '5000' })).toBe(600_000);
    expect(resolveDailyLaneDeadlineMs({ CT_DAILY_LANE_DEADLINE_MS: '99999999' })).toBe(1_800_000);
  });
});
