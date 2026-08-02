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

print("=== UNMATCHED OBSERVATIONS AUDIT ===")

# Total observations vs matched observations
sql_stats = """
SELECT 
  o.provider,
  COUNT(o.provider_key) as total_obs,
  COUNT(c.provider_key) as matched_obs,
  COUNT(o.provider_key) - COUNT(c.provider_key) as unmatched_obs
FROM trade_provider_observations o
LEFT JOIN trade_latency_candidates c ON c.provider = o.provider AND c.provider_key = o.provider_key
GROUP BY o.provider
"""
print("Observation Totals by Provider:")
for r in parse_html_table(run_sql(sql_stats)):
    print(r)

print("\n=== BREAKDOWN OF UNMATCHED OBSERVATIONS ===")
sql_unmatched_reasons = """
SELECT 
  o.provider,
  o.filer_name,
  o.ticker,
  o.tx_date,
  o.filed_date,
  o.trade_hash
FROM trade_provider_observations o
LEFT JOIN trade_latency_candidates c ON c.provider = o.provider AND c.provider_key = o.provider_key
WHERE c.provider_key IS NULL
LIMIT 30
"""

rows = parse_html_table(run_sql(sql_unmatched_reasons))
if len(rows) > 1:
    print(f"{'Provider':<14} | {'Filer':<22} | {'Ticker':<6} | {'Tx Date':<10} | {'Filed Date':<10} | {'Trade Hash'}")
    print("-" * 100)
    for r in rows[1:]:
        if len(r) < 6: continue
        print(f"{r[0]:<14} | {r[1]:<22} | {r[2]:<6} | {r[3]:<10} | {r[4]:<10} | {r[5]}")

