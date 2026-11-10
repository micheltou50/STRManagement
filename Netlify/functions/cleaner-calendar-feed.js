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
   Turnover maths live in ./utils/cleaner-turnover.js (shared with the morning
   digest) and mirror annotateCleanerCleans() in assets/js/utils.js.

   Deliberately NOT in the feed: the lockbox code (feeds sync through third-
   party calendar servers; the code stays in the app, revealed on the day) and
   any guest contact details.

   Required Netlify env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY
   ═══════════════════════════════════════════════════════════════════════════ */

const { captureError, flush } = require('./utils/sentry');
const { resolveTurnover, mins, clock, isoDate, addDays, addDaysStr } = require('./utils/cleaner-turnover');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
      '&select=id,local_id,booking_id,property_id,user_id,guest_name,clean_date,done,cleaner_confirmed,started_at,notes' +
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
    //    and the next arrival (the deadline). Same-host rows only (local_id is per host).
    const until = isoDate(addDays(new Date(), FUTURE_DAYS));
    const hostIds = [...new Set(cleans.map(c => c.user_id).filter(Boolean))];
    const bookings = propIds.length
      ? await get(
          'bookings?property_id=in.(' + propIds.map(enc).join(',') + ')' +
          (hostIds.length ? '&user_id=in.(' + hostIds.map(enc).join(',') + ')' : '') +
          '&checkout=gte.' + enc(since) + '&checkin=lte.' + enc(until) +
          '&select=id,local_id,property_id,user_id,checkin,checkout,checkin_time,checkout_time,guests,status'
        )
      : [];

    const events = cleans
      .map(c => buildEvent(c, propById[c.property_id] || {}, bookings.filter(b => !c.user_id || String(b.user_id) === String(c.user_id))))
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
  const day = String(c.clean_date || '').slice(0, 10);
  if (!day) return null;
  const t = resolveTurnover(c, bookings);
  if (t.cancelled) return null;

  const startMin = mins(t.checkout);
  const endMin = t.sameDay && mins(t.nextTime) > startMin ? mins(t.nextTime) : startMin + FALLBACK_HOURS * 60;
  const info = (prop.check_in_info && typeof prop.check_in_info === 'object') ? prop.check_in_info : {};
  const own = t.own;

  const description = [
    'Guest out: ' + (c.guest_name || 'Guest') + (own && own.guests ? ' (' + own.guests + ' guests)' : '') + ' · ' + clock(t.checkout),
    t.sameDay
      ? 'Next guest: ' + clock(t.nextTime) + ' today' + (t.next.guests ? ' (' + t.next.guests + ' guests)' : '')
      : t.nextDay ? 'Next guest: ' + t.nextDay + ' ' + clock(t.nextTime) : 'Next guest: none booked yet',
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
    summary: 'Clean · ' + (prop.name || 'Property') + (t.sameDay ? ' (next guest ' + clock(t.nextTime) + ')' : ''),
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

/** "YYYY-MM-DD" + minutes from midnight → "YYYYMMDDTHHMMSS" (floating local time). */
function stamp(day, minutes) {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return day.replace(/-/g, '') + 'T' + String(h).padStart(2, '0') + String(m).padStart(2, '0') + '00';
}

function enc(s) { return encodeURIComponent(s); }
function text(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body };
}
