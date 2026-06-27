# STRManagement (StayOps) — Full Code Analysis

**Date:** 2026-06-11 · **Scope:** entire repo — `assets/js/` (frontend), `Netlify/functions/` (backend), `supabase/functions/`, `index.html`, config/scripts. Analysis only; no code changed, no services contacted.
**Method:** six parallel deep-read audits (frontend core, finance, bookings/cleaning, settings/AI, calendar backend, other backend), with cross-repo grep verification of every dead-code claim and spot-checks of critical findings.

Severity legend: 🔴 critical · 🟠 high · 🟡 medium · ⚪ low

---

## 1. BROKEN

### Backend

#### 🔴 1.1 Empty/partial iCal feed mass-cancels real bookings
`Netlify/functions/ical-sync.js:73-74, 176-204`
`fetchFeed` only throws on non-2xx. A 200 response that is truncated, an HTML error page, or an empty body parses to **zero events**, so `liveUids` is empty and the "UID disappeared → soft-cancel" sweep cancels **every** booking on that feed — and notifies cleaners and deletes calendar events. (Verified: no guard between parse and the sweep.)
**Fix:** skip the disappearance sweep when `events.length === 0`, when the text lacks `BEGIN:VCALENDAR`, or when the live set shrank past a sanity threshold.

#### 🔴 1.2 Scheduled `poll-emails` edge function scans zero users
`supabase/functions/poll-emails/index.ts:47-50`
It selects users via `app_config.gmail_refresh_token` — a column nothing in the repo ever writes (Gmail OAuth stores tokens in `email_connections`, `gmail-oauth-callback.js:86-88`). The background email scan always finds 0 users; enrichment only works because the frontend auto-scans on boot. It also never scans Outlook, and nothing in the repo schedules it (the `cron.schedule` SQL is commented out).
**Fix:** query `email_connections` (`provider='google'`/`'microsoft'`, `refresh_token not null`), or delete the function and document that scanning is frontend-driven.

#### 🔴 1.3 Cleaner cancellation notifications never send (wrong booking ID type)
`Netlify/functions/utils/notify-cleaner-cancellation.js:60-64`; callers `utils/email-scan-shared.js:630-634`, `ical-sync.js:105-109`
The helper queries `cleans?booking_id=eq.<bookingId>` but callers pass `match.id` (cloud UUID) while `cleans.booking_id` stores the booking's **local_id** (see `cleaner-action.js:207` comment, `assets/js/supabase.js:729`). Zero rows match → cleaners are never emailed about cancellations, `cleaner_cancel_notified` never flips, and `send-clean-reminders.js:79` then sends **reminders for cancelled bookings**.
**Fix:** pass `match.local_id` / `prior.local_id` (or query `booking_id=in.(local_id,id)`).

#### 🔴 1.4 Deprecated Claude model retires 2026-06-15 — four days away
`Netlify/functions/ai-proxy.js:16`; callers `assets/js/ai.js:488,784`, `assets/js/finance.js:6000`, `assets/js/bank-import.js:446`
`claude-sonnet-4-20250514` is deprecated with retirement June 15, 2026. AI insights, finance analysis, and bank-statement PDF parsing will start 404ing within days.
**Fix:** migrate allowlist + call sites to `claude-sonnet-4-6` now.

#### 🟠 1.5 `calendar_sync_state` upserts have no `on_conflict` target — merge never happens
`Netlify/functions/utils/calendar-push-core.js:55-61, 163-175`, `utils/calendar-reconcile-google.js:42-48`, `utils/calendar-reconcile-outlook.js:44-50` (schema: `scripts/calendar-sync-migration.sql:24-29`)
`Prefer: resolution=merge-duplicates` without `?on_conflict=...` is ambiguous when the table has **two** unique indexes; the "update existing mapping" path 409s and the failure is invisible (`return=minimal`, no `res.ok` check). Etags/`provider_updated_at` never advance, so the echo guard misfires and sync-state rows go stale. The same missing-`on_conflict` pattern affects the bookings insert in `ical-sync.js:121-149` (dedupe of overlapping sync runs depends on a DB constraint the request never names).
**Fix:** add explicit `?on_conflict=` to each upsert and check `res.ok`.

#### 🟠 1.6 Email-scan booking insert failure is counted as success and never retried
`Netlify/functions/utils/email-scan-shared.js:906-927`
`insertNewBooking` returns `null` on failure, but the else-branch still does `results.imported++` and pushes the message ID into `skipped_ids` — the booking is silently lost forever while the user sees "imported".
**Fix:** count as `errors` and don't persist the msgId to skipped on failure.

#### 🟠 1.7 Transient Claude API failures permanently blacklist booking emails
`Netlify/functions/utils/email-scan-shared.js:517-525, 539-550`
A 429/529 or `JSON.parse` throw returns `null`, which is treated identically to "not a booking": msgId goes into `skipped_ids` and is never re-scanned. One bad API minute = dropped bookings.
**Fix:** distinguish transient errors from `not_a_booking`; only blacklist definitive outcomes.

#### 🟠 1.8 Cancellation/modification/enrichment PATCHes never check the response
`Netlify/functions/utils/email-scan-shared.js:595-608, 669-671, 767-769, 866-868`
A failed `bookings` PATCH (RLS/5xx) still increments success counters, pushes "Cancelled/Updated" to the host, and permanently marks the email processed. A real platform cancellation can be silently lost while the host is told it was handled.
**Fix:** check `res.ok`; on failure count as error and don't add to `skipped_ids`.

#### 🟡 1.9 Outlook Graph search misses subject forms Gmail catches
`Netlify/functions/outlook-scan-bookings.js:158-159` vs `gmail-scan-bookings.js:185`
The Graph `$filter` lacks `updated`, `update`, `request`, `arrival` — Outlook users never get "Reservation updated"-style modification emails fetched at all.

#### 🟡 1.10 `daily-notifications` review-cost lookup: unchecked error, cross-tenant, fragile filter
`Netlify/functions/daily-notifications.js:343-350`
`id.eq.<text-local-id>` against a uuid column makes PostgREST error; `error` is never checked so the "fee already entered" guard never fires (repeated false "Review Cleaning Cost" pushes). The query also has no `user_id` filter (cross-tenant local_id collisions) and `.or()` breaks on ids containing `,`/`(`.

#### 🟡 1.11 Google reconcile 410 (expired sync token) bails instead of full-syncing in the same call
`Netlify/functions/utils/calendar-reconcile-google.js:246-258` — sets `sync_token=null` and returns; the recovery full-sync only happens on the *next* trigger, so webhook-driven changes can be delayed up to 15 min.

#### 🟡 1.12 iCal single-day VEVENT yields a 0-night stub
`Netlify/functions/utils/ical-parse.js:91-99` — `checkout: ev.dtend || ev.dtstart` makes checkout == checkin when DTEND is absent.

#### ⚪ 1.13 `ai-proxy` "Model not allowed" response missing CORS headers
`Netlify/functions/ai-proxy.js:60-62` — browser sees an opaque CORS failure instead of the 400 body.

#### ⚪ 1.14 `send-clean-reminders` comment contradicts code; failed sends never retried
`Netlify/functions/send-clean-reminders.js:188-193` — marks `reminder_sent` only on success (comment says "regardless"), but the next run's `clean_date = tomorrow` window means a failed reminder is never retried.

### Frontend — data correctness

#### 🔴 1.15 The late-cancel "$0" bug: root cause chain
`assets/js/booking-revenue.js:46-55` (+ `assets/js/supabase.js:1568`, `utils` date handling)
The rollups (report/revenue/management/tax) all correctly use `isRevenueBearingBooking`, but:
- **Null = excluded.** `getCancellationBillable` returns `true` only on `cancellation_billable === true`. Any cancellation reaching the DB without the flag (notably the documented Supabase trigger that intercepts raw `.delete()` and just sets `status='cancelled'`) hydrates as `null` → treated as not billable → **$0 even inside the 14-day window**. There is no fallback to `isCancellationInsideWindow()`.
- **Billable but still $0.** `bookingRevenue()` returns `hostPayout`; an iCal stub cancelled before email enrichment has `host_payout = 0`, so even a correctly-flagged late cancel contributes $0.
- **Boundary off-by-one.** `daysUntilCheckin` (lines 35-40) uses `toISOString()` (UTC) for "today" — for an AEST user before ~10am the 14-day window shifts by a day.
**Fix:** when the flag is null, fall back to the window check using `cancelledAt`; use local dates; surface "billable but $0 payout" stubs in the UI.

#### 🔴 1.16 Bank import double-counts matched rows and books platform deposits as expenses
`assets/js/finance.js:927-948`
After `confirmTransaction`, a `local` expense object is pushed into `expenses` for **every** row: `matched` rows duplicate an expense already in memory (double-counted totals/tax until reload), and **credit** rows (whose result has no id/amount) fall back to `r.amount` — an Airbnb payout is pushed and persisted as an *expense*.
**Fix:** only push when `row.action === 'created'`; never push credits.

#### 🔴 1.17 Cancelling a booking deletes cleans/notes of *other* bookings by the same guest
`assets/js/bookings.js:1513-1540`
The orphan sweep falls back to a name-only match (`c.guestName === deletedGuestName`): a repeat guest cancelling one stay deletes the clean and notes for their other upcoming stay — in memory **and** in Supabase (lines 1580-1612). Silent data loss.
**Fix:** require the clean date to match the cancelled booking's checkout, or drop the name fallback.

#### 🟠 1.18 ATO tax export dumps most default categories into "Sundry"
`assets/js/finance.js:103-113` vs `3850-3862` — `ATO_CATEGORY_MAP` lacks entries for the actual defaults (`Utilities`, `Council Rates & Strata`, `Mortgage`, `Furnishings & Linen`, `Advertising`, and all `Parent > Sub` values), so council rates / mortgage interest / advertising export as "Sundry" on a tax document.
**Fix:** map every `DEFAULT_EXPENSE_CATS` entry; strip `> Sub` suffixes before lookup.

#### 🟠 1.19 Owner-paid expense classification misses default categories → wrong owner payout
`assets/js/finance.js:1788-1819` — `'Council Rates & Strata'` normalizes to `'council_rates_&_strata'` and never matches the owner-paid list (`'Mortgage > Interest'` likewise); in "deduct" mode these are wrongly subtracted from the monthly owner payout.

#### 🟠 1.20 Booking.com/Stayz revenue mislabeled "Direct" on tax PDF; missing from report columns
`assets/js/finance.js:4626-4638, 1610, 1691-1702` — hardcoded `['Airbnb','VRBO','Direct']` buckets everything else into "Direct" (wrong income-source attribution on a tax doc); in `renderReport` the same list means platform columns don't sum to the total.

#### 🟠 1.21 Mixed local/cloud booking ids in `cleans.booking_id` break cleaner-side cancellation detection
`assets/js/cleaning.js:263, 317, 1330` (local id) vs `1600` (cloud uuid); consumer `assets/js/supabase.js:174-180`
`loadCleanerDashboard` runs `.in('id', bookingIds)` against `bookings.id` (uuid) — numeric local ids never match, so `_bookingCancelled` is never set for cleans created via `addClean`/auto-assign; the cleaner PWA keeps showing cancelled jobs as active. (Also the direct cause of backend bug 1.3.)
**Fix:** always write `booking._cloudId || booking.id`; backfill on save.

#### 🟠 1.22 `toISOString()` "today" is wrong every AEST morning (systemic)
`assets/js/bookings.js:585,766`, `cleaning.js:369`, `property.js:675`, `cleaner-ui.js:37,50-51`, `finance.js:1172,3057,3309,3369,2877-2879,3872-3873,6194`
`toISOString()` returns the UTC date — in UTC+10, until ~10am it's *yesterday*: arriving/departing badges, cleaning timeline, the cleaner's "next clean", and default expense/payout dates all shift a day (an expense entered 1 July before 10am lands in the prior FY). Related: bare `new Date('YYYY-MM-DD')` parses as UTC midnight (`bookings.js:455-457,562-565`, `finance.js:1618,1826,4439`) — the codebase has correct local helpers (`parseLocalDayStart`, `_bkCalYmd`, `toLocaleDateString('en-CA')`) used inconsistently.
**Fix:** one `localTodayYmd()` + `parseLocalDate()` helper, used everywhere.

#### 🟠 1.23 Recurring expenses generated without a property → hidden locally, mis-assigned in cloud
`assets/js/recurring.js:84-99` — the generated expense has no `_propertyId` (invisible to the property-scoped expense list until reload), and `saveExpenseToCloud` stamps whatever property is *active*, not the template's.

#### 🟠 1.24 Straight-line depreciation over-deducts in the final year
`assets/js/depreciation.js:102-122` — the FY containing end-of-life still deducts a full year; a mid-FY purchase totals ~5.5× annual on a 5-year asset. Tax PDF/CSV use the unclamped path.
**Fix:** cap at remaining undepreciated value.

#### 🟠 1.25 "View invoice" regenerates with a NEW invoice number
`assets/js/finance.js:2294-2310, 2375-2380` — viewing a historical invoice rebuilds it with the next sequence number and today's date; "Mark as issued" there creates a duplicate record for the same bookings.

#### 🟠 1.26 Maintenance delete never removes the item (string vs number `!==`)
`assets/js/render.js:2434` — onclick passes a string id, `m.id` is a number, so `filter(m => m.id !== id)` removes nothing; the follow-up `savePropertyData()` re-upserts the "deleted" item racing the fire-and-forget cloud delete. Same bug in the inventory modal (`render.js:2576`) — which additionally has **no cloud delete function at all**, so inventory rows always resurrect on hydration.

#### 🟠 1.27 Booking detail Notes never match; Notes tab renders "undefined" after reload
`assets/js/bookings.js:768` (`n.bookingId === id` — number vs string strict compare, and cloud-vs-local id confusion) and `663-673` vs `assets/js/supabase.js:819-825` — `loadNotesFromCloud` maps only `{content,date}` (no `bookingId`/`text`/`tag`/`guestName`), so notes lose their booking link on every reload and the tab prints literal "undefined".

#### 🟠 1.28 "Remove calendar feed" is broken — wrong `showAppModal` signature
`assets/js/settings.js:1786-1799` — calls `showAppModal(title, msg, callback)` but the API (`render.js:2634`) takes one options object and returns a Promise. The modal shows blank text and the delete callback never runs: **iCal feeds cannot be removed from the UI.**

#### 🟠 1.29 Onboarding-v2 wizard performs no real signup/login/verification
`assets/js/onboarding-v2.js:578-674` — calls `handleSignUpSubmitFromOnboarding` and `addCleanerFromOnboarding` (don't exist anywhere), passes args to `handleLoginSubmit`/`handleVerifySubmit` which ignore args and read DOM fields that aren't in the overlay, advances past OTP **regardless of verification result**, and passes a property object to `savePropertyData()` which takes no params (property silently discarded). Currently moot only because nothing ever launches the wizard (see Dead Ends 2.1).

#### 🟠 1.30 Push re-subscribe is destructive on failure
`assets/js/notifications.js:305-315` — the working subscription is unsubscribed *before* permission is requested/new subscribe runs; on denial/failure the device is left unreachable while the server keeps pushing to the dead endpoint. Onboarding's `subscribeToPush()` call (`onboarding-v2.js:648-653`) also omits the `role` arg, so the subscription is never stored server-side.

#### 🟡 1.31 Edit-modal "Owner Payout" preview omits the management fee
`assets/js/bookings.js:1262-1272` vs `1293-1297` — preview shows `host − cleaning`; save stores `host − cleaning − mgmtFee`. User sees one number, gets another.

#### 🟡 1.32 Advanced booking filter sheet is a complete no-op
`assets/js/bookings.js:2201-2204` — `applyBookingFilters()` just closes the sheet and re-renders; `renderBookings()` never consults `_bkFilterState`. The whole sources/status/date-range sheet changes nothing.

#### 🟡 1.33 Desktop "Today's Activity" can never show cleans
`assets/js/render.js:1734-1744` — reads `window.cleans` (never assigned anywhere; the module import is `cleans`) and snake_case fields (`c.cleaner_id`) on camelCase objects.

#### 🟡 1.34 Monthly Statement math is wrong (and the view is unreachable)
`assets/js/finance.js:5446-5464` — adds `cleaningFee` on top of `hostPayout` (other reports subtract it; `netPayout` already nets it out), `b.platformFee` is not a real field (always 0), and the Share/PDF buttons export the FY report instead of the statement. See Dead Ends 2.9.

#### 🟡 1.35 Settings property cards always show "iCal: None" / "0 bookings"
`assets/js/settings.js:959, 1668` — reads `window._icalFeeds` / `window._bookings`, neither of which is ever assigned anywhere in the repo.

#### 🟡 1.36 Cleaner calendar can't navigate to January
`assets/js/render.js:4596-4598` — `window._cleanerCalMonth || today.getMonth()`: month 0 is falsy, so navigating to January resets to the current month. Use `??`.

#### 🟡 1.37 Quick actions broken: "Message" blanks the app; "New Booking" clicks a nonexistent button
`assets/js/render.js:1700` — `showSection('messaging')` hides all sections (no `section-messaging` exists, no fallback in `showSection`). `render.js:1688` + `index.html:2869,2976` — three entry points click `#add-booking-btn`, which exists nowhere.

#### 🟡 1.38 Expense-category migration runs before hydration — permanent no-op
`assets/js/render.js:2688-2719` — the migration IIFE runs at module load over an empty `expenses` array; `resolveIssue` (render.js:2413) meanwhile still creates expenses with the old category it was meant to rewrite.

#### 🟡 1.39 `syncCalendarNow` reports "✓ Synced" on server errors
`assets/js/settings.js:228-239` — no `res.ok` check; a 500 renders "✓ Synced — 0 applied". (Sibling `resyncStayOpsCalendar` checks correctly.)

#### 🟡 1.40 Email content toggles for pay/hours are no-ops
`assets/js/notifications.js:998-999` — both ternary branches are `''`; the "Show pay"/"Show estimated hours" settings toggles have zero effect.

#### 🟡 1.41 Inline email-template preview throws on every keystroke
`assets/js/notifications.js:781,787,800` — `oninput="updateEmailPreview(...)"` but `window.updateEmailPreview` is never assigned in main.js → ReferenceError each keystroke.

#### 🟡 1.42 Owner-report banner shows raw HTML as text
`assets/js/render.js:4106-4110` + `utils.js:122` — `showBannerToast` uses `textContent`, so the user sees literal `<a href=...>` markup; the third (duration) argument doesn't exist in the signature.

#### 🟡 1.43 OAuth return during onboarding targets removed elements
`assets/js/main.js:912-915` + `render.js:3887-3896` — `onboardEmailConnected` writes to `ob-email-connected` / `ob-step2-continue`, which no longer exist; users returning from OAuth get no "connected" feedback.

#### 🟡 1.44 In-page login/signup skips half the boot wiring
`assets/js/supabase.js:2536-2540, 2781-2812` vs `main.js:960-1006` — the login paths never run `maybeAutoSyncICal`, `installCalendarSyncOutbound`, `triggerCalendarReconcileNow`, etc.; iCal + outbound calendar sync are inert until the next full page reload. Three diverging copies of the boot sequence.

#### 🟡 1.45 Gmail token-expired flag never clears on recovery
`assets/js/settings.js:401-407` vs Outlook's `527-532` — asymmetric handling; Gmail keeps showing "token expired" after recovery until reload.

#### ⚪ 1.46 Misc small breaks
- Airbnb CSV import writes its error to the wrong element (`bookings.js:1681` → `#import-preview` instead of `#airbnb-import-preview`) — bad files show no feedback.
- Screenshot-extract button stays disabled after success (`ai.js:775-825`) — no `finally` reset.
- `reassignClean` not-found path calls `showDetail(cleanId)` with a clean id — silent no-op (`cleaning.js:1085-1089`).
- Cancelled rows in the cleaning view have no "notify cleaner" action despite the state machine defining one (`cleaning.js:679-727` vs `93-95`).
- Cleaner Accept/Decline/Done match only local `id`, but cleaner-ui passes `_cloudId` first (`cleaner-ui.js:226` vs `cleaning.js:1420,1468,1523`) — silent no-op in the fallback data path.
- Airbnb-fetched property type never applied: `if (t && !t.value)` is always false for a `<select>` (`setup.js:440`).
- "Clear Cache & Re-sync" clears nothing — just reloads (`settings.js:1030-1041`; both index.html buttons promise a data clear).
- `openSettingsCat` touches `Notification.permission` without a support check — throws on iOS Safari non-PWA (`settings.js:724`).
- SMS template placeholders replaced only once — `String.replace` with string patterns (`notifications.js:503-510`).
- Cleaner cards show `€` not `$` (`cleaning.js:847`).
- Messaging "Active Cleans" grouping compares `messages.cleaner_id` (uuid) to local clean ids — likely never matches (`messaging.js:255-262`).
- Add-property flow races a 250ms `setTimeout` navigation against an un-awaited cloud save (`setup.js:348-369`).

---

## 2. DEAD ENDS

(All verified with repo-wide grep, including string-literal/inline-onclick call sites.)

1. 🟠 **`onboarding-v2.js` (714 lines) is entirely unreachable** — `window.runOnboarding` (main.js:314) is assigned but never called anywhere. Combined with finding 1.29: delete or wire up properly.
2. 🟠 **Legacy dashboard calendar stack is dead** — `#cal-grid`/`.dashboard-calendar` exist nowhere: `renderCalendar()` (bookings.js:486), `_calNavigate`/`attachCalSwipe` (render.js:4118-4196), `calPrev`/`calNext` (main.js:467-469), `openCalPreview`/`closeCalPreview` + the `#cal-preview-content` modal (index.html:2499).
3. 🟠 **v2 cleaner active-clean flow unreachable** — `showCleanerActive` (cleaner-ui.js:250) is window-assigned but never invoked → the timer/checklist screen, `toggleCleanerCheckItem`, and the only caller of `completeCleanerClean` are all dead.
4. 🟠 **Monthly Statement view unreachable** — no caller of `showStatementView()`/`showFinanceSub('statement')` anywhere; full feature incl. owner-statement mode is orphaned (`finance.js:5411`, `index.html:1300`). Also `backToFinanceHub` doesn't hide it (finance.js:1049-1052) and `renderFinance()` has no branch for `recurring|depreciation|statement` — sync renders kick users back to the hub.
5. 🟠 **Reconciliation "undo" exports have no UI** — `unlinkTransaction`, `unlinkPayoutFromTransaction`, `autoReconcile`, `findMatchesForExpense` (reconciliation.js:130-409): no way to un-reconcile a wrong link even though the code exists.
6. 🟠 **Custom email-template editor persists data nothing reads** — `app_config.email_templates` is saved (notifications.js:708-723) but every send uses server-side static templates (`send-email.js:28-33`); the entire editor (presets, variables, colors) has zero runtime effect. Backend twin: `bookingConfirmation`/`monthlyReport` templates in `utils/email-templates.js:174-311` have no caller.
7. 🟠 **`calendar-backfill-background.js` has no caller** — not in netlify.toml, never fetched from the frontend (settings uses `calendar-resync`); as a `-background` function the UI couldn't call it synchronously anyway.
8. 🟠 **`monthly-revenue-summary` has no scheduler in the repo** — not in netlify.toml, no `schedule()` wrapper, no pg_cron SQL (only daily-notifications has one). Unless configured out-of-band it never fires.
9. 🟡 **`refreshFinanceReconciliationSummary` guard always false** — defined module-local, checked as `globalThis.refreshFinanceReconciliationSummary` (finance.js:329 vs 6259) — post-payout summary refresh never runs. (One-line fix.)
10. 🟡 **Inert deferred-render mechanism** — `_refreshAfterDataChange` (render.js:419-435) never called, so every `_flushPendingUiRefresh()` is a no-op; `_hasOpenModal` checks `style.display` but modals toggle a class.
11. 🟡 **Write-only `cleaner_learning`** — `updateCleanerLearning` (cleaning.js:1202-1299) writes config the suggestion engine never reads (it reads `cleaner_automation`); two parallel learning systems, one dead.
12. 🟡 **Settings dead surface** — `saveGeminiKey` (no `#settings-gemini-key` element exists; settings.js:1053), `saveApiKey`/`getApiKey` + Anthropic-key panel (key stored but no consumer — all AI goes through the proxy; settings.js:1062-1077, see also Risk 4.14), `manageHostIdentity`/`HOST_PROFILE_KEY` (1079-1099), PIN-by-id handlers targeting unrendered `#pin-input-*` DOM (1519-1560), App-Data storage viewer with `DATA_KEYS = []` (1357-1358 — panel permanently blank).
13. 🟡 **Dead frontend functions (zero call sites)** — `quickAssignLastCleaner` (cleaning.js:283), `revealCleanerReassign` (cleaning.js:1158, targets nonexistent DOM), `toggleClean` (cleaning.js:1364), `saveCleaningFee` (bookings.js:1904), `getStatus`/`getBookingIdentityKey`/`editBooking`/`saveBookingEdit` (bookings.js:1872-2062), `togglePropertyDetail`/`jumpToPropertyCleaningAction`/`localPropertyIdFromCloudPropertyId` (property.js:40,431,421), `deleteInventoryItem`/`updateThreshold`/`jumpToScheduleClean` (render.js:2538,2508,546), `isAwaitingCleanerResponse`/`getAwaitingResponseMeta` (utils.js:35-55), `getSmartPricing` (smart-pricing.js:763), `bankImportConfirmAllSuggested` (finance.js:890), `switchFinanceTab`/`switchRevTab` + four deprecated tab shims + `toggleMgmtSelect`/`toggleExpenseMonth`/`_setVal` (finance.js, various), `loadCleaningJobsFromCloud` (supabase.js:805).
14. ⚪ **Misc** — unreachable `'declined'` branch in `toggleCleanAction` (cleaning.js:711-718); `#clean-name-select` fallback for an element that doesn't exist (cleaning.js:1312); login-toggle code targeting removed `#login-toggle-*` elements (supabase.js:2425-2444); `_pendingVerifyName` written never read (supabase.js:2635); `_bankImportJustImported` write-only (finance.js:197); per-property VAPID config round-trip ignored (config.js:425-427); messaging "Create maintenance task →" styled as a button with no handler (messaging.js:715); fake random "sync activity" histogram (settings.js:1638); `daily_notifications_last_aest_date` column created by SQL but never used by code (scripts/daily-notifications-cron.sql:8-12); unused exports `pushToProvider`/`PROVIDERS` (calendar-push-core.js:216), `gcal-client.getCalendar`, `outlook-cal-client.getEvent`, nine unused exports from `email-scan-shared.js:976-997`; unused `crypto` import (gcal-oauth-callback.js:18); leftover `scan_debug` insert in the production hot path (gmail-scan-bookings.js:285-301 — also a privacy issue, see 4.13).

---

## 3. SILENT FAILURES

#### 🔴 3.1 `saveCleanToCloud` swallows all errors — every cleaning success banner can lie
`assets/js/supabase.js:775-777` — catches and `console.warn`s only; every downstream `try/catch` around it (assign, accept, addClean, quickAssign…) is dead code, and "✓ Assigned" / "✅ Clean scheduled" show even when nothing persisted. State silently reverts on next hydration. Same pattern: `saveNoteToCloud` (867), `saveInventoryItemToCloud` (1426), `saveMaintenanceItemToCloud` (1503).
**Fix:** rethrow or return `{ok:false}` and honor it at call sites (the expenses retry-queue at supabase.js:932-995 is the in-repo model to copy).

#### 🔴 3.2 Supabase v2 `{error}` results widely discarded (writes)
- `saveCleanersToCloud` (supabase.js:664-671) — failed roster/PIN/permission saves vanish.
- `saveAppConfigToCloud` (supabase.js:2094-2095) — every settings write funnels here; failures silently evaporate on next hydration.
- Delete helpers `deleteCleanFromCloud`/`deleteExpenseFromCloud`/`deleteMaintenanceFromCloud` (supabase.js:793,1069,1518) — rows resurrect.
- `reconLinkToExpense` (finance.js:5285-5291) — always banners "✓ linked" (a checked twin, `linkTransactionToExpense`, already exists in reconciliation.js).
- Inbox triage inserts (settings.js:351-369) — a failed insert still marks the calendar event classified; the record never exists.
- Calendar disconnects (settings.js:176-209), `adminHandleToggle` (admin.js:540-558), `inviteCleaner` status update (cleaning.js:1259-1261), `cleaner_cancel_notified` update (bookings.js:1567-1569), mark-thread-read (messaging.js:291-298), `setActivePropertyId`/`saveUiPreferenceToCloud` (config.js:224-245 — logs "synced" even on error since PostgREST errors resolve, not reject), `send-push` stale-endpoint cleanup (send-push.js:176-181 — the `.catch` is dead code).
**Fix:** one `sbWrite()` helper that destructures `error`, logs, banners, optionally queues.

#### 🟠 3.3 Hydration loaders fail to empty arrays with zero logging
`assets/js/supabase.js:626, 689, 818, 901, 1372, 1447, 1548` — `if (error || !data) return null;` — a failed bookings/cleans query during boot renders an empty app with no console output, no Sentry, no banner. Boot failure itself is also swallowed (`main.js:1007-1011` — chrome shown over empty arrays). `loadPortfolioData` (property.js:828-895) same pattern.

#### 🟠 3.4 Outbound calendar push queue drops events permanently
`assets/js/calendar-sync-outbound.js:30-52` — the batch is spliced off the queue *before* auth/connected checks; any failure loses those pushes with no requeue. Backend twin: `clearPendingOutbound` (calendar-sync-reconcile.js:101-118) nulls `pending_direction` **without re-pushing** — a transient Google/Outlook outage permanently drops the change (calendar-push-core.js:196-211 only console.warns).

#### 🟠 3.5 Gmail OAuth callback reports success when the token save failed
`Netlify/functions/gmail-oauth-callback.js:90-98` — `dbError` is logged then ignored; user lands on `?oauth_success=google` with no connection saved. (Outlook's callback correctly throws.) Related: rotated Outlook refresh-token PATCH unchecked (`outlook-scan-bookings.js:140-143` — connection dies silently weeks later), `updateLastScan` unchecked both providers (gmail:84-96, outlook:51-63 — same non-booking emails re-sent to Claude every scan, pure cost).

#### 🟠 3.6 iCal sync's Supabase writes unchecked
`Netlify/functions/ical-sync.js:64-68, 94-103, 163-167, 180-189, 206-210` — every PATCH except one insert ignores the response; `result.cancelled++`/`updated++` increment regardless, so the UI reports success while the DB is unchanged.

#### 🟠 3.7 Notification sends fire-and-forget
`assets/js/cleaning.js:1663-1690` — assignment push un-awaited; email `.then` without `.catch` (unhandled rejection); a cleaner can be "assigned" with every channel failing and the host never knows. `notifyCleanerCancellation` results discarded by all callers (compounds backend bug 1.3). Settings saves banner-before-await throughout settings.js/notifications.js/ai.js (settings.js:1043-1052, 1071, 1139, 1457; notifications.js:187, 718; ai.js:113).

#### 🟡 3.8 Misc
- Chat bubble shows ✓✓ delivered ticks before the insert; on failure the "delivered" message was never persisted (messaging.js:325-340).
- Payout save counts a header with zero inserted lines as success (finance.js:6237-6240; `insertPayoutLines` returns `[]` on error).
- `confirmTransaction` partial save: bank row inserted, expense insert fails, no rollback — orphan appears as "Unaccounted" and re-import flags it duplicate forever (bank-import.js:860-919).
- Recurring generation advances `nextDue` regardless of save success (lost expense), and reverts on config-save failure (duplicate expense) (recurring.js:96-109).
- `deleteExpense` leaves `bank_transactions.expense_id` and booking-clean links stale (finance.js:3561-3571).
- `cleaner-data.js:47-100` parses Supabase REST bodies without status checks — outages masquerade as "Cleaner not found".
- Reconciler watch-renewal errors swallowed bare (`calendar-sync-reconcile.js:128-133`) — inbound sync can die invisibly; fail-open `loadCancelledBookingIds` (calendar-resync.js:42) re-pushes cleans for cancelled bookings.
- `showCleanerApp` load has no `.catch` (supabase.js:2617-2622).
- Auto-assign double-save race: `maybeAutoAssignPreferredCleaner` and `addBooking` both save the same new clean concurrently (cleaning.js:278 + bookings.js:1391-1394); `toggleCleanerConfirmed` saves the same clean twice (cleaning.js:1189-1193 — `saveCleaningJobToCloud` *is* `saveCleanToCloud`).

---

## 4. OTHER RISKS

### Security — critical

#### 🔴 4.1 `ai-proxy` is an unauthenticated open relay to the Anthropic API
`Netlify/functions/ai-proxy.js:19-64` (verified) — CORS `*`, no `verifyAuth`, caller-controlled model/messages and **unbounded `max_tokens`**. Anyone who finds the URL gets a free LLM API on the host's bill. **Fix:** require Supabase JWT (`utils/auth.js` already exists and is used by send-email/send-push/fetch-listing), clamp `max_tokens`, rate-limit.

#### 🔴 4.2 Scan/sync endpoints "authenticated" only by knowing a user UUID — which the app leaks
`gmail-scan-bookings.js:100-102`, `outlook-scan-bookings.js:67-69`, `ical-sync.js:215-262` (verified — no verifyAuth), `calendar-sync-reconcile.js:140`, `calendar-resync.js:51`
The uid is not secret: it's embedded in every shareable cleaner link (`notifications.js:1099-1102`) and the public calendar-feed URL. Consequences: trigger scans for any user and **read the scan summary** (guest names, dates, platforms), burn up to 20 Claude calls per request, or trigger ical-sync (combined with 1.1, deliberately cause false-cancel notifications). **Fix:** `verifyAuth` + assert `uid === auth.id`; cron paths via `x-cron-secret`.

#### 🔴 4.3 `cleaner-action` IDOR; cleaner endpoints effectively unauthenticated
`Netlify/functions/cleaner-action.js:56-90` (verified) — the cleans PATCH filters only `user_id + local_id`, never the acting `cleaner_id`: Cleaner A can accept/decline/complete Cleaner B's cleans (and `done` auto-creates expenses). The whole auth model is "knows uid + small-integer ids" — anyone with one cleaner link can enumerate everything. Same model in `cleaner-message.js` (spam → host pushes) and `cleaner-data.js` (reads guest names, `host_payout`, `cleaning_fee`; also PostgREST filter injection via cleaner name at :72-73). The client-side PIN check is decorative — the PIN is base64 of itself in the URL (`render.js:3144-3146`, `notifications.js:1100-1102`). **Fix:** add `&cleaner_id=eq.<cleanerUuid>` to the PATCH today; move to signed per-cleaner invite tokens.

#### 🔴 4.4 Prompt injection from email content → attacker-controlled bookings
`Netlify/functions/utils/email-scan-shared.js:485, 72` — sender check is `fromLo.includes('airbnb.com')` (matches `attacker@airbnb.com.evil.net`) and the raw body goes into the Claude prompt with no delimiting/hardening. A crafted email can emit `cancellation` JSON → real bookings soft-cancelled, cleaners notified, attacker text pushed to the host. (`generate-pricing-suggestions.js:431-439` shows the team already knows the mitigation.) **Fix:** anchor the sender domain match to the address suffix; wrap email content as delimited untrusted data; require confirmation-code matching for cancellations.

#### 🔴 4.5 OAuth `state` is an unverified user id — account-linking CSRF (all four flows)
`gmail-oauth-start.js:13` / `gmail-oauth-callback.js:20,77`, `outlook-oauth-callback.js:17,78` (accepts empty state → `user_id: null` row), `gcal-oauth-start.js:12`, `outlook-cal-oauth-start.js:14` — no nonce/HMAC/session binding; an attacker can bind their mailbox/calendar to a victim's account (then inject "bookings" via 4.4). **Fix:** HMAC-signed state with expiry, verified in callbacks.

#### 🔴 4.6 Production cron secret committed to the repo; endpoint returns all tenants' financials
`scripts/daily-notifications-cron.sql:23` (plaintext `x-cron-secret`), `monthly-revenue-summary.js:279-283` (response body includes every user's per-property gross/expenses/net). Both cron handlers accept anyone when `CRON_SECRET` is unset (daily-notifications.js:100-104). **Fix:** rotate the secret, scrub the SQL, make the env var mandatory, strip financials from the response.

### Security — high

#### 🟠 4.7 Stored XSS via untrusted guest names / external data in `innerHTML` (many sinks)
Guest names arrive from iCal feeds and AI-parsed emails — attacker-influenceable — and are interpolated unescaped:
- `main.js:618-634` (cancelled-booking prompt), `render.js:3343,3362` (legacy cleaner cards), `render.js:4279-4372` (cleaner view: guest, property, address, **lockbox codes**), `render.js:4708-4717` (cleaner profile).
- `bookings.js:666-671, 1016` (notes), `1062` (edit modal `value="${b.name}"` — attribute breakout), `cleaning.js:1133-1153` (option lists).
- `settings.js:1265-1316, 1501-1504` (team list/profile — cleaner names/phones raw, `escHtml` imported but unused here).
- `ai.js:136-145, 189-227` (AI output → innerHTML: indirect prompt-injection→XSS channel), `notifications.js:884-947` (guest names into email HTML).
- `finance.js:2722-2730` (clients list), `2798-2809` (merchant autocomplete — bank-CSV content), `2410-2498` (invoice PDF fields).
- `index.html:3021` (context menu builds `onclick` strings from guest names — `"` breaks out of the attribute).
A crafted guest name executes script in a session holding the Supabase JWT. **Fix:** mechanical `escHtml()` pass plus an auto-escaping `html\`\`` tagged-template helper to make it the default.

#### 🟠 4.8 `fetch-listing` SSRF — regex matches anywhere in the URL
`Netlify/functions/fetch-listing.js:151-162` — `https://169.254.169.254/?x=airbnb.com/rooms/1` passes the check and is fetched server-side, with page content reflected back. **Fix:** parse with `new URL`, pin host to airbnb domains, or rebuild the URL from the extracted room id.

#### 🟠 4.9 Public calendar feed keyed on the permanent, leakable user UUID
`Netlify/functions/calendar-feed.js:14-18` — the uid is the only credential; no rotation. Anyone with it gets guest names and the full booking calendar. **Fix:** random per-user feed token, rotatable.

#### 🟠 4.10 Webhook validation bypasses
- `gcal-webhook.js:62-66` — channel token only checked **if present**; omit it and the guard is skipped.
- `outlook-cal-webhook.js:65` — `every(n => n.clientState && n.clientState !== expected)` passes when clientState is **missing**. **Fix:** require present-and-matching in both.

#### 🟠 4.11 Gmail refresh token logged in plaintext on every scan
`gmail-scan-bookings.js:126-133` — `console.log('[gmail-scan] connRows:', JSON.stringify(connRows))` includes `refresh_token`. Delete the line. Related: token-refresh failures dump full token-endpoint responses (`calendar-token.js:63,84`); OAuth tokens stored plaintext in `email_connections`.

#### 🟠 4.12 `send-email` open relay / `send-push` cross-tenant targeting (authenticated)
`send-email.js:28-35` — any authenticated user (cleaners have accounts) can send arbitrary HTML to arbitrary recipients via the host's Resend; `send-push.js:88-187` — caller-supplied `user_id` lets any user push spoofed notifications to any other. **Fix:** derive targets from the verified token; restrict recipients.

#### 🟠 4.13 `scan_debug` writes raw guest-email excerpts + parsed PII on every scan, unbounded
`gmail-scan-bookings.js:285-301` — self-labeled TODO debug code in the production path. Remove.

### Data integrity / races / performance

#### 🟠 4.14 Anthropic API key collected, cloud-synced, and mirrored to localStorage — for a feature that doesn't use it
`settings.js:1062-1077`, `supabase.js:444`, `index.html:2355` (copy claims "stored on this device only" — false). Remove the panel and the column write.

#### 🟠 4.15 Concurrent-sync races
- No per-user serialization between webhook reconcile, 15-min cron, and outbound push (calendar-sync-reconcile.js:148-155 + webhooks) — duplicate local inserts possible given 1.5.
- Email scans: boot auto-scan + manual scan + (intended) poller share no lock; a confirmation + modification pair processed in parallel inserts two rows (email-scan-shared.js).
- Frontend: `hydrateFromCloud` has no in-flight guard and fires from ~6 triggers including visibilitychange+pageshow together (main.js:894, render.js:2252, 2752, 2762, 2776); the 60s clean-poll re-renders unconditionally and can't see deletions (`render.js:2776-2782` — `.length` guard), and wholesale `replaceArrayInPlace` swaps objects out from under open edit modals (lost edits).
- `addBooking` has no double-submit guard (bookings.js:1351-1405) — double-tap creates two bookings (addClean has a lock; copy it).

#### 🟡 4.16 Other integrity items
- Cleared fields can never be cleared in the cloud — empty strings filtered from upserts and `_deepMerge` skips them; old values resurrect (supabase.js:526-531, config.js:547).
- `Storage.prototype` monkey-patch leaks legacy unscoped keys (API key, clients, bank data) from property A into newly-created property B; also patches sessionStorage (config.js:106-151).
- Re-pasting a payout statement duplicates `platform_payouts` — no dedupe key (finance.js:6150-6256).
- In-memory clean dedupe never deletes the loser cloud row — duplicates resurrect every hydration and the server reminder job may email from the "removed" row (cleaning.js:142-171).
- `parseAUDate` assumes DD/MM with no sanity check (US-format CSVs import with swapped day/month) and falls back to a UTC-shifting `new Date(s).toISOString()` (bank-import.js:66-84).
- "Host Management Income (All properties)" only covers the active property outside portfolio mode (finance.js:4463-4497 — label is wrong).
- Mgmt-fee % computed differently in the management view vs the invoice (finance.js:2030-2036 vs 2387-2392).
- Over-broad auth-failure matcher: any error containing "Invalid" nukes all `sb-*` localStorage + sessionStorage (supabase.js:31-49).
- Chat photos uploaded to a **public** bucket via `getPublicUrl` (messaging.js:427-439).
- No confirmation on cleaner deletion — one tap, permanent, while the profile panel stays open (settings.js:1246-1251).
- `_getBookingInvoiceMap` cache invalidation keyed on array length (finance.js:2245-2261).

#### 🟡 4.17 Performance
- Bank import: ~5 sequential Supabase round-trips **per row** (duplicate `checkDuplicates` pass ×2, per-row vendor-mapping and match queries — finance.js:735-737, 262-289; bank-import.js:621, 745, 769); a 200-row statement ≈ 1,000+ requests before the review UI shows. Batch with `.in()`.
- `hydrateFromCloud` awaits 8 table loads sequentially, each re-awaiting `getCloudPropertyId()` (supabase.js:1944-1969) — `Promise.all` it.
- `validatePropertyIds` downloads every booking row each boot just to log counts (supabase.js:1724-1747).
- Full `innerHTML` rebuild of the import review on every dropdown change (finance.js:804-831); messaging fetches 500 messages per list open (messaging.js:200-205); admin Devices tab fires a real push probe on open (admin.js:487-492).
- `renderAll()` rerenders the entire UI on every change — acceptable for now, but the inert deferred-render mechanism (Dead End 10) was clearly meant to fix the modal-clobbering side of this; finish it.

---

## 5. IMPROVEMENTS (prioritized)

1. **Lock down the backend surface** (4.1-4.3): `verifyAuth` on ai-proxy (+ max_tokens clamp + rate limit), gmail/outlook scan, ical-sync POST, calendar-sync-reconcile/resync; add the one-line `cleaner_id` constraint to cleaner-action's PATCH. Small diffs, closes the worst abuse vectors.
2. **Migrate off `claude-sonnet-4-20250514` before June 15** (1.4) and delete the refresh-token log line (4.11) in the same pass.
3. **Guard the iCal cancellation sweep** (1.1) — the single highest-blast-radius data bug.
4. **Fix the booking-id contract for cleans** (1.3 + 1.21): always store the cloud id in `cleans.booking_id`, pass `local_id` to `notifyCleanerCancellation`, backfill existing rows. Restores cleaner cancellation notices and stops reminders for cancelled bookings.
5. **Make writes honest**: a shared `sbWrite()` helper checking `{error}` (3.1, 3.2), `res.ok` checks in ical-sync/email-scan (1.6-1.8, 3.6), rethrow from `saveCleanToCloud`, and stop showing success banners before saves complete (3.7). This converts a dozen classes of silent data loss into visible, retryable errors.
6. **One date discipline** (1.22): `localTodayYmd()` + `parseLocalDate()`, ban `toISOString().split('T')[0]` and bare `new Date('YYYY-MM-DD')`. Fixes the every-morning status shift, FY boundary misfiles, and the late-cancel window boundary.
7. **Fix the money pipeline** (1.15-1.20, 1.24-1.25): late-cancel null-flag fallback, bank-import push logic, ATO + owner-paid category maps, dynamic platform columns, depreciation clamp, view-only historical invoices. These all misstate real dollars on reports/tax docs.
8. **Escape-by-default templating** (4.7): a tagged `html\`\`` helper that auto-escapes, plus a mechanical `escHtml` pass over the listed sinks. Structural fix for the XSS class.
9. **Harden OAuth + webhooks + tokens** (4.5, 4.10, 4.9, 4.6): signed state nonce, require webhook tokens present-and-matching, rotatable calendar-feed token, rotate + mandate CRON_SECRET, signed cleaner invite links replacing base64 PINs (4.3).
10. **Fix outbound-sync retry** (3.4): re-queue failed frontend pushes; make `clearPendingOutbound` actually re-push pending rows.
11. **Unify boot + hydration** (1.44, 4.15): one shared post-auth boot function; single in-flight `hydrateFromCloud` promise; parallelize table loads (4.17).
12. **Delete ~2,500 lines of dead surface** (section 2): onboarding-v2, legacy calendar stack, v2 cleaner active screen, dead settings panels, dead finance shims — or wire up the three "finished features one nav entry away from useful" (Monthly Statement, reconciliation undo, email-template editor → actually apply templates in send-email.js).
13. **Honest UI**: implement or relabel "Clear Cache & Re-sync", remove the random sync histogram, fix the always-zero feed/booking counts (1.35), re-enable the screenshot button, fix the broken quick actions (1.37).
14. **Observability**: route swallowed background failures (hydration loaders, watch-renewal, fail-open guards) to Sentry — sync death is currently invisible.
15. **Tests where money moves**: unit tests for `getCancellationBillable`, ATO mapping completeness (every default category resolves to a non-sundry field), depreciation totals ≤ cost−residual, and email-scan skip semantics.

---

## Top 10 — what I'd fix first

1. **Add auth to `ai-proxy` + scan/sync endpoints; fix the `cleaner-action` IDOR** (4.1-4.3) — unauthenticated spend, data exposure, and cross-cleaner actions, all small diffs.
2. **Swap the deprecated Sonnet model** (1.4) — hard deadline June 15; AI features break in days.
3. **Guard ical-sync against empty feeds** (1.1) — one transient bad fetch can cancel every booking on a feed and notify cleaners.
4. **Fix `cleans.booking_id` (cloud vs local id)** (1.3, 1.21) — cancellation notices never send; cleaners get reminders for cancelled stays and see cancelled jobs as active.
5. **Make email-scan failures retryable, not permanent** (1.6-1.8) — failed inserts/API hiccups currently delete bookings from existence while reporting success.
6. **Late-cancel revenue chain** (1.15) — null-flag fallback + UTC window fix + flag $0-payout billable stubs; this is the known "$0 in rollups" bug.
7. **Bank-import push logic** (1.16) — double-counted expenses and deposits booked as expenses corrupt finance data on every import.
8. **`sbWrite()` error-checking sweep** (3.1, 3.2) — the single highest-leverage reliability change; today most writes can fail invisibly while the UI says ✓.
9. **One local-date helper everywhere** (1.22) — every AEST morning the app shows the wrong day across bookings, cleaning, and finance defaults.
10. **`escHtml` pass + auto-escaping template helper** (4.7) — guest names from iCal/email are an XSS vector into sessions holding Supabase JWTs (including lockbox codes on the cleaner view).
