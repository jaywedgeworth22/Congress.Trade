import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import { loadDocBytes } from '../agreement.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadDocBytes lease cancellation', () => {
  it('propagates the lease signal to source_url fallback and rethrows abort', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      controller.abort(new Error('lease lost'));
      throw controller.signal.reason;
    });
    vi.stubGlobal('fetch', fetchMock);
    const env = {
      RAW_FILES: { get: vi.fn(async () => null) },
      DB: {
        prepare: vi.fn(() => ({
          bind() { return this; },
          first: vi.fn(async () => ({ source_url: 'https://example.test/filing.pdf' })),
        })),
      },
    } as unknown as Env;

    await expect(loadDocBytes(env, 'H-abort', 'raw/H-abort', controller.signal))
      .rejects.toThrow('lease lost');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
