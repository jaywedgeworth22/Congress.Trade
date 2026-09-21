/**
 * src/shared/deadlineFetch.ts
 * OWNER: shared
 *
 * A `fetch` wrapper that gives every upstream call its OWN deadline, and ties
 * that call to a caller-supplied abort signal.
 *
 * Why this exists (CONGRESS-TRADE-1B).  The Deno cron tick races the whole
 * pipeline against a hard deadline (`CT_TICK_DEADLINE_MS`, default 45,000 ms)
 * and aborts an `AbortController` five seconds earlier so lanes can stop
 * cleanly.  That machinery only works for code that actually watches the
 * signal.  Lanes that reached off-box through the bare global `fetch` did not:
 * Deno's `fetch` has no default timeout, so one slow peer call — or a long
 * serial run of them — sailed past the soft abort, past the hard deadline, and
 * kept running after `Promise.race` had already rejected the tick.  The
 * abandoned work then overlapped the next tick and made it slower still.
 *
 * Two properties matter here and both are load-bearing:
 *
 *  1. The per-request timeout must be SHORTER than the tick deadline.  A
 *     request that cannot finish inside its own budget is not worth the tick's
 *     remaining time; the row it would have served stays pending and is picked
 *     up by the next tick.
 *  2. The tick signal must cancel work already in flight, not merely stop the
 *     next iteration.  Combining the two signals means the soft abort tears
 *     down open sockets instead of leaving them to finish unattended.
 *
 * A caller that passes its own `init.signal` keeps it — all three signals are
 * combined, and whichever fires first wins.
 */

/**
 * Per-request budget for upstream calls made inside the Deno cron tick.
 *
 * Deliberately far below the 45,000 ms tick deadline: the tick's job is to
 * make steady incremental progress every few minutes, not to wait out one
 * unresponsive peer.  Ten seconds is roughly twenty times the observed
 * per-call latency of the peer market-data routes, so a healthy call is never
 * cut short, while a hung one costs the tick a bounded amount of time.
 */
export const DEFAULT_TICK_FETCH_TIMEOUT_MS = 10_000;

/**
 * The per-call budget to use inside a run whose whole-run deadline is
 * `deadlineMs`.
 *
 * Capped at a quarter of the deadline so the invariant "a single upstream call
 * cannot consume the run" holds at every configured deadline, not just the
 * default one.  `CT_TICK_DEADLINE_MS` accepts values as low as 10,000 ms, and
 * at that setting a flat ten-second call budget would be the entire tick.
 */
export function resolveUpstreamTimeoutMs(deadlineMs: number): number {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return DEFAULT_TICK_FETCH_TIMEOUT_MS;
  return Math.max(1_000, Math.min(DEFAULT_TICK_FETCH_TIMEOUT_MS, Math.floor(deadlineMs / 4)));
}

export interface DeadlineFetchOptions {
  /** Per-request budget in milliseconds.  Must be shorter than the deadline
   *  of whatever is calling, or it buys nothing. */
  timeoutMs?: number;
  /** Outer deadline (the tick's soft abort).  Cancels calls already in flight. */
  signal?: AbortSignal;
}

/** Thrown when a single upstream call outlives its own budget. */
export function upstreamTimeoutError(timeoutMs: number): Error {
  const error = new Error(`upstream request exceeded ${timeoutMs}ms budget`);
  error.name = 'TimeoutError';
  return error;
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error('upstream request aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Combine any number of signals into one.  Prefers the platform's
 * `AbortSignal.any` (Deno 2.x, Node 20.3+) and falls back to manual wiring so
 * the helper stays usable under an older runtime rather than silently
 * dropping a signal — dropping one is exactly the failure this module exists
 * to remove.
 */
function combineSignals(signals: AbortSignal[]): { signal: AbortSignal; dispose: () => void } {
  const live = signals.filter((s): s is AbortSignal => Boolean(s));
  if (live.length === 1) return { signal: live[0]!, dispose: () => {} };

  const anyFn = (AbortSignal as unknown as { any?: (list: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') {
    return { signal: anyFn.call(AbortSignal, live), dispose: () => {} };
  }

  const controller = new AbortController();
  const listeners: Array<() => void> = [];
  for (const source of live) {
    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }
    const onAbort = () => controller.abort(source.reason);
    source.addEventListener('abort', onAbort, { once: true });
    listeners.push(() => source.removeEventListener('abort', onAbort));
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const remove of listeners) remove();
    },
  };
}

/**
 * Wrap a `fetch` so every call it makes carries a timeout of its own and dies
 * with the outer signal.
 *
 * The timeout covers the whole exchange, body included, not just the moment
 * the response headers arrive — a peer that answers `200` and then stalls
 * mid-body is exactly as damaging to a time-boxed tick as one that never
 * answers, and clearing the timer when `fetch()` resolves would leave that
 * case uncovered.
 *
 * A call made after the outer signal has already fired rejects without
 * opening a socket, so an aborted tick stops costing the peer traffic
 * immediately rather than draining the rest of its work list.
 */
export function createDeadlineFetch(
  fetchImpl?: typeof fetch,
  options: DeadlineFetchOptions = {},
): typeof fetch {
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TICK_FETCH_TIMEOUT_MS);
  const outer = options.signal;
  // Late-bound on purpose when no implementation is given: the wrapper is
  // built once when a run starts but used for the whole run, so it must see
  // whatever `globalThis.fetch` is at call time rather than capturing the
  // reference that happened to exist at construction.
  const call: typeof fetch = fetchImpl
    ?? (((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init)) as typeof fetch);

  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (outer?.aborted) throw abortError(outer.reason);

    const timeoutController = new AbortController();
    const sources: AbortSignal[] = [timeoutController.signal];
    if (outer) sources.push(outer);
    if (init?.signal) sources.push(init.signal);
    const combined = combineSignals(sources);

    const timer = setTimeout(() => {
      timeoutController.abort(upstreamTimeoutError(timeoutMs));
      combined.dispose();
    }, timeoutMs);

    try {
      return await call(input, { ...init, signal: combined.signal });
    } catch (err) {
      // The exchange is over, so nothing is left for the budget to protect.
      clearTimeout(timer);
      combined.dispose();
      throw err;
    }
    // Deliberately NOT cleared on success: the response body is still to be
    // read, and a peer that answers 200 and then stalls mid-body would hang a
    // time-boxed tick exactly as badly as one that never answers.  The timer
    // disposes itself when it fires, and firing against an already-consumed
    // response is a no-op.
  };

  return wrapped as unknown as typeof fetch;
}
