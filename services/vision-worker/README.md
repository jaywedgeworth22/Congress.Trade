# macOS Vision Worker (`com.congress.trade.vision-worker`)

Local vision worker for paper-scanned PTR / OGE filings. Polls the production
admin API, runs **Grok vision via OpenRouter** (`x-ai/grok-4.5` by default),
and posts structured rows to `POST /api/admin/ingest-local-vision`.

## Why Grok (not Kimi)

The earlier `kimi -p` engine hit a hard provider billing 403 (usage limit for
the billing cycle) and will not recover for this seat. The worker now uses the
same Grok vision path the server bake-off already trusts (`openrouter:x-ai/grok-4.5`).

## Features

- Heartbeats → `POST /api/admin/local-worker/heartbeat` (`engine=openrouter-grok-vision`)
- Polls → `GET /api/admin/scanned-filings/pending` (pending local + extract_empty review scans)
- Transcribes PDFs with Grok vision (native PDF file attachment)
- Submits → `POST /api/admin/ingest-local-vision` (`source=local_mac`, `extractor=local_grok_vision_v1`)

## Env

| Var | Default | Notes |
| --- | --- | --- |
| `CONGRESS_TRADE_API_URL` | `http://localhost:8787` | Use `https://congress.trade` in launchd |
| `ADMIN_TOKEN` | — | `CT_ADMIN_TOKEN` from `~/.secrets/` |
| `OPENROUTER_API_KEY` | — | Required. From `CT_OPENROUTER_API_KEY` |
| `OPENROUTER_MODEL` | `x-ai/grok-4.5` | OpenRouter Grok vision slug |
| `WORKER_ID` | `local_mac_1` | Heartbeat id |
| `POLL_INTERVAL_SEC` | `30` | |
| `MAX_DOCS_PER_POLL` | `3` | Pace OpenRouter spend |
| `GROK_TIMEOUT_SEC` | `600` | Per-doc hard cap |

## Installation (launchd)

```bash
# Install tree
mkdir -p ~/vision-worker
cp services/vision-worker/worker.py ~/vision-worker/
cp services/vision-worker/run-vision-worker.sh ~/vision-worker/
chmod +x ~/vision-worker/run-vision-worker.sh ~/vision-worker/worker.py

# LaunchAgent
cp services/vision-worker/com.congress.trade.vision-worker.plist ~/Library/LaunchAgents/
launchctl unload ~/Library/LaunchAgents/com.congress.trade.vision-worker.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.congress.trade.vision-worker.plist
launchctl list | grep vision-worker
```

`run-vision-worker.sh` loads `CT_ADMIN_TOKEN` + `CT_OPENROUTER_API_KEY` from
`~/.secrets/global-api-keys` (or `.env` sibling) without printing them.

## Logs

- stdout: `~/Library/Logs/com.congress.trade.vision-worker.log`
- stderr: `~/Library/Logs/com.congress.trade.vision-worker.err.log`

## Server alternative (no Mac)

`services/scan-cpu-worker/` — Tesseract/Surya on Coolify. Use for free OCR only;
empty extract_empty executive scans need this Grok worker (or server
`configuredVision` reprocess), not more Tesseract.
