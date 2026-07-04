import { describe, it, expect } from 'vitest';
import {
  parseCsrfMiddlewareToken,
  parseReportLink,
  parseSenateRows,
  formatSenateDate,
  CookieJar,
  fetchSenatePtrFilings,
} from '../senateSource';

describe('parseCsrfMiddlewareToken', () => {
  it('extracts the hidden token (value after name)', () => {
    const html = `<form><input type="hidden" name="csrfmiddlewaretoken" value="ABC123token"></form>`;
    expect(parseCsrfMiddlewareToken(html)).toBe('ABC123token');
  });
  it('extracts the token when value precedes name', () => {
    const html = `<input value="XYZ789" name='csrfmiddlewaretoken' />`;
    expect(parseCsrfMiddlewareToken(html)).toBe('XYZ789');
  });
  it('returns empty string when absent', () => {
    expect(parseCsrfMiddlewareToken('<form></form>')).toBe('');
  });
});

describe('parseReportLink', () => {
  it('parses path + trailing-slash id from an anchor', () => {
    const cell = `<a href="/search/view/ptr/0f8b12cd/" target="_blank">Smith, Jane</a>`;
    expect(parseReportLink(cell)).toEqual({
      reportPath: '/search/view/ptr/0f8b12cd/',
      reportId: '0f8b12cd',
    });
  });
  it('parses single-quoted href without trailing slash', () => {
    const cell = `<a href='/search/view/paper/abcd'>X</a>`;
    expect(parseReportLink(cell)).toEqual({
      reportPath: '/search/view/paper/abcd',
      reportId: 'abcd',
    });
  });
  it('returns null when there is no href', () => {
    expect(parseReportLink('Smith, Jane')).toBeNull();
  });
});

describe('parseSenateRows', () => {
  it('maps DataTables rows into SenateFiling, stripping tags for fullName', () => {
    const rows: string[][] = [
      [
        'Jane',
        'Smith',
        `<a href="/search/view/ptr/0f8b12cd/">Smith, Jane</a>`,
        'Periodic Transaction Report',
        '01/15/2024',
      ],
      // unparseable link -> skipped
      ['No', 'Link', 'plain text', 'PTR', '02/01/2024'],
      // short row -> skipped
      ['too', 'short'],
    ];
    const out = parseSenateRows(rows);
    expect(out).toHaveLength(1);
    const f = out[0];
    expect(f.reportId).toBe('0f8b12cd');
    expect(f.pipelineDocId).toBe('S-0f8b12cd');
    expect(f.fullName).toBe('Smith, Jane');
    expect(f.first).toBe('Jane');
    expect(f.last).toBe('Smith');
    expect(f.filedDate).toBe('01/15/2024');
    expect(f.sourceUrl).toBe('https://efdsearch.senate.gov/search/view/ptr/0f8b12cd/');
  });

  it('locates the anchor by content when eFD shifts columns (inserted office col)', () => {
    // The live eFD response now returns 6 columns with the anchor at index 3:
    // [first, last, office, anchorHtml, filingType, filedDate]. The old index-2
    // parse yielded 0 rows; the content-based parse must still map it.
    const rows: string[][] = [
      [
        'John R',
        'Curtis',
        'Curtis, John R. (Senator)',
        `<a href="/search/view/ptr/96d0794e/" target="_blank">Curtis, John R. (Senator)</a>`,
        'Periodic Transaction Report',
        '06/30/2026',
      ],
    ];
    const out = parseSenateRows(rows);
    expect(out).toHaveLength(1);
    const f = out[0];
    expect(f.reportId).toBe('96d0794e');
    expect(f.pipelineDocId).toBe('S-96d0794e');
    expect(f.first).toBe('John R');
    expect(f.last).toBe('Curtis');
    expect(f.fullName).toBe('Curtis, John R. (Senator)');
    expect(f.filedDate).toBe('06/30/2026');
    expect(f.filingTypeLabel).toBe('Periodic Transaction Report');
    expect(f.sourceUrl).toBe('https://efdsearch.senate.gov/search/view/ptr/96d0794e/');
  });
});

describe('formatSenateDate', () => {
  it('formats MM/DD/YYYY HH:MM:SS in UTC', () => {
    const d = new Date(Date.UTC(2024, 0, 5, 9, 8, 7)); // 2024-01-05T09:08:07Z
    expect(formatSenateDate(d)).toBe('01/05/2024 09:08:07');
  });
});

describe('CookieJar', () => {
  it('absorbs name=value pairs and serializes a Cookie header', () => {
    const jar = new CookieJar();
    jar.absorbString('csrftoken=tok123; Path=/; HttpOnly');
    jar.absorbString('sessionid=sess456; Path=/; Secure');
    expect(jar.get('csrftoken')).toBe('tok123');
    expect(jar.get('sessionid')).toBe('sess456');
    const header = jar.header();
    expect(header).toContain('csrftoken=tok123');
    expect(header).toContain('sessionid=sess456');
  });
  it('overwrites an existing cookie on re-set', () => {
    const jar = new CookieJar();
    jar.absorbString('csrftoken=old');
    jar.absorbString('csrftoken=new; Path=/');
    expect(jar.get('csrftoken')).toBe('new');
  });
});

describe('fetchSenatePtrFilings', () => {
  function senateRow(id: string): string[] {
    return [
      'Jane',
      'Smith',
      `<a href="/search/view/ptr/${id}/">Smith, Jane</a>`,
      'Periodic Transaction Report',
      '06/30/2026',
    ];
  }

  it('paginates beyond the first DataTables page and stops at recordsFiltered', async () => {
    const starts: string[] = [];
    const lengths: string[] = [];
    const fetchImpl = async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/search/')) {
        return new Response(
          `<form><input type="hidden" name="csrfmiddlewaretoken" value="csrf-hidden"></form>`,
          { headers: { 'set-cookie': 'csrftoken=csrf-cookie; Path=/' } },
        );
      }
      if (url.endsWith('/search/home/')) {
        return new Response('', { status: 302, headers: { 'set-cookie': 'sessionid=sess; Path=/' } });
      }
      if (url.endsWith('/search/report/data/')) {
        const body = new URLSearchParams(String(init?.body ?? ''));
        starts.push(body.get('start') ?? '');
        lengths.push(body.get('length') ?? '');
        const start = Number(body.get('start') ?? '0');
        const data = start === 0 ? [senateRow('a'), senateRow('b')] : [senateRow('c')];
        return new Response(JSON.stringify({ data, recordsFiltered: 3 }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    const out = await fetchSenatePtrFilings(
      {
        since: new Date('2026-06-30T00:00:00.000Z'),
        now: new Date('2026-06-30T23:59:59.000Z'),
        pageSize: 2,
        maxPages: 5,
        politeDelayMs: 0,
      },
      fetchImpl,
    );

    expect(starts).toEqual(['0', '2']);
    expect(lengths).toEqual(['2', '2']);
    expect(out.map((f) => f.pipelineDocId)).toEqual(['S-a', 'S-b', 'S-c']);
  });
});
