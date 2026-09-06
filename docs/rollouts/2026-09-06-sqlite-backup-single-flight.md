# 2026-09-06 — fleet-sqlite-backup.sh single-flight, complete-only retention, backup timeout

Board `e1f66898`.  Branch `grok/sqlite-backup-harden`.  Worktree
`~/apps/congress-grok-sqlite-backup`.

## Summary

Housekeeper 2026-09-06 mitigated a live incident on `fleet-hetzner-nbg1`: Coolify
had three concurrent `sqlite3 .backup` processes against Socratic.Trade live
`app.db` (orphan 18:15 tick plus overlapping 00:15 and 06:15), each ~93–97% CPU
for hours, because the product script had no flock.  `KEEP_COUNT` used
`ls -1t` mtime, so in-progress dumps (`*.db-journal`, missing `.sha256`) ranked
newer than a finished snapshot and retention deleted a good local complete.
B2 still had good sets.  Housekeeper killed the overlaps, deleted incomplete
locals, and wrapped cron with `flock -n /var/lock/fleet-sqlite-backup.lock`.
This change hardens the canonical script so it is safe even without that
wrapper.

## Files changed

- `scripts/ops/fleet-sqlite-backup.sh` — in-script flock, complete-only
  retention, `timeout` around `sqlite3 .backup`
- `scripts/ops/test-fleet-sqlite-backup.sh` — offline retention harness
- `docs/EFFORT-LOG.md`
- `STATUS.md`
- `docs/rollouts/2026-09-06-sqlite-backup-single-flight.md` (this note)

## Changes

1. **Single-flight.**  `flock -n` on
   `${FLEET_BACKUP_LOCKFILE:-/var/lock/fleet-sqlite-backup.lock}`.  If the lock
   is held, log `SKIP already running` and exit 0.  Same inode as the host cron
   wrapper; Linux `flock(2)` grants a second lock to the same process, so the
   wrapper and in-script lock compose.  Missing `flock` fails closed.
2. **Complete-only retention.**  A dump counts only when the `.db` exists, a
   matching `.sha256` exists, and no `${dump}-journal` sidecar is present.
   Incomplete files are deleted first and never occupy a `KEEP_COUNT` slot or
   win a `KEEP_DAYS` mtime race.  Integrity-failed dumps no longer get a
   `.sha256`, so retention will not treat them as keepers.
3. **Backup timeout.**  `sqlite3 .backup` runs under
   `timeout -k 30s ${FLEET_BACKUP_TIMEOUT:-30m}`.  A timeout or failure logs
   `FAIL`, removes the partial dest / journal / sha256, and continues to the
   next app instead of hanging the whole run.

## Verification

- `bash -n scripts/ops/fleet-sqlite-backup.sh`
- `bash scripts/ops/test-fleet-sqlite-backup.sh`
- `grep` for non-ASCII bytes should stay clean (ASCII-only script)

## Follow-ups (host install — Housekeeper / Deployer)

Do **not** bake Coolify images.  Do **not** extra-ship or `--force-ship`.
After merge, install the script to `/usr/local/sbin/fleet-sqlite-backup.sh`
on `fleet-hetzner-nbg1`.  The live host copy still carries UUID-pinned
volume/container greps that the public repo cannot hold (see
`docs/rollouts/2026-08-31-b2-hetzner-prune.md`).  Apply this diff on top of
the host copy; do not overwrite wholesale.  Backup the current host file
first.  Cron wrapper flock can stay; it composes with the in-script lock.
