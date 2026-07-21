/**
 * src/analytics/quality.ts
 *
 * Quality cross-check report logic comparing our parsed production transactions
 * against historical FMP and Quiver Quant observations to identify quality
 * discrepancies (missed trades, extra extractions, ticker/detail mismatches).
 */

import type { Env } from '../shared/types.ts';
import { all } from '../shared/db.ts';
import { matchDisclosureCandidate } from '../ingestion/fmpDisclosureLatency.ts';

interface CandidateRow {
  doc_id: string;
  provider: string;
  chamber: string;
  source_url: string | null;
  filed_date: string | null;
  filer_name: string | null;
  provider_key: string | null;
}

interface ObservationRow {
  provider: string;
  chamber: string;
  provider_key: string;
  first_observed_at: string;
  provider_published_at: string | null;
  source_url: string | null;
  filed_date: string | null;
  filer_name: string | null;
  payload: string | null;
}

interface TransactionRow {
  ticker: string;
  tx_date: string;
  tx_type: string;
}

export interface QualityTx {
  ticker: string;
  txDate: string;
  txType: string;
}

export interface ProviderQualityMetrics {
  filingsCompared: number;
  totalUsTx: number;
  totalProviderTx: number;
  agreed: number;
  onlyUs: number;
  onlyProvider: number;
  discrepancyRatePct: number;
}

export interface QualityFilingDetail {
  docId: string;
  provider: string;
  filerName: string | null;
  filedDate: string | null;
  usCount: number;
  providerCount: number;
  agreed: string[];
  onlyUs: string[];
  onlyProvider: string[];
}

export interface QualityCrosscheckResult {
  generatedAt: string;
  summary: {
    fmp: ProviderQualityMetrics;
    quiver: ProviderQualityMetrics;
    unusual_whales: ProviderQualityMetrics;
  };
  details: QualityFilingDetail[];
}

function normalizeType(raw: string | null): string {
  const s = (raw ?? '').trim().toLowerCase();
  if (s.startsWith('p')) return 'purchase';
  if (s.startsWith('s')) return 'sale';
  if (s.startsWith('e')) return 'exchange';
  return s;
}

function normalizeDate(raw: string | null): string {
  if (!raw) return '';
  const clean = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) return clean;
  // Fallback parsed date check
  const d = new Date(clean);
  if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  return clean;
}

function txKey(tx: QualityTx): string {
  const ticker = (tx.ticker ?? '').trim().toUpperCase() || 'UNKNOWN';
  const date = normalizeDate(tx.txDate);
  const type = normalizeType(tx.txType);
  return `${ticker}|${date}|${type}`;
}

export async function getQualityCrosscheck(env: Env): Promise<QualityCrosscheckResult> {
  // 1) Fetch matched candidates
  const candidates = await all<CandidateRow>(
    env.DB,
    `SELECT doc_id, provider, chamber, source_url, filed_date, filer_name, provider_key
       FROM disclosure_latency_candidates
      WHERE status = 'matched'`
  );

  // 2) Group candidates by provider
  const fmpCandidates = candidates.filter((c) => c.provider === 'fmp');
  const quiverCandidates = candidates.filter((c) => c.provider === 'quiver');
  const uwCandidates = candidates.filter((c) => c.provider === 'unusual_whales');

  // 3) Fetch observations for FMP, Quiver, and Unusual Whales
  const observations = await all<ObservationRow>(
    env.DB,
    `SELECT provider, chamber, provider_key, first_observed_at, provider_published_at, source_url, filed_date, filer_name, payload
       FROM disclosure_provider_observations
      WHERE provider IN ('fmp', 'quiver', 'unusual_whales')`
  );

  const fmpObs = observations.filter((o) => o.provider === 'fmp');
  const quiverObs = observations.filter((o) => o.provider === 'quiver');
  const uwObs = observations.filter((o) => o.provider === 'unusual_whales');

  const details: QualityFilingDetail[] = [];

  // Helper to process a list of candidates against observations
  async function processProvider(
    providerId: 'fmp' | 'quiver' | 'unusual_whales',
    provCandidates: CandidateRow[],
    provObs: ObservationRow[]
  ): Promise<ProviderQualityMetrics> {
    let totalUsTx = 0;
    let totalProviderTx = 0;
    let agreedCount = 0;
    let onlyUsCount = 0;
    let onlyProviderCount = 0;
    let filingsCompared = 0;

    for (const candidate of provCandidates) {
      // Find all observations for this candidate filing
      const matchedObs = provObs.filter((o) => {
        // Parse observation for matching logic
        const parsed = {
          provider: o.provider as any,
          chamber: o.chamber as 'house' | 'senate',
          providerKey: o.provider_key,
          payload: JSON.parse(o.payload || '{}'),
          sourceUrl: o.source_url,
          filedDate: o.filed_date,
          filerName: o.filer_name,
          providerPublishedAt: o.provider_published_at,
        };
        const m = matchDisclosureCandidate(candidate as any, parsed);
        return m !== null;
      });

      if (!matchedObs.length) continue;

      // Extract provider transactions from payload
      const providerTxs: QualityTx[] = matchedObs.flatMap((o) => {
        const payload = JSON.parse(o.payload || '{}');
        if (providerId === 'fmp') {
          return [{
            ticker: String(payload.symbol ?? payload.ticker ?? ''),
            txDate: String(payload.transactionDate ?? ''),
            txType: String(payload.type ?? ''),
          }];
        } else if (providerId === 'quiver') {
          return [{
            ticker: String(payload.Ticker ?? ''),
            txDate: String(payload.Date ?? ''),
            txType: String(payload.Transaction ?? ''),
          }];
        } else {
          return [{
            ticker: String(payload.ticker ?? payload.symbol ?? ''),
            txDate: String(payload.transaction_date ?? payload.transactionDate ?? ''),
            txType: String(payload.txn_type ?? payload.type ?? ''),
          }];
        }
      }).filter((tx) => tx.ticker && tx.txDate);

      // Fetch our parsed transactions for this filing
      const ourTxsRaw = await all<TransactionRow>(
        env.DB,
        `SELECT ticker, tx_date, tx_type FROM transactions WHERE doc_id = ?`,
        [candidate.doc_id]
      );

      const ourTxs: QualityTx[] = ourTxsRaw.map((tx) => ({
        ticker: tx.ticker,
        txDate: tx.tx_date,
        txType: tx.tx_type,
      }));

      // Calculate sets
      const usKeys = new Set(ourTxs.map(txKey));
      const providerKeys = new Set(providerTxs.map(txKey));

      const agreed: string[] = [];
      const onlyUs: string[] = [];
      const onlyProvider: string[] = [];

      for (const key of usKeys) {
        if (providerKeys.has(key)) {
          agreed.push(key);
        } else {
          onlyUs.push(key);
        }
      }

      for (const key of providerKeys) {
        if (!usKeys.has(key)) {
          onlyProvider.push(key);
        }
      }

      totalUsTx += usKeys.size;
      totalProviderTx += providerKeys.size;
      agreedCount += agreed.length;
      onlyUsCount += onlyUs.length;
      onlyProviderCount += onlyProvider.length;
      filingsCompared++;

      details.push({
        docId: candidate.doc_id,
        provider: providerId,
        filerName: candidate.filer_name,
        filedDate: candidate.filed_date,
        usCount: usKeys.size,
        providerCount: providerKeys.size,
        agreed,
        onlyUs,
        onlyProvider,
      });
    }

    const totalDiff = onlyUsCount + onlyProviderCount;
    const totalDenom = agreedCount + onlyUsCount + onlyProviderCount;
    const discrepancyRatePct = totalDenom > 0 ? Math.round((totalDiff / totalDenom) * 1000) / 10 : 0;

    return {
      filingsCompared,
      totalUsTx,
      totalProviderTx,
      agreed: agreedCount,
      onlyUs: onlyUsCount,
      onlyProvider: onlyProviderCount,
      discrepancyRatePct,
    };
  }

  const fmpMetrics = await processProvider('fmp', fmpCandidates, fmpObs);
  const quiverMetrics = await processProvider('quiver', quiverCandidates, quiverObs);
  const uwMetrics = await processProvider('unusual_whales', uwCandidates, uwObs);

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      fmp: fmpMetrics,
      quiver: quiverMetrics,
      unusual_whales: uwMetrics,
    },
    details: details.sort((a, b) => (b.filedDate ?? '').localeCompare(a.filedDate ?? '')),
  };
}
