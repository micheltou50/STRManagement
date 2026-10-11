'use strict';
// cleaner-calendar-feed: the .ics feed a cleaner subscribes to from their phone
// calendar. Same fetch-mock pattern as cleaner-action.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { installFetchMock, resetAll } = require('./_mocks.js');

const FN = path.join(__dirname, '..', 'Netlify', 'functions', 'cleaner-calendar-feed.js');
function loadFn() {
  delete require.cache[require.resolve(FN)];
  return require(FN);
}
const CLEANER = '11111111-2222-4333-8444-555555555555';

function mockSupabase({ cleaners = [], cleans = [], properties = [], bookings = [] }) {
  const calls = [];
  installFetchMock(async (url) => {
    calls.push(url);
    if (url.includes('/rest/v1/cleaners?')) return { status: 200, body: cleaners };
    if (url.includes('/rest/v1/cleans?')) return { status: 200, body: cleans };
    if (url.includes('/rest/v1/properties?')) return { status: 200, body: properties };
    if (url.includes('/rest/v1/bookings?')) return { status: 200, body: bookings };
    return { status: 404, body: [] };
  });
  return calls;
}

test.beforeEach(() => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'test-key';
});
test.afterEach(() => resetAll());

test('rejects a non-uuid key before touching Supabase', async () => {
  const calls = mockSupabase({});
  const res = await loadFn().handler({ queryStringParameters: { key: "x' or 1=1" } });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(calls, []);
});

test('404 for an unknown or deactivated cleaner', async () => {
  mockSupabase({ cleaners: [] });
  assert.equal((await loadFn().handler({ queryStringParameters: { key: CLEANER } })).statusCode, 404);
  resetAll();
  mockSupabase({ cleaners: [{ id: CLEANER, name: 'Megan', active: false }] });
  assert.equal((await loadFn().handler({ queryStringParameters: { key: CLEANER } })).statusCode, 404);
});

test('timed events from turnover facts; cancelled booking skipped; lockbox code withheld; lines folded', async () => {
  const cleans = [
    // same-day turnover: late checkout 11:00, next guest 16:00
    { id: 'c1', local_id: '1', booking_id: '101', property_id: 'p1', guest_name: 'Alice', clean_date: '2026-10-12', done: false, cleaner_confirmed: true, started_at: null, notes: 'Extra towels please' },
    // default 10:00 checkout, nobody arriving → 3h block, awaiting reply
    { id: 'c2', local_id: '2', booking_id: '103', property_id: 'p2', guest_name: 'Bob', clean_date: '2026-10-12', done: false, cleaner_confirmed: false, started_at: null, notes: null },
    // own booking cancelled → no event
    { id: 'c3', local_id: '3', booking_id: '105', property_id: 'p1', guest_name: 'Cara', clean_date: '2026-10-20', done: false, cleaner_confirmed: true, started_at: null, notes: null },
  ];
  const properties = [
    { id: 'p1', name: 'Seaview', address: '1 Beach Rd', suburb: 'Kiama', state: 'NSW',
      check_in_info: { lockbox_code: '4821', instructions: 'Side gate sticks, lift and push', wifi: 'Seaview_Guest', cleaner_notes: 'Linen in the hall cupboard, top shelf. Bins out Tuesday night. King in main, two singles in bed 2.' } },
    { id: 'p2', name: 'Hilltop', address: '9 Ridge St', suburb: '', state: 'NSW', check_in_info: {} },
  ];
  const bookings = [
    { id: 'b101', local_id: '101', property_id: 'p1', checkin: '2026-10-09', checkout: '2026-10-12', checkout_time: '11:00:00', status: 'confirmed', guests: 4 },
    { id: 'b102', local_id: '102', property_id: 'p1', checkin: '2026-10-12', checkout: '2026-10-15', checkin_time: '16:00:00', status: 'confirmed', guests: 2 },
    { id: 'b103', local_id: '103', property_id: 'p2', checkin: '2026-10-10', checkout: '2026-10-12', status: 'confirmed', guests: 3 },
    { id: 'b105', local_id: '105', property_id: 'p1', checkin: '2026-10-18', checkout: '2026-10-20', status: 'cancelled', guests: 2 },
  ];
  const calls = mockSupabase({ cleaners: [{ id: CLEANER, name: 'Megan Smith', active: true }], cleans, properties, bookings });

  const res = await loadFn().handler({ queryStringParameters: { key: CLEANER } });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /text\/calendar/);

  const raw = res.body;
  const unfolded = raw.replace(/\r\n[ \t]/g, '');

  // declined cleans are excluded in the query itself
  assert.ok(calls.some(u => u.includes('/rest/v1/cleans?') && u.includes('cleaner_declined=eq.false')));

  // c1: 11:00 → 16:00, summary names the deadline
  assert.ok(unfolded.includes('UID:clean-c1@stayops'));
  assert.ok(unfolded.includes('DTSTART:20261012T110000'));
  assert.ok(unfolded.includes('DTEND:20261012T160000'));
  assert.ok(unfolded.includes('SUMMARY:Clean · Seaview (next guest 4pm)'));
  assert.ok(unfolded.includes('LOCATION:1 Beach Rd\\, Kiama\\, NSW'));
  assert.ok(unfolded.includes('Guest out: Alice (4 guests) · 11am'));
  assert.ok(unfolded.includes('Next guest: 4pm today (2 guests)'));
  assert.ok(unfolded.includes('Note from host: Extra towels please'));
  assert.ok(unfolded.includes('Wi-Fi: Seaview_Guest'));

  // c2: default 10:00, +3h, tentative until accepted
  assert.ok(unfolded.includes('DTSTART:20261012T100000'));
  assert.ok(unfolded.includes('DTEND:20261012T130000'));
  assert.ok(unfolded.includes('Next guest: none booked yet'));
  assert.ok(unfolded.includes('STATUS:TENTATIVE'));

  // c3: its booking is cancelled → no event at all
  assert.ok(!unfolded.includes('clean-c3@stayops'));

  // the lockbox code never leaves the app
  assert.ok(!unfolded.includes('4821'));
  assert.ok(unfolded.includes('Lockbox code: shown in the StayOps app on the day'));

  assert.ok(unfolded.includes('X-WR-CALNAME:StayOps cleans · Megan'));

  // RFC 5545: no content line longer than 75 characters
  assert.deepEqual(raw.split('\r\n').filter(l => l.length > 75), []);
});

test('empty feed is still a valid calendar', async () => {
  mockSupabase({ cleaners: [{ id: CLEANER, name: 'Megan', active: true }], cleans: [] });
  const res = await loadFn().handler({ queryStringParameters: { key: CLEANER } });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.startsWith('BEGIN:VCALENDAR'));
  assert.ok(res.body.includes('END:VCALENDAR'));
  assert.ok(!res.body.includes('BEGIN:VEVENT'));
});
