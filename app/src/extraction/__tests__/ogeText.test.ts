import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Filing } from '../../shared/types.ts';

// Mock unpdf the same way textPdf.test.ts does, so extract() tests don't need
// a real PDF fixture. parseOgeTransactionRows tests below bypass unpdf
// entirely (they operate on already-merged text), so this mock is inert there.
const unpdfMocks = vi.hoisted(() => ({
  getDocumentProxy: vi.fn(),
  extractText: vi.fn(),
}));
vi.mock('unpdf', () => ({
  getDocumentProxy: unpdfMocks.getDocumentProxy,
  extractText: unpdfMocks.extractText,
}));

import { OgeTextExtractor, parseOgeTransactionRows } from '../ogeText.ts';

beforeEach(() => {
  vi.clearAllMocks();
});

function executiveFiling(overrides: Partial<Filing> = {}): Filing {
  return {
    docId: 'E-1',
    chamber: 'executive',
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
    ...overrides,
  };
}

// Verbatim (whitespace-normalized) unpdf.extractText({mergePages:true}) output
// for a real, public OGE Form 278-T — Criswell, Deanne, filed 07/01/2022,
// https://extapps2.oge.gov/201/Presiden.nsf/PAS+Index/D35261AFD48DF3EE852588B1002EB958/$FILE/Deanne-Criswell-07.01.2022-278T.pdf
// — used as a golden fixture so the regex is proven against real production
// input, not just a hand-written approximation of the layout.
const CRISWELL_278T_TEXT = `
Criswell, Deanne - Page 1
Periodic Transaction Report | U.S. Office of Government Ethics; 5 C.F.R. part 2634 (Updated Nov. 2019)
Executive Branch Personnel
Public Financial Disclosure Report:
Periodic Transaction Report (OGE Form 278-T)
Filer's Information
Criswell, Deanne
Administrator, Department of Homeland Security
Electronic Signature - I certify that the statements I have made in this form are true, complete and correct to the best of my knowledge.
/s/ Criswell, Deanne [electronically signed on 07/01/2022 by Criswell, Deanne in Integrity.gov]
Transactions
Criswell, Deanne - Page 2
Endnotes
Summary of Contents
The 278-T discloses purchases, sales, or exchanges of securities in excess of $1,000 made on behalf of the filer, the filer's spouse, or dependent child.
Privacy Act Statement
Title I of the Ethics in Government Act of 1978, as amended (the Act), 5 U.S.C. app. section 101 et seq.
# DESCRIPTION TYPE DATE NOTIFICATION
RECEIVED OVER
30 DAYS AGO
AMOUNT
1 Amazon.com, Inc. (AMZN) Sale 06/10/2022 No $1,001 - $15,000
2 SPDR S&P 500 ETF Trust (SPY) Purchase 06/13/2022 No $1,001 - $15,000
3 Invesco QQQ Trust, Series 1 (QQQ) Purchase 06/13/2022 No $1,001 - $15,000
Criswell, Deanne - Page 3
Website and to any person, department or agency, any waiver of the restrictions.
`;

describe('parseOgeTransactionRows', () => {
  it('parses all three rows from a real 278-T text extraction, ignoring preamble/footer prose', () => {
    const rows = parseOgeTransactionRows(CRISWELL_278T_TEXT);

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      assetName: 'Amazon.com, Inc.',
      ticker: 'AMZN',
      txType: 'S',
      txDate: '2022-06-10',
      amountMin: 1001,
      amountMax: 15000,
      owner: null,
      isOption: false,
      confidence: 0.97,
    });
    expect(rows[1]).toMatchObject({
      assetName: 'SPDR S&P 500 ETF Trust',
      ticker: 'SPY',
      txType: 'B',
      txDate: '2022-06-13',
      amountMin: 1001,
      amountMax: 15000,
    });
    expect(rows[2]).toMatchObject({
      assetName: 'Invesco QQQ Trust, Series 1',
      ticker: 'QQQ',
      txType: 'B',
      txDate: '2022-06-13',
      amountMin: 1001,
      amountMax: 15000,
    });
  });

  it('handles an Exchange row and an open-ended top-tier amount', () => {
    const rows = parseOgeTransactionRows(
      '1 Some Bond Fund (XYZ) Exchange 01/02/2026 Yes $50,000,001 +',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      txType: 'E',
      ticker: 'XYZ',
      amountMin: 50000001,
      amountMax: null,
    });
  });

  it('leaves the asset name intact and ticker null when no parenthetical ticker is present', () => {
    const rows = parseOgeTransactionRows(
      '1 Some Municipal Bond 5% Due 2030 Purchase 03/04/2026 No $15,001 - $50,000',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ticker).toBeNull();
    expect(rows[0].assetName).toBe('Some Municipal Bond 5% Due 2030');
  });

  it('flags option-related rows via detectOption on the raw row text', () => {
    const rows = parseOgeTransactionRows(
      '1 Call option on Widget Corp (WGT) Purchase 01/01/2026 No $1,001 - $15,000',
    );
    expect(rows[0].isOption).toBe(true);
  });

  it('does not match ordinary numbered-list prose from an unrelated form section', () => {
    // Real text pulled from an OGE 278e "Positions Held" section: numbered,
    // but missing the Purchase/Sale/Exchange + date + Yes/No + amount suffix
    // that ROW_RE requires — must yield zero rows, not a guessed match.
    const rows = parseOgeTransactionRows(
      [
        '1 Moonbright LLC Homewood, Illinois Partnership Partner 12/2004 12/2024',
        '2 Irrevocable Child Trust #1 Washington, District of Columbia Trust Trustee 12/2004 Present',
      ].join('\n'),
    );
    expect(rows).toHaveLength(0);
  });

  it('does not match garbled OCR text from a scanned-then-OCR\'d 278-T', () => {
    // Real (anonymized-in-spirit) OCR artifact pattern seen on a scanned
    // executive filing: words are corrupted enough that no row completes the
    // required suffix. Zero rows is the CORRECT, safe outcome (blocked, not
    // a wrong parse) — this filing needs vision, not a regex guess.
    const rows = parseOgeTransactionRows(
      '1 SPOR SERIES TRUST HIGH YlELD BONO ETF ourchoeo 1/20/2028 no $500,001 -$1.000.000',
    );
    expect(rows).toHaveLength(0);
  });

  it('returns an empty array for text with no matching rows', () => {
    expect(parseOgeTransactionRows('nothing to see here')).toEqual([]);
  });
});

describe('OgeTextExtractor', () => {
  it('claims executive-chamber text_pdf filings only', () => {
    const extractor = new OgeTextExtractor();
    expect(extractor.canHandle(executiveFiling())).toBe(true);
    expect(extractor.canHandle(executiveFiling({ chamber: 'house' }))).toBe(false);
    expect(extractor.canHandle(executiveFiling({ chamber: 'senate' }))).toBe(false);
    expect(extractor.canHandle(executiveFiling({ docKind: 'scanned_pdf' }))).toBe(false);
  });

  it('extracts rows from the merged PDF text and reports document confidence as the row mean', async () => {
    unpdfMocks.getDocumentProxy.mockResolvedValue({ numPages: 3 });
    unpdfMocks.extractText.mockResolvedValue({ text: CRISWELL_278T_TEXT });

    const extractor = new OgeTextExtractor();
    const result = (await extractor.extract({
      filing: executiveFiling(),
      bytes: new ArrayBuffer(8),
    })) as { transactions: unknown[]; confidence: number; extractor: string; pageCount?: number | null };

    expect(result.transactions).toHaveLength(3);
    expect(result.extractor).toBe('ogeText');
    expect(result.confidence).toBeCloseTo(0.97, 5);
    expect(result.pageCount).toBe(3);
  });

  it('throws when no bytes are provided', async () => {
    const extractor = new OgeTextExtractor();
    await expect(extractor.extract({ filing: executiveFiling() })).rejects.toThrow(
      'ogeText: no bytes provided',
    );
  });

  it('does not detach the caller-supplied ArrayBuffer (same regression guard as textPdf.ts)', async () => {
    unpdfMocks.getDocumentProxy.mockImplementation(async (view: Uint8Array) => {
      structuredClone(view.buffer, { transfer: [view.buffer] });
      return { numPages: 1 };
    });
    unpdfMocks.extractText.mockResolvedValue({ text: '' });

    const bytes = new ArrayBuffer(8);
    const extractor = new OgeTextExtractor();
    await extractor.extract({ filing: executiveFiling(), bytes });

    expect(bytes.byteLength).toBe(8);
    expect(() => new Uint8Array(bytes)).not.toThrow();
  });
});
