/**
 * Owner cleaning tab: scheduling, pipeline/timeline, cleaner assignment, locks.
 */
import { bookings, cleans } from './state.js';
import {
  fmt,
  fmtShort,
  escHtml,
  _normName,
  escapeJsSingleQuotedHtmlAttr,
} from './utils.js';
import { getAllProperties, getActivePropertyId, initPropertyUI } from './config.js';
import {
  getPropertyNameById,
  getPropertyColourById,
  isPortfolioMode,
  setPortfolioMode,
  switchActiveProperty,
} from './property.js';
import {
  openNotifyModal,
  _sendCleanerAssignmentNotifications,
  getCleanerSub,
  sendPushToDevice,
  cleanerLinkForId,
  sendCleanerEmail,
  getFreshOwnerSub,
} from './notifications.js';
import {
  saveCleanToCloud,
  saveBookingToCloud,
  saveCleansToCloud,
  saveCleaningJobToCloud,
} from './supabase.js';

export const cleaningActionLocks = Object.create(null);
export function acquireCleaningLock(key) {
  if (cleaningActionLocks[key]) return false;
  cleaningActionLocks[key] = true;
  return true;
}
export function releaseCleaningLock(key) {
  delete cleaningActionLocks[key];
}

let cleaningViewMode = localStorage.getItem('stayops-clean-view') || 'timeline';
let cleanStatusFilter = 'all';
let _expandedCleanIndex = null;

function loadCleaners() {
  return (window._cleaners || []);
}

export function isCleanerPerson(person) {
  const role = String((person && person.role) || '').trim().toLowerCase();
  return !role || role === 'cleaner';
}

export function findMatchingCleanForBooking(booking, preferredDate) {
  if (!booking) return null;
  const byBookingId = cleans.find(c =>
    String(c.bookingId) === String(booking.id) ||
    (booking._cloudId && String(c.bookingId) === String(booking._cloudId))
  );
  if (byBookingId) return byBookingId;

  const targetDate = String(preferredDate || booking.checkout || '').slice(0, 10);
  const name = _normName(booking.name);
  if (name && targetDate) {
    const byGuestAndDate = cleans.find(c => _normName(c.guestName) === name && String(c.date || '').slice(0, 10) === targetDate);
    if (byGuestAndDate) return byGuestAndDate;
  }

  return null;
}

export function isCleanLinkedToCancelledBooking(clean) {
  if (!clean) return false;
  const byBookingId = bookings.find(b => String(b.id) === String(clean.bookingId));
  if (byBookingId) return byBookingId.status === 'cancelled';
  const byGuestCancelled = bookings.find(b =>
    b.status === 'cancelled' &&
    _normName(b.name) === _normName(clean.guestName) &&
    String(b.checkout || '').slice(0, 10) === String(clean.date || '').slice(0, 10)
  );
  return !!byGuestCancelled;
}

export function getBookingCleanerState(booking) {
  if (booking && booking.status === 'cancelled') return { key: 'cancelled', label: 'Cancelled — no cleaner required', tone: 'ok' };
  const clean = findMatchingCleanForBooking(booking);
  if (!clean) return { key: 'unassigned', label: 'Needs cleaner assignment', tone: 'warn' };
  if (clean.done) return { key: 'done', label: 'Clean completed', tone: 'ok', clean };
  if (clean.cleanerDeclined) return { key: 'declined', label: 'Cleaner declined — reassign needed', tone: 'bad', clean };
  if (clean.cleanerConfirmed) return { key: 'confirmed', label: 'Cleaner confirmed', tone: 'ok', clean };
  return { key: 'pending', label: 'Assigned — awaiting cleaner response', tone: 'warn', clean };
}
export function normalizeBookingCleanState() {
  let cleansChanged = false;
  let bookingsChanged = false;

  cleans.forEach(c => {
    if (c && !c.bookingId && c.guestName && c.date) {
      const match = bookings.find(b => _normName(b.name) === _normName(c.guestName) && String(b.checkout || '').slice(0, 10) === String(c.date || '').slice(0, 10));
      if (match) {
        c.bookingId = match.id;
        cleansChanged = true;
      }
    }
    // Refresh stale guestName snapshot if clean is linked to a booking
    if (c && c.bookingId) {
      const linked = bookings.find(b => String(b.id) === String(c.bookingId) || (b._cloudId && String(b._cloudId) === String(c.bookingId)));
      if (linked && linked.name && _normName(linked.name) !== _normName(c.guestName)) {
        c.guestName = linked.name;
        cleansChanged = true;
      }
    }
  });

  bookings.forEach(b => {
    const st = getBookingCleanerState(b);
    const shouldConfirmed = st.key === 'confirmed' || st.key === 'done';
    if (!!b.cleanerConfirmed !== shouldConfirmed) {
      b.cleanerConfirmed = shouldConfirmed;
      bookingsChanged = true;
    }
  });

  // Dedup: if multiple active cleans share the same bookingId, keep only the newest
  const seen = Object.create(null);
  const toRemove = new Set();
  cleans.forEach((c, i) => {
    if (!c || !c.bookingId) return;
    // Normalise key: prefer numeric local id, but also track _cloudId aliases
    const booking = bookings.find(b => String(b.id) === String(c.bookingId) || (b._cloudId && String(b._cloudId) === String(c.bookingId)));
    const key = booking ? String(booking.id) : String(c.bookingId);
    if (seen[key] === undefined) {
      seen[key] = i;
    } else {
      // Keep the one with the later assignedAt; mark the other for removal
      const prev = cleans[seen[key]];
      const prevTime = new Date(prev.assignedAt || 0).getTime();
      const currTime = new Date(c.assignedAt || 0).getTime();
      if (currTime >= prevTime) {
        toRemove.add(seen[key]);
        seen[key] = i;
      } else {
        toRemove.add(i);
      }
      cleansChanged = true;
    }
  });
  if (toRemove.size) {
    // Filter out duplicates (iterate backwards to keep indices stable)
    const kept = cleans.filter((_, i) => !toRemove.has(i));
    cleans.length = 0;
    kept.forEach(c => cleans.push(c));
  }

  // TODO: was persisting cleans/bookings to localStorage; now cloud/in-memory only
  return cleansChanged || bookingsChanged;
}
function loadCleanerAutomationState() {
  const raw = (window._appConfig && window._appConfig.cleaner_automation) || {};
  return {
    lastCleanerId: raw.lastCleanerId || null,
    freq: raw.freq && typeof raw.freq === 'object' ? raw.freq : {}
  };
}

function saveCleanerAutomationState(state) {
  window._appConfig = window._appConfig || {};
  window._appConfig.cleaner_automation = {
    lastCleanerId: state.lastCleanerId || null,
    freq: state.freq && typeof state.freq === 'object' ? state.freq : {}
  };
  // TODO: migrate to Supabase app_config
}

function cleanerUsageKey(cleanerObj) {
  if (!cleanerObj) return '';
  if (cleanerObj.id !== undefined && cleanerObj.id !== null) return 'id:' + String(cleanerObj.id);
  const name = _normName(cleanerObj.name || '');
  return name ? 'name:' + name : '';
}

function findCleanerByUsageKey(key) {
  const all = loadCleaners().filter(c => isCleanerPerson(c));
  if (!key) return null;
  if (String(key).startsWith('id:')) {
    const id = String(key).slice(3);
    return all.find(c => String(c.id) === id) || null;
  }
  if (String(key).startsWith('name:')) {
    const name = String(key).slice(5);
    return all.find(c => _normName(c.name) === name) || null;
  }
  return null;
}

function recordCleanerAssignmentUsage(cleanerObj) {
  if (!cleanerObj) return;
  const st = loadCleanerAutomationState();
  const usageKey = cleanerUsageKey(cleanerObj);
  if (!usageKey) return;
  st.lastCleanerId = cleanerObj.id !== undefined ? cleanerObj.id : st.lastCleanerId;
  st.freq[usageKey] = Number(st.freq[usageKey] || 0) + 1;
  saveCleanerAutomationState(st);
  // TODO: migrate last-cleaner to Supabase app_config.ui_preferences
}

export function getPreferredCleaner() {
  const all = loadCleaners().filter(c => isCleanerPerson(c));
  if (!all.length) return null;
  const st = loadCleanerAutomationState();
  if (st.lastCleanerId !== null && st.lastCleanerId !== undefined) {
    const byLastId = all.find(c => String(c.id) === String(st.lastCleanerId));
    if (byLastId) return byLastId;
  }
  // TODO: migrate last-cleaner fallback (previously stored in localStorage)
  const topKey = Object.entries(st.freq)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))[0]?.[0];
  if (topKey) {
    const byFreq = findCleanerByUsageKey(topKey);
    if (byFreq) return byFreq;
  }
  return all[0] || null;
}

export function getSuggestedCleanerForBooking(booking) {
  const matched = booking ? findMatchingCleanForBooking(booking) : null;
  if (matched && matched.cleanerId) {
    const byMatched = loadCleaners().find(c => String(c.id) === String(matched.cleanerId));
    if (byMatched) return byMatched;
  }
  return getPreferredCleaner();
}

export function maybeAutoAssignPreferredCleaner(booking, reason) {
  if (!booking || booking.status === 'cancelled') return false;
  if (!booking.checkout || new Date(booking.checkout) < new Date()) return false;
  // Check auto-assign toggle — default ON
  if (window._appConfig && window._appConfig.auto_assign_cleaner === false) return false;
  const state = getBookingCleanerState(booking);
  if (state.key !== 'unassigned') return false;
  const preferred = getPreferredCleaner();
  if (!preferred) return false;
  const newClean = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    bookingId: booking.id,
    guestName: booking.name,
    cleaner: preferred.name,
    cleanerId: preferred.id,
    checkin: booking.checkin,
    date: booking.checkout,
    done: false,
    notified: false,
    cleanerDeclined: false,
    cleanerConfirmed: false,
    assignedAt: new Date().toISOString(),
    autoAssigned: true,
    autoAssignReason: reason || 'preferred-cleaner'
  };
  cleans.push(newClean);
  if (typeof saveCleanToCloud === 'function') saveCleanToCloud(newClean).catch(() => console.log('[StayOps]', 'saveCleanToCloud failed (auto-assign)'));
  booking.cleanerConfirmed = false;
  recordCleanerAssignmentUsage(preferred);
  return true;
}
export async function quickAssignLastCleaner(bookingId) {
  const lockKey = 'quickAssign:' + String(bookingId);
  if (!acquireCleaningLock(lockKey)) return;
  try {
    const booking = bookings.find(b => String(b.id) === String(bookingId));
    if (!booking) return;
    const preferred = getSuggestedCleanerForBooking(booking);
    if (!preferred) {
      globalThis.showBanner('⚠ No preferred cleaner yet — assign one from booking details first.', 'warn');
      return;
    }
    if (booking.status === 'cancelled' || new Date(booking.checkout) < new Date()) {
      globalThis.showBanner('Past/cancelled booking — cleaner assignment is disabled', 'warn');
      return;
    }
    if (!window.confirm(`Assign ${preferred.name} to ${booking.name} (checkout ${fmt(booking.checkout)})?`)) return;
    const matched = findMatchingCleanForBooking(booking, booking.checkout);
    const existingIdx = matched ? cleans.findIndex(c => c.id === matched.id) : -1;
    const prev = existingIdx >= 0 ? cleans[existingIdx] : null;
    const sameAssignment = !!(prev && String(prev.cleanerId) === String(preferred.id) && String(prev.date || '').slice(0, 10) === String(booking.checkout || '').slice(0, 10));
    if (sameAssignment) {
      booking.cleanerConfirmed = !!prev.cleanerConfirmed;
      normalizeBookingCleanState();
      try {
        await saveCleanToCloud(prev);
      } catch (e) {
        console.error('[StayOps] Cloud save failed:', e);
      }
      globalThis.showBanner('No changes — already assigned to ' + preferred.name, 'ok');
      return;
    }
    const newClean = {
      id: prev ? prev.id : Date.now(),
      _cloudId: prev ? prev._cloudId : undefined,
      bookingId: booking.id,
      guestName: booking.name,
      cleaner: preferred.name,
      cleanerId: preferred.id,
      checkin: booking.checkin,
      date: booking.checkout,
      done: false,
      notified: false,
      cleanerDeclined: false,
      cleanerConfirmed: false,
      assignedAt: (prev && prev.cleanerId && String(prev.cleanerId) === String(preferred.id)) ? (prev.assignedAt || new Date().toISOString()) : new Date().toISOString()
    };
    if (existingIdx >= 0) cleans[existingIdx] = newClean;
    else cleans.push(newClean);
    booking.cleanerConfirmed = false;
    recordCleanerAssignmentUsage(preferred);
    normalizeBookingCleanState();
    try {
      await saveCleanToCloud(newClean);
    } catch (e) {
      console.error('[StayOps] Cloud save failed:', e);
    }
    if (typeof saveBookingToCloud === 'function') saveBookingToCloud(booking).catch(() => {});
    globalThis.showBanner('✓ Assigned to ' + preferred.name + ' — awaiting cleaner response', 'ok');
    globalThis.renderBookings();
    globalThis.renderNotes();
    populateSelects();
    if (globalThis.getCurrentSection && globalThis.getCurrentSection() === 'cleaning') renderCleaning();
    _sendCleanerAssignmentNotifications(booking, preferred, booking.checkout, 'quick-assign-' + bookingId)
      .then(async notify => {
        if (notify.emailSent) {
          globalThis.showBanner('✉️ Email sent to ' + preferred.name, 'ok');
        } else {
          if (window.confirm('Notify ' + preferred.name + ' via SMS?')) {
            newClean.notified = true;
            try {
              await saveCleanToCloud(newClean);
            } catch (e) {
              console.error('[StayOps] Cloud save failed:', e);
            }
            openNotifyModal(newClean.id);
          }
        }
      })
      .catch(() => {});
  } finally {
    releaseCleaningLock(lockKey);
  }
}
export function prepareCleaningData() {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayStr = now.toISOString().split('T')[0];
  const weekEnd = new Date(todayStart);
  weekEnd.setDate(weekEnd.getDate() + (7 - weekEnd.getDay()));
  const nextWeekEnd = new Date(weekEnd);
  nextWeekEnd.setDate(nextWeekEnd.getDate() + 7);

  const upcoming = cleans.filter(c =>
    !c.done && !c.cleanerDeclined && c.date >= todayStr &&
    !isCleanLinkedToCancelledBooking(c)
  ).sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const unassignedBookings = bookings.filter(b => {
    if (b.status === 'cancelled' || new Date(b.checkout) < now) return false;
    const st = getBookingCleanerState(b).key;
    return st === 'unassigned' || st === 'declined';
  }).sort((a, b) => new Date(a.checkout) - new Date(b.checkout));

  const allItems = [];

  upcoming.forEach(c => {
    const b = bookings.find(bk =>
      String(bk.id) === String(c.bookingId) ||
      (bk._cloudId && String(bk._cloudId) === String(c.bookingId)) ||
      _normName(bk.name) === _normName(c.guestName)
    );
    allItems.push({
      type: 'clean',
      clean: c,
      booking: b,
      guest: b ? b.name : (c.guestName || '—'),
      date: c.date,
      cleaner: c.cleaner || null,
      status: c.cleanerConfirmed ? 'confirmed' : 'awaiting',
      propertyId: c._propertyId || (b && b._propertyId) || null,
    });
  });

  unassignedBookings.forEach(b => {
    const alreadyHasClean = allItems.some(item =>
      item.booking && (
        String(item.booking.id) === String(b.id) ||
        (b._cloudId && item.booking._cloudId && String(item.booking._cloudId) === String(b._cloudId))
      )
    );
    if (alreadyHasClean) return;

    allItems.push({
      type: 'unassigned',
      clean: null,
      booking: b,
      guest: b.name || '—',
      date: b.checkout || '',
      cleaner: null,
      status: 'unassigned',
      propertyId: b._propertyId || null,
    });
  });

  allItems.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const filtered = cleanStatusFilter === 'all'
    ? allItems
    : allItems.filter(item => item.status === cleanStatusFilter);

  const groups = { tomorrow: [], thisWeek: [], nextWeek: [], later: [] };
  const tomorrow = new Date(todayStart);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dayAfterTomorrow = new Date(tomorrow);
  dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 1);

  filtered.forEach(item => {
    const ds = String(item.date || '').slice(0, 10);
    if (!ds) {
      groups.later.push(item);
      return;
    }
    const d = new Date(ds + 'T00:00:00');
    if (Number.isNaN(d.getTime())) {
      groups.later.push(item);
      return;
    }
    if (d >= todayStart && d < dayAfterTomorrow) groups.tomorrow.push(item);
    else if (d < weekEnd) groups.thisWeek.push(item);
    else if (d < nextWeekEnd) groups.nextWeek.push(item);
    else groups.later.push(item);
  });

  const byProperty = {};
  filtered.forEach(item => {
    const propName = item.propertyId ? getPropertyNameById(item.propertyId) : 'Unknown';
    if (!byProperty[propName]) byProperty[propName] = { items: [], propertyId: item.propertyId };
    byProperty[propName].items.push(item);
  });

  const counts = {
    all: allItems.length,
    unassigned: allItems.filter(i => i.status === 'unassigned').length,
    awaiting: allItems.filter(i => i.status === 'awaiting').length,
    confirmed: allItems.filter(i => i.status === 'confirmed').length,
  };

  return { allItems, filtered, groups, byProperty, counts, now, todayStart };
}

export function renderCleanFilterPills(counts) {
  const pills = document.getElementById('clean-status-pills');
  if (!pills) return;

  const pill = (key, label, count, bg, color) => {
    const isActive = cleanStatusFilter === key;
    return '<div onclick="setCleanStatusFilter(\'' + key + '\')" ' +
      'style="flex:0 0 auto;background:' + (isActive ? '#1E3A2F' : bg) +
      ';color:' + (isActive ? '#fff' : color) +
      ';font-size:12px;font-weight:700;padding:6px 12px;border-radius:20px;cursor:pointer;white-space:nowrap">' +
      label + (count > 0 ? ' · ' + count : '') + '</div>';
  };

  pills.innerHTML =
    pill('all', 'All', counts.all, '#F0EDE8', '#5F5E5A') +
    pill('unassigned', 'Unassigned', counts.unassigned, '#FCEBEB', '#A32D2D') +
    pill('awaiting', 'Awaiting', counts.awaiting, '#FEF3E2', '#854F0B') +
    pill('confirmed', 'Confirmed', counts.confirmed, '#EAF3DE', '#3B6D11');
}

export function renderCleanRow(item, showProperty, index) {
  const colour = showProperty && item.propertyId
    ? getPropertyColourById(item.propertyId) : 'var(--forest, #1E3A2F)';
  const propName = showProperty && item.propertyId
    ? getPropertyNameById(item.propertyId) : '';

  const statusPill = item.status === 'unassigned'
    ? '<div style="background:#FCEBEB;color:#A32D2D;font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px">Unassigned</div>'
    : item.status === 'awaiting'
      ? '<div style="background:#FEF3E2;color:#854F0B;font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px">Awaiting</div>'
      : '<div style="background:#EAF3DE;color:#3B6D11;font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px">Confirmed</div>';

  const cleanerText = item.cleaner
    ? escHtml(item.cleaner)
    : '<span style="color:#C0392B;font-weight:600">No cleaner</span>';

  const propLabel = showProperty && propName
    ? escHtml(propName) + ' · ' : '';

  const rowId = 'clean-row-' + index;
  const actionId = 'clean-action-' + index;
  const cleanId = item.clean
    ? escapeJsSingleQuotedHtmlAttr(String(item.clean.id != null ? item.clean.id : (item.clean._cloudId || '')))
    : '';
  const bookingId = item.booking
    ? escapeJsSingleQuotedHtmlAttr(String(item.booking._cloudId || item.booking.id || ''))
    : '';

  return '<div>' +
    '<div onclick="toggleCleanAction(' + index + ',\'' + cleanId + '\',\'' + bookingId + '\',\'' + escapeJsSingleQuotedHtmlAttr(item.status) + '\')" ' +
      'style="padding:12px 14px;border-bottom:1px solid var(--warm,#F0EDE8);display:flex;align-items:center;gap:12px;cursor:pointer" id="' + rowId + '">' +
      '<div style="width:4px;height:36px;border-radius:2px;background:' + colour + ';flex-shrink:0"></div>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-weight:700;font-size:14px;color:var(--text,#1A1A1A)">' + escHtml(item.guest) + '</div>' +
        '<div style="font-size:12px;color:var(--text-soft,#6B6560);margin-top:2px">' + propLabel + cleanerText + '</div>' +
      '</div>' +
      '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px">' +
        statusPill +
        '<div style="font-size:11px;color:var(--text-soft,#6B6560)">' + escHtml(fmtShort(item.date)) + '</div>' +
      '</div>' +
    '</div>' +
    '<div id="' + actionId + '" style="display:none;padding:0 14px 12px;border-bottom:1px solid var(--warm,#F0EDE8);background:var(--mist,#F8F6F3)"></div>' +
  '</div>';
}

export function renderCleanTimeline(data, showProperty) {
  const list = document.getElementById('cleaning-list');
  if (!list) return;

  const timeGroups = [
    { key: 'tomorrow', label: 'Today / Tomorrow', colour: '#C0392B', items: data.groups.tomorrow },
    { key: 'thisWeek', label: 'This week', colour: '#854F0B', items: data.groups.thisWeek },
    { key: 'nextWeek', label: 'Next week', colour: '#6B6560', items: data.groups.nextWeek },
    { key: 'later', label: 'Later', colour: '#B4B2A9', items: data.groups.later },
  ].filter(g => g.items.length > 0);

  if (!timeGroups.length) {
    list.innerHTML = '<div style="text-align:center;padding:28px 16px">' +
      '<div style="font-size:36px;margin-bottom:10px;opacity:0.4">&#10003;</div>' +
      '<div style="font-weight:600;font-size:14px;margin-bottom:4px">All clear</div>' +
      '<div style="font-size:12px;color:var(--text-soft)">No cleans match this filter</div></div>';
    return;
  }

  let cleanRowIdx = 0;
  list.innerHTML = timeGroups.map(g =>
    '<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;color:' + g.colour +
      ';margin-bottom:8px;display:flex;align-items:center;gap:6px">' +
      '<div style="width:6px;height:6px;border-radius:50%;background:' + g.colour + '"></div>' +
      g.label +
    '</div>' +
    '<div style="background:#fff;border-radius:14px;padding:2px 0;margin-bottom:14px">' +
      g.items.map(item => renderCleanRow(item, showProperty, cleanRowIdx++)).join('') +
    '</div>'
  ).join('');
}

export function renderCleanPipeline(data, showProperty) {
  const list = document.getElementById('cleaning-list');
  if (!list) return;

  const columns = [
    { key: 'unassigned', label: 'Needs assignment', bg: '#FCEBEB', colour: '#A32D2D',
      items: data.filtered.filter(i => i.status === 'unassigned') },
    { key: 'awaiting', label: 'Awaiting', bg: '#FEF3E2', colour: '#854F0B',
      items: data.filtered.filter(i => i.status === 'awaiting') },
    { key: 'confirmed', label: 'Confirmed', bg: '#EAF3DE', colour: '#3B6D11',
      items: data.filtered.filter(i => i.status === 'confirmed') },
  ];

  let pipelineRowIdx = 0;
  list.innerHTML = columns.map(col => {
    if (!col.items.length) return '';
    return '<div style="margin-bottom:14px">' +
      '<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:' +
        col.colour + ';margin-bottom:8px;display:flex;justify-content:space-between">' +
        '<span>' + col.label + '</span><span>' + col.items.length + '</span></div>' +
      '<div style="background:' + col.bg + ';border-radius:14px;padding:8px">' +
        '<div style="display:flex;flex-direction:column;gap:6px">' +
          col.items.map(item => renderCleanRow(item, showProperty, pipelineRowIdx++)).join('') +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  if (!list.innerHTML) {
    list.innerHTML = '<div style="text-align:center;padding:28px 16px">' +
      '<div style="font-weight:600;font-size:14px;margin-bottom:4px">All clear</div>' +
      '<div style="font-size:12px;color:var(--text-soft)">No cleans match this filter</div></div>';
  }
}

export function renderCleanByProperty(data) {
  const list = document.getElementById('cleaning-list');
  if (!list) return;

  const props = Object.entries(data.byProperty).sort((a, b) => a[0].localeCompare(b[0]));
  if (!props.length) {
    list.innerHTML = '<div style="text-align:center;padding:28px 16px">' +
      '<div style="font-weight:600;font-size:14px;margin-bottom:4px">All clear</div>' +
      '<div style="font-size:12px;color:var(--text-soft)">No cleans match this filter</div></div>';
    return;
  }

  let byPropRowIdx = 0;
  list.innerHTML = props.map(([propName, propData]) => {
    const colour = propData.propertyId
      ? getPropertyColourById(propData.propertyId) : 'var(--forest)';
    const unassignedCount = propData.items.filter(i => i.status === 'unassigned').length;

    return '<div style="background:#fff;border-radius:14px;border-left:4px solid ' + colour +
      ';border-top-left-radius:0;border-bottom-left-radius:0;padding:14px 16px;margin-bottom:10px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
        '<div>' +
          '<div style="font-weight:700;font-size:16px;color:var(--text)">' + escHtml(propName) + '</div>' +
          '<div style="font-size:12px;color:var(--text-soft)">' + propData.items.length + ' upcoming clean' +
            (propData.items.length !== 1 ? 's' : '') + '</div>' +
        '</div>' +
        (unassignedCount > 0
          ? '<div style="background:#FCEBEB;color:#A32D2D;font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px">' +
              unassignedCount + ' unassigned</div>'
          : '') +
      '</div>' +
      '<div style="position:relative;padding-left:0;border-left:none">' +
        propData.items.map(item => renderCleanRow(item, false, byPropRowIdx++)).join('') +
      '</div>' +
    '</div>';
  }).join('');
}

export function toggleCleanAction(index, cleanId, bookingId, status) {
  const actionEl = document.getElementById('clean-action-' + index);
  if (!actionEl) return;

  if (_expandedCleanIndex !== null && _expandedCleanIndex !== index) {
    const prev = document.getElementById('clean-action-' + _expandedCleanIndex);
    if (prev) prev.style.display = 'none';
  }

  const isOpen = actionEl.style.display !== 'none';
  if (isOpen) {
    actionEl.style.display = 'none';
    _expandedCleanIndex = null;
    return;
  }

  let buttons = '';

  if (status === 'unassigned') {
    buttons =
      '<button onclick="event.stopPropagation();jumpToAssignClean(\'' + bookingId + '\')" ' +
        'style="flex:1;padding:10px;background:var(--forest,#1E3A2F);color:#fff;border:none;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;font-family:\'DM Sans\',sans-serif">' +
        'Assign cleaner</button>';
  } else if (status === 'awaiting') {
    buttons =
      '<button onclick="event.stopPropagation();markCleanerConfirmed(\'' + cleanId + '\');renderCleaning()" ' +
        'style="flex:1;padding:10px;background:var(--moss,#4A7C59);color:#fff;border:none;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;font-family:\'DM Sans\',sans-serif">' +
        'Confirm</button>' +
      '<button onclick="event.stopPropagation();markCleanDeclined(\'' + cleanId + '\');renderCleaning()" ' +
        'style="flex:1;padding:10px;background:#FCEBEB;color:#A32D2D;border:none;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;font-family:\'DM Sans\',sans-serif">' +
        'Decline</button>' +
      '<button onclick="event.stopPropagation();openNotifyModal(\'' + cleanId + '\')" ' +
        'style="flex:1;padding:10px;background:var(--mist,#F0EDE8);color:var(--text,#1A1A1A);border:none;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;font-family:\'DM Sans\',sans-serif">' +
        'SMS</button>';
  } else if (status === 'confirmed') {
    buttons =
      '<button onclick="event.stopPropagation();openNotifyModal(\'' + cleanId + '\')" ' +
        'style="flex:1;padding:10px;background:var(--forest,#1E3A2F);color:#fff;border:none;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;font-family:\'DM Sans\',sans-serif">' +
        'Send SMS</button>' +
      '<button onclick="event.stopPropagation();reassignClean(\'' + cleanId + '\')" ' +
        'style="flex:1;padding:10px;background:var(--mist,#F0EDE8);color:var(--text,#1A1A1A);border:none;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;font-family:\'DM Sans\',sans-serif">' +
        'Reassign</button>';
  }

  const viewBookingBtn = bookingId
    ? '<button onclick="event.stopPropagation();globalThis.showDetail(\'' + bookingId + '\')" ' +
        'style="flex:1;padding:10px;background:transparent;color:var(--forest,#1E3A2F);border:1.5px solid var(--warm,#E8E0D5);border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;font-family:\'DM Sans\',sans-serif">' +
        'View booking</button>'
    : '';

  actionEl.innerHTML =
    '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px">' + buttons + '</div>' +
    (viewBookingBtn ? '<div style="display:flex;gap:8px;margin-top:6px">' + viewBookingBtn + '</div>' : '');

  actionEl.style.display = 'block';
  _expandedCleanIndex = index;
}

export function jumpToAssignClean(bookingIdRaw) {
  _expandedCleanIndex = null;
  const booking = bookings.find(b =>
    String(b._cloudId || '') === String(bookingIdRaw) ||
    String(b.id) === String(bookingIdRaw)
  );
  if (!booking) return;
  const localId = String(booking.id);

  if (isPortfolioMode()) {
    if (booking._propertyId) {
      const props = getAllProperties();
      const cloudIds = window._cloudPropertyIds || {};
      const match = props.find(p =>
        cloudIds[p.propertyId] === booking._propertyId ||
        p.supabaseId === booking._propertyId
      );
      if (match && match.propertyId !== getActivePropertyId()) {
        setPortfolioMode(false);
        sessionStorage.setItem('stayops-portfolio-mode', 'false');
        sessionStorage.setItem('stayops-post-switch-action', 'assign-clean-' + localId);
        switchActiveProperty(match.propertyId);
        return;
      }
    }
    setPortfolioMode(false);
    sessionStorage.setItem('stayops-portfolio-mode', 'false');
    globalThis.reloadInMemoryData();
    initPropertyUI();
  }

  globalThis.showSection('cleaning');
  populateSelects();
  const select = document.getElementById('clean-booking-select');
  if (select) {
    select.value = localId;
    select.dispatchEvent(new Event('change'));
  }
  const addCard = document.getElementById('clean-add-card');
  if (addCard) addCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function updateCleanViewSwitcherStyles() {
  document.querySelectorAll('.clean-view-tab').forEach(t => {
    t.style.background = '';
    t.style.color = 'var(--text-soft, #6B6560)';
    t.style.fontWeight = '600';
  });
  const active = document.getElementById('clean-view-' + cleaningViewMode);
  if (active) {
    active.style.background = 'var(--forest, #1E3A2F)';
    active.style.color = '#fff';
    active.style.fontWeight = '700';
  }
}

export function switchCleanView(mode) {
  _expandedCleanIndex = null;
  cleaningViewMode = mode;
  localStorage.setItem('stayops-clean-view', mode);
  updateCleanViewSwitcherStyles();
  renderCleaning();
}
window.switchCleanView = switchCleanView;

export function setCleanStatusFilter(filter) {
  _expandedCleanIndex = null;
  cleanStatusFilter = filter;
  renderCleaning();
}
window.setCleanStatusFilter = setCleanStatusFilter;

export function renderCleaning() {
  _expandedCleanIndex = null;
  if (cleaningViewMode !== 'timeline' && cleaningViewMode !== 'pipeline' && cleaningViewMode !== 'property') {
    cleaningViewMode = 'timeline';
  }
  updateCleanViewSwitcherStyles();
  const data = prepareCleaningData();
  renderCleanFilterPills(data.counts);

  const summaryEl = document.getElementById('cleaning-summary-strip');
  if (summaryEl) summaryEl.innerHTML = '';

  const showProperty = isPortfolioMode();

  // Desktop: table view regardless of view mode
  if (window.innerWidth >= 1024) {
    _renderCleanDesktopTable(data, showProperty);
    return;
  }

  if (cleaningViewMode === 'timeline') {
    renderCleanTimeline(data, showProperty);
  } else if (cleaningViewMode === 'pipeline') {
    renderCleanPipeline(data, showProperty);
  } else if (cleaningViewMode === 'property') {
    renderCleanByProperty(data);
  }
}

function _renderCleanDesktopTable(data, showProperty) {
  const list = document.getElementById('cleaning-list');
  if (!list) return;

  const items = data.filtered;
  if (!items.length) {
    list.innerHTML = '<div class="card" style="text-align:center;padding:40px"><div style="font-size:36px;margin-bottom:10px;opacity:0.4">&#10003;</div><div style="font-weight:600;font-size:14px;margin-bottom:4px">All clear</div><div style="font-size:12px;color:var(--text-soft)">No cleans match this filter</div></div>';
    return;
  }

  const fmtSh = d => { if (!d) return ''; return new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { day:'numeric', month:'short' }); };
  const statusBadge = item => {
    if (item.status === 'confirmed') return '<span class="dt-badge dt-badge-green">Confirmed</span>';
    if (item.status === 'unassigned') return '<span class="dt-badge dt-badge-red">Unassigned</span>';
    if (item.status === 'awaiting') return '<span class="dt-badge dt-badge-amber">Awaiting</span>';
    return '<span class="dt-badge dt-badge-gray">' + escHtml(item.status) + '</span>';
  };

  const propTh = showProperty ? '<th>Property</th>' : '';
  const rows = items.map(item => {
    const propTd = showProperty ? '<td style="font-size:12px;color:var(--text-soft)">' + escHtml(item.propertyId ? getPropertyNameById(item.propertyId) : '') + '</td>' : '';
    const cleanerHtml = item.cleaner
      ? '<span style="color:var(--moss);font-weight:500">' + escHtml(item.cleaner) + '</span>'
      : '<span style="color:var(--red);font-size:12px">Unassigned</span>';
    const costHtml = item.clean && item.clean.cost ? '$' + Number(item.clean.cost).toLocaleString() : '—';
    const bid = item.booking ? escapeJsSingleQuotedHtmlAttr(String(item.booking._cloudId || item.booking.id)) : '';
    const onclick = bid ? ' onclick="showDetail(\'' + bid + '\')" style="cursor:pointer"' : '';
    return '<tr' + onclick + '>' +
      '<td>' + fmtSh(item.date) + '</td>' +
      propTd +
      '<td><strong>' + escHtml(item.guest) + '</strong></td>' +
      '<td>' + cleanerHtml + '</td>' +
      '<td>' + statusBadge(item) + '</td>' +
      '<td>' + costHtml + '</td>' +
      '</tr>';
  }).join('');

  // Cleaner summary sidebar
  const cleanerMap = {};
  items.forEach(item => {
    const name = item.cleaner || 'Unassigned';
    if (!cleanerMap[name]) cleanerMap[name] = 0;
    cleanerMap[name]++;
  });
  const cleanerSummary = Object.entries(cleanerMap)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => {
      const col = name === 'Unassigned' ? 'var(--red)' : 'var(--moss)';
      return '<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f0ede8;font-size:13px"><span style="font-weight:500">' + escHtml(name) + '</span><span style="color:' + col + '">' + count + ' clean' + (count > 1 ? 's' : '') + '</span></div>';
    }).join('');

  const confirmed = items.filter(i => i.status === 'confirmed').length;
  const unassigned = items.filter(i => i.status === 'unassigned').length;
  const awaiting = items.filter(i => i.status === 'awaiting').length;

  list.innerHTML = '<div style="display:grid;grid-template-columns:1fr minmax(280px,320px);gap:20px">' +
    '<div class="card" style="padding:0;overflow:hidden;overflow-x:auto">' +
      '<table class="desktop-table"><thead><tr><th>Date</th>' + propTh + '<th>Guest</th><th>Cleaner</th><th>Status</th><th>Cost</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '</div>' +
    '<div style="display:flex;flex-direction:column;gap:16px">' +
      '<div class="card"><div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-soft);margin-bottom:12px">Cleaner Summary</div>' + cleanerSummary + '</div>' +
      '<div class="card"><div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-soft);margin-bottom:12px">Overview</div>' +
        '<div style="font-family:\'DM Serif Display\',serif;font-size:28px;color:var(--forest)">' + items.length + ' cleans</div>' +
        '<div style="font-size:12px;color:var(--text-soft);margin-top:4px">' + confirmed + ' confirmed · ' + awaiting + ' awaiting · ' + unassigned + ' unassigned</div>' +
      '</div>' +
    '</div>' +
  '</div>';
}

export function reassignClean(cleanId) {
  const c = cleans.find(cl => String(cl.id) === String(cleanId));
  if (c) {
    c.cleaner = '';
    c.cleanerId = null;
    c.cleanerDeclined = false;
    c.cleanerConfirmed = false;
    c.notified = false;
    normalizeBookingCleanState();
    if (typeof saveCleanToCloud === 'function') {
      saveCleanToCloud(c).catch(e => console.error('[StayOps] Cloud save failed:', e));
    }
  } else {
    console.log('[StayOps] reassignClean: clean not found', cleanId);
    globalThis.showDetail(cleanId);
    return;
  }
  const b = bookings.find(bk => String(bk.id) === String(c.bookingId) || (bk._cloudId && String(bk._cloudId) === String(c.bookingId)) || _normName(bk.name) === _normName(c.guestName));
  if (b) {
    globalThis.showDetail(b.id);
  } else {
    globalThis.showBanner('⚠ Booking not found — delete and reassign manually', 'warn');
  }
}

export function markCleanerConfirmed(id) {
  const c = cleans.find(c => String(c.id) === String(id));
  if (!c) return;
  c.cleanerConfirmed = true;
  c.cleanerDeclined  = false;
  const b = bookings.find(bk => String(bk.id) === String(c.bookingId) || (bk._cloudId && String(bk._cloudId) === String(c.bookingId)));
  if (b) b.cleanerConfirmed = true;
  normalizeBookingCleanState();
  if (typeof saveCleanToCloud === 'function') saveCleanToCloud(c).catch(e => console.error('[StayOps] Cloud save failed:', e));
  if (b && typeof saveBookingToCloud === 'function') saveBookingToCloud(b).catch(() => {});
  globalThis.showBanner('✅ Cleaner confirmed', 'ok');
  renderCleaning();
  globalThis.renderBookings();
}

export function markCleanDeclined(id) {
  if (!window.confirm('Mark this cleaner as unavailable? The clean will need reassigning.')) return;
  const c = cleans.find(c => String(c.id) === String(id));
  if (!c) return;
  c.cleanerDeclined  = true;
  c.cleanerConfirmed = false;
  const b = bookings.find(bk => String(bk.id) === String(c.bookingId) || (bk._cloudId && String(bk._cloudId) === String(c.bookingId)));
  if (b) b.cleanerConfirmed = false;
  normalizeBookingCleanState();
  if (typeof saveCleanToCloud === 'function') saveCleanToCloud(c).catch(e => console.error('[StayOps] Cloud save failed:', e));
  if (b && typeof saveBookingToCloud === 'function') saveBookingToCloud(b).catch(() => {});
  globalThis.showBanner('Clean marked as declined — reassign when ready', 'warn');
  renderCleaning();
  globalThis.renderBookings();
}
export function populateSelects() {
  const now = new Date();
  const upcomingForNotes = bookings
    .filter(b => b.status !== 'cancelled' && new Date(b.checkout) >= now)
    .sort((a,b) => new Date(a.checkin) - new Date(b.checkin));
  const allOpts = '<option value="">Select upcoming booking...</option>' + upcomingForNotes.map(b=>`<option value="${b.id}">${b.name} (${fmt(b.checkin)})</option>`).join('');
  // For clean form: exclude bookings that already have a confirmed or done clean
  const cleanBookings = bookings
    .filter(b => {
      if (b.status === 'cancelled' || new Date(b.checkout) < now) return false;
      const st = getBookingCleanerState(b).key;
      return st !== 'confirmed' && st !== 'done';
    })
    .sort((a,b) => new Date(a.checkin) - new Date(b.checkin));
  const cleanOpts = '<option value="">Select booking...</option>' + cleanBookings.map(b=>`<option value="${b.id}">${b.name} (${fmt(b.checkin)})</option>`).join('');
  document.getElementById('clean-booking-select').innerHTML = cleanOpts;
  document.getElementById('note-booking-select').innerHTML = allOpts;
  populateCleanerSelect();
}
export function populateCleanerSelect() {
  const cleaners = loadCleaners().filter(c => isCleanerPerson(c));
  const sel = document.getElementById('clean-name');
  if (!sel) return;
  if (cleaners.length > 0) {
    const lastCleaner = '';
    sel.innerHTML = cleaners.map(c => `<option value="${c.name}" data-phone="${c.phone||''}" ${c.name===lastCleaner?'selected':''}>${c.name}${c.phone?' — '+c.phone:''}</option>`).join('');
  } else {
    sel.innerHTML = '<option value="">No cleaners saved — add in Settings</option>';
  }
}
export function revealCleanerReassign(id) {
  if (!confirm('This cleaner is already confirmed. Change the assignment?')) return;
  const form = document.getElementById('detail-reassign-form');
  const btn  = document.getElementById('detail-change-cleaner-btn');
  if (form) form.style.display = '';
  if (btn)  btn.style.display  = 'none';
}

export function toggleCleanerConfirmed(id) {
  const b = bookings.find(b => b._cloudId === id || String(b.id) === String(id));
  if (!b) return;
  if (b.status === 'cancelled') {
    globalThis.showBanner('Cancelled booking — cleaner confirmation is disabled', 'warn');
    return;
  }
  const next = !b.cleanerConfirmed;
  const matchedClean = findMatchingCleanForBooking(b);
  b.cleanerConfirmed = next;
  if (matchedClean) {
    matchedClean.cleanerConfirmed = next;
    if (!next) matchedClean.cleanerDeclined = false;
    if (typeof saveCleaningJobToCloud === 'function') saveCleaningJobToCloud(matchedClean);
  }
  normalizeBookingCleanState();
  if (matchedClean && typeof saveCleanToCloud === 'function') {
    saveCleanToCloud(matchedClean).catch(e => console.error('[StayOps] Cloud save failed:', e));
  }
  // Fix: also persist the booking's cleaner_confirmed to Supabase so both
  // tables stay in sync (previously only the clean record was saved).
  if (typeof saveBookingToCloud === 'function') saveBookingToCloud(b).catch(() => {});
  globalThis.showDetail(id);
  globalThis.renderBookings();
  renderCleaning();
}
export function loadCleanerLearning() {
  return (window._appConfig && window._appConfig.cleaner_learning) || { lastCleanerId: null, frequency: {} };
}

/** Edge Function expects cleaners.id (Supabase UUID). App stores that on cleaner._cloudId; cleaner.id is local. */
function _resolveInviteCleanerCloudId(passed) {
  const raw = passed != null ? String(passed).trim() : '';
  if (!raw) return '';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return raw;
  const list = typeof globalThis.loadCleaners === 'function' ? globalThis.loadCleaners() : [];
  for (const c of list) {
    if (!c) continue;
    if (String(c.id) === raw) {
      const pk = c._cloudId || c.cloud_id;
      return pk ? String(pk) : '';
    }
  }
  return '';
}

async function inviteCleaner(cleanerId) {
  if (!cleanerId) return;
  const cleaners = window._cleaners || [];
  const cleaner = cleaners.find(c => (c._cloudId || c.cloud_id) === cleanerId);
  if (!cleaner) { alert('Cleaner not found'); return; }
  if (!cleaner.email) { alert('Add an email address to this cleaner first'); return; }

  const btn = document.getElementById('invite-btn-' + cleanerId);
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

  const appUrl = window.location.origin;
  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="color:#1E3A2F">You're invited to StayOps</h2>
      <p>Hi ${cleaner.name || 'there'},</p>
      <p>You've been added as a cleaner on StayOps. Create your account to view and manage your assigned cleans.</p>
      <a href="${appUrl}" style="display:inline-block;padding:14px 28px;background:#1E3A2F;color:white;text-decoration:none;border-radius:10px;font-weight:bold;margin:16px 0">Sign Up on StayOps</a>
      <p style="color:#999;font-size:13px">Use this email address (${cleaner.email}) when signing up so your account is automatically linked.</p>
    </div>
  `;

  try {
    let authToken = '';
    if (window._sb) {
      const { data } = await window._sb.auth.getSession();
      authToken = data?.session?.access_token || '';
    }

    const res = await fetch('/.netlify/functions/send-email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { 'Authorization': 'Bearer ' + authToken } : {})
      },
      body: JSON.stringify({
        to: cleaner.email,
        subject: 'You\'re invited to StayOps',
        html: html
      })
    });

    const result = await res.json();
    if (result.success || result.status === 'ok') {
      if (typeof globalThis.showBanner === 'function') globalThis.showBanner('Invitation sent to ' + cleaner.email, 'ok');
      if (btn) { btn.textContent = 'Invited ✓'; btn.style.opacity = '0.6'; }

      // Update invitation status in Supabase
      if (window._sb && cleanerId) {
        window._sb.from('cleaners').update({ invitation_status: 'invited' }).eq('id', cleanerId).then(() => {});
      }
    } else {
      alert('Failed to send invite: ' + (result.error || 'Unknown error'));
      if (btn) { btn.disabled = false; btn.textContent = 'Invite to App'; }
    }
  } catch (e) {
    alert('Failed to send invite: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Invite to App'; }
  }
}
window.inviteCleaner = inviteCleaner;

export function saveCleanerLearning(state) {
  window._appConfig = window._appConfig || {};
  window._appConfig.cleaner_learning = state || { lastCleanerId: null, frequency: {} };
  // TODO: migrate to Supabase app_config
}

export function updateCleanerLearning(cleanerObj, assignmentSource) {
  if (!cleanerObj || !cleanerObj.id) return;
  const source = String(assignmentSource || 'manual').toLowerCase();
  const shouldLearnFrequency = source === 'manual' || source === 'quick';
  const shouldUpdateLastCleaner = source !== 'auto';
  if (!shouldLearnFrequency && !shouldUpdateLastCleaner) return;

  const learning = loadCleanerLearning();
  if (!learning.frequency || typeof learning.frequency !== 'object') learning.frequency = {};

  const cleanerId = String(cleanerObj.id);
  if (shouldLearnFrequency) {
    const current = Number(learning.frequency[cleanerId]) || 0;
    learning.frequency[cleanerId] = current + 1;
  }
  if (shouldUpdateLastCleaner) learning.lastCleanerId = cleanerObj.id;

  saveCleanerLearning(learning);
  // TODO: migrate last-cleaner to Supabase app_config.ui_preferences
}
export function autoFillCleanDate() {
  const bookingIdRaw = document.getElementById('clean-booking-select').value;
  if (!bookingIdRaw) return;
  const booking = bookings.find(b => String(b.id) === String(bookingIdRaw) || (b._cloudId && String(b._cloudId) === String(bookingIdRaw)));
  if (booking && booking.checkout) {
    document.getElementById('clean-date').value = booking.checkout;
  }
}

export function addClean() {
  if (!acquireCleaningLock('addClean')) return;
  const bookingIdRaw = document.getElementById('clean-booking-select').value;
  const selectEl = document.getElementById('clean-name-select');
  const cleaner = selectEl ? selectEl.value.trim() : document.getElementById('clean-name').value.trim();
  const date=document.getElementById('clean-date').value;
  if (!bookingIdRaw||!cleaner||!date){globalThis.showBanner('⚠ Please fill all fields','warn'); releaseCleaningLock('addClean'); return;}
  // TODO: migrate last-cleaner to Supabase app_config.ui_preferences
  const booking = bookings.find(b => String(b.id) === String(bookingIdRaw) || (b._cloudId && String(b._cloudId) === String(bookingIdRaw)));
  if (!booking) { globalThis.showBanner('⚠ Booking not found — it may have been deleted', 'warn'); releaseCleaningLock('addClean'); return; }
  const bookingId = booking.id;
  // Find cleaner ID from the saved cleaners list
  const cleanerObj = loadCleaners().find(c => c.name === cleaner);
  const cleanerId = cleanerObj ? cleanerObj.id : null;
  if (cleanerObj) updateCleanerLearning(cleanerObj, 'manual');
  // Upsert: reuse existing clean record for this booking if one exists
  const existingIdx = cleans.findIndex(c => String(c.bookingId) === String(booking.id) || (booking._cloudId && String(c.bookingId) === String(booking._cloudId)));
  const prev = existingIdx >= 0 ? cleans[existingIdx] : null;
  const newClean = {
    id: prev ? prev.id : Date.now(),
    _cloudId: prev ? prev._cloudId : undefined,
    bookingId, guestName: booking.name, cleaner, cleanerId,
    checkin: booking.checkin, date,
    done: false, notified: false, cleanerConfirmed: false, cleanerDeclined: false,
    assignedAt: (prev && prev.cleanerId && String(prev.cleanerId) === String(cleanerId)) ? (prev.assignedAt || new Date().toISOString()) : new Date().toISOString()
  };
  if (existingIdx >= 0) cleans[existingIdx] = newClean;
  else cleans.push(newClean);
  booking.cleanerConfirmed = false;
  if (cleanerObj) recordCleanerAssignmentUsage(cleanerObj);
  if (typeof saveCleanToCloud === 'function') {
    saveCleanToCloud(newClean).catch(e => console.error('[StayOps] Cloud save failed:', e));
  }
  globalThis.showBanner('✅ Clean scheduled for ' + newClean.date, 'ok');
  // Prompt to send SMS — only mark notified if user confirms
  globalThis.showAppModal({ title: '💬 Send SMS?', msg: `Notify ${cleaner} about this booking now?`, confirmText: 'Send SMS', cancelText: 'Later' })
    .then(ok => {
      if (ok) {
        newClean.notified = true;
        if (typeof saveCleanToCloud === 'function') {
          saveCleanToCloud(newClean).catch(e => console.error('[StayOps] Cloud save failed:', e));
        }
        switchCleanView('timeline');
        globalThis.renderBookings();
        openNotifyModal(newClean.id);
      } else {
        switchCleanView('timeline');
        globalThis.renderBookings();
      }
    })
    .catch(() => {})
    .finally(() => releaseCleaningLock('addClean'));
  populateSelects();
}
export function toggleClean(id) {
  const c=cleans.find(c=>c.id===id);
  if (c){
    c.done=!c.done;
    if (typeof saveCleanToCloud === 'function') {
      saveCleanToCloud(c).catch(e => console.error('[StayOps] Cloud save failed:', e));
    }
    renderCleaning(); globalThis.renderDashboard();
  }
}
export async function postCleanerAction(cleanId, action) {
  const { id: cleanerId, uid } = globalThis.getCleanerParams();
  if (!uid || !cleanerId) {
    console.warn('[StayOps] postCleanerAction: missing uid or cleanerId, skipping cloud write');
    return false;
  }
  try {
    const res = await fetch('/.netlify/functions/cleaner-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, cleanerId: String(cleanerId), cleanId: String(cleanId), action })
    });
    if (!res.ok) {
      console.warn('[StayOps] postCleanerAction failed: HTTP ' + res.status);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[StayOps] postCleanerAction error:', e);
    return false;
  }
}
export async function cleanerAccept(cleanId) {
  const lockKey = 'cleanerAccept:' + String(cleanId);
  if (!acquireCleaningLock(lockKey)) return;
  const c = cleans.find(cl => String(cl.id) === String(cleanId));
  if (!c) { releaseCleaningLock(lockKey); return; }
  c.cleanerConfirmed = true;
  c.cleanerDeclined = false;
  // Also update booking so owner sees confirmed status in detail
  const b = bookings.find(bk => String(bk.id) === String(c.bookingId) || (bk._cloudId && String(bk._cloudId) === String(c.bookingId)) || _normName(bk.name) === _normName(c.guestName));
  if (b) b.cleanerConfirmed = true;
  try {
    normalizeBookingCleanState();
    try {
      await saveCleanToCloud(c);
    } catch (e) {
      console.error('[StayOps] Cloud save failed:', e);
    }
    // Try direct Supabase first (works in Safari), fall back to Netlify function (home screen PWA)
    if (typeof saveCleansToCloud === 'function' && window._supabaseUser) {
      saveCleansToCloud(cleans).catch(() => {});
    } else {
      postCleanerAction(cleanId, 'accept');
    }
    renderCleanerCleans();
    globalThis.showBanner('✓ Clean accepted!', 'ok');
    // Push owner via user_id mode (cleaner doesn't have owner's local sub)
    try {
      const { uid } = (typeof globalThis.getCleanerParams === 'function') ? globalThis.getCleanerParams() : {};
      if (uid) {
        fetch('/.netlify/functions/send-push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: uid,
            title: '✅ Clean Confirmed',
            body: c.cleaner + ' accepted the clean for ' + (c.guestName || 'guest') + ' on ' + fmt(c.date),
            url: '/',
            tag: 'accept-' + cleanId
          })
        }).catch(e => console.warn('[StayOps] Push notify failed:', e));
      }
    } catch (e) {
      console.warn('[StayOps] Push notify failed:', e);
    }
  } finally {
    releaseCleaningLock(lockKey);
  }
}

export async function cleanerDecline(cleanId) {
  const lockKey = 'cleanerDecline:' + String(cleanId);
  if (!acquireCleaningLock(lockKey)) return;
  const c = cleans.find(cl => String(cl.id) === String(cleanId));
  if (!c) { releaseCleaningLock(lockKey); return; }
  const ok = await globalThis.showAppModal({
    title: '❌ Decline Clean?',
    msg: 'Are you sure you want to decline this clean? The owner will be notified.',
    confirmText: 'Decline',
    confirmColor: 'var(--red)',
    cancelText: 'Cancel'
  });
  if (!ok) { releaseCleaningLock(lockKey); return; }
  c.cleanerDeclined = true;
  c.cleanerConfirmed = false;
  const b = bookings.find(bk => String(bk.id) === String(c.bookingId) || (bk._cloudId && String(bk._cloudId) === String(c.bookingId)) || _normName(bk.name) === _normName(c.guestName));
  if (b) b.cleanerConfirmed = false;
  try {
    normalizeBookingCleanState();
    try {
      await saveCleanToCloud(c);
    } catch (e) {
      console.error('[StayOps] Cloud save failed:', e);
    }
    if (typeof saveCleansToCloud === 'function' && window._supabaseUser) {
      saveCleansToCloud(cleans).catch(() => {});
    } else {
      postCleanerAction(cleanId, 'decline');
    }
    if (typeof saveCleaningJobToCloud === 'function' && window._supabaseUser) saveCleaningJobToCloud(c);
    renderCleanerCleans();
    globalThis.showBanner('Clean declined', 'ok');
    // Push owner via user_id mode (cleaner doesn't have owner's local sub)
    try {
      const { uid } = (typeof globalThis.getCleanerParams === 'function') ? globalThis.getCleanerParams() : {};
      if (uid) {
        fetch('/.netlify/functions/send-push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: uid,
            title: '❌ Clean Declined',
            body: c.cleaner + ' cannot do the clean for ' + (c.guestName || 'guest') + ' on ' + fmt(c.date) + '. Reassign needed.',
            url: '/',
            tag: 'decline-' + cleanId
          })
        }).catch(e => console.warn('[StayOps] Push notify failed:', e));
      }
    } catch (e) {
      console.warn('[StayOps] Push notify failed:', e);
    }
  } finally {
    releaseCleaningLock(lockKey);
  }
}

export async function cleanerMarkDone(cleanId) {
  const lockKey = 'cleanerDone:' + String(cleanId);
  if (!acquireCleaningLock(lockKey)) return;
  const c = cleans.find(cl => String(cl.id) === String(cleanId));
  if (!c) { releaseCleaningLock(lockKey); return; }
  const ok = await globalThis.showAppModal({ title: '✅ Mark Complete', msg: 'Mark this clean as completed?', confirmText: 'Yes, done!', cancelText: 'Not yet' });
  if (!ok) { releaseCleaningLock(lockKey); return; }
  c.done = true; c.cleanerConfirmed = true;
  const b = bookings.find(bk => String(bk.id) === String(c.bookingId) || (bk._cloudId && String(bk._cloudId) === String(c.bookingId)) || _normName(bk.name) === _normName(c.guestName));
  if (b) b.cleanerConfirmed = true;
  try {
    normalizeBookingCleanState();
    try {
      await saveCleanToCloud(c);
    } catch (e) {
      console.error('[StayOps] Cloud save failed:', e);
    }
    if (typeof saveCleansToCloud === 'function' && window._supabaseUser) {
      saveCleansToCloud(cleans).catch(() => {});
    } else {
      postCleanerAction(cleanId, 'done');
    }
    renderCleanerCleans();
    if (typeof saveCleaningJobToCloud === 'function' && window._supabaseUser) saveCleaningJobToCloud(c);
    globalThis.showBanner('✓ Clean marked as complete', 'ok');
    // Push owner via user_id mode (cleaner doesn't have owner's local sub)
    try {
      const { uid } = (typeof globalThis.getCleanerParams === 'function') ? globalThis.getCleanerParams() : {};
      if (uid) {
        fetch('/.netlify/functions/send-push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: uid,
            title: '🏡 Clean Complete!',
            body: c.cleaner + ' has finished the clean for ' + (c.guestName || 'guest') + ' on ' + fmt(c.date),
            url: '/',
            tag: 'done-' + cleanId
          })
        }).catch(e => console.warn('[StayOps] Push notify failed:', e));
      }
    } catch (e) {
      console.warn('[StayOps] Push notify failed:', e);
    }
  } finally {
    releaseCleaningLock(lockKey);
  }
}
export async function assignCleanerToBooking(bookingIdParam) {
  const lockKey = 'assignCleaner:' + String(bookingIdParam);
  if (!acquireCleaningLock(lockKey)) return;
  const saveBtn = document.getElementById('detail-assign-btn');
  if (saveBtn && saveBtn.disabled) { releaseCleaningLock(lockKey); return; }
  const cleanerInput = document.getElementById('detail-assign-cleaner');
  const dateInput = document.getElementById('detail-assign-date');
  if (!cleanerInput || !dateInput) {
    console.warn('[StayOps] assignCleanerToBooking: missing detail assign controls');
    releaseCleaningLock(lockKey);
    return;
  }
  const cleanerId = String(cleanerInput.value || '').trim();
  const date = dateInput.value;
  if (!cleanerId || !date) { globalThis.showBanner('⚠ Select a cleaner and date', 'warn'); releaseCleaningLock(lockKey); return; }
  const cleanerObj = loadCleaners().find(c => String(c.id) === cleanerId);
  if (!cleanerObj) { globalThis.showBanner('⚠ Cleaner not found', 'warn'); releaseCleaningLock(lockKey); return; }
  const booking = bookings.find(b => String(b.id) === String(bookingIdParam) || (b._cloudId && String(b._cloudId) === String(bookingIdParam)));
  if (!booking) {
    console.warn('[StayOps] assignCleanerToBooking: booking not found', { bookingIdParam });
    releaseCleaningLock(lockKey);
    return;
  }
  const detailId = booking._cloudId || booking.id;
  if (booking.status === 'cancelled') { globalThis.showBanner('Cancelled booking — cleaner assignment is disabled', 'warn'); releaseCleaningLock(lockKey); return; }
  // Reuse an existing clean's local id and _cloudId during reassignment so saveCleanToCloud upserts the same row.
  const matched = findMatchingCleanForBooking(booking, date);
  const existingByBookingIdx = cleans.findIndex(c =>
    String(c.bookingId) === String(booking.id) ||
    (booking._cloudId && String(c.bookingId) === String(booking._cloudId))
  );
  const existingIdx = matched ? cleans.findIndex(c => c.id === matched.id) : existingByBookingIdx;
  const prev = existingIdx >= 0 ? cleans[existingIdx] : null;
  const bookingIdForClean = prev ? prev.bookingId : (booking._cloudId || booking.id);

  console.log('[StayOps] Save assignment clicked', { cleanId: prev != null ? prev.id : null, cleanerId, cleanerName: cleanerObj.name });

  if (prev) {
    console.log('[StayOps] Reusing existing clean row', { localId: prev.id, _cloudId: prev._cloudId, bookingIdForClean });
  } else {
    console.log('[StayOps] Creating new clean for booking', { bookingIdForClean });
  }
  const sameAssignment = !!(prev && String(prev.cleanerId) === String(cleanerObj.id) && String(prev.date || '').slice(0, 10) === String(date || '').slice(0, 10));
  const alreadyConfirmed = !!(prev && prev.cleanerConfirmed);
  if (sameAssignment && !alreadyConfirmed) {
    booking.cleanerConfirmed = !!prev.cleanerConfirmed;
    normalizeBookingCleanState();
    if (prev && typeof saveCleanToCloud === 'function') {
      try {
        await saveCleanToCloud(prev);
      } catch (e) {
        console.error('[StayOps] Cloud save failed:', e);
      }
    }
    globalThis.showBanner('No changes — already assigned to ' + cleanerObj.name, 'ok');
    globalThis.showDetail(detailId);
    releaseCleaningLock(lockKey);
    return;
  }
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
  const newClean = {
    id: prev ? prev.id : Date.now(),
    _cloudId: prev ? prev._cloudId : undefined,
    bookingId: bookingIdForClean,
    guestName: booking.name,
    cleaner: cleanerObj.name, cleanerId: cleanerObj.id,
    checkin: booking.checkin,
    date,
    assignedAt: (prev && prev.cleanerId && String(prev.cleanerId) === String(cleanerObj.id)) ? (prev.assignedAt || new Date().toISOString()) : new Date().toISOString(),
    done: false,
    notified: false,
    cleanerDeclined: false,
    cleanerConfirmed: false
  };
  if (existingIdx >= 0) cleans[existingIdx] = newClean;
  else cleans.push(newClean);

  booking.cleanerConfirmed = false;

  try {
    normalizeBookingCleanState();
    recordCleanerAssignmentUsage(cleanerObj);
    if (typeof saveCleanToCloud === 'function') {
      console.log('[StayOps] saveCleanToCloud starting', { localId: newClean.id, _cloudId: newClean._cloudId });
      await saveCleanToCloud(newClean);
      console.log('[StayOps] saveCleanToCloud finished OK');
    }
    globalThis.showBanner('✓ Assigned to ' + cleanerObj.name + ' — awaiting cleaner response', 'ok');
    globalThis.showDetail(detailId);

    // Send push notification
    const cleanerSub = getCleanerSub(cleanerObj.id);
    let pushSent = false;
    console.log('[StayOps] cleaner push sub', { cleanerId: cleanerObj.id, hasSub: !!cleanerSub });
    if (cleanerSub) {
      pushSent = true;
      sendPushToDevice(cleanerSub,
        '🏡 New Clean Assigned',
        `${booking.name || 'Guest'} · ${fmt(date)}`,
        cleanerLinkForId(cleanerObj),
        'assign-' + String(bookingIdParam)
      );
    } else {
      console.warn('[StayOps] No push subscription for cleaner', cleanerObj.id);
    }

    // Send email notification via Gmail/Legacy Sync (fires silently in background)
    const cleanerEmail = String(cleanerObj.email || '').trim();
    if (cleanerEmail) {
      sendCleanerEmail({
        cleanerName: cleanerObj.name,
        cleanerEmail,
        guestName: booking.name || 'Guest',
        checkin: fmt(booking.checkin),
        checkout: fmt(booking.checkout),
        cleanerLink: cleanerLinkForId(cleanerObj),
        guests: booking.guests ? String(booking.guests) : '',
        nights: booking.nights ? String(booking.nights) : ''
      }).then(result => {
        if (result.ok) globalThis.showBanner('✉️ Email sent to ' + cleanerObj.name, 'ok');
        else if (result.reason !== 'no-key' && result.reason !== 'no-email') {
          if (window.Sentry) window.Sentry.captureMessage('Cleaner email failed: ' + (result.reason || 'unknown'), 'warning');
        }
      });
    }
    if (!cleanerEmail && !pushSent) {
      globalThis.showBanner('⚠ Assigned, but no cleaner email or push subscription is configured', 'warn');
    }
  } catch (e) {
    console.warn('[StayOps] assignCleanerToBooking save failed', e);
    globalThis.showBanner('⚠ Could not save assignment — try again', 'warn');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = '💾 Save Assignment';
    }
    releaseCleaningLock(lockKey);
  }
}

window.populateSelects = populateSelects;
