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

print("=== UNMATCHED UNUSUAL WHALES OBSERVATIONS ===")
unmatched_uw = parse_html_table(run_sql("""
SELECT o.provider_key, o.trade_hash, o.filer_name, o.filed_date, o.first_observed_at
FROM trade_provider_observations o
LEFT JOIN trade_latency_candidates c ON c.provider = o.provider AND c.provider_key = o.provider_key
WHERE o.provider = 'unusual_whales' AND c.provider_key IS NULL
LIMIT 30
"""))

for r in unmatched_uw:
    print(r)

