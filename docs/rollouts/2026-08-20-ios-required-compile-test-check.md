# 2026-08-20 — iOS compile + XCTest is a failing CI check

## Summary

Monet **IOSENGINEERING-14** (review finding #27): iOS CI was compile-only and
advisory.  `.github/workflows/ios-build.yml` ran `xcodebuild build` on
`generic/platform=iOS` and never ran the 71 `CongressTradeTests` cases.  Branch
protection on `main` required only `typecheck + test` and `gitleaks`, so three
red iOS builds merged on 2026-08-15/16 and `main` stayed uncompilable for about
38 hours.

This change makes job **`xcodebuild (unsigned)` fail** (not `continue-on-error`)
when either the unsigned compile or any XCTest case fails.  It also runs the
tests and refuses a green result that executed fewer than 71 cases.

## Files changed

- `.github/workflows/ios-build.yml` — keep unsigned device compile; call
  `scripts/ios-ci-xctest.sh`; upload `.xcresult`; scope `cancel-in-progress`
  to pull requests only.  `pull_request` has no `paths:` filter.  An ubuntu
  wrapper job named `xcodebuild (unsigned)` always reports, so it can be a
  required check without blocking backend-only PRs.  The Mac job runs only
  when `clients/ios/**`, this workflow, or the XCTest script changed.
- `scripts/ios-ci-xctest.sh` — `xcodebuild test -only-testing:CongressTradeTests`;
  fail if fewer than 71 cases run; skip ghost sims and create a fresh
  iPhone 17 Pro / 16 Pro when needed.
- `scripts/check-actions-runner-policy.mjs` — pin: no `continue-on-error`,
  must run `xcodebuild test` against `CongressTradeTests`, wrapper must
  always report.
- `docs/EFFORT-LOG.md` — claim/closeout for issue #2031.

A shared `.xcscheme` was not added.  The repo hook blocks hand-edits under
`.xcodeproj/`.  CI does not rely on a checked-in scheme: it passes
`-only-testing:CongressTradeTests` and fails closed if fewer than 71 cases
execute.

No app product code, PDF, billing, OGE, extract, or TestFlight ship.

## Verification

```
node scripts/check-actions-runner-policy.mjs
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ios-build.yml'))"
```

Verified on the Mac runner (workflow_dispatch run 32318653886, sha
`fac8f748`): unsigned device compile succeeded; a fresh iPhone 17 Pro
simulator was created after ghost UDID `27C2C925-…` failed boot; **71
XCTest cases ran**; 4 failures made `xcodebuild-mac` and the wrapper
`xcodebuild (unsigned)` red.  That is the success condition.

GROK babysit (2026-08-20, same PR, after rebase onto current main) fixed
the three XCTest failures that painted the unsigned wrapper red, plus the
`testDeleteAccountCommandPayload` body unwrap that would have failed next:

- POST body tests read `Self.requestBody(request)` (httpBody or stream).
- Pager test expects the default 50-row page size (offset `50`, 5 pages
  for 250 rows).
- Device compile and XCTest use `$RUNNER_TEMP/DerivedData-ct-ci` so a
  contended default DerivedData lock cannot sit until the 45-minute
  timeout and cancel the Mac job.

## Required check (Jay / ASC)

Agents can POST a context to classic branch protection, but that must wait
until **this workflow is on `main`**.  Adding `xcodebuild (unsigned)` while
the old path-filtered workflow is still what other open PRs run would leave
those PRs waiting on a check that never starts.

Live `required_status_checks.contexts` after this PR (still):

- `typecheck + test`
- `gitleaks`

**Owner step after this lands on `main` and has produced at least one check
run of that name:**

1. Repo **Settings → Branches → `main`**.
2. Edit the branch protection rule (or ruleset).
3. Enable **Require status checks to pass before merging**.
4. Search for and add **`xcodebuild (unsigned)`** (the wrapper job name).
5. Save.  Confirm with:

```
gh api repos/jaywedgeworth22/Congress.Trade/branches/main/protection \
  --jq '.required_status_checks.contexts'
```

Expected after the tick: `typecheck + test`, `gitleaks`,
`xcodebuild (unsigned)`.

Do not require the workflow name (`iOS build (Mac runner)`).  Require the
**job** name.  Do not require `xcodebuild-mac` or `ios path gate`.

A premature add of `xcodebuild (unsigned)` was posted and immediately
deleted during this work, before the always-report wrapper existed.

## Follow-ups

- Jay/ASC ticks `xcodebuild (unsigned)` required after merge.  Until then
  the workflow still fails and paints the PR red; GitHub will still allow
  merge.
- No TestFlight from this change.
