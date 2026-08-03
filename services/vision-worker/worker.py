#!/usr/bin/env python3
"""
macOS local vision worker for Congress.Trade
Service: com.congress.trade.vision-worker

Polls the app for pending scanned_pdf filings, transcribes them locally at $0
API cost, and posts ParsedTx-shaped rows to /api/admin/ingest-local-vision
(which runs them through the normal normalize() pipeline as source='local_mac').

Extraction engine: the local Kimi Code CLI (`kimi -p`) reads rendered page
images with its vision model — the method proven on the 2026-08-02 backlog
clearance (247 filings / 16.5k rows). The earlier naive text-line parser was
removed: paper PTR type/amount live in checkbox X-marks, not text.

Env:
  CONGRESS_TRADE_API_URL  (default http://localhost:8787)
  ADMIN_TOKEN             (admin bearer for the app)
  WORKER_ID               (default local_mac_1)
  POLL_INTERVAL_SEC       (default 30)
  HEARTBEAT_INTERVAL_SEC  (default 60)
  KIMI_BIN                (default `which kimi`)
  KIMI_TIMEOUT_SEC        (per-doc transcription budget, default 900)
"""

from __future__ import annotations  # py3.9: lazy annotations (dict | None etc.)

import json
import logging
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("vision-worker")

API_BASE_URL = os.getenv("CONGRESS_TRADE_API_URL", "http://localhost:8787").rstrip("/")
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "")
WORKER_ID = os.getenv("WORKER_ID", "local_mac_1")
POLL_INTERVAL_SEC = int(os.getenv("POLL_INTERVAL_SEC", "30"))
HEARTBEAT_INTERVAL_SEC = int(os.getenv("HEARTBEAT_INTERVAL_SEC", "60"))
KIMI_TIMEOUT_SEC = int(os.getenv("KIMI_TIMEOUT_SEC", "900"))
DOWNLOAD_UA = "congress-feed/0.1 (+https://congress.trade)"


def kimi_bin() -> str:
    if os.getenv("KIMI_BIN"):
        return os.environ["KIMI_BIN"]
    for cand in ("/opt/homebrew/bin/kimi", "/usr/local/bin/kimi", os.path.expanduser("~/.local/bin/kimi")):
        if os.path.exists(cand):
            return cand
    return "kimi"


def send_request(url: str, method: str = "GET", payload: dict | None = None) -> dict:
    req = urllib.request.Request(url, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "congress-vision-worker/1.0")
    if ADMIN_TOKEN:
        req.add_header("Authorization", f"Bearer {ADMIN_TOKEN}")
    data_bytes = json.dumps(payload).encode("utf-8") if payload is not None else None
    try:
        with urllib.request.urlopen(req, data=data_bytes, timeout=30) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", "replace")[:300]
        logger.error("HTTP %d for %s: %s", e.code, url, err_body)
        return {"ok": False, "error": f"HTTP {e.code}: {err_body}"}
    except Exception as e:
        logger.error("Request error for %s: %s", url, str(e))
        return {"ok": False, "error": str(e)}


def send_heartbeat() -> bool:
    res = send_request(
        f"{API_BASE_URL}/api/admin/local-worker/heartbeat",
        method="POST",
        payload={
            "workerId": WORKER_ID,
            "statusJson": {
                "engine": "kimi-cli-vision",
                "kimiBin": kimi_bin(),
                "activeAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            },
        },
    )
    ok = bool(res.get("ok"))
    if not ok:
        logger.warning("Heartbeat failed: %s", res.get("error"))
    return ok


def get_pending_scanned_filings() -> list:
    res = send_request(f"{API_BASE_URL}/api/admin/scanned-filings/pending")
    if res.get("ok") and isinstance(res.get("filings"), list):
        return res["filings"]
    return []


PROMPT_TEMPLATE = """You are transcribing a scanned U.S. {form_hint} Periodic Transaction Report
(paper PTR form) into structured JSON. The page images (in order) are:
{image_list}

Read EVERY page with your image-reading tool; zoom into regions when text or
checkmarks are small. The form is often rotated 90 degrees.

Each transaction is a grid row:
- ID Owner checkboxes: JT=joint, SP=spouse, DC=dependent; none marked = self.
  NOTE: a leading TRUST/account-name column may exist — identical
  (asset,date,type,amount) rows under different trusts/owners are REAL distinct
  rows; transcribe all of them, never dedupe.
- FULL ASSET NAME (ticker may be in parentheses).
- TYPE OF TRANSACTION: PURCHASE / SALE / EXCHANGE checkbox X-marks.
- DATE OF TRANSACTION and DATE NOTIFIED (M/D/YY style; assume 20xx).
- AMOUNT OF TRANSACTION: checkboxes with printed ranges, usually:
  A=$1,001-$15,000 (some forms print A=$1,000-$15,000: then use 1000),
  B=$15,001-$50,000, C=$50,001-$100,000, D=$100,001-$250,000,
  E=$250,001-$500,000, F=$500,001-$1,000,000, G=$1,000,001-$5,000,000,
  H=$5,000,001-$25,000,000, I=$25,000,001-$50,000,000, J=Over $50,000,000
  (min 50000000, max null), and some forms print K="Spouse/DC Over $1,000,000"
  (min 1000000, max null). Use the PRINTED range of the CHECKED box.
  If no box is checked, set both amounts null and add a note.
- Amendments: transcribe normally, add note "amendment".

Rules: tx_date must be on/before the filing's filed date ({filed_date}).
Never invent rows. Put uncertainty in each row's "note".

Reply with ONLY a JSON array (no prose, no markdown fences). One object per row:
[{{"owner":"self|spouse|joint|dependent","asset":"...","ticker":"ABC"|null,
  "txType":"P|S|E","txDate":"YYYY-MM-DD"|null,"notifDate":"YYYY-MM-DD"|null,
  "amountMin":1001,"amountMax":15000,"bracket":"A"|null,"note":null}}]
If the document truly has no transactions (e.g. states "Nothing to report"),
reply with exactly: {{"noRows": true}}
"""


def download_pdf(source_url: str, dest: str) -> bool:
    rc = subprocess.run(
        ["curl", "-sS", "-o", dest, "-w", "%{http_code}", "--max-time", "60",
         "-A", DOWNLOAD_UA, source_url],
        capture_output=True, text=True,
    )
    code = (rc.stdout or "").strip()[-3:]
    if code == "200" and os.path.exists(dest):
        with open(dest, "rb") as f:
            return f.read(4) == b"%PDF"
    return False


def render_pages(pdf_path: str, out_dir: str) -> list:
    prefix = os.path.join(out_dir, "page")
    rc = subprocess.run(["pdftoppm", "-png", "-r", "150", pdf_path, prefix],
                        capture_output=True, text=True)
    if rc.returncode != 0:
        logger.error("pdftoppm failed: %s", rc.stderr[:200])
        return []
    pages = sorted(
        os.path.join(out_dir, f) for f in os.listdir(out_dir)
        if f.startswith("page-") and f.endswith(".png")
    )
    return pages


def parse_kimi_json(text: str):
    """Extract the JSON payload from a kimi -p reply (array or {noRows})."""
    text = text.strip()
    text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.M).strip()
    start = min([i for i in (text.find("["), text.find("{")) if i >= 0], default=-1)
    if start < 0:
        return None
    # try progressively smaller suffixes until it parses
    for end in range(len(text), start, -1):
        chunk = text[start:end].strip()
        if not chunk:
            break
        try:
            return json.loads(chunk)
        except Exception:
            # jump to the last closing bracket before end
            nxt = max(chunk.rfind("]"), chunk.rfind("}"))
            if nxt <= 0:
                return None
            end = start + nxt + 1
            try:
                return json.loads(text[start:end])
            except Exception:
                return None
    return None


def validate_rows(rows) -> list:
    """Mechanical validation; returns list of ParsedTx-shaped dicts."""
    out = []
    if not isinstance(rows, list):
        return out
    for o in rows:
        if not isinstance(o, dict):
            continue
        tx_type = o.get("txType")
        if tx_type not in ("P", "S", "E"):
            continue
        asset = (o.get("asset") or "").strip()
        if len(asset) < 3:
            continue
        amin, amax = o.get("amountMin"), o.get("amountMax")
        if amin is not None and amax is not None and isinstance(amin, (int, float)) and isinstance(amax, (int, float)) and amin > amax:
            continue
        note = o.get("note")
        raw = f"{asset} | {tx_type} | {o.get('txDate')} | {amin}-{amax}" + (f" | {note}" if note else "")
        out.append({
            "txDate": o.get("txDate"),
            "owner": o.get("owner") if o.get("owner") in ("self", "spouse", "joint", "dependent") else None,
            "assetName": asset[:500],
            "ticker": (o.get("ticker") or None),
            "assetType": None,
            "txType": tx_type,
            "amountMin": int(amin) if isinstance(amin, (int, float)) else None,
            "amountMax": int(amax) if isinstance(amax, (int, float)) else None,
            "isOption": bool(re.search(r"\b(put|call|option)\b", asset, re.I)),
            "capGainsOver200": False,
            "rawText": raw[:800],
            "description": note,
        })
    return out


def transcribe_with_kimi(pages: list, filed_date: str) -> list | None:
    """Returns list of ParsedTx dicts, [] for verified no-rows, or None on failure."""
    image_list = "\n".join(pages)
    prompt = PROMPT_TEMPLATE.format(
        form_hint="House", image_list=image_list, filed_date=filed_date or "unknown",
    )
    env = dict(os.environ)
    try:
        rc = subprocess.run(
            [kimi_bin(), "-p", prompt],
            capture_output=True, text=True, timeout=KIMI_TIMEOUT_SEC, env=env,
        )
    except subprocess.TimeoutExpired:
        logger.error("kimi transcription timed out (%ss)", KIMI_TIMEOUT_SEC)
        return None
    if rc.returncode != 0:
        logger.error("kimi exited %d: %s", rc.returncode, (rc.stderr or "")[:300])
        return None
    parsed = parse_kimi_json(rc.stdout or "")
    if parsed is None:
        logger.error("could not parse kimi output: %s", (rc.stdout or "")[:200])
        return None
    if isinstance(parsed, dict) and parsed.get("noRows"):
        return []
    rows = validate_rows(parsed)
    return rows


def process_filing(filing: dict) -> bool:
    doc_id = filing.get("doc_id")
    source_url = filing.get("source_url")
    if not doc_id or not source_url:
        return False
    logger.info("Processing %s ...", doc_id)
    with tempfile.TemporaryDirectory(prefix="vw-") as td:
        pdf_path = os.path.join(td, "filing.pdf")
        if not download_pdf(source_url, pdf_path):
            logger.warning("download failed for %s", doc_id)
            return False
        pages = render_pages(pdf_path, td)
        if not pages:
            logger.warning("render failed for %s", doc_id)
            return False
        rows = transcribe_with_kimi(pages, filing.get("filed_date") or "")
    if rows is None:
        logger.warning("transcription failed for %s (will retry next poll)", doc_id)
        return False

    res = send_request(
        f"{API_BASE_URL}/api/admin/ingest-local-vision",
        method="POST",
        payload={
            "docId": doc_id,
            "transactions": rows,
            "workerId": WORKER_ID,
            "extractor": "local_kimi_vision_v1",
        },
    )
    if res.get("ok"):
        logger.info(
            "%s submitted: %d txs, published=%s needsReview=%s",
            doc_id, len(rows), res.get("published"), res.get("needsReview"),
        )
        return True
    logger.error("Submission failed for %s: %s", doc_id, res.get("error"))
    return False


def main():
    logger.info("Starting local vision worker [ID=%s, API=%s, engine=kimi-cli-vision]",
                WORKER_ID, API_BASE_URL)
    last_heartbeat = 0.0
    while True:
        now = time.time()
        if now - last_heartbeat >= HEARTBEAT_INTERVAL_SEC:
            send_heartbeat()
            last_heartbeat = now
        try:
            filings = get_pending_scanned_filings()
            if filings:
                logger.info("Found %d pending scanned filings", len(filings))
                for f in filings:
                    process_filing(f)
        except Exception as e:
            logger.error("Worker poll loop exception: %s", str(e))
        time.sleep(POLL_INTERVAL_SEC)


if __name__ == "__main__":
    main()
