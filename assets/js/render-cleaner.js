/**
 * StayOps — cleaner PWA: the standalone cleaner-facing app (PIN login, cleans/
 * inventory/calendar/profile views, accept/decline/done actions, become-a-host).
 * Split out of render.js 2026-07-10 (second render.js slice). render.js stays the
 * barrel: it imports the 16 public cleaner fns back and re-exports them, so main.js's
 * 92-name import contract is unchanged. Region D's window/globalThis self-bridges moved
 * verbatim (main.js does NOT import them — the inline onclick handlers depend on them).
 * Back-imports from the render core (showBanner/showAppModal/savePropertyData/
 * renderHeaderDateBadge) are call-time only (safe cycle). Cross-module calls already
 * guarded as globalThis.* (loadCleanerDashboard/authFetch/withButtonLoading/subscribeToPush/
 * showBanner in Region D) are left as-is.
 */
import { bookings, cleans, inventory, replaceArrayInPlace } from './state.js';
import { escHtml, _normName, fmt, localDateStr } from './utils.js';
import { subscribeToPush, getCleanerSub } from './notifications.js';
import { isCleanLinkedToCancelledBooking } from './cleaning.js';
import { loadCleaners } from './settings.js';
import { showBanner, showAppModal, savePropertyData, renderHeaderDateBadge } from './render.js';

// ── CLEANER MODE ─────────────────────────────────────────────────────────────
export function isCleanerMode() {
  const hash = window.location.hash; // e.g. #cleaner/123/ABC
  if (hash.startsWith('#cleaner/')) return true;
  const p = new URLSearchParams(window.location.search);
  if (p.get('role') === 'cleaner') return true;
  // Fallback: cleaner params were saved to localStorage on first auth
  return !!localStorage.getItem('gh-cleaner-session');
}

export function getCleanerParams() {
  // Hash format: #cleaner/ID/ENCODEDPIN
  const hash = window.location.hash;
  const p = new URLSearchParams(window.location.search);
  if (hash.startsWith('#cleaner/')) {
    const parts = hash.slice(1).split('/');
    return { id: parts[1] || null, encoded: parts[2] || null, uid: p.get('uid') || null };
  }
  // Fallback: query string format (old links)
  if (p.get('id')) return { id: p.get('id'), encoded: p.get('p'), uid: p.get('uid') || null };
  // Fallback: saved session from home screen launch
  try {
    const saved = JSON.parse(localStorage.getItem('gh-cleaner-session') || 'null');
    if (saved && saved.id) return { id: saved.id, encoded: saved.encoded || null, uid: saved.uid || null };
  } catch (_e) { /* ignore malformed session JSON */ }
  return { id: null, encoded: null, uid: null };
}
globalThis.getCleanerParams = getCleanerParams;

function getActiveCleaner() {
  const { id } = getCleanerParams();
  if (!id) return null;
  return loadCleaners().find(c => String(c.id) === String(id)) || null;
}

/**
 * hydrateCleanerFromFunction — fetches cleaner data from the Netlify function
 * and populates localStorage + in-memory arrays. Used when the home screen PWA
 * has no Supabase auth session (isolated localStorage).
 */
export async function hydrateCleanerFromFunction() {
  const { id, uid } = getCleanerParams();
  if (!id || !uid) {
    console.log('[StayOps] hydrateCleanerFromFunction: missing id or uid');
    return false;
  }
  try {
    console.log('[StayOps] hydrateCleanerFromFunction: fetching data…');
    const res = await fetch((globalThis.apiUrl || (u => u))('/.netlify/functions/cleaner-data?cleanerId=' + encodeURIComponent(id) + '&uid=' + encodeURIComponent(uid)));
    if (!res.ok) {
      console.warn('[StayOps] hydrateCleanerFromFunction: HTTP ' + res.status);
      return false;
    }
    const data = await res.json();
    if (!data || !data.cleaner) {
      console.warn('[StayOps] hydrateCleanerFromFunction: no cleaner in response');
      return false;
    }

    const cleanerRecord = data.cleaner;
    // Ensure the cleaner's local_id is a number if it was originally
    if (cleanerRecord.id && !isNaN(Number(cleanerRecord.id))) {
      cleanerRecord.id = Number(cleanerRecord.id);
    }
    // Populate cleans
    if (Array.isArray(data.cleans)) {
      replaceArrayInPlace(cleans, data.cleans);
    }

    // Populate bookings
    if (Array.isArray(data.bookings)) {
      replaceArrayInPlace(bookings, data.bookings);
    }

    // Populate inventory
    if (Array.isArray(data.inventory)) {
      replaceArrayInPlace(inventory, data.inventory);
    }

    // Set property name
    if (data.property && data.property.name) {
      const headerName = document.getElementById('header-property-name');
      if (headerName) headerName.textContent = data.property.name;
    }

    console.log('[StayOps] hydrateCleanerFromFunction: done — ' +
      (data.cleans || []).length + ' cleans, ' +
      (data.bookings || []).length + ' bookings');
    return true;
  } catch (e) {
    console.warn('[StayOps] hydrateCleanerFromFunction failed:', e);
    return false;
  }
}

/**
 * postCleanerAction — sends accept/decline/done to the Netlify function.
 * Used when there's no Supabase auth session (home screen PWA).
 */
export function _showCleanerLinkError(msg) {
  // Repurpose the PIN screen to show a clear error instead of a blank cleaner view.
  // Removes cleaner-mode so the cleaner shell is hidden, keeps the PIN screen bg.
  document.body.classList.remove('cleaner-mode');
  document.body.classList.add('cleaner-pin-active');
  const dots = document.getElementById('pin-dots');
  if (dots) dots.style.display = 'none';
  const errEl = document.getElementById('pin-error');
  if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
}

export function isCleanerAuthed() {
  const { id } = getCleanerParams();
  return localStorage.getItem('gh-cleaner-authed-' + id) === '1';
}

// ── PIN ENTRY ─────────────────────────────────────────────────────────────────
let cleanerPinEntry = '';
export function pinPress(digit) {
  if (cleanerPinEntry.length >= 4) return;
  cleanerPinEntry += digit;
  updatePinDots();
  if (cleanerPinEntry.length === 4) setTimeout(verifyCleanerPin, 120);
}
export function pinDelete() {
  cleanerPinEntry = cleanerPinEntry.slice(0, -1);
  updatePinDots();
  document.getElementById('pin-error').style.display = 'none';
}
function updatePinDots() {
  for (let i = 0; i < 4; i++) {
    const dot = document.getElementById('pd-' + i);
    if (dot) dot.classList.toggle('filled', i < cleanerPinEntry.length);
  }
}
async function verifyCleanerPin() {
  const { id, encoded } = getCleanerParams();
  if (!encoded) {
    document.getElementById('pin-error').textContent = 'No PIN in link — ask owner to re-copy link from Settings';
    document.getElementById('pin-error').style.display = 'block';
    cleanerPinEntry = ''; updatePinDots(); return;
  }
  let stored;
  try { stored = atob(encoded); } catch(_e) { stored = ''; }
  if (cleanerPinEntry === stored) {
    localStorage.setItem('gh-cleaner-authed-' + id, '1');
    // Save cleaner session so home screen launch preserves cleaner mode
    const { uid } = getCleanerParams();
    localStorage.setItem('gh-cleaner-session', JSON.stringify({ id, encoded, uid: uid || '' }));
    document.body.classList.remove('cleaner-pin-active');
    document.body.classList.add('cleaner-mode');
    // Hydrate cleaner data from Netlify function before rendering
    const hydrateOk = await hydrateCleanerFromFunction();
    if (hydrateOk) {
      renderCleanerView();
      // Subscribe cleaner to push after auth
      setTimeout(() => subscribeToPush('cleaner', id), 1500);
    } else {
      _showCleanerLinkError('Could not load your cleaning data — check your connection and try again.');
    }
  } else {
    document.getElementById('pin-error').textContent = 'Incorrect PIN — try again';
    document.getElementById('pin-error').style.display = 'block';
    const dotsEl = document.getElementById('pin-dots');
    dotsEl.style.transform = 'translateX(-8px)';
    setTimeout(() => { dotsEl.style.transform = 'translateX(8px)'; }, 80);
    setTimeout(() => { dotsEl.style.transform = 'translateX(0)'; }, 160);
    cleanerPinEntry = ''; setTimeout(updatePinDots, 200);
  }
}
export async function cleanerRefresh() {
  const btn = document.getElementById('cleaner-refresh-btn');
  if (btn) { btn.textContent = '↻ …'; btn.disabled = true; }
  await hydrateCleanerFromFunction();
  renderCleanerView();
  if (btn) { btn.textContent = '↻ Refresh'; btn.disabled = false; }
  showBanner('✓ Updated', 'ok');
}

export async function enableCleanerNotifications() {
  const { id } = getCleanerParams();
  const btn = document.getElementById('cleaner-notif-btn');
  if (btn) { btn.textContent = '…'; btn.disabled = true; }
  const sub = await subscribeToPush('cleaner', id);
  if (sub) {
    if (btn) { btn.textContent = '✅ Notifications On'; btn.style.color = 'rgba(255,255,255,0.9)'; }
    showBanner('✓ Notifications enabled!', 'ok');
  } else {
    if (btn) { btn.textContent = '🔔 Enable Notifications'; btn.disabled = false; }
    const perm = window.Notification && Notification.permission;
    if (perm === 'denied') {
      showBanner('Notifications blocked — check Settings', 'error');
    } else {
      showBanner('Could not enable notifications', 'error');
    }
  }
}

function updateCleanerNotifBtn() {
  const btn = document.getElementById('cleaner-notif-btn');
  const status = document.getElementById('cleaner-notif-status');
  if (!btn) return;
  const { id } = getCleanerParams();
  const sub = getCleanerSub(id);
  const granted = window.Notification && Notification.permission === 'granted';
  if (sub && granted) {
    btn.textContent = '🔔 Notifications On';
    if (status) status.textContent = '✅ Notifications enabled';
  } else {
    if (status) status.textContent = '';
  }
}

export function cleanerSignOut() {
  if (window._cleanerData) {
    const signOutPromise = window._sb ? window._sb.auth.signOut() : Promise.resolve();
    signOutPromise.finally(() => {
      window._cleanerData = null;
      document.body.classList.remove('cleaner-mode');
      const cleanerNav = document.getElementById('cleaner-nav');
      const cleanerContent = document.getElementById('cleaner-content');
      if (cleanerNav) cleanerNav.style.display = 'none';
      if (cleanerContent) cleanerContent.style.display = 'none';
      if (typeof showLoginScreen === 'function') showLoginScreen();
    });
    return;
  }
  const { id } = getCleanerParams();
  localStorage.removeItem('gh-cleaner-authed-' + id);
  localStorage.removeItem('gh-cleaner-session');
  cleanerPinEntry = ''; updatePinDots();
  document.getElementById('pin-error').style.display = 'none';
  document.body.classList.remove('cleaner-mode');
  document.body.classList.add('cleaner-pin-active');
}

// ── CLEANER TAB SWITCHING ─────────────────────────────────────────────────────
let _cleanerTab = 'cleans';
export function switchCleanerTab(tab) {
  _cleanerTab = tab;
  ['cleans','inventory'].forEach(t => {
    const tabBtn = document.getElementById('ctab-' + t);
    const viewEl = document.getElementById('cleaner-' + t + '-view');
    if (tabBtn) tabBtn.classList.toggle('active', t === tab);
    if (viewEl) viewEl.style.display = t === tab ? 'block' : 'none';
  });
}

// ── CLEANER CLEANS VIEW ───────────────────────────────────────────────────────
let _cleanerCleanTab = 'upcoming';

export function switchCleanerCleanTab(tab) {
  _cleanerCleanTab = tab;
  ['upcoming','new'].forEach(t => {
    const btn = document.getElementById('csubtab-' + t);
    const el = document.getElementById('cleaner-cleans-' + t);
    if (btn) {
      btn.style.color = t === tab ? 'var(--primary)' : 'var(--muted-2)';
      btn.style.fontWeight = t === tab ? '700' : '600';
      btn.style.borderBottomColor = t === tab ? 'var(--primary)' : 'transparent';
      btn.style.background = t === tab ? 'rgba(31,90,67,0.08)' : 'transparent';
      btn.style.borderRadius = '10px 10px 0 0';
    }
    if (el) el.style.display = t === tab ? '' : 'none';
  });
}

export function renderCleanerCleans() {
  const cleaner = getActiveCleaner();
  const today = localDateStr();
  const twoDaysAgo = localDateStr(new Date(Date.now() - 2*24*60*60*1000));
  const perm = (cleaner && cleaner.permissions) ? cleaner.permissions : {};

  const relevant = cleans.filter(c => {
    if (c.done) return false;
    if (c.date < twoDaysAgo) return false;
    if (isCleanLinkedToCancelledBooking(c)) return false;
    if (cleaner) {
      return (c.cleanerId && String(c.cleanerId) === String(cleaner.id)) ||
             (!c.cleanerId && c.cleaner && c.cleaner === cleaner.name);
    }
    return true;
  }).sort((a,b) => a.date.localeCompare(b.date));

  // Badges on both tabs
  const newCount = relevant.filter(c => !c.cleanerConfirmed && !c.cleanerDeclined).length;
  const upcomingCount = relevant.filter(c => c.cleanerConfirmed && !c.cleanerDeclined).length;
  const cleanerView = document.getElementById('cleaner-cleans-view');
  if (cleanerView) {
    let quick = document.getElementById('cleaner-quick-summary');
    if (!quick) {
      quick = document.createElement('div');
      quick.id = 'cleaner-quick-summary';
      quick.className = 'card';
      quick.style.marginBottom = '10px';
      const upcomingEl = document.getElementById('cleaner-cleans-upcoming');
      cleanerView.insertBefore(quick, upcomingEl || null);
    }
    quick.innerHTML = `
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.55px;color:var(--muted-2);margin-bottom:6px">Your jobs today</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <div class="mini-status-chip chip-new">New: <strong>${newCount}</strong></div>
        <div class="mini-status-chip chip-upcoming">Upcoming: <strong>${upcomingCount}</strong></div>
      </div>
      <div style="font-size:11px;color:var(--muted-2);margin-top:7px">${newCount > 0 ? 'Start in New to accept/decline your latest jobs.' : 'No new responses needed right now.'}</div>
    `;
  }
  const newBadge = document.getElementById('csubtab-new-badge');
  const upBadge = document.getElementById('csubtab-upcoming-badge');
  const badgeStyle = 'border-radius:10px;padding:1px 7px;font-size:11px;margin-left:4px;font-weight:700';
  if (newBadge) newBadge.innerHTML = newCount > 0
    ? `<span style="background:var(--red);color:white;${badgeStyle}">${newCount}</span>`
    : `<span style="background:var(--hairline-1);color:white;${badgeStyle}">0</span>`;
  if (upBadge) upBadge.innerHTML = `<span style="background:${upcomingCount > 0 ? 'var(--primary)' : 'var(--hairline-1)'};color:white;${badgeStyle}">${upcomingCount}</span>`;

  const daysUntil = d => {
    const diff = (new Date(d) - new Date(today)) / 86400000;
    if (diff < -0.5) return null;
    if (diff < 0.5) return 'Today';
    if (diff < 1.5) return 'Tomorrow';
    return Math.ceil(diff) + ' days away';
  };

  function buildCard(c) {
    const booking = bookings.find(b => String(b.id) === String(c.bookingId) || _normName(b.name) === _normName(c.guestName));
    const checkinStr = booking ? fmt(booking.checkin) : (c.checkin ? fmt(c.checkin) : '—');
    const checkoutStr = booking ? fmt(booking.checkout) : fmt(c.date);
    const isToday = c.date === today;
    const showFirstName = perm.firstName && booking;
    const showFullName  = perm.fullName  && booking;
    const showGuests    = perm.guests    && booking;
    const showNotes     = perm.notes;
    const showPayout    = perm.payout    && booking;
    const nameDisplay   = showFullName ? escHtml(booking.name) : showFirstName ? escHtml((booking.name||'').split(' ')[0]) : null;
    const urgency = daysUntil(c.date);

    return `<div class="clean-job-card ${isToday ? 'urgent' : ''}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
        <div>
          <div style="font-family:inherit;font-size:16px;font-weight:500;color:var(--ink-1)">${urgency || 'Upcoming'}</div>
          <div style="font-size:13px;font-weight:400;color:#999;margin-top:2px">${c.date ? fmt(c.date) : '—'}</div>
          ${nameDisplay ? `<div style="font-size:13px;font-weight:600;color:var(--text);margin-top:4px">👤 ${nameDisplay}</div>` : ''}
        </div>
        ${isToday ? '<div style="font-size:11px;font-weight:600;color:var(--amber);background:#FFF5E6;padding:4px 10px;border-radius:20px">Today!</div>' : ''}
      </div>
      <div style="display:grid;grid-template-columns:${showGuests ? '1fr 1fr 1fr' : '1fr 1fr'};gap:8px;margin-bottom:12px">
        <div style="background:var(--surface2);border-radius:8px;padding:8px 10px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.4px;color:var(--muted-2);margin-bottom:3px">Check-in</div>
          <div style="font-size:12px;font-weight:600">${checkinStr}</div>
        </div>
        <div style="background:var(--surface2);border-radius:8px;padding:8px 10px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.4px;color:var(--muted-2);margin-bottom:3px">Check-out</div>
          <div style="font-size:12px;font-weight:600">${checkoutStr}</div>
        </div>
        ${showGuests ? `<div style="background:var(--surface2);border-radius:8px;padding:8px 10px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.4px;color:var(--muted-2);margin-bottom:3px">Guests</div>
          <div style="font-size:12px;font-weight:600">${escHtml(String(booking.guests))}</div>
        </div>` : ''}
      </div>
      ${showPayout ? `<div style="background:#EDF7ED;border-radius:8px;padding:8px 12px;margin-bottom:10px;font-size:13px;color:var(--primary);font-weight:600">💰 Cleaning fee: $${Number(booking.cleaningFee||0).toLocaleString()}</div>` : ''}
      ${showNotes && c.notes ? `<div style="background:var(--surface2);border-radius:8px;padding:8px 12px;margin-bottom:10px;font-size:12px;color:var(--muted-2)">📝 ${escHtml(c.notes)}</div>` : ''}
      BUTTONS_PLACEHOLDER
    </div>`;
  }

  // NEW tab — pending (not yet accepted or declined)
  const newEl = document.getElementById('cleaner-cleans-new');
  const newCleans = relevant.filter(c => !c.cleanerConfirmed && !c.cleanerDeclined);
  if (newEl) {
    if (!newCleans.length) {
      newEl.innerHTML = `<div style="text-align:center;padding:48px 16px">
        <div style="font-size:48px;margin-bottom:12px">✨</div>
        <div style="font-family:inherit;font-size:16px;font-weight:500;color:var(--ink-1);margin-bottom:6px">Nothing new!</div>
        <div style="font-size:13px;font-weight:400;color:#999">New assignments will appear here</div>
        <div style="font-size:13px;font-weight:400;color:#999;margin-top:8px">If you were just assigned, tap <strong>↻ Refresh</strong>.</div>
      </div>`;
    } else {
      newEl.innerHTML = newCleans.map(c => {
        const buttons = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <button onclick="cleanerDecline('${c.id}')" style="background:#FDECEA;color:var(--red);border:none;border-radius:var(--radius-sm);padding:13px;font-size:13px;font-weight:600;font-family:'Plus Jakarta Sans',sans-serif;cursor:pointer">✗ Decline</button>
          <button onclick="cleanerAccept('${c.id}')" style="background:var(--primary);color:white;border:none;border-radius:var(--radius-sm);padding:13px;font-size:13px;font-weight:600;font-family:'Plus Jakarta Sans',sans-serif;cursor:pointer">✓ Accept</button>
        </div>`;
        return buildCard(c).replace('BUTTONS_PLACEHOLDER', buttons);
      }).join('');
    }
  }

  // UPCOMING tab — accepted cleans
  const upcomingEl = document.getElementById('cleaner-cleans-upcoming');
  const upcomingCleans = relevant.filter(c => c.cleanerConfirmed && !c.cleanerDeclined);
  if (upcomingEl) {
    if (!upcomingCleans.length) {
      upcomingEl.innerHTML = `<div style="text-align:center;padding:48px 16px">
        <div style="font-size:48px;margin-bottom:12px">🗓</div>
        <div style="font-family:inherit;font-size:16px;font-weight:500;color:var(--ink-1);margin-bottom:6px">No upcoming cleans</div>
        <div style="font-size:13px;font-weight:400;color:#999">Cleans you've accepted will appear here</div>
        <div style="font-size:13px;font-weight:400;color:#999;margin-top:8px">Accept a clean from the <strong>New</strong> tab first.</div>
      </div>`;
    } else {
      upcomingEl.innerHTML = upcomingCleans.map(c => {
        const buttons = `<button onclick="cleanerMarkDone('${c.id}')" style="width:100%;background:var(--primary);color:white;border:none;border-radius:var(--radius-sm);padding:13px;font-size:14px;font-weight:600;font-family:'Plus Jakarta Sans',sans-serif;cursor:pointer">✓ Mark as Complete</button>`;
        return buildCard(c).replace('BUTTONS_PLACEHOLDER', buttons);
      }).join('');
    }
  }
}

// ── CLEANER INVENTORY VIEW ────────────────────────────────────────────────────
function renderCleanerInventory() {
  const el = document.getElementById('cleaner-inventory-list');
  if (!el) return;
  const lowItems = inventory.filter(i => i.stock <= i.threshold);
  let html = '';
  if (lowItems.length) {
    html += `<div class="card" style="margin-bottom:12px;border-left:4px solid var(--amber)">
      <div style="font-size:12px;font-weight:600;color:var(--amber);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">⚠ Needs Restocking</div>
      <div style="font-size:13px;color:var(--muted-2)">${lowItems.map(i=>`<strong>${escHtml(i.name)}</strong>`).join(', ')} ${lowItems.length===1?'is':'are'} running low</div>
    </div>`;
  }
  if (!inventory.length) {
    html += '<div style="text-align:center;padding:40px 16px;color:var(--muted-2);font-size:13px">No inventory items added yet</div>';
  } else {
    html += `<div class="card" style="padding:0">` + inventory.map(i => {
      const isLow = i.stock <= i.threshold;
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--hairline-2);gap:8px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:14px;color:${isLow?'var(--red)':'var(--text)'}">${escHtml(i.name)}${isLow?' ⚠':''}</div>
          ${i.unit?`<div style="font-size:11px;color:var(--muted-2);margin-top:2px">${escHtml(i.unit)}</div>`:''}
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
          <button onclick="cleanerAdjustStock('${i.id}',-1)" style="width:36px;height:36px;border-radius:50%;border:1.5px solid var(--hairline-1);background:white;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1">−</button>
          <span style="font-weight:700;font-size:18px;min-width:28px;text-align:center;color:${isLow?'var(--red)':'var(--primary)'}">${i.stock}</span>
          <button onclick="cleanerAdjustStock('${i.id}',1)" style="width:36px;height:36px;border-radius:50%;border:none;background:var(--primary);color:white;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1">+</button>
        </div>
      </div>`;
    }).join('') + `</div>`;
  }
  el.innerHTML = html;
}
export async function cleanerAddInventoryItem() {
  const name = await showAppModal({
    title: '+ Add Inventory Item',
    msg: 'Enter the item name:',
    hasInput: true,
    inputPlaceholder: 'e.g. Toilet paper',
    inputType: 'text',
    confirmText: 'Add',
    cancelText: 'Cancel'
  });
  if (!name || !name.trim()) return;
  const newItem = {
    id: Date.now(),
    name: name.trim(),
    stock: 0,
    threshold: 2,
    unit: ''
  };
  inventory.push(newItem);
  savePropertyData();
  renderCleanerInventory();
  showBanner('✓ Item added', 'ok');
}

export function cleanerAdjustStock(id, delta) {
  const item = inventory.find(i => String(i.id) === String(id));
  if (!item) return;
  item.stock = Math.max(0, item.stock + delta);
  savePropertyData(); renderCleanerInventory();
}
// ── CLEANER CHAT VIEW ─────────────��──────────────────────────────────────────

export function renderCleanerView() {
  const cleaner = getActiveCleaner();
  const headerSub = document.querySelector('.cleaner-header .header-sub-name');
  if (headerSub && cleaner) headerSub.textContent = 'Hi, ' + cleaner.name.split(' ')[0] + ' 👋';
  renderCleanerCleans();
  renderCleanerInventory();
  updateCleanerNotifBtn();
}

function renderNewCleanerView(data) {
  if (!data) return;
  const { cleanerRecord, myCleans } = data;

  // Hide FAB — cleaners don't need the quick-add button
  const fab = document.querySelector('.fab');
  if (fab) fab.style.display = 'none';
  const qaFab = document.getElementById('quick-add-fab');
  if (qaFab) qaFab.style.display = 'none';

  // Set header date badge (normally only set during host init)
  renderHeaderDateBadge();

  const greeting = document.getElementById('cleaner-greeting');
  if (greeting) greeting.textContent = 'Welcome, ' + (cleanerRecord.name || 'Cleaner');

  // Update header subtitle — show property name instead of location
  const headerSub = document.querySelector('.cleaner-header .header-sub-name');
  if (headerSub) {
    const propName = window._cleanerData && window._cleanerData.property && window._cleanerData.property.name;
    headerSub.textContent = propName || '';
  }

  const container = document.getElementById('cleaner-section-cleans');
  if (!container) return;

  const today = new Date();
  const todayStr = localDateStr(today);

  function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return days[d.getDay()] + ', ' + d.getDate() + ' ' + months[d.getMonth()];
  }

  function daysUntil(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr + 'T00:00:00');
    const diff = Math.ceil((d - today) / (1000 * 60 * 60 * 24));
    return diff;
  }

  function urgencyPill(days) {
    if (days === null) return '';
    let bg, color, label;
    if (days < 0) {
      bg = '#F1EFE8'; color = '#5F5E5A'; label = 'Past';
    } else if (days === 0) {
      bg = '#FCEBEB'; color = '#A32D2D'; label = 'Today';
    } else if (days === 1) {
      bg = '#FCEBEB'; color = '#A32D2D'; label = 'Tomorrow';
    } else if (days <= 7) {
      bg = '#FCEBEB'; color = '#A32D2D'; label = 'In ' + days + ' days';
    } else if (days <= 30) {
      bg = '#FAEEDA'; color = '#854F0B'; label = 'In ' + days + ' days';
    } else {
      bg = '#E1F5EE'; color = '#0F6E56'; label = 'In ' + days + ' days';
    }
    return '<div style="font-size:11px;font-weight:500;background:' + bg + ';color:' + color + ';padding:3px 10px;border-radius:12px;white-space:nowrap">' + label + '</div>';
  }

  const cancelled = myCleans.filter(c => c._bookingCancelled && !c.done);
  const nonCancelled = myCleans.filter(c => !c._bookingCancelled);
  const actionNeeded = nonCancelled.filter(c => !c.done && !c.cleaner_confirmed && !c.cleaner_declined);
  const upcoming = nonCancelled.filter(c => !c.done && c.cleaner_confirmed && c.clean_date >= todayStr);
  const completed = nonCancelled.filter(c => c.done);

  let html = '';

  // Cancelled bookings
  if (cancelled.length) {
    html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:12px">';
    html += '<div style="width:8px;height:8px;border-radius:50%;background:#C0392B"></div>';
    html += '<span style="font-size:12px;font-weight:500;color:#C0392B;text-transform:uppercase;letter-spacing:0.4px">Cancelled</span>';
    html += '<span style="font-size:11px;color:#999;margin-left:2px">' + cancelled.length + '</span>';
    html += '</div>';

    cancelled.forEach(c => {
      const prop = c.properties || {};
      const guestLine = escHtml(c.guest_name || 'Guest');
      const acked = c.cleaner_cancel_acknowledged;

      html += '<div style="background:white;border:0.5px solid #eee;border-left:3px solid #C0392B;border-radius:0 8px 8px 0;padding:14px 16px;margin-bottom:10px">';
      html += '<div style="display:flex;justify-content:space-between;align-items:flex-start">';
      html += '<div>';
      html += '<div style="font-size:17px;font-weight:500;color:var(--ink-1);text-decoration:line-through">' + formatDate(c.clean_date) + '</div>';
      html += '<div style="font-size:13px;color:#888;margin-top:2px;text-decoration:line-through">' + guestLine + '</div>';
      html += '</div>';
      html += '<div style="font-size:11px;font-weight:500;background:#FCEBEB;color:#A32D2D;padding:3px 10px;border-radius:12px;white-space:nowrap">Booking cancelled</div>';
      html += '</div>';
      html += '<div style="margin-top:10px;padding:10px 12px;background:#f7f7f5;border-radius:6px">';
      html += '<div style="font-size:13px;font-weight:500;color:#333">' + escHtml(prop.name || 'Property') + '</div>';
      html += '<div style="font-size:12px;color:#888;margin-top:1px">' + escHtml(prop.address || '') + '</div>';
      html += '</div>';
      if (acked) {
        html += '<div style="margin-top:10px;font-size:12px;color:#0F6E56;font-weight:500">✓ Acknowledged</div>';
      } else {
        html += '<button type="button" data-action="acknowledge_cancel" data-clean-id="' + String(c.id) + '" style="width:100%;margin-top:10px;padding:10px;background:#2f5d4e;color:white;border:none;border-radius:8px;font-weight:500;font-size:13px;cursor:pointer">Acknowledge Cancellation</button>';
      }
      html += '</div>';
    });
  }

  // Action needed
  if (actionNeeded.length) {
    html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:12px">';
    html += '<div style="width:8px;height:8px;border-radius:50%;background:#E24B4A"></div>';
    html += '<span style="font-size:12px;font-weight:500;color:#A32D2D;text-transform:uppercase;letter-spacing:0.4px">Action needed</span>';
    html += '<span style="font-size:11px;color:#999;margin-left:2px">' + actionNeeded.length + '</span>';
    html += '</div>';

    actionNeeded.forEach(c => {
      const prop = c.properties || {};
      const days = daysUntil(c.clean_date);
      const guests = c.guests || '';
      const guestLine = escHtml(c.guest_name || 'Guest') + (guests ? ' · ' + escHtml(String(guests)) + ' guests' : '');

      html += '<div style="background:white;border:0.5px solid #eee;border-left:3px solid #E24B4A;border-radius:0 8px 8px 0;padding:14px 16px;margin-bottom:10px">';
      html += '<div style="display:flex;justify-content:space-between;align-items:flex-start">';
      html += '<div>';
      html += '<div style="font-size:17px;font-weight:500;color:var(--ink-1)">' + formatDate(c.clean_date) + '</div>';
      html += '<div style="font-size:13px;color:#888;margin-top:2px">' + guestLine + '</div>';
      html += '</div>';
      html += urgencyPill(days);
      html += '</div>';
      html += '<div style="margin-top:10px;padding:10px 12px;background:#f7f7f5;border-radius:6px">';
      html += '<div style="font-size:13px;font-weight:500;color:#333">' + escHtml(prop.name || 'Property') + '</div>';
      html += '<div style="font-size:12px;color:#888;margin-top:1px">' + escHtml(prop.address || '') + '</div>';
      html += '</div>';
      html += '<div style="display:flex;gap:8px;margin-top:12px">';
      html += '<button type="button" data-action="accept" data-clean-id="' + String(c.id) + '" style="flex:1;padding:10px;background:#2f5d4e;color:white;border:none;border-radius:8px;font-weight:500;font-size:13px;cursor:pointer">Accept</button>';
      html += '<button type="button" data-action="decline" data-clean-id="' + String(c.id) + '" style="flex:1;padding:10px;background:transparent;color:#A32D2D;border:1px solid #F09595;border-radius:8px;font-weight:500;font-size:13px;cursor:pointer">Decline</button>';
      html += '</div></div>';
    });
  }

  // Upcoming confirmed
  if (upcoming.length) {
    html += '<div style="display:flex;align-items:center;gap:6px;margin:20px 0 12px">';
    html += '<div style="width:8px;height:8px;border-radius:50%;background:#1D9E75"></div>';
    html += '<span style="font-size:12px;font-weight:500;color:#0F6E56;text-transform:uppercase;letter-spacing:0.4px">Confirmed</span>';
    html += '<span style="font-size:11px;color:#999;margin-left:2px">' + upcoming.length + '</span>';
    html += '</div>';

    upcoming.forEach(c => {
      const prop = c.properties || {};
      const days = daysUntil(c.clean_date);
      const checkInInfo = prop.check_in_info || {};
      const guests = c.guests || '';
      const guestLine = escHtml(c.guest_name || 'Guest') + (guests ? ' · ' + escHtml(String(guests)) + ' guests' : '');

      html += '<div style="background:white;border:0.5px solid #eee;border-left:3px solid #1D9E75;border-radius:0 8px 8px 0;padding:14px 16px;margin-bottom:10px">';
      html += '<div style="display:flex;justify-content:space-between;align-items:flex-start">';
      html += '<div>';
      html += '<div style="font-size:17px;font-weight:500;color:var(--ink-1)">' + formatDate(c.clean_date) + '</div>';
      html += '<div style="font-size:13px;color:#888;margin-top:2px">' + guestLine + '</div>';
      html += '</div>';
      html += urgencyPill(days);
      html += '</div>';
      html += '<div style="margin-top:10px;padding:10px 12px;background:#f7f7f5;border-radius:6px">';
      html += '<div style="font-size:13px;font-weight:500;color:#333">' + escHtml(prop.name || 'Property') + '</div>';
      html += '<div style="font-size:12px;color:#888;margin-top:1px">' + escHtml(prop.address || '') + '</div>';
      html += '</div>';

      if (checkInInfo.lockbox_code || checkInInfo.instructions) {
        html += '<div style="margin-top:8px;padding:10px 12px;background:#f7f7f5;border-radius:6px;font-size:12px;color:#666">';
        html += '<div style="font-weight:500;margin-bottom:2px;color:#333">Access info</div>';
        let accessParts = [];
        if (checkInInfo.lockbox_code) accessParts.push('Lockbox: ' + escHtml(checkInInfo.lockbox_code));
        if (checkInInfo.instructions) accessParts.push(escHtml(checkInInfo.instructions));
        html += accessParts.join(' · ');
        html += '</div>';
      }

      const cleanDateObj = new Date(c.clean_date + 'T00:00:00');
      const isToday = c.clean_date === todayStr;
      const isPast = cleanDateObj < today;
      if (isToday || isPast) {
        html += '<button type="button" data-action="done" data-clean-id="' + String(c.id) + '" style="width:100%;margin-top:10px;padding:10px;background:transparent;color:#2f5d4e;border:1px solid #ccc;border-radius:8px;font-weight:500;font-size:13px;cursor:pointer">Mark as done</button>';
      }
      html += '</div>';
    });
  }

  // Completed
  if (completed.length) {
    html += '<div style="display:flex;align-items:center;gap:6px;margin:20px 0 12px">';
    html += '<div style="width:8px;height:8px;border-radius:50%;background:#999"></div>';
    html += '<span style="font-size:12px;font-weight:500;color:#999;text-transform:uppercase;letter-spacing:0.4px">Completed</span>';
    html += '</div>';

    completed.slice(0, 10).forEach(c => {
      const prop = c.properties || {};
      html += '<div style="background:#f9f9f7;border:0.5px solid #eee;border-radius:8px;padding:12px 16px;margin-bottom:8px;opacity:0.7">';
      html += '<div style="display:flex;justify-content:space-between;align-items:center">';
      html += '<div>';
      html += '<div style="font-size:14px;font-weight:500;color:#555">' + formatDate(c.clean_date) + '</div>';
      html += '<div style="font-size:12px;color:#999;margin-top:1px">' + escHtml(c.guest_name || '') + ' · ' + escHtml(prop.name || '') + '</div>';
      html += '</div>';
      html += '<div style="font-size:11px;color:#999">Done</div>';
      html += '</div></div>';
    });
  }

  if (!html) {
    html = '<div style="text-align:center;padding:40px 20px;color:#999"><div style="font-size:40px;margin-bottom:12px">✨</div><div style="font-size:15px;font-weight:500">No cleans assigned yet</div><div style="font-size:13px;margin-top:6px">Your host will assign cleans to you here.</div></div>';
  }

  container.innerHTML = html;

  if (!container._cleanerDelegated) {
    container.addEventListener('click', async function (e) {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      e.stopPropagation();
      e.stopImmediatePropagation();
      const action = btn.getAttribute('data-action');
      const cleanId = btn.getAttribute('data-clean-id');
      if (!cleanId) return;
      const labels = { accept: 'Accepting…', decline: 'Declining…', done: 'Completing…', acknowledge_cancel: 'Acknowledging…' };
      await globalThis.withButtonLoading(btn, async () => {
        if (action === 'accept') await cleanerAcceptClean(cleanId);
        else if (action === 'decline') await cleanerDeclineClean(cleanId);
        else if (action === 'done') await cleanerMarkDone(cleanId);
        else if (action === 'acknowledge_cancel') await cleanerAcknowledgeCancel(cleanId);
      }, labels[action] || 'Working…');
    }, true);
    container._cleanerDelegated = true;
  }
}
window.renderNewCleanerView = renderNewCleanerView;

async function cleanerAcceptClean(cleanId) {
  if (!window._sb) return;
  const { error } = await window._sb
    .from('cleans')
    .update({ cleaner_confirmed: true, confirmed_at: new Date().toISOString() })
    .eq('id', cleanId);
  if (error) { globalThis.showBanner('Failed to accept: ' + error.message, 'error'); return; }
  const data = typeof globalThis.loadCleanerDashboard === 'function'
    ? await globalThis.loadCleanerDashboard()
    : null;
  if (data) {
    try {
      const cleanData = data.myCleans?.find((c) => String(c.id) === String(cleanId));
      const guestName = cleanData?.guest_name || cleanData?.guestName || 'guest';
      const cleanDate = cleanData?.clean_date || cleanData?.date || '';
      const cleanerName = data.cleanerRecord?.name || 'Cleaner';
      const uid = cleanData?.user_id || getCleanerParams().uid;
      if (uid) {
        await (typeof globalThis.authFetch === 'function' ? globalThis.authFetch : fetch)('/.netlify/functions/send-push', {
          method: 'POST',
          body: JSON.stringify({
            user_id: uid,
            title: '✅ Clean Confirmed',
            body: cleanerName + ' accepted the clean for ' + guestName + (cleanDate ? ' on ' + cleanDate : ''),
            url: '/',
            tag: 'accept-' + cleanId
          })
        });
      }
    } catch (e) {
      console.warn('[StayOps] Push notify failed:', e);
    }
    window._cleanerData = data;
    renderNewCleanerView(data);
    renderCleanerCalendar();
    renderCleanerProfile();
  }
}
window.cleanerAcceptClean = cleanerAcceptClean;

async function cleanerDeclineClean(cleanId) {
  if (!window._sb) return;
  const { error } = await window._sb
    .from('cleans')
    .update({ cleaner_declined: true })
    .eq('id', cleanId);
  if (error) { globalThis.showBanner('Failed to decline: ' + error.message, 'error'); return; }
  const data = typeof globalThis.loadCleanerDashboard === 'function'
    ? await globalThis.loadCleanerDashboard()
    : null;
  if (data) {
    try {
      const cleanData = data.myCleans?.find((c) => String(c.id) === String(cleanId));
      const guestName = cleanData?.guest_name || cleanData?.guestName || 'guest';
      const cleanDate = cleanData?.clean_date || cleanData?.date || '';
      const cleanerName = data.cleanerRecord?.name || 'Cleaner';
      const uid = cleanData?.user_id || getCleanerParams().uid;
      if (uid) {
        await (typeof globalThis.authFetch === 'function' ? globalThis.authFetch : fetch)('/.netlify/functions/send-push', {
          method: 'POST',
          body: JSON.stringify({
            user_id: uid,
            title: '❌ Clean Declined',
            body: cleanerName + ' cannot do the clean for ' + guestName + (cleanDate ? ' on ' + cleanDate : '') + '. Reassign needed.',
            url: '/',
            tag: 'decline-' + cleanId
          })
        });
      }
    } catch (e) {
      console.warn('[StayOps] Push notify failed:', e);
    }
    window._cleanerData = data;
    renderNewCleanerView(data);
    renderCleanerCalendar();
    renderCleanerProfile();
  }
}
window.cleanerDeclineClean = cleanerDeclineClean;

async function cleanerMarkDone(cleanId) {
  if (!window._sb) return;
  const { error } = await window._sb
    .from('cleans')
    .update({ done: true, completed_at: new Date().toISOString() })
    .eq('id', cleanId);
  if (error) { globalThis.showBanner('Failed to mark done: ' + error.message, 'error'); return; }
  const data = typeof globalThis.loadCleanerDashboard === 'function'
    ? await globalThis.loadCleanerDashboard()
    : null;
  if (data) {
    try {
      const cleanData = data.myCleans?.find((c) => String(c.id) === String(cleanId));
      const guestName = cleanData?.guest_name || cleanData?.guestName || 'guest';
      const cleanDate = cleanData?.clean_date || cleanData?.date || '';
      const cleanerName = data.cleanerRecord?.name || 'Cleaner';
      const uid = cleanData?.user_id || getCleanerParams().uid;
      if (uid) {
        await (typeof globalThis.authFetch === 'function' ? globalThis.authFetch : fetch)('/.netlify/functions/send-push', {
          method: 'POST',
          body: JSON.stringify({
            user_id: uid,
            title: '🏡 Clean Complete!',
            body: cleanerName + ' has finished the clean for ' + guestName + (cleanDate ? ' on ' + cleanDate : '') + ' — review cleaning cost',
            url: '/',
            tag: 'done-' + cleanId
          })
        });
      }
    } catch (e) {
      console.warn('[StayOps] Push notify failed:', e);
    }
    window._cleanerData = data;
    renderNewCleanerView(data);
    renderCleanerCalendar();
    renderCleanerProfile();
  }
}
window.cleanerMarkDone = cleanerMarkDone;

async function cleanerAcknowledgeCancel(cleanId) {
  if (!window._sb) return;
  const { error } = await window._sb
    .from('cleans')
    .update({ cleaner_cancel_acknowledged: true, cleaner_cancel_acknowledged_at: new Date().toISOString() })
    .eq('id', cleanId);
  if (error) { globalThis.showBanner('Failed to acknowledge: ' + error.message, 'error'); return; }
  const data = typeof globalThis.loadCleanerDashboard === 'function'
    ? await globalThis.loadCleanerDashboard()
    : null;
  if (data) {
    try {
      const cleanData = data.myCleans?.find((c) => String(c.id) === String(cleanId));
      const cleanerName = data.cleanerRecord?.name || 'Cleaner';
      const uid = cleanData?.user_id || getCleanerParams().uid;
      if (uid) {
        await (typeof globalThis.authFetch === 'function' ? globalThis.authFetch : fetch)('/.netlify/functions/send-push', {
          method: 'POST',
          body: JSON.stringify({
            user_id: uid,
            title: '✓ Cancellation acknowledged',
            body: cleanerName + ' acknowledged the booking cancellation',
            url: '/',
            tag: 'ack-cancel-' + cleanId
          })
        });
      }
    } catch (e) {
      console.warn('[StayOps] Push notify failed:', e);
    }
    window._cleanerData = data;
    renderNewCleanerView(data);
    renderCleanerCalendar();
    renderCleanerProfile();
  }
}
window.cleanerAcknowledgeCancel = cleanerAcknowledgeCancel;

function renderCleanerCalendar() {
  const container = document.getElementById('cleaner-section-calendar');
  if (!container || !window._cleanerData) return;

  const cleans = window._cleanerData.myCleans || [];
  const today = new Date();
  let viewMonth = window._cleanerCalMonth || today.getMonth();
  let viewYear = window._cleanerCalYear || today.getFullYear();
  window._cleanerCalMonth = viewMonth;
  window._cleanerCalYear = viewYear;

  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  const cleanDates = {};
  cleans.forEach((c) => {
    if (c.clean_date) {
      cleanDates[c.clean_date] = cleanDates[c.clean_date] || [];
      cleanDates[c.clean_date].push(c);
    }
  });

  const firstDay = new Date(viewYear, viewMonth, 1);
  const lastDay = new Date(viewYear, viewMonth + 1, 0);
  let startDay = firstDay.getDay() - 1;
  if (startDay < 0) startDay = 6;

  let html = '';
  html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">';
  html += '<button onclick="cleanerCalNav(-1)" style="background:none;border:none;font-size:20px;cursor:pointer;padding:8px">‹</button>';
  html += '<div style="font-weight:700;font-size:16px;color:var(--primary)">' + monthNames[viewMonth] + ' ' + viewYear + '</div>';
  html += '<button onclick="cleanerCalNav(1)" style="background:none;border:none;font-size:20px;cursor:pointer;padding:8px">›</button>';
  html += '</div>';

  html += '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;margin-bottom:12px">';
  dayNames.forEach((d) => {
    html += '<div style="text-align:center;font-size:11px;font-weight:600;color:#999;padding:4px 0">' + d + '</div>';
  });

  for (let i = 0; i < startDay; i++) {
    html += '<div></div>';
  }

  const todayStr = localDateStr(today);

  for (let d = 1; d <= lastDay.getDate(); d++) {
    const dateStr = viewYear + '-' + String(viewMonth + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    const hasCleans = cleanDates[dateStr];
    const isToday = dateStr === todayStr;

    html += '<div onclick="showCleanerDayDetail(\'' + dateStr + '\')" style="text-align:center;padding:8px 2px;border-radius:10px;cursor:' + (hasCleans ? 'pointer' : 'default') + ';' + (isToday ? 'background:var(--primary);color:white;font-weight:700;' : '') + '">';
    html += '<div style="font-size:14px">' + d + '</div>';
    if (hasCleans) {
      const dotColor = hasCleans.some((c) => !c.cleaner_confirmed && !c.done) ? '#C0392B' : '#3B6D11';
      html += '<div style="width:6px;height:6px;border-radius:50%;background:' + dotColor + ';margin:3px auto 0"></div>';
    }
    html += '</div>';
  }
  html += '</div>';
  html += '<div id="cleaner-day-detail"></div>';
  container.innerHTML = html;
}
window.renderCleanerCalendar = renderCleanerCalendar;

function cleanerCalNav(dir) {
  window._cleanerCalMonth = (window._cleanerCalMonth || new Date().getMonth()) + dir;
  window._cleanerCalYear = window._cleanerCalYear || new Date().getFullYear();
  if (window._cleanerCalMonth > 11) { window._cleanerCalMonth = 0; window._cleanerCalYear++; }
  if (window._cleanerCalMonth < 0) { window._cleanerCalMonth = 11; window._cleanerCalYear--; }
  renderCleanerCalendar();
}
window.cleanerCalNav = cleanerCalNav;

function showCleanerDayDetail(dateStr) {
  const container = document.getElementById('cleaner-day-detail');
  if (!container || !window._cleanerData) return;

  const cleans = (window._cleanerData.myCleans || []).filter((c) => c.clean_date === dateStr);
  if (!cleans.length) { container.innerHTML = ''; return; }

  let html = '<div style="margin-top:12px;padding-top:12px;border-top:1px solid #eee">';
  html += '<div style="font-weight:700;font-size:13px;color:var(--primary);margin-bottom:8px">' + dateStr + '</div>';

  cleans.forEach((c) => {
    const prop = c.properties || {};
    const status = c.done ? 'Done' : c.cleaner_confirmed ? 'Confirmed' : c.cleaner_declined ? 'Declined' : 'Pending';
    const statusColor = c.done ? '#999' : c.cleaner_confirmed ? '#3B6D11' : c.cleaner_declined ? '#C0392B' : '#F5A623';
    html += '<div style="background:white;border-radius:10px;padding:12px;margin-bottom:6px;box-shadow:0 1px 3px rgba(0,0,0,0.05)">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center">';
    html += '<div style="font-weight:600;font-size:14px">' + (prop.name || 'Property') + '</div>';
    html += '<span style="font-size:11px;font-weight:700;color:' + statusColor + ';background:' + statusColor + '15;padding:3px 8px;border-radius:6px">' + status + '</span>';
    html += '</div>';
    html += '<div style="font-size:12px;color:#666;margin-top:3px">' + (c.guest_name || '') + '</div>';
    html += '</div>';
  });

  html += '</div>';
  container.innerHTML = html;
}
window.showCleanerDayDetail = showCleanerDayDetail;

function renderCleanerProfile() {
  const container = document.getElementById('cleaner-section-profile');
  if (!container || !window._cleanerData) return;

  const cr = window._cleanerData.cleanerRecord;

  // Update header subtitle — show property name instead of location
  const headerSub = document.querySelector('.cleaner-header .header-sub-name');
  if (headerSub) {
    const propName = window._cleanerData.property && window._cleanerData.property.name;
    headerSub.textContent = propName || '';
  }

  let html = '';
  html += '<div style="background:white;border-radius:16px;padding:24px;box-shadow:0 1px 4px rgba(0,0,0,0.06)">';
  html += '<div style="text-align:center;margin-bottom:20px">';
  html += '<div style="width:64px;height:64px;border-radius:50%;background:var(--primary);color:white;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;margin:0 auto 10px">' + escHtml((cr.name || 'C')[0].toUpperCase()) + '</div>';
  html += '<div style="font-weight:700;font-size:18px;color:var(--primary)">' + escHtml(cr.name || 'Cleaner') + '</div>';
  html += '</div>';
  html += '<div style="border-top:1px solid #f0f0f0;padding-top:16px">';
  html += '<div style="display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #f5f5f3">';
  html += '<span style="font-size:13px;color:#999">Email</span>';
  html += '<span style="font-size:13px;font-weight:600;color:#333">' + escHtml(cr.email || '—') + '</span>';
  html += '</div>';
  html += '<div style="display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #f5f5f3">';
  html += '<span style="font-size:13px;color:#999">Phone</span>';
  html += '<span style="font-size:13px;font-weight:600;color:#333">' + escHtml(cr.phone || '—') + '</span>';
  html += '</div>';
  html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid #f5f5f3">';
  html += '<span style="font-size:13px;color:#999">Notifications</span>';
  html += '<span id="cleaner-profile-notif-status" style="font-size:13px;font-weight:600;color:#999"></span>';
  html += '</div>';

  const cleans = window._cleanerData.myCleans || [];
  const completed = cleans.filter((c) => c.done).length;
  const upcoming = cleans.filter((c) => !c.done && c.cleaner_confirmed).length;

  html += '<div style="display:flex;gap:12px;margin-top:20px">';
  html += '<div style="flex:1;background:#f5f5f3;border-radius:12px;padding:14px;text-align:center">';
  html += '<div style="font-size:22px;font-weight:700;color:var(--primary)">' + completed + '</div>';
  html += '<div style="font-size:11px;color:#999;margin-top:2px">Completed</div>';
  html += '</div>';
  html += '<div style="flex:1;background:#f5f5f3;border-radius:12px;padding:14px;text-align:center">';
  html += '<div style="font-size:22px;font-weight:700;color:var(--primary)">' + upcoming + '</div>';
  html += '<div style="font-size:11px;color:#999;margin-top:2px">Upcoming</div>';
  html += '</div>';
  html += '</div>';
  html += '</div></div>';
  // "Also a Host?" section — only show if user doesn't already have a host role
  html += '<div id="cleaner-become-host-section" style="margin-top:20px;display:none">';
  html += '<div style="background:white;border-radius:12px;padding:16px;border:1.5px solid #EAF3DE">';
  html += '<div style="font-weight:700;font-size:14px;color:var(--primary);margin-bottom:4px">Also manage your own property?</div>';
  html += '<div style="font-size:12px;color:#888;margin-bottom:12px;line-height:1.4">Add host mode to manage bookings, finances, and cleaning schedules for your own properties.</div>';
  html += '<button onclick="becomeHost()" id="become-host-btn" style="width:100%;padding:12px;background:var(--primary);color:white;border:none;border-radius:10px;font-weight:600;font-size:13px;cursor:pointer;font-family:\'Plus Jakarta Sans\',sans-serif">Enable Host Mode</button>';
  html += '</div></div>';

  html += '<button onclick="cleanerSignOut()" style="width:100%;margin-top:20px;padding:14px;background:white;color:#C0392B;border:1.5px solid #C0392B;border-radius:12px;font-weight:700;font-size:14px;cursor:pointer">Sign Out</button>';

  container.innerHTML = html;

  // Check notification status — use unique ID to avoid conflict with legacy header element
  const notifEl = document.getElementById('cleaner-profile-notif-status');
  if (notifEl) {
    const enableBtn =
      '<button onclick="window._enableCleanerNotifs()" style="background:var(--primary);color:white;border:none;border-radius:8px;padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer">Enable</button>';
    if (typeof Notification === 'undefined' || !('serviceWorker' in navigator)) {
      notifEl.innerHTML = '<span style="color:#C0392B">Not supported</span>';
    } else if (Notification.permission === 'granted') {
      notifEl.innerHTML = '<span style="color:#1D9E75">✓ Enabled</span>';
    } else if (Notification.permission === 'denied') {
      notifEl.innerHTML = '<span style="color:#C0392B">Blocked</span>';
    } else {
      notifEl.innerHTML = enableBtn;
    }
  }

  // Check if "Become a Host" section should be visible
  if (typeof window._checkBecomeHostVisibility === 'function') {
    window._checkBecomeHostVisibility();
  }
}
window.renderCleanerProfile = renderCleanerProfile;

window._enableCleanerNotifs = async function () {
  const el = document.getElementById('cleaner-profile-notif-status');
  if (el) el.innerHTML = '<span style="color:#999">Enabling…</span>';
  try {
    const cr = window._cleanerData && window._cleanerData.cleanerRecord;
    const cleanerId = cr ? cr.id : null;
    if (typeof globalThis.subscribeToPush === 'function') {
      await globalThis.subscribeToPush('cleaner', cleanerId);
    } else {
      // Fallback: import dynamically
      const { subscribeToPush } = await import('./notifications.js');
      await subscribeToPush('cleaner', cleanerId);
    }
    if (el) el.innerHTML = '<span style="color:#1D9E75">✓ Enabled</span>';
    if (typeof globalThis.showBanner === 'function') {
      globalThis.showBanner('Notifications enabled!', 'success');
    }
  } catch (e) {
    console.warn('[StayOps] Enable notifs failed:', e);
    if (el) el.innerHTML = '<span style="color:#C0392B">Failed — try again</span>';
  }
};

// Check if cleaner already has host role — if not, show "Become a Host" section
window._checkBecomeHostVisibility = async function () {
  const section = document.getElementById('cleaner-become-host-section');
  if (!section || !window._sb) return;
  try {
    const user = window._supabaseUser || (await window._sb.auth.getUser()).data?.user;
    if (!user) return;
    const { data: roles } = await window._sb.from('user_roles').select('role').eq('auth_user_id', user.id);
    const hasHost = roles && roles.some(r => r.role === 'host');
    section.style.display = hasHost ? 'none' : 'block';
  } catch (_) { /* ignore */ }
};

window.becomeHost = async function () {
  const btn = document.getElementById('become-host-btn');
  if (btn) { btn.textContent = 'Setting up…'; btn.disabled = true; }
  try {
    const user = window._supabaseUser || (await window._sb.auth.getUser()).data?.user;
    if (!user || !window._sb) throw new Error('Not signed in');

    // Insert host role
    const { error } = await window._sb.from('user_roles').insert({ auth_user_id: user.id, role: 'host' });
    if (error) throw error;

    if (btn) btn.textContent = 'Host mode enabled!';
    if (typeof globalThis.showBanner === 'function') {
      globalThis.showBanner('Host mode enabled — reload to start setting up your property', 'ok');
    }

    // Hide the section
    const section = document.getElementById('cleaner-become-host-section');
    if (section) section.style.display = 'none';

    // Auto-reload after a short delay so the host boot sequence runs
    setTimeout(() => { window.location.reload(); }, 1500);
  } catch (e) {
    console.warn('[StayOps] becomeHost failed:', e);
    if (btn) { btn.textContent = 'Failed — try again'; btn.disabled = false; }
  }
};

function showCleanerSection(section) {
  ['cleans', 'calendar', 'profile'].forEach((s) => {
    const el = document.getElementById('cleaner-section-' + s);
    if (el) el.style.display = s === section ? '' : 'none';
  });
  document.querySelectorAll('#cleaner-nav .nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.id === 'cnav-' + section);
  });
  const titles = { cleans: 'My Cleans', calendar: 'Calendar', profile: 'Profile' };
  const hdr = document.querySelector('#cleaner-header > div:first-child');
  if (hdr) hdr.textContent = titles[section] || 'My Cleans';

  if (section === 'calendar') renderCleanerCalendar();
  if (section === 'profile') renderCleanerProfile();
}
window.showCleanerSection = showCleanerSection;

function getInviteButtonHtml(cleaner) {
  if (!cleaner.email) {
    return '<span style="font-size:11px;color:#999;font-style:italic">No email - can\'t invite</span>';
  }
  if (cleaner.invitation_status === 'active' || cleaner.auth_user_id) {
    return '<span style="font-size:11px;color:#3B6D11;font-weight:600">✓ Account linked</span>';
  }
  const cloudId = cleaner._cloudId || cleaner.cloud_id;
  if (!cloudId) {
    return '<span style="font-size:11px;color:#999;font-style:italic">Save team to sync cleaner before inviting</span>';
  }
  if (cleaner.invitation_status === 'invited') {
    return '<button id="invite-btn-' + cloudId + '" onclick="inviteCleaner(\'' + (cleaner._cloudId || cleaner.cloud_id) + '\')" style="font-size:12px;padding:6px 12px;background:transparent;color:var(--primary);border:1px solid var(--primary);border-radius:8px;font-weight:600;cursor:pointer">Resend Invite</button>';
  }
  return '<button id="invite-btn-' + cloudId + '" onclick="inviteCleaner(\'' + (cleaner._cloudId || cleaner.cloud_id) + '\')" style="font-size:12px;padding:6px 12px;background:var(--primary);color:white;border:none;border-radius:8px;font-weight:600;cursor:pointer">Invite to App</button>';
}
window.getInviteButtonHtml = getInviteButtonHtml;
