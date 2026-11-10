'use strict';
// cleaner-handoff: a cleaner hands one of their cleans to a teammate of the
// same host. Tier B integration test with the fake Supabase client + fake web-push.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  makeFakeSupabase,
  makeFakeWebPush,
  installModuleMocks,
  resetAll,
} = require('./_mocks.js');

const FN = path.join(__dirname, '..', 'Netlify', 'functions', 'cleaner-handoff.js');
function loadFn() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('Netlify', 'functions'))) delete require.cache[k];
  }
  return require(FN);
}

const HOST = 'host-1';
const OTHER_HOST = 'host-2';
const MEGAN = '11111111-2222-4333-8444-555555555555';   // caller
const MEGAN_B = '11111111-2222-4333-8444-666666666666'; // caller's row under host-2
const SAM = '66666666-7777-4888-9999-000000000000';     // teammate, same host, has a login
const JO = '77777777-7777-4888-9999-000000000000';      // teammate, same host, no login
const KIM = '88888888-7777-4888-9999-000000000000';     // works for host-2 only
const SUB = who => ({ endpoint: 'https://push.example/' + who, keys: { p256dh: 'p', auth: 'a' } });

function seed() {
  return {
    cleaners: [
      { id: MEGAN, local_id: '1', name: 'Megan', user_id: HOST, auth_user_id: 'auth-megan', active: true },
      { id: MEGAN_B, local_id: '9', name: 'Megan', user_id: OTHER_HOST, auth_user_id: 'auth-megan', active: true },
      { id: SAM, local_id: '2', name: 'Sam', user_id: HOST, auth_user_id: 'auth-sam', active: true },
      { id: JO, local_id: '3', name: 'Jo', user_id: HOST, auth_user_id: null, active: true },
      { id: KIM, local_id: '1', name: 'Kim', user_id: OTHER_HOST, auth_user_id: 'auth-kim', active: true },
    ],
    properties: [
      { id: 'p1', name: 'Seaview', user_id: HOST },
    ],
    cleans: [
      { id: 'c1', user_id: HOST, property_id: 'p1', booking_id: '101', cleaner_uuid: MEGAN, cleaner_id: '1', cleaner: 'Megan', guest_name: 'Alice', clean_date: '2026-10-20', done: false, cleaner_confirmed: true, cleaner_declined: false, started_at: '2026-10-20T00:10:00Z', checklist_done: ['Bins'], photos: [{ url: 'https://x/1.jpg' }], notified: true, reminder_sent: true },
      { id: 'c2', user_id: HOST, property_id: 'p1', booking_id: '102', cleaner_uuid: SAM, cleaner_id: '2', cleaner: 'Sam', guest_name: 'Bob', clean_date: '2026-10-21', done: false, cleaner_confirmed: false, cleaner_declined: false },
      { id: 'c3', user_id: HOST, property_id: 'p1', booking_id: '103', cleaner_uuid: MEGAN, cleaner_id: '1', cleaner: 'Megan', guest_name: 'Cara', clean_date: '2026-10-01', done: true, cleaner_confirmed: true, cleaner_declined: false },
    ],
    app_config: [
      { user_id: HOST, push_subscriptions: [SUB('host')], native_push_tokens: [], notification_config: {} },
      { user_id: 'auth-sam', push_subscriptions: [SUB('sam')], native_push_tokens: [] },
    ],
    notification_log: [],
  };
}

const AUTH_USERS = [{ id: 'auth-megan', token: 'tok-megan', email: 'megan@example.com' }];

function call(fn, body, { token = 'tok-megan', method = 'POST' } = {}) {
  const headers = token ? { authorization: 'Bearer ' + token } : {};
  return fn.handler({ httpMethod: method, headers, body: body == null ? '' : JSON.stringify(body) });
}

function setup(tables = seed()) {
  const sb = makeFakeSupabase({ tables, authUsers: AUTH_USERS });
  const wp = makeFakeWebPush();
  installModuleMocks({ supabase: sb, webpush: wp });
  return { sb, wp, fn: loadFn() };
}

test.beforeEach(() => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'test-key';
  process.env.VAPID_PUBLIC_KEY = 'test-pub';
  process.env.VAPID_PRIVATE_KEY = 'test-priv';
  delete process.env.RESEND_API_KEY;
});
test.afterEach(() => resetAll());

test('rejects anything but POST, and a call without a cleaner token', async () => {
  const { fn } = setup();
  assert.equal((await call(fn, null, { method: 'GET' })).statusCode, 405);
  assert.equal((await call(fn, { cleanId: 'c1', toCleanerId: SAM }, { token: '' })).statusCode, 401);
  assert.equal((await call(fn, { cleanId: 'c1', toCleanerId: SAM }, { token: 'bogus' })).statusCode, 401);
});

test('400 when cleanId or toCleanerId is missing', async () => {
  const { fn } = setup();
  assert.equal((await call(fn, { cleanId: 'c1' })).statusCode, 400);
  assert.equal((await call(fn, { toCleanerId: SAM })).statusCode, 400);
});

test('403 when the clean is not the caller\'s', async () => {
  const { fn, sb } = setup();
  const res = await call(fn, { cleanId: 'c2', toCleanerId: JO });
  assert.equal(res.statusCode, 403);
  assert.equal(sb._store.cleans.find(c => c.id === 'c2').cleaner_uuid, SAM, 'untouched');
});

test('409 when the clean is already done', async () => {
  const { fn } = setup();
  assert.equal((await call(fn, { cleanId: 'c3', toCleanerId: SAM })).statusCode, 409);
});

test('400 when the teammate works for a different host, or is the caller\'s own other row', async () => {
  const { fn, sb } = setup();
  const r1 = await call(fn, { cleanId: 'c1', toCleanerId: KIM });
  assert.equal(r1.statusCode, 400);
  assert.match(JSON.parse(r1.body).error, /does not work for this host/);
  const r2 = await call(fn, { cleanId: 'c1', toCleanerId: MEGAN_B });
  assert.equal(r2.statusCode, 400);
  const r3 = await call(fn, { cleanId: 'c1', toCleanerId: 'nope' });
  assert.equal(r3.statusCode, 400);
  assert.equal(sb._store.cleans.find(c => c.id === 'c1').cleaner_uuid, MEGAN, 'untouched');
});

test('hands the clean over: re-pointed, back to awaiting, progress reset, host + teammate pushed', async () => {
  const { fn, sb, wp } = setup();
  const res = await call(fn, { cleanId: 'c1', toCleanerId: SAM });
  assert.equal(res.statusCode, 200, res.body);
  const out = JSON.parse(res.body);
  assert.equal(out.ok, true);
  assert.deepEqual(out.to, { id: SAM, name: 'Sam' });
  assert.equal(out.hostNotified, 1);
  assert.equal(out.teammateNotified, 1);

  const c = sb._store.cleans.find(x => x.id === 'c1');
  assert.equal(c.cleaner_uuid, SAM);
  assert.equal(c.cleaner_id, '2', 'host app matches cleaners by local_id');
  assert.equal(c.cleaner, 'Sam');
  assert.equal(c.cleaner_confirmed, false, 'Sam still has to accept');
  assert.equal(c.cleaner_declined, false);
  assert.equal(c.started_at, null);
  assert.deepEqual(c.checklist_done, []);
  assert.deepEqual(c.photos, [{ url: 'https://x/1.jpg' }], 'photos are kept');
  assert.equal(c.notified, false, 'host dashboard will prompt to notify Sam properly');
  assert.equal(c.reminder_sent, false, 'Sam gets the 24h reminder email');
  assert.ok(c.assigned_at);

  // Host push is logged (push-helper sendPushToHost), teammate push is not.
  const log = sb._store.notification_log;
  assert.equal(log.length, 1);
  assert.equal(log[0].type, 'cleaner_handoff');
  assert.equal(log[0].reference_id, 'c1');
  assert.match(log[0].title, /Megan handed a clean to Sam/);
  assert.match(log[0].body, /Seaview on Tue, 20 Oct · Alice/);

  assert.equal(wp._sent.length, 2);
  const endpoints = wp._sent.map(s => s.sub.endpoint).sort();
  assert.deepEqual(endpoints, ['https://push.example/host', 'https://push.example/sam']);
  const toSam = JSON.parse(wp._sent.find(s => s.sub.endpoint.endsWith('/sam')).payload);
  assert.equal(toSam.title, '🏡 Megan handed you a clean');
  assert.equal(toSam.tag, 'handoff-c1');
});

test('teammate without a login: clean is handed over, host pushed, teammateNotified 0', async () => {
  const { fn, sb, wp } = setup();
  const res = await call(fn, { cleanId: 'c1', toCleanerId: JO });
  assert.equal(res.statusCode, 200, res.body);
  const out = JSON.parse(res.body);
  assert.equal(out.teammateNotified, 0);
  assert.equal(sb._store.cleans.find(x => x.id === 'c1').cleaner_uuid, JO);
  assert.equal(wp._sent.length, 1, 'host only');
});
