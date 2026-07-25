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
