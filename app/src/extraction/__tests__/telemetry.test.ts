import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types';
import type { MeasuredThirdPartyUsage } from '../../shared/thirdPartyTelemetry';
import type { CandidateDocResult } from '../bakeoff';

const mocks = vi.hoisted(() => ({
  recordMeasuredThirdPartyUsage: vi.fn<
    (env: Env, usage: MeasuredThirdPartyUsage) => Promise<boolean>
  >(async () => true),
}));

vi.mock('../../shared/thirdPartyTelemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/thirdPartyTelemetry')>()),
  recordMeasuredThirdPartyUsage: mocks.recordMeasuredThirdPartyUsage,
}));

import { stableMeasuredUsageIdempotencyKey } from '../../shared/thirdPartyTelemetry';
import { pushExtractionTelemetry } from '../telemetry';

describe('extraction measured telemetry', () => {
  beforeEach(() => mocks.recordMeasuredThirdPartyUsage.mockClear());
  afterEach(() => vi.useRealTimers());

  it('retains cache-write and service-tier provenance without double-counting token quantity', async () => {
    const result: CandidateDocResult = {
      provider: 'openai',
      model: 'gpt-5.6',
      resolvedModel: 'gpt-5.6-20260701',
      docId: 'H-1',
      ok: true,
      latencyMs: 123,
      rowCount: 0,
      rowKeys: [],
      avgConfidence: 0,
      rows: [],
      usage: {
        promptTokens: 1_000,
        completionTokens: 100,
        cachedTokens: 200,
        cacheWriteTokens: 300,
        cacheWriteOneHourTokens: 100,
        serviceTier: 'priority',
      },
    };

    await pushExtractionTelemetry({} as Env, result, 'benchmark');

    expect(mocks.recordMeasuredThirdPartyUsage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      provider: 'openai',
      model: 'gpt-5.6-20260701',
      quantity: 1_100,
      unit: 'token',
      metadata: expect.objectContaining({
        promptTokens: 1_000,
        completionTokens: 100,
        cachedTokens: 200,
        cacheWriteTokens: 300,
        cacheWriteOneHourTokens: 100,
        serviceTier: 'priority',
      }),
    }));
  });

  it('records xAI provider-reported attachment-search usage without allocating request cost twice', async () => {
    const result: CandidateDocResult = {
      provider: 'xai',
      model: 'grok-4.3',
      providerRequestId: 'xai-response-1',
      occurredAt: '2026-07-13T12:00:00.000Z',
      docId: 'E-1',
      ok: true,
      latencyMs: 456,
      rowCount: 0,
      rowKeys: [],
      avgConfidence: 0,
      rows: [],
      usage: {
        promptTokens: 900,
        completionTokens: 50,
        pagesProcessed: 3,
        costInUsdTicks: 321_000_000,
        attachmentSearchCalls: 2,
      },
    };

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T13:00:00.000Z'));
    await pushExtractionTelemetry({} as Env, result, 'benchmark');

    const [costKey, tokenKey, pageKey, attachmentKey] = await Promise.all(
      ['cost', 'tokens', 'pages', 'attachment-search'].map((dimension) =>
        stableMeasuredUsageIdempotencyKey(
          'provider-result', dimension, 'xai', 'xai-response-1',
        )),
    );
    expect(mocks.recordMeasuredThirdPartyUsage).toHaveBeenCalledTimes(4);
    expect(mocks.recordMeasuredThirdPartyUsage).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({
      operation: 'benchmark-provider-cost',
      idempotencyKey: costKey,
      occurredAt: '2026-07-13T12:00:00.000Z',
      metricType: 'cost',
      quantity: 0.0321,
      costUsd: 0.0321,
      unit: 'usd',
      metadata: expect.objectContaining({ costInUsdTicks: 321_000_000, attachmentSearchCalls: 2 }),
    }));
    expect(mocks.recordMeasuredThirdPartyUsage).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({
      operation: 'benchmark-tokens',
      idempotencyKey: tokenKey,
      occurredAt: '2026-07-13T12:00:00.000Z',
      unit: 'token',
      metadata: expect.objectContaining({ costInUsdTicks: 321_000_000, attachmentSearchCalls: 2 }),
    }));
    expect(mocks.recordMeasuredThirdPartyUsage).toHaveBeenNthCalledWith(3, expect.anything(), expect.objectContaining({
      operation: 'benchmark-pages',
      idempotencyKey: pageKey,
      occurredAt: '2026-07-13T12:00:00.000Z',
      quantity: 3,
      unit: 'page',
    }));
    expect(mocks.recordMeasuredThirdPartyUsage).toHaveBeenNthCalledWith(4, expect.anything(), expect.objectContaining({
      operation: 'benchmark-attachment-search',
      idempotencyKey: attachmentKey,
      occurredAt: '2026-07-13T12:00:00.000Z',
      quantity: 2,
      unit: 'call',
      metadata: expect.objectContaining({ toolName: 'attachment_search', costInUsdTicks: 321_000_000 }),
    }));
    expect(mocks.recordMeasuredThirdPartyUsage.mock.calls[3]?.[1]).not.toHaveProperty('costUsd');

    const firstEmission = mocks.recordMeasuredThirdPartyUsage.mock.calls.map(([, usage]) => JSON.stringify(usage));
    mocks.recordMeasuredThirdPartyUsage.mockClear();
    vi.setSystemTime(new Date('2026-07-14T01:00:00.000Z'));
    await pushExtractionTelemetry({} as Env, result, 'benchmark');
    expect(mocks.recordMeasuredThirdPartyUsage.mock.calls.map(([, usage]) => JSON.stringify(usage)))
      .toEqual(firstEmission);
  });

  it('keeps long mixed provider ids and every measured dimension collision-resistant', async () => {
    const prefix = 'MiXeD/Provider_ID+'.repeat(12);
    const buildResult = (providerRequestId: string): CandidateDocResult => ({
      provider: 'xai',
      model: 'grok-4.3',
      providerRequestId,
      occurredAt: '2026-07-13T12:00:00.000Z',
      docId: 'E-long',
      ok: true,
      latencyMs: 10,
      rowCount: 0,
      rowKeys: [],
      avgConfidence: 0,
      rows: [],
      usage: {
        promptTokens: 10,
        completionTokens: 2,
        pagesProcessed: 1,
        costInUsdTicks: 0,
        attachmentSearchCalls: 1,
      },
    });
    const keysFor = async (providerRequestId: string) => {
      mocks.recordMeasuredThirdPartyUsage.mockClear();
      await pushExtractionTelemetry({} as Env, buildResult(providerRequestId), 'benchmark');
      return mocks.recordMeasuredThirdPartyUsage.mock.calls.map(([, usage]) => usage.idempotencyKey);
    };

    const leftKeys = await keysFor(`${prefix}/Tail-A`);
    const rightKeys = await keysFor(`${prefix}-tail_a`);

    expect(leftKeys).toHaveLength(4);
    expect(rightKeys).toHaveLength(4);
    for (const key of [...leftKeys, ...rightKeys]) {
      expect(key).toMatch(/^ct-measured-[0-9a-f]{64}$/);
      expect(key).toHaveLength(76);
    }
    expect(new Set(leftKeys).size).toBe(4);
    expect(new Set(rightKeys).size).toBe(4);
    expect(new Set([...leftKeys, ...rightKeys]).size).toBe(8);
  });

  it('estimates gemini cost from token usage against the shared rate card, marked as estimated', async () => {
    const result: CandidateDocResult = {
      provider: 'gemini',
      model: 'gemini-3.5-flash',
      docId: 'H-gemini',
      ok: true,
      latencyMs: 10,
      rowCount: 0,
      rowKeys: [],
      avgConfidence: 0,
      rows: [],
      usage: { promptTokens: 1_000, completionTokens: 200, cachedTokens: 100 },
    };

    await pushExtractionTelemetry({} as Env, result, 'benchmark');

    expect(mocks.recordMeasuredThirdPartyUsage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      provider: 'gemini',
      operation: 'benchmark-provider-cost',
      metricType: 'cost',
      quantity: expect.closeTo(0.003165, 6),
      costUsd: expect.closeTo(0.003165, 6),
      unit: 'usd',
      billingMode: 'estimated',
      confidence: 'estimated',
      metadata: expect.objectContaining({ costSource: 'usage_priced' }),
    }));
  });

  it('estimates OpenAI GPT-5.6 Terra cost from token usage, marked as estimated', async () => {
    const result: CandidateDocResult = {
      provider: 'openai',
      model: 'gpt-5.6-terra',
      docId: 'H-openai',
      ok: true,
      latencyMs: 10,
      rowCount: 0,
      rowKeys: [],
      avgConfidence: 0,
      rows: [],
      usage: { promptTokens: 1_000, completionTokens: 100 },
    };

    await pushExtractionTelemetry({} as Env, result, 'benchmark');

    expect(mocks.recordMeasuredThirdPartyUsage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      provider: 'openai',
      operation: 'benchmark-provider-cost',
      costUsd: expect.closeTo(0.004, 6),
      billingMode: 'estimated',
      confidence: 'estimated',
    }));
  });

  it('estimates Anthropic Sonnet cost including cache read/write tiers, marked as estimated', async () => {
    const result: CandidateDocResult = {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      docId: 'H-anthropic',
      ok: true,
      latencyMs: 10,
      rowCount: 0,
      rowKeys: [],
      avgConfidence: 0,
      rows: [],
      usage: {
        promptTokens: 500,
        completionTokens: 80,
        cachedTokens: 100,
        cacheWriteTokens: 50,
      },
    };
    await pushExtractionTelemetry({} as Env, result, 'benchmark');

    expect(mocks.recordMeasuredThirdPartyUsage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      provider: 'anthropic',
      operation: 'benchmark-provider-cost',
      billingMode: 'estimated',
      confidence: 'estimated',
      // Sonnet 5 introductory pricing ($2/$10 through 2026-08-31):
      // 350 uncached-in * 2 + 100 cache-read * 0.2 + 50 cache-write * 2 * 1.25
      // + 80 out * 10, all per MTok = 0.001645. From 2026-09-01 standard
      // pricing ($3/$15) makes the same fixture 0.0024675.
      costUsd: expect.closeTo(0.001645, 7),
    }));
  });

  it('estimates Mistral OCR cost from pages processed, marked as estimated', async () => {
    const result: CandidateDocResult = {
      provider: 'mistral',
      model: 'mistral-ocr-latest',
      docId: 'H-mistral',
      ok: true,
      latencyMs: 10,
      rowCount: 0,
      rowKeys: [],
      avgConfidence: 0,
      rows: [],
      usage: { pagesProcessed: 4 },
    };

    await pushExtractionTelemetry({} as Env, result, 'benchmark');

    expect(mocks.recordMeasuredThirdPartyUsage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      provider: 'mistral',
      operation: 'benchmark-provider-cost',
      costUsd: expect.closeTo(0.02, 6),
      billingMode: 'estimated',
      confidence: 'estimated',
    }));
  });

  it('does not emit a cost event when the model has no rate-card entry', async () => {
    const result: CandidateDocResult = {
      provider: 'openai',
      model: 'gpt-3.5-unlisted',
      docId: 'H-unlisted',
      ok: true,
      latencyMs: 10,
      rowCount: 0,
      rowKeys: [],
      avgConfidence: 0,
      rows: [],
      usage: { promptTokens: 1_000, completionTokens: 100 },
    };

    await pushExtractionTelemetry({} as Env, result, 'benchmark');

    const costCalls = mocks.recordMeasuredThirdPartyUsage.mock.calls
      .filter(([, usage]) => usage.operation === 'benchmark-provider-cost');
    expect(costCalls).toHaveLength(0);
    // The tokens event still fires — cost estimation is best-effort, not a gate.
    expect(mocks.recordMeasuredThirdPartyUsage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      operation: 'benchmark-tokens',
    }));
  });

  it('keeps xAI provider-reported cost as actual, never estimated, even though it is also priceable by tokens', async () => {
    const result: CandidateDocResult = {
      provider: 'xai',
      model: 'grok-4.3',
      docId: 'H-xai',
      ok: true,
      latencyMs: 10,
      rowCount: 0,
      rowKeys: [],
      avgConfidence: 0,
      rows: [],
      usage: { promptTokens: 900, completionTokens: 50, costInUsdTicks: 321_000_000 },
    };

    await pushExtractionTelemetry({} as Env, result, 'benchmark');

    const costCalls = mocks.recordMeasuredThirdPartyUsage.mock.calls
      .filter(([, usage]) => usage.operation === 'benchmark-provider-cost');
    expect(costCalls).toHaveLength(1);
    expect(costCalls[0]?.[1]).toMatchObject({ billingMode: 'actual', confidence: 'actual' });
  });

  it('preserves an exact zero-cost provider result', async () => {
    const result: CandidateDocResult = {
      provider: 'xai',
      model: 'grok-4.3',
      providerRequestId: 'xai-response-zero',
      docId: 'E-2',
      ok: false,
      latencyMs: 99,
      rowCount: 0,
      rowKeys: [],
      avgConfidence: 0,
      rows: [],
      usage: { costInUsdTicks: 0 },
    };

    await pushExtractionTelemetry({} as Env, result, 'benchmark');

    expect(mocks.recordMeasuredThirdPartyUsage).toHaveBeenCalledOnce();
    expect(mocks.recordMeasuredThirdPartyUsage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      operation: 'benchmark-provider-cost',
      quantity: 0,
      costUsd: 0,
      unit: 'usd',
    }));
  });
});
