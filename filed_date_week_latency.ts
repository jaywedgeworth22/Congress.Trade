const ADMIN_TOKEN = "9d6900f7e9dd5ff57781e02a0d17f5100508fef57f56d37579f9420ce0b22c9c";
const URL = "https://congress.trade/api/admin/debug-sql";

async function runSql(query: string, params: any[] = []): Promise<any[]> {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, params })
  });
  if (!res.ok) throw new Error(`HTTP error: ${res.status}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error);
  return data.results;
}

async function main() {
  console.log("=== Disclosed in Past Week (filed_date >= 2026-07-22) Latency Comparison ===");

  // 1. Fetch trades officially filed in the past 7 days (filed_date >= '2026-07-22')
  const filedRows = await runSql(`
    SELECT t.id, t.doc_id, t.filer_id, t.tx_date, t.ticker, t.tx_type, t.created_at, f.filed_date, f.chamber, fl.full_name as filer_name
    FROM transactions t
    JOIN filings f ON f.doc_id = t.doc_id
    LEFT JOIN filers fl ON fl.bioguide_id = t.filer_id
    WHERE f.filed_date >= '2026-07-22' AND t.source = 'primary'
  `);

  console.log(`Found ${filedRows.length} official primary transactions officially filed between 2026-07-22 and 2026-07-29.`);

  // 2. Clear candidate entries for filed_date >= 2026-07-22 to ensure clean test
  await runSql(`
    DELETE FROM trade_latency_candidates WHERE filed_date < '2026-07-22'
  `);

  // 3. Upsert candidates for these filed_date >= 2026-07-22 trades
  await runSql(`
    INSERT INTO trade_latency_candidates
      (trade_hash, doc_id, provider, chamber, source_url, filed_date, filer_name, ticker, tx_date, tx_type,
       congress_first_seen_at, status, attempts, created_at, updated_at)
    SELECT
      LOWER(RTRIM(SUBSTR(COALESCE(fl.full_name, t.filer_id), INSTR(COALESCE(fl.full_name, t.filer_id), ' ') + 1), ' ,')) || '_' ||
      UPPER(COALESCE(t.ticker, '')) || '_' ||
      SUBSTR(COALESCE(t.tx_date, ''), 1, 10) || '_' ||
      CASE WHEN LOWER(t.tx_type) IN ('p', 'buy', 'purchase') THEN 'buy' WHEN LOWER(t.tx_type) IN ('s', 'sell', 'sale') THEN 'sell' ELSE 'exchange' END AS trade_hash,
      t.doc_id,
      p.provider,
      COALESCE(f.chamber, CASE WHEN t.doc_id LIKE 'S-%' THEN 'senate' ELSE 'house' END) AS chamber,
      f.source_url,
      f.filed_date,
      COALESCE(fl.full_name, t.filer_id) AS filer_name,
      t.ticker,
      t.tx_date,
      t.tx_type,
      COALESCE(t.first_seen_at, t.created_at) AS congress_first_seen_at,
      'pending',
      0,
      t.created_at,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM transactions t
    CROSS JOIN (SELECT 'unusual_whales' AS provider UNION ALL SELECT 'quiver') p
    JOIN filings f ON f.doc_id = t.doc_id
    LEFT JOIN filers fl ON fl.bioguide_id = t.filer_id
    WHERE f.filed_date >= '2026-07-22' AND t.source = 'primary'
    ON CONFLICT(trade_hash, provider) DO UPDATE SET updated_at = excluded.updated_at
  `);

  // 4. Perform match against provider observations
  await runSql(`
    UPDATE trade_latency_candidates
    SET status = 'matched',
        provider_key = (
          SELECT o.provider_key
          FROM trade_provider_observations o
          WHERE o.provider = trade_latency_candidates.provider
            AND o.trade_hash = trade_latency_candidates.trade_hash
          LIMIT 1
        ),
        provider_first_seen_at = (
          SELECT o.first_observed_at
          FROM trade_provider_observations o
          WHERE o.provider = trade_latency_candidates.provider
            AND o.trade_hash = trade_latency_candidates.trade_hash
          LIMIT 1
        ),
        provider_published_at = (
          SELECT COALESCE(o.provider_published_at, o.first_observed_at)
          FROM trade_provider_observations o
          WHERE o.provider = trade_latency_candidates.provider
            AND o.trade_hash = trade_latency_candidates.trade_hash
          LIMIT 1
        ),
        match_method = 'trade-hash',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE filed_date >= '2026-07-22'
      AND EXISTS (
        SELECT 1 FROM trade_provider_observations o
        WHERE o.provider = trade_latency_candidates.provider
          AND o.trade_hash = trade_latency_candidates.trade_hash
      )
  `);

  // 5. Query matching statistics for filed_date >= 2026-07-22
  const summary = await runSql(`
    SELECT provider, status, COUNT(*) as count
    FROM trade_latency_candidates
    WHERE filed_date >= '2026-07-22'
    GROUP BY provider, status
  `);

  console.table(summary);
}

main().catch(console.error);
