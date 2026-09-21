import { describe, expect, it, vi } from 'vitest';
import {
  createDeadlineFetch,
  DEFAULT_TICK_FETCH_TIMEOUT_MS,
  resolveUpstreamTimeoutMs,
} from '../deadlineFetch.ts';

/** A peer that never answers, and only settles when its request is aborted —
 *  the shape of upstream call that used to run past the tick deadline. */
function hangingFetch(seen: AbortSignal[] = []): typeof fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        seen.push(signal);
        signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), {
          once: true,
        });
      }
    })) as unknown as typeof fetch;
}

describe('resolveUpstreamTimeoutMs', () => {
  it('uses the flat default at the standard 45s tick deadline', () => {
    expect(resolveUpstreamTimeoutMs(45_000)).toBe(DEFAULT_TICK_FETCH_TIMEOUT_MS);
  });

  it('never lets one call own more than a quarter of a short deadline', () => {
    // CT_TICK_DEADLINE_MS accepts 10_000; a flat 10s budget would be the
    // entire tick, which is the same as having no budget at all.
    expect(resolveUpstreamTimeoutMs(10_000)).toBe(2_500);
    expect(resolveUpstreamTimeoutMs(20_000)).toBe(5_000);
  });

  it('keeps a floor so a misconfigured deadline cannot make every call fail', () => {
    expect(resolveUpstreamTimeoutMs(100)).toBe(1_000);
  });

  it('falls back to the default for a nonsense deadline', () => {
    expect(resolveUpstreamTimeoutMs(Number.NaN)).toBe(DEFAULT_TICK_FETCH_TIMEOUT_MS);
    expect(resolveUpstreamTimeoutMs(0)).toBe(DEFAULT_TICK_FETCH_TIMEOUT_MS);
  });
});

describe('createDeadlineFetch', () => {
  it('gives a hung call its own deadline instead of waiting forever', async () => {
    const wrapped = createDeadlineFetch(hangingFetch(), { timeoutMs: 25 });
    await expect(wrapped('https://peer.example/api/market/intraday/AAPL')).rejects.toMatchObject({
      name: 'TimeoutError',
    });
  });

  it('lets a healthy call through untouched', async () => {
    const inner = vi.fn(async () => new Response('{"bars":[]}', { status: 200 })) as unknown as typeof fetch;
    const wrapped = createDeadlineFetch(inner, { timeoutMs: 5_000 });
    const res = await wrapped('https://peer.example/api/market/quotes?symbols=AAPL');
    expect(res.status).toBe(200);
    expect(inner).toHaveBeenCalledOnce();
  });

  it('cancels a call already in flight when the outer deadline fires', async () => {
    const controller = new AbortController();
    const wrapped = createDeadlineFetch(hangingFetch(), {
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    const pending = wrapped('https://peer.example/api/market/intraday/NVDA');
    controller.abort(new Error('Deno cron tick nearing 45000ms deadline'));
    await expect(pending).rejects.toThrow('Deno cron tick nearing 45000ms deadline');
  });

  it('refuses to open a socket once the outer deadline has already passed', async () => {
    const inner = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const controller = new AbortController();
    controller.abort(new Error('Deno cron tick nearing 45000ms deadline'));
    const wrapped = createDeadlineFetch(inner, { timeoutMs: 5_000, signal: controller.signal });

    await expect(wrapped('https://peer.example/api/market/quotes')).rejects.toThrow(
      'Deno cron tick nearing 45000ms deadline',
    );
    // The point of the early exit: an aborted tick stops costing the peer
    // traffic immediately rather than draining the rest of its work list.
    expect(inner).not.toHaveBeenCalled();
  });

  it("keeps the caller's own signal working alongside the budget", async () => {
    const callerAbort = new AbortController();
    const wrapped = createDeadlineFetch(hangingFetch(), { timeoutMs: 60_000 });
    const pending = wrapped('https://peer.example/api/market/quotes', { signal: callerAbort.signal });
    callerAbort.abort(new Error('caller changed its mind'));
    await expect(pending).rejects.toThrow('caller changed its mind');
  });

  it('scopes the budget per call, not per wrapper', async () => {
    const inner = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const wrapped = createDeadlineFetch(inner, { timeoutMs: 25 });
    await wrapped('https://peer.example/one');
    await new Promise((resolve) => setTimeout(resolve, 40));
    // A wrapper whose budget were shared would have expired by now.
    const res = await wrapped('https://peer.example/two');
    expect(res.status).toBe(200);
  });
});
