import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../shared/types';

const mocks = vi.hoisted(() => ({
  fetchHouseIndex: vi.fn(),
  pollHouseLiveSearch: vi.fn(),
  fetchSenatePtrFilings: vi.fn(),
}));

vi.mock('../houseSource', () => ({
  fetchHouseIndex: mocks.fetchHouseIndex,
  pollHouseLiveSearch: mocks.pollHouseLiveSearch,
}));

vi.mock('../senateSource', () => ({
  fetchSenatePtrFilings: mocks.fetchSenatePtrFilings,
}));

import { runWatcher } from '../watcher';

function housePtr(docId: string, overrides: Partial<Record<'filingDate' | 'first' | 'last' | 'stateDst', string>> = {}) {
  return {
    pipelineDocId: `H-2026-${docId}`,
    sourceUrl: `https://example.test/${docId}.pdf`,
    filingDate: overrides.filingDate ?? '7/4/2026',
    first: overrides.first ?? 'Jane',
    last: overrides.last ?? 'Smith',
    stateDst: overrides.stateDst ?? 'CA01',
    isPtr: true,
  };
}

function fakeEnv(
  overrides: Partial<{ HOUSE_LIVE_SEARCH_ENABLED: string }> = {},
): {
  env: Env;
  kvPuts: Array<[string, string]>;
  dbRuns: Array<{ sql: string; params: unknown[] }>;
  queueSends: Array<unknown>;
} {
  const kv = new Map<string, string>();
  const kvPuts: Array<[string, string]> = [];
  const dbRuns: Array<{ sql: string; params: unknown[] }> = [];
  const queueSends: Array<unknown> = [];
  const insertedDocIds = new Set<string>();

  const env = {
    ...overrides,
    CONFIG_KV: {
      async get(key: string) {
        return kv.get(key) ?? null;
      },
      async put(key: string, value: string) {
        kv.set(key, value);
        kvPuts.push([key, value]);
      },
    },
    DB: {
      prepare(sql: string) {
        let params: unknown[] = [];
        return {
          bind(...bound: unknown[]) {
            params = bound;
            return this;
          },
          async first<T>() {
            return null as T | null;
          },
          async all<T>() {
            return { results: [] as T[] };
          },
          async run() {
            dbRuns.push({ sql, params });
            if (/INSERT OR IGNORE INTO filings/i.test(sql)) {
              const docId = String(params[0] ?? '');
              const isNew = !insertedDocIds.has(docId);
              insertedDocIds.add(docId);
              return { success: true, meta: { changes: isNew ? 1 : 0 } };
            }
            return { success: true, meta: { changes: 1 } };
          },
        };
      },
    },
    INGEST_QUEUE: {
      async send(message: unknown) {
        queueSends.push(message);
      },
    },
  } as unknown as Env;

  return { env, kvPuts, dbRuns, queueSends };
}

describe('runWatcher', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('does not stamp last-poll state after source failures', async () => {
    const { env, kvPuts, dbRuns } = fakeEnv();
    mocks.fetchHouseIndex.mockRejectedValueOnce(new Error('house down'));
    mocks.fetchSenatePtrFilings.mockRejectedValueOnce(new Error('senate down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await runWatcher(env, new Date('2026-06-30T15:00:00.000Z'));
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }

    expect(kvPuts.map(([key]) => key)).not.toContain('last_poll:house');
    expect(kvPuts.map(([key]) => key)).not.toContain('last_poll:senate');
    expect(dbRuns.filter((run) => /INSERT INTO ingest_log/i.test(run.sql))).toHaveLength(2);
  });

  it('polls the live House search by default and de-dupes overlap against the bulk index', async () => {
    const { env, dbRuns, queueSends } = fakeEnv();
    mocks.fetchHouseIndex.mockResolvedValueOnce([housePtr('20026001'), housePtr('20026002')]);
    mocks.pollHouseLiveSearch.mockResolvedValueOnce([
      housePtr('20026002', { filingDate: '' }),
      housePtr('20026003', { filingDate: '' }),
    ]);
    mocks.fetchSenatePtrFilings.mockResolvedValueOnce([]);

    await runWatcher(env, new Date('2026-07-04T15:00:00.000Z'));

    expect(mocks.pollHouseLiveSearch).toHaveBeenCalledWith(2026);
    expect(queueSends).toHaveLength(3);
    expect(queueSends).toEqual([
      expect.objectContaining({ docId: 'H-2026-20026001', chamber: 'house' }),
      expect.objectContaining({ docId: 'H-2026-20026002', chamber: 'house' }),
      expect.objectContaining({ docId: 'H-2026-20026003', chamber: 'house' }),
    ]);

    const filingInserts = dbRuns.filter((run) => /INSERT OR IGNORE INTO filings/i.test(run.sql));
    expect(filingInserts).toHaveLength(3);
  });

  it('skips the live House search when explicitly disabled', async () => {
    const { env, queueSends } = fakeEnv({ HOUSE_LIVE_SEARCH_ENABLED: 'false' });
    mocks.fetchHouseIndex.mockResolvedValueOnce([housePtr('20026001')]);
    mocks.fetchSenatePtrFilings.mockResolvedValueOnce([]);

    await runWatcher(env, new Date('2026-07-04T15:00:00.000Z'));

    expect(mocks.pollHouseLiveSearch).not.toHaveBeenCalled();
    expect(queueSends).toEqual([expect.objectContaining({ docId: 'H-2026-20026001', chamber: 'house' })]);
  });

  it('fails soft when the live House search errors and still persists the bulk index', async () => {
    const { env, kvPuts, queueSends } = fakeEnv();
    mocks.fetchHouseIndex.mockResolvedValueOnce([housePtr('20026001')]);
    mocks.pollHouseLiveSearch.mockRejectedValueOnce(new Error('live blocked'));
    mocks.fetchSenatePtrFilings.mockResolvedValueOnce([]);

    await runWatcher(env, new Date('2026-07-04T15:00:00.000Z'));

    expect(mocks.pollHouseLiveSearch).toHaveBeenCalledWith(2026);
    expect(queueSends).toEqual([expect.objectContaining({ docId: 'H-2026-20026001', chamber: 'house' })]);
    expect(kvPuts.map(([key]) => key)).toContain('last_poll:house');
  });
});
