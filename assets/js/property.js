/**
 * StayOps — property / portfolio UI (Pass 4).
 */
import {
  lsKey,
  getAllProperties,
  getActivePropertyId,
  setActivePropertyId,
  getActivePropertyConfig,
  getCurrentPropertyName,
  savePropertyConfig,
  initPropertyUI,
} from './config.js';
import { hydrateFromCloud } from './supabase.js';
import { bookings, cleans, expenses, replaceArrayInPlace } from './state.js';
import {
  escHtml,
  fmt,
  fmtShort,
  parseLocalDayStart,
  escapeJsSingleQuotedHtmlAttr,
  fyLabel,
} from './utils.js';

export let portfolioMode = false;
export let bookingFilter = 'upcoming';
export let propFilter = 'hub';

export function setBookingFilter(f) {
  bookingFilter = f;
}

export function setPortfolioMode(v) {
  portfolioMode = v;
}

let _expandedPortfolioCardIndex = null;

function togglePropertyDetail(cloudPid, cardIndex) {
  const detail = document.getElementById('portfolio-detail-' + cardIndex);
  const chevron = document.getElementById('portfolio-chevron-' + cardIndex);
  const cardHead = document.getElementById('portfolio-card-head-' + cardIndex);

  if (_expandedPortfolioCardIndex !== null && _expandedPortfolioCardIndex !== cardIndex) {
    const prevDetail = document.getElementById('portfolio-detail-' + _expandedPortfolioCardIndex);
    const prevChevron = document.getElementById('portfolio-chevron-' + _expandedPortfolioCardIndex);
    const prevHead = document.getElementById('portfolio-card-head-' + _expandedPortfolioCardIndex);
    if (prevDetail) prevDetail.style.display = 'none';
    if (prevChevron) prevChevron.style.transform = '';
    if (prevHead) prevHead.style.borderBottomRightRadius = '14px';
  }

  if (!detail) return;

  const isOpen = detail.style.display !== 'none';

  if (isOpen) {
    detail.style.display = 'none';
    if (chevron) chevron.style.transform = '';
    if (cardHead) cardHead.style.borderBottomRightRadius = '14px';
    _expandedPortfolioCardIndex = null;
  } else {
    detail.innerHTML = buildPropertyDetailContent(cloudPid);
    detail.style.display = 'block';
    if (chevron) chevron.style.transform = 'rotate(180deg)';
    if (cardHead) cardHead.style.borderBottomRightRadius = '0';
    _expandedPortfolioCardIndex = cardIndex;
  }
}

function viewPropertyBtn(cloudPid) {
  const props = typeof getAllProperties === 'function' ? getAllProperties() : [];
  const cloudIds = window._cloudPropertyIds || {};
  const match = props.find(p =>
    String(cloudIds[p.propertyId] || '') === String(cloudPid || '') ||
    String(p.supabaseId || '') === String(cloudPid || '') ||
    String(p.propertyId || '') === String(cloudPid || '')
  );
  const localId = match ? match.propertyId : cloudPid;

  return '<div style="margin-top:12px">' +
    '<button type="button" onclick="event.stopPropagation();switchPropertyFromSheet(\'' + escapeJsSingleQuotedHtmlAttr(localId ?? '') + '\')" ' +
      'style="width:100%;padding:10px;background:var(--forest,#1E3A2F);color:#fff;border:none;' +
      'border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;font-family:\'DM Sans\',sans-serif">' +
      'View property &#8594;' +
    '</button>' +
  '</div>';
}

function buildPropertyDetailContent(cloudPid) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const activeBookings = bookings.filter(b =>
    b.status !== 'cancelled' && String(b._propertyId || '') === String(cloudPid || '')
  );

  const current = activeBookings.find(b => {
    const ci = parseLocalDayStart(b.checkin);
    const co = parseLocalDayStart(b.checkout);
    return !Number.isNaN(ci.getTime()) && !Number.isNaN(co.getTime()) && ci <= todayStart && co > todayStart;
  });
  const checkoutToday = activeBookings.find(b =>
    b.checkout && String(b.checkout).slice(0, 10) === todayStr
  );
  const nextUpcoming = activeBookings
    .filter(b => parseLocalDayStart(b.checkin) > todayStart)
    .sort((a, b) => parseLocalDayStart(a.checkin) - parseLocalDayStart(b.checkin))[0];

  const booking = checkoutToday || current || nextUpcoming;

  if (!booking) {
    return '<div style="padding:8px 0;font-size:13px;color:var(--text-soft)">No upcoming bookings</div>' +
      viewPropertyBtn(cloudPid);
  }

  const isCurrentlyHosting = !!current && !checkoutToday;
  const label = isCurrentlyHosting ? 'Currently hosting' : checkoutToday ? 'Checking out today' : 'Next booking';

  const clean = cleans.find(c =>
    c.bookingId && (String(c.bookingId) === String(booking.id) || String(c.bookingId) === String(booking._cloudId))
  );
  const cleanLine = clean
    ? (clean.done
      ? '<span style="color:#1D9E75;font-weight:600">Done</span>'
      : clean.cleaner
        ? escHtml(clean.cleaner) + ' · <span style="color:' + (clean.cleanerConfirmed ? '#1D9E75' : '#BA7517') + ';font-weight:600">' + (clean.cleanerConfirmed ? 'Confirmed' : 'Awaiting') + '</span>'
        : '<span style="color:#C0392B;font-weight:600">Unassigned</span>')
    : '<span style="color:#C0392B;font-weight:600">No clean scheduled</span>';

  const row = (lbl, val) =>
    '<div style="display:flex;justify-content:space-between;gap:12px;padding:5px 0;font-size:13px">' +
      '<span style="color:var(--text-soft)">' + escHtml(lbl) + '</span>' +
      '<span style="font-weight:600;color:var(--text);text-align:right">' + val + '</span>' +
    '</div>';

  const plat = booking.platform ? String(booking.platform).trim() : '';
  const platDisp = plat ? plat.charAt(0).toUpperCase() + plat.slice(1).toLowerCase() : '';

  let body =
    '<div style="border-top:1px solid var(--warm,#F0EDE8);padding-top:10px">' +
      '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-soft);margin-bottom:6px">' + escHtml(label) + '</div>' +
      row('Guest', escHtml(booking.name)) +
      row('Check-in', escHtml(fmtShort(booking.checkin))) +
      row('Check-out', escHtml(fmtShort(booking.checkout))) +
      row('Nights', escHtml(String(booking.nights ?? ''))) +
      row('Guests', escHtml(String(booking.guests ?? ''))) +
      (booking.hostPayout != null && booking.hostPayout !== ''
        ? row('Payout', escHtml('$' + Number(booking.hostPayout).toLocaleString()))
        : '') +
      (platDisp ? row('Platform', escHtml(platDisp)) : '') +
      row('Clean', cleanLine) +
      (isCurrentlyHosting && nextUpcoming
        ? '<div style="border-top:1px solid var(--warm,#F0EDE8);margin-top:8px;padding-top:8px">' +
            '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-soft);margin-bottom:6px">Next booking</div>' +
            row('Guest', escHtml(nextUpcoming.name)) +
            row('Check-in', escHtml(fmtShort(nextUpcoming.checkin))) +
            row('Nights', escHtml(String(nextUpcoming.nights ?? ''))) +
          '</div>'
        : '') +
      viewPropertyBtn(cloudPid) +
    '</div>';

  return body;
}
window.buildPropertyDetailContent = buildPropertyDetailContent;

function renderPortfolioDashboard() {
  const singleDash = document.getElementById('dashboard-content');
  const portfolioDash = document.getElementById('portfolio-dashboard');
  if (singleDash) singleDash.style.display = 'none';
  if (!portfolioDash) return;
  portfolioDash.style.display = '';
  _expandedPortfolioCardIndex = null;

  const props = getAllProperties();
  const cloudIds = window._cloudPropertyIds || {};
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const activeBookings = bookings.filter(b => b.status !== 'cancelled');

  const pidFor = (p) => String(cloudIds[p.propertyId] || p.supabaseId || p.propertyId || '');
  const bookingsForProp = (pid) => activeBookings.filter(b => String(b._propertyId || '') === pid);

  const pair = (label, valueHtml, valueStyle) =>
    '<span style="font-size:12px;white-space:nowrap;flex-shrink:0">' + escHtml(label) + ' <span style="font-weight:700;font-size:12px;color:' + (valueStyle || 'var(--text,#1A1A1A)') + '">' + valueHtml + '</span></span>';

  const todayEndMs = todayStart.getTime() + 86400000;

  function portfolioCleanForBooking(b) {
    if (!b) return null;
    return cleans.find(c =>
      c.bookingId && (
        String(c.bookingId) === String(b.id) ||
        String(c.bookingId) === String(b._cloudId)
      )
    ) || null;
  }

  /** Vacant tonight / turnover context: not ready only when checkout is today or nobody is in house. */
  function portfolioNotReadyForProperty(propBookings, checkoutToday, currentGuest) {
    const nextCheckin = propBookings
      .filter(b => parseLocalDayStart(b.checkin) > todayStart)
      .sort((a, b) => parseLocalDayStart(a.checkin) - parseLocalDayStart(b.checkin))[0];
    if (!nextCheckin) return { isNotReady: false, urgencyLabel: '', daysUntilNextGuest: null };

    const lastCheckoutPool = propBookings.filter(b => {
      if (!b.checkout) return false;
      const co = parseLocalDayStart(b.checkout);
      return !Number.isNaN(co.getTime()) && co.getTime() < todayEndMs;
    });
    const lastCheckout = lastCheckoutPool.length
      ? [...lastCheckoutPool].sort((a, b) => parseLocalDayStart(b.checkout) - parseLocalDayStart(a.checkout))[0]
      : null;

    const betweenGuests = !!checkoutToday || !currentGuest;
    if (!betweenGuests) return { isNotReady: false, urgencyLabel: '', daysUntilNextGuest: null };

    const turnoverBooking = checkoutToday || lastCheckout;
    if (!turnoverBooking) return { isNotReady: false, urgencyLabel: '', daysUntilNextGuest: null };

    const lastClean = portfolioCleanForBooking(turnoverBooking);
    if (lastClean && lastClean.done) return { isNotReady: false, urgencyLabel: '', daysUntilNextGuest: null };

    const nextCi = parseLocalDayStart(nextCheckin.checkin);
    const daysUntilNextGuest = Number.isNaN(nextCi.getTime())
      ? 0
      : Math.ceil((nextCi.getTime() - todayStart.getTime()) / 86400000);

    let urgencyLabel = '';
    if (daysUntilNextGuest <= 0) urgencyLabel = 'Guest arriving today!';
    else if (daysUntilNextGuest === 1) urgencyLabel = 'Guest arriving tomorrow';
    else urgencyLabel = 'Guest arriving in ' + daysUntilNextGuest + ' days';

    return { isNotReady: true, urgencyLabel, daysUntilNextGuest, nextCheckin, turnoverBooking };
  }

  const statusCards = props.map((p, i) => {
    const colour = getPropertyColour(i);
    const pid = pidFor(p);
    const propBookings = pid ? bookingsForProp(pid) : [];
    const location = [p.suburb, p.state].filter(Boolean).join(', ');

    const checkoutToday = propBookings.find(b =>
      b.checkout && String(b.checkout).slice(0, 10) === todayStr
    );
    const currentGuest = propBookings.find(b => {
      const ci = parseLocalDayStart(b.checkin);
      const co = parseLocalDayStart(b.checkout);
      return !Number.isNaN(ci.getTime()) && !Number.isNaN(co.getTime()) && ci <= todayStart && co > todayStart;
    });
    const checkinToday = propBookings.find(b =>
      b.checkin && String(b.checkin).slice(0, 10) === todayStr
    );
    const nextBooking = propBookings
      .filter(b => parseLocalDayStart(b.checkin) > todayStart)
      .sort((a, b) => parseLocalDayStart(a.checkin) - parseLocalDayStart(b.checkin))[0];

    const notReadyState = portfolioNotReadyForProperty(propBookings, checkoutToday, currentGuest);
    const { isNotReady, urgencyLabel, daysUntilNextGuest } = notReadyState;

    let statusLabel, statusBg, statusTextColour, bottomRowHtml;

    if (checkoutToday) {
      statusLabel = 'Out today';
      statusBg = '#FAEEDA';
      statusTextColour = '#854F0B';
      const clean = cleans.find(c =>
        c.bookingId && (String(c.bookingId) === String(checkoutToday.id) || String(c.bookingId) === String(checkoutToday._cloudId))
      );
      const cleanLabel = clean && clean.cleaner ? 'Assigned' : 'Unassigned';
      const cleanColour = clean && clean.cleaner ? '#1D9E75' : '#C0392B';
      bottomRowHtml = pair('Guest', escHtml(checkoutToday.name))
        + pair('Clean', cleanLabel, cleanColour)
        + (nextBooking ? pair('Next', escHtml(fmtShort(nextBooking.checkin))) : '');
    } else if (currentGuest) {
      statusLabel = 'Occupied';
      statusBg = '#EAF3DE';
      statusTextColour = '#3B6D11';
      const clean = cleans.find(c =>
        c.bookingId && (String(c.bookingId) === String(currentGuest.id) || String(c.bookingId) === String(currentGuest._cloudId))
      );
      const cleanLabel = clean && clean.cleaner ? 'Assigned' : 'Unassigned';
      const cleanColour = clean && clean.cleaner ? '#1D9E75' : '#C0392B';
      bottomRowHtml = pair('Guest', escHtml(currentGuest.name))
        + pair('Checkout', escHtml(fmtShort(currentGuest.checkout)))
        + pair('Clean', cleanLabel, cleanColour);
    } else if (checkinToday) {
      statusLabel = 'In today';
      statusBg = '#E6F1FB';
      statusTextColour = '#185FA5';
      bottomRowHtml = pair('Guest', escHtml(checkinToday.name))
        + pair('Nights', escHtml(String(checkinToday.nights ?? '')))
        + pair('Guests', escHtml(String(checkinToday.guests ?? '')));
    } else {
      statusLabel = 'Vacant';
      statusBg = '#F1EFE8';
      statusTextColour = '#5F5E5A';
      bottomRowHtml = nextBooking
        ? pair('Next guest', escHtml(nextBooking.name))
          + pair('Checkin', escHtml(fmtShort(nextBooking.checkin)))
        : '<span style="font-size:12px;color:var(--text-soft,#6B6560);white-space:nowrap;flex-shrink:0">No upcoming bookings</span>';
    }

    if (isNotReady && daysUntilNextGuest !== null && daysUntilNextGuest <= 1) {
      statusLabel = 'Not ready';
      statusBg = '#FCEBEB';
      statusTextColour = '#A32D2D';
    }

    const notReadyHtml = isNotReady
      ? '<div style="margin-top:10px;background:#FCEBEB;border-radius:10px;padding:9px 12px;' +
          'display:flex;align-items:center;justify-content:space-between;gap:8px">' +
          '<div style="display:flex;align-items:center;gap:8px;min-width:0">' +
            '<div style="width:8px;height:8px;border-radius:50%;background:#E24B4A;flex-shrink:0"></div>' +
            '<span style="font-size:12px;font-weight:700;color:#A32D2D">Not ready — clean not done</span>' +
          '</div>' +
          '<span style="font-size:11px;font-weight:600;color:#A32D2D;flex-shrink:0;text-align:right">' + escHtml(urgencyLabel) + '</span>' +
        '</div>'
      : '';

    return '<div style="margin-bottom:0">' +
      '<div id="portfolio-card-head-' + i + '" onclick="togglePropertyDetail(\'' + escapeJsSingleQuotedHtmlAttr(pid) + '\', ' + i + ')" ' +
        'style="background:#fff;padding:14px 16px;border-left:4px solid ' + colour + ';' +
        'border-radius:0;border-top-right-radius:14px;border-bottom-right-radius:14px;cursor:pointer;' +
        'touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:background 0.15s">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">' +
          '<div style="min-width:0">' +
            '<div style="font-weight:700;font-size:15px;color:var(--text,#1A1A1A)">' + escHtml(p.name || p.propertyId) + '</div>' +
            '<div style="font-size:12px;color:var(--text-soft,#6B6560);margin-top:2px">' + escHtml(location || '—') + '</div>' +
          '</div>' +
          '<div style="background:' + statusBg + ';color:' + statusTextColour + ';font-size:12px;font-weight:700;padding:4px 12px;border-radius:20px;white-space:nowrap;flex-shrink:0">' + statusLabel + '</div>' +
        '</div>' +
        '<div style="border-top:1px solid var(--warm,#F0EDE8);margin:8px 0"></div>' +
        '<div style="display:flex;align-items:center;gap:14px;flex-wrap:nowrap;overflow:hidden;color:var(--text-soft,#6B6560)">' +
          '<div style="min-width:0;flex:1;overflow:hidden;display:flex;align-items:center;gap:14px;flex-wrap:nowrap">' +
            bottomRowHtml +
          '</div>' +
          '<div style="margin-left:auto;color:var(--stone,#C4BDB5);font-size:12px;flex-shrink:0;transition:transform 0.2s" ' +
            'id="portfolio-chevron-' + i + '">&#9662;</div>' +
        '</div>' +
        notReadyHtml +
      '</div>' +
      '<div id="portfolio-detail-' + i + '" style="display:none;background:#fff;border-left:4px solid ' + colour + ';' +
        'border-radius:0;border-bottom-right-radius:14px;padding:0 16px 14px;margin-top:-1px;overflow:hidden"></div>' +
    '</div>';
  }).join('');

  const thisMonth = now.getMonth();
  const thisYear = now.getFullYear();
  const daysInMonth = new Date(thisYear, thisMonth + 1, 0).getDate();
  const monthName = now.toLocaleString('en-AU', { month: 'long', year: 'numeric' });
  const monthStart = new Date(thisYear, thisMonth, 1);
  const monthEnd = new Date(thisYear, thisMonth + 1, 1);

  const calendarRows = props.map((p, i) => {
    const colour = getPropertyColour(i);
    const pid = pidFor(p);
    const propBookings = pid ? bookingsForProp(pid) : [];
    const shortName = (p.name || '??').slice(0, 2).toUpperCase();

    const bars = propBookings.map(b => {
      if (!b.checkin || !b.checkout) return '';
      const ci = parseLocalDayStart(b.checkin);
      const co = parseLocalDayStart(b.checkout);
      if (Number.isNaN(ci.getTime()) || Number.isNaN(co.getTime())) return '';
      if (co <= monthStart || ci >= monthEnd) return '';

      const startDay = Math.max(1, ci < monthStart ? 1 : ci.getDate());
      const endDay = Math.min(daysInMonth, co >= monthEnd ? daysInMonth : co.getDate());
      const leftPct = ((startDay - 1) / daysInMonth * 100).toFixed(1);
      const widthPct = ((endDay - startDay + 1) / daysInMonth * 100).toFixed(1);
      const parts = (b.name || '').trim().split(/\s+/);
      const guestShort = parts.length > 1 ? (parts[1] || parts[0]) : (parts[0] || '');

      const detailId = escapeJsSingleQuotedHtmlAttr(String(b._cloudId || b.id));
      return '<div onclick="event.stopPropagation();showDetail(\'' + detailId + '\')" ' +
        'style="cursor:pointer;min-width:20px;position:absolute;top:2px;bottom:2px;left:' + leftPct + '%;width:' + widthPct + '%;' +
        'background:' + colour + ';border-radius:3px;display:flex;align-items:center;padding:0 4px;overflow:hidden;touch-action:manipulation;-webkit-tap-highlight-color:transparent">' +
        '<span style="color:#fff;font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escHtml(guestShort) + '</span></div>';
    }).join('');

    return '<div style="display:flex;align-items:center;gap:4px;padding:4px 0">' +
        '<div style="width:6px;height:6px;border-radius:50%;background:' + colour + ';flex-shrink:0"></div>' +
        '<span style="color:#6B6560;font-size:11px;min-width:22px">' + escHtml(shortName) + '</span>' +
      '</div>' +
      '<div style="position:relative;height:22px;background:#F8F6F3;border-radius:4px;overflow:hidden">' + bars + '</div>';
  }).join('');

  const dateLabels = '<div></div><div style="display:flex;justify-content:space-between;padding:4px 0;color:#B4B2A9;font-size:9px">' +
    '<span>1</span><span>5</span><span>10</span><span>15</span><span>20</span><span>25</span><span>' + daysInMonth + '</span></div>';

  const next30 = new Date(todayStart);
  next30.setDate(next30.getDate() + 30);
  const upcomingBookings30 = activeBookings.filter(b => {
    const ci = parseLocalDayStart(b.checkin);
    return !Number.isNaN(ci.getTime()) && ci >= todayStart && ci < next30;
  });
  const revenue30 = upcomingBookings30.reduce((sum, b) => sum + Number(b.hostPayout || 0), 0);

  const thisMonthBookings = activeBookings.filter(b => {
    const ci = parseLocalDayStart(b.checkin);
    return !Number.isNaN(ci.getTime()) && ci >= monthStart && ci < monthEnd;
  });
  const revenueThisMonth = thisMonthBookings.reduce((sum, b) => sum + Number(b.hostPayout || 0), 0);

  let totalBookedNights = 0;
  props.forEach(p => {
    const pid = pidFor(p);
    const propBookings = pid ? bookingsForProp(pid) : [];
    propBookings.forEach(b => {
      if (!b.checkin || !b.checkout) return;
      const ci = new Date(Math.max(parseLocalDayStart(b.checkin).getTime(), monthStart.getTime()));
      const co = new Date(Math.min(parseLocalDayStart(b.checkout).getTime(), monthEnd.getTime()));
      if (co > ci) totalBookedNights += Math.round((co - ci) / 86400000);
    });
  });
  const avgOcc = props.length > 0
    ? Math.round((totalBookedNights / (daysInMonth * props.length)) * 100)
    : 0;

  const unassignedCleans = activeBookings.filter(b => {
    if (parseLocalDayStart(b.checkout) < todayStart) return false;
    const state = typeof globalThis.getBookingCleanerState === 'function'
      ? globalThis.getBookingCleanerState(b)
      : { key: 'pending', tone: 'warn', clean: null };
    return state.key === 'unassigned' || state.key === 'declined';
  });
  const unconfirmedBookings = activeBookings.filter(b => !!(b.propertyUnconfirmed || b.property_unconfirmed));

  const notReadyProps = [];
  props.forEach(p => {
    const pid = pidFor(p);
    const propBookings = pid ? bookingsForProp(pid) : [];
    const coToday = propBookings.find(b =>
      b.checkout && String(b.checkout).slice(0, 10) === todayStr
    );
    const curGuest = propBookings.find(b => {
      const ci = parseLocalDayStart(b.checkin);
      const co = parseLocalDayStart(b.checkout);
      return !Number.isNaN(ci.getTime()) && !Number.isNaN(co.getTime()) && ci <= todayStart && co > todayStart;
    });
    const st = portfolioNotReadyForProperty(propBookings, coToday, curGuest);
    if (st.isNotReady && st.nextCheckin) {
      notReadyProps.push({
        name: p.name || p.propertyId,
        localId: p.propertyId,
        daysUntil: st.daysUntilNextGuest,
        nextGuest: st.nextCheckin.name || '',
      });
    }
  });

  const hasUrgentNotReady = notReadyProps.some(nr => nr.daysUntil <= 0);
  const actionsBg = hasUrgentNotReady ? '#FCEBEB' : '#FEF3E2';
  const actionsBorder = hasUrgentNotReady ? '#E24B4A' : '#EF9F27';
  const actionsTextColour = hasUrgentNotReady ? '#A32D2D' : '#854F0B';
  const actionsLabelColour = hasUrgentNotReady ? '#791F1F' : '#854F0B';

  let actionsHtml = '';
  if (unassignedCleans.length || unconfirmedBookings.length || notReadyProps.length) {
    const actionLineStyle =
      'cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:rgba(0,0,0,0.06);' +
      'padding:8px 10px;margin:2px -10px 0;border-radius:8px;transition:background 0.15s;line-height:1.5';
    const actionItems = [];
    if (unassignedCleans.length) {
      const byLocal = {};
      unassignedCleans.forEach(b => {
        const lid = localPropertyIdFromCloudPropertyId(b._propertyId);
        if (!lid) return;
        byLocal[lid] = (byLocal[lid] || 0) + 1;
      });
      Object.entries(byLocal).forEach(([localId, count]) => {
        const name = getPropertyNameById(localId);
        actionItems.push({
          kind: 'cleaning',
          localId,
          label: count + ' unassigned clean' + (count > 1 ? 's' : '') + ' · ' + escHtml(name),
        });
      });
    }
    notReadyProps.forEach(nr => {
      const urgency = nr.daysUntil <= 0 ? 'TODAY' : nr.daysUntil === 1 ? 'TOMORROW' : 'in ' + nr.daysUntil + 'd';
      actionItems.push({
        kind: 'cleaning',
        localId: nr.localId,
        label: 'Not ready · ' + escHtml(nr.name) + ' · ' + escHtml(nr.nextGuest) + ' arrives ' + urgency,
      });
    });
    if (unconfirmedBookings.length) {
      actionItems.push({
        kind: 'bookings',
        label: unconfirmedBookings.length + ' booking' + (unconfirmedBookings.length > 1 ? 's' : '') + ' need property assignment',
      });
    }

    const actionsHeader =
      '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:' + actionsLabelColour + ';margin-bottom:5px">Actions needed</div>';
    const single = actionItems.length === 1;
    const singleItem = single ? actionItems[0] : null;

    let bodyInner;
    if (single && singleItem.kind === 'cleaning') {
      bodyInner = '<div style="font-size:12px;color:' + actionsTextColour + ';line-height:1.6">' + singleItem.label + '</div>';
    } else if (single && singleItem.kind === 'bookings') {
      bodyInner = '<div style="font-size:12px;color:' + actionsTextColour + ';line-height:1.6">' + singleItem.label + '</div>';
    } else {
      bodyInner = actionItems.map(item => {
        if (item.kind === 'cleaning' && item.localId) {
          return '<div role="button" onclick="jumpToPropertyCleaningAction(\'' + escapeJsSingleQuotedHtmlAttr(item.localId) + '\')" ' +
            'style="' + actionLineStyle + '">' + item.label + '</div>';
        }
        return '<div role="button" onclick="showSection(\'bookings\')" style="' + actionLineStyle + '">' + item.label + '</div>';
      }).join('');
    }

    const cardPadding = 'padding:12px 14px';
    const cardBaseStyle = 'background:' + actionsBg + ';border-radius:0;border-top-right-radius:12px;border-bottom-right-radius:12px;' +
      cardPadding + ';border-left:4px solid ' + actionsBorder + ';margin-top:14px';
    if (single && singleItem.kind === 'cleaning') {
      actionsHtml = '<div onclick="jumpToPropertyCleaningAction(\'' + escapeJsSingleQuotedHtmlAttr(singleItem.localId) + '\')" ' +
        'style="' + cardBaseStyle + ';cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:rgba(0,0,0,0.06)">' +
        actionsHeader + bodyInner + '</div>';
    } else if (single && singleItem.kind === 'bookings') {
      actionsHtml = '<div onclick="showSection(\'bookings\')" style="' + cardBaseStyle + ';cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:rgba(0,0,0,0.06)">' +
        actionsHeader + bodyInner + '</div>';
    } else {
      actionsHtml = '<div style="' + cardBaseStyle + '">' + actionsHeader +
        '<div style="font-size:12px;color:' + actionsTextColour + ';line-height:1.6">' + bodyInner + '</div></div>';
    }
  }

  portfolioDash.innerHTML =
    '<div style="padding:14px 14px 0">' +
      '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px">' + statusCards + '</div>' +
    '</div>' +
    '<div style="padding:0 14px">' +
      '<div style="background:#fff;border-radius:14px;padding:14px;margin-bottom:0">' +
        '<div style="font-size:13px;font-weight:700;color:#1A1A1A;margin-bottom:10px">' + escHtml(monthName) + '</div>' +
        '<div style="display:grid;grid-template-columns:40px 1fr;gap:0;align-items:center">' + calendarRows + dateLabels + '</div>' +
        '<div style="display:flex;justify-content:space-around;margin-top:10px;padding-top:10px;border-top:1px solid #F0EDE8">' +
          '<div onclick="showSection(\'finance\')" style="cursor:pointer;text-align:center;touch-action:manipulation;-webkit-tap-highlight-color:transparent">' +
            '<div style="font-size:18px;font-weight:700;color:#1E3A2F">' + avgOcc + '%</div><div style="font-size:10px;color:#6B6560;text-transform:uppercase;letter-spacing:0.3px">Avg occ.</div></div>' +
          '<div onclick="showSection(\'finance\')" style="cursor:pointer;text-align:center;touch-action:manipulation;-webkit-tap-highlight-color:transparent">' +
            '<div style="font-size:18px;font-weight:700;color:#1E3A2F">$' + Math.round(revenueThisMonth).toLocaleString() + '</div><div style="font-size:10px;color:#6B6560;text-transform:uppercase;letter-spacing:0.3px">This month</div></div>' +
          '<div onclick="showSection(\'finance\')" style="cursor:pointer;text-align:center;touch-action:manipulation;-webkit-tap-highlight-color:transparent">' +
            '<div style="font-size:18px;font-weight:700;color:#1E3A2F">$' + Math.round(revenue30).toLocaleString() + '</div><div style="font-size:10px;color:#6B6560;text-transform:uppercase;letter-spacing:0.3px">Next 30d</div></div>' +
        '</div>' +
      '</div>' +
    '</div>' +
    (actionsHtml ? '<div style="padding:0 14px 14px">' + actionsHtml + '</div>' : '');
}

function renderPortfolioBookings(filter) {
  if (filter) bookingFilter = filter;
  const list = document.getElementById('bookings-list');
  const notesView = document.getElementById('bookings-notes-view');
  if (notesView) notesView.style.display = bookingFilter === 'notes' ? '' : 'none';
  if (list) list.style.display = bookingFilter === 'notes' ? 'none' : '';
  if (bookingFilter === 'notes') { globalThis.renderNotes?.(); return; }

  const now = new Date();
  let filtered;
  if (bookingFilter === 'all') filtered = bookings.filter(b => b.status !== 'cancelled');
  else if (bookingFilter === 'upcoming') filtered = bookings.filter(b => b.status !== 'cancelled' && new Date(b.checkout) >= now);
  else if (bookingFilter === 'completed') filtered = bookings.filter(b => b.status !== 'cancelled' && new Date(b.checkout) < now);
  else if (bookingFilter === 'cancelled') filtered = bookings.filter(b => b.status === 'cancelled');
  else filtered = bookings.filter(b => b.status !== 'cancelled' && new Date(b.checkout) >= now);

  if (!filtered.length) {
    list.innerHTML = '<div class="card" style="text-align:center;padding:40px 24px 36px">' +
      '<div style="font-size:36px;margin-bottom:14px;opacity:0.45">📅</div>' +
      '<div style="font-weight:700;font-size:15px;color:var(--forest);margin-bottom:6px">No bookings found</div>' +
      '<div style="font-size:12.5px;color:var(--text-soft);line-height:1.5">Across all properties</div></div>';
    return;
  }

  const sorted = [...filtered].sort((a, b) => new Date(a.checkin) - new Date(b.checkin));
  const grouped = sorted.reduce((acc, b) => {
    const d = new Date(b.checkin || b.checkout || Date.now());
    const key = d.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
    if (!acc[key]) acc[key] = [];
    acc[key].push(b);
    return acc;
  }, {});

  list.innerHTML = Object.entries(grouped).map(([monthLabel, items]) => `
    <div style="margin-bottom:4px">
      <div style="font-size:11px;font-weight:700;color:var(--text-soft);text-transform:uppercase;letter-spacing:0.9px;padding:16px 4px 8px">${escHtml(monthLabel)}</div>
      ${items.map(b => {
        const isCancelled = b.status === 'cancelled';
        const isHosting = !isCancelled && new Date(b.checkin) <= new Date() && new Date(b.checkout) >= new Date();
        const isPast = !isCancelled && new Date(b.checkout) < new Date();
        const statusLabel = isCancelled ? '✕ Cancelled' : isHosting ? '🏡 Hosting' : isPast ? 'Past' : 'Upcoming';
        const colour = getPropertyColourById(b._propertyId);
        const propName = getPropertyNameById(b._propertyId);

        let cleanerRowHtml = '';
        if (!isCancelled && !isPast) {
          const cs = typeof globalThis.getBookingCleanerState === 'function'
            ? globalThis.getBookingCleanerState(b)
            : { key: 'pending', tone: 'warn', clean: null };
          const cleanerName = cs.clean ? escHtml(cs.clean.cleaner || 'Unknown') : 'Not assigned';
          const pillStyle = cs.tone === 'ok'
            ? 'background:#e8f4ed;color:#1a4f3a'
            : cs.tone === 'bad'
            ? 'background:#fef0f0;color:#993c1d'
            : 'background:#fef3e2;color:#854f0b';
          const pillLabel = cs.key === 'done' ? '✓ Done'
            : cs.key === 'confirmed' ? '✓ Confirmed'
            : cs.key === 'declined' ? '✕ Declined'
            : cs.key === 'pending' ? 'Awaiting reply'
            : '⚠ Needs assignment';
          cleanerRowHtml = '<div style="border-top:1px solid var(--warm);margin-top:8px;padding-top:7px;display:flex;align-items:center;gap:6px">' +
            '<span style="font-size:12px;opacity:0.7">🧹</span>' +
            '<span style="font-size:12px;color:var(--text-soft)">' + cleanerName + '</span>' +
            '<span style="font-size:11px;font-weight:600;padding:2px 7px;border-radius:20px;margin-left:auto;' + pillStyle + '">' + pillLabel + '</span></div>';
        }

        const propRow = '<div style="margin-top:6px;display:flex;align-items:center;gap:5px">' +
          '<div style="width:7px;height:7px;border-radius:50%;background:' + colour + ';flex-shrink:0"></div>' +
          '<span style="font-size:11px;color:var(--text-soft)">' + escHtml(propName) + '</span>' +
          (b.platform ? '<span style="font-size:11px;color:var(--stone)"> · </span><span style="font-size:11px;color:var(--text-soft)">' + escHtml(b.platform) + '</span>' : '') +
          '</div>';

        const detailId = escapeJsSingleQuotedHtmlAttr(String(b._cloudId || b.id));
        return '<div class="card" onclick="showDetail(\'' + detailId + '\')" ' +
          'style="cursor:pointer;border-left:3px solid ' + colour + ';border-radius:0;border-top-right-radius:12px;border-bottom-right-radius:12px' +
          (isCancelled ? ';opacity:0.6' : '') + '">' +
          '<div class="booking-item" style="border:none;padding:0">' +
            globalThis.platformIcon(b.platform, 42) +
            '<div class="booking-info">' +
              '<div class="booking-name">' + escHtml(b.name) + '</div>' +
              '<div class="booking-dates">' + escHtml(fmt(b.checkin)) + ' → ' + escHtml(fmt(b.checkout)) + '</div>' +
              '<div class="booking-guests">' + escHtml(b.guests) + ' guests · ' + escHtml(b.nights) + ' night' + (b.nights !== 1 ? 's' : '') + '</div>' +
            '</div>' +
            '<div class="booking-right">' +
              '<div class="booking-amount" style="' + (isCancelled ? 'text-decoration:line-through;color:var(--text-soft)' : '') + '">$' + Number(b.hostPayout || 0).toLocaleString() + '</div>' +
              '<div class="booking-status">' + statusLabel + '</div>' +
            '</div>' +
          '</div>' +
          propRow +
          cleanerRowHtml +
        '</div>';
      }).join('')}
    </div>`).join('');

  globalThis.animateList?.('#bookings-list');
  setTimeout(() => globalThis.attachLongPress?.(), 60);
}

function renderPortfolioFinance() {
  const singleFin = document.getElementById('finance-content');
  const portfolioFin = document.getElementById('portfolio-finance');
  if (singleFin) singleFin.style.display = 'none';
  if (!portfolioFin) return;
  portfolioFin.style.display = '';

  const now = new Date();
  const thisMonth = now.getMonth();
  const thisYear = now.getFullYear();
  const monthStart = new Date(thisYear, thisMonth, 1);
  const monthEnd = new Date(thisYear, thisMonth + 1, 1);
  const pad = n => String(n).padStart(2, '0');
  const monthStartStr = `${thisYear}-${pad(thisMonth + 1)}-01`;
  const nextM = thisMonth === 11 ? 0 : thisMonth + 1;
  const nextY = thisMonth === 11 ? thisYear + 1 : thisYear;
  const monthEndStr = `${nextY}-${pad(nextM + 1)}-01`;
  const monthName = now.toLocaleString('en-AU', { month: 'long', year: 'numeric' });

  const props = typeof getAllProperties === 'function' ? getAllProperties() : [];
  const cloudIds = window._cloudPropertyIds || {};
  const activeBookings = bookings.filter(b => b.status !== 'cancelled');

  let totalRevenue = 0, totalMgmt = 0, totalExpenses = 0;
  const perProp = props.map((p, i) => {
    const pid = cloudIds[p.propertyId] || p.supabaseId || p.propertyId;
    const colour = getPropertyColour(i);
    const propBookings = activeBookings.filter(b =>
      String(b._propertyId || '') === String(pid || '') && b.checkin &&
      new Date(b.checkin) >= monthStart && new Date(b.checkin) < monthEnd
    );
    const revenue = propBookings.reduce((sum, b) => sum + Number(b.hostPayout || 0), 0);
    const mgmt = propBookings.reduce((sum, b) => sum + Number(b.mgmtFee || 0), 0);
    const propExp = expenses.filter(e =>
      String(e._propertyId || '') === String(pid || '') && e.date && e.date >= monthStartStr && e.date < monthEndStr
    );
    const expTotal = propExp.reduce((sum, e) => sum + Number(e.amount || 0), 0);
    totalRevenue += revenue;
    totalMgmt += mgmt;
    totalExpenses += expTotal;
    return { name: p.name || p.propertyId, colour, revenue };
  });

  const totalOwner = totalRevenue - totalMgmt - totalExpenses;
  const maxRevenue = Math.max(...perProp.map(p => p.revenue), 1);

  const breakdownHtml = perProp.map(p =>
    '<div style="display:flex;align-items:center;gap:8px;font-size:12px">' +
      '<div style="width:7px;height:7px;border-radius:50%;background:' + p.colour + ';flex-shrink:0"></div>' +
      '<span style="color:var(--text);font-weight:600;min-width:90px">' + escHtml(p.name) + '</span>' +
      '<div style="flex:1;height:6px;background:var(--warm,#F0EDE8);border-radius:3px;overflow:hidden">' +
        '<div style="width:' + Math.round(p.revenue / maxRevenue * 100) + '%;height:100%;background:' + p.colour + ';border-radius:3px"></div>' +
      '</div>' +
      '<span style="font-weight:600;color:var(--text);min-width:50px;text-align:right">$' + Math.round(p.revenue).toLocaleString() + '</span>' +
    '</div>'
  ).join('');

  const recentExpenses = [...expenses]
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, 10);

  const expenseRows = recentExpenses.map(e => {
    const colour = getPropertyColourById(e._propertyId);
    const propName = getPropertyNameById(e._propertyId);
    return '<div style="padding:10px 14px;border-bottom:1px solid var(--warm);border-left:3px solid ' + colour + '">' +
      '<div style="display:flex;justify-content:space-between">' +
        '<div>' +
          '<div style="font-weight:600;font-size:13px">' + escHtml(e.description || e.category || 'Expense') + '</div>' +
          '<div style="font-size:11px;color:var(--text-soft);margin-top:2px">' + escHtml(fmt(e.date)) + ' · ' + escHtml(propName) + '</div>' +
        '</div>' +
        '<div style="font-weight:700;font-size:14px;color:var(--red)">-$' + Math.round(Number(e.amount || 0)).toLocaleString() + '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  const summaryCard = (label, value) =>
    '<div style="background:var(--mist,#F8F6F3);border-radius:10px;padding:12px;text-align:center">' +
      '<div style="font-size:22px;font-weight:700;color:var(--forest)">' + value + '</div>' +
      '<div style="font-size:10px;color:var(--text-soft);text-transform:uppercase;margin-top:2px">' + label + '</div></div>';

  portfolioFin.innerHTML =
    '<div style="background:#fff;border-radius:14px;padding:16px;margin-bottom:12px">' +
      '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-soft);margin-bottom:10px">' + escHtml(monthName) + ' · All properties</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">' +
        summaryCard('Revenue', '$' + Math.round(totalRevenue).toLocaleString()) +
        summaryCard('Mgmt fees', '$' + Math.round(totalMgmt).toLocaleString()) +
        summaryCard('Expenses', '$' + Math.round(totalExpenses).toLocaleString()) +
        summaryCard('Owner payout', '$' + Math.round(totalOwner).toLocaleString()) +
      '</div>' +
      '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-soft);margin-bottom:8px">Per property</div>' +
      '<div style="display:flex;flex-direction:column;gap:8px">' + breakdownHtml + '</div>' +
    '</div>' +
    (recentExpenses.length
      ? '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-soft);margin-bottom:8px;padding:0 4px">Recent expenses</div>' +
        '<div style="background:#fff;border-radius:14px;overflow:hidden">' + expenseRows + '</div>'
      : '');
}

function renderPropertySwitcher() {
  const select = document.getElementById('property-switcher-select');
  if (!select || typeof getAllProperties !== 'function') return;

  const props = getAllProperties();
  const activeId = getActivePropertyId();
  select.innerHTML = props.map(p =>
    '<option value="' + escHtml(p.propertyId) + '">' + escHtml(p.name || p.propertyId) + '</option>'
  ).join('');

  if (activeId) select.value = activeId;

  const active = getActivePropertyConfig();
  const activeNameEl = document.getElementById('active-property-name');
  if (activeNameEl) activeNameEl.textContent = active.name || 'Property';
}

function switchActiveProperty(id) {
  if (!id || typeof setActivePropertyId !== 'function') {
    console.warn('[StayOps] switchActiveProperty: missing id or setActivePropertyId', id);
    return;
  }
  const targetId = id;
  const current = getActivePropertyId();
  if (targetId === current) {
    console.log('[StayOps] switchActiveProperty: already active, refreshing UI only', targetId);
    sessionStorage.setItem('stayops-portfolio-mode', 'false');
    portfolioMode = false;
    console.log('[StayOps] switchPropertyFromSheet: calling reloadInMemoryData');
    globalThis.reloadInMemoryData?.();
    globalThis._normalizeBookingCleanState?.();
    initPropertyUI();
    console.log('[StayOps] switchPropertyFromSheet: calling renderAll/showSection');
    globalThis.renderAll?.();
    globalThis.applyStayopsPostSwitchAction?.();
    globalThis.showSection?.('today');
    return;
  }

  const ok = setActivePropertyId(targetId);
  if (!ok) {
    globalThis.showBanner?.('⚠ Could not switch property', 'warn');
    renderPropertySwitcher();
    return;
  }

  console.log('[StayOps] switchActiveProperty: active id after setActivePropertyId:', getActivePropertyId());

  sessionStorage.setItem('stayops-portfolio-mode', 'false');
  portfolioMode = false;

  const hadPostAction = sessionStorage.getItem('stayops-post-switch-action');

  // 1) Synchronous: localStorage + in-memory + full UI update immediately (do not wait on cloud).
  console.log('[StayOps] switchPropertyFromSheet: calling reloadInMemoryData');
  globalThis.reloadInMemoryData?.();
  globalThis._normalizeBookingCleanState?.();
  initPropertyUI();

  console.log('[StayOps] switchPropertyFromSheet: calling renderAll/showSection');
  globalThis.renderAll?.();
  globalThis.applyStayopsPostSwitchAction?.();
  if (!hadPostAction) globalThis.showSection?.('today');

  globalThis.showBanner?.('✓ Switched to ' + getCurrentPropertyName(), 'ok');

  // 2) Async: hydrate can race with other hydrates and briefly restore a stale active id in supabase.js;
  // re-apply targetId after hydrate, then refresh UI again without blocking step 1.
  (async function () {
    try {
      if (typeof hydrateFromCloud !== 'function') return;

      await hydrateFromCloud();

      const list = typeof getAllProperties === 'function' ? getAllProperties() : [];
      const stillValid = list.some(p => p.propertyId === targetId);
      const activeNow = getActivePropertyId();
      if (stillValid && activeNow !== targetId) {
        console.warn(
          '[StayOps] switchActiveProperty: active id drifted after hydrate (was',
          activeNow,
          'expected',
          targetId,
          ') — re-applying'
        );
        setActivePropertyId(targetId);
      }

      globalThis.reloadInMemoryData?.();
      globalThis._normalizeBookingCleanState?.();
      initPropertyUI();
      globalThis.renderAll?.();
    } catch (e) {
      console.warn('[StayOps] switchActiveProperty: post-switch hydrate failed (UI already updated)', e);
    }
  })();
}

/** Resolve config propertyId from a booking's Supabase property_id (or local id). */
function localPropertyIdFromCloudPropertyId(cloudPid) {
  const props = typeof getAllProperties === 'function' ? getAllProperties() : [];
  const cloudIds = window._cloudPropertyIds || {};
  const cid = String(cloudPid || '');
  const match = props.find(p =>
    String(cloudIds[p.propertyId] || p.supabaseId || p.propertyId || '') === cid
  );
  return match ? match.propertyId : '';
}

function jumpToPropertyCleaningAction(localId) {
  portfolioMode = false;
  sessionStorage.setItem('stayops-portfolio-mode', 'false');
  if (typeof getActivePropertyId === 'function' && getActivePropertyId() === localId) {
    globalThis.reloadInMemoryData?.();
    if (typeof initPropertyUI === 'function') initPropertyUI();
    globalThis.showSection?.('cleaning');
    globalThis.setCleanStatusFilter?.('all');
    globalThis.switchCleanView?.('pipeline');
    return;
  }
  sessionStorage.setItem('stayops-post-switch-action', 'cleaning-action');
  switchActiveProperty(localId);
}

function openPropertySettingsMenu() {
  globalThis.showSection?.('settings');
}


// ── PROPERTY SWITCHER (header) ─────────────────────────────────
let _propSwitcherOpenedAt = 0;
function openPropertySwitcherSheet() {
  console.log('[StayOps] openPropertySwitcherSheet called');
  const props = typeof getAllProperties === 'function' ? getAllProperties() : [];
  const activeId = getActivePropertyId();
  const list = document.getElementById('property-switcher-sheet-list');
  if (list) {
    list.style.display = 'flex';
    list.style.flexDirection = 'column';
    list.style.gap = '8px';
    list.style.padding = '0 16px';

    const sheetHeader = '<div style="padding:4px 20px 14px;display:flex;justify-content:space-between;align-items:center">' +
      '<div style="font-size:16px;font-weight:700;color:#1A1A1A">Switch property</div>' +
      '<div onclick="closePropertySwitcherSheet()" style="font-size:13px;color:#6B6560;cursor:pointer">Close</div>' +
      '</div>';

    const allPropsRow = props.length > 1
      ? '<div onclick="switchToPortfolioFromSheet()" style="background:' +
          (portfolioMode ? '#F0EDE8' : '#fff') +
          ';border:1.5px solid ' + (portfolioMode ? '#F0EDE8' : '#F0EDE8') +
          ';border-radius:14px;padding:14px 16px;cursor:pointer;display:flex;align-items:center;gap:14px">' +
          '<div style="width:40px;height:40px;border-radius:12px;background:#1E3A2F;display:flex;align-items:center;justify-content:center">' +
            '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="2" y="6" width="7" height="8" rx="1" fill="#8FAF85"/><rect x="11" y="4" width="7" height="10" rx="1" fill="#8FAF85"/><rect x="4" y="9" width="3" height="3" rx="0.5" fill="#1E3A2F"/><rect x="13" y="7" width="3" height="3" rx="0.5" fill="#1E3A2F"/></svg>' +
          '</div>' +
          '<div style="flex:1">' +
            '<div style="font-weight:700;font-size:15px;color:#1A1A1A">All properties</div>' +
            '<div style="font-size:12px;color:#6B6560;margin-top:1px">Portfolio overview</div>' +
          '</div>' +
          (portfolioMode
            ? '<div style="background:#1E3A2F;color:#fff;font-size:11px;font-weight:700;padding:4px 10px;border-radius:20px">Active</div>'
            : '') +
        '</div>'
      : '';

    const propRows = props.map((p, i) => {
      const isActive = !portfolioMode && p.propertyId === activeId;
      const colour = getPropertyColour(i);
      const initial = (p.name || '?').charAt(0).toUpperCase();
      const location = [p.suburb, p.state].filter(Boolean).join(', ');

      const tintBg = i === 0 ? '#E8F4ED' : i === 1 ? '#E6F1FB' : i === 2 ? '#FAEEDA' : '#FBEAF0';
      const tintText = i === 0 ? '#1E3A2F' : i === 1 ? '#185FA5' : i === 2 ? '#854F0B' : '#72243E';

      const cloudPid = (window._cloudPropertyIds && window._cloudPropertyIds[p.propertyId]) || p.supabaseId || '';
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const todayStr = now.toISOString().split('T')[0];
      const allBookings = typeof bookings !== 'undefined' ? bookings : [];
      const propBookings = allBookings.filter(b => b.status !== 'cancelled' && b._propertyId === cloudPid);
      const upcomingCount = propBookings.filter(b => new Date(b.checkout) >= now).length;

      const currentGuest = propBookings.find(b => new Date(b.checkin) <= todayStart && new Date(b.checkout) > todayStart);
      const checkoutToday = propBookings.find(b => b.checkout && b.checkout.slice(0, 10) === todayStr);

      let statusLabel; let statusBg; let statusColour;
      if (checkoutToday) {
        statusLabel = 'Out today'; statusBg = '#FAEEDA'; statusColour = '#854F0B';
      } else if (currentGuest) {
        statusLabel = 'Occupied'; statusBg = '#EAF3DE'; statusColour = '#3B6D11';
      } else {
        statusLabel = 'Vacant'; statusBg = '#F1EFE8'; statusColour = '#5F5E5A';
      }

      return '<div onclick="switchPropertyFromSheet(\'' + escapeJsSingleQuotedHtmlAttr(p.propertyId ?? '') + '\')" ' +
        'style="background:' + (isActive ? '#F8F6F3' : '#fff') +
        ';border:1.5px solid ' + (isActive ? colour : '#F0EDE8') +
        ';border-radius:14px;padding:14px 16px;cursor:pointer;display:flex;align-items:center;gap:14px">' +

        '<div style="width:40px;height:40px;border-radius:12px;background:' + tintBg +
          ';border-left:4px solid ' + colour +
          ';display:flex;align-items:center;justify-content:center">' +
          '<span style="font-size:14px;font-weight:700;color:' + tintText + '">' + initial + '</span>' +
        '</div>' +

        '<div style="flex:1">' +
          '<div style="font-weight:700;font-size:15px;color:#1A1A1A">' + escHtml(p.name || p.propertyId) + '</div>' +
          (location ? '<div style="font-size:12px;color:#6B6560;margin-top:1px">' + escHtml(location) + '</div>' : '') +
        '</div>' +

        (isActive
          ? '<div style="background:#1E3A2F;color:#fff;font-size:11px;font-weight:700;padding:4px 10px;border-radius:20px">Active</div>'
          : '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px">' +
              '<div style="background:' + statusBg + ';color:' + statusColour + ';font-size:11px;font-weight:600;padding:2px 8px;border-radius:12px">' + statusLabel + '</div>' +
              '<div style="font-size:11px;color:#6B6560">' + upcomingCount + ' booking' + (upcomingCount !== 1 ? 's' : '') + '</div>' +
            '</div>') +
      '</div>';
    }).join('');

    const addRow = '<div onclick="closePropertySwitcherSheet();openAddPropertySetup()" ' +
      'style="width:100%;padding:13px;background:#F8F6F3;border:1.5px dashed #D3D1C7;' +
      'border-radius:14px;text-align:center;cursor:pointer;display:flex;align-items:center;' +
      'justify-content:center;gap:8px;margin-top:4px">' +
      '<div style="width:22px;height:22px;border-radius:50%;background:#1E3A2F;color:#fff;' +
      'display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700">+</div>' +
      '<span style="font-size:14px;font-weight:600;color:#1E3A2F">Add property</span>' +
      '</div>';

    list.innerHTML = sheetHeader + allPropsRow + propRows + addRow;
  }
  const sheet = document.getElementById('property-switcher-sheet');
  if (!sheet) { console.error('[StayOps] property-switcher-sheet element not found'); return; }
  _propSwitcherOpenedAt = Date.now();
  sheet.style.display = 'flex';
  // Double rAF: first frame paints display:flex at opacity 0, second triggers transition.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      sheet.style.opacity = '1';
      const inner = sheet.querySelector(':scope > div');
      if (inner) inner.style.transform = 'translateY(0)';
    });
  });
  console.log('[StayOps] Sheet shown:', sheet.style.display);
}

/**
 * @param {boolean} [force] — if true, skip the ghost-click guard (e.g. user picked a property:
 *   closing must run immediately or the sheet stays on screen and looks like the switch failed).
 */
function closePropertySwitcherSheet(force) {
  // Guard against ghost-click: on mobile, a tap on the header button can fire
  // a second click event on the backdrop that now sits under the finger,
  // immediately closing the sheet. Ignore close requests within 350ms of open.
  if (!force && Date.now() - _propSwitcherOpenedAt < 350) return;
  const sheet = document.getElementById('property-switcher-sheet');
  if (!sheet) return;
  sheet.style.opacity = '0';
  const inner = sheet.querySelector(':scope > div');
  if (inner) inner.style.transform = 'translateY(100%)';
  setTimeout(() => { if (sheet) sheet.style.display = 'none'; }, 300);
}

function switchToPortfolioFromSheet() {
  closePropertySwitcherSheet();
  sessionStorage.setItem('stayops-portfolio-mode', 'true');
  enterPortfolioMode();
}

function switchPropertyFromSheet(id) {
  console.log('[StayOps] switchPropertyFromSheet called with:', id);
  // Force close so the 350ms ghost-click guard cannot leave the sheet open over the new view.
  closePropertySwitcherSheet(true);
  console.log('[StayOps] switchPropertyFromSheet: closed switcher sheet (forced)');
  sessionStorage.setItem('stayops-portfolio-mode', 'false');
  if (portfolioMode) {
    console.log('[StayOps] switchPropertyFromSheet: exiting portfolio mode before switch');
    exitPortfolioMode();
  }
  console.log('[StayOps] switchPropertyFromSheet: setting active property to', id);
  if (typeof switchActiveProperty === 'function') switchActiveProperty(id);
  console.log('[StayOps] switchPropertyFromSheet: switchActiveProperty returned (sync part complete)');
}

// ── PROPERTY HUB NAVIGATION ───────────────────────────────────────────────

/** Show the top-level Property hub (called on tab entry and back-nav) */
function backToPropertyHub() {
  propFilter = 'hub';
  if (isPortfolioMode()) {
    renderPortfolioPropertyTab();
    return;
  }
  const portV = document.getElementById('portfolio-property-view');
  if (portV) { portV.style.display = 'none'; portV.innerHTML = ''; }
  const hub = document.getElementById('prop-hub');
  if (hub) hub.style.display = 'block';
  ['expenses', 'maintenance', 'inventory'].forEach(s => {
    const el = document.getElementById('prop-' + s);
    if (el) el.style.display = 'none';
  });
}

/** Navigate into a Property sub-panel (Maintenance or Inventory) */
function showPropertySub(f) {
  if (isPortfolioMode()) return;
  propFilter = f;
  const hub = document.getElementById('prop-hub');
  if (hub) hub.style.display = 'none';
  ['expenses', 'maintenance', 'inventory'].forEach(s => {
    const el = document.getElementById('prop-' + s);
    if (el) el.style.display = s === f ? 'block' : 'none';
  });
  renderProperty();
}

/**
 * filterProperty — kept for backward-compat with any external deep-links.
 * Internal callers now use showPropertySub() directly.
 */
function filterProperty(f, btn) {
  showPropertySub(f);
}

function renderPortfolioPropertyTab() {
  const container = document.getElementById('portfolio-property-view');
  if (!container) return;
  const hub = document.getElementById('prop-hub');
  if (hub) hub.style.display = 'none';
  ['expenses', 'maintenance', 'inventory'].forEach(s => {
    const el = document.getElementById('prop-' + s);
    if (el) el.style.display = 'none';
  });
  container.style.display = '';

  const props = typeof getAllProperties === 'function' ? getAllProperties() : [];
  const cloudIds = window._cloudPropertyIds || {};
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayStr = now.toISOString().split('T')[0];
  const thisMonth = now.getMonth();
  const thisYear = now.getFullYear();
  const daysInMonth = new Date(thisYear, thisMonth + 1, 0).getDate();
  const monthStart = new Date(thisYear, thisMonth, 1);
  const monthEnd = new Date(thisYear, thisMonth + 1, 1);
  const activeBookings = bookings.filter(b => b.status !== 'cancelled');

  const cards = props.map((p, i) => {
    const colour = getPropertyColour(i);
    const pid = cloudIds[p.propertyId] || p.supabaseId || p.propertyId;
    const propBookings = activeBookings.filter(b => String(b._propertyId || '') === String(pid || ''));
    const stats = p.property || {};

    const currentGuest = propBookings.find(b =>
      new Date(b.checkin) <= todayStart && new Date(b.checkout) > todayStart
    );
    const checkoutToday = propBookings.find(b =>
      b.checkout && b.checkout.slice(0, 10) === todayStr
    );
    let statusLabel, statusBg, statusColour;
    if (checkoutToday) {
      statusLabel = 'Out today'; statusBg = '#FAEEDA'; statusColour = '#854F0B';
    } else if (currentGuest) {
      statusLabel = 'Occupied'; statusBg = '#EAF3DE'; statusColour = '#3B6D11';
    } else {
      statusLabel = 'Vacant'; statusBg = '#F1EFE8'; statusColour = '#5F5E5A';
    }

    let bookedNights = 0;
    propBookings.forEach(b => {
      if (!b.checkin || !b.checkout) return;
      const ci = new Date(Math.max(new Date(b.checkin).getTime(), monthStart.getTime()));
      const co = new Date(Math.min(new Date(b.checkout).getTime(), monthEnd.getTime()));
      if (co > ci) bookedNights += Math.round((co - ci) / 86400000);
    });
    const occ = Math.round((bookedNights / daysInMonth) * 100);

    const tagline = (p.branding && p.branding.tagline)
      ? p.branding.tagline
      : [p.suburb, p.state].filter(Boolean).join(', ');

    // Single-quoted JS string inside onclick="..." — do NOT use JSON.stringify here (it adds
    // double quotes and breaks the HTML attribute, so the handler never runs).
    return '<div onclick="switchPropertyFromSheet(\'' + escapeJsSingleQuotedHtmlAttr(String(p.propertyId ?? '')) + '\')" ' +
      'style="background:#fff;padding:16px;border-left:4px solid ' + colour + ';' +
      'border-radius:0;border-top-right-radius:14px;border-bottom-right-radius:14px;cursor:pointer">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">' +
        '<div>' +
          '<div style="font-weight:700;font-size:16px;color:var(--text)">' + escHtml(p.name || p.propertyId) + '</div>' +
          '<div style="font-size:12px;color:var(--text-soft)">' + escHtml(tagline) + '</div>' +
        '</div>' +
        '<div style="background:' + statusBg + ';color:' + statusColour + ';font-size:11px;font-weight:700;padding:3px 9px;border-radius:20px">' + statusLabel + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:16px;font-size:12px;color:var(--text-soft);border-top:1px solid var(--warm);padding-top:8px">' +
        '<span>' + (stats.bedrooms || '?') + ' bed</span>' +
        '<span>' + (stats.maxGuests || '?') + ' guests</span>' +
        '<span>' + (stats.bathrooms || '?') + ' bath</span>' +
        '<span style="font-weight:600;color:var(--forest)">' + occ + '% occ.</span>' +
      '</div>' +
    '</div>';
  }).join('');

  const addBtn = '<div style="text-align:center;padding:16px 0 4px">' +
    '<div onclick="closePropertySwitcherSheet();openAddPropertySetup()" ' +
    'style="display:inline-flex;align-items:center;gap:8px;background:var(--forest);color:#fff;' +
    'padding:12px 20px;border-radius:12px;font-size:14px;font-weight:700;cursor:pointer">+ Add property</div></div>';

  container.innerHTML =
    '<div style="padding:14px">' +
      '<div style="display:flex;flex-direction:column;gap:8px">' + cards + '</div>' +
      addBtn +
    '</div>';
}

function renderProperty() {
  if (isPortfolioMode()) {
    renderPortfolioPropertyTab();
    return;
  }
  const portV = document.getElementById('portfolio-property-view');
  if (portV) { portV.style.display = 'none'; portV.innerHTML = ''; }
  const hub = document.getElementById('prop-hub');
  if (propFilter === 'hub' && hub) hub.style.display = 'block';

  // expenses moved to Finance tab — only maintenance and inventory remain in Property
  if (propFilter === 'maintenance') { globalThis.renderMaintenance?.(); globalThis.populateContractorSelect?.(); }
  if (propFilter === 'inventory')   globalThis.renderInventory?.();
}

/** UI-only placeholder — Access & Rules screen to be built in a later step */
function openPropertyAccessRules() {
  globalThis.showBanner?.('Access & Rules — coming soon', 'info');
}

/**
 * Open Property Details from the Property hub.
 * Passes returnSection='property' so the back button returns to Property, not Settings.
 */
function openPropertyDetailsFromHub() {
  globalThis.openSettingsCat?.('property', 'property');
}

/**
 * Open Owner Reports panel from the Property hub.
 * Passes returnSection='property' so the back button returns to Property, not Settings.
 */
function openOwnerReportFromHub() {
  globalThis.openSettingsPanel?.('owner-report', 'property');
}

const PROPERTY_COLOURS = ['#1E3A2F', '#378ADD', '#EF9F27', '#D4537E', '#534AB7', '#1D9E75', '#D85A30', '#639922'];

function getPropertyColour(index) {
  return PROPERTY_COLOURS[index % PROPERTY_COLOURS.length];
}

function getPropertyColourById(propertyId) {
  const props = typeof getAllProperties === 'function' ? getAllProperties() : [];
  const cloudIds = window._cloudPropertyIds || {};
  const idx = props.findIndex(p =>
    cloudIds[p.propertyId] === propertyId || p.supabaseId === propertyId || p.propertyId === propertyId
  );
  return getPropertyColour(idx >= 0 ? idx : 0);
}

function getPropertyNameById(propertyId) {
  const props = typeof getAllProperties === 'function' ? getAllProperties() : [];
  const cloudIds = window._cloudPropertyIds || {};
  const match = props.find(p =>
    cloudIds[p.propertyId] === propertyId || p.supabaseId === propertyId || p.propertyId === propertyId
  );
  return match ? (match.name || match.propertyId) : 'Unknown';
}

function isPortfolioMode() {
  return portfolioMode && typeof getAllProperties === 'function' && getAllProperties().length > 1;
}

async function loadPortfolioData() {
  if (!window._sb || !window._supabaseUser) return;
  const uid = window._supabaseUser.id;

  try {
    const { data: allBookings } = await window._sb
      .from('bookings')
      .select('*')
      .eq('user_id', uid)
      .order('checkin', { ascending: true });

    if (allBookings) {
      replaceArrayInPlace(bookings, allBookings.map(b => ({
        id:               b.local_id ? (isNaN(Number(b.local_id)) ? b.local_id : Number(b.local_id)) : b.id,
        _cloudId:         b.id,
        _propertyId:      b.property_id,
        checkin:          b.checkin   || '',
        checkout:         b.checkout  || '',
        nights:           b.nights    || 0,
        name:             b.guest_name || '',
        guests:           b.guests    || 1,
        hostPayout:       b.host_payout  || 0,
        cleaningFee:      b.cleaning_fee || 0,
        mgmtFee:          b.mgmt_fee     || 0,
        mgmtFeeRaw:       b.mgmt_fee_raw || 0,
        mgmtPayout:       b.mgmt_payout  || 0,
        netPayout:        b.net_payout   || 0,
        platform:         b.platform     || '',
        confirmCode:      b.confirmation_code || '',
        status:           b.status       || 'confirmed',
        cleanerConfirmed: b.cleaner_confirmed || false,
        source:           b.source        || 'sheet',
        phone:            b.phone         || '',
        email:            b.email         || '',
        propertyUnconfirmed: !!b.property_unconfirmed,
      })));
    }

    const { data: allCleans } = await window._sb
      .from('cleans')
      .select('*')
      .eq('user_id', uid)
      .order('clean_date', { ascending: true });

    if (allCleans) {
      replaceArrayInPlace(cleans, allCleans.map(c => ({
        id:               c.local_id ? Number(c.local_id) || c.local_id : c.id,
        _cloudId:         c.id,
        _propertyId:      c.property_id,
        bookingId:        c.booking_id   || '',
        guestName:        c.guest_name   || '',
        cleaner:          c.cleaner      || '',
        cleanerId:        c.cleaner_id   || '',
        date:             c.clean_date   || '',
        done:             c.done         || false,
        cleanerConfirmed: c.cleaner_confirmed || false,
        cleanerDeclined:  c.cleaner_declined  || false,
        notified:         c.notified     || false,
        reminderSent:     c.reminder_sent || false,
        assignedAt:       c.assigned_at  || null,
        confirmedAt:      c.confirmed_at || null,
        notes:            c.notes        || '',
      })));
    }

    const { data: allExpenses } = await window._sb
      .from('expenses')
      .select('*')
      .eq('user_id', uid)
      .order('date', { ascending: false });

    if (allExpenses) {
      replaceArrayInPlace(expenses, allExpenses.map(e => ({
        id:          e.local_id ? Number(e.local_id) || e.local_id : e.id,
        _cloudId:    e.id,
        _propertyId: e.property_id,
        date:        e.date        || '',
        merchant:    e.merchant    || '',
        description: e.description || '',
        category:    e.category    || '',
        amount:      e.amount      || 0,
        receiptNum:  e.receipt_num  || '',
        receiptType: e.receipt_type || '',
        driveLink:   e.drive_link   || '',
        photo:       null,
      })));
    }

    globalThis._normalizeBookingCleanState?.();
  } catch (e) {
    console.warn('[StayOps] loadPortfolioData failed', e);
    throw e;
  }
}

async function enterPortfolioMode() {
  if (typeof getAllProperties !== 'function' || getAllProperties().length < 2) return;
  portfolioMode = true;
  sessionStorage.setItem('stayops-portfolio-mode', 'true');
  try {
    await loadPortfolioData();
    initPropertyUI();
    globalThis.renderAll?.();
  } catch (e) {
    console.warn('[StayOps] enterPortfolioMode: portfolio load failed', e);
    portfolioMode = false;
    globalThis.reloadInMemoryData?.();
    initPropertyUI();
    globalThis.renderAll?.();
  }
}

function exitPortfolioMode() {
  portfolioMode = false;
  sessionStorage.setItem('stayops-portfolio-mode', 'false');
  globalThis.reloadInMemoryData?.();
  initPropertyUI();
  globalThis.renderAll?.();
}

function showPropertyPicker({ guest, checkin, checkout, platform, properties }) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10001;display:flex;align-items:flex-end;justify-content:center;padding:0;opacity:0;transition:opacity 0.2s';

    const platformLabel = platform
      ? ' · ' + platform.charAt(0).toUpperCase() + platform.slice(1) : '';
    const dateLabel = checkin && checkout
      ? new Date(checkin + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) +
        ' → ' +
        new Date(checkout + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
      : '';

    const sheet = document.createElement('div');
    sheet.style.cssText = 'width:100%;max-width:440px;background:#fff;border-radius:20px 20px 0 0;' +
      'padding:20px 20px calc(20px + env(safe-area-inset-bottom,0));' +
      'transform:translateY(20px);transition:transform 0.25s ease';

    sheet.innerHTML =
      '<div style="width:36px;height:4px;background:var(--stone,#C4BDB5);border-radius:2px;margin:0 auto 16px"></div>' +
      '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-soft,#6B6560);margin-bottom:6px">Which property is this booking for?</div>' +
      '<div style="font-size:16px;font-weight:700;color:var(--text,#1A1A1A);margin-bottom:4px">' +
        escHtml(guest) + platformLabel + '</div>' +
      (dateLabel ? '<div style="font-size:13px;color:var(--text-soft);margin-bottom:16px">' + dateLabel + '</div>' : '') +
      '<div id="prop-picker-list" style="display:flex;flex-direction:column;gap:8px"></div>' +
      '<button id="prop-picker-skip" style="width:100%;margin-top:12px;padding:12px;' +
        'border:1.5px solid var(--stone,#C4BDB5);border-radius:12px;background:white;' +
        'font-size:14px;font-weight:600;color:var(--text-soft);cursor:pointer;' +
        'font-family:\'DM Sans\',sans-serif">Skip — assign later</button>';

    overlay.appendChild(sheet);

    const dismiss = (value) => {
      overlay.style.opacity = '0';
      sheet.style.transform = 'translateY(20px)';
      setTimeout(() => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 250);
      resolve(value);
    };

    const listEl = sheet.querySelector('#prop-picker-list');
    properties.forEach(p => {
      const btn = document.createElement('button');
      btn.style.cssText = 'width:100%;text-align:left;padding:14px 16px;' +
        'border:1.5px solid var(--warm,#F0EDE8);border-radius:12px;' +
        'background:var(--mist,#F8F6F3);cursor:pointer;' +
        'font-family:\'DM Sans\',sans-serif;transition:border-color 0.15s';
      btn.innerHTML =
        '<div style="font-weight:700;font-size:14px;color:var(--forest,#1E3A2F)">' +
          escHtml(p.name) + '</div>' +
        (p.subtitle
          ? '<div style="font-size:12px;color:var(--text-soft);margin-top:2px">' +
              escHtml(p.subtitle) + '</div>'
          : '');
      btn.addEventListener('click', () => dismiss(p.id));
      listEl.appendChild(btn);
    });

    sheet.querySelector('#prop-picker-skip').addEventListener('click', () => dismiss(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(null); });

    document.body.appendChild(overlay);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      overlay.style.opacity = '1';
      sheet.style.transform = 'translateY(0)';
    }));
  });
}

function _ownerReportSetVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}

function _updateOwnerReportToggleUI(on) {
  const track = document.getElementById('owner-autosend-toggle');
  const thumb = document.getElementById('owner-autosend-thumb');
  if (track) track.style.background = on ? 'var(--forest, #1E3A2F)' : 'var(--border, #C7C7CC)';
  if (thumb) thumb.style.transform  = on ? 'translateX(18px)' : 'translateX(0)';
}

function populateOwnerReportPanel() {
  const cfg = getActivePropertyConfig();
  const owner = cfg.owner || {};

  _ownerReportSetVal('owner-report-name',    owner.name  || '');
  _ownerReportSetVal('owner-report-email',   owner.email || '');
  _ownerReportSetVal('owner-report-phone',   owner.phone || '');
  _ownerReportSetVal('owner-report-subject', owner.reportEmailSubject || '');
  _ownerReportSetVal('owner-report-body',    owner.reportEmailBody    || '');

  // Set state on the plain-div toggle (no checkbox)
  window._ownerAutoSend = !!owner.autoSendReport;
  _updateOwnerReportToggleUI(window._ownerAutoSend);

  const freqEl = document.getElementById('owner-report-frequency');
  if (freqEl) freqEl.value = owner.reportFrequency || 'monthly';

  // Last-sent label
  const lastSentEl = document.getElementById('owner-report-last-sent-row');
  if (lastSentEl) {
    if (owner.lastReportSentAt) {
      const d = new Date(owner.lastReportSentAt);
      lastSentEl.textContent = 'Last sent: ' + d.toLocaleDateString('en-AU', { day:'numeric', month:'short', year:'numeric' });
    } else {
      lastSentEl.textContent = 'No report sent yet.';
    }
  }

  // Populate FY picker
  const fyEl = document.getElementById('owner-report-send-fy');
  if (fyEl) {
    const now = new Date();
    const currentFY = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
    fyEl.innerHTML = '';
    for (let fy = currentFY; fy >= currentFY - 4; fy--) {
      const opt = document.createElement('option');
      opt.value = fy;
      opt.textContent = fyLabel(fy);
      fyEl.appendChild(opt);
    }
    fyEl.value = currentFY;
  }

}

async function applyPortfolioModeAfterHostHydrate() {
  const storedPortfolioChoice = sessionStorage.getItem('stayops-portfolio-mode');
  sessionStorage.removeItem('stayops-portfolio-mode');
  const hasMultipleProperties = typeof getAllProperties === 'function' && getAllProperties().length > 1;
  console.log('[StayOps] Portfolio check:', {
    hasMultipleProperties,
    storedPortfolioChoice,
    propCount: typeof getAllProperties === 'function' ? getAllProperties().length : 'N/A',
    willEnterPortfolio: hasMultipleProperties && storedPortfolioChoice !== 'false'
  });
  if (hasMultipleProperties && storedPortfolioChoice !== 'false') {
    portfolioMode = true;
    try {
      await loadPortfolioData();
      initPropertyUI();
      globalThis.renderAll?.();
    } catch (e) {
      console.warn('[StayOps] Portfolio auto-load failed, falling back to single property', e);
      portfolioMode = false;
      globalThis.reloadInMemoryData?.();
      initPropertyUI();
    }
  }
}

export {
  togglePropertyDetail,
  viewPropertyBtn,
  buildPropertyDetailContent,
  renderPortfolioDashboard,
  renderPortfolioBookings,
  renderPortfolioFinance,
  renderPropertySwitcher,
  switchActiveProperty,
  localPropertyIdFromCloudPropertyId,
  jumpToPropertyCleaningAction,
  openPropertySettingsMenu,
  openPropertySwitcherSheet,
  closePropertySwitcherSheet,
  switchToPortfolioFromSheet,
  switchPropertyFromSheet,
  backToPropertyHub,
  showPropertySub,
  filterProperty,
  renderPortfolioPropertyTab,
  renderProperty,
  openPropertyAccessRules,
  openPropertyDetailsFromHub,
  openOwnerReportFromHub,
  getPropertyColour,
  getPropertyColourById,
  getPropertyNameById,
  isPortfolioMode,
  loadPortfolioData,
  enterPortfolioMode,
  exitPortfolioMode,
  showPropertyPicker,
  populateOwnerReportPanel,
  applyPortfolioModeAfterHostHydrate,
};

// ── window bridges (HTML onclick + legacy callers) ─────────────────────────
window.togglePropertyDetail = togglePropertyDetail;
window.buildPropertyDetailContent = buildPropertyDetailContent;
window.switchPropertyFromSheet = switchPropertyFromSheet;
window.switchToPortfolioFromSheet = switchToPortfolioFromSheet;
window.jumpToPropertyCleaningAction = jumpToPropertyCleaningAction;
window.isPortfolioMode = isPortfolioMode;
window.enterPortfolioMode = enterPortfolioMode;
window.exitPortfolioMode = exitPortfolioMode;
window.getPropertyColour = getPropertyColour;
window.getPropertyColourById = getPropertyColourById;
window.getPropertyNameById = getPropertyNameById;
window.showPropertyPicker = showPropertyPicker;
window.applyPortfolioModeAfterHostHydrate = applyPortfolioModeAfterHostHydrate;
window.openPropertyAccessRules = openPropertyAccessRules;
window.openPropertySettingsMenu = openPropertySettingsMenu;
window.filterProperty = filterProperty;
