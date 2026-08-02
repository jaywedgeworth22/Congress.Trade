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

print("=== EXECUTIVE FILERS IN FILERS TABLE ===")
filers = parse_html_table(run_sql("SELECT bioguide_id, full_name, chamber FROM filers WHERE bioguide_id LIKE 'EXEC%' OR full_name LIKE '%Trump%'"))
for f in filers:
    print(f)

print("\n=== EXECUTIVE TRANSACTIONS IN TRANSACTIONS TABLE ===")
txs = parse_html_table(run_sql("SELECT id, doc_id, filer_id, ticker, tx_date, tx_type, created_at FROM transactions WHERE filer_id LIKE 'EXEC%' OR doc_id LIKE 'OGE%' OR doc_id LIKE 'E-%' LIMIT 10"))
for t in txs:
    print(t)

