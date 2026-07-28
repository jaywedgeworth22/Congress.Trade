# Congress.Trade brand assets (eagle)

Source: SuperGrok Imagine lockup / app-icon mockups provided by the owner
(eagle clutching a money bag, dark navy ground, metallic gold eagle).

**Installed live 2026-07-28 (GROK)** — previous effort-log claim that PR #932
landed these bytes was incorrect; masters lived only under `docs/brand/assets/`
while iOS/PWA/dashboard still shipped the old capitol/chart placeholder.

## Files

| File | Use |
|------|-----|
| `eagle-app-icon-1024.png` | iOS AppIcon master |
| `eagle-app-icon-512.png` / `192.png` | PWA icons |
| `eagle-apple-touch-180.png` | PWA apple-touch-icon |
| `eagle-emblem-512.png` / `256.png` | Square emblem exports |
| `eagle-mark-128.png` / `64.png` / `32.png` | Header / favicon-scale marks |
| `eagle-lockup.png` | Full wordmark+eagle lockup reference (light ground) |
| `eagle-header-lockup-dark.png` | Dark header lockup (emblem + wordmark) for PWA topbar |

Installed into:

- `clients/ios/.../AppIcon.appiconset/AppIcon.png` ← `eagle-app-icon-1024.png`
- `clients/ios/.../BrandLogo.imageset/BrandLogo.png` ← `eagle-app-icon-1024.png`
- `clients/pwa/public/{icon-192,icon-512,apple-touch-icon}.png` ← matching eagle masters
- `clients/pwa/public/congress-trade-logo.png` ← `eagle-header-lockup-dark.png`
- `clients/pwa/public/icon.svg` ← embedded `eagle-mark-128.png`
- Dashboard brand mark: embedded data-URI from `eagle-mark-128.png` in `app/src/ui/dashboardHtml.ts`

Do not regenerate with a new model run — use these bytes.
