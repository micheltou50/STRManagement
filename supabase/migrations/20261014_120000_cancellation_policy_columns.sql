-- ═══════════════════════════════════════════════════════════════════════════
-- StayOps — cancellation policy columns on app_config
--
-- Both the frontend (assets/js/supabase.js hydration, booking-revenue.js) and
-- the Netlify functions (utils/cancellation-policy.js) read
-- app_config.cancellation_window_days and app_config.cancellation_policy, but
-- the columns were never created. Every server-side lookup returned HTTP 400
-- and the hard-coded 14-day fallback applied to every cancellation, so e.g. a
-- booking wrongly cancelled two days before check-in was marked "billable".
--
-- Both columns are nullable; NULL keeps the existing 14-day fallback.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.app_config
  add column if not exists cancellation_window_days integer;

alter table public.app_config
  add column if not exists cancellation_policy jsonb;

comment on column public.app_config.cancellation_window_days is
  'Days before check-in inside which a cancellation is treated as billable (late cancel). NULL = app default (14).';

comment on column public.app_config.cancellation_policy is
  'Optional structured cancellation policy, e.g. {"window_days": 7}. Read by utils/cancellation-policy.js when cancellation_window_days is NULL.';
