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
  disclosurePublishYieldBand,
  disclosurePublishYieldWeight,
  budgetedProbeIntervalSec,
  selectFmpLatencyKey,
  selectRotatedAvenue,
  selectFmpLatencyPathForCycle,
  selectLatencySourceProbe,
  resolveUnusualWhalesKey,
  resolveFmpRapidApiKey,
  getFmpLatencyFleetRemaining,
  getFmpLatencyUsed,
  addFmpLatencyUsed,
  addLatencySourceUsed,
  getLatencySourceUsed,
  LATENCY_SOURCE_BUDGETS,
  getDisclosureLatencyProviderStatuses,
  listFmpLatencyPathRegistry,
  runDisclosureLatencyProbe,
  earliestIso,
  effectiveRaceProviderTime,
  mergeFmpFamilyCandidateRows,
  mergeFmpFamilyObservationRows,
  mergeFmpOperationalStatus,
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
      expect(interval).toBeGreaterThanOrEqual(60);
      expect(interval).toBeLessThanOrEqual(45 * 60);
      // Exhausted budget → max interval (skip signal for caller).
      expect(fmpLatencyIntervalSec(noon, 0)).toBe(45 * 60);
      expect(fmpLatencyIntervalSec(noon, 1)).toBe(45 * 60); // < CALLS_PER_RUN
    });

    it('uses 4-level ET yield bands with peak ~3× denser than mid', () => {
      // 2026-08-05 is a Wednesday.
      // 14:00 UTC = 10:00 ET → peak
      expect(disclosurePublishYieldBand(new Date('2026-08-05T14:00:00.000Z'))).toBe('peak');
      // 17:00 UTC = 13:00 ET → high
      expect(disclosurePublishYieldBand(new Date('2026-08-05T17:00:00.000Z'))).toBe('high');
      // 21:00 UTC = 17:00 ET → mid
      expect(disclosurePublishYieldBand(new Date('2026-08-05T21:00:00.000Z'))).toBe('mid');
      // 04:00 UTC = 00:00 ET → low
      expect(disclosurePublishYieldBand(new Date('2026-08-05T04:00:00.000Z'))).toBe('low');
      expect(disclosurePublishYieldWeight(new Date('2026-08-05T14:00:00.000Z'))).toBe(3);
      expect(disclosurePublishYieldWeight(new Date('2026-08-05T17:00:00.000Z'))).toBe(2);
      expect(disclosurePublishYieldWeight(new Date('2026-08-05T21:00:00.000Z'))).toBe(1);
      expect(disclosurePublishYieldWeight(new Date('2026-08-05T04:00:00.000Z'))).toBe(0.4);
      // Weekend peak downgrades (Sat 2026-08-08 10:00 ET = 14:00 UTC).
      expect(disclosurePublishYieldBand(new Date('2026-08-08T14:00:00.000Z'))).toBe('high');
    });

    it('weights peak ET hours denser than overnight (2–3×+)', () => {
      // America/New_York: 2026-08-05 14:00 UTC = 10:00 ET (peak weekday)
      const peak = fmpLatencyEtHourWeight(new Date('2026-08-05T14:00:00.000Z'));
      // 2026-08-05 04:00 UTC = 00:00 ET (overnight)
      const night = fmpLatencyEtHourWeight(new Date('2026-08-05T04:00:00.000Z'));
      expect(peak).toBeGreaterThanOrEqual(night * 2);
      // Peak spacing should be shorter than overnight for same remaining budget.
      const remaining = 100;
      const peakIv = fmpLatencyIntervalSec(new Date('2026-08-05T14:00:00.000Z'), remaining);
      const nightIv = fmpLatencyIntervalSec(new Date('2026-08-05T04:00:00.000Z'), remaining);
      expect(peakIv).toBeLessThan(nightIv);
      // Shared budgeted helper used by UW/QQ as well.
      const peakShared = budgetedProbeIntervalSec({
        now: new Date('2026-08-05T14:00:00.000Z'),
        remainingRuns: 50,
        minIntervalSec: 60,
        maxIntervalSec: 45 * 60,
      });
      const nightShared = budgetedProbeIntervalSec({
        now: new Date('2026-08-05T04:00:00.000Z'),
        remainingRuns: 50,
        minIntervalSec: 60,
        maxIntervalSec: 45 * 60,
      });
      expect(peakShared).toBeLessThan(nightShared);
    });

    it('resolveUnusualWhalesKey accepts canonical or UNUSUALWHALES alias (single key)', async () => {
      expect(await resolveUnusualWhalesKey({} as never)).toBeNull();
      expect(
        (await resolveUnusualWhalesKey({ UNUSUALWHALES_API_KEY: 'from-global' } as never))?.apiKey,
      ).toBe('from-global');
      expect(
        (
          await resolveUnusualWhalesKey({
            UNUSUAL_WHALES_API_KEY: 'canonical',
            UNUSUALWHALES_API_KEY: 'alias',
          } as never)
        )?.apiKey,
      ).toBe('canonical');
    });

    it('UW/QQ selectLatencySourceProbe enforces daily cap and yield spacing', async () => {
      const kv = new Map<string, string>();
      const env = {
        CONFIG_KV: {
          get: async (k: string) => kv.get(k) ?? null,
          put: async (k: string, v: string) => {
            kv.set(k, v);
          },
        },
        UW_LATENCY_DAILY_CAP: '10',
        QUIVER_LATENCY_DAILY_CAP: '12',
      } as never;
      const peakNow = new Date('2026-08-05T14:00:00.000Z');
      const uw = await selectLatencySourceProbe(env, 'unusual_whales', peakNow, { force: true });
      expect(uw?.cap).toBe(10);
      expect(uw?.callsPerRun).toBe(1);
      expect(uw?.band).toBe('peak');
      await addLatencySourceUsed(env, 'unusual_whales', 10, peakNow);
      expect(await selectLatencySourceProbe(env, 'unusual_whales', peakNow, { force: true })).toBeNull();

      const qq = await selectLatencySourceProbe(env, 'quiver', peakNow, { force: true });
      expect(qq?.cap).toBe(12);
      expect(qq?.callsPerRun).toBe(LATENCY_SOURCE_BUDGETS.quiver.callsPerRun);
      await addLatencySourceUsed(env, 'quiver', 11, peakNow);
      expect(await selectLatencySourceProbe(env, 'quiver', peakNow, { force: true })).toBeNull();
    });

    it('uses FMP_API_KEY as free-tier slot-2 (or sole key) for dual capacity', async () => {
      const kv = new Map<string, string>();
      const env = {
        FMP_API_KEY: 'free-only',
        CONFIG_KV: {
          get: async (k: string) => kv.get(k) ?? null,
          put: async (k: string, v: string) => {
            kv.set(k, v);
          },
        },
      } as never;
      // Sole free key via FMP_API_KEY → slot 2 material (still eligible).
      const sole = await selectFmpLatencyKey(env, new Date('2026-08-05T15:00:00.000Z'), { force: true });
      expect(sole?.apiKey).toBe('free-only');
      expect(sole?.secretName).toBe('FMP_API_KEY');
      expect(sole?.slot).toBe('2');

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

    it('rotates among eligible dual keys (does not dual-spend) and tracks counters', async () => {
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
      await addFmpLatencyUsed(env, '2', 10, now);
      expect(await getFmpLatencyUsed(env, '2', now)).toBe(10);
      // First pick among [1,2] → slot 1 (round-robin from empty last).
      const sel1 = await selectFmpLatencyKey(env, now, { force: true });
      expect(sel1?.slot).toBe('1');
      expect(sel1?.apiKey).toBe('k1');
      // Second pick rotates to slot 2.
      const sel2 = await selectFmpLatencyKey(env, now, { force: true });
      expect(sel2?.slot).toBe('2');
      expect(sel2?.apiKey).toBe('k2');
      expect(sel2?.remaining).toBe(FMP_LATENCY_DAILY_CAP_PER_KEY - 10);
      // Exhaust key1 — only key2 remains eligible, rotation stays on 2.
      await addFmpLatencyUsed(env, '1', FMP_LATENCY_DAILY_CAP_PER_KEY, now);
      const sel3 = await selectFmpLatencyKey(env, now, { force: true });
      expect(sel3?.slot).toBe('2');
    });

    it('selectRotatedAvenue round-robins multi-avenue families', async () => {
      const kv = new Map<string, string>();
      const env = {
        CONFIG_KV: {
          get: async (k: string) => kv.get(k) ?? null,
          put: async (k: string, v: string) => {
            kv.set(k, v);
          },
        },
      } as never;
      expect(await selectRotatedAvenue(env, 'demo', [])).toBeNull();
      expect(await selectRotatedAvenue(env, 'demo', ['only'])).toBe('only');
      expect(await selectRotatedAvenue(env, 'demo', ['a', 'b'])).toBe('a');
      expect(await selectRotatedAvenue(env, 'demo', ['a', 'b'])).toBe('b');
      expect(await selectRotatedAvenue(env, 'demo', ['a', 'b'])).toBe('a');
      // Independent family namespaces.
      expect(await selectRotatedAvenue(env, 'other', ['x', 'y'])).toBe('x');
    });

    it('resolveFmpRapidApiKey prefers FMP_RAPIDAPI_KEY then shared RAPIDAPI_KEY (ST)', async () => {
      expect(await resolveFmpRapidApiKey({} as never)).toBeNull();
      expect(await resolveFmpRapidApiKey({ RAPIDAPI_KEY: 'shared-marketplace' } as never)).toBe(
        'shared-marketplace',
      );
      expect(
        await resolveFmpRapidApiKey({
          FMP_RAPIDAPI_KEY: 'dedicated',
          RAPIDAPI_KEY: 'shared-marketplace',
        } as never),
      ).toBe('dedicated');
      // Free-tier FMP keys are NOT valid RapidAPI credentials.
      expect(await resolveFmpRapidApiKey({ FMP_LATENCY_API_KEY: 'free-tier' } as never)).toBeNull();
    });

    it('selectFmpLatencyPathForCycle defaults to stable only; alternates when rapidapi opt-in', async () => {
      const kv = new Map<string, string>();
      const env = {
        FMP_LATENCY_API_KEY: 'k1',
        RAPIDAPI_KEY: 'marketplace-key',
        CONFIG_KV: {
          get: async (k: string) => kv.get(k) ?? null,
          put: async (k: string, v: string) => {
            kv.set(k, v);
          },
        },
      } as never;
      const ids = ['fmp', 'fmp_rapidapi', 'quiver'] as const;
      // Default FMP_LATENCY_PATHS=stable (RapidAPI congress endpoints 404 on product).
      expect(await selectFmpLatencyPathForCycle(env, ids, { force: true })).toBe('stable');
      expect(await selectFmpLatencyPathForCycle(env, ids, { force: true })).toBe('stable');
      // Opt-in both paths → rotate.
      const both = { ...env, FMP_LATENCY_PATHS: 'stable,rapidapi' } as never;
      expect(await selectFmpLatencyPathForCycle(both, ids, { force: true })).toBe('stable');
      expect(await selectFmpLatencyPathForCycle(both, ids, { force: true })).toBe('rapidapi');
      expect(await selectFmpLatencyPathForCycle(both, ids, { force: true })).toBe('stable');
      // Without marketplace key, RapidAPI is not a candidate even when opt-in.
      const noRapid = {
        FMP_LATENCY_API_KEY: 'k1',
        FMP_LATENCY_PATHS: 'stable,rapidapi',
        CONFIG_KV: env.CONFIG_KV,
      } as never;
      expect(await selectFmpLatencyPathForCycle(noRapid, ids, { force: true })).toBe('stable');
      expect(await selectFmpLatencyPathForCycle(noRapid, ids, { force: true })).toBe('stable');
      // Probe OFF — no path selected.
      const off = { ...env, FMP_LATENCY_PROBE_ENABLED: 'false' } as never;
      expect(await selectFmpLatencyPathForCycle(off, ids, { force: true })).toBeNull();
    });

    it('selectFmpLatencyKey rotates dual free keys including FMP_API_KEY as slot-2 fallback', async () => {
      const kv = new Map<string, string>();
      const env = {
        FMP_LATENCY_API_KEY: 'free-key-a',
        FMP_API_KEY: 'free-key-b',
        CONFIG_KV: {
          get: async (k: string) => kv.get(k) ?? null,
          put: async (k: string, v: string) => {
            kv.set(k, v);
          },
        },
      } as never;
      const now = new Date('2026-08-05T15:00:00.000Z');
      const a = await selectFmpLatencyKey(env, now, { force: true });
      const b = await selectFmpLatencyKey(env, now, { force: true });
      const c = await selectFmpLatencyKey(env, now, { force: true });
      expect(a?.apiKey).toBe('free-key-a');
      expect(a?.slot).toBe('1');
      expect(b?.apiKey).toBe('free-key-b');
      expect(b?.slot).toBe('2');
      expect(b?.secretName).toBe('FMP_API_KEY');
      expect(c?.apiKey).toBe('free-key-a');
      // Duplicate of primary must not create a second slot.
      const same = {
        FMP_LATENCY_API_KEY: 'same',
        FMP_API_KEY: 'same',
        CONFIG_KV: env.CONFIG_KV,
      } as never;
      const only = await selectFmpLatencyKey(same, now, { force: true });
      expect(only?.slot).toBe('1');
      expect(await selectFmpLatencyKey(same, now, { force: true })).toMatchObject({ slot: '1', apiKey: 'same' });
      const fleet = await getFmpLatencyFleetRemaining(env, now);
      expect(fleet.freeTierKeysConfigured).toBe(2);
      expect(fleet.freeTierCap).toBe(FMP_LATENCY_DAILY_CAP_PER_KEY * 2);
    });

    it('getFmpLatencyFleetRemaining sums dual free keys + RapidAPI path budget', async () => {
      const kv = new Map<string, string>();
      const env = {
        FMP_LATENCY_API_KEY: 'k1',
        ['FMP_LATENCY_API_KEY' + '_2']: 'k2',
        RAPIDAPI_KEY: 'marketplace',
        FMP_RAPIDAPI_DAILY_CAP: '100',
        CONFIG_KV: {
          get: async (k: string) => kv.get(k) ?? null,
          put: async (k: string, v: string) => {
            kv.set(k, v);
          },
        },
      } as never;
      const now = new Date('2026-08-05T15:00:00.000Z');
      const fleet = await getFmpLatencyFleetRemaining(env, now);
      expect(fleet.freeTierKeysConfigured).toBe(2);
      expect(fleet.freeTierCap).toBe(FMP_LATENCY_DAILY_CAP_PER_KEY * 2);
      expect(fleet.freeTierRemaining).toBe(FMP_LATENCY_DAILY_CAP_PER_KEY * 2);
      expect(fleet.rapidapiCap).toBe(100);
      expect(fleet.rapidapiRemaining).toBe(100);
      expect(fleet.totalRemaining).toBe(FMP_LATENCY_DAILY_CAP_PER_KEY * 2 + 100);
    });

    it('probe run HTTP-spends only one FMP path per cycle when both enabled', async () => {
      const kv = new Map<string, string>();
      const hosts: string[] = [];
      const fetchImpl = (async (input: RequestInfo | URL) => {
        const url = String(input);
        hosts.push(url);
        return new Response(JSON.stringify([]), { status: 200 });
      }) as typeof fetch;
      const env = {
        DISCLOSURE_LATENCY_WATCH_ENABLED: 'true',
        FMP_LATENCY_API_KEY: 'k1',
        RAPIDAPI_KEY: 'marketplace-key',
        FMP_LATENCY_PATHS: 'stable,rapidapi',
        CONFIG_KV: {
          get: async (k: string) => kv.get(k) ?? null,
          put: async (k: string, v: string) => {
            kv.set(k, v);
          },
        },
        DB: {
          prepare() {
            return {
              bind() {
                return this;
              },
              async all() {
                return { results: [] };
              },
              async first() {
                return null;
              },
              async run() {
                return { success: true, meta: { changes: 0 } };
              },
            };
          },
        },
      } as never;
      const now = new Date('2026-08-05T15:00:00.000Z');
      const r1 = await runDisclosureLatencyProbe(env, now, fetchImpl, {
        force: true,
        providers: ['fmp', 'fmp_rapidapi'],
      });
      // House + senate = 2 calls for the selected path only.
      expect(hosts.length).toBe(2);
      expect(hosts.every((u) => u.includes('financialmodelingprep.com'))).toBe(true);
      const rotated = r1.providers.find((p) => p.id === 'fmp_rapidapi');
      expect(rotated?.enabled).toBe(false);
      expect(rotated?.reason).toMatch(/rotated/i);

      hosts.length = 0;
      const r2 = await runDisclosureLatencyProbe(env, now, fetchImpl, {
        force: true,
        providers: ['fmp', 'fmp_rapidapi'],
      });
      // Second cycle should hit RapidAPI host, not stable.
      expect(hosts.length).toBe(2);
      expect(hosts.every((u) => u.includes('rapidapi.com'))).toBe(true);
      const rotatedStable = r2.providers.find((p) => p.id === 'fmp');
      expect(rotatedStable?.enabled).toBe(false);
      expect(rotatedStable?.reason).toMatch(/rotated/i);
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

    it('reports FMP configured when latency key or free-tier FMP_API_KEY present', async () => {
      // FMP_API_KEY alone is valid free-tier material (slot-2 fallback / single key).
      const statusesLegacy = await getDisclosureLatencyProviderStatuses({
        FMP_API_KEY: 'free-tier-only',
        CONFIG_KV: { get: async () => null, put: async () => {} },
      } as never);
      const fmpLegacy = statusesLegacy.find((s) => s.id === 'fmp');
      expect(fmpLegacy?.configured).toBe(true);

      const statuses = await getDisclosureLatencyProviderStatuses({
        ['FMP_LATENCY_API_KEY' + '_2']: 'second-key',
        CONFIG_KV: { get: async () => null, put: async () => {} },
      } as never);
      const fmp = statuses.find((s) => s.id === 'fmp');
      expect(fmp?.configured).toBe(true);
    });

    it('defaults FMP family ON for CT when latency key present (explicit false disables); rapidapi path off by default', async () => {
      const env = {
        FMP_LATENCY_API_KEY: 'latency-key',
        RAPIDAPI_KEY: 'marketplace-key',
        CONFIG_KV: { get: async () => null, put: async () => {} },
      } as never;
      const defaultStatuses = await getDisclosureLatencyProviderStatuses(env);
      const fmp = defaultStatuses.find((s) => s.id === 'fmp');
      const rapid = defaultStatuses.find((s) => s.id === 'fmp_rapidapi');
      // Default ON for stable — not grey OFF (owner: FMP is for CT latency).
      expect(fmp?.operationalStatus).toBe('running');
      // RapidAPI path default OFF (congress endpoints not on marketplace product).
      expect(rapid?.operationalStatus).toBe('off');
      expect(fmp?.configured).toBe(true);
      expect(rapid?.configured).toBe(true);
      expect(listFmpLatencyPathRegistry().map((p) => p.pathId).sort()).toEqual(['rapidapi', 'stable']);

      const offEnv = { ...env, FMP_LATENCY_PROBE_ENABLED: 'false' } as never;
      const offStatuses = await getDisclosureLatencyProviderStatuses(offEnv);
      expect(offStatuses.find((s) => s.id === 'fmp')?.operationalStatus).toBe('off');
      expect(offStatuses.find((s) => s.id === 'fmp_rapidapi')?.operationalStatus).toBe('off');

      const withRapid = {
        ...env,
        FMP_LATENCY_PATHS: 'stable,rapidapi',
      } as never;
      const pathStatuses = await getDisclosureLatencyProviderStatuses(withRapid);
      expect(pathStatuses.find((s) => s.id === 'fmp')?.operationalStatus).toBe('running');
      expect(pathStatuses.find((s) => s.id === 'fmp_rapidapi')?.operationalStatus).toBe('running');
    });

    it('skips FMP HTTP when probe is explicitly OFF even if watch is force-run', async () => {
      let fetchCount = 0;
      const fetchImpl = (async () => {
        fetchCount += 1;
        return new Response(JSON.stringify([]), { status: 200 });
      }) as typeof fetch;
      const env = {
        DISCLOSURE_LATENCY_WATCH_ENABLED: 'true',
        FMP_LATENCY_PROBE_ENABLED: 'false',
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

  describe('public scoreboard FMP merge + effective timing', () => {
    it('earliestIso picks the minimum parseable stamp', () => {
      expect(earliestIso('2026-08-05T12:00:00.000Z', '2026-08-05T11:00:00.000Z', null)).toBe(
        '2026-08-05T11:00:00.000Z',
      );
      expect(earliestIso(null, undefined, '')).toBeNull();
    });

    it('effectiveRaceProviderTime falls back to first_seen for provider-kind feeds', () => {
      expect(
        effectiveRaceProviderTime('provider', {
          provider_published_at: null,
          provider_first_seen_at: '2026-08-05T10:00:00.000Z',
        }),
      ).toBe('2026-08-05T10:00:00.000Z');
      expect(
        effectiveRaceProviderTime('provider', {
          provider_published_at: '2026-08-05T09:00:00.000Z',
          provider_first_seen_at: '2026-08-05T10:00:00.000Z',
        }),
      ).toBe('2026-08-05T09:00:00.000Z');
      expect(
        effectiveRaceProviderTime('monitor', {
          provider_published_at: '2026-08-05T09:00:00.000Z',
          provider_first_seen_at: '2026-08-05T10:00:00.000Z',
        }),
      ).toBe('2026-08-05T10:00:00.000Z');
    });

    it('mergeFmpFamilyCandidateRows collapses dual paths by trade_hash with earliest stamp', () => {
      const merged = mergeFmpFamilyCandidateRows([
        {
          provider: 'fmp',
          trade_hash: 't1',
          status: 'matched',
          chamber: 'house',
          provider_key: 'a',
          match_method: 'trade-hash',
          congress_first_seen_at: '2026-08-05T10:00:00.000Z',
          provider_first_seen_at: '2026-08-05T10:05:00.000Z',
          provider_published_at: null,
          filed_date: '2026-08-05',
          created_at: '2026-08-05T10:00:00.000Z',
          updated_at: '2026-08-05T10:05:00.000Z',
        },
        {
          provider: 'fmp_rapidapi',
          trade_hash: 't1',
          status: 'matched',
          chamber: 'house',
          provider_key: 'b',
          match_method: 'trade-hash',
          congress_first_seen_at: '2026-08-05T10:00:00.000Z',
          provider_first_seen_at: '2026-08-05T10:02:00.000Z',
          provider_published_at: null,
          filed_date: '2026-08-05',
          created_at: '2026-08-05T10:00:00.000Z',
          updated_at: '2026-08-05T10:02:00.000Z',
        },
      ]);
      expect(merged).toHaveLength(1);
      expect(merged[0]!.provider).toBe('fmp');
      expect(merged[0]!.provider_first_seen_at).toBe('2026-08-05T10:02:00.000Z');
    });

    it('mergeFmpFamilyObservationRows dedupes by trade_hash', () => {
      const merged = mergeFmpFamilyObservationRows([
        {
          provider: 'fmp',
          chamber: 'house',
          provider_key: 'a',
          trade_hash: 't1',
          first_observed_at: '2026-08-05T10:05:00.000Z',
          last_observed_at: '2026-08-05T10:05:00.000Z',
          provider_published_at: null,
          source_url: null,
          filed_date: null,
          filer_name: null,
          payload: null,
        },
        {
          provider: 'fmp_rapidapi',
          chamber: 'house',
          provider_key: 'b',
          trade_hash: 't1',
          first_observed_at: '2026-08-05T10:01:00.000Z',
          last_observed_at: '2026-08-05T10:01:00.000Z',
          provider_published_at: null,
          source_url: null,
          filed_date: null,
          filer_name: null,
          payload: null,
        },
      ]);
      expect(merged).toHaveLength(1);
      expect(merged[0]!.first_observed_at).toBe('2026-08-05T10:01:00.000Z');
      expect(merged[0]!.provider).toBe('fmp');
    });

    it('mergeFmpOperationalStatus prefers running over stopped/off', () => {
      expect(mergeFmpOperationalStatus(['off', 'running'])).toBe('running');
      expect(mergeFmpOperationalStatus(['stopped', 'off'])).toBe('stopped');
      expect(mergeFmpOperationalStatus(['off', 'off'])).toBe('off');
    });
  });
});
