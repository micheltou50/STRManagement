# StayOps — STR Management App

## What this is
A short-term rental (STR) management PWA for hosts. Manages bookings, cleaning schedules, finances, and cleaner communication. Hosted on Netlify with Supabase as the backend.

## Tech stack
- **Frontend:** Vanilla JS (no framework), single-page app served from `index.html`
- **Backend:** Supabase (Postgres, Auth, Realtime)
- **Serverless functions:** Netlify Functions (`Netlify/functions/`)
- **Email:** Resend API
- **Push notifications:** Web Push API (VAPID)
- **AI:** Claude Sonnet via Netlify proxy (`ai-proxy.js`)
- **Deployment:** Netlify

## Project structure
- `assets/js/` — all frontend modules (no build step, ES modules imported in main.js)
- `Netlify/functions/` — serverless endpoints (cleaner actions, push, email reminders, Gmail/Outlook scanning, iCal sync)
- `Netlify/functions/utils/` — shared helpers (auth, push, iCal parsing, email-scan logic)
- `index.html` — the entire app shell

## Key architectural decisions

### Bookings are soft-deleted
`deleteBooking()` in JS calls `deleteBookingFromCloud()` which issues a `.delete()`, but a Supabase trigger/RLS policy intercepts it and sets `status = 'cancelled'` instead of removing the row. The booking persists in the database. This applies both to manual deletes and platform cancellations (via iCal sync / Gmail / Outlook scan). Cancelled bookings are always queryable.

### Bookings come from iCal feeds, then get enriched by email
Booking ingestion is two-stage:
1. **iCal sync** (`ical-sync.js`, scheduled every 15 min + on app boot + on visibilitychange) polls per-property iCal URLs stored in `property_ical_feeds` (Airbnb, Booking.com, VRBO, Stayz). Each `VEVENT` becomes a thin booking stub keyed on `(user_id, ical_uid)` with `source='ical'`, `enrichment_status='pending'`, and `guest_name='Reserved — awaiting details'`. Property is set deterministically from the feed (no fuzzy matching).
2. **Email scan** (`gmail-scan-bookings.js` / `outlook-scan-bookings.js`, shared logic in `utils/email-scan-shared.js`) parses booking confirmation emails with Claude Haiku and **enriches** the matching iCal stub in place — filling in guest name, host_payout, cleaning_fee, confirmation_code, and setting `enrichment_status='enriched'`. Match order in `findExistingBooking()`: confirmation_code → property_id+checkin → guest_name+checkin → guest_name (unique).
3. Cancellations: when a UID disappears from the feed (or status flips to CANCELLED), the booking is soft-cancelled. Email-driven cancellations follow the same path.
4. **Guest reviews** ride the same scan: an Airbnb "<Name> left a 5-star review!" email (`looksLikeReviewEmail()` → `parseReviewEmail()` → `processReviewResult()` in `utils/email-scan-shared.js`) is parsed with Claude Haiku and inserted into the shared `reviews` table as `status='pending'`, `platform='airbnb'`. The booking website (separate repo `glenhaven-book`, same Supabase project) lists pending reviews in its admin for one-click approval and publishes only approved ones. Airbnb's email truncates long reviews at ~200 chars (stored with a trailing `…`) and includes a private "NOTE FROM" section that must never be stored. The "wrote you a review" / "Write a review" emails carry no text and are skipped before Claude.

Direct bookings (no iCal feed) still flow through the email scanner as standalone inserts when no stub matches.

### In-memory state is the runtime source of truth
All data is loaded from Supabase into in-memory arrays at boot (`hydrateFromCloud()`), then rendered from those arrays. Mutations update both the in-memory array and Supabase. Key arrays:
- `bookings` — all bookings
- `cleans` — cleaning jobs linked to bookings
- `window._cleaners` — cleaner roster
- State lives in `state.js`, hydration in `supabase.js`

### Boot sequence matters
After login: config migration -> cloud seed -> host identity -> app init -> `hydrateFromCloud()` -> state normalization -> UI render -> post-boot tasks (auto-scan Gmail/Outlook, check reports). Any new boot-time checks should go after hydration but before or alongside render.

### Notification system is multi-channel
- **Push:** Web Push API, subscriptions stored in `app_config.push_subscriptions`
- **Email:** Resend API, customizable templates stored in `app_config.email_templates` (types: assignment, reminder, cancellation)
- **SMS:** Native phone integration (opens `sms:` URL), host-triggered manually
- **Scheduled reminders:** Netlify Function `send-clean-reminders.js` runs daily at 10PM UTC, emails cleaners 24h before their clean date
- Notification toggles in `app_config.notification_config`: `email_cancellation`, `notif_assignment`, `email_reminder`

### Cleaners have their own PWA
Cleaners sign in with their own Supabase user (`cleaners.auth_user_id`). A cleaner who works for several hosts has one `cleaners` row per host sharing that `auth_user_id`; `loadCleanerDashboard()` loads every row (`cleanerRecords`, first = primary) and spans cleans, days off, hosts and calendar feeds across them, the cards say which host a clean is for, and the morning digest groups by login. The cleaner UI is `render-cleaner.js`, fed by `loadCleanerDashboard()` in `supabase.js`: their cleans and assigned properties come through RLS, and host contact plus the sibling bookings needed for turnover deadlines come from the `cleaner_dashboard_context()` SECURITY DEFINER RPC (scoped to `auth.uid()`). `annotateCleanerCleans()` in `utils.js` derives per-clean checkout time, next check-in, same-day-turnover flag and the deadline sort key. Accept / decline / start / finish / acknowledge write to `cleans` directly (RLS policy `cleaner_update_own_cleans`; `started_at` marks a clean in progress) and notify the host via `send-push`. The per-property cheat sheet (lockbox, access, Wi-Fi, cleaner notes) lives in `properties.check_in_info` and is edited from Property → Access & Rules; the lockbox code is only shown on the day of the clean. "Message Host" opens the phone's SMS app via an `sms:` link to `host_config.phone`. A host-defined checklist per property (`check_in_info.checklist`, one string per item) is ticked per clean into `cleans.checklist_done`; photo proof goes straight from the cleaner's browser to the public `photos` bucket under `cleans/<cleaner uuid>/<clean id>/` and is listed in `cleans.photos`. The host app never writes those cleaner-owned fields (no realtime on cleans), except resetting `started_at` / `checklist_done` when a clean is unassigned. Cleaners can also subscribe to their cleans as an iCal feed from the Profile tab (`cleaner-calendar-feed.js`, keyed by `cleaners.id`; timed events, no lockbox code). Days off live in `cleaner_unavailable`: the cleaner toggles them from the Calendar tab (own rows via RLS), the host reads them at hydration into `window._cleanerDaysOff`; assigning onto a day off asks for confirmation and auto-assign skips an unavailable preferred cleaner. A cleaner who can't make a clean can hand it to a teammate ("Can't make it?" on the card): the RPC's `teammates` list is the other active cleaners of the same host (`id`/`name`/`user_id` only), and the reassignment runs in the `cleaner-handoff` Netlify function with the service key (RLS stops a cleaner re-pointing `cleaner_uuid` themselves). It checks the clean is the caller's and the target works for that host, puts the clean back to awaiting with progress reset (photos kept) and `notified = false` so the host dashboard prompts the proper assignment notice, then pushes the host and the teammate. The plan's sections come from `bucketCleanerCleans()` in `utils.js`: an open clean more than 3 days past its date is left out (same rule as the host dashboard's "Clean not done" alert: by then it was done and never marked, or a newer guest has been through), and acknowledged cancellations drop off after 14 days. A host who is also a cleaner (a `cleaners` row linked by `auth_user_id` or carrying the login email, `findOwnCleanerRecord()`) gets the Host / Cleaner switch; `checkRoleSwitcher` is scheduled from `runSharedPostBootTasks()` in `main.js`, which every host sign-in path (stored session, password, magic link) calls.

Pushing a cleaner: the cleaner PWA saves push subscriptions to `app_config.push_subscriptions` under the cleaner's OWN auth user (`subscribeToPush('cleaner', …)`), so server code reaches them with `push-helper.sendPushToUser({ userId: cleaners.auth_user_id })` or `send-push` in `user_id` mode; the host app does this on assignment (`sendPushToUserId`). The legacy `app_config.push_subs.cleaners` map only ever worked when a cleaner subscribed on the host's device. `cleaner-morning-digest.js` (scheduled 20:00 UTC in `netlify.toml`) pushes each cleaner one "Today: N cleans · first out … · same-day turnovers" summary, deduped via `notification_log` type `cleaner_digest`. The cleaner PWA also caches the last loaded plan per auth user in localStorage (`prepareCleanerCache()` in `utils.js` strips lockbox codes for future days) and renders it with an Offline banner when the live load fails, reloading on the `online` event.

`cleaner-data.js` and `cleaner-action.js` (Netlify Functions) are the legacy link/PIN cleaner path and are no longer called by the frontend.

## Supabase tables (key ones)
- `bookings` — guest bookings (status: confirmed/cancelled). Key columns: `source` (`ical`/`gmail`/`outlook`/`manual`), `enrichment_status` (`pending`/`enriched`), `ical_uid`, `ical_feed_id`, `confirmation_code`.
- `property_ical_feeds` — per-property iCal subscriptions (one row per platform per property). Polled by `ical-sync.js`.
- `cleans` — cleaning jobs linked to bookings via `booking_id` (the booking's `local_id`). `cleaner_confirmed` / `cleaner_declined` / `started_at` / `done` track the cleaner's progress.
- `cleaners` — cleaner roster with auth, contact info, permissions
- `app_config` — per-user settings, push subs, notification config, email templates
- `host_config` — host profile (name, company, contact)
- `messages` — in-app message cards (cleaner actions, etc.)
- `notes`, `expenses`, `inventory`, `maintenance` — other domain tables

## Conventions
- Local IDs (`local_id`) for offline/local references, cloud IDs (`id`/`_cloudId`) for Supabase
- `globalThis` / `window` used extensively to expose functions across modules (no bundler)
- `replaceArrayInPlace()` pattern to mutate shared arrays without breaking references
- `renderAll()` re-renders the entire UI after state changes
- Config flags checked via `isNotifEnabled('flag_name')`

## Gotchas
- Some Supabase logic (triggers, RLS policies) may cause behavior that isn't visible in the JS code alone. Always check the actual database behavior, not just what the JS appears to do.
- `deleteBookingFromCloud()` looks like a DELETE but results in a soft-delete (status = cancelled). Don't assume the row is gone.
- Two fields for push subscriptions exist: `push_subscriptions` and `push_subs` (backward compat).
