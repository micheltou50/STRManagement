/**
 * StayOps — Google Calendar API client.
 * Thin wrapper around calendar.v3 endpoints used by the sync engine.
 */

const BASE = 'https://www.googleapis.com/calendar/v3';

async function call(accessToken, path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
  if (!res.ok) {
    const err = new Error('Google Calendar ' + res.status + ': ' + (text || '').slice(0, 300));
    err.statusCode = res.status;
    err.body = body;
    throw err;
  }
  return { status: res.status, body, headers: res.headers };
}

async function createCalendar(accessToken, summary) {
  const r = await call(accessToken, '/calendars', {
    method: 'POST',
    body: JSON.stringify({ summary, timeZone: 'UTC' }),
  });
  return r.body; // { id, ... }
}

async function getCalendar(accessToken, calendarId) {
  const r = await call(accessToken, '/calendars/' + encodeURIComponent(calendarId));
  return r.body;
}

async function insertEvent(accessToken, calendarId, event) {
  const r = await call(accessToken, '/calendars/' + encodeURIComponent(calendarId) + '/events', {
    method: 'POST',
    body: JSON.stringify(event),
  });
  return r.body; // { id, etag, updated, ... }
}

async function patchEvent(accessToken, calendarId, eventId, etag, patch) {
  const headers = etag ? { 'If-Match': etag } : {};
  const r = await call(accessToken,
    '/calendars/' + encodeURIComponent(calendarId) + '/events/' + encodeURIComponent(eventId),
    { method: 'PATCH', body: JSON.stringify(patch), headers });
  return r.body;
}

async function deleteEvent(accessToken, calendarId, eventId, etag) {
  const headers = etag ? { 'If-Match': etag } : {};
  try {
    await call(accessToken,
      '/calendars/' + encodeURIComponent(calendarId) + '/events/' + encodeURIComponent(eventId),
      { method: 'DELETE', headers });
  } catch (e) {
    // 410 Gone / 404 Not Found are acceptable — the event is already gone.
    if (e.statusCode === 410 || e.statusCode === 404) return;
    throw e;
  }
}

/**
 * Incremental list. If syncToken is provided, returns only changes since
 * last sync. If 410, caller must perform a full sync (drop syncToken).
 */
async function listEvents(accessToken, calendarId, opts = {}) {
  const params = new URLSearchParams();
  if (opts.syncToken) params.set('syncToken', opts.syncToken);
  if (opts.pageToken) params.set('pageToken', opts.pageToken);
  if (opts.timeMin && !opts.syncToken) params.set('timeMin', opts.timeMin);
  if (opts.timeMax && !opts.syncToken) params.set('timeMax', opts.timeMax);
  params.set('singleEvents', 'true');
  params.set('maxResults', '250');
  params.set('showDeleted', 'true');
  const r = await call(accessToken,
    '/calendars/' + encodeURIComponent(calendarId) + '/events?' + params.toString());
  return r.body;
}

/**
 * Register a push channel. Channel expires after ~7 days.
 * notificationUrl must be HTTPS and reachable from Google.
 */
async function watchEvents(accessToken, calendarId, channelId, notificationUrl, token) {
  const r = await call(accessToken,
    '/calendars/' + encodeURIComponent(calendarId) + '/events/watch',
    {
      method: 'POST',
      body: JSON.stringify({
        id: channelId,
        type: 'web_hook',
        address: notificationUrl,
        token: token || '',
      }),
    });
  return r.body; // { id, resourceId, expiration, ... }
}

async function stopChannel(accessToken, channelId, resourceId) {
  try {
    await call(accessToken, '/channels/stop', {
      method: 'POST',
      body: JSON.stringify({ id: channelId, resourceId }),
    });
  } catch (e) {
    // Channel may already be expired/stopped.
    if (e.statusCode === 404) return;
    throw e;
  }
}

module.exports = {
  createCalendar,
  getCalendar,
  insertEvent,
  patchEvent,
  deleteEvent,
  listEvents,
  watchEvents,
  stopChannel,
};
