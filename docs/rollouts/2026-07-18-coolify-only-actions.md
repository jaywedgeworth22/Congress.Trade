# Coolify-only GitHub Actions

## Summary

The repository's intentionally exhausted GitHub-hosted Actions spending cap was
blocking required checks that still requested hosted runners. Every active
workflow now uses one of the two owned Coolify labels:

- `congress-ci` for CI, security, monitoring, reporting, package checks, effort
  sync, and diagnostics.
- `congress-deploy` for trusted production/preview deployment and production
  maintenance.

Hosted fallbacks and GitHub Actions dependency caching were removed. Marketplace
actions are pinned to full commit SHAs. A policy check prevents hosted runners,
mutable action refs, remote reusable workflows, and Actions cache usage from
returning unnoticed.

Codex Autofix was removed from active workflows. Its remote reusable workflow
hardcoded a hosted runner, and moving its write token, LLM key, and shell agent
onto the current persistent CI runner would cross an unsafe trust boundary. It
can return after a dedicated ephemeral, wiped, isolated runner is available.

## Files changed

- `.github/workflows/*.yml` — owned runner labels, ref/trust gates, pinned
  actions, and safe uptime-response handling.
- `.github/actionlint.yaml` — declares the two repository runner labels.
- `scripts/check-actions-runner-policy.mjs` — regression guard for the runner,
  cache, action-ref, and reusable-workflow policy.
- `docs/EFFORT-LOG.md` — coordination and closeout record.

## Verification

1. Run `actionlint` from the repository root.
2. Run `node scripts/check-actions-runner-policy.mjs`.
3. Open a same-repository PR and confirm CI and Security jobs report
   `runner_name: coolify-hetzner-congress-ci`, execute real steps, and have no
   GitHub-hosted billable time.
4. Dispatch production only from `main` and preview only from `staging`; confirm
   both use `coolify-hetzner-congress`.
5. Confirm the GitHub `production` and `preview` environments restrict their
   deployment branches to `main` and `staging`, respectively.

During live validation, pre-change workflows that still requested GitHub cache
restore repeatedly wedged in `setup-node` and saturated the shared Coolify host.
The host had no swap and rebooted after reaching approximately 7.4 of 7.6 GiB
used. Socratic.Trade briefly timed out, then recovered with HTTP 200, DB and
scheduler healthy, and Litestream back in `replicating` state; Congress.Trade's
Cloudflare Worker remained healthy. The runner service was contained while the
host recovered. This is why cache removal and the resource follow-ups below are
release requirements, not optional optimization.

After recovery, a persistent 4 GiB `/swapfile` was enabled with swappiness 10.
Concurrent production deployment and CI later used about 1.3 GiB of swap while
retaining roughly 2.5 GiB of available RAM, preventing another immediate
memory-exhaustion failure.

The reboot also exposed a persistent-workspace interaction: the Sentry reporter's
sparse checkout left only its script materialized, and later checkout runs did
not reliably restore `app/` or `clients/pwa/`. The reporter now uses a full
checkout, CI explicitly materializes tracked paths before use, and the policy
guard rejects future sparse-checkout directives.

Closeout receipts:

- Core routing PR #568 merged as `2149d69`; workspace-recovery PR #575 merged
  as `be1d4e1`.
- Latest #575 backend, PWA, gitleaks, and package-pin runs all passed on the
  Coolify CI runner. Their timing APIs, and production deploy run `29642001268`,
  returned an empty `billable` object: no GitHub-hosted runner minutes.
- Deploy run `29642001268` shipped Worker version
  `d48cb502-2f28-41d5-9447-0dbba96f91db`, applied the canonical
  `d1_budget` migration, passed readiness, and parsed all three served inline
  dashboard scripts. Live Congress health is HTTP 200 with
  `ok/db/schema=true`; Socratic health, scheduler, and Litestream replication
  are also green.
- Sentry CI reporting was re-enabled after its full-checkout fix landed. No
  workflow KEEPOUT remains.

## Follow-ups

- Convert `congress-ci` to a one-job ephemeral runner with a destroyed workspace
  and no Docker socket, Coolify API, production mounts/network, SSH keys, PATs,
  or Infisical credentials. Until then fork PRs and Dependabot install/test jobs
  remain excluded; Dependabot CI fails explicitly instead of reporting a false
  green skipped check. Private-fork workflow execution is disabled at the
  repository level.
- Recheck the existing runner CPU/memory limits under concurrent CI/deploy load,
  add PID limits, and keep explicit production memory reserve despite swap.
- Re-enable Codex Autofix only on a dedicated ephemeral runner label, and pin
  the shared reusable workflow to an immutable commit.
- Keep Actions cache/artifact storage disabled or separately budgeted; owned
  runner execution is unmetered, but GitHub-hosted storage is not.
