'use strict';
// First frontend test tripwire (see supabase/migrations/README + the architecture
// review). Covers the pure date/time helpers the turnover + per-booking-times
// features rest on. Frontend modules are ESM, so we dynamic-import them from this
// CJS test. Grows opportunistically — add a case whenever a pure-logic bug bites.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const utilsUrl = pathToFileURL(path.join(__dirname, '..', 'assets', 'js', 'utils.js')).href;
const importUtils = () => import(utilsUrl);

test('getTurnoverTimes() defaults to 10:00 checkout / 15:00 check-in', async () => {
  const { getTurnoverTimes } = await importUtils();
  const t = getTurnoverTimes();
  assert.strictEqual(t.checkoutHour, 10);
  assert.strictEqual(t.checkoutMin, 0);
  assert.strictEqual(t.checkinHour, 15);
  assert.strictEqual(t.checkinMin, 0);
  assert.strictEqual(t.checkoutLabel, '10:00');
  assert.strictEqual(t.checkinLabel, '15:00');
});

test('getTurnoverTimes() reads a config override and formats labels', async () => {
  const { getTurnoverTimes } = await importUtils();
  globalThis.window = { _appConfig: { turnover_times: { checkoutHour: 11, checkoutMin: 30, checkinHour: 14, checkinMin: 0 } } };
  try {
    const t = getTurnoverTimes();
    assert.strictEqual(t.checkoutHour, 11);
    assert.strictEqual(t.checkoutLabel, '11:30');
    assert.strictEqual(t.checkinHour, 14);
    assert.strictEqual(t.checkinLabel, '14:00');
  } finally {
    delete globalThis.window;
  }
});

test('getTurnoverTimes(booking) uses the booking\'s own override times', async () => {
  const { getTurnoverTimes } = await importUtils();
  const t = getTurnoverTimes({ checkoutTime: '12:00', checkinTime: '16:30' });
  assert.strictEqual(t.checkoutHour, 12);
  assert.strictEqual(t.checkoutLabel, '12:00');
  assert.strictEqual(t.checkinHour, 16);
  assert.strictEqual(t.checkinMin, 30);
  assert.strictEqual(t.checkinLabel, '16:30');
});

test('getTurnoverTimes(booking) parses "HH:MM:SS" (Postgres time) and falls back per-field', async () => {
  const { getTurnoverTimes } = await importUtils();
  const t = getTurnoverTimes({ checkoutTime: '11:00:00', checkinTime: null });
  assert.strictEqual(t.checkoutLabel, '11:00'); // from the booking
  assert.strictEqual(t.checkinLabel, '15:00');  // null -> default
});

test('findTurnoverClashes(): default times never clash (10:00 out < 15:00 in)', async () => {
  const { findTurnoverClashes } = await importUtils();
  const out = { name: 'A', checkin: '2026-07-04', checkout: '2026-07-08', status: 'confirmed', _propertyId: 'p1' };
  const inn = { name: 'B', checkin: '2026-07-08', checkout: '2026-07-10', status: 'confirmed', _propertyId: 'p1' };
  assert.strictEqual(findTurnoverClashes([out, inn]).length, 0);
});

test('findTurnoverClashes(): late checkout past the next check-in clashes with negative gap', async () => {
  const { findTurnoverClashes } = await importUtils();
  const out = { name: 'A', checkin: '2026-07-04', checkout: '2026-07-08', checkoutTime: '16:00', status: 'confirmed', _propertyId: 'p1' };
  const inn = { name: 'B', checkin: '2026-07-08', checkout: '2026-07-10', status: 'confirmed', _propertyId: 'p1' }; // default 15:00 in
  const clashes = findTurnoverClashes([out, inn]);
  assert.strictEqual(clashes.length, 1);
  assert.strictEqual(clashes[0].gapMinutes, -60);
  assert.strictEqual(clashes[0].out.name, 'A');
  assert.strictEqual(clashes[0].in.name, 'B');
});

test('findTurnoverClashes(): zero gap counts as a clash; different property or day does not', async () => {
  const { findTurnoverClashes } = await importUtils();
  const outSame = { name: 'A', checkin: '2026-07-04', checkout: '2026-07-08', checkoutTime: '15:00', status: 'confirmed', _propertyId: 'p1' };
  const innSame = { name: 'B', checkin: '2026-07-08', checkout: '2026-07-10', status: 'confirmed', _propertyId: 'p1' };
  assert.strictEqual(findTurnoverClashes([outSame, innSame])[0].gapMinutes, 0);
  const innOtherProp = { ...innSame, _propertyId: 'p2' };
  assert.strictEqual(findTurnoverClashes([outSame, innOtherProp]).length, 0);
  const innOtherDay = { ...innSame, checkin: '2026-07-09' };
  assert.strictEqual(findTurnoverClashes([outSame, innOtherDay]).length, 0);
  const cancelled = { ...innSame, status: 'cancelled' };
  assert.strictEqual(findTurnoverClashes([outSame, cancelled]).length, 0);
});

test('localDateStr() returns the LOCAL calendar day, not UTC', async () => {
  const { localDateStr } = await importUtils();
  // 2:46pm local on 8 Jul — must stay 8 Jul (the UTC-shift bug returned 7 Jul before ~10am)
  assert.strictEqual(localDateStr(new Date(2026, 6, 8, 14, 46, 0)), '2026-07-08');
  assert.strictEqual(localDateStr(new Date(2026, 0, 1, 0, 5, 0)), '2026-01-01');
});

test('localDateStr() returns "" for an invalid date', async () => {
  const { localDateStr } = await importUtils();
  assert.strictEqual(localDateStr('not-a-date'), '');
});

test('parseLocalDayStart() parses YYYY-MM-DD at local midnight', async () => {
  const { parseLocalDayStart } = await importUtils();
  const d = parseLocalDayStart('2026-07-08');
  assert.strictEqual(d.getFullYear(), 2026);
  assert.strictEqual(d.getMonth(), 6);   // July = 6
  assert.strictEqual(d.getDate(), 8);
  assert.strictEqual(d.getHours(), 0);
});

test('parseLocalDayStart() of an empty string is an Invalid Date', async () => {
  const { parseLocalDayStart } = await importUtils();
  assert.ok(Number.isNaN(parseLocalDayStart('').getTime()));
});

// ─────────────────────────────────────────────────────────────────────────────
// Expense → booking allocations (one cleaner invoice split across N stays).
// Money maths, so the assertions are on integer CENTS wherever a sum is
// involved — a float comparison here can pass by luck and hide the dust bug
// these helpers exist to prevent.
// ─────────────────────────────────────────────────────────────────────────────

/** Sum an array of dollar amounts as integer cents (no float dust). */
const totalCents = arr => arr.reduce((s, n) => s + Math.round(n * 100), 0);

test('evenSplitAmounts(): $100 across 3 gives 33.34/33.33/33.33 and sums to exactly $100', async () => {
  const { evenSplitAmounts } = await importUtils();
  const shares = evenSplitAmounts(100, 3);
  assert.deepStrictEqual(shares, [33.34, 33.33, 33.33]); // remainder cent leads
  assert.strictEqual(totalCents(shares), 10000);
});

test('evenSplitAmounts(): $600 across 4 gives four clean $150 shares', async () => {
  const { evenSplitAmounts } = await importUtils();
  const shares = evenSplitAmounts(600, 4);
  assert.deepStrictEqual(shares, [150, 150, 150, 150]);
  assert.strictEqual(totalCents(shares), 60000);
});

test('evenSplitAmounts(): n<=0 gives [], n=1 gives the whole total', async () => {
  const { evenSplitAmounts } = await importUtils();
  assert.deepStrictEqual(evenSplitAmounts(100, 0), []);
  assert.deepStrictEqual(evenSplitAmounts(100, -2), []);
  assert.deepStrictEqual(evenSplitAmounts(100, 1), [100]);
  assert.deepStrictEqual(evenSplitAmounts(0, 3), [0, 0, 0]);
});

test('evenSplitAmounts(): a NEGATIVE total (credit note) stays negative in every share', async () => {
  const { evenSplitAmounts } = await importUtils();
  const shares = evenSplitAmounts(-100, 3);
  assert.deepStrictEqual(shares, [-33.34, -33.33, -33.33]);
  assert.ok(shares.every(a => a < 0), 'a refund must never flip a share positive');
  assert.strictEqual(totalCents(shares), -10000);
});

test('normalizeExpenseAllocations(): undefined / junk / non-array all degrade to []', async () => {
  const { normalizeExpenseAllocations } = await importUtils();
  assert.deepStrictEqual(normalizeExpenseAllocations(undefined), []); // column not applied yet
  assert.deepStrictEqual(normalizeExpenseAllocations(null), []);
  assert.deepStrictEqual(normalizeExpenseAllocations('not json at all'), []);
  assert.deepStrictEqual(normalizeExpenseAllocations('{"bookingId":"b1"}'), []); // valid JSON, wrong shape
  assert.deepStrictEqual(normalizeExpenseAllocations(42), []);
  assert.deepStrictEqual(normalizeExpenseAllocations({ bookingId: 'b1', amount: 10 }), []);
  assert.deepStrictEqual(normalizeExpenseAllocations([]), []);
});

test('normalizeExpenseAllocations(): parses a JSON string and accepts the DB booking_id key', async () => {
  const { normalizeExpenseAllocations } = await importUtils();
  const out = normalizeExpenseAllocations('[{"booking_id":"b1","amount":175},{"bookingId":"b2","amount":175}]');
  assert.deepStrictEqual(out, [
    { bookingId: 'b1', amount: 175 },
    { bookingId: 'b2', amount: 175 }
  ]);
});

test('normalizeExpenseAllocations(): drops rows with no bookingId, keeps the rest', async () => {
  const { normalizeExpenseAllocations } = await importUtils();
  const out = normalizeExpenseAllocations([
    { amount: 50 },                       // no id at all
    { bookingId: '', amount: 50 },        // empty string id
    { bookingId: null, amount: 50 },
    null,
    'nope',
    { bookingId: 'b7', amount: 50 }
  ]);
  assert.deepStrictEqual(out, [{ bookingId: 'b7', amount: 50 }]);
});

test('normalizeExpenseAllocations(): non-finite amounts become 0 and ids become strings', async () => {
  const { normalizeExpenseAllocations } = await importUtils();
  const out = normalizeExpenseAllocations([
    { bookingId: 'b1', amount: 'abc' },
    { bookingId: 'b2' },
    { bookingId: 'b3', amount: Infinity },
    { bookingId: 12345, amount: '90.129' } // numeric id + string amount, both straight from the DB
  ]);
  assert.deepStrictEqual(out, [
    { bookingId: 'b1', amount: 0 },
    { bookingId: 'b2', amount: 0 },
    { bookingId: 'b3', amount: 0 },
    { bookingId: '12345', amount: 90.13 }
  ]);
});

test('expenseAllocations(): legacy single-link row yields one allocation for the FULL amount', async () => {
  const { expenseAllocations } = await importUtils();
  // Pre-migration rows (and the auto-expense in cleaner-action.js) only ever set bookingId.
  assert.deepStrictEqual(
    expenseAllocations({ amount: 165.35, bookingId: 'b1' }),
    [{ bookingId: 'b1', amount: 165.35 }]
  );
});

test('expenseAllocations(): no allocations and no bookingId yields []', async () => {
  const { expenseAllocations } = await importUtils();
  assert.deepStrictEqual(expenseAllocations({ amount: 80 }), []);
  assert.deepStrictEqual(expenseAllocations({ amount: 80, bookingAllocations: [] }), []);
  assert.deepStrictEqual(expenseAllocations(null), []);
});

test('expenseAllocations(): real allocations win over the legacy bookingId mirror', async () => {
  const { expenseAllocations } = await importUtils();
  const e = {
    amount: 400,
    bookingId: 'b1', // mirror of element 0 — must not double up
    bookingAllocations: [{ bookingId: 'b1', amount: 175 }, { bookingId: 'b2', amount: 175 }]
  };
  assert.deepStrictEqual(expenseAllocations(e), [
    { bookingId: 'b1', amount: 175 },
    { bookingId: 'b2', amount: 175 }
  ]);
});

test('sumAllocations()/unallocatedExpenseAmount(): $400 invoice, 2 x $175, leaves $50 operational', async () => {
  const { sumAllocations, unallocatedExpenseAmount } = await importUtils();
  const e = { amount: 400, bookingAllocations: [{ bookingId: 'b1', amount: 175 }, { bookingId: 'b2', amount: 175 }] };
  assert.strictEqual(sumAllocations(e), 350);
  assert.strictEqual(unallocatedExpenseAmount(e), 50);
});

test('unallocatedExpenseAmount(): a legacy single-link row leaves EXACTLY 0 (stops the payout double-count)', async () => {
  const { unallocatedExpenseAmount } = await importUtils();
  // If this ever returns non-zero the rollups deduct the clean twice: once via
  // the stay's cleaning cost and again as an operational expense.
  assert.strictEqual(unallocatedExpenseAmount({ amount: 165.35, bookingId: 'b1' }), 0);
  assert.strictEqual(unallocatedExpenseAmount({ amount: 0.3, bookingId: 'b1' }), 0);
  assert.strictEqual(unallocatedExpenseAmount({ amount: 120, bookingAllocations: [{ bookingId: 'b1', amount: 120 }] }), 0);
});

test('unallocatedExpenseAmount(): a fully unallocated expense keeps its whole amount', async () => {
  const { unallocatedExpenseAmount, sumAllocations } = await importUtils();
  const e = { amount: 89.9 };
  assert.strictEqual(sumAllocations(e), 0);
  assert.strictEqual(unallocatedExpenseAmount(e), 89.9);
  assert.strictEqual(unallocatedExpenseAmount(null), 0);
});

test('signed allocations: a cleaner credit note REDUCES the stays it is split across', async () => {
  const { evenSplitAmounts, sumAllocations, unallocatedExpenseAmount } = await importUtils();
  const shares = evenSplitAmounts(-220, 2);
  const e = {
    amount: -220,
    bookingAllocations: shares.map((amount, i) => ({ bookingId: 'b' + i, amount }))
  };
  assert.deepStrictEqual(shares, [-110, -110]);
  assert.strictEqual(sumAllocations(e), -220);
  assert.strictEqual(unallocatedExpenseAmount(e), 0);
});

test('even split round-trip: 5 stays off one invoice leave nothing unallocated', async () => {
  const { evenSplitAmounts, sumAllocations, unallocatedExpenseAmount } = await importUtils();
  const total = 100; // the awkward one — 33.34/33.33/... style remainders
  [2, 3, 4, 5, 7].forEach(n => {
    const e = {
      amount: total,
      bookingAllocations: evenSplitAmounts(total, n).map((amount, i) => ({ bookingId: 'b' + i, amount }))
    };
    assert.strictEqual(sumAllocations(e), total, `sum must be exact for n=${n}`);
    assert.strictEqual(unallocatedExpenseAmount(e), 0, `no remainder for n=${n}`);
  });
});

// ── MONEY-IN LEDGER + PERIOD RECONCILE ───────────────────────────────────────
// The two pure modules the money-in unification rests on. These carry real
// invariants, not smoke tests: one deposit can settle N payouts, amounts are
// stored absolute with the sign in `direction`, and the reconcile arithmetic is
// integer cents so an out-of-balance figure can actually reach exactly zero.
const moneyInUrl = pathToFileURL(path.join(__dirname, '..', 'assets', 'js', 'money-in-model.js')).href;
const reconcileUrl = pathToFileURL(path.join(__dirname, '..', 'assets', 'js', 'reconcile-period.js')).href;

test('buildMoneyInLedger(): one deposit settling N payouts collapses to ONE matched row', async () => {
  const { buildMoneyInLedger } = await import(moneyInUrl);
  const rows = buildMoneyInLedger({
    payouts: [
      { _cloudId: 'p1', net: 1208.75, bankTransactionId: 't1', status: 'active' },
      { _cloudId: 'p2', net: 100.00,  bankTransactionId: 't1', status: 'active' },
    ],
    creditTxns: [{ id: 't1', date: '2026-03-11', amount: 1308.75 }],
  });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].kind, 'matched');
  assert.deepStrictEqual(rows[0].payoutIds, ['p1', 'p2']);
  assert.strictEqual(rows[0].varianceCents, 0);
});

test('buildMoneyInLedger(): separates expected-not-received from unexplained deposits', async () => {
  const { buildMoneyInLedger, summariseMoneyIn } = await import(moneyInUrl);
  const rows = buildMoneyInLedger({
    payouts: [
      { _cloudId: 'p3', net: 918.65, payoutDate: '2026-03-30', bankTransactionId: null, status: 'active' },
      { _cloudId: 'p4', net: 50, bankTransactionId: null, status: 'deleted' }, // soft-deleted
    ],
    creditTxns: [{ id: 't2', date: '2026-03-20', amount: 400, description: 'MYSTERY' }],
  });
  assert.strictEqual(rows.find(r => r.txnId === 't2').kind, 'credit_only');
  assert.strictEqual(rows.find(r => r.key === 'payout:p3').kind, 'payout_only');
  assert.ok(!rows.some(r => r.payoutIds.includes('p4')), 'soft-deleted payout must not appear');
  const s = summariseMoneyIn(rows);
  assert.strictEqual(s.expected, 1);
  assert.strictEqual(s.unexplained, 1);
});

test('computePeriodReconcile(): closing = opening + credits - debits, over cleared rows only', async () => {
  const { computePeriodReconcile } = await import(reconcileUrl);
  const r = computePeriodReconcile({
    openingBalanceCents: 100000,
    statementClosingCents: 120000,
    transactions: [
      { id: 'a', amount: 500, direction: 'credit', cleared: true },
      { id: 'b', amount: 300, direction: 'debit', cleared: true },
      { id: 'c', amount: 999, direction: 'debit', cleared: false },
    ],
  });
  assert.strictEqual(r.calculatedClosingCents, 120000);
  assert.strictEqual(r.outOfBalanceCents, 0);
  assert.strictEqual(r.balanced, true);
  assert.strictEqual(r.unclearedCount, 1);
});

test('computePeriodReconcile(): integer cents, so 0.1 + 0.2 lands on exactly $0.30', async () => {
  const { computePeriodReconcile } = await import(reconcileUrl);
  // Float accumulation here is what leaves an out-of-balance stuck at
  // $0.0000001 and unable to reach zero, which would make the feature useless.
  const r = computePeriodReconcile({
    openingBalanceCents: 0,
    statementClosingCents: 30,
    transactions: [
      { id: 'a', amount: 0.1, direction: 'credit', cleared: true },
      { id: 'b', amount: 0.2, direction: 'credit', cleared: true },
    ],
  });
  assert.strictEqual(r.calculatedClosingCents, 30);
  assert.strictEqual(r.balanced, true);
});

test('computePeriodReconcile(): null direction is a debit; signed amounts are absoluted', async () => {
  const { computePeriodReconcile } = await import(reconcileUrl);
  assert.strictEqual(
    computePeriodReconcile({ transactions: [{ id: 'a', amount: 100, cleared: true }] }).debitsCents, 10000);
  assert.strictEqual(
    computePeriodReconcile({ transactions: [{ id: 'a', amount: -250, direction: 'debit', cleared: true }] }).debitsCents, 25000);
});

test('explainOutOfBalance(): names the likely cause, and says nothing when balanced', async () => {
  const { explainOutOfBalance } = await import(reconcileUrl);
  assert.strictEqual(explainOutOfBalance(0, [], []).length, 0);
  const single = explainOutOfBalance(30000,
    [{ id: 'b', amount: 300, direction: 'debit', description: 'ANZ FEE', date: '2026-03-02' }], []);
  assert.strictEqual(single[0].kind, 'single-transaction');
  const missing = explainOutOfBalance(91865, [], [{ net: 918.65, platform: 'airbnb', payoutDate: '2026-03-30' }]);
  assert.ok(missing.some(h => h.kind === 'missing-deposit'));
  assert.strictEqual(explainOutOfBalance(777, [], [])[0].kind, 'generic');
});

// The real-world shape: early imports wrote debits only, so the account held
// months of expenses with no income against them. That is unreconcilable, and
// the generic "check for a missing transaction" hint sent the host looking for
// one row when ~100 deposits were absent.
test('explainOutOfBalance(): calls out a long stretch with money out but none in', async () => {
  const { explainOutOfBalance } = await import(reconcileUrl);
  const txns = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(2026, 0, 22) + i * 8 * 86400000).toISOString().slice(0, 10);
    txns.push({ id: 'd' + i, amount: 200, direction: 'debit', description: 'PAYMENT', date: d });
  }
  txns.push({ id: 'c1', amount: 5000, direction: 'credit', description: 'AIRBNB', date: '2026-05-11' });

  const gap = explainOutOfBalance(2940093, txns, []);
  assert.strictEqual(gap[0].kind, 'missing-deposits', 'leads with the gap — it is the whole answer');
  assert.match(gap[0].message, /2026-01-22 and 2026-05-11/);

  // No credits at all anywhere is the same fault, worded for that case.
  const none = explainOutOfBalance(2940093, txns.slice(0, 12), []);
  assert.strictEqual(none[0].kind, 'missing-deposits');
  assert.match(none[0].message, /No money in anywhere/);

  // A normal period that simply opens with an expense must NOT be flagged.
  const healthy = explainOutOfBalance(500, [
    { id: 'a', amount: 200, direction: 'debit', description: 'FEE', date: '2026-06-01' },
    { id: 'b', amount: 900, direction: 'credit', description: 'AIRBNB', date: '2026-06-09' },
  ], []);
  assert.ok(!healthy.some(h => h.kind === 'missing-deposits'));
});

test('payoutSettlementState(): three states, and bank evidence outranks attestation', async () => {
  const reconUrl = pathToFileURL(path.join(__dirname, '..', 'assets', 'js', 'reconciliation.js')).href;
  const { payoutSettlementState } = await import(reconUrl);
  assert.strictEqual(payoutSettlementState({ bank_transaction_id: 'x' }), 'settled');
  assert.strictEqual(payoutSettlementState({ bank_transaction_id: 'x', received_at: '2026-03-10' }), 'settled');
  assert.strictEqual(payoutSettlementState({ received_at: '2026-03-10' }), 'attested');
  assert.strictEqual(payoutSettlementState({}), 'outstanding');
  assert.strictEqual(payoutSettlementState(null), 'outstanding');
});

// planPayoutAutoMatch — the one-click "Match all". Matching was manual only, so
// 34 payouts against 29 deposits never got reconciled. Every case here is about
// REFUSING to guess: a wrong link hides a genuinely missing deposit behind a
// plausible one, which is the exact silent error this whole area exists to stop.
const payout = (id, date, net, extra = {}) =>
  ({ _cloudId: id, payoutDate: date, expectedArrivalDate: null, net, bankTransactionId: null, ...extra });
const credit = (id, date, amount, extra = {}) =>
  ({ id, date, amount, direction: 'credit', isPersonal: false, skipped: false, ...extra });

test('planPayoutAutoMatch(): links a clean one-to-one match', async () => {
  const { planPayoutAutoMatch } = await import(moneyInUrl);
  const plan = planPayoutAutoMatch({
    payouts: [payout('p1', '2026-07-20', 1489.18)],
    creditTxns: [credit('c1', '2026-07-24', 1489.18)],
  });
  assert.strictEqual(plan.links.length, 1);
  assert.strictEqual(plan.links[0].credit.id, 'c1');
  assert.strictEqual(plan.unmatched.length, 0);
});

test('planPayoutAutoMatch(): refuses when two payouts want the same deposit', async () => {
  const { planPayoutAutoMatch } = await import(moneyInUrl);
  const plan = planPayoutAutoMatch({
    payouts: [payout('p1', '2026-07-20', 500), payout('p2', '2026-07-21', 500)],
    creditTxns: [credit('c1', '2026-07-22', 500)],
  });
  assert.strictEqual(plan.links.length, 0, 'linking either one would be a coin toss');
  assert.strictEqual(plan.ambiguous.length, 2);
});

test('planPayoutAutoMatch(): refuses when one payout has two candidate deposits', async () => {
  const { planPayoutAutoMatch } = await import(moneyInUrl);
  const plan = planPayoutAutoMatch({
    payouts: [payout('p1', '2026-07-20', 500)],
    creditTxns: [credit('c1', '2026-07-21', 500), credit('c2', '2026-07-23', 500)],
  });
  assert.strictEqual(plan.links.length, 0);
  assert.strictEqual(plan.ambiguous[0].candidates.length, 2);
});

test('planPayoutAutoMatch(): a deposit already settling a payout is off the table', async () => {
  const { planPayoutAutoMatch } = await import(moneyInUrl);
  const plan = planPayoutAutoMatch({
    payouts: [payout('p1', '2026-07-20', 500, { bankTransactionId: 'c1' }), payout('p2', '2026-07-20', 500)],
    creditTxns: [credit('c1', '2026-07-22', 500)],
  });
  assert.strictEqual(plan.links.length, 0, 'c1 is taken; p2 must not steal it');
  assert.strictEqual(plan.unmatched.length, 1);
});

test('planPayoutAutoMatch(): honours the arrival window and skips personal rows', async () => {
  const { planPayoutAutoMatch } = await import(moneyInUrl);
  const tooLate = planPayoutAutoMatch({
    payouts: [payout('p1', '2026-07-01', 500)],
    creditTxns: [credit('c1', '2026-07-20', 500)],
  });
  assert.strictEqual(tooLate.links.length, 0, '19 days later is not this payout');

  const arrivesLater = planPayoutAutoMatch({
    payouts: [payout('p1', '2026-07-01', 500, { expectedArrivalDate: '2026-07-15' })],
    creditTxns: [credit('c1', '2026-07-18', 500)],
  });
  assert.strictEqual(arrivesLater.links.length, 1, 'window extends from expected arrival');

  const personal = planPayoutAutoMatch({
    payouts: [payout('p1', '2026-07-20', 500)],
    creditTxns: [credit('c1', '2026-07-22', 500, { isPersonal: true })],
  });
  assert.strictEqual(personal.links.length, 0);
});

test('planPayoutAutoMatch(): a cent of difference is not a match', async () => {
  const { planPayoutAutoMatch } = await import(moneyInUrl);
  const plan = planPayoutAutoMatch({
    payouts: [payout('p1', '2026-07-20', 1489.18)],
    creditTxns: [credit('c1', '2026-07-22', 1489.19)],
  });
  assert.strictEqual(plan.links.length, 0);
  assert.strictEqual(plan.unmatched.length, 1);
});
