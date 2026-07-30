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

print("=== CHECK TRUMP IN TRANSACTIONS AND FILERS ===")
filers = parse_html_table(run_sql("SELECT bioguide_id, full_name FROM filers WHERE full_name LIKE '%Trump%'"))
print("Filers:", filers)

txs = parse_html_table(run_sql("SELECT id, doc_id, filer_id, ticker, tx_date, tx_type FROM transactions WHERE filer_id LIKE '%trump%' OR asset_name LIKE '%Trump%' LIMIT 10"))
print("Txs:", txs)

