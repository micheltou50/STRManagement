# StayOps (STRManagement) — AI Context

> Shared context for AI assistants (Claude, ChatGPT/Codex). Describes what is true in the code at the commit below. Anything not confirmed in the code is marked **Unverified**.

| | |
|---|---|
| Repository | micheltou50/STRManagement (public) |
| Default branch | main |
| Verified against | `b2c1d33` (2026-10-24 23:17 UTC) |
| Last reviewed | 2026-10-25 |
| Related repos | `micheltou50/glenhaven-book`: the Glenhaven direct-booking website. It uses the **same Supabase project** (`nbeuyypgiipptxlqnhel`) and reads and writes the shared `bookings`, `reviews`, `guest_offers`, `price_overrides`, `site_config` and `properties` tables (see `glenhaven-book/GO-LIVE-AUDIT.md` and its `netlify/functions/*`; this repo's `supabase/migrations/20260710_120000_security_advisor_fixes.sql` calls the project "SHARED (StayOps + Glenhaven)"). `micheltou50/Bookkeeper` is linked only through the Codemagic App Store Connect integration, which is named `Bookkeeper` (`codemagic.yaml`). `micheltou50/Expenses-app` is mentioned in `PLAN-bank-transactions-redesign.md` as the source of the merchant normaliser that was ported. |

Existing in-repo docs: `CLAUDE.md`, `AGENTS.md`, `ANALYSIS-STRManagement.md` (code audit dated 2026-06-11) and `PLAN-bank-transactions-redesign.md` (written 2026-10-04, then built). Several of their claims are now stale. Section 15 lists the contradictions.

---

## 1. Purpose

StayOps is a short-term-rental (STR) management app for hosts and property managers, built for MT Management's own properties (Glenhaven among them). One single-page web app serves two roles:

- **Host app**: dashboard ("Today"), bookings (list and calendar), cleaning schedule and cleaner assignment, finance (expenses, receipts, reports, owner payouts, invoices, bank-statement import and reconciliation, recurring expenses, depreciation, ATO tax export), property hub (inventory, maintenance, access rules), settings and integrations, and an admin area (`user_roles.role = 'admin'`).
- **Cleaner app**: shown when the signed-in user's `user_roles` row says `cleaner`. It lists the cleaner's assigned cleans, with accept, decline, done and acknowledge-cancellation actions (`assets/js/render-cleaner.js`).

Bookings arrive automatically from platform iCal feeds (Airbnb, Booking.com, VRBO, Stayz). They are then enriched from booking-confirmation emails, read via Gmail or Outlook OAuth and parsed with Claude. The app also syncs bookings and cleans both ways with Google Calendar and Outlook Calendar. It sends web push, native iOS push (APNs) and email (Resend) notifications.

## 2. Technology stack

| Layer | What | Evidence |
|---|---|---|
| Frontend | Vanilla JS ES modules, no framework, **no bundler and no build step for web**. `index.html` (about 3,080 lines) is the whole app shell, `assets/js/main.js` is the module entry point, and `assets/css/styles.css` holds the styles | `index.html`, `assets/js/*.js` (55 modules, about 37k lines) |
| CDN libraries | `@supabase/supabase-js@2` (jsDelivr, pinned to major version only), jsPDF 2.5.1 + autotable 3.8.2 (cdnjs), Sentry browser loader, Google Fonts | `index.html` `<script>` tags |
| Backend | Supabase: Postgres 17, Auth, Storage (`receipts`, `photos` buckets). **Realtime is not used**: there is no `.channel(` call anywhere | `assets/js/supabase*.js` |
| Serverless | Netlify Functions in **`Netlify/functions/`** (capital N), Node, CommonJS, bundled by esbuild | `netlify.toml` |
| Supabase Edge | `supabase/functions/poll-emails/index.ts` (Deno) | file |
| AI | Anthropic Messages API. Models: `claude-haiku-4-5-20251001` (default and most callers) and `claude-sonnet-4-6` (bank PDF/photo parsing, payout-statement paste, some `ai.js` features) | `grep claude-` across `Netlify/` and `assets/js` |
| Email | Resend REST API. `nodemailer` is in package.json but no code requires it | `send-email.js`, `utils/push-helper.js` |
| Push | Web Push (`web-push`, VAPID) and APNs over HTTP/2 with a `.p8` token (`utils/apns.js`, no extra dependency) | |
| Error tracking | Sentry (browser loader in `index.html`; `@sentry/node` in `utils/sentry.js`) | |
| Mobile | Capacitor 8 iOS shell (`ios/`, SPM), app id `com.mtmanagement.stayops`. Built by Codemagic and uploaded to App Store Connect | `capacitor.config.json`, `codemagic.yaml` |
| Tests | `node --test` (built-in runner), with in-memory fakes in `tests/_mocks.js` | `package.json` |
| Lint | ESLint 10 flat config, deliberately minimal rules | `eslint.config.js` |

## 3. System architecture

```
                      ┌────────────────────────── Netlify site (app.stayops.com.au) ──────────────────────────┐
 Browser / PWA ──────►│ index.html + assets/js (static, repo root)                                              │
 iOS Capacitor app ──►│   (native shell calls functions at https://strmanagement.netlify.app — see supabase.js) │
   capacitor://       │ Netlify/functions/*  (JWT-checked via utils/auth.js verifyAuth, or cron/secret paths)   │
                      └───────┬──────────────┬───────────────┬───────────────┬───────────────┬─────────────────┘
                              │ supabase-js  │ service key   │               │               │
                              ▼  (anon key)  ▼  REST/SDK     ▼               ▼               ▼
                      ┌───────────────────────────┐   Anthropic API   Gmail / MS Graph   Google Cal / Outlook Cal
                      │ Supabase `stayops`         │   (Haiku/Sonnet)   (mail scan)       (two-way sync, webhooks)
                      │ nbeuyypgiipptxlqnhel       │                                      Resend (email)
                      │ Postgres + Auth + Storage  │◄── pg_cron → net.http_post → daily-notifications
                      │ Edge fn poll-emails        │                                      Web Push / APNs
                      └───────────▲───────────────┘
                                  │ same project, shared tables (bookings, reviews, properties, …)
                      glenhaven-book (direct-booking website, separate repo)

 Platform iCal feeds (Airbnb/Booking/VRBO/Stayz) ──► ical-sync (cron */15 + app boot) ──► bookings stubs
 Booking/review emails ──► gmail-/outlook-scan-bookings (app-triggered every 15 min) ──► enrich bookings / insert reviews
```

Runtime model:

- **Direct DB access from the browser.** The frontend talks to Supabase with the anon key plus the user's session, so Row-Level Security (RLS) is the main data guard. RLS is enabled on every table, but most policies are not in the repo (see §6). Netlify functions use the service-role key (`SUPABASE_SERVICE_KEY`) and bypass RLS. Each function must therefore scope its own queries by `user_id`.
- **In-memory state.** After login, `hydrateFromCloud()` (`assets/js/supabase.js`) loads, one after another, the properties, cleaners, bookings, cleans, notes, expenses, inventory, maintenance and `app_config` into the shared arrays in `assets/js/state.js` (and `window._cleaners`, `window._appConfig`). The UI renders from those arrays, and every mutation writes both the array and Supabase. `replaceArrayInPlace()` swaps contents without breaking module references.
- **Global bridges.** Inline `onclick` handlers and cross-module calls rely on functions attached to `window` / `globalThis` in `main.js` and the feature modules. `scripts/check-finance-split.sh` guards the finance bridge names against `scripts/finance-bridges-baseline.txt` (102 names; it passed at `b2c1d33`).

## 4. Repository layout

| Path | Role |
|---|---|
| `index.html` | Entire app shell: login, onboarding, sections `today`, `bookings`, `cleaning`, `finance`, `notes` (empty div), `property`, `admin`, `settings`, the modals, Sentry init, boot diagnostics and inline-handler stubs |
| `assets/js/main.js` | ES-module entry. It imports every module, exposes globals and runs the boot sequence (§5.1) |
| `assets/js/state.js` | Shared arrays `bookings`, `cleans`, `notes`, `expenses`, `maintenance`, `inventory` and `replaceArrayInPlace()` |
| `assets/js/supabase.js` | Supabase client (URL and anon key hardcoded), auth UI handlers, `detectUserRole()`, `loadCleanerDashboard()`, `hydrateFromCloud()`, `sbWrite()`, `authFetch()` / `apiUrl()` (native API origin), `beginOAuthConnect()`. Barrel that re-exports the `supabase-*.js` entity modules |
| `assets/js/supabase-{bookings,cleans,cleaners,expenses,inventory,maintenance,notes,payouts,pricing,properties,receipts,appconfig,bank-accounts,bank-lines}.js` | Per-table data layer, split out of `supabase.js` in July 2026 |
| `assets/js/render.js` (+ `render-cleaner.js`, `render-onboarding.js`) | Dashboard, sections, modals (`showAppModal`), maintenance/inventory, the 60 s cleans poll; cleaner PWA; onboarding wizard |
| `assets/js/bookings.js`, `booking-list-card.js`, `booking-revenue.js` | Bookings list/calendar/detail/edit, CSV import, the cancellation dialog; revenue and cancellation rules (§8) |
| `assets/js/cleaning.js` | Cleaning tab: scheduling, auto-assign, dispatch, cleaner invites (via `send-email` template `cleanerInvite`) |
| `assets/js/notifications.js` | Web and native push subscribe, SMS modal (`sms:` links), cleaner email sends, the email-template editor; registers `sw.js` (not in native builds) |
| `assets/js/finance.js` | Finance barrel: hub, expenses, reports, management fees, owner report, statement. Slices: `finance-invoices.js`, `finance-tax-export.js`, `finance-payout-paste.js`, `finance-bank.js` (Bank screen), `finance-bank-import.js`, `finance-shared.js` |
| `assets/js/bank-explain.js`, `bank-import.js`, `money-in-model.js`, `reconcile-period.js`, `reconciliation.js`, `airbnb-csv.js` | Bank-line explain engine (pure, tested), statement parsing (CSV in the browser; PDF/photo via Claude), payout auto-match, period-balance arithmetic, link writes, Airbnb CSV parser |
| `assets/js/owner-payout.js`, `recurring.js`, `depreciation.js` | Owner statement maths, recurring expenses, ATO depreciation presets |
| `assets/js/settings.js`, `admin.js`, `config.js`, `setup.js`, `property.js` | Settings (4 categories: property, money, app, finance), integrations (Gmail/Outlook/iCal/calendars), admin tabs, per-property config and localStorage namespacing, property setup (Airbnb listing fetch), portfolio mode |
| `assets/js/ai.js`, `ai-logic.js`, `smart-pricing.js`, `calendar-sync-outbound.js`, `since-last-opened.js`, `adapter.js`, `utils.js` | AI features via `ai-proxy`, Smart Pricing UI (entry points hidden), outbound calendar hooks, "since you last opened" rundown, email adapter, pure helpers (dates, turnover times, allocations) |
| `assets/js/onboarding-v2.js` | 15-screen wizard. **Unreachable:** `window.runOnboarding` is assigned and never called |
| `sw.js` | Service worker: push display and notification click only. **No offline caching** (no fetch handler) |
| `manifest.json` | PWA manifest (StayOps, standalone, portrait, host icons) |
| `Netlify/functions/*.js` | 31 functions (§7, §9) |
| `Netlify/functions/utils/*.js` | Shared helpers: `auth`, `cors`, `oauth-state`, `email-scan-shared` (1.5k lines), `email-templates`, `push-helper`, `apns`, `ical-parse`, `calendar-*` (mapper, push core, token, Google/Outlook clients and reconcilers), `cancellation-policy`, `notify-cleaner-cancellation`, `sentry` |
| `supabase/migrations/` | Schema source of truth since 2026-07-08 (`README.md` describes the rules). There is no runner: SQL is pasted into the Supabase SQL editor or MCP |
| `supabase/functions/poll-emails/` | Edge function (see §7). Note that `.gitignore` ignores `/supabase/functions`, so **new edge functions are not tracked unless force-added** |
| `ios/` | Capacitor iOS project (committed). `ios/App/App/Info.plist` holds the camera/photo usage strings and the document types for share-to-app; `App.entitlements` sets `aps-environment=production` |
| `scripts/` | `build-www.mjs` (assembles `www/` for Capacitor), `smoke-deploy.mjs` (read-only live endpoint checks), `check-finance-split.sh`, `dedupe-bookings.mjs` / `cleanup-duplicate-bookings.mjs` (dry-run-by-default duplicate booking cleanup using the service key), `gen_app_js.mjs` (historical: reads a `main.js.bak` that no longer exists) |
| `tests/` | 15 `*.test.js` files, 209 tests (§12) |
| `serve.ps1` | Local static file server (PowerShell, port 8080) |
| `codemagic.yaml`, `capacitor.config.json` | iOS CI/CD and the Capacitor config (`webDir: www`) |

## 5. Key features and how they work

### 5.1 Auth, roles and boot
- Supabase Auth supports email/password, magic link and OTP (`handleLoginSubmit`, `handleMagicLinkSubmit`, `handleVerifySubmit` in `supabase.js`). With no session, the login screen shows.
- `detectUserRole()` reads `user_roles` (`host`, then `cleaner`, otherwise `unlinked`). A cleaner is routed to `showCleanerApp()`. A cleaner can become a host by inserting a `host` role (`render-cleaner.js`).
- The host boot runs in this order in `main.js`: `migrateConfigFromLegacySettings` → `seedLocalConfigFromCloud` → `ensureHostIdentityAndRestore` → `finishAppInit` → `hydrateFromCloud` → native push init, the share-receipt listener and the queued-expense retry → `reloadInMemoryData` / `normalizeBookingCleanState` → portfolio mode → onboarding check → `renderAll()`. Post-boot timers then fire: the role switcher at 1 s, iCal sync at 1.5 s, the owner-report prompt at 1.5 s, the cancelled-booking check at 2.5 s, the Gmail scan at 3 s, the Outlook scan at 4.5 s and the calendar reconcile at 5 s. Gmail, Outlook, iCal and calendar reconcile repeat every 15 min, and again on `visibilitychange`, throttled to once per 60 s. `render.js` also polls `cleans` every 60 s.
- **Known divergence:** the in-page password and magic-link login paths in `supabase.js` run their own copy of the boot and skip some post-boot tasks. PR #66 fixes this with a shared `runSharedPostBootTasks()`.

### 5.2 Booking ingestion
1. **iCal sync** (`Netlify/functions/ical-sync.js`). Each active `property_ical_feeds` row is fetched and parsed (`utils/ical-parse.js`). For every event:
   - Host blocks ("Not available", "CLOSED", "Blocked") are ignored, and past events never create stubs.
   - An event first tries to **adopt** an existing un-linked confirmed booking at that property: same dates, else same check-in, else a second pass pairing within ±3 days on both ends, closest first. Adoption sets `ical_uid` and `ical_feed_id` and re-dates the booking to the feed.
   - Otherwise it inserts a stub: `source='ical'`, `enrichment_status='pending'`, `guest_name='Reserved — awaiting details'`, `local_id='ical-<feed>-<uid>'`.
   - A `STATUS:CANCELLED` event soft-cancels the booking.
   - The disappearance sweep (UID gone means cancelled) runs only if the body contains `BEGIN:VCALENDAR` **and** at least one live event parsed, and only for stays that have not started yet.
   - Cancellations set `cancelled_at` and `cancellation_billable`, push a calendar delete and notify the assigned cleaner (`utils/notify-cleaner-cancellation.js`).
   - Triggers: a Netlify cron every 15 min (all users; the no-body POST path is unauthenticated by design and returns totals only) and the app (POST `{uid}` with a JWT; the uid is taken from the token).
2. **Email scan** (`gmail-scan-bookings.js` and `outlook-scan-bookings.js`, shared logic in `utils/email-scan-shared.js`). The app triggers it with a JWT every 15 min while open.
   - Messages come from platform senders only. The domain is matched as a suffix of the address, and extra senders can be added via env.
   - A cheap keyword pre-filter runs, then Claude Haiku parses the email. The prompt marks the email content as untrusted data.
   - Results are typed: new booking, cancellation, modification, modification_notice, review, or not a booking. A match updates the booking in place, setting guest name, payout, cleaning fee, confirmation code and `enrichment_status='enriched'`.
   - `findExistingBooking()` matches in order: confirmation code → `property_id` + check-in → guest name + check-in. **There is no name-only tier** (removed 2026-09-03 in `2ea8e2d`).
   - Modification emails can also use `findModificationCandidate()`: same first name, same property, dates within 3 days, no conflicting real code. An unmatched modification with no real code pushes the host ("modification_unmatched") instead of inserting.
   - Synthetic confirmation codes (13 or more digits) are rejected (`sanitizeConfirmationCode`). Inserts with no payout get `enrichment_status='payout_pending'`.
   - Transient Claude or Supabase failures are retried on the next scan. Processed message ids are stored in `email_connections.skipped_ids`.
3. **Guest reviews** (since `b2c1d33`, 2026-10-24). An Airbnb "… left a N-star review" email is parsed into the shared `reviews` table with `status='pending'` and `platform='airbnb'`. The glenhaven-book admin approves and publishes it. The private "NOTE FROM" section is never stored, and truncated reviews end in "…". The host gets a push of type `new_review`.
4. **Manual bookings**: the add-booking modal, an Airbnb CSV import and a screenshot read with Claude (`ai.js`).
5. **Background polling**: the Supabase edge function `poll-emails` is meant to scan Gmail on a schedule but **does not work on `main`** (§13).

### 5.3 Cancelling a booking (frontend)
`deleteBooking()` (`bookings.js`) shows a cancel dialog. It then calls `applyCancellationPolicy()` (`status='cancelled'`, `cancelledAt`, `cancellationBillable`) and **upserts the booking with `saveBookingToCloud()`**. It does not call `deleteBookingFromCloud()` (that function still exists and is wrapped by `calendar-sync-outbound.js`, but nothing calls it). Linked cleans and notes are removed by booking id, or by guest name plus the same checkout date, and the cleaner is emailed if `email_cancellation` is enabled.

### 5.4 Cleaning and cleaners
- A clean is a `cleans` row. Its `booking_id` holds the booking's **`local_id`** (the canonical form since `ac9bb89`; legacy rows may hold the booking UUID, and readers check both).
- Assignment sets `cleaner`, `cleaner_id` (the cleaner's local id) and `cleaner_uuid`. It sends a push and/or an email (Resend template `cleanAssignment`) and optionally opens an SMS.
- Auto-assign uses `app_config.auto_assign_cleaner` and `cleaner_automation`.
- Cleaners sign in with email (the legacy link/PIN path was removed on 2026-07-10, `40bc3ee`). The cleaner PWA (`render-cleaner.js`) updates its own `cleans` rows directly through supabase-js and RLS, and notifies the host via `send-push`.
- `Netlify/functions/cleaner-action.js` and `cleaner-data.js` are **dormant legacy endpoints**: still deployed, but no frontend code calls them.
- Reminders: `send-clean-reminders` (daily cron) emails cleaners about tomorrow's cleans that are not done, declined, already reminded or on a cancelled booking.

### 5.5 Finance
- **Expenses**: categories, receipts in the private `receipts` bucket (ATO-style file naming, signed URLs), offline retry queue, soft-delete (`status='deleted'`). One expense can be split across stays (`booking_allocations`). Recurring templates and depreciation assets live in `app_config` JSON.
- **Reports**: FY performance, monthly revenue, management fees, owner report (PDF/CSV, emailed), and an ATO tax export (PDF/CSV, `finance-tax-export.js`).
- **Invoices** (`finance-invoices.js`): numbered `INV<YY><NNN>`, with issued/paid/cancelled lifecycle and jsPDF output. The invoice states "Not registered for GST".
- **Platform payouts**: paste or upload an Airbnb/Booking.com payout statement (CSV, Excel, TSV, PDF or image; AI extraction for PDF/image, a deterministic Airbnb CSV parser otherwise). These create `platform_payouts` and `platform_payout_lines` rows matched to bookings.
- **Bank** (`finance-bank.js`, built 2026-10-05, replacing "Transaction Map" and "Reconcile"; see `PLAN-bank-transactions-redesign.md`). Statement import parses, de-dupes, saves every new line and runs `bank-explain.js`.
  - Every line gets a **kind** plus an optional link to an expense, payout or booking.
  - The engine runs in this order: memory (`bank_memory`) → rules (platform names, bank fees, interest) → evidence (expense, payout auto-match, booking) → suggestions (optionally Claude Haiku) → default (a debit becomes an expense).
  - The "To decide" queue is the set of lines with `needs_review = true`.
  - The balance card uses `reconcile-period.js`. Locking a month writes `bank_reconciliations`. There is also a bulk-mark-a-past-year flow.
- **Owner payout** (`owner-payout.js`): see §8.

### 5.6 Calendar sync (two-way)
- Google Calendar and Outlook connect through separate OAuth flows (`gcal-oauth-*`, `outlook-cal-oauth-*`). Tokens and channel state are stored on `email_connections`.
- **Outbound:** `calendar-sync-outbound.js` wraps the global save and delete functions and POSTs `calendar-push`. The server writes `calendar_sync_state`.
- **Inbound:** `gcal-webhook` and `outlook-cal-webhook` (token / clientState must be present and match), plus `calendar-sync-reconcile` (cron every 15 min, and on demand) pull changes. Events from the phone with no StayOps mapping land in an "inbox" for triage in Settings.
- `calendar-resync` rebuilds everything synchronously. `calendar-feed` serves a read-only `.ics` keyed by `?uid=`.
- **On `main`, deleting a mirrored calendar event soft-cancels the linked booking** (`utils/calendar-reconcile-google.js` `applyEventDeletion`), including platform bookings. Branch `claude/annie-cancelled-status-mdvdyq` changes this (see AI_HANDOFF).

### 5.7 Notifications
- **Web push:** subscriptions are stored in `app_config.push_subscriptions` (and legacy `push_subs`), using a VAPID public key from `config.js`.
- **iOS:** APNs tokens in `app_config.native_push_tokens`.
- **Sending:** `utils/push-helper.js` `sendPushToHost()` checks the `app_config.notification_config` toggles (`push_checkin`, `push_checkout`, `push_unassigned_clean`, `push_no_response`, `push_review_cost`, `push_monthly_summary`, `push_cleaner_confirm`, `push_cleaner_decline`, `push_clean_done`, `push_cleaner_message`, `push_new_review`, …), writes `notification_log` for dedupe, prunes stale endpoints, and sends an email alongside.
- **Scheduled digests:** `daily-notifications` (host morning digest) and `monthly-revenue-summary`.
- **Templates:** email templates are server-side in `utils/email-templates.js` (`cleanAssignment`, `cleanReminder`, `cancellation`, `cleanerInvite`, `bookingConfirmation`, `monthlyReport`, `notification`). The in-app email-template editor saves to `app_config.email_templates`, **but sends never read it**.

### 5.8 Smart Pricing (hidden)
`smart-pricing.js` provides the UI. `generate-pricing-suggestions.js` calls Claude Haiku with NSW holidays and rules and writes `pricing_runs` / `pricing_suggestions`. `close-rate-outcomes.js` writes `rate_outcomes`. All three UI entry points were hidden with `display:none` on 2026-10-02 (`a26788a`, "not working properly"), **but the scheduled functions still run** (§9).

### 5.9 Native iOS extras
APNs push registration (`initNativePush`); share-to-app, which receives a shared receipt file as a new expense (`initSharedReceiptListener` in `ai.js`, Capacitor Filesystem); and device-adaptive invoice PDF saving.

## 6. Data model and Supabase integration

Project `stayops` (ref `nbeuyypgiipptxlqnhel`, ap-southeast-2), shared with glenhaven-book. The frontend uses the anon key hardcoded in `assets/js/supabase.js` (public by design). Functions use the service key.

**Schema in the repo.** `supabase/migrations/0000_baseline_schema.sql` is a column-level snapshot of 32 tables taken 2026-07-08, with RLS-enable flags. It does **not** include constraints, indexes, foreign keys, triggers or RLS policies, which "still live in prod". Ten dated migrations follow (calendar sync, iCal feeds, daily-notifications cron, native push tokens, revoke trigger-function execute, booking check-in/out times, photos bucket policies, security-advisor fixes, expense booking allocations, bank line kinds + `bank_memory`).

**Core tables** (host-scoped by `user_id` unless noted):

| Table | Purpose / key columns |
|---|---|
| `properties` | Property config: address, beds, `mgmt_fee_rate`, owner contact and report settings, `check_in_info` jsonb, platform URLs, `is_self_managed`; also a legacy `anthropic_api_key` column |
| `host_config` | Host identity (name, company, ABN/ACN, contact) |
| `app_config` | One row per user: push subscriptions and tokens, `notification_config`, `email_templates`, `expense_cats`, `recurring_templates`, `depreciation_assets`, `cleaner_automation`, `invoices`, `clients`, bank and invoice details, `mgmt_fee_rate`, `auto_assign_cleaner`, `ical_last_sync`, `daily_notifications_last_aest_date`, legacy Gmail columns |
| `bookings` | `local_id`, `checkin`/`checkout` (date), `checkin_time`/`checkout_time` (time, NULL means the 15:00 / 10:00 defaults), money fields (`host_payout`, `cleaning_fee`, `mgmt_fee`, `mgmt_payout`, `net_payout`), `platform`, `confirmation_code`, `status` (`confirmed`/`cancelled`), `cancelled_at`, `cancellation_billable`, `source` (`ical`, `email`, `gmail`, `outlook`, `manual`, `gcal`, plus glenhaven-book's `direct-booking` / `manual-block`), `enrichment_status` (`pending`/`enriched`/`payout_pending`/`manual`), `ical_uid` (unique per user), `ical_feed_id`, `notes`, `modification_pending_at` |
| `property_ical_feeds` | One row per platform feed per property (`platform` check: airbnb/booking/vrbo/stayz/other) |
| `cleans` | `booking_id` (text: the booking `local_id`), `cleaner`, `cleaner_id`, `cleaner_uuid`, `clean_date`, `done`, `cleaner_confirmed`/`declined`, `notified`, `reminder_sent`, `cost`, `cleaner_cancel_notified`/`acknowledged` |
| `cleaners` | Roster per host: `auth_user_id` links the cleaner's login, `invitation_status`, `permissions`, legacy `pin` |
| `user_roles` | `auth_user_id` → `host` / `cleaner` / `admin` |
| `email_connections` | Gmail/Outlook OAuth tokens (stored in plaintext), `skipped_ids`, calendar ids, Google watch channel, Outlook subscription / clientState / delta link |
| `calendar_sync_state`, `calendar_sync_log` | Row↔event mapping (two partial unique indexes) and a debug log (nothing writes the log on `main`) |
| `expenses` | `category`, `amount` (negative for credit notes), receipt fields, `bank_transaction_id`, `booking_id` plus `booking_allocations` jsonb (array check), `status`, `paid_by`, `recoverable_from_owner`, `gst`, `tax_note`, `refund_of_expense_id`, `paid_via` (check constraint) |
| `bank_transactions` | Bank lines: `direction`, `kind` (check), `kind_source`, `kind_confidence`, `needs_review`, `counterparty`, `expense_id`, `booking_id`, `import_batch_id`, legacy `is_personal`/`skipped` mirrors |
| `bank_import_log`, `bank_memory` | Import batches with statement period and balances; remembered decisions keyed `(user_id, counterparty_key, direction)` |
| `platform_payouts`, `platform_payout_lines` | Payout statements and their per-booking lines; `platform_payouts.bank_transaction_id` links the deposit |
| `notes`, `inventory`, `maintenance` | Property operations data |
| `notification_log` | Push dedupe and history |
| `pricing_rules`, `pricing_runs`, `pricing_suggestions`, `rate_outcomes` | Smart Pricing |
| `reviews` | Shared with glenhaven-book (pending → approved) |
| `messages` | Old in-app chat. The chat was removed 2026-07-05. Only the dormant `cleaner-action.js` still inserts here, and nothing reads it |
| `guest_offers`, `price_overrides`, `site_config` | Used only by glenhaven-book |
| `vendor_mappings`, `expense_email_log`, `scan_debug` | Legacy tables with no current code reader or writer (`vendor_mappings` was replaced by `bank_memory`; the `scan_debug` insert was removed in June 2026) |

**Live tables with no migration in this repo** (live list as of 2026-10-25 compared with `supabase/migrations/` on `main`):
- `bank_accounts` and `bank_reconciliations`. They were created by a "bank_accounts_and_reconciliations" migration applied to prod in `0bc3d2b` (2026-08-04), but that SQL was never committed. `supabase-bank-accounts.js` and `supabase-bank-lines.js` read and write them, and `20261004_100000_bank_line_kinds.sql` even references `public.bank_accounts` in a foreign key. The same un-committed migration added `bank_transactions.bank_account_id`, `reconciled_at` and `reconciliation_id`.
- `cleaner_unavailable`. Its migration exists only on the PR #66 branch, and the commit message says it was applied to prod.

**Other prod objects not on `main`:**
- Columns `cleans.started_at`, `checklist_done` and `photos`, and the `SECURITY DEFINER` RPC `cleaner_dashboard_context()` (PR #66 branch; commit messages say applied).
- Columns `app_config.cancellation_window_days` / `cancellation_policy`. They are read by `utils/cancellation-policy.js` and `supabase.js`, but their migration is only on branch `claude/annie-cancelled-status-mdvdyq`. **Unverified** whether they exist live. Without them the server-side lookup fails and the 14-day fallback applies.
- Trigger functions `expenses_soft_delete()`, `platform_payouts_soft_delete()` and `link_cleaner_on_signup()` exist in prod (named in `20260708_120000_revoke_trigger_fn_execute.sql`), but their definitions are not in the repo.

**Storage:**
- `receipts`: private; upload plus 1-hour signed URLs (`supabase-receipts.js`).
- `photos`: public; Glenhaven property photos, uploaded server-side by glenhaven-book. Its list and delete policies were dropped in `20260708_140000_tighten_photos_bucket_policies.sql`.

**Edge functions (live):**
- `poll-emails` (v5): source in `supabase/functions/poll-emails/index.ts`.
- `invite-cleaner` (v4): **source not in the repo**. The frontend stopped calling it on 2026-04-03 (`bb28576`); invites now go through `send-email` with the `cleanerInvite` template.

**Rules for schema changes** (`supabase/migrations/README.md`): every code change that touches the schema ships an idempotent, timestamped migration in the same commit, with a header comment; afterwards, run the Supabase advisors. A pending branch adds a further rule: from 30 Oct 2026 new `public` tables need explicit `grant`s for `authenticated` / `service_role` (see AI_HANDOFF).

## 7. External integrations and APIs

| Service | Used for | Where | Env vars (names only) |
|---|---|---|---|
| Supabase | DB, Auth, Storage | `assets/js/supabase*.js` (anon), all functions (service key) | `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (`SUPABASE_SERVICE_ROLE_KEY` is accepted as a fallback in `utils/auth.js`, `utils/calendar-token.js`, `utils/oauth-state.js`, `daily-notifications.js`, `monthly-revenue-summary.js`, `calendar-sync-reconcile.js`) |
| Anthropic | Email parsing, listing extraction, pricing, AI proxy for the browser | `ai-proxy.js` (JWT, model allowlist, `max_tokens` capped at 8192), `utils/email-scan-shared.js`, `fetch-listing.js`, `generate-pricing-suggestions.js` | `ANTHROPIC_API_KEY` |
| Gmail API + Google OAuth | Mail scan | `gmail-oauth-start/-callback.js`, `gmail-scan-bookings.js` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SITE_URL`/`URL`, `GMAIL_SCAN_EXTRA_SENDERS` (optional) |
| Microsoft Graph (mail) | Outlook/Hotmail scan | `outlook-oauth-start/-callback.js`, `outlook-scan-bookings.js` | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID`, `MICROSOFT_REDIRECT_URI` |
| Google Calendar | Two-way sync, push channels | `gcal-oauth-*`, `gcal-webhook.js`, `utils/gcal-client.js`, `utils/calendar-reconcile-google.js` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SITE_URL`/`URL` |
| Outlook Calendar (Graph) | Two-way sync, subscriptions | `outlook-cal-oauth-*`, `outlook-cal-webhook.js`, `utils/outlook-cal-client.js`, `utils/calendar-reconcile-outlook.js` | `MICROSOFT_*`, `MICROSOFT_CAL_REDIRECT_URI` |
| OAuth state signing | CSRF-safe connect flows (signed tokens, 15 min expiry) | `oauth-state.js`, `utils/oauth-state.js` | `OAUTH_STATE_SECRET` (optional; falls back to the service key) |
| Resend | All email | `send-email.js`, `send-push.js`, `utils/push-helper.js`, `send-clean-reminders.js`, `utils/notify-cleaner-cancellation.js` | `RESEND_API_KEY`, `RESEND_FROM` |
| Web Push | Browser/PWA push | `send-push.js`, `utils/push-helper.js` | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` |
| APNs | iOS push | `utils/apns.js` | `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_AUTH_KEY`, `APNS_BUNDLE_ID`, `APNS_PRODUCTION` |
| Platform iCal feeds | Booking stubs | `ical-sync.js` | (URLs are stored in `property_ical_feeds`) |
| Airbnb listing pages | Property setup autofill (the URL is rebuilt from the numeric id to prevent SSRF) | `fetch-listing.js` | `ANTHROPIC_API_KEY` |
| Sentry | Error tracking (DSN hardcoded, with an env override on the server) | `index.html`, `utils/sentry.js` | `SENTRY_DSN` (optional), `CONTEXT` |
| Codemagic + App Store Connect | iOS build and upload | `codemagic.yaml` | env group `stayops` (`CERTIFICATE_PRIVATE_KEY`), integration `Bookkeeper`, `BUILD_NUMBER` |

**Netlify functions** (31 on `main`):

| Function | What it does | Called by | Auth |
|---|---|---|---|
| `ai-proxy` | Anthropic Messages proxy | `ai-logic.js` (AIService), `bank-import.js`, `finance-bank.js` | Supabase JWT |
| `send-email` | Resend send; raw HTML or a named template | `adapter.js`, `cleaning.js`, `finance.js` | JWT (recipient not restricted) |
| `send-push` | Push to a subscription or to every device of a `user_id`, plus email alongside | `render-cleaner.js`, `admin.js`, `config.js`, `setup.js` | JWT (target `user_id` is caller-supplied) |
| `fetch-listing` | Airbnb listing → property fields | `setup.js` | JWT |
| `oauth-state` | Mint signed OAuth state | `supabase.js` `beginOAuthConnect` | JWT |
| `gmail-oauth-start/-callback`, `outlook-oauth-start/-callback` | Mail OAuth → `email_connections` | Settings / onboarding | Signed state |
| `gmail-scan-bookings`, `outlook-scan-bookings` | Mail scan (§5.2) | `settings.js` auto/manual scan; `poll-emails` (Gmail) | JWT |
| `ical-sync` | iCal → bookings | Netlify cron, `settings.js` / boot | JWT for per-user calls; open for the cron path |
| `gcal-oauth-*`, `outlook-cal-oauth-*` | Calendar OAuth, watch/subscription setup | Settings | Signed state |
| `gcal-webhook`, `outlook-cal-webhook` | Provider change notifications → reconcile | Google / Microsoft | Channel token / clientState |
| `calendar-push` | Push one row change to providers | `calendar-sync-outbound.js` | JWT |
| `calendar-sync-reconcile` | Inbound pull, renew channels, clear pending outbound | Netlify cron, Settings, boot | JWT when `uid` given; open for the cron path |
| `calendar-resync` | Synchronous full re-push | Settings | JWT |
| `calendar-backfill-background` | Background full re-push | **No caller** | **None** (`uid` in body) |
| `calendar-feed` | `.ics` of bookings | Calendar apps (URL shown in Settings) | `?uid=` only |
| `daily-notifications` | Host morning digest | Supabase pg_cron | `x-cron-secret` (`CRON_SECRET` mandatory) |
| `monthly-revenue-summary` | Monthly revenue/expense push | **No scheduler in repo** | `x-cron-secret` |
| `send-clean-reminders` | Cleaner reminder emails | Netlify cron | Scheduled |
| `generate-pricing-suggestions` | AI rate suggestions | `supabase-pricing.js`, `scheduled-pricing-weekly` | JWT or `INTERNAL_FN_SECRET` |
| `scheduled-pricing-weekly`, `close-rate-outcomes` | Pricing schedule, outcome capture | `schedule()` wrapper | Scheduled only |
| `cleaner-action`, `cleaner-data` | Legacy PIN-link cleaner endpoints | **No frontend caller** (dormant) | `uid` + cleaner `local_id` (+ PIN if one is set) |

## 8. Important business rules

- **Time zone:** Australia/Sydney throughout. Date-only fields are parsed as local calendar days (`utils.js` helpers; `toISOString()` for "today" was removed in June 2026). Server crons are fixed UTC values with no DST adjustment.
- **Turnover times:** default checkout is 10:00 and check-in 15:00, overridable per booking (`bookings.checkin_time` / `checkout_time`, `getTurnoverTimes()` in `utils.js`). The UI flags turnover clashes.
- **Revenue:** a stay's revenue is `host_payout`. Only revenue-bearing bookings count (`booking-revenue.js` `isRevenueBearingBooking`): a booking that is not cancelled, or one cancelled as **billable**.
  - `cancellation_billable` wins when it is set.
  - When it is null, the stay is billable if it was cancelled within the window before check-in. The window is 14 days by default, overridable by `cancellation_window_days` or `cancellation_policy.window_days`.
  - A billable stub with $0 payout shows as "payout pending", not $0. Invoices refuse a $0 or payout-pending selection.
- **Reporting month = check-out month.** A stay that crosses a month end belongs to the check-out month (`bookingReportingDate()` / `isBookingInMonth()`, since `7873423`, 2026-10-02). This applies to every Finance view, the exports and `monthly-revenue-summary`.
- **Management fee** = (`host_payout` − `cleaning_fee`) × fee %, and `net_payout` = that base − fee (`bookings.js`). Invoices bill the fee on revenue excluding cleaning, without GST.
- **Owner payout** (`owner-payout.js`): per stay, gross − management payout − owner cleaning cost.
  - The cleaning cost comes from expense allocations to that stay first, falling back to `cleans.cost`.
  - A stay counts as **paid once its check-in date has passed** (`8688558`). The app is not linked to the bank.
  - Only the *unallocated* part of operational expenses is deducted (in "deduct" mode).
  - Owner-paid categories are excluded, and the manager's own invoice to the owner, recorded as an expense, is never deducted again.
- **Expense allocations:** `booking_allocations` holds signed `{booking_id, amount}` pairs that need not sum to the expense; the remainder is plain operating cost. `expenses.booking_id` mirrors element 0.
- **Bank lines:** every line has exactly one kind.
  - Debits default to `expense` (with a "Bank Fees" category for fees).
  - `owner_funds`, `transfer` and `personal` are neutral: never profit and loss.
  - Credit kinds: `platform_payout`, `direct_booking`, `expense_refund`, `owner_funds`, `transfer`, `interest`, `other_income`, `personal`. Debit kinds: `expense`, `owner_funds`, `transfer`, `guest_refund`, `personal` (check constraint in `20261004_100000_bank_line_kinds.sql`).
  - Refunds are credit notes: a negative expense pointing at the original via `refund_of_expense_id`.
  - Income always comes from bookings. A payout deposit is evidence of payment, not income.
- **iCal safety rules:** see §5.2. Never back-fill history, never auto-cancel a stay that has started, skip the sweep on empty or invalid feeds, ignore host blocks.
- **Email scan safety:** platform-domain senders only, email content treated as untrusted in prompts, no guest-name-only matching, no synthetic codes, only definitive outcomes recorded as processed.
- **Cleaner cancellation notice:** when a booking is cancelled, the assigned cleaner is emailed once (`cleaner_cancel_notified`), and reminders skip such cleans.
- **Shared-project caution:** the database is shared with glenhaven-book. That site inserts `bookings` with `source='direct-booking'`, and `source='manual-block'` rows with `platform='Blocked'` and `host_payout=0`. Its code comment asks StayOps to filter `platform='Blocked'`, **but no such filter exists in `assets/js`**. Glenhaven also depends on `reviews`, `properties` and the `photos` bucket.

## 9. Deployment architecture

- **Web and functions: Netlify** site `strmanagement`, primary URL `https://app.stayops.com.au` (verified live fact; the code calls it from the `daily-notifications` cron SQL and `outlook-oauth-*` defaults; URLs moved from `strmanagement.netlify.app` in `e1ac079`, 2026-05-07).
  - `netlify.toml` sets only `functions = "Netlify/functions"` and the esbuild bundler. There is **no build command and no publish dir**, so the static app is served as-is from the repo root (**Unverified:** the Netlify UI settings).
  - No-cache headers apply to `/assets/js/*`, `/assets/css/*` and `/index.html`. No redirects.
  - The native shell calls functions on `https://strmanagement.netlify.app` (`NATIVE_API_ORIGIN` in `supabase.js`); `scripts/smoke-deploy.mjs` defaults to the same origin.
- **Schedules:**

| Job | Schedule (UTC) | Defined in |
|---|---|---|
| `send-clean-reminders` | `0 22 * * *` (08:00 AEST / 09:00 AEDT) | `netlify.toml` |
| `ical-sync` | `*/15 * * * *` | `netlify.toml` |
| `calendar-sync-reconcile` | `*/15 * * * *` | `netlify.toml` |
| `scheduled-pricing-weekly` | `30 18 * * 1` | `schedule()` in source |
| `close-rate-outcomes` | `30 14 * * *` | `schedule()` in source |
| `daily-notifications` | `0 21 * * *` via `cron.schedule` + `net.http_post` with an `x-cron-secret` header (placeholder in SQL; the real value must come from Vault) | `supabase/migrations/20260620_000000_daily_notifications_cron.sql` (**Unverified** that it is scheduled live with the correct secret) |
| `monthly-revenue-summary` | none in repo | **Unverified** whether scheduled outside the repo |
| `poll-emails` (edge) | the `*/30` example is only a comment | **Unverified** whether a pg_cron job exists |

- **Supabase:** migrations are applied by hand (SQL editor or MCP). There is no `supabase/config.toml` in git. Edge functions are deployed with `supabase functions deploy <name>`.
- **iOS:** Codemagic workflow `ios-testflight` runs on every push to `main`: `npm install` → `node scripts/build-www.mjs` → `npx cap sync ios` → build number set to `$BUILD_NUMBER` → code signing via `app-store-connect fetch-signing-files --create` → `xcode-project build-ipa` → upload to App Store Connect (`submit_to_testflight: false`, so internal testers get processed builds). `MARKETING_VERSION` is 1.0. **Unverified:** whether builds currently succeed or are installed by anyone.
- **CI:** there is no GitHub Actions workflow (`.github/` is absent). Tests and lint run only locally or in agent sessions.

## 10. Configuration and environment variables

Netlify function env (names only):
- Core: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`), `ANTHROPIC_API_KEY`.
- Email and push: `RESEND_API_KEY`, `RESEND_FROM`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_AUTH_KEY`, `APNS_BUNDLE_ID`, `APNS_PRODUCTION`.
- OAuth: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID`, `MICROSOFT_REDIRECT_URI`, `MICROSOFT_CAL_REDIRECT_URI`, `OAUTH_STATE_SECRET`.
- Cron and internal: `CRON_SECRET` (required by `daily-notifications` and `monthly-revenue-summary`; they refuse when it is unset), `INTERNAL_FN_SECRET` (pricing).
- Optional: `SENTRY_DSN`, `GMAIL_SCAN_EXTRA_SENDERS`, `EMAIL_SCAN_DEV_BYPASS_FROM` (dev only; leave unset in prod).
- Netlify-provided or overridable: `URL`, `SITE_URL`, `DEPLOY_URL`, `CONTEXT`.

Supabase edge secrets (`poll-emails`): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NETLIFY_URL`.

Codemagic: env group `stayops` containing `CERTIFICATE_PRIVATE_KEY`; App Store Connect integration named `Bookkeeper`; vars `BUNDLE_ID`, `XCODE_PROJECT`, `XCODE_SCHEME`.

Scripts: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (dedupe scripts); `SMOKE_BASE_URL` (smoke test).

Hardcoded client config (public by design): the Supabase URL and anon key (`assets/js/supabase.js`), the VAPID public key (`assets/js/config.js`), the Sentry DSN (`index.html`, `utils/sentry.js`) and `NATIVE_API_ORIGIN` (`supabase.js`).

Per-user settings live in `app_config` and `properties` (§6), not in env. localStorage is used for UI preferences, the active property, an expense retry queue and some legacy keys, namespaced per property by `config.js`.

## 11. Significant design decisions

- **No build step.** Static ES modules plus window bridges, with cache-busting query strings on `main.js` and the CSS. Large files were split into slices behind barrels (`finance.js`, `supabase.js`, `render.js`) in July 2026, with an invariant script guarding the bridge names.
- **iCal first, email enrichment second** (2026-05-02 `ea6cd4e`, replacing a channel manager). Property assignment is deterministic from the feed.
- **Soft cancellation.** Bookings are cancelled with an explicit `status='cancelled'` plus `cancelled_at` and `cancellation_billable`, never deleted. Expenses and payouts are soft-deleted (`status='deleted'`, with DB triggers named `*_soft_delete`).
- **Schema in git** since 2026-07-08 (baseline + idempotent migrations), after prod-only DDL caused silent missing-column save failures.
- **Bank model** (2026-10-04 plan): one list in which every line has a kind; "every payment is an expense"; balance check plus month lock instead of row ticking; memory keyed on the normalised merchant.
- **Owner payout counts a stay as paid once check-in passes**, because there is no bank feed (2026-10-05).
- **Server security pattern** (2026-06 audit fixes): JWT on every user-triggered function, with the user derived from the token, never from the body; signed OAuth state; mandatory cron secret; anchored sender-domain checks; prompt-injection framing; `sbWrite()` error surfacing; escape-by-default HTML (`escHtml`).
- **Removed features:** the in-app host↔cleaner chat (2026-07-05) and the legacy cleaner PIN links (2026-07-10). The `gmail-scan-expenses` function was removed 2026-04-14. Capacitor was removed 2026-05-02 and re-added 2026-06-24.

## 12. Current development status

- Active development, about 456 commits on `main` since 2026-03 (the fetched history is shallow at 2026-03-25). The latest commit is `b2c1d33` (2026-10-24, review capture).
- Recent focus: the bank redesign (shipped 2026-10-05), booking-ingestion safety (October), owner payout rules, and the cleaner PWA rebuild on open PR #66 (not merged).
- **Prod is ahead of `main`:** several migrations were applied to the live DB from unmerged branches (§6).
- **Tests:** `npm test` (= `node --test tests/*.test.js`) runs 15 files and 209 tests. Without `npm install`, 148 pass and 61 fail with `MODULE_NOT_FOUND` (`@supabase/supabase-js`, `web-push`, `@sentry/node`); every failure checked at `b2c1d33` was this missing-dependency type. Recent commit messages report 6 further pre-existing failures in `daily-notifications` / `push-helper` with dependencies installed (**Unverified** here; dependencies were not installed).
- Other checks: `npm run lint` (ESLint; not run here); `sh scripts/check-finance-split.sh` (passes); `npm run smoke:deploy [baseUrl]` (hits the live site with deliberately bad requests; read-only).

## 13. Known limitations

- **Background Gmail polling is broken on `main`.** `poll-emails` selects users by `app_config.gmail_refresh_token`, which nothing writes (tokens moved to `email_connections` in `95a5346`). It also calls `gmail-scan-bookings` without an `Authorization` header, which that function rejects (JWT required). Outlook is never polled. Scanning effectively happens only while the app is open.
- **Calendar deletions cancel platform bookings** on `main` (§5.6), and `clearPendingOutbound()` clears pending outbound pushes without retrying them (`calendar-sync-reconcile.js`). Both are fixed only on an unmerged branch.
- `calendar_sync_state` upserts use `resolution=merge-duplicates` with no `on_conflict` target and no `res.ok` check, while the table has two unique indexes (`utils/calendar-push-core.js`, `utils/calendar-reconcile-*.js`).
- Auth gaps that remain: `send-push` accepts any `user_id` from an authenticated caller; `send-email` sends to any recipient; `calendar-feed` is keyed only by the permanent user id; `calendar-backfill-background` has no auth; the dormant `cleaner-data` / `cleaner-action` endpoints are still deployed; the cron (no-body) paths of `ical-sync` and `calendar-sync-reconcile` are open by design and return only totals.
- `sw.js` uses `/icon-192.png` for notification icon and badge, but that file does not exist (only `icon-host-*` / `icon-cleaner-192.png`).
- Email-template editor: saved templates are never used by sends.
- The Monthly Statement view (`showStatementView`) has no UI entry point, and `onboarding-v2.js` is unreachable.
- The bookings advanced filter sheet only updates the "Show N bookings" count. `renderBookings()` never applies `_applyAdvancedFilters()`.
- Settings property and feed cards read `window._icalFeeds` / `window._bookings`, which nothing assigns, so counts show 0 or None.
- Smart Pricing is hidden in the UI, but `scheduled-pricing-weekly` still calls the AI weekly for every property with pricing rules.
- The Settings "AI Booking Import" panel still collects an Anthropic API key and syncs it to `properties.anthropic_api_key` and localStorage. Its copy says "stored on this device only", and all AI calls actually go through the server proxy.
- No offline support beyond the expense retry queue; no Realtime (polling only); `hydrateFromCloud` loads tables sequentially.
- Many items in `ANALYSIS-STRManagement.md` are fixed (see AI_HANDOFF), but the file is not annotated, so read it as a historical audit.

## 14. Planned future improvements (from repo evidence)

- **Open PR #66** (`claude/keen-ramanujan-kwnhmx`), cleaner PWA: day plan, start/finish, cheat sheet, checklist and photos, `.ics` calendar feed per cleaner, days off, morning digest, offline plan, multi-host cleaners, hand-off to a teammate.
- **Branch `claude/annie-cancelled-status-mdvdyq`**: platform bookings are never cancelled by calendar deletions; a sync decision log; retries of pending outbound pushes; cancellation-policy columns; service-key auth for `poll-emails` → `gmail-scan-bookings`.
- **Branch `claude/fyi-a9umu8`**: document the Supabase rule that, from 30 Oct 2026, new public tables need explicit grants.
- `PLAN-bank-transactions-redesign.md` Phase 4 leftovers that are not found in code: an "Owner funds" section on owner and monthly statements; the tax export filtering on `kind`; a `paid_via` filter and bulk action on the Expenses screen (the bulk mark currently exists only in the Bank "past year" flow); dropping `vendor_mappings`; splitting loan principal from interest later. Out of scope per the plan: a live bank feed and double-entry ledger.
- `generate-pricing-suggestions.js:41` TODO: review the NSW school-holiday dates every year.
- Smart Pricing is to be restored once it works (the hidden elements carry restore comments, `a26788a`).

## 15. Unverified / open questions

- **Bookings soft-delete trigger:** `CLAUDE.md` says a trigger turns `bookings` DELETE into `status='cancelled'`. No such SQL is in the repo, and the frontend no longer issues booking deletes. **Unverified** whether the trigger exists.
- Whether `CRON_SECRET` was rotated after a literal value was committed to `scripts/daily-notifications-cron.sql` (scrubbed 2026-06-20, `f0b2380`; still in git history).
- Whether pg_cron jobs exist for `daily-notifications`, `monthly-revenue-summary` and `poll-emails`, and with which secrets.
- Whether `app_config.cancellation_window_days` / `cancellation_policy` exist live.
- Whether Netlify accepts direct HTTP calls to functions that are also declared as scheduled in `netlify.toml` (`ical-sync`, `calendar-sync-reconcile`). The frontend POSTs to both, while the comment in `scheduled-pricing-weekly.js` says Netlify rejects external HTTP to scheduled functions.
- The Netlify build/publish settings in the UI, and whether `strmanagement.netlify.app` and `app.stayops.com.au` are the same deploy (implied by `e1ac079` and the site name).
- Whether the iOS app builds and ships today; `ios/App/CapApp-SPM/Package.swift` contains Windows-style relative paths (regenerated by `cap sync`).
- The source and purpose of the live `invite-cleaner` edge function.
- How StayOps lists and cleans glenhaven-book `manual-block` rows.
- The RLS policies of most tables; only those in the dated migrations are in the repo.
- The exact test pass count with dependencies installed.

### Stale claims in existing docs (code wins)
- `CLAUDE.md` / `AGENTS.md`:
  - "`deleteBooking()` calls `deleteBookingFromCloud()`" is stale; it now upserts `status='cancelled'` (§5.3).
  - "Match order … → guest_name (unique)" is stale; the name-only tier was removed.
  - "Cleaners … accept/decline/mark-done through `cleaner-action.js` … insert message cards into `messages`" is stale; cleaners write directly via supabase-js, and chat was removed.
  - "customizable templates stored in `app_config.email_templates`" are not used by sends.
  - "Supabase (Postgres, Auth, Realtime)": Realtime is unused.
  - "AI: Claude Sonnet via proxy": the default model is Haiku 4.5.
  - The iCal disappearance rule is now limited to future stays and valid, non-empty feeds.
- `AGENTS.md` reads "Codex Sonnet" / "Codex Haiku" (an apparent find-and-replace of "Claude"; the models are Anthropic Claude). It also lacks the guest-review paragraph that `CLAUDE.md` has.
- `PLAN-bank-transactions-redesign.md` describes the pre-change state in §1–2. Its status line says the plan is built.
- `supabase/functions/poll-emails/index.ts` header says "Scheduled via pg_cron every 30 minutes" and reads `app_config.gmail_refresh_token` (see §13).
- `ANALYSIS-STRManagement.md` (2026-06-11): many findings were fixed in the 2026-06-11 → 06-20 commits. See the AI_HANDOFF "Outstanding bugs" for the ones still open.
