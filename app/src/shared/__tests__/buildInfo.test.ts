/**
 * Guards the deploy-verification receipt (CT-AUD-P1-5).
 *
 * On 2026-08-01 six merged security PRs were reported as deployed while
 * production still served the previous image: ship.sh does not deploy (Coolify
 * does, on push to main), the webhook did not fire, and nothing in the response
 * identified the running build — so the health check passed against stale code.
 * These tests pin the two properties that make that detectable: a real SHA is
 * reported, and anything that is not a SHA reports 'unknown' rather than an
 * empty string that reads as a confident answer.
 */

import { describe, it, expect } from 'vitest';
import { readBuildInfo } from '../buildInfo.ts';

describe('readBuildInfo', () => {
  it('reports the commit Coolify supplies as SOURCE_COMMIT', () => {
    const info = readBuildInfo({ SOURCE_COMMIT: '94a3a921f0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5' });
    expect(info.sha).toBe('94a3a921f0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5');
    expect(info.shortSha).toBe('94a3a921f0b1');
  });

  it('prefers an explicit CT_BUILD_SHA over the platform variable', () => {
    const info = readBuildInfo({ CT_BUILD_SHA: 'aaaaaaaaaaaa', SOURCE_COMMIT: 'bbbbbbbbbbbb' });
    expect(info.sha).toBe('aaaaaaaaaaaa');
  });

  it('normalizes case and surrounding whitespace', () => {
    expect(readBuildInfo({ SOURCE_COMMIT: '  94A3A921F0B1  ' }).sha).toBe('94a3a921f0b1');
  });

  it("reports 'unknown' rather than a confident-looking empty answer", () => {
    // An unset Docker ARG arrives as '' — the failure mode this guards.
    expect(readBuildInfo({ SOURCE_COMMIT: '' }).sha).toBe('unknown');
    expect(readBuildInfo({}).sha).toBe('unknown');
    expect(readBuildInfo(undefined).sha).toBe('unknown');
    // Placeholders that are not git object names must not be mistaken for one.
    expect(readBuildInfo({ SOURCE_COMMIT: 'HEAD' }).sha).toBe('unknown');
    expect(readBuildInfo({ SOURCE_COMMIT: 'main' }).sha).toBe('unknown');
    expect(readBuildInfo({ SOURCE_COMMIT: '$SOURCE_COMMIT' }).sha).toBe('unknown');
    // Too short to be a git object name.
    expect(readBuildInfo({ SOURCE_COMMIT: 'abc' }).sha).toBe('unknown');
  });

  it('accepts both abbreviated and full object names', () => {
    expect(readBuildInfo({ SOURCE_COMMIT: '94a3a92' }).sha).toBe('94a3a92');
    expect(readBuildInfo({ SOURCE_COMMIT: 'f'.repeat(40) }).sha).toBe('f'.repeat(40));
    expect(readBuildInfo({ SOURCE_COMMIT: 'f'.repeat(41) }).sha).toBe('unknown');
  });
});
