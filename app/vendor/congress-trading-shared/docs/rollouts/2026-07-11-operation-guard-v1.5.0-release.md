# Operation-guard v1.5.0 release

## Summary

- Release the portable operation-guard rejection contract merged by PR #144.
- Correct the changelog comparison links and verify the lightweight `v1.5.0` tag.
- Keep the owner-directed tokenless Git release path; there is no npm registry publish.

## Why

PR #144 correctly bumped the package to 1.5.0 and added its changelog section, but the link footer
still compared `Unreleased` against v1.4.0 and omitted a 1.5.0 comparison link. The release tag
should include accurate release metadata so consumers and future changelog entries resolve cleanly.

## Files

- `CHANGELOG.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-11-operation-guard-v1.5.0-release.md`

## Verification

- Clean tokenless HTTPS install from merged PR #144 commit `2222baeb` with
  `NODE_AUTH_TOKEN`, `NPM_TOKEN`, and `GH_PACKAGES_TOKEN` unset: package reports version 1.5.0.
- CJS and ESM imports of `buildRateLimitedRejection`, `buildOperationInFlightRejection`, and
  `getOperationGuardHttpStatus` returned the expected 429/409 contract behavior.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm test`: passed, 10 files / 351 tests.
- `npm audit`: passed, 0 vulnerabilities.
- `npm run pack:dry`: passed; package 1.5.0, 6 files, 42.1 kB tarball.
- Shared main CI at release-hygiene merge `7a8dca7c`: passed verify and smoke-install.
- Remote lightweight tag `v1.5.0`: resolves to contract merge `2222baeb`.
- Clean tokenless install from `v1.5.0` with a fresh isolated npm cache and all registry tokens
  unset: passed; installed package reports 1.5.0 and CJS+ESM builder/status smoke is green.
- First tag-install attempt failed in the shared global npm cache with an `EEXIST` rename race;
  the isolated-cache retry passed without clearing or mutating another agent's cache.

## Follow-ups

- Update Socratic.Trade PR #1409 to consume the tagged shared builders/status mapping.

## Coordination note

The lightweight tag appeared at `2222baeb` concurrently while CODEX was gating release-hygiene PR
#146. It already points at the correct 1.5.0 contract payload, so it was preserved rather than
force-moved. PR #146 remains the main-branch metadata correction; no GitHub Release or npm registry
publish is part of this repository's release model.
