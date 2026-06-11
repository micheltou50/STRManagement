const FALLBACK_CANCELLATION_WINDOW_DAYS = 14;

function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function _dateOnly(value) {
  if (!value) return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // Local Y-M-D, NOT toISOString(): UTC would shift the 14-day window back a
    // day for AEST users before ~10am (booking cancelled "today" reads as
    // yesterday in UTC). The window comparison must be done in local time.
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

function _parseLocalDate(value) {
  const ymd = _dateOnly(value);
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

export function getCancellationWindowDays(config) {
  const cfg = config || globalThis._appConfig || globalThis._siteConfig || {};
  const policy = cfg.cancellation_policy || cfg.cancellationPolicy || {};
  const raw =
    cfg.cancellation_window_days ??
    cfg.cancellationWindowDays ??
    policy.window_days ??
    policy.windowDays;
  const days = Number(raw);
  return Number.isFinite(days) && days >= 0 ? days : FALLBACK_CANCELLATION_WINDOW_DAYS;
}

export function daysUntilCheckin(checkin, cancelledAt) {
  const ci = _parseLocalDate(checkin);
  const ca = _parseLocalDate(cancelledAt || new Date());
  if (!ci || !ca) return Infinity;
  return Math.ceil((ci - ca) / 86400000);
}

export function isCancellationInsideWindow(booking, cancelledAt, windowDays = getCancellationWindowDays()) {
  return daysUntilCheckin(booking && booking.checkin, cancelledAt) <= windowDays;
}

export function getCancellationBillable(booking) {
  if (!booking || String(booking.status || '').toLowerCase() !== 'cancelled') return false;
  // Explicit flag wins in either direction.
  if (booking.cancellationBillable === true || booking.cancellation_billable === true) return true;
  if (booking.cancellationBillable === false || booking.cancellation_billable === false) return false;
  // Flag is null/unset. This is the common case for a soft-cancel that reached
  // the DB via the trigger that just sets status='cancelled' (it never stamps
  // cancellation_billable). Don't treat "unknown" as "$0" — fall back to the
  // policy window: a cancellation inside the billable window still counts.
  const cancelledAt = booking.cancelledAt || booking.cancelled_at || null;
  return isCancellationInsideWindow(booking, cancelledAt);
}

export function isRevenueBearingBooking(booking) {
  if (!booking) return false;
  if (String(booking.status || '').toLowerCase() !== 'cancelled') return true;
  return getCancellationBillable(booking);
}

// A revenue-bearing (billable) cancellation whose host_payout is still 0 —
// typically an iCal stub cancelled before email enrichment ever filled in the
// money fields. Its rollup contribution is a misleading $0. Callers (UI) use
// this to flag "billable, payout pending" rather than presenting $0 as final.
export function isBillableButMissingPayout(booking) {
  if (!booking) return false;
  if (String(booking.status || '').toLowerCase() !== 'cancelled') return false;
  if (!isRevenueBearingBooking(booking)) return false;
  return _num(booking.hostPayout) <= 0;
}

export function bookingAmount(booking, field) {
  return isRevenueBearingBooking(booking) ? _num(booking && booking[field]) : 0;
}

export function bookingRevenue(booking) {
  return bookingAmount(booking, 'hostPayout');
}

export function bookingCleaningFee(booking) {
  return bookingAmount(booking, 'cleaningFee');
}

export function bookingMgmtFee(booking) {
  return bookingAmount(booking, 'mgmtFee');
}

export function bookingMgmtPayout(booking) {
  return bookingAmount(booking, 'mgmtPayout');
}

export function bookingNetPayout(booking) {
  return bookingAmount(booking, 'netPayout');
}

export function bookingStatusLabel(booking, isPast = false) {
  if (String((booking && booking.status) || '').toLowerCase() === 'cancelled') {
    return getCancellationBillable(booking) ? 'Late cancel - billed' : 'Cancelled';
  }
  return isPast ? 'Past' : 'Upcoming';
}

export function applyCancellationPolicy(booking, opts = {}) {
  if (!booking) return booking;
  const cancelledAt = opts.cancelledAt || booking.cancelledAt || booking.cancelled_at || new Date().toISOString();
  const windowDays = opts.windowDays != null ? Number(opts.windowDays) : getCancellationWindowDays(opts.config);
  const suggested = isCancellationInsideWindow(booking, cancelledAt, windowDays);
  booking.status = 'cancelled';
  booking.cancelledAt = cancelledAt;
  booking.cancellationBillable = opts.billable != null ? !!opts.billable : suggested;
  return booking;
}
