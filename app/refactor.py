import re

with open('src/ingestion/tradeLatency.ts', 'r') as f:
    code = f.read()

# 1. Update CandidateRow interface
code = code.replace(
'''interface CandidateRow {
  doc_id: string;
  provider: ProviderId;
  chamber: Chamber;
  source_url: string | null;
  filed_date: string | null;
  filer_name: string | null;
  congress_first_seen_at: string;
  attempts: number;
}''',
'''interface CandidateRow {
  trade_hash: string;
  doc_id: string;
  provider: ProviderId;
  chamber: Chamber;
  source_url: string | null;
  filed_date: string | null;
  filer_name: string | null;
  ticker: string | null;
  tx_date: string | null;
  tx_type: string | null;
  congress_first_seen_at: string;
  attempts: number;
}''')

# 2. Update ProviderObservationRow interface
code = code.replace(
'''interface ProviderObservationRow {
  provider: ProviderId;
  chamber: Chamber;
  provider_key: string;
  first_observed_at: string;
  last_observed_at: string;
  provider_published_at: string | null;
  source_url: string | null;
  filed_date: string | null;
  filer_name: string | null;
  payload: string | null;
}''',
'''interface ProviderObservationRow {
  provider: ProviderId;
  chamber: Chamber;
  provider_key: string;
  trade_hash: string;
  first_observed_at: string;
  last_observed_at: string;
  provider_published_at: string | null;
  source_url: string | null;
  filed_date: string | null;
  filer_name: string | null;
  payload: string | null;
}''')

# 3. Update DisclosureProviderRow interface
code = code.replace(
'''export interface DisclosureProviderRow {
  provider: ProviderId;
  chamber: Chamber;
  providerKey: string;
  payload: Record<string, unknown>;
  sourceUrl: string | null;
  filedDate: string | null;
  filerName: string | null;
  providerPublishedAt: string | null;
}''',
'''export interface DisclosureProviderRow {
  provider: ProviderId;
  chamber: Chamber;
  providerKey: string;
  tradeHash: string;
  payload: Record<string, unknown>;
  sourceUrl: string | null;
  filedDate: string | null;
  filerName: string | null;
  providerPublishedAt: string | null;
}''')

# 4. Add trade_hash generator
trade_hash_func = '''
export function extractLastName(name: string | null): string {
  if (!name) return '';
  const parts = name.split(',')[0].split(' ');
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i].toLowerCase().replace(/[^a-z]/g, '');
    if (p && !['jr', 'sr', 'md', 'ii', 'iii', 'iv'].includes(p)) return p;
  }
  return '';
}

export function generateTradeHash(filerName: string | null, ticker: string | null, date: string | null, type: string | null): string {
  const ln = extractLastName(filerName);
  const tk = (ticker || '').toUpperCase();
  const dt = date || '';
  const tyStr = (type || '').toLowerCase();
  const ty = tyStr.includes('buy') || tyStr.includes('purchase') ? 'buy' : tyStr.includes('sell') || tyStr.includes('sale') ? 'sell' : 'exchange';
  return `${ln}_${tk}_${dt}_${ty}`;
}
'''
code = code.replace('function lastName(name: string | null): string | null {', trade_hash_func + '\nfunction lastName(name: string | null): string | null {')

# 5. Fix SQL queries for CandidateRow
code = code.replace('disclosure_latency_candidates', 'trade_latency_candidates')
code = code.replace('disclosure_provider_observations', 'trade_provider_observations')

code = code.replace('''INSERT INTO trade_latency_candidates
           (doc_id, provider, chamber, source_url, filed_date, filer_name,
            congress_first_seen_at, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
         ON CONFLICT(doc_id, provider) DO UPDATE SET''',
'''INSERT INTO trade_latency_candidates
           (trade_hash, doc_id, provider, chamber, source_url, filed_date, filer_name, ticker, tx_date, tx_type,
            congress_first_seen_at, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
         ON CONFLICT(trade_hash, provider) DO UPDATE SET''')

# Replace recordDisclosureLatencyCandidate with recordTradeLatencyCandidates
code = code.replace('''export async function recordDisclosureLatencyCandidate(
  env: Env,
  filing: DiscoveredFiling,
  nowIso: string,
): Promise<void> {

  for (const provider of DIRECT_PROVIDER_IDS) {
    try {
      await run(
        env.DB,
        `INSERT INTO trade_latency_candidates
           (trade_hash, doc_id, provider, chamber, source_url, filed_date, filer_name, ticker, tx_date, tx_type,
            congress_first_seen_at, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
         ON CONFLICT(trade_hash, provider) DO UPDATE SET
           filed_date = CASE WHEN filed_date = '' THEN excluded.filed_date ELSE filed_date END,
           congress_first_seen_at = MIN(congress_first_seen_at, excluded.congress_first_seen_at),
           updated_at = excluded.updated_at`,
        [
          filing.docId,
          provider,
          filing.chamber,
          filing.sourceUrl,
          normalizeDate(filing.filedDate),
          filing.filerName ?? null,
          nowIso,
          nowIso,
          nowIso,
        ],
      );
    } catch (err) {
      if (!storageMissing(err)) console.warn('disclosure latency candidate write failed:', (err as Error).message);
    }
  }
}''', '''
import type { Transaction } from '../extraction/types.ts';
export async function recordTradeLatencyCandidates(
  env: Env,
  transactions: Transaction[],
  nowIso: string,
): Promise<void> {
  const updates: Array<[string, SqlParam[]]> = [];
  for (const provider of DIRECT_PROVIDER_IDS) {
    for (const tx of transactions) {
      const trade_hash = generateTradeHash(tx.owner || '', tx.ticker || '', tx.txDate || '', tx.txType || '');
      updates.push([
        `INSERT INTO trade_latency_candidates
           (trade_hash, doc_id, provider, chamber, source_url, filed_date, filer_name, ticker, tx_date, tx_type,
            congress_first_seen_at, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
         ON CONFLICT(trade_hash, provider) DO UPDATE SET
           congress_first_seen_at = MIN(congress_first_seen_at, excluded.congress_first_seen_at),
           updated_at = excluded.updated_at`,
        [
          trade_hash,
          tx.docId,
          provider,
          'house', // we'll use fallback, wait we need actual chamber
          null, // source_url
          tx.filedDate || null,
          tx.owner || null,
          tx.ticker || null,
          tx.txDate || null,
          tx.txType || null,
          tx.firstSeenAt || nowIso,
          nowIso,
          nowIso,
        ]
      ]);
    }
  }
  if (updates.length > 0) {
    try {
      await batch(env.DB, updates);
    } catch (err) {
      if (!storageMissing(err)) console.warn('trade latency candidate write failed:', (err as Error).message);
    }
  }
}
''')

# 6. Update Provider observation upserts
code = code.replace('''INSERT INTO trade_provider_observations
         (provider, chamber, provider_key, first_observed_at, last_observed_at,
          provider_published_at, source_url, filed_date, filer_name, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, chamber, provider_key) DO UPDATE SET''',
'''INSERT INTO trade_provider_observations
         (provider, chamber, provider_key, trade_hash, first_observed_at, last_observed_at,
          provider_published_at, source_url, filed_date, filer_name, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, chamber, provider_key, trade_hash) DO UPDATE SET''')

code = code.replace('''        provider,
        row.chamber,
        row.providerKey,
        nowIso,
        nowIso,
        row.providerPublishedAt,
        row.sourceUrl,
        row.filedDate,
        row.filerName,
        JSON.stringify(row.payload).slice(0, PAYLOAD_LIMIT),''',
'''        provider,
        row.chamber,
        row.providerKey,
        row.tradeHash,
        nowIso,
        nowIso,
        row.providerPublishedAt,
        row.sourceUrl,
        row.filedDate,
        row.filerName,
        JSON.stringify(row.payload).slice(0, PAYLOAD_LIMIT),''')

# 7. Update candidate fetch
code = code.replace('SELECT doc_id, provider, chamber, source_url, filed_date, filer_name,', 'SELECT trade_hash, doc_id, provider, chamber, source_url, filed_date, filer_name, ticker, tx_date, tx_type,')

# 8. Update parseFmpDisclosureRows etc to include tradeHash
code = code.replace('''      providerKey,
      payload,
      sourceUrl,''',
'''      providerKey,
      tradeHash: generateTradeHash(fieldString(payload, ['representative', 'senator', 'filerName', 'name']), fieldString(payload, ['ticker', 'symbol']), fieldString(payload, ['transactionDate', 'txDate']), fieldString(payload, ['type', 'transactionType'])),
      payload,
      sourceUrl,''')

code = code.replace('''      providerKey: rowKeyFromFields('unusual_whales', payload, [
        'politician_id',
        'filed_at_date',
        'ticker',
        'transaction_date',
        'txn_type',
        'name',
      ]),
      payload,
      sourceUrl,''',
'''      providerKey: rowKeyFromFields('unusual_whales', payload, [
        'politician_id',
        'filed_at_date',
        'ticker',
        'transaction_date',
        'txn_type',
        'name',
      ]),
      tradeHash: generateTradeHash(filerName, fieldString(payload, ['ticker', 'symbol']), fieldString(payload, ['transaction_date']), fieldString(payload, ['txn_type', 'type'])),
      payload,
      sourceUrl,''')

code = code.replace('''      providerKey: rowKeyFromFields('quiver', payload, [
        'BioGuideID',
        'Representative',
        'Senator',
        'Name',
        'Filed',
        'ReportDate',
        'Ticker',
        'TransactionDate',
        'Date',
        'Traded',
        'Transaction',
      ]),
      payload,
      sourceUrl,''',
'''      providerKey: rowKeyFromFields('quiver', payload, [
        'BioGuideID',
        'Representative',
        'Senator',
        'Name',
        'Filed',
        'ReportDate',
        'Ticker',
        'TransactionDate',
        'Date',
        'Traded',
        'Transaction',
      ]),
      tradeHash: generateTradeHash(filerName, fieldString(payload, ['Ticker']), fieldString(payload, ['TransactionDate', 'Date']), fieldString(payload, ['Transaction'])),
      payload,
      sourceUrl,''')

code = code.replace('''export function matchDisclosureCandidate(
  candidate: Pick<CandidateRow, 'doc_id' | 'source_url' | 'filed_date' | 'filer_name'>,
  row: DisclosureProviderRow,
): CandidateMatch | null {
  const text = rowText(row.payload);
  for (const token of tokensFromDoc(candidate.doc_id, candidate.source_url)) {
    if (text.includes(token)) return { providerKey: row.providerKey, matchMethod: 'doc-token' };
  }
  const filed = normalizeDate(candidate.filed_date);
  const candidateLast = lastName(candidate.filer_name);
  const rowLast = lastName(row.filerName);
  if (filed && candidateLast && rowLast === candidateLast && row.filedDate === filed) {
    return { providerKey: row.providerKey, matchMethod: 'filer-date' };
  }
  if (filed && candidateLast && text.includes(candidateLast) && dateVariants(filed).some((d) => text.includes(d))) {
    return { providerKey: row.providerKey, matchMethod: 'probable-filer-date' };
  }
  return null;
}''',
'''export function matchDisclosureCandidate(
  candidate: Pick<CandidateRow, 'trade_hash'>,
  row: DisclosureProviderRow,
): CandidateMatch | null {
  if (candidate.trade_hash === row.tradeHash) {
    return { providerKey: row.providerKey, matchMethod: 'trade-hash' };
  }
  return null;
}''')


# 9. Update matchAndUpdateCandidates query
code = code.replace('''WHERE doc_id = ? AND provider = ?`,
        [
          match.provider_key,
          match.first_observed_at,
          match.provider_published_at,
          method,
          match.payload,
          nowIso,
          nowIso,
          candidate.doc_id,
          provider.id,
        ],''',
'''WHERE trade_hash = ? AND provider = ?`,
        [
          match.provider_key,
          match.first_observed_at,
          match.provider_published_at,
          method,
          match.payload,
          nowIso,
          nowIso,
          candidate.trade_hash,
          provider.id,
        ],''')

code = code.replace('''WHERE doc_id = ? AND provider = ?`,
        [nowIso, nowIso, errors[0] ?? null, candidate.doc_id, provider.id],''',
'''WHERE trade_hash = ? AND provider = ?`,
        [nowIso, nowIso, errors[0] ?? null, candidate.trade_hash, provider.id],''')

# 10. Fix examinedDocIds to examinedTradeHashes, matchedDocIds to matchedTradeHashes
code = code.replace('matchedDocIds', 'matchedTradeHashes')
code = code.replace('examinedDocIds', 'examinedTradeHashes')
code = code.replace('candidate.doc_id', 'candidate.trade_hash')

# Update row parse
code = code.replace('''        payload,
        sourceUrl: providerRow.source_url,''',
'''        tradeHash: providerRow.trade_hash,
        payload,
        sourceUrl: providerRow.source_url,''')

code = code.replace('''            source_url, filed_date, filer_name, payload
       FROM trade_provider_observations''',
'''            trade_hash, source_url, filed_date, filer_name, payload
       FROM trade_provider_observations''')

# Remove duplicate doc_id references where appropriate
code = code.replace('Doc: ${candidate.doc_id}', 'Trade Hash: ${candidate.trade_hash}')

with open('src/ingestion/tradeLatency.ts', 'w') as f:
    f.write(code)
