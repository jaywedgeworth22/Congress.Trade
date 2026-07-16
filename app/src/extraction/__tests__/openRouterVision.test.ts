import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env, Filing } from '../../shared/types';
import { OpenRouterVisionExtractor } from '../openRouterVision';

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

const env = { OPENROUTER_API_KEY: 'test-key' } as unknown as Env;

afterEach(() => vi.unstubAllGlobals());

describe('OpenRouterVisionExtractor', () => {
  it('correctly maps the openrouter JSON response', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'gen-123',
        model: 'qwen/qwen-2.5-vl-72b-instruct:free',
        choices: [
          {
            message: {
              content: JSON.stringify({
                transactions: [
                  {
                    ticker: 'AAPL',
                    assetName: 'Apple Inc.',
                    txType: 'P',
                    amountRange: '$1,001 - $15,000',
                    txDate: '2026-05-01',
                    owner: 'Self',
                    assetType: 'Stock',
                  },
                ],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const ex = new OpenRouterVisionExtractor(env);
    const result = await ex.extract({
      filing: filing(),
      bytes: new TextEncoder().encode('dummy pdf bytes').buffer as ArrayBuffer,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    
    // Verify the output maps correctly
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].ticker).toBe('AAPL');
    expect(result.transactions[0].assetName).toBe('Apple Inc.');
    
    // Verify usage mapping
    expect(result.usage).toMatchObject({ promptTokens: 100, completionTokens: 50 });
    
    // Verify extractor name
    expect(result.extractor).toBe('openRouterVision');
  });

  it('throws an error if no API key is provided', async () => {
    const emptyEnv = {} as Env;
    const ex = new OpenRouterVisionExtractor(emptyEnv);
    
    await expect(
      ex.extract({
        filing: filing(),
        bytes: new TextEncoder().encode('dummy pdf bytes').buffer as ArrayBuffer,
      }),
    ).rejects.toThrow('openRouterVision: API key is not configured');
  });

  it('attaches usage to error when parsing fails', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'gen-123',
        model: 'qwen/qwen-2.5-vl-72b-instruct:free',
        choices: [
          {
            message: {
              content: 'definitely not valid JSON',
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const ex = new OpenRouterVisionExtractor(env);
    let caughtErr: Error & { usage?: any } | undefined;
    
    try {
      await ex.extract({
        filing: filing(),
        bytes: new TextEncoder().encode('dummy pdf bytes').buffer as ArrayBuffer,
      });
    } catch (err) {
      caughtErr = err as any;
    }
    
    expect(caughtErr).toBeDefined();
    expect(caughtErr?.message).toContain('could not parse model JSON');
    expect(caughtErr?.usage).toMatchObject({ promptTokens: 100, completionTokens: 50 });
  });
});
