/**
 * StayOps — local row ↔ provider event translation.
 *
 * Provider-neutral shape (Google + Outlook conform). Keys:
 *   summary, description, start { date | dateTime, timeZone? },
 *   end   { date | dateTime, timeZone? },
 *   extendedProperties.private.{ stayops_table, stayops_id }
 *
 * The classifyEvent() function inspects an inbound provider event and decides
 * which local table it belongs to (or 'inbox' if untriaged).
 */

const TITLE_PREFIX = {
  bookings: 'Booking — ',
  cleans: 'Clean — ',
  maintenance: 'Maintenance — ',
};

// Property-local times for calendar events. Hardcoded to Sydney since the
// app's cron schedules and email send-times are all set for AEST/AEDT.
const EVENT_TZ = 'Australia/Sydney';
const BOOKING_CHECKIN_TIME  = '15:00:00'; // 3pm
const BOOKING_CHECKOUT_TIME = '10:00:00'; // 10am
const CLEAN_START_TIME      = '11:00:00'; // 11am
const CLEAN_END_TIME        = '13:00:00'; // 1pm (2hr block)

// A trailing marker we embed in event descriptions so we can recover the
// (table, local_id) pairing on providers (e.g. Microsoft Graph) where the
// equivalent of Google's extendedProperties.private isn't trivial to read.
const MARKER_RE = /\[stayops:(bookings|cleans|maintenance):([^\]]+)\]/i;
function withMarker(description, table, id) {
  const tag = '[stayops:' + table + ':' + String(id) + ']';
  if (!description) return tag;
  return description.replace(/\s*\[stayops:[^\]]+\]\s*$/i, '').trimEnd() + '\n\n' + tag;
}

function bookingToEvent(b) {
  const guests = b.guests ? ' (' + b.guests + ')' : '';
  const platform = b.platform ? ' [' + b.platform + ']' : '';
  const lines = [];
  if (b.confirmation_code) lines.push('Confirmation: ' + b.confirmation_code);
  if (b.host_payout) lines.push('Host payout: $' + Number(b.host_payout).toFixed(2));
  if (b.cleaning_fee) lines.push('Cleaning fee: $' + Number(b.cleaning_fee).toFixed(2));
  if (b.notes) lines.push('', b.notes);
  return {
    summary: TITLE_PREFIX.bookings + (b.guest_name || 'Guest') + guests + platform,
    description: withMarker(lines.join('\n'), 'bookings', b.id),
    start: { dateTime: b.checkin  + 'T' + BOOKING_CHECKIN_TIME,  timeZone: EVENT_TZ },
    end:   { dateTime: b.checkout + 'T' + BOOKING_CHECKOUT_TIME, timeZone: EVENT_TZ },
    extendedProperties: { private: { stayops_table: 'bookings', stayops_id: String(b.id) } },
  };
}

function cleanToEvent(c, propertyName) {
  const date = c.clean_date;
  const lines = [];
  if (c.cleaner) lines.push('Cleaner: ' + c.cleaner);
  if (c.guest_name) lines.push('Guest: ' + c.guest_name);
  if (c.done) lines.push('Status: Done');
  else if (c.cleaner_confirmed) lines.push('Status: Confirmed');
  else if (c.cleaner_declined) lines.push('Status: Declined');
  if (c.notes) lines.push('', c.notes);
  return {
    summary: TITLE_PREFIX.cleans + (propertyName || c.property_name || 'Property'),
    description: withMarker(lines.join('\n'), 'cleans', c.id),
    start: { dateTime: date + 'T' + CLEAN_START_TIME, timeZone: EVENT_TZ },
    end:   { dateTime: date + 'T' + CLEAN_END_TIME,   timeZone: EVENT_TZ },
    extendedProperties: { private: { stayops_table: 'cleans', stayops_id: String(c.id) } },
  };
}

function maintenanceToEvent(m) {
  const lines = [];
  if (m.contractor) lines.push('Contractor: ' + m.contractor);
  if (m.cost) lines.push('Cost: $' + Number(m.cost).toFixed(2));
  if (m.status) lines.push('Status: ' + m.status);
  return {
    summary: TITLE_PREFIX.maintenance + (m.description || 'Task').slice(0, 80),
    description: withMarker(lines.join('\n'), 'maintenance', m.id),
    start: { date: m.date },
    end:   { date: m.date },
    extendedProperties: { private: { stayops_table: 'maintenance', stayops_id: String(m.id) } },
  };
}

/**
 * Inspect an inbound provider event and decide its local table.
 * Order:
 *   1. extendedProperties.private.stayops_table — definitive (round-trip echo)
 *   2. Title prefix — "Clean: ...", "Cleaning: ...", "Maintenance: ...", "Repair: ..."
 *   3. Otherwise → 'inbox' (untriaged)
 */
function classifyEvent(event) {
  const ext = event && event.extendedProperties && event.extendedProperties.private;
  if (ext && ext.stayops_table) {
    return { table: ext.stayops_table, localId: ext.stayops_id || null };
  }
  const desc = String((event && event.description) || '');
  const m = desc.match(MARKER_RE);
  if (m) return { table: m[1].toLowerCase(), localId: m[2] };

  const title = String((event && event.summary) || '').trim();
  if (/^clean(ing)?\s*[:\-—]/i.test(title)) return { table: 'cleans', localId: null };
  if (/^(maintenance|repair)\s*[:\-—]/i.test(title)) return { table: 'maintenance', localId: null };
  if (/^booking\s*[:\-—]/i.test(title))     return { table: 'bookings', localId: null };
  return { table: 'inbox', localId: null };
}

/**
 * Convert provider event to a local-row patch for the given table.
 * Returns null if event is malformed.
 */
function eventToLocal(table, event) {
  const start = event.start || {};
  const end = event.end || {};
  const startDate = start.date || (start.dateTime || '').slice(0, 10);
  if (!startDate) return null;
  void end;

  const title = String(event.summary || '').replace(/^(Clean(ing)?|Maintenance|Repair|Booking)\s*[:\-—]\s*/i, '').trim();
  const notes = String(event.description || '').replace(MARKER_RE, '').trim();

  if (table === 'cleans') {
    return { clean_date: startDate, notes };
  }
  if (table === 'maintenance') {
    return { date: startDate, description: title || notes || 'Untitled', notes };
  }
  if (table === 'bookings') {
    // Per plan: phone edits to bookings update only title→guest_name and notes.
    return { guest_name: title || 'Guest', notes };
  }
  return null;
}

module.exports = {
  TITLE_PREFIX,
  bookingToEvent,
  cleanToEvent,
  maintenanceToEvent,
  classifyEvent,
  eventToLocal,
};
