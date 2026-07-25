-- Feature: multi-stay expense allocation (2026-07-25). Idempotent — safe to re-run.
-- A cleaner invoices one lump sum covering ~5 cleans across ~5 different stays, but an
-- expense could only ever link to ONE booking (expenses.booking_id). That forced the host
-- to either split the invoice into N expense rows (which no longer reconciles against the
-- single bank line) or pin the whole amount on one stay (which mis-costs all of them).
--
-- booking_allocations carries N {booking_id, amount} pairs on the SINGLE expense row:
--   * amounts are SIGNED, matching the sign of expenses.amount, so a cleaner credit note
--     REDUCES a stay's cost rather than adding to it;
--   * they need NOT sum to expenses.amount — any remainder is a plain operational expense
--     belonging to no particular stay (see unallocatedExpenseAmount());
--   * expenses.booking_id is KEPT, as the mirror of element 0, so the existing FK, partial
--     index, single-stay queries and the untouched single-stay UI all keep working.
-- Consumed by normalizeExpenseAllocations() / expenseAllocations() / sumAllocations() /
-- unallocatedExpenseAmount() in assets/js/utils.js.

-- 1. The column. `not null default '[]'` (rather than a nullable jsonb) means every
--    existing row and every older client that never sends the field still reads back a
--    well-formed empty array, so no reader needs a null guard.
alter table public.expenses
  add column if not exists booking_allocations jsonb not null default '[]'::jsonb;

comment on column public.expenses.booking_allocations is
  'Multi-stay split: jsonb array of {"booking_id":"<uuid string>","amount":<signed numeric>}. Amounts carry the same sign as expenses.amount and need NOT sum to it — the remainder is an unallocated operational cost. expenses.amount remains the authoritative total for the expense; expenses.booking_id is the mirror of element 0. Empty array = not split (legacy single-stay link, or no stay at all).';

-- 2. Shape guard: readers index into this with jsonb_array_length / -> 0, so an object or
--    scalar written by a buggy client would break them silently. Wrapped in a pg_constraint
--    lookup because Postgres has no `add constraint if not exists`.
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'expenses_booking_allocations_is_array'
      and conrelid = 'public.expenses'::regclass
  ) then
    alter table public.expenses
      add constraint expenses_booking_allocations_is_array
      check (jsonb_typeof(booking_allocations) = 'array');
  end if;
end $$;

-- 3. Backfill. An existing single-stay link means "this whole expense belongs to that
--    stay", which is exactly a one-element allocation carrying the full amount.
--    `jsonb_array_length(booking_allocations) = 0` makes the statement SELF-EXCLUDING:
--    once a row has been backfilled — or once a host has split it by hand — it can never
--    match again, so re-running this file is a genuine no-op and never clobbers real
--    allocations with a stale single-element array.
update public.expenses
   set booking_allocations = jsonb_build_array(
         jsonb_build_object('booking_id', booking_id::text, 'amount', coalesce(amount, 0))
       )
 where booking_id is not null
   and jsonb_array_length(booking_allocations) = 0;

-- 4. GIN index so "which expenses touch this stay?" stays a containment lookup
--    (booking_allocations @> '[{"booking_id":"<uuid>"}]') instead of a table scan, now that
--    the link is no longer only a plain indexed column. Default jsonb_ops opclass — it is
--    the one that supports @> on the whole document.
create index if not exists expenses_booking_allocations_gin
  on public.expenses using gin (booking_allocations);

-- No RLS change needed: the existing "expenses: own data only" policy is
-- FOR ALL USING (auth.uid() = user_id) — row-scoped, so it already covers this new column.
-- booking_id is deliberately neither dropped nor altered; it is the mirror, not dead weight.
