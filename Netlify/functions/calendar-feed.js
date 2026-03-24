/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Calendar Feed (.ics)
   Serves an iCalendar feed of bookings from Supabase.
   Subscribe to this URL from any calendar app (Apple, Google, Outlook).

   Required Netlify env vars:
     SUPABASE_URL              — e.g. https://xyz.supabase.co
     SUPABASE_SERVICE_KEY      — from Supabase dashboard → Settings → API
   ═══════════════════════════════════════════════════════════════════════════ */

exports.handler = async (event) => {
  // ── Auth ────────────────────────────────────────────────────────────────
  const uid = (event.queryStringParameters || {}).uid;
  if (!uid || uid.length < 10) {
    return { statusCode: 401, body: 'Missing or invalid uid parameter.' };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[calendar-feed] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars');
    return { statusCode: 500, body: 'Server misconfigured.' };
  }

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
  };

  try {
    // ── 1. Validate user exists ────────────────────────────────────────────
    const userRes = await fetch(
      SUPABASE_URL + '/auth/v1/admin/users/' + encodeURIComponent(uid),
      { headers }
    );
    if (!userRes.ok) {
      return { statusCode: 403, body: 'Invalid user.' };
    }

    // ── 2. Get property ────────────────────────────────────────────────────
    const propRes = await fetch(
      SUPABASE_URL + '/rest/v1/properties?user_id=eq.' + encodeURIComponent(uid) +
        '&select=id,name&order=updated_at.desc&limit=1',
      { headers }
    );
    const properties = await propRes.json();
    if (!properties || !properties.length) {
      return icsResponse([], 'StayOps Bookings');
    }
    const property = properties[0];

    // ── 3. Get bookings ────────────────────────────────────────────────────
    const bookingsRes = await fetch(
      SUPABASE_URL + '/rest/v1/bookings?user_id=eq.' + encodeURIComponent(uid) +
        '&property_id=eq.' + encodeURIComponent(property.id) +
        '&status=neq.cancelled&select=id,checkin,checkout,guest_name,guests,platform,status' +
        '&order=checkin.asc',
      { headers }
    );
    const bookings = await bookingsRes.json();

    // ── 4. Serve .ics ──────────────────────────────────────────────────────
    return icsResponse(Array.isArray(bookings) ? bookings : [], property.name || 'StayOps');

  } catch (err) {
    console.error('[calendar-feed] Error:', err);
    return { statusCode: 500, body: 'Internal error.' };
  }
};


// ── .ics generation ──────────────────────────────────────────────────────────

function icsResponse(bookings, propertyName) {
  const body = generateICS(bookings, propertyName);
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="stayops-bookings.ics"',
      'Cache-Control': 'no-cache, max-age=900',
      'Access-Control-Allow-Origin': '*',
    },
    body,
  };
}

function generateICS(bookings, propertyName) {
  const now = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';

  const events = bookings.map(b => {
    const start = (b.checkin || '').replace(/-/g, '');
    const end   = (b.checkout || '').replace(/-/g, '');
    if (!start || !end) return '';

    const name     = sanitizeICS(b.guest_name || 'Guest');
    const guests   = b.guests || '?';
    const platform = b.platform ? sanitizeICS(b.platform) : '';
    const uid      = 'booking-' + b.id + '@stayops';

    const description = [
      'Check-in: ' + (b.checkin || ''),
      'Check-out: ' + (b.checkout || ''),
      'Guests: ' + guests,
      platform ? 'Platform: ' + platform : '',
    ].filter(Boolean).join('\\n');

    return [
      'BEGIN:VEVENT',
      'UID:' + uid,
      'DTSTAMP:' + now,
      'DTSTART;VALUE=DATE:' + start,
      'DTEND;VALUE=DATE:' + end,
      'SUMMARY:🏡 ' + name + ' — ' + sanitizeICS(propertyName),
      'DESCRIPTION:' + description,
      'STATUS:CONFIRMED',
      'TRANSP:OPAQUE',
      'END:VEVENT',
    ].join('\r\n');
  }).filter(Boolean);

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//StayOps//Booking Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:' + sanitizeICS(propertyName) + ' — Bookings',
    'X-WR-TIMEZONE:Australia/Sydney',
    '',
    events.join('\r\n'),
    '',
    'END:VCALENDAR',
  ].join('\r\n');
}

function sanitizeICS(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}
