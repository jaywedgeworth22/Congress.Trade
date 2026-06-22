/**
 * src/shared/pace.ts
 * OWNER: shared
 *
 * Tiny per-minute rate pacer for outbound API calls. On a paid FMP tier the
 * limit is per-MINUTE (e.g. ~300/min), so a fast backfill can trip 429s if it
 * fires calls back-to-back. `createPacer(maxPerMinute)` returns an async gate to
 * `await` immediately before each call; it sleeps only as much as needed to keep
 * the average rate at or below the cap. With no cap (undefined / <= 0) it is a
 * no-op, so existing callers and tests are unaffected.
 */
export function createPacer(maxPerMinute?: number): () => Promise<void> {
  if (!maxPerMinute || maxPerMinute <= 0) return async () => {};
  const minGapMs = Math.ceil(60000 / maxPerMinute);
  let last = 0;
  return async () => {
    const wait = last + minGapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
  };
}
