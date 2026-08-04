# macOS Vision Worker (`com.congress.trade.vision-worker`)

Local vision worker for paper-scanned PTR / OGE filings.

## Engines

| Engine | How | Spend |
| --- | --- | --- |
| **`local_cli` (PRIMARY)** | Local `grok -p` headless CLI, authenticated via the owner's **xAI OIDC subscription** (`~/.grok/auth.json`). Renders PDF pages with `pdftoppm` and has Grok read the PNGs via multimodal `read_file`. | Subscription pool (no OpenRouter) |
| **`openrouter` (fallback)** | OpenRouter `x-ai/grok-4.5` with native PDF attachment | `CT_OPENROUTER_API_KEY` |
| **`auto` (default)** | Try `local_cli` first, fall back to OpenRouter on hard failure | subscription first |

Kimi CLI was retired (hard provider billing 403). Do not reintroduce it.

## Features

- Heartbeats → `POST /api/admin/local-worker/heartbeat`
- Polls → `GET /api/admin/scanned-filings/pending`
- Submits → `POST /api/admin/ingest-local-vision` (`source=local_mac`)

## Env

| Var | Default | Notes |
| --- | --- | --- |
| `VISION_ENGINE` | `auto` | `local_cli` \| `openrouter` \| `auto` |
| `GROK_BIN` | `~/.grok/bin/grok` | Local Grok Build CLI |
| `GROK_CLI_TIMEOUT_SEC` | `900` | Per-doc local CLI budget |
| `GROK_CLI_MAX_TURNS` | `8` | Headless turns (page reads) |
| `OPENROUTER_API_KEY` | — | Required for openrouter / auto fallback |
| `OPENROUTER_MODEL` | `x-ai/grok-4.5` | |
| `CONGRESS_TRADE_API_URL` | `http://localhost:8787` | Use `https://congress.trade` in launchd |
| `ADMIN_TOKEN` | — | `CT_ADMIN_TOKEN` from `~/.secrets/` |
| `WORKER_ID` | `local_mac_1` | |
| `MAX_DOCS_PER_POLL` | `2` | |

## Installation (launchd)

```bash
mkdir -p ~/vision-worker
cp services/vision-worker/worker.py ~/vision-worker/
cp services/vision-worker/run-vision-worker.sh ~/vision-worker/
chmod +x ~/vision-worker/run-vision-worker.sh ~/vision-worker/worker.py
cp services/vision-worker/com.congress.trade.vision-worker.plist ~/Library/LaunchAgents/
launchctl bootout gui/$(id -u)/com.congress.trade.vision-worker 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.congress.trade.vision-worker.plist
```

Confirm the owner is logged into Grok CLI (subscription) once:

```bash
grok -p "Reply: OK" --max-turns 1
```

## Logs

- stdout: `~/Library/Logs/com.congress.trade.vision-worker.log`
- stderr: `~/Library/Logs/com.congress.trade.vision-worker.err.log`
