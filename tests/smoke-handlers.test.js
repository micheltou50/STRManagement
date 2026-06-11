/**
 * StayOps — Tier A handler-shape smoke tests.
 *
 * Loads each Netlify function in-process and exercises only the cheap,
 * deterministic negative paths (OPTIONS, wrong method, missing required
 * fields, missing auth, wrong cron secret). Never touches Supabase or the
 * network. Catches dropped exports, broken requires, and regressions in the
 * pre-handler validation layer.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const FN_DIR = path.join(__dirname, '..', 'Netlify', 'functions');

function load(name) {
  // Fresh require each call so env-var changes between tests are visible.
  const p = require.resolve(path.join(FN_DIR, name + '.js'));
  delete require.cache[p];
  return require(p);
}

function event(opts = {}) {
  return {
    httpMethod: opts.httpMethod || 'POST',
    headers: opts.headers || {},
    queryStringParameters: opts.queryStringParameters || {},
    body: opts.body || '',
  };
}

// ── ai-proxy ─────────────────────────────────────────────────────────────────
test('ai-proxy: OPTIONS → 200', async () => {
  const { handler } = load('ai-proxy');
  const r = await handler(event({ httpMethod: 'OPTIONS' }));
  assert.equal(r.statusCode, 200);
});

test('ai-proxy: GET → 405', async () => {
  const { handler } = load('ai-proxy');
  const r = await handler(event({ httpMethod: 'GET' }));
  assert.equal(r.statusCode, 405);
});

test('ai-proxy: missing auth → 401 (with envs set)', async () => {
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_KEY;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'test-key';
  try {
    const { handler } = load('ai-proxy');
    const r = await handler(event({ httpMethod: 'POST', body: '{}' }));
    assert.equal(r.statusCode, 401);
  } finally {
    if (prevUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_KEY; else process.env.SUPABASE_SERVICE_KEY = prevKey;
  }
});

// ── calendar-feed ────────────────────────────────────────────────────────────
test('calendar-feed: missing uid → 401', async () => {
  const { handler } = load('calendar-feed');
  const r = await handler(event({ httpMethod: 'GET' }));
  assert.equal(r.statusCode, 401);
});

test('calendar-feed: short uid → 401', async () => {
  const { handler } = load('calendar-feed');
  const r = await handler(event({ httpMethod: 'GET', queryStringParameters: { uid: 'abc' } }));
  assert.equal(r.statusCode, 401);
});

// ── cleaner-action ───────────────────────────────────────────────────────────
test('cleaner-action: OPTIONS → 204', async () => {
  const { handler } = load('cleaner-action');
  const r = await handler(event({ httpMethod: 'OPTIONS' }));
  assert.equal(r.statusCode, 204);
});

test('cleaner-action: GET → 405', async () => {
  const { handler } = load('cleaner-action');
  const r = await handler(event({ httpMethod: 'GET' }));
  assert.equal(r.statusCode, 405);
});

test('cleaner-action: bad JSON → 400', async () => {
  const { handler } = load('cleaner-action');
  const r = await handler(event({ httpMethod: 'POST', body: 'not-json' }));
  assert.equal(r.statusCode, 400);
});

// ── cleaner-data ─────────────────────────────────────────────────────────────
test('cleaner-data: missing params → 400', async () => {
  const { handler } = load('cleaner-data');
  const r = await handler(event({ httpMethod: 'GET' }));
  assert.equal(r.statusCode, 400);
});

// ── cleaner-message ──────────────────────────────────────────────────────────
test('cleaner-message: OPTIONS → 204', async () => {
  const { handler } = load('cleaner-message');
  const r = await handler(event({ httpMethod: 'OPTIONS' }));
  assert.equal(r.statusCode, 204);
});

test('cleaner-message: GET → 405', async () => {
  const { handler } = load('cleaner-message');
  const r = await handler(event({ httpMethod: 'GET' }));
  assert.equal(r.statusCode, 405);
});

// ── ical-sync ────────────────────────────────────────────────────────────────
test('ical-sync: OPTIONS → 200', async () => {
  const { handler } = load('ical-sync');
  const r = await handler(event({ httpMethod: 'OPTIONS' }));
  assert.equal(r.statusCode, 200);
});

test('ical-sync: GET → 405', async () => {
  const { handler } = load('ical-sync');
  const r = await handler(event({ httpMethod: 'GET' }));
  assert.equal(r.statusCode, 405);
});

test('ical-sync: bad JSON → 400', async () => {
  const { handler } = load('ical-sync');
  const r = await handler(event({ httpMethod: 'POST', body: 'not-json' }));
  assert.equal(r.statusCode, 400);
});

test('ical-sync: uid without auth → 401 (with envs set)', async () => {
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_KEY;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'test-key';
  try {
    const { handler } = load('ical-sync');
    const r = await handler(event({ httpMethod: 'POST', body: JSON.stringify({ uid: 'some-user' }) }));
    assert.equal(r.statusCode, 401);
  } finally {
    if (prevUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_KEY; else process.env.SUPABASE_SERVICE_KEY = prevKey;
  }
});

// ── daily-notifications ──────────────────────────────────────────────────────
test('daily-notifications: PUT → 405', async () => {
  const { handler } = load('daily-notifications');
  const r = await handler(event({ httpMethod: 'PUT' }));
  assert.equal(r.statusCode, 405);
});

test('daily-notifications: missing cron secret with CRON_SECRET set → 401', async () => {
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'test-secret';
  try {
    const { handler } = load('daily-notifications');
    const r = await handler(event({ httpMethod: 'GET' }));
    assert.equal(r.statusCode, 401);
  } finally {
    if (prev === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prev;
  }
});

test('daily-notifications: wrong cron secret → 401', async () => {
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'test-secret';
  try {
    const { handler } = load('daily-notifications');
    const r = await handler(event({ httpMethod: 'GET', headers: { 'x-cron-secret': 'wrong' } }));
    assert.equal(r.statusCode, 401);
  } finally {
    if (prev === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prev;
  }
});

// ── fetch-listing ────────────────────────────────────────────────────────────
test('fetch-listing: missing auth → 401 (with envs set)', async () => {
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_KEY;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'test-key';
  try {
    const { handler } = load('fetch-listing');
    const r = await handler(event({ httpMethod: 'POST', body: '{}' }));
    assert.equal(r.statusCode, 401);
  } finally {
    if (prevUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_KEY; else process.env.SUPABASE_SERVICE_KEY = prevKey;
  }
});

// ── generate-pricing-suggestions ─────────────────────────────────────────────
test('generate-pricing-suggestions: OPTIONS → 200', async () => {
  const { handler } = load('generate-pricing-suggestions');
  const r = await handler(event({ httpMethod: 'OPTIONS' }));
  assert.equal(r.statusCode, 200);
});

test('generate-pricing-suggestions: GET → 405', async () => {
  const { handler } = load('generate-pricing-suggestions');
  const r = await handler(event({ httpMethod: 'GET' }));
  assert.equal(r.statusCode, 405);
});

// ── gmail-oauth-callback ─────────────────────────────────────────────────────
test('gmail-oauth-callback: missing code/state → 302 with oauth_error', async () => {
  const { handler } = load('gmail-oauth-callback');
  const r = await handler(event({ httpMethod: 'GET' }));
  assert.equal(r.statusCode, 302);
  assert.match(r.headers.Location, /oauth_error=missing_code_or_state/);
});

// ── gmail-oauth-start ────────────────────────────────────────────────────────
test('gmail-oauth-start: missing state → 400', async () => {
  const { handler } = load('gmail-oauth-start');
  const r = await handler(event({ httpMethod: 'GET' }));
  assert.equal(r.statusCode, 400);
});

// ── gmail-scan-bookings ──────────────────────────────────────────────────────
test('gmail-scan-bookings: missing auth → 401 (with envs set)', async () => {
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_KEY;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'test-key';
  try {
    const { handler } = load('gmail-scan-bookings');
    const r = await handler(event({ httpMethod: 'GET' }));
    assert.equal(r.statusCode, 401);
  } finally {
    if (prevUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_KEY; else process.env.SUPABASE_SERVICE_KEY = prevKey;
  }
});

// ── monthly-revenue-summary ──────────────────────────────────────────────────
test('monthly-revenue-summary: PUT → 405', async () => {
  const { handler } = load('monthly-revenue-summary');
  const r = await handler(event({ httpMethod: 'PUT' }));
  assert.equal(r.statusCode, 405);
});

test('monthly-revenue-summary: wrong cron secret → 401', async () => {
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'test-secret';
  try {
    const { handler } = load('monthly-revenue-summary');
    const r = await handler(event({ httpMethod: 'GET', headers: { 'x-cron-secret': 'wrong' } }));
    assert.equal(r.statusCode, 401);
  } finally {
    if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev;
  }
});

// ── outlook-oauth-callback ───────────────────────────────────────────────────
test('outlook-oauth-callback: missing code → 400', async () => {
  const { handler } = load('outlook-oauth-callback');
  const r = await handler(event({ httpMethod: 'GET' }));
  assert.equal(r.statusCode, 400);
});

// ── outlook-oauth-start ──────────────────────────────────────────────────────
test('outlook-oauth-start: with no env vars → 500 misconfigured', async () => {
  const prev = process.env.MICROSOFT_CLIENT_ID;
  delete process.env.MICROSOFT_CLIENT_ID;
  try {
    const { handler } = load('outlook-oauth-start');
    const r = await handler(event({ httpMethod: 'GET' }));
    assert.equal(r.statusCode, 500);
  } finally {
    if (prev !== undefined) process.env.MICROSOFT_CLIENT_ID = prev;
  }
});

// ── outlook-scan-bookings ────────────────────────────────────────────────────
test('outlook-scan-bookings: missing auth → 401 (with envs set)', async () => {
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_KEY;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'test-key';
  try {
    const { handler } = load('outlook-scan-bookings');
    const r = await handler(event({ httpMethod: 'GET' }));
    assert.equal(r.statusCode, 401);
  } finally {
    if (prevUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_KEY; else process.env.SUPABASE_SERVICE_KEY = prevKey;
  }
});

// ── send-email ───────────────────────────────────────────────────────────────
test('send-email: OPTIONS → 200', async () => {
  const { handler } = load('send-email');
  const r = await handler(event({ httpMethod: 'OPTIONS' }));
  assert.equal(r.statusCode, 200);
});

test('send-email: GET → 405', async () => {
  const { handler } = load('send-email');
  const r = await handler(event({ httpMethod: 'GET' }));
  assert.equal(r.statusCode, 405);
});

test('send-email: missing auth → 401 (with envs set)', async () => {
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_KEY;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'test-key';
  try {
    const { handler } = load('send-email');
    const r = await handler(event({ httpMethod: 'POST', body: '{}' }));
    assert.equal(r.statusCode, 401);
  } finally {
    if (prevUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_KEY; else process.env.SUPABASE_SERVICE_KEY = prevKey;
  }
});

// ── send-push ────────────────────────────────────────────────────────────────
test('send-push: OPTIONS → 200', async () => {
  const { handler } = load('send-push');
  const r = await handler(event({ httpMethod: 'OPTIONS' }));
  assert.equal(r.statusCode, 200);
});

test('send-push: GET → 405', async () => {
  const { handler } = load('send-push');
  const r = await handler(event({ httpMethod: 'GET' }));
  assert.equal(r.statusCode, 405);
});

test('send-push: missing auth → 401 (with envs set)', async () => {
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_KEY;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'test-key';
  try {
    const { handler } = load('send-push');
    const r = await handler(event({ httpMethod: 'POST', body: '{}' }));
    assert.equal(r.statusCode, 401);
  } finally {
    if (prevUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_KEY; else process.env.SUPABASE_SERVICE_KEY = prevKey;
  }
});
