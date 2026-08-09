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

// Verbatim response captured from the deployed production /debug-raw-text
// diagnostic for this same filing (E-2022-deanne-criswell-07-01-2022-278t) --
// unpdf.extractText({mergePages:true}) under the Cloudflare Workers
// runtime, with ZERO newline characters anywhere in the whole multi-page
// document (a real production behavior difference from Node.js, which DOES
// insert per-row newlines for the same PDF -- see the module comment on
// ROW_RE/TABLE_HEADER_RE). This is the regression fixture for the actual
// incident: the original line-split implementation found 3/3 rows against
// local Node output and 0/3 rows here, in production, against the exact
// same source PDF.
const CRISWELL_278T_TEXT_PRODUCTION_FLATTENED = `Criswell, Deanne - Page 1 Periodic Transaction Report | U.S. Office of Government Ethics; 5 C.F.R. part 2634 (Updated Nov. 2019) Executive Branch Personnel Public Financial Disclosure Report: Periodic Transaction Report (OGE Form 278-T) Filer's Information Criswell, Deanne Administrator, Department of Homeland Security Electronic Signature - I certify that the statements I have made in this form are true, complete and correct to the best of my knowledge. /s/ Criswell, Deanne [electronically signed on 07/01/2022 by Criswell, Deanne in Integrity.gov] Agency Ethics Official's Opinion - On the basis of information contained in this report, I conclude that the filer is in compliance with applicable laws and regulations (subject to any comments below). /s/ O'Connor, Michael, Certifying Official [electronically signed on 08/05/2022 by O'Connor, Michael in Integrity.gov] Other review conducted by /s/ Phillips, Christina, Ethics Official [electronically signed on 08/02/2022 by Phillips, Christina in Integrity.gov] U.S. Office of Government Ethics Certification /s/ Granahan, Megan, Certifying Official [electronically signed on 09/01/2022 by Granahan, Megan in Integrity.gov] Transactions Criswell, Deanne - Page 2 Endnotes Summary of Contents The 278-T discloses purchases, sales, or exchanges of securities in excess of $1,000 made on behalf of the filer, the filer's spouse, or dependent child. Transactions are required to be disclosed within 30 days of receiving notification of a transaction but not later than 45 days after the transaction. Filers need not disclose (1) mutual funds and other excepted investment funds; (2) certificates of deposit, savings or checking accounts, and money market accounts; (3) U.S. Treasury bills, notes, and bonds; (4) Thrift Savings Plan accounts; (5) real property; and (6) transactions that are solely by and between the filer, the filer's spouse, and the filer's dependent children. Privacy Act Statement Title I of the Ethics in Government Act of 1978, as amended (the Act), 5 U.S.C. app. § 101 et seq., as amended by the Stop Trading on Congressional Knowledge Act of 2012 (Pub. L. 112-105) (STOCK Act), and 5 C.F.R. Part 2634 of the U. S. Office of Government Ethics regulations require the reporting of this information. Failure to provide the requested information may result in separation, disciplinary action, or civil action. The primary use of the information on this report is for review by Government officials to determine compliance with applicable Federal laws and regulations. This report may also be disclosed upon request to any requesting person in accordance with sections 105 and 402(b)(1) of the Act or as otherwise authorized by law. You may inspect applications for public access of your own form upon request. Additional disclosures of the information on this report may be made: (1) to any requesting person, subject to the limitation contained in section 208(d)(1) of title 18, any determination granting an exemption pursuant to sections 208(b)(1) and 208(b)(3) of title 18; (2) to a Federal, State, or local law enforcement agency if the disclosing agency becomes aware of violations or potential violations of law or regulation; (3) to a source when necessary to obtain information relevant to a conflict of interest investigation or determination; (4) to the National Archives and Records Administration or the General Services Administration in records management inspections; (5) to the Office of Management and Budget during legislative coordination on private relief legislation; (6) when the disclosing agency determines that the records are arguably relevant to a proceeding before a court, grand jury, or administrative or adjudicative body, or in a proceeding before an administrative or adjudicative body when the adjudicator determines the records to be relevant to the proceeding; (7) to reviewing officials in a new office, department or agency when an employee transfers or is detailed from one covered position to another, a public financial disclosure report and any accompanying documents, including statements notifying an employee's supervising ethics office of the commencement of negotiations for future employment or compensation or of an agreement for future employment or compensation; (8) to a Member of Congress or a congressional office in response to an inquiry made on behalf of and at the request of an individual who is the subject of the record; (9) to contractors and other non-Government employees working on a contract, service or assignment for the Federal Government when necessary to accomplish a function related to this system of records; (10) on the OGE Website and to any person, department or agency, any written ethics agreement, including certifications of ethics agreement compliance, filed with OGE by an individual nominated by the President to a position requiring Senate confirmation; (11) on the OGE Website and to any person, department or agency, any certificate of divestiture issued by OGE; (12) on the OGE # DESCRIPTION TYPE DATE NOTIFICATION RECEIVED OVER 30 DAYS AGO AMOUNT 1 Amazon.com, Inc. (AMZN) Sale 06/10/2022 No $1,001 - $15,000 2 SPDR S&P 500 ETF Trust (SPY) Purchase 06/13/2022 No $1,001 - $15,000 3 Invesco QQQ Trust, Series 1 (QQQ) Purchase 06/13/2022 No $1,001 - $15,000 Criswell, Deanne - Page 3 Website and to any person, department or agency, any waiver of the restrictions contained in Executive Order 13770 or any superseding executive order; (13) to appropriate agencies, entities and persons when there has been a suspected or confirmed breach of the system of records, the agency maintaining the records has determined that there is a risk of harm to individuals, the agency, the Federal Government, or national security, and the disclosure is reasonably necessary to assist in connection with the agency's efforts to respond to the suspected or confirmed breach or to prevent, minimize, or remedy such harm; and (14) to another Federal agency or Federal entity, when the agency maintaining the record determines that information from this system of records is reasonably necessary to assist the recipient agency or entity in responding to a suspected or confirmed breach or in preventing, minimizing, or remedying the risk of harm to individuals, the recipient agency or entity, the Federal Government, or national security. See also the OGE/GOVT-1 executive branch-wide Privacy Act system of records.`;

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

  it('parses all three rows from the real, verbatim PRODUCTION text (single line, zero newlines) -- regression guard for the newline-flattening incident', () => {
    const rows = parseOgeTransactionRows(CRISWELL_278T_TEXT_PRODUCTION_FLATTENED);

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      assetName: 'Amazon.com, Inc.',
      ticker: 'AMZN',
      txType: 'S',
      txDate: '2022-06-10',
      amountMin: 1001,
      amountMax: 15000,
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
    // None of the surrounding legal boilerplate's own "<digit> <word>"
    // sequences (e.g. "5 U.S.C. app. section 101 et seq.", "(1) mutual
    // funds...", page numbers) produced a spurious extra row.
    for (const row of rows) {
      expect(row.assetName.length).toBeLessThan(60);
    }
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
