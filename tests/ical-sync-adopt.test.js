'use strict';
/**
 * StayOps — ical-sync adoption / safety regression tests.
 *
 * Background: this account's bookings all came in by email before any iCal
 * feed existed. Adding a feed used to mean a duplicate "Reserved — awaiting
 * details" stub next to every existing future booking, because the sync only
 * ever matched events by ical_uid. These tests lock in:
 *   1. A live event ADOPTS an existing un-linked booking with the same dates
 *      (PATCH ical_uid/ical_feed_id) — no stub is inserted.
 *   2. Same check-in but a different check-out (changed on the platform) is
 *      adopted too, and re-dated to the feed.
 *   3. An event with nothing to adopt still inserts a stub (unchanged).
 *   4. A past event never inserts a stub (no backfilling history).
 *   5. Host blocks ("Airbnb (Not available)") are never bookings.
 *   6. The disappearance sweep only cancels stays that haven't started; a
 *      finished stay dropping off the feed keeps its revenue.
 *   7. If the adoption PATCH fails, no stub is inserted (retry next sync).
 *   8. Both dates moved on the platform: paired by proximity (≤3 days each
 *      end, closest pair first), re-dated, never duplicated; far shifts are
 *      not guessed at.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { installFetchMock, resetAll } = require('./_mocks.js');

const SYNC = path.join(__dirname, '..', 'Netlify', 'functions', 'ical-sync.js');

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

function loadSync() {
  delete require.cache[require.resolve(SYNC)];
  return require(SYNC);
}

const FEED = { id: 'feed-1', user_id: 'user-1', property_id: 'prop-1', platform: 'airbnb', ical_url: 'https://feeds.example/airbnb.ics' };
const SB = 'https://example.supabase.co';
const HEADERS = { apikey: 'k', Authorization: 'Bearer k', 'Content-Type': 'application/json' };

function ics(events) {
  const body = events.map(e =>
    'BEGIN:VEVENT\nUID:' + e.uid + '\nDTSTART;VALUE=DATE:' + e.start.replace(/-/g, '') +
    '\nDTEND;VALUE=DATE:' + e.end.replace(/-/g, '') + '\nSUMMARY:' + (e.summary || 'Reserved') + '\nEND:VEVENT'
  ).join('\n');
  return 'BEGIN:VCALENDAR\nVERSION:2.0\n' + body + '\nEND:VCALENDAR\n';
}

/**
 * Fetch router. `icalRows` = bookings already linked to this feed,
 * `pool` = un-linked confirmed bookings at the property (adoption candidates).
 */
function buildFetchMock({ icsText, icalRows = [], pool = [], failAdoptPatch = false }) {
  const calls = [];
  const fetchMock = async (url, init) => {
    const method = (init && init.method) || 'GET';
    calls.push({ url: String(url), method, body: init && init.body ? JSON.parse(init.body) : null });
    const u = String(url);
    if (u === FEED.ical_url) return { status: 200, body: icsText };
    if (u.includes('/rest/v1/bookings') && method === 'GET') {
      if (u.includes('ical_feed_id=eq.')) return { status: 200, body: icalRows };
      if (u.includes('ical_uid=is.null')) return { status: 200, body: pool };
      return { status: 200, body: [] };
    }
    if (u.includes('/rest/v1/bookings') && method === 'PATCH') {
      if (failAdoptPatch && init.body && init.body.includes('"ical_uid"')) return { status: 500, body: '' };
      return { status: 204, body: '' };
    }
    if (u.includes('/rest/v1/bookings') && method === 'POST') return { status: 201, body: '' };
    return { status: 200, body: [] };
  };
  return { fetchMock, calls };
}

const stubInserts = calls => calls.filter(c => c.method === 'POST' && c.url.includes('/rest/v1/bookings'));
const bookingPatches = calls => calls.filter(c => c.method === 'PATCH' && c.url.includes('/rest/v1/bookings'));

// Far-future / far-past dates so the tests don't depend on the real clock.
const FUT = { in: '2099-12-24', out: '2099-12-26', in2: '2099-12-23', out2: '2099-12-24' };
const PAST = { in: '2001-01-05', out: '2001-01-07' };

test.beforeEach(() => installModuleStubs());
test.afterEach(() => { resetAll(); restoreModuleStubs(); });

test('live event with same dates ADOPTS the existing email booking — no stub', async () => {
  const marije = { id: 'db-m', local_id: 'gmail-m', ical_uid: null, checkin: FUT.in, checkout: FUT.out, status: 'confirmed', guest_name: 'Marije Holtland', guests: 6, property_id: 'prop-1' };
  const { fetchMock, calls } = buildFetchMock({ icsText: ics([{ uid: 'uid-m', start: FUT.in, end: FUT.out }]), pool: [marije] });
  installFetchMock(fetchMock);
  const { syncOneFeed } = loadSync();

  const r = await syncOneFeed(SB, HEADERS, FEED);

  assert.equal(r.adopted, 1);
  assert.equal(r.imported, 0, 'no stub inserted');
  assert.equal(stubInserts(calls).length, 0);
  const link = bookingPatches(calls).find(c => c.url.includes('id=eq.db-m'));
  assert.ok(link, 'the existing booking is PATCHed');
  assert.equal(link.body.ical_uid, 'uid-m');
  assert.equal(link.body.ical_feed_id, 'feed-1');
  assert.equal(r.updated, 0, 'dates already match — nothing to re-date');
});

test('same check-in, different check-out: adopted AND re-dated to the feed', async () => {
  const stale = { id: 'db-s', local_id: 'gmail-s', ical_uid: null, checkin: FUT.in, checkout: '2099-12-25', status: 'confirmed', guest_name: 'Marije Holtland', guests: 6, property_id: 'prop-1' };
  const { fetchMock, calls } = buildFetchMock({ icsText: ics([{ uid: 'uid-s', start: FUT.in, end: FUT.out }]), pool: [stale] });
  installFetchMock(fetchMock);
  const { syncOneFeed } = loadSync();

  const r = await syncOneFeed(SB, HEADERS, FEED);

  assert.equal(r.adopted, 1);
  assert.equal(r.updated, 1, 're-dated');
  assert.equal(stubInserts(calls).length, 0);
  const redate = bookingPatches(calls).find(c => c.body && c.body.checkout === FUT.out);
  assert.ok(redate, 'checkout moved to the feed value');
  assert.equal(redate.body.nights, 2);
});

test('event with nothing to adopt still inserts a stub (unchanged behaviour)', async () => {
  const other = { id: 'db-o', local_id: 'gmail-o', ical_uid: null, checkin: '2099-11-01', checkout: '2099-11-03', status: 'confirmed', guest_name: 'Someone Else', guests: 2, property_id: 'prop-1' };
  const { fetchMock, calls } = buildFetchMock({ icsText: ics([{ uid: 'uid-new', start: FUT.in, end: FUT.out }]), pool: [other] });
  installFetchMock(fetchMock);
  const { syncOneFeed } = loadSync();

  const r = await syncOneFeed(SB, HEADERS, FEED);

  assert.equal(r.adopted, 0);
  assert.equal(r.imported, 1);
  const ins = stubInserts(calls);
  assert.equal(ins.length, 1);
  assert.equal(ins[0].body.ical_uid, 'uid-new');
  assert.equal(ins[0].body.guest_name, 'Reserved — awaiting details');
  assert.equal(bookingPatches(calls).length, 0, 'the unrelated booking is untouched');
});

test('a past event never inserts a stub', async () => {
  const { fetchMock, calls } = buildFetchMock({ icsText: ics([{ uid: 'uid-old', start: PAST.in, end: PAST.out }]) });
  installFetchMock(fetchMock);
  const { syncOneFeed } = loadSync();

  const r = await syncOneFeed(SB, HEADERS, FEED);

  assert.equal(r.imported, 0);
  assert.equal(stubInserts(calls).length, 0);
});

test('host blocks ("Airbnb (Not available)") are never bookings', async () => {
  const { fetchMock, calls } = buildFetchMock({
    icsText: ics([
      { uid: 'uid-block', start: FUT.in2, end: FUT.out, summary: 'Airbnb (Not available)' },
      { uid: 'uid-closed', start: '2099-11-10', end: '2099-11-12', summary: 'CLOSED - Not available' },
    ]),
  });
  installFetchMock(fetchMock);
  const { syncOneFeed } = loadSync();

  const r = await syncOneFeed(SB, HEADERS, FEED);

  assert.equal(r.imported, 0);
  assert.equal(stubInserts(calls).length, 0);
});

test('disappearance sweep: future stay gone from feed is cancelled, finished stay is left alone', async () => {
  const finished = { id: 'db-done', local_id: 'ical-done', ical_uid: 'uid-done', checkin: PAST.in, checkout: PAST.out, status: 'confirmed', guest_name: 'Past Guest', guests: 2, property_id: 'prop-1' };
  const upcoming = { id: 'db-up', local_id: 'ical-up', ical_uid: 'uid-up', checkin: '2099-11-20', checkout: '2099-11-22', status: 'confirmed', guest_name: 'Future Guest', guests: 2, property_id: 'prop-1' };
  const stillThere = { id: 'db-keep', local_id: 'ical-keep', ical_uid: 'uid-keep', checkin: FUT.in, checkout: FUT.out, status: 'confirmed', guest_name: 'Kept Guest', guests: 2, property_id: 'prop-1' };
  // Feed now only lists the kept stay.
  const { fetchMock, calls } = buildFetchMock({ icsText: ics([{ uid: 'uid-keep', start: FUT.in, end: FUT.out }]), icalRows: [finished, upcoming, stillThere] });
  installFetchMock(fetchMock);
  const { syncOneFeed } = loadSync();

  const r = await syncOneFeed(SB, HEADERS, FEED);

  assert.equal(r.cancelled, 1, 'only the upcoming stay is cancelled');
  const cancels = bookingPatches(calls).filter(c => c.body && c.body.status === 'cancelled');
  assert.equal(cancels.length, 1);
  assert.ok(cancels[0].url.includes('id=eq.db-up'));
  assert.ok(!bookingPatches(calls).some(c => c.url.includes('id=eq.db-done')), 'finished stay never touched');
});

test('both dates moved on the platform (the Marije case): adopted by proximity and re-dated, no stub', async () => {
  // App still holds the confirmation-email dates 23–24; Airbnb now says 24–26.
  const stale = { id: 'db-m', local_id: 'gmail-m', ical_uid: null, checkin: FUT.in2, checkout: FUT.out2, status: 'confirmed', guest_name: 'Marije Holtland', guests: 6, property_id: 'prop-1' };
  const { fetchMock, calls } = buildFetchMock({ icsText: ics([{ uid: 'uid-m', start: FUT.in, end: FUT.out }]), pool: [stale] });
  installFetchMock(fetchMock);
  const { syncOneFeed } = loadSync();

  const r = await syncOneFeed(SB, HEADERS, FEED);

  assert.equal(r.adopted, 1);
  assert.equal(r.imported, 0, 'no duplicate stub');
  assert.equal(stubInserts(calls).length, 0);
  const link = bookingPatches(calls).find(c => c.body && c.body.ical_uid === 'uid-m');
  assert.ok(link && link.url.includes('id=eq.db-m'));
  const redate = bookingPatches(calls).find(c => c.body && c.body.checkin === FUT.in && c.body.checkout === FUT.out);
  assert.ok(redate, 're-dated to the feed');
  assert.equal(r.updated, 1);
});

test('proximity pairing picks the closest pair and leaves truly new events as stubs', async () => {
  // Two un-linked bookings, two feed events each shifted by a day, plus one
  // event with nothing near it at all.
  const x = { id: 'db-x', local_id: 'gmail-x', ical_uid: null, checkin: '2099-11-10', checkout: '2099-11-12', status: 'confirmed', guest_name: 'X Guest', guests: 2, property_id: 'prop-1' };
  const y = { id: 'db-y', local_id: 'gmail-y', ical_uid: null, checkin: '2099-11-13', checkout: '2099-11-15', status: 'confirmed', guest_name: 'Y Guest', guests: 2, property_id: 'prop-1' };
  const { fetchMock, calls } = buildFetchMock({
    icsText: ics([
      { uid: 'uid-a', start: '2099-11-11', end: '2099-11-13' },
      { uid: 'uid-b', start: '2099-11-14', end: '2099-11-16' },
      { uid: 'uid-new', start: '2099-12-01', end: '2099-12-03' },
    ]),
    pool: [x, y],
  });
  installFetchMock(fetchMock);
  const { syncOneFeed } = loadSync();

  const r = await syncOneFeed(SB, HEADERS, FEED);

  assert.equal(r.adopted, 2);
  assert.equal(r.imported, 1, 'only the genuinely new event becomes a stub');
  const links = bookingPatches(calls).filter(c => c.body && c.body.ical_uid);
  assert.equal(links.find(c => c.url.includes('id=eq.db-x')).body.ical_uid, 'uid-a');
  assert.equal(links.find(c => c.url.includes('id=eq.db-y')).body.ical_uid, 'uid-b');
  assert.equal(stubInserts(calls)[0].body.ical_uid, 'uid-new');
});

test('a booking shifted by more than 3 days is not guessed at — the event becomes a stub', async () => {
  const far = { id: 'db-far', local_id: 'gmail-far', ical_uid: null, checkin: '2099-11-01', checkout: '2099-11-03', status: 'confirmed', guest_name: 'Far Guest', guests: 2, property_id: 'prop-1' };
  const { fetchMock, calls } = buildFetchMock({ icsText: ics([{ uid: 'uid-f', start: '2099-11-10', end: '2099-11-12' }]), pool: [far] });
  installFetchMock(fetchMock);
  const { syncOneFeed } = loadSync();

  const r = await syncOneFeed(SB, HEADERS, FEED);

  assert.equal(r.adopted, 0);
  assert.equal(r.imported, 1);
  assert.equal(bookingPatches(calls).length, 0, 'the far booking is untouched');
});

test('if the adoption PATCH fails, no stub is inserted (retry next sync)', async () => {
  const marije = { id: 'db-m', local_id: 'gmail-m', ical_uid: null, checkin: FUT.in, checkout: FUT.out, status: 'confirmed', guest_name: 'Marije Holtland', guests: 6, property_id: 'prop-1' };
  const { fetchMock, calls } = buildFetchMock({ icsText: ics([{ uid: 'uid-m', start: FUT.in, end: FUT.out }]), pool: [marije], failAdoptPatch: true });
  installFetchMock(fetchMock);
  const { syncOneFeed } = loadSync();

  const r = await syncOneFeed(SB, HEADERS, FEED);

  assert.equal(r.adopted, 0);
  assert.equal(r.errors, 1);
  assert.equal(stubInserts(calls).length, 0, 'never a duplicate stub');
});
