/**
 * StayOps — Microsoft Graph (Outlook) Calendar client.
 *
 * Wraps /me/calendars and /me/events endpoints used by the sync engine,
 * plus an adapter layer that converts our provider-neutral event shape
 * (the same one calendar-mapper.js emits for Google) into Graph format
 * and back. Subscriptions ('change notifications') are also managed here.
 */

const BASE = 'https://graph.microsoft.com/v1.0';

async function call(accessToken, path, init = {}) {
  const url = path.startsWith('http') ? path : (BASE + path);
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
      Prefer: init.prefer || 'outlook.timezone="UTC"',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
  if (!res.ok) {
    const err = new Error('Graph ' + res.status + ': ' + (text || '').slice(0, 300));
    err.statusCode = res.status;
    err.body = body;
    throw err;
  }
  return { status: res.status, body, headers: res.headers };
}

// ── Calendar CRUD ──────────────────────────────────────────────────────────

async function findCalendarByName(accessToken, name) {
  const r = await call(accessToken, '/me/calendars?$select=id,name&$top=200');
  const list = (r.body && r.body.value) || [];
  return list.find(c => c.name === name) || null;
}

async function createCalendar(accessToken, name) {
  const r = await call(accessToken, '/me/calendars', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  return r.body;
}

// ── Adapter: neutral ↔ Graph event shape ───────────────────────────────────

/**
 * Neutral → Graph. Neutral is the shape calendar-mapper.js emits.
 *   neutral.start = { date: 'YYYY-MM-DD' }   (all-day)
 *           = { dateTime: 'YYYY-MM-DDTHH:mm:ss', timeZone: 'UTC' }
 */
function toGraphEvent(neutral) {
  const start = neutral.start || {};
  const end   = neutral.end   || {};
  const isAllDay = !!start.date;
  let startSpec, endSpec;
  if (isAllDay) {
    startSpec = { dateTime: start.date + 'T00:00:00.0000000', timeZone: 'UTC' };
    // Graph requires end >= start + 24h for all-day; if same date, bump by 1 day.
    let endDate = end.date || start.date;
    if (endDate === start.date) {
      const d = new Date(start.date + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 1);
      endDate = d.toISOString().slice(0, 10);
    }
    endSpec = { dateTime: endDate + 'T00:00:00.0000000', timeZone: 'UTC' };
  } else {
    startSpec = { dateTime: start.dateTime, timeZone: start.timeZone || 'UTC' };
    endSpec   = { dateTime: end.dateTime,   timeZone: end.timeZone   || 'UTC' };
  }
  return {
    subject: neutral.summary || '',
    body: { contentType: 'text', content: neutral.description || '' },
    start: startSpec,
    end: endSpec,
    isAllDay,
  };
}

/**
 * Graph → neutral. Returns the same shape Google's events.list returns,
 * which calendar-mapper.classifyEvent / eventToLocal already understand.
 * Includes id, etag, updated for the reconciler.
 */
function fromGraphEvent(g) {
  if (!g) return null;
  const start = g.start || {};
  const end   = g.end   || {};
  const isAllDay = !!g.isAllDay;
  let startN, endN;
  if (isAllDay) {
    startN = { date: (start.dateTime || '').slice(0, 10) };
    // Graph all-day end is exclusive next-day midnight. Subtract 1 day so
    // the neutral end matches the Google convention used elsewhere.
    let endDate = (end.dateTime || '').slice(0, 10);
    if (endDate && start.dateTime) {
      const dStart = new Date(start.dateTime + (start.dateTime.endsWith('Z') ? '' : 'Z'));
      const dEnd = new Date(end.dateTime + (end.dateTime.endsWith('Z') ? '' : 'Z'));
      const diffDays = Math.round((dEnd - dStart) / 86400000);
      if (diffDays >= 1) {
        const d = new Date(dEnd.getTime() - 86400000);
        endDate = d.toISOString().slice(0, 10);
      }
    }
    endN = { date: endDate };
  } else {
    startN = { dateTime: start.dateTime, timeZone: start.timeZone || 'UTC' };
    endN   = { dateTime: end.dateTime,   timeZone: end.timeZone   || 'UTC' };
  }
  return {
    id: g.id,
    etag: g['@odata.etag'] || null,
    updated: g.lastModifiedDateTime || null,
    status: g['@removed'] ? 'cancelled' : 'confirmed',
    summary: g.subject || '',
    description: (g.body && g.body.content) || '',
    start: startN,
    end: endN,
    // No extendedProperties.private equivalent; classifier falls back to body marker.
  };
}

// ── Event CRUD ─────────────────────────────────────────────────────────────

async function insertEvent(accessToken, calendarId, neutral) {
  const r = await call(accessToken,
    '/me/calendars/' + encodeURIComponent(calendarId) + '/events',
    { method: 'POST', body: JSON.stringify(toGraphEvent(neutral)) });
  return r.body; // { id, '@odata.etag', ... }
}

async function patchEvent(accessToken, eventId, etag, neutral) {
  const headers = etag ? { 'If-Match': etag } : {};
  const r = await call(accessToken,
    '/me/events/' + encodeURIComponent(eventId),
    { method: 'PATCH', body: JSON.stringify(toGraphEvent(neutral)), headers });
  return r.body;
}

async function deleteEvent(accessToken, eventId, etag) {
  const headers = etag ? { 'If-Match': etag } : {};
  try {
    await call(accessToken, '/me/events/' + encodeURIComponent(eventId),
      { method: 'DELETE', headers });
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) return;
    throw e;
  }
}

// ── Delta query (incremental list) ─────────────────────────────────────────

/**
 * Fetch one page of /events/delta. If `deltaLink` is provided, fetch from it
 * (incremental). Otherwise start fresh with a 60-day-back / 365-day-forward
 * window.
 *
 * Returns { events: [...neutral], nextDeltaLink, nextLink }.
 * Caller paginates via nextLink until nextDeltaLink is set.
 */
async function listEventsDelta(accessToken, calendarId, opts = {}) {
  let url;
  if (opts.deltaLink) {
    url = opts.deltaLink;
  } else if (opts.nextLink) {
    url = opts.nextLink;
  } else {
    const startDt = new Date(Date.now() - 60 * 86400000).toISOString();
    const endDt   = new Date(Date.now() + 365 * 86400000).toISOString();
    url = BASE + '/me/calendars/' + encodeURIComponent(calendarId) +
      '/calendarView/delta?startDateTime=' + encodeURIComponent(startDt) +
      '&endDateTime=' + encodeURIComponent(endDt);
  }
  const r = await call(accessToken, url);
  const body = r.body || {};
  const items = Array.isArray(body.value) ? body.value : [];
  const events = items.map(fromGraphEvent).filter(Boolean);
  return {
    events,
    nextDeltaLink: body['@odata.deltaLink'] || null,
    nextLink: body['@odata.nextLink'] || null,
  };
}

// ── Subscriptions (change notifications) ───────────────────────────────────

/**
 * Register a change subscription. Graph performs a validation handshake
 * synchronously: it POSTs the notificationUrl with ?validationToken=…
 * which our outlook-cal-webhook responds to. If the handshake fails this
 * call returns 400.
 *
 * Max expiration for /me/events: 4230 minutes (~70.5 hours).
 */
async function createSubscription(accessToken, calendarId, notificationUrl, clientState) {
  const expirationDateTime = new Date(Date.now() + 4200 * 60 * 1000).toISOString();
  const r = await call(accessToken, '/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      changeType: 'created,updated,deleted',
      notificationUrl,
      resource: '/me/calendars/' + calendarId + '/events',
      expirationDateTime,
      clientState: clientState || '',
    }),
  });
  return r.body; // { id, expirationDateTime, ... }
}

async function renewSubscription(accessToken, subscriptionId) {
  const expirationDateTime = new Date(Date.now() + 4200 * 60 * 1000).toISOString();
  const r = await call(accessToken, '/subscriptions/' + encodeURIComponent(subscriptionId), {
    method: 'PATCH',
    body: JSON.stringify({ expirationDateTime }),
  });
  return r.body;
}

async function deleteSubscription(accessToken, subscriptionId) {
  try {
    await call(accessToken, '/subscriptions/' + encodeURIComponent(subscriptionId), { method: 'DELETE' });
  } catch (e) {
    if (e.statusCode === 404) return;
    throw e;
  }
}

async function getEvent(accessToken, eventId) {
  try {
    const r = await call(accessToken, '/me/events/' + encodeURIComponent(eventId));
    return fromGraphEvent(r.body);
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) return null;
    throw e;
  }
}

module.exports = {
  findCalendarByName,
  createCalendar,
  toGraphEvent,
  fromGraphEvent,
  insertEvent,
  patchEvent,
  deleteEvent,
  listEventsDelta,
  createSubscription,
  renewSubscription,
  deleteSubscription,
  getEvent,
};
