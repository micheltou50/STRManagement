/**
 * Booking list row cards (single-property + portfolio). Avoids importing cleaning.js from property.js.
 */
import { cleans } from './state.js';
import { escHtml, escapeJsSingleQuotedHtmlAttr, fmtShort, _normName, localDateStr, getTurnoverTimes } from './utils.js';
import { bookingRevenue, bookingStatusLabel, getCancellationBillable, isBillableButMissingPayout, isPayoutPending } from './booking-revenue.js';

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

export function normalizePlatformLabel(platformRaw) {
  const p = String(platformRaw || '').trim().toLowerCase();
  if (p === 'airbnb') return 'Airbnb';
  if (p === 'vrbo') return 'Vrbo';
  if (p === 'booking.com' || p.includes('booking')) return 'Booking.com';
  if (p === 'direct') return 'Direct';
  if (p === 'agoda') return 'Agoda';
  if (p === 'expedia') return 'Expedia';
  if (p.includes('tripadvisor') || p.includes('trip advisor')) return 'TripAdvisor';
  if (!p) return 'Other';
  return platformRaw.charAt(0).toUpperCase() + platformRaw.slice(1);
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
  const label = normalizePlatformLabel(raw);
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

function getBookingListBookingStatusMeta(b, isCancelled, isPast) {
  if (isCancelled) return { label: 'Cancelled', color: '#A32D2D', bg: '#FCEBEB' };
  // Turnover-aware states. On the checkout/check-in day the badge also honours the
  // time of day (from getTurnoverTimes) so a guest reads "Checked out" once the
  // checkout time has passed, not "Checking out" all day.
  const GREY = { color: '#5F5E5A', bg: '#F1EFE8' };
  const AMBER = { color: '#854F0B', bg: '#FAEEDA' };
  const GREEN = { color: '#1D6E45', bg: '#E7F1E5' };
  const BLUE = { color: '#0C447C', bg: '#E6F1FB' };
  const now = new Date();
  const todayStr = localDateStr(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const co = String(b.checkout || '').slice(0, 10);
  const ci = String(b.checkin || '').slice(0, 10);
  const { checkoutHour, checkoutMin, checkinHour, checkinMin } = getTurnoverTimes(b);
  if (co && co < todayStr) return { label: 'Past', ...GREY };
  if (co && co === todayStr) {
    // Checkout day: still departing until the checkout time, then gone.
    return nowMin >= checkoutHour * 60 + checkoutMin
      ? { label: 'Checked out', ...GREY }
      : { label: 'Checking out', ...AMBER };
  }
  // Checkout is in the future — the guest is still staying.
  if (ci && ci === todayStr) {
    // Arriving today: "Checking in" until the check-in time, then in-house.
    return nowMin >= checkinHour * 60 + checkinMin
      ? { label: 'Hosting', ...GREEN }
      : { label: 'Checking in', ...GREEN };
  }
  if (ci && ci < todayStr) return { label: 'Hosting', ...GREEN };
  if (isPast) return { label: 'Past', ...GREY };
  return { label: 'Upcoming', ...BLUE };
}

const CARD_TOUCH = 'touch-action:manipulation;-webkit-tap-highlight-color:rgba(0,0,0,0.06)';

/**
 * @param {object} b booking
 * @param {{ portfolioStripeColor?: string, portfolioPropRowHtml?: string }} [options]
 */
// Map platform string → spec source rail token (airbnb | booking | vrbo | direct)
function _bookingSourceKey(platformRaw) {
  const p = String(platformRaw || '').trim().toLowerCase();
  if (p === 'airbnb') return 'airbnb';
  if (p === 'vrbo') return 'vrbo';
  if (p === 'booking.com' || p.includes('booking')) return 'booking';
  if (p === 'direct') return 'direct';
  return 'direct';
}

export function buildBookingListCardFromBooking(b, options = {}) {
  const { portfolioStripeColor, portfolioPropRowHtml } = options;
  const matchedClean = findMatchingCleanForBookingCard(b);
  const isCancelled = b.status === 'cancelled';
  const isPast = !isCancelled && new Date(b.checkout) < new Date();
  const isStub = String(b.enrichment_status || '').toLowerCase() === 'pending';
  const sourceKey = _bookingSourceKey(b.platform);
  const id = escapeJsSingleQuotedHtmlAttr(String(b._cloudId || b.id));
  const payout = bookingRevenue(b);

  const platformMeta = getBookingListPlatformPillMeta(b.platform);
  const bookStatus = getBookingListBookingStatusMeta(b, isCancelled, isPast);
  if (isCancelled && getCancellationBillable(b)) {
    bookStatus.label = bookingStatusLabel(b, isPast);
    bookStatus.color = '#166534';
    bookStatus.bg = '#DCFCE7';
  }
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
  const nameSpanStyle = 'font-weight:700;font-size:14.5px;color:var(--ink-1);font-family:\'Newsreader\',serif';
  const priceSpanStyle = isCancelled && !getCancellationBillable(b)
    ? 'font-weight:600;font-size:16px;color:var(--muted-2);text-decoration:line-through;font-family:\'Newsreader\',serif'
    : 'font-weight:600;font-size:16px;color:var(--ink-1);font-family:\'Newsreader\',serif';
  // Payout not yet captured — showing "$0" would read as "no revenue" when it's
  // really "amount not yet known". Two cases: a billable late-cancel never
  // enriched, or a CONFIRMED booking that arrived with no payout (payout_pending).
  const missingPayoutCancel = isBillableButMissingPayout(b);
  const pendingConfirmed = !isCancelled && isPayoutPending(b);
  const missingPayout = missingPayoutCancel || pendingConfirmed;
  const priceHtml = missingPayout
    ? `<span style="font-weight:600;font-size:12.5px;color:var(--warn,#b56a3a)" title="Host payout not yet captured from the confirmation email — verify on the platform">${missingPayoutCancel ? 'Billable · payout pending' : 'Payout pending'}</span>`
    : `<span style="${priceSpanStyle}">$${payout.toLocaleString()}</span>`;
  const row2Style = isCancelled
    ? 'font-size:12px;color:var(--muted-2);margin-top:2px;opacity:0.6'
    : 'font-size:12px;color:var(--muted-2);margin-top:2px';

  const platformPill = `<span style="font-size:11px;font-weight:600;padding:3px 10px;border-radius:999px;color:${platformMeta.color};background:${platformMeta.bg}">${escHtml(platformMeta.label)}</span>`;

  const bookBadge = `<span style="font-size:11px;font-weight:600;padding:3px 10px;border-radius:999px;color:${bookStatus.color};background:${bookStatus.bg}">${escHtml(bookStatus.label)}</span>`;

  const cleanerBadgeHtml =
    !isCancelled && cleanerMeta
      ? `<span style="font-size:11px;font-weight:600;padding:3px 10px;border-radius:999px;color:${cleanerMeta.color};background:${cleanerMeta.bg}">${escHtml(cleanerMeta.label)}</span>`
      : '';

  const row3LeftPills = isCancelled
    ? platformPill
    : `${platformPill}${cleanerBadgeHtml}`;

  const row3 = `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px"><div style="display:flex;gap:6px;align-items:center">${row3LeftPills}</div>${bookBadge}</div>`;

  const propBlock = portfolioPropRowHtml
    ? `<div style="margin-top:8px;display:block">${portfolioPropRowHtml}</div>`
    : '';

  // Source rails (5px inset shadow) live on `data-source` attr — class rule wins.
  // If a portfolio stripe is also requested, layer it as a 2nd shadow so both show.
  const outerStyle =
    'display:block;background:white;border-radius:16px;border:1px solid var(--hairline-1);padding:14px 16px 14px 22px;margin-bottom:8px;cursor:pointer;border-bottom:none;' +
    CARD_TOUCH +
    stripe;

  const cardClasses = [
    'booking-item', 'booking-card',
    isStub && 'is-stub',
    isCancelled && 'is-cancelled',
  ].filter(Boolean).join(' ');
  const stubBadge = isStub
    ? `<span class="stub-pulse" aria-hidden="true"></span><span style="font-size:11px;color:var(--warn,#b56a3a);font-style:italic;margin-left:4px">Stub from iCal · enrichment pending</span>`
    : '';

  return (
    `<div class="${cardClasses}" onclick="showDetail('${id}')" style="${outerStyle}" data-booking-id="${b.id}" data-source="${sourceKey}">` +
    `<div style="display:flex;justify-content:space-between;align-items:baseline${row1WrapOpacity}">` +
    `<span class="guest-name" style="${nameSpanStyle}"><span class="source-dot" aria-hidden="true"></span>${escHtml(b.name)}</span>` +
    priceHtml +
    `</div>` +
    `<div style="${row2Style}">${dateLine}</div>` +
    (isStub ? `<div style="margin-top:6px;display:flex;align-items:center">${stubBadge}</div>` : '') +
    propBlock +
    row3 +
    `</div>`
  );
}
