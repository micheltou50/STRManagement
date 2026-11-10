-- cleaner_dashboard_context(): add `teammates` (2026-10-14).
-- Idempotent — `create or replace`, no DROP (the Supabase MCP stalls on DROP; see README).
--
-- Why: a cleaner who cannot make a clean can hand it to a colleague of the
-- same host ("Can't make it? → Hand off to Sam" in the cleaner PWA;
-- Netlify/functions/cleaner-handoff.js does the reassignment). RLS lets a
-- cleaner read only their own cleaners row, so the colleague list comes from
-- this SECURITY DEFINER RPC: id, name and host user_id ONLY — no contact
-- details, no auth ids (the hand-off function pushes the teammate server-side).
-- Teammates are the other active cleaners of every host the caller works for,
-- excluding the caller's own rows and any row sharing the caller's login.
--
-- Everything else is unchanged from 20261011_130000 (tenant-scoped bookings).
-- Output: { hosts: [...], bookings: [...], teammates: [{id, name, user_id}] }

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
          exists (
            select 1 from my_cleans mc
            where mc.booking_id is not null
              and mc.user_id = b.user_id
              and (mc.booking_id = b.local_id or mc.booking_id = b.id::text)
          )
        )
    ), '[]'::jsonb),
    'teammates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',      t.id,
        'name',    t.name,
        'user_id', t.user_id
      ) order by t.name)
      from public.cleaners t
      where t.user_id in (select user_id from me)
        and t.active is distinct from false
        and t.id not in (select id from me)
        and t.auth_user_id is distinct from auth.uid()
    ), '[]'::jsonb)
  );
$$;

comment on function public.cleaner_dashboard_context() is
  'Cleaner PWA: host contact, minimal turnover bookings (scoped to each clean''s host) and teammates (id/name/host only) for the calling cleaner (auth.uid()). SECURITY DEFINER because RLS hides host_config, sibling bookings and other cleaners from cleaners.';

revoke all on function public.cleaner_dashboard_context() from public;
revoke all on function public.cleaner_dashboard_context() from anon;
grant execute on function public.cleaner_dashboard_context() to authenticated;
