/**
 * src/ingestion/__tests__/sourceError.test.ts
 *
 * isTransientSourceError() decides whether a watcher source failure is a
 * recoverable upstream/platform condition (logged at warn, not error). This
 * keeps recurring anti-bot 403s and transient D1 limits from dominating the
 * observability error stream.
 */

import { describe, it, expect } from 'vitest';
import { isTransientSourceError } from '../watcher';

describe('isTransientSourceError', () => {
  it('treats anti-bot 403 and rate-limit 429 as transient', () => {
    expect(isTransientSourceError('senate GET /search/ -> HTTP 403')).toBe(true);
    expect(isTransientSourceError('senate POST report/data/ -> HTTP 429')).toBe(true);
  });

  it('treats transient D1/Workers platform conditions as transient', () => {
    expect(isTransientSourceError('D1_ERROR: Network connection lost.')).toBe(true);
    expect(isTransientSourceError('Error: D1_ERROR: D1 DB is overloaded. Requests queued for too long.')).toBe(true);
    expect(isTransientSourceError('Too many API requests by single Worker invocation.')).toBe(true);
    expect(
      isTransientSourceError('D1_ERROR: Internal error in D1 DB storage caused object to be reset; reference = abc'),
    ).toBe(true);
  });

  it('treats genuine errors (parse/4xx-other/5xx) as non-transient', () => {
    expect(isTransientSourceError('senate: csrfmiddlewaretoken not found on landing page')).toBe(false);
    expect(isTransientSourceError('senate GET /search/ -> HTTP 500')).toBe(false);
    expect(isTransientSourceError('TypeError: cannot read property of undefined')).toBe(false);
  });
});
