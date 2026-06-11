/**
 * StayOps — Tier B integration tests for cleaner-action.
 *
 * Covers:
 *   - rejects unknown action values
 *   - rejects cleaner that doesn't belong to the host (403)
 *   - accept/decline/done all return ok and PATCH cleans with the right shape
 *   - accept inserts a clean_confirmed system message
 *   - decline insert a clean_declined system message
 *   - host push is dispatched after the action
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  installFetchMock,
  installModuleMocks,
  makeFakeSupabase,
  makeFakeWebPush,
  makeFakeNodemailer,
  resetAll,
} = require('./_mocks.js');

const FN = path.join(__dirname, '..', 'Netlify', 'functions', 'cleaner-action.js');

function loadFn() {
  // Force fresh require for handler + push-helper.
  delete require.cache[require.resolve(FN)];
  delete require.cache[require.resolve(path.join(__dirname, '..', 'Netlify', 'functions', 'utils', 'push-helper.js'))];
  return require(FN);
}

function setupEnv() {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'test-key';
  process.env.VAPID_PUBLIC_KEY = 'pub';
  process.env.VAPID_PRIVATE_KEY = 'priv';
  delete process.env.GMAIL_USER;
  delete process.env.RESEND_API_KEY;
}

function buildFetchMock({
  cleaners = [{ id: 'cl-uuid-1', name: 'Sam' }],
  cleanRows = [{ property_id: 'prop-1', guest_name: 'Alice', clean_date: '2026-05-01' }],
  // PATCH now uses return=representation; a non-empty array means a row matched
  // (user_id + clean local_id + acting cleaner_id). [] simulates the IDOR case
  // where the clean isn't assigned to this cleaner.
  patchRows = [{ id: 'cn-row-1' }],
} = {}) {
  const calls = [];
  const fetchMock = async (url, init) => {
    calls.push({ url, method: (init && init.method) || 'GET', body: init && init.body });

    // Cleaner lookup
    if (url.includes('/rest/v1/cleaners?')) {
      return { status: 200, body: cleaners };
    }
    // Clean lookup (after PATCH) — has &select=property_id
    if (url.includes('/rest/v1/cleans?') && url.includes('select=property_id')) {
      return { status: 200, body: cleanRows };
    }
    // PATCH clean
    if (url.includes('/rest/v1/cleans?') && (init && init.method) === 'PATCH') {
      return { status: 200, body: patchRows };
    }
    // Insert message
    if (url.includes('/rest/v1/messages')) {
      return { status: 201, body: '' };
    }
    return { status: 200, body: [] };
  };
  return { fetchMock, calls };
}

function event(body) {
  return { httpMethod: 'POST', headers: {}, body: JSON.stringify(body) };
}

test.afterEach(() => resetAll());

test('cleaner-action: invalid action → 400', async () => {
  setupEnv();
  installModuleMocks({ supabase: makeFakeSupabase(), webpush: makeFakeWebPush(), nodemailer: makeFakeNodemailer() });
  installFetchMock(async () => ({ status: 200, body: [] }));

  const { handler } = loadFn();
  const res = await handler(event({ uid: 'u', cleanerId: 'c', cleanId: 'k', action: 'explode' }));

  assert.equal(res.statusCode, 400);
  assert.match(res.body, /Invalid action/);
});

test('cleaner-action: cleaner not found → 403', async () => {
  setupEnv();
  installModuleMocks({ supabase: makeFakeSupabase(), webpush: makeFakeWebPush(), nodemailer: makeFakeNodemailer() });
  const { fetchMock } = buildFetchMock({ cleaners: [] });
  installFetchMock(fetchMock);

  const { handler } = loadFn();
  const res = await handler(event({ uid: 'u', cleanerId: 'c', cleanId: 'k', action: 'accept' }));

  assert.equal(res.statusCode, 403);
});

test('cleaner-action: accept patches cleans with confirmed=true and pushes host', async () => {
  setupEnv();
  // Provide a property + sub so push-helper actually sends.
  const sb = makeFakeSupabase({
    tables: {
      properties: [{ id: 'prop-1', user_id: 'user-1', name: 'House' }],
      app_config: [{ user_id: 'user-1', push_subscriptions: [{ endpoint: 'e', keys: { p256dh: 'p', auth: 'a' } }], notification_config: {} }],
      notification_log: [],
    },
  });
  const wp = makeFakeWebPush();
  installModuleMocks({ supabase: sb, webpush: wp, nodemailer: makeFakeNodemailer() });
  const { fetchMock, calls } = buildFetchMock();
  installFetchMock(fetchMock);

  const { handler } = loadFn();
  const res = await handler(event({ uid: 'user-1', cleanerId: 'cl-1', cleanId: 'cn-1', action: 'accept' }));

  assert.equal(res.statusCode, 200);
  assert.match(res.body, /"action":"accept"/);

  // Verify a PATCH to /cleans was issued with cleaner_confirmed: true.
  const patch = calls.find(c => c.method === 'PATCH' && c.url.includes('/rest/v1/cleans'));
  assert.ok(patch, 'expected a PATCH to cleans');
  const patchBody = JSON.parse(patch.body);
  assert.equal(patchBody.cleaner_confirmed, true);
  assert.equal(patchBody.cleaner_declined, false);
  assert.ok(patchBody.confirmed_at, 'accept should stamp confirmed_at');

  // Verify a system card row was inserted.
  const msg = calls.find(c => c.url.includes('/rest/v1/messages'));
  assert.ok(msg, 'expected a messages insert');
  const msgBody = JSON.parse(msg.body);
  assert.equal(msgBody.card_type, 'clean_confirmed');
  assert.equal(msgBody.sender_type, 'system');

  // Verify host push fired with the right type.
  assert.equal(wp._sent.length, 1);
  const payload = JSON.parse(wp._sent[0].payload);
  assert.equal(payload.type, 'cleaner_confirmed');
  assert.match(payload.title, /Sam confirmed/);
});

test('cleaner-action: decline patches cleans with declined=true and pushes host', async () => {
  setupEnv();
  const sb = makeFakeSupabase({
    tables: {
      properties: [{ id: 'prop-1', user_id: 'user-1', name: 'House' }],
      app_config: [{ user_id: 'user-1', push_subscriptions: [{ endpoint: 'e', keys: { p256dh: 'p', auth: 'a' } }], notification_config: {} }],
      notification_log: [],
    },
  });
  const wp = makeFakeWebPush();
  installModuleMocks({ supabase: sb, webpush: wp, nodemailer: makeFakeNodemailer() });
  const { fetchMock, calls } = buildFetchMock();
  installFetchMock(fetchMock);

  const { handler } = loadFn();
  const res = await handler(event({ uid: 'user-1', cleanerId: 'cl-1', cleanId: 'cn-1', action: 'decline' }));

  assert.equal(res.statusCode, 200);
  const patch = calls.find(c => c.method === 'PATCH' && c.url.includes('/rest/v1/cleans'));
  const patchBody = JSON.parse(patch.body);
  assert.equal(patchBody.cleaner_declined, true);
  assert.equal(patchBody.cleaner_confirmed, false);

  const msg = calls.find(c => c.url.includes('/rest/v1/messages'));
  assert.equal(JSON.parse(msg.body).card_type, 'clean_declined');

  const payload = JSON.parse(wp._sent[0].payload);
  assert.equal(payload.type, 'cleaner_declined');
});

test('cleaner-action: done patches done=true and pushes clean_done', async () => {
  setupEnv();
  const sb = makeFakeSupabase({
    tables: {
      properties: [{ id: 'prop-1', user_id: 'user-1', name: 'House' }],
      app_config: [{ user_id: 'user-1', push_subscriptions: [{ endpoint: 'e', keys: { p256dh: 'p', auth: 'a' } }], notification_config: {} }],
      notification_log: [],
    },
  });
  const wp = makeFakeWebPush();
  installModuleMocks({ supabase: sb, webpush: wp, nodemailer: makeFakeNodemailer() });
  const { fetchMock, calls } = buildFetchMock();
  installFetchMock(fetchMock);

  const { handler } = loadFn();
  const res = await handler(event({ uid: 'user-1', cleanerId: 'cl-1', cleanId: 'cn-1', action: 'done' }));

  assert.equal(res.statusCode, 200);
  const patch = calls.find(c => c.method === 'PATCH' && c.url.includes('/rest/v1/cleans'));
  const patchBody = JSON.parse(patch.body);
  assert.equal(patchBody.done, true);

  const payload = JSON.parse(wp._sent[0].payload);
  assert.equal(payload.type, 'clean_done');
});

test('cleaner-action: wrong PIN → 403, no clean PATCH', async () => {
  setupEnv();
  installModuleMocks({ supabase: makeFakeSupabase(), webpush: makeFakeWebPush(), nodemailer: makeFakeNodemailer() });
  // Cleaner has a PIN on file; caller presents the wrong one.
  const { fetchMock, calls } = buildFetchMock({ cleaners: [{ id: 'cl-uuid-1', name: 'Sam', pin: '1234' }] });
  installFetchMock(fetchMock);

  const { handler } = loadFn();
  const res = await handler(event({ uid: 'user-1', cleanerId: 'cl-1', cleanId: 'cn-1', action: 'accept', pin: '9999' }));

  assert.equal(res.statusCode, 403);
  assert.match(res.body, /Invalid PIN/);
  // The clean must NOT have been touched.
  assert.equal(calls.find(c => c.method === 'PATCH' && c.url.includes('/rest/v1/cleans')), undefined);
});

test('cleaner-action: correct PIN → 200', async () => {
  setupEnv();
  const sb = makeFakeSupabase({
    tables: {
      properties: [{ id: 'prop-1', user_id: 'user-1', name: 'House' }],
      app_config: [{ user_id: 'user-1', push_subscriptions: [], notification_config: {} }],
      notification_log: [],
    },
  });
  installModuleMocks({ supabase: sb, webpush: makeFakeWebPush(), nodemailer: makeFakeNodemailer() });
  const { fetchMock } = buildFetchMock({ cleaners: [{ id: 'cl-uuid-1', name: 'Sam', pin: '1234' }] });
  installFetchMock(fetchMock);

  const { handler } = loadFn();
  const res = await handler(event({ uid: 'user-1', cleanerId: 'cl-1', cleanId: 'cn-1', action: 'accept', pin: '1234' }));

  assert.equal(res.statusCode, 200);
});

test('cleaner-action: clean not assigned to this cleaner (IDOR) → 403', async () => {
  setupEnv();
  installModuleMocks({ supabase: makeFakeSupabase(), webpush: makeFakeWebPush(), nodemailer: makeFakeNodemailer() });
  // PATCH scoped by cleaner_id matches zero rows → handler must refuse.
  const { fetchMock } = buildFetchMock({ patchRows: [] });
  installFetchMock(fetchMock);

  const { handler } = loadFn();
  const res = await handler(event({ uid: 'user-1', cleanerId: 'cl-1', cleanId: 'cn-1', action: 'accept' }));

  assert.equal(res.statusCode, 403);
  assert.match(res.body, /not assigned/);
});
