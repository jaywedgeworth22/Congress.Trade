import { describe, expect, it } from 'vitest';
import type { Filing, ParsedTx } from '../../shared/types.ts';
import {
  OPENROUTER_FILES_HOLD_USD,
  TYPED_PTR_CHEAP_PATH_USD_CEILING,
  allowOpenRouterFiles,
  classifyHouseExtractRoute,
  evaluateExtractQuality,
  isHouseElectronicDocId,
  isHousePaperScanDocId,
  looksLikePlausibleTradeTable,
  looksLikeHeaderContaminatedAsset,
  looksLikePtrFormSampleAsset,
  looksLikeNothingToReport,
  isDeletedFilingStatus,
  shouldEnqueueAgreement,
  shouldSkipAgreementForReviewReason,
} from '../extractRouting.ts';

const filing = (over: Partial<Filing> = {}): Filing => ({
  docId: 'H-2025-20030634',
  chamber: 'house',
  filerId: 'F1',
  filingType: 'P',
  filedDate: '2026-06-24',
  sourceUrl: 'https://example.test/doc.pdf',
  rawObjectKey: 'raw/doc.pdf',
  ingestStatus: 'classified',
  docKind: 'scanned_pdf',
  extractor: null,
  modelVersion: null,
  confidence: null,
  firstSeenAt: '2026-06-24T00:00:00.000Z',
  sourceUpdatedAt: null,
  error: null,
  ...over,
});

const tx = (over: Partial<ParsedTx> = {}): ParsedTx => ({
  txDate: '2026-01-02',
  owner: 'self',
  assetName: 'Apple Inc',
  ticker: 'AAPL',
  assetType: 'ST',
  txType: 'B',
  amountMin: 1001,
  amountMax: 15000,
  isOption: false,
  capGainsOver200: false,
  rawText: '',
  confidence: 0.7,
  ...over,
});

describe('House DocID routing', () => {
  it('treats 20xxxxxx House IDs as electronic and 822/911 as paper scans', () => {
    expect(isHouseElectronicDocId('H-2025-20030634')).toBe(true);
    expect(isHouseElectronicDocId('H-2024-20025111')).toBe(true);
    expect(isHouseElectronicDocId('H-2025-8221302')).toBe(false);
    expect(isHouseElectronicDocId('H-2025-9115662')).toBe(false);
    expect(isHousePaperScanDocId('H-2025-8221302')).toBe(true);
    expect(isHousePaperScanDocId('H-2025-9115662')).toBe(true);
    expect(isHousePaperScanDocId('H-2025-20030634')).toBe(false);
  });
});

describe('classifyHouseExtractRoute / allowOpenRouterFiles', () => {
  it('forbids OpenRouter Files on electronic House PTRs even when doc_kind is scanned_pdf', () => {
    const electronic = filing({ docId: 'H-2025-20030634', docKind: 'scanned_pdf' });
    expect(classifyHouseExtractRoute(electronic)).toEqual({ kind: 'electronic', allowFiles: false });
    expect(allowOpenRouterFiles(electronic)).toBe(false);
  });

  it('forbids Files on text_pdf and typed doc_class', () => {
    expect(allowOpenRouterFiles(filing({ docId: 'H-2025-1', docKind: 'text_pdf' }))).toBe(false);
    expect(allowOpenRouterFiles(filing({
      docId: 'H-2025-8221302',
      docKind: 'scanned_pdf',
      ...{ docClass: 'typed' },
    } as Filing))).toBe(false);
  });

  it('allows Files only for real paper/scan DocIDs or scan classes', () => {
    expect(allowOpenRouterFiles(filing({ docId: 'H-2025-8221302', docKind: 'scanned_pdf' }))).toBe(true);
    expect(allowOpenRouterFiles(filing({ docId: 'H-2025-9115662', docKind: 'scanned_pdf' }))).toBe(true);
    expect(allowOpenRouterFiles(filing({
      docId: 'H-2024-8220192',
      docKind: 'scanned_pdf',
      ...{ docClass: 'hard_scan' },
    } as Filing))).toBe(true);
  });
});

describe('evaluateExtractQuality — hard-stops', () => {
  it('treats the printed PTR Example Mega Corp sample as form chrome', () => {
    expect(looksLikePtrFormSampleAsset('Example Mega Corp Common Stock')).toBe(true);
    expect(looksLikePtrFormSampleAsset('Exemplje Mega Corp.')).toBe(true);
    expect(looksLikeHeaderContaminatedAsset('Exemplje Mega Corp Common Stock')).toBe(true);
    expect(looksLikeNothingToReport('Nothing to report for July 2026')).toBe(true);
    expect(isDeletedFilingStatus('Deleted')).toBe(true);
    expect(isDeletedFilingStatus('New')).toBe(false);
  });

  it('hard-stops letterhead-as-asset (Clerk / B81 Cannon)', () => {
    const junk = [
      tx({
        assetName: 'Clerk of the House of Representatives',
        ticker: null,
        txDate: null,
        amountMin: 5_000_001,
        amountMax: 25_000_000,
        txType: 'S',
        confidence: 0.2,
      }),
      tx({
        assetName: 'B81 Cannon Building',
        ticker: null,
        txDate: null,
        amountMin: 5_000_001,
        amountMax: 25_000_000,
        txType: 'S',
        confidence: 0.18,
      }),
    ];
    expect(evaluateExtractQuality(junk)).toEqual({ ok: false, reason: 'letterhead_as_asset' });
  });

  it('hard-stops column-header-as-asset', () => {
    const junk = [
      tx({ assetName: 'Transaction Type', ticker: null, txDate: null }),
      tx({ assetName: 'Notification Date', ticker: null, txDate: null }),
      tx({ assetName: 'Amount', ticker: null, txDate: null }),
    ];
    expect(evaluateExtractQuality(junk)).toEqual({ ok: false, reason: 'column_header_as_asset' });
  });

  it('hard-stops row-limit garbage', () => {
    const rows = Array.from({ length: 201 }, (_, i) => tx({ ticker: `T${i}` }));
    expect(evaluateExtractQuality(rows)).toEqual({ ok: false, reason: 'extraction_row_limit' });
  });

  it('hard-stops majority missing tx date + malformed amount', () => {
    const junk = [
      tx({ txDate: null, amountMin: null, amountMax: null, assetName: '???', ticker: null }),
      tx({ txDate: null, amountMin: null, amountMax: null, assetName: '###', ticker: null }),
      tx({ txDate: null, amountMin: null, amountMax: null, assetName: '---', ticker: null }),
    ];
    expect(evaluateExtractQuality(junk)).toEqual({
      ok: false,
      reason: 'missing_tx_date_malformed_amount',
    });
  });

  it('lets a plausible trade table through', () => {
    expect(evaluateExtractQuality([tx()])).toEqual({ ok: true });
    expect(evaluateExtractQuality([])).toEqual({ ok: true });
  });
});

describe('agreement hard-stop', () => {
  it('does not enqueue the trio on an already-failed letterhead read', () => {
    const electronic = filing({ docId: 'H-2025-20030634', docKind: 'scanned_pdf' });
    expect(shouldEnqueueAgreement({
      filing: electronic,
      extractor: 'openRouterVision',
      quality: { ok: false, reason: 'letterhead_as_asset' },
      reviewReason: 'form_chrome_only,letterhead_as_asset',
    })).toBe(false);
    expect(shouldSkipAgreementForReviewReason('form_chrome_only,extract_empty_failure')).toBe(true);
    expect(shouldSkipAgreementForReviewReason('agreement_cascade_unresolved')).toBe(false);
  });

  it('does not enqueue agreement for electronic / typed House PTRs', () => {
    expect(shouldEnqueueAgreement({
      filing: filing({ docId: 'H-2025-20030634', docKind: 'text_pdf' }),
      extractor: 'openRouterText',
      quality: { ok: true },
    })).toBe(false);
  });

  it('allows agreement only for a plausible real-scan read', () => {
    expect(shouldEnqueueAgreement({
      filing: filing({ docId: 'H-2025-8221302', docKind: 'scanned_pdf' }),
      extractor: 'openRouterVision',
      quality: { ok: true },
    })).toBe(true);
  });
});

describe('looksLikePlausibleTradeTable', () => {
  it('requires trade tokens, not letterhead-only chrome', () => {
    expect(looksLikePlausibleTradeTable('Clerk of the House')).toBe(false);
    expect(looksLikePlausibleTradeTable(
      'SP  Apple Inc. (AAPL) [ST]\nP  06/14/2024  06/20/2024  $1,001 - $15,000',
    )).toBe(true);
  });
});

describe('typed PTR cost envelope', () => {
  it('keeps the cheap path far below the Files prepaid hold', () => {
    expect(TYPED_PTR_CHEAP_PATH_USD_CEILING).toBeLessThan(OPENROUTER_FILES_HOLD_USD);
    expect(TYPED_PTR_CHEAP_PATH_USD_CEILING / OPENROUTER_FILES_HOLD_USD).toBeLessThan(0.05);
  });
});
