# macOS Vision Worker Service (`com.congress.trade.vision-worker`)

The local vision worker is a macOS launchd daemon that processes paper-scanned PTR filings using native macOS `Vision.framework` OCR and checkbox grid projection analysis.

## Features
- Periodically sends heartbeats to `POST /api/admin/local-worker/heartbeat`.
- Polls `GET /api/admin/scanned-filings/pending` for `scanned_pdf` filings.
- Extracts transaction tables locally at **$0 marginal cost** (no LLM API spend).
- Submits structured transactions to `POST /api/admin/ingest-local-vision` (`source = 'local_mac'`).

## Installation via launchd
To install and start the service on macOS:

```bash
# 1. Copy plist to user LaunchAgents
cp services/vision-worker/com.congress.trade.vision-worker.plist ~/Library/LaunchAgents/

# 2. Load and start launchd daemon
launchctl load ~/Library/LaunchAgents/com.congress.trade.vision-worker.plist

# 3. Check daemon status
launchctl list | grep vision-worker
```

## Logs
- Standard output: `~/Library/Logs/com.congress.trade.vision-worker.log`
- Error output: `~/Library/Logs/com.congress.trade.vision-worker.err.log`

## Server alternative (no Mac)

For Coolify/Linux ARM64 without a Mac host, use **`services/scan-cpu-worker/`**:
Tesseract (or Surya/docTR) + deterministic checkbox ink-ratio. Same admin API;
posts `source=server_cpu`. See that service's README and
`docs/rollouts/2026-08-03-server-cpu-scan-worker.md`.
