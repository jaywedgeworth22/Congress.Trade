import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env, Filing } from '../../shared/types';
import type { Extractor, ExtractorInput, ExtractorResult } from '../../extractors/types';
import type { CandidateDocResult } from '../bakeoff';

const mocks = vi.hoisted(() => ({
  runCandidateOnDoc: vi.fn(),
}));

vi.mock('../bakeoff', async () => {
  const actual = await vi.importActual<typeof import('../bakeoff')>('../bakeoff');
  return {
    ...actual,
    runCandidateOnDoc: mocks.runCandidateOnDoc,
  };
});

import { ConfiguredVisionExtractor, resolvePrimaryFailoverModels } from '../configuredVision';

const filing = (chamber: Filing['chamber'] = 'house'): Filing => ({
  docId: 'H-1',
  chamber,
  filerId: 'F1',
  filingType: 'P',
  filedDate: '2026-07-01',
  sourceUrl: 'https://x',
  rawObjectKey: 'raw/house/H-1.pdf',
  ingestStatus: 'classified',
  docKind: 'scanned_pdf',
  extractor: null,
  modelVersion: null,
  confidence: null,
  firstSeenAt: '2026-07-01T00:00:00.000Z',
  sourceUpdatedAt: null,
  error: null,
});

function makeBytes(s: string): ArrayBuffer {
  const src = new TextEncoder().encode(s);
  const buf = new ArrayBuffer(src.byteLength);
  new Uint8Array(buf).set(src);
  return buf;
}
const bytes = makeBytes('%PDF-1.7 scanned');

function input(chamber: Filing['chamber'] = 'house'): ExtractorInput {
  return { filing: filing(chamber), bytes };
}

function okResult(over: Partial<CandidateDocResult> = {}): CandidateDocResult {
  return {
    provider: 'mistral',
    model: 'mistral-ocr-latest',
    docId: 'H-1',
    ok: true,
    latencyMs: 50,
    rowCount: 1,
    rowKeys: ['AAPL|2026-07-01|P'],
    avgConfidence: 0.9,
    rows: [{ ticker: 'AAPL', confidence: 0.9 } as never],
    resolvedModel: 'mistral-ocr-latest-2026',
    providerRequestId: 'req-1',
    ...over,
  };
}

function failResult(over: Partial<CandidateDocResult> = {}): CandidateDocResult {
  return {
    provider: 'mistral',
    model: 'mistral-ocr-latest',
    docId: 'H-1',
    ok: false,
    error: 'boom',
    latencyMs: 10,
    rowCount: 0,
    rowKeys: [],
    avgConfidence: 0,
    rows: [],
    ...over,
  };
}

function legacyExtractor(result: ExtractorResult): Extractor {
  return {
    name: 'legacy',
    canHandle: () => true,
    extract: vi.fn(async () => result),
  };
}

const LEGACY_RESULT: ExtractorResult = {
  transactions: [],
  confidence: 0.6,
  raw: 'legacy',
  extractor: 'legacy',
};

beforeEach(() => {
  mocks.runCandidateOnDoc.mockReset();
});

describe('resolvePrimaryFailoverModels', () => {
  it('resolves the per-chamber A/B keys and upgrades a retired candidate', async () => {
    const env = {
      AGREEMENT_HOUSE_MODEL_A: 'openai:gpt-4o',
      AGREEMENT_HOUSE_MODEL_B: 'anthropic:claude-haiku-4-5',
    } as unknown as Env;
    const { primary, failover } = await resolvePrimaryFailoverModels(env, 'house');
    expect(primary).toEqual({ provider: 'openai', model: 'gpt-5.6-terra' });
    expect(failover).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5' });
  });

  it('returns nulls for an unconfigured chamber', async () => {
    const { primary, failover } = await resolvePrimaryFailoverModels({} as Env, 'senate');
    expect(primary).toBeNull();
    expect(failover).toBeNull();
  });
});

describe('ConfiguredVisionExtractor', () => {
  it('delegates entirely to legacy when no primary is configured', async () => {
    const legacy = legacyExtractor(LEGACY_RESULT);
    const extractor = new ConfiguredVisionExtractor({} as Env, legacy);
    const result = await extractor.extract(input());
    expect(result).toBe(LEGACY_RESULT);
    expect(legacy.extract).toHaveBeenCalledTimes(1);
    expect(mocks.runCandidateOnDoc).not.toHaveBeenCalled();
  });

  it('maps a successful primary read to ExtractorResult and never calls legacy', async () => {
    const env = {
      AGREEMENT_HOUSE_MODEL_A: 'mistral:mistral-ocr-latest',
      AGREEMENT_HOUSE_MODEL_B: 'openai:gpt-5.6-terra',
    } as unknown as Env;
    mocks.runCandidateOnDoc.mockResolvedValueOnce(okResult({
      usage: { promptTokens: 10, completionTokens: 5 },
    }));
    const legacy = legacyExtractor(LEGACY_RESULT);
    const extractor = new ConfiguredVisionExtractor(env, legacy);
    const result = await extractor.extract(input());

    expect(legacy.extract).not.toHaveBeenCalled();
    expect(mocks.runCandidateOnDoc).toHaveBeenCalledTimes(1);
    expect(mocks.runCandidateOnDoc).toHaveBeenCalledWith(
      env, { provider: 'mistral', model: 'mistral-ocr-latest' }, 'H-1', bytes,
    );
    expect(result.transactions).toHaveLength(1);
    expect(result.confidence).toBeLessThanOrEqual(0.6); // capped like visionLlm's DEFAULT_CONFIDENCE
    expect(result.extractor).toBe('configured(mistral:mistral-ocr-latest)');
    expect(result.modelVersion).toBe('mistral-ocr-latest-2026');
    expect(result.providerRequestId).toBe('req-1');
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
    expect(result.modelRuns).toEqual([{
      extractor: 'configured(mistral:mistral-ocr-latest)',
      modelVersion: 'mistral-ocr-latest-2026',
      providerRequestId: 'req-1',
      usage: { promptTokens: 10, completionTokens: 5 },
    }]);
  });

  it('tries the failover when the primary fails, and never falls back to legacy', async () => {
    const env = {
      AGREEMENT_HOUSE_MODEL_A: 'mistral:mistral-ocr-latest',
      AGREEMENT_HOUSE_MODEL_B: 'openai:gpt-5.6-terra',
    } as unknown as Env;
    mocks.runCandidateOnDoc
      .mockResolvedValueOnce(failResult({ error: 'primary provider down' }))
      .mockResolvedValueOnce(okResult({
        provider: 'openai', model: 'gpt-5.6-terra', resolvedModel: 'gpt-5.6-terra-2026',
      }));
    const legacy = legacyExtractor(LEGACY_RESULT);
    const extractor = new ConfiguredVisionExtractor(env, legacy);
    const result = await extractor.extract(input());

    expect(legacy.extract).not.toHaveBeenCalled();
    expect(mocks.runCandidateOnDoc).toHaveBeenCalledTimes(2);
    expect(result.extractor).toBe('configured(openai:gpt-5.6-terra)');
    expect(result.modelVersion).toBe('gpt-5.6-terra-2026');
  });

  it('throws with both stable error strings when primary and failover both fail', async () => {
    const env = {
      AGREEMENT_HOUSE_MODEL_A: 'mistral:mistral-ocr-latest',
      AGREEMENT_HOUSE_MODEL_B: 'openai:gpt-5.6-terra',
    } as unknown as Env;
    mocks.runCandidateOnDoc
      .mockResolvedValueOnce(failResult({ error: 'primary provider down' }))
      .mockResolvedValueOnce(failResult({
        provider: 'openai', model: 'gpt-5.6-terra', error: 'failover rate limited',
      }));
    const legacy = legacyExtractor(LEGACY_RESULT);
    const extractor = new ConfiguredVisionExtractor(env, legacy);

    await expect(extractor.extract(input())).rejects.toThrow(
      /mistral:mistral-ocr-latest.*primary provider down[\s\S]*openai:gpt-5\.6-terra.*failover rate limited/,
    );
    expect(legacy.extract).not.toHaveBeenCalled();
  });

  it('throws immediately when only a primary is configured and it fails (no failover)', async () => {
    const env = { AGREEMENT_HOUSE_MODEL_A: 'mistral:mistral-ocr-latest' } as unknown as Env;
    mocks.runCandidateOnDoc.mockResolvedValueOnce(failResult({ error: 'primary provider down' }));
    const legacy = legacyExtractor(LEGACY_RESULT);
    const extractor = new ConfiguredVisionExtractor(env, legacy);

    await expect(extractor.extract(input())).rejects.toThrow(/primary provider down/);
    expect(mocks.runCandidateOnDoc).toHaveBeenCalledTimes(1);
    expect(legacy.extract).not.toHaveBeenCalled();
  });

  it('is provider-generic: a non-vision-LLM candidate (mistral OCR) maps the same way', async () => {
    const env = {
      AGREEMENT_SENATE_MODEL_A: 'mistral:mistral-ocr-latest',
      AGREEMENT_SENATE_MODEL_B: 'llamaparse:cost-effective',
    } as unknown as Env;
    mocks.runCandidateOnDoc.mockResolvedValueOnce(okResult({
      provider: 'mistral', model: 'mistral-ocr-latest', rowCount: 2,
      rows: [{ ticker: 'MSFT', confidence: 0.8 } as never, { ticker: 'AAPL', confidence: 0.7 } as never],
    }));
    const legacy = legacyExtractor(LEGACY_RESULT);
    const extractor = new ConfiguredVisionExtractor(env, legacy);
    const result = await extractor.extract(input('senate'));

    expect(result.transactions).toHaveLength(2);
    expect(JSON.parse(result.raw)).toMatchObject({
      source: 'configuredVision', provider: 'mistral', model: 'mistral-ocr-latest', rowCount: 2,
    });
  });
});
