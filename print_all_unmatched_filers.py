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
    matches = re.findall(r'<table.*?>(.*?)</table>', html, re.DOTALL)
    if not matches: return []
    rows = re.findall(r'<tr.*?>(.*?)</tr>', matches[0], re.DOTALL)
    res = []
    for r in rows:
        cols = [re.sub(r'\s+', ' ', re.sub(r'<.*?>', '', c)).strip() for c in re.findall(r'<t[dh].*?>(.*?)</t[dh]>', r, re.DOTALL)]
        if cols:
            res.append(cols)
    return res

sql = """
SELECT 
  o.provider,
  o.filer_name,
  COUNT(*) as cnt
FROM trade_provider_observations o
LEFT JOIN trade_latency_candidates c ON c.provider = o.provider AND c.provider_key = o.provider_key
WHERE c.provider_key IS NULL
GROUP BY o.provider, o.filer_name
ORDER BY cnt DESC
"""

print("=== ALL UNMATCHED OBSERVATIONS BY FILER ===")
rows = parse_html_table(run_sql(sql))
for r in rows:
    print(r)

