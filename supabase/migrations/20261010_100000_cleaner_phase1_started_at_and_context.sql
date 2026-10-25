-- Cleaner phase 1 (2026-10-10): on-site tracking + cleaner dashboard context.
-- Idempotent — safe to re-run.
--
-- 1. cleans.started_at — set when the cleaner taps "Start clean" in the cleaner
--    PWA (assets/js/render-cleaner.js cleanerStartClean). Read by the host's
--    cleaning pipeline (assets/js/cleaning.js getBookingCleanerState ->
--    'in_progress') and mapped in assets/js/supabase-cleans.js (startedAt).
--
-- 2. cleaner_dashboard_context() — SECURITY DEFINER RPC called from
--    loadCleanerDashboard() in assets/js/supabase.js. A cleaner signs in with
--    their own Supabase user; RLS exposes only their cleans + assigned
--    properties. Two things the Today view needs are NOT reachable that way:
--      * host_config (host name + phone, for the "Message Host" sms: button);
--      * the OTHER bookings at an assigned property, to work out the next
--        guest's check-in — the deadline for a same-day turnover.
--    This function returns exactly those, scoped to the calling cleaner, with
--    a deliberately minimal column list (no payouts, no guest contact details,
--    no guest names). Bookings are limited to a rolling window plus any booking
--    directly linked to one of the cleaner's cleans.
--    The Supabase security advisor flags "Signed-In Users Can Execute SECURITY
--    DEFINER Function" for it — that is the intent: every row it returns is
--    filtered through the caller's auth.uid(), and anon has no execute grant.

alter table public.cleans add column if not exists started_at timestamptz;
comment on column public.cleans.started_at is
  'When the cleaner tapped "Start clean" in the cleaner PWA. NULL = not started.';

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
    select cl.booking_id, cl.property_id
    from public.cleans cl
    join me on cl.cleaner_uuid = me.id
  ),
  my_props as (
    select distinct property_id from my_cleans where property_id is not null
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
      where (
              b.property_id in (select property_id from my_props)
          and b.checkout >= (current_date - 14)
          and b.checkin  <= (current_date + 120)
        )
        or b.local_id in (select booking_id from my_cleans where booking_id is not null)
        or b.id::text  in (select booking_id from my_cleans where booking_id is not null)
    ), '[]'::jsonb)
  );
$$;

comment on function public.cleaner_dashboard_context() is
  'Cleaner PWA: host contact + minimal turnover bookings for the calling cleaner (auth.uid()). SECURITY DEFINER because RLS hides host_config and sibling bookings from cleaners.';

revoke all on function public.cleaner_dashboard_context() from public;
revoke all on function public.cleaner_dashboard_context() from anon;
grant execute on function public.cleaner_dashboard_context() to authenticated;
