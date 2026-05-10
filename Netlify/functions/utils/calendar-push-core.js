/* ═══════════════════════════════════════════════════════════════════════════
   StayOps — Calendar Push Core

   Shared per-row push logic for outbound app→provider sync. Used by
   /calendar-push (frontend-triggered) and the server-side scanners
   (gmail-scan-bookings, outlook-scan-bookings, ical-sync) so any path that
   writes a booking can keep Google/Outlook calendars in lockstep.
   ═══════════════════════════════════════════════════════════════════════════ */

const { getFreshAccessToken, sbHeaders } = require('./calendar-token');
const gcal = require('./gcal-client');
const ocal = require('./outlook-cal-client');
const mapper = require('./calendar-mapper');

const PROVIDERS = ['google_calendar', 'outlook_calendar'];

const ADAPTERS = {
  google_calendar: {
    delete:  (token, calId, eventId, etag) => gcal.deleteEvent(token, calId, eventId, etag),
    insert:  (token, calId, ev)            => gcal.insertEvent(token, calId, ev),
    patch:   (token, calId, eventId, etag, ev) => gcal.patchEvent(token, calId, eventId, etag, ev),
    extractMeta: (r) => ({ id: r.id, etag: r.etag || null, updated: r.updated || null }),
  },
  outlook_calendar: {
    delete:  (token, _calId, eventId, etag) => ocal.deleteEvent(token, eventId, etag),
    insert:  (token, calId, ev)             => ocal.insertEvent(token, calId, ev),
    patch:   (token, _calId, eventId, etag, ev) => ocal.patchEvent(token, eventId, etag, ev),
    extractMeta: (r) => ({ id: r.id, etag: r['@odata.etag'] || null, updated: r.lastModifiedDateTime || null }),
  },
};

async function loadLocalRow(userId, table, localId) {
  const url = process.env.SUPABASE_URL + '/rest/v1/' + table +
    '?user_id=eq.' + encodeURIComponent(userId) +
    '&local_id=eq.' + encodeURIComponent(String(localId)) +
    '&select=*&limit=1';
  const res = await fetch(url, { headers: sbHeaders() });
  if (!res.ok) throw new Error('load row failed: ' + res.status);
  const rows = await res.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function loadSyncState(userId, provider, table, localId) {
  const url = process.env.SUPABASE_URL + '/rest/v1/calendar_sync_state' +
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
  await fetch(process.env.SUPABASE_URL + '/rest/v1/calendar_sync_state', {
    method: 'POST',
    headers: { ...sbHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
}

async function deleteSyncState(userId, provider, table, localId) {
  await fetch(process.env.SUPABASE_URL + '/rest/v1/calendar_sync_state' +
    '?user_id=eq.' + encodeURIComponent(userId) +
    '&provider=eq.' + encodeURIComponent(provider) +
    '&local_table=eq.' + encodeURIComponent(table) +
    '&local_id=eq.' + encodeURIComponent(String(localId)),
    { method: 'DELETE', headers: { ...sbHeaders(), Prefer: 'return=minimal' } });
}

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

async function isProviderConnected(userId, provider) {
  const url = process.env.SUPABASE_URL + '/rest/v1/email_connections' +
    '?user_id=eq.' + encodeURIComponent(userId) +
    '&provider=eq.' + encodeURIComponent(provider) +
    '&select=user_id&limit=1';
  const res = await fetch(url, { headers: sbHeaders() });
  const rows = await res.json();
  return Array.isArray(rows) && !!rows[0];
}

function rowToEvent(table, row, propertyName) {
  if (table === 'bookings')    return mapper.bookingToEvent(row);
  if (table === 'cleans')      return mapper.cleanToEvent(row, propertyName);
  if (table === 'maintenance') return mapper.maintenanceToEvent(row);
  return null;
}

function shouldSkip(table, row) {
  // iCal stubs (pending enrichment) clutter the calendar with "Reserved — awaiting details".
  // We push them once enriched.
  if (table === 'bookings' && row && row.enrichment_status === 'pending') return true;
  return false;
}

async function pushToProvider(userId, provider, table, localId, op) {
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new Error('Unknown provider: ' + provider);

  const { accessToken, connection } = await getFreshAccessToken(userId, provider);
  if (!connection.calendar_id) throw new Error('No StayOps calendar id stored for ' + provider);
  const calendarId = connection.calendar_id;

  const state = await loadSyncState(userId, provider, table, localId);

  if (op === 'delete') {
    if (state && state.provider_event_id) {
      await adapter.delete(accessToken, calendarId, state.provider_event_id, state.provider_etag);
      await deleteSyncState(userId, provider, table, localId);
    }
    return { op: 'delete' };
  }

  const row = await loadLocalRow(userId, table, localId);
  if (!row) return { op: 'skip', reason: 'row not found' };
  if (shouldSkip(table, row)) return { op: 'skip', reason: 'pending enrichment' };

  if (table === 'bookings' && row.status === 'cancelled') {
    if (state && state.provider_event_id) {
      await adapter.delete(accessToken, calendarId, state.provider_event_id, state.provider_etag);
      await deleteSyncState(userId, provider, table, localId);
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
      result = await adapter.patch(accessToken, calendarId, state.provider_event_id, state.provider_etag, event);
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        result = await adapter.insert(accessToken, calendarId, event);
      } else if (e.statusCode === 412) {
        result = await adapter.patch(accessToken, calendarId, state.provider_event_id, null, event);
      } else {
        throw e;
      }
    }
  } else {
    result = await adapter.insert(accessToken, calendarId, event);
  }

  const meta = adapter.extractMeta(result);
  await upsertSyncState({
    user_id: userId,
    provider,
    local_table: table,
    local_id: String(localId),
    provider_event_id: meta.id,
    provider_calendar_id: calendarId,
    provider_etag: meta.etag,
    local_updated_at: row.updated_at || new Date().toISOString(),
    provider_updated_at: meta.updated || new Date().toISOString(),
    last_synced_at: new Date().toISOString(),
    pending_direction: null,
  });

  return { op: state ? 'update' : 'insert', eventId: meta.id };
}

/**
 * Push a single change to every connected calendar provider.
 * Used by frontend-triggered /calendar-push and server-side scanners.
 *
 * Failures are caught per provider and recorded in calendar_sync_state with
 * pending_direction='to_provider' so calendar-sync-reconcile retries them.
 */
async function pushChange(userId, table, localId, op) {
  const results = {};
  for (const provider of PROVIDERS) {
    try {
      if (!(await isProviderConnected(userId, provider))) {
        results[provider] = { skipped: 'not connected' };
        continue;
      }
      results[provider] = await pushToProvider(userId, provider, table, localId, op);
    } catch (e) {
      console.warn('[calendar-push-core]', provider, table, localId, 'failed:', e.message);
      results[provider] = { error: e.message };
      try {
        await upsertSyncState({
          user_id: userId,
          provider,
          local_table: table,
          local_id: String(localId),
          provider_event_id: 'pending-' + localId,
          provider_calendar_id: '',
          pending_direction: 'to_provider',
          last_synced_at: new Date().toISOString(),
        });
      } catch (_) { /* best-effort */ }
    }
  }
  return results;
}

module.exports = { pushChange, pushToProvider, PROVIDERS };
