import { describe, it, expect } from 'vitest';
import {
  ArbitratingExtractor,
  arbitrationRowKey,
  buildExtractorPipeline,
  fieldAgreement,
  HousePdfExtractor,
  mergeResults,
  type Extractor,
  type ExtractorResult,
} from '../types.ts';
import type { Env, Filing, ParsedTx } from '../../shared/types.ts';

function tx(over: Partial<ParsedTx> = {}): ParsedTx {
  return {
    txDate: '2026-01-02',
    owner: 'self',
    assetName: 'Apple Inc',
    ticker: 'AAPL',
    assetType: 'ST',
    txType: 'B',
    amountMin: 1001,
    amountMax: 15000,
    isOption: false,
    capGainsOver200: false,
    rawText: '',
    confidence: 0.6,
    ...over,
  };
}

function result(rows: ParsedTx[], over: Partial<ExtractorResult> = {}): ExtractorResult {
  return {
    transactions: rows,
    confidence: rows.length ? rows.reduce((s, r) => s + r.confidence, 0) / rows.length : 0,
    raw: 'raw',
    extractor: 'primary',
    ...over,
  };
}

const filing = (over: Partial<Filing> = {}): Filing => ({
  docId: 'H-1',
  chamber: 'house',
  filerId: 'F1',
  filingType: 'P',
  filedDate: '2026-06-24',
  sourceUrl: 'https://example.test/doc.pdf',
  rawObjectKey: 'raw/doc.pdf',
  ingestStatus: 'classified',
  docKind: 'scanned_pdf',
  extractor: null,
  modelVersion: null,
  confidence: null,
  firstSeenAt: '2026-06-24T00:00:00.000Z',
  sourceUpdatedAt: null,
  error: null,
  ...over,
});

function extractor(name: string, out: ExtractorResult): Extractor {
  return {
    name,
    canHandle: () => true,
    extract: async () => out,
  };
}

describe('arbitrationRowKey', () => {
  it('keys on ticker + date + type, uppercased', () => {
    expect(arbitrationRowKey(tx({ ticker: 'aapl' }))).toBe('AAPL|2026-01-02|B');
  });
  it('falls back to asset name when no ticker', () => {
    expect(arbitrationRowKey(tx({ ticker: null, assetName: 'US T-Bill' }))).toBe(
      'US T-BILL|2026-01-02|B',
    );
  });
});

describe('fieldAgreement', () => {
  it('counts matching comparable fields', () => {
    expect(fieldAgreement(tx(), tx())).toEqual({ agree: 5, total: 5 });
    expect(fieldAgreement(tx(), tx({ amountMin: 50000 }))).toEqual({ agree: 4, total: 5 });
    expect(fieldAgreement(tx(), tx({ owner: 'spouse', isOption: true }))).toEqual({
      agree: 3,
      total: 5,
    });
  });
});

describe('mergeResults', () => {
  it('boosts confidence when both extractors fully agree', () => {
    const merged = mergeResults(result([tx({ confidence: 0.6 })]), result([tx({ confidence: 0.6 })]));
    expect(merged.transactions).toHaveLength(1);
    // (0.6 + 0.6)/2 + 0.1 = 0.7
    expect(merged.transactions[0].confidence).toBeCloseTo(0.7, 5);
    expect(merged.extractor).toBe('arbitrating(primary,primary)');
  });

  it('scales row confidence down on partial field disagreement', () => {
    const primary = result([tx({ confidence: 1 })]);
    const secondary = result([tx({ confidence: 1, amountMin: 50000, amountMax: 100000 })]);
    const merged = mergeResults(primary, secondary);
    // 4/5 fields agree -> 1 * 0.8
    expect(merged.transactions[0].confidence).toBeCloseTo(0.8, 5);
  });

  it('halves confidence for primary-only rows (no corroboration)', () => {
    const primary = result([tx({ ticker: 'AAPL', confidence: 0.8 })]);
    const secondary = result([tx({ ticker: 'MSFT', confidence: 0.8 })]);
    const merged = mergeResults(primary, secondary);
    // primary row has no secondary match -> 0.8 * 0.5
    expect(merged.transactions[0].confidence).toBeCloseTo(0.4, 5);
  });

  it('keeps the primary row set authoritative and lowers doc confidence when contested', () => {
    const primary = result([tx({ ticker: 'AAPL' })]);
    const secondary = result([tx({ ticker: 'AAPL' }), tx({ ticker: 'TSLA' })]);
    const merged = mergeResults(primary, secondary);
    // Output is still just the one primary row...
    expect(merged.transactions).toHaveLength(1);
    // ...but the secondary-only row drags doc confidence below the row confidence.
    expect(merged.confidence).toBeLessThan(merged.transactions[0].confidence);
    expect(merged.raw).toContain('secondaryOnly=1');
  });

  it('retains usage and provider request identity for every arbitrated model call', () => {
    const primary = result([tx()], {
      extractor: 'vision-primary',
      modelVersion: 'gemini-3.5-flash',
      providerRequestId: 'primary-request',
      usage: { promptTokens: 100, completionTokens: 20 },
    });
    const secondary = result([tx()], {
      extractor: 'vision-secondary',
      modelVersion: 'gemini-2.5-pro',
      providerRequestId: 'secondary-request',
      usage: { promptTokens: 120, completionTokens: 30 },
    });

    const merged = mergeResults(primary, secondary);

    expect(merged.providerRequestId).toBe('primary-request');
    expect(merged.usage).toEqual({ promptTokens: 100, completionTokens: 20 });
    expect(merged.modelRuns).toEqual([
      {
        extractor: 'vision-primary',
        modelVersion: 'gemini-3.5-flash',
        providerRequestId: 'primary-request',
        usage: { promptTokens: 100, completionTokens: 20 },
      },
      {
        extractor: 'vision-secondary',
        modelVersion: 'gemini-2.5-pro',
        providerRequestId: 'secondary-request',
        usage: { promptTokens: 120, completionTokens: 30 },
      },
    ]);
  });
});

describe('ArbitratingExtractor usage preservation', () => {
  it('attaches the billed primary run when the secondary fails after consuming usage', async () => {
    const primary = result([tx()], {
      extractor: 'vision-primary',
      modelVersion: 'gemini-3.5-flash',
      providerRequestId: 'primary-request',
      usage: { promptTokens: 100, completionTokens: 20 },
    });
    const secondaryError = Object.assign(new Error('secondary parse failed'), {
      resolvedModel: 'gemini-2.5-pro',
      providerRequestId: 'secondary-request',
      usage: { promptTokens: 120, completionTokens: 30 },
    });
    const secondary: Extractor = {
      name: 'vision-secondary',
      canHandle: () => true,
      extract: async () => { throw secondaryError; },
    };
    const arbitrating = new ArbitratingExtractor(
      extractor('vision-primary', primary),
      { ARBITRATION_ENABLED: 'true' } as unknown as Env,
      secondary,
    );

    await expect(arbitrating.extract({ filing: filing() })).rejects.toBe(secondaryError);
    expect((secondaryError as Error & { modelRuns?: unknown[] }).modelRuns).toEqual([
      {
        extractor: 'vision-primary',
        modelVersion: 'gemini-3.5-flash',
        providerRequestId: 'primary-request',
        usage: { promptTokens: 100, completionTokens: 20 },
      },
      {
        extractor: 'vision-secondary',
        modelVersion: 'gemini-2.5-pro',
        providerRequestId: 'secondary-request',
        usage: { promptTokens: 120, completionTokens: 30 },
      },
    ]);
  });
});

describe('HousePdfExtractor', () => {
  it('uses text extraction first for House scanned PDFs when rows are found', async () => {
    const text = extractor('textPdf', result([tx({ confidence: 0.9 })], { extractor: 'textPdf' }));
    const vision = extractor('vision', result([tx({ ticker: 'MSFT' })], { extractor: 'vision' }));
    const house = new HousePdfExtractor(text, vision);

    const out = await house.extract({ filing: filing() });

    expect(house.canHandle(filing())).toBe(true);
    expect(out.extractor).toBe('textPdf');
    expect(out.transactions[0].ticker).toBe('AAPL');
  });

  it('falls back to vision when a real House scan has no text rows', async () => {
    const text = extractor('textPdf', result([], { extractor: 'textPdf' }));
    const vision = extractor('vision', result([tx({ ticker: 'INTC' })], { extractor: 'vision' }));
    const house = new HousePdfExtractor(text, vision);

    const out = await house.extract({
      filing: filing({ docId: 'H-2025-8221302', docKind: 'scanned_pdf' }),
    });

    expect(out.extractor).toBe('vision');
    expect(out.transactions[0].ticker).toBe('INTC');
  });

  it('does not call Files/vision on an electronic House PTR with zero text rows', async () => {
    const text = extractor('textPdf', result([], { extractor: 'textPdf', raw: 'Periodic Transaction Report header only' }));
    let visionCalls = 0;
    const vision: Extractor = {
      name: 'vision',
      canHandle: () => true,
      extract: async () => {
        visionCalls += 1;
        return result([tx({ ticker: 'INTC' })], { extractor: 'vision' });
      },
    };
    const house = new HousePdfExtractor(text, vision);

    const out = await house.extract({
      filing: filing({ docId: 'H-2025-20030634', docKind: 'scanned_pdf' }),
    });

    expect(visionCalls).toBe(0);
    expect(out.extractor).toBe('textPdf');
    expect(out.transactions).toEqual([]);
  });

  it('does not escalate a letterhead cheap read to Files/vision', async () => {
    const letterhead = result([
      tx({
        assetName: 'Clerk of the House of Representatives',
        ticker: null,
        txDate: null,
        confidence: 0.15,
      }),
    ], { extractor: 'textPdf' });
    let visionCalls = 0;
    const vision: Extractor = {
      name: 'vision',
      canHandle: () => true,
      extract: async () => {
        visionCalls += 1;
        return result([tx()], { extractor: 'vision' });
      },
    };
    const house = new HousePdfExtractor(
      extractor('textPdf', letterhead),
      vision,
    );

    const out = await house.extract({
      filing: filing({ docId: 'H-2025-20030634', docKind: 'text_pdf' }),
    });

    expect(visionCalls).toBe(0);
    expect(out.transactions[0]?.assetName).toMatch(/Clerk of the House/);
  });

  it('uses cheap text (not Files) when an electronic PTR has a plausible table but zero structured rows', async () => {
    const emptyText = result([], {
      extractor: 'textPdf',
      raw: 'SP  Apple Inc. (AAPL) [ST]\nP  06/14/2024  06/20/2024  $1,001 - $15,000',
    });
    let visionCalls = 0;
    let cheapCalls = 0;
    const vision: Extractor = {
      name: 'vision',
      canHandle: () => true,
      extract: async () => {
        visionCalls += 1;
        return result([tx({ ticker: 'MSFT' })], { extractor: 'vision' });
      },
    };
    const cheap: Extractor = {
      name: 'openRouterText',
      canHandle: () => true,
      extract: async (input) => {
        cheapCalls += 1;
        expect(input.extractedText).toContain('AAPL');
        return result([tx({ ticker: 'AAPL' })], { extractor: 'openRouterText' });
      },
    };
    const house = new HousePdfExtractor(extractor('textPdf', emptyText), vision, cheap);

    const out = await house.extract({
      filing: filing({ docId: 'H-2025-20030634', docKind: 'text_pdf' }),
    });

    expect(cheapCalls).toBe(1);
    expect(visionCalls).toBe(0);
    expect(out.extractor).toBe('openRouterText');
    expect(out.transactions[0]?.ticker).toBe('AAPL');
  });

  it('skips a doc when cheap text returns Unauthorized, without Files', async () => {
    const emptyText = result([], {
      extractor: 'textPdf',
      raw: 'SP  Apple Inc. (AAPL) [ST]\nP  06/14/2024  06/20/2024  $1,001 - $15,000',
    });
    let visionCalls = 0;
    const vision: Extractor = {
      name: 'vision',
      canHandle: () => true,
      extract: async () => {
        visionCalls += 1;
        return result([tx({ ticker: 'MSFT' })], { extractor: 'vision' });
      },
    };
    const cheap: Extractor = {
      name: 'openRouterText',
      canHandle: () => true,
      extract: async () => {
        throw new Error('openRouterReply:unauth_reply: 401 Unauthorized');
      },
    };
    const house = new HousePdfExtractor(extractor('textPdf', emptyText), vision, cheap);
    const out = await house.extract({
      filing: filing({ docId: 'H-2025-20030634', docKind: 'text_pdf' }),
    });
    expect(visionCalls).toBe(0);
    expect(out.extractor).toBe('textPdf');
    expect(out.transactions).toEqual([]);
  });

  it('still fail-closes a proven OpenRouter dead-key rejection', async () => {
    const emptyText = result([], {
      extractor: 'textPdf',
      raw: 'SP  Apple Inc. (AAPL) [ST]\nP  06/14/2024  06/20/2024  $1,001 - $15,000',
    });
    const cheap: Extractor = {
      name: 'openRouterText',
      canHandle: () => true,
      extract: async () => {
        throw new Error('openRouterText: OpenRouter API 401 Unauthorized {"error":{"message":"User not found.","code":401}}');
      },
    };
    const house = new HousePdfExtractor(
      extractor('textPdf', emptyText),
      extractor('vision', result([])),
      cheap,
    );
    await expect(house.extract({
      filing: filing({ docId: 'H-2025-20030634', docKind: 'text_pdf' }),
    })).rejects.toThrow(/User not found/);
  });

  it('does not claim non-House scanned PDFs', () => {
    const text = extractor('textPdf', result([]));
    const vision = extractor('vision', result([]));
    const house = new HousePdfExtractor(text, vision);

    expect(house.canHandle(filing({ chamber: 'senate' }))).toBe(false);
  });
});

describe('buildExtractorPipeline routing', () => {
  // Construction does no I/O (secrets/keys resolve lazily inside extract()),
  // so a bare fake Env is safe here — this only exercises canHandle() routing.
  const pipeline = buildExtractorPipeline({} as Env);

  function firstMatch(f: Filing): string | undefined {
    return pipeline.find((e) => e.canHandle(f))?.name;
  }

  it('routes executive text_pdf filings to ogeText, not the House-tuned textPdf or vision', () => {
    expect(firstMatch(filing({ chamber: 'executive', docKind: 'text_pdf' }))).toBe('ogeText');
  });

  it('still routes House text_pdf filings through housePdf (text-first, Files only for real scans)', () => {
    const name = firstMatch(filing({ chamber: 'house', docKind: 'text_pdf' }));
    expect(name).toMatch(/^housePdf\(/);
    expect(name).toContain('openRouterText');
  });

  it('still routes Senate HTML filings to senateHtml', () => {
    expect(firstMatch(filing({ chamber: 'senate', docKind: 'senate_html' }))).toBe('senateHtml');
  });

  // KEEPOUT #1959: that PR routes executive scanned_pdf to ogePdf (unpdf, then
  // fail-soft OpenRouter OCR). This branch must not implement OgePdfExtractor
  // or change this expectation to steal that lane.
  it('leaves executive scanned_pdf filings on the vision path (ogeText only claims text_pdf)', () => {
    const name = firstMatch(filing({ chamber: 'executive', docKind: 'scanned_pdf' }));
    expect(name).toMatch(/^arbitrating\(/);
  });
});
