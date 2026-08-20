# 2026-08-20 — Monet P0/P1 pack (webhook, APNs, politician 404, delivery secret, Apple refund, Filing PDF)

## Summary

Ship the unambiguous S-effort P0/P1 items from the Monet 2026-08-19 review so Apple notifications, push fan-out, politician sheets, Delivery secrets, refunded/sandbox purchases, and Filing PDF (3.1.1) behave correctly.

- **APICONTRACT-01** — Peel a query string that was percent-encoded into the politician path.  Web `aGet` builds `/api/analytics/…` via `analyticsUrl` so `?` cannot ride in a path segment.  No iOS file change for this item.
- **DELIVERYALERTS-02** — APNs official-trade SQL joins `filers.bioguide_id = transactions.filer_id` (filers has no `id`).
- **ENGINEERINGQUALITY-02** — `buildAppleWebhookRouter()` is mounted on the production assembly (`mountApiRouters` in `index.ts`) at `POST /api/webhooks/apple`.  `app.ts` re-exports that app.
- **DELIVERYALERTS-01** — Inline `create_subscription` claims `result_secret` on the POST so Delivery UI can show the one-time secret once.  The secret is not logged.
- **BILLING-03** — Apple `REFUND` applies like `REVOKE`.  `environment === 'Sandbox'` does not grant live Premium unless `APPLE_ALLOW_SANDBOX=true`.  Stripe webhooks require `livemode` to match a `sk_live` / `sk_test` key prefix.
- **APPSTORECOMPLIANCE-01 / 02** — Archived Filing PDF is Premium.  iOS fetches with Bearer and presents QuickLook.  Free/anonymous opens `PremiumSheet`.  Backend returns 402 JSON for Bearer / `Accept: application/pdf`.  Government Source Filing stays ungated.  Jay skipped the PDF product widget; this is the decision.  iOS files changed — note it; do not ship a second TestFlight from this seat.

## Files changed

- `app/src/apiRouters.ts`, `app/src/index.ts`, `app/src/app.ts`
- `app/src/shared/memberPath.ts`, `app/src/client/routes.ts`, `app/src/analytics/routes.ts`, `app/src/ui/dashboardHtml.ts`
- `app/src/delivery/apnsFanout.ts`
- `app/src/billing/apple.ts`, `app/src/billing/appleWebhook.ts`, `app/src/billing/stripe.ts`, `app/src/billing/routes.ts`, `app/src/client/commands.ts`
- `app/src/shared/types.ts`
- `app/src/delivery/rest.ts`, `app/src/delivery/__tests__/documentPdf.test.ts`
- `clients/ios/CongressTrade/APIClient.swift`, `Views/Feed/TradeDetailView.swift`, `Views/Status/PremiumSheet.swift`, `CongressTradeTests/CongressTradeTests.swift`
- `app/docs/client-mobile-api.md`

## Verification

From `app/`:

```bash
npm run typecheck
npm test
```

2026-08-20: `deno check src/deno/main.ts` clean.  `vitest run` 262 files / 3218 tests.

`POST /api/webhooks/apple` on the production app is 503 (IAP off) or 400/200 — never 404.

## Follow-ups

- Account deletion, deploy 502s, and duplicate-trade cleanup stay out of this slice.
- Infisical `APPLE_ALLOW_SANDBOX` stays unset in prod unless TestFlight grants are deliberately wanted.
- Hourly TestFlight ship picks up the iOS Filing PDF change; this seat does not cut a second build.
