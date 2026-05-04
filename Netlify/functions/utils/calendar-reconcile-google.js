/**
 * StayOps — Google Calendar incremental reconciliation.
 *
 * Pulls changes from Google via events.list?syncToken=…, applies them to the
 * local tables, and stores the next syncToken. Used by both the webhook and
 * the scheduled poll function.
 */

const { getFreshAccessToken, sbHeaders, patchConnection } = require('./calendar-token');
const gcal = require('./gcal-client');
const mapper = require('./calendar-mapper');

async function rest(path, init) {
  const url = process.env.SUPABASE_URL + '/rest/v1' + path;
  const res = await fetch(url, { ...init, headers: { ...sbHeaders(), ...((init && init.headers) || {}) } });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '');
    throw new Error('REST ' + path + ' → ' + res.status + ': ' + text.slice(0, 200));
  }
  if (init && init.method && init.method !== 'GET') return null;
  return res.json();
}

async function loadSyncStateByEventId(userId, eventId) {
  const rows = await rest('/calendar_sync_state' +
    '?user_id=eq.' + encodeURIComponent(userId) +
    '&provider=eq.google_calendar' +
    '&provider_event_id=eq.' + encodeURIComponent(eventId) +
    '&select=*&limit=1');
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function loadLocalRowById(userId, table, localId) {
  const rows = await rest('/' + table +
    '?user_id=eq.' + encodeURIComponent(userId) +
    '&local_id=eq.' + encodeURIComponent(String(localId)) +
    '&select=*&limit=1');
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function upsertSyncState(row) {
  return rest('/calendar_sync_state', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
}

async function deleteSyncState(userId, eventId) {
  return rest('/calendar_sync_state' +
    '?user_id=eq.' + encodeURIComponent(userId) +
    '&provider=eq.google_calendar' +
    '&provider_event_id=eq.' + encodeURIComponent(eventId),
    { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
}

async function newLocalId() {
  return 'gcal-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

async function applyEventToLocal(userId, ev, classification, state) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const table = classification.table;
  const patch = mapper.eventToLocal(table, ev);
  if (!patch) return { op: 'skip', reason: 'unmappable' };

  const eventUpdated = ev.updated || new Date().toISOString();

  // Existing mapping → update local row if provider's update is newer (last-write-wins).
  if (state && state.local_id) {
    const local = await loadLocalRowById(userId, table, state.local_id);
    if (!local) {
      // Local row was deleted; remove the mapping and (best-effort) the calendar event.
      await deleteSyncState(userId, ev.id);
      return { op: 'skip', reason: 'local row gone' };
    }
    const localUpdated = local.updated_at ? new Date(local.updated_at).getTime() : 0;
    const remoteUpdated = new Date(eventUpdated).getTime();
    if (remoteUpdated <= localUpdated) {
      // App is newer or equal; no-op.
      return { op: 'skip', reason: 'local newer' };
    }
    await fetch(SUPABASE_URL + '/rest/v1/' + table +
      '?id=eq.' + encodeURIComponent(local.id), {
      method: 'PATCH',
      headers: { ...sbHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
    });
    await upsertSyncState({
      user_id: userId,
      provider: 'google_calendar',
      local_table: table,
      local_id: state.local_id,
      provider_event_id: ev.id,
      provider_calendar_id: state.provider_calendar_id,
      provider_etag: ev.etag || null,
      local_updated_at: new Date().toISOString(),
      provider_updated_at: eventUpdated,
      last_synced_at: new Date().toISOString(),
      pending_direction: null,
    });
    return { op: 'update' };
  }

  // No mapping yet → new event from phone.
  if (table === 'inbox') {
    // Park in calendar_sync_state for user to triage in the UI.
    await upsertSyncState({
      user_id: userId,
      provider: 'google_calendar',
      local_table: 'inbox',
      local_id: null,
      provider_event_id: ev.id,
      provider_calendar_id: (state && state.provider_calendar_id) || ev.organizer?.email || '',
      provider_etag: ev.etag || null,
      provider_updated_at: eventUpdated,
      last_synced_at: new Date().toISOString(),
      inbox_payload: ev,
    });
    return { op: 'inbox' };
  }

  // Auto-insert into the appropriate table.
  const localId = await newLocalId();
  let payload = { user_id: userId, local_id: localId, source: 'gcal', updated_at: new Date().toISOString(), ...patch };
  if (table === 'cleans') {
    payload = { ...payload, guest_name: '', cleaner: '', cleaner_id: '', done: false, cleaner_confirmed: false, cleaner_declined: false };
  } else if (table === 'bookings') {
    payload = { ...payload, status: 'confirmed', source: 'gcal', enrichment_status: 'manual', checkin: patch.checkin || null, checkout: patch.checkout || null };
  } else if (table === 'maintenance') {
    payload = { ...payload, status: 'open' };
  }
  const insRes = await fetch(process.env.SUPABASE_URL + '/rest/v1/' + table, {
    method: 'POST',
    headers: { ...sbHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify(payload),
  });
  if (!insRes.ok) {
    const text = await insRes.text().catch(() => '');
    throw new Error('insert into ' + table + ' failed: ' + insRes.status + ' ' + text.slice(0, 200));
  }
  const inserted = (await insRes.json())[0] || {};

  await upsertSyncState({
    user_id: userId,
    provider: 'google_calendar',
    local_table: table,
    local_id: localId,
    provider_event_id: ev.id,
    provider_calendar_id: (state && state.provider_calendar_id) || '',
    provider_etag: ev.etag || null,
    local_updated_at: inserted.updated_at || new Date().toISOString(),
    provider_updated_at: eventUpdated,
    last_synced_at: new Date().toISOString(),
    pending_direction: null,
  });
  return { op: 'insert_local' };
}

async function applyEventDeletion(userId, eventId) {
  const state = await loadSyncStateByEventId(userId, eventId);
  if (!state) return { op: 'skip', reason: 'no mapping' };

  if (state.local_table === 'inbox') {
    await deleteSyncState(userId, eventId);
    return { op: 'inbox_deleted' };
  }

  if (state.local_id) {
    if (state.local_table === 'bookings') {
      // Soft-cancel via existing pattern.
      await fetch(process.env.SUPABASE_URL + '/rest/v1/bookings' +
        '?user_id=eq.' + encodeURIComponent(userId) +
        '&local_id=eq.' + encodeURIComponent(state.local_id), {
        method: 'PATCH',
        headers: { ...sbHeaders(), Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'cancelled', updated_at: new Date().toISOString() }),
      });
    } else {
      await fetch(process.env.SUPABASE_URL + '/rest/v1/' + state.local_table +
        '?user_id=eq.' + encodeURIComponent(userId) +
        '&local_id=eq.' + encodeURIComponent(state.local_id), {
        method: 'DELETE',
        headers: { ...sbHeaders(), Prefer: 'return=minimal' },
      });
    }
  }
  await deleteSyncState(userId, eventId);
  return { op: 'deleted' };
}

async function reconcileGoogle(userId) {
  const { accessToken, connection } = await getFreshAccessToken(userId, 'google_calendar');
  if (!connection.calendar_id) return { skipped: 'no calendar_id' };

  let syncToken = connection.sync_token || null;
  let pageToken = null;
  let nextSyncToken = null;
  const totals = { applied: 0, skipped: 0, errors: 0, deleted: 0 };

  // If no syncToken, do a scoped initial fetch (last 60 days → next 365 days).
  const timeMin = new Date(Date.now() - 60 * 86400000).toISOString();
  const timeMax = new Date(Date.now() + 365 * 86400000).toISOString();

  for (let safety = 0; safety < 20; safety++) {
    let page;
    try {
      page = await gcal.listEvents(accessToken, connection.calendar_id, {
        syncToken, pageToken, timeMin, timeMax,
      });
    } catch (e) {
      if (e.statusCode === 410) {
        // Sync token invalidated → drop and full-sync next time.
        await patchConnection(userId, 'google_calendar', { sync_token: null });
        return { invalidated: true };
      }
      throw e;
    }

    for (const ev of (page.items || [])) {
      try {
        if (ev.status === 'cancelled') {
          await applyEventDeletion(userId, ev.id);
          totals.deleted++;
          continue;
        }
        const classification = mapper.classifyEvent(ev);
        const state = await loadSyncStateByEventId(userId, ev.id);

        // Echo guard: if our last push has the same etag/updated, skip.
        if (state && state.provider_updated_at && ev.updated &&
            new Date(state.provider_updated_at).getTime() >= new Date(ev.updated).getTime()) {
          totals.skipped++;
          continue;
        }

        const r = await applyEventToLocal(userId, ev, classification, state);
        if (r.op === 'skip') totals.skipped++;
        else totals.applied++;
      } catch (e) {
        totals.errors++;
        console.warn('[reconcile-google] event', ev.id, 'failed:', e.message);
      }
    }

    if (page.nextPageToken) {
      pageToken = page.nextPageToken;
      continue;
    }
    nextSyncToken = page.nextSyncToken || null;
    break;
  }

  if (nextSyncToken) {
    await patchConnection(userId, 'google_calendar', { sync_token: nextSyncToken });
  }
  return totals;
}

module.exports = { reconcileGoogle };
