# 2026-07-28 — Eagle logo install (site + PWA + iOS)

## Summary

Owner SuperGrok Imagine eagle+money-bag brand assets lived only under
`docs/brand/assets/`. Live surfaces still shipped the old capitol/chart
placeholder (iOS AppIcon/BrandLogo, PWA icons, broken base64
`congress-trade-logo.png`, truncated dashboard brand-logo data-URI). An
earlier effort-log note claiming PR #932 installed them was incorrect — that
PR number does not exist on GitHub.

This change copies the archived masters into every client surface and embeds
the 128px mark in the Deno dashboard header.

## Files changed

- `clients/ios/.../AppIcon.appiconset/AppIcon.png` ← `eagle-app-icon-1024.png`
- `clients/ios/.../BrandLogo.imageset/BrandLogo.png` ← same
- `clients/pwa/public/icon-{192,512}.png`, `apple-touch-icon.png`, `icon.svg`
- `clients/pwa/public/congress-trade-logo.png` ← dark header lockup
- `docs/brand/assets/eagle-header-lockup-dark.png` (archived master)
- `app/src/ui/dashboardHtml.ts` brand-logo data-URI ← `eagle-mark-128.png`
- Test: brand-logo data-URI must be a non-trivial PNG embed

## Verification

- `cd app && npm run typecheck`
- `cd app && npm test -- src/ui/__tests__/dashboardHtml.test.ts` (105/105)
- MD5 of live AppIcon/PWA icons match brand masters
- After deploy: site header shows eagle mark; PWA icons/header show eagle;
  iOS rebuild picks up AppIcon/BrandLogo

## Follow-ups

- iOS App Store / TestFlight rebuild required for home-screen icon change
- Optional: full-screen fly-in splash on web dashboard (iOS already has
  `EagleSplashView`)
