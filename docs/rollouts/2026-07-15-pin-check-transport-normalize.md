# 2026-07-15 - Shared package pin check: normalize git transport before comparing (CLAUDE)

## Summary

The `Shared package pin check` workflow was red on `main` (Sentry FLEET-INFRA-16,
FLEET-INFRA-C, FLEET-INFRA-3C; failing runs through 2026-07-15T17:57Z) even though
both consumers install the IDENTICAL shared-package commit. Congress.Trade's
`app/package-lock.json` records the dependency as
`git+ssh://git@github.com/jaywedgeworth22/congress-trading-shared.git#0bc26ab9...`
while Socratic.Trade's `package-lock.json` records
`git+https://github.com/jaywedgeworth22/congress-trading-shared.git#0bc26ab9...` -
same commit, different git transport, and the check compared the raw strings.

The fix normalizes both sides to the ref after `#` (the pinned commit/tag) before
comparing. Lock entries without `#` (registry versions) pass through unchanged, so
the original comparison semantics are preserved for non-git deps. Real ref
divergence (different commits/tags) still fails loudly; the error message now shows
both the full resolved strings and the extracted refs.

Note: Socratic.Trade's copy of this check already normalizes (and resolves tags to
commits via the GitHub API), which is why ST's check was green while CT's was red
on the same pair of lockfiles. This change brings CT's comparison in line for the
transport case; tag-vs-SHA aliasing resolution (ST's step 4) is NOT replicated here
because both repos pin raw SHAs by convention (matched-pair bumps).

## Why

Cross-repo pin drift is a real hazard (the check exists for good reason), but a
standing false-positive red on `main` trains everyone to ignore the guard - it was
already being misattributed ("Socratic still on v1.6.0") on the effort board after
Socratic's v1.7.1 consumer (#1607) had in fact landed.

## Files

- `.github/workflows/shared-package-pin-check.yml` - added `strip_transport()` and
  compare `LOCAL_REF`/`PEER_REF` instead of raw `LOCAL_V`/`PEER_V`.
- `docs/EFFORT-LOG.md` + `/Users/jay/apps/CONGRESS-TRADE-EFFORT-LOG.md` - lane row.
- `docs/rollouts/2026-07-15-pin-check-transport-normalize.md` - this note.

## Verification

- `grep -nP '[^\x00-\x7F]' .github/workflows/shared-package-pin-check.yml` - clean (ASCII-only rule).
- Shell-level test of `strip_transport()` against the exact live values:
  ssh-vs-https same SHA -> MATCH (false positive cleared); differing SHAs -> still
  DIVERGED (guard intact); bare `1.7.1` registry version -> passes through unchanged.
- Post-merge: the `push: branches: [main]` trigger re-runs the check; expect green.

## Follow-ups

- Optional: replicate ST's tag-to-commit resolution (its step 4) if either repo
  ever pins tags instead of SHAs.
- Optional hygiene: align the two repos' lockfile transports (both https) by
  re-installing from the same URL form; not required once the check normalizes.
