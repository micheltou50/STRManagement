# StayOps (STRManagement) — AI Handoff

**Date of last update:** 2026-10-25
**Based on:** `main` @ `b2c1d33` (2026-10-24 23:17 UTC)
**Updated by:** Claude (initial documentation audit)

## Latest known development status

- `main` is deployable and in daily use: Netlify site `strmanagement`, primary URL https://app.stayops.com.au. The latest change captures Airbnb guest reviews into the shared `reviews` table for the Glenhaven website (2026-10-24).
- **The production database is ahead of `main`.** These schema changes were applied to the live `stayops` project but have no migration on `main`:
  - `bank_accounts`, `bank_reconciliations` and related `bank_transactions` columns (applied 2026-08-04; the SQL was never committed);
  - the cleaner tables and columns, and the `cleaner_dashboard_context()` RPC, from open PR #66;
  - possibly the `app_config` cancellation-policy columns (branch `claude/annie-cancelled-status-mdvdyq`, **Unverified** live).
- Two unmerged branches contain production fixes:
  - `claude/annie-cancelled-status-mdvdyq`: calendar deletions must not cancel platform bookings; fixes the background Gmail poll auth.
  - `claude/keen-ramanujan-kwnhmx` (PR #66): the cleaner PWA rebuild.
  Both merge cleanly into `main` as of today (`git merge-tree`), and both edit `CLAUDE.md`.
- Tests: `npm install && npm test` (209 tests). Without dependencies installed, 148 pass and 61 fail on missing modules only. There is no CI.

## Recently completed features

Newest first, from `git log origin/main`:

- **2026-10-24** — Airbnb guest-review capture from host emails into `reviews` (`status='pending'`, approved on the Glenhaven site), with a `new_review` push and 12 tests (`b2c1d33`).
- **2026-10-05** — **Finance → Bank** replaces Transaction Map and Reconcile (PRs #60–#65):
  - `bank-explain.js` engine; `bank_memory`; kinds on every bank line; credit notes; `paid_via`; balance card and month lock; bulk-mark of a past year;
  - migration `20261004_100000_bank_line_kinds.sql`;
  - owner payout simplified to Expected and Payout, with a stay counted as paid once check-in passes (`c2a8251`, `b5868f2`, `7db7ce1`, `0408d3e`, `65b745e`, `8688558`).
- **2026-10-04** — `PLAN-bank-transactions-redesign.md` written (`ebfed63`, `db4a6d3`).
- **2026-10-02** (PRs #58–#59):
  - iCal feeds made safe to enable: adopt existing bookings, proximity pairing, ignore host blocks, never back-fill, never auto-cancel started stays;
  - unmatched change emails push the host instead of creating $0 phantom bookings (`a62406e`, `66d1870`);
  - Finance attributes stays to their **check-out month** (`7873423`);
  - Smart Pricing entry points hidden (`a26788a`);
  - booking detail "Schedule Clean" plus an SMS prompt (`beb62a4`).
- **2026-09-10** — Owner cleaning deductions separated from management fees (`619a652`).
- **2026-09-03** — Repeat-booking ingestion: no name-only match, synthetic codes rejected, `payout_pending` flag, invoices refuse $0 (`2ea8e2d`).
- **2026-08-01 → 08-10** — Bank reconciliation stages 0–4 (PR #54, `feature/bank-reconciliation`): money-in ledger, payout de-duplication, bank accounts plus period reconcile, deterministic Airbnb CSV parser, "Match all" payouts, import error reporting.
- **2026-07-25** — One expense split across several stays (`booking_allocations`, `c884dd6`).
- **2026-07-08 → 07-10**:
  - migrations folder and baseline schema, boot diagnostics, first frontend tests (`fe380aa`);
  - `finance.js`, `supabase.js` and `render.js` split into slices;
  - per-booking check-in/out times and turnover clash detection;
  - Settings restructured into categories;
  - security-advisor fixes migration;
  - iOS receipt-camera crash fix;
  - legacy cleaner PIN/link path removed (`40bc3ee`); dead legacy code cleanup (`98f4778`).
- **2026-07-05** — Invoice viewer and lifecycle (issued/paid/cancel, PDF save); Transaction Map P1–P3 (since superseded); in-app chat removed (`f105bd9`).
- **2026-06-24 → 06-27** — Capacitor iOS shell + Codemagic pipeline (`ad6bbd8`), native APNs push (`4134fe3`, `37de8c6`), share-to-app receipts (`7440516`), ATO receipt naming and app icon (`2e50a78`), duplicate-booking cleanup script.
- **2026-06-11 → 06-20** — Fix batches from `ANALYSIS-STRManagement.md`:
  - auth on `ai-proxy` and the scan/sync endpoints; deprecated model swapped; iCal empty-feed guard (`322653e`);
  - late-cancel revenue fix; bank double-count fix; token logging removed (`43975d4`);
  - `cleans.booking_id` contract; retryable scan failures (`ac9bb89`);
  - `sbWrite()` and an XSS escape pass (`de13f7c`); local-date helper (`53a88a7`);
  - SSRF, webhook, sender-domain, prompt-injection and `scan_debug` fixes (`c6663be`); reliability batch (`ee0fe1b`);
  - signed OAuth state (`9723287`); mandatory `CRON_SECRET` and the committed secret scrubbed (`f0b2380`).
- **2026-05** — Two-way Google and Outlook calendar sync; iCal feeds replace the channel manager (`ea6cd4e`); Gmail tokens moved to `email_connections` (`95a5346`); v2 design system; finance redesign phases 0–6 (payout paste, Expected vs Received, owner-managed statement mode).

## Current work in progress

Branch status, using `git rev-list --count origin/main..origin/<branch>`:

| Branch | Ahead of main | Last commit | Status |
|---|---|---|---|
| `claude/keen-ramanujan-kwnhmx` — **open PR #66** (opened 2026-10-11) | 10 | 2026-10-18 | **Active.** Cleaner PWA phases 1–5b; see below |
| `claude/annie-cancelled-status-mdvdyq` | 1 | 2026-10-14 | **Unmerged production fix, no PR.** See below |
| `claude/fyi-a9umu8` | 1 | 2026-10-20 | **Unmerged doc-only change, no PR.** Adds the "grant every new public table" rule to `supabase/migrations/README.md`, `CLAUDE.md` and `AGENTS.md` (Supabase stops auto-granting from 30 Oct 2026) |
| `codex/*` (11 branches), `test` | 20–57 (shallow-history artefact) | 2026-03-24 / 03-25 | **Stale.** Pre-date `main`'s fetched history (no merge-base in this shallow clone). The `codex/update-ui-based-on-new-design-rules` history shows PRs #31–#42 merging these branches in March 2026. Safe to delete after a quick check (**Unverified** that every commit landed) |
| `claude/transaction-reconciliation-redesign-5s9opj`, `claude/booking-cleaner-assignment-button-tdpwuj`, `claude/glenhaven-airbnb-integration-67p8kt`, `claude/hungry-lederberg-02f54e`, `claude/intelligent-archimedes`, `claude/serene-lumiere-a5d833`, `feature/bank-reconciliation`, `feature/expense-receipts-icon`, `feature/native-push`, `fix/owner-payout-cleaning-allocation`, `module-refactor`, `ds-store-516d9` | 0 | 2026-03-28 → 2026-10-24 | Fully merged; candidates for deletion |

**PR #66 — cleaner PWA (10 commits, 35 files, about +3.6k lines):**
- Day plan sorted by turnover deadline, start/finish (`cleans.started_at`), "Message host" via an `sms:` link, and a per-property cheat sheet (lockbox code revealed on the day only).
- Week strip and a subscribable `.ics` feed (new function `cleaner-calendar-feed.js`).
- Per-property checklist and photo proof (`cleans.checklist_done`, `cleans.photos`, `photos` bucket insert policy).
- Accept-all, heavy-day warnings, earnings card.
- Days off (`cleaner_unavailable`), visible to the host when assigning.
- Tenant-scoped `cleaner_dashboard_context()` RPC (`SECURITY DEFINER`).
- Cleaners reachable by push under their own auth user, assignment push, scheduled morning digest (`cleaner-morning-digest.js`, `0 20 * * *`), offline cached plan.
- Cleaners working for several hosts; hand-off to a teammate (`cleaner-handoff.js`).
- 3-day overdue window; Host/Cleaner switch on every sign-in path (`runSharedPostBootTasks()`); calendar sync no longer grows clean notes.
- Six new test files.
- The commit messages say all migrations were applied to prod, and that data fixes were run directly on the live DB (the 3-day window and the polluted-notes clean-up).

**`claude/annie-cancelled-status-mdvdyq` (1 commit):**
- Follows a production incident (14 Oct 2026) in which a live platform booking was cancelled because its mirrored Google event was deleted.
- Adds `utils/calendar-deletion.js` (platform bookings are kept and re-pushed, and the host is notified), re-linking of marker-tagged events, `utils/calendar-sync-log.js` (writes `calendar_sync_log`), real retry of pending outbound pushes, and migration `20261014_120000_cancellation_policy_columns.sql`.
- Adds `verifyAuthOrService()` (service key plus `uid`) so `poll-emails` → `gmail-scan-bookings` stops failing with 401. It still requires `supabase functions deploy poll-emails` after merge.
- Note: on this branch `poll-emails` **still selects users by `app_config.gmail_refresh_token`**, so the background poll would still find zero users.

## Outstanding bugs

Verified in the code at `b2c1d33` unless marked otherwise.

1. **Background Gmail poll does nothing.** `supabase/functions/poll-emails/index.ts` selects `app_config.gmail_refresh_token`, which nothing writes (tokens are in `email_connections` since `95a5346`). It also calls `gmail-scan-bookings` with no `Authorization` header, which `verifyAuth` rejects. Outlook is never polled. (Also `ANALYSIS-STRManagement.md` 1.2.)
2. **Deleting a mirrored calendar event soft-cancels the booking, including platform bookings** (`utils/calendar-reconcile-google.js` `applyEventDeletion`, and the Outlook equivalent). Fixed only on the calendar-deletion branch.
3. **Pending outbound calendar pushes are dropped:** `clearPendingOutbound()` in `calendar-sync-reconcile.js` nulls `pending_direction` without re-pushing (ANALYSIS 3.4).
4. **`calendar_sync_state` upserts** use `resolution=merge-duplicates` with no `on_conflict` and no `res.ok` check, on a table with two unique indexes (`utils/calendar-push-core.js:55`, `utils/calendar-reconcile-google.js:42`, `-outlook.js`) (ANALYSIS 1.5).
5. **Cancellation-policy columns may not exist:** `utils/cancellation-policy.js` selects `app_config.cancellation_window_days` and `cancellation_policy`, but no migration on `main` creates them. The calendar-deletion branch commit says the lookup returned HTTP 400 and fell back to 14 days. **Unverified** live.
6. **Live schema missing from `supabase/migrations/`:** `bank_accounts`, `bank_reconciliations` and `bank_transactions.bank_account_id` / `reconciled_at` / `reconciliation_id` (applied in `0bc3d2b`), `cleaner_unavailable` and the PR #66 objects. The bookings soft-delete trigger described in `CLAUDE.md` is also absent (**Unverified** that it exists live). `20261004_100000_bank_line_kinds.sql` cannot run on a fresh database because it references `bank_accounts`.
7. **Edge-function source not tracked:** `.gitignore` ignores `/supabase/functions`. The deployed `invite-cleaner` edge function has no source in the repo, and the frontend has not called it since 2026-04-03.
8. **Cross-tenant push and open email relay** (authenticated callers): `send-push.js` pushes to any caller-supplied `user_id`, and `send-email.js` sends any HTML to any recipient (ANALYSIS 4.12; still present).
9. **Public `.ics` feed keyed only on the permanent user id** (`calendar-feed.js`; ANALYSIS 4.9).
10. **Unauthenticated, uncalled `calendar-backfill-background`** (takes `uid` from the body).
11. **Dormant legacy cleaner endpoints still deployed:** `cleaner-data.js` returns cleans and booking guest names and payouts for `uid` + cleaner `local_id`; `cleaner-action.js` changes cleans, with a PIN check only when the cleaner has a PIN (ANALYSIS 4.3). The frontend no longer calls either.
12. **Daily digest "review cleaning cost" lookup:** `.or('local_id.eq.<id>,id.eq.<id>')` against a uuid `id` column, with no `user_id` filter and no error check (`daily-notifications.js:343-347`; ANALYSIS 1.10).
13. **Single-day iCal event gives a 0-night stub:** `checkout: ev.dtend || ev.dtstart` (`utils/ical-parse.js`; ANALYSIS 1.12).
14. **Bookings filter sheet does nothing:** `applyBookingFilters()` only re-renders, and `_applyAdvancedFilters()` is used only for the button count (`bookings.js:2204-2279`; ANALYSIS 1.32).
15. **Settings feed/booking counts always 0:** they read `window._icalFeeds` and `window._bookings`, which nothing assigns (`settings.js:974, 1612`; ANALYSIS 1.35).
16. **Email-template editor has no effect:** it saves `app_config.email_templates`, which no send reads (ANALYSIS 2.6).
17. **Missing notification icon:** `sw.js` uses `/icon-192.png`, which does not exist.
18. **Anthropic API key panel** (`index.html` "AI Booking Import"; `settings.js` `saveApiKey`) stores a key in `properties.anthropic_api_key` and localStorage that nothing uses, and its copy says "stored on this device only" (ANALYSIS 4.14).
19. **Smart Pricing still runs while hidden:** `scheduled-pricing-weekly` (Mondays) and `close-rate-outcomes` (daily) keep running, which costs Anthropic tokens for a feature hidden as "not working properly" (`a26788a`).
20. **`monthly-revenue-summary` has no scheduler in the repo** (ANALYSIS 2.8). **Unverified** whether a pg_cron job exists.
21. **Glenhaven block rows not filtered:** glenhaven-book inserts `bookings` with `source='manual-block'`, `platform='Blocked'` and `host_payout=0`, and asks StayOps to filter them. No filter exists in `assets/js`. **Unverified** how they appear in StayOps (likely as $0 / "payout pending" bookings).
22. **Unreachable features:** the Monthly Statement view (`showStatementView` has no entry point) and `onboarding-v2.js` (`runOnboarding` never called).
23. **Six pre-existing test failures** in `daily-notifications` / `push-helper`, reported in commit messages `a62406e`, `66d1870` and `ffe4a78` (**Unverified** here; dependencies not installed).
24. **Broken script:** `scripts/gen_app_js.mjs` reads `assets/js/main.js.bak`, which no longer exists.
25. **Security: a credential appears to be committed in git history of `scripts/daily-notifications-cron.sql` (a cron shared secret, scrubbed from the working tree in `f0b2380`) — rotate (if not already) and remove from history.** **Unverified** whether it was rotated.
26. **Personal data in a public repo:** real personal names and real account figures appear in `PLAN-bank-transactions-redesign.md`, `assets/js/bank-explain.js` (comment), `tests/bank-explain.test.js` (fixtures), `supabase/migrations/20261004_100000_bank_line_kinds.sql` (comment), `scripts/dedupe-bookings.mjs`, `scripts/cleanup-duplicate-bookings.mjs` and `Netlify/functions/utils/email-scan-shared.js` (comments). Some branch names and commit messages also contain guest names. Consider anonymising.

Other fixes from `ANALYSIS-STRManagement.md` were spot-checked and are fixed on `main`: 1.1, 1.3, 1.4, 1.6–1.8, 1.9 (Outlook filter now includes `modified`, `alteration`, `review`; Gmail additionally has `updated`, `request`, `arrival`), 1.15–1.19, 1.22, 1.28, 4.1, 4.2, 4.4–4.6, 4.8, 4.10, 4.11, 4.13.

## Planned changes

- Merge PR #66 (cleaner PWA) and the calendar-deletion branch (calendar-deletion safety, poll auth, cancellation columns). Then run `supabase functions deploy poll-emails`.
- Merge `claude/fyi-a9umu8`. From 30 Oct 2026, every `create table` in a migration must `grant` access to `authenticated` / `service_role`.
- Remaining `PLAN-bank-transactions-redesign.md` Phase 4 items: owner funds on statements; tax export filtered by `kind`; a `paid_via` filter and bulk action on Expenses; drop `vendor_mappings`.
- Restore Smart Pricing when it works (`a26788a`).
- Review the NSW school-holiday dates every year (`generate-pricing-suggestions.js:41`).

## Important decisions made

- Bookings are never deleted; cancellation is `status='cancelled'` plus `cancelled_at` and `cancellation_billable`. The billable window defaults to 14 days.
- Platform iCal feeds are the authoritative booking source; emails only enrich. Platform bookings must only be cancelled by the platform (iCal or email). On `main` this does not yet hold for calendar deletions.
- Finance attributes a stay to its **check-out** month (2026-10-02).
- Owner payout treats a stay as paid once check-in passes; there is no bank feed (2026-10-05).
- Bank: every line has a kind; every payment is an expense unless it is owner funds, a transfer or personal; refunds are credit notes; the month is locked once the balance agrees (2026-10-04/05).
- Schema changes must ship as idempotent migrations in the same commit (2026-07-08). Applying them to prod before the code merges has happened repeatedly; avoid it or commit the SQL first.
- Cleaners use email login only (2026-07-10); in-app chat was removed (2026-07-05).
- All user-triggered functions derive the user from the Supabase JWT, never from body or query `uid` (2026-06).
- No bundler; global bridges, guarded by `scripts/check-finance-split.sh`.

## Pending tests

**Existing suites** (run from the repo root): `npm install`, then `npm test` (= `node --test tests/*.test.js`).

| File | Covers |
|---|---|
| `airbnb-csv` | Airbnb payout CSV parsing |
| `bank-explain` | Bank-line explain engine |
| `booking-reporting-month` | Check-out month attribution |
| `booking-revenue-payout-pending` | Payout-pending flag |
| `cleaner-action` | Legacy cleaner endpoint |
| `daily-notifications` | Host morning digest |
| `email-scan-dedup`, `-modification-match`, `-repeat-booking`, `-reviews` | Email scan matching and review capture |
| `frontend-pure` | Pure date/time helpers |
| `ical-sync-adopt` | iCal adoption and safety rules |
| `owner-payout` | Owner statement maths |
| `push-helper` | Push gating and pruning |
| `smoke-handlers` | Handler-shape smoke tests |

Other checks:
- `npm run lint`
- `sh scripts/check-finance-split.sh` (passes at `b2c1d33`)
- `npm run smoke:deploy [baseUrl]` (read-only checks against the live site; defaults to `https://strmanagement.netlify.app`)

**Gaps / manual verification needed:**
- No UI tests. The Bank screen, owner statement, booking modals and the cleaner PWA are verified by hand only.
- No tests for the calendar reconcilers on `main` (the calendar-deletion branch adds `tests/calendar-deletion.test.js`), the OAuth callbacks, `send-email`, `generate-pricing-suggestions` or `fetch-listing`.
- After merging PR #66: walk through the deploy preview as a cleaner and as a host (multi-host cleaner, hand-off, days off, offline plan, morning digest timing).
- After merging the calendar-deletion branch: deploy `poll-emails`, confirm a scheduled run gets past auth, and fix the user query (bug 1).
- Confirm in Supabase that `bank_accounts`, `bank_reconciliations`, `cleaner_unavailable`, the cancellation columns, the pg_cron jobs and the bookings soft-delete trigger exist as the docs describe.
- iOS: confirm that the Codemagic `ios-testflight` build passes on `main` and that APNs push and share-to-app work on device.
- There is no CI: nothing runs tests or lint on push.

## Recommended next development tasks

1. **Merge the calendar-deletion branch** (calendar-deletion safety) after review, and fix `poll-emails` in the same PR to read `email_connections` (`provider='google'`, `refresh_token` not null) and to cover Outlook. Deploy the edge function, then verify the cancellation-policy columns exist live.
2. **Review and merge PR #66.** Its migrations are already live, so `main` currently misdescribes the schema. Expect a small `CLAUDE.md` / `AGENTS.md` conflict between PR #66, the calendar-deletion branch, `claude/fyi-a9umu8` and the AI-documentation block appended today.
3. **Bring the migrations in line with prod.** Dump and commit the DDL for `bank_accounts`, `bank_reconciliations`, the extra `bank_transactions` columns, the soft-delete triggers and the RLS policies. Un-ignore `/supabase/functions` (or force-add), and either commit or delete the `invite-cleaner` edge function.
4. **Security clean-up:** confirm `CRON_SECRET` was rotated; restrict `send-push` targets to the caller (or their cleaners) and `send-email` recipients; delete or disable `cleaner-data`, `cleaner-action` and `calendar-backfill-background`; move `calendar-feed` to a rotatable token; anonymise the personal data listed in bug 26.
5. **Fix the `calendar_sync_state` upsert** (`on_conflict` + `res.ok`) and the daily-digest `.or()` lookup.
6. **Decide on Smart Pricing:** pause `scheduled-pricing-weekly` / `close-rate-outcomes` while it is hidden, or fix it.
7. **Filter Glenhaven `manual-block` rows** (`platform='Blocked'`) out of StayOps booking lists and finance.
8. **Quick UI fixes:** apply the booking filter sheet, fix the Settings feed counts, fix the `sw.js` icon, remove the Anthropic key panel, and either wire up or delete the email-template editor, the Statement view and `onboarding-v2.js`.
9. **Add CI:** a GitHub Actions job running `npm ci && npm test && npm run lint && sh scripts/check-finance-split.sh`. Fix or quarantine the six known failures.
10. **Finish bank-plan Phase 4** (owner funds on statements, tax export by kind, Expenses `paid_via` filter) and drop `vendor_mappings`.

## Update log
- 2026-10-25 — Initial AI_CONTEXT/AI_HANDOFF created from codebase audit.
