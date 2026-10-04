# Bank transactions and reconciliation: redesign plan

Status: proposal, nothing built yet. Written 2026-10-04 against the live `stayops`
Supabase project and the code on `main` (Transaction Map, Reconcile, bank import,
payout paste).

## 1. What is actually in the account

One host, one ANZ account, three properties, bank lines from Sep 2025 to Aug 2026.

| Fact | Count | Amount |
|---|---:|---:|
| Bank lines imported | 260 | |
| Money in lines | 83 | $96,481 |
| Money in lines with no explanation ("Unexplained" tile) | 75 | $83,613 |
| …of which: transfers from the owner (MARDINI C) | 37 | $49,890 |
| …of which: Airbnb payouts arriving via Payoneer, plus one VRBO | 28 | $33,008 |
| …of which: supplier refunds (Temu, Amazon, Bunnings, Costco, Pillow Talk, MJS Electrical) | 9 | $715 |
| …of which: bank interest adjustment | 1 | $0.01 |
| Platform payouts recorded but "not received" | 27 | $33,008 |
| …of which have an identical-amount deposit within 0–3 days | 27 | all |
| Money out lines with no expense | 17 | $3,182 |
| Expenses with no bank line (shown as "Expenses with no payment") | 93 | $178,049 |
| …of which Renovation + Furnishings, i.e. almost certainly paid from elsewhere | 65 | $153,471 |
| Periods ever closed on the Reconcile screen | 0 | |
| Times the same ANZ.csv was re-imported with 0 new rows | 5 | |

Two things follow from this table.

1. **"Unexplained" is not one problem.** It is four different kinds of money with
   four different correct answers, and the screen offers only one of them
   ("Match payout"). Half the dollars are the owner topping the account up, which
   is not income and not an expense and can never be matched to anything.
2. **The payouts are already matchable.** Every one of the 27 "not received"
   payouts has its deposit sitting in the list. The "Match 27 deposits" button
   would clear them. The screen gives no reason to trust it, so it has not been
   pressed.

Two smaller findings that shape the plan:

- The learned vendor rules are keyed on the bank prefix, not the merchant.
  The top rules in the account are `VISA DEBIT PURCHASE CARD` → "other" (29 uses)
  and `ANZ MOBILE BANKING PAYMENT` → "cleaning" (24 uses). That is why "learned"
  categorisation never feels learned. `normaliseVendorPattern()` keeps the first
  four words, and on an ANZ statement the first four words are the bank's.
- The import review screen will not import any row, including a deposit, until it
  has a property and an expense category. That is why early imports show 59 of 73
  rows skipped, and why deposits were categorised as expenses just to get them in.

## 2. Why the current screens fail

- **Two screens for one job.** Transaction Map (match lines) and Reconcile (tick
  lines and type a closing balance) are halves of the same workflow, and neither
  tells you whether you are finished.
- **Money In has one verb.** A credit can be a payout, a refund, owner money, a
  transfer between your own accounts, interest, or personal. Only "payout" exists.
  The refund path that already exists in Expenses ("This is a refund / credit")
  is unreachable from the bank side.
- **Money Out has one verb plus two escape hatches.** "Personal" and "Skip" are
  the only ways to say "not an expense", and neither says what the line was.
  Money paid to the owner, moved to another account, or repaid on a loan has no
  honest answer.
- **The summary tiles lie.** "Unaccounted" on Money Out adds in $150k of
  renovation expenses that were never paid from this account, and "Unexplained"
  on Money In is dominated by money that needs no explanation beyond "owner".
- **Import demands decisions before it has shown you anything.** Property and
  category per row, before you can see the month as a whole, and the file lands
  in whichever view happens to be hidden.
- **Reconcile asks you to tick rows the app itself imported.** The code comment
  admits ticking is busywork. Nothing has ever been closed.

## 3. The model: one list, every line explained

Replace "match debits to expenses, match credits to payouts" with one rule:

> Every bank line gets exactly one **kind** (what sort of money movement it is),
> plus a **link** to the thing it settles when such a thing exists.
> The account is reconciled for a month when every line has a kind and the
> statement balance agrees with the lines.

### Kinds for money in

| Kind | Means | Links to | Effect on reports |
|---|---|---|---|
| Platform payout | Airbnb / VRBO / Booking.com / Stayz paid you | `platform_payouts` row(s), and through them the bookings | None directly. Revenue already comes from bookings; this is the evidence it arrived |
| Direct booking payment | A guest paid you directly | a booking | Marks the booking paid. Revenue still comes from the booking |
| Refund of an expense | A supplier gave money back | the original expense; creates a credit-note expense (negative) in the same category and property | Reduces that category's total, same as the refund checkbox does today |
| Owner funds in | The owner (or you) put money in | optional property | Owner statement "Funds received". Never profit and loss |
| Transfer between my accounts | From another account you own | the other bank account | Neutral |
| Interest or bank adjustment | Interest paid, fee reversed | nothing | Other income, or nets a bank-fee expense |
| Other income | Insurance payout, bond claim, rebate | optional booking or expense | Other income |
| Personal | Not business | nothing | Excluded everywhere |

### Kinds for money out

The rule is simple: **every payment is an expense.** On a dedicated rental
account that is true for all but two cases, so the app books each debit as an
expense the moment it is imported, with its best guess at the category, and the
host only ever flips the exceptions. A $10 account servicing fee is an expense
under Bank fees, not a question. The only thing a payment can ever ask is
"is this category right?", and even that never blocks the booking.

| Kind | Means | Links to | Effect on reports |
|---|---|---|---|
| Expense (the default) | A cost of running the property | an expense (link an existing one if the amount and merchant match, else create) | Profit and loss by category, as today |
| Owner funds out | Paid to the owner, or drawn by you | optional property | Owner statement "Paid to owner". Never profit and loss |
| Transfer between my accounts | To another account you own | the other bank account | Neutral |
| Refund to a guest | Money back to a guest on a direct booking | a booking | Reduces that booking's revenue |
| Personal | Not business | nothing | Excluded everywhere |

Loan repayments are deliberately left out of the first cut. The monthly payment
to MARDINI CHADDY is already booked as "Expense → Mortgage" and stays that way;
splitting principal from interest is a later step.

"Bank fees" is added to the default expense categories, mapped to Sundry in the
ATO export, so the servicing fees have a home instead of landing in Other.

### How sure the app is

Every explanation carries a source and a confidence, and the list shows it:

| Tier | Where it comes from | What the host sees |
|---|---|---|
| Certain | A built-in rule, a remembered decision used before, or an exact one-to-one amount match | Applied already. Chip reads "auto". Undo on tap |
| Suggested | A single-use memory, a near match, or an AI guess | Pre-filled, row flagged "to decide". One tap confirms |
| Unknown | Nothing fits | Row flagged "to decide", no kind |

"To decide" is the only queue. When it is empty and the balance agrees, the month
is done. That sentence is the whole screen.

## 4. The flow

1. **Load a statement** (CSV, PDF or photo, as today). Parsing and de-duplication
   are already solid and stay.
2. **Every new line is saved immediately**, with no kind, stamped with the import
   batch and the statement's opening and closing balance when the file carries
   them. There is no per-row review wall. If the file is all duplicates the app
   says "all 95 rows are already in" and stops, instead of rendering a review
   screen of greyed rows.
3. **The explain engine runs** over the new lines (section 7) and applies the
   certain tier, pre-fills the suggested tier. Every debit that is not flagged
   owner, transfer or personal becomes an expense right here, linked to the bank
   line; a weak category guess only marks that expense "check category".
4. **You land on the Bank screen** for that month with a one-line result:
   "52 new · 41 explained · 11 to decide".
5. **You work the "To decide" queue.** Tap a row, pick the kind, pick the link if
   one is offered, done. "Remember this for MARDINI C" is on by default, so the
   second owner transfer and the thirty-seventh cost the same: nothing.
6. **The balance strip** at the top compares statement closing balance with
   opening plus the lines. It is green or it names the gap, using the hints that
   `explainOutOfBalance()` already produces (a missing import, a doubled batch,
   one line's exact amount).
7. **Lock the month** when the queue is empty and the strip is green. That writes
   the `bank_reconciliations` row and stamps the lines, exactly as the close does
   today, minus the ticking.

Expected-but-missing payouts (statement pasted, deposit never arrived) stay
visible as ghost rows under the Payouts filter, which is the one genuinely good
idea in the current Money In ledger and is kept as is.

Expenses with no bank line leave this screen entirely. They are a question about
the expense ("how was this paid?"), not about the bank, so they become a filter
on the Expenses screen with a bulk action "Paid elsewhere". Only expenses marked
as paid from this account and still unlinked count as waiting for a bank line.

## 5. The screen

One entry under Finance, replacing both "Transaction Map" and "Reconcile".
Suggested name: **Bank**.

Top to bottom, phone first:

- **Account and month.** One account today; the picker appears only when a
  second exists. Month arrows, same as the statement view.
- **Balance card.** "Statement closing $12,340.10 · From your lines $12,340.10 ✓".
  When out, the gap and the best hint. A "Lock August" button that is enabled only
  when green and the queue is empty. Locked months show a padlock and an Unlock.
- **Three tiles.** To decide (count and dollars) · Money in explained · Money out
  explained. Nothing called "Unexplained" or "Unaccounted".
- **Filter chips.** To decide · In · Out · Payouts · Refunds · Owner · Personal ·
  All.
- **Rows.** Date · counterparty (the cleaned merchant name, raw bank text one tap
  away) · signed amount · explanation chip ("Airbnb payout → 2 bookings",
  "Refund → Amazon $51.67, Furnishings", "Owner funds in") · source chip (auto /
  suggested / you).
- **Tap a row → "What is this?" sheet.** The kinds as large buttons, the suggested
  one highlighted. Under the chosen kind, the context that kind needs: candidate
  payouts, candidate expenses (exact first, near ones labelled by how far off),
  candidate bookings, or a property picker for owner funds. For a refund with no
  recorded original, "Create credit note" with merchant, category and property
  pre-filled from memory. A "Remember for <counterparty>" toggle, on by default.
- **Bulk.** Long-press to select; apply one kind to many. A "Confirm all
  suggested" button when there are suggestions.
- **Import** stays as one button at the top ("Load statement"). The payout paste
  stays as a second button and is also reachable from inside the sheet when a
  deposit looks like a payout but no statement matches.

Desktop gets the same thing as a table with the sheet docked on the right.

## 6. Data changes

All idempotent, in `supabase/migrations/`, committed with the code that uses them.

`bank_transactions`
- `kind text` with a check constraint on the kinds above. Null means unexplained.
- `kind_source text` (`rule` / `memory` / `match` / `ai` / `manual`) and
  `kind_confidence numeric`.
- `needs_review boolean not null default true`.
- `counterparty text`: the normalised merchant, computed once at import.
- `booking_id uuid` for direct booking payments and guest refunds.
- `transfer_account_id uuid` for transfers between accounts.
- `notes text`.
- Backfill: `is_personal` → `personal`; rows with `expense_id` → `expense`; rows a
  `platform_payouts.bank_transaction_id` points at → `platform_payout`; rows that
  were `skipped` and not personal → kind null, `needs_review` true (one row in the
  live account). `is_personal` and `skipped` stay for one release as mirrors, then
  go.
- Keep `platform_payouts.bank_transaction_id` as the payout-to-deposit link; one
  deposit still settles many payouts.

`expenses`
- `refund_of_expense_id uuid` (nullable). A credit note points at what it refunds,
  so the expense view can show "refunded $51.67 on 14 Jul" and the original is
  left untouched with its receipt.
- `paid_via text default 'unknown'` (`this_account` / `other_account` /
  `owner_direct` / `cash` / `unknown`). Lets the 93 unlinked expenses stop
  masquerading as reconciliation work.

`bank_import_log`
- `bank_account_id`, `period_start`, `period_end`, `opening_balance`,
  `closing_balance`, `source_type`. The log row is created before the lines so
  `import_batch_id` is finally populated, which the batch-level out-of-balance
  hint already expects.

`bank_memory` (new, replaces `vendor_mappings`)
- `(user_id, counterparty_key)` unique → `kind`, `category`, `property_id`,
  `platform`, `times_used`, `last_used_at`. Migrate the 14 existing rows where the
  key is a real merchant; drop the ones that are bank prefixes.

`bank_reconciliations`: unchanged. Row ticking goes; locking a month stamps every
line in the period.

## 7. The explain engine

A pure module, `assets/js/bank-explain.js`, no window access, tested in
`tests/`. Runs in this order and stops at the first certain answer.

1. **Normalise the counterparty.** Strip the bank's own words
   (`VISA DEBIT PURCHASE CARD 0500`, `ANZ MOBILE BANKING PAYMENT 110245 TO`,
   `TRANSFER FROM`, `VISA DEBIT DEPOSIT`, reference numbers, suburb, state).
   The `Expenses-app` repo already has a working normaliser and memory matcher
   written for exactly this, keyed on merchant tokens rather than position; port
   those two files rather than reinventing them. "VISA DEBIT DEPOSIT" and
   "EFTPOS" on a credit are themselves a signal: card refund.
2. **Built-in rules, certain tier.** `PAYONEER`, `AIRBNB`, `VRBO`, `EXPEDIA`,
   `BOOKING.COM`, `STAYZ` → platform payout. Counterparty equals a host, company
   or property-owner name → owner funds in / out. `INTEREST` → interest or
   adjustment. `ACCOUNT SERVICING FEE` → expense, bank fees.
3. **Memory.** Remembered decision for this counterparty: certain after two uses,
   suggested after one.
4. **Evidence match.** Payout → `planPayoutAutoMatch()` as it exists today, which
   refuses anything ambiguous. Expense → the existing debit scorer. Refund → an
   expense with the same counterparty, amount at or below the original, within
   120 days. Direct booking → a booking whose host payout equals the amount near
   check-in or check-out.
5. **AI, suggested tier only.** Haiku, batched 20 at a time, only for what is
   left, returning one of the kinds plus a category and a reason. Never certain.
6. Everything else is unknown.

Decisions the host makes on the sheet write back to memory and re-run step 3
over the rest of the month, so fixing one row fixes its siblings in the same
import.

## 8. What happens to the existing pieces

| Piece | Verdict |
|---|---|
| `money-in-model.js` (ledger, `planPayoutAutoMatch`, cents arithmetic) | Keep. Becomes the Payouts filter and the payout matcher |
| `reconcile-period.js` (balance arithmetic, out-of-balance hints) | Keep unchanged. Drives the balance card |
| `airbnb-csv.js`, `finance-payout-paste.js` | Keep |
| `bank-import.js` parsing, duplicate check, AI PDF read | Keep. `confirmTransaction()` is split: insert line, then explain |
| `finance-bank-import.js` review screen | Retire. Replaced by the one-line import result and the To decide queue |
| `finance.js` lines 3772–4780 (Transaction Map rendering and handlers) | Retire. Replaced by the Bank screen in its own module |
| `finance-reconcile.js` tick-box close | Retire. Lock button on the Bank screen uses the same `saveReconciliation()` |
| `reconciliation.js` | Thin out. `getAllTransactionsWithStatus`, `findPayoutMatchesForBankTransaction`, `linkTransactionToPayout`, `linkTransactionToExpense` stay; `autoReconcile`, `getReconciliationSummary`, `unlinkTransaction` have no callers and go |
| `vendor_mappings` | Migrate the real merchants into `bank_memory`, then drop |
| Expense refund checkbox and `booking_allocations` sign handling | Keep. The credit note the bank side creates is exactly this |
| Reports and tax export | Income still from bookings. Add an "Owner funds" section to the owner statement and the monthly statement. Tax export filters on kind so personal and owner lines can never leak in |

## 9. Phases, and what you would see after each

**Phase 0, bulk-mark FY 2025-26 (half a day, runs once).**
What's done is done: last financial year is closed in one pass, not row by row.
The explain engine (section 7) runs over the 209 lines dated before 1 July 2026
and applies everything it finds, with no confirmation step:

| Lines before 1 July 2026 | Count | Becomes |
|---|---:|---|
| Transfers in from MARDINI C | 37 | Owner funds in |
| Card refunds (Temu, Bunnings, Pillow Talk and so on) | 5 | Credit notes against the matching purchase, or a standalone credit note when no purchase is recorded |
| Bank interest adjustment | 1 | Interest or adjustment |
| Extra Payoneer transfer with no pasted statement | 1 | Platform payout, Airbnb, no statement |
| Debits with no expense (servicing fees, Bunnings, Kmart, pest control, water, locksmith, a cleaner) | 18 | Expenses, category by rule, Bank fees for the fees, Other where unsure |
| Expenses dated in the year with no bank line | 93 | `paid_via = other_account`, so they stop showing as work |

The 27 payouts that were "not received" when section 1 was written have since
been matched in the app, so they need nothing. Then FY 2025-26 is locked: it
never appears in a queue again, and the lock is reversible. Expected result:
zero to decide for last year, and this year opens with four refunds and one
payment to book.

**Phase 1, data (one to two days).**
Migrations in section 6, backfill from existing links, `bank_memory` seeded from
the surviving vendor rules, import batches recorded with balances.

**Phase 2, engine (two days).**
`bank-explain.js` with tests for every tier and for the owner-name and refund
rules, using the real patterns from this account as fixtures.

**Phase 3, the Bank screen (two to three days).**
New module, new entry under Finance, import without the review wall, balance
card, lock. Transaction Map and Reconcile removed from the hub and the nav.

**Phase 4, reports and clean-up (one day).**
Owner funds on statements, `paid_via` filter and bulk action on Expenses, tax
export exclusions, dead code deleted, `check-finance-split.sh` baseline updated.

Each phase ships on its own and leaves the app working. Phase 0 alone fixes the
screenshot.

## 10. Decisions needed before building

1. **The kind names.** The lists in section 3 are the proposal. Anything to add,
   merge or rename? In particular: is "Owner funds" the right word for the
   MARDINI C transfers, and should that be per property (Glenhaven is the only
   owner-managed one) or a single pool?
2. **Refunds as credit notes.** Recommended: a negative expense linked to the
   original, not an edit of the original amount. The original keeps its receipt,
   the bank line links one-to-one, and the existing refund checkbox already
   produces this shape.
3. **The MARDINI C transfers in.** "Owner funds in" is the proposed label. The
   payments out to MARDINI CHADDY stay as Mortgage expenses, as you have them.
   Decided: the 93 unlinked expenses from last year are bulk-marked as paid
   from another account, not matched.
4. **Retire row ticking.** Recommended: yes. Every line comes from a statement, so
   the balance check is the real control. One check I could not do from here: does
   the ANZ CSV export carry a running balance column? If it does, opening and
   closing come for free and nothing is ever typed.
5. **Naming.** "Bank" under Finance, replacing "Transaction Map" and "Reconcile".

## 11. Not in scope

- A live bank feed. Import stays manual.
- Double-entry bookkeeping or a general ledger. The kinds are enough to keep
  owner money out of profit and loss, which is the actual requirement.
- Changes to how GST is recorded.
- Booking.com and Stayz handling beyond the keyword rules; neither appears in the
  account yet.
