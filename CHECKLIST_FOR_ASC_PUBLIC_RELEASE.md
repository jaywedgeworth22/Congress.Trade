# Checklist for App Store public release — Congress.Trade iOS

Living document.  Last verified against live App Store Connect and GitHub: **2026-08-20**.

App id `6798076688` · bundle `trade.congress.ios` · team `CC8UTF7ATG` · version `1.0.0`

Every claim below was read from the live ASC API or the repo, not assumed.  Where something is
unverified, it says so.

---

## 0.  Status right now

| Thing | State | Evidence |
|---|---|---|
| App Store version 1.0.0 | **PREPARE_FOR_SUBMISSION** (was REJECTED; attaching the new build cleared it) | ASC `appStoreVersions` → `appStoreState` |
| Review submission `b61e2a4a` | **UNRESOLVED_ISSUES** — must be cancelled before the version can be resubmitted | ASC `reviewSubmissions` |
| Build attached to the version | ✅ **`202608202100`** — updated 2026-08-20 by agent | ASC `appStoreVersions/{id}/build` |
| Newest uploaded build | **`202608202100`** (Aug 20, 14:02 PT) — VALID, contains both App Review fixes | ASC `builds`, ship run sha `4b9694d1` |
| That build in TestFlight | **Yes — `internalBuildState = IN_BETA_TESTING`** | ASC `buildBetaDetail` |
| Subscriptions `…premium.monthly` / `…premium.annual` | **READY_TO_SUBMIT**, review screenshots COMPLETE, en-US localizations present — never attached to a submission | ASC `subscriptions` |

**Install `202608202100` from TestFlight — that is the build to record and to submit.**

### What Apple actually asked for (submission `b61e2a4a`, reviewed 2026-08-19 on an iPad Air 11-inch M3)

1. **Guideline 2.1(b)** — the In-App Purchase products were never submitted for review, and they want a new binary.
2. **Guideline 5.1.1(v)** — the app required registration before purchasing IAP products that are not account based.
3. **Guideline 5.1.1(v)** — the app supports account creation but offered no in-app account deletion, plus they want a screen recording of the deletion flow **captured on a physical device**.

### What is already fixed and merged

| Apple item | Fix | PR |
|---|---|---|
| 5.1.1(v) registration before purchase | Premium is purchasable with no account; sign-in is optional and explains what it adds.  Delivery alerts and push stay account-tied (legitimately account-based). | #2087 |
| 5.1.1(v) account deletion | In-app Delete Account with confirmation; deletes session, push devices, delivery subscriptions and the user row. | #2041 |
| 2.1(b) IAP products | Nothing to fix in code — the products are ready; they just need attaching to the submission (§2 below). | — |
| iPad Air 11-inch layout (the device they reviewed on) | Full-width sheets, Assets two-column grid, Delivery text capped, account menu on every tab, "President · Republican" instead of "Executive · R". | #2094 |

---

## 1.  Owner tasks — the things only you can do

### 1a.  Record the account-deletion video  ← **this is the one true blocker**

Apple asked for it **on a physical device**.  A simulator recording risks a fourth rejection on a
technicality, and you have a device, so record it there.  Full script in §4.

### 1b.  Decide two product questions

- **Free trial**: the subscriptions are configured with an introductory offer.  Confirm the trial
  length in ASC matches what the paywall copy says before submitting — a mismatch here is its own
  rejection reason.
- **Price**: confirm $5/mo and $50/yr are the live prices in the ASC subscription config.

### 1c.  Read the Resolution Center message yourself once more

Apple's rejection text is not exposed through the API.  If they added anything beyond the three
items above, everything below needs re-planning.

### 1d.  After approval

- Set `IOS_APP_STORE_ID=6798076688` in the production environment.  That one variable lights up both
  the Safari smart app banner and the site's own App Store banner, which are built and deliberately
  dark until the listing is real (PR #2077).
- Tell the iOS seat to finish universal links (§5).

---

## 2.  Agent tasks — what an agent can do without you

These are safe for an agent with the ASC key.  Marked ✅ when done.

- [x] ✅ **Attached build `202608202100` to version 1.0.0** (HTTP 204), replacing the stale Aug-15 binary.  This also moved the version out of REJECTED into PREPARE_FOR_SUBMISSION.
- [x] ✅ **Replaced the App Review Information notes** (HTTP 200).  The old 3,906-character notes
      described an "Email Link" sign-in that PR #2010 removed and a build predating account deletion;
      the new 3,443-character notes answer Apple's three items point by point.  Source of truth:
      `.review-shots/asc/REVIEW-NOTES.txt` (rendered from `REVIEW-NOTES-DRAFT.md`).  **Add one line
      naming your attached recording once it exists.**
- [ ] **Cancel submission `b61e2a4a`** (state UNRESOLVED_ISSUES).  The previous cycle had to cancel
      `37412b30` the same way before the version could be added again.
- [ ] **Create the new review submission with three items**: the app version **and both
      subscriptions** (`trade.congress.premium.monthly`, `trade.congress.premium.annual`).  Attaching
      the subscriptions is the entire fix for Guideline 2.1(b).
- [ ] **Submit** — only after your video is in the notes.
- [ ] **Watch the state** and report `WAITING_FOR_REVIEW` → `IN_REVIEW` → outcome.

### Agent tasks that are not blockers but should land before submit

- [ ] **Premium sheet on iPad** still renders as a narrow floating card.  PR #2094 deferred this one
      line because another agent held `PremiumSheet.swift` at the time; that file is now free.  The
      fix is `.iPadFullWidthSheet()` (already defined in `Components.swift`) applied at
      `clients/ios/CongressTrade/App.swift:270`.  A reviewer on an iPad will open exactly this sheet
      to check the 5.1.1(v) fix, so it is worth the one line.
- [ ] Merge the two open web PRs — #2072 (accessibility) and #2082 (Pushover premium alerts).
      Neither affects the iOS submission.

---

## 3.  Pre-submit verification — run through this on the TestFlight build

Do this on **`202608202100`** on a physical device.  Each line is something a reviewer can check.

- [ ] Launch as a **signed-out** user.  The app is fully browsable — Trends, Trades, Directory all
      show data with no account.
- [ ] Open **Premium** from the ≡ menu while signed out.  **Both plans are purchasable.**  There is
      no "sign in first" wall.  This is the 5.1.1(v) fix; if this is wrong, do not submit.
- [ ] The sign-in offer on that screen reads as **optional** and says what it adds (other devices,
      Delivery alerts).
- [ ] **Restore Purchases** is reachable while signed out.
- [ ] Sign in → ≡ menu → **Delete Account** exists, confirms, and completes without email or a
      phone call.
- [ ] On **iPad**: detail sheets use the full width, Directory → Assets is a two-column grid,
      Delivery text is not full-bleed, and the ≡ menu is reachable from every tab.
- [ ] Executive-branch filers show a real position ("President"), never the word "Executive".
- [ ] No placeholder or debug UI anywhere.

---

## 4.  The video — exact order to record

Record **on your physical iPhone**, portrait, with the app installed from TestFlight build
`202608202100`.  Keep it under ~2 minutes.  Do not edit or speed it up — App Review wants an
unbroken flow.  Screen recording via Control Centre is fine; no narration needed.

**Video 1 — account deletion (required by Apple).**

1. Start the recording on the **home screen**, then open Congress.Trade, so the launch is visible.
2. Tap the **≡ / profile button** in the top right.
3. Tap **Sign In**, and sign in with Apple (or Google).  Let the account finish loading so the
   account row shows your email — the reviewer needs to see an account exists.
4. Return to the ≡ menu.  **Scroll so the whole menu is visible**, including the Delete Account row.
5. Tap **Delete Account**.
6. Show the **confirmation prompt** clearly — pause a beat so it is readable.
7. Confirm.
8. Show the app **returning to the signed-out state**.
9. Re-open the ≡ menu once more to show you are signed out.
10. Stop the recording.

**Video 2 — purchase without an account (optional, but it pre-empts the 5.1.1 argument).**

1. Start on the home screen and launch the app **without signing in**.
2. Open ≡ → **Premium**.
3. Show that **both plans are tappable** and there is no sign-in gate.
4. Show the copy that says signing in is optional.
5. Stop.  **Do not complete a purchase** — showing the paywall is reachable is the point.

**Then:** send me both files, or drop them in `.review-shots/asc/`, and I will attach them and write
the notes around them.  If you prefer to do it yourself: App Store Connect → the 1.0.0 version →
**App Review Information** → Notes / attachment.

---

## 5.  Universal links — needs the iOS seat, not blocking release

The web half is live and verified: `https://congress.trade/.well-known/apple-app-site-association`
returns 200 `application/json`, excludes `/auth/*` and `/api/*` before its four query matchers, and
carries `CC8UTF7ATG.trade.congress.ios` (PR #2076).  Two legs remain, both inside `clients/ios`:

1. Add `com.apple.developer.associated-domains` = `applinks:congress.trade` **via Xcode's capability
   UI** — never hand-edit the entitlements file — and enable Associated Domains on the App ID.
2. Handle `onContinueUserActivity(NSUserActivityTypeBrowsingWeb)`, parse `member` / `ticker` /
   `trade` / `view`, route to the same destinations the web app uses, and leave the existing
   `congresstrade://auth` branch alone.
3. Verify with `xcrun simctl openurl booted "https://congress.trade/?member=<slug>"`.

Until those land, congress.trade links open Safari rather than the app.  That is not a review
blocker, but it is the difference between a shared trade opening the app and not.

---

## 6.  Known gaps that are deliberately not blocking

- **Smart app banner and site banner are dark** until `IOS_APP_STORE_ID` is set — deliberate, so the
  site never advertises a listing that is not live (§1d).
- **Apple IAP activations report as "paid"** in the Pushover alert even on a trial; Apple's decoded
  payload carries no trial flag in this codebase, while Stripe's distinction is exact (PR #2082).
- **iPhone before/after screenshots** for the iPad layout work were not captured — the iPhone
  simulator became unresponsive under heavy concurrent load.  Every iPad change is gated behind
  `horizontalSizeClass == .regular`, so iPhone is a no-op by construction, but it was not visually
  re-verified.

---

## 7.  If Apple rejects again

1. Read the Resolution Center message before changing anything.
2. Check whether the cited build is the one you think it is — a stale attached build caused this
   exact cycle once already.
3. Reply in Resolution Center rather than resubmitting blind; Apple answers questions there.
4. Update this file with what they said and what changed.
