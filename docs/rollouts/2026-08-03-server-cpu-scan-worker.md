# 2026-08-03 — Server CPU scan worker (no Mac, no LLM)

## Summary

Add a **Linux/ARM64 Coolify** worker that extracts scanned House PTRs using:

1. **CPU OCR** — Tesseract default; optional Surya / docTR backends  
2. **Deterministic checkboxes** — grid projection + ROI crop + binarize + **ink pixel ratio** (default 10%)  
3. Same admin chassis as the Mac vision worker (`heartbeat` / `pending` / `ingest-local-vision`)

Persisted rows use `source = 'server_cpu'` (new `TxSource` value) so they are
distinct from Mac `local_mac` and hand `manual` swarm inserts.

## Why

- Mac vision-worker is great but host-bound; prod must not depend on a laptop.  
- LLM/OpenRouter is off for this backlog (cost + checkbox unreliability).  
- Pixel ink-ratio is **repeatable** on paper checkbox grids; general VLMs confuse borders for marks.

## Files

- `services/scan-cpu-worker/` — worker, pipeline, checkbox CV, OCR backends, Dockerfile  
- `app/src/shared/types.ts` — `TxSource` += `server_cpu`  
- `app/src/extraction/normalizer.ts` — include `server_cpu` in live-source filters  
- `app/src/admin/routes.ts` — ingest maps `source`/`extractor` → `server_cpu`  
- `app/src/ingestion/__tests__/localVisionWaitState.test.ts` — server_cpu case  

## Verification

```bash
# Python unit tests (checkbox ink ratio)
cd services/scan-cpu-worker && python -m pytest tests/ -q

# App
cd app && npm run typecheck && npm test -- src/ingestion/__tests__/localVisionWaitState.test.ts
```

Deploy worker on Coolify with `ADMIN_TOKEN`, `CONGRESS_TRADE_API_URL`, heartbeat
as `server_cpu_1`. Classifier already treats any fresh `local_worker_heartbeat`
row as “local lane available”.

## Coolify deploy path

`app/docker-compose.yml` includes `scan-cpu-worker` built from
`services/scan-cpu-worker/`. Coolify `base_directory=/app` so build context is
`../services/scan-cpu-worker`. On merge to `main`, auto-deploy (or
`POST /api/v1/deploy?uuid=congress-trade`) rebuilds both `congress-app` and
`congress-scan-cpu-worker`.

Worker env (compose + Coolify `.env`):
- `CONGRESS_TRADE_API_URL=http://congress-app:5000` (internal network)
- `ADMIN_TOKEN` from existing app secrets
- `WORKER_ID=server_cpu_1`

Verify after deploy:
```bash
docker ps | grep congress-scan-cpu-worker
docker logs congress-scan-cpu-worker --tail 50
# heartbeat should succeed; pending feed may be empty if backlog already cleared
```

## Follow-ups

- Calibrate `TEMPLATE_X` / row lattice on a sample of live paper PDFs on ARM64.  
- Template library for digital FD table pages (non-checkbox).  
- Surya/docTR optional image layers when Tesseract confidence is low.  
