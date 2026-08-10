import { describe, expect, it } from 'vitest';
import type { Env } from '../types.ts';
import {
  OPENROUTER_APP_REFERER,
  OPENROUTER_APP_TITLE,
  OPENROUTER_PRIMARY_KEY_REF,
  OPENROUTER_SOURCE_APP,
  buildOpenRouterClassifier,
  openRouterAttributionHeaders,
  openRouterTelemetryMetadata,
} from '../openRouterAttribution.ts';

const env = {
  USAGE_MONITOR_ENVIRONMENT: 'test',
  CF_VERSION_METADATA: { id: 'deadbeef', tag: 'v1' },
} as unknown as Env;

describe('openRouterAttributionHeaders', () => {
  it('sets the OpenRouter app page identity headers', () => {
    const headers = openRouterAttributionHeaders();
    expect(headers['HTTP-Referer']).toBe(OPENROUTER_APP_REFERER);
    expect(headers['X-OpenRouter-Title']).toBe(OPENROUTER_APP_TITLE);
    // Back-compat title for older analytics paths.
    expect(headers['X-Title']).toBe(OPENROUTER_APP_TITLE);
  });
});

describe('buildOpenRouterClassifier', () => {
  it('builds flat trace enrichment with congress-trade sourceApp', () => {
    const enrichment = buildOpenRouterClassifier(env, {
      service: 'openRouterVision',
      feature: 'vision-extract-house',
      user: 'H-2025-1',
    });
    expect(enrichment).toBeDefined();
    expect(enrichment!.user).toBe('H-2025-1');
    expect(enrichment!.trace).toEqual({
      sourceApp: OPENROUTER_SOURCE_APP,
      environment: 'test',
      service: 'openRouterVision',
      feature: 'vision-extract-house',
      keyRef: OPENROUTER_PRIMARY_KEY_REF,
      gitSha: 'deadbeef',
    });
    expect((enrichment!.trace as { metadata?: unknown }).metadata).toBeUndefined();
  });

  it('omits blank user and defaults keyRef', () => {
    const enrichment = buildOpenRouterClassifier(env, {
      service: 'docClassifier',
      feature: 'doc-class',
      user: '',
    });
    expect(enrichment).toBeDefined();
    expect('user' in enrichment!).toBe(false);
    expect(enrichment!.trace.keyRef).toBe(OPENROUTER_PRIMARY_KEY_REF);
  });
});

describe('openRouterTelemetryMetadata', () => {
  it('mirrors classifier keys for Usage-Monitor filters', () => {
    const meta = openRouterTelemetryMetadata(env, {
      service: 'senatePaperMedia',
      feature: 'senate-paper-ocr',
      user: 'S-1',
    });
    expect(meta.sourceApp).toBe(OPENROUTER_SOURCE_APP);
    expect(meta.keyRef).toBe(OPENROUTER_PRIMARY_KEY_REF);
    expect(meta.service).toBe('senatePaperMedia');
    expect(meta.feature).toBe('senate-paper-ocr');
    expect(meta.user).toBe('S-1');
  });
});
