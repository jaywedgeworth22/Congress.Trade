# 2026-07-30 — Restore self-hosted CI (PR merges unblocked); Deno Deploy retired

Supersedes `2026-07-29-github-hosted-ci-oracle-runners-off.md`.

## Summary

**Root cause of the PR-merge stall:** GitHub-hosted `ubuntu-latest` provisioned
zero jobs for this repo for 24h+ (2026-07-29 ~11:00Z through 2026-07-30 ~04:00Z).
Every workflow — CI, Security, deploys, crons — failed in ~3 seconds with no
runner ever assigned (job `labels`/`runner_name` null, zero steps). Because
branch protection requires `typecheck + test` and `gitleaks`, no PR could go
green; merges in that window relied on manually-posted synthetic green commit
statuses. This matches the signature of GitHub-hosted Actions being unavailable
to the account (billing/spending limit could not be verified — the billing API
needs the `user` OAuth scope); it is not repo code.

Meanwhile the Coolify self-hosted runner `oracle-congress-ci`
(`[self-hosted, Linux, congress-ci, ARM64, oracle-ci]`) was registered, ONLINE
and busy, and AGENTS.md has always mandated Coolify self-hosted runners for all
workflows. The 2026-07-29 "GitHub-hosted only" change (#1150) moved the
required checks onto the dead fleet.

Owner directives (2026-07-29 23:05): "figure out why PR aren't merging on
github and resolve please" and "we aren't using deno-deploy anymore only
oracle".

## Files changed

- All 11 remaining workflows: `runs-on: ubuntu-latest` →
  `runs-on: [self-hosted, oracle-ci]` (ci, security, admin-maintenance,
  auto-update-prs, debug, deploy-oracle, effort-issues-sync,
  runner-workerd-diagnostics, sentry-ci-report, shared-package-pin-check,
  uptime-monitor).
- Deleted `.github/workflows/deploy-deno.yml` and
  `.github/workflows/deploy-staging.yml` — Deno Deploy is retired; production
  deploys are Coolify auto-deploy on push to `main` (see
  `deploy-oracle.yml`, now named "Deploy Coolify (Congress.Trade)").
- `scripts/check-actions-runner-policy.mjs` — allowed runner set is now the
  owned self-hosted labels (`[self-hosted, oracle-ci]` / `[self-hosted,
  congress-ci]`); `ubuntu-latest` is no longer permitted.
- `sentry-ci-report.yml` — dropped stale "Deploy Deno" / "Deploy Preview"
  entries; updated "Deploy Oracle Monolith" → "Deploy Coolify
  (Congress.Trade)".

## Verification

- `node scripts/check-actions-runner-policy.mjs` → "Actions policy OK: 11
  workflows use owned runners only."
- CI for this PR runs on `oracle-congress-ci` and must go green (it is itself
  the proof that required checks work again).

## Follow-ups

- `app/package.json` `deploy` / `deploy:full` and `app/scripts/ship.sh` still
  target Deno Deploy; the canonical prod path is now Coolify auto-deploy +
  `POST /api/admin/migrate` against the live app. Docs/scripts sweep should
  follow (AGENTS.md "Migrations & deploy" section is stale).
- Migrations 0065/0066 (STOCK Act status, filer bioguide resolution) are in
  main's idempotent migrate list and apply on the next prod migrate call.
- If GitHub-hosted runner availability is restored (billing), do NOT move
  required checks back without an owner decision — AGENTS.md policy is
  self-hosted only.
