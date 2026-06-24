import { describe, it, expect } from 'vitest';
import {
  runHouseHistoricalBackfill,
  type HouseBackfillOptions,
} from '../houseCrawler';
import type { HouseFiling } from '../../ingestion/houseSource';
import type { Env, QueueMessage } from '../../shared/types';

// ---------------------------------------------------------------------------
// Test doubles — no network, no real D1/queue.
// ---------------------------------------------------------------------------

/** Build a HouseFiling fixture (mirrors parseHouseIndexXml output shape). */
function filing(year: number, docId: string, filingType: string): HouseFiling {
  const isPtr = filingType.toUpperCase() === 'P';
  return {
    docId,
    filingType,
    year: String(year),
    first: 'Test',
    last: 'Member',
    stateDst: 'CA01',
    isPtr,
    pipelineDocId: `H-${year}-${docId}`,
    sourceUrl: `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/${docId}.pdf`,
  };
}

/**
 * Minimal D1 stub. Every INSERT OR IGNORE reports meta.changes=1 (genuinely
 * new) UNLESS the doc_id has been seen before in this run — mirroring real
 * INSERT OR IGNORE de-duplication so we can assert idempotency.
 */
function fakeEnv(): { env: Env; sent: QueueMessage[]; seen: Set<string> } {
  const sent: QueueMessage[] = [];
  const seen = new Set<string>();

  const db = {
    prepare(_sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        run() {
          // First bound param is doc_id in the crawler's INSERT.
          const docId = String(bound[0]);
          const isNew = !seen.has(docId);
          if (isNew) seen.add(docId);
          return Promise.resolve({ meta: { changes: isNew ? 1 : 0 } } as unknown as D1Result);
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;

  const env = {
    DB: db,
    INGEST_QUEUE: {
      send(msg: QueueMessage) {
        sent.push(msg);
        return Promise.resolve();
      },
    },
  } as unknown as Env;

  return { env, sent, seen };
}

/** Build an injectable index impl from a year->filings map. */
function indexImpl(byYear: Record<number, HouseFiling[]>): HouseBackfillOptions['fetchIndexImpl'] {
  return (year) => Promise.resolve(byYear[Number(year)] ?? []);
}

// ---------------------------------------------------------------------------

describe('runHouseHistoricalBackfill', () => {
  it('iterates the inclusive year range and only enqueues PTRs (FilingType P)', async () => {
    const { env, sent } = fakeEnv();
    const data: Record<number, HouseFiling[]> = {
      2014: [filing(2014, '100', 'P'), filing(2014, '101', 'O') /* annual, not PTR */],
      2015: [filing(2015, '200', 'P'), filing(2015, '201', 'A') /* amendment */],
    };

    const res = await runHouseHistoricalBackfill(env, {
      fromYear: 2014,
      toYear: 2015,
      fetchIndexImpl: indexImpl(data),
    });

    expect(res.fromYear).toBe(2014);
    expect(res.toYear).toBe(2015);
    // 4 filings seen, but only the 2 PTRs are discovered/persisted + enqueued.
    expect(res.discovered).toBe(2);
    expect(res.enqueued).toBe(2);
    expect(res.skipped).toBe(0);
    expect(res.byYear).toEqual({ '2014': 1, '2015': 1 });

    // Exactly the two PTR doc ids, with the watcher-identical message shape.
    expect(sent).toEqual([
      {
        type: 'filing.new',
        docId: 'H-2014-100',
        chamber: 'house',
        sourceUrl: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2014/100.pdf',
      },
      {
        type: 'filing.new',
        docId: 'H-2015-200',
        chamber: 'house',
        sourceUrl: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2015/200.pdf',
      },
    ]);
  });

  it('respects maxFilings as a global cap on enqueued messages', async () => {
    const { env, sent } = fakeEnv();
    const data: Record<number, HouseFiling[]> = {
      2014: [filing(2014, '1', 'P'), filing(2014, '2', 'P'), filing(2014, '3', 'P')],
      2015: [filing(2015, '4', 'P'), filing(2015, '5', 'P')],
    };

    const res = await runHouseHistoricalBackfill(env, {
      fromYear: 2014,
      toYear: 2015,
      maxFilings: 2,
      fetchIndexImpl: indexImpl(data),
    });

    // All 5 PTRs are discovered/persisted, but only 2 are enqueued (the cap).
    expect(res.discovered).toBe(5);
    expect(res.enqueued).toBe(2);
    expect(res.skipped).toBe(3);
    expect(sent).toHaveLength(2);
    expect(sent.map((m) => (m.type === 'filing.new' ? m.docId : ''))).toEqual([
      'H-2014-1',
      'H-2014-2',
    ]);
  });

  it('does not write or enqueue in dryRun', async () => {
    const { env, sent, seen } = fakeEnv();
    const data: Record<number, HouseFiling[]> = { 2014: [filing(2014, '1', 'P')] };

    const res = await runHouseHistoricalBackfill(env, {
      fromYear: 2014,
      toYear: 2014,
      dryRun: true,
      fetchIndexImpl: indexImpl(data),
    });

    expect(res.discovered).toBe(1);
    expect(res.enqueued).toBe(0);
    expect(res.skipped).toBe(1);
    expect(sent).toHaveLength(0);
    expect(seen.size).toBe(0);
  });

  it('is idempotent: a second run never double-enqueues already-seen PTRs', async () => {
    const { env, sent } = fakeEnv(); // shared `seen` across both runs
    const data: Record<number, HouseFiling[]> = { 2014: [filing(2014, '1', 'P')] };
    const opts: HouseBackfillOptions = {
      fromYear: 2014,
      toYear: 2014,
      fetchIndexImpl: indexImpl(data),
    };

    const first = await runHouseHistoricalBackfill(env, opts);
    expect(first.enqueued).toBe(1);

    const second = await runHouseHistoricalBackfill(env, opts);
    // INSERT OR IGNORE -> meta.changes=0 the second time -> nothing enqueued.
    expect(second.enqueued).toBe(0);
    expect(second.skipped).toBe(1);
    expect(sent).toHaveLength(1); // total across both runs
  });

  it('fails soft per-year: one bad year is recorded but does not abort the run', async () => {
    const { env, sent } = fakeEnv();
    const fetchIndexImpl: HouseBackfillOptions['fetchIndexImpl'] = (year) => {
      if (Number(year) === 2015) return Promise.reject(new Error('HTTP 404'));
      return Promise.resolve([filing(Number(year), '1', 'P')]);
    };

    const res = await runHouseHistoricalBackfill(env, {
      fromYear: 2014,
      toYear: 2016,
      fetchIndexImpl,
    });

    // 2014 + 2016 succeed; 2015 is recorded in errors.
    expect(res.enqueued).toBe(2);
    expect(res.errors).toEqual(['2015: HTTP 404']);
    expect(sent).toHaveLength(2);
  });

  it('defaults toYear to the current UTC year and fromYear to 2014', async () => {
    const { env } = fakeEnv();
    const res = await runHouseHistoricalBackfill(env, {
      // no fromYear/toYear -> defaults; empty index so nothing is enqueued.
      fetchIndexImpl: () => Promise.resolve([]),
    });
    expect(res.fromYear).toBe(2014);
    expect(res.toYear).toBe(new Date().getUTCFullYear());
  });
});
