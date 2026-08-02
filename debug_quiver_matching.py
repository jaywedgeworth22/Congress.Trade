import os
import urllib.request
import urllib.parse
import http.cookiejar
import re
import json

cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

login_data = urllib.parse.urlencode({"password": os.environ["SQLITE_WEB_PASSWORD"], "next": "/query/"}).encode("utf-8")
opener.open("http://100.97.154.2:8080/login/", data=login_data)

def run_sql(sql):
    query_data = urllib.parse.urlencode({"sql": sql}).encode("utf-8")
    req = urllib.request.Request("http://100.97.154.2:8080/query/", data=query_data)
    with opener.open(req) as resp:
        return resp.read().decode("utf-8")

print("=== 1. Quiver observations from yesterday/today ===")
q_html = run_sql("""
SELECT provider_key, trade_hash, filer_name, source_url, filed_date, first_observed_at
FROM trade_provider_observations
WHERE provider = 'quiver' AND (first_observed_at >= '2026-07-28' OR filed_date >= '2026-07-28')
LIMIT 20
""")

print(q_html[:1500])

print("\n=== 2. Official transactions filed yesterday/today ===")
tx_html = run_sql("""
SELECT t.id, t.doc_id, t.filer_id, fl.full_name, t.ticker, t.tx_date, t.tx_type, f.filed_date
FROM transactions t
JOIN filings f ON f.doc_id = t.doc_id
LEFT JOIN filers fl ON fl.bioguide_id = t.filer_id
WHERE f.filed_date >= '2026-07-28' OR t.created_at >= '2026-07-28'
LIMIT 20
""")

print(tx_html[:1500])

