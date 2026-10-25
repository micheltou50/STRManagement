/**
 * StayOps — hourly scheduled review scan, end to end against a mocked network.
 *
 * One Gmail-connected host, three "review" emails in the mailbox: a published
 * review (captured), a "wrote you a review" (no text, skipped without Claude)
 * and one already processed (never fetched). Asserts the review row, that
 * Claude is called exactly once, and that every new id is remembered in
 * email_connections.skipped_ids so no scan re-reads it. Also: a failed token
 * refresh is reported and does not abort the run.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { installFetchMock, resetAll } = require('./_mocks.js');

const FN = path.join(__dirname, '..', 'Netlify', 'functions', 'scheduled-review-scan.js');
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
function loadFn() {
  delete require.cache[require.resolve(SHARED)];
  delete require.cache[require.resolve(FN)];
  return require(FN);
}

const ENV = {
  SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_KEY: 'service-key', ANTHROPIC_API_KEY: 'anthropic-key',
  GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret',
};
function withEnv(fn) {
  const saved = {};
  for (const k of Object.keys(ENV)) { saved[k] = process.env[k]; process.env[k] = ENV[k]; }
  return fn().finally(() => { for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
}

const REVIEW_BODY = [
  'EURANIE RATED THEIR STAY 5 STARS!',
  'FEEDBACK FROM THEIR STAY',
  '   Glenhaven - A Quintessential Katoomba Cottage',
  '   Oct 21 – 22, 2026',
  'OVERALL RATING 5',
  'Une maison au top, idéal pour une famille ! Je recommande 😊 Michel a été très disponible et réactif lors d + More',
  'NOTE FROM EURANIE',
  'Michel, merci encore !',
  'SPECIAL THANKS',
].join('\n');
const HIDDEN_BODY = "Airbnb Find out what Samuel wrote. You can read Samuel's review after you write one for them. Write a review. Instagram TikTok YouTube.";

function gmailMessage(id, subject, bodyText) {
  return {
    id,
    payload: {
      mimeType: 'multipart/alternative',
      headers: [{ name: 'Subject', value: subject }, { name: 'From', value: 'Airbnb <automated@airbnb.com>' }],
      parts: [{ mimeType: 'text/plain', body: { data: Buffer.from(bodyText, 'utf8').toString('base64url') } }],
    },
  };
}

const CLAUDE_JSON = {
  is_review: true, guestFirstName: 'Euranie', rating: 5,
  reviewText: 'Une maison au top, idéal pour une famille ! Je recommande 😊 Michel a été très disponible et réactif lors d + More',
  isTruncated: true, stayPeriod: 'October 2026', listingTitle: 'Glenhaven - A Quintessential Katoomba Cottage', language: 'fr',
};

function buildNetwork({ tokenOk = true } = {}) {
  const calls = [];
  const ok = (body, status = 200) => ({ ok: status < 400, status, async json() { return body; }, async text() { return JSON.stringify(body); } });
  const fetchMock = async (url, init) => {
    const u = String(url); const method = (init && init.method) || 'GET';
    const body = init && init.body && typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : (init && init.body) || null;
    calls.push({ url: u, method, body });

    if (u.includes('/rest/v1/email_connections?refresh_token=not.is.null')) {
      return ok([{ user_id: 'user-1', provider: 'google', email: 'host@gmail.test', refresh_token: 'rt', skipped_ids: '["old1"]' }]);
    }
    if (u.startsWith('https://oauth2.googleapis.com/token')) return tokenOk ? ok({ access_token: 'at' }) : ok({ error: 'invalid_grant' }, 400);
    if (u.includes('/rest/v1/properties?user_id=eq.user-1')) {
      return ok([{ id: 'prop-glenhaven', name: 'Glenhaven', mgmt_fee_rate: 10 }]);
    }
    if (u.includes('/rest/v1/bookings?user_id=eq.user-1')) return ok([{ gmail_message_id: 'b1' }]);
    if (u.startsWith('https://www.googleapis.com/gmail/v1/users/me/messages?q=')) {
      return ok({ messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'old1' }, { id: 'b1' }] });
    }
    if (u.includes('/gmail/v1/users/me/messages/m1?')) return ok(gmailMessage('m1', 'Euranie left a 5-star review!', REVIEW_BODY));
    if (u.includes('/gmail/v1/users/me/messages/m2?')) return ok(gmailMessage('m2', 'Samuel wrote you a review', HIDDEN_BODY));
    if (u.includes('/gmail/v1/users/me/messages/old1?') || u.includes('/gmail/v1/users/me/messages/b1?')) throw new Error('processed message must not be fetched: ' + u);
    if (u.startsWith('https://api.anthropic.com/v1/messages')) return ok({ content: [{ text: JSON.stringify(CLAUDE_JSON) }] });
    if (u.includes('/rest/v1/reviews') && method === 'GET') return ok([]);
    if (u.includes('/rest/v1/reviews') && method === 'POST') return ok([{ id: 'rev-1', ...body }], 201);
    if (u.includes('/rest/v1/email_connections?user_id=eq.user-1&provider=eq.google') && method === 'PATCH') return ok(null, 204);
    throw new Error('unexpected fetch: ' + method + ' ' + u);
  };
  return { fetchMock, calls };
}

test('scheduled review scan: captures the published review, skips the hidden one, remembers both, never refetches processed ids', async () => {
  installModuleStubs();
  const net = buildNetwork();
  installFetchMock(net.fetchMock);
  try {
    await withEnv(async () => {
      const { runReviewScan } = loadFn();
      const res = await runReviewScan();
      assert.equal(res.statusCode, 200);
      const out = JSON.parse(res.body);
      assert.equal(out.accounts, 1);
      assert.equal(out.reviews, 1);
      assert.equal(out.errors, 0);
      assert.match(out.message, /1 review captured as pending/);

      const claude = net.calls.filter(c => c.url.startsWith('https://api.anthropic.com'));
      assert.equal(claude.length, 1, 'only the published review goes to Claude');

      const inserts = net.calls.filter(c => c.url.includes('/rest/v1/reviews') && c.method === 'POST');
      assert.equal(inserts.length, 1);
      assert.equal(inserts[0].body.status, 'pending');
      assert.equal(inserts[0].body.platform, 'airbnb');
      assert.equal(inserts[0].body.property_id, 'prop-glenhaven');
      assert.equal(inserts[0].body.guest_name, 'Euranie');
      assert.ok(inserts[0].body.review_text.endsWith('…'));
      assert.ok(!/merci encore/.test(inserts[0].body.review_text), 'private note never stored');

      const patch = net.calls.find(c => c.method === 'PATCH' && c.url.includes('provider=eq.google'));
      assert.ok(patch, 'skipped_ids persisted');
      const remembered = JSON.parse(patch.body.skipped_ids);
      assert.ok(remembered.includes('old1') && remembered.includes('m1') && remembered.includes('m2'));
    });
  } finally { resetAll(); restoreModuleStubs(); }
});

test('scheduled review scan: a failed Gmail token refresh is reported and does not throw', async () => {
  installModuleStubs();
  const net = buildNetwork({ tokenOk: false });
  installFetchMock(net.fetchMock);
  try {
    await withEnv(async () => {
      const { runReviewScan } = loadFn();
      const out = JSON.parse((await runReviewScan()).body);
      assert.equal(out.accounts, 1);
      assert.equal(out.reviews, 0);
      assert.equal(out.errors, 1);
      assert.match(out.details[0].reason, /reconnect Gmail/);
      assert.equal(net.calls.filter(c => c.url.includes('gmail/v1')).length, 0, 'no Gmail calls without a token');
    });
  } finally { resetAll(); restoreModuleStubs(); }
});

test('scheduled review scan: refuses to run when misconfigured', async () => {
  installModuleStubs();
  try {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { runReviewScan } = loadFn();
      const res = await runReviewScan();
      assert.equal(res.statusCode, 500);
    } finally { if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; }
  } finally { restoreModuleStubs(); }
});
