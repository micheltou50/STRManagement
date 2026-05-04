-- ═══════════════════════════════════════════════════════════════════════════
-- StayOps — Two-way calendar sync migration (PR 1: Google Calendar)
-- Run in Supabase SQL editor.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Per-event mapping: local row ↔ provider event
create table if not exists public.calendar_sync_state (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  provider              text not null check (provider in ('google_calendar','outlook_calendar','apple_caldav')),
  local_table           text not null check (local_table in ('bookings','cleans','maintenance','inbox')),
  local_id              text,                          -- null while inbox-pending (no local row yet)
  provider_event_id     text not null,
  provider_calendar_id  text not null,
  provider_etag         text,
  local_updated_at      timestamptz,
  provider_updated_at   timestamptz,
  last_synced_at        timestamptz not null default now(),
  pending_direction     text check (pending_direction in ('to_provider','to_local')),
  inbox_payload         jsonb,                          -- raw event for untriaged phone events
  created_at            timestamptz not null default now()
);

create unique index if not exists calendar_sync_state_local_uidx
  on public.calendar_sync_state(user_id, provider, local_table, local_id)
  where local_id is not null;

create unique index if not exists calendar_sync_state_remote_uidx
  on public.calendar_sync_state(user_id, provider, provider_event_id);

create index if not exists calendar_sync_state_user_idx
  on public.calendar_sync_state(user_id);

create index if not exists calendar_sync_state_pending_idx
  on public.calendar_sync_state(pending_direction)
  where pending_direction is not null;

alter table public.calendar_sync_state enable row level security;

drop policy if exists "users can manage own calendar sync state" on public.calendar_sync_state;
create policy "users can manage own calendar sync state"
  on public.calendar_sync_state
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 2. Lightweight debug log (auto-pruned after 30 days)
create table if not exists public.calendar_sync_log (
  id          bigserial primary key,
  user_id     uuid references auth.users(id) on delete cascade,
  provider    text,
  direction   text check (direction in ('to_provider','to_local')),
  local_table text,
  local_id    text,
  provider_event_id text,
  op          text,                  -- 'insert','update','delete','skip','error'
  message     text,
  created_at  timestamptz not null default now()
);

create index if not exists calendar_sync_log_user_idx on public.calendar_sync_log(user_id, created_at desc);

alter table public.calendar_sync_log enable row level security;

drop policy if exists "users can read own calendar sync log" on public.calendar_sync_log;
create policy "users can read own calendar sync log"
  on public.calendar_sync_log
  for select
  using (auth.uid() = user_id);

-- 3. email_connections additions
--    - calendar_id: id of the dedicated "StayOps" calendar at the provider
--    - sync_token:  Google Calendar incremental sync token
--    - watch_*:     Google push channel registration
alter table public.email_connections
  add column if not exists calendar_id           text,
  add column if not exists sync_token            text,
  add column if not exists watch_channel_id      text,
  add column if not exists watch_resource_id     text,
  add column if not exists watch_expires_at      timestamptz;

-- 4. Bookings: add notes column for phone-side title/notes round-trip
alter table public.bookings
  add column if not exists notes text;

-- 5. Ensure updated_at columns exist with auto-bump triggers
--    (bookings/cleans/maintenance already have updated_at populated by app code,
--    but a trigger guarantees correctness when rows are touched directly.)
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'bookings_touch_updated_at') then
    create trigger bookings_touch_updated_at before update on public.bookings
      for each row execute function public.touch_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'cleans_touch_updated_at') then
    create trigger cleans_touch_updated_at before update on public.cleans
      for each row execute function public.touch_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'maintenance_touch_updated_at') then
    -- maintenance already has updated_at column added via earlier app code; if not, add it
    begin
      alter table public.maintenance add column if not exists updated_at timestamptz default now();
    exception when others then null;
    end;
    create trigger maintenance_touch_updated_at before update on public.maintenance
      for each row execute function public.touch_updated_at();
  end if;
end $$;
