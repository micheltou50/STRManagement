/**
 * StayOps — turnover maths for the cleaner-facing server functions
 * (cleaner-calendar-feed.js, cleaner-morning-digest.js). CommonJS, pure.
 *
 * Mirrors annotateCleanerCleans() in assets/js/utils.js, which does the same
 * for the cleaner PWA — keep the two in step:
 *   checkout  = the departing guest's checkout time (per-booking override, else 10:00)
 *   next      = the earliest non-cancelled arrival at the same property on/after
 *               the clean date, excluding the clean's own booking
 *   sameDay   = that arrival is on the clean date itself (the hard deadline)
 * Times are property-local wall clock ("HH:MM"); no timezone maths here.
 */

const DEFAULT_CHECKOUT = '10:00';
const DEFAULT_CHECKIN = '15:00';

/** "10:00:00" | "9:30" → "HH:MM", or `dflt` when missing/invalid. */
function hhmm(value, dflt) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(value || ''));
  if (!m) return dflt;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return dflt;
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
}

/** "HH:MM" → minutes from midnight. */
function mins(label) {
  const [h, m] = String(label).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** "15:30" → "3:30pm", "10:00" → "10am". */
function clock(label) {
  const total = mins(label);
  const h = Math.floor(total / 60), m = total % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + (m ? ':' + String(m).padStart(2, '0') : '') + (h >= 12 ? 'pm' : 'am');
}

/** Date → "YYYY-MM-DD" (UTC). */
function isoDate(d) { return d.toISOString().slice(0, 10); }

/** Date + n days (UTC arithmetic, returns a new Date). */
function addDays(d, n) { const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate() + n); return x; }

/** "YYYY-MM-DD" + n days → "YYYY-MM-DD". */
function addDaysStr(day, n) {
  if (!n) return day;
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

/**
 * Resolve one clean's turnover against the bookings at its property.
 * @param {{clean_date:string, booking_id?:string, property_id?:string}} clean raw cleans row
 * @param {Array<object>} bookings rows with local_id, id, property_id, checkin, checkout,
 *   checkin_time, checkout_time, guests, status (same host as the clean)
 * @returns {{own:object|null, cancelled:boolean, checkout:string, next:object|null,
 *   nextDay:string, nextTime:string, sameDay:boolean}}
 *   checkout / nextTime are "HH:MM"; nextDay "YYYY-MM-DD" or ''.
 */
function resolveTurnover(clean, bookings) {
  const list = Array.isArray(bookings) ? bookings : [];
  const key = clean.booking_id != null && clean.booking_id !== '' ? String(clean.booking_id) : '';
  const own = key ? (list.find(b => String(b.local_id) === key || String(b.id) === key) || null) : null;
  const day = String(clean.clean_date || '').slice(0, 10);
  const checkout = hhmm(own && own.checkout_time, DEFAULT_CHECKOUT);

  let next = null;
  if (day) {
    list.forEach(b => {
      if (b === own || b.status === 'cancelled' || String(b.property_id) !== String(clean.property_id)) return;
      const ci = String(b.checkin || '').slice(0, 10);
      if (!ci || ci < day) return;
      if (!next) { next = b; return; }
      const nci = String(next.checkin).slice(0, 10);
      if (ci < nci || (ci === nci && mins(hhmm(b.checkin_time, DEFAULT_CHECKIN)) < mins(hhmm(next.checkin_time, DEFAULT_CHECKIN)))) next = b;
    });
  }
  const nextDay = next ? String(next.checkin).slice(0, 10) : '';
  return {
    own,
    cancelled: !!(own && own.status === 'cancelled'),
    checkout,
    next,
    nextDay,
    nextTime: next ? hhmm(next.checkin_time, DEFAULT_CHECKIN) : '',
    sameDay: !!next && nextDay === day,
  };
}

module.exports = {
  DEFAULT_CHECKOUT,
  DEFAULT_CHECKIN,
  hhmm,
  mins,
  clock,
  isoDate,
  addDays,
  addDaysStr,
  resolveTurnover,
};
