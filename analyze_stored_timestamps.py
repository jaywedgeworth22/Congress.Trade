import urllib.request
import urllib.parse
import http.cookiejar
import re
from datetime import datetime

cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

login_data = urllib.parse.urlencode({"password": "admin", "next": "/query/"}).encode("utf-8")
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

print("=== STORED PROVIDER OBSERVATIONS SUMMARY ===")
summary = parse_html_table(run_sql("""
SELECT provider, COUNT(*), MIN(first_observed_at), MAX(first_observed_at)
FROM trade_provider_observations
GROUP BY provider
"""))
for s in summary:
    print(s)

print("\n=== SAMPLE UNUSUAL WHALES TIMESTAMPS (STORED) ===")
uw_rows = parse_html_table(run_sql("""
SELECT filer_name, ticker, tx_date, filed_date, first_observed_at, provider_published_at
FROM trade_provider_observations
WHERE provider = 'unusual_whales'
LIMIT 10
"""))
for r in uw_rows:
    print(r)

print("\n=== SAMPLE QUIVER TIMESTAMPS (STORED) ===")
q_rows = parse_html_table(run_sql("""
SELECT filer_name, ticker, tx_date, filed_date, first_observed_at, provider_published_at
FROM trade_provider_observations
WHERE provider = 'quiver'
LIMIT 10
"""))
for r in q_rows:
    print(r)

