import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types';
import type { MeasuredThirdPartyUsage } from '../../shared/thirdPartyTelemetry';
import type { CandidateDocResult } from '../bakeoff';

const mocks = vi.hoisted(() => ({
  recordMeasuredThirdPartyUsage: vi.fn<
    (env: Env, usage: MeasuredThirdPartyUsage) => Promise<boolean>
  >(async () => true),
}));

vi.mock('../../shared/thirdPartyTelemetry', () => ({
  recordMeasuredThirdPartyUsage: mocks.recordMeasuredThirdPartyUsage,
}));

import { pushExtractionTelemetry } from '../telemetry';

describe('extraction measured telemetry', () => {
  beforeEach(() => mocks.recordMeasuredThirdPartyUsage.mockClear());

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
        costInUsdTicks: 321_000_000,
        attachmentSearchCalls: 2,
      },
    };

    await pushExtractionTelemetry({} as Env, result, 'benchmark');

    expect(mocks.recordMeasuredThirdPartyUsage).toHaveBeenCalledTimes(3);
    expect(mocks.recordMeasuredThirdPartyUsage).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({
      operation: 'benchmark-provider-cost',
      idempotencyKey: 'ct-sync-xai-xai-response-1-cost',
      metricType: 'cost',
      quantity: 0.0321,
      costUsd: 0.0321,
      unit: 'usd',
      metadata: expect.objectContaining({ costInUsdTicks: 321_000_000, attachmentSearchCalls: 2 }),
    }));
    expect(mocks.recordMeasuredThirdPartyUsage).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({
      operation: 'benchmark-tokens',
      unit: 'token',
      metadata: expect.objectContaining({ costInUsdTicks: 321_000_000, attachmentSearchCalls: 2 }),
    }));
    expect(mocks.recordMeasuredThirdPartyUsage).toHaveBeenNthCalledWith(3, expect.anything(), expect.objectContaining({
      operation: 'benchmark-attachment-search',
      quantity: 2,
      unit: 'call',
      metadata: expect.objectContaining({ toolName: 'attachment_search', costInUsdTicks: 321_000_000 }),
    }));
    expect(mocks.recordMeasuredThirdPartyUsage.mock.calls[2]?.[1]).not.toHaveProperty('costUsd');
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
