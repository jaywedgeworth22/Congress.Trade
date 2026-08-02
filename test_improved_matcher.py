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
    matches = re.findall(r'<tr>(.*?)</tr>', html, re.DOTALL)
    rows = []
    for m in matches:
        cols = [re.sub(r'<.*?>', '', c).strip() for c in re.findall(r'<t[dh]>(.*?)</t[dh]>', m, re.DOTALL)]
        if cols:
            rows.append(cols)
    return rows

def extract_last_name(name):
    if not name:
        return ''
    clean = re.sub(r'\b[A-Za-z]\.\s*', ' ', name)
    clean = re.sub(r'\s+', ' ', clean).strip()
    parts = clean.split(',')[0].split(' ')
    for p in reversed(parts):
        p_clean = re.sub(r'[^a-z]', '', p.lower())
        if p_clean and len(p_clean) > 1 and p_clean not in ['jr', 'sr', 'md', 'ii', 'iii', 'iv', 'v']:
            return p_clean
    return ''

print("=== TESTING IMPROVED LAST NAME EXTRACTION ===")
print("James A. Himes ->", extract_last_name("James A. Himes"))
print("David H. McCormick ->", extract_last_name("David H. McCormick"))
print("John W. Hickenlooper ->", extract_last_name("John W. Hickenlooper"))

