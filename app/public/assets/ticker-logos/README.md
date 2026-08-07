# Local ticker logos (repo-hosted)

Served **first** by `GET /api/logos/ticker?symbol=…` (before logo.dev / GitHub).

## Layout

| File | Symbol(s) |
|------|-----------|
| `TSCO.png` | Tractor Supply |
| `SPCX.png` | SpaceX (private disclosure name) |
| `HONAV.png` | Honeywell Aerospace |
| `HON.png` | Honeywell |
| `BRK.B.png` / `BRKB.png` / `BRK-B.png` | Berkshire Hathaway Class B |
| Plus copies of common mirrors (HUBB, ECL, …) when useful |

## Adding a logo

1. Save a **square PNG** (256×256 preferred) as `SYMBOL.png` (uppercase ticker).
2. Commit under this directory — no code change if the filename matches the symbol.
3. After deploy, hard-refresh; `x-logo-source: local:ticker-logos/SYMBOL.png`.

## Owner-supplied pack (2026-08-07)

- Berkshire **BH** mark → BRK.B / BRKB / BRK-B  
- Tractor Supply **TSC** → TSCO  
- Honeywell wordmark → HONAV + HON  
- SpaceX **X** mark → SPCX  
