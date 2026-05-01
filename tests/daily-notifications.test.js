/**
 * StayOps — Tier B integration tests for daily-notifications.
 *
 * Covers:
 *   - cancelled bookings are skipped in the check-in section
 *   - already-notified bookings (within DEDUP_MINUTES) are skipped
 *   - happy path: new check-in produces a checkin_today push
 *   - checkout section produces a checkout_today push
 *   - unassigned cleans inside the 48h window produce a push
 *   - assigned cleans without confirmation past 12h produce a no_response push
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  makeFakeSupabase,
  makeFakeWebPush,
  makeFakeNodemailer,
  installModuleMocks,
  resetAll,
} = require('./_mocks.js');

const FN = path.join(__dirname, '..', 'Netlify', 'functions', 'daily-notifications.js');

function loadFn() {
  delete require.cache[require.resolve(FN)];
  // Force the push-helper to also pick up the mocks.
  delete require.cache[require.resolve(path.join(__dirname, '..', 'Netlify', 'functions', 'utils', 'push-helper.js'))];
  return require(FN);
}

function setupEnv() {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  process.env.VAPID_PUBLIC_KEY = 'pub';
  process.env.VAPID_PRIVATE_KEY = 'priv';
  delete process.env.CRON_SECRET; // accept unauthenticated calls in tests
  delete process.env.GMAIL_USER;
  delete process.env.RESEND_API_KEY;
}

function sydneyToday() {
  // Reuse the same TZ formatter the function uses, so seeded data is in sync
  // even when the host machine's local TZ differs from Australia/Sydney.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

function sub() { return { endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } }; }

function event({ headers = {} } = {}) {
  return { httpMethod: 'GET', headers, queryStringParameters: {}, body: '' };
}

test.afterEach(() => resetAll());

test('daily-notifications: skips cancelled bookings in check-in section', async () => {
  setupEnv();
  const today = sydneyToday();
  const sb = makeFakeSupabase({
    tables: {
      bookings: [
        { id: 'b-cancel', property_id: 'prop-1', guest_name: 'X', guests: 2, status: 'cancelled', checkin: today, checkout: '9999-12-31' },
      ],
      properties: [{ id: 'prop-1', user_id: 'user-1', name: 'House' }],
      app_config: [{ user_id: 'user-1', push_subscriptions: [sub()], notification_config: {} }],
      cleans: [],
      notification_log: [],
    },
  });
  const wp = makeFakeWebPush();
  installModuleMocks({ supabase: sb, webpush: wp, nodemailer: makeFakeNodemailer() });

  const { handler } = loadFn();
  const res = await handler(event());
  const body = JSON.parse(res.body);

  assert.equal(res.statusCode, 200);
  assert.equal(body.summary.checkins, 0);
  assert.equal(wp._sent.length, 0, 'cancelled booking must not push');
});

test('daily-notifications: skips check-in already in notification_log', async () => {
  setupEnv();
  const today = sydneyToday();
  const recent = new Date().toISOString();
  const sb = makeFakeSupabase({
    tables: {
      bookings: [
        { id: 'b-1', property_id: 'prop-1', guest_name: 'Alice', guests: 2, status: 'confirmed', checkin: today, checkout: '9999-12-31' },
      ],
      properties: [{ id: 'prop-1', user_id: 'user-1', name: 'House' }],
      app_config: [{ user_id: 'user-1', push_subscriptions: [sub()], notification_config: {} }],
      cleans: [],
      notification_log: [
        { id: 'log-1', type: 'checkin_today', reference_id: 'b-1', sent_at: recent },
      ],
    },
  });
  const wp = makeFakeWebPush();
  installModuleMocks({ supabase: sb, webpush: wp, nodemailer: makeFakeNodemailer() });

  const { handler } = loadFn();
  await handler(event());

  assert.equal(wp._sent.length, 0, 'dedup must skip recently-notified booking');
});

test('daily-notifications: happy path — confirmed check-in pushes', async () => {
  setupEnv();
  const today = sydneyToday();
  const sb = makeFakeSupabase({
    tables: {
      bookings: [
        { id: 'b-1', property_id: 'prop-1', guest_name: 'Alice', guests: 3, status: 'confirmed', checkin: today, checkout: '9999-12-31' },
      ],
      properties: [{ id: 'prop-1', user_id: 'user-1', name: 'Beach House' }],
      app_config: [{ user_id: 'user-1', push_subscriptions: [sub()], notification_config: {} }],
      cleans: [],
      notification_log: [],
    },
  });
  const wp = makeFakeWebPush();
  installModuleMocks({ supabase: sb, webpush: wp, nodemailer: makeFakeNodemailer() });

  const { handler } = loadFn();
  const res = await handler(event());
  const body = JSON.parse(res.body);

  assert.equal(body.summary.checkins, 1);
  assert.equal(wp._sent.length, 1);
  const payload = JSON.parse(wp._sent[0].payload);
  assert.equal(payload.type, 'checkin_today');
  assert.match(payload.title, /Check-in Today.*Beach House/);
  assert.match(payload.body, /Alice.*3 guests/);
  // Logged for dedup
  const logs = sb._store.notification_log.filter(l => l.type === 'checkin_today');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].reference_id, 'b-1');
});

test('daily-notifications: checkout section pushes for today\'s checkouts', async () => {
  setupEnv();
  const today = sydneyToday();
  const sb = makeFakeSupabase({
    tables: {
      bookings: [
        { id: 'b-2', property_id: 'prop-1', guest_name: 'Bob', guests: 2, status: 'confirmed', checkin: '2000-01-01', checkout: today },
      ],
      properties: [{ id: 'prop-1', user_id: 'user-1', name: 'House' }],
      app_config: [{ user_id: 'user-1', push_subscriptions: [sub()], notification_config: {} }],
      cleans: [],
      notification_log: [],
    },
  });
  const wp = makeFakeWebPush();
  installModuleMocks({ supabase: sb, webpush: wp, nodemailer: makeFakeNodemailer() });

  const { handler } = loadFn();
  const res = await handler(event());
  const body = JSON.parse(res.body);

  assert.equal(body.summary.checkouts, 1);
  const types = wp._sent.map(s => JSON.parse(s.payload).type);
  assert.deepEqual(types, ['checkout_today']);
});

test('daily-notifications: unassigned clean inside 48h window pushes', async () => {
  setupEnv();
  // Use tomorrow's Sydney date so hoursUntilCleanDate stays inside the 0–48h
  // window regardless of when the test runs.
  const today = sydneyToday();
  const tomorrow = (() => {
    const [y, m, d] = today.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + 1));
    return dt.toISOString().slice(0, 10);
  })();
  const sb = makeFakeSupabase({
    tables: {
      bookings: [],
      properties: [{ id: 'prop-1', user_id: 'user-1', name: 'House' }],
      app_config: [{ user_id: 'user-1', push_subscriptions: [sub()], notification_config: {} }],
      cleans: [
        // Unassigned clean — both cleaner and cleaner_id empty
        { id: 'c-1', property_id: 'prop-1', booking_id: 'b-1', guest_name: 'X',
          cleaner: '', cleaner_id: '', clean_date: tomorrow, done: false, cleaner_declined: false },
      ],
      notification_log: [],
    },
  });
  const wp = makeFakeWebPush();
  installModuleMocks({ supabase: sb, webpush: wp, nodemailer: makeFakeNodemailer() });

  const { handler } = loadFn();
  const res = await handler(event());
  const body = JSON.parse(res.body);

  assert.equal(body.summary.unassigned, 1);
  const types = wp._sent.map(s => JSON.parse(s.payload).type);
  assert.ok(types.includes('unassigned_clean'));
});

test('daily-notifications: assigned-but-no-response clean past 12h pushes', async () => {
  setupEnv();
  const today = sydneyToday();
  const longAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString(); // 24h ago

  const sb = makeFakeSupabase({
    tables: {
      bookings: [],
      properties: [{ id: 'prop-1', user_id: 'user-1', name: 'House' }],
      app_config: [{ user_id: 'user-1', push_subscriptions: [sub()], notification_config: {} }],
      cleans: [
        { id: 'c-1', property_id: 'prop-1', cleaner: 'Sam', cleaner_id: 'cl-1',
          clean_date: today, done: false, cleaner_confirmed: false, cleaner_declined: false,
          assigned_at: longAgo },
      ],
      cleaners: [{ local_id: 'cl-1', name: 'Sam', user_id: 'user-1' }],
      notification_log: [],
    },
  });
  const wp = makeFakeWebPush();
  installModuleMocks({ supabase: sb, webpush: wp, nodemailer: makeFakeNodemailer() });

  const { handler } = loadFn();
  const res = await handler(event());
  const body = JSON.parse(res.body);

  assert.equal(body.summary.no_response, 1);
  const noResp = wp._sent.find(s => JSON.parse(s.payload).type === 'no_response');
  assert.ok(noResp, 'expected a no_response push');
  assert.match(JSON.parse(noResp.payload).body, /Sam.*hasn't responded/);
});
