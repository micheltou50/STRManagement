/**
 * StayOps — inbound calendar deletion handling (provider → app).
 *
 * Shared by the Google and Outlook reconcilers. Called when a provider reports
 * that an event we had linked to a local booking is gone (deleted, or moved to
 * another calendar, which providers report the same way).
 *
 * Rules (post-incident, 14 Oct 2026 — a live Airbnb booking was cancelled in
 * StayOps because its Google event was deleted on a phone):
 *
 *   1. Platform bookings (iCal / Gmail / Outlook sourced, or carrying an iCal
 *      UID) are owned by the platform. A calendar deletion is NOT a
 *      cancellation signal for them: the booking stays as is, the stale link
 *      is dropped, the event is re-pushed so the calendar mirrors StayOps
 *      again, and the host is told what happened.
 *   2. Manual / calendar-sourced bookings keep the original behaviour — a
 *      deletion in the calendar soft-cancels the booking — but the host is now
 *      notified, and stays that have already started are never auto-cancelled.
 *   3. Every decision is written to calendar_sync_log.
 */

const { createClient } = require('@supabase/supabase-js');
const { sbHeaders } = require('./calendar-token');
const { isCancellationBillable, loadCancellationConfig } = require('./cancellation-policy');
const { pushToProvider } = require('./calendar-push-core');
const { sendPushToHost, hasRecentNotification } = require('./push-helper');
const { logSync } = require('./calendar-sync-log');

const PLATFORM_SOURCES = new Set(['ical', 'gmail', 'outlook']);

const PROVIDER_LABEL = {
  google_calendar: 'Google Calendar',
  outlook_calendar: 'Outlook Calendar',
};

/** True when the platform (Airbnb, Booking.com, …) is the source of truth for this booking. */
function isPlatformBooking(booking) {
  if (!booking) return false;
  if (booking.ical_uid) return true;
  return PLATFORM_SOURCES.has(String(booking.source || '').toLowerCase());
}

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

function supabaseUrl() {
  return process.env.SUPABASE_URL;
}

async function loadBookingByLocalId(userId, localId) {
  const res = await fetch(supabaseUrl() + '/rest/v1/bookings' +
    '?user_id=eq.' + encodeURIComponent(userId) +
    '&local_id=eq.' + encodeURIComponent(String(localId)) +
    '&select=id,local_id,guest_name,checkin,checkout,status,source,ical_uid,confirmation_code,property_id,platform,host_payout,guests,enrichment_status,updated_at' +
    '&limit=1', { headers: sbHeaders() });
  if (!res.ok) throw new Error('bookings lookup failed: ' + res.status);
  const rows = await res.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadRowByCloudId(userId, table, id) {
  const res = await fetch(supabaseUrl() + '/rest/v1/' + encodeURIComponent(table) +
    '?user_id=eq.' + encodeURIComponent(userId) +
    '&id=eq.' + encodeURIComponent(String(id)) +
    '&select=*&limit=1', { headers: sbHeaders() });
  if (!res.ok) return null;
  const rows = await res.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function deleteSyncStateByEventId(userId, provider, eventId) {
  await fetch(supabaseUrl() + '/rest/v1/calendar_sync_state' +
    '?user_id=eq.' + encodeURIComponent(userId) +
    '&provider=eq.' + encodeURIComponent(provider) +
    '&provider_event_id=eq.' + encodeURIComponent(String(eventId)),
    { method: 'DELETE', headers: { ...sbHeaders(), Prefer: 'return=minimal' } });
}

async function patchBookingById(id, patch) {
  const res = await fetch(supabaseUrl() + '/rest/v1/bookings?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { ...sbHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
  return res.ok;
}

function makeAdminClient() {
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl() || !key) return null;
  try { return createClient(supabaseUrl(), key); } catch (_) { return null; }
}

/**
 * Push a short notice to the host. Deduped per (type, booking) within 30 min
 * via notification_log, like the email-scan notifications.
 */
async function notifyHost({ notifyType, booking, title, body }) {
  try {
    const supabaseAdmin = makeAdminClient();
    if (!supabaseAdmin || !booking || !booking.id || !booking.property_id) return;
    const recent = await hasRecentNotification({
      supabaseAdmin, type: notifyType, referenceId: booking.id, withinMinutes: 30,
    });
    if (recent) return;
    await sendPushToHost({
      supabaseAdmin,
      propertyId: booking.property_id,
      title,
      body,
      url: '/bookings',
      type: notifyType,
      referenceId: booking.id,
    });
  } catch (e) {
    console.warn('[calendar-deletion] host notification failed:', e && e.message);
  }
}

function describe(booking) {
  const g = String(booking.guest_name || 'Guest').trim();
  const ci = String(booking.checkin || '').slice(0, 10);
  const co = String(booking.checkout || '').slice(0, 10);
  return g + ' · ' + ci + ' to ' + co;
}

/**
 * Handle "linked booking event vanished from the provider".
 *
 * @param {object} args
 * @param {string} args.userId
 * @param {'google_calendar'|'outlook_calendar'} args.provider
 * @param {object} args.state   calendar_sync_state row (local_table='bookings')
 * @returns {Promise<{op: string, reason?: string}>}
 */
async function handleBookingEventDeletion({ userId, provider, state }) {
  const eventId = state && state.provider_event_id;
  const localId = state && state.local_id;
  const label = PROVIDER_LABEL[provider] || provider;
  const base = { userId, provider, direction: 'to_local', localTable: 'bookings', localId, providerEventId: eventId };

  const booking = await loadBookingByLocalId(userId, localId);

  if (!booking) {
    await deleteSyncStateByEventId(userId, provider, eventId);
    await logSync({ ...base, op: 'skip', message: 'event deleted in ' + label + '; local booking no longer exists' });
    return { op: 'skip', reason: 'local row gone' };
  }

  if (String(booking.status || '').toLowerCase() === 'cancelled') {
    await deleteSyncStateByEventId(userId, provider, eventId);
    await logSync({ ...base, op: 'skip', message: 'event deleted in ' + label + '; booking already cancelled' });
    return { op: 'skip', reason: 'already cancelled' };
  }

  // ── Platform booking: the calendar is a mirror, not an input ──────────────
  if (isPlatformBooking(booking)) {
    await deleteSyncStateByEventId(userId, provider, eventId);
    let restored = false;
    let pushErr = '';
    try {
      const r = await pushToProvider(userId, provider, 'bookings', booking.local_id, 'upsert');
      restored = !!(r && (r.op === 'insert' || r.op === 'update'));
    } catch (e) {
      pushErr = e && e.message ? e.message : String(e);
      console.warn('[calendar-deletion] re-push failed for', booking.local_id, ':', pushErr);
    }
    await logSync({
      ...base,
      op: restored ? 'restore' : 'error',
      message: 'event deleted in ' + label + ' for platform booking (' + (booking.source || 'platform') +
        ') — booking kept; ' + (restored ? 'event re-created' : 'event re-create failed: ' + pushErr),
    });
    await notifyHost({
      notifyType: 'calendar_event_restored',
      booking,
      title: '📅 Calendar event put back',
      body: describe(booking) + ' was deleted in ' + label + '. The booking is still live on ' +
        (booking.platform || 'the platform') + ', so StayOps kept it' + (restored ? ' and re-created the event.' : '.'),
    });
    return { op: restored ? 'restored' : 'kept', reason: 'platform booking' };
  }

  // ── Manual / calendar-sourced booking: deletion means cancel ─────────────
  if (booking.checkin && String(booking.checkin).slice(0, 10) < todayYmd()) {
    // Mirrors ical-sync: never auto-cancel a stay that has started or finished.
    await deleteSyncStateByEventId(userId, provider, eventId);
    await logSync({ ...base, op: 'skip', message: 'event deleted in ' + label + '; stay already started — not cancelled' });
    return { op: 'skip', reason: 'past stay' };
  }

  const cancelledAt = new Date().toISOString();
  const cancellationConfig = await loadCancellationConfig(supabaseUrl(), sbHeaders(), userId);
  const ok = await patchBookingById(booking.id, {
    status: 'cancelled',
    cancelled_at: cancelledAt,
    cancellation_billable: isCancellationBillable(booking, cancelledAt, cancellationConfig),
    updated_at: cancelledAt,
  });
  if (!ok) {
    await logSync({ ...base, op: 'error', message: 'event deleted in ' + label + '; cancel PATCH failed — mapping kept for retry' });
    return { op: 'error', reason: 'cancel patch failed' };
  }
  await deleteSyncStateByEventId(userId, provider, eventId);
  await logSync({ ...base, op: 'cancel', message: 'event deleted in ' + label + ' — manual booking soft-cancelled' });
  await notifyHost({
    notifyType: 'cancellation',
    booking,
    title: '❌ Cancelled from ' + label,
    body: describe(booking) + ' — its event was deleted in ' + label + ', so StayOps cancelled the booking.',
  });
  return { op: 'cancelled' };
}

/**
 * Re-link an inbound event that carries our own marker (stayops_table /
 * stayops_id) to a local row that still exists but has lost its mapping —
 * typically an event restored from the provider's bin. Without this the
 * reconciler inserts a duplicate row.
 *
 * Returns null when there is nothing to re-link (caller continues as normal).
 */
async function relinkMarkedEvent({ userId, provider, table, localId, ev, calendarId, loadLocalRowById, upsertSyncState }) {
  if (!localId) return null;
  // Outbound events carry the row's cloud UUID in stayops_id (calendar-mapper);
  // description markers may carry the local_id. Accept either.
  let existing = await loadLocalRowById(userId, table, localId);
  if (!existing && UUID_RE.test(String(localId))) existing = await loadRowByCloudId(userId, table, localId);
  if (!existing || !existing.local_id) return null;

  const eventUpdated = ev.updated || new Date().toISOString();
  let revived = false;

  if (table === 'bookings' &&
      String(existing.status || '').toLowerCase() === 'cancelled' &&
      !isPlatformBooking(existing) &&
      existing.checkin && String(existing.checkin).slice(0, 10) >= todayYmd()) {
    // A manual booking cancelled by a calendar deletion, whose event has now
    // been restored: undo the cancellation (symmetric with the deletion rule).
    revived = await patchBookingById(existing.id, {
      status: 'confirmed', cancelled_at: null, cancellation_billable: null, updated_at: new Date().toISOString(),
    });
  }

  await upsertSyncState({
    user_id: userId,
    provider,
    local_table: table,
    local_id: String(existing.local_id),
    provider_event_id: ev.id,
    provider_calendar_id: calendarId || '',
    provider_etag: ev.etag || null,
    local_updated_at: existing.updated_at || new Date().toISOString(),
    provider_updated_at: eventUpdated,
    last_synced_at: new Date().toISOString(),
    pending_direction: null,
  });

  // Bring the provider back in line with local truth: re-dates/re-titles the
  // event, or deletes it again if the local row is a genuinely cancelled
  // platform booking.
  try { await pushToProvider(userId, provider, table, existing.local_id, 'upsert'); }
  catch (e) { console.warn('[calendar-deletion] relink push failed:', e && e.message); }

  await logSync({
    userId, provider, direction: 'to_local', localTable: table, localId: existing.local_id, providerEventId: ev.id,
    op: 'relink',
    message: 'event carried stayops marker for an existing row with no mapping — re-linked' + (revived ? ' and booking revived' : ''),
  });
  return { op: revived ? 'relink_revive' : 'relink' };
}

module.exports = {
  handleBookingEventDeletion,
  relinkMarkedEvent,
  isPlatformBooking,
};
