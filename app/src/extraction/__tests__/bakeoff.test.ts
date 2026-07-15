import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Env } from '../../shared/types';
import {
  computeConsensusAgreement,
  DEFAULT_CANDIDATES,
  isRetiredDisclosureCandidate,
  openAiDisclosureReasoningEffort,
  upgradeRetiredDisclosureCandidate,
  EXTRACTION_SCHEMA_VERSION,
  extractProviderReportedPageCount,
  extractXaiResponseText,
  MISTRAL_ANNOTATION_SCHEMA,
  llamaParseModeParameters,
  parseLlamaParseMarkdown,
  parseMistralOcrResponse,
  runCandidateOnDoc,
  summarizeModels,
  type BakeoffCandidate,
  type CandidateDocResult,
} from '../bakeoff';
import { EXECUTIVE_SYSTEM_PROMPT } from '../visionLlm';

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

describe('llamaParseModeParameters', () => {
  it('maps display tiers to explicit v1 parse modes used by the public rate card', () => {
    expect(llamaParseModeParameters('fast')).toEqual({ parse_mode: 'parse_page_without_llm' });
    expect(llamaParseModeParameters('cost-effective')).toEqual({
      parse_mode: 'parse_page_with_llm',
      high_res_ocr: 'true',
    });
    expect(llamaParseModeParameters('agentic')).toEqual({
      parse_mode: 'parse_page_with_agent',
      model: 'gemini-2.5-flash',
      high_res_ocr: 'true',
    });
    expect(() => llamaParseModeParameters('agentic-plus')).toThrow(/unsupported benchmark mode/);
  });
});

describe('extractProviderReportedPageCount', () => {
  it('accepts explicit provider page meters but never derives pages from unrelated data', () => {
    expect(extractProviderReportedPageCount({ usage: { pages_processed: 7 } })).toBe(7);
    expect(extractProviderReportedPageCount({ pages: [{}, {}, {}] })).toBe(3);
    expect(extractProviderReportedPageCount({ bytes: 9_000_000 })).toBeUndefined();
  });
});

describe('runCandidateOnDoc (openai): token usage capture', () => {
  const env = { OPENAI_API_KEY: 'sk-openai-test' } as unknown as Env;
  const candidate: BakeoffCandidate = { provider: 'openai', model: 'gpt-5.6-terra' };
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
            status: 'completed',
            output_text: okContent,
            usage: { input_tokens: 500, output_tokens: 40, input_tokens_details: { cached_tokens: 100 } },
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
          json: async () => ({ status: 'completed', output_text: okContent }),
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

  it('uses high-detail Responses PDF input and captures GPT-5.6 usage metadata', async () => {
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      ({
        ok: true,
        json: async () => ({
          id: 'resp_56',
          model: 'gpt-5.6-terra',
          service_tier: 'default',
          status: 'completed',
          output_text: okContent,
          usage: {
            input_tokens: 1_200,
            output_tokens: 75,
            input_tokens_details: { cached_tokens: 200, cache_write_tokens: 50 },
          },
        }),
      }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await runCandidateOnDoc(
      env,
      { provider: 'openai', model: 'gpt-5.6-terra' },
      'E-doc1',
      bytes,
    );

    expect(result).toMatchObject({
      ok: true,
      resolvedModel: 'gpt-5.6-terra',
      providerRequestId: 'resp_56',
      serviceTier: 'default',
      usage: {
        promptTokens: 1_200,
        completionTokens: 75,
        cachedTokens: 200,
        cacheWriteTokens: 50,
        serviceTier: 'default',
      },
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/responses');
    const request = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    expect(request).toMatchObject({
      model: 'gpt-5.6-terra',
      service_tier: 'default',
      reasoning: { effort: 'medium' },
      store: false,
      text: { format: { type: 'json_schema', strict: true } },
    });
    expect(request.input[0].content[0]).toMatchObject({
      type: 'input_file',
      filename: 'ptr.pdf',
      detail: 'high',
    });
  });

  it('rejects incomplete Responses results while preserving billable usage and request metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ({
          ok: true,
          json: async () => ({
            id: 'resp_incomplete',
            model: 'gpt-5.6-luna',
            service_tier: 'default',
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            usage: {
              input_tokens: 900,
              output_tokens: 8_000,
              input_tokens_details: { cached_tokens: 100, cache_write_tokens: 25 },
            },
          }),
        }) as unknown as Response,
      ),
    );

    const result = await runCandidateOnDoc(
      env,
      { provider: 'openai', model: 'gpt-5.6-luna' },
      'H-incomplete',
      bytes,
    );

    expect(result).toMatchObject({
      ok: false,
      error: 'openai: response incomplete: max_output_tokens',
      resolvedModel: 'gpt-5.6-luna',
      providerRequestId: 'resp_incomplete',
      serviceTier: 'default',
      usage: {
        promptTokens: 900,
        completionTokens: 8_000,
        cachedTokens: 100,
        cacheWriteTokens: 25,
        serviceTier: 'default',
      },
    });
  });

  it('rejects Responses refusals while preserving usage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ({
          ok: true,
          json: async () => ({
            id: 'resp_refusal',
            model: 'gpt-5.6-sol',
            service_tier: 'default',
            status: 'completed',
            output: [{ content: [{ type: 'refusal', refusal: 'Unable to process this document.' }] }],
            usage: { input_tokens: 700, output_tokens: 12 },
          }),
        }) as unknown as Response,
      ),
    );

    const result = await runCandidateOnDoc(
      env,
      { provider: 'openai', model: 'gpt-5.6-sol' },
      'S-refusal',
      bytes,
    );

    expect(result).toMatchObject({
      ok: false,
      error: 'openai: refusal: Unable to process this document.',
      usage: { promptTokens: 700, completionTokens: 12, serviceTier: 'default' },
    });
  });

  it('keeps unreadable asset name and transaction type nullable in the strict schema', () => {
    const properties = MISTRAL_ANNOTATION_SCHEMA.schema.properties.transactions.items.properties;
    expect(EXTRACTION_SCHEMA_VERSION).toBe('stock-act-transactions-v2');
    expect(properties.assetName.type).toEqual(['string', 'null']);
    expect(properties.txType.type).toEqual(['string', 'null']);
  });

  it('offers only the three GPT-5.6 tiers for new OpenAI disclosure reads', () => {
    const openAiModels = DEFAULT_CANDIDATES
      .filter((entry) => entry.provider === 'openai')
      .map((entry) => entry.model);
    expect(openAiModels).toEqual([
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.6-sol',
    ]);
  });

  it('maps the GPT-5.6 roles to low, medium, and high reasoning', () => {
    expect(openAiDisclosureReasoningEffort('gpt-5.6-luna')).toBe('low');
    expect(openAiDisclosureReasoningEffort('gpt-5.6-terra')).toBe('medium');
    expect(openAiDisclosureReasoningEffort('gpt-5.6-sol')).toBe('high');
  });

  it('retires the GPT-4o family from active reads while upgrading stale agreement config', () => {
    expect(isRetiredDisclosureCandidate({ provider: 'openai', model: 'gpt-4o' })).toBe(true);
    expect(isRetiredDisclosureCandidate({ provider: 'openai', model: 'gpt-4o-mini' })).toBe(true);
    expect(isRetiredDisclosureCandidate({ provider: 'openai', model: 'chatgpt-4o-latest' })).toBe(true);
    expect(isRetiredDisclosureCandidate({ provider: 'openai', model: 'gpt-5.6-terra' })).toBe(false);
    expect(upgradeRetiredDisclosureCandidate({ provider: 'openai', model: 'gpt-4o' }))
      .toEqual({ provider: 'openai', model: 'gpt-5.6-terra' });
  });

  it('blocks a low-level GPT-4o invocation before resolving a key or calling a provider', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await runCandidateOnDoc(
      { OPENAI_API_KEY: 'must-not-use' } as unknown as Env,
      { provider: 'openai', model: 'chatgpt-4o-latest' },
      'H-retired',
      new TextEncoder().encode('%PDF').buffer as ArrayBuffer,
    );
    expect(result).toMatchObject({
      ok: false,
      error: 'GPT-4o is retired for new disclosure extraction',
      latencyMs: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('runCandidateOnDoc: provider billing metadata', () => {
  const bytes = new TextEncoder().encode('%PDF-1.4 fake').buffer as ArrayBuffer;
  const annotation = {
    transactions: [
      {
        ticker: 'AAPL',
        assetName: 'Apple Inc.',
        txType: 'P',
        amountRange: '$1,001 - $15,000',
      },
    ],
  };

  afterEach(() => vi.unstubAllGlobals());

  it('captures Mistral OCR usage_info pages instead of a nonexistent token-usage field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ({
          ok: true,
          json: async () => ({
            id: 'ocr-request-1',
            model: 'mistral-ocr-4-0',
            document_annotation: annotation,
            usage_info: { pages_processed: 7 },
          }),
        }) as unknown as Response,
      ),
    );

    const result = await runCandidateOnDoc(
      { MISTRAL_API_KEY: 'mistral-test' } as unknown as Env,
      { provider: 'mistral', model: 'mistral-ocr-latest' },
      'H-doc',
      bytes,
    );

    expect(result).toMatchObject({
      ok: true,
      resolvedModel: 'mistral-ocr-4-0',
      providerRequestId: 'ocr-request-1',
      usage: { pagesProcessed: 7 },
    });
  });

  it('captures xAI Responses input/output/cached tokens and request metadata', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'file-1' }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'response-1',
          model: 'grok-4.3-20260701',
          output_text: JSON.stringify(annotation),
          usage: {
            input_tokens: 900,
            output_tokens: 50,
            input_tokens_details: { cached_tokens: 125 },
            cost_in_usd_ticks: 321_000_000,
            num_server_side_tools_used: 2,
          },
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'file-1', deleted: true }),
      } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await runCandidateOnDoc(
      { XAI_API_KEY: 'xai-test' } as unknown as Env,
      { provider: 'xai', model: 'grok-4.3' },
      'E-doc',
      bytes,
    );

    expect(result).toMatchObject({
      ok: true,
      resolvedModel: 'grok-4.3-20260701',
      providerRequestId: 'response-1',
      usage: {
        promptTokens: 900,
        completionTokens: 50,
        cachedTokens: 125,
        costInUsdTicks: 321_000_000,
        attachmentSearchCalls: 2,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const uploadBody = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(uploadBody.get('expires_after')).toBe('3600');
    const responseBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(responseBody.input[0].content[0].text).toContain(EXECUTIVE_SYSTEM_PROMPT);
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://api.x.ai/v1/files/file-1');
    expect(fetchMock.mock.calls[2]?.[1]?.method).toBe('DELETE');
  });

  it('deletes an uploaded xAI file when the extraction request fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'file-failed-response' }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => 'temporarily unavailable',
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'file-failed-response', deleted: true }),
      } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await runCandidateOnDoc(
      { XAI_API_KEY: 'xai-test' } as unknown as Env,
      { provider: 'xai', model: 'grok-4.3' },
      'H-doc',
      bytes,
    );

    expect(result).toMatchObject({ ok: false, error: 'xai 503 temporarily unavailable' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://api.x.ai/v1/files/file-failed-response');
    expect(fetchMock.mock.calls[2]?.[1]?.method).toBe('DELETE');
  });

  it('includes Gemini thinking/cache tokens and provider model version', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ({
          ok: true,
          json: async () => ({
            responseId: 'gemini-response-1',
            modelVersion: 'gemini-3.5-flash-2026-06',
            candidates: [{ content: { parts: [{ text: JSON.stringify(annotation.transactions) }] } }],
            usageMetadata: {
              promptTokenCount: 1_000,
              cachedContentTokenCount: 200,
              candidatesTokenCount: 75,
              thoughtsTokenCount: 25,
            },
          }),
        }) as unknown as Response,
      ),
    );

    const result = await runCandidateOnDoc(
      { GEMINI_API_KEY: 'gemini-test' } as unknown as Env,
      { provider: 'gemini', model: 'gemini-3.5-flash' },
      'H-doc',
      bytes,
    );

    expect(result).toMatchObject({
      ok: true,
      resolvedModel: 'gemini-3.5-flash-2026-06',
      providerRequestId: 'gemini-response-1',
      usage: { promptTokens: 1_000, completionTokens: 100, cachedTokens: 200 },
    });
  });
});

describe('runCandidateOnDoc (anthropic): complete billed input usage', () => {
  const bytes = new TextEncoder().encode('%PDF-1.4 fake').buffer as ArrayBuffer;

  afterEach(() => vi.unstubAllGlobals());

  it('sums base/read/write tokens and preserves the cache TTL breakdown', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({
        id: 'msg_1',
        model: 'claude-sonnet-4-6',
        content: [{
          type: 'text',
          text: '[{"ticker":"AAPL","assetName":"Apple Inc.","txType":"P","amountRange":"$1,001 - $15,000"}]',
        }],
        usage: {
          input_tokens: 500,
          output_tokens: 100,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 300,
          cache_creation: {
            ephemeral_5m_input_tokens: 200,
            ephemeral_1h_input_tokens: 100,
          },
        },
      }),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await runCandidateOnDoc(
      { ANTHROPIC_API_KEY: 'anthropic-test' } as unknown as Env,
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      'E-doc',
      bytes,
    );

    expect(result).toMatchObject({
      ok: true,
      usage: {
        promptTokens: 1_000,
        completionTokens: 100,
        cachedTokens: 200,
        cacheWriteTokens: 200,
        cacheWriteOneHourTokens: 100,
      },
    });
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.messages[0].content[1].text).toContain(EXECUTIVE_SYSTEM_PROMPT);
  });
});

describe('runCandidateOnDoc extraction cache', () => {
  const bytes = new TextEncoder().encode('%PDF-1.4 fake').buffer as ArrayBuffer;
  const candidate: BakeoffCandidate = { provider: 'openai', model: 'gpt-5.6-terra' };
  const cachedRow = {
    txDate: '2026-07-14',
    owner: 'self',
    assetName: 'Apple Inc.',
    ticker: 'AAPL',
    assetType: 'stock',
    txType: 'P',
    amountMin: 1_001,
    amountMax: 15_000,
    isOption: false,
    capGainsOver200: false,
    rawText: 'Apple Inc. purchase',
    confidence: 0.9,
  };

  afterEach(() => vi.unstubAllGlobals());

  it('reconstructs a cached result from the stored flat row array', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const first = vi.fn(async () => ({ result_json: JSON.stringify([cachedRow]) }));
    const env = {
      OPENAI_API_KEY: 'openai-test',
      DB: { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first })) })) },
    } as unknown as Env;

    const result = await runCandidateOnDoc(env, candidate, 'H-cache', bytes);

    expect(result).toMatchObject({
      ok: true,
      cached: true,
      latencyMs: 0,
      rowCount: 1,
      rowKeys: ['AAPL|2026-07-14|P'],
      avgConfidence: 0.9,
      rows: [cachedRow],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls through when the cache table is unavailable before migration', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      status: 'completed',
      output_text: '{"transactions":[]}',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const env = {
      OPENAI_API_KEY: 'openai-test',
      DB: {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({ first: vi.fn(async () => { throw new Error('no such table: extraction_runs'); }) })),
        })),
      },
    } as unknown as Env;

    const result = await runCandidateOnDoc(env, candidate, 'H-unmigrated', bytes);

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bypasses a prior row when a benchmark requires fresh provider measurements', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      status: 'completed',
      output_text: '{"transactions":[]}',
      usage: { input_tokens: 12, output_tokens: 3 },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const first = vi.fn(async () => ({ result_json: JSON.stringify([cachedRow]) }));
    const env = {
      DB: { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first })) })) },
    } as unknown as Env;

    const result = await runCandidateOnDoc(
      env,
      candidate,
      'H-benchmark',
      bytes,
      { apiKey: 'reserved-key', skipCache: true },
    );

    expect(result).toMatchObject({
      ok: true,
      usage: { promptTokens: 12, completionTokens: 3 },
    });
    expect(result.cached).toBeUndefined();
    expect(first).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('runCandidateOnDoc frozen invocation authorization', () => {
  const bytes = new TextEncoder().encode('%PDF-1.4 fake').buffer as ArrayBuffer;

  afterEach(() => vi.unstubAllGlobals());

  it('does not re-resolve a key that appears after the caller froze an unconfigured plan', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await runCandidateOnDoc(
      { OPENAI_API_KEY: 'appeared-after-reservation-check' } as unknown as Env,
      { provider: 'openai', model: 'gpt-5.6-terra' },
      'H-1',
      bytes,
      { apiKey: null },
    );

    expect(result).toMatchObject({
      ok: false,
      error: 'openai API key not configured',
      failure: {
        code: 'provider_not_configured',
        scope: 'provider',
        retryable: false,
      },
      latencyMs: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the exact frozen key even when runtime secret resolution is now empty', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response('denied', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runCandidateOnDoc(
      {} as Env,
      { provider: 'openai', model: 'gpt-5.6-terra' },
      'H-1',
      bytes,
      { apiKey: 'reserved-key' },
    );

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('openai 401'),
      failure: {
        code: 'provider_authentication_failed',
        scope: 'provider',
        retryable: false,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer reserved-key');
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
