#!/usr/bin/env python3
"""
load_prices.py — 5-year Massive (Polygon-style) price-history bulk loader.

Backfills daily aggregate bars for every ticker in `securities_master` into
`price_eod` (INSERT OR IGNORE — existing rows always win), plus the SPX
benchmark series into `spx_eod` (fetched as SPY, matching the app's own
Massive client convention in app/src/prices/massive.ts: index symbols need a
separate Indices entitlement the Stocks plan lacks).

Python 3 stdlib only (urllib/sqlite3/json/argparse) — the destination host
may have no pip.

API conventions mirrored from app/src/prices/massive.ts + retry429.ts:
  GET https://api.massive.com/v2/aggs/ticker/{SYM}/range/1/day/{FROM}/{TO}
      ?adjusted=true&sort=desc&limit=50000&apiKey={KEY}
  - `t` is ms epoch (start of trading day) -> UTC YYYY-MM-DD
  - 404            -> genuinely no data for the symbol (negative-cache, skip)
  - 429            -> retry up to 3x, waits ~5s/15s/30s jittered +/-20%,
                      Retry-After honored, capped at 60s
  - 401/403        -> fatal: every call fails identically, abort the run
  - 5xx / network  -> retry with the same backoff budget, then record an
                      error for the ticker and move on (never marked done)

Resumable: per-ticker outcomes are recorded in a JSON state file; completed
tickers (status ok / empty / not_found) are skipped on rerun. INSERT OR IGNORE
makes reruns idempotent even if state is lost.

Usage:
  export MASSIVE_API_KEY=...            # or pass --api-key-env OTHER_VAR
  python3 load_prices.py --db /data/congress-trade/db.sqlite
  python3 load_prices.py --db copy.db --tickers AAPL,MSFT,ROYL --dry-run
"""

import argparse
import json
import os
import random
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

BASE_URL = "https://api.massive.com/v2/aggs/ticker/"
USER_AGENT = "congress.trade/0.1 (+https://congress.trade)"
SPX_SYMBOL = "SPY"  # app convention: S&P benchmark via the SPY equity
LIMIT = 50000       # one page covers 5y of daily bars (~1,260) with huge margin

# Mirrors app/src/prices/retry429.ts (waits 5s/15s/30s, jittered, cap 60s).
# --retries > 3 extends the tail with 60s waits for the overnight bulk job.
RETRY_WAITS_S = [5.0, 15.0, 30.0]
MAX_WAIT_S = 60.0

STATE_VERSION = 1


def log(msg):
    print("[%s] %s" % (datetime.now(timezone.utc).strftime("%H:%M:%S"), msg), flush=True)


def iso_days_ago(days, now=None):
    return ((now or datetime.now(timezone.utc)) - timedelta(days=days)).date().isoformat()


class MassiveError(Exception):
    """Non-retryable-after-budget failure (auth, persistent 5xx/network)."""
    def __init__(self, msg, fatal=False):
        super().__init__(msg)
        self.fatal = fatal


class HttpResult:
    __slots__ = ("status", "body", "retry_after_s")

    def __init__(self, status, body, retry_after_s=None):
        self.status = status
        self.body = body
        self.retry_after_s = retry_after_s


def http_get(url, timeout=60):
    req = urllib.request.Request(url, headers={
        "user-agent": USER_AGENT,
        "accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return HttpResult(res.status, res.read())
    except urllib.error.HTTPError as e:
        # HTTPError carries the status + a Retry-After header when present.
        raw = e.headers.get("Retry-After") if e.headers else None
        try:
            retry_after_s = float(raw) if raw else None
        except (TypeError, ValueError):
            retry_after_s = None
        try:
            body = e.read()
        except Exception:
            body = b""
        return HttpResult(e.code, body, retry_after_s)
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
        raise MassiveError("network: %s" % e)


def wait_seconds(result, attempt, waits):
    ra = result.retry_after_s
    if ra and ra > 0:
        return min(ra, MAX_WAIT_S)
    base = waits[min(attempt, len(waits) - 1)]
    return min(round(base * (0.8 + 0.4 * random.random()), 2), MAX_WAIT_S)


class Pacer:
    """Minimum spacing between request attempts (polite rate limiting)."""

    def __init__(self, rpm):
        self.min_interval = 60.0 / rpm if rpm and rpm > 0 else 0.0
        self.next_at = 0.0

    def wait(self):
        if self.min_interval <= 0:
            return
        now = time.monotonic()
        if now < self.next_at:
            time.sleep(self.next_at - now)
        self.next_at = max(time.monotonic(), self.next_at) + self.min_interval


class MassiveClient:
    def __init__(self, api_key, rpm, retries=3):
        self.api_key = api_key
        self.pacer = Pacer(rpm)
        # waits per retry: app-default 5/15/30s, extended tail pinned at 60s
        self.waits = RETRY_WAITS_S + [MAX_WAIT_S] * max(0, retries - len(RETRY_WAITS_S))
        self.waits = self.waits[: max(0, retries)]

    def aggs(self, symbol, frm, to):
        """-> list of (date, close, volume) ascending. Raises MassiveError."""
        url = (
            BASE_URL + urllib.parse.quote(symbol, safe="")
            + "/range/1/day/" + frm + "/" + to
            + "?adjusted=true&sort=desc&limit=%d&apiKey=" % LIMIT
            + urllib.parse.quote(self.api_key, safe="")
        )
        result = None
        for attempt in range(len(self.waits) + 1):
            self.pacer.wait()
            try:
                result = http_get(url)
            except MassiveError as e:
                # network-layer failure — retryable on the same budget as 429/5xx
                if attempt < len(self.waits):
                    wait = wait_seconds(HttpResult(0, b""), attempt, self.waits)
                    log("%s: %s — retry %d/%d in %.0fs" % (
                        symbol, e, attempt + 1, len(self.waits), wait))
                    time.sleep(wait)
                    continue
                raise
            if result.status == 429 or result.status >= 500:
                if attempt < len(self.waits):
                    wait = wait_seconds(result, attempt, self.waits)
                    log("%s: HTTP %d — retry %d/%d in %.0fs" % (
                        symbol, result.status, attempt + 1, len(self.waits), wait))
                    time.sleep(wait)
                    continue
                if result.status == 429:
                    raise MassiveError("MASSIVE_HTTP_429 (after retries)")
                raise MassiveError("MASSIVE_HTTP_%d (after retries)" % result.status)
            break

        if result.status == 404:
            return None  # genuinely no data — safe to negative-cache
        if result.status in (401, 403):
            raise MassiveError(
                "MASSIVE_HTTP_%d (auth/plan — every call fails identically; if the "
                "requested window predates the plan's history entitlement, narrow it)"
                % result.status, fatal=True)
        if result.status != 200:
            raise MassiveError("MASSIVE_HTTP_%d" % result.status)

        try:
            payload = json.loads(result.body)
        except json.JSONDecodeError as e:
            raise MassiveError("bad json: %s" % e)
        rows = []
        for r in payload.get("results") or []:
            t, c = r.get("t"), r.get("c")
            if not isinstance(t, (int, float)) or not isinstance(c, (int, float)):
                continue
            date = datetime.fromtimestamp(t / 1000, tz=timezone.utc).date().isoformat()
            v = r.get("v")
            vol = int(v) if isinstance(v, (int, float)) else None
            rows.append((date, float(c), vol))
        rows.sort()
        if payload.get("resultsCount", len(rows)) > len(rows):
            log("WARNING: %s resultsCount=%s > returned=%d (page truncated)" % (
                symbol, payload.get("resultsCount"), len(rows)))
        return rows


# ---------------------------------------------------------------- state file

def load_state(path):
    if not os.path.exists(path):
        return {"version": STATE_VERSION, "windows": {}}
    with open(path, "r") as f:
        state = json.load(f)
    if state.get("version") != STATE_VERSION:
        raise SystemExit("state file %s has unsupported version" % path)
    state.setdefault("windows", {})
    return state


def save_state(path, state):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, path)


def window_state(state, frm, to):
    key = "%s|%s" % (frm, to)
    win = state["windows"].get(key)
    if win is None:
        win = {"from": frm, "to": to, "started_at": datetime.now(timezone.utc).isoformat(),
               "spx": None, "tickers": {}}
        state["windows"][key] = win
    return win


# ------------------------------------------------------------------ db layer

def connect_db(path):
    if not os.path.exists(path):
        raise SystemExit("db not found: %s" % path)
    db = sqlite3.connect("file:%s?mode=rw" % urllib.parse.quote(path), uri=True,
                         timeout=60)
    db.execute("PRAGMA busy_timeout = 60000")
    # BEGIN IMMEDIATE for every write txn: busy_timeout does NOT cover
    # SQLITE_BUSY_SNAPSHOT (WAL snapshot conflict vs the live app's constant
    # small writes); acquiring the write lock up front waits instead of dying.
    db.isolation_level = "IMMEDIATE"
    # Schema contract check (fail before burning API quota on a wrong db).
    cols = [r[1] for r in db.execute("PRAGMA table_info(price_eod)")]
    if cols != ["ticker", "date", "close", "volume"]:
        raise SystemExit("unexpected price_eod schema: %s" % cols)
    cols = [r[1] for r in db.execute("PRAGMA table_info(spx_eod)")]
    if cols != ["date", "close"]:
        raise SystemExit("unexpected spx_eod schema: %s" % cols)
    return db


def flush_price_batch(db, batch):
    """Write buffered (ticker, rows) pairs in one SQLite transaction.

    Holds the write lock only for the multi-ticker INSERT, not across network
    fetches. Each commit becomes Litestream L0 PutObject Class A ops — batching
    (default 50) keeps free-tier R2 Class A under control during bulk loads.
    """
    if not batch:
        return 0
    before = db.total_changes
    for ticker, rows in batch:
        db.executemany(
            "INSERT OR IGNORE INTO price_eod (ticker, date, close, volume)"
            " VALUES (?, ?, ?, ?)",
            [(ticker, d, c, v) for (d, c, v) in rows],
        )
    db.commit()
    return db.total_changes - before


def inserted_price_rows(db, ticker, rows):
    """Single-ticker write (compat wrapper). Prefer flush_price_batch for bulk."""
    return flush_price_batch(db, [(ticker, rows)])


def insert_spx_rows(db, rows):
    before = db.total_changes
    db.executemany("INSERT OR IGNORE INTO spx_eod (date, close) VALUES (?, ?)",
                   [(d, c) for (d, c, _v) in rows])
    db.commit()
    return db.total_changes - before


# ---------------------------------------------------------------------- main

def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--db", required=True, help="path to the sqlite database (rw)")
    p.add_argument("--api-key-env", default="MASSIVE_API_KEY",
                   help="env var holding the Massive API key (default MASSIVE_API_KEY)")
    p.add_argument("--years", type=float, default=5.0,
                   help="history window in years (default 5; uses 365*years days)")
    p.add_argument("--from", dest="frm", help="override window start YYYY-MM-DD")
    p.add_argument("--to", dest="to", help="override window end YYYY-MM-DD (default today)")
    p.add_argument("--tickers", help="comma-separated ticker subset (default: all securities_master)")
    p.add_argument("--tickers-file", help="file with one ticker per line")
    p.add_argument("--limit", type=int, help="process at most N tickers this run")
    p.add_argument("--offset", type=int, default=0, help="skip first N tickers of the pending list")
    p.add_argument("--rpm", type=float, default=60,
                   help="max API requests per minute (default 60; shared key — be polite)")
    p.add_argument("--retries", type=int, default=3,
                   help="429/5xx/network retries per request (default 3 = app behavior;"
                        " waits 5s/15s/30s then 60s each, Retry-After honored, cap 60s)")
    p.add_argument("--state", default="massive_load_state.json",
                   help="progress state file (default ./massive_load_state.json)")
    p.add_argument("--skip-spx", action="store_true", help="do not load the SPX (SPY) series")
    p.add_argument("--spx-only", action="store_true", help="load only the SPX (SPY) series")
    p.add_argument("--max-consec-errors", type=int, default=25,
                   help="abort after N consecutive ticker errors (default 25)")
    p.add_argument("--dry-run", action="store_true",
                   help="fetch and report, but write nothing (db + state untouched)")
    p.add_argument("--verbose", action="store_true", help="log every ticker")
    p.add_argument(
        "--commit-every",
        type=int,
        default=50,
        help="flush N tickers per SQLite commit (default 50; lowers Litestream Class A ops)",
    )
    return p.parse_args(argv)


def select_tickers(db, args):
    if args.tickers:
        return [t.strip() for t in args.tickers.split(",") if t.strip()]
    if args.tickers_file:
        with open(args.tickers_file) as f:
            return [ln.strip() for ln in f if ln.strip() and not ln.startswith("#")]
    return [r[0] for r in db.execute("SELECT ticker FROM securities_master ORDER BY ticker")]


def main(argv=None):
    args = parse_args(argv or sys.argv[1:])
    api_key = os.environ.get(args.api_key_env, "").strip()
    if not api_key:
        raise SystemExit("missing API key: set $%s (or pass --api-key-env)" % args.api_key_env)

    req_frm = args.frm or iso_days_ago(int(365 * args.years))
    to = args.to or datetime.now(timezone.utc).date().isoformat()
    log("requested window %s -> %s  db=%s  state=%s%s" % (
        req_frm, to, args.db, args.state, "  DRY-RUN" if args.dry_run else ""))

    db = connect_db(args.db)
    client = MassiveClient(api_key, args.rpm, args.retries)
    t_run = time.monotonic()

    stats = {"spx_rows": 0, "attempted": 0, "ok": 0, "empty": 0, "not_found": 0,
             "error": 0, "rows_returned": 0, "rows_inserted": 0, "skipped_done": 0}

    # ---- SPY fetch: loads spx_eod AND doubles as the plan-entitlement probe.
    # The Stocks plan caps aggregates history (observed: 2 years — older
    # requests either truncate silently or 403). The first returned SPY bar is
    # the account-level history boundary, so the EFFECTIVE window start is
    # max(requested, first_spy_bar). State is keyed by the effective window:
    # reruns resume correctly today, and after a plan upgrade the probe moves
    # the boundary back, producing a new window key that re-fetches the older
    # history (INSERT OR IGNORE fills only the missing rows).
    try:
        spx_rows = client.aggs(SPX_SYMBOL, req_frm, to)
    except MassiveError as e:
        log("SPX(%s) probe FAILED: %s" % (SPX_SYMBOL, e))
        if e.fatal:
            raise SystemExit(2)
        spx_rows = None
        log("continuing without entitlement probe — using requested window as-is")

    frm = req_frm
    if spx_rows:
        first_bar = spx_rows[0][0]
        if first_bar > frm:
            log("NOTE: plan entitlement clamps window start %s -> %s "
                "(upgrade the Massive plan for deeper history, then rerun)" % (frm, first_bar))
            frm = first_bar

    state = load_state(args.state)
    win = window_state(state, frm, to)

    if spx_rows is None:
        log("SPX(%s): 404 not found — unexpected, check plan entitlement" % SPX_SYMBOL)
    elif spx_rows:
        if args.skip_spx:
            log("SPX(%s): probe ok (%d bars) — spx_eod write skipped (--skip-spx)"
                % (SPX_SYMBOL, len(spx_rows)))
        else:
            inserted = 0 if args.dry_run else insert_spx_rows(db, spx_rows)
            stats["spx_rows"] = len(spx_rows)
            log("SPX(%s): %d bars %s..%s, inserted %d%s" % (
                SPX_SYMBOL, len(spx_rows), spx_rows[0][0], spx_rows[-1][0], inserted,
                " (dry-run, not written)" if args.dry_run else ""))
            if not args.dry_run:
                win["spx"] = {"status": "ok", "rows": len(spx_rows), "inserted": inserted,
                              "at": datetime.now(timezone.utc).isoformat()}
                save_state(args.state, state)
    else:
        log("SPX(%s): empty result — unexpected, check plan entitlement" % SPX_SYMBOL)

    if args.spx_only:
        return report(db, stats, t_run)

    # ---- per-ticker loop
    tickers = select_tickers(db, args)
    done = win["tickers"]
    pending = [t for t in tickers if t not in done]
    stats["skipped_done"] = len(tickers) - len(pending)
    if args.offset:
        pending = pending[args.offset:]
    if args.limit:
        pending = pending[: args.limit]
    log("tickers: %d selected, %d already done, %d to process this run"
        % (len(tickers), stats["skipped_done"], len(pending)))

    if args.commit_every < 1:
        raise SystemExit("--commit-every must be >= 1")
    log("commit-every=%d (batched writes for Litestream Class A hygiene)" % args.commit_every)

    consec_errors = 0
    # Buffer rows + state entries; flush every --commit-every tickers so one
    # SQLite commit covers many tickers (fewer Litestream L0 PutObjects).
    batch = []  # list of (ticker, rows) with non-empty rows
    pending_entries = []  # list of (ticker, entry) to mark done after flush

    def flush_batch():
        if not batch and not pending_entries:
            return
        inserted = 0 if args.dry_run else flush_price_batch(db, batch)
        stats["rows_inserted"] += inserted
        # attribute inserted is aggregate; per-ticker insert count is approximate
        if not args.dry_run:
            now = datetime.now(timezone.utc).isoformat()
            for ticker, entry in pending_entries:
                entry["at"] = now
                done[ticker] = entry
            save_state(args.state, state)
        batch.clear()
        pending_entries.clear()

    for i, ticker in enumerate(pending, 1):
        try:
            rows = client.aggs(ticker, frm, to)
        except MassiveError as e:
            stats["error"] += 1
            consec_errors += 1
            log("%s: ERROR %s (%d consecutive)" % (ticker, e, consec_errors))
            # durable progress before bailing / continuing
            try:
                flush_batch()
            except Exception as fe:
                log("flush after error failed: %s" % fe)
            if e.fatal:
                log("fatal provider error (auth/plan) — aborting run; rerun later, progress is saved")
                raise SystemExit(2)
            if consec_errors >= args.max_consec_errors:
                log("too many consecutive errors — aborting run; progress is saved")
                raise SystemExit(3)
            continue
        consec_errors = 0
        stats["attempted"] += 1

        if rows is None:
            stats["not_found"] += 1
            entry = {"status": "not_found", "rows": 0}
            if args.verbose:
                log("%s: not found (404)" % ticker)
        elif not rows:
            stats["empty"] += 1
            entry = {"status": "empty", "rows": 0}
            if args.verbose:
                log("%s: empty result (delisted/foreign/non-equity?)" % ticker)
        else:
            stats["ok"] += 1
            stats["rows_returned"] += len(rows)
            entry = {"status": "ok", "rows": len(rows), "inserted": None,
                     "first": rows[0][0], "last": rows[-1][0]}
            batch.append((ticker, rows))
            if args.verbose or i % 50 == 0 or i == len(pending):
                log("%s: %d bars %s..%s (buffered) [%d/%d]%s" % (
                    ticker, len(rows), rows[0][0], rows[-1][0], i, len(pending),
                    " (dry-run)" if args.dry_run else ""))

        pending_entries.append((ticker, entry))
        if len(pending_entries) >= args.commit_every:
            flush_batch()
            if i % 50 == 0 or i == len(pending):
                log("flushed batch @ %d/%d (rows_inserted_total=%d)" % (
                    i, len(pending), stats["rows_inserted"]))

    flush_batch()
    return report(db, stats, t_run)


def report(db, stats, t_run):
    elapsed = time.monotonic() - t_run
    print("\n================ run report ================")
    print("elapsed: %.1fs" % elapsed)
    if stats["spx_rows"]:
        print("spx: %d bars fetched" % stats["spx_rows"])
    print("tickers: %d attempted (%d ok, %d empty, %d not_found, %d error), %d skipped (done)"
          % (stats["attempted"], stats["ok"], stats["empty"], stats["not_found"],
             stats["error"], stats["skipped_done"]))
    print("rows: %d returned, %d inserted" % (stats["rows_returned"], stats["rows_inserted"]))
    cov = db.execute(
        "SELECT COUNT(DISTINCT ticker), COUNT(*), MIN(date), MAX(date) FROM price_eod").fetchone()
    master = db.execute("SELECT COUNT(*) FROM securities_master").fetchone()[0]
    spx = db.execute("SELECT COUNT(*), MIN(date), MAX(date) FROM spx_eod").fetchone()
    print("price_eod coverage: %d/%d tickers, %d rows, %s .. %s"
          % (cov[0], master, cov[1], cov[2], cov[3]))
    print("spx_eod coverage:   %d rows, %s .. %s" % (spx[0], spx[1], spx[2]))
    print("============================================")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
