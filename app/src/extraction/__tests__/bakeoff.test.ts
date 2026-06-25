import { describe, it, expect } from 'vitest';
import {
  computeConsensusAgreement,
  extractXaiResponseText,
  parseMistralOcrResponse,
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
