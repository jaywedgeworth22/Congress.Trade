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

print("=== CHECK FETTERMAN / ARMSTRONG / WHITEHOUSE IN TRANSACTIONS ===")
rows = parse_html_table(run_sql("""
SELECT t.id, t.doc_id, fl.full_name, t.ticker, t.tx_date, t.tx_type, f.filed_date, t.created_at
FROM transactions t
JOIN filers fl ON fl.bioguide_id = t.filer_id
LEFT JOIN filings f ON f.doc_id = t.doc_id
WHERE fl.full_name LIKE '%Fetterman%' OR fl.full_name LIKE '%Armstrong%' OR fl.full_name LIKE '%Whitehouse%'
ORDER BY t.created_at DESC
LIMIT 20
"""))
for r in rows:
    print(r)

