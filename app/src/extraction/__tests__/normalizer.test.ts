import { describe, it, expect, beforeEach } from 'vitest';
import {
  normalize,
  CONFIDENCE_THRESHOLD,
  DETERMINISTIC_CONFIDENCE_THRESHOLD,
  isDeterministicExtractor,
  confidenceThresholdFor,
  persistTransactions,
  transactionRowKey,
  clearResolverCache,
  clearNameIndexCache,
  scoreFields,
  type NameIndex,
  looksLikeHeaderContaminatedAsset,
  isMostlyGarbageOcrExtraction,
} from '../normalizer.ts';
import type { Env, Filing, ParsedTx } from '../../shared/types.ts';

beforeEach(() => {
  clearResolverCache();
  clearNameIndexCache();
});

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
  masterReads: number;
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
    masterReads: 0,
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
          cap.masterReads += 1;
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
  txType: 'B',
  amountMin: 1001,
  amountMax: 15000,
  isOption: false,
  capGainsOver200: false,
  rawText: 'AAPL Apple Inc P $1,001 - $15,000',
  confidence: 0.97,
  ...over,
});

// Letters-only per-row tag (no digits) so varying rawText across synthetic
// fixture rows can't accidentally be mis-sniffed as a dollar amount by
// parseAmountRange's digit-stripping parser (which would trip a spurious
// invalid_amount flag unrelated to whatever the test is actually exercising).
function letterVariant(index: number): string {
  return String.fromCharCode(97 + (index % 26)) + String.fromCharCode(97 + Math.floor(index / 26));
}

describe('normalize', () => {
  it('publishes a clean oversized extraction instead of capping at 200', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    const parsed = Array.from(
      { length: 201 },
      (_, index) => tx({
        rawText: `AAPL Apple Inc P $1,001 - $15,000 (variant ${letterVariant(index)})`,
        confidence: 0.97,
      }),
    );
    const result = await normalize(
      env,
      filing({ docKind: 'scanned_pdf', extractor: 'visionLlm' }),
      parsed,
      { extractor: 'visionLlm' },
    );
    expect(result.needsReview).toBe(false);
    expect(result.published).toBe(true);
    expect(result.transactions.length).toBe(201);
    expect(cap.insertedTx).toHaveLength(201);
    await expect(persistTransactions(env, result.transactions)).resolves.toBeTruthy();
  });

  it('still holds a low-confidence uniform OCR flood above 200 rows', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    const parsed = Array.from(
      { length: 201 },
      (_, index) => tx({
        rawText: `AAPL Apple Inc P $1,001 - $15,000 (variant ${letterVariant(index)})`,
        confidence: 0.189,
      }),
    );
    const result = await normalize(
      env,
      filing({ docKind: 'scanned_pdf', extractor: 'visionLlm' }),
      parsed,
      { extractor: 'visionLlm' },
    );
    expect(result.needsReview).toBe(true);
    expect(cap.insertedTx).toHaveLength(0);
    expect(String(cap.reviewRows[0][1])).toBe('extraction_row_limit_exceeded_likely_garbage:0.00');
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
    // Use a vision extractor so soft unresolved_ticker still lands in review
    // (deterministic text/html now autopublishes at a lower confidence gate).
    const f = filing({ docKind: 'scanned_pdf', extractor: 'visionLlm' });
    const parsed = [tx({ ticker: 'Bank of America Mystery', assetName: 'Mystery Co' })];
    await expect(normalize(env, f, parsed, { extractor: 'visionLlm' })).rejects.toThrow('audit insert failed');
    expect(cap.reviewRows).toHaveLength(0);
    expect(cap.filingUpdates).toHaveLength(0);

    allowAudit();
    await normalize(env, f, parsed, { extractor: 'visionLlm' });
    await normalize(env, f, parsed, { extractor: 'visionLlm' });
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
        expect.stringMatching(/deprecated_reason = 'upgraded_by_primary'/),
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
    expect(stale.transactions[0].ticker).toBe('AVGO'); // acquisition; point-in-time ticker preserved

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
    const result = await normalize(env, filing(), [
      tx({ amountMin: 1200, amountMax: 14000, rawText: 'AAPL Apple Inc P $1,200 - $14,000' }),
    ]);
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

  it('local Grok vision publishes siblings when some PTR rows omit the amount checkbox', async () => {
    const { env, cap } = makeEnv([]);
    const result = await normalize(
      env,
      filing({ chamber: 'house', docKind: 'scanned_pdf', extractor: 'local_grok_cli_v1' }),
      [
        tx({
          ticker: null,
          assetName: 'Vng Growth Index',
          txType: 'S',
          amountMin: 1001,
          amountMax: 15000,
          confidence: 0.97,
          rawText: 'Vng Growth Index',
        }),
        tx({
          ticker: null,
          assetName: 'Bridge Builder Sm/Mid Value',
          txType: 'S',
          amountMin: null,
          amountMax: null,
          confidence: 0.97,
          rawText: 'Bridge Builder Sm/Mid Value',
        }),
      ],
      { extractor: 'local_grok_cli_v1', source: 'local_mac' },
    );
    expect(result.needsReview).toBe(false);
    expect(result.published).toBe(true);
    expect(result.transactions).toHaveLength(2);
    expect(cap.insertedTx).toHaveLength(2);
    expect(cap.reviewRows).toHaveLength(0);
  });

  it('local Grok vision does not auto-publish when every row omitted the amount', async () => {
    const { env, cap } = makeEnv([]);
    const result = await normalize(
      env,
      filing({ chamber: 'house', docKind: 'scanned_pdf', extractor: 'local_grok_cli_v1' }),
      [
        tx({
          ticker: null,
          assetName: 'Vng Growth Index',
          txType: 'S',
          amountMin: null,
          amountMax: null,
          confidence: 0.97,
          rawText: 'Vng Growth Index',
        }),
        tx({
          ticker: null,
          assetName: 'Bridge Builder Sm/Mid Value',
          txType: 'S',
          amountMin: null,
          amountMax: null,
          confidence: 0.97,
          rawText: 'Bridge Builder Sm/Mid Value',
        }),
      ],
      { extractor: 'local_grok_cli_v1', source: 'local_mac' },
    );
    expect(result.needsReview).toBe(true);
    expect(result.published).toBe(false);
    expect(cap.insertedTx).toHaveLength(0);
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

  it('drops pure form-chrome rows as extract_empty (not fake review trades)', async () => {
    const { env, cap } = makeEnv([{ ticker: 'GD', name: 'General Dynamics Corporation', aliases: '[]' }]);
    const result = await normalize(env, filing(), [
      tx({
        ticker: 'GD',
        assetName:
          'P T R Clerk of the House of Representatives Legislative Resource Center Name: Hon. Dwight Evans Status: Member State/District: PA03 T ID Owner Asset Transaction Type Date Notification Date Amount Cap. Gains >',
      }),
    ]);

    expect(result.needsReview).toBe(true);
    expect(result.transactions).toHaveLength(0);
    expect(result.minConfidence).toBe(0);
    expect(cap.insertedTx).toHaveLength(0);
    expect(cap.reviewRows).toHaveLength(1);
    const reason = String(cap.reviewRows[0][1]);
    expect(reason).toContain('form_chrome_only');
    expect(reason).toContain('extract_empty_failure');
    // Must not park as a soft "bad_asset_name" fake trade for humans/cascade.
    expect(reason).not.toContain('bad_asset_name');
  });

  it('drops form-chrome rows and still publishes remaining real trades', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '["Apple"]' }]);
    const result = await normalize(env, filing(), [
      tx({
        assetName:
          'Clerk of the House of Representatives + Legislative Resource Center * B81 Cannon Building',
        ticker: null,
        txDate: null,
        confidence: 0.25,
      }),
      tx({ ticker: 'AAPL', assetName: 'Apple Inc.', confidence: 0.97 }),
    ]);

    expect(result.needsReview).toBe(false);
    expect(result.published).toBe(true);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].ticker).toBe('AAPL');
    expect(cap.insertedTx).toHaveLength(1);
    expect(cap.reviewRows).toHaveLength(0);
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

  it('reuses the in-process securities_master resolver across calls until cleared', async () => {
    const first = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    await normalize(first.env, filing({ docId: 'doc-warm' }), [tx({ ticker: 'AAPL' })]);
    expect(first.cap.masterReads).toBe(1);

    const second = makeEnv([{ ticker: 'MSFT', name: 'Microsoft', aliases: '[]' }]);
    await normalize(second.env, filing({ docId: 'doc-cached' }), [tx({ ticker: 'AAPL' })]);
    expect(second.cap.masterReads).toBe(0);

    clearResolverCache();
    await normalize(second.env, filing({ docId: 'doc-cold' }), [tx({ ticker: 'AAPL' })]);
    expect(second.cap.masterReads).toBe(1);
  });

  it('differentiates duplicate trades across split trust accounts (e.g. Harshbarger CHEGG trades) using owner, subholding, description, and rowIndex', () => {
    const tradeBase = {
      txDate: '2024-05-15',
      ticker: 'CHGG',
      assetName: 'Chegg, Inc.',
      amountMin: 1001,
      amountMax: 15000,
      txType: 'B' as const,
    };

    const trust1 = tx({ ...tradeBase, owner: 'dependent' as const, subholding: 'Harshbarger Family Trust #1', description: 'Trust 1 Purchase' });
    const trust2 = tx({ ...tradeBase, owner: 'dependent' as const, subholding: 'Harshbarger Family Trust #2', description: 'Trust 2 Purchase' });

    // Different subholding / description -> different hash
    const key1 = transactionRowKey('primary', 0, trust1);
    const key2 = transactionRowKey('primary', 1, trust2);
    expect(key1).not.toBe(key2);

    // Same details, different rowIndex -> different row key string
    const key1Row0 = transactionRowKey('primary', 0, trust1);
    const key1Row1 = transactionRowKey('primary', 1, trust1);
    expect(key1Row0).not.toBe(key1Row1);
    expect(key1Row0).toContain('v1:primary:0:');
    expect(key1Row1).toContain('v1:primary:1:');
  });

  it('routes contradictory amount ranges or future trade dates to review queue', async () => {
    // 1. Contradictory amount range: rawText says $1,001 - $15,000 but amountMin/Max set to $50,001 - $100,000
    const { env: env1, cap: cap1 } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    const result1 = await normalize(env1, filing(), [
      tx({
        rawText: '$1,001 - $15,000',
        amountMin: 50001,
        amountMax: 100000,
      }),
    ]);
    expect(result1.needsReview).toBe(true);
    expect(String(cap1.reviewRows[0][1])).toContain('invalid_amount');

    // 2. Future trade date (txDate > filedDate)
    const { env: env2, cap: cap2 } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    const result2 = await normalize(env2, filing({ filedDate: '2024-05-01' }), [
      tx({
        txDate: '2024-05-15',
      }),
    ]);
    expect(result2.needsReview).toBe(true);
    expect(String(cap2.reviewRows[0][1])).toContain('future_tx_date');
  });

  it('publishes an oversized extraction of distinct, varied-confidence rows', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    const parsed = Array.from(
      { length: 201 },
      (_, index) => tx({
        rawText: `AAPL Apple Inc P $1,001 - $15,000 (variant ${letterVariant(index)})`,
        confidence: 0.97 - (index % 7) * 0.03,
      }),
    );
    const result = await normalize(env, filing(), parsed);
    expect(result.needsReview).toBe(false);
    expect(result.published).toBe(true);
    expect(cap.insertedTx).toHaveLength(201);
  });

  it('classifies an oversized extraction of duplicated rows as likely_garbage', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    const parsed = Array.from({ length: 201 }, () => tx());
    const result = await normalize(env, filing(), parsed);
    expect(result.needsReview).toBe(true);
    expect(cap.insertedTx).toHaveLength(0);
    expect(String(cap.reviewRows[0][1])).toBe('extraction_row_limit_exceeded_likely_garbage:1.00');
  });

  it('does not false-flag invalid_amount when freeform rawText embeds the same canonical bracket', async () => {
    const { env, cap } = makeEnv([{ ticker: 'INTC', name: 'Intel Corporation', aliases: '[]' }]);
    const result = await normalize(
      env,
      filing({ docId: 'H-text', chamber: 'house', docKind: 'text_pdf', extractor: 'textPdf' }),
      [
        tx({
          ticker: 'INTC',
          assetName: 'Intel Corporation',
          amountMin: 1001,
          amountMax: 15000,
          confidence: 0.6,
          rawText:
            'SP Intel Corporation - Common Stock (INTC) [ST] S 11/08/2024 12/11/2024 $1,001 - $15,000 F S: New',
        }),
      ],
      { extractor: 'textPdf' },
    );
    expect(result.needsReview).toBe(false);
    expect(result.published).toBe(true);
    expect(result.minConfidence).toBeGreaterThanOrEqual(DETERMINISTIC_CONFIDENCE_THRESHOLD);
    expect(cap.insertedTx).toHaveLength(1);
    expect(cap.reviewRows).toHaveLength(0);
  });

  it('does not false-flag invalid_amount when rawText also has an address number', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AGIO', name: 'Agios Pharmaceuticals, Inc.', aliases: '[]' }]);
    const result = await normalize(
      env,
      filing({ docId: 'H-agio', chamber: 'house', docKind: 'text_pdf', extractor: 'textPdf' }),
      [
        tx({
          ticker: 'AGIO',
          assetName: 'Agios Pharmaceuticals, Inc.',
          amountMin: 1001,
          amountMax: 15000,
          confidence: 0.6,
          rawText:
            'Agios Pharmaceuticals, Inc. - Common Stock (AGIO) [ST] P 01/29/2025 02/06/2025 $1,001 - $15,000 F S: New S O: 150 Main St',
        }),
      ],
      { extractor: 'textPdf' },
    );
    expect(result.needsReview).toBe(false);
    expect(result.published).toBe(true);
    expect(cap.insertedTx).toHaveLength(1);
  });

  it('demotes a House GS type code stuffed into ticker on a Treasury bill', async () => {
    const { env, cap } = makeEnv([]);
    const result = await normalize(
      env,
      filing({ docId: 'H-2025-20026666', chamber: 'house', docKind: 'text_pdf', extractor: 'openRouterText' }),
      [
        tx({
          ticker: 'GS',
          assetName: 'Treasury Bill (3-Month, Matures 5/1/2025)',
          assetType: 'GS',
          amountMin: 15001,
          amountMax: 50000,
          confidence: 0.6,
          rawText: 'Treasury Bill (3-Month, Matures 5/1/2025) [GS] P $15,001 - $50,000',
        }),
      ],
      { extractor: 'openRouterText' },
    );
    expect(result.published).toBe(true);
    expect(result.needsReview).toBe(false);
    expect(cap.insertedTx).toHaveLength(1);
  });

  it('treats cheap openRouterText on typed PTRs as deterministic', () => {
    expect(isDeterministicExtractor('openRouterText', 'text_pdf')).toBe(true);
    expect(isDeterministicExtractor('openRouterText', 'senate_html')).toBe(true);
    expect(isDeterministicExtractor('openRouterText', 'scanned_pdf')).toBe(false);
    expect(isDeterministicExtractor('openRouterVision', 'text_pdf')).toBe(false);
    expect(confidenceThresholdFor('openRouterText', 'text_pdf')).toBe(DETERMINISTIC_CONFIDENCE_THRESHOLD);
  });

  it('autopublishes cheap openRouterText rows at 0.6 on electronic House PTRs', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    const result = await normalize(
      env,
      filing({ docId: 'H-2026-20034898', chamber: 'house', docKind: 'text_pdf', extractor: 'openRouterText' }),
      [tx({ confidence: 0.6, rawText: 'AAPL Apple Inc B $1,001 - $15,000' })],
      { extractor: 'openRouterText' },
    );
    expect(result.minConfidence).toBeLessThan(CONFIDENCE_THRESHOLD);
    expect(result.minConfidence).toBeGreaterThanOrEqual(DETERMINISTIC_CONFIDENCE_THRESHOLD);
    expect(result.needsReview).toBe(false);
    expect(result.published).toBe(true);
    expect(cap.insertedTx).toHaveLength(1);
  });

  it('autopublishes deterministic textPdf rows below vision conf threshold when clean', async () => {
    const { env, cap } = makeEnv([{ ticker: 'AAPL', name: 'Apple Inc.', aliases: '[]' }]);
    const result = await normalize(
      env,
      filing({ docId: 'H-det', chamber: 'house', docKind: 'text_pdf', extractor: 'textPdf' }),
      [tx({ confidence: 0.6, rawText: 'AAPL Apple Inc B $1,001 - $15,000' })],
      { extractor: 'textPdf' },
    );
    expect(result.minConfidence).toBeLessThan(CONFIDENCE_THRESHOLD);
    expect(result.minConfidence).toBeGreaterThanOrEqual(DETERMINISTIC_CONFIDENCE_THRESHOLD);
    expect(result.needsReview).toBe(false);
    expect(result.published).toBe(true);
    expect(cap.insertedTx).toHaveLength(1);
  });

  it('parks mostly-garbage OCR as ocr_unusable extract_empty (not 200 fake review rows)', async () => {
    const { env, cap } = makeEnv([]);
    const garbage = Array.from({ length: 40 }, (_, i) =>
      tx({
        assetName: i % 2 === 0
          ? 'Member of the U.S. House of Representatives Officer or Employee'
          : `unreadable asset p1 y${300 + i}`,
        ticker: null,
        txDate: null,
        amountMin: 250001,
        amountMax: 500000,
        confidence: 0.19,
        rawText: 'form chrome',
      }),
    );
    const result = await normalize(
      env,
      filing({ docId: 'H-scan', chamber: 'house', docKind: 'scanned_pdf', extractor: 'server_cpu_v1' }),
      garbage,
      { extractor: 'server_cpu_v1' },
    );
    expect(result.needsReview).toBe(true);
    expect(result.transactions).toHaveLength(0);
    expect(cap.insertedTx).toHaveLength(0);
    expect(cap.reviewRows).toHaveLength(1);
    const reason = String(cap.reviewRows[0][1]);
    expect(reason).toContain('ocr_unusable');
    expect(reason).toContain('extract_empty_failure');
    const payload = JSON.parse(String(cap.reviewRows[0][2])) as { transactionCount: number };
    expect(payload.transactionCount).toBe(0);
  });

  it('keeps a dated real row in the review payload when the rest is OCR chrome', async () => {
    const { env, cap } = makeEnv([]);
    const garbage = Array.from({ length: 24 }, (_, i) =>
      tx({
        assetName: `unreadable asset p1 y${300 + i}`,
        ticker: null,
        txDate: null,
        amountMin: 250001,
        amountMax: 500000,
        confidence: 0.19,
        rawText: 'form chrome',
      }),
    );
    garbage.push(tx({
      assetName: 'Apple Inc.',
      ticker: 'AAPL',
      txDate: '2025-02-19',
      amountMin: 1001,
      amountMax: 15000,
      confidence: 0.95,
      rawText: 'Apple Inc. (AAPL) [ST] P 02/19/2025 02/19/2025 $1,001 - $15,000',
    }));
    const result = await normalize(
      env,
      filing({ docId: 'H-mix', chamber: 'house', docKind: 'scanned_pdf', extractor: 'server_cpu_v1' }),
      garbage,
      { extractor: 'server_cpu_v1' },
    );
    expect(result.needsReview).toBe(true);
    expect(result.published).toBe(false);
    expect(cap.insertedTx).toHaveLength(0);
    const payload = JSON.parse(String(cap.reviewRows[0][2])) as {
      transactionCount: number;
      transactions: Array<{ ticker?: string | null }>;
    };
    expect(payload.transactionCount).toBeGreaterThanOrEqual(1);
    expect(payload.transactions.some((row) => row.ticker === 'AAPL')).toBe(true);
  });

  it('classifies expanded form-chrome and garbage-ratio helpers', () => {
    expect(looksLikeHeaderContaminatedAsset('Member of the U.S. House of Representatives')).toBe(true);
    expect(looksLikeHeaderContaminatedAsset('unreadable asset p1 y331')).toBe(true);
    expect(looksLikeHeaderContaminatedAsset('Apple Inc.')).toBe(false);
    expect(looksLikeHeaderContaminatedAsset('The following information serves to identify the previously and erroneously filed periodic')).toBe(true);
    expect(isMostlyGarbageOcrExtraction(100, 5, 5)).toBe(true);
    expect(isMostlyGarbageOcrExtraction(10, 9, 0)).toBe(false);
  });
});


describe('scoreFields ticker/asset-name consistency (informational, unpenalized)', () => {
  const passthroughResolve = (ticker: string | null) => ticker;
  const baseFields = {
    ticker: 'AAPL',
    assetName: 'Apple Inc.',
    amountMin: 1001,
    amountMax: 15000,
    txType: 'B',
    txDate: '2024-06-14',
    rawText: 'AAPL Apple Inc P $1,001 - $15,000',
  };

  it('flags ticker_asset_mismatch when the ticker resolves to a known but different company', () => {
    const nameIndex: NameIndex = new Map([['AAPL', 'apple']]);
    const scored = scoreFields(
      0.97,
      { ...baseFields, ticker: 'AAPL', assetName: 'Tesla Inc' },
      '2024-07-01',
      passthroughResolve,
      nameIndex,
    );
    expect(scored.flags).toContain('ticker_asset_mismatch');
    // Informational only: no confidence penalty, unlike every other flag here.
    expect(scored.confidence).toBe(0.97);
  });

  it('does not flag a match (allowing partial/legacy company-name forms)', () => {
    const nameIndex: NameIndex = new Map([['AAPL', 'apple']]);
    const scored = scoreFields(0.97, baseFields, '2024-07-01', passthroughResolve, nameIndex);
    expect(scored.flags).not.toContain('ticker_asset_mismatch');
  });

  it('does not flag a mismatch when the ticker has no known name (e.g. crypto/bond tickers not in either table)', () => {
    const nameIndex: NameIndex = new Map(); // no BTC entry -- absence of data is not evidence of mismatch
    const scored = scoreFields(
      0.97,
      { ...baseFields, ticker: 'BTC', assetName: 'BTC' },
      '2024-07-01',
      passthroughResolve,
      nameIndex,
    );
    expect(scored.flags).not.toContain('ticker_asset_mismatch');
  });

  it('does not flag a mismatch when the asset name is just the ticker symbol', () => {
    const nameIndex: NameIndex = new Map([['ACN', 'accenture']]);
    const scored = scoreFields(
      0.97,
      { ...baseFields, ticker: 'ACN', assetName: 'ACN' },
      '2024-07-01',
      passthroughResolve,
      nameIndex,
    );
    expect(scored.flags).not.toContain('ticker_asset_mismatch');
  });

  it('does not flag a mismatch when no nameIndex is supplied (backward compatible with existing callers)', () => {
    const scored = scoreFields(
      0.97,
      { ...baseFields, ticker: 'AAPL', assetName: 'Tesla Inc' },
      '2024-07-01',
      passthroughResolve,
    );
    expect(scored.flags).not.toContain('ticker_asset_mismatch');
  });

  it('does not flag invalid_amount when rawText is a fund name with a digit', () => {
    const scored = scoreFields(
      0.97,
      {
        ticker: null,
        assetName: 'BDT Capital Partners Fund 4 LP',
        amountMin: 250001,
        amountMax: 500000,
        txType: 'S',
        txDate: '2025-12-19',
        rawText: 'BDT Capital Partners Fund 4 LP',
      },
      '2026-01-15',
      () => null,
    );
    expect(scored.flags).not.toContain('invalid_amount');
    expect(scored.confidence).toBe(0.97);
  });
});
