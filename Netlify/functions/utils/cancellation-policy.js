const FALLBACK_CANCELLATION_WINDOW_DAYS = 14;

function getCancellationWindowDays(config) {
  const cfg = config || {};
  const policy = cfg.cancellation_policy || cfg.cancellationPolicy || {};
  const raw =
    cfg.cancellation_window_days ??
    cfg.cancellationWindowDays ??
    policy.window_days ??
    policy.windowDays;
  const days = Number(raw);
  return Number.isFinite(days) && days >= 0 ? days : FALLBACK_CANCELLATION_WINDOW_DAYS;
}

function parseDateOnly(value) {
  if (!value) return null;
  const ymd = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return null;
  return Date.UTC(y, m - 1, d);
}

function daysUntilCheckin(checkin, cancelledAt) {
  const ci = parseDateOnly(checkin);
  const ca = parseDateOnly(cancelledAt || new Date());
  if (ci == null || ca == null) return Infinity;
  return Math.ceil((ci - ca) / 86400000);
}

function isCancellationBillable(booking, cancelledAt, config) {
  return daysUntilCheckin(booking && booking.checkin, cancelledAt) <= getCancellationWindowDays(config);
}

async function loadCancellationConfig(supabaseUrl, sbHeaders, userId) {
  if (!supabaseUrl || !sbHeaders || !userId) return {};
  try {
    const res = await fetch(
      supabaseUrl + '/rest/v1/app_config?user_id=eq.' + encodeURIComponent(userId) +
        '&select=cancellation_window_days,cancellation_policy',
      { headers: sbHeaders }
    );
    if (!res.ok) return {};
    const rows = await res.json();
    return (Array.isArray(rows) && rows[0]) || {};
  } catch (_) {
    return {};
  }
}

module.exports = {
  getCancellationWindowDays,
  daysUntilCheckin,
  isCancellationBillable,
  loadCancellationConfig,
};
