#!/usr/bin/env python3
"""
congress_trade_watch.py (Congress.Trade) — Detect newly filed House Periodic Transaction Reports (PTRs).

Mechanism:
  The /public_disc/ptr-pdfs/ directory is NOT listable (403, no index) and PDFs
  are named by opaque DocID. The authoritative manifest is the annual FD index:
      https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{YEAR}FD.zip
  which contains {YEAR}FD.xml listing every filing (PTRs have FilingType == 'P').

  We poll that XML, diff DocIDs against a local snapshot, and report new PTRs.

Usage:
  python3 congress_trade_watch.py            # check current year, report new PTRs
  python3 congress_trade_watch.py --year 2026
  python3 congress_trade_watch.py --json     # machine-readable output

State is stored next to this script in ./ptr_state/seen_{YEAR}.json
"""

import argparse, datetime, io, json, os, sys, urllib.request, zipfile
import xml.etree.ElementTree as ET

BASE = "https://disclosures-clerk.house.gov/public_disc"
HERE = os.path.dirname(os.path.abspath(__file__))
STATE_DIR = os.path.join(HERE, "ptr_state")
UA = "Mozilla/5.0 (Congress.Trade PTR watcher)"


def fetch_index_xml(year: int) -> bytes:
    """Download {YEAR}FD.zip and return the inner XML bytes."""
    url = f"{BASE}/financial-pdfs/{year}FD.zip"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        blob = r.read()
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        name = next(n for n in z.namelist() if n.lower().endswith(".xml"))
        return z.read(name)


def parse_ptrs(xml_bytes: bytes, year: int):
    """Return list of PTR dicts (FilingType == 'P')."""
    root = ET.fromstring(xml_bytes)
    out = []
    for m in root.findall(".//Member"):
        def g(tag):
            e = m.find(tag)
            return (e.text or "").strip() if e is not None and e.text else ""
        if g("FilingType") != "P":
            continue
        doc_id = g("DocID")
        name = " ".join(p for p in [g("Prefix"), g("First"), g("Last"), g("Suffix")] if p)
        out.append({
            "doc_id": doc_id,
            "name": name.strip(),
            "state_dst": g("StateDst"),
            "filing_date": g("FilingDate"),
            "year": g("Year") or str(year),
            "pdf_url": f"{BASE}/ptr-pdfs/{g('Year') or year}/{doc_id}.pdf",
        })
    return out


def load_seen(year: int) -> set:
    path = os.path.join(STATE_DIR, f"seen_{year}.json")
    if os.path.exists(path):
        with open(path) as f:
            return set(json.load(f).get("doc_ids", []))
    return set()


def save_seen(year: int, doc_ids: set):
    os.makedirs(STATE_DIR, exist_ok=True)
    path = os.path.join(STATE_DIR, f"seen_{year}.json")
    with open(path, "w") as f:
        json.dump({"updated": datetime.datetime.now().isoformat(),
                   "doc_ids": sorted(doc_ids)}, f, indent=2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, default=datetime.date.today().year)
    ap.add_argument("--json", action="store_true", help="emit JSON")
    ap.add_argument("--no-save", action="store_true", help="don't update snapshot")
    args = ap.parse_args()

    ptrs = parse_ptrs(fetch_index_xml(args.year), args.year)
    current = {p["doc_id"] for p in ptrs if p["doc_id"]}
    seen = load_seen(args.year)
    first_run = len(seen) == 0
    new_ids = current - seen
    new = [p for p in ptrs if p["doc_id"] in new_ids]
    new.sort(key=lambda p: p["filing_date"])

    if not args.no_save:
        save_seen(args.year, current)

    if args.json:
        print(json.dumps({"year": args.year, "total": len(current),
                          "first_run": first_run, "new": new}, indent=2))
        return

    if first_run:
        print(f"[{args.year}] Baseline saved: {len(current)} PTRs tracked. "
              f"No 'new' reported on first run.")
        return
    if not new:
        print(f"[{args.year}] No new PTRs. ({len(current)} total)")
        return
    print(f"[{args.year}] {len(new)} NEW PTR(s):")
    for p in new:
        print(f"  {p['filing_date']:<12} {p['name']:<32} {p['state_dst']:<6} {p['pdf_url']}")


if __name__ == "__main__":
    main()
