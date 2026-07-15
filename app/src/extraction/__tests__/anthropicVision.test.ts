import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import type { Env, Filing } from '../../shared/types';
import { AnthropicVisionExtractor } from '../anthropicVision';

async function validPdfBytes(): Promise<ArrayBuffer> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  const saved = await pdf.save();
  return saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer;
}

const filing = (): Filing => ({
  docId: 'S-1',
  chamber: 'senate',
  filerId: 'F1',
  filingType: 'P',
  filedDate: '2026-06-19',
  sourceUrl: 'https://x',
  rawObjectKey: 'raw/senate/S-1.pdf',
  ingestStatus: 'classified',
  docKind: 'scanned_pdf',
  extractor: null,
  modelVersion: null,
  confidence: null,
  firstSeenAt: '2026-06-19T00:00:00.000Z',
  sourceUpdatedAt: null,
  error: null,
});

const env = { ANTHROPIC_API_KEY: 'test-key' } as unknown as Env;

afterEach(() => vi.unstubAllGlobals());

describe('AnthropicVisionExtractor: invalid-PDF pre-validation', () => {
  it('short-circuits BEFORE any provider call when the PDF is unparseable by pdf-lib', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const ex = new AnthropicVisionExtractor(env);
    await expect(
      ex.extract({ filing: filing(), bytes: new TextEncoder().encode('not a pdf').buffer as ArrayBuffer }),
    ).rejects.toThrow('anthropic: invalid PDF (unparseable by pdf-lib)');

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('AnthropicVisionExtractor: output-truncation handling', () => {
  const truncatedReply = (extra: Record<string, unknown> = {}) => ({
    ok: true,
    json: async () => ({
      stop_reason: 'max_tokens',
      content: [{
        type: 'text',
        text: '[{"ticker":"AAPL","assetName":"Apple Inc.","txType":"P","amountRange":"$1,001 - $15,000"},{"ticker":"MSFT","assetName":"Micro',
      }],
      usage: { input_tokens: 400, output_tokens: 8000 },
      ...extra,
    }),
  } as unknown as Response);

  it('retries once with a doubled token budget when the first reply is cut off, and succeeds cleanly if the retry completes', async () => {
    const bytes = await validPdfBytes();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(truncatedReply())
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          stop_reason: 'end_turn',
          content: [{
            type: 'text',
            text: '[{"ticker":"AAPL","assetName":"Apple Inc.","txType":"P","amountRange":"$1,001 - $15,000"},{"ticker":"MSFT","assetName":"Microsoft","txType":"S","amountRange":"$15,001 - $50,000"}]',
          }],
          usage: { input_tokens: 400, output_tokens: 150 },
        }),
      } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const ex = new AnthropicVisionExtractor(env, { model: 'claude-sonnet-4-6' });
    const result = await ex.extract({ filing: filing(), bytes });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(firstBody.max_tokens).toBe(8000);
    expect(secondBody.max_tokens).toBe(16000);

    expect(result.transactions).toHaveLength(2);
    expect(result.transactions.every((r) => !r.extractionWarnings?.includes('salvaged_truncated_output'))).toBe(true);
    expect(result.usage).toMatchObject({ promptTokens: 800, completionTokens: 8150 });
  });

  it('salvages the complete leading rows and marks them when the retry is STILL truncated', async () => {
    const bytes = await validPdfBytes();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(truncatedReply())
      .mockResolvedValueOnce(truncatedReply());
    vi.stubGlobal('fetch', fetchMock);

    const ex = new AnthropicVisionExtractor(env, { model: 'claude-sonnet-4-6' });
    const result = await ex.extract({ filing: filing(), bytes });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].ticker).toBe('AAPL');
    expect(result.transactions[0].extractionWarnings).toContain('salvaged_truncated_output');
  });

  it('does not retry when the first reply completes normally', async () => {
    const bytes = await validPdfBytes();
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '[{"ticker":"AAPL","assetName":"Apple Inc.","txType":"P","amountRange":"$1,001 - $15,000"}]' }],
        usage: { input_tokens: 400, output_tokens: 50 },
      }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const ex = new AnthropicVisionExtractor(env, { model: 'claude-sonnet-4-6' });
    const result = await ex.extract({ filing: filing(), bytes });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.transactions).toHaveLength(1);
  });
});
