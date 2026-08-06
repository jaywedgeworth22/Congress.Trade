import { describe, expect, it } from 'vitest';
import {
  generateTradeHash,
  extractLastName,
  normalizeTradeSide,
  matchDisclosureCandidate,
  parseTradeHash,
  raceFirstSeenAt,
  tradeDateDayDistance,
  isLiveRaceImport,
  LATENCY_MAX_CONCURRENT_DELTA_HOURS,
  LATENCY_SCORE_WINDOW_HOURS,
  LATENCY_PROVIDER_MATCH_LOOKBACK_HOURS,
  LATENCY_LIVE_FILING_MAX_LAG_DAYS,
  FMP_LATENCY_CALLS_PER_RUN,
  FMP_LATENCY_DAILY_CAP_PER_KEY,
  fmpLatencyEtHourWeight,
  fmpLatencyIntervalSec,
  selectFmpLatencyKey,
  getFmpLatencyUsed,
  addFmpLatencyUsed,
  getDisclosureLatencyProviderStatuses,
  listFmpLatencyPathRegistry,
  runDisclosureLatencyProbe,
} from '../tradeLatency.ts';

describe('tradeLatency', () => {
  describe('extractLastName', () => {
    it('extracts last name', () => {
      expect(extractLastName('Ro Khanna')).toBe('khanna');
      expect(extractLastName('Pelosi, Nancy')).toBe('pelosi');
      expect(extractLastName('Donald J. Trump')).toBe('trump');
      expect(extractLastName('Tuberville, Tommy')).toBe('tuberville');
    });
  });

  describe('normalizeTradeSide', () => {
    it('maps CT P/S/E codes and provider prose to buy/sell/exchange', () => {
      expect(normalizeTradeSide('P')).toBe('buy');
      expect(normalizeTradeSide('S')).toBe('sell');
      expect(normalizeTradeSide('E')).toBe('exchange');
      expect(normalizeTradeSide('purchase')).toBe('buy');
      expect(normalizeTradeSide('Sale')).toBe('sell');
      expect(normalizeTradeSide('buy')).toBe('buy');
      expect(normalizeTradeSide(null)).toBe('exchange');
    });
  });

  describe('generateTradeHash', () => {
    it('generates deterministic hash across name/type variants', () => {
      const hash1 = generateTradeHash('Ro Khanna', 'AAPL', '2026-07-24', 'buy');
      const hash2 = generateTradeHash('Khanna, Ro', 'AAPL', '2026-07-24', 'purchase');
      const hash3 = generateTradeHash('Ro Khanna', 'AAPL', '2026-07-24', 'P');
      expect(hash1).toBe(hash2);
      expect(hash1).toBe(hash3);
      expect(hash1).toBe('khanna_AAPL_2026-07-24_buy');
    });

    it('maps sale codes to sell', () => {
      expect(generateTradeHash('Kevin Hern', 'DVN', '2024-06-28', 'S')).toBe(
        generateTradeHash('Hern, Kevin', 'DVN', '2024-06-28', 'Sale'),
      );
    });
  });

  describe('matchDisclosureCandidate', () => {
    it('matches exact trade hashes as trade-hash', () => {
      const hash = generateTradeHash('Debbie Dingell', 'HONAV', '2026-06-29', 'exchange');
      const m = matchDisclosureCandidate(
        { trade_hash: hash },
        {
          provider: 'unusual_whales',
          chamber: 'house',
          providerKey: 'k1',
          tradeHash: hash,
          payload: {},
          sourceUrl: null,
          filedDate: null,
          filerName: 'Debbie Dingell',
          providerPublishedAt: null,
        },
      );
      expect(m).toEqual({ providerKey: 'k1', matchMethod: 'trade-hash' });
    });

    it('fuzzy-matches near trade dates (±2 days) for same filer/ticker/side', () => {
      const m = matchDisclosureCandidate(
        { trade_hash: 'delaney_BWXT_2026-07-24_buy' },
        {
          provider: 'quiver',
          chamber: 'house',
          providerKey: 'k-near',
          tradeHash: 'delaney_BWXT_2026-07-26_buy',
          payload: {},
          sourceUrl: null,
          filedDate: null,
          filerName: 'April McClain Delaney',
          providerPublishedAt: null,
        },
      );
      expect(m?.matchMethod).toBe('fuzzy-near-date');
    });

    it('fuzzy-matches when provider date is empty but filer/ticker/side agree', () => {
      const m = matchDisclosureCandidate(
        { trade_hash: 'sessions_ARCC_2026-07-24_sell' },
        {
          provider: 'unusual_whales',
          chamber: 'house',
          providerKey: 'k2',
          tradeHash: 'sessions_ARCC__sell',
          payload: {},
          sourceUrl: null,
          filedDate: null,
          filerName: 'Pete Sessions',
          providerPublishedAt: null,
        },
      );
      expect(m?.matchMethod).toBe('fuzzy-missing-date');
    });

    it('fuzzy-matches when provider ticker is empty but filer/date/side agree', () => {
      const m = matchDisclosureCandidate(
        { trade_hash: 'beyer_AAPL_2026-07-27_buy' },
        {
          provider: 'unusual_whales',
          chamber: 'house',
          providerKey: 'k3',
          tradeHash: 'beyer__2026-07-27_buy',
          payload: {},
          sourceUrl: null,
          filedDate: null,
          filerName: 'Don Beyer',
          providerPublishedAt: null,
        },
      );
      expect(m?.matchMethod).toBe('fuzzy-no-ticker');
    });
  });

  describe('parseTradeHash', () => {
    it('parses normal and empty-ticker hashes', () => {
      expect(parseTradeHash('himes_BAC_2026-07-20_sell')).toEqual({
        lastName: 'himes',
        ticker: 'BAC',
        date: '2026-07-20',
        side: 'sell',
      });
      expect(parseTradeHash('beyer__2026-07-27_buy')).toMatchObject({
        lastName: 'beyer',
        date: '2026-07-27',
        side: 'buy',
      });
    });
  });

  describe('raceFirstSeenAt', () => {
    it('uses now when first_seen is outside the score window', () => {
      const now = '2026-08-04T12:00:00.000Z';
      expect(raceFirstSeenAt('2024-01-01T00:00:00.000Z', now, 168)).toBe(now);
      expect(raceFirstSeenAt('2026-08-03T12:00:00.000Z', now, 168)).toBe('2026-08-03T12:00:00.000Z');
    });
  });

  describe('scoreboard constants', () => {
    it('uses 7d CT live window and 14d provider match/timing lookback', () => {
      expect(LATENCY_SCORE_WINDOW_HOURS).toBe(168);
      expect(LATENCY_PROVIDER_MATCH_LOOKBACK_HOURS).toBe(336);
      expect(LATENCY_MAX_CONCURRENT_DELTA_HOURS).toBe(336);
      expect(LATENCY_LIVE_FILING_MAX_LAG_DAYS).toBe(21);
    });
  });

  describe('isLiveRaceImport', () => {
    it('excludes seed and competitor backfills', () => {
      expect(isLiveRaceImport({ source: 'seed_dataset', filedDate: '2026-08-01', firstSeenAt: '2026-08-02T00:00:00.000Z' })).toBe(
        false,
      );
      expect(
        isLiveRaceImport({ source: 'competitor_backfill', filedDate: '2026-08-01', firstSeenAt: '2026-08-02T00:00:00.000Z' }),
      ).toBe(false);
    });

    it('excludes primary-path historical crawls (first_seen long after filed)', () => {
      expect(
        isLiveRaceImport({
          source: 'primary',
          filedDate: '2024-05-01',
          firstSeenAt: '2026-08-04T12:00:00.000Z',
        }),
      ).toBe(false);
    });

    it('allows live primary imports filed days before first_seen', () => {
      expect(
        isLiveRaceImport({
          source: 'primary',
          filedDate: '2026-08-01',
          firstSeenAt: '2026-08-03T12:00:00.000Z',
        }),
      ).toBe(true);
    });
  });

  describe('tradeDateDayDistance', () => {
    it('returns absolute day gaps', () => {
      expect(tradeDateDayDistance('2026-07-24', '2026-07-26')).toBe(2);
      expect(tradeDateDayDistance('2026-07-24', '2026-07-24')).toBe(0);
      expect(tradeDateDayDistance('bad', '2026-07-24')).toBeNull();
    });
  });

  describe('FMP latency-only dual keys', () => {
    it('spaces remaining budget across the UTC day with floor/ceiling', () => {
      // Noon UTC mid-day with plenty of remaining runs.
      const noon = new Date('2026-08-05T16:00:00.000Z'); // 12:00 ET in summer
      const interval = fmpLatencyIntervalSec(noon, FMP_LATENCY_DAILY_CAP_PER_KEY);
      expect(interval).toBeGreaterThanOrEqual(120);
      expect(interval).toBeLessThanOrEqual(45 * 60);
      // Exhausted budget → max interval (skip signal for caller).
      expect(fmpLatencyIntervalSec(noon, 0)).toBe(45 * 60);
      expect(fmpLatencyIntervalSec(noon, 1)).toBe(45 * 60); // < CALLS_PER_RUN
    });

    it('weights peak ET hours denser than overnight', () => {
      // America/New_York: 2026-08-05 14:00 UTC = 10:00 ET (peak weekday)
      const peak = fmpLatencyEtHourWeight(new Date('2026-08-05T14:00:00.000Z'));
      // 2026-08-05 04:00 UTC = 00:00 ET (overnight)
      const night = fmpLatencyEtHourWeight(new Date('2026-08-05T04:00:00.000Z'));
      expect(peak).toBeGreaterThan(night);
      // Peak spacing should be shorter than overnight for same remaining budget.
      const remaining = 100;
      const peakIv = fmpLatencyIntervalSec(new Date('2026-08-05T14:00:00.000Z'), remaining);
      const nightIv = fmpLatencyIntervalSec(new Date('2026-08-05T04:00:00.000Z'), remaining);
      expect(peakIv).toBeLessThanOrEqual(nightIv);
    });

    it('never selects FMP_API_KEY — only FMP_LATENCY_API_KEY[_2]', async () => {
      const kv = new Map<string, string>();
      const env = {
        FMP_API_KEY: 'legacy-must-not-use',
        CONFIG_KV: {
          get: async (k: string) => kv.get(k) ?? null,
          put: async (k: string, v: string) => {
            kv.set(k, v);
          },
        },
      } as never;
      expect(await selectFmpLatencyKey(env, new Date('2026-08-05T15:00:00.000Z'), { force: true })).toBeNull();

      const envLatency = {
        ...env,
        FMP_LATENCY_API_KEY: 'latency-key-1',
      } as never;
      const sel = await selectFmpLatencyKey(envLatency, new Date('2026-08-05T15:00:00.000Z'), { force: true });
      expect(sel?.apiKey).toBe('latency-key-1');
      expect(sel?.slot).toBe('1');
      expect(sel?.secretName).toBe('FMP_LATENCY_API_KEY');
      expect(sel?.cap).toBe(FMP_LATENCY_DAILY_CAP_PER_KEY);
      expect(FMP_LATENCY_CALLS_PER_RUN).toBe(2);
    });

    it('prefers the key with more remaining budget and tracks per-key counters', async () => {
      const kv = new Map<string, string>();
      const env = {
        FMP_LATENCY_API_KEY: 'k1',
        ['FMP_LATENCY_API_KEY' + '_2']: 'k2',
        CONFIG_KV: {
          get: async (k: string) => kv.get(k) ?? null,
          put: async (k: string, v: string) => {
            kv.set(k, v);
          },
        },
      } as never;
      const now = new Date('2026-08-05T15:00:00.000Z');
      // Exhaust most of key1 so key2 is preferred.
      await addFmpLatencyUsed(env, '1', FMP_LATENCY_DAILY_CAP_PER_KEY - 4, now);
      await addFmpLatencyUsed(env, '2', 10, now);
      expect(await getFmpLatencyUsed(env, '1', now)).toBe(FMP_LATENCY_DAILY_CAP_PER_KEY - 4);
      const sel = await selectFmpLatencyKey(env, now, { force: true });
      expect(sel?.slot).toBe('2');
      expect(sel?.apiKey).toBe('k2');
      expect(sel?.remaining).toBe(FMP_LATENCY_DAILY_CAP_PER_KEY - 10);
    });

    it('skips a key that is at daily cap', async () => {
      const kv = new Map<string, string>();
      const env = {
        FMP_LATENCY_API_KEY: 'k1',
        CONFIG_KV: {
          get: async (k: string) => kv.get(k) ?? null,
          put: async (k: string, v: string) => {
            kv.set(k, v);
          },
        },
      } as never;
      const now = new Date('2026-08-05T15:00:00.000Z');
      await addFmpLatencyUsed(env, '1', FMP_LATENCY_DAILY_CAP_PER_KEY, now);
      expect(await selectFmpLatencyKey(env, now, { force: true })).toBeNull();
    });

    it('reports FMP configured only when a latency key is present (not FMP_API_KEY)', async () => {
      const statusesLegacy = await getDisclosureLatencyProviderStatuses({
        FMP_API_KEY: 'legacy-only',
        CONFIG_KV: { get: async () => null, put: async () => {} },
      } as never);
      const fmpLegacy = statusesLegacy.find((s) => s.id === 'fmp');
      expect(fmpLegacy?.configured).toBe(false);

      const statuses = await getDisclosureLatencyProviderStatuses({
        ['FMP_LATENCY_API_KEY' + '_2']: 'second-key',
        CONFIG_KV: { get: async () => null, put: async () => {} },
      } as never);
      const fmp = statuses.find((s) => s.id === 'fmp');
      expect(fmp?.configured).toBe(true);
    });

    it('defaults FMP family operationalStatus to off (no spend) until FMP_LATENCY_PROBE_ENABLED', async () => {
      const env = {
        FMP_LATENCY_API_KEY: 'latency-key',
        CONFIG_KV: { get: async () => null, put: async () => {} },
      } as never;
      const offStatuses = await getDisclosureLatencyProviderStatuses(env);
      const fmp = offStatuses.find((s) => s.id === 'fmp');
      const rapid = offStatuses.find((s) => s.id === 'fmp_rapidapi');
      expect(fmp?.operationalStatus).toBe('off');
      expect(rapid?.operationalStatus).toBe('off');
      expect(fmp?.configured).toBe(true);
      expect(listFmpLatencyPathRegistry().map((p) => p.pathId).sort()).toEqual(['rapidapi', 'stable']);

      const onEnv = { ...env, FMP_LATENCY_PROBE_ENABLED: 'true' } as never;
      const onStatuses = await getDisclosureLatencyProviderStatuses(onEnv);
      expect(onStatuses.find((s) => s.id === 'fmp')?.operationalStatus).toBe('running');
      expect(onStatuses.find((s) => s.id === 'fmp_rapidapi')?.operationalStatus).toBe('running');

      const stableOnly = {
        ...env,
        FMP_LATENCY_PROBE_ENABLED: '1',
        FMP_LATENCY_PATHS: 'stable',
      } as never;
      const pathStatuses = await getDisclosureLatencyProviderStatuses(stableOnly);
      expect(pathStatuses.find((s) => s.id === 'fmp')?.operationalStatus).toBe('running');
      expect(pathStatuses.find((s) => s.id === 'fmp_rapidapi')?.operationalStatus).toBe('off');
    });

    it('skips FMP HTTP when probe is OFF even if watch is force-run', async () => {
      let fetchCount = 0;
      const fetchImpl = (async () => {
        fetchCount += 1;
        return new Response(JSON.stringify([]), { status: 200 });
      }) as typeof fetch;
      const env = {
        DISCLOSURE_LATENCY_WATCH_ENABLED: 'true',
        FMP_LATENCY_API_KEY: 'k1',
        CONFIG_KV: {
          get: async () => null,
          put: async () => {},
        },
        DB: {
          prepare() {
            return {
              bind() { return this; },
              async all() { return { results: [] }; },
              async first() { return null; },
              async run() { return { success: true, meta: { changes: 0 } }; },
            };
          },
        },
      } as never;
      const result = await runDisclosureLatencyProbe(env, new Date('2026-08-05T15:00:00.000Z'), fetchImpl, {
        force: true,
        providers: ['fmp', 'fmp_rapidapi'],
      });
      expect(fetchCount).toBe(0);
      expect(result.providers.every((p) => p.operationalStatus === 'off')).toBe(true);
      expect(result.fetchedRows).toBe(0);
    });
  });
});
