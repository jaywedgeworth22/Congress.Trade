# congress-scout

A tiny, dependency-free **detection-latency scout** for congressional PTR
disclosures. It answers one question with a hard number: **do we notice a new
filing before FMP, and by how many seconds?**

## Why it runs on your Mac (not Cloudflare)

Senate eFD (`efdsearch.senate.gov`) sits behind Imperva, which blocks
datacenter/cloud egress IPs — Cloudflare Workers **and** generic VPS. So the
anti-bot-sensitive polling has to originate from a **residential connection**
(your Mac, a Raspberry Pi). It makes **outbound requests only** — no inbound
ports, no port-forwarding, works behind your router's NAT.

Everything else (storage, API, delivery) stays on Cloudflare; this is just the
"eyes."

## What it does each cycle (default 45s)

- **Detects** new PTRs straight from the primary gov sources the instant they
  appear — House Clerk (intraday live search + PDF-URL frontier probe) and
  Senate eFD (the CSRF/agreement/DataTables flow) — stamping `our_detected_at`.
  Detection only (existence + link), no parsing.
- **Optionally polls FMP family** (`stable` + `rapidapi` alternate paths) and
  stamps `fmp_first_seen_at` the first time either path surfaces each filing.
  **Default = **ON** when keys present; set `FMP_PROBE_ENABLED=0` to disable.
- **Logs the lead** per filing: `lead = fmp_first_seen_at − our_detected_at`
  (positive = we were first). Filings present at startup are flagged `baseline`;
  only ones that first appear *while running* count as a `live` race.

## Run it

```bash
# One cycle to sanity-check (detection only; FMP OFF by default):
node scout/congress-scout.mjs --once

# Enable FMP race (stable + RapidAPI paths can race when both keys/paths set):
FMP_PROBE_ENABLED=1 FMP_API_KEY=xxxxx node scout/congress-scout.mjs

# Stable path only:
FMP_PROBE_ENABLED=1 FMP_PATHS=stable FMP_API_KEY=xxxxx node scout/congress-scout.mjs
```

Startup logs each FMP source with status `off` (grey intent), `running`, or
`stopped` (missing key). Leave it running for a few days. Watch `scout-leads.jsonl`
and the `SUMMARY` line: `live-races`, `we-were-first`, and `median-lead`.

### Keep it alive on a Mac (survives logout/reboot)

`~/Library/LaunchAgents/trade.congress.scout.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>trade.congress.scout</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string><string>node</string>
    <string>/ABSOLUTE/PATH/TO/scout/congress-scout.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>FMP_API_KEY</key><string>YOUR_KEY</string>
    <key>STATE_FILE</key><string>/ABSOLUTE/PATH/scout-state.json</string>
    <key>LEADS_FILE</key><string>/ABSOLUTE/PATH/scout-leads.jsonl</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/ABSOLUTE/PATH/scout.log</string>
  <key>StandardErrorPath</key><string>/ABSOLUTE/PATH/scout.err</string>
</dict></plist>
```

```bash
launchctl load ~/Library/LaunchAgents/trade.congress.scout.plist   # start + auto-restart + start on boot
launchctl unload ~/Library/LaunchAgents/trade.congress.scout.plist # stop
```

(To avoid tying up your main Mac, an old Mac in clamshell — plugged in, Energy
Saver → "Prevent sleep" — or a Raspberry Pi works identically.)

## Config (env)

| var | default | meaning |
|---|---|---|
| `FMP_PROBE_ENABLED` | on | default ON for CT; set `0`/`false`/`off` to disable FMP family |
| `FMP_PATHS` | `stable,rapidapi` | which FMP paths race when probe is on |
| `FMP_API_KEY` / `FMP_LATENCY_API_KEY` | — | FMP key for stable (query) path |
| `FMP_RAPIDAPI_KEY` | falls back to FMP key | key for RapidAPI path |
| `FMP_STABLE_BASE_URL` | `https://financialmodelingprep.com/stable` | override stable base |
| `FMP_RAPIDAPI_BASE_URL` | RapidAPI FMP stable base | override RapidAPI base |
| `FMP_RAPIDAPI_HOST` | `financial-modeling-prep.p.rapidapi.com` | RapidAPI host header |
| `POLL_INTERVAL_SEC` | `45` | cycle interval |
| `SOURCES` | `house,senate` | subset to poll |
| `HOUSE_FRONTIER` | `1` | probe the PDF-URL frontier (earliest House detection) |
| `HOUSE_PROBE_WINDOW` | `25` | docIds probed ahead of the known max |
| `STATE_FILE` / `LEADS_FILE` | `./scout-state.json` / `./scout-leads.jsonl` | persistence |
| `CT_INGEST_URL` / `CT_INGEST_TOKEN` | — | optional: POST each detection to the app |
| `CT_INGEST_LATENCY_ONLY` | unset | set `1` to stamp latency only (no filings insert/enqueue) |

## Feeding the app (official residential ingest)

Point the scout at production:

```bash
export CT_INGEST_URL=https://congress.trade/api/ingest/detection
export CT_INGEST_TOKEN="..."   # Worker INGEST_TOKEN (Infisical / secret handoff; never commit)
# FMP race is opt-in (default OFF):
# export FMP_PROBE_ENABLED=1
# export FMP_API_KEY="..."
node scout/congress-scout.mjs --once
```

Each non-baseline detection POSTs `{source, docKey, link, detectedAt, filerName?,
filedDate?, ingest:true}` with `Authorization: Bearer $CT_INGEST_TOKEN`. The
Worker (INGEST_TOKEN-gated) then:

1. `INSERT OR IGNORE` into `filings` + durable `ingestion_outbox` (same path as
   the live watcher / `senate-backfill`)
2. Enqueues `filing.new` for genuinely-new rows
3. Records a disclosure-latency candidate for the FMP race board

This is **not** a GitHub Actions runner. Senate eFD is Imperva-gated from
Coolify/datacenter IPs; the scout must stay on residential egress. Secrets stay
in env / LaunchAgent plist / `chmod 600` files — never in the repo.

Set `CT_INGEST_LATENCY_ONLY=1` for pure measurement (no insert/enqueue).

## Note found while building this (RESOLVED)

eFD's DataTables response inserted an "office" column, shifting the `/ptr/…`
anchor from index 2 to 3. The scout finds the anchor by content (robust to that);
**the app's `src/ingestion/senateSource.ts parseSenateRows` was fixed to locate
fields by content instead of hardcoded indexes**, resolving the Senate-zero problem.
