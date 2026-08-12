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
- **Optionally polls FMP family** (default **stable** path with dual free-tier
  key rotation; RapidAPI opt-in only — marketplace product lacks congress
  endpoints as of 2026-08) and stamps `fmp_first_seen_at`.
  **Default = ON** when keys present; set `FMP_PROBE_ENABLED=0` to disable.
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
| `FMP_PATHS` | `stable` | which FMP paths race (`stable` default; add `rapidapi` only if product gains congress endpoints) |
| `FMP_LATENCY_API_KEY` + `FMP_LATENCY_API_KEY_2` / `FMP_API_KEY` | — | dual free-tier keys for **stable** path (rotate; ~2× capacity; no known per-IP limit) |
| `FMP_RAPIDAPI_KEY` / `RAPIDAPI_KEY` | — | RapidAPI marketplace key if path opt-in (ST shared `RAPIDAPI_KEY` ok; **not** free-tier FMP keys) |
| `FMP_STABLE_BASE_URL` | `https://financialmodelingprep.com/stable` | override stable base |
| `FMP_RAPIDAPI_BASE_URL` | RapidAPI FMP stable base | override RapidAPI base |
| `FMP_RAPIDAPI_HOST` | `financial-modeling-prep.p.rapidapi.com` | RapidAPI host header |
| `POLL_INTERVAL_SEC` | `45` | cycle interval |
| `SOURCES` | `house,senate` | subset to poll |
| `HOUSE_FRONTIER` | `1` | probe the PDF-URL frontier (earliest House detection) |
| `HOUSE_PROBE_WINDOW` | `25` | docIds probed ahead of the known max |
| `STATE_FILE` / `LEADS_FILE` | `./scout-state.json` / `./scout-leads.jsonl` | persistence |
| `CT_INGEST_URL` / `CT_INGEST_TOKEN` | — | optional: POST each detection to the app |
| `CT_BASE_URL` | derived from `CT_INGEST_URL` | base for scout-plan / latency-payload / raw |
| `CT_INGEST_LATENCY_ONLY` | unset | set `1` to stamp latency only (no filings insert/enqueue) |
| `SCOUT_LATENCY_ALWAYS` | off | set `1` to always post FMP/QQ/UW payloads (ignore server needScout) |
| `SCOUT_RAW_UPLOAD` | on | download filing PDF/HTML and POST to R2 when residential access works |
| `SCOUT_RAW_MAX_BYTES` | 20MB | max raw upload size |

## Server-first latency + residential fallback

1. **Server** (`runDisclosureLatencyProbe` on cron) is primary for FMP / UW / Quiver.
2. Outcomes live in CONFIG_KV. **`needScout` opens only after 3 successive *server* hard
   errors** (or missing keys). Budget/spacing skips and wall-clock silence do **not** hand off.
3. **Mac scout** calls `GET /api/ingest/scout-plan` each cycle. For each `needScout` provider it
   polls from residential egress and `POST /api/ingest/latency-payload`. Scout success fills
   observations; **server success** clears `needScout` and reclaims the lane.
4. **FMP keys:** when covering FMP handoff, scout prefers the **secondary** free-tier key
   (`FMP_LATENCY_API_KEY_2` / distinct `FMP_API_KEY`) so the server primary is not double-spent.
5. **Raw files (R2, not Backblaze):** when the scout detects a filing (or the plan lists a filing
   missing `raw_object_key` / stuck on 403-class fetch), it downloads the PDF/HTML and
   `POST /api/ingest/raw` so Coolify never has to hit Imperva-blocked Senate/House from a
   datacenter IP.

## Senate relay tunnel — the hostname is permanent

Senate document fetches from the Worker are routed to the residential relay on
this Mac.  The server finds it at one address, forever:

```
SENATE_RELAY_URL=https://scout.congress.trade
```

**This value never changes and must never need a manual update.**  If the Senate
path breaks, do not go looking for a new URL to paste somewhere — that was the
old failure mode, and it is gone.  Debug the tunnel or the relay instead.

| | |
|---|---|
| pm2 entry | `senate-tunnel` (`scout/run-senate-tunnel.sh`) |
| tunnel | named tunnel `ct-mac-scout`, id `60b9bdbd-df7d-42f9-99b2-91110548df70` |
| hostname | `scout.congress.trade` -> `http://127.0.0.1:8899` |
| ingress | configured **in Cloudflare** (`config_src=cloudflare`), pushed to cloudflared at connect |
| credentials | `~/.cloudflared/<tunnel-id>.json`, mode 600, not in the repo |

Ingress deliberately lives only in Cloudflare — there is no local `config.yml`,
because a second copy of the routing rules is a second thing to drift.  On
startup cloudflared warns "No ingress rules were defined"; that describes the
local config that intentionally does not exist, and the edge supersedes it a
beat later with `Updated to new configuration ... scout.congress.trade`.

The runner is invoked by **UUID with `--cred-file`**, not by tunnel name.
Resolving a tunnel *name* requires an origin certificate, and there is no
`cert.pem` on this box, so `cloudflared tunnel run ct-mac-scout` fails with
"Cannot determine default origin certificate path".

Beyond running cloudflared, the wrapper probes the relay through the public
hostname and compares the status with a direct local probe; when they disagree
(or the public probe answers nothing) three times running it exits non-zero so
pm2 restarts it.  That covers a real observed failure: a cloudflared whose DNS
resolver had died stayed "online" in pm2 indefinitely while serving nothing.
Restarts are cheap now — a named tunnel reconnects to the *same* hostname.

### Why this replaced the quick tunnel

Until 2026-08-12 the tunnel was `cloudflared tunnel --url http://127.0.0.1:8899`
— a TryCloudflare **quick** tunnel, which mints a brand-new random
`*.trycloudflare.com` hostname on every start and kills the previous one.  The
server dialled the static `SENATE_RELAY_URL`, so every restart silently
repointed the tunnel while the server kept calling a dead host.  It rotated four
hostnames across three restarts on 2026-08-11 with nothing announcing it.  The
documented remedy was "update `SENATE_RELAY_URL` when it changes" — a manual
step in a machine's restart path, which is a defect rather than a procedure, and
it is exactly what failed.  The named tunnel removes the rotation, so the
hostname-recording and rotation-alerting machinery built around it is gone too.

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
