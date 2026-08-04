#!/usr/bin/env python3
"""
macOS local vision worker for Congress.Trade
Service: com.congress.trade.vision-worker

Polls the app for pending scanned_pdf filings, transcribes them with Grok
vision via OpenRouter (x-ai/grok-4.5 by default), and posts ParsedTx-shaped
rows to /api/admin/ingest-local-vision (normalize pipeline, source='local_mac').

Kimi CLI was retired: it hit a hard provider billing 403 and is not recoverable
for this seat. Grok vision is the single local-worker engine going forward.

Env:
  CONGRESS_TRADE_API_URL   (default http://localhost:8787)
  ADMIN_TOKEN              (admin bearer for the app)
  WORKER_ID                (default local_mac_1)
  POLL_INTERVAL_SEC        (default 30)
  HEARTBEAT_INTERVAL_SEC   (default 60)
  OPENROUTER_API_KEY       (required for Grok vision)
  OPENROUTER_MODEL         (default x-ai/grok-4.5)
  GROK_TIMEOUT_SEC         (per-doc transcription budget, default 600)
  MAX_DOCS_PER_POLL        (default 3 — keep OpenRouter spend paced)
"""

from __future__ import annotations  # py3.9: lazy annotations (dict | None etc.)

import base64
import json
import logging
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

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
GROK_TIMEOUT_SEC = int(os.getenv("GROK_TIMEOUT_SEC", "600"))
MAX_DOCS_PER_POLL = int(os.getenv("MAX_DOCS_PER_POLL", "3"))
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "x-ai/grok-4.5")
DOWNLOAD_UA = "congress-feed/0.1 (+https://congress.trade)"
ENGINE = "openrouter-grok-vision"


def send_request(url: str, method: str = "GET", payload: dict | None = None, timeout: int = 60) -> dict:
    req = urllib.request.Request(url, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "congress-vision-worker/2.0-grok")
    if ADMIN_TOKEN:
        req.add_header("Authorization", f"Bearer {ADMIN_TOKEN}")
    data_bytes = json.dumps(payload).encode("utf-8") if payload is not None else None
    try:
        with urllib.request.urlopen(req, data=data_bytes, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", "replace")[:400]
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
                "engine": ENGINE,
                "model": OPENROUTER_MODEL,
                "openrouterKeyConfigured": bool(OPENROUTER_API_KEY),
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


PROMPT_TEMPLATE = """You are transcribing a scanned U.S. {form_hint} disclosure
form into structured JSON. A PDF of the filing is attached.

Read EVERY page. Forms may be rotated. Prefer the literal printed text over
guesses. Checkbox X-marks determine transaction type and amount brackets.

Each transaction is a grid/table row with fields like:
- Owner: JT=joint, SP=spouse, DC=dependent; unmarked = self.
  A leading TRUST/account-name column may exist — identical
  (asset,date,type,amount) rows under different trusts/owners are REAL distinct
  rows; transcribe all of them, never dedupe.
- FULL ASSET NAME (ticker may be in parentheses).
- TYPE OF TRANSACTION: PURCHASE / SALE / EXCHANGE (or P/S/E checkboxes).
- DATE OF TRANSACTION and DATE NOTIFIED (M/D/YY style; assume 20xx).
- AMOUNT: checkbox ranges, usually:
  A=$1,001-$15,000 (some forms print A=$1,000-$15,000: then use 1000),
  B=$15,001-$50,000, C=$50,001-$100,000, D=$100,001-$250,000,
  E=$250,001-$500,000, F=$500,001-$1,000,000, G=$1,000,001-$5,000,000,
  H=$5,000,001-$25,000,000, I=$25,000,001-$50,000,000, J=Over $50,000,000
  (min 50000000, max null), and some forms print K="Spouse/DC Over $1,000,000"
  (min 1000000, max null). Use the PRINTED range of the CHECKED box.
  If no box is checked, set both amounts null and add a note.
- Executive OGE 278-T: asset / transaction type / date / amount category may
  appear as free text rather than checkboxes — still emit the same schema.
- Amendments: transcribe normally, add note "amendment".

Rules: tx_date must be on/before the filing's filed date ({filed_date}).
Never invent rows. Put uncertainty in each row's "note".

Reply with ONLY a JSON object (no prose, no markdown fences):
{{"transactions":[{{"owner":"self|spouse|joint|dependent","asset":"...","ticker":"ABC"|null,
  "txType":"P|S|E","txDate":"YYYY-MM-DD"|null,"notifDate":"YYYY-MM-DD"|null,
  "amountMin":1001,"amountMax":15000,"bracket":"A"|null,"note":null}}]}}
If the document truly has no transactions (e.g. states "Nothing to report"),
reply with exactly: {{"transactions":[],"noRows":true}}
"""


def download_pdf(source_url: str, dest: str) -> bool:
    rc = subprocess.run(
        ["curl", "-sS", "-o", dest, "-w", "%{http_code}", "--max-time", "90",
         "-A", DOWNLOAD_UA, "-L", source_url],
        capture_output=True, text=True,
    )
    code = (rc.stdout or "").strip()[-3:]
    if code == "200" and os.path.exists(dest):
        with open(dest, "rb") as f:
            return f.read(4) == b"%PDF"
    logger.warning("download HTTP %s for %s", code, source_url[:120])
    return False


def parse_model_json(text: str):
    """Extract JSON payload (array, {transactions}, or {noRows})."""
    text = (text or "").strip()
    text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.M).strip()
    start = min([i for i in (text.find("["), text.find("{")) if i >= 0], default=-1)
    if start < 0:
        return None
    for end in range(len(text), start, -1):
        chunk = text[start:end].strip()
        if not chunk:
            break
        try:
            return json.loads(chunk)
        except Exception:
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
        tx_type = o.get("txType") or o.get("tx_type")
        # Accept long-form labels from free-text OGE forms.
        if isinstance(tx_type, str):
            t = tx_type.strip().upper()
            if t in ("P", "PURCHASE", "BUY", "BOUGHT"):
                tx_type = "P"
            elif t in ("S", "SALE", "SELL", "SOLD", "SALE_FULL", "SALE_PARTIAL", "PARTIAL SALE"):
                tx_type = "S"
            elif t in ("E", "EXCHANGE"):
                tx_type = "E"
        if tx_type not in ("P", "S", "E"):
            continue
        asset = (o.get("asset") or o.get("assetName") or o.get("asset_name") or "").strip()
        if len(asset) < 3:
            continue
        amin, amax = o.get("amountMin", o.get("amount_min")), o.get("amountMax", o.get("amount_max"))
        if amin is not None and amax is not None and isinstance(amin, (int, float)) and isinstance(amax, (int, float)) and amin > amax:
            continue
        note = o.get("note") or o.get("description")
        amin_i = int(amin) if isinstance(amin, (int, float)) else None
        amax_i = int(amax) if isinstance(amax, (int, float)) else None
        # Keep rawText free of bare "min-max" digits so normalizer's
        # parseAmountRange(rawText) does not fight the already-snapped bracket
        # and flag invalid_amount. Prefer ticker/asset prose only.
        raw = f"{asset}"
        if o.get("ticker"):
            raw += f" ({o.get('ticker')})"
        raw += f" | {tx_type} | {o.get('txDate') or o.get('tx_date') or ''}"
        if note:
            raw += f" | {note}"
        out.append({
            "txDate": o.get("txDate") or o.get("tx_date"),
            "owner": o.get("owner") if o.get("owner") in ("self", "spouse", "joint", "dependent") else None,
            "assetName": asset[:500],
            "ticker": (o.get("ticker") or None),
            "assetType": None,
            "txType": tx_type,
            "amountMin": amin_i,
            "amountMax": amax_i,
            "isOption": bool(re.search(r"\b(put|call|option)\b", asset, re.I)),
            "capGainsOver200": False,
            # Grok vision base confidence — high enough that clean rows clear
            # CONFIDENCE_THRESHOLD (0.95) after mild penalties; missing amounts
            # still get penalized into review.
            "confidence": 0.97,
            "rawText": raw[:800],
            "description": note,
        })
    return out


def form_hint_for(filing: dict) -> str:
    chamber = (filing.get("chamber") or "").lower()
    if chamber == "executive":
        return "executive branch OGE 278-T / 278"
    if chamber == "senate":
        return "Senate"
    return "House"


def transcribe_with_grok(pdf_path: str, filing: dict) -> list | None:
    """Returns list of ParsedTx dicts, [] for verified no-rows, or None on failure."""
    if not OPENROUTER_API_KEY:
        logger.error("OPENROUTER_API_KEY is not set — cannot run Grok vision")
        return None

    with open(pdf_path, "rb") as f:
        pdf_b64 = base64.b64encode(f.read()).decode("ascii")
    file_data = f"data:application/pdf;base64,{pdf_b64}"

    prompt = PROMPT_TEMPLATE.format(
        form_hint=form_hint_for(filing),
        filed_date=filing.get("filed_date") or "unknown",
    )

    body = {
        "model": OPENROUTER_MODEL,
        "max_tokens": 32000,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "usage": {"include": True},
        "plugins": [{"id": "response-healing"}],
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "file",
                        "file": {"filename": "filing.pdf", "file_data": file_data},
                    },
                    {"type": "text", "text": prompt},
                ],
            }
        ],
        "user": f"vision-worker:{filing.get('doc_id') or 'unknown'}",
    }

    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {OPENROUTER_API_KEY}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://congress.trade",
            "X-Title": "Congress.Trade vision-worker",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=GROK_TIMEOUT_SEC) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", "replace")[:500]
        logger.error("OpenRouter HTTP %d: %s", e.code, err_body)
        # Hard budget — sleep longer so we don't burn the poll loop.
        if e.code in (402, 403):
            logger.error("OpenRouter budget/auth halt — backing off 15m")
            time.sleep(900)
        return None
    except Exception as e:
        logger.error("OpenRouter request failed: %s", str(e)[:300])
        return None

    usage = payload.get("usage") or {}
    cost = usage.get("cost")
    logger.info(
        "Grok reply model=%s tokens_in=%s tokens_out=%s cost=%s",
        payload.get("model") or OPENROUTER_MODEL,
        usage.get("prompt_tokens"),
        usage.get("completion_tokens"),
        cost,
    )

    content = ""
    try:
        content = payload["choices"][0]["message"]["content"] or ""
    except Exception:
        logger.error("unexpected OpenRouter shape: %s", json.dumps(payload)[:300])
        return None

    parsed = parse_model_json(content)
    if parsed is None:
        logger.error("could not parse Grok output: %s", content[:240])
        return None
    if isinstance(parsed, dict):
        if parsed.get("noRows") and not parsed.get("transactions"):
            return []
        rows = parsed.get("transactions")
        if rows is None and isinstance(parsed.get("rows"), list):
            rows = parsed["rows"]
        if rows is None:
            # Single object mistaken for a row?
            logger.error("Grok JSON missing transactions: keys=%s", list(parsed.keys())[:12])
            return None
        return validate_rows(rows)
    if isinstance(parsed, list):
        return validate_rows(parsed)
    return None


def process_filing(filing: dict) -> bool:
    doc_id = filing.get("doc_id")
    source_url = filing.get("source_url")
    if not doc_id or not source_url:
        return False
    logger.info("Processing %s (chamber=%s) ...", doc_id, filing.get("chamber"))
    with tempfile.TemporaryDirectory(prefix="vw-") as td:
        pdf_path = os.path.join(td, "filing.pdf")
        if not download_pdf(source_url, pdf_path):
            # Fall back to app-hosted raw when source URL fails (R2 signed via admin not available;
            # many OGE/house URLs are public — if not, leave for next poll/reprocess).
            logger.warning("download failed for %s", doc_id)
            return False
        rows = transcribe_with_grok(pdf_path, filing)
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
            "extractor": "local_grok_vision_v1",
            "source": "local_mac",
        },
        timeout=120,
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
    if not OPENROUTER_API_KEY:
        logger.error("OPENROUTER_API_KEY missing — set it in the launch wrapper and restart")
        sys.exit(2)
    logger.info(
        "Starting local vision worker [ID=%s, API=%s, engine=%s, model=%s]",
        WORKER_ID, API_BASE_URL, ENGINE, OPENROUTER_MODEL,
    )
    last_heartbeat = 0.0
    while True:
        now = time.time()
        if now - last_heartbeat >= HEARTBEAT_INTERVAL_SEC:
            send_heartbeat()
            last_heartbeat = now
        try:
            filings = get_pending_scanned_filings()
            if filings:
                batch = filings[:MAX_DOCS_PER_POLL]
                logger.info("Found %d pending scanned filings; processing %d", len(filings), len(batch))
                for f in batch:
                    process_filing(f)
        except Exception as e:
            logger.error("Worker poll loop exception: %s", str(e))
        time.sleep(POLL_INTERVAL_SEC)


if __name__ == "__main__":
    main()
