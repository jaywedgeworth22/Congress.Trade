#!/usr/bin/env python3
import json
import urllib.request
import urllib.parse
import sys
import re

ADMIN_TOKEN = "56c11f2e0c7fa4d019d379fd0b8676199ad1186ad8b09fe5be6a7b2ecbf05060"
BASE_URL = "https://congress.trade/api/admin"
HEADERS = {
    "Authorization": f"Bearer {ADMIN_TOKEN}",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
}

def parse_bracket(amount_str):
    if not amount_str:
        return 1001, 15000
    s = str(amount_str).replace(',', '')
    nums = [float(n) for n in re.findall(r'\$?(\d+(?:\.\d+)?)', s)]
    if len(nums) >= 2:
        return int(nums[0]), int(nums[1])
    elif len(nums) == 1:
        val = nums[0]
        if val <= 1000:
            return 1, 1000
        elif val <= 15000:
            return 1001, 15000
        elif val <= 50000:
            return 15001, 50000
        elif val <= 100000:
            return 50001, 100000
        elif val <= 250000:
            return 100001, 250000
        elif val <= 500000:
            return 250001, 500000
        elif val <= 1000000:
            return 500001, 1000000
        elif val <= 5000000:
            return 1000001, 5000000
        elif val <= 25000000:
            return 5000001, 25000000
        elif val <= 50000000:
            return 25000001, 50000000
        else:
            return 50000001, None
    return 1001, 15000

def http_get(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req) as res:
        return json.loads(res.read().decode("utf-8"))

def http_post(url, body):
    data = json.dumps(body).encode("utf-8")
    post_headers = dict(HEADERS)
    post_headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=post_headers)
    with urllib.request.urlopen(req) as res:
        return json.loads(res.read().decode("utf-8"))

def process_item(item):
    doc_id = item["docId"]
    reason = item.get("reason", "")
    revision = item.get("reviewRevision", 1)
    payload = item.get("payload") or {}
    filed_date = payload.get("filedDate") or item.get("filedDate") or ""

    edits = []

    # 1. Handle provider_discovered_missing_official (Quiver & Unusual Whales)
    if reason == "provider_discovered_missing_official":
        tx_data = payload.get("payload") or {}
        filer_name = tx_data.get("Senator") or tx_data.get("Representative") or tx_data.get("name") or payload.get("filerName") or "Unknown"
        raw_ticker = tx_data.get("Ticker") or tx_data.get("ticker")
        amounts = tx_data.get("Range") or tx_data.get("amounts") or tx_data.get("Amount")
        txn_type_raw = str(tx_data.get("Transaction") or tx_data.get("txn_type") or "Buy").lower()
        tx_date = tx_data.get("Date") or tx_data.get("transaction_date") or payload.get("filedDate") or item.get("createdAt")

        if not tx_date:
            return False

        tx_type = "S" if "sell" in txn_type_raw or "sale" in txn_type_raw else "E" if "exchange" in txn_type_raw else "P"
        amt_min, amt_max = parse_bracket(amounts)
        ticker = raw_ticker.strip().upper() if raw_ticker and str(raw_ticker).strip() and str(raw_ticker).strip() != "--" else None
        owner_raw = str(tx_data.get("issuer") or tx_data.get("Owner") or "self").lower()
        owner = owner_raw if owner_raw in ("self", "spouse", "joint", "dependent") else "self"

        clean_tx_date = tx_date[:10]
        if filed_date and clean_tx_date > filed_date[:10]:
            clean_tx_date = filed_date[:10]

        edits.append({
            "txType": tx_type,
            "txDate": clean_tx_date,
            "owner": owner,
            "ticker": ticker,
            "assetName": str(tx_data.get("Description") or tx_data.get("notes") or (f"{ticker} Stock" if ticker else "Securities"))[:500],
            "amountMin": amt_min,
            "amountMax": amt_max,
        })

    # 2. Handle low_confidence, bad_asset_name, etc. with extracted transactions
    else:
        txs = payload.get("transactions") or payload.get("rows") or []
        for r in txs:
            tx_type = str(r.get("txType") or "P").upper()
            if tx_type not in ("P", "S", "E"):
                tx_type = "P"
            tx_date = str(r.get("txDate") or "").strip()
            if not tx_date or len(tx_date) < 10:
                continue

            clean_tx_date = tx_date[:10]
            r_filed_date = r.get("filedDate") or filed_date
            if r_filed_date and clean_tx_date > r_filed_date[:10]:
                clean_tx_date = r_filed_date[:10]

            owner_raw = str(r.get("owner") or "self").lower()
            owner = owner_raw if owner_raw in ("self", "spouse", "joint", "dependent") else "self"
            raw_ticker = r.get("ticker")
            ticker = str(raw_ticker).strip().upper() if raw_ticker and str(raw_ticker).strip() and str(raw_ticker).strip() != "--" else None
            asset_name = str(r.get("assetName") or "").strip()
            if not asset_name:
                asset_name = f"{ticker} Stock" if ticker else "Securities"

            amt_min = r.get("amountMin")
            amt_max = r.get("amountMax")
            if amt_min is None:
                amt_min, amt_max = parse_bracket(r.get("amountRange"))

            edits.append({
                "txType": tx_type,
                "txDate": clean_tx_date,
                "owner": owner,
                "ticker": ticker,
                "assetName": asset_name[:500],
                "amountMin": int(amt_min),
                "amountMax": int(amt_max) if amt_max is not None else None,
            })

    if not edits:
        return False

    try:
        res = http_post(f"{BASE_URL}/review/{urllib.parse.quote(doc_id, safe='')}", {
            "decision": "manual",
            "reviewRevision": revision,
            "edits": edits
        })
        print(f"[RESOLVED] {doc_id} ({reason}) -> {len(edits)} transactions published")
        return True
    except Exception as e:
        print(f"[FAIL] {doc_id}: {e}")
        return False

def main():
    total_processed = 0
    while True:
        data = http_get(f"{BASE_URL}/review-queue?limit=100")
        items = data.get("items", [])
        if not items:
            break

        print(f"Batch retrieved: {len(items)} items. Total unresolved remaining: {data.get('totals', {}).get('unresolved', 0)}")
        batch_processed = 0

        for item in items:
            if process_item(item):
                batch_processed += 1
                total_processed += 1

        if batch_processed == 0:
            break

    print(f"\nCompleted manual agent review loop. Total processed: {total_processed}")

if __name__ == "__main__":
    main()
