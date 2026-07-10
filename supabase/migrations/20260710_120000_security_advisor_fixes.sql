-- Security advisor fixes (2026-07-10). Idempotent — safe to re-run.
-- Addresses Supabase security linter findings:
--   * notification_log INSERT policy WITH CHECK (true)           -> scope to owner
--   * touch_updated_at / link_cleaner_on_signup mutable search_path -> pin to ''
--   * guest_offers: RLS enabled with no policy                    -> add scoped owner policy
-- SHARED project (StayOps + Glenhaven): every scope is tenant-isolated by user_id/property_id,
-- so both apps are unaffected (and both benefit from the hardening).

-- 1. notification_log — replace the always-true INSERT check with the same owner scope
--    the existing read policy uses. Real inserts come from the service role (push-helper),
--    which bypasses RLS entirely, so this is a no-op for current writes; it only blocks a
--    future authenticated/anon insert attempt.
drop policy if exists "Service role can insert" on public.notification_log;
create policy "Service role can insert"
  on public.notification_log
  for insert
  with check (
    property_id in (select properties.id from properties where properties.user_id = auth.uid())
  );

-- 2. Pin a fixed search_path on both trigger functions. Both fully schema-qualify their
--    table references (public.cleaners / public.user_roles) and use only pg_catalog
--    built-ins (now(), lower()), so '' is non-behavioral pure hardening.
alter function public.touch_updated_at() set search_path = '';
alter function public.link_cleaner_on_signup() set search_path = '';

-- 3. guest_offers — table has RLS enabled but zero policies (deny-all). Add a scoped owner
--    policy so the linter clears and, if the (currently unused) feature ships, it is
--    tenant-isolated from the start. Non-destructive; the table is not dropped.
drop policy if exists "Hosts manage own guest_offers" on public.guest_offers;
create policy "Hosts manage own guest_offers"
  on public.guest_offers
  for all
  using (property_id in (select id from properties where user_id = auth.uid()))
  with check (property_id in (select id from properties where user_id = auth.uid()));
