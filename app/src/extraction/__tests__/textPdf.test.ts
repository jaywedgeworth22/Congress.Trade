import { describe, expect, it } from 'vitest';
import { parseHousePtrText } from '../textPdf';

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
    });
    expect(rows[0].assetName).not.toContain('Clerk');
  });
});
