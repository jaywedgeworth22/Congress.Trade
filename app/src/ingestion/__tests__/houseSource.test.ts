import { describe, it, expect, vi } from 'vitest';
import {
  parseHouseIndexXml,
  parseHouseSearchHtml,
  buildHouseSearchBody,
  pollHouseLiveSearch,
  houseBulkZipUrl,
  housePtrPdfUrl,
  houseDocId,
} from '../houseSource.ts';

const FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<FinancialDisclosure>
  <Member>
    <Prefix></Prefix>
    <Last>Smith</Last>
    <First>Jane</First>
    <Suffix></Suffix>
    <FilingType>P</FilingType>
    <StateDst>CA01</StateDst>
    <Year>2024</Year>
    <FilingDate>1/2/2024</FilingDate>
    <DocID>20012345</DocID>
  </Member>
  <Member>
    <Last>O&apos;Brien</Last>
    <First>Pat &amp; Co</First>
    <FilingType>O</FilingType>
    <StateDst>NY10</StateDst>
    <Year>2024</Year>
    <FilingDate>3/4/2024</FilingDate>
    <DocID>20099999</DocID>
  </Member>
  <Member>
    <Last>NoDoc</Last>
    <First>Skip</First>
    <FilingType>P</FilingType>
    <StateDst>TX05</StateDst>
    <Year>2024</Year>
  </Member>
</FinancialDisclosure>`;

describe('parseHouseIndexXml', () => {
  it('parses members, decodes entities, flags PTRs, and skips rows without DocID', () => {
    const rows = parseHouseIndexXml(FIXTURE, '2024');
    expect(rows).toHaveLength(2); // the DocID-less row is skipped

    const [ptr, other] = rows;
    expect(ptr.docId).toBe('20012345');
    expect(ptr.filingType).toBe('P');
    expect(ptr.isPtr).toBe(true);
    expect(ptr.first).toBe('Jane');
    expect(ptr.last).toBe('Smith');
    expect(ptr.stateDst).toBe('CA01');
    expect(ptr.filingDate).toBe('1/2/2024');
    expect(ptr.pipelineDocId).toBe('H-2024-20012345');
    expect(ptr.sourceUrl).toBe(
      'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2024/20012345.pdf',
    );

    expect(other.isPtr).toBe(false);
    expect(other.first).toBe('Pat & Co'); // &amp; decoded
    expect(other.last).toBe("O'Brien"); // &apos; decoded
  });

  it('falls back to defaultYear when <Year> is absent', () => {
    const xml = `<FinancialDisclosure><Member><FilingType>P</FilingType><DocID>1</DocID></Member></FinancialDisclosure>`;
    const rows = parseHouseIndexXml(xml, '2099');
    expect(rows[0].year).toBe('2099');
    expect(rows[0].pipelineDocId).toBe('H-2099-1');
  });
});

// Shaped like the real disclosures-clerk.house.gov/FinancialDisclosure/
// ViewMemberSearchResult markup: relative hrefs (no leading slash), an "Hon.."
// honorific in the filer name, and a data-label="Office" StateDst cell.
const SEARCH_HTML = `
<table><tbody>
  <tr role="row">
    <td data-label="Name" class="memberName"><a href="public_disc/ptr-pdfs/2026/20026001.pdf" target="_blank">Smith, Hon.. Jane A. </a></td>
    <td data-label="Office">CA01</td><td data-label="Filing Year">2026</td><td data-label="Filing">PTR</td>
  </tr>
  <tr role="row">
    <td data-label="Name" class="memberName">O'Brien, Hon.. Pat</td>
    <td data-label="Office">NY10</td><td data-label="Filing Year">2026</td>
    <td data-label="Filing"><a href="https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20026002.pdf">View</a></td>
  </tr>
  <tr role="row">
    <td data-label="Name"><a href="public_disc/financial-pdfs/2026/20026003.pdf" target="_blank">Annual, Hon.. Filer</a></td>
    <td data-label="Office">TX05</td><td data-label="Filing Year">2026</td><td data-label="Filing">FD Original</td>
  </tr>
  <tr role="row">
    <td data-label="Name"><a href="public_disc/ptr-pdfs/2026/20026001.pdf">Smith, Hon.. Jane A. </a></td>
    <td data-label="Office">CA01</td><td data-label="Filing Year">2026</td><td data-label="Filing">PTR</td>
  </tr>
</tbody></table>`;

describe('parseHouseSearchHtml', () => {
  it('extracts PTR rows, strips honorifics, captures office, dedupes, ignores non-PTR', () => {
    const rows = parseHouseSearchHtml(SEARCH_HTML, '2026');
    // Two distinct PTRs; the FD row and the duplicate docId are dropped.
    expect(rows).toHaveLength(2);

    const a = rows[0];
    expect(a.docId).toBe('20026001');
    expect(a.isPtr).toBe(true);
    expect(a.last).toBe('Smith');
    expect(a.first).toBe('Jane A.'); // "Hon.." honorific stripped
    expect(a.stateDst).toBe('CA01'); // from the Office cell
    expect(a.pipelineDocId).toBe('H-2026-20026001');
    // Relative href (no leading slash) is resolved to an absolute URL.
    expect(a.sourceUrl).toBe(
      'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20026001.pdf',
    );

    const b = rows[1];
    expect(b.docId).toBe('20026002');
    // Anchor text "View" is generic -> name falls back to the first cell.
    expect(b.last).toBe("O'Brien");
    expect(b.first).toBe('Pat');
    expect(b.stateDst).toBe('NY10');
    // Already-absolute href is preserved.
    expect(b.sourceUrl).toBe(
      'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20026002.pdf',
    );
  });

  it('returns nothing for HTML with no PTR links', () => {
    expect(parseHouseSearchHtml('<table><tr><td>nope</td></tr></table>', '2026')).toEqual([]);
  });
});

describe('buildHouseSearchBody', () => {
  it('scopes the search to the requested filing year with a blank name', () => {
    const body = buildHouseSearchBody(2026);
    expect(body.get('FilingYear')).toBe('2026');
    expect(body.get('LastName')).toBe('');
  });
});

describe('pollHouseLiveSearch', () => {
  it('gets a session cookie before posting the live search form', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        return new Response('<html></html>', {
          status: 200,
          headers: { 'set-cookie': 'HOUSESESSION=abc123; Path=/; HttpOnly' },
        });
      }

      return new Response(SEARCH_HTML, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });

    const rows = await pollHouseLiveSearch(2026, fetchMock as unknown as typeof fetch);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/FinancialDisclosure/ViewSearch');
    expect(String(fetchMock.mock.calls[1][0])).toContain('/FinancialDisclosure/ViewMemberSearchResult');

    const postInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect(postInit.method).toBe('POST');
    expect(String(postInit.body)).toContain('FilingYear=2026');
    expect(postInit.headers).toMatchObject({
      cookie: 'HOUSESESSION=abc123',
      'x-requested-with': 'XMLHttpRequest',
    });

    expect(rows.map((row) => row.pipelineDocId)).toEqual(['H-2026-20026001', 'H-2026-20026002']);
  });

  it('retries up to 3 times on HTTP errors and allows subsequent calls to succeed independently', async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount++;
      if (callCount <= 6) {
        return new Response('403 Forbidden', { status: 403 });
      }
      return new Response(SEARCH_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    });

    // 1st call fails 3 attempts (6 fetches)
    await expect(pollHouseLiveSearch(2026, fetchMock as unknown as typeof fetch, { delayMs: 0 })).rejects.toThrow('HTTP 403');
    expect(callCount).toBe(6);

    // 2nd call (next tick) runs fresh attempts without persistent lockout
    const rows = await pollHouseLiveSearch(2026, fetchMock as unknown as typeof fetch, { delayMs: 0 });
    expect(rows.map((row) => row.pipelineDocId)).toEqual(['H-2026-20026001', 'H-2026-20026002']);
  });
});

describe('house url builders', () => {
  it('builds the yearly zip url', () => {
    expect(houseBulkZipUrl(2024)).toBe(
      'https://disclosures-clerk.house.gov/public_disc/financial-pdfs/2024FD.ZIP',
    );
  });
  it('builds the ptr pdf url', () => {
    expect(housePtrPdfUrl(2024, '20012345')).toBe(
      'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2024/20012345.pdf',
    );
  });
  it('builds the pipeline doc id', () => {
    expect(houseDocId(2024, '20012345')).toBe('H-2024-20012345');
  });
});
