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
    matches = re.findall(r'<tr>(.*?)</tr>', html, re.DOTALL)
    rows = []
    for m in matches:
        cols = [re.sub(r'<.*?>', '', c).strip() for c in re.findall(r'<t[dh]>(.*?)</t[dh]>', m, re.DOTALL)]
        if cols:
            rows.append(cols)
    return rows

print("=== QUIVER OBSERVATIONS RECENT ===")
q_rows = parse_html_table(run_sql("""
SELECT provider_key, trade_hash, filer_name, source_url, filed_date, first_observed_at
FROM trade_provider_observations
WHERE provider = 'quiver' AND (first_observed_at >= '2026-07-25' OR filed_date >= '2026-07-25')
ORDER BY first_observed_at DESC
LIMIT 30
"""))
for r in q_rows:
    print(r)

print("\n=== RECENT OFFICIAL TRANSACTIONS (filed_date >= 2026-07-20 or created_at >= 2026-07-25) ===")
tx_rows = parse_html_table(run_sql("""
SELECT t.id, t.doc_id, t.filer_id, COALESCE(fl.full_name, t.filer_id) as member, t.ticker, t.tx_date, t.tx_type, f.filed_date, t.created_at
FROM transactions t
LEFT JOIN filings f ON f.doc_id = t.doc_id
LEFT JOIN filers fl ON fl.bioguide_id = t.filer_id
WHERE f.filed_date >= '2026-07-20' OR t.created_at >= '2026-07-25'
ORDER BY t.created_at DESC
LIMIT 30
"""))
for r in tx_rows:
    print(r)

