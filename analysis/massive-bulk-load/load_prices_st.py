#!/usr/bin/env python3
"""load_prices_st.py — bulk-load 5y daily price history into Congress.Trade's
price_eod/spx_eod from SOCRATIC.TRADE's market-read endpoints (which serve the
Massive flat-file history). No third-party API is called by this app — owner
directive 2026-08-03: CT data comes from Socratic.Trade, never Massive/FMP/etc.

  GET {ST_ORIGIN}/api/market/prices/{SYM}?from=YYYY-MM-DD&to=YYYY-MM-DD
      -> {"ticker": ..., "closes": [{"date","close","volume"}, ...] desc}
  GET {ST_ORIGIN}/api/market/spx?from=...&to=...  -> {"closes": [...]} (SPY-fed)

Auth: Bearer token from env ST_PEER_TOKEN (APP_B_INGEST_TOKEN).
Resumable: --state JSON tracks completed tickers; INSERT OR IGNORE makes
reruns idempotent. Safe alongside the live app (WAL, BEGIN IMMEDIATE).

R2 / Litestream note (2026-08-04): each SQLite commit becomes one or more
Litestream L0 LTX PutObject Class A ops. Default --commit-every 50 batches
tickers into a single write transaction so free-tier Class A stays sane.
Fetches still happen outside the write lock (buffer rows, then flush).
"""

import argparse, json, os, sqlite3, sys, time, urllib.parse, urllib.request, urllib.error

ST_ORIGIN = os.environ.get("ST_ORIGIN", "https://socratictrade.com").rstrip("/")
WINDOW_FROM = "2021-08-02"  # 5y window start; clamped implicitly by what ST serves


def http_get(path, token, timeout=60, retries=4):
    url = ST_ORIGIN + path
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                "authorization": "Bearer " + token,
                "user-agent": "congress-price-loader/1.0",
            })
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            last = "HTTP %d" % e.code
            if e.code in (401, 403):
                raise SystemExit("auth failed (%s) — check ST_PEER_TOKEN" % last)
            if e.code == 404:
                return None  # unknown ticker to ST
            time.sleep(2 * (attempt + 1))
        except Exception as e:
            last = str(e)[:80]
            time.sleep(2 * (attempt + 1))
    raise RuntimeError("fetch failed after retries: %s" % last)


def connect_db(path):
    db = sqlite3.connect("file:%s?mode=rw" % urllib.parse.quote(path), uri=True, timeout=60)
    db.execute("PRAGMA busy_timeout = 60000")
    db.isolation_level = "IMMEDIATE"  # busy_timeout does not cover BUSY_SNAPSHOT
    return db


def flush_price_batch(db, batch):
    """Write buffered (ticker, rows) pairs in one transaction. Returns rows inserted.

    Holds the write lock only for the duration of the multi-ticker INSERT, not
    across network fetches.
    """
    if not batch:
        return 0
    before = db.total_changes
    for attempt in range(4):
        try:
            for ticker, rows in batch:
                db.executemany(
                    "INSERT OR IGNORE INTO price_eod (ticker, date, close, volume) VALUES (?, ?, ?, ?)",
                    [(ticker, r["date"], r["close"], r.get("volume")) for r in rows],
                )
            db.commit()
            return db.total_changes - before
        except sqlite3.OperationalError as e:
            # BUSY/BUSY_SNAPSHOT from app writers + checkpoint stalls — wait it out
            try:
                db.rollback()
            except Exception:
                pass
            time.sleep(15 * (attempt + 1))
    tickers = ",".join(t for t, _ in batch[:5])
    raise RuntimeError("insert locked out for batch starting %s (will retry next run)" % tickers)


def insert_spx_rows(db, rows):
    before = db.total_changes
    for attempt in range(4):
        try:
            db.executemany("INSERT OR IGNORE INTO spx_eod (date, close) VALUES (?, ?)",
                           [(r["date"], r["close"]) for r in rows])
            db.commit()
            return db.total_changes - before
        except sqlite3.OperationalError:
            try:
                db.rollback()
            except Exception:
                pass
            time.sleep(15 * (attempt + 1))
    raise RuntimeError("spx insert locked out")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--db", required=True)
    p.add_argument("--state", default="st_load_state.json")
    p.add_argument("--rpm", type=int, default=60, help="max requests per minute")
    p.add_argument("--tickers", default=None, help="comma list; default = all securities_master tickers")
    p.add_argument(
        "--commit-every",
        type=int,
        default=50,
        help="flush N tickers per SQLite commit (default 50). Lower Litestream Class A ops; "
             "keep moderate so write locks don't starve the live app.",
    )
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()
    if args.commit_every < 1:
        raise SystemExit("--commit-every must be >= 1")

    token = os.environ.get("ST_PEER_TOKEN", "").strip()
    if not token:
        raise SystemExit("ST_PEER_TOKEN not set")
    db = connect_db(args.db)
    state = {}
    if os.path.exists(args.state):
        state = json.load(open(args.state))
    done = set(state.get("done", []))

    today = time.strftime("%Y-%m-%d", time.gmtime())
    span = "?from=%s&to=%s" % (WINDOW_FROM, today)

    # SPX first (single call)
    spx = http_get("/api/market/spx" + span, token)
    if spx and spx.get("closes"):
        n = 0 if args.dry_run else insert_spx_rows(db, spx["closes"])
        print("spx: %d bars, %d inserted" % (len(spx["closes"]), n), flush=True)

    if args.tickers:
        tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
    else:
        tickers = [r[0] for r in db.execute("SELECT ticker FROM securities_master ORDER BY ticker")]
    todo = [t for t in tickers if t not in done]
    print(
        "tickers: %d selected, %d already done, %d to process (commit-every=%d)"
        % (len(tickers), len(done), len(todo), args.commit_every),
        flush=True,
    )

    delay = 60.0 / max(args.rpm, 1)
    t0 = time.time()
    inserted_total = attempted = empty = errors = 0
    batch = []  # list of (ticker, rows)
    pending_done = []  # tickers to mark done after successful flush

    def flush():
        nonlocal inserted_total, batch, pending_done
        if not batch and not pending_done:
            return
        if args.dry_run:
            inserted_total += sum(len(rows) for _, rows in batch)
        else:
            try:
                inserted_total += flush_price_batch(db, batch)
            except Exception as e:
                # leave these tickers out of done; retry next run
                print(
                    "[%s] BATCH-INSERT-ERROR (%d tickers): %s"
                    % (time.strftime("%H:%M:%S"), len(batch), e),
                    flush=True,
                )
                batch = []
                pending_done = []
                raise
        for t in pending_done:
            done.add(t)
        batch = []
        pending_done = []

    for i, t in enumerate(todo):
        attempted += 1
        try:
            d = http_get("/api/market/prices/" + urllib.parse.quote(t) + span, token)
        except Exception as e:
            errors += 1
            print("[%s] %s: ERROR %s" % (time.strftime("%H:%M:%S"), t, e), flush=True)
            # flush what we have so progress is durable before continuing
            try:
                flush()
            except Exception:
                pass
            time.sleep(delay)
            continue
        rows = (d or {}).get("closes") or []
        if not rows:
            empty += 1
            pending_done.append(t)  # empty is a completed result
        else:
            batch.append((t, rows))
            pending_done.append(t)

        if len(pending_done) >= args.commit_every:
            try:
                flush()
            except Exception:
                errors += 1
                time.sleep(delay)
                continue
            state["done"] = sorted(done)
            json.dump(state, open(args.state, "w"))
            rate = attempted / max(time.time() - t0, 0.1) * 60
            print(
                "[%s] %d/%d (%.0f/min) inserted=%d empty=%d errors=%d"
                % (time.strftime("%H:%M:%S"), attempted, len(todo), rate, inserted_total, empty, errors),
                flush=True,
            )

        time.sleep(delay)

    try:
        flush()
    except Exception:
        errors += 1
    state["done"] = sorted(done)
    json.dump(state, open(args.state, "w"))
    print(
        "DONE: attempted=%d inserted=%d empty=%d errors=%d elapsed=%.0fs"
        % (attempted, inserted_total, empty, errors, time.time() - t0),
        flush=True,
    )


if __name__ == "__main__":
    main()
