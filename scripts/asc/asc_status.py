#!/usr/bin/env python3
"""Read-only App Store Connect status for Congress.Trade.

Reads only the three ASC_* values it needs from the handoff file via grep and
never prints them.  Prints app / version / build / IAP / submission state only.

Usage: asc_status.py [all|builds|version|iap|submissions]
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

import jwt

ENV = os.path.expanduser('~/.secrets/appstore-connect.env')
APP = '6798076688'


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
        return {'_err': getattr(e, 'code', '?'), '_path': path}


what = sys.argv[1] if len(sys.argv) > 1 else 'all'

if what in ('all', 'builds'):
    print('== builds (newest first) ==')
    d = api(f'builds?filter[app]={APP}&limit=5&sort=-uploadedDate'
            '&fields[builds]=version,uploadedDate,processingState,expired')
    for b in d.get('data', []):
        a = b['attributes']
        print(f"  {a.get('version')}  {a.get('uploadedDate')}  {a.get('processingState')}  expired={a.get('expired')}")
    if d.get('_err'):
        print('  err', d['_err'])

if what in ('all', 'version'):
    print('== version + attached build ==')
    v = api(f'apps/{APP}/appStoreVersions?limit=2')
    for item in v.get('data', []):
        vid, a = item['id'], item['attributes']
        print(f"  {a.get('versionString')}  state={a.get('appStoreState')}  id={vid}")
        b = api(f'appStoreVersions/{vid}/build?fields[builds]=version,uploadedDate')
        data = b.get('data')
        attached = data.get('attributes', {}).get('version') if isinstance(data, dict) else None
        print('    attached build:', attached or 'NONE')

if what in ('all', 'iap'):
    print('== subscriptions ==')
    g = api(f'apps/{APP}/subscriptionGroups?limit=5&include=subscriptions')
    for inc in g.get('included', []):
        if inc['type'] == 'subscriptions':
            a = inc['attributes']
            print(f"  {a.get('productId')}  state={a.get('state')}  id={inc['id']}")

if what in ('all', 'submissions'):
    print('== review submissions ==')
    s = api(f'reviewSubmissions?filter[app]={APP}&filter[platform]=IOS&limit=5')
    for item in s.get('data', []):
        a = item['attributes']
        print(f"  {item['id']}  state={a.get('state')}  submitted={a.get('submitted')}")
    if s.get('_err'):
        print('  err', s['_err'])
