import { describe, expect, it } from 'vitest';
import {
  matchDisclosureCandidate,
  matchFmpDisclosureCandidate,
  parseFmpDisclosureRows,
  parseQuiverDisclosureRows,
  parseUnusualWhalesDisclosureRows,
} from '../fmpDisclosureLatency';

describe('parseFmpDisclosureRows', () => {
  it('extracts a House doc token from PTR PDF URLs', () => {
    const rows = parseFmpDisclosureRows('house', [
      {
        representative: 'Jane Smith',
        disclosureDate: '2026-06-29',
        link: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20012345.pdf',
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].providerKey).toBe('20012345');
    expect(rows[0].sourceUrl).toContain('20012345.pdf');
    expect(rows[0].filedDate).toBe('2026-06-29');
  });

  it('accepts wrapped FMP result arrays', () => {
    const rows = parseFmpDisclosureRows('senate', {
      data: [
        {
          senator: 'Smith, Jane',
          filingDate: '06/29/2026',
          url: 'https://efdsearch.senate.gov/search/view/ptr/abcd1234/',
        },
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].providerKey).toBe('abcd1234');
    expect(rows[0].filedDate).toBe('2026-06-29');
  });
});

describe('matchFmpDisclosureCandidate', () => {
  it('matches by canonical House document token', () => {
    const row = parseFmpDisclosureRows('house', [
      { link: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20012345.pdf' },
    ])[0];

    expect(
      matchFmpDisclosureCandidate(
        {
          doc_id: 'H-2026-20012345',
          source_url: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20012345.pdf',
          filed_date: '2026-06-29',
          filer_name: 'Jane Smith',
        },
        row,
      ),
    ).toEqual({ providerKey: '20012345', matchMethod: 'doc-token' });
  });

  it('matches by Senate report id token', () => {
    const row = parseFmpDisclosureRows('senate', [
      { url: 'https://efdsearch.senate.gov/search/view/ptr/abcd1234/' },
    ])[0];

    expect(
      matchFmpDisclosureCandidate(
        {
          doc_id: 'S-abcd1234',
          source_url: 'https://efdsearch.senate.gov/search/view/ptr/abcd1234/',
          filed_date: '2026-06-29',
          filer_name: 'Smith, Jane',
        },
        row,
      ),
    ).toEqual({ providerKey: 'abcd1234', matchMethod: 'doc-token' });
  });

  it('falls back to probable filer/date when no document token is exposed', () => {
    const row = parseFmpDisclosureRows('senate', [
      { senator: 'Smith, Jane', filingDate: '06/29/2026', ticker: 'AAPL' },
    ])[0];

    expect(
      matchFmpDisclosureCandidate(
        {
          doc_id: 'S-hidden-report',
          source_url: null,
          filed_date: '2026-06-29',
          filer_name: 'Smith, Jane',
        },
        row,
      ),
    ).toEqual({ providerKey: row.providerKey, matchMethod: 'filer-date' });
  });
});

describe('parse third-party disclosure providers', () => {
  it('normalizes Unusual Whales recent Congress rows', () => {
    const rows = parseUnusualWhalesDisclosureRows({
      data: [
        {
          filed_at_date: '2026-06-29',
          member_type: 'senate',
          name: 'Jane Smith',
          politician_id: 'abc',
          ticker: 'MSFT',
          transaction_date: '2026-06-20',
          txn_type: 'Buy',
        },
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        provider: 'unusual_whales',
        chamber: 'senate',
        filedDate: '2026-06-29',
        filerName: 'Jane Smith',
        providerPublishedAt: null,
      }),
    );
    expect(
      matchDisclosureCandidate(
        { doc_id: 'S-hidden', source_url: null, filed_date: '2026-06-29', filer_name: 'Smith, Jane' },
        rows[0],
      ),
    ).toEqual({ providerKey: rows[0].providerKey, matchMethod: 'filer-date' });
  });

  it('captures Quiver upload timestamps separately from monitor observation time', () => {
    const rows = parseQuiverDisclosureRows('house', [
      {
        Representative: 'Jane Smith',
        ReportDate: '2026-06-29T00:00:00Z',
        Date: '2026-06-20T00:00:00Z',
        Ticker: 'MSFT',
        Transaction: 'Purchase',
        Quiver_Upload_Time: '2026-06-29T14:05:00Z',
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        provider: 'quiver',
        chamber: 'house',
        filedDate: '2026-06-29',
        filerName: 'Jane Smith',
        providerPublishedAt: '2026-06-29T14:05:00.000Z',
      }),
    );
  });
});
