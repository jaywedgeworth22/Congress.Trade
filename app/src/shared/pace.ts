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
  // `next` is the earliest timestamp the NEXT call may fire. Each invocation
  // claims its slot synchronously — advancing `next` BEFORE it awaits — so
  // callers that enter concurrently (house+senate via Promise.all, or an
  // enrichment run overlapping the probe in the same isolate) are handed
  // distinct, staggered slots instead of all reading one stale timestamp and
  // firing together. Reads/writes of `next` never straddle an await, so the
  // single-threaded event loop makes this reservation race-free.
  let next = 0;
  return async () => {
    const now = Date.now();
    const scheduled = Math.max(now, next);
    next = scheduled + minGapMs;
    const wait = scheduled - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };
}

/**
 * Process-wide FMP pacer shared by every FMP consumer (enrichment, price
 * refresh, and the disclosure-latency probe). Each of those used to build its
 * OWN `createPacer(...)` per invocation, so two runs firing concurrently in the
 * same isolate would each see only their own calls and could jointly exceed the
 * per-minute cap. Drawing them all from this single closure serializes their
 * FMP calls against one shared minute-rate gate.
 *
 * Lazily created on first use and memoized at module scope for the lifetime of
 * the Worker isolate. To support Infisical-live updates, the pacer is rebuilt
 * if a new caller requests a different `maxPerMinute` ceiling than the one
 * currently cached.
 *
 * NOTE: this coordinates only calls made within the SAME isolate. Cloudflare
 * may run multiple concurrent isolates, which do not share this closure, so
 * this is NOT a global cross-instance rate limit.
 */
let sharedFmpPacer: { pacer: () => Promise<void>; cap?: number } | null = null;
export function getSharedFmpPacer(maxPerMinute?: number): () => Promise<void> {
  if (!sharedFmpPacer || sharedFmpPacer.cap !== maxPerMinute) {
    sharedFmpPacer = { pacer: createPacer(maxPerMinute), cap: maxPerMinute };
  }
  return sharedFmpPacer.pacer;
}

/** Test-only: drop the memoized singleton so each test starts from a clean gate. */
export function __resetSharedFmpPacerForTests(): void {
  sharedFmpPacer = null;
}

/**
 * Process-wide SEC EDGAR pacer. SEPARATE from the FMP pacer above and NOT
 * drawn from the same budget: EDGAR is a different provider with its own
 * fair-access limit (SEC documents an approx 10 req/s ceiling), independent of
 * FMP's per-minute plan cap. Same lazily-created, memoized-at-module-scope
 * singleton shape as `getSharedFmpPacer` — see that doc comment for the
 * per-isolate-only caveat and the ceiling-change rebuild logic,
 * both of which apply here too.
 */
let sharedEdgarPacer: { pacer: () => Promise<void>; cap?: number } | null = null;
export function getSharedEdgarPacer(maxPerMinute?: number): () => Promise<void> {
  if (!sharedEdgarPacer || sharedEdgarPacer.cap !== maxPerMinute) {
    sharedEdgarPacer = { pacer: createPacer(maxPerMinute), cap: maxPerMinute };
  }
  return sharedEdgarPacer.pacer;
}

/** Test-only: drop the memoized singleton so each test starts from a clean gate. */
export function __resetSharedEdgarPacerForTests(): void {
  sharedEdgarPacer = null;
}
