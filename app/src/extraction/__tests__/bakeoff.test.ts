import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Env } from '../../shared/types';
import {
  computeConsensusAgreement,
  extractXaiResponseText,
  parseLlamaParseMarkdown,
  parseMistralOcrResponse,
  runCandidateOnDoc,
  summarizeModels,
  type BakeoffCandidate,
  type CandidateDocResult,
} from '../bakeoff';

function r(
  provider: CandidateDocResult['provider'],
  model: string,
  docId: string,
  rowKeys: string[],
  over: Partial<CandidateDocResult> = {},
): CandidateDocResult {
  return {
    provider,
    model,
    docId,
    ok: true,
    latencyMs: 100,
    rowCount: rowKeys.length,
    rowKeys,
    avgConfidence: 0,
    rows: [],
    ...over,
  };
}

describe('computeConsensusAgreement', () => {
  it('scores each model by the fraction of the majority-consensus rows it recovered', () => {
    // doc1: A=[k1,k2,k3], B=[k1,k2], C=[k1]; majority(3)=2 => consensus {k1,k2}
    const results = [
      r('gemini', 'g', 'doc1', ['k1', 'k2', 'k3']),
      r('openai', 'o', 'doc1', ['k1', 'k2']),
      r('anthropic', 'a', 'doc1', ['k1']),
    ];
    const agree = computeConsensusAgreement(results);
    expect(agree.get('gemini:g')).toBeCloseTo(1.0); // recovered k1,k2
    expect(agree.get('openai:o')).toBeCloseTo(1.0); // recovered k1,k2
    expect(agree.get('anthropic:a')).toBeCloseTo(0.5); // recovered only k1 of {k1,k2}
  });

  it('skips documents with fewer than two successful models (no consensus)', () => {
    const results = [
      r('gemini', 'g', 'doc1', ['k1', 'k2']),
      r('openai', 'o', 'doc1', [], { ok: false, error: 'boom', rowCount: 0 }),
    ];
    // Only one ok model -> no consensus -> no agreement recorded.
    expect(computeConsensusAgreement(results).size).toBe(0);
  });

  it('averages agreement across multiple documents (3 models => majority is 2)', () => {
    const results = [
      // doc1: all three agree on {k1,k2} -> consensus {k1,k2}
      r('gemini', 'g', 'doc1', ['k1', 'k2']),
      r('openai', 'o', 'doc1', ['k1', 'k2']),
      r('anthropic', 'a', 'doc1', ['k1', 'k2']),
      // doc2: g & o find {k3,k4}, a finds only {k3}; votes k3=3,k4=2 => consensus {k3,k4}
      r('gemini', 'g', 'doc2', ['k3', 'k4']),
      r('openai', 'o', 'doc2', ['k3', 'k4']),
      r('anthropic', 'a', 'doc2', ['k3']),
    ];
    const agree = computeConsensusAgreement(results);
    expect(agree.get('gemini:g')).toBeCloseTo(1.0); // (1 + 1) / 2
    expect(agree.get('openai:o')).toBeCloseTo(1.0); // (1 + 1) / 2
    expect(agree.get('anthropic:a')).toBeCloseTo(0.75); // (1 + 0.5) / 2
  });
});

describe('summarizeModels', () => {
  const candidates: BakeoffCandidate[] = [
    { provider: 'gemini', model: 'g' },
    { provider: 'openai', model: 'o' },
  ];

  it('rolls up rows, failures, latency, and agreement per model', () => {
    const results = [
      r('gemini', 'g', 'doc1', ['k1', 'k2'], { latencyMs: 200 }),
      r('gemini', 'g', 'doc2', ['k1'], { latencyMs: 100 }),
      r('openai', 'o', 'doc1', ['k1', 'k2'], { latencyMs: 400 }),
      r('openai', 'o', 'doc2', [], { ok: false, error: 'parse fail', rowCount: 0, latencyMs: 50 }),
    ];
    const [g, o] = summarizeModels(candidates, results);

    expect(g.label).toBe('gemini:g');
    expect(g.docsAttempted).toBe(2);
    expect(g.docsOk).toBe(2);
    expect(g.failures).toBe(0);
    expect(g.totalRows).toBe(3);
    expect(g.avgRowsPerOkDoc).toBe(1.5);
    expect(g.avgLatencyMs).toBe(150);

    expect(o.failures).toBe(1);
    expect(o.docsOk).toBe(1);
    expect(o.totalRows).toBe(2);
    expect(o.avgLatencyMs).toBe(225); // (400 + 50) / 2 over attempts, not ok-only
  });

  it('emits a zeroed row for a model that produced no results', () => {
    const [g, o] = summarizeModels(candidates, []);
    for (const s of [g, o]) {
      expect(s.docsAttempted).toBe(0);
      expect(s.totalRows).toBe(0);
      expect(s.avgRowsPerOkDoc).toBe(0);
      expect(s.consensusAgreement).toBe(0);
    }
  });
});

describe('parseMistralOcrResponse', () => {
  it('maps a structured document_annotation (JSON string) to ParsedTx[]', () => {
    const annotation = JSON.stringify({
      transactions: [
        { txDate: '2026-05-05', owner: 'self', assetName: 'Apple Inc.', ticker: 'AAPL', assetType: 'ST', txType: 'P', amountRange: '$1,001 - $15,000', isOption: false },
        { txDate: '2026-05-06', owner: 'spouse', assetName: 'Intel Corp', ticker: 'INTC', assetType: 'ST', txType: 'S', amountRange: '$15,001 - $50,000', isOption: false },
      ],
    });
    const rows = parseMistralOcrResponse({ document_annotation: annotation, pages: [] });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ ticker: 'AAPL', txType: 'P', amountMin: 1001, amountMax: 15000 });
    expect(rows[1]).toMatchObject({ ticker: 'INTC', txType: 'S' });
  });

  it('accepts a document_annotation already parsed into an object', () => {
    const rows = parseMistralOcrResponse({
      document_annotation: { transactions: [{ assetName: 'Microsoft', ticker: 'MSFT', txType: 'P', amountRange: '$1,001 - $15,000' }] },
    });
    expect(rows[0].ticker).toBe('MSFT');
  });

  it('falls back to a fenced JSON block in the OCR markdown', () => {
    const md = 'Some OCR text\n```json\n{"transactions":[{"assetName":"Tesla","ticker":"TSLA","txType":"P","amountRange":"$1,001 - $15,000"}]}\n```\n';
    const rows = parseMistralOcrResponse({ pages: [{ markdown: md }] });
    expect(rows[0].ticker).toBe('TSLA');
  });

  it('throws when there is neither an annotation nor a JSON block', () => {
    expect(() => parseMistralOcrResponse({ pages: [{ markdown: 'plain text only' }] })).toThrow(/no document_annotation/);
  });
});

describe('parseLlamaParseMarkdown', () => {
  const txJson = '[{"assetName":"Apple Inc.","ticker":"AAPL","txType":"P","amountRange":"$1,001 - $15,000","txDate":"2026-05-05","owner":"self","assetType":"ST","isOption":false}]';

  it('extracts a fenced ```json block', () => {
    const md = `Some OCR preamble.\n\`\`\`json\n${txJson}\n\`\`\`\n`;
    const rows = parseLlamaParseMarkdown(md);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ticker: 'AAPL', txType: 'P', amountMin: 1001, amountMax: 15000 });
  });

  it('extracts a fenced ``` block without the json tag', () => {
    const md = `\`\`\`\n${txJson}\n\`\`\``;
    expect(parseLlamaParseMarkdown(md)[0].ticker).toBe('AAPL');
  });

  it('falls back to a bare JSON array when no fenced block is present', () => {
    const md = `Here are the transactions:\n${txJson}\nEnd of output.`;
    expect(parseLlamaParseMarkdown(md)[0].ticker).toBe('AAPL');
  });

  it('parses multiple transactions', () => {
    const multi = '[{"assetName":"AAPL","ticker":"AAPL","txType":"P","amountRange":"$1,001 - $15,000"},{"assetName":"MSFT","ticker":"MSFT","txType":"S","amountRange":"$15,001 - $50,000"}]';
    const rows = parseLlamaParseMarkdown(`\`\`\`json\n${multi}\n\`\`\``);
    expect(rows).toHaveLength(2);
    expect(rows[1].ticker).toBe('MSFT');
  });

  it('throws when no JSON array is found in the markdown', () => {
    expect(() => parseLlamaParseMarkdown('Plain text with no JSON at all.')).toThrow(/no JSON array/);
  });
});

describe('runCandidateOnDoc (openai): token usage capture', () => {
  const env = { OPENAI_API_KEY: 'sk-openai-test' } as unknown as Env;
  const candidate: BakeoffCandidate = { provider: 'openai', model: 'gpt-4o' };
  const bytes = new TextEncoder().encode('%PDF-1.4 fake').buffer as ArrayBuffer;
  const okContent = '{"transactions":[{"ticker":"AAPL","assetName":"Apple Inc.","txType":"P","amountRange":"$1,001 - $15,000"}]}';

  afterEach(() => vi.unstubAllGlobals());

  it('extracts promptTokens/completionTokens/cachedTokens from a usage field present in the response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: okContent } }],
            usage: { prompt_tokens: 500, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 100 } },
          }),
        }) as unknown as Response,
      ),
    );

    const result = await runCandidateOnDoc(env, candidate, 'doc1', bytes);
    expect(result.ok).toBe(true);
    expect(result.usage).toEqual({ promptTokens: 500, completionTokens: 40, cachedTokens: 100 });
  });

  it('leaves usage undefined when the response omits the usage field (e.g. older models)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ({
          ok: true,
          json: async () => ({ choices: [{ message: { content: okContent } }] }),
        }) as unknown as Response,
      ),
    );

    const result = await runCandidateOnDoc(env, candidate, 'doc1', bytes);
    expect(result.ok).toBe(true);
    expect(result.usage).toBeUndefined();
  });

  it('leaves usage undefined on the API-failure error path', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ({ ok: false, status: 500, text: async () => 'server error' }) as unknown as Response,
      ),
    );

    const result = await runCandidateOnDoc(env, candidate, 'doc1', bytes);
    expect(result.ok).toBe(false);
    expect(result.usage).toBeUndefined();
  });
});

describe('extractXaiResponseText', () => {
  it('prefers the convenience output_text field', () => {
    expect(extractXaiResponseText({ output_text: '{"transactions":[]}' })).toBe('{"transactions":[]}');
  });

  it('concatenates output[].content[].text parts (Responses message shape)', () => {
    const payload = {
      output: [
        { content: [{ type: 'output_text', text: '{"transactions":' }, { type: 'output_text', text: '[{"ticker":"AAPL"}]}' }] },
      ],
    };
    expect(extractXaiResponseText(payload)).toBe('{"transactions":[{"ticker":"AAPL"}]}');
  });

  it('throws when there is no text in the output', () => {
    expect(() => extractXaiResponseText({ output: [{ content: [] }] })).toThrow(/no text/);
  });
});
