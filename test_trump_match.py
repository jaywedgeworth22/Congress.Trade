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

def match_hashes(c_hash, r_hash):
    if c_hash == r_hash:
        return True, 'exact'
    c = c_hash.split('_')
    r = r_hash.split('_')
    if len(c) >= 4 and len(r) >= 4:
        same_filer = c[0] == r[0]
        same_ticker = c[1] and r[1] and c[1] == r[1]
        same_date = c[2] == r[2] or not c[2] or not r[2]
        same_type = c[3] == r[3]
        if same_filer and same_ticker and same_date and same_type:
            return True, 'missing-date'
        if same_filer and c[2] == r[2] and same_type:
            return True, 'missing-ticker'
    return False, None

obs = parse_html_table(run_sql("""
SELECT provider_key, trade_hash FROM trade_provider_observations WHERE filer_name LIKE '%Trump%'
"""))

cands = parse_html_table(run_sql("""
SELECT trade_hash FROM transactions WHERE filer_id LIKE '%trump%'
"""))

print(f"Loaded {len(obs)} Trump observations and {len(cands)} Trump transactions.")

matched_count = 0
for o in obs:
    if len(o) < 2 or o[0] == 'provider_key': continue
    o_hash = o[1]
    for c in cands:
        if not c or c[0] == 'trade_hash': continue
        c_hash = c[0]
        is_match, method = match_hashes(c_hash, o_hash)
        if is_match:
            matched_count += 1
            break

print("Trump Matches found:", matched_count, "out of", len(obs))

