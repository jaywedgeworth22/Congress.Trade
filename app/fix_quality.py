import re

with open('src/analytics/quality.ts', 'r') as f:
    code = f.read()

# Fix import to include generateTradeHash
code = code.replace("import { matchDisclosureCandidate } from '../ingestion/tradeLatency.ts';",
                    "import { matchDisclosureCandidate, generateTradeHash } from '../ingestion/tradeLatency.ts';")

# Fix CandidateRow
code = code.replace(
'''interface CandidateRow {
  doc_id: string;
  provider: string;
  chamber: string;
  source_url: string | null;
  filed_date: string | null;
  filer_name: string | null;
  congress_first_seen_at: string;
}''',
'''interface CandidateRow {
  trade_hash: string;
  doc_id: string;
  provider: string;
  chamber: string;
  source_url: string | null;
  filed_date: string | null;
  filer_name: string | null;
  congress_first_seen_at: string;
}''')

code = code.replace("disclosure_latency_candidates", "trade_latency_candidates")
code = code.replace("disclosure_provider_observations", "trade_provider_observations")

code = code.replace("SELECT doc_id, provider, chamber, source_url, filed_date, filer_name, congress_first_seen_at",
                    "SELECT trade_hash, doc_id, provider, chamber, source_url, filed_date, filer_name, congress_first_seen_at")


code = code.replace(
'''        const parsed = {
          provider: o.provider as any,
          chamber: o.chamber as 'house' | 'senate',
          providerKey: o.provider_key,
          payload: JSON.parse(o.payload || '{}'),
          sourceUrl: o.source_url,
          filedDate: o.filed_date,
          filerName: o.filer_name,
          providerPublishedAt: o.provider_published_at,
        };
        const m = matchDisclosureCandidate({ trade_hash: generateTradeHash(parsed.filerName, '', parsed.filedDate, '') } as any, parsed);
        return m !== null;''',
'''        const parsed = {
          provider: o.provider as any,
          chamber: o.chamber as 'house' | 'senate',
          providerKey: o.provider_key,
          tradeHash: o.trade_hash,
          payload: JSON.parse(o.payload || '{}'),
          sourceUrl: o.source_url,
          filedDate: o.filed_date,
          filerName: o.filer_name,
          providerPublishedAt: o.provider_published_at,
        };
        const m = matchDisclosureCandidate(candidate as any, parsed as any);
        return m !== null;''')

with open('src/analytics/quality.ts', 'w') as f:
    f.write(code)

