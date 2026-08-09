# Congress.Trade brand assets

**Source of truth (2026-08-09):** owner hi-res masters

- `source-owner-lockup-hires-2026-08-09.png` — full CONGRESS + eagle + TRADE lockup (~1670×334 after trim)
- `source-owner-mark-hires-2026-08-09.png` — eagle + money-bag mark alone (~1015×1048)

## Rules (owner)

- **Never** ship the navy-filled badge as the product mark or website logo.
- **Website:** transparent lockup/mark only (no cream fill) — the UI supplies the background.
- **Light lockup:** solid black letters on transparent (good on light/cream UI).
- **Dark lockup:** same art with **white** letters; eagle colors preserved.
- **iOS AppIcon only:** opaque light-gray full-bleed plate (`eagle-app-icon-light-1024.png` / `source-owner-app-icon-1024x1024.jpg`). Hi-res master: `eagle-app-icon-light-1408.png` / `source-owner-app-icon-1408x1408.jpg`. iOS rejects transparent AppIcon.
- **Everywhere else that allows alpha** (web/PWA icons, favicon, apple-touch-icon, splash, in-app BrandLogo): transparent eagle mark — no plate fill.

## Files

| File | Use |
|------|-----|
| `source-owner-lockup-hires-2026-08-09.png` | Owner lockup master (hi-res) |
| `source-owner-mark-hires-2026-08-09.png` | Owner eagle mark master (hi-res) |
| `eagle-lockup-transparent.png` | Website light type (black text), transparent |
| `eagle-lockup-dark-ui.png` | Website dark type (white text), transparent |
| `eagle-header-lockup-{light,dark}-240.png` | High-DPI header embeds |
| `eagle-moneybag-icon-square.png` | Transparent eagle mark (splash / BrandLogo) |
| `source-owner-app-icon-1024x1024.jpg` | Owner App Store / AppIcon plate (1024×1024) |
| `source-owner-app-icon-1408x1408.jpg` | Owner app-icon master at 1408×1408 |
| `eagle-app-icon-light-1024.png` | iOS AppIcon + derived PWA icons |
| `eagle-app-icon-light-1408.png` | Hi-res app-icon master (pixels in name) |
| `eagle-app-icon-light-{180,192,512}.png` | Derived install / PWA sizes |
| `eagle-app-icon-1024.png` | Archived navy mockup — **do not use** |

## Installed

- Web `app/public/assets/brand-logo-{light,dark}.png` ← hi-res lockups (`?v=20`)
- Web `app/public/assets/eagle-splash.png` ← transparent mark
- Web `app/public/{icon-192,icon-512,apple-touch-icon,favicon}.png` ← **transparent** mark (`?v=10`)
- iOS `BrandLockup` ← light (black letters) + dark (white letters)
- iOS `BrandLogo` ← transparent eagle mark (in-app; alpha OK)
- iOS `AppIcon` ← **opaque** owner 1024×1024 plate (light bg + soft shadow); web icons stay transparent
