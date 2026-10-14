'use strict';
/**
 * StayOps — inbound calendar deletion rules + service-auth regression tests.
 *
 * Background (14 Oct 2026): a live Airbnb booking (Annie Parker, Glenhaven)
 * was soft-cancelled in StayOps because its mirrored Google Calendar event was
 * deleted on a phone. The reconciler treated any deletion as a cancellation,
 * told nobody, wrote no log, and dropped the link so a restored event would
 * have become a duplicate booking. These tests lock in the new rules:
 *
 *   1. Platform booking (gmail/outlook/ical) + event deleted → booking KEPT,
 *      link dropped, event re-created, host notified, sync log written.
 *   2. Manual booking + event deleted → booking cancelled (as before), host
 *      notified, sync log written.
 *   3. Manual booking whose stay has started → never auto-cancelled.
 *   4. Already-cancelled booking → nothing but link cleanup.
 *   5. Local row gone → nothing but link cleanup.
 *   6. Event carrying our marker for a row with no mapping → re-linked, never
 *      inserted as a duplicate; a manual booking cancelled by a deletion is
 *      revived; a genuinely cancelled platform booking is not.
 *   7. verifyAuthOrService accepts service-key + uid (scheduled scanner) and
 *      still rejects everything a user JWT would reject.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { installFetchMock, installModuleMocks, makeFakeSupabase, resetAll } = require('./_mocks.js');

const UTILS = path.join(__dirname, '..', 'Netlify', 'functions', 'utils');
const DELETION = path.join(UTILS, 'calendar-deletion.js');
const AUTH = path.join(UTILS, 'auth.js');

const USER = '11111111-1111-4111-8111-111111111111';
const SB = 'https://sb.test';

// ── module stubs for heavy deps pulled in by push-helper ────────────────────
const _origLoad = Module._load;
const STUBS = {
  'web-push': { setVapidDetails() {}, async sendNotification() { return { statusCode: 201 }; } },
};
function installModuleStubs() {
  Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
    return _origLoad.call(this, request, parent, isMain);
  };
}
function restoreModuleStubs() { Module._load = _origLoad; }

function fresh(p) {
  delete require.cache[require.resolve(p)];
  return require(p);
}

function ymd(offsetDays) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}

function booking(overrides = {}) {
  return {
    id: 'c4cb185b-31dd-48d5-8bed-a8de04a46506',
    local_id: 'gmail-1a109c0705fe005f',
    guest_name: 'Annie Parker',
    checkin: ymd(2),
    checkout: ymd(3),
    status: 'confirmed',
    source: 'gmail',
    ical_uid: null,
    confirmation_code: 'HMAQKENDH9',
    property_id: 'P1',
    platform: 'airbnb',
    host_payout: 900,
    guests: 2,
    enrichment_status: null,
    updated_at: new Date(Date.now() - 3600e3).toISOString(),
    ...overrides,
  };
}

/**
 * Routes Supabase REST + Google Calendar API calls and records every request.
 * `opts.booking`  — row returned for any GET /rest/v1/bookings (or [] if null)
 * `opts.mapping`  — row returned for GET calendar_sync_state by local_id
 */
function makeRouter(opts = {}) {
  const calls = [];
  const handler = async (url, init) => {
    const method = (init && init.method) || 'GET';
    let body = null;
    try { body = init && init.body ? JSON.parse(init.body) : null; } catch (_) { body = init && init.body; }
    calls.push({ method, url, body });
    const u = new URL(url);

    if (u.origin === SB) {
      const p = u.pathname;
      if (p === '/rest/v1/bookings' && method === 'GET') return { status: 200, body: opts.booking ? [opts.booking] : [] };
      if (p === '/rest/v1/bookings') return { status: 204, body: '' };
      if (p === '/rest/v1/calendar_sync_state' && method === 'GET') {
        return { status: 200, body: u.searchParams.get('local_id') && opts.mapping ? [opts.mapping] : [] };
      }
      if (p === '/rest/v1/calendar_sync_state') return { status: 204, body: '' };
      if (p === '/rest/v1/calendar_sync_log') return { status: 201, body: '' };
      if (p === '/rest/v1/email_connections' && method === 'GET') {
        return { status: 200, body: [{
          user_id: USER, provider: 'google_calendar', access_token: 'tok',
          token_expiry: new Date(Date.now() + 3600e3).toISOString(), calendar_id: 'CAL',
        }] };
      }
      if (p === '/rest/v1/email_connections') return { status: 204, body: '' };
      if (p === '/rest/v1/properties') return { status: 200, body: [{ id: 'P1', name: 'Glenhaven', user_id: USER }] };
      if (p === '/rest/v1/app_config') return { status: 200, body: [{ cancellation_window_days: null, cancellation_policy: null }] };
      if (p.startsWith('/auth/v1/admin/users')) return { status: 401, body: { error: 'nope' } };
      return { status: 404, body: '' };
    }

    if (u.origin === 'https://www.googleapis.com') {
      if (method === 'POST') return { status: 200, body: { id: 'EV-NEW', etag: '"e2"', updated: new Date().toISOString() } };
      if (method === 'PATCH') return { status: 200, body: { id: u.pathname.split('/').pop(), etag: '"e3"', updated: new Date().toISOString() } };
      if (method === 'DELETE') return { status: 204, body: '' };
      return { status: 404, body: '' };
    }
    return { status: 404, body: '' };
  };
  return { calls, handler };
}

function setup(opts = {}) {
  process.env.SUPABASE_URL = SB;
  process.env.SUPABASE_SERVICE_KEY = 'service-key';
  delete process.env.RESEND_API_KEY;
  installModuleStubs();
  const fake = makeFakeSupabase({
    tables: {
      properties: [{ id: 'P1', user_id: USER, name: 'Glenhaven' }],
      app_config: [{ user_id: USER, push_subscriptions: null, push_subs: null, notification_config: {}, native_push_tokens: [] }],
      notification_log: [],
    },
  });
  installModuleMocks({ supabase: fake });
  const router = makeRouter(opts);
  installFetchMock(router.handler);
  return { calls: router.calls, fake, mod: fresh(DELETION) };
}

function teardown() {
  resetAll();
  restoreModuleStubs();
}

const STATE = { user_id: USER, provider: 'google_calendar', local_table: 'bookings', local_id: 'gmail-1a109c0705fe005f', provider_event_id: 'EV1' };

const find = (calls, method, pathPart, pred) => calls.find(c =>
  c.method === method && c.url.includes(pathPart) && (!pred || pred(c)));

// ── 1. Platform booking: kept, re-pushed, host told ─────────────────────────
test('platform booking: calendar deletion keeps the booking and re-creates the event', async () => {
  const { calls, fake, mod } = setup({ booking: booking() });
  try {
    const r = await mod.handleBookingEventDeletion({ userId: USER, provider: 'google_calendar', state: STATE });
    assert.equal(r.op, 'restored');

    assert.equal(find(calls, 'PATCH', '/rest/v1/bookings', c => c.body && c.body.status === 'cancelled'), undefined, 'must not cancel');
    assert.ok(find(calls, 'DELETE', '/rest/v1/calendar_sync_state', c => c.url.includes('provider_event_id=eq.EV1')), 'stale link dropped');
    assert.ok(find(calls, 'POST', 'googleapis.com/calendar/v3/calendars/CAL/events'), 'event re-created in Google');
    assert.ok(find(calls, 'POST', '/rest/v1/calendar_sync_state', c => c.body.provider_event_id === 'EV-NEW' && c.body.local_id === 'gmail-1a109c0705fe005f'), 'new link written');
    assert.ok(find(calls, 'POST', '/rest/v1/calendar_sync_log', c => c.body.op === 'restore' && c.body.local_table === 'bookings'), 'audit row written');

    const notes = fake._store.notification_log;
    assert.equal(notes.length, 1);
    assert.equal(notes[0].type, 'calendar_event_restored');
    assert.match(notes[0].body, /Annie Parker/);
  } finally { teardown(); }
});

test('platform booking detected by ical_uid even when source is blank', async () => {
  const { calls, mod } = setup({ booking: booking({ source: null, ical_uid: 'abc@airbnb.com' }) });
  try {
    const r = await mod.handleBookingEventDeletion({ userId: USER, provider: 'google_calendar', state: STATE });
    assert.equal(r.op, 'restored');
    assert.equal(find(calls, 'PATCH', '/rest/v1/bookings', c => c.body && c.body.status === 'cancelled'), undefined);
  } finally { teardown(); }
});

// ── 2. Manual booking: cancelled, host told ─────────────────────────────────
test('manual booking: calendar deletion still soft-cancels, and now notifies + logs', async () => {
  const { calls, fake, mod } = setup({ booking: booking({ source: 'manual', confirmation_code: '', platform: 'direct' }) });
  try {
    const r = await mod.handleBookingEventDeletion({ userId: USER, provider: 'google_calendar', state: STATE });
    assert.equal(r.op, 'cancelled');

    const patch = find(calls, 'PATCH', '/rest/v1/bookings?id=eq.c4cb185b');
    assert.ok(patch, 'booking patched');
    assert.equal(patch.body.status, 'cancelled');
    assert.ok(patch.body.cancelled_at);
    assert.equal(patch.body.cancellation_billable, true, '2 days out is inside the fallback window');
    assert.equal(find(calls, 'POST', 'googleapis.com'), undefined, 'nothing pushed to Google');
    assert.ok(find(calls, 'DELETE', '/rest/v1/calendar_sync_state', c => c.url.includes('provider_event_id=eq.EV1')));
    assert.ok(find(calls, 'POST', '/rest/v1/calendar_sync_log', c => c.body.op === 'cancel'));
    assert.equal(fake._store.notification_log[0].type, 'cancellation');
  } finally { teardown(); }
});

// ── 3. Stay already started → never auto-cancelled ──────────────────────────
test('manual booking whose stay has started is not cancelled by a calendar deletion', async () => {
  const { calls, mod } = setup({ booking: booking({ source: 'manual', checkin: ymd(-1), checkout: ymd(1) }) });
  try {
    const r = await mod.handleBookingEventDeletion({ userId: USER, provider: 'google_calendar', state: STATE });
    assert.equal(r.op, 'skip');
    assert.equal(r.reason, 'past stay');
    assert.equal(find(calls, 'PATCH', '/rest/v1/bookings'), undefined);
    assert.ok(find(calls, 'DELETE', '/rest/v1/calendar_sync_state'));
  } finally { teardown(); }
});

// ── 4/5. Nothing to do cases ────────────────────────────────────────────────
test('already-cancelled booking: only the stale link is removed', async () => {
  const { calls, mod } = setup({ booking: booking({ status: 'cancelled' }) });
  try {
    const r = await mod.handleBookingEventDeletion({ userId: USER, provider: 'google_calendar', state: STATE });
    assert.equal(r.op, 'skip');
    assert.equal(find(calls, 'PATCH', '/rest/v1/bookings'), undefined);
    assert.equal(find(calls, 'POST', 'googleapis.com'), undefined);
    assert.ok(find(calls, 'DELETE', '/rest/v1/calendar_sync_state'));
  } finally { teardown(); }
});

test('local booking gone: only the stale link is removed', async () => {
  const { calls, mod } = setup({ booking: null });
  try {
    const r = await mod.handleBookingEventDeletion({ userId: USER, provider: 'google_calendar', state: STATE });
    assert.equal(r.op, 'skip');
    assert.equal(r.reason, 'local row gone');
    assert.equal(find(calls, 'PATCH', '/rest/v1/bookings'), undefined);
    assert.ok(find(calls, 'DELETE', '/rest/v1/calendar_sync_state'));
  } finally { teardown(); }
});

// ── 6. Re-link instead of duplicate ─────────────────────────────────────────
function relinkArgs(mod, existing, extra = {}) {
  const upserts = [];
  return {
    args: {
      userId: USER, provider: 'google_calendar', table: 'bookings',
      localId: existing ? existing.local_id : 'nope',
      ev: { id: 'EV1', etag: '"e1"', updated: new Date().toISOString(), summary: 'Annie Parker' },
      calendarId: 'CAL',
      loadLocalRowById: async (_u, _t, id) => (existing && id === existing.local_id ? existing : null),
      upsertSyncState: async (row) => { upserts.push(row); },
      ...extra,
    },
    upserts,
  };
}

test('relink: marked event for an existing confirmed booking re-links and patches the event, no duplicate row', async () => {
  const existing = booking();
  const { calls, mod } = setup({ booking: existing, mapping: { provider_event_id: 'EV1', provider_etag: '"e1"' } });
  try {
    const { args, upserts } = relinkArgs(mod, existing);
    const r = await mod.relinkMarkedEvent(args);
    assert.equal(r.op, 'relink');
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].local_id, existing.local_id);
    assert.equal(upserts[0].provider_event_id, 'EV1');
    assert.equal(find(calls, 'POST', '/rest/v1/bookings'), undefined, 'no duplicate booking inserted');
    assert.ok(find(calls, 'PATCH', 'googleapis.com/calendar/v3/calendars/CAL/events/EV1'), 'event brought in line with local data');
    assert.ok(find(calls, 'POST', '/rest/v1/calendar_sync_log', c => c.body.op === 'relink'));
  } finally { teardown(); }
});

test('relink: marker carrying the cloud UUID (as outbound events do) resolves the row too', async () => {
  const existing = booking();
  const { calls, mod } = setup({ booking: existing, mapping: { provider_event_id: 'EV1' } });
  try {
    const { args, upserts } = relinkArgs(mod, existing, { localId: existing.id, loadLocalRowById: async () => null });
    const r = await mod.relinkMarkedEvent(args);
    assert.equal(r.op, 'relink');
    assert.equal(upserts[0].local_id, existing.local_id);
    assert.ok(find(calls, 'GET', '/rest/v1/bookings', c => c.url.includes('id=eq.' + existing.id)));
  } finally { teardown(); }
});

test('relink: manual booking cancelled by a deletion is revived when its event comes back', async () => {
  const existing = booking({ source: 'manual', status: 'cancelled', cancelled_at: new Date().toISOString() });
  const { calls, mod } = setup({ booking: existing, mapping: { provider_event_id: 'EV1' } });
  try {
    const { args } = relinkArgs(mod, existing);
    const r = await mod.relinkMarkedEvent(args);
    assert.equal(r.op, 'relink_revive');
    const patch = find(calls, 'PATCH', '/rest/v1/bookings?id=eq.' + existing.id);
    assert.ok(patch);
    assert.equal(patch.body.status, 'confirmed');
    assert.equal(patch.body.cancelled_at, null);
    assert.equal(patch.body.cancellation_billable, null);
  } finally { teardown(); }
});

test('relink: a genuinely cancelled platform booking is NOT revived; its event is deleted again', async () => {
  const existing = booking({ status: 'cancelled' });
  const { calls, mod } = setup({ booking: existing, mapping: { provider_event_id: 'EV1' } });
  try {
    const { args } = relinkArgs(mod, existing);
    const r = await mod.relinkMarkedEvent(args);
    assert.equal(r.op, 'relink');
    assert.equal(find(calls, 'PATCH', '/rest/v1/bookings'), undefined, 'status untouched');
    assert.ok(find(calls, 'DELETE', 'googleapis.com/calendar/v3/calendars/CAL/events/EV1'), 'mirror removed again');
  } finally { teardown(); }
});

test('relink: returns null when no local row matches (caller falls through)', async () => {
  const { mod } = setup({ booking: null });
  try {
    const { args } = relinkArgs(mod, null);
    assert.equal(await mod.relinkMarkedEvent(args), null);
  } finally { teardown(); }
});

// ── 7. verifyAuthOrService ──────────────────────────────────────────────────
function authSetup() {
  process.env.SUPABASE_URL = SB;
  process.env.SUPABASE_SERVICE_KEY = 'service-key';
  installModuleMocks({ supabase: { auth: { async getUser() { return { data: null, error: { message: 'invalid JWT' } }; } } } });
  const router = makeRouter();
  installFetchMock(router.handler);
  return { calls: router.calls, auth: fresh(AUTH) };
}

function ev(headers, qs, body) {
  return { httpMethod: 'GET', headers: headers || {}, queryStringParameters: qs || {}, body: body || '' };
}

test('verifyAuthOrService: service key + uid → trusted server call', async () => {
  const { auth } = authSetup();
  try {
    const r = await auth.verifyAuthOrService(ev({ authorization: 'Bearer service-key' }, { uid: USER }));
    assert.equal(r.error, undefined);
    assert.equal(r.id, USER);
    assert.equal(r.service, true);
  } finally { resetAll(); }
});

test('verifyAuthOrService: service key via JSON body uid works too', async () => {
  const { auth } = authSetup();
  try {
    const r = await auth.verifyAuthOrService(ev({ Authorization: 'Bearer service-key' }, {}, JSON.stringify({ uid: USER })));
    assert.equal(r.id, USER);
  } finally { resetAll(); }
});

test('verifyAuthOrService: service key without uid → 401', async () => {
  const { auth } = authSetup();
  try {
    const r = await auth.verifyAuthOrService(ev({ authorization: 'Bearer service-key' }, {}));
    assert.equal(r.error.statusCode, 401);
  } finally { resetAll(); }
});

test('verifyAuthOrService: non-service token + uid → 401 (admin check rejected)', async () => {
  const { auth, calls } = authSetup();
  try {
    const r = await auth.verifyAuthOrService(ev({ authorization: 'Bearer not-the-key' }, { uid: USER }));
    assert.equal(r.error.statusCode, 401);
    assert.ok(find(calls, 'GET', '/auth/v1/admin/users'), 'asked Supabase whether the token is admin');
  } finally { resetAll(); }
});

test('verifyAuthOrService: service key + non-UUID uid → 400', async () => {
  const { auth } = authSetup();
  try {
    const r = await auth.verifyAuthOrService(ev({ authorization: 'Bearer service-key' }, { uid: 'bob' }));
    assert.equal(r.error.statusCode, 400);
  } finally { resetAll(); }
});

test('verifyAuthOrService: no token at all → 401', async () => {
  const { auth } = authSetup();
  try {
    const r = await auth.verifyAuthOrService(ev({}, { uid: USER }));
    assert.equal(r.error.statusCode, 401);
  } finally { resetAll(); }
});
