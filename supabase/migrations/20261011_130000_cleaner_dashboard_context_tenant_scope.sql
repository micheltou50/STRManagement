-- cleaner_dashboard_context(): scope every booking lookup to the clean's host (2026-10-11).
-- Idempotent — `create or replace`, no DROP (the Supabase MCP stalls on DROP; see README).
--
-- Why: the function is SECURITY DEFINER, so it bypasses bookings RLS. The first
-- version (20261010_100000) matched a clean's own booking with
--   b.local_id in (select booking_id from my_cleans) or b.id::text in (...)
-- without a tenant key. cleans.booking_id holds the host's LOCAL id, which is
-- only unique per host (bookings are upserted per (user_id, local_id)), so a
-- collision with another host's local_id — or a chosen one — would have returned
-- that host's booking dates, occupancy and status. Found by the Codex review on
-- PR #66. Every clean row carries the host's user_id, so both branches (the
-- clean's own booking and the sibling bookings at an assigned property) now
-- also require b.user_id to match that clean's user_id.
--
-- Same output shape as before: { hosts: [{user_id, name, company, phone}],
--   bookings: [{id, local_id, property_id, checkin, checkout, checkin_time,
--               checkout_time, guests, status}] }
-- consumed by loadCleanerDashboard() in assets/js/supabase.js.

create or replace function public.cleaner_dashboard_context()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select id, user_id
    from public.cleaners
    where auth_user_id = auth.uid()
      and active is distinct from false
  ),
  my_cleans as (
    -- cleans.user_id is the host (tenant) that owns the clean: the key every
    -- booking lookup below is scoped with.
    select cl.booking_id, cl.property_id, cl.user_id
    from public.cleans cl
    join me on cl.cleaner_uuid = me.id
  ),
  my_props as (
    select distinct property_id, user_id
    from my_cleans
    where property_id is not null
  )
  select jsonb_build_object(
    'hosts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', hc.user_id,
        'name',    hc.name,
        'company', hc.company,
        'phone',   hc.phone
      ))
      from public.host_config hc
      where hc.user_id in (select user_id from me)
    ), '[]'::jsonb),
    'bookings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',            b.id,
        'local_id',      b.local_id,
        'property_id',   b.property_id,
        'checkin',       b.checkin,
        'checkout',      b.checkout,
        'checkin_time',  b.checkin_time,
        'checkout_time', b.checkout_time,
        'guests',        b.guests,
        'status',        b.status
      ))
      from public.bookings b
      where
        (
          -- sibling bookings at a property this cleaner is assigned to, same host
          exists (
            select 1 from my_props mp
            where mp.property_id = b.property_id
              and mp.user_id = b.user_id
          )
          and b.checkout >= (current_date - 14)
          and b.checkin  <= (current_date + 120)
        )
        or
        (
          -- the clean's own booking, same host (local_id is only unique per host)
          exists (
            select 1 from my_cleans mc
            where mc.booking_id is not null
              and mc.user_id = b.user_id
              and (mc.booking_id = b.local_id or mc.booking_id = b.id::text)
          )
        )
    ), '[]'::jsonb)
  );
$$;

comment on function public.cleaner_dashboard_context() is
  'Cleaner PWA: host contact + minimal turnover bookings for the calling cleaner (auth.uid()), scoped to the host (cleans.user_id) of each clean. SECURITY DEFINER because RLS hides host_config and sibling bookings from cleaners.';

revoke all on function public.cleaner_dashboard_context() from public;
revoke all on function public.cleaner_dashboard_context() from anon;
grant execute on function public.cleaner_dashboard_context() to authenticated;
