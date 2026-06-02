const FALLBACK_CANCELLATION_WINDOW_DAYS = 14;

function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function _dateOnly(value) {
  if (!value) return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
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
  return booking.cancellationBillable === true || booking.cancellation_billable === true;
}

export function isRevenueBearingBooking(booking) {
  if (!booking) return false;
  if (String(booking.status || '').toLowerCase() !== 'cancelled') return true;
  return getCancellationBillable(booking);
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
