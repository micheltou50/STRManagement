'use strict';
/**
 * StayOps — regression tests for first-name modification emails.
 *
 * Real incident (guest "Marije Holtland", Dec 2026): Airbnb's "reservation
 * changed" email came through with only the first name ("Marije"), the NEW
 * dates (24–26 Dec vs the stored 23–24 Dec), 1 guest (the parser default), no
 * payout and a synthetic numeric id as the "confirmation code". None of the
 * match tiers could find the booking, so it was inserted as a brand-new $0
 * phantom beside the real one.
 *
 * These lock in the fix (email-scan-shared.js):
 *   1. A modification email is attached to the booking with the same FIRST
 *      name and overlapping/adjacent dates: the real row is re-dated and
 *      flagged "modified", no insert, and the parser's guest count is NOT
 *      written over the real one.
 *   2. An unmatched modification with NO real code is flagged for review, not
 *      inserted (no more phantoms).
 *   3. An unmatched modification WITH a real code still inserts (a reservation
 *      we genuinely never saw must not be lost).
 *   4. A different real code, or dates far apart, is never a candidate.
 *   5. modification_notice emails get the same first-name tier.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { installFetchMock, resetAll } = require('./_mocks.js');

const SHARED = path.join(__dirname, '..', 'Netlify', 'functions', 'utils', 'email-scan-shared.js');

const _origLoad = Module._load;
const STUBS = {
  'web-push': { setVapidDetails() {}, async sendNotification() { return { statusCode: 201 }; } },
  '@sentry/node': new Proxy({}, { get: () => () => {} }),
};
function installModuleStubs() {
  Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
    return _origLoad.call(this, request, parent, isMain);
  };
}
function restoreModuleStubs() { Module._load = _origLoad; }

function loadShared() {
  delete require.cache[require.resolve(SHARED)];
  return require(SHARED);
}

function buildFetchMock() {
  const calls = [];
  let idCounter = 0;
  const fetchMock = async (url, init) => {
    const method = (init && init.method) || 'GET';
    calls.push({ url: String(url), method, body: init && init.body ? JSON.parse(init.body) : null });
    if (String(url).includes('/rest/v1/bookings') && method === 'POST') {
      idCounter += 1;
      const row = JSON.parse(init.body);
      return { status: 201, body: [{ ...row, id: 'db-id-' + idCounter }] };
    }
    if (method === 'PATCH') return { status: 204, body: '' };
    return { status: 200, body: [] };
  };
  return { fetchMock, calls };
}

function makeCtx(existing = []) {
  const defaultProp = { id: 'prop-1', name: 'Glenhaven', mgmtFeeRate: 10 };
  return {
    supabaseUrl: 'https://example.supabase.co',
    sbHeaders: { apikey: 'k', Authorization: 'Bearer k', 'Content-Type': 'application/json' },
    uid: 'user-1',
    existingBookings: existing,
    propMap: [defaultProp],
    defaultProp,
    isSingleProperty: true,
    results: { imported: 0, updated: 0, cancelled: 0, skipped: 0, errors: 0, details: [] },
    needsReview: [],
    newlySkipped: [],
    emailFrom: 'noreply@airbnb.com',
    supabaseAdmin: null,
  };
}

// The real booking as it stood before the change email arrived.
function marijeRow() {
  return {
    id: 'db-marije', local_id: 'gmail-marije', property_id: 'prop-1',
    confirmation_code: 'HM3PDX8JJE', guest_name: 'Marije Holtland',
    checkin: '2026-12-23', checkout: '2026-12-24', guests: 7,
    host_payout: 739.08, cleaning_fee: 250, status: 'confirmed',
    enrichment_status: null, source: 'gmail',
  };
}

// The change email exactly as the parser returned it in the incident.
function marijeChangeEmail(overrides = {}) {
  return {
    emailType: 'modification', guestName: 'Marije',
    checkin: '2026-12-24', checkout: '2026-12-26', guests: 1,
    hostPayout: 0, cleaningFee: 0, platform: 'airbnb',
    confirmationCode: '1758618813373455241', status: 'confirmed',
    ...overrides,
  };
}

const inserts = calls => calls.filter(c => c.method === 'POST' && c.url.includes('/rest/v1/bookings'));
const patches = calls => calls.filter(c => c.method === 'PATCH');

test.beforeEach(() => installModuleStubs());
test.afterEach(() => { resetAll(); restoreModuleStubs(); });

test('the Marije case: first-name change email re-dates the real booking, no phantom', async () => {
  const { fetchMock, calls } = buildFetchMock();
  installFetchMock(fetchMock);
  const { processEmailResult } = loadShared();
  const ctx = makeCtx([marijeRow()]);

  await processEmailResult(marijeChangeEmail(), 'msg-change', 'gmail', ctx);

  assert.equal(inserts(calls).length, 0, 'no new booking is inserted');
  assert.equal(ctx.existingBookings.length, 1, 'still one booking');
  assert.equal(ctx.results.updated, 1);
  const p = patches(calls).find(c => c.url.includes('id=eq.db-marije'));
  assert.ok(p, 'the real booking is PATCHed');
  assert.equal(p.body.checkin, '2026-12-24');
  assert.equal(p.body.checkout, '2026-12-26');
  assert.equal(p.body.nights, 2);
  assert.ok(p.body.modification_pending_at, 'flagged for the host to verify');
  assert.equal('guests' in p.body, false, 'the parser default of 1 guest is NOT written over the real 7');
  assert.equal('host_payout' in p.body, false, 'a payout-less email never zeroes the payout');
  assert.ok(ctx.newlySkipped.includes('msg-change'), 'message marked processed');
});

test('unmatched modification with NO real code is flagged for review, not inserted', async () => {
  const { fetchMock, calls } = buildFetchMock();
  installFetchMock(fetchMock);
  const { processEmailResult } = loadShared();
  const ctx = makeCtx([marijeRow()]);

  // Different first name, so nothing to attach to; synthetic code only.
  await processEmailResult(marijeChangeEmail({ guestName: 'Sofia' }), 'msg-nomatch', 'gmail', ctx);

  assert.equal(inserts(calls).length, 0, 'no $0 phantom');
  assert.equal(patches(calls).length, 0, 'the real booking is untouched');
  assert.equal(ctx.results.skipped, 1);
  assert.equal(ctx.needsReview.length, 1);
  assert.match(ctx.needsReview[0].reason, /could not be matched/i);
  assert.equal(ctx.results.details[0].status, 'modification_unmatched');
  assert.ok(ctx.newlySkipped.includes('msg-nomatch'), 'not re-scanned forever');
});

test('unmatched modification WITH a real code still inserts (never lose a real reservation)', async () => {
  const { fetchMock, calls } = buildFetchMock();
  installFetchMock(fetchMock);
  const { processEmailResult } = loadShared();
  const ctx = makeCtx([marijeRow()]);

  await processEmailResult(marijeChangeEmail({ guestName: 'Sofia', confirmationCode: 'HMSOFIA123', hostPayout: 500 }), 'msg-real', 'gmail', ctx);

  assert.equal(inserts(calls).length, 1);
  assert.equal(ctx.results.imported, 1);
  assert.equal(ctx.existingBookings.length, 2);
  assert.equal(inserts(calls)[0].body.confirmation_code, 'HMSOFIA123');
});

test('same first name but a DIFFERENT real code is never attached', async () => {
  const { fetchMock, calls } = buildFetchMock();
  installFetchMock(fetchMock);
  const { processEmailResult } = loadShared();
  const ctx = makeCtx([marijeRow()]);

  await processEmailResult(marijeChangeEmail({ confirmationCode: 'HMOTHER999', hostPayout: 400 }), 'msg-other', 'gmail', ctx);

  assert.equal(patches(calls).length, 0, 'Marije Holtland untouched');
  assert.equal(inserts(calls).length, 1, 'treated as its own reservation');
});

test('same first name but dates months apart is never attached', async () => {
  const { fetchMock, calls } = buildFetchMock();
  installFetchMock(fetchMock);
  const { processEmailResult } = loadShared();
  const ctx = makeCtx([marijeRow()]);

  await processEmailResult(marijeChangeEmail({ checkin: '2027-03-10', checkout: '2027-03-12' }), 'msg-far', 'gmail', ctx);

  assert.equal(patches(calls).length, 0);
  assert.equal(inserts(calls).length, 0, 'no code → flagged, not inserted');
  assert.equal(ctx.results.details[0].status, 'modification_unmatched');
});

test('candidate is scoped to the property and to confirmed bookings', async () => {
  const { fetchMock, calls } = buildFetchMock();
  installFetchMock(fetchMock);
  const { processEmailResult } = loadShared();
  const otherProp = { ...marijeRow(), id: 'db-other', property_id: 'prop-2' };
  const cancelled = { ...marijeRow(), id: 'db-cxl', status: 'cancelled' };
  const ctx = makeCtx([otherProp, cancelled]);

  await processEmailResult(marijeChangeEmail(), 'msg-scope', 'gmail', ctx);

  assert.equal(patches(calls).length, 0, 'neither the other property nor the cancelled row is touched');
  assert.equal(inserts(calls).length, 0);
});

test('with two first-name candidates the closest check-in wins', async () => {
  const { findModificationCandidate } = loadShared();
  const a = { ...marijeRow(), id: 'a', checkin: '2026-12-20', checkout: '2026-12-22' };
  const b = { ...marijeRow(), id: 'b', checkin: '2026-12-23', checkout: '2026-12-24' };
  const hit = findModificationCandidate([a, b], '', 'Marije', '2026-12-24', '2026-12-26', 'prop-1');
  assert.equal(hit.id, 'b');
});

test('modification_notice: first-name tier attaches and flags the real booking', async () => {
  const { fetchMock, calls } = buildFetchMock();
  installFetchMock(fetchMock);
  const { processEmailResult } = loadShared();
  const ctx = makeCtx([marijeRow()]);

  await processEmailResult(marijeChangeEmail({ emailType: 'modification_notice' }), 'msg-notice', 'gmail', ctx);

  assert.equal(inserts(calls).length, 0);
  const p = patches(calls).find(c => c.url.includes('id=eq.db-marije'));
  assert.ok(p, 'flagged on the real booking');
  assert.ok(p.body.modification_pending_at);
  assert.equal(p.body.checkout, '2026-12-26', 'dates applied from the notice');
  assert.equal('guests' in p.body, false, 'guest count left alone for a first-name match');
});
