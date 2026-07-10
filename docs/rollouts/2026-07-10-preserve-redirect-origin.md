# Rollout Notes — Preserve Login Subdomain Origin on Redirect

- **Date**: 2026-07-10
- **Author**: AG (Antigravity)
- **Status**: Completed & Deployed

## Summary

This rollout resolves issues where users logging in from a subdomain (e.g. `admin.congress.trade`) were redirected to the apex domain `congress.trade` after a successful login callback.

## Files Changed

- **[session.ts](file:///Users/jay/Code/Congress.Trade/app/src/auth/session.ts)**: Added `getSafeRedirectUrl` to validate allowed origins (subdomains of `congress.trade` and local development hosts).
- **[routes.ts](file:///Users/jay/Code/Congress.Trade/app/src/auth/routes.ts)**:
  - Stored initiator subdomain origin in a `ct_auth_origin` cookie for Google OAuth.
  - Passed initiator origin as a query parameter for Magic Links, verifying it on callback.
- **[session.test.ts](file:///Users/jay/Code/Congress.Trade/app/src/auth/__tests__/session.test.ts)**: Added unit tests for `getSafeRedirectUrl` origin validation.

## Verification

- **Automated Tests**: Ran `npm run typecheck` and `npm test` locally. All 672 tests passed.
- **CI / Build Verification**: GitHub Actions passed successfully.
- **Production Verification**: Deploy completed successfully and health checks returned 200.
