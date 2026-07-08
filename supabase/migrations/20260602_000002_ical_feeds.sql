-- ═══════════════════════════════════════════════════════════════════════════
-- StayOps — iCal feeds + Channel Manager removal migration
-- Run in Supabase SQL editor.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. New table: per-property iCal feeds (Airbnb, Booking.com, VRBO, Stayz, …)
create table if not exists public.property_ical_feeds (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  property_id  uuid not null references public.properties(id) on delete cascade,
  platform     text not null check (platform in ('airbnb','booking','vrbo','stayz','other')),
  ical_url     text not null,
  active       boolean not null default true,
  last_synced_at timestamptz,
  last_error   text,
  created_at   timestamptz not null default now()
);

create index if not exists property_ical_feeds_user_idx on public.property_ical_feeds(user_id);
create index if not exists property_ical_feeds_property_idx on public.property_ical_feeds(property_id);

alter table public.property_ical_feeds enable row level security;

drop policy if exists "users can manage own ical feeds" on public.property_ical_feeds;
create policy "users can manage own ical feeds"
  on public.property_ical_feeds
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 2. Bookings: iCal linkage + enrichment status
alter table public.bookings
  add column if not exists ical_uid text,
  add column if not exists ical_feed_id uuid references public.property_ical_feeds(id) on delete set null,
  add column if not exists enrichment_status text;

create unique index if not exists bookings_user_ical_uid_uidx
  on public.bookings(user_id, ical_uid)
  where ical_uid is not null;

-- 3. Drop the channel manager table and columns
drop table if exists public.channel_property_map;

alter table public.app_config
  drop column if exists channel_manager_provider,
  drop column if exists channel_manager_connected,
  drop column if exists channel_manager_tier,
  drop column if exists channel_manager_last_sync,
  drop column if exists channel_manager_sync_error;

-- 4. Track iCal sync state at the user level (optional; per-feed state lives on property_ical_feeds)
alter table public.app_config
  add column if not exists ical_last_sync timestamptz,
  add column if not exists ical_last_error text;
