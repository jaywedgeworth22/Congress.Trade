# 2026-09-04 — Sentry Max Features (CT)

Board `af1ab6e9`.  Branch `grok/sentry-max-features`.  Worktree
`~/apps/congress-grok-sentry-max`.

## Changes

- Browser SDK loader (DSN-gated) with error Replay 100%, session Replay **10%**,
  Feedback on, mask-all.  CSP widens to Sentry CDN + ingest host only when DSN
  is set (no wildcards).  Kill switch: `SENTRY_BROWSER_ENABLED=false` and
  sample-rate env vars.
- `sentryLoggerWarn` also emits `metrics.count` for the same name.
- iOS profiling 0.1 + error-only Session Replay (session 0% stays; filings
  PII bar on Cocoa — this unit changes **web** only).

## Verification

- `cd app && npx vitest run src/shared/__tests__/sentryBrowser.test.ts src/security/__tests__/headers.test.ts src/deno/__tests__/sentryInit.test.ts`
