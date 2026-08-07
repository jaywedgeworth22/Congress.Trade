# Local ticker logos (repo-hosted)

**These are optional gap-fills**, not necessarily the best or final marks.

Resolution order for `GET /api/logos/ticker`:

1. **logo.dev** (when `LOGODEV_PUBLISHABLE_KEY` / `LOGO_DEV_TOKEN` is live)
2. **This pack** (only if logo.dev misses or is unavailable)
3. GitHub ticker-logos mirror

So a better logo.dev hit always wins over files here. Overwrite any PNG anytime
you have a cleaner official asset.

## Current options (2026-08-07)

| File | Use | Notes |
|------|-----|--------|
| `TSCO.png` | Tractor Supply | Interim TSC-style option |
| `SPCX.png` | SpaceX (disclosure) | Interim X mark |
| `HONAV.png` / `HON.png` | Honeywell Aerospace / HON | Interim wordmark |
| `BRK.B.png` / `BRKB.png` / `BRK-B.png` | Berkshire B | Interim BH monogram |
| Others | HUBB, ECL, … | Mirrors; replace freely |

## Replace a logo

1. Drop a square PNG (256×256 preferred) as `SYMBOL.png`.
2. Commit — no code change if the filename matches the ticker.
3. Deploy; confirm with `curl -sI '…/api/logos/ticker?symbol=TSCO' | grep x-logo-source`.
