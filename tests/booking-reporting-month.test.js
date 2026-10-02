'use strict';
// bookingReportingDate() / isBookingInMonth() — which month a stay belongs to
// in Finance. Attribution is by CHECK-OUT so a 30 Sep → 1 Oct stay lands in
// October (its clean and owner settlement happen then), not September. Every
// monthly view, payout list, FY report, statement, export and dashboard uses
// this one rule so they never disagree.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modUrl = pathToFileURL(path.join(__dirname, '..', 'assets', 'js', 'booking-revenue.js')).href;
const load = () => import(modUrl);

test('stay that crosses a month end belongs to the check-out month', async () => {
  const { isBookingInMonth } = await load();
  const yasmin = { checkin: '2026-09-30', checkout: '2026-10-01', nights: 1 };
  assert.equal(isBookingInMonth(yasmin, 2026, 9), true);   // October (0-based)
  assert.equal(isBookingInMonth(yasmin, 2026, 8), false);  // not September
});

test('stay fully inside a month stays in that month', async () => {
  const { isBookingInMonth } = await load();
  const b = { checkin: '2026-09-02', checkout: '2026-09-04' };
  assert.equal(isBookingInMonth(b, 2026, 8), true);
  assert.equal(isBookingInMonth(b, 2026, 9), false);
});

test('year boundary: 30 Dec → 2 Jan is January of the next year', async () => {
  const { isBookingInMonth, bookingReportingDate } = await load();
  const b = { checkin: '2026-12-30', checkout: '2027-01-02' };
  assert.equal(isBookingInMonth(b, 2027, 0), true);
  assert.equal(isBookingInMonth(b, 2026, 11), false);
  const d = bookingReportingDate(b);
  assert.equal(d.getFullYear(), 2027);
  assert.equal(d.getMonth(), 0);
  assert.equal(d.getDate(), 2);
});

test('financial year boundary: 29 Jun → 2 Jul moves to the new FY', async () => {
  const { isBookingInMonth } = await load();
  const b = { checkin: '2026-06-29', checkout: '2026-07-02' };
  assert.equal(isBookingInMonth(b, 2026, 5), false); // June
  assert.equal(isBookingInMonth(b, 2026, 6), true);  // July
});

test('falls back to check-in only when check-out is missing', async () => {
  const { isBookingInMonth, bookingReportingDate } = await load();
  const b = { checkin: '2026-09-30' };
  assert.equal(bookingReportingDate(b).getDate(), 30);
  assert.equal(isBookingInMonth(b, 2026, 8), true);
  assert.equal(isBookingInMonth({ checkin: '2026-09-30', checkout: '' }, 2026, 8), true);
});

test('timestamps and Date objects are read as local calendar days', async () => {
  const { isBookingInMonth } = await load();
  assert.equal(isBookingInMonth({ checkout: '2026-10-01T00:00:00' }, 2026, 9), true);
  assert.equal(isBookingInMonth({ checkout: new Date(2026, 9, 1) }, 2026, 9), true);
});

test('year/month given as strings still match', async () => {
  const { isBookingInMonth } = await load();
  assert.equal(isBookingInMonth({ checkout: '2026-10-01' }, '2026', '9'), true);
});

test('no dates, null or garbage never match a month', async () => {
  const { isBookingInMonth, bookingReportingDate } = await load();
  assert.equal(bookingReportingDate(null), null);
  assert.equal(bookingReportingDate({}), null);
  assert.equal(isBookingInMonth(null, 2026, 9), false);
  assert.equal(isBookingInMonth({}, 2026, 9), false);
  assert.equal(isBookingInMonth({ checkout: 'not a date' }, 2026, 9), false);
});
