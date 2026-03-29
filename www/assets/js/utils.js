/**
 * Pass 2 — pure helpers (no shared app arrays, no imports from main/bookings/render).
 * DOM-only helpers (calcNights/calcNet/showBanner) are allowed.
 */

let bannerTimer;

export function escHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function parseLocalDayStart(dateLike) {
  const key = String(dateLike || '').slice(0, 10);
  return key ? new Date(key + 'T00:00:00') : new Date('');
}

export function fmtShort(dateStr) {
  if (!dateStr) return '';
  const d = parseLocalDayStart(dateStr);
  return Number.isNaN(d.getTime()) ? String(dateStr).slice(0, 10) : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

export function fmt(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function isAwaitingCleanerResponse(clean, nowRef) {
  if (!clean) return false;
  if (!clean.cleaner && !clean.cleanerId) return false;
  if (clean.done || clean.cleanerDeclined || clean.cleanerConfirmed) return false;
  const now = nowRef instanceof Date ? nowRef : new Date();
  const assignedAt = clean.assignedAt ? new Date(clean.assignedAt) : null;
  const ageMs = assignedAt && !Number.isNaN(assignedAt.getTime()) ? (now.getTime() - assignedAt.getTime()) : 0;
  return ageMs >= 0;
}

export function getAwaitingResponseMeta(clean, nowRef) {
  const now = nowRef instanceof Date ? nowRef : new Date();
  const assignedAt = clean && clean.assignedAt ? new Date(clean.assignedAt) : null;
  const ageMs = assignedAt && !Number.isNaN(assignedAt.getTime()) ? Math.max(0, now.getTime() - assignedAt.getTime()) : 0;
  const ageHours = ageMs / 3600000;
  return {
    ageHours,
    isOverdue: ageHours >= 24,
    label: ageHours >= 24 ? `Awaiting ${Math.round(ageHours / 24)}d` : (ageHours >= 1 ? `Awaiting ${Math.round(ageHours)}h` : 'Awaiting reply')
  };
}

export function _normName(v) {
  return String(v || '').trim().toLowerCase();
}

/** For onclick="fn('…')" — single-quoted JS string inside double-quoted HTML attribute. */
export function escapeJsSingleQuotedHtmlAttr(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r\n|\r|\n/g, '\\n');
}

export function calcNights() {
  const ci = document.getElementById('b-checkin').value;
  const co = document.getElementById('b-checkout').value;
  if (ci && co) {
    const n = Math.ceil((new Date(co) - new Date(ci)) / 86400000);
    document.getElementById('b-nights').value = n > 0 ? n : '';
  }
}

export function calcNet() {
  const host = Number(document.getElementById('b-hostpayout').value) || 0;
  const clean = Number(document.getElementById('b-cleaningfee').value) || 0;
  const mgmtPct = Number(document.getElementById('b-mgmtfee').value) || 0;
  const mgmtAmt = Math.round((host - clean) * mgmtPct / 100 * 100) / 100;
  const net = Math.round((host - clean - mgmtAmt) * 100) / 100;
  const mgmtEl = document.getElementById('b-mgmtpayout');
  const netEl = document.getElementById('b-netpayout');
  if (mgmtEl) mgmtEl.value = mgmtPct ? '$' + mgmtAmt.toFixed(2) : '';
  if (netEl) netEl.value = host ? '$' + net.toFixed(2) : '';
}

export function fyLabel(fy) {
  return `FY ${fy}–${String(fy + 1).slice(2)}`;
}

export function fyMonths(fy) {
  return [6, 7, 8, 9, 10, 11, 0, 1, 2, 3, 4, 5].map(m => ({ year: m >= 6 ? fy : fy + 1, month: m }));
}

/** Toast UI only — main.js wraps with showBanner() to also call refreshConnectionSummarySoon(). */
export function showBannerToast(msg, type) {
  const banner = document.getElementById('sync-banner');
  const text = document.getElementById('sync-text');
  if (!banner || !text) return;

  const styles = {
    ok: { bg: '#2E7D32', ms: 3200 },
    success: { bg: '#2E7D32', ms: 3200 },
    info: { bg: '#2C4A3E', ms: 2600 },
    warn: { bg: '#B9652C', ms: 4600 },
    error: { bg: '#B24747', ms: 5200 }
  };
  const tone = styles[type] || styles.warn;

  banner.style.background = tone.bg;
  banner.style.display = 'flex';
  text.textContent = msg;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { banner.style.display = 'none'; }, tone.ms);
}
