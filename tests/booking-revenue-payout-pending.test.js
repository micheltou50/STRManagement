'use strict';
// isPayoutPending() — flags a booking whose host payout hasn't been captured yet
// (the "$0 September row" case), so the UI shows "payout pending" and the report
// refuses to bill it, rather than treating the $0 as final.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modUrl = pathToFileURL(path.join(__dirname, '..', 'assets', 'js', 'booking-revenue.js')).href;
const load = () => import(modUrl);

test('confirmed booking with $0 payout is pending', async () => {
  const { isPayoutPending } = await load();
  assert.equal(isPayoutPending({ status: 'confirmed', hostPayout: 0 }), true);
  assert.equal(isPayoutPending({ status: 'confirmed', hostPayout: -5 }), true);
});

test('confirmed booking with a real payout is NOT pending', async () => {
  const { isPayoutPending } = await load();
  assert.equal(isPayoutPending({ status: 'confirmed', hostPayout: 500 }), false);
});

test('explicit payout_pending sentinel is always pending', async () => {
  const { isPayoutPending } = await load();
  assert.equal(isPayoutPending({ status: 'confirmed', enrichment_status: 'payout_pending', hostPayout: 0 }), true);
});

test('cancelled bookings are not payout_pending (handled by isBillableButMissingPayout)', async () => {
  const { isPayoutPending } = await load();
  assert.equal(isPayoutPending({ status: 'cancelled', hostPayout: 0 }), false);
});

test('null / missing booking is not pending', async () => {
  const { isPayoutPending } = await load();
  assert.equal(isPayoutPending(null), false);
  assert.equal(isPayoutPending(undefined), false);
});
