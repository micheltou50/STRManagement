/**
 * StayOps — regression tests for the repeat-booking / alteration-split bug.
 *
 * Real incident (guest "Mohammad Abdulaziz", Sep 2026): a returning guest's
 * second reservation arrived with a SHORTENED guest name and a SYNTHETIC numeric
 * "confirmation code" (a URL/timestamp id, not the real HM… code). The old
 * name-only match tier + the lack of code validation let it either collapse onto
 * the prior booking or land as a broken $0 row that could never be billed.
 *
 * These tests lock in the fix (email-scan-shared.js):
 *   1. A repeat guest's genuinely-new reservation ALWAYS creates a new row and
 *      never touches the prior booking (Tier-4 name-only match removed).
 *   2. A payout-less insert is flagged enrichment_status='payout_pending'.
 *   3. sanitizeConfirmationCode() rejects synthetic long-numeric ids, keeps real
 *      Airbnb (HM…) and Booking.com (numeric) codes.
 *   4. A "modification" email whose real code differs from the matched row's real
 *      code must NOT re-date/re-price that row (it's a different reservation).
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

// Echo POST /bookings inserts back as the persisted row (with a db id); 204 for
// PATCH; empty array otherwise. Records every call so tests can inspect them.
function buildFetchMock() {
  const calls = [];
  let idCounter = 0;
  const fetchMock = async (url, init) => {
    const method = (init && init.method) || 'GET';
    calls.push({ url: String(url), method, body: init && init.body });
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

// The prior, real, already-finished August booking.
function augustRow() {
  return {
    id: 'db-aug-1', local_id: 'gmail-aug', property_id: 'prop-1',
    confirmation_code: 'HMPPKAEFNS',
    guest_name: 'Mohammad Abdulaziz M Alabdulkarim',
    checkin: '2026-08-26', checkout: '2026-08-28',
    host_payout: 1116.51, cleaning_fee: 250, status: 'confirmed',
    enrichment_status: 'enriched', source: 'gmail',
  };
}

const countInserts = (calls) => calls.filter(c => c.method === 'POST' && c.url.includes('/rest/v1/bookings')).length;
const patchedIds = (calls) => calls.filter(c => c.method === 'PATCH').map(c => c.url);

test.beforeEach(() => installModuleStubs());
test.afterEach(() => { resetAll(); restoreModuleStubs(); });

test('repeat guest, genuinely-new reservation: inserts a SECOND row, never touches the prior booking', async () => {
  const { fetchMock, calls } = buildFetchMock();
  installFetchMock(fetchMock);
  const { processEmailResult } = loadShared();
  const ctx = makeCtx([augustRow()]);

  // New September reservation — shortened name, a DIFFERENT real code, new dates.
  await processEmailResult({
    emailType: 'new_booking',
    guestName: 'Mohammad Abdulaziz M',
    checkin: '2026-09-02', checkout: '2026-09-04', guests: 4,
    hostPayout: 900, cleaningFee: 250, platform: 'airbnb',
    confirmationCode: 'HMSEPT999', status: 'confirmed',
  }, 'msg-sep', 'gmail', ctx);

  assert.equal(ctx.results.imported, 1, 'the new reservation is imported as its own booking');
  assert.equal(countInserts(calls), 1, 'exactly one new insert');
  assert.equal(ctx.existingBookings.length, 2, 'now two rows — prior + new, not merged');
  assert.equal(patchedIds(calls).length, 0, 'the prior August booking is never PATCHed');
  // Prior row untouched in memory.
  const aug = ctx.existingBookings.find(b => b.id === 'db-aug-1');
  assert.equal(aug.checkin, '2026-08-26', 'August dates unchanged');
  assert.equal(aug.confirmation_code, 'HMPPKAEFNS', 'August code unchanged');
});

test('payout-less insert is flagged payout_pending (not a silent $0 booking)', async () => {
  const { fetchMock, calls } = buildFetchMock();
  installFetchMock(fetchMock);
  const { processEmailResult } = loadShared();
  const ctx = makeCtx([augustRow()]);

  await processEmailResult({
    emailType: 'new_booking',
    guestName: 'Mohammad Abdulaziz M',
    checkin: '2026-09-02', checkout: '2026-09-04',
    hostPayout: 0, cleaningFee: 0, platform: 'airbnb',
    confirmationCode: '', status: 'confirmed',
  }, 'msg-sep0', 'gmail', ctx);

  assert.equal(countInserts(calls), 1, 'a separate row is still inserted, not merged');
  const inserted = ctx.existingBookings.find(b => b.id !== 'db-aug-1');
  assert.ok(inserted, 'the new row exists');
  assert.equal(inserted.enrichment_status, 'payout_pending', '$0 insert is flagged payout_pending');
});

test('a booking WITH a payout is not flagged pending', async () => {
  const { fetchMock, calls } = buildFetchMock();
  installFetchMock(fetchMock);
  const { processEmailResult } = loadShared();
  const ctx = makeCtx();

  await processEmailResult({
    emailType: 'new_booking', guestName: 'Jane Doe',
    checkin: '2026-10-01', checkout: '2026-10-03',
    hostPayout: 500, cleaningFee: 100, platform: 'airbnb',
    confirmationCode: 'HMJANE123', status: 'confirmed',
  }, 'msg-jane', 'gmail', ctx);

  assert.equal(countInserts(calls), 1);
  assert.equal(ctx.existingBookings[0].enrichment_status, null, 'a real (paid) booking is not payout_pending');
});

test('sanitizeConfirmationCode: rejects synthetic ids, keeps real Airbnb/Booking.com codes', () => {
  const { sanitizeConfirmationCode } = loadShared();
  // Synthetic long numeric (the exact incident value) → dropped.
  assert.equal(sanitizeConfirmationCode('1755486896329011039'), '');
  assert.equal(sanitizeConfirmationCode('1758618813373455241'), '');
  // Real Airbnb alphanumeric → kept (upper-cased).
  assert.equal(sanitizeConfirmationCode('HMPPKAEFNS'), 'HMPPKAEFNS');
  assert.equal(sanitizeConfirmationCode('hmppkaefns'), 'HMPPKAEFNS');
  // Real Booking.com numeric (~10 digits) → kept.
  assert.equal(sanitizeConfirmationCode('4567890123'), '4567890123');
  // Junk / empty → dropped.
  assert.equal(sanitizeConfirmationCode(''), '');
  assert.equal(sanitizeConfirmationCode(null), '');
  assert.equal(sanitizeConfirmationCode('   '), '');
});

test('synthetic confirmation code is never persisted on insert', async () => {
  const { fetchMock, calls } = buildFetchMock();
  installFetchMock(fetchMock);
  const { processEmailResult } = loadShared();
  const ctx = makeCtx();

  await processEmailResult({
    emailType: 'new_booking', guestName: 'Mohammad Abdulaziz M',
    checkin: '2026-09-02', checkout: '2026-09-04',
    hostPayout: 900, cleaningFee: 250, platform: 'airbnb',
    confirmationCode: '1755486896329011039', status: 'confirmed',
  }, 'msg-syn', 'gmail', ctx);

  assert.equal(countInserts(calls), 1);
  const body = JSON.parse(calls.find(c => c.method === 'POST').body);
  assert.equal(body.confirmation_code, '', 'the synthetic numeric id is stored as empty, never persisted');
});

test('modification must NOT re-date/re-price a row whose real code differs (different reservation)', async () => {
  const { fetchMock, calls } = buildFetchMock();
  installFetchMock(fetchMock);
  const { processEmailResult } = loadShared();
  const ctx = makeCtx([augustRow()]);

  // A "modification" email that matches August by name+checkin (Tier 3) but
  // carries a DIFFERENT real code — i.e. a different reservation. It must not
  // touch August; it falls through to an insert.
  await processEmailResult({
    emailType: 'modification',
    guestName: 'Mohammad Abdulaziz M Alabdulkarim',
    checkin: '2026-08-26', checkout: '2026-08-30', // same arrival, but different code
    hostPayout: 2000, cleaningFee: 250, platform: 'airbnb',
    confirmationCode: 'HMDIFFER99', status: 'confirmed',
  }, 'msg-mod', 'gmail', ctx);

  const augPatches = patchedIds(calls).filter(u => u.includes('id=eq.db-aug-1'));
  assert.equal(augPatches.length, 0, 'the August row (different code) is never PATCHed by this modification');
  const aug = ctx.existingBookings.find(b => b.id === 'db-aug-1');
  assert.equal(aug.checkin, '2026-08-26', 'August checkin unchanged');
  assert.equal(aug.checkout, '2026-08-28', 'August checkout unchanged');
  assert.equal(aug.host_payout, 1116.51, 'August payout unchanged');
});
