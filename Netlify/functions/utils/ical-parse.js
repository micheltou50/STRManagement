/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Lightweight iCalendar (.ics) parser.
   Handles VEVENT blocks, line unfolding, and per-platform confirmation-code
   extraction from DESCRIPTION (Booking.com / VRBO embed reservation URLs).
   Not a full RFC 5545 implementation — covers what STR platforms actually emit.
   ═══════════════════════════════════════════════════════════════════════════ */

function unfoldLines(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function parseDateValue(raw) {
  if (!raw) return null;
  const v = raw.trim();
  // Date-only: YYYYMMDD
  let m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  // Date-time: YYYYMMDDTHHMMSS[Z]
  m = v.match(/^(\d{4})(\d{2})(\d{2})T/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  return null;
}

function extractConfCode(description, summary, platform) {
  const blob = ((description || '') + ' ' + (summary || '')).replace(/\\n/g, ' ').replace(/\\,/g, ',');
  const p = String(platform || '').toLowerCase();

  // Airbnb: confirmation codes look like HM... or alphanumeric in /reservations/details/CODE
  if (p === 'airbnb') {
    const m = blob.match(/(?:reservation[s]?\/details\/|reservations\/)([A-Z0-9]{6,})/i);
    if (m) return m[1].toUpperCase();
    const m2 = blob.match(/\b(H[A-Z0-9]{8,})\b/);
    if (m2) return m2[1];
  }
  // Booking.com: numeric reservation IDs in URLs like /hotel/xxx?label=...&aid=...&res_id=1234567890
  if (p === 'booking') {
    const m = blob.match(/(?:res_id|reservation[_-]?id|booking[_-]?id|bn=)[=:]?\s*(\d{6,})/i);
    if (m) return m[1];
    const m2 = blob.match(/\b(\d{9,12})\b/);
    if (m2) return m2[1];
  }
  // VRBO / Stayz: HA- prefix sometimes; or numeric reservation IDs
  if (p === 'vrbo' || p === 'stayz') {
    const m = blob.match(/\b(HA-[A-Z0-9-]+)\b/i);
    if (m) return m[1].toUpperCase();
    const m2 = blob.match(/(?:reservation[s]?\/|trip\/)([A-Z0-9-]{6,})/i);
    if (m2) return m2[1];
  }
  return '';
}

function parseICS(text, platform) {
  const lines = unfoldLines(text);
  const events = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line === 'BEGIN:VEVENT') {
      current = {};
    } else if (line === 'END:VEVENT') {
      if (current && current.uid && current.dtstart) {
        events.push(current);
      }
      current = null;
    } else if (current) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const head = line.slice(0, colon);
      const value = line.slice(colon + 1);
      const propName = head.split(';')[0].toUpperCase();

      if (propName === 'UID') current.uid = value.trim();
      else if (propName === 'DTSTART') current.dtstart = parseDateValue(value);
      else if (propName === 'DTEND') current.dtend = parseDateValue(value);
      else if (propName === 'SUMMARY') current.summary = value;
      else if (propName === 'DESCRIPTION') current.description = value;
      else if (propName === 'STATUS') current.status = value.trim().toUpperCase();
    }
  }

  return events.map(ev => ({
    uid: ev.uid,
    checkin: ev.dtstart,
    checkout: ev.dtend || ev.dtstart,
    summary: ev.summary || '',
    description: ev.description || '',
    cancelled: ev.status === 'CANCELLED',
    confirmationCode: extractConfCode(ev.description, ev.summary, platform),
  }));
}

module.exports = { parseICS, extractConfCode };
