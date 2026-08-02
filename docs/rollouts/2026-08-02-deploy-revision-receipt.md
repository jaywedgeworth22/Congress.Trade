# 2026-08-02 — Deploy revision receipt (`/api/health` reports the running build)

## Summary

`app/scripts/ship.sh` does not deploy. Coolify redeploys on push to `main`, and
that webhook has silently failed before (board, 2026-07-31: *"Coolify auto-deploy
did NOT fire on the main merge — triggered manually via Coolify API"*). Because
nothing in any response identified the running build, `ship.sh` would:

1. health-check whichever revision happened to be live,
2. run `POST /api/admin/migrate` against it,
3. print success,

and an operator would reasonably report the new code as deployed.

**That happened on 2026-08-01.** Six merged PRs (#1228 P0-3, #1229 P1-3,
#1230 P1-4, #1231 P1-9, #1232 P0-1, #1233 P1-1) were reported "merged and
deployed, ship.sh prod deploy verified live" while production still served the
previous image. Verified against live production at 03:59Z and again at 04:05Z —
fresh, uncached (`cf-cache-status: DYNAMIC`), origin-reached (`via: 1.1 Caddy`):

```
set-cookie: ct_auth_origin=http%3A%2F%2Fcongress.trade; ... HttpOnly; SameSite=Lax
set-cookie: ct_oauth_state=...;                          ... HttpOnly; SameSite=Lax
(no Secure on either cookie; no strict-transport-security header at all)
```

`ct_auth_origin` still holding `http://congress.trade` is the decisive tell: that
is the exact value PR #1228 changed. The renderer fix (#1222) *was* live, so
production sat between the two.

This is audit finding **P1-5** — *"Deployment verification is not revision-aware…
Publish build SHA in health and require an exact Coolify deployment receipt
before migration and live verification."* The predicted gap produced exactly the
predicted false report.

## What changed

- **`app/src/shared/buildInfo.ts`** (new) — `readBuildInfo(env)` resolves the
  running commit from `CT_BUILD_SHA` / `SOURCE_COMMIT` / `GIT_COMMIT_SHA` /
  `GITHUB_SHA`. Anything that is not a git object name (`''` from an unset
  Docker ARG, `HEAD`, `main`, an un-expanded `$SOURCE_COMMIT`) resolves to
  `unknown` rather than an empty string that reads as a confident answer.
- **`app/src/delivery/rest.ts`** — `GET /api/health` now includes
  `build: { sha, shortSha }`.
- **`app/Dockerfile`** — `ARG SOURCE_COMMIT` → `ENV CT_BUILD_SHA`.
- **`app/docker-compose.yml`** — passes `SOURCE_COMMIT` as a build arg.
- **`app/scripts/ship.sh`** — new `check_live_revision()`, run after liveness and
  **before** migrate:
  - live SHA == `git rev-parse HEAD` → confirmed, continue;
  - live SHA != HEAD → **exit 1**, with the Coolify trigger URL in the message.
    Migrating and "verifying" a revision we did not ship is exactly how a stale
    production gets reported as deployed;
  - no SHA reported → continue but print `treat this run as unverified`. This is
    the bootstrap case: the currently-running image predates this change.

## Verification

```bash
curl -s -A '<browser UA>' https://congress.trade/api/health | jq .build
# { "sha": "<40-hex>", "shortSha": "<12-hex>" }
```

Then `bash app/scripts/ship.sh` prints
`live build <sha> matches HEAD — deploy confirmed.` or fails.

Gates: `deno check` clean; `src/shared/__tests__/buildInfo.test.ts` 5/5.

## Notes

- Coolify's API is reachable at `https://host.jays.services` with the
  `COOLIFY_AGENTS` bearer token. Manual trigger:
  `GET /api/v1/deploy?uuid=congress-trade`.
- **User-Agent gotcha (corrected 2026-08-02).** Cloudflare 403s a narrow set of
  known-bot User-Agents at the edge. Measured on both `host.jays.services` and
  `congress.trade`:

  | User-Agent | result |
  |---|---|
  | `Python-urllib/3.13` (Python's default) | **403 at Cloudflare** |
  | `curl/8.7.1` (curl's default) | reaches origin |
  | `python-requests/2.32` | reaches origin |
  | `""` (empty) / `x` / browser string | reaches origin |

  So bare `curl` needs no workaround, and a Python script needs only *some*
  `User-Agent` header — not a spoofed browser. The reliable tell: an edge block
  returns 403 with **no `via: 1.1 Caddy`** header, whereas the origin's own auth
  failure is a 401 that does carry it. An earlier version of this note (and the
  comment in `ship.sh`) claimed a browser UA was required; that was wrong — the
  Chrome UA worked, but for the wrong reason.
- The first `ship.sh` run after this lands takes the "unverified" branch, because
  the running image has no build SHA. Every run after that is enforced.

## Follow-ups

- `CT_DRAIN_LIMIT` is configured **twice** in the Coolify env for
  `congress-trade` (KIMI flagged duplicate-env creation on 2026-08-01). Harmless
  today but worth removing one.
- Consider asserting the revision in the uptime monitor too, so drift is caught
  without a deploy.
