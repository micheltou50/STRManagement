/**
 * StayOps — bookings list, detail, CSV import, dashboard calendar (Pass 9).
 * Uses globalThis for main.js / supabase hooks assigned at boot.
 */
import { bookings, cleans, notes, replaceArrayInPlace } from './state.js';
import {
  escHtml,
  fmt,
  escapeJsSingleQuotedHtmlAttr,
  localDateStr,
  getTurnoverTimes,
  findTurnoverClashes,
} from './utils.js';
import { buildBookingListCardFromBooking, normalizePlatformLabel } from './booking-list-card.js';
import {
  applyCancellationPolicy,
  bookingRevenue,
  getCancellationWindowDays,
  isCancellationInsideWindow,
  getCancellationBillable,
} from './booking-revenue.js';
import {
  bookingFilter,
  setBookingFilter,
  renderPortfolioBookings,
  isPortfolioMode,
} from './property.js';
import {
  normalizeBookingCleanState,
  findMatchingCleanForBooking,
  getBookingCleanerState,
  getSuggestedCleanerForBooking,
  maybeAutoAssignPreferredCleaner,
  isCleanerPerson,
} from './cleaning.js';
import { sendCleanerEmail } from './notifications.js';
import { loadPayoutLinesForBooking, markPayoutReceived, saveBookingToCloud } from './supabase.js';
// ── DASHBOARD CALENDAR STATE ─────────────────────────────────────────────────
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth();

// ── BOOKINGS VIEW STATE (list ↔ calendar) ────────────────────────────────────
let _bookingsView = 'list'; // 'list' | 'calendar'
let _bkCalYear = new Date().getFullYear();
let _bkCalMonth = new Date().getMonth();

function _bkCalPlatformStyle(platform) {
  const p = String(platform || '').toLowerCase();
  if (p.includes('airbnb'))  return { bg: 'var(--src-airbnb-soft,#fbe1e7)', border: 'var(--src-airbnb,#a8324c)', text: 'var(--src-airbnb,#a8324c)', chip: 'var(--src-airbnb-soft,#fbe1e7)', label: 'Airbnb' };
  if (p.includes('vrbo') || p.includes('homeaway')) return { bg: 'var(--src-vrbo-soft,#d6ecf3)', border: 'var(--src-vrbo,#1d6b88)', text: 'var(--src-vrbo,#1d6b88)', chip: 'var(--src-vrbo-soft,#d6ecf3)', label: 'VRBO' };
  if (p.includes('booking')) return { bg: 'var(--src-booking-soft,#dbe6f6)', border: 'var(--src-booking,#1a4f9c)', text: 'var(--src-booking,#1a4f9c)', chip: 'var(--src-booking-soft,#dbe6f6)', label: 'Booking.com' };
  return { bg: 'var(--src-direct-soft,#dde8e1)', border: 'var(--src-direct,#1f3f35)', text: 'var(--src-direct,#1f3f35)', chip: 'var(--src-direct-soft,#dde8e1)', label: 'Direct' };
}

function _bkCalMondayIndex(dow) {
  // JS getDay: 0=Sun..6=Sat. Calendar uses Mon-first → 0=Mon..6=Sun.
  return (dow + 6) % 7;
}

function _bkCalYmd(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function _bkCalParseYmd(s) {
  if (!s) return null;
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function _bkCalBookingsForMonth(year, month) {
  const monthStart = new Date(year, month, 1);
  const monthEnd = new Date(year, month + 1, 0);
  return bookings.filter(b => {
    if (!b.checkin || !b.checkout) return false;
    if (bookingFilter === 'cancelled') { if (b.status !== 'cancelled') return false; }
    else if (b.status === 'cancelled') return false;
    const ci = _bkCalParseYmd(b.checkin);
    const co = _bkCalParseYmd(b.checkout);
    if (!ci || !co) return false;
    // Include booking if its range overlaps the month at all.
    return ci <= monthEnd && co >= monthStart;
  });
}

function renderBookingsCalendarView() {
  const root = document.getElementById('bookings-calendar');
  if (!root) return;
  const y = _bkCalYear;
  const m = _bkCalMonth;
  const monthName = new Date(y, m, 1).toLocaleDateString('en-AU', { month: 'long' });
  const firstDow = new Date(y, m, 1).getDay();
  const lead = _bkCalMondayIndex(firstDow);
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const cellCount = lead + daysInMonth;
  const rows = Math.ceil(cellCount / 7);
  const gridDays = rows * 7;

  const cellDates = [];
  for (let i = 0; i < lead; i++) {
    const d = new Date(y, m, 1 - (lead - i));
    cellDates.push({ date: d, inMonth: false });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cellDates.push({ date: new Date(y, m, d), inMonth: true });
  }
  while (cellDates.length < gridDays) {
    const last = cellDates[cellDates.length - 1].date;
    const next = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
    cellDates.push({ date: next, inMonth: false });
  }

  const todayYmd = _bkCalYmd(new Date());

  const weekBookings = Array.from({ length: rows }, () => []);
  const weekStart = (wk) => cellDates[wk * 7].date;
  const weekEnd = (wk) => cellDates[wk * 7 + 6].date;

  const monthBookings = _bkCalBookingsForMonth(y, m).sort((a, b) =>
    _bkCalParseYmd(a.checkin) - _bkCalParseYmd(b.checkin)
  );

  for (const b of monthBookings) {
    const ci = _bkCalParseYmd(b.checkin);
    const co = _bkCalParseYmd(b.checkout);
    for (let w = 0; w < rows; w++) {
      const ws = weekStart(w);
      const we = weekEnd(w);
      if (co < ws || ci > we) continue;
      const segStart = ci < ws ? ws : ci;
      const segEnd = co > we ? we : co;
      const startCol = _bkCalMondayIndex(segStart.getDay());
      const endCol = _bkCalMondayIndex(segEnd.getDay());
      const isCheckoutSeg = segEnd.getTime() === co.getTime();
      weekBookings[w].push({ b, startCol, endCol, segStart, segEnd, ci, co, isCheckoutSeg });
    }
  }

  const _calDesktop = window.innerWidth >= 1024;
  const MAX_SLOTS = _calDesktop ? 4 : 3;
  const weekSlots = Array.from({ length: rows }, () => []);
  const weekOverflow = Array.from({ length: rows }, () => []);
  for (let w = 0; w < rows; w++) {
    const slots = Array(MAX_SLOTS).fill(null);
    for (const seg of weekBookings[w]) {
      let placed = false;
      for (let s = 0; s < MAX_SLOTS; s++) {
        if (slots[s] === null || slots[s] < seg.startCol) {
          slots[s] = seg.endCol;
          seg.slot = s;
          weekSlots[w].push(seg);
          placed = true;
          break;
        }
      }
      if (!placed) weekOverflow[w].push(seg);
    }
  }

  const _dowLabels = _calDesktop ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] : ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const dowHdr = _dowLabels.map(d => `<div>${d}</div>`).join('');

  let cellsHtml = '';
  cellDates.forEach((cd, idx) => {
    const ds = _bkCalYmd(cd.date);
    const isToday = ds === todayYmd;
    const cls = 'bk-cal-cell'
      + (cd.inMonth ? '' : ' bk-dim')
      + (isToday ? ' bk-today' : '');
    cellsHtml += `<div class="${cls}" data-col="${idx % 7}" data-row="${Math.floor(idx / 7)}" data-ymd="${ds}">
      <span class="bk-daynum">${cd.date.getDate()}</span>
    </div>`;
  });

  const ROW_H = _calDesktop ? 130 : 98;
  const TOP_OFFSET = _calDesktop ? 32 : 28;
  const BAR_H = _calDesktop ? 22 : 18;
  const SLOT_H = BAR_H + 3;

  let barsHtml = '';
  for (let w = 0; w < rows; w++) {
    for (const seg of weekSlots[w]) {
      const { b, startCol, endCol, slot, ci, co, isCheckoutSeg } = seg;
      const style = _bkCalPlatformStyle(b.platform);
      const widthCols = endCol - startCol + 1;
      const segStartsAtCi = seg.segStart.getTime() === ci.getTime();
      const checkinOffset = segStartsAtCi ? (0.55 / 7) * 100 : 0;
      const leftPct = (startCol / 7) * 100 + checkinOffset;
      let widthPct = (widthCols / 7) * 100 - checkinOffset;
      if (isCheckoutSeg && widthCols > 0) {
        widthPct = (widthCols / 7) * 100 - checkinOffset - ((1 - 0.45) / 7) * 100;
      }
      const top = w * ROW_H + TOP_OFFSET + slot * SLOT_H;
      const segEndsAtCo = seg.segEnd.getTime() === co.getTime();
      const radius = `${segStartsAtCi ? '4px' : '0'} ${segEndsAtCo ? '4px' : '0'} ${segEndsAtCo ? '4px' : '0'} ${segStartsAtCi ? '4px' : '0'}`;
      const nameLabel = _calDesktop ? (b.name || 'Guest') : (b.name || 'Guest').split(/\s+/)[0];
      const idAttr = b._cloudId || b.id;
      barsHtml += `<div class="bk-cal-bar" data-id="${escHtml(String(idAttr))}" title="${escHtml(b.name || 'Guest')} · ${escHtml(b.checkin)} → ${escHtml(b.checkout)}"
        style="left:${leftPct}%;width:${widthPct}%;top:${top}px;height:${BAR_H}px;border-radius:${radius};background:${style.border};">
        <span class="bk-bar-name">${segStartsAtCi ? escHtml(nameLabel) : ''}</span>
      </div>`;
    }
    if (weekOverflow[w].length) {
      const top = w * ROW_H + TOP_OFFSET + MAX_SLOTS * SLOT_H;
      barsHtml += `<div class="bk-cal-more" style="left:4px;top:${top}px">+${weekOverflow[w].length} more</div>`;
    }
  }

  const emptyHtml = monthBookings.length === 0
    ? `<div class="bk-cal-empty">No bookings this month</div>`
    : '';

  let propsHtml = '';
  const allProps = typeof globalThis.getAllProperties === 'function' ? globalThis.getAllProperties() : [];
  if (allProps.length > 1) {
    const activeId = typeof globalThis.getActivePropertyId === 'function' ? globalThis.getActivePropertyId() : null;
    propsHtml = '<div class="bk-cal-props">' +
      allProps.map(p => {
        const isActive = String(p.id) === String(activeId);
        return `<div class="bk-cal-prop-pill${isActive ? ' active' : ''}" data-prop-id="${escHtml(String(p.id))}">${escHtml(p.name || 'Property')}</div>`;
      }).join('') + '</div>';
  }

  const legend = [
    { bg: 'var(--src-direct,#1f3f35)', label: 'Direct' },
    { bg: 'var(--src-airbnb,#a8324c)', label: 'Airbnb' },
    { bg: 'var(--src-booking,#1a4f9c)', label: 'Booking' },
    { bg: 'var(--src-vrbo,#1d6b88)', label: 'VRBO' },
  ].map(l => `<div class="bk-cal-legend-item"><div class="bk-cal-legend-dot" style="background:${l.bg}"></div>${l.label}</div>`).join('');

  root.innerHTML = `
    <div class="bk-cal-card">
      <div class="bk-cal-head">
        <div>
          <div class="bk-cal-title">${escHtml(monthName)}</div>
          <div class="bk-cal-year">${y}</div>
        </div>
        <div style="display:flex;gap:4px;align-items:center">
          <button type="button" class="bk-cal-nav" id="bk-cal-prev" aria-label="Previous month">
            <svg width="18" height="18" viewBox="0 0 18 18"><path d="M11 4L5 9l6 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button type="button" class="bk-cal-nav" id="bk-cal-next" aria-label="Next month">
            <svg width="18" height="18" viewBox="0 0 18 18"><path d="M7 4l6 5-6 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>
      ${propsHtml}
      <div class="bk-cal-dow">${dowHdr}</div>
      <div class="bk-cal-grid" id="bk-cal-grid-inner" style="height:${rows * ROW_H}px">
        ${cellsHtml}
        ${barsHtml}
      </div>
      <div class="bk-cal-legend">${legend}</div>
      ${emptyHtml}
      <div id="bk-cal-day-detail"></div>
    </div>
  `;

  root.querySelector('#bk-cal-prev').onclick = () => {
    _bkCalMonth -= 1;
    if (_bkCalMonth < 0) { _bkCalMonth = 11; _bkCalYear -= 1; }
    renderBookingsCalendarView();
  };
  root.querySelector('#bk-cal-next').onclick = () => {
    _bkCalMonth += 1;
    if (_bkCalMonth > 11) { _bkCalMonth = 0; _bkCalYear += 1; }
    renderBookingsCalendarView();
  };
  root.querySelectorAll('.bk-cal-bar').forEach(bar => {
    bar.onclick = (e) => {
      e.stopPropagation();
      const id = bar.getAttribute('data-id');
      if (typeof globalThis.openDetailModal === 'function') globalThis.openDetailModal(id);
    };
  });
  root.querySelectorAll('.bk-cal-cell').forEach(cell => {
    cell.onclick = () => {
      const ymd = cell.getAttribute('data-ymd');
      if (!ymd) return;
      _renderCalDayDetail(ymd, monthBookings);
    };
  });
  root.querySelectorAll('.bk-cal-prop-pill').forEach(pill => {
    pill.onclick = () => {
      const propId = pill.getAttribute('data-prop-id');
      if (typeof globalThis.switchActiveProperty === 'function') {
        globalThis.switchActiveProperty(propId);
      }
    };
  });

  // Touch swipe between months
  const grid = root.querySelector('#bk-cal-grid-inner');
  if (grid) {
    let sx = 0, sy = 0, swiping = false;
    grid.addEventListener('touchstart', (e) => {
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      swiping = false;
    }, { passive: true });
    grid.addEventListener('touchmove', (e) => {
      const dx = e.touches[0].clientX - sx;
      const dy = e.touches[0].clientY - sy;
      if (!swiping && Math.abs(dx) > 30 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        swiping = true;
      }
    }, { passive: true });
    grid.addEventListener('touchend', (e) => {
      if (!swiping) return;
      const dx = e.changedTouches[0].clientX - sx;
      if (dx < -40) {
        _bkCalMonth += 1;
        if (_bkCalMonth > 11) { _bkCalMonth = 0; _bkCalYear += 1; }
        renderBookingsCalendarView();
      } else if (dx > 40) {
        _bkCalMonth -= 1;
        if (_bkCalMonth < 0) { _bkCalMonth = 11; _bkCalYear -= 1; }
        renderBookingsCalendarView();
      }
    }, { passive: true });
  }
}

function _renderCalDayDetail(ymd, monthBookings) {
  const detail = document.getElementById('bk-cal-day-detail');
  if (!detail) return;
  const dayDate = _bkCalParseYmd(ymd);
  if (!dayDate) { detail.innerHTML = ''; return; }
  const dayBookings = monthBookings.filter(b => {
    const ci = _bkCalParseYmd(b.checkin);
    const co = _bkCalParseYmd(b.checkout);
    return ci && co && dayDate >= ci && dayDate <= co;
  });
  if (!dayBookings.length) {
    detail.innerHTML = '';
    return;
  }
  const dayLabel = dayDate.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
  const cards = dayBookings.map(b => {
    const ci = _bkCalParseYmd(b.checkin);
    const co = _bkCalParseYmd(b.checkout);
    const style = _bkCalPlatformStyle(b.platform);
    const isCheckin = ci && ci.getTime() === dayDate.getTime();
    const isCheckout = co && co.getTime() === dayDate.getTime();
    const eventLabel = isCheckin ? 'Check-in · 15:00' : isCheckout ? 'Check-out · 10:00' : 'In stay';
    const pillBg = isCheckin ? 'var(--primary-soft,#dde8e1)' : isCheckout ? 'var(--accent-soft,#f4e7cf)' : 'var(--hairline-2,#efe9dc)';
    const pillColor = isCheckin ? 'var(--primary,#2f5d4e)' : isCheckout ? 'var(--warn,#b56a3a)' : 'var(--ink-2,#4a5751)';
    const nights = ci && co ? Math.round((co - ci) / 86400000) : 0;
    const payout = Number(b.hostPayout || 0);
    const plat = normalizePlatformLabel(b.platform) || 'Direct';
    const meta = [nights ? nights + ' night' + (nights !== 1 ? 's' : '') : '', payout ? '$' + payout.toLocaleString() : '', plat].filter(Boolean).join(' · ');
    const idAttr = b._cloudId || b.id;
    return `<div class="bk-cal-detail-card" onclick="if(typeof openDetailModal==='function')openDetailModal('${escapeJsSingleQuotedHtmlAttr(String(idAttr))}')">
      <div class="bk-cal-detail-rail" style="background:${style.border}"></div>
      <div class="bk-cal-detail-body">
        <div class="bk-cal-detail-pill" style="background:${pillBg};color:${pillColor}">${eventLabel}</div>
        <div class="bk-cal-detail-name">${escHtml(b.name || 'Guest')} · ${escHtml(String(b.guests || '?'))} guest${(b.guests || 0) !== 1 ? 's' : ''}</div>
        <div class="bk-cal-detail-meta">${escHtml(meta)}</div>
      </div>
    </div>`;
  }).join('');
  detail.innerHTML = `<div class="bk-cal-detail">
    <div class="bk-cal-detail-label">${escHtml(dayLabel)}</div>
    ${cards}
  </div>`;
}

function switchBookingsView(view) {
  _bookingsView = view === 'calendar' ? 'calendar' : 'list';
  const list = document.getElementById('bookings-list');
  const cal = document.getElementById('bookings-calendar');
  const tabRow = document.getElementById('bookings-tab-row');
  const notesView = document.getElementById('bookings-notes-view');
  const listTab = document.getElementById('bookings-view-list');
  const calTab = document.getElementById('bookings-view-calendar');
  if (listTab) {
    listTab.classList.toggle('active', _bookingsView === 'list');
    listTab.style.fontWeight = _bookingsView === 'list' ? '700' : '600';
  }
  if (calTab) {
    calTab.classList.toggle('active', _bookingsView === 'calendar');
    calTab.style.fontWeight = _bookingsView === 'calendar' ? '700' : '600';
  }
  if (_bookingsView === 'calendar') {
    if (list) list.style.display = 'none';
    if (notesView) notesView.style.display = 'none';
    if (tabRow) tabRow.style.display = 'none';
    if (cal) cal.style.display = '';
    renderBookingsCalendarView();
  } else {
    if (cal) cal.style.display = 'none';
    if (tabRow) tabRow.style.display = '';
    if (list) list.style.display = bookingFilter === 'notes' ? 'none' : '';
    if (notesView) notesView.style.display = bookingFilter === 'notes' ? '' : 'none';
    if (typeof globalThis.renderAll === 'function') globalThis.renderAll();
  }
}

function calPrev() {
  calMonth--;
  if (calMonth < 0) {
    calMonth = 11;
    calYear--;
  }
  renderCalendar();
  updateCalStats();
}
function calNext() {
  calMonth++;
  if (calMonth > 11) {
    calMonth = 0;
    calYear++;
  }
  renderCalendar();
  updateCalStats();
}

function updateCalStats() {
  const isLeap = (calYear % 4 === 0 && calYear % 100 !== 0) || calYear % 400 === 0;
  const daysInYear = isLeap ? 366 : 365;
  const yearStart = new Date(calYear, 0, 1);
  const yearEnd = new Date(calYear + 1, 0, 1);
  let bookedNightsYear = 0;
  bookings.filter(b => b.status !== 'cancelled').forEach(b => {
    if (!b.checkin || !b.checkout) return;
    const ci = new Date(Math.max(new Date(b.checkin).getTime(), yearStart.getTime()));
    const co = new Date(Math.min(new Date(b.checkout).getTime(), yearEnd.getTime()));
    if (co > ci) bookedNightsYear += Math.round((co - ci) / 86400000);
  });
  const annualOcc = Math.round((bookedNightsYear / daysInYear) * 100);

  const monthRev = bookings.filter(b => {
    const d = new Date(b.checkin);
    return d.getMonth() === calMonth && d.getFullYear() === calYear;
  }).reduce((s, b) => s + bookingRevenue(b), 0);

  const occEl = document.getElementById('stat-occupancy');
  const revEl = document.getElementById('stat-revenue');
  if (occEl) occEl.textContent = annualOcc + '%';
  if (revEl) revEl.textContent = '$' + monthRev.toLocaleString();

  const o2 = document.getElementById('stat-occupancy2');
  if (o2) o2.textContent = annualOcc + '%';
}

function renderCalendar() {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const calTitle = document.getElementById('cal-title');
  if (calTitle) calTitle.textContent = months[calMonth] + ' ' + calYear;

  const starts = new Set(),
    ends = new Set(),
    mids = new Set();
  const dayBooking = {};
  bookings.filter(b => b.status !== 'cancelled').forEach(b => {
    if (!b.checkin || !b.checkout) return;
    const ci = new Date(b.checkin),
      co = new Date(b.checkout);
    for (let d = new Date(ci); d <= co; d.setDate(d.getDate() + 1)) {
      if (d.getMonth() !== calMonth || d.getFullYear() !== calYear) continue;
      const day = d.getDate();
      const isStart = d.toDateString() === ci.toDateString();
      const isEnd = d.toDateString() === co.toDateString();
      if (isStart) starts.add(day);
      if (isEnd) ends.add(day);
      if (!isStart && !isEnd) mids.add(day);
      dayBooking[day] = b._cloudId || b.id;
    }
  });

  const now = new Date();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const firstDay = new Date(calYear, calMonth, 1).getDay();

  let html = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(d => `<div class="cal-day-label">${d}</div>`).join('');
  for (let i = 0; i < firstDay; i++) html += '<div class="cal-day"></div>';

  for (let d = 1; d <= daysInMonth; d++) {
    const isToday = d === now.getDate() && calMonth === now.getMonth() && calYear === now.getFullYear();
    const isStart = starts.has(d);
    const isEnd = ends.has(d);
    const isMid = mids.has(d);
    const isBooked = isStart || isEnd || isMid;
    const classes = ['cal-day', isStart ? 'booked-start' : '', isEnd ? 'booked-end' : '', isMid ? 'booked-mid' : '', isToday ? 'today' : ''].filter(Boolean).join(' ');
    const click = isBooked ? ` onclick="openCalPreview('${escHtml(dayBooking[d])}')" style="cursor:pointer"` : '';
    html += `<div class="${classes}"${click}><span class="cal-num">${d}</span></div>`;
  }
  const grid = document.getElementById('cal-grid');
  if (grid) grid.innerHTML = html;
}

function openCalPreview(bookingId) {
  const b = bookings.find(bk => bk._cloudId === bookingId || String(bk.id) === String(bookingId));
  if (!b) return;
  const content = document.getElementById('cal-preview-content');
  if (!content) return;
  const payout = Number(b.hostPayout || 0);
  content.innerHTML = `
    <div class="cp-name">${escHtml(b.name)}</div>
    <div class="cp-dates">${fmt(b.checkin)} → ${fmt(b.checkout)}</div>
    <div class="cp-meta-row">
      <span class="cp-chip">👥 ${escHtml(String(b.guests))} guests</span>
      <span class="cp-chip">🌙 ${escHtml(String(b.nights))} night${b.nights !== 1 ? 's' : ''}</span>
      ${b.platform ? `<span class="cp-chip">${b.platform === 'Airbnb' ? '🏠' : b.platform === 'VRBO' ? '🏡' : '📋'} ${escHtml(normalizePlatformLabel(b.platform))}</span>` : ''}
    </div>
    ${payout ? `<div class="cp-payout">$${payout.toLocaleString()}</div><div class="cp-payout-label">Gross revenue</div>` : ''}
    <div class="cp-actions">
      <button class="cp-btn-primary" onclick="closeCalPreview();showDetail('${escapeJsSingleQuotedHtmlAttr(String(b._cloudId || b.id))}')">View booking</button>
      <button class="cp-btn-ghost" onclick="closeCalPreview()">Close</button>
    </div>`;
  document.getElementById('cal-preview-backdrop').classList.add('open');
  const sheet = document.getElementById('cal-preview-sheet');
  sheet.style.display = 'block';
  requestAnimationFrame(() => sheet.classList.add('open'));
}

function closeCalPreview() {
  const sheet = document.getElementById('cal-preview-sheet');
  const backdrop = document.getElementById('cal-preview-backdrop');
  if (!sheet) return;
  sheet.classList.remove('open');
  if (backdrop) backdrop.classList.remove('open');
  sheet.addEventListener('transitionend', () => {
    sheet.style.display = 'none';
  }, { once: true });
}

function renderBookings(filter) {
  if (filter) setBookingFilter(filter);
  // Calendar view: re-render calendar instead of list.
  if (_bookingsView === 'calendar') {
    const list = document.getElementById('bookings-list');
    const cal = document.getElementById('bookings-calendar');
    const tabRow = document.getElementById('bookings-tab-row');
    const notesView = document.getElementById('bookings-notes-view');
    if (list) list.style.display = 'none';
    if (notesView) notesView.style.display = 'none';
    if (tabRow) tabRow.style.display = 'none';
    if (cal) cal.style.display = '';
    renderBookingsCalendarView();
    return;
  }
  if (isPortfolioMode()) {
    renderPortfolioBookings(filter);
    return;
  }
  const list = document.getElementById('bookings-list');
  // Fade-in animation on filter change
  if (list && filter) {
    list.style.transition = 'opacity 0.15s ease';
    list.style.opacity = '0';
    setTimeout(() => { list.style.opacity = '1'; }, 20);
  }
  const notesView = document.getElementById('bookings-notes-view');
  if (notesView) notesView.style.display = bookingFilter === 'notes' ? '' : 'none';
  if (list) list.style.display = bookingFilter === 'notes' ? 'none' : '';
  if (bookingFilter === 'notes') {
    renderNotes();
    return;
  }

  let filtered;
  if (bookingFilter === 'all') filtered = bookings.filter(b => b.status !== 'cancelled');
  else if (bookingFilter === 'upcoming') filtered = bookings.filter(b => b.status !== 'cancelled' && new Date(b.checkout) >= new Date());
  else if (bookingFilter === 'completed') filtered = bookings.filter(b => b.status !== 'cancelled' && new Date(b.checkout) < new Date());
  else if (bookingFilter === 'cancelled') filtered = bookings.filter(b => b.status === 'cancelled');
  else filtered = bookings.filter(b => b.status !== 'cancelled' && new Date(b.checkout) >= new Date());

  if (!filtered.length) {
    const hasAny = bookings.length > 0;
    const _emptyLabels = { upcoming: 'Nothing upcoming', completed: 'No past bookings', cancelled: 'No cancelled bookings', all: 'No bookings found' };
    const _emptyHints = { upcoming: 'Past and cancelled bookings live in other tabs', completed: 'Completed stays will appear here', cancelled: 'Cancelled bookings will appear here', all: 'Add a booking with the + button above' };
    const _emptyTitle = hasAny ? (_emptyLabels[bookingFilter] || 'No bookings found') : 'No bookings yet';
    const _emptyHint = hasAny ? (_emptyHints[bookingFilter] || 'Try switching tabs above') : 'Add your first booking to get started';
    const _emptyBtn = !hasAny ? '<div style="margin-top:14px"><button onclick="openModal()" class="btn-primary" style="padding:10px 24px;font-size:14px">+ Add Booking</button></div>' : '';
    list.innerHTML = `<div class="card" style="text-align:center;padding:40px 24px 36px"><div style="font-size:36px;margin-bottom:14px;opacity:0.45">📅</div><div style="font-weight:700;font-size:15px;color:var(--primary);margin-bottom:6px">${_emptyTitle}</div><div style="font-size:12.5px;color:var(--muted-2);line-height:1.5">${_emptyHint}</div>${_emptyBtn}</div>`;
    return;
  }

  const sorted = [...filtered].sort((a, b) => new Date(a.checkin) - new Date(b.checkin));

  // Desktop: table view | Mobile: card view
  if (window.innerWidth >= 1024) {
    const fmtShort = d => { if (!d) return ''; const dt = new Date(d); return dt.toLocaleDateString('en-AU', { day:'numeric', month:'short' }); };
    const platformClass = p => { const lp = (p||'').toLowerCase(); if (lp.includes('airbnb')) return 'platform-airbnb'; if (lp.includes('vrbo')||lp.includes('homeaway')) return 'platform-vrbo'; if (lp.includes('booking')) return 'platform-booking'; return 'platform-direct'; };
    const statusBadge = b => {
      const today = localDateStr();
      const ci = (b.checkin||'').slice(0,10);
      const co = (b.checkout||'').slice(0,10);
      if (b.status === 'cancelled') return getCancellationBillable(b)
        ? '<span class="dt-badge dt-badge-green">Late cancel - billed</span>'
        : '<span class="dt-badge dt-badge-gray">Cancelled</span>';
      if (ci === today) return '<span class="dt-badge dt-badge-green">Arriving</span>';
      if (co === today) return '<span class="dt-badge dt-badge-amber">Departing</span>';
      if (ci < today && co > today) return '<span class="dt-badge dt-badge-green">In-house</span>';
      if (co < today) return '<span class="dt-badge dt-badge-gray">Completed</span>';
      return '<span class="dt-badge dt-badge-blue">Confirmed</span>';
    };
    const cleanerForBooking = b => {
      const mc = typeof findMatchingCleanForBooking === 'function' ? findMatchingCleanForBooking(b) : null;
      if (mc && mc.cleaner) return `<span style="color:var(--moss);font-weight:500">${escHtml(mc.cleaner)}</span>`;
      return '<span style="color:var(--red);font-size:12px">Unassigned</span>';
    };

    const rows = sorted.map(b => {
      const bid = escapeJsSingleQuotedHtmlAttr(String(b._cloudId || b.id));
      return `<tr onclick="showDetail('${bid}')" style="cursor:pointer">
        <td><strong>${escHtml(b.name)}</strong></td>
        <td>${fmtShort(b.checkin)}</td>
        <td>${fmtShort(b.checkout)}</td>
        <td>${b.nights || ''}</td>
        <td>$${bookingRevenue(b).toLocaleString()}</td>
        <td><span class="dt-platform ${platformClass(b.platform)}">${escHtml(normalizePlatformLabel(b.platform))}</span></td>
        <td>${cleanerForBooking(b)}</td>
        <td>${statusBadge(b)}</td>
      </tr>`;
    }).join('');

    list.innerHTML = `<div class="card" style="padding:0;overflow:hidden;overflow-x:auto">
      <table class="desktop-table">
        <thead><tr>
          <th>Guest</th><th>Check-in</th><th>Check-out</th><th>Nights</th><th>Payout</th><th>Platform</th><th>Cleaner</th><th>Status</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  } else {
    const grouped = sorted.reduce((acc, b) => {
      const d = new Date(b.checkin || b.checkout || Date.now());
      const key = d.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
      if (!acc[key]) acc[key] = [];
      acc[key].push(b);
      return acc;
    }, {});

    list.innerHTML = Object.entries(grouped)
      .map(
        ([monthLabel, items]) => `
      <div style="margin-bottom:4px">
        <div style="font-size:11px;font-weight:700;color:var(--muted-2);text-transform:uppercase;letter-spacing:0.9px;padding:16px 4px 8px">${escHtml(monthLabel)}</div>
        ${items.map(b => buildBookingListCardFromBooking(b)).join('')}
      </div>`
      )
      .join('');
  }

  if (typeof globalThis.animateList === 'function') globalThis.animateList('#bookings-list');
  setTimeout(() => {
    if (typeof globalThis.attachLongPress === 'function') globalThis.attachLongPress();
  }, 60);
}

function renderNotes() {
  const list = document.getElementById('notes-list');
  if (typeof isPortfolioMode === 'function' && isPortfolioMode()) {
    list.innerHTML =
      '<div class="card" style="text-align:center;padding:28px 16px"><div style="font-size:36px;margin-bottom:10px">📝</div><div style="font-weight:600;font-size:14px;margin-bottom:4px">Select a property to view notes</div><div style="font-size:12px;color:var(--muted-2)">Notes are per property — open the property switcher and choose one property.</div></div>';
    return;
  }
  if (!notes.length) {
    list.innerHTML =
      '<div class="card" style="text-align:center;padding:28px 16px"><div style="font-size:36px;margin-bottom:10px">📝</div><div style="font-weight:600;font-size:14px;margin-bottom:4px">No notes yet</div><div style="font-size:12px;color:var(--muted-2)">Add notes about guests, special requests or anything useful</div></div>';
    return;
  }
  list.innerHTML = [...notes]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .map(
      n => `
    <div class="note-item">
      <div class="note-guest"><span class="note-tag tag-${escHtml(n.tag)}">${escHtml(n.tag)}</span>${escHtml(n.guestName)}</div>
      <div class="note-text">${escHtml(n.text)}</div>
      <div class="note-date">${fmt(n.date)}</div>
    </div>`
    )
    .join('');
}

function _bookingDetailPlatformPill(platform) {
  if (!platform) return '';
  const p = normalizePlatformLabel(platform);
  const base =
    'font-size:11px;font-weight:600;padding:3px 10px;border-radius:999px;display:inline-block';
  if (p === 'Airbnb') {
    return `<span style="${base};color:#FF5A5F;background:#FFF0F0">Airbnb</span>`;
  }
  if (p === 'VRBO') {
    return `<span style="${base};color:#3B5998;background:#EEF0FF">VRBO</span>`;
  }
  if (p === 'Direct') {
    return `<span style="${base};color:#3D6B4F;background:#E8F5E9">Direct</span>`;
  }
  return `<span style="${base};color:#5F5E5A;background:#F1EFE8">${escHtml(p)}</span>`;
}

function _bookingDetailStayStatusBadge(isCancelled, isPast, booking = null) {
  if (isCancelled) {
    const billed = getCancellationBillable(booking);
    return billed
      ? '<span style="font-size:11px;padding:3px 10px;border-radius:999px;display:inline-block;font-weight:600;color:#166534;background:#DCFCE7">Late cancel - billed</span>'
      : '<span style="font-size:11px;padding:3px 10px;border-radius:999px;display:inline-block;font-weight:600;color:#A32D2D;background:#FCEBEB">Cancelled</span>';
  }
  if (isPast) {
    return '<span style="font-size:11px;padding:3px 10px;border-radius:999px;display:inline-block;font-weight:600;color:#5F5E5A;background:#F1EFE8">Past</span>';
  }
  return '<span style="font-size:11px;padding:3px 10px;border-radius:999px;display:inline-block;font-weight:600;color:#0C447C;background:#E6F1FB">Upcoming</span>';
}

function _bookingDetailCleanerBadge(state) {
  const k = state.key;
  if (k === 'unassigned' || k === 'cancelled') {
    return '<span style="font-size:11px;padding:3px 10px;border-radius:999px;font-weight:600;white-space:nowrap;color:#A32D2D;background:#FCEBEB">No cleaner</span>';
  }
  if (k === 'done') {
    return '<span style="font-size:11px;padding:3px 10px;border-radius:999px;font-weight:600;white-space:nowrap;color:#5F5E5A;background:#F1EFE8">Done</span>';
  }
  if (k === 'confirmed') {
    return '<span style="font-size:11px;padding:3px 10px;border-radius:999px;font-weight:600;white-space:nowrap;color:#1D9E75;background:#E8F5E9">Confirmed</span>';
  }
  return '<span style="font-size:11px;padding:3px 10px;border-radius:999px;font-weight:600;white-space:nowrap;color:#BA7517;background:#FAEEDA">Awaiting</span>';
}

function _bookingDetailPlatformPlain(platform) {
  if (!platform) return '—';
  return escHtml(normalizePlatformLabel(platform));
}

function _restoreDetailModalDefaultCloseBtn() {
  const btn = document.querySelector('#detail-modal .modal > .btn-secondary');
  if (btn) btn.style.display = '';
}

function _hideDetailModalDefaultCloseBtn() {
  const btn = document.querySelector('#detail-modal .modal > .btn-secondary');
  if (btn) btn.style.display = 'none';
}

function showDetail(id) {
  _restoreDetailModalDefaultCloseBtn();
  const b = bookings.find(bk => bk._cloudId === id || String(bk.id) === String(id));
  if (!b) return;
  const isCancelled = b.status === 'cancelled';
  const todayStr = localDateStr();
  const isPast = !isCancelled && b.checkout && String(b.checkout).slice(0, 10) < todayStr;
  const bn = notes.filter(n => n.bookingId === id);
  const matchedClean = findMatchingCleanForBooking(b);
  const cleanerState = getBookingCleanerState(b);
  const bc = matchedClean ? [matchedClean] : [];
  const safeIdEsc = escapeJsSingleQuotedHtmlAttr(String(b._cloudId || b.id));
  const mgmtPct =
    b.mgmtFeeRaw ||
    Math.round(((b.mgmtFee && b.hostPayout ? (b.mgmtFee / b.hostPayout) * 100 : 0) * 10)) / 10 ||
    0;

  if (isCancelled) {
    const cancelledInitial = escHtml(String(b.name || '').charAt(0).toUpperCase());
    const cancellationBilled = getCancellationBillable(b);
    const cancellationAmount = Number(b.hostPayout || 0);
    const cancellationAmountText = '$' + cancellationAmount.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const cancelBillableBlock = `
      <div style="background:white;border-radius:16px;border:1px solid var(--hairline-1);margin-bottom:20px;overflow:hidden">
        <div style="padding:14px 16px;display:flex;justify-content:space-between;align-items:center;gap:12px">
          <span style="font-size:13px;color:var(--ink-2)">Cancellation billing</span>
          <span style="font-size:13px;font-weight:700;color:${cancellationBilled ? 'var(--good,#3f7a5e)' : 'var(--muted-2)'}">${cancellationBilled ? 'Billed as late cancel - ' + cancellationAmountText : 'Refunded - $0'}</span>
        </div>
        <div style="border-top:1px solid var(--hairline-2)"></div>
        <button type="button" onclick="setCancellationBillable('${safeIdEsc}', ${cancellationBilled ? 'false' : 'true'})" style="width:100%;border:none;background:var(--surface2);padding:14px 16px;text-align:center;color:var(--primary);font-size:14px;font-weight:700;cursor:pointer;box-sizing:border-box;touch-action:manipulation;font-family:'Plus Jakarta Sans',sans-serif">
          ${cancellationBilled ? 'Mark as refunded ($0)' : 'Mark as billed (' + cancellationAmountText + ')'}
        </button>
      </div>`;
    document.getElementById('detail-content').innerHTML = `
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:6px">
        <div style="width:52px;height:52px;border-radius:14px;background:#FCEBEB;display:flex;align-items:center;justify-content:center;font-family:'Newsreader',serif;font-weight:700;font-size:22px;color:#A32D2D;flex-shrink:0">${cancelledInitial}</div>
        <div style="flex:1;min-width:0">
          <div style="font-family:'Newsreader',serif;font-size:22px;font-weight:600;color:var(--ink-1);letter-spacing:-0.3px;text-decoration:line-through;opacity:0.7">${escHtml(b.name)}</div>
          <div style="font-size:12px;color:var(--muted-2);margin-top:2px">${b.nights} night${b.nights !== 1 ? 's' : ''} · ${b.guests} guest${b.guests !== 1 ? 's' : ''}</div>
        </div>
      </div>
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:20px">
        ${b.platform ? _bookingDetailPlatformPill(b.platform) : ''}
        ${_bookingDetailStayStatusBadge(true, false, b)}
      </div>
      <div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--muted-2);letter-spacing:1px;text-transform:uppercase;margin:0 0 8px 2px">Stay</div>
      <div style="background:white;border-radius:16px;border:1px solid var(--hairline-1);margin-bottom:20px;overflow:hidden">
        <div style="display:grid;grid-template-columns:1fr auto 1fr;align-items:center;padding:16px">
          <div>
            <div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--muted-2);letter-spacing:0.5px;text-transform:uppercase">CHECK-IN</div>
            <div style="font-size:15px;font-weight:600;color:var(--ink-1);margin-top:4px">${fmt(b.checkin)}</div>
          </div>
          <div style="padding:0 12px"><svg width="24" height="14" viewBox="0 0 24 14" fill="none"><path d="M0 7h22M16 1l6 6-6 6" stroke="var(--muted-2)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
          <div style="text-align:right">
            <div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--muted-2);letter-spacing:0.5px;text-transform:uppercase">CHECK-OUT</div>
            <div style="font-size:15px;font-weight:600;color:var(--ink-1);margin-top:4px">${fmt(b.checkout)}</div>
          </div>
        </div>
        <div style="border-top:1px solid var(--hairline-2);padding:12px 16px;display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:13px;color:var(--ink-2)">Platform</span>
          <span style="font-size:13px;font-weight:600;color:var(--ink-1)">${_bookingDetailPlatformPlain(b.platform)}</span>
        </div>
      </div>
      ${cancelBillableBlock}
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:20px">
        <div onclick="closeDetailModal()" style="width:100%;border:1px solid var(--hairline-1);border-radius:14px;padding:14px;text-align:center;color:var(--ink-2);font-size:14px;font-weight:600;cursor:pointer;box-sizing:border-box;touch-action:manipulation;font-family:'Plus Jakarta Sans',sans-serif">Close</div>
      </div>
    `;
    const _dp = window.innerWidth >= 1024 && document.getElementById('desktop-detail-panel');
    if (_dp) {
      _dp.innerHTML = document.getElementById('detail-content').innerHTML;
      _dp.style.padding = '20px';
    } else {
      document.getElementById('detail-modal').classList.add('open');
      document.body.style.overflow = 'hidden';
      _hideDetailModalDefaultCloseBtn();
      setTimeout(() => {
        if (typeof globalThis.attachModalHandleDrag === 'function') globalThis.attachModalHandleDrag();
      }, 0);
    }
    return;
  }

  const loadCleanersFn = typeof globalThis.loadCleaners === 'function' ? globalThis.loadCleaners : () => [];

  const cleanerAssignBlock = (() => {
    const cls = loadCleanersFn().filter(c => isCleanerPerson(c));
    const assigned = bc[0];
    const suggested = getSuggestedCleanerForBooking(b);
    if (!cls.length) {
      return '<div style="padding:0 14px 14px;font-size:12px;color:#999">No cleaners set up yet — add in Settings → Property &amp; People</div>';
    }
    const opts = cls
      .map(
        c =>
          '<option value="' +
          c.id +
          '" ' +
          (((assigned && String(assigned.cleanerId) === String(c.id)) ||
            (!assigned && suggested && String(suggested.id) === String(c.id)))
            ? 'selected'
            : '') +
          '>' +
          escHtml(c.name) +
          '</option>'
      )
      .join('');
    const suggestHint =
      !assigned && suggested
        ? '<div style="font-size:11px;color:#999;margin:-4px 0 8px 0">Suggested: ' +
          escHtml(suggested.name || '') +
          '</div>'
        : '';
    const selStyle =
      'width:100%;padding:10px 12px;border-radius:8px;border:0.5px solid rgba(0,0,0,0.1);font-size:13px;margin-bottom:8px;box-sizing:border-box;font-family:inherit';
    const dateStyle =
      'width:100%;padding:10px 12px;border-radius:8px;border:0.5px solid rgba(0,0,0,0.1);font-size:13px;margin-bottom:12px;box-sizing:border-box;font-family:inherit';
    const dateVal = assigned ? assigned.date : b.checkout;
    return (
      '<select id="detail-assign-cleaner" style="' +
      selStyle +
      '"><option value="">— Not assigned —</option>' +
      opts +
      '</select>' +
      suggestHint +
      '<input type="date" id="detail-assign-date" value="' +
      String(dateVal || '') +
      '" style="' +
      dateStyle +
      '">' +
      '<button type="button" onclick="assignCleanerToBooking(\'' +
      safeIdEsc +
      '\')" id="detail-assign-btn" style="width:100%;background:var(--primary);border-radius:14px;padding:14px;text-align:center;color:white;font-size:14px;font-weight:600;border:none;cursor:pointer;box-sizing:border-box;font-family:\'Plus Jakarta Sans\',sans-serif;touch-action:manipulation">Save assignment</button>'
    );
  })();

  const cleanerTopName = bc.length
    ? escHtml(String(bc[0].cleaner || '—'))
    : 'No cleaner assigned';
  const cleanerDateLine = bc.length
    ? 'Clean date: ' + fmt(bc[0].date)
    : '';

  const guestInitial = escHtml(String(b.name || '').charAt(0).toUpperCase());
  const modBanner = _renderModificationBanner(b, safeIdEsc);
  document.getElementById('detail-content').innerHTML = `
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:6px">
      <div style="width:52px;height:52px;border-radius:14px;background:var(--primary-soft);display:flex;align-items:center;justify-content:center;font-family:'Newsreader',serif;font-weight:700;font-size:22px;color:var(--primary);flex-shrink:0">${guestInitial}</div>
      <div style="flex:1;min-width:0">
        <div style="font-family:'Newsreader',serif;font-size:22px;font-weight:600;color:var(--ink-1);letter-spacing:-0.3px">${escHtml(b.name)}</div>
        <div style="font-size:12px;color:var(--muted-2);margin-top:2px">${b.nights} night${b.nights !== 1 ? 's' : ''} · ${b.guests} guest${b.guests !== 1 ? 's' : ''}</div>
      </div>
      <span onclick="showEditModal('${safeIdEsc}')" style="color:var(--primary);font-size:13px;font-weight:600;cursor:pointer;flex-shrink:0;touch-action:manipulation">Edit</span>
    </div>
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:20px">
      ${b.platform ? _bookingDetailPlatformPill(b.platform) : ''}
      ${_bookingDetailStayStatusBadge(false, isPast, b)}
    </div>

    ${modBanner}

    <div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--muted-2);letter-spacing:1px;text-transform:uppercase;margin:0 0 8px 2px">Stay</div>
    <div style="background:white;border-radius:16px;border:1px solid var(--hairline-1);margin-bottom:20px;overflow:hidden">
      <div style="display:grid;grid-template-columns:1fr auto 1fr;align-items:center;padding:16px">
        <div>
          <div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--muted-2);letter-spacing:0.5px;text-transform:uppercase">CHECK-IN</div>
          <div style="font-size:15px;font-weight:600;color:var(--ink-1);margin-top:4px">${fmt(b.checkin)}</div>
          <input type="time" value="${getTurnoverTimes(b).checkinLabel}" onchange="saveBookingTurnoverTime('${safeIdEsc}','checkin',this.value)"
            style="font-size:11px;font-family:'JetBrains Mono',monospace;margin-top:2px;border:none;background:transparent;padding:0;color:${b.checkinTime ? 'var(--warn,#b56a3a)' : 'var(--muted-2)'};font-weight:${b.checkinTime ? '700' : '400'}">
          ${b.checkinTime ? '<div style="font-size:10px;color:var(--warn,#b56a3a);margin-top:1px">custom time</div>' : ''}
        </div>
        <div style="padding:0 12px"><svg width="24" height="14" viewBox="0 0 24 14" fill="none"><path d="M0 7h22M16 1l6 6-6 6" stroke="var(--muted-2)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
        <div style="text-align:right">
          <div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--muted-2);letter-spacing:0.5px;text-transform:uppercase">CHECK-OUT</div>
          <div style="font-size:15px;font-weight:600;color:var(--ink-1);margin-top:4px">${fmt(b.checkout)}</div>
          <input type="time" value="${getTurnoverTimes(b).checkoutLabel}" onchange="saveBookingTurnoverTime('${safeIdEsc}','checkout',this.value)"
            style="font-size:11px;font-family:'JetBrains Mono',monospace;margin-top:2px;border:none;background:transparent;padding:0;text-align:right;color:${b.checkoutTime ? 'var(--warn,#b56a3a)' : 'var(--muted-2)'};font-weight:${b.checkoutTime ? '700' : '400'}">
          ${b.checkoutTime ? '<div style="font-size:10px;color:var(--warn,#b56a3a);margin-top:1px">custom time</div>' : ''}
        </div>
      </div>
      <div style="border-top:1px solid var(--hairline-2);padding:12px 16px;display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:13px;color:var(--ink-2)">Platform</span>
        <span style="font-size:13px;font-weight:600;color:var(--ink-1)">${_bookingDetailPlatformPlain(b.platform)}</span>
      </div>
    </div>

    <div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--muted-2);letter-spacing:1px;text-transform:uppercase;margin:0 0 8px 2px">Financials</div>
    <div style="background:white;border-radius:16px;border:1px solid var(--hairline-1);margin-bottom:20px;overflow:hidden">
      <div style="padding:12px 16px;display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:13px;color:var(--ink-2)">Gross revenue</span>
        <span style="font-size:14px;font-weight:600;color:var(--good,#3f7a5e);font-family:'Newsreader',serif">$${Number(b.hostPayout || 0).toLocaleString()}</span>
      </div>
      <div style="padding:12px 16px;border-top:1px solid var(--hairline-2);display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:13px;color:var(--ink-2)">Cleaning fee</span>
        <span style="font-size:13px;font-weight:500;color:var(--ink-1)">$${Number(b.cleaningFee || 0).toLocaleString()}</span>
      </div>
      <div style="padding:12px 16px;border-top:1px solid var(--hairline-2);display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:13px;color:var(--ink-2)">Management fee</span>
        <span style="font-size:13px;font-weight:500;color:var(--ink-1)">${mgmtPct}%</span>
      </div>
      <div style="padding:12px 16px;border-top:1px solid var(--hairline-2);display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:13px;color:var(--ink-2)">Management payout</span>
        <span style="font-size:13px;font-weight:500;color:var(--ink-1)">$${Number(b.mgmtPayout || 0).toLocaleString()}</span>
      </div>
      <div style="border-top:1px solid var(--hairline-1)"></div>
      <div style="padding:14px 16px;background:var(--surface2);display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:13px;font-weight:600;color:var(--ink-1)">Owner payout</span>
        <span style="font-size:16px;font-weight:600;color:var(--good,#3f7a5e);font-family:'Newsreader',serif">$${Number(b.netPayout || 0).toLocaleString()}</span>
      </div>
    </div>

    <!-- Phase 1d (moved to view): expected vs received against platform_payouts.
         The renderer fills this slot in BOTH the mobile modal and the
         desktop side panel via class selector, so duplicate-id is fine. -->
    <div class="b-payouts-slot" id="b-payouts-section" style="margin-bottom:20px"></div>

    <div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--muted-2);letter-spacing:1px;text-transform:uppercase;margin:0 0 8px 2px">Cleaner</div>
    <div style="background:white;border-radius:16px;border:1px solid var(--hairline-1);margin-bottom:20px;overflow:hidden">
      <div style="padding:14px 16px;display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
        <div style="min-width:0;flex:1">
          <div style="font-size:15px;font-weight:600;color:var(--ink-1)">${cleanerTopName}</div>
          ${cleanerDateLine ? `<div style="font-size:12px;color:var(--muted-2);margin-top:4px">${cleanerDateLine}</div>` : ''}
        </div>
        <div style="flex-shrink:0;padding-top:2px">${_bookingDetailCleanerBadge(cleanerState)}</div>
      </div>
      <div style="border-top:1px solid var(--hairline-2)"></div>
      <div class="toggle-wrap" style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;margin:0;border:none${isPast ? ';opacity:0.5' : ''}">
        <span style="font-size:13px;color:var(--ink-1)">Cleaner confirmed${isPast ? ' <span style="font-size:11px;color:var(--muted-2)">(locked)</span>' : ''}</span>
        <button type="button" class="toggle ${matchedClean?.cleanerConfirmed ?? b.cleanerConfirmed ? 'on' : ''}" ${isPast ? 'disabled' : `onclick="toggleCleanerConfirmed('${b.id}')"`} aria-label="Toggle cleaner confirmed" style="flex-shrink:0${isPast ? ';pointer-events:none' : ''}"></button>
      </div>
      <div style="border-top:1px solid var(--hairline-2)"></div>
      <div style="padding:14px 16px">
        <div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--muted-2);letter-spacing:0.5px;text-transform:uppercase;margin-bottom:8px">Change cleaner</div>
        ${cleanerAssignBlock}
      </div>
    </div>

    ${matchedClean
      ? (() => {
        const cleanCost = matchedClean.cost != null ? Number(matchedClean.cost) : Number(b.cleaningFee || 0);
        const cleanIdEsc = escapeJsSingleQuotedHtmlAttr(String(matchedClean._cloudId || matchedClean.id));
        return '<div style="font-size:12px;font-weight:500;color:#999;margin:0 0 6px 2px">Cleaning cost</div>' +
      '<div style="background:white;border-radius:12px;border:0.5px solid rgba(0,0,0,0.1);margin-bottom:20px;overflow:hidden;padding:14px">' +
      '<div id="clean-cost-view" style="display:flex;align-items:center;justify-content:space-between;gap:10px">' +
        '<span style="font-size:20px;font-weight:500;color:var(--ink-1)">' + (cleanCost ? '$' + cleanCost.toLocaleString() : 'Not set') + '</span>' +
        '<button type="button" onclick="document.getElementById(\'clean-cost-view\').style.display=\'none\';document.getElementById(\'clean-cost-edit\').style.display=\'\'" style="background:none;border:0.5px solid rgba(0,0,0,0.1);border-radius:8px;padding:6px 12px;font-size:12px;font-weight:500;color:#666;cursor:pointer;font-family:inherit;touch-action:manipulation">Edit</button>' +
      '</div>' +
      '<div id="clean-cost-edit" style="display:none;margin-top:12px">' +
        '<div style="display:flex;gap:8px;align-items:center">' +
          '<input type="number" id="actual-clean-fee" value="' + (cleanCost || '') + '" placeholder="0" style="flex:1;padding:10px 12px;border:0.5px solid rgba(0,0,0,0.1);border-radius:8px;font-size:14px;font-family:inherit;box-sizing:border-box">' +
          '<button type="button" onclick="saveCleanCost(\'' + cleanIdEsc + '\',\'' + safeIdEsc + '\')" style="background:#2D5A3D;color:white;border:none;border-radius:8px;padding:10px 14px;font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap;font-family:inherit;touch-action:manipulation">Save</button>' +
        '</div>' +
      '</div>' +
      '</div>';
      })()
      : ''}
    ${bn.length
      ? `<div style="font-size:12px;font-weight:500;color:#999;margin:0 0 6px 2px">Notes</div>
      <div style="background:white;border-radius:12px;border:0.5px solid rgba(0,0,0,0.1);margin-bottom:20px;overflow:hidden;padding:12px 14px">
      ${bn.map(n => `<div class="note-item" style="margin-bottom:8px"><span class="note-tag tag-${escHtml(n.tag)}">${escHtml(n.tag)}</span><div class="note-text">${escHtml(n.text)}</div></div>`).join('')}
    </div>`
      : ''}
    ${matchedClean ? `<div style="display:flex;gap:8px;margin-bottom:20px">
      <div onclick="showSection('cleaning')" style="flex:1;padding:12px 16px;border:1px solid var(--hairline-1);border-radius:14px;text-align:center;color:var(--ink-2);font-size:13px;font-weight:600;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;touch-action:manipulation">View clean</div>
    </div>` : ''}
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:20px">
      <div onclick="closeDetailModal()" style="width:100%;border:1px solid var(--hairline-1);border-radius:14px;padding:14px;text-align:center;color:var(--ink-2);font-size:14px;font-weight:600;cursor:pointer;box-sizing:border-box;touch-action:manipulation;font-family:'Plus Jakarta Sans',sans-serif">Close</div>
      <div onclick="deleteBooking('${safeIdEsc}')" style="width:100%;border-radius:14px;padding:14px;text-align:center;color:var(--warn,#b56a3a);font-size:14px;font-weight:600;cursor:pointer;box-sizing:border-box;touch-action:manipulation;font-family:'Plus Jakarta Sans',sans-serif">Cancel booking</div>
    </div>
  `;
  const _dp2 = window.innerWidth >= 1024 && document.getElementById('desktop-detail-panel');
  if (_dp2) {
    _dp2.innerHTML = document.getElementById('detail-content').innerHTML;
    _dp2.style.padding = '20px';
  } else {
    document.getElementById('detail-modal').classList.add('open');
    document.body.style.overflow = 'hidden';
    _hideDetailModalDefaultCloseBtn();
    setTimeout(() => {
      if (typeof globalThis.attachModalHandleDrag === 'function') globalThis.attachModalHandleDrag();
    }, 0);
  }
  // Phase 1d (extended): lazy-fill the Platform Payouts panel after the
  // modal/desktop-panel content is in the DOM. Non-blocking — the view
  // is interactive immediately and the panel appears once the query lands.
  if (b._cloudId) {
    _renderBookingPayoutsSection(b._cloudId, Number(b.hostPayout) || 0)
      .catch(err => console.warn('[StayOps] _renderBookingPayoutsSection (view) failed', err));
  }
}

function showEditModal(id) {
  _restoreDetailModalDefaultCloseBtn();
  const b = bookings.find(bk => bk._cloudId === id || String(bk.id) === String(id));
  if (!b) return;
  const safeId = b._cloudId || b.id;
  if (typeof globalThis.closeDetailModal === 'function') globalThis.closeDetailModal();
  document.getElementById('detail-content').innerHTML = `
    <div style="font-family:inherit;font-size:16px;font-weight:500;color:var(--ink-1);margin-bottom:16px">Edit Booking</div>
    <label>Guest Name</label><input type="text" id="e-name" value="${escHtml(b.name)}">
    <div class="form-row">
      <div class="field"><label>Check-in</label><input type="date" id="e-checkin" value="${b.checkin}" onchange="editCalcNights()"></div>
      <div class="field"><label>Check-out</label><input type="date" id="e-checkout" value="${b.checkout}" onchange="editCalcNights()"></div>
    </div>
    <div class="form-row">
      <div class="field"><label>Nights</label><input type="number" id="e-nights" value="${b.nights}" readonly style="background:var(--hairline-2)"></div>
      <div class="field"><label>Guests</label><input type="number" id="e-guests" value="${b.guests}"></div>
    </div>
    <div class="form-row">
      <div class="field"><label>Gross Revenue ($)</label><input type="number" id="e-hostpayout" value="${b.hostPayout}" oninput="editCalcNet()"></div>
      <div class="field"><label>Cleaning Fee ($)</label><input type="number" id="e-cleaningfee" value="${b.cleaningFee}" oninput="editCalcNet()"></div>
    </div>
    <div class="form-row">
      <div class="field"><label>Mgmt Fee (%)</label><input type="number" id="e-mgmtfee" value="${b.mgmtFeeRaw || Math.round((b.mgmtFee / b.hostPayout) * 1000) / 10 || 0}" min="0" max="100" step="0.1" oninput="editCalcNet()"></div>
      <div class="field"><label>Mgmt Payout</label><input type="text" id="e-mgmtpayout" value="$${Number(b.mgmtPayout || 0).toFixed(2)}" style="background:var(--hairline-2);color:var(--muted-2);font-style:italic" readonly></div>
    </div>
    <label>Owner Payout ($)</label>
    <input type="text" id="e-netpayout" value="$${Number(b.netPayout || 0).toFixed(2)}" readonly style="background:var(--hairline-2);color:var(--muted-2);font-style:italic">
    <label>Platform</label>
    <div style="padding:10px 12px;background:var(--hairline-2);border-radius:var(--radius-sm);font-size:14px;color:var(--muted-2);font-style:italic">
      ${b.platform ? (b.platform === 'Airbnb' ? '🏠 Airbnb' : b.platform === 'VRBO' ? '🏡 VRBO' : '📋 Direct') : 'Not set'}
    </div>
    <!-- Phase 1d: expected vs received from matched platform payout lines -->
    <div id="b-payouts-section" style="margin-top:14px"></div>
    <button class="btn-primary" onclick="saveEdit('${safeId}')" id="save-edit-btn">Save & Sync</button>
    <button class="btn-secondary" onclick="closeDetailModal()">Cancel</button>
  `;
  document.getElementById('detail-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => {
    if (typeof globalThis.attachModalHandleDrag === 'function') globalThis.attachModalHandleDrag();
  }, 50);
  // Lazy-fetch any platform payout lines linked to this booking and render
  // them into the placeholder. Non-blocking — modal opens immediately.
  if (b._cloudId) {
    _renderBookingPayoutsSection(b._cloudId, Number(b.hostPayout) || 0)
      .catch(err => console.warn('[StayOps] _renderBookingPayoutsSection failed', err));
  } else {
    const el = document.getElementById('b-payouts-section');
    if (el) el.innerHTML = '';
  }
}

/**
 * Phase 1d: fetch + render the "Expected vs Received" panel inside the
 * booking detail modal. Shows the expected host_payout (the platform's
 * promise at confirmation time) vs the sum of all matched payout-line
 * amounts (what the platform actually paid), with the variance highlighted.
 */
async function _renderBookingPayoutsSection(bookingCloudId, expected) {
  // Slot lives in BOTH the mobile modal (#detail-content) and the desktop
  // side panel (#desktop-detail-panel) because showDetail copies the modal
  // HTML over to the desktop panel. Use a class-based selector that fills
  // both and tolerates either being absent (e.g. edit modal only has the
  // one inside #detail-content).
  const slots = document.querySelectorAll('.b-payouts-slot, #b-payouts-section');
  if (!slots.length) return;
  const setAll = (html) => slots.forEach(s => { s.innerHTML = html; });

  setAll(`<div style="background:var(--surface2);border-radius:10px;padding:10px 12px;font-size:12px;color:var(--muted-2);font-family:'Plus Jakarta Sans',sans-serif">⏳ Loading payouts...</div>`);

  let lines = [];
  try {
    lines = await loadPayoutLinesForBooking(bookingCloudId);
  } catch (err) {
    console.warn('[StayOps] loadPayoutLinesForBooking failed', err);
    setAll(`<div style="background:#FDECEA;border-radius:10px;padding:10px 12px;font-size:12px;color:#991B1B;font-family:'Plus Jakarta Sans',sans-serif">⚠ Could not load payouts</div>`);
    return;
  }

  if (!lines.length) {
    setAll(`
      <div style="background:var(--surface2);border-radius:10px;padding:12px 14px;font-family:'Plus Jakarta Sans',sans-serif">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;color:var(--muted-2);margin-bottom:4px">Platform Payouts</div>
        <div style="font-size:13px;color:var(--ink-1)">No payouts linked yet. <span style="color:var(--muted-2)">Paste a platform statement in Finance → Transaction Map to match payouts to this booking.</span></div>
      </div>`);
    return;
  }

  const received = lines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0);
  const variance = Number(expected) - received;
  const absVar = Math.abs(variance);
  // Banding: matched (<$1), small (<$25), notable (else)
  let varColor, varBg, varNote;
  if (absVar < 1) {
    varColor = '#166534'; varBg = '#DCFCE7'; varNote = '✓ Matches expected';
  } else if (absVar < 25) {
    varColor = '#92400E'; varBg = '#FEF3C7'; varNote = '~ Small variance — likely platform fee/rounding';
  } else {
    varColor = '#991B1B'; varBg = '#FEE2E2'; varNote = '⚠ Variance — investigate';
  }
  const fmtMoney = (n) => (n < 0 ? '−$' : '$') + Math.abs(Number(n) || 0).toFixed(2);

  // Phase 2-lite: dedupe the unique payouts so each gets ONE "received"
  // status row (with badge or button) rather than one per line item.
  const seenPayouts = new Set();
  const uniquePayouts = [];
  for (const l of lines) {
    const p = l._payout || {};
    if (!p.cloudId || seenPayouts.has(p.cloudId)) continue;
    seenPayouts.add(p.cloudId);
    uniquePayouts.push(p);
  }

  const payoutStatusRows = uniquePayouts.map(p => {
    const platformStr = (p.platform || 'platform').replace('_', '.');
    const refStr = p.payoutReference || '(no ref)';
    const confirmed = !!(p.receivedAt || p.bankTransactionId);
    const confirmedDate = p.receivedAt || (p.bankTransactionId ? 'bank-matched' : null);
    const right = confirmed
      ? `<span style="display:inline-flex;align-items:center;gap:4px;font-size:12px;color:#166534;font-weight:600">
           <span style="width:8px;height:8px;border-radius:50%;background:#22c55e"></span>
           Received${confirmedDate && confirmedDate !== 'bank-matched' ? ' ' + escHtml(confirmedDate) : ''}
         </span>`
      : `<button onclick="markPayoutAsReceivedForBooking('${escHtml(p.cloudId)}','${escHtml(bookingCloudId)}',${expected})"
             style="background:var(--moss,#166534);color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif">
           ✓ Mark received
         </button>`;
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 12px;border-bottom:0.5px solid var(--hairline-1);background:#fafafa;font-family:'Plus Jakarta Sans',sans-serif">
        <div style="min-width:0;flex:1">
          <div style="font-size:12px;font-weight:600;color:var(--ink-1)">${escHtml(platformStr)} · ${escHtml(refStr)}</div>
          <div style="font-size:11px;color:var(--muted-2);margin-top:2px">Statement date ${escHtml(p.payoutDate || '?')}</div>
        </div>
        ${right}
      </div>`;
  }).join('');

  const lineRows = lines.map(l => {
    const amtColor = (Number(l.amount) || 0) < 0 ? '#A32D2D' : '#1D9E75';
    return `
      <div style="display:flex;justify-content:space-between;gap:8px;padding:8px 10px;border-bottom:0.5px solid var(--hairline-1);font-family:'Plus Jakarta Sans',sans-serif">
        <div style="min-width:0;flex:1">
          <div style="font-size:11px;font-weight:600;color:var(--muted-2);text-transform:uppercase;letter-spacing:0.4px">${escHtml(l.lineType || 'other')}</div>
          <div style="font-size:13px;color:var(--ink-1);font-weight:500;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(l.description || '(no description)')}</div>
        </div>
        <div style="font-size:14px;font-weight:600;color:${amtColor};flex-shrink:0;align-self:center">${fmtMoney(l.amount)}</div>
      </div>`;
  }).join('');

  setAll(`
    <div style="background:#fff;border:1px solid var(--hairline-1);border-radius:12px;overflow:hidden;font-family:'Plus Jakarta Sans',sans-serif">
      <div style="padding:12px 14px;background:var(--surface2);border-bottom:0.5px solid var(--hairline-1)">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;color:var(--muted-2);margin-bottom:6px">Platform Payouts (${lines.length})</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
          <div>
            <div style="font-size:10px;color:var(--muted-2);text-transform:uppercase;letter-spacing:0.4px">Expected</div>
            <div style="font-size:15px;font-weight:600;color:var(--ink-1);margin-top:2px">${fmtMoney(expected)}</div>
          </div>
          <div>
            <div style="font-size:10px;color:var(--muted-2);text-transform:uppercase;letter-spacing:0.4px">Received</div>
            <div style="font-size:15px;font-weight:600;color:var(--ink-1);margin-top:2px">${fmtMoney(received)}</div>
          </div>
          <div>
            <div style="font-size:10px;color:var(--muted-2);text-transform:uppercase;letter-spacing:0.4px">Variance</div>
            <div style="font-size:15px;font-weight:600;color:${varColor};margin-top:2px">${fmtMoney(variance)}</div>
          </div>
        </div>
        <div style="margin-top:8px;padding:6px 10px;border-radius:6px;background:${varBg};color:${varColor};font-size:11px;font-weight:500">${varNote}</div>
      </div>
      ${payoutStatusRows}
      <div>${lineRows}</div>
    </div>`);
}

/**
 * Phase 2-lite: 1-click "mark this payout as received" — used in the
 * booking-detail Platform Payouts panel. Bypasses the bank-CSV/PDF import
 * flow entirely. Default date = today; user can later set a specific date
 * via SQL or a future date-picker if needed.
 */
async function markPayoutAsReceivedForBooking(payoutId, bookingCloudId, expected) {
  if (!payoutId) return;
  const today = localDateStr();
  const ok = await markPayoutReceived(payoutId, today);
  if (!ok) {
    if (typeof globalThis.showBanner === 'function') {
      globalThis.showBanner('⚠ Could not mark received — see console', 'warn');
    }
    return;
  }
  if (typeof globalThis.showBanner === 'function') {
    globalThis.showBanner('✓ Marked received ' + today, 'ok');
  }
  // Re-fetch and re-render the panel so the badge/button updates
  _renderBookingPayoutsSection(bookingCloudId, expected)
    .catch(err => console.warn('[StayOps] re-render after mark-received failed', err));
}
globalThis.markPayoutAsReceivedForBooking = markPayoutAsReceivedForBooking;

function editCalcNights() {
  const ci = document.getElementById('e-checkin').value;
  const co = document.getElementById('e-checkout').value;
  if (ci && co) {
    const n = Math.ceil((new Date(co) - new Date(ci)) / 86400000);
    document.getElementById('e-nights').value = n > 0 ? n : '';
  }
}

function editCalcNet() {
  const host = Number(document.getElementById('e-hostpayout').value) || 0;
  const clean = Number(document.getElementById('e-cleaningfee').value) || 0;
  const mgmtPct = Number(document.getElementById('e-mgmtfee').value) || 0;
  const mgmtBase = host - clean;
  const mgmtAmt = Math.round((mgmtBase * mgmtPct) / 100 * 100) / 100;
  const net = Math.round(mgmtBase * 100) / 100;
  const mgmtEl = document.getElementById('e-mgmtpayout');
  const netEl = document.getElementById('e-netpayout');
  if (mgmtEl) mgmtEl.value = mgmtPct ? '$' + mgmtAmt.toFixed(2) : '';
  if (netEl) netEl.value = host ? '$' + net.toFixed(2) : '';
}

async function saveEdit(id) {
  const b = bookings.find(bk => bk._cloudId === id || String(bk.id) === String(id));
  if (!b) return;
  const btn = document.getElementById('save-edit-btn');
  btn.textContent = 'Saving...';
  btn.disabled = true;

  const prevCheckout = b.checkout;

  b.name = document.getElementById('e-name').value.trim();
  b.checkin = document.getElementById('e-checkin').value;
  b.checkout = document.getElementById('e-checkout').value;
  b.nights = Number(document.getElementById('e-nights').value) || 1;
  b.guests = Number(document.getElementById('e-guests').value) || 1;
  b.hostPayout = Number(document.getElementById('e-hostpayout').value) || 0;
  b.cleaningFee = Number(document.getElementById('e-cleaningfee').value) || 0;

  const mgmtPct = Number(document.getElementById('e-mgmtfee').value) || 0;
  const mgmtBase = b.hostPayout - b.cleaningFee;
  b.mgmtFeeRaw = mgmtPct;
  b.mgmtFee = Math.round((mgmtBase * mgmtPct) / 100 * 100) / 100;
  b.mgmtPayout = b.mgmtFee;
  b.netPayout = Math.round((mgmtBase - b.mgmtFee) * 100) / 100;

  if (!b.status) b.status = 'confirmed';
  normalizeBookingCleanState();

  const checkoutChanged = prevCheckout && b.checkout && prevCheckout !== b.checkout;
  const linkedCleans = checkoutChanged
    ? cleans.filter(c =>
        String(c.bookingId) === String(b.id) ||
        (b._cloudId && String(c.bookingId) === String(b._cloudId)) ||
        (c._cloudId && b._cloudId && String(c.bookingId) === String(b._cloudId))
      )
    : [];
  if (linkedCleans.length) {
    for (const c of linkedCleans) {
      if (c.date === b.checkout) continue;
      c.date = b.checkout;
      if (typeof globalThis.saveCleanToCloud === 'function') {
        try { await globalThis.saveCleanToCloud(c); }
        catch (e) { console.warn('[StayOps] clean cloud save failed on date follow', e); }
      }
    }
  }

  if (typeof globalThis.saveBookingToCloud === 'function') {
    try {
      await globalThis.saveBookingToCloud(b);
    } catch (e) {
      console.error('[StayOps] Cloud save failed:', e);
      globalThis.showBanner('Changes saved locally, cloud sync failed', 'warn');
    }
  }
  globalThis.showBanner('✅ Booking saved', 'ok');

  if (linkedCleans.length && typeof globalThis.renotifyClean === 'function') {
    for (const c of linkedCleans) {
      if (!c.cleanerId) continue;
      try { await globalThis.renotifyClean(c.id); }
      catch (e) { console.warn('[StayOps] cleaner re-notify failed on date follow', e); }
    }
  }

  setTimeout(() => {
    if (typeof globalThis.closeDetailModal === 'function') globalThis.closeDetailModal();
    if (typeof globalThis.renderAll === 'function') globalThis.renderAll();
  }, 500);
}

function filterBookings(f, btn) {
  document.querySelectorAll('#section-bookings .tab-row .tab').forEach(t => t.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderBookings(f);
}

/**
 * Set (or clear) a per-booking check-in/check-out time from the Stay card.
 * Picking the default time clears the override (back to NULL in the DB).
 * Warns immediately if the new time creates a same-day turnover clash.
 * @param {string} id booking cloud id or local id
 * @param {'checkin'|'checkout'} field
 * @param {string} value "HH:MM" from the <input type="time">
 */
async function saveBookingTurnoverTime(id, field, value) {
  const b = bookings.find(bk => bk._cloudId === id || String(bk.id) === String(id));
  if (!b || !/^\d{2}:\d{2}$/.test(String(value || ''))) return;
  const defaults = getTurnoverTimes(); // property/global default (no booking arg)
  const isDefault = value === (field === 'checkin' ? defaults.checkinLabel : defaults.checkoutLabel);
  const prop = field === 'checkin' ? 'checkinTime' : 'checkoutTime';
  b[prop] = isDefault ? null : value;
  try {
    await saveBookingToCloud(b);
    globalThis.showBanner(isDefault
      ? '✓ ' + (field === 'checkin' ? 'Check-in' : 'Check-out') + ' back to default (' + value + ')'
      : '✓ ' + (field === 'checkin' ? 'Check-in' : 'Check-out') + ' set to ' + value + ' for ' + (b.name || 'guest'), 'ok');
  } catch (e) {
    globalThis.showBanner('⚠ Could not save time — ' + (e && e.message || 'try again'), 'warn');
    return;
  }
  // Immediate clash feedback: does this booking now collide with a same-day neighbour?
  const clash = findTurnoverClashes(bookings).find(c => c.out === b || c.in === b);
  if (clash) {
    const mins = Math.abs(clash.gapMinutes);
    globalThis.showBanner('⚠ Turnover clash on ' + fmt(clash.date) + ': ' + (clash.out.name || 'checkout') + ' → ' + (clash.in.name || 'check-in') +
      (clash.gapMinutes < 0 ? ' overlaps by ' + mins + ' min' : ' leaves no cleaning window'), 'warn');
  }
  if (typeof globalThis.renderAll === 'function') globalThis.renderAll();
  showDetail(id); // refresh the open detail with the new time + custom marker
}
globalThis.saveBookingTurnoverTime = saveBookingTurnoverTime;
window.saveBookingTurnoverTime = saveBookingTurnoverTime;

async function addBooking() {
  const name = document.getElementById('b-name').value.trim();
  const checkin = document.getElementById('b-checkin').value;
  const checkout = document.getElementById('b-checkout').value;
  const guests = document.getElementById('b-guests').value;
  if (!name || !checkin || !checkout || !guests) {
    globalThis.showBanner('⚠ Please fill in guest name, dates and guests', 'warn');
    return;
  }
  const newB = {
    id: Date.now(),
    name,
    checkin,
    checkout,
    nights: Number(document.getElementById('b-nights').value) || 1,
    guests: Number(guests),
    hostPayout: Number(document.getElementById('b-hostpayout').value) || 0,
    cleaningFee: Number(document.getElementById('b-cleaningfee').value) || 0,
    mgmtFeeRaw: Number(document.getElementById('b-mgmtfee').value) || 0,
    mgmtFee: 0,
    platform: document.getElementById('b-platform').value || '',
    mgmtPayout: 0,
    netPayout: 0,
    cleanerConfirmed: false,
    status: document.getElementById('b-status').value,
    _local: true,
  };
  bookings.push(newB);
  const autoAssigned = maybeAutoAssignPreferredCleaner(newB, 'booking-create');
  normalizeBookingCleanState();

  if (typeof globalThis.saveBookingToCloud === 'function') {
    try {
      await globalThis.saveBookingToCloud(newB);
    } catch (e) {
      console.error('[StayOps] Cloud save failed:', e);
      globalThis.showBanner('Changes saved locally, cloud sync failed', 'warn');
    }
  }

  if (autoAssigned && typeof globalThis.saveCleansToCloud === 'function') {
    try {
      const newClean = findMatchingCleanForBooking(newB);
      if (newClean) await globalThis.saveCleansToCloud([newClean]);
    } catch (e) {
      console.error('[StayOps] Cloud save failed:', e);
      globalThis.showBanner('Changes saved locally, cloud sync failed', 'warn');
    }
  }

  if (typeof globalThis.closeModal === 'function') globalThis.closeModal();
  if (typeof globalThis.render === 'function') globalThis.render();
  globalThis.showBanner('✅ Booking added', 'ok');
  if (typeof globalThis.renderOnboardingGuidance === 'function') globalThis.renderOnboardingGuidance();
}

async function addNote() {
  const bookingId = Number(document.getElementById('note-booking-select').value);
  const text = document.getElementById('note-text').value.trim();
  const tag = document.getElementById('note-tag').value;
  if (!bookingId || !text) {
    globalThis.showBanner('⚠ Please select a booking and add a note', 'warn');
    return;
  }
  const booking = bookings.find(b => String(b.id) === String(bookingId) || String(b._cloudId) === String(bookingId));
  if (!booking) {
    globalThis.showBanner('⚠ Booking not found — it may have been deleted', 'warn');
    return;
  }
  const newNote = { id: Date.now(), bookingId, guestName: booking.name, text, tag, date: localDateStr() };
  notes.push(newNote);
  document.getElementById('note-text').value = '';
  if (typeof globalThis.saveNotesToCloud === 'function') {
    try {
      await globalThis.saveNotesToCloud([newNote]);
    } catch (e) {
      console.error('[StayOps] Cloud save failed:', e);
      globalThis.showBanner('Changes saved locally, cloud sync failed', 'warn');
    }
  }
  renderNotes();
  globalThis.showBanner('✅ Note saved', 'ok');
}

function showCancelBookingDialog(booking) {
  return new Promise(resolve => {
    const cancelledAt = new Date().toISOString();
    const windowDays = getCancellationWindowDays();
    const suggested = isCancellationInsideWindow(booking, cancelledAt, windowDays);
    const days = Math.max(0, Math.ceil((new Date(String(booking.checkin || '').slice(0, 10) + 'T00:00:00') - new Date(cancelledAt.slice(0, 10) + 'T00:00:00')) / 86400000));
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10020;background:rgba(28,38,32,0.38);display:flex;align-items:center;justify-content:center;padding:18px;font-family:\'Plus Jakarta Sans\',sans-serif';
    overlay.innerHTML = `
      <div style="width:min(430px,100%);background:#fff;border-radius:16px;box-shadow:0 18px 60px rgba(0,0,0,0.18);padding:18px">
        <div style="font-size:18px;font-weight:700;color:var(--ink-1);margin-bottom:6px">Cancel booking</div>
        <div style="font-size:13px;color:var(--muted-2);line-height:1.45;margin-bottom:16px">${escHtml(booking.name || 'This guest')} checks in ${days} day${days === 1 ? '' : 's'} from now. The cancellation window is ${windowDays} day${windowDays === 1 ? '' : 's'}.</div>
        <label style="display:flex;align-items:center;justify-content:space-between;gap:14px;border:1px solid var(--hairline-1);border-radius:12px;padding:14px;margin:0 0 10px;text-transform:none;cursor:pointer">
          <span style="min-width:0">
            <span style="display:block;font-size:14px;font-weight:700;color:var(--ink-1)">Still bill this cancellation?</span>
            <span style="display:block;font-size:12px;color:var(--muted-2);margin-top:3px">${suggested ? 'Suggested on: inside the cancellation window.' : 'Suggested off: outside the cancellation window.'}</span>
          </span>
          <button type="button" id="cancel-billable-toggle" class="toggle ${suggested ? 'on' : ''}" aria-label="Still bill this cancellation?" style="flex-shrink:0"></button>
        </label>
        <div style="display:flex;gap:8px;margin-top:16px">
          <button type="button" id="cancel-booking-dismiss" style="flex:1;border:1px solid var(--hairline-1);background:#fff;color:var(--ink-2);border-radius:12px;padding:12px;font-size:14px;font-weight:700;font-family:inherit;cursor:pointer">Keep booking</button>
          <button type="button" id="cancel-booking-confirm" style="flex:1;border:none;background:var(--red);color:#fff;border-radius:12px;padding:12px;font-size:14px;font-weight:700;font-family:inherit;cursor:pointer">Cancel booking</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    let billable = suggested;
    const done = (value) => {
      overlay.remove();
      resolve(value);
    };
    overlay.querySelector('#cancel-billable-toggle').onclick = (e) => {
      e.preventDefault();
      billable = !billable;
      e.currentTarget.classList.toggle('on', billable);
    };
    overlay.querySelector('#cancel-booking-dismiss').onclick = () => done(null);
    overlay.querySelector('#cancel-booking-confirm').onclick = () => done({ cancelledAt, billable });
    overlay.onclick = (e) => { if (e.target === overlay) done(null); };
  });
}

async function deleteBooking(id) {
  const deletedBooking = bookings.find(
    b => String(b._cloudId || '') === String(id) || String(b.id) === String(id)
  );
  if (!deletedBooking) {
    console.warn('[StayOps] deleteBooking: booking not found in memory:', id);
    globalThis.showBanner('Booking not found', 'warn');
    return;
  }
  const cancelChoice = await showCancelBookingDialog(deletedBooking);
  if (!cancelChoice) return;

  console.log('[StayOps] deleteBooking: cancellation requested', {
    id,
    localId: deletedBooking ? deletedBooking.id : null,
    cloudId: deletedBooking ? deletedBooking._cloudId : null,
  });

  applyCancellationPolicy(deletedBooking, {
    cancelledAt: cancelChoice.cancelledAt,
    billable: cancelChoice.billable,
  });
  if (typeof globalThis.saveBookingToCloud === 'function') {
    try {
      await globalThis.saveBookingToCloud(deletedBooking);
    } catch (e) {
      console.error('[StayOps] deleteBooking: cloud cancellation failed', e);
      globalThis.showBanner('Could not cancel booking - please try again', 'warn');
      return;
    }
  }

  const deletedLocalId = String(deletedBooking.id);
  const deletedCloudId = String(deletedBooking._cloudId || '');
  const deletedGuestName = deletedBooking.name;

  // Match records to THIS booking by id first. The guest-name fallback is
  // dangerous for repeat guests — name alone would also sweep a DIFFERENT
  // upcoming stay's clean/notes (silent data loss). So only apply the name
  // fallback when it lines up with this exact booking: a clean must fall on
  // the booking's checkout date; notes carry no stay-date, so they match by
  // id only (no name fallback).
  const deletedCheckout = deletedBooking.checkout ? String(deletedBooking.checkout) : '';
  const cleanBelongsToBooking = (c) =>
    String(c.bookingId) === deletedLocalId ||
    (deletedCloudId && String(c.bookingId) === deletedCloudId) ||
    (deletedGuestName && c.guestName === deletedGuestName &&
      deletedCheckout && String(c.date) === deletedCheckout);
  const noteBelongsToBooking = (n) =>
    String(n.bookingId) === deletedLocalId ||
    (deletedCloudId && String(n.bookingId) === deletedCloudId);

  const orphanedCleans = cleans.filter(cleanBelongsToBooking);
  const orphanedNotes = notes.filter(noteBelongsToBooking);

  // Cancelled bookings stay in memory so revenue and the Cancelled tab reflect the new state immediately.
  replaceArrayInPlace(cleans, cleans.filter(c => !cleanBelongsToBooking(c)));
  replaceArrayInPlace(notes, notes.filter(n => !noteBelongsToBooking(n)));

  // In-memory arrays are the source of truth (cloud already deleted above).

  // ── Send cancellation email to assigned cleaner(s) ──────────────────────
  if (orphanedCleans.length && typeof globalThis.isNotifEnabled === 'function' && globalThis.isNotifEnabled('email_cancellation')) {
    for (const c of orphanedCleans) {
      if (!c.cleaner) continue;
      try {
        // Look up cleaner email from the cleaners list
        const cleaners = (typeof globalThis.loadCleaners === 'function' ? globalThis.loadCleaners() : []) || [];
        const cleanerObj = cleaners.find(cl =>
          cl.name === c.cleaner || String(cl.id) === String(c.cleanerId || c.cleaner_id)
        );
        const email = cleanerObj && cleanerObj.email ? cleanerObj.email.trim() : '';
        if (email) {
          await sendCleanerEmail({
            cleanerName: c.cleaner,
            cleanerEmail: email,
            guestName: deletedGuestName || 'Guest',
            checkin: deletedBooking.checkin ? fmt(deletedBooking.checkin) : '',
            checkout: deletedBooking.checkout ? fmt(deletedBooking.checkout) : '',
            cleanDate: c.date || (deletedBooking.checkout ? fmt(deletedBooking.checkout) : ''),
            type: 'cancellation',
          });
          // Mark cleaner as notified about cancellation
          c.cleanerCancelNotified = true;
          if (window._sb && c._cloudId) {
            window._sb.from('cleans').update({ cleaner_cancel_notified: true, updated_at: new Date().toISOString() }).eq('id', c._cloudId).then(() => {}).catch(() => {});
          }
          console.log('[StayOps] Cancellation email sent to', c.cleaner, email);
        }
      } catch (e) {
        console.warn('[StayOps] Cancellation email failed for', c.cleaner, e);
      }
    }
  }

  const user = typeof globalThis.getCurrentSupabaseUser === 'function' ? await globalThis.getCurrentSupabaseUser() : null;
  if (user && window._sb) {
    if (orphanedCleans.length) {
      console.log('[StayOps] Deleting orphaned cleans from Supabase:', orphanedCleans.map(c => c._cloudId || String(c.id)));
      for (const c of orphanedCleans) {
        try {
          // Route through deleteCleanFromCloud (wrapped by calendar-sync-outbound)
          // so the clean's calendar event is also deleted, not just the DB row.
          if (typeof globalThis.deleteCleanFromCloud === 'function') {
            await globalThis.deleteCleanFromCloud(c);
          } else if (c._cloudId) {
            await window._sb.from('cleans').delete().eq('id', c._cloudId);
          } else {
            await window._sb.from('cleans').delete().eq('user_id', user.id).eq('local_id', String(c.id));
          }
        } catch (e) {
          console.warn('[StayOps] Failed to delete orphaned clean from cloud', e);
        }
      }
    }

    if (orphanedNotes.length) {
      console.log('[StayOps] Deleting orphaned notes from Supabase:', orphanedNotes.map(n => n._cloudId || String(n.id)));
      for (const n of orphanedNotes) {
        try {
          if (n._cloudId) {
            await window._sb.from('notes').delete().eq('id', n._cloudId);
          } else {
            await window._sb.from('notes').delete().eq('user_id', user.id).eq('local_id', String(n.id));
          }
        } catch (e) {
          console.warn('[StayOps] Failed to delete orphaned note from cloud', e);
        }
      }
    }
  }

  if (typeof globalThis.reloadInMemoryData === 'function') globalThis.reloadInMemoryData();
  if (typeof globalThis.renderAll === 'function') globalThis.renderAll();
  if (typeof globalThis.closeDetailModal === 'function') globalThis.closeDetailModal();

  console.log('[StayOps] deleteBooking: done');
  globalThis.showBanner(cancelChoice.billable ? 'Booking cancelled - late cancel billed' : 'Booking cancelled', 'ok');
}

async function setCancellationBillable(id, billable) {
  const booking = bookings.find(
    b => String(b._cloudId || '') === String(id) || String(b.id) === String(id)
  );
  if (!booking) {
    globalThis.showBanner('Booking not found', 'warn');
    return;
  }
  if (booking.status !== 'cancelled') {
    globalThis.showBanner('Only cancelled bookings can be marked billed or refunded', 'warn');
    return;
  }

  const keepCancelledAt = booking.cancelledAt || booking.cancelled_at || new Date().toISOString();
  applyCancellationPolicy(booking, { cancelledAt: keepCancelledAt, billable });

  if (typeof globalThis.saveBookingToCloud === 'function') {
    try {
      await globalThis.saveBookingToCloud(booking);
    } catch (e) {
      console.error('[StayOps] setCancellationBillable: cloud sync failed', e);
      globalThis.showBanner('Changes saved locally, cloud sync failed', 'warn');
      return;
    }
  }

  if (typeof globalThis.renderAll === 'function') globalThis.renderAll();
  else renderBookings();
  showDetail(String(booking._cloudId || booking.id));
  globalThis.showBanner(
    (booking.name || 'Booking') + (billable ? ' marked as billed' : ' marked as refunded'),
    'ok'
  );
}

function importAirbnbCSV(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async function (e) {
    const lines = e.target.result.trim().split('\n');
    if (lines.length < 2) return;

    const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().trim());
    const col = name => headers.indexOf(name);

    const iCode = col('confirmation code');
    const iStatus = col('status');
    const iName = col('guest name');
    const iContact = col('contact');
    const iAdults = col('# of adults');
    const iChildren = col('# of children');
    const iStart = col('start date');
    const iEnd = col('end date');
    const iNights = col('# of nights');
    const iEarnings = col('earnings');

    if (iName === -1 || iStart === -1) {
      document.getElementById('import-preview').textContent = '✕ This does not look like an Airbnb reservations CSV.';
      return;
    }

    const existingCodes = new Set(bookings.map(b => b.confirmCode || b.confirmation_code || ''));
    let imported = 0,
      skipped = 0;

    const newBookings = [];
    lines.forEach((line, i) => {
      if (i === 0) return;
      const p = parseCSVLine(line);
      if (!p[iName] && !p[iStart]) return;

      const confirmCode = p[iCode] ? p[iCode].trim() : '';
      if (confirmCode && existingCodes.has(confirmCode)) {
        skipped++;
        return;
      }

      const statusRaw = (p[iStatus] || '').trim().toLowerCase();
      const status = statusRaw === 'cancelled' ? 'cancelled' : 'confirmed';
      const adults = parseInt(p[iAdults] || '0', 10) || 0;
      const children = parseInt(p[iChildren] || '0', 10) || 0;
      const guests = adults + children || 1;
      const checkin = toISO((p[iStart] || '').trim());
      const checkout = toISO((p[iEnd] || '').trim());
      const nights = parseInt(p[iNights] || '0', 10) || 0;
      const payout = toNum(p[iEarnings] || '');
      const name = (p[iName] || '').trim();
      const phone = iContact !== -1 ? (p[iContact] || '').trim() : '';

      if (!name || !checkin) return;

      newBookings.push({
        id: Date.now() + i,
        checkin,
        checkout,
        nights,
        name,
        guests,
        hostPayout: payout,
        cleaningFee: 0,
        mgmtFee: 0,
        mgmtPayout: 0,
        netPayout: payout,
        mgmtFeeRaw: 0,
        platform: 'Airbnb',
        status,
        confirmCode,
        phone,
        cleanerConfirmed: false,
        _local: true,
      });
      existingCodes.add(confirmCode);
      imported++;
    });

    if (!newBookings.length) {
      const msg =
        skipped > 0
          ? `All ${skipped} booking${skipped !== 1 ? 's' : ''} already exist — nothing new to import.`
          : 'No valid bookings found in this file.';
      document.getElementById('airbnb-import-preview').textContent = msg;
      return;
    }

    bookings.push(...newBookings);

    if (typeof globalThis.saveBookingsToCloud === 'function') {
      try {
        await globalThis.saveBookingsToCloud(newBookings);
      } catch (e) {
        console.error('[StayOps] Cloud save failed:', e);
        globalThis.showBanner('Changes saved locally, cloud sync failed', 'warn');
      }
    }

    const msg =
      skipped > 0
        ? `✓ Imported ${imported} booking${imported !== 1 ? 's' : ''}. Skipped ${skipped} duplicate${skipped !== 1 ? 's' : ''}.`
        : `✓ Imported ${imported} booking${imported !== 1 ? 's' : ''} from Airbnb.`;
    document.getElementById('airbnb-import-preview').textContent = msg;
    setTimeout(() => {
      if (typeof globalThis.closeModal === 'function') globalThis.closeModal();
      if (typeof globalThis.render === 'function') globalThis.render();
    }, 1400);
  };
  reader.readAsText(file);
}

function importCSV(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async function (e) {
    const lines = e.target.result.trim().split('\n');
    let imported = 0;
    const newBookings = [];
    lines.forEach((line, i) => {
      if (i === 0) return;
      const p = parseCSVLine(line);
      if (!p[0] && !p[3]) return;
      const name = String(p[3] || '').trim();
      const checkin = toISO(String(p[0] || '').trim());
      if (!name || !checkin) return;
      const nb = {
        id: Date.now() + i,
        checkin,
        nights: Number(p[1]) || 1,
        checkout: toISO(String(p[2] || '')),
        name,
        guests: Number(p[4]) || 1,
        hostPayout: toNum(p[5]),
        cleaningFee: toNum(p[6]),
        mgmtFee: toNum(p[7]),
        mgmtPayout: toNum(p[8]),
        netPayout: toNum(p[9]),
        mgmtFeeRaw: toNum(p[5]) ? Math.round((toNum(p[7]) / toNum(p[5])) * 1000) / 10 : 0,
        cleanerConfirmed: ['yes', 'true', '1', 'TRUE'].includes(String(p[10] || '').trim()),
        platform: String(p[11] || '').trim(),
        status: 'confirmed',
        _local: true,
      };
      bookings.push(nb);
      newBookings.push(nb);
      imported++;
    });
    if (newBookings.length && typeof globalThis.saveBookingsToCloud === 'function') {
      try {
        await globalThis.saveBookingsToCloud(newBookings);
      } catch (e) {
        console.error('[StayOps] Cloud save failed:', e);
        globalThis.showBanner('Changes saved locally, cloud sync failed', 'warn');
      }
    }
    document.getElementById('import-preview').textContent = `✓ Imported ${imported} booking${imported !== 1 ? 's' : ''}`;
    setTimeout(() => {
      if (typeof globalThis.closeModal === 'function') globalThis.closeModal();
      if (typeof globalThis.render === 'function') globalThis.render();
    }, 1200);
  };
  reader.readAsText(file);
}

function switchModalTab(tab, btn) {
  document.querySelectorAll('#modal .tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('modal-manual').style.display = tab === 'manual' ? 'block' : 'none';
  document.getElementById('modal-screenshot').style.display = tab === 'screenshot' ? 'block' : 'none';
  document.getElementById('modal-import').style.display = tab === 'import' ? 'block' : 'none';
}

function toNum(val) {
  if (!val) return 0;
  return Number(String(val).replace(/[$,%\s]/g, '')) || 0;
}
function toISO(val) {
  if (!val) return '';
  val = String(val).trim();
  if (val.includes('T') || val.includes('Z')) {
    const d = new Date(val);
    if (!isNaN(d.getTime())) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
  const slashParts = val.split('/');
  if (slashParts.length === 3) {
    if (slashParts[0].length === 4) {
      const [y, m, d] = slashParts;
      return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    const [d, m, y] = slashParts;
    return `${y.length === 2 ? '20' + y : y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const dashParts = val.split('-');
  if (dashParts.length === 3 && dashParts[0].length <= 2) {
    const [d, m, y] = dashParts;
    return `${y.length === 2 ? '20' + y : y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  if (/^\d{4,6}$/.test(val)) {
    const epoch = new Date(1899, 11, 30);
    epoch.setDate(epoch.getDate() + Number(val));
    return localDateStr(epoch);
  }
  const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const tm = val.match(/^(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4})$/);
  if (tm && months[tm[2].toLowerCase()] !== undefined) {
    return `${tm[3]}-${String(months[tm[2].toLowerCase()] + 1).padStart(2, '0')}-${tm[1].padStart(2, '0')}`;
  }
  return val;
}
function getStatus(checkin) {
  const now = new Date(),
    ci = new Date(checkin);
  if (ci < now) return 'completed';
  return 'upcoming';
}
function parseCSVLine(line) {
  const result = [];
  let current = '',
    inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      inQuotes = !inQuotes;
    } else if (line[i] === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += line[i];
    }
  }
  result.push(current.trim());
  return result;
}
function getBookingIdentityKey(booking) {
  if (!booking) return '';
  const name = String(booking.name || '').trim().toLowerCase();
  const checkin = String(booking.checkin || '').trim();
  const checkout = String(booking.checkout || '').trim();
  const confirmCode = String(booking.confirmCode || '').trim().toLowerCase();
  return [name, checkin, checkout, confirmCode].join('|');
}

async function saveCleaningFee(bookingId) {
  const b = bookings.find(bk => String(bk.id) === String(bookingId) || (bk._cloudId && String(bk._cloudId) === String(bookingId)));
  const input = document.getElementById('actual-clean-fee');
  if (!b || !input) return;
  b.cleaningFee = Number(input.value) || 0;

  // Recalculate management payout (same formula as saveEdit)
  const mgmtPct = Number(b.mgmtFeeRaw) || 0;
  if (mgmtPct) {
    const mgmtBase = (Number(b.hostPayout) || 0) - b.cleaningFee;
    b.mgmtFee = Math.round((mgmtBase * mgmtPct) / 100 * 100) / 100;
    b.mgmtPayout = b.mgmtFee;
    b.netPayout = Math.round((mgmtBase - b.mgmtFee) * 100) / 100;
  }

  if (typeof globalThis.saveBookingToCloud === 'function') {
    try {
      await globalThis.saveBookingToCloud(b);
    } catch (e) {
      console.error('[StayOps] Cloud save failed:', e);
      globalThis.showBanner('Changes saved locally, cloud sync failed', 'warn');
    }
  }
  globalThis.showBanner('✓ Cleaning fee saved & payout recalculated', 'ok');
  // Refresh the detail view so the updated payout is visible
  if (typeof showDetail === 'function') showDetail(bookingId);
}

/** Persist a clean's actual cost AND recompute the booking's mgmt fee + net
 *  payout. Reusable from saveCleanCost (booking-detail UI) and from the
 *  expense-link path (when a Cleaning expense gets attached to a booking).
 *  Returns { ok: true } on success or { ok: false, error } on cloud failure. */
async function applyCleanCostAndRecompute(cleanId, bookingId, amount) {
  const c = cleans.find(cl => String(cl.id) === String(cleanId) || (cl._cloudId && String(cl._cloudId) === String(cleanId)));
  if (!c) return { ok: false, error: 'clean not found' };
  c.cost = (amount === null || amount === '' || amount === undefined) ? null : Number(amount);
  if (typeof globalThis.saveCleanToCloud === 'function') {
    try { await globalThis.saveCleanToCloud(c); }
    catch (e) { return { ok: false, error: e }; }
  }

  const b = bookings.find(bk => String(bk.id) === String(bookingId) || (bk._cloudId && String(bk._cloudId) === String(bookingId)));
  if (b) {
    const mgmtPct = Number(b.mgmtFeeRaw) || 0;
    const effectiveClean = (c.cost != null && c.cost !== '') ? Number(c.cost) : (Number(b.cleaningFee) || 0);
    b.cleaningFee = effectiveClean;
    const mgmtBase = (Number(b.hostPayout) || 0) - effectiveClean;
    if (mgmtPct) {
      b.mgmtFee = Math.round((mgmtBase * mgmtPct) / 100 * 100) / 100;
      b.mgmtPayout = b.mgmtFee;
      b.netPayout = Math.round((mgmtBase - b.mgmtFee) * 100) / 100;
    } else {
      b.netPayout = Math.round(mgmtBase * 100) / 100;
    }
    if (typeof globalThis.saveBookingToCloud === 'function') {
      try { await globalThis.saveBookingToCloud(b); }
      catch (e) { return { ok: false, error: e }; }
    }
  }
  return { ok: true };
}

async function saveCleanCost(cleanId, bookingId) {
  const input = document.getElementById('actual-clean-fee');
  if (!input) return;
  const amount = Number(input.value) || 0;
  const res = await applyCleanCostAndRecompute(cleanId, bookingId, amount);
  if (!res.ok) {
    console.error('[StayOps] saveCleanCost failed:', res.error);
    globalThis.showBanner('Changes saved locally, cloud sync failed', 'warn');
    if (typeof showDetail === 'function') showDetail(bookingId);
    return;
  }
  globalThis.showBanner('✓ Cleaning cost saved & payout recalculated', 'ok');
  if (typeof showDetail === 'function') showDetail(bookingId);
}

/** Called from the expense add/edit flow when an expense is linked to a
 *  booking. Mirrors the expense.amount into the booking's clean.cost and
 *  triggers the mgmt fee + net payout recompute. */
async function applyExpenseToBookingClean(bookingId, amount) {
  if (!bookingId) return { ok: false, error: 'no bookingId' };
  const b = bookings.find(bk => String(bk.id) === String(bookingId) || (bk._cloudId && String(bk._cloudId) === String(bookingId)));
  if (!b) return { ok: false, error: 'booking not found' };
  const clean = findMatchingCleanForBooking(b);
  if (!clean) return { ok: false, error: 'no clean record for booking' };
  return await applyCleanCostAndRecompute(clean._cloudId || clean.id, b._cloudId || b.id, amount);
}

/** Clear the cleaning cost on a booking's matched clean (used when an
 *  expense is unlinked or deleted). */
async function clearExpenseFromBookingClean(bookingId) {
  if (!bookingId) return;
  const b = bookings.find(bk => String(bk.id) === String(bookingId) || (bk._cloudId && String(bk._cloudId) === String(bookingId)));
  if (!b) return;
  const clean = findMatchingCleanForBooking(b);
  if (!clean) return;
  await applyCleanCostAndRecompute(clean._cloudId || clean.id, b._cloudId || b.id, null);
}

/** Yellow banner shown on a booking detail when a modification email was
 *  detected for this booking. Stays visible until "Mark as reviewed" clears
 *  the modificationPendingAt flag. Lets the host verify the new values on
 *  the source platform (since Airbnb modification emails often hide the new
 *  payout behind a link). */
function _renderModificationBanner(b, safeIdEsc) {
  if (!b || !b.modificationPendingAt) return '';
  const when = (() => {
    try {
      const d = new Date(b.modificationPendingAt);
      return d.toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch (_e) { return ''; }
  })();
  const platform = String(b.platform || '').toLowerCase();
  let platformLink = '';
  if (platform === 'airbnb' && b.confirmCode) {
    const code = escHtml(String(b.confirmCode));
    platformLink = `<a href="https://www.airbnb.com/hosting/reservations/details/${code}" target="_blank" rel="noopener" style="display:inline-block;background:#FFFFFF;color:#8A5A00;border:1px solid #E8C265;border-radius:8px;padding:8px 12px;font-size:12px;font-weight:600;text-decoration:none;font-family:'Plus Jakarta Sans',sans-serif;touch-action:manipulation">Open on Airbnb</a>`;
  } else if (platform === 'airbnb') {
    platformLink = `<a href="https://www.airbnb.com/hosting/reservations" target="_blank" rel="noopener" style="display:inline-block;background:#FFFFFF;color:#8A5A00;border:1px solid #E8C265;border-radius:8px;padding:8px 12px;font-size:12px;font-weight:600;text-decoration:none;font-family:'Plus Jakarta Sans',sans-serif;touch-action:manipulation">Open on Airbnb</a>`;
  }
  return `
    <div style="background:#FFF7E0;border:1px solid #E8C265;border-radius:12px;padding:14px 16px;margin-bottom:20px;display:flex;flex-direction:column;gap:10px;font-family:'Plus Jakarta Sans',sans-serif">
      <div style="display:flex;align-items:flex-start;gap:10px">
        <div style="font-size:18px;line-height:1.2;flex-shrink:0">⚠️</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:#5C3C00">Modified by guest${when ? ' on ' + when : ''}</div>
          <div style="font-size:12px;color:#7A5400;margin-top:2px;line-height:1.4">Verify the new guest count, dates, or payout on the platform — the modification email may not include every change.</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${platformLink}
        <button type="button" onclick="clearModificationFlag('${safeIdEsc}')" style="background:transparent;color:#8A5A00;border:1px solid #E8C265;border-radius:8px;padding:8px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;touch-action:manipulation">Mark as reviewed</button>
      </div>
    </div>
  `;
}

async function clearModificationFlag(bookingId) {
  const b = bookings.find(bk => String(bk.id) === String(bookingId) || (bk._cloudId && String(bk._cloudId) === String(bookingId)));
  if (!b) return;
  b.modificationPendingAt = null;
  if (typeof globalThis.saveBookingToCloud === 'function') {
    try {
      await globalThis.saveBookingToCloud(b);
    } catch (e) {
      console.error('[StayOps] Clear modification flag failed:', e);
      globalThis.showBanner('Marked locally, cloud sync failed', 'warn');
      if (typeof showDetail === 'function') showDetail(bookingId);
      return;
    }
  }
  globalThis.showBanner('✓ Marked as reviewed', 'ok');
  if (typeof showDetail === 'function') showDetail(bookingId);
}

/** Aliases for clarity (same as showEditModal / saveEdit). */
const editBooking = showEditModal;
const saveBookingEdit = saveEdit;

// ── BOOKING FILTER SHEET ────────────────────────────────────────────────────
const _bkFilterState = { sources: [], statuses: [], dateRange: 'all' };
const _BK_SOURCES = ['Direct', 'Airbnb', 'Booking.com', 'VRBO'];
const _BK_STATUSES = ['Confirmed', 'Pending', 'Cancelled', 'Past'];
const _BK_DATE_RANGES = [
  { key: 'all', label: 'All time', sub: '' },
  { key: 'this-month', label: 'This month', sub: () => { const n = new Date(); return `1 – ${new Date(n.getFullYear(), n.getMonth() + 1, 0).getDate()} ${n.toLocaleDateString('en-AU', { month: 'short' })}`; } },
  { key: 'next-30', label: 'Next 30 days', sub: () => { const s = new Date(); const e = new Date(s.getTime() + 30 * 86400000); return `${s.getDate()} ${s.toLocaleDateString('en-AU', { month: 'short' })} – ${e.getDate()} ${e.toLocaleDateString('en-AU', { month: 'short' })}`; } },
  { key: 'last-90', label: 'Last 90 days', sub: () => { const e = new Date(); const s = new Date(e.getTime() - 90 * 86400000); return `${s.getDate()} ${s.toLocaleDateString('en-AU', { month: 'short' })} – ${e.getDate()} ${e.toLocaleDateString('en-AU', { month: 'short' })}`; } },
];

function _bkFilterPill(label, active) {
  const bg = active ? 'var(--primary-soft,#dde8e1)' : '#fff';
  const color = active ? 'var(--primary-ink,#1f3f35)' : 'var(--ink-2,#4a5751)';
  const border = active ? 'var(--primary,#2f5d4e)' : 'var(--hairline-1,#e8e1d3)';
  return `<div style="padding:8px 14px;border-radius:999px;font-size:13px;font-weight:600;background:${bg};color:${color};border:1px solid ${border};cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif" data-val="${escHtml(label)}">${escHtml(label)}</div>`;
}

function _renderFilterPills() {
  const srcEl = document.getElementById('bk-filter-source-pills');
  const statEl = document.getElementById('bk-filter-status-pills');
  if (srcEl) {
    srcEl.innerHTML = _BK_SOURCES.map(s => _bkFilterPill(s, _bkFilterState.sources.includes(s))).join('');
    srcEl.querySelectorAll('[data-val]').forEach(el => {
      el.onclick = () => {
        const v = el.getAttribute('data-val');
        const idx = _bkFilterState.sources.indexOf(v);
        if (idx >= 0) _bkFilterState.sources.splice(idx, 1);
        else _bkFilterState.sources.push(v);
        _renderFilterPills();
      };
    });
  }
  if (statEl) {
    statEl.innerHTML = _BK_STATUSES.map(s => _bkFilterPill(s, _bkFilterState.statuses.includes(s))).join('');
    statEl.querySelectorAll('[data-val]').forEach(el => {
      el.onclick = () => {
        const v = el.getAttribute('data-val');
        const idx = _bkFilterState.statuses.indexOf(v);
        if (idx >= 0) _bkFilterState.statuses.splice(idx, 1);
        else _bkFilterState.statuses.push(v);
        _renderFilterPills();
      };
    });
  }
  _updateFilterDateDisplay();
  _updateFilterCount();
}

function _updateFilterDateDisplay() {
  const range = _BK_DATE_RANGES.find(r => r.key === _bkFilterState.dateRange) || _BK_DATE_RANGES[0];
  const label = document.getElementById('bk-filter-date-label');
  const sub = document.getElementById('bk-filter-date-sub');
  if (label) label.textContent = range.label;
  if (sub) sub.textContent = typeof range.sub === 'function' ? range.sub() : (range.sub || '');
}

function _updateFilterCount() {
  const btn = document.getElementById('bk-filter-apply-btn');
  if (!btn) return;
  const count = _countFilteredBookings();
  btn.textContent = `Show ${count} booking${count !== 1 ? 's' : ''}`;
}

function _countFilteredBookings() {
  return _applyAdvancedFilters(bookings).length;
}

function _applyAdvancedFilters(list) {
  let filtered = [...list];
  if (_bkFilterState.sources.length) {
    filtered = filtered.filter(b => {
      const plat = normalizePlatformLabel(b.platform) || 'Direct';
      return _bkFilterState.sources.some(s => plat.toLowerCase().includes(s.toLowerCase()));
    });
  }
  if (_bkFilterState.statuses.length) {
    const now = new Date();
    filtered = filtered.filter(b => {
      for (const s of _bkFilterState.statuses) {
        if (s === 'Cancelled' && b.status === 'cancelled') return true;
        if (s === 'Confirmed' && b.status !== 'cancelled' && new Date(b.checkout) >= now) return true;
        if (s === 'Pending' && b.enrichment_status === 'pending') return true;
        if (s === 'Past' && b.status !== 'cancelled' && new Date(b.checkout) < now) return true;
      }
      return false;
    });
  }
  if (_bkFilterState.dateRange !== 'all') {
    const now = new Date();
    let start, end;
    if (_bkFilterState.dateRange === 'this-month') {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    } else if (_bkFilterState.dateRange === 'next-30') {
      start = now;
      end = new Date(now.getTime() + 30 * 86400000);
    } else if (_bkFilterState.dateRange === 'last-90') {
      start = new Date(now.getTime() - 90 * 86400000);
      end = now;
    }
    if (start && end) {
      filtered = filtered.filter(b => {
        const ci = new Date(b.checkin);
        const co = new Date(b.checkout);
        return ci <= end && co >= start;
      });
    }
  }
  return filtered;
}

function openBookingFilterSheet() {
  _renderFilterPills();
  const overlay = document.getElementById('booking-filter-overlay');
  if (overlay) overlay.classList.add('open');
}

function closeBookingFilterSheet() {
  const overlay = document.getElementById('booking-filter-overlay');
  if (overlay) overlay.classList.remove('open');
}

function cycleBookingFilterDateRange() {
  const idx = _BK_DATE_RANGES.findIndex(r => r.key === _bkFilterState.dateRange);
  _bkFilterState.dateRange = _BK_DATE_RANGES[(idx + 1) % _BK_DATE_RANGES.length].key;
  _updateFilterDateDisplay();
  _updateFilterCount();
}

function resetBookingFilters() {
  _bkFilterState.sources = [];
  _bkFilterState.statuses = [];
  _bkFilterState.dateRange = 'all';
  _renderFilterPills();
}

function applyBookingFilters() {
  closeBookingFilterSheet();
  renderBookings();
}

export {
  calPrev,
  calNext,
  updateCalStats,
  renderCalendar,
  openCalPreview,
  closeCalPreview,
  renderBookings,
  renderNotes,
  addNote,
  showDetail,
  showEditModal,
  editBooking,
  saveEdit,
  saveBookingEdit,
  editCalcNights,
  editCalcNet,
  filterBookings,
  addBooking,
  deleteBooking,
  setCancellationBillable,
  importAirbnbCSV,
  importCSV,
  switchModalTab,
  toNum,
  toISO,
  getStatus,
  parseCSVLine,
  getBookingIdentityKey,
  saveCleaningFee,
  saveCleanCost,
  applyExpenseToBookingClean,
  clearExpenseFromBookingClean,
  clearModificationFlag,
  switchBookingsView,
  renderBookingsCalendarView,
  openBookingFilterSheet,
  closeBookingFilterSheet,
  cycleBookingFilterDateRange,
  resetBookingFilters,
  applyBookingFilters,
};
