/**
 * Map internal `transactions.cleaning_note` audit strings to concise plain-English
 * fragments for feed/API display. Incomplete sentences, no forced title case.
 *
 * Owner (2026-08-09): notes like "Populated official company name from
 * securities_ref" should read as "asset name derived from ticker".
 */
export function plainCleaningNote(raw: string | null | undefined): string {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s) return '';

  if (
    s === 'Populated official company name from securities_ref' ||
    s === 'asset name derived from ticker'
  ) {
    return 'asset name derived from ticker';
  }

  if (/^Cleaned OCR dot leader noise/i.test(s)) {
    return 'cleaned OCR noise from asset name';
  }
  if (/^Stripped OCR dot leader suffix/i.test(s)) {
    return 'removed OCR noise from asset name';
  }
  if (/^Cleaned junk OCR text/i.test(s)) {
    return 'removed junk OCR from asset name';
  }

  // Already-plain rewrites (idempotent after migrate).
  if (
    s === 'cleaned OCR noise from asset name' ||
    s === 'removed OCR noise from asset name' ||
    s === 'removed junk OCR from asset name'
  ) {
    return s;
  }

  // Disclosure-machinery notes emitted by cleanAssetName()
  // (extraction/nameNormalizer.ts). These are already written as plain
  // fragments — the House type code, the footnote markers, the Senate eFD
  // "Rate/Coupon: … Matures: …" suffix, and the second leg of an exchange —
  // and several can be joined with "; " on one row. Listed explicitly so the
  // idempotency contract is visible rather than resting on the pass-through
  // at the bottom of this function.
  if (
    s === 'removed disclosure type code from asset name' ||
    s === 'removed filing footnote markers from asset name' ||
    /^\d+(?:\.\d+)?% coupon(?:, matures \d{1,2}\/\d{1,2}\/\d{2,4})?$/.test(s) ||
    /^matures \d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s) ||
    /^exchanged for .+$/.test(s) ||
    s.includes('; ')
  ) {
    return s;
  }

  return s;
}
