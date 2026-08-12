# iOS fleet ship tooling

This directory is the **source of truth** for the fleet-wide TestFlight ship scripts used by all three apps (Socratic.Trade, Congress.Trade, Usage Monitor).  The runtime install location is `/Users/jay/apps/ios-fleet/`, which is outside version control — twice in one week an unversioned host script there carried a defect nobody could review (a reattach cron that opened a 60s outage window every minute; a macOS `flock` bug that would have shipped an empty version string).  This directory exists so the same scripts get code review, history, and PRs before they run.

## Files

- `ship-testflight.sh` — archive + export + upload a single app to TestFlight without the Xcode UI.
- `ship-all.sh` — ship all three fleet apps sequentially.
- `apps.json` — per-app registry (bundle id, scheme, project paths, team id).
- `asc-api.mjs` — minimal App Store Connect API client (ES256 JWT, no dependencies).  Used by `ship-testflight.sh` for export-compliance (`ensure-tf-ready`) and for build-number verification (`latest-build-seq`).
- `appstore-connect.env.example` — template for `~/.secrets/appstore-connect.env`; variable **names** only, no values.
- `ExportOptions-appstore.plist` — export options for `destination=upload`.
- `ExportOptions-export-ipa.plist` — export options for `destination=export` (local IPA only).

Secrets (ASC API key id/issuer/path) are read at runtime from `~/.secrets/appstore-connect.env`; none of the files here contain secret values, only the names of the environment variables they expect.

## Install (sync repo copy -> runtime location)

```bash
install -m 0755 scripts/ios-fleet/ship-testflight.sh /Users/jay/apps/ios-fleet/ship-testflight.sh
install -m 0755 scripts/ios-fleet/ship-all.sh /Users/jay/apps/ios-fleet/ship-all.sh
install -m 0644 scripts/ios-fleet/apps.json /Users/jay/apps/ios-fleet/apps.json
install -m 0644 scripts/ios-fleet/asc-api.mjs /Users/jay/apps/ios-fleet/asc-api.mjs
install -m 0644 scripts/ios-fleet/appstore-connect.env.example /Users/jay/apps/ios-fleet/appstore-connect.env.example
install -m 0644 scripts/ios-fleet/ExportOptions-appstore.plist /Users/jay/apps/ios-fleet/ExportOptions-appstore.plist
install -m 0644 scripts/ios-fleet/ExportOptions-export-ipa.plist /Users/jay/apps/ios-fleet/ExportOptions-export-ipa.plist
```

Edit the runtime copy only through this repo: change the file here, land the PR, then re-run the `install` commands above to sync `/Users/jay/apps/ios-fleet/`.

## Versioning contract

Every rebuild — including a tiny tweak — assigns the next `1.0.<seq>` value and writes that identical dotted string to both `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION`, so the version shown in TestFlight and the build number can never drift apart.  `--dry-run` only peeks at the next value and does not consume it, and the sequence file is guarded by an atomic-`mkdir` lock (not `flock(1)`, which does not exist on macOS) so concurrent ships cannot race the counter.

### Where the number comes from

The next sequence is **`max(local cache, App Store Connect, project.pbxproj) + 1`**.

`~/.cache/ios-fleet/build-seq-<app>.txt` is a *cache*, not the source of truth.  It is a single unbacked file on one machine: if it is lost, reset, or a ship runs from a second machine, a bare "+1" reuses a build number and App Store Connect rejects the upload as a duplicate.  Taking the max of every record we have is monotonic against all of them.  It can skip a number — harmless, numbers are free — but it cannot reuse one, which is fatal.

The three inputs are printed on every run, e.g. `seq sources: local=2 asc=1 project=4 -> floor=4`.

- **App Store Connect** is queried with `asc-api.mjs latest-build-seq <bundleId> 1.0`, using the same credentials already passed to `xcodebuild`.  Legacy timestamp builds (`202608120521`) do not match `1.0.N` and are ignored on purpose — they belong to the old `1.0.0` marketing train.
- **`project.pbxproj`** participates in the max, so the project file can never be silently disagreed with.  The resolved version is passed on the `xcodebuild` command line and overrides whatever the project file says, so a run whose resolved version differs from the project file prints a `NOTICE` naming both.  `--sync-project-version` writes the resolved version back into the project file (opt-in: it dirties the worktree, and shipping requires a clean one).
- If **ASC cannot be consulted at all** and there is no local sequence and no on-train version in the project file, the script **fails** rather than guessing, and prints the three ways to resolve it.  `--allow-unverified-seq` overrides, with a warning.

`IOS_FLEET_STATE_DIR` relocates the sequence/rate-limit state, for testing against a scratch directory.

## Drift check

`check-drift.sh` compares the sha256 of each file here against its counterpart in `/Users/jay/apps/ios-fleet/` and fails if they differ, so the repo copy cannot silently go stale relative to what actually runs.  Run it locally with:

```bash
bash scripts/ios-fleet/check-drift.sh
```

It exits 0 with a warning (not a failure) when `/Users/jay/apps/ios-fleet/` does not exist on the current machine, since that directory is host-local and won't be present in CI.
