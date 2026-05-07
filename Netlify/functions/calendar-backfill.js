/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — One-time Calendar Backfill
   Pushes all existing confirmed bookings and pending cleans to connected
   calendar providers. Safe to run multiple times (uses upsert on sync state).

   POST { uid }   — backfill for a specific user
   ═══════════════════════════════════════════════════════════════════════════ */

const { getFreshAccessToken, sbHeaders } = require('./utils/calendar-token');
const gcal = require('./utils/gcal-client');
const ocal = require('./utils/outlook-cal-client');
const mapper = require('./utils/calendar-mapper');

const PROVIDERS = ['google_calendar', 'outlook_calendar'];

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}

const ADAPTERS = {
  google_calendar: {
    insert: (token, calId, ev) => gcal.insertEvent(token, calId, ev),
    extractMeta: (r) => ({ id: r.id, etag: r.etag || null, updated: r.updated || null }),
  },
  outlook_calendar: {
    insert: (token, calId, ev) => ocal.insertEvent(token, calId, ev),
    extractMeta: (r) => ({ id: r.id, etag: r['@odata.etag'] || null, updated: r.lastModifiedDateTime || null }),
  },
};

async function loadPropertyName(userId, propertyId) {
  if (!propertyId) return '';
  const url = process.env.SUPABASE_URL + '/rest/v1/properties' +
    '?id=eq.' + encodeURIComponent(propertyId) +
    '&user_id=eq.' + encodeURIComponent(userId) +
    '&select=name&limit=1';
  try {
    const res = await fetch(url, { headers: sbHeaders() });
    const rows = await res.json();
    return (Array.isArray(rows) && rows[0] && rows[0].name) || '';
  } catch (_) { return ''; }
}

async function loadSyncState(userId, provider, table, localId) {
  const url = process.env.SUPABASE_URL + '/rest/v1/calendar_sync_state' +
    '?user_id=eq.' + encodeURIComponent(userId) +
    '&provider=eq.' + encodeURIComponent(provider) +
    '&local_table=eq.' + encodeURIComponent(table) +
    '&local_id=eq.' + encodeURIComponent(String(localId)) +
    '&select=id&limit=1';
  const res = await fetch(url, { headers: sbHeaders() });
  const rows = await res.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function upsertSyncState(row) {
  await fetch(process.env.SUPABASE_URL + '/rest/v1/calendar_sync_state', {
    method: 'POST',
    headers: { ...sbHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' }, body: '' };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (_e) { return json(400, { error: 'Invalid JSON' }); }
  const uid = body.uid;
  if (!uid) return json(400, { error: 'Missing uid' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const results = { bookings: { pushed: 0, skipped: 0, errors: 0 }, cleans: { pushed: 0, skipped: 0, errors: 0 } };

  for (const provider of PROVIDERS) {
    let accessToken, connection;
    try {
      const fresh = await getFreshAccessToken(uid, provider);
      accessToken = fresh.accessToken;
      connection = fresh.connection;
    } catch (_) { continue; } // provider not connected
    if (!connection || !connection.calendar_id) continue;

    const adapter = ADAPTERS[provider];
    const calendarId = connection.calendar_id;

    // Backfill bookings
    try {
      const res = await fetch(SUPABASE_URL + '/rest/v1/bookings' +
        '?user_id=eq.' + encodeURIComponent(uid) +
        '&status=eq.confirmed&select=*', { headers: sbHeaders() });
      const bookings = await res.json();
      for (const b of (bookings || [])) {
        try {
          const existing = await loadSyncState(uid, provider, 'bookings', b.local_id);
          if (existing) { results.bookings.skipped++; continue; }
          const ev = mapper.bookingToEvent(b);
          if (!ev) { results.bookings.skipped++; continue; }
          const created = await adapter.insert(accessToken, calendarId, ev);
          const meta = adapter.extractMeta(created);
          await upsertSyncState({
            user_id: uid, provider, local_table: 'bookings', local_id: b.local_id,
            provider_event_id: meta.id, provider_calendar_id: calendarId,
            provider_etag: meta.etag, provider_updated_at: meta.updated,
            local_updated_at: b.updated_at || new Date().toISOString(),
            last_synced_at: new Date().toISOString(), pending_direction: null,
          });
          results.bookings.pushed++;
        } catch (e) {
          console.warn('[backfill] booking', b.local_id, 'failed:', e.message);
          results.bookings.errors++;
        }
      }
    } catch (e) {
      console.error('[backfill] bookings load failed:', e.message);
    }

    // Backfill cleans
    try {
      const res = await fetch(SUPABASE_URL + '/rest/v1/cleans' +
        '?user_id=eq.' + encodeURIComponent(uid) +
        '&done=eq.false&select=*', { headers: sbHeaders() });
      const cleans = await res.json();

      // Pre-load property names
      const propNames = {};
      for (const c of (cleans || [])) {
        if (c.property_id && !propNames[c.property_id]) {
          propNames[c.property_id] = await loadPropertyName(uid, c.property_id);
        }
      }

      for (const c of (cleans || [])) {
        try {
          const existing = await loadSyncState(uid, provider, 'cleans', c.local_id);
          if (existing) { results.cleans.skipped++; continue; }
          const ev = mapper.cleanToEvent(c, propNames[c.property_id] || '');
          if (!ev) { results.cleans.skipped++; continue; }
          const created = await adapter.insert(accessToken, calendarId, ev);
          const meta = adapter.extractMeta(created);
          await upsertSyncState({
            user_id: uid, provider, local_table: 'cleans', local_id: c.local_id,
            provider_event_id: meta.id, provider_calendar_id: calendarId,
            provider_etag: meta.etag, provider_updated_at: meta.updated,
            local_updated_at: c.updated_at || new Date().toISOString(),
            last_synced_at: new Date().toISOString(), pending_direction: null,
          });
          results.cleans.pushed++;
        } catch (e) {
          console.warn('[backfill] clean', c.local_id, 'failed:', e.message);
          results.cleans.errors++;
        }
      }
    } catch (e) {
      console.error('[backfill] cleans load failed:', e.message);
    }
  }

  return json(200, { ok: true, results });
};
