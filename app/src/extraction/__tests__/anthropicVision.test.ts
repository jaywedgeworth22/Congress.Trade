import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import type { Env, Filing } from '../../shared/types';
import { AnthropicVisionExtractor } from '../anthropicVision';
import { arrayBufferToBase64 } from '../visionLlm';

async function validPdfBytes(): Promise<ArrayBuffer> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  const saved = await pdf.save();
  return saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer;
}

/** A hand-written minimal PDF (not pdf-lib-generated) that pdf-lib CAN parse
 *  but whose pdf-lib resave produces DIFFERENT bytes — lets tests assert
 *  "the ORIGINAL bytes were sent, not a pdf-lib resave". */
function handWrittenPdfBytes(): ArrayBuffer {
  const text = [
    '%PDF-1.4',
    '1 0 obj',
    '<< /Type /Catalog /Pages 2 0 R >>',
    'endobj',
    '2 0 obj',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    'endobj',
    '3 0 obj',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
    'endobj',
    'xref',
    '0 4',
    '0000000000 65535 f ',
    '0000000009 00000 n ',
    '0000000058 00000 n ',
    '0000000115 00000 n ',
    'trailer',
    '<< /Size 4 /Root 1 0 R >>',
    'startxref',
    '190',
    '%%EOF',
  ].join('\n');
  const src = new TextEncoder().encode(text);
  const buf = new ArrayBuffer(src.byteLength);
  new Uint8Array(buf).set(src);
  return buf;
}

/** A 400 response shaped like the receipted 2026-07-15 invalid-PDF failure
 *  (doc H-2026-20034954; req_011Cd4nNWmv3LPBZwfys7KhM /
 *  req_011Cd4nNpBAjfCCXj29EqSF7). */
const invalidPdfReply = (): Response => ({
  ok: false,
  status: 400,
  statusText: 'Bad Request',
  text: async () => JSON.stringify({
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: 'messages.0.content.0.pdf.source.base64.data: The PDF specified was not valid.',
    },
  }),
}) as unknown as Response;

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
    // The ORIGINAL bytes are sent, not a pdf-lib resave (2026-07-15 regression fix).
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.messages[0].content[0].source.data).toBe(arrayBufferToBase64(bytes));
  });
});

describe('AnthropicVisionExtractor: invalid-PDF repair retry (2026-07-15 regression)', () => {
  const successReply = (): Response => ({
    ok: true,
    json: async () => ({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '[{"ticker":"AAPL","assetName":"Apple Inc.","txType":"P","amountRange":"$1,001 - $15,000"}]' }],
      usage: { input_tokens: 400, output_tokens: 50 },
    }),
  }) as unknown as Response;

  it('sends the ORIGINAL bytes first; on a 400 invalid-PDF response, retries exactly once with resaved bytes and uses the success result', async () => {
    const bytes = handWrittenPdfBytes();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(invalidPdfReply())
      .mockResolvedValueOnce(successReply());
    vi.stubGlobal('fetch', fetchMock);

    const ex = new AnthropicVisionExtractor(env, { model: 'claude-sonnet-4-6' });
    const result = await ex.extract({ filing: filing(), bytes });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(firstBody.messages[0].content[0].source.data).toBe(arrayBufferToBase64(bytes));
    expect(secondBody.messages[0].content[0].source.data).not.toBe(firstBody.messages[0].content[0].source.data);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].ticker).toBe('AAPL');
  });

  it('surfaces the ORIGINAL 400 invalid-PDF error once when the repair retry also fails (no infinite retry)', async () => {
    const bytes = handWrittenPdfBytes();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(invalidPdfReply())
      .mockResolvedValueOnce(invalidPdfReply());
    vi.stubGlobal('fetch', fetchMock);

    const ex = new AnthropicVisionExtractor(env, { model: 'claude-sonnet-4-6' });
    await expect(ex.extract({ filing: filing(), bytes })).rejects.toThrow('The PDF specified was not valid');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not repair-retry on a non-invalid-PDF failure', async () => {
    const bytes = await validPdfBytes();
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'internal server error',
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const ex = new AnthropicVisionExtractor(env, { model: 'claude-sonnet-4-6' });
    await expect(ex.extract({ filing: filing(), bytes })).rejects.toThrow('Anthropic API 500');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
