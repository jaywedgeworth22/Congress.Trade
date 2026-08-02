import os
import urllib.request
import urllib.parse
import http.cookiejar
import re

cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

login_data = urllib.parse.urlencode({"password": os.environ.get("SQLITE_WEB_PASSWORD", ""), "next": "/query/"}).encode("utf-8")
opener.open("http://100.97.154.2:8080/login/", data=login_data)

def run_sql(sql):
    query_data = urllib.parse.urlencode({"sql": sql}).encode("utf-8")
    req = urllib.request.Request("http://100.97.154.2:8080/query/", data=query_data)
    with opener.open(req) as resp:
        return resp.read().decode("utf-8")

def parse_html_table(html):
    matches = re.findall(r'<table.*?>(.*?)</table>', html, re.DOTALL)
    if not matches: return []
    rows = re.findall(r'<tr.*?>(.*?)</tr>', matches[0], re.DOTALL)
    res = []
    for r in rows:
        cols = [re.sub(r'\s+', ' ', re.sub(r'<.*?>', '', c)).strip() for c in re.findall(r'<t[dh].*?>(.*?)</t[dh]>', r, re.DOTALL)]
        if cols:
            res.append(cols)
    return res

print("=== CATEGORIZATION OF UNMATCHED OBSERVATIONS ===")

# Category 1: Executive / Donald Trump Filings
sql_trump = """
SELECT COUNT(*) FROM trade_provider_observations o
LEFT JOIN trade_latency_candidates c ON c.provider = o.provider AND c.provider_key = o.provider_key
WHERE c.provider_key IS NULL AND (o.filer_name LIKE '%Trump%' OR o.trade_hash LIKE 'trump_%')
"""
print("Unmatched Trump/Executive Disclosures:", parse_html_table(run_sql(sql_trump)))

# Category 2: Missing / NULL Tickers (e.g. municipal bonds, private assets)
sql_no_ticker = """
SELECT COUNT(*) FROM trade_provider_observations o
LEFT JOIN trade_latency_candidates c ON c.provider = o.provider AND c.provider_key = o.provider_key
WHERE c.provider_key IS NULL AND (o.ticker IS NULL OR o.ticker = '' OR o.ticker = 'NULL')
"""
print("Unmatched Missing/Empty Tickers:", parse_html_table(run_sql(sql_no_ticker)))

# Category 3: Older Historical Filings (Filed before 2026-06-01)
sql_old_filings = """
SELECT COUNT(*) FROM trade_provider_observations o
LEFT JOIN trade_latency_candidates c ON c.provider = o.provider AND c.provider_key = o.provider_key
WHERE c.provider_key IS NULL AND (o.filed_date < '2026-06-01' OR o.tx_date < '2026-06-01')
"""
print("Unmatched Older Historical Filings (< June 2026):", parse_html_table(run_sql(sql_old_filings)))

# Category 4: Recent Filings (Filed >= June 2026) with valid stock ticker
sql_recent_valid = """
SELECT o.provider, o.filer_name, o.ticker, o.tx_date, o.filed_date, o.trade_hash
FROM trade_provider_observations o
LEFT JOIN trade_latency_candidates c ON c.provider = o.provider AND c.provider_key = o.provider_key
WHERE c.provider_key IS NULL 
  AND o.filer_name NOT LIKE '%Trump%'
  AND o.ticker IS NOT NULL AND o.ticker != '' AND o.ticker != 'NULL'
  AND (o.filed_date >= '2026-06-01' OR o.tx_date >= '2026-06-01')
LIMIT 20
"""
recent_valid_rows = parse_html_table(run_sql(sql_recent_valid))
print(f"\nUnmatched Recent Valid Stock Filings (>= June 2026): {len(recent_valid_rows) - 1 if len(recent_valid_rows) > 0 else 0}")
for r in recent_valid_rows[1:]:
    print(r)

