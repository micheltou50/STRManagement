-- Feature: bank lines get a KIND (2026-10-04). Idempotent — safe to re-run.
--
-- The Transaction Map could only say two things about a bank line: "matched to
-- an expense" (debits) or "matched to a payout" (credits). Everything else sat
-- as Unaccounted / Unexplained forever: 37 owner top-ups, 9 supplier refunds, a
-- cent of interest. This migration gives every bank line one explanation.
--
--   bank_transactions.kind       what sort of money movement this is
--   bank_transactions.needs_review  the only queue: true until the host (or a
--                                certain rule) has settled it
--   bank_memory                  "last time you said MARDINI C was Owner funds",
--                                keyed on the NORMALISED merchant, not the bank's
--                                prefix (vendor_mappings keyed on "VISA DEBIT
--                                PURCHASE CARD", which is why it never learned)
--   expenses.refund_of_expense_id  a credit note points at what it refunds
--   expenses.paid_via            how an expense was paid, so one paid from
--                                another account stops looking like
--                                reconciliation work
--   bank_import_log.*            the statement's period and balances, so the
--                                balance check needs nothing typed
--
-- Consumed by assets/js/bank-explain.js (pure engine), supabase-bank-lines.js
-- (data layer) and finance-bank.js (the Bank screen).

-- ── 1. bank_transactions: the kind and its provenance ─────────────────────────
alter table public.bank_transactions
  add column if not exists kind text,
  add column if not exists kind_source text,
  add column if not exists kind_confidence numeric,
  add column if not exists needs_review boolean not null default true,
  add column if not exists counterparty text,
  add column if not exists booking_id uuid references public.bookings(id) on delete set null,
  add column if not exists notes text,
  add column if not exists reviewed_at timestamptz;

comment on column public.bank_transactions.kind is
  'One of: platform_payout, direct_booking, expense_refund, owner_funds, transfer, interest, other_income, personal (credits); expense, owner_funds, transfer, guest_refund, personal (debits). NULL = not yet explained. direction carries in/out, so owner_funds and transfer are the same kind both ways.';
comment on column public.bank_transactions.kind_source is
  'rule | memory | match | ai | manual | bulk | backfill — where the kind came from.';
comment on column public.bank_transactions.needs_review is
  'TRUE until the kind is certain (a rule, a remembered decision or the host). The Bank screen''s "To decide" queue is exactly these rows.';
comment on column public.bank_transactions.counterparty is
  'Normalised merchant (bank prefixes, reference numbers, suburb and state stripped). Computed once by counterpartyKey() in bank-explain.js; the key into bank_memory.';

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'bank_transactions_kind_check'
      and conrelid = 'public.bank_transactions'::regclass
  ) then
    alter table public.bank_transactions
      add constraint bank_transactions_kind_check
      check (kind is null or kind in (
        'platform_payout','direct_booking','expense_refund','owner_funds','transfer',
        'interest','other_income','personal','expense','guest_refund'));
  end if;
end $$;

create index if not exists bank_transactions_user_date_idx
  on public.bank_transactions (user_id, date);
create index if not exists bank_transactions_user_review_idx
  on public.bank_transactions (user_id) where needs_review;

-- Backfill from the links that already exist. Each statement is self-excluding
-- (kind is null), so re-running never overwrites a decision made since.
update public.bank_transactions t
   set kind = 'expense', kind_source = 'backfill', kind_confidence = 1,
       needs_review = false, reviewed_at = coalesce(reviewed_at, now())
 where kind is null and expense_id is not null;

update public.bank_transactions t
   set kind = 'platform_payout', kind_source = 'backfill', kind_confidence = 1,
       needs_review = false, reviewed_at = coalesce(reviewed_at, now())
 where kind is null
   and exists (select 1 from public.platform_payouts p where p.bank_transaction_id = t.id);

update public.bank_transactions
   set kind = 'personal', kind_source = 'backfill', kind_confidence = 1,
       needs_review = false, reviewed_at = coalesce(reviewed_at, now())
 where kind is null and coalesce(is_personal, false);

-- A row that was "skipped" but not personal was never explained; it stays
-- kind NULL / needs_review TRUE and goes back into the queue. is_personal and
-- skipped are kept as mirrors for one release.

-- ── 2. expenses: credit notes and how it was paid ─────────────────────────────
alter table public.expenses
  add column if not exists refund_of_expense_id uuid references public.expenses(id) on delete set null,
  add column if not exists paid_via text not null default 'unknown';

comment on column public.expenses.refund_of_expense_id is
  'Set on a credit note (negative amount): the expense it refunds. The original is left untouched, receipt and all.';
comment on column public.expenses.paid_via is
  'this_account | other_account | owner_direct | cash | unknown. Only this_account + no bank line is reconciliation work.';

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'expenses_paid_via_check'
      and conrelid = 'public.expenses'::regclass
  ) then
    alter table public.expenses
      add constraint expenses_paid_via_check
      check (paid_via in ('this_account','other_account','owner_direct','cash','unknown'));
  end if;
end $$;

-- An expense that already carries a bank line was, by definition, paid from it.
update public.expenses
   set paid_via = 'this_account'
 where paid_via = 'unknown' and bank_transaction_id is not null;

create index if not exists expenses_refund_of_idx
  on public.expenses (refund_of_expense_id) where refund_of_expense_id is not null;

-- ── 3. bank_import_log: the statement behind each import ──────────────────────
alter table public.bank_import_log
  add column if not exists bank_account_id uuid references public.bank_accounts(id) on delete set null,
  add column if not exists period_start date,
  add column if not exists period_end date,
  add column if not exists opening_balance numeric,
  add column if not exists closing_balance numeric,
  add column if not exists source_type text;

-- ── 4. bank_memory: remembered decisions per merchant ─────────────────────────
-- user_id carries no FK to auth.users, matching bank_transactions and the other
-- per-user tables in the baseline; the RLS policy below is what scopes rows.
-- (Applied to prod 2026-10-05 via the Supabase MCP, statement by statement.)
create table if not exists public.bank_memory (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null,
  counterparty_key text not null,
  direction        text not null default 'debit',
  kind             text not null,
  category         text,
  property_id      uuid references public.properties(id) on delete set null,
  platform         text,
  times_used       integer not null default 1,
  last_used_at     timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, counterparty_key, direction)
);

comment on table public.bank_memory is
  'What the host decided the last time a merchant appeared. Keyed on the normalised counterparty + direction (AMAZON as a debit is an expense; AMAZON as a credit is a refund). Replaces vendor_mappings, whose keys were bank prefixes.';

create index if not exists bank_memory_user_idx on public.bank_memory (user_id);

alter table public.bank_memory enable row level security;

drop policy if exists "bank_memory: own rows" on public.bank_memory;
create policy "bank_memory: own rows"
  on public.bank_memory
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- vendor_mappings is deliberately left in place for now; nothing reads it after
-- this change, and dropping it is a separate, visible step once bank_memory has
-- a month of decisions in it.
