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
4. **Guest reviews**: `scheduled-review-scan.js` runs hourly (no app open needed) and, for every connected Gmail/Outlook account, reads Airbnb "<Name> left a 5-star review!" emails (`looksLikeReviewEmail()` → `parseReviewEmail()` → `processReviewResult()` in `utils/email-scan-shared.js`), parses them with Claude Haiku and inserts them into the shared `reviews` table as `status='pending'`, `platform='airbnb'`. The on-open scan does the same when it happens to run. The booking website (separate repo `glenhaven-book`, same Supabase project) is the only UI for reviews: its admin lists pending ones for one-click approval and publishes only approved ones; StayOps shows no banner and sends no push about reviews. Airbnb's email truncates long reviews at ~200 chars (stored with a trailing `…`) and includes a private "NOTE FROM" section that must never be stored. The "wrote you a review" / "Write a review" emails carry no text and are skipped before Claude.

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
Cleaners log in via `auth_user_id` on the `cleaners` table. They can accept/decline/mark-done cleans through `cleaner-action.js` (Netlify Function). Actions trigger push + email notifications to the host and insert message cards into the `messages` table.

## Supabase tables (key ones)
- `bookings` — guest bookings (status: confirmed/cancelled). Key columns: `source` (`ical`/`gmail`/`outlook`/`manual`), `enrichment_status` (`pending`/`enriched`), `ical_uid`, `ical_feed_id`, `confirmation_code`.
- `property_ical_feeds` — per-property iCal subscriptions (one row per platform per property). Polled by `ical-sync.js`.
- `cleans` — cleaning jobs linked to bookings via `booking_id`
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

## AI documentation — read first, keep current

This repository keeps a shared knowledge base for every AI assistant (Claude, ChatGPT/Codex, Cursor):

- `docs/AI_CONTEXT.md` — what the application is, how it is built and deployed, data model, integrations, business rules.
- `docs/AI_HANDOFF.md` — current status, work in progress, bugs, next tasks.

**Before starting work:** read both files.

**After completing any significant task** (new feature, behaviour change, schema or migration, new integration, deployment/config change, notable bug fix):

1. Update `docs/AI_CONTEXT.md` if the architecture, features, data model, integrations or deployment changed.
2. Update `docs/AI_HANDOFF.md`: move finished work into "Recently completed features", refresh work in progress, outstanding bugs, pending tests and recommended next tasks, set "Date of last update", and add a line to the update log.
3. Commit the documentation changes in the same commit or pull request as the code they describe.
4. Push, so the latest documentation is on GitHub.

Rules for these files:
- Verify against the code; never invent. Mark anything unconfirmed as **Unverified**.
- Never include API keys, passwords, tokens, service-role keys, connection strings or env var values — name the variable only.
- Never include guest, client or other personal or confidential information.
- This repository is public — anything committed here is world-readable.
