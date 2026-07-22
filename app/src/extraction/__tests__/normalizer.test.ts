import { describe, it, expect } from 'vitest';
import {
  normalize,
  CONFIDENCE_THRESHOLD,
  MAX_PUBLISH_TRANSACTIONS_PER_FILING,
  persistTransactions,
  TransactionPublishLimitError,
  transactionRowKey,
} from '../normalizer.ts';
import type { Env, Filing, ParsedTx } from '../../shared/types.ts';

// ---------------------------------------------------------------------------
// Minimal in-memory D1 + Queue fakes. We only need to satisfy the prepared-
// statement surface the normalizer touches (prepare -> bind -> all/run/first),
// and capture which writes happened.
// ---------------------------------------------------------------------------

interface Captured {
  insertedTx: Array<Record<string, unknown>>;
  reviewRows: unknown[][];
  reviewSql: string[];
  filingUpdates: unknown[][];
  enqueued: Array<{ type: string; txId: string }>;
  batches: string[][];
  auditRows: unknown[][];
}

function makeEnv(
  securities: Array<{ ticker: string; name: string | null; aliases: string | null }>,
  opts: { failAudit?: boolean } = {},
) {
  const cap: Captured = {
    insertedTx: [],
    reviewRows: [],
    reviewSql: [],
    filingUpdates: [],
    enqueued: [],
    batches: [],
    auditRows: [],
  };
  const insertedByRowKey = new Map<string, Record<string, unknown>>();
  const outboxSeen = new Set<string>();
  let failAudit = opts.failAudit ?? false;

  const prepare = (sql: string) => {
    const stmt = {
      _sql: sql,
      _params: [] as unknown[],
      bind(...params: unknown[]) {
        this._params = params;
        return this;
      },
      async all<T>() {
        if (/FROM securities_master/i.test(sql)) {
          return { results: securities as unknown as T[] };
        }
        return { results: [] as T[] };
      },
      async first<T>() {
        if (/SELECT resolved, review_revision, agreement_suppressed_at/i.test(sql)) {
          return null as T | null;
        }
        return null as T | null;
      },
      async run() {
        let changes = 1;
        if (/INSERT(?: OR IGNORE)? INTO transactions/i.test(sql) && /json_each/i.test(sql)) {
          const rows = JSON.parse(String(this._params[0])) as Array<Record<string, unknown>>;
          changes = 0;
          for (const row of rows) {
            const rowKey = String(row.rowKey ?? '');
            if (!insertedByRowKey.has(rowKey)) {
              insertedByRowKey.set(rowKey, row);
              cap.insertedTx.push(row);
              changes += 1;
            }
          }
        } else if (/INSERT OR IGNORE INTO delivery_outbox/i.test(sql)) {
          const rows = JSON.parse(String(this._params[3])) as Array<Record<string, unknown>>;
          changes = 0;
          for (const row of rows) {
            const rowKey = String(row.rowKey ?? '');
            const txId = String(insertedByRowKey.get(rowKey)?.id ?? '');
            if (txId && !outboxSeen.has(txId)) {
              outboxSeen.add(txId);
              changes += 1;
            }
          }
        } else if (/INSERT(?: OR IGNORE)? INTO review_queue/i.test(sql) || /UPDATE review_queue\s+SET reason/i.test(sql)) {
          cap.reviewRows.push(this._params);
          cap.reviewSql.push(sql);
        }
        else if (/INSERT(?: OR IGNORE)? INTO ingestion_decisions/i.test(sql)) cap.auditRows.push(this._params);
        else if (/UPDATE filings/i.test(sql)) cap.filingUpdates.push(this._params);
        return { success: true, meta: { changes } } as unknown;
      },
    };
    return stmt;
  };

  const env = {
    DB: {
      prepare,
      async batch(statements: Array<{ _sql: string; run(): Promise<unknown> }>) {
        cap.batches.push(statements.map((statement) => statement._sql));
        if (failAudit && statements.some((statement) => /ingestion_decisions/i.test(statement._sql))) {
          throw new Error('audit insert failed');
        }
        return Promise.all(statements.map((statement) => statement.run()));
      },
    } as unknown as D1Database,
    DELIVERY_QUEUE: {
      async send(msg: { type: string; txId: string }) {
        cap.enqueued.push(msg);
      },
      async sendBatch(msgs: { body: any }[]) {
        for (const m of msgs) cap.enqueued.push(m.body);
      },
    } as unknown as Env['DELIVERY_QUEUE'],
  } as unknown as Env;

  return { env, cap, allowAudit: () => { failAudit = false; } };
}

const filing = (over: Partial<Filing> = {}): Filing => ({
  docId: 'doc1',
  chamber: 'senate',
  filerId: 'F1',
  filingType: 'P',
  filedDate: '2024-07-01',
  sourceUrl: 'https://x',
  rawObjectKey: 'raw/senate/doc1.html',
  ingestStatus: 'extracted',
  docKind: 'senate_html',
  extractor: 'senateHtml',
  modelVersion: null,
  confidence: null,
  firstSeenAt: '2024-07-01T00:00:00.000Z',
  sourceUpdatedAt: null,
  error: null,
  ...over,
});

const tx = (over: Partial<ParsedTx> = {}): ParsedTx => ({
  txDate: '2024-06-14',
  owner: 'self',
  assetName: 'Apple Inc.',
  ticker: 'AAPL',
  assetType: 'Stock',
  txType: 'P',
  amountMin: 1001,
  amountMax: 15000,
  isOption: false,
  capGainsOver200: false,
  rawText: 'AAPL Apple Inc P $1,001 - $15,000',
  confidence: 0.97,
  ...over,
});

describe('normalize', () => {
  it('holds an oversized extraction for review and caps its review payload', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    const parsed = Array.from(
      { length: MAX_PUBLISH_TRANSACTIONS_PER_FILING + 1 },
      (_, index) => tx({ rawText: `row ${index}` }),
    );
    const result = await normalize(env, filing(), parsed);
    expect(result.needsReview).toBe(true);
    expect(cap.insertedTx).toHaveLength(0);
    expect(String(cap.reviewRows[0][1])).toBe('extraction_row_limit_exceeded');
    const payload = JSON.parse(String(cap.reviewRows[0][2])) as {
      transactionCount: number; truncated: boolean; transactions: unknown[];
    };
    expect(payload).toMatchObject({ transactionCount: 201, truncated: true });
    expect(payload.transactions).toHaveLength(MAX_PUBLISH_TRANSACTIONS_PER_FILING);
    await expect(persistTransactions(env, result.transactions)).rejects.toBeInstanceOf(TransactionPublishLimitError);
  });

  it('makes the publication receipt part of the atomic batch and retries it idempotently', async () => {
    const { env, cap, allowAudit } = makeEnv(
      [{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }],
      { failAudit: true },
    );
    await expect(normalize(env, filing(), [tx()])).rejects.toThrow('audit insert failed');
    expect(cap.insertedTx).toHaveLength(0);
    allowAudit();
    await normalize(env, filing(), [tx()]);
    await normalize(env, filing(), [tx()]);
    expect(cap.insertedTx).toHaveLength(1);
    expect(cap.auditRows).toHaveLength(2);
    expect(cap.auditRows[0][0]).toBe('decision:auto_published:doc1');
    expect(cap.auditRows[1][0]).toBe(cap.auditRows[0][0]);
  });

  it('atomically retries needs-review state with one deterministic receipt', async () => {
    const { env, cap, allowAudit } = makeEnv([], { failAudit: true });
    const parsed = [tx({ ticker: 'Bank of America Mystery', assetName: 'Mystery Co' })];
    await expect(normalize(env, filing(), parsed)).rejects.toThrow('audit insert failed');
    expect(cap.reviewRows).toHaveLength(0);
    expect(cap.filingUpdates).toHaveLength(0);

    allowAudit();
    await normalize(env, filing(), parsed);
    await normalize(env, filing(), parsed);
    expect(cap.reviewRows).toHaveLength(2);
    expect(cap.auditRows).toHaveLength(2);
    expect(cap.auditRows[0][0]).toBe('decision:review_opened:doc1');
    expect(cap.auditRows[1][0]).toBe(cap.auditRows[0][0]);
    expect(cap.batches.at(-1)).toEqual(expect.arrayContaining([
      expect.stringMatching(/UPDATE filings/),
      expect.stringMatching(/INSERT(?: OR IGNORE)? INTO review_queue/),
      expect.stringMatching(/INSERT OR IGNORE INTO ingestion_decisions/),
    ]));
  });

  it('keeps row identity stable when asset type labels are added as enrichment', () => {
    const parsed = tx({ assetType: 'Stock', assetTypeName: null });
    const enriched = tx({ assetType: 'Stock', assetTypeName: 'Stock' });

    expect(transactionRowKey('primary', 0, enriched)).toBe(transactionRowKey('primary', 0, parsed));

    const house = tx({ assetType: 'ST', assetTypeName: 'Stocks (including ADRs)' });
    const houseWithoutLabel = tx({ assetType: 'ST', assetTypeName: null });
    expect(transactionRowKey('primary', 0, house)).not.toBe(transactionRowKey('primary', 0, houseWithoutLabel));
  });

  it('publishes high-confidence, resolved, valid rows', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '["Apple"]' }]);
    const result = await normalize(env, filing(), [tx()]);

    expect(result.needsReview).toBe(false);
    expect(result.minConfidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].ticker).toBe('AAPL');
    expect(result.transactions[0].source).toBe('primary');

    // Persisted + delivery fan-out happened; no review row.
    expect(cap.insertedTx).toHaveLength(1);
    expect(cap.insertedTx[0].rowKey).toEqual(expect.stringMatching(/^v1:primary:0:/));
    expect(cap.insertedTx[0].estValue).toBe((1001 + 15000) / 2);
    expect(cap.reviewRows).toHaveLength(0);
    // Queue publication is now reconciled from the durable outbox. This minimal
    // fake does not materialize SELECT-based outbox rows for the flusher.
    expect(cap.enqueued).toEqual([]);
    // Filing metadata and persisted status are committed by one atomic update.
    expect(cap.filingUpdates).toHaveLength(1);
    expect(cap.filingUpdates[0].slice(0, 4)).toEqual([
      result.minConfidence,
      'senateHtml',
      null,
      'doc1',
    ]);
    expect(cap.batches).toEqual([
      expect.arrayContaining([
        expect.stringMatching(/INSERT OR IGNORE INTO transactions/),
        expect.stringMatching(/INSERT OR IGNORE INTO delivery_outbox/),
        expect.stringMatching(/ingest_status = 'persisted'/),
        expect.stringMatching(/INSERT OR IGNORE INTO ingestion_decisions/),
      ]),
    ]);
  });

  it('does not insert or enqueue duplicates when the same filing is normalized twice', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '["Apple"]' }]);
    const first = await normalize(env, filing(), [tx()]);
    const second = await normalize(env, filing(), [tx()]);

    expect(first.needsReview).toBe(false);
    expect(second.needsReview).toBe(false);
    expect(cap.insertedTx).toHaveLength(1);
    expect(cap.enqueued).toHaveLength(0);
    expect(cap.auditRows).toHaveLength(2);
    expect(cap.auditRows[0][0]).toBe(cap.auditRows[1][0]);
  });

  it('resolves ticker via alias when raw ticker is missing', async () => {
    const { env } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '["apple inc."]' }]);
    const result = await normalize(env, filing(), [tx({ ticker: null })]);
    expect(result.transactions[0].ticker).toBe('AAPL');
    expect(result.needsReview).toBe(false);
  });

  it('routes to review when ticker is malformed/contaminated (confidence penalty pushes below threshold)', async () => {
    const { env, cap } = makeEnv([]); // empty securities_master
    // A header-contaminated, non-symbol string (spaces) is NOT a well-formed
    // ticker, so it stays unresolved and routes to review.
    const result = await normalize(
      env,
      filing(),
      [tx({ ticker: 'Bank of America Mystery', assetName: 'Mystery Co' })],
      { extractor: 'visionLlm', modelVersion: 'gemini-test' },
    );

    // 0.97 * 0.85 (unresolved) = 0.8245 < 0.85 threshold.
    expect(result.minConfidence).toBeLessThan(CONFIDENCE_THRESHOLD);
    expect(result.needsReview).toBe(true);
    expect(cap.insertedTx).toHaveLength(0);
    expect(cap.reviewRows).toHaveLength(1);
    expect(cap.enqueued).toHaveLength(0);
    expect(String(cap.reviewRows[0][1])).toContain('unresolved_ticker');
    expect(JSON.parse(String(cap.reviewRows[0][2]))).toMatchObject({
      extractor: 'visionLlm',
      modelVersion: 'gemini-test',
    });
    expect(cap.reviewSql[0]).toMatch(/INSERT OR IGNORE INTO review_queue/i);
    expect(cap.reviewSql[0]).not.toMatch(/agreement_legacy_replay_at\s*=/i);
  });

  it('publishes a well-formed symbol the master does not list yet (no false review)', async () => {
    const { env, cap } = makeEnv([]); // empty securities_master
    // "CTRA" (Coterra) is a valid current symbol absent from our master — the
    // deterministic fallback accepts it instead of penalizing it into review.
    const result = await normalize(env, filing(), [tx({ ticker: 'CTRA', assetName: 'Coterra Energy Inc.' })]);
    expect(result.needsReview).toBe(false);
    expect(result.minConfidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
    expect(result.transactions[0].ticker).toBe('CTRA');
    expect(cap.insertedTx).toHaveLength(1);
    expect(cap.reviewRows).toHaveLength(0);
  });

  it('resolves preferred/depositary ticker variants and stale tickers', async () => {
    const { env } = makeEnv([
      { ticker: 'T', name: 'AT&T Inc.', aliases: '[]' },
      { ticker: 'JPM', name: 'JPMorgan Chase & Co.', aliases: '[]' },
      { ticker: 'AVGO', name: 'Broadcom Inc.', aliases: '[]' },
      { ticker: 'BRK-B', name: 'Berkshire Hathaway', aliases: '[]' },
    ]);
    const pref = await normalize(env, filing(), [tx({ ticker: 'T$A', assetName: 'AT&T Inc. Pfd A' })]);
    expect(pref.transactions[0].ticker).toBe('T^A'); // preferred variant normalized
    expect(pref.needsReview).toBe(false);

    const yahooPref = await normalize(env, filing(), [tx({ ticker: 'JPM-PJ', assetName: 'JPMorgan Chase & Co. Depositary Shares, Series GG' })]);
    expect(yahooPref.transactions[0].ticker).toBe('JPM^J');

    const nameOnlyPref = await normalize(env, filing(), [
      tx({
        ticker: null,
        assetName: 'JPMorgan Chase & Co. Depositary Shares, Series GG',
      }),
    ]);
    expect(nameOnlyPref.transactions[0].ticker).toBe('JPM^J');
    expect(nameOnlyPref.needsReview).toBe(false);

    const issuerCollapsedPref = await normalize(env, filing(), [
      tx({
        ticker: 'T',
        assetName: 'AT&T Inc. Depositary Shares, each representing a 1/1,000th interest in a share of 5.000% Perpetual Preferred Stock, Series A',
      }),
    ]);
    expect(issuerCollapsedPref.transactions[0].ticker).toBe('T^A');

    const stale = await normalize(env, filing(), [tx({ ticker: 'BRCM', assetName: 'Broadcom' })]);
    expect(stale.transactions[0].ticker).toBe('BRCM'); // acquisition; point-in-time ticker preserved

    const klass = await normalize(env, filing(), [tx({ ticker: 'BRK.B', assetName: 'Berkshire' })]);
    expect(klass.transactions[0].ticker).toBe('BRK-B'); // punctuation variant
  });

  it('treats a dash/N-A placeholder ticker as ticker-less (no penalty, no review)', async () => {
    const { env, cap } = makeEnv([]);
    const result = await normalize(env, filing(), [tx({ ticker: '--', assetName: 'US Treasury Note' })]);
    expect(result.needsReview).toBe(false);
    expect(result.transactions[0].ticker).toBeNull();
    expect(cap.insertedTx).toHaveLength(1);
    expect(cap.reviewRows).toHaveLength(0);
  });

  it('snaps a plausible non-canonical amount to the nearest bracket without penalty', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    // 1200–14000 isn't an exact STOCK Act bracket but is a sane range -> snap, no penalty.
    const result = await normalize(env, filing(), [tx({ amountMin: 1200, amountMax: 14000 })]);
    expect(result.needsReview).toBe(false);
    expect(result.minConfidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
    expect(cap.insertedTx).toHaveLength(1);
  });

  it('routes to review when the amount is missing entirely', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    const result = await normalize(env, filing(), [tx({ amountMin: null, amountMax: null })]);
    expect(result.needsReview).toBe(true);
    expect(cap.reviewRows).toHaveLength(1);
    expect(String(cap.reviewRows[0][1])).toContain('no_amount');
  });

  it('does not penalize a legitimately ticker-less asset (no ticker supplied)', async () => {
    const { env, cap } = makeEnv([]); // empty securities_master
    const result = await normalize(env, filing(), [
      tx({ ticker: null, assetName: 'US Treasury Bond 2.5% 2030' }),
    ]);
    expect(result.needsReview).toBe(false);
    expect(result.minConfidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
    expect(cap.insertedTx).toHaveLength(1);
  });

  it('flags a tx_date after the filing filed_date', async () => {
    const { env } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    const result = await normalize(env, filing({ filedDate: '2024-06-01' }), [
      tx({ txDate: '2024-06-14' }),
    ]);
    // 0.97 * 0.7 (future date) = 0.679 < threshold => review.
    expect(result.needsReview).toBe(true);
    expect(result.minConfidence).toBeLessThan(CONFIDENCE_THRESHOLD);
  });

  it('routes empty extraction to review', async () => {
    const { env, cap } = makeEnv([]);
    const result = await normalize(env, filing(), []);
    expect(result.needsReview).toBe(true);
    expect(result.minConfidence).toBe(0);
    expect(cap.reviewRows).toHaveLength(1);
    expect(String(cap.reviewRows[0][1])).toContain('extract_empty_failure');
    expect(String(cap.reviewRows[0][1])).toContain('no_transactions_extracted');
    // Empty extract is hard failure — do not also tag low_confidence (no rows).
    expect(String(cap.reviewRows[0][1])).not.toContain('low_confidence');
  });

  it('routes header-contaminated asset names to review', async () => {
    const { env, cap } = makeEnv([{ ticker: 'GD', name: 'General Dynamics Corporation', aliases: '[]' }]);
    const result = await normalize(env, filing(), [
      tx({
        ticker: 'GD',
        assetName:
          'P T R Clerk of the House of Representatives Legislative Resource Center Name: Hon. Dwight Evans Status: Member State/District: PA03 T ID Owner Asset Transaction Type Date Notification Date Amount Cap. Gains >',
      }),
    ]);

    expect(result.needsReview).toBe(true);
    expect(result.minConfidence).toBeLessThan(CONFIDENCE_THRESHOLD);
    expect(cap.insertedTx).toHaveLength(0);
    expect(cap.reviewRows).toHaveLength(1);
    expect(String(cap.reviewRows[0][1])).toContain('bad_asset_name');
  });

  it('routes unreadable or missing asset names to review instead of publishing a guessed row', async () => {
    for (const assetName of ['', '(unknown)', 'unreadable']) {
      const { env, cap } = makeEnv([]);
      const result = await normalize(env, filing(), [tx({ ticker: null, assetName })]);
      expect(result.needsReview).toBe(true);
      expect(cap.insertedTx).toHaveLength(0);
      expect(String(cap.reviewRows[0][1])).toContain('bad_asset_name');
    }
  });

  it('routes rows with unreadable option or capital-gains checkboxes to review', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    const result = await normalize(env, filing(), [tx({
      extractionWarnings: ['unreadable_is_option', 'unreadable_cap_gains'],
    })]);
    expect(result.needsReview).toBe(true);
    expect(cap.insertedTx).toHaveLength(0);
    expect(String(cap.reviewRows[0][1])).toContain('unreadable_is_option');
    expect(String(cap.reviewRows[0][1])).toContain('unreadable_cap_gains');
  });
});
