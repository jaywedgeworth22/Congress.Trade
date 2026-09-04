import { describe, expect, it } from 'vitest';
import {
  renderSentryBrowserScript,
  resolveSentryBrowser,
  sentryIngestOrigin,
  SENTRY_BROWSER_SCRIPT_ORIGIN,
} from '../sentryBrowser.ts';

const DSN = 'https://key@o1.ingest.us.sentry.io/1';

describe('sentry browser loader', () => {
  it('stays dark without a DSN', () => {
    expect(resolveSentryBrowser({}).enabled).toBe(false);
    expect(renderSentryBrowserScript({})).toBe('');
  });

  it('honors SENTRY_BROWSER_ENABLED=false', () => {
    expect(resolveSentryBrowser({ SENTRY_DSN: DSN, SENTRY_BROWSER_ENABLED: 'false' }).enabled).toBe(
      false,
    );
  });

  it('defaults session Replay to 0.1 and error Replay to 1 with Feedback on', () => {
    const resolved = resolveSentryBrowser({ SENTRY_DSN: DSN });
    expect(resolved.enabled).toBe(true);
    if (!resolved.enabled) return;
    expect(resolved.replaysSessionSampleRate).toBe(0.1);
    expect(resolved.replaysOnErrorSampleRate).toBe(1);
    expect(resolved.feedbackEnabled).toBe(true);
    expect(resolved.connectOrigin).toBe('https://o1.ingest.us.sentry.io');
    expect(resolved.scriptSrc.startsWith(SENTRY_BROWSER_SCRIPT_ORIGIN)).toBe(true);
    const html = renderSentryBrowserScript({ SENTRY_DSN: DSN });
    expect(html).toContain('replaysSessionSampleRate":0.1');
    expect(html).toContain('feedbackIntegration');
    expect(html).toContain('maskAllText:true');
  });

  it('parses ingest origin without wildcards', () => {
    expect(sentryIngestOrigin(DSN)).toBe('https://o1.ingest.us.sentry.io');
    expect(sentryIngestOrigin('not-a-url')).toBeUndefined();
  });
});
