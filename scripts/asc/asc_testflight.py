#!/usr/bin/env python3
"""Read-only: TestFlight availability of the newest Congress.Trade builds.

Reads only the three ASC_* values it needs and never prints them.
"""
import json
import os
import subprocess
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
        return {'_err': getattr(e, 'code', '?')}


builds = api(f'builds?filter[app]={APP}&limit=3&sort=-uploadedDate'
             '&fields[builds]=version,processingState,expired')
for item in builds.get('data', []):
    bid = item['id']
    version = item['attributes']['version']
    det = api(f'builds/{bid}/buildBetaDetail'
              '?fields[buildBetaDetails]=internalBuildState,externalBuildState,autoNotifyEnabled')
    d = det.get('data')
    at = d.get('attributes', {}) if isinstance(d, dict) else {}
    groups = api(f'builds/{bid}/betaGroups?limit=5&fields[betaGroups]=name,isInternalGroup')
    names = [g['attributes'].get('name') for g in groups.get('data', [])] if groups.get('data') else []
    print(f"build {version}: internal={at.get('internalBuildState')} "
          f"external={at.get('externalBuildState')} groups={names or 'none'}")
