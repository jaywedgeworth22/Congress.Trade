import { describe, it, expect } from 'vitest';
import {
  parseHouseIndexXml,
  houseBulkZipUrl,
  housePtrPdfUrl,
  houseDocId,
} from '../houseSource';

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
