# Congress.Trade shared-package v1.7.1 consumer adoption

## Summary

Congress.Trade now exact-pins the immutable `congress-trading-shared` v1.7.1 release commit
`0bc26ab9311a396f3f6b5cba0fb54fa7558a42b4` in both Node consumers. The root and Worker
manifests, lockfiles, and `allowScripts` approvals all use the same commit object; no movable tag
or semver range remains in the active dependency metadata.

The release adds shared webhook-auth exports and carries the TypeScript 7 declaration-build
compatibility fix. Congress.Trade source integration is unchanged in this adoption unit.

## Files changed

- `package.json` and `package-lock.json`
- `app/package.json` and `app/package-lock.json`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-14-shared-v171-consumer.md`

## Verification

- Verified remote `v1.7.1` is a lightweight tag resolving directly to release commit
  `0bc26ab9311a396f3f6b5cba0fb54fa7558a42b4`. The shared repo's
  `immutable-release-tags` ruleset is active, and both consumers pin the commit rather than the
  tag, so tag representation cannot move this adoption.
- Regenerated each lockfile through a separate empty npm cache; both resolve installed version
  1.7.1 at the exact commit.
- Reinstalled both consumers through separate empty npm caches with lifecycle scripts enabled.
  Both installed packages contain `dist/index.js`, `dist/index.mjs`, `dist/index.d.ts`, and
  `dist/index.d.mts`; CommonJS and ESM import smokes each expose 105 exports.
- Artifact SHA-256 values are `53457467...` (CJS), `9657e951...` (ESM), and `05df1a56...`
  for both declaration variants, identical in the root, Worker, and parallel Socratic consumer.
- Exact manifest, `allowScripts`, lock-root, installed-version, and resolved-commit assertions
  pass for the root and Worker consumers. `npm ls` reports v1.7.1 at the exact commit in both.
- A parallel Socratic.Trade install produced a different npm git-package `integrity` value, but
  all four built artifact SHA-256 hashes and the package manifest are byte-identical across apps.
  npm skips integrity enforcement for this git dependency; the exact resolved commit remains the
  durable cross-consumer identity.
- `npm run typecheck` passes. The serialized `npm test -- --maxWorkers=1` gate passes all 127
  files / 1,259 tests in 94.87 seconds.
- Fresh Wrangler 4.110.0 dry-runs from fetched `origin/main` and this branch each produce a
  6,187,729-byte `index.js` with SHA-256
  `d3c0be609d9c6b799bad56e67ca0997a573849f6b6805e34c1b587d834ec2406`. The new shared exports
  are unused and tree-shaken, so the Worker runtime artifact is byte-identical.
- Parent-directed `npm run preview:deploy` reused the isolated preview D1/KV/R2/queues, refreshed
  fixtures, reran typecheck and all 127 files / 1,259 tests green, and deployed preview Worker
  version `ed4189b2-4115-4779-ae4f-7781f3398b7d` at
  `https://congress-trade-preview.jaywedgeworth22.workers.dev`.
- Independent preview checks return HTTP 200 for the UI and `/api/health`; readiness reports
  `ok=true`, `db=true`, `schema=true`, and `missing=[]`. An unauthenticated request to
  `/api/admin/benchmark/runs?chamber=house&limit=1` returns HTTP 401 with `unauthorized`, proving
  the benchmark admin surface remains fail-closed.

## Follow-ups

- Socratic.Trade `main` still resolves shared v1.6.0 commit `c4fcfb4...`; its consumer must adopt
  this same exact v1.7.1 commit before the cross-repo pin workflow can return green.
- Release-policy follow-up: decide whether future shared releases should require annotated or
  signed tags. The current active ruleset enforces tag immutability, but v1.7.1 itself is
  lightweight.
- Push, PR, merge, and production release are intentionally outside this isolated work unit.
- The requested isolated preview is complete. A production Worker deploy is not required for this
  metadata-only adoption because the exact runtime bundle is byte-identical to fetched
  `origin/main`.
