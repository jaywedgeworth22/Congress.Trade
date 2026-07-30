import urllib.request
import urllib.parse
import http.cookiejar
import re

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

rows = parse_html_table(run_sql("""
SELECT trade_hash, doc_id, provider, filer_name, ticker, tx_date, tx_type, congress_first_seen_at
FROM trade_latency_candidates
LIMIT 5
"""))

for r in rows:
    print(r)

