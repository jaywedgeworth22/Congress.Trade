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

def normalize_side(t):
    if not t:
        return 'exchange'
    s = t.lower().strip()
    if s in ['p', 'buy', 'purchase'] or 'buy' in s or 'purchase' in s:
        return 'buy'
    if s in ['s', 'sell', 'sale'] or 'sell' in s or 'sale' in s:
        return 'sell'
    return 'exchange'

print("=== 1. Loading candidates & fixing trade_hash ===")
candidates_raw = parse_html_table(run_sql("""
SELECT trade_hash, doc_id, provider, filer_name, ticker, tx_date, tx_type, congress_first_seen_at
FROM trade_latency_candidates
WHERE status = 'pending'
"""))

print(f"Loaded {len(candidates_raw)} pending candidate rows.")

# Map provider observations
obs_raw = parse_html_table(run_sql("""
SELECT provider, provider_key, trade_hash, filer_name, first_observed_at, provider_published_at
FROM trade_provider_observations
"""))

print(f"Loaded {len(obs_raw)} provider observations.")

obs_map = {}
for r in obs_raw:
    if len(r) >= 6:
        prov = r[0]
        if prov not in obs_map:
            obs_map[prov] = []
        obs_map[prov].append({
            'key': r[1],
            'hash': r[2],
            'filer': r[3],
            'seen': r[4],
            'pub': r[5] if r[5] != 'NULL' else r[4]
        })

matches_found = {'unusual_whales': 0, 'quiver': 0, 'fmp': 0}

for cand in candidates_raw:
    if len(cand) < 8 or cand[0] == 'trade_hash':
        continue
    c_hash, doc_id, provider, filer_name, ticker, tx_date, tx_type, first_seen = cand[:8]
    
    ln = extract_last_name(filer_name)
    tk = (ticker if ticker != 'NULL' else '').upper()
    dt = (tx_date if tx_date != 'NULL' else '')[:10]
    ty = normalize_side(tx_type)
    
    clean_hash = f"{ln}_{tk}_{dt}_{ty}"
    c_parts = clean_hash.split('_')

    prov_obs_list = obs_map.get(provider, [])
    for obs in prov_obs_list:
        o_hash = obs['hash']
        o_parts = o_hash.split('_')
        
        matched = False
        if clean_hash == o_hash or c_hash == o_hash:
            matched = True
        elif len(c_parts) >= 4 and len(o_parts) >= 4:
            if c_parts[0] and c_parts[0] == o_parts[0] and c_parts[2] == o_parts[2] and c_parts[3] == o_parts[3]:
                matched = True
        
        if matched:
            matches_found[provider] = matches_found.get(provider, 0) + 1
            break

print("=== NEW MATCH TOTALS AFTER CLEAN HASH MATCHING ===")
for k, v in matches_found.items():
    print(f"{k}: {v} matches")

