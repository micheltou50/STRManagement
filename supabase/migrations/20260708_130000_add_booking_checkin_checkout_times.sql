-- Feature: per-booking check-in / check-out times (2026-07-08).
-- Bookings are stored date-only; these optional columns let a specific booking
-- override the standard turnover time (e.g. a guest granted a late checkout).
-- NULL = use the default (10:00 checkout / 15:00 check-in).
-- Type `time` = property-LOCAL wall clock (an accommodation check-in is "3pm at
-- the property", not an absolute UTC instant) — matches host_config/properties.timezone.
-- Consumed by getTurnoverTimes(booking) in assets/js/utils.js.
alter table public.bookings
  add column if not exists checkin_time  time,
  add column if not exists checkout_time time;

comment on column public.bookings.checkin_time  is 'Per-booking check-in time (property-local wall clock). NULL = default 15:00. Set when a guest requests an early/late check-in.';
comment on column public.bookings.checkout_time is 'Per-booking check-out time (property-local wall clock). NULL = default 10:00. Set when a guest requests a late/early check-out.';
