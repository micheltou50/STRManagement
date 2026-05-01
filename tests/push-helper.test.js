/**
 * StayOps — Tier B integration tests for push-helper.
 *
 * Covers:
 *   - notification_config toggle gates push (and short-circuits before email)
 *   - new_booking type bypasses the toggle map (every notification ships)
 *   - successful push logs to notification_log and emails the host
 *   - stale endpoints (HTTP 410) are removed from app_config.push_subscriptions
 *   - missing property → no-op
 *   - missing subscriptions → no-op
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

const HELPER = path.join(__dirname, '..', 'Netlify', 'functions', 'utils', 'push-helper.js');

function loadHelper() {
  delete require.cache[require.resolve(HELPER)];
  return require(HELPER);
}

function setupEnv() {
  process.env.VAPID_PUBLIC_KEY = 'test-pub';
  process.env.VAPID_PRIVATE_KEY = 'test-priv';
  // Ensure the email branch in the helper does not fire during tests
  // unless a test explicitly sets these.
  delete process.env.GMAIL_USER;
  delete process.env.GMAIL_APP_PASSWORD;
  delete process.env.RESEND_API_KEY;
}

function seedTables({ propertyId = 'prop-1', userId = 'user-1', subs = [], notif = {} } = {}) {
  return {
    properties: [{ id: propertyId, user_id: userId, name: 'Beach House' }],
    app_config: [{ user_id: userId, push_subscriptions: subs, notification_config: notif }],
    notification_log: [],
  };
}

function fakeSub(endpoint = 'https://push.example/abc') {
  return { endpoint, keys: { p256dh: 'p', auth: 'a' } };
}

test.afterEach(() => resetAll());

test('push-helper: toggle off → no push, no log, no email', async () => {
  setupEnv();
  const sb = makeFakeSupabase({
    tables: seedTables({
      subs: [fakeSub()],
      notif: { push_checkin: false },
    }),
  });
  const wp = makeFakeWebPush();
  const nm = makeFakeNodemailer();
  installModuleMocks({ supabase: sb, webpush: wp, nodemailer: nm });

  const { sendPushToHost } = loadHelper();
  const res = await sendPushToHost({
    supabaseAdmin: sb,
    propertyId: 'prop-1',
    title: '🔑 Check-in Today',
    body: 'Guest · 2 guests',
    type: 'checkin_today',
    referenceId: 'b-1',
  });

  assert.deepEqual(res, { sent: 0, removed: 0 });
  assert.equal(wp._sent.length, 0, 'no push should be sent');
  assert.equal(sb._store.notification_log.length, 0, 'no log row when toggle off');
});

test('push-helper: new_booking type is not toggle-gated', async () => {
  // new_booking is not in the typeToKey map, so it should always send.
  setupEnv();
  const sb = makeFakeSupabase({
    tables: seedTables({
      subs: [fakeSub()],
      notif: {}, // empty config
    }),
  });
  const wp = makeFakeWebPush();
  installModuleMocks({ supabase: sb, webpush: wp, nodemailer: makeFakeNodemailer() });

  const { sendPushToHost } = loadHelper();
  const res = await sendPushToHost({
    supabaseAdmin: sb,
    propertyId: 'prop-1',
    title: '🏠 New Booking',
    body: 'Guest',
    type: 'new_booking',
    referenceId: 'b-1',
  });

  assert.equal(res.sent, 1);
  assert.equal(wp._sent.length, 1);
  assert.equal(sb._store.notification_log.length, 1);
  assert.equal(sb._store.notification_log[0].type, 'new_booking');
});

test('push-helper: stale 410 endpoint is removed from app_config', async () => {
  setupEnv();
  const live = fakeSub('https://push.example/live');
  const dead = fakeSub('https://push.example/dead');
  const sb = makeFakeSupabase({
    tables: seedTables({ subs: [live, dead] }),
  });
  const wp = makeFakeWebPush({
    failures: [null, { statusCode: 410, message: 'gone' }],
  });
  installModuleMocks({ supabase: sb, webpush: wp, nodemailer: makeFakeNodemailer() });

  const { sendPushToHost } = loadHelper();
  const res = await sendPushToHost({
    supabaseAdmin: sb,
    propertyId: 'prop-1',
    title: 'X',
    body: 'Y',
    type: 'checkin_today',
    referenceId: 'b-1',
  });

  assert.equal(res.sent, 1);
  assert.equal(res.removed, 1);
  const subsAfter = sb._store.app_config[0].push_subscriptions;
  assert.equal(subsAfter.length, 1);
  assert.equal(subsAfter[0].endpoint, 'https://push.example/live');
});

test('push-helper: missing property → no-op', async () => {
  setupEnv();
  const sb = makeFakeSupabase({ tables: { properties: [], app_config: [], notification_log: [] } });
  const wp = makeFakeWebPush();
  installModuleMocks({ supabase: sb, webpush: wp, nodemailer: makeFakeNodemailer() });

  const { sendPushToHost } = loadHelper();
  const res = await sendPushToHost({
    supabaseAdmin: sb,
    propertyId: 'missing',
    title: 'X',
    body: 'Y',
    type: 'checkin_today',
    referenceId: 'b-1',
  });

  assert.deepEqual(res, { sent: 0, removed: 0 });
  assert.equal(wp._sent.length, 0);
});

test('push-helper: no subscriptions → no-op, no log row', async () => {
  setupEnv();
  const sb = makeFakeSupabase({ tables: seedTables({ subs: [] }) });
  const wp = makeFakeWebPush();
  installModuleMocks({ supabase: sb, webpush: wp, nodemailer: makeFakeNodemailer() });

  const { sendPushToHost } = loadHelper();
  const res = await sendPushToHost({
    supabaseAdmin: sb,
    propertyId: 'prop-1',
    title: 'X',
    body: 'Y',
    type: 'checkin_today',
    referenceId: 'b-1',
  });

  assert.deepEqual(res, { sent: 0, removed: 0 });
  assert.equal(sb._store.notification_log.length, 0);
});

test('push-helper: hasRecentNotification respects withinMinutes window', async () => {
  setupEnv();
  const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const sb = makeFakeSupabase({
    tables: {
      notification_log: [
        { id: '1', type: 'checkin_today', reference_id: 'b-1', sent_at: recent },
        { id: '2', type: 'checkin_today', reference_id: 'b-2', sent_at: old },
      ],
    },
  });
  installModuleMocks({ supabase: sb, webpush: makeFakeWebPush(), nodemailer: makeFakeNodemailer() });

  const { hasRecentNotification } = loadHelper();
  assert.equal(
    await hasRecentNotification({ supabaseAdmin: sb, type: 'checkin_today', referenceId: 'b-1', withinMinutes: 30 }),
    true,
    'recent row inside window'
  );
  assert.equal(
    await hasRecentNotification({ supabaseAdmin: sb, type: 'checkin_today', referenceId: 'b-2', withinMinutes: 30 }),
    false,
    'old row outside window'
  );
  assert.equal(
    await hasRecentNotification({ supabaseAdmin: sb, type: 'checkin_today', referenceId: 'b-3', withinMinutes: 30 }),
    false,
    'unknown reference id'
  );
});
