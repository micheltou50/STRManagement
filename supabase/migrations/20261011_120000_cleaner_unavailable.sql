-- Cleaner phase 3b (2026-10-11): cleaner availability — days off.
-- Idempotent — safe to re-run. Policies are created inside DO blocks guarded by
-- pg_policies lookups rather than `drop policy if exists` + `create policy`,
-- because the Supabase MCP stalls on DROP statements (see README).
--
-- A cleaner marks a day off in the cleaner PWA Calendar tab
-- (assets/js/render-cleaner.js cleanerToggleDayOff); the host sees it when
-- assigning a clean on that date (assets/js/cleaning.js: the cleaner select in
-- Add Clean / Change Assignment flags "day off", and auto-assign skips an
-- unavailable preferred cleaner). Read on both sides via RLS:
--   * cleaner  — full control of their own rows (cleaners.auth_user_id = auth.uid())
--   * host     — read-only on rows of cleaners they employ (cleaners.user_id = auth.uid())

create table if not exists public.cleaner_unavailable (
  id           uuid primary key default gen_random_uuid(),
  cleaner_uuid uuid not null references public.cleaners(id) on delete cascade,
  day          date not null,
  note         text,
  created_at   timestamptz not null default now(),
  unique (cleaner_uuid, day)
);

comment on table public.cleaner_unavailable is
  'Days a cleaner has marked themselves unavailable. One row per cleaner per day.';

alter table public.cleaner_unavailable enable row level security;

create index if not exists idx_cleaner_unavailable_cleaner_day
  on public.cleaner_unavailable (cleaner_uuid, day);

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'cleaner_unavailable'
      and policyname = 'cleaner_manage_own_unavailable'
  ) then
    create policy cleaner_manage_own_unavailable
      on public.cleaner_unavailable
      for all
      to authenticated
      using (cleaner_uuid in (select id from public.cleaners where auth_user_id = auth.uid()))
      with check (cleaner_uuid in (select id from public.cleaners where auth_user_id = auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'cleaner_unavailable'
      and policyname = 'host_read_cleaner_unavailable'
  ) then
    create policy host_read_cleaner_unavailable
      on public.cleaner_unavailable
      for select
      to authenticated
      using (cleaner_uuid in (select id from public.cleaners where user_id = auth.uid()));
  end if;
end
$$;
