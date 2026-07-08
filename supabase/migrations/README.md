# Database migrations

The repo's source of truth for the StayOps / Glenhaven Supabase schema
(project `nbeuyypgiipptxlqnhel`). Before this folder existed, schema changes were
typed straight into production, which caused silent "missing column" save
failures. That stops now.

## The rule

**Every code change that touches the database ships with a migration file here,
in the same commit.** No exceptions — if a save references a new column, the
`ALTER TABLE` that adds it must be committed alongside it.

## Conventions

- **Name:** `YYYYMMDD_HHMMSS_short_description.sql` (timestamp-ordered).
- **Idempotent, always.** Use `IF NOT EXISTS` / `IF EXISTS` so re-running is a
  safe no-op:
  ```sql
  alter table public.bookings add column if not exists checkin_time time;
  create table if not exists public.foo (...);
  create index if not exists idx_foo_bar on public.foo (bar);
  ```
- **Header comment** on each file: what changed and which app code depends on it.

## Applying

There is no migration *runner* — you apply them by pasting the SQL into the
Supabase MCP / SQL editor as you always have. The discipline is that the SQL is
now **committed and diffable**, and idempotent so "did I apply it?" is answered
by just re-running it.

## Files

- `0000_baseline_schema.sql` — snapshot of the production schema on 2026-07-08
  (columns + RLS-enable flags). Column-level only; it does **not** reproduce
  every constraint/index/FK/trigger or the RLS *policies*, which still live in
  prod. It exists to document + diff the shape, not to clone prod byte-for-byte.
- `20260602_*` … `20260624_*` — the previously-loose migrations from `scripts/`,
  folded in here with their original dates.

## After any schema change

Run the Supabase security/performance advisors (via the Supabase MCP
`get_advisors`) — a new table without an RLS policy, or an over-permissive one,
shows up there.
