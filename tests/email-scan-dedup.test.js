/**
 * StayOps — regression test for processEmailResult duplicate-registration.
 *
 * Scenario (the bug this guards against):
 *   Two separate emails about the SAME reservation arrive in the SAME scan
 *   batch (e.g. Airbnb sends a "reservation confirmed" and a follow-up
 *   "your guest is arriving"). The first email inserts a new booking. The
 *   second email must MATCH that just-inserted booking and be treated as a
 *   duplicate — it must NOT insert a second row.
 *
 * The fix lives in email-scan-shared.js: insertNewBooking() returns the
 * persisted row (with its real DB id), and processEmailResult() pushes that
 * row into the in-memory `existingBookings` list. Without it, the second
 * email's findExistingBooking() finds nothing and inserts a duplicate.
 *
 * Covered:
 *   - second email with the SAME confirmation_code → matched (Tier 1), skipped
 *   - second email with NO confirmation_code, same property_id+checkin →
 *     matched (Tier 2), skipped
 *   - the just-inserted row is synced into existingBookings (the actual fix)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { installFetchMock, resetAll } = require('./_mocks.js');

const SHARED = path.join(__dirname, '..', 'Netlify', 'functions', 'utils', 'email-scan-shared.js');

// The dependency tree (push-helper → web-push, sentry → @sentry/node) pulls in
// two third-party packages. They aren't installed in CI-light environments and
// aren't exercised by processEmailResult (supabaseAdmin is null here), so stub
// them at require() time. Neither is invoked at module-load, so empty-ish
// shims are enough.
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

function restoreModuleStubs() {
  Module._load = _origLoad;
}

function loadShared() {
  delete require.cache[require.resolve(SHARED)];
  return require(SHARED);
}

// Fetch mock: echo POST /bookings inserts back as the "persisted" representation
// (with a real db id), 204 for PATCH, empty array for everything else. Records
// every call so tests can count inserts.
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

function makeCtx() {
  const defaultProp = { id: 'prop-1', name: 'Beach House', mgmtFeeRate: 15 };
  return {
    supabaseUrl: 'https://example.supabase.co',
    sbHeaders: { apikey: 'k', Authorization: 'Bearer k', 'Content-Type': 'application/json' },
    uid: 'user-1',
    existingBookings: [],
    propMap: [defaultProp],
    defaultProp,
    isSingleProperty: true,
    results: { imported: 0, updated: 0, cancelled: 0, skipped: 0, errors: 0, details: [] },
    needsReview: [],
    newlySkipped: [],
    emailFrom: 'noreply@airbnb.com',
    supabaseAdmin: null, // skip the push-notification path; not under test here
  };
}

// The real Viola reservation: a first-name-only email followed by the
// full-name email, same reservation, same scan batch.
function violaEmail(overrides = {}) {
  return {
    emailType: 'new_booking',
    guestName: 'Viola Douaihy',
    checkin: '2026-07-02',
    checkout: '2026-07-04',
    guests: 7,
    hostPayout: 1305.45,
    cleaningFee: 0,
    platform: 'airbnb',
    confirmationCode: 'HMAVIOLA1',
    status: 'confirmed',
    ...overrides,
  };
}

function countBookingInserts(calls) {
  return calls.filter(c => c.method === 'POST' && c.url.includes('/rest/v1/bookings')).length;
}

test.beforeEach(() => installModuleStubs());
test.afterEach(() => { resetAll(); restoreModuleStubs(); });

test('two emails, one reservation (same confirmation_code): second is deduped, not re-inserted', async () => {
  const { fetchMock, calls } = buildFetchMock();
  installFetchMock(fetchMock);
  const { processEmailResult } = loadShared();

  const ctx = makeCtx();

  // First email — a fresh booking is inserted.
  await processEmailResult(violaEmail({ guestName: 'Viola' }), 'msg-1', 'gmail', ctx);

  assert.equal(ctx.results.imported, 1, 'first email should import one booking');
  assert.equal(countBookingInserts(calls), 1, 'exactly one insert after first email');
  // The fix: the persisted row (with its real db id) is now in the in-memory list.
  assert.equal(ctx.existingBookings.length, 1, 'inserted booking must be synced into existingBookings');
  assert.equal(ctx.existingBookings[0].id, 'db-id-1', 'synced row carries the real DB id');
  assert.equal(ctx.existingBookings[0].confirmation_code, 'HMAVIOLA1');

  // Second email about the SAME reservation, same batch — fuller guest name.
  await processEmailResult(violaEmail({ guestName: 'Viola Douaihy' }), 'msg-2', 'gmail', ctx);

  assert.equal(ctx.results.imported, 1, 'second email must NOT import another booking');
  assert.equal(ctx.results.skipped, 1, 'second email is skipped as a duplicate');
  assert.equal(countBookingInserts(calls), 1, 'still exactly one insert — no duplicate POST');
  assert.equal(ctx.existingBookings.length, 1, 'no duplicate added to the in-memory list');

  const lastDetail = ctx.results.details[ctx.results.details.length - 1];
  assert.equal(lastDetail.status, 'skipped');
  assert.match(lastDetail.reason, /already enriched/i);
});

test('two emails, one reservation (no confirmation_code): matched by property_id + checkin', async () => {
  const { fetchMock, calls } = buildFetchMock();
  installFetchMock(fetchMock);
  const { processEmailResult } = loadShared();

  const ctx = makeCtx();

  // Direct/iCal-style email with no platform confirmation code.
  await processEmailResult(violaEmail({ confirmationCode: '' }), 'msg-1', 'gmail', ctx);

  assert.equal(ctx.results.imported, 1);
  assert.equal(countBookingInserts(calls), 1);
  assert.equal(ctx.existingBookings.length, 1);
  assert.equal(ctx.existingBookings[0].property_id, 'prop-1');
  assert.equal(ctx.existingBookings[0].checkin, '2026-07-02');

  // Second email, same reservation, still no code — must match on property+date.
  await processEmailResult(violaEmail({ confirmationCode: '' }), 'msg-2', 'gmail', ctx);

  assert.equal(ctx.results.imported, 1, 'no duplicate import');
  assert.equal(ctx.results.skipped, 1, 'second deduped');
  assert.equal(countBookingInserts(calls), 1, 'still only one insert');
  assert.equal(ctx.existingBookings.length, 1);
});
