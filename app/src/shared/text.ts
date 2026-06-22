/**
 * src/shared/text.ts
 * Small text-cleaning helpers shared across ingestion + backfill.
 */

/**
 * Strip HTML markup and decode common entities from a free-text field, then
 * collapse whitespace. Some upstream datasets (e.g. the Senate eFD mirror) embed
 * raw HTML in asset descriptions — `OWENS & MINOR <div class="text-muted">
 * <em>Rate/Coupon:</em> 3.875%<br>…</div>`. This reduces that to readable text:
 * `OWENS & MINOR Rate/Coupon: 3.875% Matures: …`.
 */
export function sanitizeAssetName(raw: string | null | undefined): string {
  if (raw == null) return '';
  let s = String(raw);
  // Replace block-ish tags with a space so words don't run together, drop the rest.
  s = s.replace(/<(br|\/p|\/div|\/li|\/tr|\/td)[^>]*>/gi, ' ').replace(/<[^>]*>/g, ' ');
  // Decode the handful of entities that actually show up in this data.
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');
  return s.replace(/\s+/g, ' ').trim();
}
