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

  it('parses single-line House text without treating the PTR header as an asset', () => {
    const rows = parseHousePtrText(
      'P T R Clerk of the House of Representatives T ID Owner Asset Transaction Type Date Notification Date Amount Cap. Gains > $200? ' +
        'SP Amazon.com, Inc. - Common Stock (AMZN) [ST] S (partial) 03/16/2026 03/16/2026 $1,001 - $15,000 F S: New S O: Putnam Investments D: details with AAPL and QQQ shares ' +
        'DC Apple Inc. - Common Stock (AAPL) [ST] S (partial) 03/16/2026 03/16/2026 $1,001 - $15,000 F S: New',
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      owner: 'spouse',
      assetName: 'Amazon.com, Inc. - Common Stock',
      ticker: 'AMZN',
      assetType: 'ST',
      assetTypeName: 'Stocks (including ADRs)',
      txType: 'S',
      txDate: '2026-03-16',
      amountMin: 1001,
      amountMax: 15000,
    });
    expect(rows[1]).toMatchObject({
      owner: 'dependent',
      assetName: 'Apple Inc. - Common Stock',
      ticker: 'AAPL',
    });
    expect(rows[0].assetName).not.toContain('Clerk');
  });

  it('anchors inline House rows at owner codes instead of the PTR header', () => {
    const rows = parseHousePtrText(
      'P T R Clerk of the House of Representatives T ID Owner Asset Transaction Type Date Notification Date Amount Cap. Gains > $200? ' +
        'SP Austin TX ARPT SYS TRAN [GS] P 05/05/2026 05/31/2026 $50,001 - $100,000 F S: New ' +
        'SP Bonita CA UNI SCH [GS] P 05/05/2026 05/31/2026 $50,001 - $100,000 F S: New ' +
        'SP East Bay CA Muni Util [GS] P 05/06/2026 05/31/2026 $250,001 - Filing ID #20034784 ID Owner Asset Transaction Type Date Notification Date Amount Cap. Gains > $200? $500,000 F S: New ' +
        'SP EEMA O&M Services Group [OL] P 05/15/2026 05/31/2026 $250,001 - $500,000 F S: New S O: Kent Street Group LLC L: Elverson, PA, US D: Water/Wastewater O&M ' +
        'SP Energy Northwest WA PWR UTIL [GS] P 05/20/2026 05/31/2026 $500,001 - $1,000,000 F S: New',
    );

    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({
      owner: 'spouse',
      assetName: 'Austin TX ARPT SYS TRAN',
      assetType: 'GS',
      txType: 'P',
      txDate: '2026-05-05',
      amountMin: 50001,
      amountMax: 100000,
    });
    expect(rows[2]).toMatchObject({
      assetName: 'East Bay CA Muni Util',
      amountMin: 250001,
      amountMax: 500000,
    });
    expect(rows[3]).toMatchObject({
      assetName: 'EEMA O&M Services Group',
      assetType: 'OL',
    });
    expect(rows[0].assetName).not.toContain('Clerk');
    expect(rows[3].assetName).not.toContain('Kent Street Group');
  });

  it('preserves row-specific House PTR detail text and checked capital gains flags', () => {
    const rows = parseHousePtrText(`
      Filer Information
      Name: Hon. Josh Gottheimer
      ID Owner Asset Transaction Type Date Notification Date Amount Cap. Gains > $200?
      JT Abbott Laboratories Common Stock (ABT) [ST]
      S (partial) 05/27/2026 06/02/2026 $1,001 - $15,000
      Filing Status: New
      Subholding Of: Morgan Stanley - Select UMA Account # 1
      Location: US
      Description: Common Stock
      Cap. Gains > $200? checked
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner: 'joint',
      ticker: 'ABT',
      assetType: 'ST',
      assetTypeName: 'Stocks (including ADRs)',
      filingStatus: 'New',
      subholding: 'Morgan Stanley - Select UMA Account # 1',
      location: 'US',
      description: 'Common Stock',
      supplementalText:
        'New | Morgan Stanley - Select UMA Account # 1 | US | Common Stock',
      capGainsOver200: true,
    });
    expect(rows[0].supplementalText).not.toContain('Hon. Josh');
  });
});
