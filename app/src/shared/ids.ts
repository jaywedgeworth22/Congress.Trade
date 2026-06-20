/**
 * src/shared/ids.ts
 * ID + monotonic sequence helpers. Implemented (not a stub).
 */

/** RFC4122 v4 UUID via the Workers-provided Web Crypto. */
export function uuid(): string {
  return crypto.randomUUID();
}

/**
 * Generate a prefixed id, e.g. id('tx') => 'tx_9f1c...'. Useful for making
 * primary keys self-describing in logs.
 */
export function prefixedId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

/**
 * Monotonic, lexically-sortable id: zero-padded epoch-millis + random suffix.
 * Handy where a sortable string key is preferable to a UUID (e.g. object keys).
 * NOTE: not a replacement for the DB-backed transactions.cursor_seq cursor,
 * which is the authoritative ordering for delivery.
 */
let __lastMs = 0;
let __seq = 0;
export function monotonicId(): string {
  const now = Date.now();
  if (now === __lastMs) {
    __seq += 1;
  } else {
    __lastMs = now;
    __seq = 0;
  }
  const ms = now.toString().padStart(15, '0');
  const seq = __seq.toString().padStart(4, '0');
  const rand = crypto.randomUUID().slice(0, 8);
  return `${ms}-${seq}-${rand}`;
}

/** Build an R2 object key for a raw disclosure file. */
export function rawObjectKey(chamber: string, docId: string, ext: string): string {
  const safeExt = ext.replace(/^\./, '');
  return `raw/${chamber}/${docId}.${safeExt}`;
}
