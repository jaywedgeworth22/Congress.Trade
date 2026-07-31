/**
 * src/prices/retry429.ts
 * OWNER: prices
 *
 * Bounded 429 retry for the unmetered price providers (Massive, Tiingo). Their
 * API keys are shared across several sibling apps, so per-minute
 * "maximum requests per minute" 429s are routine and self-clearing — retry with
 * exponential backoff before giving up, instead of letting the first 429 of the
 * day sink the whole price refresh.
 */

export interface Retry429Options {
  /** Sleep between attempts; injectable so tests don't wait real seconds. */
  sleep?: (ms: number) => Promise<void>;
  /** Randomness source for jitter; injectable for deterministic tests. */
  random?: () => number;
}

/** Base waits before retries 1..3 (ms), jittered ±20% per attempt. */
const RETRY_WAITS_MS = [5_000, 15_000, 30_000];
/** Never wait longer than this, even if a Retry-After header asks for more. */
const MAX_WAIT_MS = 60_000;

function waitMs(res: Response, attempt: number, random: () => number): number {
  const retryAfterSec = Number(res.headers.get('retry-after') ?? '');
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    return Math.min(retryAfterSec * 1000, MAX_WAIT_MS);
  }
  const base = RETRY_WAITS_MS[Math.min(attempt, RETRY_WAITS_MS.length - 1)];
  return Math.min(Math.round(base * (0.8 + 0.4 * random())), MAX_WAIT_MS);
}

/**
 * Run `call`, retrying HTTP 429 responses with bounded exponential backoff: the
 * initial attempt plus up to 3 retries (~5s/15s/30s, jittered; a Retry-After
 * header is honored, capped at 60s). Any other status — success or failure —
 * is returned as-is on the first attempt. The final 429 response is returned
 * once the retry budget is exhausted, for the caller to classify.
 */
export async function with429Retries(
  call: () => Promise<Response>,
  opts: Retry429Options = {},
): Promise<Response> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = opts.random ?? Math.random;
  let res = await call();
  for (let attempt = 0; attempt < RETRY_WAITS_MS.length && res.status === 429; attempt++) {
    await sleep(waitMs(res, attempt, random));
    res = await call();
  }
  return res;
}
