# 2026-07-18 Subscription Lifecycle & Quota Trigger Fix

## Summary
- **Quota Lockout Fix**: Replaced the trigger `trg_subscriptions_total_quota` so it only counts active subscriptions (`active = 1`) against the 20-subscription limit per client. Previously, deactivated subscriptions were counted toward the limit, leading to a permanent lockout after 20 lifetime subscriptions.
- **Deactivation Stream Teardown**: Updated the SSE stream loop in `app/src/delivery/sse.ts` to re-check the subscription's active status from the D1 database on each tick, terminating the stream immediately if deactivated.
- **Admin Endpoints**: Introduced admin lifecycle endpoints for subscription rotation and deactivation.

## Files Changed
- [0047_subscription_quota_active_only.sql](file:///Users/jay/Code/Congress.Trade/app/migrations/0047_subscription_quota_active_only.sql) — D1 migration file.
- [migrations.ts](file:///Users/jay/Code/Congress.Trade/app/src/admin/migrations.ts) — Idempotent prod migrations list.
- [routes.ts](file:///Users/jay/Code/Congress.Trade/app/src/admin/routes.ts) — Admin lifecycle routes.
- [subscriptions.ts](file:///Users/jay/Code/Congress.Trade/app/src/delivery/subscriptions.ts) — Quota preflight validation.
- [sse.ts](file:///Users/jay/Code/Congress.Trade/app/src/delivery/sse.ts) — SSE stream check loop.

## Verification
- Local D1 schema and integration tests run successfully:
  - `app/src/admin/__tests__/subscriptionLifecycle.test.ts`
  - `app/src/admin/__tests__/migrations.test.ts`
  - `app/src/admin/__tests__/subscriptions.test.ts`
- Manual verification via admin endpoints confirm deactivation terminates live streams and frees client slots.

## Follow-ups
- None.
