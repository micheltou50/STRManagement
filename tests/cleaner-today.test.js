'use strict';
// Cleaner PWA "Today" view — the pure turnover annotation the view sorts and
// labels by (assets/js/utils.js annotateCleanerCleans). Frontend modules are
// ESM, so we dynamic-import from this CJS test (same pattern as frontend-pure).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const utilsUrl = pathToFileURL(path.join(__dirname, '..', 'assets', 'js', 'utils.js')).href;
const importUtils = () => import(utilsUrl);

test('annotateCleanerCleans: same-day turnovers sort first, by arrival time; no-arrival sinks last', async () => {
  const { annotateCleanerCleans } = await importUtils();
  const P1 = 'p1', P2 = 'p2', P3 = 'p3';
  const bookings = [
    // P1: guest out 12th (default 10:00), next guest in the 12th at 16:00
    { id: 'b1', local_id: '101', property_id: P1, checkin: '2026-10-08', checkout: '2026-10-12', status: 'confirmed' },
    { id: 'b2', local_id: '102', property_id: P1, checkin: '2026-10-12', checkout: '2026-10-15', checkin_time: '16:00:00', status: 'confirmed' },
    // P2: late checkout 11:00, next guest same day at the default 15:00
    { id: 'b3', local_id: '103', property_id: P2, checkin: '2026-10-09', checkout: '2026-10-12', checkout_time: '11:00:00', status: 'confirmed' },
    { id: 'b4', local_id: '104', property_id: P2, checkin: '2026-10-12', checkout: '2026-10-14', status: 'confirmed' },
    // P3: next real arrival is the 15th; a cancelled same-day arrival must be ignored
    { id: 'b5', local_id: '105', property_id: P3, checkin: '2026-10-10', checkout: '2026-10-12', status: 'confirmed' },
    { id: 'b6', local_id: '106', property_id: P3, checkin: '2026-10-15', checkout: '2026-10-18', status: 'confirmed' },
    { id: 'b7', local_id: '107', property_id: P3, checkin: '2026-10-12', checkout: '2026-10-13', status: 'cancelled' },
  ];
  const cleans = [
    { id: 'c1', property_id: P1, booking_id: '101', clean_date: '2026-10-12' },
    { id: 'c2', property_id: P2, booking_id: '103', clean_date: '2026-10-12' },
    { id: 'c3', property_id: P3, booking_id: '105', clean_date: '2026-10-12' },
    { id: 'c4', property_id: 'p4', booking_id: '999', clean_date: '2026-10-12' }, // RPC knows nothing about it
  ];
  annotateCleanerCleans(cleans, bookings);
  const by = Object.fromEntries(cleans.map(c => [c.id, c]));

  assert.strictEqual(by.c1._sameDayTurnover, true);
  assert.strictEqual(by.c1._checkoutTime, '10:00');
  assert.strictEqual(by.c1._nextCheckinTime, '16:00');
  assert.strictEqual(by.c1._nextCheckinDate, '2026-10-12');

  assert.strictEqual(by.c2._sameDayTurnover, true);
  assert.strictEqual(by.c2._checkoutTime, '11:00');
  assert.strictEqual(by.c2._nextCheckinTime, '15:00');

  assert.strictEqual(by.c3._sameDayTurnover, false);
  assert.strictEqual(by.c3._nextCheckinDate, '2026-10-15');
  assert.strictEqual(by.c3._nextCheckinTime, '15:00');

  assert.strictEqual(by.c4._booking, null);
  assert.strictEqual(by.c4._bookingCancelled, false);
  assert.strictEqual(by.c4._checkoutTime, '10:00');
  assert.strictEqual(by.c4._nextCheckinDate, '');
  assert.strictEqual(by.c4._sameDayTurnover, false);

  const order = cleans.slice().sort((a, b) => a._deadlineMinutes - b._deadlineMinutes).map(c => c.id);
  assert.deepStrictEqual(order, ['c2', 'c1', 'c3', 'c4']);
});

test('annotateCleanerCleans: flags a cancelled own booking and matches legacy uuid booking_ids', async () => {
  const { annotateCleanerCleans } = await importUtils();
  const bookings = [
    { id: '7d3e1b2a-0000-4000-8000-000000000001', local_id: '55', property_id: 'p1', checkin: '2026-10-01', checkout: '2026-10-03', status: 'cancelled' },
    { id: '7d3e1b2a-0000-4000-8000-000000000002', local_id: '56', property_id: 'p1', checkin: '2026-10-03', checkout: '2026-10-05', status: 'confirmed' },
  ];
  const cleans = [
    { id: 'legacy', property_id: 'p1', booking_id: '7d3e1b2a-0000-4000-8000-000000000001', clean_date: '2026-10-03' },
    { id: 'canon',  property_id: 'p1', booking_id: '56', clean_date: '2026-10-05' },
    { id: 'orphan', property_id: 'p1', booking_id: '',   clean_date: '2026-10-05' },
  ];
  annotateCleanerCleans(cleans, bookings);
  const by = Object.fromEntries(cleans.map(c => [c.id, c]));
  assert.strictEqual(by.legacy._bookingCancelled, true, 'uuid-keyed clean resolves its booking');
  assert.strictEqual(by.legacy._booking.local_id, '55');
  // the cancelled booking is this clean's OWN booking, so the next arrival is b56 the same day
  assert.strictEqual(by.legacy._sameDayTurnover, true);
  assert.strictEqual(by.canon._bookingCancelled, false);
  assert.strictEqual(by.canon._nextCheckinDate, '');
  assert.strictEqual(by.orphan._booking, null);
  // an orphan clean still gets a deadline from the property's bookings (none after the 5th here)
  assert.strictEqual(by.orphan._nextCheckinDate, '');
});
