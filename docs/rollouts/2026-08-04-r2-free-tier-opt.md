# 2026-08-04 — Congress.Trade R2 free-tier opt [GROK]

## Problem

CT R2 Class A pace projected **~123%** of free tier (0.2 elapsed floor) with
storage ~6.0 GiB (60%). Cause: litestream LTX PutObject rate (sync 10s→30s still
too hot under bulk price load + normal writes).

## Change (host, not app path)

`/etc/litestream/congress.yml` on the Oracle host:

| Setting | Before | After |
|---------|--------|-------|
| `sync-interval` | 30s | **60s** |
| `snapshot.retention` | 72h | **36h** |

`litestream-congress` restarted; logs show `sync-interval=1m0s`. Credentials
via `EnvironmentFile` + `${AWS_ACCESS_KEY_ID}` / `${AWS_SECRET_ACCESS_KEY}`.

## Performance impact

**None on app requests.** Litestream is backup-only. RPO worsens from 30s→60s
(still excellent for free-tier PITR).

## Verification

```bash
systemctl is-active litestream-congress
journalctl -u litestream-congress -n 5 --no-pager | grep sync-interval
```

## Follow-ups

- Watch Class A pace over 24–48h (target well under 50% with floor).
- Optional: document this file under Coolify/host IaC if we ever rebuild the box.
