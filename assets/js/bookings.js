/**
 * StayOps — bookings list, detail, CSV import, dashboard calendar (Pass 9).
 * Uses globalThis for main.js / supabase hooks assigned at boot.
 */
import { bookings, cleans, notes, replaceArrayInPlace } from './state.js';
import {
  escHtml,
  fmt,
  escapeJsSingleQuotedHtmlAttr,
} from './utils.js';
import { buildBookingListCardFromBooking, normalizePlatformLabel } from './booking-list-card.js';
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
  assignCleanerToBooking,
  toggleCleanerConfirmed,
} from './cleaning.js';
import { sendCleanerEmail } from './notifications.js';
// ── DASHBOARD CALENDAR STATE ─────────────────────────────────────────────────
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth();

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
    return b.status !== 'cancelled' && d.getMonth() === calMonth && d.getFullYear() === calYear;
  }).reduce((s, b) => s + Number(b.hostPayout || 0), 0);

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
    const _emptyBtn = !hasAny ? '<div style="margin-top:14px"><button onclick="showAddBookingModal()" class="btn-primary" style="padding:10px 24px;font-size:14px">+ Add Booking</button></div>' : '';
    list.innerHTML = `<div class="card" style="text-align:center;padding:40px 24px 36px"><div style="font-size:36px;margin-bottom:14px;opacity:0.45">📅</div><div style="font-weight:700;font-size:15px;color:var(--forest);margin-bottom:6px">${_emptyTitle}</div><div style="font-size:12.5px;color:var(--text-soft);line-height:1.5">${_emptyHint}</div>${_emptyBtn}</div>`;
    return;
  }

  const sorted = [...filtered].sort((a, b) => new Date(a.checkin) - new Date(b.checkin));

  // Desktop: table view | Mobile: card view
  if (window.innerWidth >= 1024) {
    const fmtShort = d => { if (!d) return ''; const dt = new Date(d); return dt.toLocaleDateString('en-AU', { day:'numeric', month:'short' }); };
    const platformClass = p => { const lp = (p||'').toLowerCase(); if (lp.includes('airbnb')) return 'platform-airbnb'; if (lp.includes('vrbo')||lp.includes('homeaway')) return 'platform-vrbo'; if (lp.includes('booking')) return 'platform-booking'; return 'platform-direct'; };
    const statusBadge = b => {
      const today = new Date().toISOString().split('T')[0];
      const ci = (b.checkin||'').slice(0,10);
      const co = (b.checkout||'').slice(0,10);
      if (b.status === 'cancelled') return '<span class="dt-badge dt-badge-gray">Cancelled</span>';
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
        <td>$${Number(b.hostPayout||0).toLocaleString()}</td>
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
        <div style="font-size:11px;font-weight:700;color:var(--text-soft);text-transform:uppercase;letter-spacing:0.9px;padding:16px 4px 8px">${escHtml(monthLabel)}</div>
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
      '<div class="card" style="text-align:center;padding:28px 16px"><div style="font-size:36px;margin-bottom:10px">📝</div><div style="font-weight:600;font-size:14px;margin-bottom:4px">Select a property to view notes</div><div style="font-size:12px;color:var(--text-soft)">Notes are per property — open the property switcher and choose one property.</div></div>';
    return;
  }
  if (!notes.length) {
    list.innerHTML =
      '<div class="card" style="text-align:center;padding:28px 16px"><div style="font-size:36px;margin-bottom:10px">📝</div><div style="font-weight:600;font-size:14px;margin-bottom:4px">No notes yet</div><div style="font-size:12px;color:var(--text-soft)">Add notes about guests, special requests or anything useful</div></div>';
    return;
  }
  list.innerHTML = [...notes]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .map(
      n => `
    <div class="note-item">
      <div class="note-guest"><span class="note-tag tag-${n.tag}">${n.tag}</span>${n.guestName}</div>
      <div class="note-text">${n.text}</div>
      <div class="note-date">${fmt(n.date)}</div>
    </div>`
    )
    .join('');
}

function _bookingDetailPlatformPill(platform) {
  if (!platform) return '';
  const p = normalizePlatformLabel(platform);
  const base =
    'font-size:11px;font-weight:500;padding:1px 7px;border-radius:4px;display:inline-block';
  if (p === 'Airbnb') {
    return `<span style="${base};color:#FF5A5F;background:#FFF0F0">Airbnb</span>`;
  }
  if (p === 'VRBO') {
    return `<span style="${base};color:#3B5998;background:#EEF0FF">VRBO</span>`;
  }
  if (p === 'Direct') {
    return `<span style="${base};color:#3D6B4F;background:#E8F5E9">Direct</span>`;
  }
  return `<span style="${base};color:#666;background:#F1EFE8">${escHtml(p)}</span>`;
}

function _bookingDetailStayStatusBadge(isCancelled, isPast) {
  if (isCancelled) {
    return '<span style="font-size:11px;padding:2px 8px;border-radius:4px;display:inline-block;font-weight:500;color:#A32D2D;background:#FCEBEB">Cancelled</span>';
  }
  if (isPast) {
    return '<span style="font-size:11px;padding:2px 8px;border-radius:4px;display:inline-block;font-weight:500;color:#5F5E5A;background:#F1EFE8">Past</span>';
  }
  return '<span style="font-size:11px;padding:2px 8px;border-radius:4px;display:inline-block;font-weight:500;color:#0C447C;background:#E6F1FB">Upcoming</span>';
}

function _bookingDetailCleanerBadge(state) {
  const k = state.key;
  if (k === 'unassigned' || k === 'cancelled') {
    return '<span style="font-size:12px;padding:2px 8px;border-radius:4px;font-weight:500;white-space:nowrap;color:#A32D2D;background:#FCEBEB">No cleaner</span>';
  }
  if (k === 'done') {
    return '<span style="font-size:12px;padding:2px 8px;border-radius:4px;font-weight:500;white-space:nowrap;color:#5F5E5A;background:#F1EFE8">Done</span>';
  }
  if (k === 'confirmed') {
    return '<span style="font-size:12px;padding:2px 8px;border-radius:4px;font-weight:500;white-space:nowrap;color:#1D9E75;background:#E8F5E9">Confirmed</span>';
  }
  return '<span style="font-size:12px;padding:2px 8px;border-radius:4px;font-weight:500;white-space:nowrap;color:#BA7517;background:#FAEEDA">Awaiting</span>';
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
  const todayStr = new Date().toISOString().split('T')[0];
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
    document.getElementById('detail-content').innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:4px">
        <div style="font-size:18px;font-weight:500;color:#1a1a1a;flex:1;min-width:0">${escHtml(b.name)}</div>
      </div>
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:20px">
        ${b.platform ? _bookingDetailPlatformPill(b.platform) : ''}
        ${_bookingDetailStayStatusBadge(true, false)}
      </div>
      <div style="font-size:12px;font-weight:500;color:#999;margin:0 0 6px 2px">Stay details</div>
      <div style="background:white;border-radius:12px;border:0.5px solid rgba(0,0,0,0.1);margin-bottom:20px;overflow:hidden">
        <div style="padding:12px 14px;display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:13px;color:#666">Check-in</span>
          <span style="font-size:13px;font-weight:500;color:#1a1a1a">${fmt(b.checkin)}</span>
        </div>
        <div style="padding:12px 14px;border-top:0.5px solid rgba(0,0,0,0.1);margin-left:14px;display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:13px;color:#666">Check-out</span>
          <span style="font-size:13px;font-weight:500;color:#1a1a1a">${fmt(b.checkout)}</span>
        </div>
        <div style="padding:12px 14px;border-top:0.5px solid rgba(0,0,0,0.1);margin-left:14px;display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:13px;color:#666">Nights</span>
          <span style="font-size:13px;font-weight:500;color:#1a1a1a">${b.nights}</span>
        </div>
        <div style="padding:12px 14px;border-top:0.5px solid rgba(0,0,0,0.1);margin-left:14px;display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:13px;color:#666">Guests</span>
          <span style="font-size:13px;font-weight:500;color:#1a1a1a">${b.guests}</span>
        </div>
        <div style="padding:12px 14px;border-top:0.5px solid rgba(0,0,0,0.1);margin-left:14px;display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:13px;color:#666">Platform</span>
          <span style="font-size:13px;font-weight:500;color:#1a1a1a">${_bookingDetailPlatformPlain(b.platform)}</span>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-top:20px">
        <div style="flex:1;border:0.5px solid rgba(0,0,0,0.1);border-radius:10px;padding:12px;text-align:center;color:#666;font-size:13px;cursor:pointer;box-sizing:border-box;touch-action:manipulation" onclick="closeDetailModal()">Close</div>
        <div style="flex:1;background:#FCEBEB;border:0.5px solid #FCEBEB;border-radius:10px;padding:12px;text-align:center;color:#A32D2D;font-size:13px;font-weight:500;cursor:pointer;box-sizing:border-box;touch-action:manipulation" onclick="deleteBooking('${safeIdEsc}')">Delete booking</div>
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
      '\')" id="detail-assign-btn" style="width:100%;background:#2D5A3D;border-radius:10px;padding:12px;text-align:center;color:white;font-size:14px;font-weight:500;border:none;cursor:pointer;box-sizing:border-box;font-family:inherit;touch-action:manipulation">Save assignment</button>'
    );
  })();

  const cleanerTopName = bc.length
    ? escHtml(String(bc[0].cleaner || '—'))
    : 'No cleaner assigned';
  const cleanerDateLine = bc.length
    ? 'Clean date: ' + fmt(bc[0].date)
    : '';

  document.getElementById('detail-content').innerHTML = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:4px">
      <div style="font-size:18px;font-weight:500;color:#1a1a1a;flex:1;min-width:0">${escHtml(b.name)}</div>
      <span onclick="showEditModal('${safeIdEsc}')" style="color:#2D5A3D;font-size:13px;font-weight:500;cursor:pointer;flex-shrink:0;touch-action:manipulation;padding-top:2px">Edit</span>
    </div>
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:20px">
      ${b.platform ? _bookingDetailPlatformPill(b.platform) : ''}
      ${_bookingDetailStayStatusBadge(false, isPast)}
    </div>

    <div style="font-size:12px;font-weight:500;color:#999;margin:0 0 6px 2px">Stay details</div>
    <div style="background:white;border-radius:12px;border:0.5px solid rgba(0,0,0,0.1);margin-bottom:20px;overflow:hidden">
      <div style="padding:12px 14px;display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:13px;color:#666">Check-in</span>
        <span style="font-size:13px;font-weight:500;color:#1a1a1a">${fmt(b.checkin)}</span>
      </div>
      <div style="padding:12px 14px;border-top:0.5px solid rgba(0,0,0,0.1);margin-left:14px;display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:13px;color:#666">Check-out</span>
        <span style="font-size:13px;font-weight:500;color:#1a1a1a">${fmt(b.checkout)}</span>
      </div>
      <div style="padding:12px 14px;border-top:0.5px solid rgba(0,0,0,0.1);margin-left:14px;display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:13px;color:#666">Nights</span>
        <span style="font-size:13px;font-weight:500;color:#1a1a1a">${b.nights}</span>
      </div>
      <div style="padding:12px 14px;border-top:0.5px solid rgba(0,0,0,0.1);margin-left:14px;display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:13px;color:#666">Guests</span>
        <span style="font-size:13px;font-weight:500;color:#1a1a1a">${b.guests}</span>
      </div>
      <div style="padding:12px 14px;border-top:0.5px solid rgba(0,0,0,0.1);margin-left:14px;display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:13px;color:#666">Platform</span>
        <span style="font-size:13px;font-weight:500;color:#1a1a1a">${_bookingDetailPlatformPlain(b.platform)}</span>
      </div>
    </div>

    <div style="font-size:12px;font-weight:500;color:#999;margin:0 0 6px 2px">Financials</div>
    <div style="background:white;border-radius:12px;border:0.5px solid rgba(0,0,0,0.1);margin-bottom:20px;overflow:hidden">
      <div style="padding:12px 14px;display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:13px;color:#666">Gross revenue</span>
        <span style="font-size:13px;font-weight:500;color:#1D9E75">$${Number(b.hostPayout || 0).toLocaleString()}</span>
      </div>
      <div style="padding:12px 14px;border-top:0.5px solid rgba(0,0,0,0.1);margin-left:14px;display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:13px;color:#666">Cleaning fee</span>
        <span style="font-size:13px;font-weight:500;color:#1a1a1a">$${Number(b.cleaningFee || 0).toLocaleString()}</span>
      </div>
      <div style="padding:12px 14px;border-top:0.5px solid rgba(0,0,0,0.1);margin-left:14px;display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:13px;color:#666">Management fee</span>
        <span style="font-size:13px;font-weight:500;color:#1a1a1a">${mgmtPct}%</span>
      </div>
      <div style="padding:12px 14px;border-top:0.5px solid rgba(0,0,0,0.1);margin-left:14px;display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:13px;color:#666">Management payout</span>
        <span style="font-size:13px;font-weight:500;color:#1a1a1a">$${Number(b.mgmtPayout || 0).toLocaleString()}</span>
      </div>
      <div style="border-top:0.5px solid rgba(0,0,0,0.1)"></div>
      <div style="padding:12px 14px;background:#f5f5f3;border-radius:0 0 12px 12px;display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:13px;font-weight:500;color:#1a1a1a">Owner payout</span>
        <span style="font-size:14px;font-weight:500;color:#1D9E75">$${Number(b.netPayout || 0).toLocaleString()}</span>
      </div>
    </div>

    <div style="font-size:12px;font-weight:500;color:#999;margin:0 0 6px 2px">Cleaner</div>
    <div style="background:white;border-radius:12px;border:0.5px solid rgba(0,0,0,0.1);margin-bottom:20px;overflow:hidden">
      <div style="padding:14px;display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
        <div style="min-width:0;flex:1">
          <div style="font-size:15px;font-weight:500;color:#1a1a1a">${cleanerTopName}</div>
          ${cleanerDateLine ? `<div style="font-size:13px;color:#666;margin-top:4px">${cleanerDateLine}</div>` : ''}
        </div>
        <div style="flex-shrink:0;padding-top:2px">${_bookingDetailCleanerBadge(cleanerState)}</div>
      </div>
      <div style="border-top:0.5px solid rgba(0,0,0,0.1)"></div>
      <div class="toggle-wrap" style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;margin:0;border:none${isPast ? ';opacity:0.5' : ''}">
        <span style="font-size:13px;color:#1a1a1a">Cleaner confirmed${isPast ? ' <span style="font-size:11px;color:var(--text-soft)">(locked)</span>' : ''}</span>
        <button type="button" class="toggle ${matchedClean?.cleanerConfirmed ?? b.cleanerConfirmed ? 'on' : ''}" ${isPast ? 'disabled' : `onclick="toggleCleanerConfirmed('${b.id}')"`} aria-label="Toggle cleaner confirmed" style="flex-shrink:0${isPast ? ';pointer-events:none' : ''}"></button>
      </div>
      <div style="border-top:0.5px solid rgba(0,0,0,0.1)"></div>
      <div style="padding:14px">
        <div style="font-size:12px;font-weight:500;color:#999;margin-bottom:8px">Change cleaner</div>
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
        '<span style="font-size:20px;font-weight:500;color:#1a1a1a">' + (cleanCost ? '$' + cleanCost.toLocaleString() : 'Not set') + '</span>' +
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
      ${bn.map(n => `<div class="note-item" style="margin-bottom:8px"><span class="note-tag tag-${n.tag}">${n.tag}</span><div class="note-text">${n.text}</div></div>`).join('')}
    </div>`
      : ''}
    <div style="display:flex;gap:10px;margin-top:20px">
      <div style="flex:1;border:0.5px solid rgba(0,0,0,0.1);border-radius:10px;padding:12px;text-align:center;color:#666;font-size:13px;cursor:pointer;box-sizing:border-box;touch-action:manipulation" onclick="closeDetailModal()">Close</div>
      <div style="flex:1;background:#FCEBEB;border:0.5px solid #FCEBEB;border-radius:10px;padding:12px;text-align:center;color:#A32D2D;font-size:13px;font-weight:500;cursor:pointer;box-sizing:border-box;touch-action:manipulation" onclick="deleteBooking('${safeIdEsc}')">Delete booking</div>
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
}

function showEditModal(id) {
  _restoreDetailModalDefaultCloseBtn();
  const b = bookings.find(bk => bk._cloudId === id || String(bk.id) === String(id));
  if (!b) return;
  const safeId = b._cloudId || b.id;
  if (typeof globalThis.closeDetailModal === 'function') globalThis.closeDetailModal();
  document.getElementById('detail-content').innerHTML = `
    <div style="font-family:inherit;font-size:16px;font-weight:500;color:#1a1a1a;margin-bottom:16px">Edit Booking</div>
    <label>Guest Name</label><input type="text" id="e-name" value="${b.name}">
    <div class="form-row">
      <div class="field"><label>Check-in</label><input type="date" id="e-checkin" value="${b.checkin}" onchange="editCalcNights()"></div>
      <div class="field"><label>Check-out</label><input type="date" id="e-checkout" value="${b.checkout}" onchange="editCalcNights()"></div>
    </div>
    <div class="form-row">
      <div class="field"><label>Nights</label><input type="number" id="e-nights" value="${b.nights}" readonly style="background:var(--warm)"></div>
      <div class="field"><label>Guests</label><input type="number" id="e-guests" value="${b.guests}"></div>
    </div>
    <div class="form-row">
      <div class="field"><label>Gross Revenue ($)</label><input type="number" id="e-hostpayout" value="${b.hostPayout}" oninput="editCalcNet()"></div>
      <div class="field"><label>Cleaning Fee ($)</label><input type="number" id="e-cleaningfee" value="${b.cleaningFee}" oninput="editCalcNet()"></div>
    </div>
    <div class="form-row">
      <div class="field"><label>Mgmt Fee (%)</label><input type="number" id="e-mgmtfee" value="${b.mgmtFeeRaw || Math.round((b.mgmtFee / b.hostPayout) * 1000) / 10 || 0}" min="0" max="100" step="0.1" oninput="editCalcNet()"></div>
      <div class="field"><label>Mgmt Payout</label><input type="text" id="e-mgmtpayout" value="$${Number(b.mgmtPayout || 0).toFixed(2)}" style="background:var(--warm);color:var(--text-soft);font-style:italic" readonly></div>
    </div>
    <label>Owner Payout ($)</label>
    <input type="text" id="e-netpayout" value="$${Number(b.netPayout || 0).toFixed(2)}" readonly style="background:var(--warm);color:var(--text-soft);font-style:italic">
    <label>Platform</label>
    <div style="padding:10px 12px;background:var(--warm);border-radius:var(--radius-sm);font-size:14px;color:var(--text-soft);font-style:italic">
      ${b.platform ? (b.platform === 'Airbnb' ? '🏠 Airbnb' : b.platform === 'VRBO' ? '🏡 VRBO' : '📋 Direct') : 'Not set'}
    </div>
    <button class="btn-primary" onclick="saveEdit('${safeId}')" id="save-edit-btn">Save & Sync</button>
    <button class="btn-secondary" onclick="closeDetailModal()">Cancel</button>
  `;
  document.getElementById('detail-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => {
    if (typeof globalThis.attachModalHandleDrag === 'function') globalThis.attachModalHandleDrag();
  }, 50);
}

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
  if (typeof globalThis.saveBookingToCloud === 'function') {
    try {
      await globalThis.saveBookingToCloud(b);
    } catch (e) {
      console.error('[StayOps] Cloud save failed:', e);
      globalThis.showBanner('Changes saved locally, cloud sync failed', 'warn');
    }
  }
  globalThis.showBanner('✅ Booking saved', 'ok');
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
  const newNote = { id: Date.now(), bookingId, guestName: booking.name, text, tag, date: new Date().toISOString().split('T')[0] };
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

async function deleteBooking(id) {
  const _okBk = await globalThis.showAppModal({
    title: 'Delete Booking',
    msg: 'Remove this booking? This cannot be undone.',
    confirmText: 'Delete',
    confirmColor: 'var(--red)',
  });
  if (!_okBk) return;
  const deletedBooking = bookings.find(
    b => String(b._cloudId || '') === String(id) || String(b.id) === String(id)
  );
  if (!deletedBooking) {
    console.warn('[StayOps] deleteBooking: booking not found in memory:', id);
    globalThis.showBanner('Booking not found', 'warn');
    return;
  }

  console.log('[StayOps] deleteBooking: local delete requested', {
    id,
    localId: deletedBooking ? deletedBooking.id : null,
    cloudId: deletedBooking ? deletedBooking._cloudId : null,
  });

  // Cloud delete FIRST (avoid local state corruption if cloud delete fails)
  if (typeof globalThis.deleteBookingFromCloud === 'function') {
    try {
      await globalThis.deleteBookingFromCloud(deletedBooking);
    } catch (e) {
      console.error('[StayOps] deleteBooking: cloud delete failed', e);
      globalThis.showBanner('Could not delete booking — please try again', 'warn');
      return;
    }
  }

  const deletedLocalId = String(deletedBooking.id);
  const deletedCloudId = String(deletedBooking._cloudId || '');
  const deletedGuestName = deletedBooking.name;

  const orphanedCleans = cleans.filter(c =>
    String(c.bookingId) === deletedLocalId ||
    (deletedCloudId && String(c.bookingId) === deletedCloudId) ||
    (deletedGuestName && c.guestName === deletedGuestName)
  );
  const orphanedNotes = notes.filter(n =>
    String(n.bookingId) === deletedLocalId ||
    (deletedCloudId && String(n.bookingId) === deletedCloudId) ||
    (deletedGuestName && n.guestName === deletedGuestName)
  );

  // Only after cloud delete succeeds: remove from in-memory arrays
  replaceArrayInPlace(
    bookings,
    bookings.filter(b =>
      String(b.id) !== deletedLocalId &&
      String(b._cloudId || '') !== deletedCloudId
    )
  );
  replaceArrayInPlace(
    cleans,
    cleans.filter(c =>
      String(c.bookingId) !== deletedLocalId &&
      (!deletedCloudId || String(c.bookingId) !== deletedCloudId) &&
      !(deletedGuestName && c.guestName === deletedGuestName)
    )
  );
  replaceArrayInPlace(
    notes,
    notes.filter(n =>
      String(n.bookingId) !== deletedLocalId &&
      (!deletedCloudId || String(n.bookingId) !== deletedCloudId) &&
      !(deletedGuestName && n.guestName === deletedGuestName)
    )
  );

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
          if (c._cloudId) {
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
  globalThis.showBanner('✅ Booking deleted', 'ok');
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
    return epoch.toISOString().split('T')[0];
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

async function saveCleanCost(cleanId, bookingId) {
  const c = cleans.find(cl => String(cl.id) === String(cleanId) || (cl._cloudId && String(cl._cloudId) === String(cleanId)));
  const input = document.getElementById('actual-clean-fee');
  if (!c || !input) return;
  c.cost = Number(input.value) || 0;
  if (typeof globalThis.saveCleanToCloud === 'function') {
    try {
      await globalThis.saveCleanToCloud(c);
    } catch (e) {
      console.error('[StayOps] Cloud save failed:', e);
      globalThis.showBanner('Changes saved locally, cloud sync failed', 'warn');
      return;
    }
  }
  globalThis.showBanner('Cleaning cost saved', 'ok');
  if (typeof showDetail === 'function') showDetail(bookingId);
}

/** Aliases for clarity (same as showEditModal / saveEdit). */
const editBooking = showEditModal;
const saveBookingEdit = saveEdit;

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
};
