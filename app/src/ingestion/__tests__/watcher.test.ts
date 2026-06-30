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

function fakeEnv(): { env: Env; kvPuts: Array<[string, string]>; dbRuns: Array<{ sql: string; params: unknown[] }> } {
  const kv = new Map<string, string>();
  const kvPuts: Array<[string, string]> = [];
  const dbRuns: Array<{ sql: string; params: unknown[] }> = [];

  const env = {
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
            return { success: true, meta: { changes: 1 } };
          },
        };
      },
    },
    INGEST_QUEUE: {
      async send() {
        throw new Error('should not enqueue when sources fail');
      },
    },
  } as unknown as Env;

  return { env, kvPuts, dbRuns };
}

describe('runWatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
