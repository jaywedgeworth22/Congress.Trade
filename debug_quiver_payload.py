import os
import urllib.request
import urllib.parse
import http.cookiejar
import re
import json

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

print("=== RECENT QUIVER OBSERVATIONS WITH PAYLOAD ===")
rows = parse_html_table(run_sql("""
SELECT provider_key, trade_hash, filer_name, filed_date, first_observed_at, payload
FROM trade_provider_observations
WHERE provider = 'quiver'
ORDER BY first_observed_at DESC
LIMIT 10
"""))
for r in rows:
    print("KEY:", r[0], "HASH:", r[1], "FILER:", r[2], "DATE:", r[3], "OBSERVED:", r[4])
    if len(r) > 5:
        print("PAYLOAD:", r[5][:200])
    print("-" * 50)

