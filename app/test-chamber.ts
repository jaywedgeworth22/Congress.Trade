function fieldString(obj: unknown, keys: string[]): string | null {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    if (k in obj) {
      const v = (obj as any)[k];
      if (typeof v === 'string') return v;
      if (typeof v === 'number') return String(v);
    }
  }
  return null;
}
function normalizeChamber(raw: string | null, fallback: string): string {
  const s = (raw ?? '').toLowerCase();
  if (s.includes('executive') || s.includes('president') || s.includes('whitehouse')) return 'executive';
  if (s.includes('senate') || s.includes('senator')) return 'senate';
  if (s.includes('house') || s.includes('representative') || s.includes('representatives')) return 'house';
  return fallback;
}
const payload = {"name":"Donald J Trump","ticker":"DHR","issuer":"undisclosed","is_active":true,"transaction_date":"2026-05-22","notes":"DANAHER CORP","politician_id":"888dc73f-f1eb-485a-a241-80657aaaaff9","reporter":"Donald J Trump","txn_type":"Sell","amounts":"$15,001 - $50,000","filed_at_date":"2026-07-01","member_type":"executive"};
console.log("fieldString:", fieldString(payload, ['member_type', 'chamber']));
console.log("normalizeChamber:", normalizeChamber(fieldString(payload, ['member_type', 'chamber']), 'house'));
