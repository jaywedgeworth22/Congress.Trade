# App Store Screenshots (Congress.Trade iOS)

Screenshots are **captured by an XCUITest**, not by hand and not by driving the
Simulator UI.  `CongressTradeUITests/AppStoreScreenshotTests` walks the app
through every listing scene via the accessibility API and attaches a full-screen
capture of each; `scripts/capture-app-store-screenshots.sh` boots the
simulators, runs it at each App Store size, and harvests the attachments.

Driving the app through the accessibility API means a capture run **never steals
foreground focus** — you can keep working while it shoots.  There is no
AppleScript, no `open -a`, and no Simulator.app automation anywhere in this path.

## Capture a set

```bash
scripts/capture-app-store-screenshots.sh              # all three sizes
scripts/capture-app-store-screenshots.sh --sizes 69   # just the 6.9" slot
scripts/capture-app-store-screenshots.sh --keep 10    # retain more runs
```

Output lands in a **timestamped run directory**:

```
docs/brand/app-store-screenshots/runs/20260811-171354/
├── RUN.md            commit, Xcode/runtime, API base, slots
├── iphone_69/        iphone_69_01_trends.png … _07_quick_menu.png
├── iphone_67/
└── iphone_61/
```

Runs **accumulate** so you can shoot whenever the live data looks good and pick a
set later.  They are ~19MB each, so `runs/` is gitignored and the script prunes
to the newest `--keep` (default 5).  **Do not commit a run** — the harness is the
artifact worth versioning, and a committed run freezes whatever bugs were live
that afternoon into the repo as if they were the reference.

## Sizes

Each slot is captured on a device whose **native** resolution is exactly what App
Store Connect wants, so nothing is ever resampled.  (The 2026-08-07 set below was
shot once on a Pro Max and `sips`-resized down; that stretched the 6.9" layout
into the other two aspect ratios instead of letting each size lay itself out.)

| Slot | Pixels | Simulator |
|------|--------|-----------|
| `iphone_69` (6.9") | 1320×2868 | iPhone 16 Pro Max |
| `iphone_67` (6.7") | 1290×2796 | iPhone 15 Pro Max |
| `iphone_61` (6.1") | 1179×2556 | iPhone 15 Pro |

The status bar is frozen at 9:41 with full Wi-Fi and a charged battery via
`simctl status_bar override`, and cleared again afterwards.  Any simulator the
script boots is shut down and any it creates is deleted, so the machine is left
as it was found.

## Scenes

| # | Name | What it shows |
|---|------|---------------|
| 01 | `trends` | Market Snapshot KPIs + What Congress Is Trading leaderboard |
| 02 | `trades` | BrandTitle lockup, shared filters, live trade rows |
| 03 | `people` | Member directory |
| 04 | `delivery` | Alert delivery + APNs |
| 05 | `settings` | Sign-in, pictographic theme, legal links |
| 06 | `trade_detail` | Trade detail sheet over the trades list |
| 07 | `quick_menu` | Header account quick menu |

## Live data, and why a run can fail

The app loads real data from congress.trade, so the test waits on **explicit
conditions** — activity indicators gone, the Trends loading label gone, the view
hierarchy settled — never a fixed sleep.  A scene that has not finished loading
when its timeout expires **fails the run loudly** rather than handing back a
screenshot of a spinner.  That is deliberate: a failed run costs a rerun, a
captured spinner costs an App Store review cycle.

If prod is down or you want a fixed dataset, point the app elsewhere:

```bash
scripts/capture-app-store-screenshots.sh --api-base http://127.0.0.1:8791/api/client/v1
```

## Currently-live App Store assets

`archive/2026-08-07/` holds the set uploaded to App Store Connect (en-US, v1.0)
— `iphone_61/`, `iphone_67/`, `iphone_69/`, and the `raw/` Pro Max captures.
**These are the assets live on the store today**, kept for reference until a new
run replaces them.  Their scene 01 is named `feed`; the app calls that tab
**Trades** now, which is why new runs name it `02_trades`.
