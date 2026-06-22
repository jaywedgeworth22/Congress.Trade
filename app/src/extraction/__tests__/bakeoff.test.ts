import { describe, it, expect } from 'vitest';
import {
  computeConsensusAgreement,
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
