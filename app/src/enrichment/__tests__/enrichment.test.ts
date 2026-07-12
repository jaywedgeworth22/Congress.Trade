/**
 * src/enrichment/__tests__/enrichment.test.ts
 *
 * Unit tests for the pure enrichment core: market-cap bucketing, SIC→sector,
 * budget arithmetic, provider-merge, and the FMP / SEC-EDGAR response parsers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { marketCapBucket, sicToSector, remainingBudget, mergeRefs } from '../compute';
import { parseFmpProfile } from '../fmp';
import { parseCompanyTickers, parseSecSubmissions, padCik } from '../sec';
import { enrichmentNeededSql, hasConfiguredKeyedEnrichmentProvider, runEnrichment } from '../service';
import { __resetSharedEdgarPacerForTests } from '../../shared/pace';

describe('marketCapBucket', () => {
  it('buckets by the standard thresholds', () => {
    expect(marketCapBucket(3.2e12)).toBe('mega');
    expect(marketCapBucket(200e9)).toBe('mega');
    expect(marketCapBucket(50e9)).toBe('large');
    expect(marketCapBucket(5e9)).toBe('mid');
    expect(marketCapBucket(1e9)).toBe('small');
    expect(marketCapBucket(1e8)).toBe('micro');
    expect(marketCapBucket(1e7)).toBe('nano');
  });
  it('is null for missing / non-positive', () => {
    expect(marketCapBucket(null)).toBeNull();
    expect(marketCapBucket(0)).toBeNull();
    expect(marketCapBucket(undefined)).toBeNull();
  });
});

describe('sicToSector', () => {
  it('maps SIC division ranges to coarse sectors', () => {
    expect(sicToSector(3674)).toBe('Manufacturing'); // semiconductors
    expect(sicToSector('6021')).toBe('Finance, Insurance & Real Estate');
    expect(sicToSector(7372)).toBe('Services'); // prepackaged software
    expect(sicToSector(1311)).toBe('Mining'); // crude petroleum
    expect(sicToSector(5812)).toBe('Retail Trade');
  });
  it('is null for missing/invalid', () => {
    expect(sicToSector(null)).toBeNull();
    expect(sicToSector('')).toBeNull();
    expect(sicToSector('abc')).toBeNull();
  });
});

describe('remainingBudget', () => {
  it('is cap minus used, never negative, optionally capped by runMax', () => {
    expect(remainingBudget(230, 0)).toBe(230);
    expect(remainingBudget(230, 200)).toBe(30);
    expect(remainingBudget(230, 999)).toBe(0);
    expect(remainingBudget(230, 100, 50)).toBe(50); // runMax wins
    expect(remainingBudget(230, 220, 50)).toBe(10); // budget wins
  });
});

describe('enrichmentNeededSql', () => {
  it('retries incomplete EDGAR/imported rows only when a keyed provider exists', () => {
    expect(enrichmentNeededSql('sr', false)).toBe('(sr.ticker IS NULL OR sr.enriched_at IS NULL)');
    const withKey = enrichmentNeededSql('sr', true);
    expect(withKey).toContain('sr.company_name IS NULL');
    expect(withKey).toContain('sr.country IS NULL');
    expect(withKey).toContain('sr.market_cap IS NULL');
    expect(withKey).toContain("sr.source LIKE '%fmp%'");
    expect(withKey).toContain('AND NOT');
  });
});

describe('hasConfiguredKeyedEnrichmentProvider', () => {
  // Async since the keys resolve through Infisical (env fallback in tests).
  it('detects any configured keyed market-data provider', async () => {
    expect(await hasConfiguredKeyedEnrichmentProvider({} as never)).toBe(false);
    expect(await hasConfiguredKeyedEnrichmentProvider({ FMP_API_KEY: 'k' } as never)).toBe(true);
    expect(await hasConfiguredKeyedEnrichmentProvider({ MASSIVE_API_KEY: 'k' } as never)).toBe(true);
    // Tiingo is intentionally excluded — its free tier supplies only name+exchange,
    // so it should not enable retry-incomplete mode that would endlessly re-select
    // the same newest tickers (which already have enriched_at but not sector/market cap).
    expect(await hasConfiguredKeyedEnrichmentProvider({ TIINGO_API_KEY: 'k' } as never)).toBe(false);
  });
});

describe('mergeRefs', () => {
  it('layers a richer provider over a coarser one without erasing fields', () => {
    const edgar = { sector: 'Manufacturing', stateOfIncorp: 'DE', cik: '0000320193', source: 'edgar' };
    const fmp = { sector: 'Technology', marketCap: 3.2e12, country: 'US', isEtf: false, source: 'fmp' };
    const merged = mergeRefs('AAPL', [edgar, fmp]);
    expect(merged.sector).toBe('Technology'); // fmp overrides edgar
    expect(merged.stateOfIncorp).toBe('DE'); // kept from edgar
    expect(merged.marketCap).toBe(3.2e12);
    expect(merged.marketCapBucket).toBe('mega'); // recomputed
    expect(merged.country).toBe('US');
    expect(merged.source).toBe('edgar+fmp');
  });
  it('OR-s booleans and ignores null/empty overrides', () => {
    const merged = mergeRefs('SPY', [{ isEtf: true, sector: 'X' }, { isEtf: false, sector: null }]);
    expect(merged.isEtf).toBe(true);
    expect(merged.sector).toBe('X'); // null didn't erase it
  });
});

describe('parseFmpProfile', () => {
  it('parses a profile array into a partial ref', () => {
    const r = parseFmpProfile([
      { symbol: 'AAPL', companyName: 'Apple Inc.', sector: 'Technology', industry: 'Consumer Electronics',
        mktCap: 3200000000000, country: 'US', state: 'CA', exchangeShortName: 'NASDAQ', currency: 'USD',
        ipoDate: '1980-12-12', cik: '0000320193', isEtf: false, isAdr: false },
    ]);
    expect(r).not.toBeNull();
    expect(r!.sector).toBe('Technology');
    expect(r!.marketCap).toBe(3200000000000);
    expect(r!.marketCapBucket).toBe('mega');
    expect(r!.assetClass).toBe('equity');
    expect(r!.exchangeShort).toBe('NASDAQ');
    expect(r!.source).toBe('fmp');
  });
  it('flags ETFs and returns null for an empty/unknown response', () => {
    expect(parseFmpProfile([{ symbol: 'SPY', isEtf: true }])!.assetClass).toBe('etf');
    expect(parseFmpProfile([])).toBeNull();
    expect(parseFmpProfile({})).toBeNull();
  });
});

describe('SEC EDGAR parsers', () => {
  it('padCik zero-pads to 10 digits', () => {
    expect(padCik(320193)).toBe('0000320193');
    expect(padCik('0000320193')).toBe('0000320193');
  });
  it('parseCompanyTickers builds an uppercase ticker→CIK map', () => {
    const m = parseCompanyTickers({
      '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
      '1': { cik_str: 789019, ticker: 'msft', title: 'Microsoft' },
    });
    expect(m.get('AAPL')).toBe('0000320193');
    expect(m.get('MSFT')).toBe('0000789019');
  });
  it('parseSecSubmissions derives sector from SIC and flags ETFs', () => {
    const r = parseSecSubmissions({
      name: 'Apple Inc.', sic: '3571', sicDescription: 'Electronic Computers',
      stateOfIncorporation: 'CA', exchanges: ['Nasdaq'], cik: 320193, category: 'Operating',
    });
    expect(r!.sector).toBe('Manufacturing');
    expect(r!.stateOfIncorp).toBe('CA');
    expect(r!.exchange).toBe('Nasdaq');
    expect(r!.cik).toBe('0000320193');
    expect(r!.isEtf).toBe(false);
    expect(parseSecSubmissions({ name: 'SPDR', category: 'Exchange Traded Fund' })!.isEtf).toBe(true);
  });
});

/**
 * Regression coverage for the throttling change: EDGAR calls used to skip
 * pace() entirely ("EDGAR is free + unmetered"). They now await the
 * EDGAR-dedicated pacer, same as every other provider awaits its own gate.
 * Minimal D1/KV fakes (mirrors the pattern in
 * ingestion/__tests__/fmpDisclosureLatency.test.ts) let this exercise the real
 * runEnrichment provider loop instead of only the pacer unit in isolation.
 */
describe('runEnrichment paces SEC EDGAR calls', () => {
  beforeEach(() => __resetSharedEdgarPacerForTests());
  afterEach(() => vi.unstubAllGlobals());

  function fakeDb(tickerRows: Array<{ ticker: string }>) {
    const stmt = {
      bind() {
        return stmt;
      },
      async all<T>() {
        return { results: tickerRows as unknown as T[] };
      },
      async first<T>() {
        return null as T | null;
      },
      async run() {
        return { success: true, meta: { changes: 0 } };
      },
    };
    return { prepare: () => stmt, async batch() { return []; } } as unknown as D1Database;
  }

  function fakeKv() {
    const store = new Map<string, string>();
    return {
      async get(k: string) {
        return store.get(k) ?? null;
      },
      async put(k: string, v: string) {
        store.set(k, v);
      },
      async delete(k: string) {
        store.delete(k);
      },
    };
  }

  it('awaits the EDGAR-dedicated pacer before every EDGAR fetch, no keyed provider configured', async () => {
    const db = fakeDb([{ ticker: 'AAA' }, { ticker: 'BBB' }]);
    const kv = fakeKv();

    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('company_tickers.json')) {
        return {
          ok: true,
          json: async () => ({
            '0': { cik_str: 1, ticker: 'AAA' },
            '1': { cik_str: 2, ticker: 'BBB' },
          }),
        } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => ({
          name: 'Test Co', sic: '7372', exchanges: ['Nasdaq'], cik: 1, category: 'Operating',
        }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchImpl);

    const env = { DB: db, CONFIG_KV: kv } as unknown as Parameters<typeof runEnrichment>[0];

    const t0 = Date.now();
    // 600/min = 100ms min gap; a fast rate chosen for a deterministic-but-quick
    // test, not the production default (see EDGAR_MAX_PER_MINUTE in wrangler.toml).
    const result = await runEnrichment(env, { max: 2, dryRun: true, edgarMaxPerMinute: 600 });
    const elapsed = Date.now() - t0;

    expect(result.scanned).toBe(2);
    expect(result.enriched).toBe(2); // both tickers resolved via the EDGAR-only chain
    // Before this change, EDGAR calls skipped pace() entirely and this loop of
    // 2 EDGAR fetches would finish near-instantly; now the second call is
    // gated behind the pacer's ~100ms min gap from the first.
    expect(elapsed).toBeGreaterThanOrEqual(90);
  });
});
