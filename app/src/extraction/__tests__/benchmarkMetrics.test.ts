import { describe, expect, it } from 'vitest';
import {
  priceBenchmarkUsage,
  simulateCascadeDocumentMetrics,
  summarizeBenchmarkCosts,
  summarizeBenchmarkLatency,
} from '../benchmarkMetrics';

describe('priceBenchmarkUsage', () => {
  it('prices measured OpenAI usage and applies the cached-input rate only to cached tokens', () => {
    const result = priceBenchmarkUsage({
      provider: 'openai',
      model: 'gpt-4o',
      invoked: true,
      usage: { promptTokens: 1_000, cachedTokens: 200, completionTokens: 100 },
    });

    expect(result.costSource).toBe('usage_priced');
    expect(result.costUsd).toBeCloseTo(0.00325, 10);
    expect(result.costDetail).toMatchObject({
      pricingBasis: 'tokens',
      rateCardVersion: 'openai-standard-2026-07-13',
      billedUsage: { uncachedPromptTokens: 800, cachedTokens: 200 },
    });
  });

  it('prices each GPT-5.6 tier from measured tokens', () => {
    const usage = { promptTokens: 1_000, cachedTokens: 200, completionTokens: 100 };
    expect(priceBenchmarkUsage({
      provider: 'openai', model: 'gpt-5.6-luna', invoked: true, usage,
    }).costUsd).toBeCloseTo(0.00142, 10);
    expect(priceBenchmarkUsage({
      provider: 'openai', model: 'gpt-5.6-terra', invoked: true, usage,
    }).costUsd).toBeCloseTo(0.00355, 10);
    expect(priceBenchmarkUsage({
      provider: 'openai', model: 'gpt-5.6-sol', invoked: true, usage,
    }).costUsd).toBeCloseTo(0.0071, 10);
  });

  it('prices GPT-5.6 cache writes at the measured 1.25x input rate', () => {
    const result = priceBenchmarkUsage({
      provider: 'openai',
      model: 'gpt-5.6-terra',
      invoked: true,
      usage: {
        promptTokens: 1_000,
        cachedTokens: 200,
        cacheWriteTokens: 300,
        completionTokens: 100,
        serviceTier: 'default',
      },
    });
    expect(result.costUsd).toBeCloseTo(0.0037375, 10);
    expect(result.costDetail).toMatchObject({
      serviceTier: 'default',
      billedUsage: { uncachedPromptTokens: 500, cachedTokens: 200, cacheWriteTokens: 300 },
      rates: { cacheWriteInputMultiplier: 1.25 },
    });
  });

  it('prices Anthropic base, cache-read, and both cache-write TTL meters', () => {
    const result = priceBenchmarkUsage({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      invoked: true,
      usage: {
        promptTokens: 1_000,
        cachedTokens: 200,
        cacheWriteTokens: 200,
        cacheWriteOneHourTokens: 100,
        completionTokens: 100,
      },
    });
    expect(result.costUsd).toBeCloseTo(0.00294, 10);
    expect(result.costDetail.billedUsage).toMatchObject({
      uncachedPromptTokens: 500,
      cachedTokens: 200,
      cacheWriteTokens: 200,
      cacheWriteOneHourTokens: 100,
    });
  });

  it('does not apply default-tier rates to an unpriced service tier', () => {
    expect(priceBenchmarkUsage({
      provider: 'openai',
      model: 'gpt-5.6-terra',
      invoked: true,
      usage: { promptTokens: 100, completionTokens: 10, serviceTier: 'priority' },
    }).costDetail.unknownReason).toBe('unsupported_service_tier');
  });

  it('applies GPT-5.6 full-request long-context multipliers above 272K input tokens', () => {
    const result = priceBenchmarkUsage({
      provider: 'openai',
      model: 'gpt-5.6-terra',
      invoked: true,
      usage: { promptTokens: 300_000, cachedTokens: 0, completionTokens: 10_000 },
    });
    expect(result.costUsd).toBeCloseTo(1.725, 10);
    expect(result.costDetail.rates).toMatchObject({
      longContextApplied: true,
      inputMultiplier: 2,
      outputMultiplier: 1.5,
    });
  });

  it('uses provider-reported dollars ahead of a rate-card calculation', () => {
    const result = priceBenchmarkUsage({
      provider: 'unknown-provider',
      model: 'private-model',
      invoked: true,
      providerReportedCostUsd: 0.0123,
    });
    expect(result).toMatchObject({
      costUsd: 0.0123,
      costSource: 'provider_reported',
      costDetail: { pricingBasis: 'provider_reported', unknownReason: null },
    });
  });

  it('uses xAI exact billed ticks so attachment-search tools are included in actual cost', () => {
    const result = priceBenchmarkUsage({
      provider: 'xai',
      model: 'grok-4.3',
      invoked: true,
      usage: {
        promptTokens: 1_000,
        completionTokens: 100,
        costInUsdTicks: 123_450_000,
        attachmentSearchCalls: 2,
      },
    });

    expect(result).toMatchObject({
      costUsd: 0.012345,
      costSource: 'provider_reported',
      costDetail: {
        pricingBasis: 'provider_reported',
        billedUsage: {
          costInUsdTicks: 123_450_000,
          attachmentSearchCalls: 2,
        },
      },
    });
  });

  it('does not report token-only xAI cost when the exact tool-inclusive charge is absent', () => {
    expect(priceBenchmarkUsage({
      provider: 'xai',
      model: 'grok-4.3',
      invoked: true,
      usage: { promptTokens: 1_000, completionTokens: 100, attachmentSearchCalls: 1 },
    })).toMatchObject({
      costUsd: null,
      costSource: 'unknown',
      costDetail: { unknownReason: 'provider_cost_not_reported' },
    });
  });

  it('prices Mistral structured OCR from provider-reported pages, not file bytes', () => {
    const result = priceBenchmarkUsage({
      provider: 'mistral',
      model: 'mistral-ocr-latest',
      resolvedModel: 'mistral-ocr-4-0',
      invoked: true,
      usage: { pagesProcessed: 3 },
    });
    expect(result.costUsd).toBeCloseTo(0.015, 10);
    expect(result.costDetail).toMatchObject({
      pricingBasis: 'annotated_pages',
      billedUsage: { pagesProcessed: 3 },
      rates: { usdPerPage: 0.005 },
    });
  });

  it('prices OpenRouter gpt-5.6-terra-pro from measured tokens', () => {
    const result = priceBenchmarkUsage({
      provider: 'openrouter',
      model: 'openai/gpt-5.6-terra-pro',
      invoked: true,
      usage: { promptTokens: 1_000, cachedTokens: 200, completionTokens: 100 },
    });
    expect(result.costSource).toBe('usage_priced');
    expect(result.costUsd).toBeCloseTo(0.00355, 10);
    expect(result.costDetail).toMatchObject({
      pricingBasis: 'tokens',
      rateCardVersion: 'openrouter-static-2026-07-17',
      billedUsage: { promptTokens: 1_000, uncachedPromptTokens: 800, cachedTokens: 200, completionTokens: 100 },
      rates: { inputUsdPerMillion: 2.5, cachedInputUsdPerMillion: 0.25, outputUsdPerMillion: 15 },
    });
  });

  it('prices OpenRouter claude-haiku-4.5 with cache writes', () => {
    const result = priceBenchmarkUsage({
      provider: 'openrouter',
      model: 'anthropic/claude-haiku-4.5',
      invoked: true,
      usage: {
        promptTokens: 1_000,
        cachedTokens: 200,
        cacheWriteTokens: 200,
        cacheWriteOneHourTokens: 100,
        completionTokens: 100,
      },
    });
    expect(result.costSource).toBe('usage_priced');
    expect(result.costUsd).toBeCloseTo(0.00147, 10);
    expect(result.costDetail).toMatchObject({
      pricingBasis: 'tokens',
      rateCardVersion: 'openrouter-static-2026-07-17',
      billedUsage: {
        uncachedPromptTokens: 500,
        cachedTokens: 200,
        cacheWriteTokens: 200,
        cacheWriteOneHourTokens: 100,
        completionTokens: 100,
      },
      rates: {
        inputUsdPerMillion: 1,
        cachedInputUsdPerMillion: 0.1,
        cacheWriteInputMultiplier: 1.25,
        cacheWriteOneHourInputMultiplier: 2,
        outputUsdPerMillion: 5,
      },
    });
  });

  it('prices OpenRouter Mistral structured OCR from provider-reported pages', () => {
    const result = priceBenchmarkUsage({
      provider: 'openrouter',
      model: 'mistral/mistral-ocr-latest',
      invoked: true,
      usage: { pagesProcessed: 3 },
    });
    expect(result.costUsd).toBeCloseTo(0.006, 10);
    expect(result.costDetail).toMatchObject({
      pricingBasis: 'annotated_pages',
      billedUsage: { pagesProcessed: 3 },
      rates: { usdPerPage: 0.002 },
    });
  });

  it('prices each LlamaParse tier from provider-reported pages and public credits', () => {
    expect(priceBenchmarkUsage({
      provider: 'llamaparse', model: 'fast', invoked: true, usage: { pagesProcessed: 4 },
    }).costUsd).toBeCloseTo(0.005, 10);
    expect(priceBenchmarkUsage({
      provider: 'llamaparse', model: 'cost-effective', invoked: true, usage: { pagesProcessed: 4 },
    }).costUsd).toBeCloseTo(0.015, 10);
    expect(priceBenchmarkUsage({
      provider: 'llamaparse', model: 'agentic', invoked: true, usage: { pagesProcessed: 4 },
    }).costUsd).toBeCloseTo(0.05, 10);
  });

  it('never fabricates a fallback cost for an unknown model', () => {
    const result = priceBenchmarkUsage({
      provider: 'llamaparse', model: 'unlisted-mode', invoked: true, usage: { pagesProcessed: 4 },
    });
    expect(result).toMatchObject({
      costUsd: null,
      costSource: 'unknown',
      costDetail: { unknownReason: 'rate_not_configured' },
    });
  });

  it('requires complete, internally valid token usage', () => {
    expect(priceBenchmarkUsage({
      provider: 'openai', model: 'gpt-4o', invoked: true, usage: { promptTokens: 100 },
    }).costDetail.unknownReason).toBe('token_usage_incomplete');

    expect(priceBenchmarkUsage({
      provider: 'openai',
      model: 'gpt-4o',
      invoked: true,
      usage: { promptTokens: 100, cachedTokens: 101, completionTokens: 5 },
    }).costDetail.unknownReason).toBe('invalid_token_usage');
  });

  it('distinguishes a non-invocation from an invoked call with missing usage', () => {
    expect(priceBenchmarkUsage({
      provider: 'openai', model: 'gpt-4o', invoked: false,
    }).costDetail.unknownReason).toBe('not_invoked');
    expect(priceBenchmarkUsage({
      provider: 'openai', model: 'gpt-4o', invoked: true,
    }).costDetail.unknownReason).toBe('usage_not_reported');
  });
});

describe('summarizeBenchmarkCosts', () => {
  it('reports per-document cost only with complete invoked-call coverage', () => {
    expect(summarizeBenchmarkCosts([
      { invoked: true, costUsd: 0.01 },
      { invoked: true, costUsd: 0.03 },
      { invoked: false, costUsd: null },
    ], 2)).toEqual({
      invokedCalls: 2,
      coveredCalls: 2,
      coverageRate: 1,
      knownCostUsd: 0.04,
      totalCostUsd: 0.04,
      costPerDocumentUsd: 0.02,
    });
  });

  it('keeps totals and per-document cost null when any invoked call is unpriced', () => {
    expect(summarizeBenchmarkCosts([
      { invoked: true, costUsd: 0.01 },
      { invoked: true, costUsd: null },
      { invoked: false, costUsd: null },
    ], 1)).toEqual({
      invokedCalls: 2,
      coveredCalls: 1,
      coverageRate: 0.5,
      knownCostUsd: 0.01,
      totalCostUsd: null,
      costPerDocumentUsd: null,
    });
  });
});

describe('summarizeBenchmarkLatency', () => {
  it('reports end-to-end average and nearest-rank p50/p95 for invoked calls', () => {
    expect(summarizeBenchmarkLatency([
      { invoked: true, latencyMs: 400 },
      { invoked: true, latencyMs: 100 },
      { invoked: true, latencyMs: 300 },
      { invoked: true, latencyMs: 200 },
      { invoked: false, latencyMs: 0 },
      { invoked: true, latencyMs: null },
    ])).toEqual({
      sampleCount: 4,
      averageMs: 250,
      p50Ms: 200,
      p95Ms: 400,
      minMs: 100,
      maxMs: 400,
    });
  });

  it('returns explicit null metrics when no invoked call has latency', () => {
    expect(summarizeBenchmarkLatency([{ invoked: false, latencyMs: 0 }])).toEqual({
      sampleCount: 0,
      averageMs: null,
      p50Ms: null,
      p95Ms: null,
      minMs: null,
      maxMs: null,
    });
  });
});

describe('simulateCascadeDocumentMetrics', () => {
  const a = { invoked: true, latencyMs: 100, costUsd: 0.01 };
  const b = { invoked: true, latencyMs: 250, costUsd: 0.02 };

  it('models sequential A then B and excludes C when tier one resolves', () => {
    expect(simulateCascadeDocumentMetrics({
      a,
      b,
      c: { invoked: true, latencyMs: 900, costUsd: null },
      escalated: false,
    })).toEqual({
      requiredCalls: 2,
      invokedCalls: 2,
      costCoveredCalls: 2,
      knownCostUsd: 0.03,
      costUsd: 0.03,
      wallClockMs: 350,
    });
  });

  it('adds a fresh sequential A+B+C tier after tier-one disagreement', () => {
    expect(simulateCascadeDocumentMetrics({
      a,
      b,
      c: { invoked: true, latencyMs: 900, costUsd: 0.04 },
      escalated: true,
    })).toEqual({
      requiredCalls: 5,
      invokedCalls: 5,
      costCoveredCalls: 5,
      knownCostUsd: 0.10,
      costUsd: 0.10,
      wallClockMs: 1_600,
    });
  });

  it('does not claim complete cascade cost or speed when required C data is unavailable', () => {
    expect(simulateCascadeDocumentMetrics({
      a,
      b,
      c: { invoked: true, latencyMs: null, costUsd: null },
      escalated: true,
    })).toEqual({
      requiredCalls: 5,
      invokedCalls: 5,
      costCoveredCalls: 4,
      knownCostUsd: 0.06,
      costUsd: null,
      wallClockMs: null,
    });
  });

  it('counts an absent resolver as missing required coverage on an escalated document', () => {
    expect(simulateCascadeDocumentMetrics({ a, b, escalated: true })).toEqual({
      requiredCalls: 5,
      invokedCalls: 4,
      costCoveredCalls: 4,
      knownCostUsd: 0.06,
      costUsd: null,
      wallClockMs: null,
    });
  });

  it('distinguishes unavailable required slots from invoked calls', () => {
    expect(simulateCascadeDocumentMetrics({
      a,
      b: { invoked: false, latencyMs: null, costUsd: null },
      escalated: false,
    })).toEqual({
      requiredCalls: 2,
      invokedCalls: 1,
      costCoveredCalls: 1,
      knownCostUsd: 0.01,
      costUsd: null,
      wallClockMs: null,
    });
  });
});
