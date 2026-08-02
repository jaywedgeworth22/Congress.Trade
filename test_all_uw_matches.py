import os
import urllib.request
import urllib.parse
import http.cookiejar
import re

cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

login_data = urllib.parse.urlencode({"password": os.environ["SQLITE_WEB_PASSWORD"], "next": "/query/"}).encode("utf-8")
opener.open("http://100.97.154.2:8080/login/", data=login_data)

def run_sql(sql):
    query_data = urllib.parse.urlencode({"sql": sql}).encode("utf-8")
    req = urllib.request.Request("http://100.97.154.2:8080/query/", data=query_data)
    with opener.open(req) as resp:
        return resp.read().decode("utf-8")

def parse_html_table(html):
    matches = re.findall(r'<tr>(.*?)</tr>', html, re.DOTALL)
    rows = []
    for m in matches:
        cols = [re.sub(r'<.*?>', '', c).strip() for c in re.findall(r'<t[dh]>(.*?)</t[dh]>', m, re.DOTALL)]
        if cols:
            rows.append(cols)
    return rows

print("=== 1. Populate all candidates for primary filings ===")
run_sql("""
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
WHERE t.source = 'primary'
ON CONFLICT(trade_hash, provider) DO UPDATE SET updated_at = excluded.updated_at
""")

print("=== 2. Match candidates against provider observations via exact and fuzzy hash ===")
run_sql("""
UPDATE trade_latency_candidates
SET status = 'matched',
    provider_key = (
      SELECT o.provider_key
      FROM trade_provider_observations o
      WHERE o.provider = trade_latency_candidates.provider
        AND (
          o.trade_hash = trade_latency_candidates.trade_hash
          OR (
            SUBSTR(o.trade_hash, 1, INSTR(o.trade_hash, '_')) = SUBSTR(trade_latency_candidates.trade_hash, 1, INSTR(trade_latency_candidates.trade_hash, '_'))
            AND SUBSTR(o.trade_hash, LENGTH(o.trade_hash) - 10) = SUBSTR(trade_latency_candidates.trade_hash, LENGTH(trade_latency_candidates.trade_hash) - 10)
          )
        )
      LIMIT 1
    ),
    provider_first_seen_at = (
      SELECT o.first_observed_at
      FROM trade_provider_observations o
      WHERE o.provider = trade_latency_candidates.provider
        AND (
          o.trade_hash = trade_latency_candidates.trade_hash
          OR (
            SUBSTR(o.trade_hash, 1, INSTR(o.trade_hash, '_')) = SUBSTR(trade_latency_candidates.trade_hash, 1, INSTR(trade_latency_candidates.trade_hash, '_'))
            AND SUBSTR(o.trade_hash, LENGTH(o.trade_hash) - 10) = SUBSTR(trade_latency_candidates.trade_hash, LENGTH(trade_latency_candidates.trade_hash) - 10)
          )
        )
      LIMIT 1
    ),
    match_method = 'trade-hash',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (
    SELECT 1 FROM trade_provider_observations o
    WHERE o.provider = trade_latency_candidates.provider
      AND (
        o.trade_hash = trade_latency_candidates.trade_hash
        OR (
          SUBSTR(o.trade_hash, 1, INSTR(o.trade_hash, '_')) = SUBSTR(trade_latency_candidates.trade_hash, 1, INSTR(trade_latency_candidates.trade_hash, '_'))
          AND SUBSTR(o.trade_hash, LENGTH(o.trade_hash) - 10) = SUBSTR(trade_latency_candidates.trade_hash, LENGTH(trade_latency_candidates.trade_hash) - 10)
        )
      )
  )
""")

print("=== 3. Query match totals ===")
rows = parse_html_table(run_sql("""
SELECT provider, status, COUNT(*) as count
FROM trade_latency_candidates
GROUP BY provider, status
"""))

for r in rows:
    print(r)

