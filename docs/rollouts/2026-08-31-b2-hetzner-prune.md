# 2026-08-31 - B2 hetzner/ snapshot prune + R2 weekly receipt guard

## Context & Objective

`scripts/ops/fleet-sqlite-backup.sh` (deployed as `/usr/local/sbin/fleet-sqlite-backup.sh` on `fleet-hetzner-nbg1`, cron 00:15/06:15/12:15/18:15 UTC) uploads ~52 GB/day of raw full-DB snapshots to `b2:jays-{socratic,congress,usage-monitor}-trade-eu/hetzner/` (UM bucket is `jays-usage-monitor-eu`) with no B2-side prune, so only the 15-day bucket lifecycle (hide-14d/delete-1d) ever reclaims - projecting ~780 GB steady state on a shared Backblaze account whose caps are already tripping daily.  Separately, the Sunday R2 weekly leg is guarded only by day-of-week, so it re-runs on all four Sunday cron ticks.  This change adds a best-effort B2-side prune after each successful offsite upload and a same-day success receipt guard for the R2 weekly leg.

## Changes Made

- New `prune_b2_sets()` runs after each `B2 offsite OK` upload: lists `b2:<bucket>/hetzner/` via `rclone lsf --files-only`, groups objects into snapshot sets by strict `YYYYMMDDTHHMMSSZ` stamp (`grep -E '[0-9]{8}T[0-9]{6}Z'`), keeps the newest `B2_KEEP_SETS` (env, default 6) sets, and `rclone deletefile`s older sets (Class A calls, free on B2).
- Safety rails: bucket allowlist (only the three known fleet buckets, only their `hetzner/` prefix), numeric validation of `B2_KEEP_SETS`, WARN + skip on unparseable object names, an explicit refusal to delete the set carrying the current run's `$STAMP`, and `|| true` at the call site so a prune failure can never fail the backup run.  Logs are `B2 prune OK: <app> kept=N deleted=M` (N/M count sets) or `B2 prune SKIP: <reason>`.
- New `r2_receipt_ok_today()` guards the Sunday R2 leg for congress: when `/data/congress-trade/.r2-archive-status.json` exists, contains `"ok":true`, and its `completedAt` matches today's UTC date, the leg logs `R2 weekly SKIP: already succeeded today` and skips.  Missing/stale/`ok:false` receipts keep the existing retry behavior, and `FLEET_BACKUP_FORCE_WEEKLY=1` still bypasses the guard for manual proof runs.
- Fixed the one pre-existing non-ASCII byte (an em dash in a comment) to keep the script pure ASCII per the fleet shell-script rule.
- Touched files:
  - `scripts/ops/fleet-sqlite-backup.sh`
  - `docs/EFFORT-LOG.md`
  - `STATUS.md`
  - `docs/rollouts/2026-08-31-b2-hetzner-prune.md` (this note)

## Decisions & Trade-offs

- Prune counts and deletes whole SETS, not files: `deleted=M` increments only when every file of a set deleted cleanly; partial failures emit `B2 prune WARN: delete failed: <name>` and do not count.
- `kept=N` is `min(total sets, B2_KEEP_SETS)` from the newest-first stamp sort; the lexicographic sort of `YYYYMMDDTHHMMSSZ` stamps is chronological by construction.
- The receipt guard is congress-only because the receipt file is congress's health receipt; other apps have no R2 bucket mapped today anyway.  `FLEET_BACKUP_FORCE_WEEKLY=1` deliberately bypasses the guard - a manual proof run should run.
- The script keeps its pre-existing `declare -A` maps (bash 4+); it runs only on the Linux host (bash 5).  All NEW code sticks to bash-3.2-safe constructs (herestrings, `local`, POSIX case/arithmetic) per the fleet standard, and `bash -n` passes on macOS bash 3.2.57.
- The pre-existing `ls | grep` at the top of the replication loop (shellcheck SC2010) was left as-is: out of scope, filenames are controlled.

## Verification State

- `bash -n scripts/ops/fleet-sqlite-backup.sh` - clean (macOS bash 3.2.57).
- `grep -nP '[^\x00-\x7F]'` - zero non-ASCII bytes after the em-dash fix.
- `shellcheck -S warning` - only the pre-existing SC2010 on the untouched `ls | grep` line.
- Stubbed-rclone harness exercised: 8 sets/keep 6 deletes exactly the 2 oldest sets (all .db + .sha256 + kv sidecars, kept=6 deleted=2); keep=1 with the current stamp in the delete range refuses its own set; unparseable `weird-object.txt` warns and is untouched; unknown bucket and empty listing SKIP; receipt guard fires on ok:true today and retries on stale date, ok:false, and missing file.
- CI `typecheck + test` (required check) on the PR - shell change does not affect it, expected green.

## Next Steps & Blockers

- DONE 2026-08-31 11:22Z: host copy synced.  Backed up to `/root/fleet-sqlite-backup.sh.pre-prune-1788175363`, installed the merged version (sha256 `a870f921...0ed5a`), host `bash -n` clean, mode 755 root:root.
- Host drift preserved: the deployed copy had intentional local edits from 2026-08-16 that the repo cannot carry (PR #2171 sanitized Coolify volume/container UUIDs out of the public repo) - UUID-pinned `SOCRATIC_VOL`/`UM_VOL`/container greps plus a `SOCRATIC_VOL` fallback.  The install applied this PR's diff ON TOP of the host copy instead of overwriting wholesale, so those greps survive; the two regions are disjoint.
- DONE: dry-verified stamp parsing against real object names (`rclone lsf b2:jays-congress-trade-eu/hetzner/` shows `congress-trade-YYYYMMDDTHHMMSSZ.db` + `.db.sha256`; 7 distinct stamp sets, zero unparseable names).
- First real prune happens on the next cron tick (12:15Z); with 7 sets present and keep=6, expect `deleted=2` for congress (the tick uploads set 8), then ~1/tick steady state.  No full backup was run manually.
