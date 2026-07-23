# Provider gap review routing

## Summary

Codex/Grok's 2026-07-22 miss reports point to two failure classes:

1. **Official-source discovery gap** — House live search can degrade to the daily bulk index, and Senate search can be blocked/throttled. Existing mitigations widen Senate lookback and run daily deep sweeps, but third-party feeds can still surface a filing first.
2. **Extraction/persistence gap** — a filing can be known but produce no durable trades when raw bytes are unavailable, provider extraction returns empty, or agreement cannot safely publish. Recent `extract_empty_failure` hard-fail work correctly sends those to review instead of soft-parking.

This change turns the FMP/Quiver/UnusualWhales latency monitor into a safety net: after provider rows are fetched and matched against known Congress.Trade candidates, still-unmatched provider observations are grouped by official URL when available, otherwise by provider/chamber/filed-date/filer, then materialized as one synthetic `provider-missing-*` filing per probable filing and opened in `review_queue` with the provider payloads attached. That keeps autonomous discovery authoritative when possible, but sets aside unmatched provider-discovered filings for human review instead of letting them disappear from operations.

## Files changed

- `app/src/ingestion/fmpDisclosureLatency.ts` — groups and routes unmatched provider observations to `filings` + `review_queue` with reason `provider_discovered_missing_official`.
- `docs/rollouts/2026-07-22-provider-gap-review-routing.md` — durable diagnosis and rollout note.
- `docs/EFFORT-LOG.md` — work-state receipt.

## Verification

- Run `cd app && npm run typecheck`.
- Run focused ingestion tests for `fmpDisclosureLatency`.
- In production/preview diagnostics, verify provider rows that do not match official-source candidates create open review rows with reason `provider_discovered_missing_official`.

## Follow-ups

- Add provider-specific official-document recovery: for provider rows exposing House PTR PDF IDs or Senate PTR view IDs, enqueue the official source URL before falling back to synthetic review rows.
- Alert on `provider_discovered_missing_official` counts above zero per hour; any nonzero count means official-source discovery or extraction needs attention.
- Keep R2 entitlement/credentials healthy on Deno so official raw bytes can be reprocessed; otherwise known filings will still be parked in review.
