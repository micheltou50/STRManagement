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
Cleaners sign in with their own Supabase user (`cleaners.auth_user_id`). The cleaner UI is `render-cleaner.js`, fed by `loadCleanerDashboard()` in `supabase.js`: their cleans and assigned properties come through RLS, and host contact plus the sibling bookings needed for turnover deadlines come from the `cleaner_dashboard_context()` SECURITY DEFINER RPC (scoped to `auth.uid()`). `annotateCleanerCleans()` in `utils.js` derives per-clean checkout time, next check-in, same-day-turnover flag and the deadline sort key. Accept / decline / start / finish / acknowledge write to `cleans` directly (RLS policy `cleaner_update_own_cleans`; `started_at` marks a clean in progress) and notify the host via `send-push`. The per-property cheat sheet (lockbox, access, Wi-Fi, cleaner notes) lives in `properties.check_in_info` and is edited from Property → Access & Rules; the lockbox code is only shown on the day of the clean. "Message Host" opens the phone's SMS app via an `sms:` link to `host_config.phone`. Cleaners can also subscribe to their cleans as an iCal feed from the Profile tab (`cleaner-calendar-feed.js`, keyed by `cleaners.id`; timed events, no lockbox code).

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
