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
