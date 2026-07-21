/**
 * CSV formula-injection tests (CT-AUD-008).
 *
 * Congressional filing data (member names, asset names, tickers) is
 * attacker-influenced text that ends up in the public CSV export. Excel and
 * Google Sheets execute cells starting with = + - @ (or tab/CR) as formulas,
 * so the encoder must neutralize those cells with a leading single quote
 * while preserving legitimate numeric formatting.
 */
import { describe, it, expect } from 'vitest';
import { csvCell, buildRestRouter } from '../rest.ts';
import type { Env } from '../../shared/types.ts';

describe('csvCell formula neutralization', () => {
  it('neutralizes formula-leading string cells with a single quote', () => {
    expect(csvCell('=HYPERLINK("https://evil.example","x")')).toBe(
      '"\'=HYPERLINK(""https://evil.example"",""x"")"',
    );
    expect(csvCell('=1+2')).toBe("'=1+2");
    expect(csvCell('+SUM(A1:A9)')).toBe("'+SUM(A1:A9)");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('-2+3+cmd|/c calc')).toBe("'-2+3+cmd|/c calc");
    expect(csvCell('\t=cmd')).toBe("'\t=cmd");
    expect(csvCell('\r=cmd')).toBe('"\'\r=cmd"');
  });

  it('preserves numeric cells and purely numeric negative strings', () => {
    expect(csvCell(1001)).toBe('1001');
    expect(csvCell(-15000)).toBe('-15000');
    expect(csvCell(-0.5)).toBe('-0.5');
    expect(csvCell('-15000')).toBe('-15000');
    expect(csvCell('-0.5')).toBe('-0.5');
  });

  it('keeps RFC 4180 escaping for benign cells', () => {
    expect(csvCell('Apple Inc.')).toBe('Apple Inc.');
    expect(csvCell('Smith, John "Jack"')).toBe('"Smith, John ""Jack"""');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });
});

const maliciousRow = {
  id: 'tx_1',
  doc_id: 'doc_1',
  filer_id: 'bio_1',
  tx_date: '2026-06-20',
  owner: 'self',
  asset_name: '=HYPERLINK("https://evil.example","claim your refund")',
  ticker: '@SUM(1+1)',
  asset_type: 'stock',
  tx_type: 'P',
  amount_min: 1001,
  amount_max: 15000,
  is_option: 0,
  cap_gains_over_200: 0,
  raw_text: '',
  confidence: 0.9,
  source: 'primary',
  created_at: '2026-06-20T00:00:00.000Z',
  cursor_seq: 1,
  __chamber: 'house',
  __member_name: '=cmd|/c calc!A0',
};

function fakeEnv(): Env {
  return {
    CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
    DB: {
      prepare: (sql: string) => ({
        bind() {
          return this;
        },
        async first() {
          return null;
        },
        async all() {
          return { results: /FROM transactions/i.test(sql) ? [maliciousRow] : [] };
        },
        async run() {
          return {};
        },
      }),
    },
  } as unknown as Env;
}

describe('GET /export/transactions.csv neutralizes hostile filing values', () => {
  it('quotes formula-leading member/asset/ticker cells but not amounts', async () => {
    const app = buildRestRouter();
    const res = await app.request('http://localhost/export/transactions.csv', {}, fakeEnv());
    expect(res.status).toBe(200);
    const csv = await res.text();
    const dataLine = csv.split('\r\n')[1];
    expect(dataLine).toContain("'=cmd|/c calc!A0");
    expect(dataLine).toContain("'@SUM(1+1)");
    // No cell in the row may begin with a live formula trigger.
    for (const cell of dataLine.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
      const unquoted = cell.startsWith('"') ? cell.slice(1, -1).replace(/""/g, '"') : cell;
      expect(unquoted).not.toMatch(/^[=+@\t\r]/);
    }
    // Legitimate numeric amounts keep plain formatting.
    expect(dataLine).toContain('1001');
    expect(dataLine).toContain('15000');
  });
});
