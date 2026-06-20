-- StayOps — daily morning push digest (7:00 Australia/Sydney via UTC cron)
--
-- 1) Add dedupe column on app_config (run once in Supabase SQL editor).
-- 2) Enable extensions if needed: pg_cron, pg_net (Supabase Dashboard → Database → Extensions).
-- 3) Schedule: 21:00 UTC = 07:00 AEST (UTC+10). During AEDT (UTC+11), use 20:00 UTC instead
--    (see comment block at bottom).

alter table app_config
  add column if not exists daily_notifications_last_aest_date text;

comment on column app_config.daily_notifications_last_aest_date is
  'StayOps daily-notifications: last Sydney calendar date (YYYY-MM-DD) processed; prevents duplicate morning digests.';

-- Unschedule previous job with same name if you are re-applying:
-- select cron.unschedule('daily-notifications');

select cron.schedule(
  'daily-notifications',
  '0 21 * * *',
  $$
  select net.http_post(
    url := 'https://app.stayops.com.au/.netlify/functions/daily-notifications',
    -- SECURITY: the real secret must NOT live in committed SQL. Set CRON_SECRET
    -- in Netlify env, store the SAME (rotated) value in Supabase Vault, and pull
    -- it in here instead of hardcoding. The previously-committed literal has been
    -- scrubbed and MUST be rotated. Replace the placeholder before running:
    headers := '{"Content-Type": "application/json", "x-cron-secret": "<SET_ROTATED_CRON_SECRET_FROM_VAULT>"}'::jsonb,
    body := '{}'::jsonb
  ) as request_id;
  $$
);

-- ── Timezone note ─────────────────────────────────────────────
-- AEST  (Apr–Oct approx):  Sydney 07:00 = previous day 21:00 UTC  → cron "0 21 * * *"
-- AEDT (Oct–Apr approx):  Sydney 07:00 = previous day 20:00 UTC  → cron "0 20 * * *"
-- Pick one consistent slot or maintain two cron jobs / change twice yearly.
