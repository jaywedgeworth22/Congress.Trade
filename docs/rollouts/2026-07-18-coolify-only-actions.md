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

## Follow-ups

- Convert `congress-ci` to a one-job ephemeral runner with a destroyed workspace
  and no Docker socket, Coolify API, production mounts/network, SSH keys, PATs,
  or Infisical credentials. Until then fork PRs and Dependabot install/test jobs
  remain excluded; Dependabot CI fails explicitly instead of reporting a false
  green skipped check. Private-fork workflow execution is disabled at the
  repository level.
- Give the runner containers explicit CPU, memory, and PID limits and reserve
  host memory/swap so a CI/deploy overlap cannot OOM production.
- Re-enable Codex Autofix only on a dedicated ephemeral runner label, and pin
  the shared reusable workflow to an immutable commit.
- Keep Actions cache/artifact storage disabled or separately budgeted; owned
  runner execution is unmetered, but GitHub-hosted storage is not.
