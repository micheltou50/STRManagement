/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Calendar Push (outbound: app → provider)

   POST { uid, table, id, op }
     uid   — user id
     table — 'bookings' | 'cleans' | 'maintenance'
     id    — local row id (number/string used in local_id)
     op    — 'upsert' | 'delete'

   Pushes the change to every connected calendar provider for that user.
   Records the resulting provider_event_id + etag in calendar_sync_state so
   the inbound webhook can de-echo.
   ═══════════════════════════════════════════════════════════════════════════ */

const { verifyAuth } = require('./utils/auth');
const { getFreshAccessToken, sbHeaders } = require('./utils/calendar-token');
const gcal = require('./utils/gcal-client');
const mapper = require('./utils/calendar-mapper');

function json(status, body) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
    body: JSON.stringify(body),
  };
}

const PROVIDERS = ['google_calendar']; // PR 2 adds 'outlook_calendar'

async function loadLocalRow(userId, table, localId) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const headers = sbHeaders();
  const url = SUPABASE_URL + '/rest/v1/' + table +
    '?user_id=eq.' + encodeURIComponent(userId) +
    '&local_id=eq.' + encodeURIComponent(String(localId)) +
    '&select=*&limit=1';
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error('load row failed: ' + res.status);
  const rows = await res.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function loadSyncState(userId, provider, table, localId) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const url = SUPABASE_URL + '/rest/v1/calendar_sync_state' +
    '?user_id=eq.' + encodeURIComponent(userId) +
    '&provider=eq.' + encodeURIComponent(provider) +
    '&local_table=eq.' + encodeURIComponent(table) +
    '&local_id=eq.' + encodeURIComponent(String(localId)) +
    '&select=*&limit=1';
  const res = await fetch(url, { headers: sbHeaders() });
  const rows = await res.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function upsertSyncState(row) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  await fetch(SUPABASE_URL + '/rest/v1/calendar_sync_state', {
    method: 'POST',
    headers: { ...sbHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
}

async function deleteSyncState(userId, provider, table, localId) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  await fetch(SUPABASE_URL + '/rest/v1/calendar_sync_state' +
    '?user_id=eq.' + encodeURIComponent(userId) +
    '&provider=eq.' + encodeURIComponent(provider) +
    '&local_table=eq.' + encodeURIComponent(table) +
    '&local_id=eq.' + encodeURIComponent(String(localId)),
    { method: 'DELETE', headers: { ...sbHeaders(), Prefer: 'return=minimal' } });
}

async function loadPropertyName(userId, propertyId) {
  if (!propertyId) return '';
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const url = SUPABASE_URL + '/rest/v1/properties' +
    '?id=eq.' + encodeURIComponent(propertyId) +
    '&user_id=eq.' + encodeURIComponent(userId) +
    '&select=name&limit=1';
  try {
    const res = await fetch(url, { headers: sbHeaders() });
    const rows = await res.json();
    return (Array.isArray(rows) && rows[0] && rows[0].name) || '';
  } catch (_) { return ''; }
}

function rowToEvent(table, row, propertyName) {
  if (table === 'bookings')    return mapper.bookingToEvent(row);
  if (table === 'cleans')      return mapper.cleanToEvent(row, propertyName);
  if (table === 'maintenance') return mapper.maintenanceToEvent(row);
  return null;
}

function shouldSkip(table, row) {
  // Skip stub iCal bookings until enriched — they'd just clutter the calendar.
  if (table === 'bookings' && row && row.enrichment_status === 'pending') return true;
  if (table === 'bookings' && row && row.status === 'cancelled') return false; // we want delete to propagate
  return false;
}

async function pushToGoogle(userId, table, localId, op) {
  const { accessToken, connection } = await getFreshAccessToken(userId, 'google_calendar');
  if (!connection.calendar_id) throw new Error('No StayOps calendar id stored');
  const calendarId = connection.calendar_id;

  const state = await loadSyncState(userId, 'google_calendar', table, localId);

  if (op === 'delete') {
    if (state && state.provider_event_id) {
      await gcal.deleteEvent(accessToken, calendarId, state.provider_event_id, state.provider_etag);
      await deleteSyncState(userId, 'google_calendar', table, localId);
    }
    return { op: 'delete' };
  }

  const row = await loadLocalRow(userId, table, localId);
  if (!row) return { op: 'skip', reason: 'row not found' };
  if (shouldSkip(table, row)) return { op: 'skip', reason: 'pending enrichment' };

  // Soft-cancelled bookings → delete the calendar event
  if (table === 'bookings' && row.status === 'cancelled') {
    if (state && state.provider_event_id) {
      await gcal.deleteEvent(accessToken, calendarId, state.provider_event_id, state.provider_etag);
      await deleteSyncState(userId, 'google_calendar', table, localId);
    }
    return { op: 'delete' };
  }

  const propertyName = await loadPropertyName(userId, row.property_id);
  const event = rowToEvent(table, row, propertyName);
  if (!event || !event.start || (!event.start.date && !event.start.dateTime)) {
    return { op: 'skip', reason: 'no start date' };
  }

  let result;
  if (state && state.provider_event_id) {
    try {
      result = await gcal.patchEvent(accessToken, calendarId, state.provider_event_id, state.provider_etag, event);
    } catch (e) {
      // 404 → event was deleted on phone; recreate.
      // 412 (precondition) → etag stale; refetch & retry without etag.
      if (e.statusCode === 404) {
        result = await gcal.insertEvent(accessToken, calendarId, event);
      } else if (e.statusCode === 412) {
        result = await gcal.patchEvent(accessToken, calendarId, state.provider_event_id, null, event);
      } else {
        throw e;
      }
    }
  } else {
    result = await gcal.insertEvent(accessToken, calendarId, event);
  }

  await upsertSyncState({
    user_id: userId,
    provider: 'google_calendar',
    local_table: table,
    local_id: String(localId),
    provider_event_id: result.id,
    provider_calendar_id: calendarId,
    provider_etag: result.etag || null,
    local_updated_at: row.updated_at || new Date().toISOString(),
    provider_updated_at: result.updated || new Date().toISOString(),
    last_synced_at: new Date().toISOString(),
    pending_direction: null,
  });

  return { op: state ? 'update' : 'insert', eventId: result.id };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, { ok: true });
  if (event.httpMethod !== 'POST')   return json(405, { error: 'Method not allowed' });

  const auth = await verifyAuth(event);
  if (auth.error) return auth.error;

  let body;
  try { body = event.body ? JSON.parse(event.body) : {}; }
  catch (_) { return json(400, { error: 'Invalid JSON' }); }

  const { table, id, op } = body || {};
  if (!table || !id || !op) return json(400, { error: 'Missing table/id/op' });
  if (!['bookings', 'cleans', 'maintenance'].includes(table)) return json(400, { error: 'Bad table' });
  if (!['upsert', 'delete'].includes(op)) return json(400, { error: 'Bad op' });

  const results = {};
  for (const provider of PROVIDERS) {
    try {
      // Skip providers the user hasn't connected.
      const probe = await fetch(process.env.SUPABASE_URL + '/rest/v1/email_connections' +
        '?user_id=eq.' + encodeURIComponent(auth.id) +
        '&provider=eq.' + encodeURIComponent(provider) +
        '&select=user_id&limit=1',
        { headers: sbHeaders() });
      const rows = await probe.json();
      if (!Array.isArray(rows) || !rows[0]) { results[provider] = { skipped: 'not connected' }; continue; }

      if (provider === 'google_calendar') {
        results[provider] = await pushToGoogle(auth.id, table, id, op);
      }
    } catch (e) {
      console.warn('[calendar-push]', provider, 'failed:', e.message);
      results[provider] = { error: e.message };
      // Mark pending so reconciler retries.
      try {
        await upsertSyncState({
          user_id: auth.id,
          provider,
          local_table: table,
          local_id: String(id),
          provider_event_id: 'pending-' + id,
          provider_calendar_id: '',
          pending_direction: 'to_provider',
          last_synced_at: new Date().toISOString(),
        });
      } catch (_) { /* best-effort */ }
    }
  }

  return json(200, { ok: true, results });
};
