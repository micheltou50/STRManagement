/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Cleaner Calendar Feed (.ics)
   Serves an iCalendar feed of ONE cleaner's cleans so they can subscribe from
   the phone calendar they already live in (Apple / Google / Outlook). Offered
   in the cleaner PWA Profile tab (assets/js/render-cleaner.js, "Add to calendar").

   Query params:
     key — the cleaner's row uuid (cleaners.id). A random v4 uuid shown only to
           that cleaner and their host, so it acts as the feed's bearer secret —
           the same model as calendar-feed.js (host bookings feed keyed by uid).

   Events: one per clean, TIMED in floating local wall clock (a cleaner works
   where the property is). Declined cleans and cleans whose booking was
   cancelled are left out.
     DTSTART = clean date + the departing guest's checkout (per-booking override
               or 10:00)
     DTEND   = the next guest's check-in when they arrive the same day (override
               or 15:00), else checkout + 3h
   This mirrors annotateCleanerCleans() in assets/js/utils.js — keep in step.

   Deliberately NOT in the feed: the lockbox code (feeds sync through third-
   party calendar servers; the code stays in the app, revealed on the day) and
   any guest contact details.

   Required Netlify env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY
   ═══════════════════════════════════════════════════════════════════════════ */

const { captureError, flush } = require('./utils/sentry');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_CHECKOUT = '10:00';
const DEFAULT_CHECKIN = '15:00';
const FALLBACK_HOURS = 3;   // event length when nobody arrives the same day
const PAST_DAYS = 30;       // keep a month of completed cleans in the feed
const FUTURE_DAYS = 180;    // bookings window for next-arrival lookups

exports.handler = async (event) => {
  const key = String((event.queryStringParameters || {}).key || '').trim();
  if (!UUID_RE.test(key)) return text(400, 'Missing or invalid key parameter.');

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[cleaner-calendar-feed] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
    return text(500, 'Server misconfigured.');
  }
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
  };
  const get = async (path) => {
    const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, { headers });
    if (!res.ok) throw new Error('Supabase ' + res.status + ' on ' + path.split('?')[0]);
    const rows = await res.json();
    return Array.isArray(rows) ? rows : [];
  };

  try {
    // 1. The cleaner — the key IS the row id
    const cleaner = (await get('cleaners?id=eq.' + enc(key) + '&select=id,name,active&limit=1'))[0];
    if (!cleaner || cleaner.active === false) return text(404, 'Calendar not found.');

    // 2. Their cleans: everything upcoming plus the last month, declined excluded
    const since = isoDate(addDays(new Date(), -PAST_DAYS));
    const cleans = await get(
      'cleans?cleaner_uuid=eq.' + enc(cleaner.id) +
      '&clean_date=gte.' + enc(since) +
      '&cleaner_declined=eq.false' +
      '&select=id,local_id,booking_id,property_id,guest_name,clean_date,done,cleaner_confirmed,started_at,notes' +
      '&order=clean_date.asc'
    );
    if (!cleans.length) return ics([], cleaner);

    // 3. Their properties — name/address + the cheat sheet (lockbox code withheld in buildEvent)
    const propIds = [...new Set(cleans.map(c => c.property_id).filter(Boolean))];
    const properties = propIds.length
      ? await get('properties?id=in.(' + propIds.map(enc).join(',') + ')&select=id,name,address,suburb,state,check_in_info')
      : [];
    const propById = {};
    properties.forEach(p => { propById[p.id] = p; });

    // 4. Bookings at those properties: the clean's own (checkout time, cancelled?)
    //    and the next arrival (the deadline)
    const until = isoDate(addDays(new Date(), FUTURE_DAYS));
    const bookings = propIds.length
      ? await get(
          'bookings?property_id=in.(' + propIds.map(enc).join(',') + ')' +
          '&checkout=gte.' + enc(since) + '&checkin=lte.' + enc(until) +
          '&select=id,local_id,property_id,checkin,checkout,checkin_time,checkout_time,guests,status'
        )
      : [];

    const events = cleans
      .map(c => buildEvent(c, propById[c.property_id] || {}, bookings))
      .filter(Boolean);
    return ics(events, cleaner);
  } catch (err) {
    console.error('[cleaner-calendar-feed] Error:', err);
    captureError(err, { tags: { function: 'cleaner-calendar-feed' } });
    await flush();
    return text(500, 'Internal error.');
  }
};

/** One clean → event descriptor, or null when its own booking was cancelled. */
function buildEvent(c, prop, bookings) {
  const key = c.booking_id != null && c.booking_id !== '' ? String(c.booking_id) : '';
  const own = key ? (bookings.find(b => String(b.local_id) === key || String(b.id) === key) || null) : null;
  if (own && own.status === 'cancelled') return null;

  const day = String(c.clean_date || '').slice(0, 10);
  if (!day) return null;
  const checkout = hhmm(own && own.checkout_time, DEFAULT_CHECKOUT);

  // Earliest non-cancelled arrival at the same property on/after the clean date
  let next = null;
  bookings.forEach(b => {
    if (b === own || b.status === 'cancelled' || String(b.property_id) !== String(c.property_id)) return;
    const ci = String(b.checkin || '').slice(0, 10);
    if (!ci || ci < day) return;
    if (!next) { next = b; return; }
    const nci = String(next.checkin).slice(0, 10);
    if (ci < nci || (ci === nci && mins(hhmm(b.checkin_time, DEFAULT_CHECKIN)) < mins(hhmm(next.checkin_time, DEFAULT_CHECKIN)))) next = b;
  });
  const nextDay = next ? String(next.checkin).slice(0, 10) : '';
  const nextTime = next ? hhmm(next.checkin_time, DEFAULT_CHECKIN) : '';
  const sameDay = !!next && nextDay === day;

  const startMin = mins(checkout);
  const endMin = sameDay && mins(nextTime) > startMin ? mins(nextTime) : startMin + FALLBACK_HOURS * 60;
  const info = (prop.check_in_info && typeof prop.check_in_info === 'object') ? prop.check_in_info : {};

  const description = [
    'Guest out: ' + (c.guest_name || 'Guest') + (own && own.guests ? ' (' + own.guests + ' guests)' : '') + ' · ' + clock(checkout),
    sameDay
      ? 'Next guest: ' + clock(nextTime) + ' today' + (next.guests ? ' (' + next.guests + ' guests)' : '')
      : nextDay ? 'Next guest: ' + nextDay + ' ' + clock(nextTime) : 'Next guest: none booked yet',
    c.done ? 'Status: done'
      : c.started_at ? 'Status: in progress'
      : c.cleaner_confirmed ? 'Status: confirmed'
      : 'Status: awaiting your reply in StayOps',
    c.notes ? 'Note from host: ' + c.notes : '',
    info.instructions ? 'Getting in: ' + info.instructions : '',
    info.wifi ? 'Wi-Fi: ' + info.wifi : '',
    info.cleaner_notes ? 'Notes: ' + info.cleaner_notes : '',
    info.lockbox_code ? 'Lockbox code: shown in the StayOps app on the day' : '',
  ].filter(Boolean).join('\n');

  return {
    uid: 'clean-' + c.id + '@stayops',
    start: stamp(day, startMin),
    end: stamp(addDaysStr(day, Math.floor(endMin / 1440)), endMin % 1440),
    summary: 'Clean · ' + (prop.name || 'Property') + (sameDay ? ' (next guest ' + clock(nextTime) + ')' : ''),
    location: [prop.address, prop.suburb, prop.state].filter(Boolean).join(', '),
    description,
    status: c.done || c.cleaner_confirmed ? 'CONFIRMED' : 'TENTATIVE',
  };
}

// ── .ics generation ──────────────────────────────────────────────────────────

function ics(events, cleaner) {
  const now = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
  const first = String(cleaner.name || '').trim().split(/\s+/)[0] || 'Cleaner';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//StayOps//Cleaner Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:' + esc('StayOps cleans · ' + first),
    'X-WR-TIMEZONE:Australia/Sydney',
  ];
  events.forEach(ev => {
    lines.push(
      'BEGIN:VEVENT',
      'UID:' + ev.uid,
      'DTSTAMP:' + now,
      'DTSTART:' + ev.start,
      'DTEND:' + ev.end,
      'SUMMARY:' + esc(ev.summary)
    );
    if (ev.location) lines.push('LOCATION:' + esc(ev.location));
    lines.push(
      'DESCRIPTION:' + esc(ev.description),
      'STATUS:' + ev.status,
      'TRANSP:OPAQUE',
      'END:VEVENT'
    );
  });
  lines.push('END:VCALENDAR');
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="stayops-cleans.ics"',
      'Cache-Control': 'no-cache, max-age=900',
    },
    body: lines.map(fold).join('\r\n') + '\r\n',
  };
}

/** RFC 5545 text escaping. */
function esc(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** RFC 5545 line folding: content lines are at most 75 chars, continuations start with a space. */
function fold(line) {
  if (line.length <= 75) return line;
  const out = [line.slice(0, 75)];
  for (let i = 75; i < line.length; i += 74) out.push(' ' + line.slice(i, i + 74));
  return out.join('\r\n');
}

// ── time helpers (property-local wall clock, no timezone maths) ─────────────

function hhmm(value, dflt) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(value || ''));
  if (!m) return dflt;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return dflt;
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
}
function mins(label) { const [h, m] = String(label).split(':').map(Number); return (h || 0) * 60 + (m || 0); }
function clock(label) {
  const h = Math.floor(mins(label) / 60), m = mins(label) % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + (m ? ':' + String(m).padStart(2, '0') : '') + (h >= 12 ? 'pm' : 'am');
}
function stamp(day, minutes) {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return day.replace(/-/g, '') + 'T' + String(h).padStart(2, '0') + String(m).padStart(2, '0') + '00';
}
function isoDate(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate() + n); return x; }
function addDaysStr(day, n) {
  if (!n) return day;
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

function enc(s) { return encodeURIComponent(s); }
function text(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body };
}
