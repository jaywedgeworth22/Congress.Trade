import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Filing } from '../../shared/types.ts';

// Mock unpdf so the page-count test doesn't need a real PDF fixture — it only
// needs to prove TextPdfExtractor reads pdf.numPages off the same document
// proxy already opened for text extraction (no extra parse, no page merge).
// parseHousePtrText tests below don't touch unpdf, so this mock is inert for them.
const unpdfMocks = vi.hoisted(() => ({
  getDocumentProxy: vi.fn(),
  extractText: vi.fn(),
}));
vi.mock('unpdf', () => ({
  getDocumentProxy: unpdfMocks.getDocumentProxy,
  extractText: unpdfMocks.extractText,
}));

import { parseHousePtrText, TextPdfExtractor } from '../textPdf.ts';

beforeEach(() => {
  vi.clearAllMocks();
});

function textPdfFiling(): Filing {
  return {
    docId: 'H-1',
    chamber: 'house',
    filerId: null,
    filingType: 'P',
    filedDate: null,
    sourceUrl: '',
    rawObjectKey: null,
    ingestStatus: 'classified',
    docKind: 'text_pdf',
    extractor: null,
    modelVersion: null,
    confidence: null,
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    sourceUpdatedAt: null,
    error: null,
  };
}

describe('parseHousePtrText', () => {
  it('ignores PTR preamble text and parses the first real holding block', () => {
    const rows = parseHousePtrText(`
      Periodic Transaction Report
      Clerk of the House of Representatives
      This header mentions 2026 but is not a trade.

      SP Apple Inc. (AAPL) [ST]
      S 03/16/2026 04/01/2026 $1,001 - $15,000
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner: 'spouse',
      assetName: 'Apple Inc.',
      ticker: 'AAPL',
      assetType: 'ST',
      txType: 'S',
      txDate: '2026-03-16',
      amountMin: 1001,
      amountMax: 15000,
      confidence: 1.0,
    });
  });

  it('removes NUL bytes before detecting owner and ticker lines', () => {
    const nul = String.fromCharCode(0);
    const rows = parseHousePtrText([
      `P${nul} T${nul} R${nul} Clerk header`,
      `S${nul}P Abbott Laboratories Common Stock (A${nul}B${nul}T) [S${nul}T]`,
      'P 04/16/2026 04/20/2026 $15,001 - $50,000',
    ].join('\n'));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner: 'spouse',
      assetName: 'Abbott Laboratories Common Stock',
      ticker: 'ABT',
      assetType: 'ST',
      txType: 'P',
      amountMin: 15001,
      amountMax: 50000,
      confidence: 1.0,
    });
    expect(rows[0].assetName).not.toContain('Clerk');
  });

  it('parses single-line House text without treating the PTR header as an asset', () => {
    const rows = parseHousePtrText(
      'P T R Clerk of the House of Representatives T ID Owner Asset Transaction Type Date Notification Date Amount Cap. Gains > $200? ' +
        'SP Amazon.com, Inc. - Common Stock (AMZN) [ST] S (partial) 03/16/2026 03/16/2026 $1,001 - $15,000 F S: New S O: Putnam Investments D: details with AAPL and QQQ shares ' +
        'DC Apple Inc. - Common Stock (AAPL) [ST] S (partial) 03/16/2026 03/16/2026 $1,001 - $15,000 F S: New',
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      owner: 'spouse',
      assetName: 'Amazon.com, Inc. - Common Stock',
      ticker: 'AMZN',
      assetType: 'ST',
      assetTypeName: 'Stocks (including ADRs)',
      txType: 'S',
      txDate: '2026-03-16',
      amountMin: 1001,
      amountMax: 15000,
      confidence: 1.0,
    });
    expect(rows[1]).toMatchObject({
      owner: 'dependent',
      assetName: 'Apple Inc. - Common Stock',
      ticker: 'AAPL',
      confidence: 1.0,
    });
    expect(rows[0].assetName).not.toContain('Clerk');
  });

  it('handles multi-line asset descriptions that wrap before [ST]', () => {
    const rows = parseHousePtrText(`
      Filer Information
      ID Owner Asset Transaction Type Date Notification Date Amount Cap. Gains > $200?
      SP Alphabet Inc. - Class C Capital
      Stock (GOOG) [ST]
      P 06/14/2026 06/20/2026 $1,001 - $15,000
      Filing Status: New
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner: 'spouse',
      assetName: 'Alphabet Inc. - Class C Capital Stock',
      ticker: 'GOOG',
      assetType: 'ST',
      txType: 'P',
      txDate: '2026-06-14',
      amountMin: 1001,
      amountMax: 15000,
      confidence: 1.0,
    });
  });

  it('preserves caret preferred-share tickers and normalizes slash tickers', () => {
    const rows = parseHousePtrText(`
      Periodic Transaction Report
      SP JPMorgan Chase & Co. Depositary Shares, Series GG (JPM^J) [ST]
      P 05/01/2026 05/02/2026 $1,001 - $15,000
      JT Berkshire Hathaway Inc. (BRK/B) [ST]
      S 05/03/2026 05/04/2026 $15,001 - $50,000
    `);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      owner: 'spouse',
      assetName: 'JPMorgan Chase & Co. Depositary Shares, Series GG',
      ticker: 'JPM^J',
      assetType: 'ST',
      txType: 'P',
      txDate: '2026-05-01',
      amountMin: 1001,
      amountMax: 15000,
      confidence: 1.0,
    });
    expect(rows[1]).toMatchObject({
      owner: 'joint',
      assetName: 'Berkshire Hathaway Inc.',
      ticker: 'BRK.B',
      assetType: 'ST',
      txType: 'S',
      txDate: '2026-05-03',
      amountMin: 15001,
      amountMax: 50000,
      confidence: 1.0,
    });
  });

  it('strips truncated single-line House table headers before inline parsing', () => {
    const rows = parseHousePtrText(
      'P T R Clerk of the House of Representatives - Legislative Resource Center - B81 Cannon Building - Washington, DC 20515 ' +
        'F I Name: Hon. Dwight Evans Status: Member State/District: PA03 T ID Owner Asset Transaction Type Date Notification Date Amount Cap. Gains > ' +
        'DC General Dynamics Corporation (GD) [ST] P 06/10/2026 06/23/2026 $1,001 - $15,000 F S: New',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner: 'dependent',
      assetName: 'General Dynamics Corporation',
      ticker: 'GD',
      assetType: 'ST',
      txType: 'P',
      txDate: '2026-06-10',
      amountMin: 1001,
      amountMax: 15000,
      confidence: 1.0,
    });
    expect(rows[0].assetName).not.toContain('Clerk');
    expect(rows[0].assetName).not.toContain('Transaction Type');
  });

  it('parses Pelosi-style option rows from House PTR text at 1.0 deterministic confidence', () => {
    const rows = parseHousePtrText(
      'Periodic Transaction Report ID Owner Asset Transaction Type Date Notification Date Amount Cap. Gains > $200? ' +
        'SP Intel Corporation - Common Stock (INTC) [OP] P 05/29/2026 05/29/2026 $1,000,001 - $5,000,000 F S: New D: Purchased 200 call options with a strike price of $50 and an expiration date of 3/19/27. ' +
        'SP Uber Technologies, Inc. Common Stock (UBER) [OP] P 05/29/2026 05/29/2026 $500,001 - $1,000,000 F S: New D: Purchased 200 call options with a strike price of $50 and an expiration date of 3/19/27.',
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      owner: 'spouse',
      assetName: 'Intel Corporation - Common Stock',
      ticker: 'INTC',
      assetType: 'OP',
      txType: 'P',
      txDate: '2026-05-29',
      amountMin: 1000001,
      amountMax: 5000000,
      isOption: true,
      confidence: 1.0,
    });
    expect(rows[1]).toMatchObject({
      assetName: 'Uber Technologies, Inc. Common Stock',
      ticker: 'UBER',
      amountMin: 500001,
      amountMax: 1000000,
      isOption: true,
      confidence: 1.0,
    });
  });

  it('anchors inline House rows at owner codes instead of the PTR header', () => {
    const rows = parseHousePtrText(
      'P T R Clerk of the House of Representatives T ID Owner Asset Transaction Type Date Notification Date Amount Cap. Gains > $200? ' +
        'SP Austin TX ARPT SYS TRAN [GS] P 05/05/2026 05/31/2026 $50,001 - $100,000 F S: New ' +
        'SP Bonita CA UNI SCH [GS] P 05/05/2026 05/31/2026 $50,001 - $100,000 F S: New ' +
        'SP East Bay CA Muni Util [GS] P 05/06/2026 05/31/2026 $250,001 - Filing ID #20034784 ID Owner Asset Transaction Type Date Notification Date Amount Cap. Gains > $200? $500,000 F S: New ' +
        'SP EEMA O&M Services Group [OL] P 05/15/2026 05/31/2026 $250,001 - $500,000 F S: New S O: Kent Street Group LLC L: Elverson, PA, US D: Water/Wastewater O&M ' +
        'SP Energy Northwest WA PWR UTIL [GS] P 05/20/2026 05/31/2026 $500,001 - $1,000,000 F S: New',
    );

    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({
      owner: 'spouse',
      assetName: 'Austin TX ARPT SYS TRAN',
      assetType: 'GS',
      txType: 'P',
      txDate: '2026-05-05',
      amountMin: 50001,
      amountMax: 100000,
      confidence: 1.0,
    });
    expect(rows[2]).toMatchObject({
      assetName: 'East Bay CA Muni Util',
      amountMin: 250001,
      amountMax: 500000,
      confidence: 1.0,
    });
    expect(rows[3]).toMatchObject({
      assetName: 'EEMA O&M Services Group',
      assetType: 'OL',
      confidence: 1.0,
    });
    expect(rows[0].assetName).not.toContain('Clerk');
    expect(rows[3].assetName).not.toContain('Kent Street Group');
  });

  it('parses digit-prefixed House asset-type codes in inline text', () => {
    const rows = parseHousePtrText(
      'Periodic Transaction Report ID Owner Asset Transaction Type Date Notification Date Amount Cap. Gains > $200? ' +
        'SELF 401K Retirement Plan [4K] P 05/01/2026 05/02/2026 $1,001 - $15,000 F S: New ' +
        'SP 529 College Savings Account [5C] P 05/03/2026 05/04/2026 $15,001 - $50,000 F S: New ' +
        'DC 529 Growth Portfolio [5F] S 05/05/2026 05/06/2026 $1,001 - $15,000 F S: New ' +
        'JT State Prepaid Tuition Plan [5P] P 05/07/2026 05/08/2026 $1,001 - $15,000 F S: New',
    );

    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.assetType)).toEqual(['4K', '5C', '5F', '5P']);
    expect(rows.map((row) => row.assetTypeName)).toEqual([
      '401K and Other Non-Federal Retirement Accounts',
      '529 College Savings Plan',
      '529 Portfolio',
      '529 Prepaid Tuition Plan',
    ]);
    expect(rows.every((row) => row.ticker === null)).toBe(true);
    expect(rows.every((row) => row.confidence === 1.0)).toBe(true);
  });

  it('parses digit-prefixed House asset-type codes in multiline blocks', () => {
    const rows = parseHousePtrText(`
      Filer Information
      SP 529 Prepaid Tuition [5P]
      P 05/07/2026 05/08/2026 $1,001 - $15,000
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner: 'spouse',
      assetName: '529 Prepaid Tuition',
      ticker: null,
      assetType: '5P',
      assetTypeName: '529 Prepaid Tuition Plan',
      txType: 'P',
      amountMin: 1001,
      amountMax: 15000,
      confidence: 1.0,
    });
  });

  it('preserves row-specific House PTR detail text and checked capital gains flags', () => {
    const rows = parseHousePtrText(`
      Filer Information
      Name: Hon. Josh Gottheimer
      ID Owner Asset Transaction Type Date Notification Date Amount Cap. Gains > $200?
      JT Abbott Laboratories Common Stock (ABT) [ST]
      S (partial) 05/27/2026 06/02/2026 $1,001 - $15,000
      Filing Status: New
      Subholding Of: Morgan Stanley - Select UMA Account # 1
      Location: US
      Description: Common Stock
      Cap. Gains > $200? checked
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner: 'joint',
      ticker: 'ABT',
      assetType: 'ST',
      assetTypeName: 'Stocks (including ADRs)',
      filingStatus: 'New',
      subholding: 'Morgan Stanley - Select UMA Account # 1',
      location: 'US',
      description: 'Common Stock',
      supplementalText:
        'New | Morgan Stanley - Select UMA Account # 1 | US | Common Stock',
      capGainsOver200: true,
      confidence: 1.0,
    });
    expect(rows[0].supplementalText).not.toContain('Hon. Josh');
  });

  it('runs deterministic textPdf extraction with zero LLM calls', async () => {
    unpdfMocks.getDocumentProxy.mockResolvedValue({ numPages: 1 });
    unpdfMocks.extractText.mockResolvedValue({
      text: `
        Periodic Transaction Report
        SP Apple Inc. (AAPL) [ST]
        P 06/14/2026 06/20/2026 $1,001 - $15,000
      `,
    });

    const extractor = new TextPdfExtractor();
    const result = await extractor.extract({
      filing: textPdfFiling(),
      bytes: new ArrayBuffer(16),
    });

    expect(result.confidence).toBe(1.0);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].confidence).toBe(1.0);
    expect(result.extractor).toBe('textPdf');
  });
});

describe('TextPdfExtractor page count', () => {
  it('surfaces pdf.numPages from the already-open document proxy (no extra parse)', async () => {
    unpdfMocks.getDocumentProxy.mockResolvedValue({ numPages: 3 });
    unpdfMocks.extractText.mockResolvedValue({
      text: 'SP Apple Inc. (AAPL) [ST]\nP 06/14/2024 06/20/2024 $1,001 - $15,000',
    });

    const extractor = new TextPdfExtractor();
    const result = (await extractor.extract({
      filing: textPdfFiling(),
      bytes: new ArrayBuffer(8),
    })) as { pageCount?: number | null };

    expect(result.pageCount).toBe(3);

    expect(unpdfMocks.getDocumentProxy).toHaveBeenCalledTimes(1);
  });

  it('leaves page count null when the parser does not cheaply expose numPages', async () => {
    unpdfMocks.getDocumentProxy.mockResolvedValue({});
    unpdfMocks.extractText.mockResolvedValue({ text: '' });

    const extractor = new TextPdfExtractor();
    const result = (await extractor.extract({
      filing: textPdfFiling(),
      bytes: new ArrayBuffer(8),
    })) as { pageCount?: number | null };

    expect(result.pageCount).toBeNull();
  });

  it('does not detach the caller-supplied ArrayBuffer (regression guard for Sentry CONGRESS-TRADE-2)', async () => {
    unpdfMocks.getDocumentProxy.mockImplementation(async (view: Uint8Array) => {
      structuredClone(view.buffer, { transfer: [view.buffer] });
      return { numPages: 1 };
    });
    unpdfMocks.extractText.mockResolvedValue({ text: '' });

    const bytes = new ArrayBuffer(8);
    const extractor = new TextPdfExtractor();
    await extractor.extract({ filing: textPdfFiling(), bytes });

    expect(bytes.byteLength).toBe(8);
    expect(() => new Uint8Array(bytes)).not.toThrow();
  });
});
