import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env, Filing } from '../../shared/types.ts';
import { OpenRouterTextExtractor } from '../openRouterText.ts';
import { OPENROUTER_FILES_HOLD_USD, TYPED_PTR_CHEAP_PATH_USD_CEILING } from '../extractRouting.ts';

const filing = (): Filing => ({
  docId: 'H-2025-20030634',
  chamber: 'house',
  filerId: 'F1',
  filingType: 'P',
  filedDate: '2026-06-24',
  sourceUrl: 'https://example.test/doc.pdf',
  rawObjectKey: 'raw/doc.pdf',
  ingestStatus: 'classified',
  docKind: 'text_pdf',
  extractor: null,
  modelVersion: null,
  confidence: null,
  firstSeenAt: '2026-06-24T00:00:00.000Z',
  sourceUpdatedAt: null,
  error: null,
});

const env = { OPENROUTER_API_KEY: 'test-key' } as unknown as Env;

afterEach(() => vi.unstubAllGlobals());

function lastRequestBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as { body?: string };
  return JSON.parse(init.body ?? '{}') as Record<string, unknown>;
}

describe('OpenRouterTextExtractor', () => {
  it('sends extracted text only — no Files attachment and no file-parser plugin', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'gen-text-1',
        model: 'google/gemini-3.5-flash-lite',
        choices: [{
          message: {
            content: JSON.stringify({
              transactions: [{
                ticker: 'AAPL',
                assetName: 'Apple Inc.',
                txType: 'B',
                amountRange: '$1,001 - $15,000',
                txDate: '2026-05-01',
                owner: 'Self',
                assetType: 'ST',
                confidence: 0.7,
              }],
            }),
          },
        }],
        usage: { prompt_tokens: 800, completion_tokens: 120, cost: 0.0012 },
      }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const ex = new OpenRouterTextExtractor(env);
    const result = await ex.extract({
      filing: filing(),
      extractedText: 'SP  Apple Inc. (AAPL) [ST]\nP  06/14/2024  06/20/2024  $1,001 - $15,000',
    });

    expect(result.transactions[0]?.ticker).toBe('AAPL');
    expect(result.usage?.costUsd).toBe(0.0012);
    expect(result.usage?.costUsd).toBeLessThan(OPENROUTER_FILES_HOLD_USD);
    expect(result.usage?.costUsd).toBeLessThan(TYPED_PTR_CHEAP_PATH_USD_CEILING);

    const body = lastRequestBody(fetchMock);
    const messages = body.messages as Array<{ content?: unknown }>;
    expect(JSON.stringify(messages)).not.toContain('"type":"file"');
    expect(JSON.stringify(body.plugins)).not.toContain('file-parser');
    expect(body.plugins).toEqual([{ id: 'response-healing' }]);
    expect(String(messages[0]?.content)).toContain('DOCUMENT TEXT');
    expect(String(messages[0]?.content)).toContain('Apple Inc.');
  });

  it('refuses to run without extracted text (does not fall back to Files)', async () => {
    const ex = new OpenRouterTextExtractor(env);
    await expect(ex.extract({ filing: filing() })).rejects.toThrow(/no extracted text/);
  });
});
