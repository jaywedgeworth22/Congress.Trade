import { describe, it, expect } from 'vitest';
import {
  mapRecordToTransaction,
  deterministicTxId,
  mapTxType,
  mapOwner,
  mapAmount,
  normalizeDate,
  passesSinceYear,
  seedFilerId,
  runSeedBackfill,
  runSeedBackfillFromEnv,
  type RawWatcherRecord,
} from '../seed';
import type { Env } from '../../shared/types';

// Inline fixtures — no network.
const SENATE_REC: RawWatcherRecord = {
  senator: 'Jane A. Smith',
  ticker: 'nvda',
  asset_description: 'NVIDIA Corporation',
  asset_type: 'Stock',
  type: 'Purchase',
  transaction_date: '06/04/2026',
  disclosure_date: '06/19/2026',
  amount: '$250,001 - $500,000',
  owner: 'Spouse',
};

describe('field mappers', () => {
  it('maps transaction type to P/S/E', () => {
    expect(mapTxType('Purchase')).toBe('P');
    expect(mapTxType('Sale (Full)')).toBe('S');
    expect(mapTxType('Sale (Partial)')).toBe('S');
    expect(mapTxType('Exchange')).toBe('E');
    expect(mapTxType(undefined)).toBe('P');
  });

  it('maps owner to the Owner union', () => {
    expect(mapOwner('Spouse')).toBe('spouse');
    expect(mapOwner('Joint')).toBe('joint');
    expect(mapOwner('Dependent Child')).toBe('dependent');
    expect(mapOwner('Self')).toBe('self');
    expect(mapOwner('--')).toBeNull();
    expect(mapOwner(undefined)).toBeNull();
  });

  it('normalizes dates to ISO', () => {
    expect(normalizeDate('06/04/2026')).toBe('2026-06-04');
    expect(normalizeDate('6/4/2026')).toBe('2026-06-04');
    expect(normalizeDate('2026-06-04')).toBe('2026-06-04');
    expect(normalizeDate('garbage')).toBeNull();
    expect(normalizeDate(undefined)).toBeNull();
  });

  it('maps amount ranges onto canonical STOCK Act brackets', () => {
    expect(mapAmount('$1,001 - $15,000')).toEqual({ min: 1001, max: 15000 });
    expect(mapAmount('$250,001 - $500,000')).toEqual({ min: 250001, max: 500000 });
    expect(mapAmount('$50,000,001 +')).toEqual({ min: 50000001, max: null });
    expect(mapAmount('')).toEqual({ min: null, max: null });
  });
});

describe('mapRecordToTransaction', () => {
  it('maps a full senate record to a seed_dataset Transaction', () => {
    const tx = mapRecordToTransaction(SENATE_REC, 'senate', '2026-06-20T00:00:00.000Z');
    expect(tx).not.toBeNull();
    if (!tx) return;
    expect(tx.source).toBe('seed_dataset');
    expect(tx.ticker).toBe('NVDA');
    expect(tx.assetName).toBe('NVIDIA Corporation');
    expect(tx.txType).toBe('P');
    expect(tx.owner).toBe('spouse');
    expect(tx.txDate).toBe('2026-06-04');
    expect(tx.amountMin).toBe(250001);
    expect(tx.amountMax).toBe(500000);
    expect(tx.docId).toBe('seed-senate');
    expect(tx.filerId).toBe('seed-senate-jane-a-smith');
    expect(tx.isOption).toBe(false);
    expect(tx.confidence).toBe(0.8); // SEED_CONFIDENCE (down-ranked from a flat 1.0)
  });

  it('returns null when there is no asset and no ticker', () => {
    const tx = mapRecordToTransaction(
      { senator: 'Nobody', type: 'Purchase' },
      'senate',
      '2026-06-20T00:00:00.000Z',
    );
    expect(tx).toBeNull();
  });

  it('uses the representative field for House records', () => {
    const tx = mapRecordToTransaction(
      { representative: 'Hon. Pat Q. Example', ticker: 'AAPL', type: 'sale' },
      'house',
      '2026-06-20T00:00:00.000Z',
    );
    expect(tx?.filerId).toBe('seed-house-hon-pat-q-example');
    expect(tx?.txType).toBe('S');
  });
});

describe('deterministic id', () => {
  it('is stable for identical inputs (idempotent re-runs)', () => {
    const a = mapRecordToTransaction(SENATE_REC, 'senate', '2026-06-20T00:00:00.000Z');
    const b = mapRecordToTransaction(SENATE_REC, 'senate', '2999-01-01T00:00:00.000Z');
    // createdAt differs but id must not — it excludes timestamp.
    expect(a?.id).toBe(b?.id);
    expect(a?.id).toMatch(/^seed_[0-9a-f]{16}$/);
  });

  it('differs when any identity field changes', () => {
    const base = {
      source: 'seed_dataset',
      filerId: 'seed-senate-jane-a-smith',
      txDate: '2026-06-04',
      ticker: 'NVDA',
      amountMin: 250001,
      amountMax: 500000,
    };
    const id0 = deterministicTxId(base);
    expect(deterministicTxId({ ...base, ticker: 'AAPL' })).not.toBe(id0);
    expect(deterministicTxId({ ...base, txDate: '2026-06-05' })).not.toBe(id0);
    expect(deterministicTxId({ ...base, amountMin: 1001 })).not.toBe(id0);
    expect(deterministicTxId({ ...base, filerId: 'seed-senate-other' })).not.toBe(id0);
  });
});

describe('filters & helpers', () => {
  it('seedFilerId slugs names and rejects empties', () => {
    expect(seedFilerId('senate', 'Jane A. Smith')).toBe('seed-senate-jane-a-smith');
    expect(seedFilerId('house', '   ')).toBeNull();
  });

  it('passesSinceYear filters by tx_date year', () => {
    const tx = mapRecordToTransaction(SENATE_REC, 'senate', '2026-06-20T00:00:00.000Z')!;
    expect(passesSinceYear(tx, undefined)).toBe(true);
    expect(passesSinceYear(tx, 2026)).toBe(true);
    expect(passesSinceYear(tx, 2027)).toBe(false);
  });
});

describe('runSeedBackfill source overrides (dryRun)', () => {
  // dryRun never touches the DB, so a bare cast env is sufficient here.
  const env = {} as Env;

  function jsonFetch(rows: unknown[]): { fetchImpl: typeof fetch; urls: string[] } {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { fetchImpl, urls };
  }

  it('uses opts.sourceUrls override instead of the hardcoded bucket', async () => {
    const { fetchImpl, urls } = jsonFetch([SENATE_REC]);
    const res = await runSeedBackfill(env, {
      chambers: ['senate'],
      dryRun: true,
      fetchImpl,
      sourceUrls: { senate: 'https://mirror.example/senate.json' },
    });
    expect(urls).toEqual(['https://mirror.example/senate.json']);
    expect(res.inserted).toBe(1);
    expect(res.bySource.senate).toBe(1);
  });

  it('runSeedBackfillFromEnv pulls SEED_SENATE_URL from env', async () => {
    const { fetchImpl, urls } = jsonFetch([SENATE_REC]);
    const envWithUrl = { SEED_SENATE_URL: 'https://env.example/senate.json' } as unknown as Env;
    await runSeedBackfillFromEnv(envWithUrl, { chambers: ['senate'], dryRun: true, fetchImpl });
    expect(urls).toEqual(['https://env.example/senate.json']);
  });
});
