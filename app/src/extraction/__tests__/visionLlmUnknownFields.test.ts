import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import type { Env } from '../../shared/types';
import { hasHardFailureFlags, scoreFields } from '../normalizer';
import {
  EXTRACTION_PROMPT_VERSION,
  VisionLlmExtractor,
  toParsedTx,
} from '../visionLlm';

afterEach(() => vi.unstubAllGlobals());

describe('vision LLM unreadable fields', () => {
  it('allows nullable asset/type fields and preserves an invalid txType for hard-flagging', async () => {
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      ({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify([
                      {
                        assetName: null,
                        txType: null,
                        amountRange: '$1,001 - $15,000',
                        isOption: false,
                        capGainsOver200: false,
                      },
                    ]),
                  },
                ],
              },
            },
          ],
        }),
      }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await new VisionLlmExtractor(
      {} as Env,
      { apiKey: 'gemini-test', model: 'gemini-3.5-flash' },
    ).extract({
      filing: { docKind: 'scanned_pdf', chamber: 'house' } as never,
      bytes: new TextEncoder().encode('%PDF-1.4').buffer as ArrayBuffer,
    });

    const request = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    const properties = request.generationConfig.responseSchema.items.properties;
    expect(properties.assetName).toMatchObject({ type: 'STRING', nullable: true });
    expect(properties.txType).toMatchObject({ type: 'STRING', nullable: true });
    expect(properties.isOption).toMatchObject({ type: 'BOOLEAN', nullable: true });
    expect(properties.capGainsOver200).toMatchObject({ type: 'BOOLEAN', nullable: true });

    const tx = result.transactions[0];
    expect(tx.assetName).toBe('');
    expect(tx.txType).toBe('');
    expect(tx.txType).not.toBe('P');

    const scored = scoreFields(
      tx.confidence,
      {
        ticker: tx.ticker,
        assetName: tx.assetName,
        amountMin: tx.amountMin,
        amountMax: tx.amountMax,
        txType: tx.txType,
        txDate: tx.txDate,
      },
      null,
      () => null,
    );
    expect(scored.flags).toContain('bad_tx_type');
    expect(hasHardFailureFlags([{ flags: scored.flags }])).toBe(true);
  });

  it('marks unreadable boolean disclosure fields instead of silently treating them as false', () => {
    const tx = toParsedTx({
      assetName: 'Apple Inc.',
      txType: 'P',
      amountRange: '$1,001 - $15,000',
      isOption: null,
      capGainsOver200: null,
    });
    expect(tx).toMatchObject({
      isOption: false,
      capGainsOver200: false,
      extractionWarnings: ['unreadable_is_option', 'unreadable_cap_gains'],
    });
    expect(hasHardFailureFlags([{ flags: tx.extractionWarnings ?? [] }])).toBe(true);
  });

  it('uses the Executive OGE prompt for executive filings', async () => {
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '[]' }] } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    await new VisionLlmExtractor(
      {} as Env,
      { apiKey: 'gemini-test', model: 'gemini-3.5-flash' },
    ).extract({
      filing: { docKind: 'scanned_pdf', chamber: 'executive' } as never,
      bytes: new TextEncoder().encode('%PDF-1.4').buffer as ArrayBuffer,
    });

    const request = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    expect(request.contents[0].parts[0].text).toContain('Executive Branch OGE Form 278-T');
    expect(request.contents[0].parts[0].text).not.toContain('congressional STOCK Act');
  });

  it('retains valid transaction types and exports a stable prompt version', () => {
    expect(EXTRACTION_PROMPT_VERSION).toBe('stock-act-ptr-v2');
    expect(toParsedTx({ txType: 'P', assetName: 'Asset' }).txType).toBe('P');
    expect(toParsedTx({ txType: 'S', assetName: 'Asset' }).txType).toBe('S');
    expect(toParsedTx({ txType: 'E', assetName: 'Asset' }).txType).toBe('E');
  });

  it('attaches billed usage from successful chunks when a later chunk fails', async () => {
    const pdf = await PDFDocument.create();
    for (let page = 0; page < 16; page++) pdf.addPage();
    const bytes = await pdf.save();
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '[]' }] } }],
        usageMetadata: {
          promptTokenCount: 120,
          candidatesTokenCount: 9,
          thoughtsTokenCount: 3,
          cachedContentTokenCount: 25,
        },
        modelVersion: 'gemini-3.5-flash-20260713',
        responseId: 'gemini-request-1',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('unprocessable chunk', { status: 422 }));
    vi.stubGlobal('fetch', fetchSpy);

    const extraction = new VisionLlmExtractor(
      {} as Env,
      { apiKey: 'gemini-test', model: 'gemini-3.5-flash' },
    ).extract({
      filing: { docKind: 'scanned_pdf', chamber: 'house' } as never,
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    });

    await expect(extraction).rejects.toMatchObject({
      usage: {
        promptTokens: 120,
        completionTokens: 12,
        cachedTokens: 25,
      },
      resolvedModel: 'gemini-3.5-flash-20260713',
      providerRequestId: 'gemini-request-1',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
