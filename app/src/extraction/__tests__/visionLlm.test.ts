import { describe, it, expect, vi, afterEach } from 'vitest';
import { VisionLlmExtractor } from '../visionLlm';
import type { Env, Filing } from '../../shared/types';

const filing = (): Filing => ({
  docId: 'doc1',
  chamber: 'house',
  filerId: 'F1',
  filingType: 'P',
  filedDate: '2024-07-01',
  sourceUrl: 'https://x',
  rawObjectKey: 'raw/house/doc1.pdf',
  ingestStatus: 'classified',
  docKind: 'scanned_pdf',
  extractor: null,
  modelVersion: null,
  confidence: null,
  firstSeenAt: '2024-07-01T00:00:00.000Z',
  sourceUpdatedAt: null,
  error: null,
});

const env = { GEMINI_API_KEY: 'test-key' } as unknown as Env;
function makeBytes(s: string): ArrayBuffer {
  const src = new TextEncoder().encode(s);
  const buf = new ArrayBuffer(src.byteLength);
  new Uint8Array(buf).set(src);
  return buf;
}
const bytes: ArrayBuffer = makeBytes('%PDF-1.7 scanned');

const mockGenerateContent = vi.fn();

vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: class {
      models = {
        generateContent: mockGenerateContent
      };
    }
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  mockGenerateContent.mockClear();
});

describe('VisionLlmExtractor', () => {
  it('canHandle only scanned_pdf', () => {
    const ex = new VisionLlmExtractor(env);
    expect(ex.canHandle({ ...filing(), docKind: 'scanned_pdf' })).toBe(true);
    expect(ex.canHandle({ ...filing(), docKind: 'text_pdf' })).toBe(false);
  });

  it('POSTs to Gemini once and maps the JSON array to ParsedTx[]', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      text: JSON.stringify([
        {
          txDate: '2024-06-14',
          owner: 'spouse',
          assetName: 'Apple Inc.',
          ticker: 'aapl',
          assetType: 'ST',
          txType: 'P',
          amountRange: '$1,001 - $15,000',
          isOption: false,
          capGainsOver200: false,
          confidence: 0.95,
        },
      ]),
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15
      },
      modelVersion: 'gemini-3.5-flash-test'
    });

    const ex = new VisionLlmExtractor(env);
    const result = await ex.extract({ filing: filing(), bytes });

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);

    expect(result.extractor).toBe('visionLlm');
    expect(result.modelVersion).toBeTruthy();
    expect(result.transactions).toHaveLength(1);
    const t = result.transactions[0];
    expect(t.ticker).toBe('AAPL');
    expect(t.amountMin).toBe(1001);
    expect(t.amountMax).toBe(15000);
    // Conservative: per-row confidence capped at the default floor (~0.6).
    expect(t.confidence).toBeLessThanOrEqual(0.6);
  });

  it('throws on an API error', async () => {
    mockGenerateContent.mockRejectedValueOnce(
      Object.assign(new Error('overloaded'), { status: 503 })
    );
    const ex = new VisionLlmExtractor(env);
    await expect(ex.extract({ filing: filing(), bytes })).rejects.toThrow(/overloaded/);
  });
});
