#!/usr/bin/env python3
"""Read-only: Congress.Trade subscription prices and introductory offers.

Reads only the three ASC_* values it needs via grep and never prints them.
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
    print(f'== {name} ({sid}) ==')
    meta = api(f'subscriptions/{sid}?fields[subscriptions]=name,productId,subscriptionPeriod,state')
    a = (meta.get('data') or {}).get('attributes', {})
    print(f"   productId={a.get('productId')}  period={a.get('subscriptionPeriod')}  state={a.get('state')}")

    prices = api(f'subscriptions/{sid}/prices?limit=10&include=subscriptionPricePoint,territory')
    seen = False
    for inc in prices.get('included', []):
        if inc['type'] == 'subscriptionPricePoints':
            pa = inc['attributes']
            print(f"   price: customerPrice={pa.get('customerPrice')} proceeds={pa.get('proceeds')}")
            seen = True
    if not seen:
        print('   price: none returned', prices.get('_err', ''))

    offers = api(f'subscriptions/{sid}/introductoryOffers?limit=5')
    if offers.get('data'):
        for o in offers['data']:
            oa = o['attributes']
            print(f"   INTRO: mode={oa.get('offerMode')} duration={oa.get('duration')} "
                  f"periods={oa.get('numberOfPeriods')} start={oa.get('startDate')} end={oa.get('endDate')}")
    else:
        print('   INTRO: none', offers.get('_err', ''))
