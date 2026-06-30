import { describe, expect, it } from 'vitest';
import { matchFmpDisclosureCandidate, parseFmpDisclosureRows } from '../fmpDisclosureLatency';

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
    ).toEqual({ providerKey: row.providerKey, matchMethod: 'probable-filer-date' });
  });
});
