#!/usr/bin/env python3
"""
macOS local vision worker for Congress.Trade
Service: com.congress.trade.vision-worker

Polls the app for pending scanned_pdf filings, transcribes them with Grok
vision, and posts ParsedTx-shaped rows to /api/admin/ingest-local-vision
(normalize pipeline, source='local_mac').

Engines (VISION_ENGINE):
  local_cli   — PRIMARY. Local `grok -p` headless CLI, authenticated via the
                owner's xAI OIDC subscription (~/.grok/auth.json). Renders PDF
                pages with pdftoppm and has Grok read the PNGs via read_file
                vision. $0 OpenRouter / API-key spend.
  openrouter  — OpenRouter x-ai/grok-4.5 with native PDF file attachment.
                Uses CT_OPENROUTER_API_KEY. Kept as fallback / secondary path.
  auto        — try local_cli first, fall back to openrouter on hard failure.

Kimi CLI was retired (provider billing 403). Do not reintroduce it.

Env:
  CONGRESS_TRADE_API_URL   (default http://localhost:8787)
  ADMIN_TOKEN              (admin bearer for the app)
  WORKER_ID                (default local_mac_1)
  POLL_INTERVAL_SEC        (default 30)
  HEARTBEAT_INTERVAL_SEC   (default 60)
  VISION_ENGINE            (auto|local_cli|openrouter, default auto)
  GROK_BIN                 (default: which grok / ~/.grok/bin/grok)
  GROK_CLI_TIMEOUT_SEC     (per-doc local CLI budget, default 900)
  GROK_CLI_MAX_TURNS       (default 8 — room to read multipage scans)
  OPENROUTER_API_KEY       (required only for openrouter / auto fallback)
  OPENROUTER_MODEL         (default x-ai/grok-4.5)
  OPENROUTER_TIMEOUT_SEC   (default 600)
  MAX_DOCS_PER_POLL        (default 2)
  MAX_PAGES                (default 12 — cap page images sent to local CLI)
  MAX_ATTEMPTS             (default 3 — per-doc local-vision retries before park)
  BACKOFF_BASE_SEC         (default 90 — exponential: base * 2^(attempt-1))
  STATE_FILE               (default ~/vision-worker/attempt-state.json)
  EXHAUSTED_ALERT_THRESHOLD (default 5 — Pushover when parked count crosses)
  PUSHOVER_APP_TOKEN / PUSHOVER_USER_KEY  (optional; publish + exhausted alerts)

Defect fix (2026-08-10): unbounded re-attempts of the same 0-tx docs burned
xAI subscription quota and flooded Grok Build session history. Max attempts
+ exponential backoff + honest local_vision_exhausted park are mandatory.
"""

from __future__ import annotations  # py3.9: lazy annotations (dict | None etc.)

import base64
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
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
VISION_ENGINE = (os.getenv("VISION_ENGINE", "auto") or "auto").strip().lower()
GROK_CLI_TIMEOUT_SEC = int(os.getenv("GROK_CLI_TIMEOUT_SEC", "900"))
GROK_CLI_MAX_TURNS = int(os.getenv("GROK_CLI_MAX_TURNS", "8"))
OPENROUTER_TIMEOUT_SEC = int(os.getenv("OPENROUTER_TIMEOUT_SEC", "600"))
MAX_DOCS_PER_POLL = int(os.getenv("MAX_DOCS_PER_POLL", "2"))
MAX_PAGES = int(os.getenv("MAX_PAGES", "12"))
MAX_ATTEMPTS = max(1, int(os.getenv("MAX_ATTEMPTS", "3")))
BACKOFF_BASE_SEC = max(15, int(os.getenv("BACKOFF_BASE_SEC", "90")))
EXHAUSTED_ALERT_THRESHOLD = max(1, int(os.getenv("EXHAUSTED_ALERT_THRESHOLD", "5")))
STATE_FILE = os.path.expanduser(
    os.getenv("STATE_FILE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "attempt-state.json"))
)
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "x-ai/grok-4.5")
PUSHOVER_APP_TOKEN = os.getenv("PUSHOVER_APP_TOKEN", "")
PUSHOVER_USER_KEY = os.getenv("PUSHOVER_USER_KEY", "")
DOWNLOAD_UA = "congress-feed/0.1 (+https://congress.trade)"


def grok_bin() -> str:
    if os.getenv("GROK_BIN"):
        return os.environ["GROK_BIN"]
    for cand in (
        os.path.expanduser("~/.grok/bin/grok"),
        "/opt/homebrew/bin/grok",
        "/usr/local/bin/grok",
        os.path.expanduser("~/.local/bin/grok"),
    ):
        if os.path.exists(cand) and os.access(cand, os.X_OK):
            return cand
    found = shutil.which("grok")
    return found or "grok"


def active_engine_label() -> str:
    if VISION_ENGINE == "openrouter":
        return "openrouter-grok-vision"
    if VISION_ENGINE == "local_cli":
        return "local-grok-cli-vision"
    return "auto-local-cli+openrouter-fallback"


def send_request(url: str, method: str = "GET", payload: dict | None = None, timeout: int = 60) -> dict:
    req = urllib.request.Request(url, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "congress-vision-worker/3.0-local-grok")
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


def load_attempt_state() -> dict:
    """Per-doc attempt ledger: {docs: {doc_id: {attempts, next_eligible_at, last_error, exhausted, parked}}}."""
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("docs"), dict):
            return data
    except FileNotFoundError:
        pass
    except Exception as e:
        logger.warning("attempt state load failed (%s); starting empty", str(e)[:120])
    return {"docs": {}, "exhausted_alert_sent_at": None, "exhausted_alert_count": 0}


def save_attempt_state(state: dict) -> None:
    try:
        parent = os.path.dirname(STATE_FILE)
        if parent:
            os.makedirs(parent, exist_ok=True)
        tmp = STATE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2, sort_keys=True)
        os.replace(tmp, STATE_FILE)
    except Exception as e:
        logger.error("attempt state save failed: %s", str(e)[:200])


def doc_entry(state: dict, doc_id: str) -> dict:
    docs = state.setdefault("docs", {})
    entry = docs.get(doc_id)
    if not isinstance(entry, dict):
        entry = {
            "attempts": 0,
            "next_eligible_at": 0.0,
            "last_error": None,
            "exhausted": False,
            "parked": False,
        }
        docs[doc_id] = entry
    return entry


def send_pushover(title: str, message: str, priority: int = 0) -> bool:
    """Optional publish/exhausted alerts. No-op when keys missing; never throws."""
    if not PUSHOVER_APP_TOKEN or not PUSHOVER_USER_KEY:
        return False
    try:
        body = urllib.parse.urlencode({
            "token": PUSHOVER_APP_TOKEN,
            "user": PUSHOVER_USER_KEY,
            "title": title[:250],
            "message": message[:1024],
            "priority": str(priority),
        }).encode("utf-8")
        req = urllib.request.Request(
            "https://api.pushover.net/1/messages.json",
            data=body,
            method="POST",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            return 200 <= resp.status < 300
    except Exception as e:
        logger.warning("pushover failed: %s", str(e)[:160])
        return False


def count_exhausted(state: dict) -> int:
    docs = state.get("docs") or {}
    return sum(1 for e in docs.values() if isinstance(e, dict) and e.get("exhausted"))


def maybe_alert_exhausted(state: dict) -> None:
    n = count_exhausted(state)
    if n < EXHAUSTED_ALERT_THRESHOLD:
        return
    # Renotify only when count rises past a previous alert level.
    prev = int(state.get("exhausted_alert_count") or 0)
    if n <= prev:
        return
    sent = send_pushover(
        "CT local vision: docs exhausted",
        f"{n} scanned filing(s) parked as local_vision_exhausted "
        f"(threshold {EXHAUSTED_ALERT_THRESHOLD}). Needs #1575 vision spend decision.",
        priority=0,
    )
    if sent:
        state["exhausted_alert_count"] = n
        state["exhausted_alert_sent_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        save_attempt_state(state)
        logger.info("exhausted-threshold pushover sent (count=%d)", n)


def send_heartbeat(state: dict | None = None) -> bool:
    exhausted = count_exhausted(state) if state is not None else None
    res = send_request(
        f"{API_BASE_URL}/api/admin/local-worker/heartbeat",
        method="POST",
        payload={
            "workerId": WORKER_ID,
            "statusJson": {
                "engine": active_engine_label(),
                "visionEngine": VISION_ENGINE,
                "grokBin": grok_bin(),
                "openrouterModel": OPENROUTER_MODEL,
                "openrouterKeyConfigured": bool(OPENROUTER_API_KEY),
                "maxAttempts": MAX_ATTEMPTS,
                "maxDocsPerPoll": MAX_DOCS_PER_POLL,
                "exhaustedDocs": exhausted,
                "activeAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            },
        },
    )
    ok = bool(res.get("ok"))
    if not ok:
        logger.warning("Heartbeat failed: %s", res.get("error"))
    return ok


def get_pending_scanned_filings() -> list:
    # ?worker=local opts into the broad reclaim set: the server advertises
    # EVERY unresolved scanned review item (cascade disagreements, row-limit
    # garbage, low-confidence flags), not just form-chrome/empty failures.
    # The Coolify CPU OCR worker stays on the conservative set.
    res = send_request(f"{API_BASE_URL}/api/admin/scanned-filings/pending?worker=local")
    if res.get("ok") and isinstance(res.get("filings"), list):
        return res["filings"]
    return []


def park_local_vision(
    doc_id: str,
    attempts: int,
    last_error: str,
    extractor: str | None = None,
) -> bool:
    """Honest terminal park via admin API. Falls back to local exhausted flag if API missing."""
    res = send_request(
        f"{API_BASE_URL}/api/admin/local-vision-park",
        method="POST",
        payload={
            "docId": doc_id,
            "workerId": WORKER_ID,
            "attempts": attempts,
            "lastError": last_error[:500],
            "extractor": extractor or active_engine_label(),
        },
        timeout=60,
    )
    if res.get("ok"):
        logger.info(
            "parked %s as local_vision_exhausted attempts=%d last=%s",
            doc_id, attempts, last_error[:120],
        )
        return True
    err = res.get("error") or "unknown"
    # Pre-deploy: API may 404 — still stop local re-attempts.
    logger.warning("local-vision-park API failed for %s: %s (local exhaust still holds)", doc_id, err)
    return False


# Shared extraction instructions. Local CLI path lists page image paths;
# OpenRouter path attaches the PDF.
PROMPT_CORE = """You are transcribing a scanned U.S. {form_hint} disclosure
form into structured JSON.

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

LOCAL_CLI_PROMPT = """{core}

Page images (absolute paths, in order). Use your read_file / image-reading
tool on EACH path before answering — do not invent rows without reading:
{image_list}
"""

OPENROUTER_PROMPT = """{core}

A PDF of the filing is attached — read every page.
"""


def stored_document_url(filing: dict) -> str | None:
    """Build admin URL for the durable stored copy. Never uses source_url."""
    explicit = filing.get("stored_document_url") or filing.get("storedDocumentUrl")
    if isinstance(explicit, str) and explicit.strip():
        path = explicit.strip()
        if path.startswith("http://") or path.startswith("https://"):
            return path
        return f"{API_BASE_URL}{path if path.startswith('/') else '/' + path}"
    doc_id = filing.get("doc_id")
    raw_key = filing.get("raw_object_key")
    if not doc_id or not raw_key:
        return None
    return f"{API_BASE_URL}/api/admin/filings/{urllib.parse.quote(str(doc_id), safe='')}/raw"


def download_stored_document(filing: dict, dest: str) -> bool:
    """
    Fetch the durable R2 copy via admin API. NEVER hits Clerk/eFD/OGE.
    Accepts PDF (primary for scanned_pdf) and HTML (senate/electronic, saved too).
    """
    url = stored_document_url(filing)
    if not url:
        logger.warning(
            "no stored copy for %s (raw_object_key missing) — refusing source re-download",
            filing.get("doc_id"),
        )
        return False
    if not ADMIN_TOKEN:
        logger.error("ADMIN_TOKEN required to fetch stored document")
        return False
    # No -L follow to foreign hosts: the admin endpoint must return bytes inline.
    rc = subprocess.run(
        [
            "curl", "-sS", "-o", dest, "-w", "%{http_code}",
            "--max-time", "90",
            "--max-redirs", "0",
            "-A", DOWNLOAD_UA,
            "-H", f"Authorization: Bearer {ADMIN_TOKEN}",
            url,
        ],
        capture_output=True, text=True,
    )
    code = (rc.stdout or "").strip()[-3:]
    if code != "200" or not os.path.exists(dest):
        logger.warning(
            "stored download HTTP %s for %s url=%s",
            code, filing.get("doc_id"), url[:160],
        )
        return False
    with open(dest, "rb") as f:
        head = f.read(16)
    if head.startswith(b"%PDF") or head.lstrip().startswith(b"<") or head.lstrip().lower().startswith(b"<!doctype"):
        return True
    # Some HTML is served with a BOM / whitespace; accept non-empty bodies ≥ 100B
    # that the admin endpoint already validated as our stored object.
    size = os.path.getsize(dest)
    if size >= 100:
        logger.info(
            "stored download ok (non-pdf magic) doc=%s bytes=%d head=%r",
            filing.get("doc_id"), size, head[:8],
        )
        return True
    logger.warning("stored download too small/unrecognized for %s", filing.get("doc_id"))
    return False


def render_pages(pdf_path: str, out_dir: str) -> list:
    """Render PDF pages to PNG via pdftoppm. Returns absolute page paths."""
    prefix = os.path.join(out_dir, "page")
    rc = subprocess.run(
        ["pdftoppm", "-png", "-r", "150", pdf_path, prefix],
        capture_output=True, text=True,
    )
    if rc.returncode != 0:
        logger.error("pdftoppm failed: %s", (rc.stderr or "")[:200])
        return []
    pages = sorted(
        os.path.join(out_dir, f) for f in os.listdir(out_dir)
        if f.startswith("page-") and f.endswith(".png")
    )
    if MAX_PAGES > 0 and len(pages) > MAX_PAGES:
        logger.warning("capping pages %d -> %d", len(pages), MAX_PAGES)
        pages = pages[:MAX_PAGES]
    return pages


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
        # rawText is fed to normalizer parseAmountRange(). Hyphenated dates and
        # bare "1001-15000" digits get misread as amount ranges → invalid_amount.
        # Keep audit text to asset prose only.
        raw = asset[:500]
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


def rows_from_parsed(parsed) -> list | None:
    if parsed is None:
        return None
    if isinstance(parsed, dict):
        if parsed.get("noRows") and not parsed.get("transactions"):
            return []
        rows = parsed.get("transactions")
        if rows is None and isinstance(parsed.get("rows"), list):
            rows = parsed["rows"]
        if rows is None:
            logger.error("JSON missing transactions: keys=%s", list(parsed.keys())[:12])
            return None
        return validate_rows(rows)
    if isinstance(parsed, list):
        return validate_rows(parsed)
    return None


def transcribe_with_local_cli(pages: list, filing: dict) -> list | None:
    """Grok Build CLI (`grok -p`) via owner OIDC subscription — primary path."""
    bin_path = grok_bin()
    if not shutil.which(bin_path) and not os.path.exists(bin_path):
        logger.error("local grok CLI not found at %s", bin_path)
        return None
    if not pages:
        logger.error("no page images for local CLI vision")
        return None

    core = PROMPT_CORE.format(
        form_hint=form_hint_for(filing),
        filed_date=filing.get("filed_date") or "unknown",
    )
    image_list = "\n".join(f"- {p}" for p in pages)
    prompt = LOCAL_CLI_PROMPT.format(core=core, image_list=image_list)

    # Headless: single-turn agentic loop with read_file only so the model can
    # open each PNG with multimodal vision under the subscription pool.
    cmd = [
        bin_path,
        "-p", prompt,
        "--output-format", "plain",
        "--max-turns", str(GROK_CLI_MAX_TURNS),
        "--tools", "read_file",
        "--always-approve",
        "--no-memory",
        "--no-subagents",
        "--disable-web-search",
    ]
    logger.info(
        "local grok CLI: %s pages=%d timeout=%ss",
        bin_path, len(pages), GROK_CLI_TIMEOUT_SEC,
    )
    try:
        rc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=GROK_CLI_TIMEOUT_SEC,
            env=dict(os.environ),
        )
    except subprocess.TimeoutExpired:
        logger.error("local grok CLI timed out (%ss)", GROK_CLI_TIMEOUT_SEC)
        return None
    except Exception as e:
        logger.error("local grok CLI failed to start: %s", str(e)[:300])
        return None

    if rc.returncode != 0:
        logger.error(
            "local grok CLI exit %d: %s",
            rc.returncode,
            ((rc.stderr or "") + "\n" + (rc.stdout or ""))[:400],
        )
        return None

    content = rc.stdout or ""
    if not content.strip():
        # Some builds put the answer on stderr when stdout is noisy.
        content = rc.stderr or ""
    parsed = parse_model_json(content)
    if parsed is None:
        logger.error("could not parse local grok CLI output: %s", content[:300])
        return None
    rows = rows_from_parsed(parsed)
    logger.info("local grok CLI rows=%s", None if rows is None else len(rows))
    return rows


def transcribe_with_openrouter(pdf_path: str, filing: dict) -> list | None:
    """OpenRouter Grok vision fallback (paid API key)."""
    if not OPENROUTER_API_KEY:
        logger.error("OPENROUTER_API_KEY is not set — cannot run OpenRouter fallback")
        return None

    with open(pdf_path, "rb") as f:
        pdf_b64 = base64.b64encode(f.read()).decode("ascii")
    file_data = f"data:application/pdf;base64,{pdf_b64}"

    core = PROMPT_CORE.format(
        form_hint=form_hint_for(filing),
        filed_date=filing.get("filed_date") or "unknown",
    )
    prompt = OPENROUTER_PROMPT.format(core=core)

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
        with urllib.request.urlopen(req, timeout=OPENROUTER_TIMEOUT_SEC) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", "replace")[:500]
        logger.error("OpenRouter HTTP %d: %s", e.code, err_body)
        if e.code in (402, 403):
            logger.error("OpenRouter budget/auth halt — backing off 15m")
            time.sleep(900)
        return None
    except Exception as e:
        logger.error("OpenRouter request failed: %s", str(e)[:300])
        return None

    usage = payload.get("usage") or {}
    logger.info(
        "OpenRouter reply model=%s tokens_in=%s tokens_out=%s cost=%s",
        payload.get("model") or OPENROUTER_MODEL,
        usage.get("prompt_tokens"),
        usage.get("completion_tokens"),
        usage.get("cost"),
    )

    try:
        content = payload["choices"][0]["message"]["content"] or ""
    except Exception:
        logger.error("unexpected OpenRouter shape: %s", json.dumps(payload)[:300])
        return None

    parsed = parse_model_json(content)
    if parsed is None:
        logger.error("could not parse OpenRouter output: %s", content[:240])
        return None
    return rows_from_parsed(parsed)


def transcribe(pdf_path: str, pages: list, filing: dict) -> tuple[list | None, str]:
    """Returns (rows|None, engine_used)."""
    engine = VISION_ENGINE
    if engine not in ("auto", "local_cli", "openrouter"):
        logger.warning("unknown VISION_ENGINE=%s; using auto", engine)
        engine = "auto"

    if engine in ("auto", "local_cli"):
        rows = transcribe_with_local_cli(pages, filing)
        if rows is not None:
            return rows, "local_grok_cli_v1"
        if engine == "local_cli":
            return None, "local_grok_cli_v1"
        logger.warning("local CLI failed; falling back to OpenRouter Grok")

    rows = transcribe_with_openrouter(pdf_path, filing)
    return rows, "local_grok_openrouter_v1"


def record_failure(state: dict, doc_id: str, reason: str, extractor: str | None = None) -> None:
    """Increment attempt, schedule backoff, or park after MAX_ATTEMPTS."""
    entry = doc_entry(state, doc_id)
    entry["attempts"] = int(entry.get("attempts") or 0) + 1
    entry["last_error"] = reason
    entry["last_attempt_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    attempts = entry["attempts"]
    if attempts >= MAX_ATTEMPTS:
        entry["exhausted"] = True
        entry["next_eligible_at"] = time.time() + 365 * 24 * 3600  # never re-pick locally
        parked = park_local_vision(doc_id, attempts, reason, extractor)
        entry["parked"] = bool(parked)
        logger.warning(
            "cap: max attempts reached doc=%s attempts=%d/%d last=%s parked_api=%s",
            doc_id, attempts, MAX_ATTEMPTS, reason[:120], parked,
        )
        save_attempt_state(state)
        maybe_alert_exhausted(state)
        return
    backoff = BACKOFF_BASE_SEC * (2 ** max(0, attempts - 1))
    entry["next_eligible_at"] = time.time() + backoff
    logger.warning(
        "cap: attempt failed doc=%s attempts=%d/%d backoff=%ds reason=%s",
        doc_id, attempts, MAX_ATTEMPTS, backoff, reason[:120],
    )
    save_attempt_state(state)


def clear_attempts(state: dict, doc_id: str) -> None:
    docs = state.get("docs") or {}
    if doc_id in docs:
        del docs[doc_id]
        save_attempt_state(state)


def process_filing(filing: dict, state: dict) -> str:
    """
    Process one filing. Returns outcome tag:
      published | needs_review_with_rows | skipped_backoff | skipped_exhausted | failed
    """
    doc_id = filing.get("doc_id")
    if not doc_id:
        return "failed"
    if not filing.get("raw_object_key") and not (
        filing.get("stored_document_url") or filing.get("storedDocumentUrl")
    ):
        logger.warning(
            "skip %s: no stored copy (raw_object_key) — never re-download from source",
            doc_id,
        )
        record_failure(state, doc_id, "no_stored_copy", active_engine_label())
        return "failed"

    entry = doc_entry(state, doc_id)
    now = time.time()
    if entry.get("exhausted"):
        logger.info(
            "cap: skip exhausted doc=%s attempts=%s last=%s",
            doc_id, entry.get("attempts"), (entry.get("last_error") or "")[:80],
        )
        # Re-assert park if API was down earlier.
        if not entry.get("parked"):
            parked = park_local_vision(
                doc_id,
                int(entry.get("attempts") or MAX_ATTEMPTS),
                str(entry.get("last_error") or "exhausted"),
            )
            entry["parked"] = bool(parked)
            save_attempt_state(state)
        return "skipped_exhausted"

    next_eligible = float(entry.get("next_eligible_at") or 0)
    if next_eligible > now:
        wait = int(next_eligible - now)
        logger.info(
            "cap: backoff skip doc=%s attempts=%s next_in=%ds last=%s",
            doc_id, entry.get("attempts"), wait, (entry.get("last_error") or "")[:80],
        )
        return "skipped_backoff"

    logger.info(
        "Processing %s (chamber=%s, engine=%s, prior_attempts=%s, via=stored-raw) ...",
        doc_id, filing.get("chamber"), VISION_ENGINE, entry.get("attempts") or 0,
    )
    extractor = active_engine_label()
    with tempfile.TemporaryDirectory(prefix="vw-") as td:
        pdf_path = os.path.join(td, "filing.pdf")
        if not download_stored_document(filing, pdf_path):
            record_failure(state, doc_id, "stored_download_failed", extractor)
            return "failed"
        pages = render_pages(pdf_path, td) if VISION_ENGINE != "openrouter" else []
        if VISION_ENGINE != "openrouter" and not pages:
            # Still try OpenRouter with the stored PDF if local render failed.
            logger.warning("page render failed for %s; OpenRouter-only attempt on stored bytes", doc_id)
        rows, extractor = transcribe(pdf_path, pages, filing)
    if rows is None:
        record_failure(state, doc_id, "transcription_failed", extractor)
        return "failed"

    # Zero-row "success" is still a failed local-vision attempt for retry
    # purposes — those docs re-entered pending via extract_empty and spun forever.
    # Final attempt parks via local-vision-park (honest class), not extract_empty.
    if len(rows) == 0:
        record_failure(state, doc_id, "zero_transactions", extractor)
        return "failed"

    res = send_request(
        f"{API_BASE_URL}/api/admin/ingest-local-vision",
        method="POST",
        payload={
            "docId": doc_id,
            "transactions": rows,
            "workerId": WORKER_ID,
            "extractor": extractor,
            "source": "local_mac",
        },
        timeout=120,
    )
    if res.get("ok"):
        published = bool(res.get("published"))
        needs_review = bool(res.get("needsReview"))
        logger.info(
            "%s submitted via %s: %d txs, published=%s needsReview=%s",
            doc_id, extractor, len(rows), published, needs_review,
        )
        clear_attempts(state, doc_id)
        if published:
            send_pushover(
                "CT local vision: published",
                f"{doc_id}: {len(rows)} tx via {extractor}",
            )
            return "published"
        return "needs_review_with_rows"
    logger.error("Submission failed for %s: %s", doc_id, res.get("error"))
    record_failure(state, doc_id, f"submit_failed:{res.get('error')}", extractor)
    return "failed"


def main():
    if VISION_ENGINE in ("openrouter", "auto") and not OPENROUTER_API_KEY and VISION_ENGINE == "openrouter":
        logger.error("OPENROUTER_API_KEY required when VISION_ENGINE=openrouter")
        sys.exit(2)
    if VISION_ENGINE in ("local_cli", "auto"):
        gb = grok_bin()
        if not os.path.exists(gb) and not shutil.which(gb):
            logger.error("local grok CLI not found (set GROK_BIN). tried %s", gb)
            if VISION_ENGINE == "local_cli":
                sys.exit(2)
            logger.warning("continuing in auto with OpenRouter-only fallback")
    logger.info(
        "Starting vision worker [ID=%s, API=%s, engine=%s, grokBin=%s, orKey=%s, "
        "maxAttempts=%d, maxDocsPerPoll=%d, state=%s]",
        WORKER_ID, API_BASE_URL, active_engine_label(), grok_bin(), bool(OPENROUTER_API_KEY),
        MAX_ATTEMPTS, MAX_DOCS_PER_POLL, STATE_FILE,
    )
    # Grok CLI has no --no-history / ephemeral flag (checked 2026-08-10) —
    # headless -p sessions still appear in Grok Build history. Do not hack around it.
    logger.info(
        "note: grok CLI has no no-history/ephemeral flag; headless sessions may appear in Grok Build UI",
    )
    state = load_attempt_state()
    last_heartbeat = 0.0
    while True:
        now = time.time()
        if now - last_heartbeat >= HEARTBEAT_INTERVAL_SEC:
            # Heartbeat always fires — even when the pending queue is empty —
            # so the app can keep extraction_pending_local wait windows honest.
            send_heartbeat(state)
            last_heartbeat = now
        try:
            filings = get_pending_scanned_filings()
            if filings:
                if len(filings) > MAX_DOCS_PER_POLL:
                    logger.info(
                        "cap: poll backlog capped pending=%d processing=%d (MAX_DOCS_PER_POLL)",
                        len(filings), MAX_DOCS_PER_POLL,
                    )
                # Select the first MAX_DOCS_PER_POLL *processable* docs.
                # Exhausted / backoff docs can sit at the head of the pending
                # list (server sorts newest first); taking the raw head used
                # to starve the whole queue — the worker polled forever,
                # skipping the same two exhausted docs while 46 others waited
                # (observed 2026-08-20, 48-item backlog, zero progress).
                batch = []
                skipped = 0
                now = time.time()
                for f in filings:
                    if len(batch) >= MAX_DOCS_PER_POLL:
                        break
                    doc_id = f.get("doc_id")
                    entry = state.get("docs", {}).get(doc_id) if doc_id else None
                    if entry:
                        if entry.get("exhausted"):
                            skipped += 1
                            # Re-assert the server-side park when the API was
                            # down earlier, so the doc leaves the pending list.
                            if not entry.get("parked") and doc_id:
                                parked = park_local_vision(
                                    doc_id,
                                    int(entry.get("attempts") or MAX_ATTEMPTS),
                                    str(entry.get("last_error") or "exhausted"),
                                )
                                entry["parked"] = bool(parked)
                                save_attempt_state(state)
                            continue
                        next_eligible = float(entry.get("next_eligible_at") or 0)
                        if next_eligible > now:
                            skipped += 1
                            continue
                    batch.append(f)
                if skipped:
                    logger.info(
                        "cap: skipped %d not-yet-processable doc(s) (exhausted/backoff); processing %d",
                        skipped, len(batch),
                    )
                logger.info(
                    "Found %d pending scanned filings; processing %d",
                    len(filings), len(batch),
                )
                for f in batch:
                    process_filing(f, state)
            # else: quiet poll; heartbeat above still ran on schedule
        except Exception as e:
            logger.error("Worker poll loop exception: %s", str(e))
        time.sleep(POLL_INTERVAL_SEC)


if __name__ == "__main__":
    main()
