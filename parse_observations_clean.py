import os
import urllib.request
import urllib.parse
import http.cookiejar
import re

cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

login_data = urllib.parse.urlencode({"password": os.environ.get("SQLITE_WEB_PASSWORD", ""), "next": "/query/"}).encode("utf-8")
opener.open("http://100.97.154.2:8080/login/", data=login_data)

sql_stmt = "SELECT provider, filer_name, ticker, filed_date, first_observed_at, provider_published_at FROM trade_provider_observations ORDER BY first_observed_at DESC LIMIT 20"
query_data = urllib.parse.urlencode({"sql": sql_stmt}).encode("utf-8")
req = urllib.request.Request("http://100.97.154.2:8080/query/", data=query_data)

with opener.open(req) as resp:
    html = resp.read().decode("utf-8")

# Extract the results table
matches = re.findall(r'<tr.*?>(.*?)</tr>', html, re.DOTALL)
for m in matches:
    cols = [re.sub(r'<.*?>', '', c).strip() for c in re.findall(r'<t[dh].*?>(.*?)</t[dh]>', m, re.DOTALL)]
    if len(cols) >= 5 and cols[0] != 'provider':
        print(f"Provider: {cols[0]:<15} | Filer: {cols[1]:<20} | Ticker: {cols[2]:<6} | FiledDate: {cols[3]:<10} | FirstObserved: {cols[4]}")

