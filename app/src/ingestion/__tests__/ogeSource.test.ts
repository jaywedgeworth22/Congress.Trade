import { describe, expect, it } from 'vitest';
import { ogeDocId, ogeFiledDateFromName, parseOgeIndex } from '../ogeSource';

/** Anchor markup lifted from the LIVE OGE President/VP index view (Domino
 *  renders single-quoted hrefs with raw spaces in filenames). */
const FIXTURE = `
<a href='/201/Presiden.nsf/PAS+Index/AA799A2729B4D1BE85258D430031A320/$FILE/Donald J. Trump 10.17.2025 278-T.pdf'>278-T</a>
<a href='/201/Presiden.nsf/PAS+Index/18353894FE440B3685258D430031A337/$FILE/Donald J. Trump 10.20.2025 278-T (2).pdf'>278-T</a>
<a href='/201/Presiden.nsf/PAS+Index/268353939B7DACB585258D81003471B1/$FILE/Donald-J-Trump 1.14.2026-278T.pdf'>278-T</a>
<a href='/201/Presiden.nsf/PAS+Index/322B8A28DB21CC9285258CFD002C0D0B/$FILE/Donald J. Trump 9.3.25 278-T.pdf'>278-T</a>
<a href='/201/Presiden.nsf/PAS+Index/4EC9A8E6DD078F2985258CA9002C9377/$FILE/Trump, Donald J. 2025 Annual 278.pdf'>Annual</a>
<a href='/201/Presiden.nsf/PAS+Index/69AEAA9D7455ACD585258E27002DDEE1/$FILE/Donald-J-Trump-2026-278ANNUAL.pdf'>Annual</a>
<a href='/201/Presiden.nsf/PAS+Index/66A69EB879848CF885258CC9002C8582/$FILE/Howard-Lutnick-06.17.2025-278T.pdf'>278-T</a>
<a href='/201/Presiden.nsf/PAS+Index/AA799A2729B4D1BE85258D430031A320/$FILE/Donald J. Trump 10.17.2025 278-T.pdf'>dup</a>
`;

describe('parseOgeIndex', () => {
  const filings = parseOgeIndex(FIXTURE);

  it('extracts only known-filer 278-T reports (no annuals, no other filers, deduped)', () => {
    expect(filings).toHaveLength(4);
    expect(filings.every((f) => f.chamber === 'executive')).toBe(true);
    expect(filings.every((f) => f.filerId === 'EXEC-DJT')).toBe(true);
    expect(filings.every((f) => f.filerName === 'Donald J. Trump')).toBe(true);
    const raw = JSON.stringify(filings);
    expect(raw).not.toContain('Lutnick');
    expect(raw).not.toContain('Annual');
  });

  it('builds direct, space-encoded download URLs on the OGE origin', () => {
    expect(filings[0].sourceUrl).toBe(
      'https://extapps2.oge.gov/201/Presiden.nsf/PAS+Index/AA799A2729B4D1BE85258D430031A320/$FILE/Donald%20J.%20Trump%2010.17.2025%20278-T.pdf',
    );
  });

  it('derives stable doc ids and filed dates (incl. 2-digit years)', () => {
    expect(filings[0].docId).toBe('E-2025-donald-j-trump-10-17-2025-278-t');
    expect(filings[0].filedDate).toBe('2025-10-17');
    // "(2)" variant stays a distinct doc
    expect(filings[1].docId).not.toBe(filings[0].docId);
    // dotted 2-digit year
    expect(filings[3].filedDate).toBe('2025-09-03');
    expect(filings[2].filedDate).toBe('2026-01-14');
  });
});

describe('filename helpers', () => {
  it('parses both 4- and 2-digit year forms', () => {
    expect(ogeFiledDateFromName('Trump, Donald J.-05.08.2026-278T(2).pdf')).toBe('2026-05-08');
    expect(ogeFiledDateFromName('Donald J. Trump 9.3.25 278-T.pdf')).toBe('2025-09-03');
    expect(ogeFiledDateFromName('no-date-here.pdf')).toBeNull();
  });

  it('doc ids are slugged, bounded, and year-prefixed', () => {
    const id = ogeDocId('Trump, Donald J.-05.08.2026-278T(2).pdf');
    expect(id).toBe('E-2026-trump-donald-j-05-08-2026-278t-2');
    expect(id.length).toBeLessThanOrEqual(87);
  });
});
