#!/usr/bin/env python3
"""Read-only: map Congress.Trade subscription prices to the USA territory.

Answers "what does a US customer actually pay" rather than listing unmapped
price points.  Reads only the three ASC_* values it needs; never prints them.
"""
import json
import os
import subprocess
import time
import urllib.request

import jwt

ENV = os.path.expanduser('~/.secrets/appstore-connect.env')
SUBS = [('6798078775', 'monthly'), ('6798078776', 'annual')]


def val(name: str) -> str:
    out = subprocess.run(['grep', '-m1', f'^{name}=', ENV], capture_output=True, text=True).stdout
    return out.split('=', 1)[1].strip().strip('"\'') if '=' in out else ''


kid, iss, kp = val('ASC_KEY_ID'), val('ASC_ISSUER_ID'), os.path.expanduser(val('ASC_KEY_PATH'))
tok = jwt.encode(
    {'iss': iss, 'iat': int(time.time()), 'exp': int(time.time()) + 900, 'aud': 'appstoreconnect-v1'},
    open(kp).read(), algorithm='ES256', headers={'kid': kid, 'typ': 'JWT'})


def api(path: str):
    req = urllib.request.Request(f'https://api.appstoreconnect.apple.com/v1/{path}',
                                 headers={'Authorization': f'Bearer {tok}'})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=45).read())
    except Exception as e:  # noqa: BLE001
        return {'_err': getattr(e, 'code', '?')}


for sid, name in SUBS:
    d = api(f'subscriptions/{sid}/prices?limit=200&include=subscriptionPricePoint,territory')
    points = {i['id']: i['attributes'] for i in d.get('included', []) if i['type'] == 'subscriptionPricePoints'}
    rows = []
    for p in d.get('data', []):
        rel = p.get('relationships', {})
        pp = (rel.get('subscriptionPricePoint', {}).get('data') or {}).get('id')
        tt = (rel.get('territory', {}).get('data') or {}).get('id')
        if tt == 'USA' and pp in points:
            rows.append((points[pp].get('customerPrice'),
                         p['attributes'].get('startDate'),
                         p['attributes'].get('preserved')))
    print(f'== {name}: USA rows ==')
    for price, start, preserved in rows[:8]:
        print(f'   customerPrice={price}  startDate={start}  preserved={preserved}')
    if not rows:
        print('   no USA row surfaced; total price rows:', len(d.get('data', [])), d.get('_err', ''))
