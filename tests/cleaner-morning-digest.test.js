'use strict';
// cleaner-morning-digest: one push per cleaner per day with the shape of the day.
// Tier B integration test with the fake Supabase client + fake web-push.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  makeFakeSupabase,
  makeFakeWebPush,
  installModuleMocks,
  resetAll,
} = require('./_mocks.js');

const FN = path.join(__dirname, '..', 'Netlify', 'functions', 'cleaner-morning-digest.js');
const HELPER = path.join(__dirname, '..', 'Netlify', 'functions', 'utils', 'push-helper.js');
function loadFn() {
  delete require.cache[require.resolve(FN)];
  delete require.cache[require.resolve(HELPER)];
  return require(FN);
}

function todaySydney() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const pick = t => parts.find(p => p.type === t).value;
  return pick('year') + '-' + pick('month') + '-' + pick('day');
}

const TODAY = todaySydney();
const HOST = 'host-1';
const MEGAN = '11111111-2222-4333-8444-555555555555';
const SAM = '66666666-7777-4888-9999-000000000000';
const SUB = { endpoint: 'https://push.example/megan', keys: { p256dh: 'p', auth: 'a' } };

function seed({ withMeganSub = true, priorLog = [] } = {}) {
  return {
    cleaners: [
      { id: MEGAN, name: 'Megan', auth_user_id: 'auth-megan', active: true },
      { id: SAM, name: 'Sam', auth_user_id: null, active: true },           // no login → skipped
    ],
    properties: [
      { id: 'p1', name: 'Seaview', user_id: HOST },
      { id: 'p2', name: 'Hilltop', user_id: HOST },
      { id: 'p3', name: 'Riverbend', user_id: HOST },
    ],
    cleans: [
      // same-day turnover at Hilltop: out 10:00, next guest 15:00
      { id: 'c1', user_id: HOST, property_id: 'p2', booking_id: '201', cleaner_uuid: MEGAN, guest_name: 'Bob', clean_date: TODAY, done: false, cleaner_declined: false, cleaner_cancel_notified: false, cleaner_confirmed: true },
      // Seaview: late checkout 11:00, nobody arriving, still awaiting Megan's reply
      { id: 'c2', user_id: HOST, property_id: 'p1', booking_id: '101', cleaner_uuid: MEGAN, guest_name: 'Alice', clean_date: TODAY, done: false, cleaner_declined: false, cleaner_cancel_notified: false, cleaner_confirmed: false },
      // Riverbend: booking cancelled → not counted
      { id: 'c3', user_id: HOST, property_id: 'p3', booking_id: '301', cleaner_uuid: MEGAN, guest_name: 'Cara', clean_date: TODAY, done: false, cleaner_declined: false, cleaner_cancel_notified: false, cleaner_confirmed: true },
      // Sam's clean — Sam has no auth user, so no digest
      { id: 'c4', user_id: HOST, property_id: 'p1', booking_id: '102', cleaner_uuid: SAM, guest_name: 'Dee', clean_date: TODAY, done: false, cleaner_declined: false, cleaner_cancel_notified: false, cleaner_confirmed: true },
      // done already → excluded by the query
      { id: 'c5', user_id: HOST, property_id: 'p1', booking_id: '103', cleaner_uuid: MEGAN, guest_name: 'Eve', clean_date: TODAY, done: true, cleaner_declined: false, cleaner_cancel_notified: false, cleaner_confirmed: true },
    ],
    bookings: [
      { id: 'b201', local_id: '201', property_id: 'p2', user_id: HOST, checkin: '2026-01-01', checkout: TODAY, status: 'confirmed', guests: 2 },
      { id: 'b202', local_id: '202', property_id: 'p2', user_id: HOST, checkin: TODAY, checkout: '2099-01-01', checkin_time: '15:00:00', status: 'confirmed', guests: 4 },
      { id: 'b101', local_id: '101', property_id: 'p1', user_id: HOST, checkin: '2026-01-01', checkout: TODAY, checkout_time: '11:00:00', status: 'confirmed', guests: 3 },
      { id: 'b301', local_id: '301', property_id: 'p3', user_id: HOST, checkin: '2026-01-01', checkout: TODAY, status: 'cancelled', guests: 2 },
      { id: 'b102', local_id: '102', property_id: 'p1', user_id: HOST, checkin: '2026-01-01', checkout: TODAY, status: 'confirmed', guests: 1 },
    ],
    app_config: [
      { user_id: 'auth-megan', push_subscriptions: withMeganSub ? [SUB] : [], native_push_tokens: [] },
    ],
    notification_log: priorLog,
  };
}

test.beforeEach(() => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'test-key';
  process.env.VAPID_PUBLIC_KEY = 'test-pub';
  process.env.VAPID_PRIVATE_KEY = 'test-priv';
  delete process.env.CRON_SECRET;
});
test.afterEach(() => resetAll());

test('refuses an unscheduled call without the cron secret', async () => {
  installModuleMocks({ supabase: makeFakeSupabase({ tables: seed() }), webpush: makeFakeWebPush() });
  const res = await loadFn().handler({ headers: {}, body: '' });
  assert.equal(res.statusCode, 401);
});

test('accepts a manual call with x-cron-secret', async () => {
  process.env.CRON_SECRET = 's3cret';
  installModuleMocks({ supabase: makeFakeSupabase({ tables: seed() }), webpush: makeFakeWebPush() });
  const res = await loadFn().handler({ headers: { 'x-cron-secret': 's3cret' }, body: '' });
  assert.equal(res.statusCode, 200);
});

test('scheduled run: one digest per cleaner with login, deadline-first body, logged for dedup', async () => {
  const sb = makeFakeSupabase({ tables: seed() });
  const wp = makeFakeWebPush();
  installModuleMocks({ supabase: sb, webpush: wp });

  const res = await loadFn().handler({ headers: {}, body: JSON.stringify({ next_run: '2026-10-12T20:00:00Z' }) });
  assert.equal(res.statusCode, 200);
  const out = JSON.parse(res.body);
  assert.equal(out.cleaners, 1, 'only Megan has an auth user');
  assert.equal(out.sent, 1);

  assert.equal(wp._sent.length, 1);
  const payload = JSON.parse(wp._sent[0].payload);
  assert.equal(payload.title, '🧹 Today: 2 cleans');           // cancelled Riverbend and done Eve excluded
  assert.ok(payload.body.includes('First out 10am at Hilltop'), payload.body);
  assert.ok(payload.body.includes('1 same-day turnover (Hilltop, next guest 3pm)'), payload.body);
  assert.ok(payload.body.includes('1 awaiting your reply'), payload.body);
  assert.equal(payload.tag, 'cleaner-digest-' + TODAY);

  const log = sb._store.notification_log;
  assert.equal(log.length, 1);
  assert.equal(log[0].type, 'cleaner_digest');
  assert.equal(log[0].reference_id, MEGAN + ':' + TODAY);
});

test('a second run the same day sends nothing (notification_log dedup)', async () => {
  const prior = [{ id: 'n1', type: 'cleaner_digest', reference_id: MEGAN + ':' + TODAY, sent_at: new Date().toISOString() }];
  const sb = makeFakeSupabase({ tables: seed({ priorLog: prior }) });
  const wp = makeFakeWebPush();
  installModuleMocks({ supabase: sb, webpush: wp });

  const res = await loadFn().handler({ headers: {}, body: JSON.stringify({ next_run: 'x' }) });
  const out = JSON.parse(res.body);
  assert.equal(out.sent, 0);
  assert.equal(wp._sent.length, 0);
  assert.equal(sb._store.notification_log.length, 1, 'no new log row');
});

test('cleaner without push subscriptions: counted, nothing sent, still logged', async () => {
  const sb = makeFakeSupabase({ tables: seed({ withMeganSub: false }) });
  const wp = makeFakeWebPush();
  installModuleMocks({ supabase: sb, webpush: wp });
  const res = await loadFn().handler({ headers: {}, body: JSON.stringify({ next_run: 'x' }) });
  const out = JSON.parse(res.body);
  assert.equal(out.cleaners, 1);
  assert.equal(out.sent, 0);
  assert.equal(wp._sent.length, 0);
});

test('composeDigest: single clean, no turnover, confirmed', () => {
  const { _composeDigest } = loadFn();
  const d = _composeDigest([{ propertyName: 'Seaview', awaiting: false, turnover: { checkout: '10:00', sameDay: false, nextTime: '', nextDay: '' } }]);
  assert.equal(d.title, '🧹 Today: 1 clean');
  assert.equal(d.body, 'First out 10am at Seaview');
});
