/**
 * Booking list row cards (single-property + portfolio). Avoids importing cleaning.js from property.js.
 */
import { cleans } from './state.js';
import { escHtml, escapeJsSingleQuotedHtmlAttr, fmtShort, _normName } from './utils.js';

function findMatchingCleanForBookingCard(booking) {
  if (!booking) return null;
  const byBookingId = cleans.find(
    c =>
      String(c.bookingId) === String(booking.id) ||
      (booking._cloudId && String(c.bookingId) === String(booking._cloudId))
  );
  if (byBookingId) return byBookingId;

  const targetDate = String(booking.checkout || '').slice(0, 10);
  const name = _normName(booking.name);
  if (name && targetDate) {
    const byGuestAndDate = cleans.find(
      c => _normName(c.guestName) === name && String(c.date || '').slice(0, 10) === targetDate
    );
    if (byGuestAndDate) return byGuestAndDate;
  }
  return null;
}

function getBookingListPlatformPillMeta(platformRaw) {
  const raw = String(platformRaw || '').trim();
  const p = raw.toLowerCase();
  let color;
  let bg;
  if (p === 'airbnb') {
    color = '#FF5A5F';
    bg = '#FFF0F0';
  } else if (p === 'vrbo' || p === 'booking.com' || p.includes('booking')) {
    color = '#3B5998';
    bg = '#EEF0FF';
  } else if (p === 'direct') {
    color = '#3D6B4F';
    bg = '#E8F5E9';
  } else {
    color = '#5F5E5A';
    bg = '#F1EFE8';
  }
  const label = raw || 'Other';
  return { label, color, bg };
}

function getBookingListCleanerBadgeMeta(booking, matchedClean) {
  if (!booking || booking.status === 'cancelled') return null;

  const bookingCleanerName = String(booking.cleaner || '').trim();
  const cleanCleanerName = String(matchedClean?.cleaner || '').trim();
  const hasCleanerName = !!(cleanCleanerName || bookingCleanerName);
  const hasAssignedOnClean = !!(matchedClean && (matchedClean.cleanerId || cleanCleanerName));

  const st = String(booking.status || '').toLowerCase();
  const done = !!(matchedClean?.done) || st === 'completed' || st === 'complete';

  const cleanerConfirmed = !!(matchedClean?.cleanerConfirmed || booking.cleanerConfirmed);
  const cleanerDeclined = !!(matchedClean?.cleanerDeclined || booking.cleanerDeclined);

  const C = {
    noCleaner: { color: '#A32D2D', bg: '#FCEBEB', label: 'No cleaner assigned' },
    awaiting: { color: '#BA7517', bg: '#FAEEDA', label: 'Awaiting cleaner' },
    confirmed: { color: '#1D9E75', bg: '#E8F5E9', label: 'Cleaner confirmed' },
    doneBadge: { color: '#5F5E5A', bg: '#F1EFE8', label: 'Clean done' },
  };

  if (done) return C.doneBadge;
  if (cleanerConfirmed) return C.confirmed;
  if (cleanerDeclined) return C.awaiting;
  if (matchedClean && hasAssignedOnClean) return C.awaiting;
  if (!matchedClean && !hasCleanerName) return C.noCleaner;
  if (!matchedClean && hasCleanerName) return C.awaiting;
  if (matchedClean && !hasAssignedOnClean) return C.noCleaner;
  return C.awaiting;
}

function getBookingListBookingStatusMeta(isCancelled, isPast) {
  if (isCancelled) return { label: 'Cancelled', color: '#A32D2D', bg: '#FCEBEB' };
  if (isPast) return { label: 'Past', color: '#5F5E5A', bg: '#F1EFE8' };
  return { label: 'Upcoming', color: '#0C447C', bg: '#E6F1FB' };
}

const CARD_TOUCH = 'touch-action:manipulation;-webkit-tap-highlight-color:rgba(0,0,0,0.06)';

/**
 * @param {object} b booking
 * @param {{ portfolioStripeColor?: string, portfolioPropRowHtml?: string }} [options]
 */
export function buildBookingListCardFromBooking(b, options = {}) {
  const { portfolioStripeColor, portfolioPropRowHtml } = options;
  const matchedClean = findMatchingCleanForBookingCard(b);
  const isCancelled = b.status === 'cancelled';
  const isPast = !isCancelled && new Date(b.checkout) < new Date();
  const id = escapeJsSingleQuotedHtmlAttr(String(b._cloudId || b.id));
  const payout = Number(b.hostPayout ?? b.total_price ?? 0);

  const platformMeta = getBookingListPlatformPillMeta(b.platform);
  const bookStatus = getBookingListBookingStatusMeta(isCancelled, isPast);
  const cleanerMeta = isCancelled ? null : getBookingListCleanerBadgeMeta(b, matchedClean);

  const dateLine =
    escHtml(fmtShort(b.checkin)) +
    ' - ' +
    escHtml(fmtShort(b.checkout)) +
    '  ·  ' +
    escHtml(String(b.guests)) +
    ' guests  ·  ' +
    escHtml(String(b.nights)) +
    ' night' +
    (b.nights !== 1 ? 's' : '');

  const stripe = portfolioStripeColor ? `box-shadow:inset 4px 0 0 ${portfolioStripeColor};` : '';

  const row1WrapOpacity = isCancelled ? ';opacity:0.6' : '';
  const nameSpanStyle = 'font-weight:500;font-size:15px;color:#1a1a1a';
  const priceSpanStyle = isCancelled
    ? 'font-weight:500;font-size:15px;color:#666;text-decoration:line-through'
    : 'font-weight:500;font-size:15px;color:#1D9E75';
  const row2Style = isCancelled
    ? 'font-size:13px;color:#666;margin-top:3px;opacity:0.6'
    : 'font-size:13px;color:#666;margin-top:3px';

  const platformPill = `<span style="font-size:11px;font-weight:500;padding:1px 7px;border-radius:4px;color:${platformMeta.color};background:${platformMeta.bg}">${escHtml(platformMeta.label)}</span>`;

  const bookBadge = `<span style="font-size:11px;font-weight:500;padding:2px 8px;border-radius:4px;color:${bookStatus.color};background:${bookStatus.bg}">${escHtml(bookStatus.label)}</span>`;

  const cleanerBadgeHtml =
    !isCancelled && cleanerMeta
      ? `<span style="font-size:12px;font-weight:500;padding:2px 8px;border-radius:4px;color:${cleanerMeta.color};background:${cleanerMeta.bg}">${escHtml(cleanerMeta.label)}</span>`
      : '';

  const row3LeftPills = isCancelled
    ? platformPill
    : `${platformPill}${cleanerBadgeHtml}`;

  const row3 = `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px"><div style="display:flex;gap:6px;align-items:center">${row3LeftPills}</div>${bookBadge}</div>`;

  const propBlock = portfolioPropRowHtml
    ? `<div style="margin-top:8px;display:block">${portfolioPropRowHtml}</div>`
    : '';

  const outerStyle =
    'display:block;background:white;border-radius:12px;border:0.5px solid rgba(0,0,0,0.1);padding:14px 16px;margin-bottom:10px;cursor:pointer;border-bottom:none;' +
    CARD_TOUCH +
    stripe;

  return (
    `<div class="booking-item" onclick="showDetail('${id}')" style="${outerStyle}" data-booking-id="${b.id}">` +
    `<div style="display:flex;justify-content:space-between;align-items:baseline${row1WrapOpacity}">` +
    `<span style="${nameSpanStyle}">${escHtml(b.name)}</span>` +
    `<span style="${priceSpanStyle}">$${payout.toLocaleString()}</span>` +
    `</div>` +
    `<div style="${row2Style}">${dateLine}</div>` +
    propBlock +
    row3 +
    `</div>`
  );
}
