// ── HTML ESCAPE HELPER — use for any user/sheet data injected into innerHTML ──
function escHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── CONFIG ────────────────────────────────────────────────────────────────
const SHEET_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vTlssTFmteUx1q3NkqRz2hAIqtJbt8OlRxl8VcX1x5gW6mI8W52n3xutATDO13qlRNoobKSsmVPciDR/pub?gid=0&single=true&output=csv";
const DEFAULT_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzM0wcdsUqK03faXxk2VqTAEqzno4GCAMzFYGrUXc4y1LKDwd8GbCKhNJruvbXJGhOflw/exec";
const VAPID_PUBLIC_KEY = 'BFOGuTUHozPz0HabwMEzAoaHk_31ftyhqBpxecKWa7BajCsgai-pa8CIimCTGzN4zKet9poURZOeho74KblxPfE';
const PUSH_FUNCTION_URL = '/.netlify/functions/send-push';

// ── PUSH NOTIFICATIONS ────────────────────────────────────────────────────────
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

function getPushSubs() {
  return JSON.parse(localStorage.getItem('gh-push-subs') || '{"cleaners":{}}');
}
function savePushSubsLocal(subs) {
  localStorage.setItem('gh-push-subs', JSON.stringify(subs));
  pushAppData('pushSubs', subs); // immediate, not debounced — subscriptions are critical
}

async function enableNotificationsManually() {
  const btn = document.getElementById('notif-enable-btn');
  const result = document.getElementById('notif-result');
  if (result) result.style.display = 'none';
  if (btn) { btn.disabled = true; btn.textContent = '…'; }

  if (!('Notification' in window)) {
    if (result) { result.style.display = 'block'; result.style.color = 'var(--red)'; result.textContent = '❌ This browser does not support notifications.'; }
    if (btn) { btn.disabled = false; btn.textContent = '🔔 Enable Notifications on This Device'; }
    return;
  }

  const sub = await subscribeToPush('owner');
  if (result) result.style.display = 'block';
  if (sub) {
    if (result) { result.style.color = 'var(--moss)'; result.textContent = '✓ Notifications enabled on this device!'; }
    if (btn) btn.textContent = '✓ Enabled';
    updateNotifStatus();
  } else {
    const perm = Notification.permission;
    if (result) {
      result.style.color = 'var(--red)';
      result.textContent = perm === 'denied'
        ? '❌ Notifications blocked. Go to Settings → Safari → your site → Notifications → Allow.'
        : '❌ Could not enable. Make sure the app is installed to your home screen.';
    }
    if (btn) { btn.disabled = false; btn.textContent = '🔔 Enable Notifications on This Device'; }
  }
}

function updateNotifStatus() {
  const el = document.getElementById('notif-status');
  const menuRow = document.getElementById('notif-status-row-menu');
  if (!el && !menuRow) return;
  if (!('Notification' in window)) {
    if (el) { el.textContent = '⚠️ Notifications not supported on this browser.'; el.style.background = '#FDECEA'; el.style.color = 'var(--red)'; }
    if (menuRow) menuRow.textContent = '⚠️ Not supported';
    return;
  }
  const perm = Notification.permission;
  const sub = getOwnerSub();
  if (perm === 'granted' && sub) {
    if (el) { el.textContent = '✅ Notifications active on this device.'; el.style.background = '#F0FAF4'; el.style.color = 'var(--moss)'; }
    if (menuRow) menuRow.textContent = '✅ Active';
  } else if (perm === 'denied') {
    if (el) { el.textContent = '❌ Notifications blocked — change in device Settings.'; el.style.background = '#FDECEA'; el.style.color = 'var(--red)'; }
    if (menuRow) menuRow.textContent = '❌ Blocked';
  } else {
    if (el) { el.textContent = '⚪ Notifications not yet enabled on this device.'; el.style.background = 'var(--warm)'; el.style.color = 'var(--text-soft)'; }
    if (menuRow) menuRow.textContent = 'Tap to set up';
  }
}

async function subscribeToPush(role, cleanerId) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('Push not supported on this browser');
    return null;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    console.log('SW ready, getting push subscription...');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const permission = await Notification.requestPermission();
      console.log('Notification permission:', permission);
      if (permission !== 'granted') return null;
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });
    }
    const subJson = sub.toJSON();
    console.log('Subscription endpoint:', subJson.endpoint.substring(0, 60) + '...');
    const subs = getPushSubs();
    if (role === 'owner') {
      subs.owner = subJson;
    } else if (role === 'cleaner' && cleanerId) {
      if (!subs.cleaners) subs.cleaners = {};
      subs.cleaners[String(cleanerId)] = subJson;
    }
    savePushSubsLocal(subs);
    console.log('Subscription saved for role:', role, cleanerId || '');
    return subJson;
  } catch(e) {
    console.warn('Push subscribe failed:', e);
    return null;
  }
}

async function sendPushToDevice(subscription, title, body, url, tag) {
  if (!subscription) { console.warn('sendPushToDevice called with no subscription'); return; }
  try {
    console.log('Sending push "' + title + '" to endpoint:', subscription.endpoint.substring(0, 50) + '...');
    const res = await fetch(PUSH_FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription, title, body, url, tag })
    });
    const data = await res.json();
    console.log('Push function response:', data);
    if (data.expired) {
      const subs = getPushSubs();
      if (subs.owner && JSON.stringify(subs.owner) === JSON.stringify(subscription)) delete subs.owner;
      Object.keys(subs.cleaners || {}).forEach(id => {
        if (JSON.stringify(subs.cleaners[id]) === JSON.stringify(subscription)) delete subs.cleaners[id];
      });
      savePushSubsLocal(subs);
    }
  } catch(e) {
    console.warn('Push send failed:', e);
  }
}

function getOwnerSub() { return getPushSubs().owner || null; }
function getCleanerSub(cleanerId) { return (getPushSubs().cleaners || {})[String(cleanerId)] || null; }

async function getFreshOwnerSub() {
  // Always pull latest pushSubs from Sheet — owner sub lives on owner's device
  try {
    const url = localStorage.getItem('gh-script-url') || DEFAULT_SCRIPT_URL;
    if (url && url.includes('script.google.com')) {
      const resp = await fetch(url + '?action=getAppData');
      const json = await resp.json();
      if (json.success && json.data && json.data.pushSubs) {
        const local = getPushSubs();
        const merged = {
          owner: json.data.pushSubs.owner || local.owner,
          cleaners: Object.assign({}, json.data.pushSubs.cleaners, local.cleaners)
        };
        localStorage.setItem('gh-push-subs', JSON.stringify(merged));
        console.log('Refreshed pushSubs, owner sub:', merged.owner ? 'found' : 'NOT FOUND');
        return merged.owner || null;
      }
    }
  } catch(e) { console.warn('Could not refresh pushSubs for owner:', e); }
  return getOwnerSub();
}

// Register service worker on load
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(e => console.warn('SW register failed:', e));
}
function getScriptURL() { return localStorage.getItem('gh-script-url') || DEFAULT_SCRIPT_URL; }

// ── SHEET POST HELPER — all sheet calls use POST to avoid URL length limits ──
function sheetPost(scriptUrl, action, data) {
  // Apps Script redirects cause CORS failures with POST + large bodies.
  // Use GET with params appended to URL — reliable up to ~2KB per call.
  // For batch calls the app splits into small chunks before calling this.
  const dataStr = encodeURIComponent(JSON.stringify(data));
  const url = scriptUrl + '?action=' + encodeURIComponent(action) + '&data=' + dataStr;
  return fetch(url, { method: 'GET' }).then(r => r.json());
}



// ── STATE ────────────────────────────────────────────────────────────────
let bookingFilter = 'upcoming';
let cleanFilter = 'upcoming';
function loadJSON(key, fallback) {
  fallback = fallback !== undefined ? fallback : [];
  try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
  catch(e) { console.warn('loadJSON failed for', key, e); return fallback; }
}

// ── PLATFORM ICON ─────────────────────────────────────────────────────────
function platformIcon(platform, size) {
  size = size || 40;
  const s = String(platform || '').toLowerCase();
  const radius = Math.round(size * 0.25);
  const style = `width:${size}px;height:${size}px;border-radius:${radius}px;display:flex;align-items:center;justify-content:center;font-size:${Math.round(size*0.55)}px;flex-shrink:0`;
  if (s.includes('airbnb'))  return `<div style="${style};background:#FF5A5F">🏠</div>`;
  if (s.includes('vrbo') || s.includes('homeaway')) return `<div style="${style};background:#3D5A99">🏡</div>`;
  if (s.includes('booking')) return `<div style="${style};background:#003580">🔵</div>`;
  if (s.includes('direct') || s.includes('owner')) return `<div style="${style};background:#4A7C59">👤</div>`;
  return `<div style="${style};background:#8B9467">🏠</div>`;
}
let bookings = loadJSON('gh-bookings');
let cleans   = loadJSON('gh-cleans');
let notes    = loadJSON('gh-notes');
let calYear  = new Date().getFullYear();
let calMonth = new Date().getMonth();

const _appDataTimers = {};

function save() {
  localStorage.setItem('gh-bookings', JSON.stringify(bookings));
  localStorage.setItem('gh-cleans',   JSON.stringify(cleans));
  localStorage.setItem('gh-notes',    JSON.stringify(notes));
  scheduleAppDataSave('cleans', cleans);
  scheduleAppDataSave('notes',  notes);
}

// ── GOOGLE SHEET PUSH (per-booking, now that access is Anyone) ───────────
function pushToSheet(action, booking) {
  const url = getScriptURL();
  if (!url) return;
  sheetPost(url, action, booking)
    .then(json => {
      if (json.status === 'ok') {
        showBanner('✓ Synced to Google Sheets', 'ok');
        localStorage.setItem('gh-last-push', new Date().toLocaleString('en-AU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}));
      } else if (json.status === 'not_found' && action === 'update') {
        sheetPost(url, 'add', booking);
        showBanner('✓ Added to Google Sheets', 'ok');
      } else {
        showBanner('⚠ Sheet sync issue: ' + json.status, 'warn');
      }
    })
    .catch(() => {
      showBanner('⚠ Auto-sync failed — use Push button in Settings', 'warn');
    });
}

// ── SYNC FROM SHEET ───────────────────────────────────────────────────────
let _syncInProgress = false;
async function syncFromSheets(manual = false) {
  if (_syncInProgress) return;
  _syncInProgress = true;
  if (manual) showBanner('⟳ Syncing with Google Sheets...', 'info');
  try {
    const res = await fetch(SHEET_URL + '&t=' + Date.now());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const csv = await res.text();
    const lines = csv.trim().split('\n').filter(l => l.trim());
    if (lines.length < 2) throw new Error('Sheet returned no data rows');
    // Temporary debug — store header layout for display
    const headerCols = parseCSVLine(lines[0]);
    window._csvDebug = 'HEADERS:\n' + headerCols.map((h,i) => `[${i}] col ${String.fromCharCode(65+i)}: "${h}"`).join('\n');
    console.log('[CSV Debug]', window._csvDebug);

    // Parse header row to find column indices dynamically
    const headers = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
    const col = {
      checkin:          headers.indexOf('check-in date') >= 0 ? headers.indexOf('check-in date') : 0,
      nights:           1,
      checkout:         headers.indexOf('check-out date') >= 0 ? headers.indexOf('check-out date') : 2,
      name:             3,
      guests:           4,
      hostPayout:       5,
      cleaningFee:      6,
      mgmt:             7,
      mgmtPayout:       8,
      netPayout:        9,
      cleanerConfirmed: 10,
      platform:         headers.findIndex(h => h.includes('platform')),
      confirmCode:      headers.findIndex(h => h.includes('confirmation code') || h === 'confirmation' || (h.includes('confirm') && !h.includes('cleaner'))),
      status:           headers.findIndex(h => h.includes('status')),
    };
    // Fall back to positional defaults if headers not recognised
    if (col.platform < 0)     col.platform = 11;
    if (col.confirmCode < 0)  col.confirmCode = 12;
    if (col.status < 0)       col.status = 13;
    console.log('[CSV] Column map:', col);
    window._csvDebug += '\n\nDETECTED COLUMNS:\n' + Object.entries(col).map(([k,v]) => `${k}: [${v}] = "${headers[v] || 'n/a'}"`).join('\n');

    const imported = [];
    let skipped = 0;
    lines.forEach((line, i) => {
      if (i === 0) return;
      const p = parseCSVLine(line);
      if (!p[0] && !p[3]) return; // skip empty rows
      const name = String(p[col.name] || '').trim();
      const checkin = toISO(String(p[col.checkin] || '').trim());
      if (!name || !checkin) { skipped++; return; }

      const checkout = toISO(String(p[col.checkout] || '').trim());
      const nights = Number(p[col.nights]) || 1;
      const hostPayout = toNum(p[col.hostPayout]);
      const cleaningFee = toNum(p[col.cleaningFee]);
      const mgmtRaw = String(p[col.mgmt] || '').trim();
      let mgmtDecimal = 0;
      if (mgmtRaw.includes('%')) {
        mgmtDecimal = toNum(mgmtRaw) / 100;
      } else {
        const n = toNum(mgmtRaw);
        mgmtDecimal = n > 1 ? n / 100 : n;
      }
      const mgmtFeeRaw = Math.round(mgmtDecimal * 100 * 10) / 10;
      const mgmtFee = Math.round(hostPayout * mgmtDecimal * 100) / 100;
      const mgmtPayout = toNum(p[col.mgmtPayout]);
      const netPayout = toNum(p[col.netPayout]) || Math.round((hostPayout - cleaningFee - mgmtFee) * 100) / 100;
      const cleanerConfirmed = ['yes','true','1','TRUE'].includes(String(p[col.cleanerConfirmed] || '').trim());
      const platform = String(p[col.platform] || '').trim();
      const confirmCode = String(p[col.confirmCode] || '').trim();
      const sheetStatus = String(p[col.status] || '').trim().toLowerCase().replace(/\s+/g, '');
      const isCancelled = sheetStatus.includes('cancel');
      console.log(`[CSV Row ${i}] name="${name}" status_col=[${col.status}] raw="${p[col.status]}" isCancelled:${isCancelled}`);

      // Preserve local data by matching on name+checkin (more reliable than name alone)
      const existingB = bookings.find(b => 
        b.checkin === checkin &&
        b.name && b.name.toLowerCase() === name.toLowerCase()
      );
      const finalMgmtFeeRaw = mgmtFeeRaw || (existingB ? existingB.mgmtFeeRaw : 0);
      imported.push({
        id: existingB ? existingB.id : (Date.now() + i),
        checkin, checkout, nights, name,
        guests: Number(p[col.guests]) || 1,
        hostPayout, cleaningFee, mgmtFee, mgmtFeeRaw: finalMgmtFeeRaw, mgmtPayout, netPayout,
        cleanerConfirmed,
        platform,
        confirmCode,
        status: isCancelled ? 'cancelled' : getStatus(checkin),
        gcalEventId: existingB ? (existingB.gcalEventId || null) : null,
        _fromSheet: true
      });
    });

    // Check for duplicates in sheet data before deduplicating
    const sheetKeyCounts = {};
    imported.forEach(b => {
      const key = (b.name + '|' + b.checkin).toLowerCase();
      sheetKeyCounts[key] = (sheetKeyCounts[key] || 0) + 1;
    });
    const sheetDupes = Object.entries(sheetKeyCounts)
      .filter(([k, count]) => count > 1)
      .map(([k]) => { const [name, checkin] = k.split('|'); return { name, checkin }; });

    if (sheetDupes.length) {
      const dupeList = sheetDupes.map(d => `• ${d.name} (check-in ${d.checkin})`).join('\n');
      const confirmed = await showAppModal({
        title: '⚠️ Duplicate Bookings in Sheet',
        msg: `${sheetDupes.length} duplicate row${sheetDupes.length > 1 ? 's' : ''} found in your Google Sheet:\n\n${dupeList}\n\nContinue? First occurrence kept — please delete duplicates from the sheet afterwards.`,
        confirmText: 'Continue Sync',
        cancelText: 'Cancel',
      });
      if (!confirmed) {
        showBanner('Sync cancelled — fix duplicates in sheet first', 'warn');
        return;
      }
    }

    finishSync(imported, skipped, manual);
  } catch(e) {
    console.error('[Glenhaven] Sync error:', e);
    showBanner('⚠ Sync failed: ' + (e.message || 'network error'), 'warn');
  } finally {
    _syncInProgress = false;
  }
}

// ── BANNER ────────────────────────────────────────────────────────────────
function finishSync(imported, skipped, manual) {
  // Find bookings that existed before sync but are gone or cancelled now
  // so we can delete their calendar events
  const token = getDriveToken();
  const importedKeys = new Set(imported.map(b => (b.name + '|' + b.checkin).toLowerCase()));

  const orphanedCalEvents = bookings
    .filter(b => b.gcalEventId && !importedKeys.has((b.name + '|' + b.checkin).toLowerCase()))
    .map(b => b.gcalEventId);

  // Also delete calendar events for bookings now marked cancelled in the import
  const cancelledCalEvents = imported
    .filter(b => b.gcalEventId && b.status === 'cancelled')
    .map(b => b.gcalEventId);

  const toDeleteFromCal = [...new Set([...orphanedCalEvents, ...cancelledCalEvents])];

  if (token && toDeleteFromCal.length) {
    toDeleteFromCal.forEach(eventId => {
      fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events/' + eventId, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + token }
      }).catch(() => {}); // silent — best effort
    });
    console.log('[Glenhaven] Removed ' + toDeleteFromCal.length + ' orphaned calendar event(s)');
  }

  // Sheet is source of truth — use imported only, no local-only preservation
  // Bookings added in-app are pushed to sheet immediately and return on next sync
  const seen = new Set();
  const merged = imported.filter(b => {
    const key = (b.name + '|' + b.checkin).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  bookings.splice(0, bookings.length, ...merged);
  console.log('[Glenhaven] finishSync — imported:', imported.length, 'merged:', bookings.length);

  // Clear gcalEventId from cancelled bookings so they don't get re-deleted next sync
  bookings.forEach(b => { if (b.status === 'cancelled') b.gcalEventId = null; });

  save();
  const syncTime = new Date().toLocaleString('en-AU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
  localStorage.setItem('gh-last-sync', syncTime);
  renderAll();
  const calMsg = toDeleteFromCal.length ? ` · ${toDeleteFromCal.length} calendar event${toDeleteFromCal.length > 1 ? 's' : ''} removed` : '';
  const cancelledCount = imported.filter(b => b.status === 'cancelled').length;
  showBanner('✓ Synced — ' + bookings.length + ' bookings' + (cancelledCount ? ` · ${cancelledCount} cancelled` : '') + (skipped ? ` (${skipped} skipped)` : '') + calMsg, 'ok');
  if (manual) syncNewBookingsToCalendar();
}

let bannerTimer;
function showBanner(msg, type) {
  const banner = document.getElementById('sync-banner');
  const text = document.getElementById('sync-text');

  // UX decision: only surface banners when something needs attention.
  const problemTypes = new Set(['warn', 'error']);
  if (!problemTypes.has(type)) {
    banner.style.display = 'none';
    return;
  }

  const colors = { warn: '#B9652C', error: '#B24747' };
  banner.style.background = colors[type] || colors.warn;
  banner.style.display = 'flex';
  text.textContent = msg;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { banner.style.display = 'none'; }, 4200);
}

// ── NAV ───────────────────────────────────────────────────────────────────
let currentSection = 'dashboard';
function showSection(name) {
  currentSection = name;
  document.querySelectorAll('[id^="section-"]').forEach(el => el.classList.add('section-hidden'));
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
  const sec = document.getElementById('section-' + name);
  if (sec) sec.classList.remove('section-hidden');
  const nav = document.getElementById('nav-' + name);
  if (nav) nav.classList.add('active');
  // FAB only on dashboard + bookings
  const fab = document.querySelector('.fab');
  if (fab) fab.style.display = (name === 'dashboard' || name === 'bookings') ? 'flex' : 'none';
  // Only render what's needed for this section
  if (name === 'dashboard') { renderDashboard(); return; }
  if (name === 'bookings') {
    document.querySelectorAll('#section-bookings .tab-row .tab').forEach(t => t.classList.remove('active'));
    const activeTab = document.querySelector(`#section-bookings .tab-row .tab[onclick*="${bookingFilter}"]`);
    if (activeTab) activeTab.classList.add('active');
    renderBookings(); return;
  }
  if (name === 'cleaning') { renderCleaning(); populateSelects(); return; }
  if (name === 'revenue') { renderRevenue(); return; }
  if (name === 'management') { renderManagement(); return; }
  if (name === 'notes') { renderNotes(); populateSelects(); return; }
  if (name === 'property') { renderProperty(); return; }
  if (name === 'settings') { renderSettings(); return; }
}

// ── RENDER ────────────────────────────────────────────────────────────────
function render() {
  // Always update the date badge and shared state
  const todayBadge = document.getElementById('todayBadge');
  if (todayBadge) todayBadge.textContent = new Date().toLocaleDateString('en-AU',{day:'numeric',month:'short'});
  // Set FAB visibility based on current section
  const fab = document.querySelector('.fab');
  const section = currentSection || 'dashboard';
  if (fab) fab.style.display = (section === 'dashboard' || section === 'bookings') ? 'flex' : 'none';
  if (section === 'dashboard')    { renderDashboard(); return; }
  if (section === 'bookings')     { renderBookings(); return; }
  if (section === 'cleaning')     { renderCleaning(); populateSelects(); return; }
  if (section === 'revenue')      { renderRevenue(); return; }
  if (section === 'management')   { renderManagement(); return; }
  if (section === 'notes')        { renderNotes(); populateSelects(); return; }
  if (section === 'property')     { renderProperty(); return; }
  if (section === 'settings')     { renderSettings(); return; }
  renderDashboard(); // fallback
}

// Full render — used after major data changes like sheet sync
function renderAll() {
  if (isCleanerMode()) {
    renderCleanerView();
    return;
  }
  const todayBadge = document.getElementById('todayBadge');
  if (todayBadge) todayBadge.textContent = new Date().toLocaleDateString('en-AU',{day:'numeric',month:'short'});
  renderDashboard();
  renderBookings(); // always refresh booking list after sync
  populateSelects();
  populateExpenseCatSelect();
  const expDate = document.getElementById('exp-date');
  if (expDate && !expDate.value) expDate.value = new Date().toISOString().split('T')[0];
  const maintDate = document.getElementById('maint-date');
  if (maintDate && !maintDate.value) maintDate.value = new Date().toISOString().split('T')[0];
  // Also render whatever section is active
  const section = currentSection || 'dashboard';
  if (section === 'cleaning')   { renderCleaning(); populateCleanerSelect(); }
  if (section === 'revenue')    renderRevenue();
  if (section === 'management') renderManagement();
  if (section === 'notes')      renderNotes();
  if (section === 'property')   renderProperty();
  setTimeout(() => { attachButtonPress(); attachLongPress(); }, 50);
}

function renderDashboard() {
  document.getElementById('stat-bookings').textContent = bookings.filter(b => b.status !== 'cancelled').length;
  renderCalendar();
  updateCalStats();

  const now = new Date();
  const upcoming = [...bookings].filter(b => b.status !== 'cancelled' && new Date(b.checkin) >= now).sort((a,b) => new Date(a.checkin)-new Date(b.checkin));
  const nc = document.getElementById('next-checkin-content');
  if (upcoming.length > 0) {
    const b = upcoming[0];
    nc.innerHTML = `<div class="booking-item" style="border:none;padding:0">
      ${platformIcon(b.platform, 42)}
      <div class="booking-info">
        <div class="booking-name">${b.name}</div>
        <div class="booking-dates">${fmt(b.checkin)} → ${fmt(b.checkout)}</div>
        <div class="booking-guests">${b.guests} guests · ${b.nights} night${b.nights!==1?'s':''}</div>
      </div>
      <div class="booking-right"><div class="booking-amount">$${Number(b.hostPayout||0).toLocaleString()}</div></div>
    </div>`;
  } else {
    nc.innerHTML = '<div style="color:var(--text-soft);font-size:13px;">No upcoming bookings</div>';
  }

  const localNow = new Date();
  const todayStr = localNow.getFullYear() + '-' + String(localNow.getMonth()+1).padStart(2,'0') + '-' + String(localNow.getDate()).padStart(2,'0');

  // Next clean: merge cleans array + confirmed bookings, pick soonest
  const fromCleans = cleans
    .filter(c => !c.done && c.date && c.date >= todayStr)
    .map(c => ({ date: c.date, name: c.cleaner, sub: 'After ' + (c.guestName||'') }));
  const fromBookings = bookings
    .filter(b => b.cleanerConfirmed && b.checkout && b.checkout >= todayStr)
    .filter(b => !cleans.some(c => (c.bookingId === b.id || c.guestName === b.name) && !c.done))
    .map(b => {
      const cl = cleans.find(c => c.bookingId === b.id || c.guestName === b.name);
      return { date: cl ? cl.date : b.checkout, name: cl ? cl.cleaner : '—', sub: 'After ' + b.name };
    });
  const allNextCleans = [...fromCleans, ...fromBookings]
    .filter((v,i,a) => a.findIndex(x=>x.sub===v.sub)===i) // dedupe by guest
    .sort((a,b) => a.date.localeCompare(b.date));
  const nextClean = allNextCleans;

  const ncc = document.getElementById('next-clean-content');
  // Alerts: low stock + open maintenance
  const alertsEl = document.getElementById('dashboard-alerts');
  const lowStock = inventory.filter(i => i.stock <= i.threshold);
  const openIssues = maintenance.filter(m => m.status === 'open' || m.status === 'inprogress');
  let alertsHtml = '';
  if (lowStock.length) alertsHtml += `<div class="card" style="border-left:3px solid var(--amber);padding:10px 14px">
    <div style="font-weight:600;font-size:13px;margin-bottom:6px">📦 Low Stock (${lowStock.length})</div>
    ${lowStock.map(i=>`<div style="font-size:12px;color:var(--text-soft);margin-bottom:2px">⚠ ${i.name} — ${i.stock} ${i.unit||''} left</div>`).join('')}
  </div>`;
  if (openIssues.length) alertsHtml += `<div class="card" style="border-left:3px solid var(--red);padding:10px 14px">
    <div style="font-weight:600;font-size:13px;margin-bottom:6px">🔧 Open Issues (${openIssues.length})</div>
    ${openIssues.map(m=>`<div style="font-size:12px;color:var(--text-soft);margin-bottom:2px">${m.status==='inprogress'?'🔄':'🔴'} ${m.description}</div>`).join('')}
  </div>`;
  if (alertsEl) alertsEl.innerHTML = alertsHtml;

  if (nextClean.length > 0) {
    const c = nextClean[0];
    const days = Math.ceil((new Date(c.date) - localNow) / 86400000);
    const urgClass = days<=0?'urgent':days<=1?'urgent':days<=3?'soon':'ok';
    const urgText = days<=0?'Today!':days===1?'Tomorrow':`In ${days} days`;
    ncc.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center">
      <div><div style="font-weight:600;font-size:14px">${c.name}</div>
      <div style="font-size:12px;color:var(--text-soft)">${c.sub} · ${fmt(c.date)}</div></div>
      <div class="clean-urgency ${urgClass}">${urgText}</div>
    </div>`;
  } else {
    ncc.innerHTML = '<div style="color:var(--text-soft);font-size:13px;">No cleans scheduled</div>';
  }
}

function calPrev() { calMonth--; if (calMonth<0){calMonth=11;calYear--;} renderCalendar(); updateCalStats(); }
function calNext() { calMonth++; if (calMonth>11){calMonth=0;calYear++;} renderCalendar(); updateCalStats(); }

function updateCalStats() {
  const daysInMonth = new Date(calYear, calMonth+1, 0).getDate();
  let bookedDays = 0;
  bookings.filter(b => b.status !== 'cancelled').forEach(b => {
    const ci = new Date(b.checkin), co = new Date(b.checkout);
    for (let d = new Date(ci); d < co; d.setDate(d.getDate()+1))
      if (d.getMonth()===calMonth && d.getFullYear()===calYear) bookedDays++;
  });
  const monthRev = bookings.filter(b => {
    const d = new Date(b.checkin);
    return b.status !== 'cancelled' && d.getMonth()===calMonth && d.getFullYear()===calYear;
  }).reduce((s,b) => s+Number(b.hostPayout||0), 0);
  const occ = Math.round((bookedDays/daysInMonth)*100);
  document.getElementById('stat-occupancy').textContent = occ + '%';
  document.getElementById('stat-revenue').textContent = '$' + monthRev.toLocaleString();
  const o2 = document.getElementById('stat-occupancy2');
  if (o2) o2.textContent = occ + '%';
}

function renderCalendar() {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  document.getElementById('cal-title').textContent = months[calMonth] + ' ' + calYear;

  // Tag each day: start = checkin, end = checkout, mid = in between
  const starts = new Set(), ends = new Set(), mids = new Set();
  bookings.filter(b => b.status !== 'cancelled').forEach(b => {
    if (!b.checkin || !b.checkout) return;
    const ci = new Date(b.checkin), co = new Date(b.checkout);
    for (let d = new Date(ci); d <= co; d.setDate(d.getDate() + 1)) {
      if (d.getMonth() !== calMonth || d.getFullYear() !== calYear) continue;
      const day = d.getDate();
      const isStart = d.toDateString() === ci.toDateString();
      const isEnd   = d.toDateString() === co.toDateString();
      if (isStart) starts.add(day);
      if (isEnd)   ends.add(day);
      if (!isStart && !isEnd) mids.add(day);
    }
  });

  const now = new Date();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const firstDay = new Date(calYear, calMonth, 1).getDay();

  let html = ['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => `<div class="cal-day-label">${d}</div>`).join('');
  for (let i = 0; i < firstDay; i++) html += '<div class="cal-day"></div>';

  for (let d = 1; d <= daysInMonth; d++) {
    const isToday   = d === now.getDate() && calMonth === now.getMonth() && calYear === now.getFullYear();
    const isStart   = starts.has(d);
    const isEnd     = ends.has(d);
    const isMid     = mids.has(d);
    const classes   = ['cal-day', isStart?'booked-start':'', isEnd?'booked-end':'', isMid?'booked-mid':'', isToday?'today':''].filter(Boolean).join(' ');
    html += `<div class="${classes}"><span class="cal-num">${d}</span></div>`;
  }
  document.getElementById('cal-grid').innerHTML = html;
}

function renderBookings(filter) {
  if (filter) bookingFilter = filter;
  const list = document.getElementById('bookings-list');
  let filtered;
  if (bookingFilter==='all')       filtered = bookings.filter(b => b.status !== 'cancelled');
  else if (bookingFilter==='upcoming')  filtered = bookings.filter(b => b.status !== 'cancelled' && new Date(b.checkout)>=new Date());
  else if (bookingFilter==='completed') filtered = bookings.filter(b => b.status !== 'cancelled' && new Date(b.checkout)<new Date());
  else if (bookingFilter==='cancelled') filtered = bookings.filter(b => b.status === 'cancelled');
  else filtered = bookings.filter(b => b.status !== 'cancelled' && new Date(b.checkout)>=new Date());
  if (!filtered.length) {
    const hasAny = bookings.length > 0;
    list.innerHTML = `<div class="card" style="text-align:center;padding:32px 16px">
      <div style="font-size:40px;margin-bottom:12px">📋</div>
      <div style="font-weight:600;font-size:15px;margin-bottom:6px">${hasAny ? 'No ' + bookingFilter + ' bookings' : 'No bookings yet'}</div>
      <div style="font-size:13px;color:var(--text-soft)">${hasAny ? 'Try switching tabs above' : 'Tap the + button to add your first booking'}</div>
    </div>`;
    return;
  }
  const sorted = [...filtered].sort((a,b)=>new Date(a.checkin)-new Date(b.checkin));
  list.innerHTML = sorted.map(b => {
    const isCancelled = b.status === 'cancelled';
    const isHosting = !isCancelled && new Date(b.checkin)<=new Date() && new Date(b.checkout)>=new Date();
    const isPast = !isCancelled && new Date(b.checkout)<new Date();
    const statusClass = isCancelled ? 'status-cancelled' : isHosting ? 'status-upcoming' : isPast ? 'status-completed' : 'status-upcoming';
    const statusLabel = isCancelled ? '✕ Cancelled' : isHosting ? '🏡 Hosting' : isPast ? 'Past' : 'Upcoming';
    return `
    <div class="card" onclick="showDetail(${b.id})" style="cursor:pointer${isCancelled?';opacity:0.6':''}" data-booking-id="${b.id}">
      <div class="booking-item" style="border:none;padding:0" data-booking-id="${b.id}">
        ${platformIcon(b.platform, 42)}
        <div class="booking-info">
          <div class="booking-name">${escHtml(b.name)}</div>
          <div class="booking-dates">${escHtml(fmt(b.checkin))} → ${escHtml(fmt(b.checkout))}</div>
          <div class="booking-guests">${escHtml(b.guests)} guests · ${escHtml(b.nights)} night${b.nights!==1?'s':''}</div>
        </div>
        <div class="booking-right">
          <div class="booking-amount" style="${isCancelled?'text-decoration:line-through;color:var(--text-soft)':''}">$${Number(b.hostPayout||0).toLocaleString()}</div>
          <div class="booking-status ${statusClass}">${statusLabel}</div>
          ${!isCancelled ? (b.cleanerConfirmed?'<div style="font-size:10px;color:var(--moss);margin-top:2px">🧹 ✓</div>':'<div style="font-size:10px;color:var(--amber);margin-top:2px">🧹 Pending</div>') : ''}
        </div>
      </div>
    </div>`;
  }).join('');
  animateList('#bookings-list');
  setTimeout(attachLongPress, 60);
}
function filterCleans(f, btn) {
  cleanFilter = f;
  document.querySelectorAll('#section-cleaning .tab-row .tab').forEach(t=>t.classList.remove('active'));
  btn.classList.add('active');
  renderCleaning();
}
function renderCleaning() {
  const list = document.getElementById('cleaning-list');
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  function cleanCard(c, b, extra) {
    const days = Math.ceil((new Date(c.date) - now) / 86400000);
    const urgClass = days <= 0 ? 'urgent' : days <= 2 ? 'soon' : 'ok';
    const urgText = days < 0 ? 'Overdue' : days === 0 ? 'Today!' : days === 1 ? 'Tomorrow' : `In ${days}d`;
    const statusBadge = c.done
      ? '<span style="font-size:11px;font-weight:600;color:var(--moss);background:#EDF7ED;padding:3px 9px;border-radius:20px">✅ Done</span>'
      : c.cleanerDeclined
      ? '<span style="font-size:11px;font-weight:600;color:var(--red);background:#FDECEA;padding:3px 9px;border-radius:20px">❌ Declined</span>'
      : c.cleanerConfirmed
      ? '<span style="font-size:11px;font-weight:600;color:var(--moss);background:#EDF7ED;padding:3px 9px;border-radius:20px">✓ Accepted</span>'
      : '<span style="font-size:11px;font-weight:600;color:var(--amber);background:#FFF5E6;padding:3px 9px;border-radius:20px">⏳ Pending</span>';
    return `<div style="padding:14px 0;border-bottom:1px solid var(--warm)">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:8px">
        <div>
          <div style="font-weight:600;font-size:14px">${escHtml(b ? b.name : (c.guestName || '—'))}</div>
          <div style="font-size:12px;color:var(--text-soft);margin-top:2px">🧹 ${escHtml(c.cleaner || '—')} · ${escHtml(fmt(c.date))}</div>
          ${b ? `<div style="font-size:12px;color:var(--text-soft)">Checkout: ${escHtml(fmt(b.checkout))}</div>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
          <div class="clean-urgency ${urgClass}">${urgText}</div>
          ${statusBadge}
        </div>
      </div>
      ${extra || ''}
    </div>`;
  }

  // ── UPCOMING: all future assigned cleans ──────────────────────────────────
  if (cleanFilter === 'upcoming') {
    const upcoming = cleans
      .filter(c => !c.done && !c.cleanerDeclined && c.date >= todayStr)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!upcoming.length) {
      list.innerHTML = '<div style="text-align:center;padding:28px 16px"><div style="font-size:36px;margin-bottom:10px">🧹</div><div style="font-weight:600;font-size:14px;margin-bottom:4px">No upcoming cleans</div><div style="font-size:12px;color:var(--text-soft)">Assign a cleaner to a booking to get started</div></div>';
      return;
    }
    list.innerHTML = upcoming.map(c => {
      const b = bookings.find(bk => bk.id === c.bookingId || bk.name === c.guestName);
      const extra = `<div style="display:flex;gap:8px">
        <button onclick="openNotifyModal(${c.id})" style="flex:1;background:var(--forest-light);color:var(--sage);border:none;border-radius:8px;padding:9px;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">💬 SMS</button>
        <button onclick="reassignClean(${c.id})" style="flex:1;background:var(--mist);color:var(--text);border:none;border-radius:8px;padding:9px;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">↺ Reassign</button>
      </div>`;
      return cleanCard(c, b, extra);
    }).join('');
    return;
  }

  // ── ACTION: declined + unassigned bookings ────────────────────────────────
  if (cleanFilter === 'action') {
    const declined = cleans.filter(c => c.cleanerDeclined);
    const unassigned = bookings.filter(b => {
      const isFuture = new Date(b.checkout) >= now;
      const hasClean = cleans.some(c => c.bookingId === b.id || c.guestName === b.name);
      return isFuture && !hasClean;
    }).sort((a, b) => new Date(a.checkout) - new Date(b.checkout));

    if (!declined.length && !unassigned.length) {
      list.innerHTML = '<div style="text-align:center;padding:28px 16px"><div style="font-size:36px;margin-bottom:10px">✅</div><div style="font-weight:600;font-size:14px;margin-bottom:4px">All good!</div><div style="font-size:12px;color:var(--text-soft)">No action needed</div></div>';
      return;
    }

    let html = '';
    if (declined.length) {
      html += `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--red);margin-bottom:4px">❌ Declined — needs reassigning</div>`;
      html += declined.sort((a,b) => a.date.localeCompare(b.date)).map(c => {
        const b = bookings.find(bk => bk.id === c.bookingId || bk.name === c.guestName);
        const extra = `<button onclick="reassignClean(${c.id})" style="width:100%;background:var(--forest);color:white;border:none;border-radius:8px;padding:9px;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">↺ Reassign Cleaner</button>`;
        return cleanCard(c, b, extra);
      }).join('');
    }
    if (unassigned.length) {
      html += `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--amber);margin-top:${declined.length?'16px':'0'};margin-bottom:4px">⚠️ No cleaner assigned</div>`;
      html += unassigned.map(b => {
        const days = Math.ceil((new Date(b.checkout) - now) / 86400000);
        const urgClass = days <= 3 ? 'urgent' : days <= 7 ? 'soon' : 'ok';
        return `<div style="padding:14px 0;border-bottom:1px solid var(--warm)">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <div>
              <div style="font-weight:600;font-size:14px">${escHtml(b.name || '')}</div>
              <div style="font-size:12px;color:var(--text-soft);margin-top:2px">Checkout: ${escHtml(fmt(b.checkout))} · ${escHtml(b.guests || 0)} guests</div>
            </div>
            <div class="clean-urgency ${urgClass}">No cleaner</div>
          </div>
        </div>`;
      }).join('');
    }
    list.innerHTML = html;
    return;
  }

  // ── DONE: completed cleans ────────────────────────────────────────────────
  if (cleanFilter === 'done') {
    const done = cleans
      .filter(c => c.done)
      .sort((a, b) => b.date.localeCompare(a.date));
    if (!done.length) {
      list.innerHTML = '<div style="text-align:center;padding:28px 16px"><div style="font-size:36px;margin-bottom:10px">🧹</div><div style="font-weight:600;font-size:14px;margin-bottom:4px">No completed cleans yet</div></div>';
      return;
    }
    list.innerHTML = done.map(c => {
      const b = bookings.find(bk => bk.id === c.bookingId || bk.name === c.guestName);
      return cleanCard(c, b, '');
    }).join('');
    return;
  }
}

function reassignClean(cleanId) {
  const c = cleans.find(cl => cl.id === cleanId);
  if (!c) return;
  // Reset the clean so it can be reassigned from the booking detail
  const b = bookings.find(bk => bk.id === c.bookingId || bk.name === c.guestName);
  if (b) {
    showDetail(b.id);
  } else {
    showBanner('⚠ Booking not found — delete and reassign manually', 'warn');
  }
}

function markCleanerConfirmed(id) {
  const c = cleans.find(c => c.id === id);
  if (c) {
    c.cleanerConfirmed = true;
    save();
    pushAppData('cleans', cleans);
    showBanner('✅ Cleaner confirmed', 'ok');
    cleanFilter = 'upcoming';
    document.querySelectorAll('#section-cleaning .tab-row .tab').forEach((t,i) => t.classList.toggle('active', i===0));
    renderCleaning();
    renderBookings();
  }
}

let revYear = new Date().getFullYear();
let revMonth = new Date().getMonth();
function switchRevTab(tab) {
  document.getElementById('rev-tab-monthly').classList.toggle('active', tab === 'monthly');
  document.getElementById('rev-tab-report').classList.toggle('active', tab === 'report');
  document.getElementById('rev-monthly-view').style.display = tab === 'monthly' ? '' : 'none';
  document.getElementById('rev-report-view').style.display = tab === 'report' ? '' : 'none';
  if (tab === 'report') renderReport();
}

// Financial Year helpers (Jul–Jun)
let reportFY = (() => {
  const now = new Date();
  return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
})();
function fyLabel(fy) { return `FY ${fy}–${String(fy+1).slice(2)}`; }
function fyMonths(fy) {
  // Returns array of {year, month (0-indexed)} for Jul(fy)–Jun(fy+1)
  return [6,7,8,9,10,11,0,1,2,3,4,5].map(m => ({ year: m >= 6 ? fy : fy+1, month: m }));
}
function fyPrev() { reportFY--; renderReport(); }
function fyNext() { reportFY++; renderReport(); }

function renderReport() {
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const months = fyMonths(reportFY);
  const platforms = ['Airbnb','VRBO','Direct'];
  const expCats = getExpenseCats();

  // Helper: bookings in a given month
  function monthBookings(year, month) {
    return bookings.filter(b => b.status !== 'cancelled' && (function(){ const d = new Date(b.checkin); return d.getFullYear()===year && d.getMonth()===month; })());
  }
  // Helper: expenses in FY — use live array, not stale localStorage read
  function fyExpenses() {
    return expenses.filter(e => {
      const d = new Date(e.date);
      const m = d.getMonth(); const y = d.getFullYear();
      return (y === reportFY && m >= 6) || (y === reportFY+1 && m <= 5);
    });
  }

  // Build monthly data
  const mdata = months.map(({year, month}) => {
    const bs = monthBookings(year, month);
    const availNights = new Date(year, month+1, 0).getDate();
    const bookedNights = bs.reduce((s,b) => s + Number(b.nights||0), 0);
    const revenue = bs.reduce((s,b) => s + Number(b.hostPayout||0), 0);
    const netPayout = bs.reduce((s,b) => s + Number(b.netPayout||0), 0);
    const platformRev = {};
    platforms.forEach(p => { platformRev[p] = bs.filter(b=>b.platform===p).reduce((s,b)=>s+Number(b.hostPayout||0),0); });
    return { label: mo[month], year, month, bs, availNights, bookedNights, revenue, netPayout, platformRev, bookingCount: bs.length };
  });

  // FY totals
  const fyTotalRev = mdata.reduce((s,m)=>s+m.revenue,0);
  const fyTotalNet = mdata.reduce((s,m)=>s+m.netPayout,0);
  const fyTotalNights = mdata.reduce((s,m)=>s+m.bookedNights,0);
  const fyTotalAvail = mdata.reduce((s,m)=>s+m.availNights,0);
  const fyOccupancy = fyTotalAvail ? (fyTotalNights/fyTotalAvail*100) : 0;
  const fyADR = fyTotalNights ? fyTotalRev/fyTotalNights : 0;
  const fyRevPAR = fyTotalAvail ? fyTotalRev/fyTotalAvail : 0;
  const fyBookings = mdata.reduce((s,m)=>s+m.bookingCount,0);
  const fyALOS = fyBookings ? fyTotalNights/fyBookings : 0;

  // Expense data
  const allExp = fyExpenses();
  const expByCategory = {};
  expCats.forEach(c => { expByCategory[c] = allExp.filter(e=>e.category===c).reduce((s,e)=>s+Number(e.amount||0),0); });
  const fyTotalExp = allExp.reduce((s,e)=>s+Number(e.amount||0),0);
  const fyNetIncome = fyTotalNet - fyTotalExp;

  const fmt2 = n => '$' + Number(n).toLocaleString('en-AU', {minimumFractionDigits:0, maximumFractionDigits:0});
  const fmtPct = n => n ? (n*100).toFixed(0)+'%' : '—';
  const fmtDec = n => n ? '$'+n.toFixed(0) : '—';

  const html = `
  <div id="print-report">
    <!-- FY Navigator -->
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <button onclick="fyPrev()" style="background:var(--warm);border:none;border-radius:8px;width:32px;height:32px;font-size:16px;cursor:pointer">‹</button>
        <div style="font-family:'DM Serif Display',serif;font-size:18px;color:var(--forest)">${fyLabel(reportFY)}</div>
        <button onclick="fyNext()" style="background:var(--warm);border:none;border-radius:8px;width:32px;height:32px;font-size:16px;cursor:pointer">›</button>
      </div>
      <div style="margin-top:12px" class="report-kpi-grid">
        <div class="report-kpi"><div class="report-kpi-val">${fmt2(fyTotalRev)}</div><div class="report-kpi-label">Total Revenue</div></div>
        <div class="report-kpi"><div class="report-kpi-val">${fmt2(fyTotalNet)}</div><div class="report-kpi-label">Net Payout</div></div>
        <div class="report-kpi" style="background:${fyNetIncome>=0?'#EDF7ED':'#FEF2F2'}"><div class="report-kpi-val" style="color:${fyNetIncome>=0?'var(--forest)':'var(--red)'}">${fmt2(Math.abs(fyNetIncome))}</div><div class="report-kpi-label">Net Income ${fyNetIncome<0?'(Loss)':''}</div></div>
        <div class="report-kpi"><div class="report-kpi-val">${fyOccupancy.toFixed(0)}%</div><div class="report-kpi-label">Occupancy</div></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px">
        <button onclick="exportReportPDF()" class="no-print" style="background:var(--forest);color:white;border:none;border-radius:var(--radius-sm);padding:12px;font-size:14px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">⬇ Export PDF</button>
        <button onclick="exportReportCSV()" class="no-print" style="background:var(--mist);color:var(--forest);border:1.5px solid var(--forest);border-radius:var(--radius-sm);padding:12px;font-size:14px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">⬇ Export CSV</button>
      </div>
    </div>

    <!-- Revenue by Month & Platform -->
    <div class="card" style="margin-bottom:12px;overflow-x:auto">
      <div class="report-section-title">Revenue by Month & Platform</div>
      <table class="report-table">
        <thead><tr>
          <th>Month</th><th>Airbnb</th><th>VRBO</th><th>Direct</th><th>Total</th>
        </tr></thead>
        <tbody>
          ${mdata.map(m => `<tr>
            <td>${m.label}</td>
            <td>${m.platformRev['Airbnb'] ? fmt2(m.platformRev['Airbnb']) : '—'}</td>
            <td>${m.platformRev['VRBO'] ? fmt2(m.platformRev['VRBO']) : '—'}</td>
            <td>${m.platformRev['Direct'] ? fmt2(m.platformRev['Direct']) : '—'}</td>
            <td>${m.revenue ? fmt2(m.revenue) : '—'}</td>
          </tr>`).join('')}
          <tr><td>Total</td>
            <td>${fmt2(mdata.reduce((s,m)=>s+m.platformRev['Airbnb'],0))}</td>
            <td>${fmt2(mdata.reduce((s,m)=>s+m.platformRev['VRBO'],0))}</td>
            <td>${fmt2(mdata.reduce((s,m)=>s+m.platformRev['Direct'],0))}</td>
            <td>${fmt2(fyTotalRev)}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Occupancy & ADR -->
    <div class="card" style="margin-bottom:12px;overflow-x:auto">
      <div class="report-section-title">Occupancy & Performance</div>
      <table class="report-table">
        <thead><tr>
          <th>Month</th><th>Avail</th><th>Booked</th><th>Occ%</th>
          <th>ADR <span class="no-print" title="Average Daily Rate — revenue per booked night" style="cursor:help;font-size:10px;opacity:0.7">ⓘ</span></th>
          <th>RevPAR <span class="no-print" title="Revenue Per Available Night — revenue divided by all available nights, including empty ones" style="cursor:help;font-size:10px;opacity:0.7">ⓘ</span></th>
        </tr></thead>
        <tbody>
          ${mdata.map(m => `<tr>
            <td>${m.label}</td>
            <td>${m.availNights}</td>
            <td>${m.bookedNights}</td>
            <td>${m.availNights ? (m.bookedNights/m.availNights*100).toFixed(0)+'%' : '—'}</td>
            <td>${m.bookedNights ? fmtDec(m.revenue/m.bookedNights) : '—'}</td>
            <td>${m.availNights ? fmtDec(m.revenue/m.availNights) : '—'}</td>
          </tr>`).join('')}
          <tr><td>FY Total</td>
            <td>${fyTotalAvail}</td>
            <td>${fyTotalNights}</td>
            <td>${fyOccupancy.toFixed(0)}%</td>
            <td>${fmtDec(fyADR)}</td>
            <td>${fmtDec(fyRevPAR)}</td>
          </tr>
        </tbody>
      </table>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px">
        <div style="font-size:11px;color:var(--text-soft);background:var(--warm);padding:8px 10px;border-radius:var(--radius-sm)"><b>ALOS</b> ${fyALOS.toFixed(1)} nights avg</div>
        <div style="font-size:11px;color:var(--text-soft);background:var(--warm);padding:8px 10px;border-radius:var(--radius-sm)"><b>Bookings</b> ${fyBookings} total</div>
      </div>
      <div style="margin-top:10px;font-size:11px;color:var(--text-soft);line-height:1.6;border-top:1px solid var(--warm);padding-top:8px">
        <b>ADR</b> Average Daily Rate — revenue ÷ booked nights &nbsp;·&nbsp; <b>RevPAR</b> Revenue Per Available Night — revenue ÷ all available nights &nbsp;·&nbsp; <b>ALOS</b> Average Length of Stay
      </div>
    </div>

    <!-- Expense Breakdown -->
    <div class="card" style="margin-bottom:12px">
      <div class="report-section-title">Expenses by Category</div>
      ${allExp.length === 0 ? '<div style="color:var(--text-soft);font-size:13px">No expenses recorded for this financial year.</div>' : `
      <table class="report-table">
        <thead><tr><th>Category</th><th>Amount</th><th>%</th></tr></thead>
        <tbody>
          ${expCats.filter(c=>expByCategory[c]>0).sort((a,b)=>expByCategory[b]-expByCategory[a]).map(c=>`
            <tr><td>${c}</td><td>${fmt2(expByCategory[c])}</td><td>${fyTotalExp?(expByCategory[c]/fyTotalExp*100).toFixed(0)+'%':'—'}</td></tr>
          `).join('')}
          <tr><td>Total Expenses</td><td>${fmt2(fyTotalExp)}</td><td>100%</td></tr>
        </tbody>
      </table>`}
    </div>

    <!-- Net Income Summary -->
    <div class="card">
      <div class="report-section-title">Net Income Summary</div>
      <table class="report-table">
        <tbody>
          <tr><td>Total Revenue (Host Payout)</td><td>${fmt2(fyTotalRev)}</td></tr>
          <tr><td>Net Payout (after fees)</td><td>${fmt2(fyTotalNet)}</td></tr>
          <tr><td>Total Expenses</td><td style="color:var(--red)">− ${fmt2(fyTotalExp)}</td></tr>
          <tr class="highlight-row"><td>Net Income</td><td style="color:${fyNetIncome>=0?'var(--forest)':'var(--red)'}">${fyNetIncome<0?'−':''} ${fmt2(Math.abs(fyNetIncome))}</td></tr>
        </tbody>
      </table>
    </div>
  </div>`;

  document.getElementById('report-content').innerHTML = html;
}

function revPrev() { revMonth--; if(revMonth<0){revMonth=11;revYear--;} renderRevenue(); }
function revNext() { revMonth++; if(revMonth>11){revMonth=0;revYear++;} renderRevenue(); }

function renderRevenue() {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  document.getElementById('rev-month-title').textContent = months[revMonth] + ' ' + revYear;
  const monthBookings = bookings.filter(b => {
    const d = new Date(b.checkin);
    return b.status !== 'cancelled' && d.getMonth()===revMonth && d.getFullYear()===revYear;
  });
  const totalHost = monthBookings.reduce((s,b)=>s+Number(b.hostPayout||0),0);
  const totalCleaning = monthBookings.reduce((s,b)=>s+Number(b.cleaningFee||0),0);
  const totalMgmt = monthBookings.reduce((s,b)=>s+Number(b.mgmtFee||0),0);
  // Net = (hostPayout - cleaningFee) * mgmtFee% — but mgmtFee is already the dollar amount
  const totalNet = monthBookings.reduce((s,b)=>s+Number(b.netPayout||0),0);
  document.getElementById('total-revenue').textContent = '$' + totalHost.toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2});
  document.getElementById('total-net').textContent = '$' + totalNet.toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2});
  document.getElementById('revenue-sub').textContent = monthBookings.length + ' booking' + (monthBookings.length!==1?'s':'');
  document.getElementById('finance-summary-content').innerHTML = `
    <div class="finance-summary">
      <div class="finance-row"><span class="finance-label">Host Payout</span><span class="finance-val">$${totalHost.toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}</span></div>
      <div class="finance-row"><span class="finance-label">Cleaning Fees</span><span class="finance-val">- $${totalCleaning.toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}</span></div>
      <div class="finance-row"><span class="finance-label">Management Fees</span><span class="finance-val">- $${totalMgmt.toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}</span></div>
      <div class="finance-row finance-total"><span class="finance-label">Net Payout</span><span class="finance-val">$${totalNet.toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}</span></div>
    </div>`;
  document.getElementById('revenue-breakdown').innerHTML = monthBookings.length ? [...monthBookings].sort((a,b)=>new Date(a.checkin)-new Date(b.checkin)).map(b=>`
    <div class="revenue-row">
      <div class="rl"><div style="font-weight:500;font-size:13px">${b.name}</div><div style="font-size:11px;color:var(--text-soft)">${fmt(b.checkin)} · ${b.nights}n</div></div>
      <div style="text-align:right"><div class="rr">$${Number(b.hostPayout||0).toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}</div><div style="font-size:11px;color:var(--moss)">Net: $${Number(b.netPayout||0).toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}</div></div>
    </div>`).join('') : '<div style="color:var(--text-soft);font-size:13px;">No bookings this month.</div>';
}

let mgmtYear = new Date().getFullYear();
let mgmtMonth = new Date().getMonth();
function mgmtPrev() { mgmtMonth--; if(mgmtMonth<0){mgmtMonth=11;mgmtYear--;} mgmtSelected.clear(); renderManagement(); }
function mgmtNext() { mgmtMonth++; if(mgmtMonth>11){mgmtMonth=0;mgmtYear++;} mgmtSelected.clear(); renderManagement(); }

function renderManagement() {
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  document.getElementById('mgmt-month-title').textContent = monthNames[mgmtMonth] + ' ' + mgmtYear;
  const monthBookings = bookings.filter(b => {
    const d = new Date(b.checkin);
    return b.status !== 'cancelled' && d.getMonth()===mgmtMonth && d.getFullYear()===mgmtYear;
  });
  const totalMgmtPayout = monthBookings.reduce((s,b)=>s+Number(b.mgmtPayout||0),0);
  document.getElementById('total-mgmt').textContent = '$' + totalMgmtPayout.toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2});
  document.getElementById('mgmt-sub').textContent = monthBookings.length + ' booking' + (monthBookings.length!==1?'s':'');
  document.getElementById('mgmt-breakdown').innerHTML = monthBookings.length ? [...monthBookings].sort((a,b)=>new Date(a.checkin)-new Date(b.checkin)).map(b=>{
    const mgmtPct = b.mgmtFeeRaw || (b.mgmtFee && b.hostPayout ? Math.round((b.mgmtFee/b.hostPayout)*1000)/10 : 0);
    return `<div class="revenue-row mgmt-sel-row" id="mgmt-row-${b.id}" onclick="toggleMgmtSelect(${b.id})" style="align-items:flex-start;cursor:pointer;border-radius:8px;padding:10px 4px;margin:-2px 0;transition:background 0.15s">
      <div style="display:flex;align-items:center;gap:12px;flex:1">
        <div id="mgmt-cb-${b.id}" style="width:24px;height:24px;border-radius:6px;border:2px solid var(--stone);background:white;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:14px;transition:all 0.15s"></div>
        <div class="rl">
          <div style="font-weight:500;font-size:13px">${b.name}</div>
          <div style="font-size:11px;color:var(--text-soft)">${fmt(b.checkin)} · ${b.nights}n</div>
          <div style="font-size:11px;color:var(--text-soft)">Host: $${Number(b.hostPayout||0).toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})} · Fee: ${mgmtPct}%</div>
        </div>
      </div>
      <div style="text-align:right">
        <div class="rr">$${Number(b.mgmtPayout||0).toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
      </div>
    </div>`;
  }).join('') : '<div style="color:var(--text-soft);font-size:13px;">No bookings this month.</div>';
}

let mgmtSelected = new Set();
function toggleMgmtSelect(id) {
  if (mgmtSelected.has(id)) {
    mgmtSelected.delete(id);
  } else {
    mgmtSelected.add(id);
  }
  const cb = document.getElementById('mgmt-cb-' + id);
  const row = document.getElementById('mgmt-row-' + id);
  if (cb) {
    cb.style.background = mgmtSelected.has(id) ? 'var(--forest)' : 'white';
    cb.style.borderColor = mgmtSelected.has(id) ? 'var(--forest)' : 'var(--stone)';
    cb.textContent = mgmtSelected.has(id) ? '✓' : '';
    cb.style.color = 'white';
  }
  if (row) row.style.background = mgmtSelected.has(id) ? 'rgba(30,58,47,0.06)' : '';
}

function generateInvoice() {
  const selected = bookings.filter(b => mgmtSelected.has(b.id));
  if (!selected.length) { showBanner('⚠ Tap bookings above to select them first', 'warn'); return; }

  // Pick client
  const clients = loadClients();
  if (clients.length) {
    // Show inline client picker
    pendingInvoiceBookings = selected;
    const picker = document.getElementById('invoice-client-picker');
    const sel = document.getElementById('invoice-client-select');
    sel.innerHTML = '<option value="">— No client (skip) —</option>' +
      clients.map((c,i) => `<option value="${i}">${c.name}</option>`).join('');
    picker.classList.add('open'); document.body.style.overflow='hidden';
  } else {
    buildInvoicePDF(selected, null);
  }
}

let pendingInvoiceBookings = [];
function confirmInvoiceClient() {
  const sel = document.getElementById('invoice-client-select');
  const clients = loadClients();
  const idx = parseInt(sel.value);
  const client = (!isNaN(idx) && clients[idx]) ? clients[idx] : null;
  document.getElementById('invoice-client-picker').classList.remove('open'); _checkModalsClosed();
  buildInvoicePDF(pendingInvoiceBookings, client);
  pendingInvoiceBookings = [];
}
function buildInvoicePDF(selected, client) {
  const inv = {
    name: localStorage.getItem('gh-inv-name') || '',
    company: localStorage.getItem('gh-inv-company') || '',
    abn: localStorage.getItem('gh-inv-abn') || '',
    acn: localStorage.getItem('gh-inv-acn') || '',
    email: localStorage.getItem('gh-inv-email') || '',
    address: localStorage.getItem('gh-inv-address') || ''
  };
  const bank = {
    name: localStorage.getItem('gh-bank-name') || '',
    bsb: localStorage.getItem('gh-bank-bsb') || '',
    acc: localStorage.getItem('gh-bank-acc') || '',
    bank: localStorage.getItem('gh-bank-bank') || ''
  };
  const invNum = 'INV-' + Date.now().toString().slice(-6);
  const today = new Date().toLocaleDateString('en-AU',{day:'numeric',month:'long',year:'numeric'});
  const totalMgmt = selected.reduce((s,b)=>s+Number(b.mgmtPayout||0),0);
  const rows = selected.map(b => {
    const mgmtPct = b.mgmtFeeRaw || (b.mgmtFee && b.hostPayout ? Math.round((b.mgmtFee/b.hostPayout)*1000)/10 : 0);
    return `<tr>
      <td style="padding:10px 8px;border-bottom:1px solid #eee">${b.name}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #eee">${fmt(b.checkin)} — ${fmt(b.checkout)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #eee;text-align:right">$${Number(b.hostPayout||0).toFixed(2)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #eee;text-align:right">$${Number(b.cleaningFee||0).toFixed(2)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #eee;text-align:center">${mgmtPct}%</td>
      <td style="padding:10px 8px;border-bottom:1px solid #eee;text-align:right;font-weight:600">$${Number(b.mgmtPayout||0).toFixed(2)}</td>
    </tr>`;
  }).join('');

  const toBlock = client ? `
    <div style="margin-bottom:28px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#999;margin-bottom:6px">Bill To</div>
      <div style="font-weight:700;font-size:15px">${client.name}</div>
      ${client.contact?`<div style="color:#666;font-size:13px">${client.contact}</div>`:''}
      ${client.email?`<div style="color:#666;font-size:13px">${client.email}</div>`:''}
      ${client.address?`<div style="color:#666;font-size:13px">${client.address}</div>`:''}
    </div>` : '';

  const bankBlock = (bank.bsb && bank.acc) ? `
    <div style="background:#F8F8F8;border-radius:8px;padding:14px 16px;margin-top:28px;font-size:13px">
      <div style="font-weight:700;margin-bottom:8px">Payment Details</div>
      ${bank.name?`<div><span style="color:#666">Account Name:</span> ${bank.name}</div>`:''}
      <div><span style="color:#666">BSB:</span> ${bank.bsb} &nbsp;|&nbsp; <span style="color:#666">Account:</span> ${bank.acc}</div>
      ${bank.bank?`<div style="color:#666;margin-top:2px">${bank.bank}</div>`:''}
    </div>` : '';

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <style>
    body{font-family:'Helvetica Neue',sans-serif;color:#1a1a1a;max-width:700px;margin:40px auto;padding:0 20px}
    h1{font-size:28px;color:#1E3A2F;margin:0;font-weight:800}
    .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px;padding-bottom:20px;border-bottom:2px solid #1E3A2F}
    .inv-meta{text-align:right;font-size:13px;color:#666}
    .inv-meta strong{display:block;font-size:22px;color:#1E3A2F;margin-bottom:4px}
    table{width:100%;border-collapse:collapse;margin-top:20px;font-size:13px}
    th{background:#1E3A2F;color:white;padding:10px 8px;text-align:left;font-weight:600}
    th:last-child,th:nth-child(3),th:nth-child(4),th:nth-child(6){text-align:right}
    th:nth-child(5){text-align:center}
    .total-row td{padding:12px 8px;font-weight:700;font-size:15px;border-top:2px solid #1E3A2F}
    .footer{margin-top:40px;font-size:11px;color:#999;text-align:center;border-top:1px solid #eee;padding-top:16px}
    .property-badge{background:#F0EDE8;border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:13px}
  </style></head><body>
  <div class="header">
    <div>
      <h1>${inv.company || inv.name || 'Glenhaven'}</h1>
      ${inv.name && inv.company ? `<div style="color:#666;margin-top:3px;font-size:13px">${inv.name}</div>` : ''}
      ${inv.abn ? `<div style="color:#666;font-size:12px">ABN: ${inv.abn}</div>` : ''}
      ${inv.acn ? `<div style="color:#666;font-size:12px">ACN: ${inv.acn}</div>` : ''}
      ${inv.email ? `<div style="color:#666;font-size:12px">${inv.email}</div>` : ''}
      ${inv.address ? `<div style="color:#666;font-size:12px">${inv.address}</div>` : ''}
    </div>
    <div class="inv-meta">
      <strong>${invNum}</strong>
      <div>Date: ${today}</div>
    </div>
  </div>
  ${toBlock}
  <div class="property-badge">
    🏡 <strong>Glenhaven</strong> · Katoomba, NSW · Blue Mountains<br>
    <span style="color:#666">Management Fee Invoice</span>
  </div>
  <table>
    <thead><tr>
      <th>Guest</th><th>Dates</th><th style="text-align:right">Host Payout</th>
      <th style="text-align:right">Cleaning Fee</th><th style="text-align:center">Mgmt %</th>
      <th style="text-align:right">Management Payout</th>
    </tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr class="total-row">
      <td colspan="5" style="text-align:right;color:#1E3A2F">Total Management Payout</td>
      <td style="text-align:right;color:#C17F3E;font-size:18px">$${totalMgmt.toFixed(2)}</td>
    </tr></tfoot>
  </table>
  ${bankBlock}
  <div class="footer">Glenhaven Property Management · Katoomba NSW · Generated ${today}</div>
  <div style="text-align:center;margin-top:32px;display:flex;gap:12px;justify-content:center">
    <button onclick="window.print()" style="background:#1E3A2F;color:white;border:none;border-radius:8px;padding:12px 24px;font-size:14px;font-weight:600;cursor:pointer">🖨 Save as PDF</button>
    <button onclick="window.close()" style="background:#F0EDE8;color:#1A1A1A;border:none;border-radius:8px;padding:12px 24px;font-size:14px;font-weight:600;cursor:pointer">← Back to App</button>
  </div>
</body></html>`;
  const w = window.open('','_blank');
  w.document.write(html);
  w.document.close();
}

function renderNotes() {
  const list = document.getElementById('notes-list');
  if (!notes.length) { list.innerHTML='<div class="card" style="text-align:center;padding:28px 16px"><div style="font-size:36px;margin-bottom:10px">📝</div><div style="font-weight:600;font-size:14px;margin-bottom:4px">No notes yet</div><div style="font-size:12px;color:var(--text-soft)">Add notes about guests, special requests or anything useful</div></div>'; return; }
  list.innerHTML = [...notes].sort((a,b)=>new Date(b.date)-new Date(a.date)).map(n=>`
    <div class="note-item">
      <div class="note-guest"><span class="note-tag tag-${n.tag}">${n.tag}</span>${n.guestName}</div>
      <div class="note-text">${n.text}</div>
      <div class="note-date">${fmt(n.date)}</div>
    </div>`).join('');
}

function openSettingsCat(cat) {
  document.getElementById('settings-menu').style.display = 'none';
  document.querySelectorAll('[id^="settings-cat-"]').forEach(el => el.style.display = 'none');
  document.querySelectorAll('[id^="settings-panel-"]').forEach(el => el.style.display = 'none');
  const el = document.getElementById('settings-cat-' + cat);
  if (el) el.style.display = 'block';
  if (cat === 'property') {
    // update notification status row
    setTimeout(updateNotifStatus, 100);
    const sr = document.getElementById('notif-status-row-menu');
    if (sr) { const p = Notification.permission; sr.textContent = p === 'granted' ? '✅ Enabled' : p === 'denied' ? '❌ Blocked' : 'Tap to set up'; }
  }
  if (cat === 'google') {
    const token = localStorage.getItem('gh-drive-token');
    const statusRow = document.getElementById('gdrive-status-row');
    if (statusRow) statusRow.textContent = token ? '✓ Connected' : 'Tap to connect';
  }
  if (cat === 'cleaner') { openCleanerSettings(); }
}

function openSettingsPanel(panelId) {
  // track which cat we came from
  const activeCat = document.querySelector('[id^="settings-cat-"]:not([style*="display: none"]):not([style*="display:none"])');
  const prevCat = activeCat ? activeCat.id.replace('settings-cat-', '') : null;
  document.getElementById('settings-menu').style.display = 'none';
  document.querySelectorAll('[id^="settings-cat-"]').forEach(el => el.style.display = 'none');
  document.querySelectorAll('[id^="settings-panel-"]').forEach(el => el.style.display = 'none');
  const panel = document.getElementById('settings-panel-' + panelId);
  if (!panel) return;
  panel.style.display = 'block';
  if (prevCat) panel.dataset.prevCat = prevCat;
  else delete panel.dataset.prevCat;

  // populate panel data on open
  if (panelId === 'sms-template') {
    const defaultTemplate = `Hi {cleanerFirstName}\n\nNew Booking - please see below\n\nCheck in: {checkin}\nCheck out: {checkout}\nName: {guestFirstName}\nNumber of guests: {guests}\n\nPlease let me know if you are available`;
    const el = document.getElementById('settings-sms-template');
    if (el) el.value = localStorage.getItem('gh-sms-template') || defaultTemplate;
  }
  if (panelId === 'team') {
    renderTeamList();
  }
  if (panelId === 'notifications') {
    setTimeout(updateNotifStatus, 100);
  }
  if (panelId === 'expense-cats') {
    renderExpenseCatSettings();
  }
  if (panelId === 'invoice-details') {
    ['name','company','abn','acn','email','address'].forEach(k => {
      const el = document.getElementById('inv-'+k);
      if (el) el.value = localStorage.getItem('gh-inv-'+k) || '';
    });
  }
  if (panelId === 'bank-details') {
    ['name','bsb','acc','bank'].forEach(k => {
      const el = document.getElementById('inv-bank-'+k);
      if (el) el.value = localStorage.getItem('gh-inv-bank-'+k) || '';
    });
  }
  if (panelId === 'invoice-clients') {
    renderClientsList();
  }
  if (panelId === 'sheets') {
    const el = document.getElementById('settings-script-url');
    if (el) el.value = localStorage.getItem('gh-script-url') || DEFAULT_SCRIPT_URL;
  }
  if (panelId === 'apps-script') {
    const el = document.getElementById('settings-script-url');
    if (el) el.value = localStorage.getItem('gh-script-url') || DEFAULT_SCRIPT_URL;
  }
  if (panelId === 'drive') {
    const el = document.getElementById('gdrive-client-id');
    if (el) el.value = localStorage.getItem('gh-gdrive-client-id') || '';
    const statusEl = document.getElementById('gdrive-status');
    if (statusEl) verifyDriveToken();
  }
  if (panelId === 'backup') {
    const el = document.getElementById('backup-last-time');
    if (el) el.textContent = localStorage.getItem('gh-last-backup') || 'Never';
  }
  if (panelId === 'ai-import') {
    const el = document.getElementById('settings-api-key');
    if (el) el.value = localStorage.getItem('gh-api-key') || '';
  }
  if (panelId === 'smart-pricing') {
    const saved = localStorage.getItem('gh-base-rate');
    if (saved) { const el = document.getElementById('pricing-base-rate'); if (el) el.value = saved; }
  }
  if (panelId === 'ai-ignore') {
    renderAIIgnoreList();
  }
  if (panelId === 'app-data') {
    renderStorageViewer();
  }
  if (panelId === 'feel') {
    loadFxSettings();
  }
}

function closeSettingsPanel() {
  const panel = document.querySelector('[id^="settings-panel-"]:not([style*="display: none"]):not([style*="display:none"])');
  const returnCat = panel?.dataset.prevCat;
  document.querySelectorAll('[id^="settings-panel-"]').forEach(el => el.style.display = 'none');
  if (returnCat) openSettingsCat(returnCat);
  else closeSettingsCat(); // goes back to main menu
}

function closeSettingsCat() {
  document.querySelectorAll('[id^="settings-cat-"]').forEach(el => el.style.display = 'none');
  document.querySelectorAll('[id^="settings-panel-"]').forEach(el => el.style.display = 'none');
  document.getElementById('settings-menu').style.display = 'block';
}

// ── EXPENSE CATEGORY MANAGEMENT ───────────────────────────────────────────
function renderExpenseCatSettings() {
  const cats = getExpenseCats();
  const el = document.getElementById('expense-cats-list');
  el.innerHTML = cats.map((c, i) => `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <input type="text" value="${c}" id="expcat-${i}" style="flex:1;font-size:13px" onchange="updateExpenseCat(${i},this.value)">
      <button onclick="deleteExpenseCat(${i})" style="background:none;border:none;color:var(--red);font-size:16px;cursor:pointer;padding:4px">✕</button>
    </div>`).join('');
}

function updateExpenseCat(index, newName) {
  const cats = getExpenseCats();
  if (newName.trim()) { cats[index] = newName.trim(); localStorage.setItem('gh-expense-cats', JSON.stringify(cats)); populateExpenseCatSelect(); }
}

function addExpenseCat() {
  const val = document.getElementById('new-expense-cat').value.trim();
  if (!val) return;
  const cats = getExpenseCats();
  cats.push(val);
  localStorage.setItem('gh-expense-cats', JSON.stringify(cats));
  document.getElementById('new-expense-cat').value = '';
  renderExpenseCatSettings();
  populateExpenseCatSelect();
  showBanner('✓ Category added', 'ok');
}

async function deleteExpenseCat(index) {
  const cats = getExpenseCats();
  const _okCat = await showAppModal({ title: 'Delete Category', msg: 'Delete category "' + cats[index] + '"?', confirmText: 'Delete', confirmColor: 'var(--red)' });
  if (!_okCat) return;
  cats.splice(index, 1);
  localStorage.setItem('gh-expense-cats', JSON.stringify(cats));
  renderExpenseCatSettings();
  populateExpenseCatSelect();
}

async function resetExpenseCats() {
  const _okReset = await showAppModal({ title: 'Reset Categories', msg: "Reset to default categories? This won't affect existing expenses.", confirmText: 'Reset' });
  if (!_okReset) return;
  localStorage.removeItem('gh-expense-cats');
  renderExpenseCatSettings();
  populateExpenseCatSelect();
  showBanner('✓ Categories reset', 'ok');
}

// ── SMART PRICING ─────────────────────────────────────────────────────────
async function getSmartPricing() {
  const status = document.getElementById('pricing-status');
  const result = document.getElementById('pricing-result');
  status.style.display = 'block';
  result.innerHTML = '';

  const period = document.getElementById('pricing-period').value;
  const baseRate = document.getElementById('pricing-base-rate').value;
  if (baseRate) localStorage.setItem('gh-base-rate', baseRate);

  status.style.background = '#FFF8E1'; status.style.color = '#E65100';
  status.textContent = '⟳ Analysing your bookings and seasonal data...';

  const now = new Date();
  const history = bookings.filter(b => b.status !== 'cancelled').map(b => ({
    checkin: b.checkin, checkout: b.checkout, nights: b.nights,
    guests: b.guests, payout: b.hostPayout, platform: b.platform
  }));
  const totalRevenue = bookings.filter(b => b.status !== 'cancelled').reduce((s,b) => s + (b.hostPayout||0), 0);
  const avgPayout = history.length ? Math.round(totalRevenue / history.length) : 0;

  // Build date range — either next N days or a specific calendar month
  let startDate, endDate;
  if (period.startsWith('month-')) {
    const monthIdx = parseInt(period.split('-')[1]);
    const year = monthIdx < now.getMonth() ? now.getFullYear() + 1 : now.getFullYear();
    startDate = new Date(year, monthIdx, 1);
    endDate = new Date(year, monthIdx + 1, 0); // last day of month
  } else {
    startDate = new Date(now);
    endDate = new Date(now);
    endDate.setDate(endDate.getDate() + Number(period));
  }

  const periodLabel = period.startsWith('month-')
    ? startDate.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })
    : `next ${period} days`;

  // Mark already-booked dates
  const bookedDates = {};
  bookings.forEach(b => {
    if (!b.checkin || !b.checkout) return;
    const s = new Date(b.checkin), e = new Date(b.checkout);
    for (let d = new Date(s); d < e; d.setDate(d.getDate()+1)) {
      bookedDates[d.toISOString().split('T')[0]] = b.name;
    }
  });

  const prompt = `You are a short-term rental pricing expert for Katoomba, Blue Mountains, NSW, Australia. Property: Glenhaven — 4-bedroom, 8-guest luxury cottage.

Booking history (${history.length} bookings, avg host payout A$${avgPayout}):
${JSON.stringify(history.slice(-10))}

Base rate: A$${baseRate || '350'}/night. Today: ${now.toISOString().split('T')[0]}. Forecast: ${periodLabel}.

KATOOMBA-SPECIFIC DEMAND FACTORS:
- Winter Magic Festival: mid-June (huge demand spike, sell out weeks ahead)
- Yulefest: June–August (fireplaces, misty valleys, peak season for Blue Mountains)
- Three Sisters / Echo Point: year-round but peaks school holidays + long weekends
- Wildflower season: September–October (shoulder peak, strong Sydney day-tripper overflow)
- Christmas/NYE: extreme peak, book months ahead
- Easter long weekend: peak
- NSW school holidays: very high demand (Sydney families escape to mountains)
- Anzac Day, Queen's Birthday, Labour Day long weekends: peak
- Nearby competition: Katoomba has ~200+ STR listings. Occupancy typically 85%+ winter weekends, 60-70% weekdays. You should price at or slightly above market on peak dates.
- Sydney proximity (90 min drive): strong weekend demand from Sydney couples/families year-round

Return ONLY valid JSON, no markdown:
{
  "summary": "2 sentences on pricing opportunity for the forecast period",
  "tips": ["tip1","tip2","tip3"],
  "periods": [
    { "label": "Period name", "tier": "peak|high|standard|low", "rate": 480, "rule": "weekend|weekday", "months": [6,7,8] }
  ]
}

rule: "weekend" (Fri/Sat/Sun nights) | "weekday" (Mon-Thu) — omit rule if using specific dates
months: array of month numbers, optional — omit for year-round
dates: array of specific YYYY-MM-DD for exact holidays/events, optional
List 8-12 periods. Higher rates on Fri/Sat than Sun. Peak Jan 1, Easter, June festival weeks, school holidays, long weekends.`;

  try {
    const { response, data } = await AIService.request({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    });

    if (!response.ok) {
      const msg = data.error?.message || ('HTTP ' + response.status);
      throw new Error(msg);
    }
    let text = data.content?.[0]?.text || '';
    text = text.replace(/```json/gi,'').replace(/```/g,'').trim();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch(parseErr) {
      status.style.background = '#FDECEA'; status.style.color = '#C0392B';
      status.textContent = '✗ Could not read response. Raw reply: ' + text.substring(0, 200);
      return;
    }

    status.style.background = '#E8F5E9'; status.style.color = '#2E7D32';
    status.textContent = '✓ Recommendations ready';

    // Expand period rules into per-date rates client-side
    const rates = {};
    const tierRank = { peak: 4, high: 3, standard: 2, low: 1 };
    const cur = new Date(startDate);
    while (cur <= endDate) {
      const dateStr = cur.toISOString().split('T')[0];
      const dow = cur.getDay(); // 0=Sun,6=Sat
      const month = cur.getMonth() + 1;
      const isWeekend = dow === 0 || dow === 5 || dow === 6;
      let best = null;
      for (const p of (parsed.periods || [])) {
        const monthMatch = !p.months || p.months.includes(month);
        const ruleMatch = !p.rule || (p.rule === 'weekend' && isWeekend) || (p.rule === 'weekday' && !isWeekend);
        const dateMatch = !p.dates || p.dates.includes(dateStr);
        if (monthMatch && ruleMatch && dateMatch) {
          if (!best || (tierRank[p.tier]||0) > (tierRank[best.tier]||0)) best = p;
        }
      }
      rates[dateStr] = best
        ? { rate: best.rate, label: best.label, tier: best.tier }
        : { rate: Number(baseRate||350), label: 'Standard', tier: 'standard' };
      cur.setDate(cur.getDate() + 1);
    }

    result.innerHTML = renderPricingCalendar({ ...parsed, rates }, bookedDates, startDate, endDate);

  } catch(err) {
    status.style.background = '#FDECEA'; status.style.color = '#C0392B';
    const msg = err.message || 'Unknown error';
    if (msg.includes('quota') || msg.includes('429') || msg.includes('overloaded')) {
      status.textContent = '✗ API busy — wait a moment and try again';
    } else if (msg.includes('invalid') || msg.includes('401')) {
      status.textContent = '✗ API key invalid — check Settings → AI Tools';
    } else {
      status.innerHTML = '✗ Error: <small style="word-break:break-all">' + msg + '</small>';
    }
  }
}

function renderPricingCalendar(data, bookedDates, startDate, endDate) {
  const tierColors = {
    peak:     { bg:'#FF5A5F', text:'#fff', border:'#e04040' },
    high:     { bg:'#FF9800', text:'#fff', border:'#e08000' },
    standard: { bg:'#E8F5E9', text:'#2E7D32', border:'#c8e6c9' },
    low:      { bg:'#F5F5F5', text:'#757575', border:'#e0e0e0' }
  };
  const tierLabels = { peak:'🔴 Peak', high:'🟠 High', standard:'🟢 Standard', low:'⚪ Low' };

  // Group dates by month
  const months = {};
  const d = new Date(startDate);
  while (d <= endDate) {
    const key = d.toISOString().split('T')[0].substring(0,7);
    if (!months[key]) months[key] = [];
    months[key].push(d.toISOString().split('T')[0]);
    d.setDate(d.getDate()+1);
  }

  let html = '';

  // Summary
  if (data.summary) {
    html += `<div class="card" style="font-size:13px;line-height:1.6;margin-bottom:8px">
      <div style="font-weight:700;font-size:14px;margin-bottom:6px">📊 Pricing Outlook</div>
      ${data.summary}
      <div style="margin-top:8px;padding:8px;background:var(--warm);border-radius:6px;font-size:11px;color:var(--text-soft)">
        💡 <strong>Guest price</strong> = what guests pay per night · <strong>Your payout</strong> = after ~3% Airbnb fee. Cleaning fee is additional.
      </div>
    </div>`;
  }

  // Legend
  html += `<div class="card" style="margin-bottom:8px;padding:10px 14px">
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      ${Object.entries(tierLabels).map(([t,l]) => `
        <div style="display:flex;align-items:center;gap:5px">
          <div style="width:14px;height:14px;border-radius:3px;background:${tierColors[t].bg};border:1px solid ${tierColors[t].border}"></div>
          <span style="font-size:11px;color:var(--text-soft)">${l}</span>
        </div>`).join('')}
      <div style="display:flex;align-items:center;gap:5px">
        <div style="width:14px;height:14px;border-radius:3px;background:#3D67FF"></div>
        <span style="font-size:11px;color:var(--text-soft)">📅 Booked</span>
      </div>
    </div>
  </div>`;

  // Monthly calendars
  Object.entries(months).forEach(([monthKey, dates]) => {
    const [year, month] = monthKey.split('-').map(Number);
    const monthName = new Date(year, month-1, 1).toLocaleDateString('en-AU', {month:'long', year:'numeric'});
    const firstDay = new Date(year, month-1, 1).getDay(); // 0=Sun

    html += `<div class="card" style="margin-bottom:8px;padding:12px">
      <div style="font-weight:700;font-size:14px;margin-bottom:10px">${monthName}</div>
      <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px;margin-bottom:4px">
        ${['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => `<div style="text-align:center;font-size:10px;font-weight:600;color:var(--text-soft);padding:2px">${d}</div>`).join('')}
      </div>
      <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px">`;

    // Empty cells before first day
    for (let i = 0; i < firstDay; i++) {
      html += `<div></div>`;
    }

    // Days in month
    const daysInMonth = new Date(year, month, 0).getDate();
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      const isPast = new Date(dateStr) < new Date(new Date().toISOString().split('T')[0]);
      const isBooked = bookedDates[dateStr];
      const rateData = data.rates?.[dateStr];
      const tier = rateData?.tier || 'standard';
      const rate = rateData?.rate;
      const label = rateData?.label || '';
      const payout = rate ? Math.round(rate * 0.97) : null; // ~3% Airbnb fee

      let bg, textColor, border;
      if (isBooked) { bg='#3D67FF'; textColor='#fff'; border='#2d57ef'; }
      else if (isPast) { bg='#f9f9f9'; textColor='#ccc'; border='#eee'; }
      else { bg=tierColors[tier]?.bg||'#E8F5E9'; textColor=tierColors[tier]?.text||'#333'; border=tierColors[tier]?.border||'#ccc'; }

      const tooltip = isBooked
        ? `Booked: ${bookedDates[dateStr]}`
        : (rate ? `${label}\nGuest pays: $${rate}\nYour payout: ~$${payout}` : label);

      html += `<div title="${tooltip}" style="border-radius:6px;background:${bg};border:1px solid ${border};padding:3px 2px;text-align:center;cursor:default;min-height:52px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px">
        <div style="font-size:11px;font-weight:600;color:${textColor}">${day}</div>
        ${!isPast && !isBooked && rate ? `
          <div style="font-size:9px;color:${textColor};font-weight:700;line-height:1.1">$${rate}</div>
          <div style="font-size:8px;color:${textColor};opacity:0.8;line-height:1.1">~$${payout}</div>
        ` : ''}
        ${isBooked ? `<div style="font-size:8px;color:${textColor};margin-top:1px">✓ Booked</div>` : ''}
      </div>`;
    }

    html += `</div>
    <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:10px;color:var(--text-soft);padding-top:6px;border-top:1px solid var(--warm)">
      <span>Top = guest price</span><span>Bottom = ~your payout (after 3% fee)</span>
    </div>
    </div>`; 
  });

  // Tips
  if (data.tips?.length) {
    html += `<div class="card" style="font-size:13px;line-height:1.6">
      <div style="font-weight:700;font-size:14px;margin-bottom:8px">💡 Tips</div>
      ${data.tips.map(t => `<div style="display:flex;gap:8px;margin-bottom:6px"><span style="color:var(--moss);flex-shrink:0">→</span><span>${t}</span></div>`).join('')}
    </div>`;
  }

  return html;
}
function renderSettings() {
  const lastSync = localStorage.getItem('gh-last-sync') || 'Never';
  const lsEl = document.getElementById('settings-last-sync');
  if (lsEl) lsEl.textContent = lastSync;
  const bcEl = document.getElementById('settings-booking-count');
  if (bcEl) bcEl.textContent = bookings.length + ' bookings loaded';
  const lastBackup = localStorage.getItem('gh-last-backup') || 'Never';
  const buEl = document.getElementById('backup-last-time');
  if (buEl) buEl.textContent = lastBackup;
  setTimeout(updateNotifStatus, 100);
}

function populateSelects() {
  const allOpts = '<option value="">Select booking...</option>' + bookings.map(b=>`<option value="${b.id}">${b.name} (${fmt(b.checkin)})</option>`).join('');
  // For clean form: only show future bookings not yet notified
  const now = new Date();
  const unnotified = bookings.filter(b => {
    const isFuture = new Date(b.checkout) >= now;
    const hasClean = cleans.some(c => c.guestName === b.name || c.bookingId === b.id);
    const isConfirmed = b.cleanerConfirmed;
    return isFuture && !hasClean && !isConfirmed;
  });
  const cleanOpts = '<option value="">Select booking...</option>' + unnotified.map(b=>`<option value="${b.id}">${b.name} (${fmt(b.checkin)})</option>`).join('');
  document.getElementById('clean-booking-select').innerHTML = cleanOpts;
  document.getElementById('note-booking-select').innerHTML = allOpts;
}

// ── BOOKING DETAIL ────────────────────────────────────────────────────────
function showDetail(id) {
  const b = bookings.find(b=>b.id===id);
  if (!b) return;
  const bn = notes.filter(n=>n.bookingId===id);
  const bc = cleans.filter(c=>c.bookingId===id);
  document.getElementById('detail-content').innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <div style="display:flex;align-items:center;gap:12px">
        ${platformIcon(b.platform, 52)}
        <div>
          <div style="font-family:'DM Serif Display',serif;font-size:20px">${b.name}</div>
          <div class="booking-status status-${b.status}">${b.status}</div>
        </div>
      </div>
      <button onclick="showEditModal(${b.id})" style="background:var(--amber);color:white;border:none;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer">Edit</button>
    </div>
    <div class="card" style="margin-bottom:10px">
      <div class="card-title">Stay Details</div>
      <div class="detail-row"><span class="detail-label">Check-in</span><span class="detail-val">${fmt(b.checkin)}</span></div>
      <div class="detail-row"><span class="detail-label">Check-out</span><span class="detail-val">${fmt(b.checkout)}</span></div>
      <div class="detail-row"><span class="detail-label">Nights</span><span class="detail-val">${b.nights}</span></div>
      <div class="detail-row"><span class="detail-label">Guests</span><span class="detail-val">${b.guests}</span></div>
      ${b.platform?`<div class="detail-row"><span class="detail-label">Platform</span><span class="detail-val">${b.platform==='Airbnb'?'🏠 Airbnb':b.platform==='VRBO'?'🏡 VRBO':'📋 Direct'}</span></div>`:''}
    </div>
    <div class="card" style="margin-bottom:10px">
      <div class="card-title">Financials</div>
      <div class="detail-row"><span class="detail-label">Host Payout</span><span class="detail-val money">$${Number(b.hostPayout||0).toLocaleString()}</span></div>
      <div class="detail-row"><span class="detail-label">Cleaning Fee</span><span class="detail-val money">$${Number(b.cleaningFee||0).toLocaleString()}</span></div>
      <div class="detail-row"><span class="detail-label">Management Fee</span><span class="detail-val">${b.mgmtFeeRaw||Math.round((b.mgmtFee&&b.hostPayout?(b.mgmtFee/b.hostPayout)*100:0)*10)/10||0}%</span></div>
      <div class="detail-row"><span class="detail-label">Management Payout</span><span class="detail-val money">$${Number(b.mgmtPayout||0).toLocaleString()}</span></div>
      <div class="detail-row" style="background:var(--mist);padding:10px 0">
        <span class="detail-label" style="font-weight:700;color:var(--text)">Net Payout</span>
        <span class="detail-val money" style="font-size:18px">$${Number(b.netPayout||0).toLocaleString()}</span>
      </div>
    </div>
    <div class="card" style="margin-bottom:10px">
      <div class="card-title">Cleaner</div>
      <div class="toggle-wrap">
        <div>
          <div style="font-weight:500;font-size:14px">Cleaner Confirmed</div>
          <div style="font-size:12px;color:var(--text-soft)">${b.cleanerConfirmed?'✓ Confirmed':'Not yet confirmed'}</div>
        </div>
        <button class="toggle ${b.cleanerConfirmed?'on':''}" onclick="toggleCleanerConfirmed(${b.id})"></button>
      </div>
      ${bc.map(c=>`<div style="font-size:12px;color:var(--text-soft);padding:4px 0">${c.cleaner} · ${fmt(c.date)}</div>`).join('')}
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--warm)">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-soft);margin-bottom:8px">Assign Cleaner</div>
        ${(()=>{
          const cls = loadCleaners().filter(c=>!c.role||c.role==='Cleaner');
          const assigned = bc[0];
          if (!cls.length) return '<div style="font-size:12px;color:var(--text-soft)">No cleaners set up yet — add in Settings → Property &amp; People</div>';
          return `<select id="detail-assign-cleaner" style="margin-bottom:8px">
            <option value="">— Not assigned —</option>
            ${cls.map(c=>`<option value="${c.id}" ${assigned&&assigned.cleanerId===c.id?'selected':''}>${c.name}</option>`).join('')}
          </select>
          <input type="date" id="detail-assign-date" value="${assigned?assigned.date:b.checkout}" style="margin-bottom:8px">
          <button onclick="assignCleanerToBooking(${b.id})" class="btn-primary" style="width:100%">💾 Save Assignment</button>`;
        })()}
      </div>
      ${b.status==='completed'?`
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--warm)">
        <div style="font-size:12px;font-weight:600;color:var(--text-soft);text-transform:uppercase;letter-spacing:0.6px;margin-bottom:8px">Confirm Actual Cleaning Fee</div>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="number" id="actual-clean-fee" value="${Number(b.cleaningFee||0)}" style="flex:1;padding:10px;border:1px solid var(--warm);border-radius:8px;font-size:14px;font-family:'DM Sans',sans-serif">
          <button onclick="saveCleaningFee(${b.id})" style="background:var(--forest);color:white;border:none;border-radius:8px;padding:10px 14px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap">Save &amp; Sync</button>
        </div>
      </div>`:''}
    </div>
    ${bn.length?`<div class="card" style="margin-bottom:10px">
      <div class="card-title">Notes</div>
      ${bn.map(n=>`<div class="note-item" style="margin-bottom:6px"><span class="note-tag tag-${n.tag}">${n.tag}</span><div class="note-text">${n.text}</div></div>`).join('')}
    </div>`:''}
    <button class="btn-secondary" style="margin-bottom:8px;background:#FDECEA;color:var(--red)" onclick="deleteBooking(${b.id})">Delete Booking</button>
  `;
  document.getElementById('detail-modal').classList.add('open'); document.body.style.overflow='hidden';
}

function showEditModal(id) {
  const b = bookings.find(b=>b.id===id);
  if (!b) return;
  closeDetailModal();
  document.getElementById('detail-content').innerHTML = `
    <div style="font-family:'DM Serif Display',serif;font-size:22px;margin-bottom:16px">Edit Booking</div>
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
      <div class="field"><label>Host Payout ($)</label><input type="number" id="e-hostpayout" value="${b.hostPayout}" oninput="editCalcNet()"></div>
      <div class="field"><label>Cleaning Fee ($)</label><input type="number" id="e-cleaningfee" value="${b.cleaningFee}" oninput="editCalcNet()"></div>
    </div>
    <div class="form-row">
      <div class="field"><label>Mgmt Fee (%)</label><input type="number" id="e-mgmtfee" value="${b.mgmtFeeRaw||Math.round((b.mgmtFee/b.hostPayout)*1000)/10||0}" min="0" max="100" step="0.1" oninput="editCalcNet()"></div>
      <div class="field"><label>Mgmt Payout</label><input type="text" id="e-mgmtpayout" value="$${Number(b.mgmtPayout||0).toFixed(2)}" style="background:var(--warm);color:var(--text-soft);font-style:italic" readonly></div>
    </div>
    <label>Net Payout ($)</label>
    <input type="text" id="e-netpayout" value="$${Number(b.netPayout||0).toFixed(2)}" readonly style="background:var(--warm);color:var(--text-soft);font-style:italic">
    <label>Platform</label>
    <div style="padding:10px 12px;background:var(--warm);border-radius:var(--radius-sm);font-size:14px;color:var(--text-soft);font-style:italic">
      ${b.platform ? (b.platform==='Airbnb'?'🏠 Airbnb':b.platform==='VRBO'?'🏡 VRBO':'📋 Direct') : 'Not set'}
    </div>
    <button class="btn-primary" onclick="saveEdit(${b.id})" id="save-edit-btn">Save & Sync to Sheet</button>
    <button class="btn-secondary" onclick="closeDetailModal()">Cancel</button>
  `;
  document.getElementById('detail-modal').classList.add('open'); document.body.style.overflow='hidden';
  setTimeout(attachModalHandleDrag, 50);
}

function editCalcNights() {
  const ci = document.getElementById('e-checkin').value;
  const co = document.getElementById('e-checkout').value;
  if (ci && co) { const n=Math.ceil((new Date(co)-new Date(ci))/86400000); document.getElementById('e-nights').value=n>0?n:''; }
}

function editCalcNet() {
  const host=Number(document.getElementById('e-hostpayout').value)||0;
  const clean=Number(document.getElementById('e-cleaningfee').value)||0;
  const mgmtPct=Number(document.getElementById('e-mgmtfee').value)||0;
  const mgmtAmt=Math.round((host-clean)*mgmtPct/100*100)/100;
  const net=Math.round((host-clean-mgmtAmt)*100)/100;
  const mgmtEl=document.getElementById('e-mgmtpayout');
  const netEl=document.getElementById('e-netpayout');
  if(mgmtEl) mgmtEl.value=mgmtPct?'$'+mgmtAmt.toFixed(2):'';
  if(netEl) netEl.value=host?'$'+net.toFixed(2):'';
}

function saveEdit(id) {
  const b = bookings.find(b=>b.id===id);
  if (!b) return;
  const btn = document.getElementById('save-edit-btn');
  btn.textContent = 'Saving...'; btn.disabled = true;
  b.name        = document.getElementById('e-name').value.trim();
  b.checkin     = document.getElementById('e-checkin').value;
  b.checkout    = document.getElementById('e-checkout').value;
  b.nights      = Number(document.getElementById('e-nights').value)||1;
  b.guests      = Number(document.getElementById('e-guests').value)||1;
  b.hostPayout  = Number(document.getElementById('e-hostpayout').value)||0;
  b.cleaningFee = Number(document.getElementById('e-cleaningfee').value)||0;
  const mgmtPct = Number(document.getElementById('e-mgmtfee').value)||0;
  b.mgmtFeeRaw  = mgmtPct;
  // mgmtFee dollar, mgmtPayout, netPayout calculated by sheet — keep existing values
  b.status      = getStatus(b.checkin);
  save();
  pushToSheet('update', b);
  updateBookingInCalendar(b);
  showBanner('✅ Booking saved & syncing...', 'ok');
  setTimeout(() => { closeDetailModal(); render(); }, 500);
}

function toggleCleanerConfirmed(id) {
  const b = bookings.find(b=>b.id===id);
  if (b) { b.cleanerConfirmed=!b.cleanerConfirmed; save(); showDetail(id); renderBookings(); }
}

// ── ACTIONS ───────────────────────────────────────────────────────────────
function calcNights() {
  const ci=document.getElementById('b-checkin').value, co=document.getElementById('b-checkout').value;
  if (ci&&co){const n=Math.ceil((new Date(co)-new Date(ci))/86400000);document.getElementById('b-nights').value=n>0?n:'';}
}
function calcNet() {
  const host=Number(document.getElementById('b-hostpayout').value)||0;
  const clean=Number(document.getElementById('b-cleaningfee').value)||0;
  const mgmtPct=Number(document.getElementById('b-mgmtfee').value)||0;
  const mgmtAmt=Math.round((host-clean)*mgmtPct/100*100)/100;
  const net=Math.round((host-clean-mgmtAmt)*100)/100;
  const mgmtEl=document.getElementById('b-mgmtpayout');
  const netEl=document.getElementById('b-netpayout');
  if(mgmtEl) mgmtEl.value=mgmtPct?'$'+mgmtAmt.toFixed(2):'';
  if(netEl) netEl.value=host?'$'+net.toFixed(2):'';
}
function filterBookings(f,btn) {
  // Only clear tabs within the bookings section
  document.querySelectorAll('#section-bookings .tab-row .tab').forEach(t=>t.classList.remove('active'));
  btn.classList.add('active');
  renderBookings(f);
}
function addBooking() {
  const name=document.getElementById('b-name').value.trim();
  const checkin=document.getElementById('b-checkin').value;
  const checkout=document.getElementById('b-checkout').value;
  const guests=document.getElementById('b-guests').value;
  if (!name||!checkin||!checkout||!guests){showBanner('⚠ Please fill in guest name, dates and guests','warn');return;}
  const newB={
    id:Date.now(), name, checkin, checkout,
    nights:Number(document.getElementById('b-nights').value)||1,
    guests:Number(guests),
    hostPayout:Number(document.getElementById('b-hostpayout').value)||0,
    cleaningFee:Number(document.getElementById('b-cleaningfee').value)||0,
    mgmtFeeRaw:Number(document.getElementById('b-mgmtfee').value)||0,
    mgmtFee:0,
    platform:document.getElementById('b-platform').value||'',
    mgmtPayout:0,
    netPayout:0,
    cleanerConfirmed:false, status:document.getElementById('b-status').value, _local:true
  };
  bookings.push(newB); save(); pushToSheet('add', newB); closeModal(); render();
  showBanner('✅ Booking added', 'ok');
  pushBookingToCalendar(newB);
}
function autoFillCleanDate() {
  const bookingId = Number(document.getElementById('clean-booking-select').value);
  if (!bookingId) return;
  const booking = bookings.find(b => b.id === bookingId);
  if (booking && booking.checkout) {
    document.getElementById('clean-date').value = booking.checkout;
  }
}
function addClean() {
  const bookingId=Number(document.getElementById('clean-booking-select').value);
  const selectEl = document.getElementById('clean-name-select');
  const cleaner = selectEl ? selectEl.value.trim() : document.getElementById('clean-name').value.trim();
  const date=document.getElementById('clean-date').value;
  if (!bookingId||!cleaner||!date){showBanner('⚠ Please fill all fields','warn');return;}
  localStorage.setItem('gh-last-cleaner', cleaner);
  const booking=bookings.find(b=>b.id===bookingId);
  if (!booking) { showBanner('⚠ Booking not found — it may have been deleted', 'warn'); return; }
  // Find cleaner ID from the saved cleaners list
  const cleanerObj = loadCleaners().find(c => c.name === cleaner);
  const cleanerId = cleanerObj ? cleanerObj.id : null;
  const newClean = {id:Date.now(), bookingId, guestName:booking.name, cleaner, cleanerId, date, done:false, notified:false, cleanerConfirmed:false};
  cleans.push(newClean);
  save();
  showBanner('✅ Clean scheduled for ' + newClean.date, 'ok');
  // Prompt to send SMS — only mark notified if user confirms
  showAppModal({ title: '💬 Send SMS?', msg: `Notify ${cleaner} about this booking now?`, confirmText: 'Send SMS', cancelText: 'Later' })
    .then(ok => {
      if (ok) {
        newClean.notified = true;
        save();
        cleanFilter = 'upcoming';
        document.querySelectorAll('#section-cleaning .tab-row .tab').forEach((t,i) => t.classList.toggle('active', i===0));
        renderCleaning();
        openNotifyModal(newClean.id);
      } else {
        cleanFilter = 'upcoming';
        document.querySelectorAll('#section-cleaning .tab-row .tab').forEach((t,i) => t.classList.toggle('active', i===0));
        renderCleaning();
      }
    });
  populateSelects();
}
function toggleClean(id) {
  const c=cleans.find(c=>c.id===id);
  if (c){
    c.done=!c.done;
    save();
    // If marking done, switch to Done tab
    if (c.done) {
      cleanFilter='done';
      document.querySelectorAll('#section-cleaning .tab-row .tab').forEach((t,i)=>{
        t.classList.toggle('active', i===2);
      });
    }
    renderCleaning(); renderDashboard();
  }
}
function addNote() {
  const bookingId=Number(document.getElementById('note-booking-select').value);
  const text=document.getElementById('note-text').value.trim();
  const tag=document.getElementById('note-tag').value;
  if (!bookingId||!text){showBanner('⚠ Please select a booking and add a note','warn');return;}
  const booking=bookings.find(b=>b.id===bookingId);
  if (!booking) { showBanner('⚠ Booking not found — it may have been deleted', 'warn'); return; }
  notes.push({id:Date.now(),bookingId,guestName:booking.name,text,tag,date:new Date().toISOString().split('T')[0]});
  document.getElementById('note-text').value=''; save(); renderNotes();
  showBanner('✅ Note saved', 'ok');
}
async function deleteBooking(id) {
  const b=bookings.find(b=>b.id===id);
  const _okBk = await showAppModal({ title: 'Delete Booking', msg: 'Remove this booking? This cannot be undone.', confirmText: 'Delete', confirmColor: 'var(--red)' }); if (!_okBk) return;
  const deletedBooking = bookings.find(b=>b.id===id);
  bookings=bookings.filter(b=>b.id!==id);
  cleans=cleans.filter(c=>c.bookingId!==id && !(deletedBooking && c.guestName===deletedBooking.name));
  notes=notes.filter(n=>n.bookingId!==id && !(deletedBooking && n.guestName===deletedBooking.name));
  save();
  if (b) pushToSheet('delete', b);
  // Delete calendar event if one was created
  if (deletedBooking && deletedBooking.gcalEventId) {
    const token = getDriveToken();
    if (!token) {
      showBanner('✅ Booking deleted — reconnect Google Drive to also remove calendar event', 'warn');
    } else {
      fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events/' + deletedBooking.gcalEventId, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + token }
      }).then(res => {
        if (res.status === 204 || res.status === 200) showBanner('✅ Booking & calendar event deleted', 'ok');
        else if (res.status === 401) showBanner('✅ Booking deleted — calendar event not removed (token expired, reconnect Drive)', 'warn');
        else if (res.status === 404) showBanner('✅ Booking deleted — calendar event already gone', 'ok');
        else showBanner('✅ Booking deleted — calendar event not removed (error ' + res.status + ')', 'warn');
      }).catch(() => showBanner('✅ Booking deleted — calendar event not removed (network error)', 'warn'));
    }
  }
  closeDetailModal(); render();
  showBanner('✅ Booking deleted', 'ok');
}

// ── CSV IMPORT ────────────────────────────────────────────────────────────
function importCSV(input) {
  const file=input.files[0]; if (!file) return;
  const reader=new FileReader();
  reader.onload=function(e){
    const lines=e.target.result.trim().split('\n');
    let imported=0;
    lines.forEach((line,i)=>{
      if (i===0) return;
      const p=parseCSVLine(line);
      if (!p[0]&&!p[3]) return;
      const name=String(p[3]||''). trim();
      const checkin=toISO(String(p[0]||''). trim());
      if (!name||!checkin) return;
      bookings.push({
        id:Date.now()+i, checkin, nights:Number(p[1])||1, checkout:toISO(String(p[2]||'')),
        name, guests:Number(p[4])||1,
        hostPayout:toNum(p[5]), cleaningFee:toNum(p[6]),
        mgmtFee:toNum(p[7]), mgmtPayout:toNum(p[8]), netPayout:toNum(p[9]),
        mgmtFeeRaw: toNum(p[5]) ? Math.round((toNum(p[7])/toNum(p[5]))*1000)/10 : 0,
        cleanerConfirmed:['yes','true','1','TRUE'].includes(String(p[10]||''). trim()),
        platform: String(p[11]||'').trim(),
        status:'confirmed', _local:true
      });
      imported++;
    });
    save();
    document.getElementById('import-preview').textContent=`✓ Imported ${imported} booking${imported!==1?'s':''}`;
    setTimeout(()=>{closeModal();render();},1200);
  };
  reader.readAsText(file);
}

// ── MODALS ────────────────────────────────────────────────────────────────
function openModal(){ document.getElementById('modal').classList.add('open'); document.body.style.overflow='hidden'; }
function closeModal(){ document.getElementById('modal').classList.remove('open'); _checkModalsClosed(); }
function closeDetailModal(){ document.getElementById('detail-modal').classList.remove('open'); _checkModalsClosed(); }
function _checkModalsClosed(){
  const anyOpen = !!document.querySelector('.modal-overlay.open');
  if (!anyOpen) document.body.style.overflow = '';
}
document.getElementById('modal').addEventListener('click',function(e){if(e.target===this)closeModal();});
document.getElementById('detail-modal').addEventListener('click',function(e){if(e.target===this)closeDetailModal();});
function switchModalTab(tab,btn){
  document.querySelectorAll('#modal .tab').forEach(t=>t.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('modal-manual').style.display=tab==='manual'?'block':'none';
  document.getElementById('modal-screenshot').style.display=tab==='screenshot'?'block':'none';
  document.getElementById('modal-import').style.display=tab==='import'?'block':'none';
}

// ── UTILS ─────────────────────────────────────────────────────────────────
function toNum(val){if(!val)return 0;return Number(String(val).replace(/[$,%\s]/g,''))||0;}
function toISO(val){
  if (!val) return '';
  val=String(val).trim();
  // ISO datetime: 2026-03-08T00:00:00.000Z — parse and extract LOCAL date (avoids UTC→AEST shift)
  if (val.includes('T') || val.includes('Z')) {
    const d = new Date(val);
    if (!isNaN(d.getTime())) return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  // Already bare ISO date
  if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
  // Slash-separated: detect YYYY/MM/DD vs DD/MM/YYYY by first part length
  const slashParts=val.split('/');
  if (slashParts.length===3){
    if (slashParts[0].length===4){const[y,m,d]=slashParts;return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;}
    const[d,m,y]=slashParts;return `${y.length===2?'20'+y:y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }
  // Dash-separated DD-MM-YYYY (first part ≤2 digits; YYYY-MM-DD already caught above)
  const dashParts=val.split('-');
  if (dashParts.length===3 && dashParts[0].length<=2){const[d,m,y]=dashParts;return `${y.length===2?'20'+y:y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;}
  // Google Sheets serial number
  if (/^\d{4,6}$/.test(val)){const epoch=new Date(1899,11,30);epoch.setDate(epoch.getDate()+Number(val));return epoch.toISOString().split('T')[0];}
  // Text date e.g. "8 Mar 2026" — explicit parse to avoid MM/DD ambiguity
  const months={'jan':0,'feb':1,'mar':2,'apr':3,'may':4,'jun':5,'jul':6,'aug':7,'sep':8,'oct':9,'nov':10,'dec':11};
  const tm=val.match(/^(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4})$/);
  if(tm && months[tm[2].toLowerCase()]!==undefined) return `${tm[3]}-${String(months[tm[2].toLowerCase()]+1).padStart(2,'0')}-${tm[1].padStart(2,'0')}`;
  return val;
}
function getStatus(checkin){
  const now=new Date(), ci=new Date(checkin);
  if (ci<now) return 'completed';
  return 'upcoming';
}
function parseCSVLine(line){
  const result=[]; let current='', inQuotes=false;
  for (let i=0;i<line.length;i++){
    if (line[i]==='"'){inQuotes=!inQuotes;}
    else if (line[i]===','&&!inQuotes){result.push(current.trim());current='';}
    else{current+=line[i];}
  }
  result.push(current.trim()); return result;
}
function fmt(dateStr){
  if (!dateStr) return '';
  const d=new Date(dateStr+'T00:00:00');
  return d.toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric'});
}

// ── NOTIFY CLEANER ───────────────────────────────────────────────────────
let notifyPhone = '';
let currentNotifyCleanId = null;

function openNotifyModal(cleanId) {
  currentNotifyCleanId = cleanId;
  const c = cleans.find(c => c.id === cleanId);
  if (!c) return;
  const b = bookings.find(b => b.id === c.bookingId);

  // Build message
  const checkin = b ? fmt(b.checkin) : 'TBC';
  const checkout = b ? fmt(b.checkout) : fmt(c.date);
  const guests = b ? b.guests : '?';
  const nights = b ? b.nights : '?';

  // Use saved template or default
  const defaultTemplate = `Hi {cleanerFirstName}\n\nNew Booking - please see below\n\nCheck in: {checkin}\nCheck out: {checkout}\nName: {guestFirstName}\nNumber of guests: {guests}\n\nPlease let me know if you are available`;
  const template = localStorage.getItem('gh-sms-template') || defaultTemplate;
  const msg = template
    .replace('{cleanerFirstName}', (c.cleaner||'').split(' ')[0])
    .replace('{cleanerName}', c.cleaner)
    .replace('{guestFirstName}', (c.guestName||'').split(' ')[0])
    .replace('{guestName}', c.guestName)
    .replace('{checkin}', checkin)
    .replace('{checkout}', checkout)
    .replace('{guests}', guests);

  document.getElementById('notify-message').value = msg;
  document.getElementById('notify-clean-info').textContent = `${c.cleaner} · After ${c.guestName} · ${fmt(c.date)}`;
  // Find phone from cleaners list by name
  const cleaners = loadCleaners();
  const matchedCleaner = cleaners.find(cl => cl.name.toLowerCase() === c.cleaner.toLowerCase());
  if (matchedCleaner && matchedCleaner.phone) notifyPhone = matchedCleaner.phone;
  document.getElementById('notify-number-display').textContent = notifyPhone ? '📱 ' + notifyPhone : 'No number saved — go to Settings > Cleaning to add cleaner details';
  document.getElementById('notify-modal').classList.add('open'); document.body.style.overflow='hidden';
}

async function pickContact() {
  if (!('contacts' in navigator && 'ContactsManager' in window)) {
    // Fallback: manual number entry
    const num = await showAppModal({ title: '📱 Enter Number', msg: 'Contact picker not supported. Enter mobile number:', confirmText: 'Save', hasInput: true, inputPlaceholder: '0400 000 000', inputType: 'tel' });
    if (num) { notifyPhone = num.trim(); document.getElementById('notify-number-display').textContent = '📱 ' + notifyPhone; }
    return;
  }
  try {
    const contacts = await navigator.contacts.select(['tel'], { multiple: false });
    if (contacts && contacts.length > 0 && contacts[0].tel && contacts[0].tel.length > 0) {
      notifyPhone = contacts[0].tel[0].replace(/\s/g, '');
      document.getElementById('notify-number-display').textContent = '📱 ' + notifyPhone;
    }
  } catch(e) {
    const num = await showAppModal({ title: '📱 Enter Number', msg: 'Could not open contacts. Enter mobile number:', confirmText: 'Save', hasInput: true, inputPlaceholder: '0400 000 000', inputType: 'tel' });
    if (num) { notifyPhone = num.trim(); document.getElementById('notify-number-display').textContent = '📱 ' + notifyPhone; }
  }
}

function sendSMS() {
  const msg = document.getElementById('notify-message').value;
  if (!notifyPhone) {
    showBanner('⚠ No phone number — add one in Settings → People & SMS','warn');
    return;
  }
  const smsUrl = `sms:${notifyPhone}?&body=${encodeURIComponent(msg)}`;
  window.location.href = smsUrl;
  // Mark the clean as notified
  if (currentNotifyCleanId) {
    const c = cleans.find(c => c.id === currentNotifyCleanId);
    if (c) { c.notified = true; c.cleanerConfirmed = false; save(); }
  }
  closeNotifyModal();
  // Switch to upcoming tab
  cleanFilter = 'upcoming';
  document.querySelectorAll('#section-cleaning .tab-row .tab').forEach((t,i) => t.classList.toggle('active', i===0));
  renderCleaning();
  populateSelects();
}

function closeNotifyModal() {
  document.getElementById('notify-modal').classList.remove('open'); _checkModalsClosed();
}
document.getElementById('notify-modal').addEventListener('click', function(e) {
  if (e.target === this) closeNotifyModal();
});

// ── SETTINGS ─────────────────────────────────────────────────────────────
function chooseGoogleAccount() {
  // Opens Google account chooser — user picks the right account, then comes back and taps Push
  const scriptUrl = getScriptURL();
  const continueUrl = encodeURIComponent(scriptUrl + '?action=test');
  window.open('https://accounts.google.com/AccountChooser?continue=' + continueUrl, '_blank');
}

function syncToSheet() {
  const el = document.getElementById('push-sync-result');
  el.style.display = 'block';
  el.style.background = '#FFF8E1';
  el.style.color = '#E65100';
  el.textContent = '⟳ Opening sync page...';

  const url = getScriptURL();
  if (!url) { el.textContent = '✗ No script URL set.'; return; }

  const payload = JSON.stringify({ bookings: bookings });

  // Use a hidden form POST — handles large payloads, works on iOS Safari
  // Opens in new tab, user sees result and closes it
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = url;
  form.target = '_blank';
  form.style.display = 'none';

  const actionInput = document.createElement('input');
  actionInput.type = 'hidden';
  actionInput.name = 'action';
  actionInput.value = 'replaceAll';
  form.appendChild(actionInput);

  const dataInput = document.createElement('input');
  dataInput.type = 'hidden';
  dataInput.name = 'data';
  dataInput.value = payload;
  form.appendChild(dataInput);

  document.body.appendChild(form);
  form.submit();
  document.body.removeChild(form);

  el.style.background = '#E8F5E9';
  el.style.color = '#2E7D32';
  el.textContent = '✓ Sync page opened — close it once you see status ok';
  const syncTime = new Date().toLocaleString('en-AU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
  localStorage.setItem('gh-last-push', syncTime);
}


// ── CLEAR CACHE (SAFE) ───────────────────────────────────────────────────────
function clearCacheAndResync() {
  showAppModal({
    title: '🗑 Clear booking cache?',
    msg: 'This will clear synced bookings, cleans, notes and expenses, then re-pull from Google Sheets.\n\nYour inventory, cleaners, maintenance records and all settings will be kept.',
    confirmText: 'Clear & Re-sync',
    cancelText: 'Cancel'
  }).then(ok => {
    if (!ok) return;
    // Only clear the data that comes from the sheet — preserve everything else
    ['gh-bookings','gh-cleans','gh-notes','gh-expenses','gh-last-sync'].forEach(k => localStorage.removeItem(k));
    location.reload();
  });
}

// ── SAVE SMS TEMPLATE ────────────────────────────────────────────────────────
function saveSMSTemplate() {
  const val = document.getElementById('settings-sms-template');
  if (!val) return;
  localStorage.setItem('gh-sms-template', val.value);
  showBanner('✓ SMS template saved', 'ok');
}

// ── SAVE CLEANING FEE ────────────────────────────────────────────────────────
function saveCleaningFee(bookingId) {
  const b = bookings.find(b => b.id === bookingId);
  const input = document.getElementById('actual-clean-fee');
  if (!b || !input) return;
  b.cleaningFee = Number(input.value) || 0;
  save();
  pushToSheet('update', b);
  showBanner('✓ Cleaning fee saved & synced', 'ok');
}

// ── PUSH ALL EXPENSES TO SHEET ───────────────────────────────────────────────
async function smartSyncExpenses() {
  const scriptUrl = localStorage.getItem('gh-script-url') || DEFAULT_SCRIPT_URL;
  if (!scriptUrl || !scriptUrl.includes('script.google.com')) {
    showBanner('⚠ Set your Apps Script URL in Settings → Google Sheets first', 'warn'); return;
  }
  if (!expenses.length) { showBanner('⚠ No expenses to sync', 'warn'); return; }

  const resultEl = document.getElementById('push-expenses-result');
  resultEl.style.display = 'block';
  resultEl.style.background = '#FFF8E1'; resultEl.style.color = '#E65100';

  let ok = 0, failed = 0;
  const total = expenses.length;

  for (let i = 0; i < expenses.length; i++) {
    const e = expenses[i];
    resultEl.textContent = '⟳ Syncing ' + (i + 1) + ' / ' + total + '...';
    try {
      const expForSheet = {
        date:        e.date||'',
        merchant:    e.merchant||'',
        description: e.description||'',
        category:    e.category||'',
        amount:      e.amount||0,
        receiptNum:  e.receiptNum||'',
        receiptType: e.receiptType||'',
        driveLink:   e.driveLink||''
      };
      // Use POST with text/plain to avoid GET URL length limits
      const res = await fetch(scriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'updateExpense', data: JSON.stringify(expForSheet) })
      }).then(r => r.json());
      if (res.status === 'ok') ok++; else failed++;
    } catch(err) { failed++; }
  }

  resultEl.style.background = ok ? '#E8F5E9' : '#FDECEA';
  resultEl.style.color = ok ? '#2E7D32' : '#C0392B';
  resultEl.textContent = (ok ? '✅' : '✗') + ' ' + ok + ' synced' + (failed ? ', ' + failed + ' failed' : '');
  showBanner(ok ? '✅ ' + ok + ' expenses synced to sheet' : '⚠ Sync had ' + failed + ' failures', ok ? 'ok' : 'warn');
}

function saveScriptURL() {
  const url = document.getElementById('settings-script-url').value.trim();
  if (!url) return;
  localStorage.setItem('gh-script-url', url);
  const el = document.getElementById('script-url-confirm');
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 2000);
}
async function testScriptConnection() {
  const el = document.getElementById('script-test-result');
  el.style.display = 'block';
  el.style.background = '#FFF8E1';
  el.style.color = '#E65100';
  el.textContent = '⟳ Testing connection...';
  try {
    const url = getScriptURL() + '?action=test';
    const res = await fetch(url);
    const testJson = await res.json();
    if (!testJson.status) throw new Error('unexpected response from script');
    el.style.background = '#E8F5E9';
    el.style.color = '#2E7D32';
    el.textContent = '✓ Connected — script responded OK';
  } catch(e) {
    el.style.background = '#FDECEA';
    el.style.color = '#C0392B';
    el.textContent = '✗ Could not reach script: ' + e.message;
  }
}
function saveBankDetails() {
  ['name','bsb','acc','bank'].forEach(k => {
    const val = document.getElementById('inv-bank-'+k)?.value?.trim();
    if (val !== undefined) localStorage.setItem('gh-bank-'+k, val);
  });
  const el = document.getElementById('inv-bank-confirm');
  el.style.display='block'; setTimeout(()=>el.style.display='none',2000);
}

function loadClients() { return JSON.parse(localStorage.getItem('gh-clients')||'[]'); }
function saveClients(c) { localStorage.setItem('gh-clients', JSON.stringify(c)); }

function renderClientsList() {
  const clients = loadClients();
  const el = document.getElementById('clients-list');
  if (!el) return;
  if (!clients.length) { el.innerHTML='<div style="font-size:13px;color:var(--text-soft)">No clients yet</div>'; return; }
  el.innerHTML = clients.map((c,i) => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--warm)">
      <div>
        <div style="font-weight:600;font-size:14px">${c.name}</div>
        ${c.contact?`<div style="font-size:12px;color:var(--text-soft)">${c.contact}</div>`:''}
        ${c.email?`<div style="font-size:12px;color:var(--text-soft)">${c.email}</div>`:''}
      </div>
      <button onclick="deleteClient(${i})" style="background:none;border:none;color:var(--red);font-size:18px;cursor:pointer;padding:4px">✕</button>
    </div>`).join('');
}

function addClient() {
  const name = document.getElementById('new-client-name').value.trim();
  if (!name) { showBanner('⚠ Please enter a client name','warn'); return; }
  const clients = loadClients();
  clients.push({
    name,
    contact: document.getElementById('new-client-contact').value.trim(),
    email: document.getElementById('new-client-email').value.trim(),
    address: document.getElementById('new-client-address').value.trim()
  });
  saveClients(clients);
  ['name','contact','email','address'].forEach(k => { const el = document.getElementById('new-client-'+k); if(el) el.value=''; });
  renderClientsList();
  showBanner('✓ Client added','ok');
}

async function deleteClient(i) {
  const _okClient = await showAppModal({ title: 'Remove Client', msg: 'Remove this client?', confirmText: 'Remove', confirmColor: 'var(--red)' });
  if (!_okClient) return;
  const clients = loadClients();
  clients.splice(i,1);
  saveClients(clients);
  renderClientsList();
}

function saveGeminiKey() {
  const key = document.getElementById('settings-gemini-key').value.trim();
  if (!key) return;
  localStorage.setItem('gh-gemini-key', key);
  const el = document.getElementById('gemini-key-confirm');
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 2000);
}
function saveGDriveClientId() {
  const id = document.getElementById('gdrive-client-id').value.trim();
  if (!id) return;
  localStorage.setItem('gh-gdrive-client-id', id);
  const el = document.getElementById('gdrive-client-confirm');
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 2000);
}
function saveApiKey() {
  const key = document.getElementById('settings-api-key').value.trim();
  if (!key) return;
  localStorage.setItem('gh-api-key', key);
  const el = document.getElementById('api-key-confirm');
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 2000);
}
function getApiKey() {
  return localStorage.getItem('gh-api-key') || '';
}
function saveInvoiceDetails() {
  ['name','company','abn','acn','email','address'].forEach(k => {
    const val = document.getElementById('inv-'+k)?.value?.trim();
    if (val !== undefined) localStorage.setItem('gh-inv-'+k, val);
  });
  const el = document.getElementById('inv-save-confirm');
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 2000);
}
function loadCleaners() {
  return loadJSON('gh-cleaners');
}
function saveCleaners(list) {
  localStorage.setItem('gh-cleaners', JSON.stringify(list));
  scheduleAppDataSave('cleaners', list);
}
function addCleaner() {
  const name = document.getElementById('new-cleaner-name').value.trim();
  const phone = document.getElementById('new-cleaner-phone').value.trim();
  const email = document.getElementById('new-cleaner-email').value.trim();
  const pin = document.getElementById('new-cleaner-pin').value.trim();
  const roleEl = document.getElementById('new-cleaner-role');
  const role = roleEl ? roleEl.value : 'Cleaner';
  if (!name) { showBanner('⚠ Please enter a name','warn'); return; }
  if (pin && !/^\d{4}$/.test(pin)) { showBanner('⚠ PIN must be exactly 4 digits','warn'); return; }
  const people = loadCleaners();
  people.push({ id: Date.now(), name, phone, email: email || '', pin: pin || '', role });
  saveCleaners(people);
  document.getElementById('new-cleaner-name').value = '';
  document.getElementById('new-cleaner-phone').value = '';
  document.getElementById('new-cleaner-email').value = '';
  document.getElementById('new-cleaner-pin').value = '';
  populateCleanerSelect();
  populateContractorSelect();
  showBanner('✓ ' + name + ' added', 'ok');
  // Go back to team list
  openSettingsPanel('team');
}
function deleteCleaner(id) {
  saveCleaners(loadCleaners().filter(c => c.id !== id));
  renderTeamList();
  populateCleanerSelect();
  populateContractorSelect();
}
function renderCleanersList() {
  // Legacy — now handled by renderTeamList
  renderTeamList();
}
function renderTeamList() {
  const el = document.getElementById('team-list-container');
  if (!el) return;
  const people = loadCleaners();
  // Update subtitle on property cat
  const countRow = document.getElementById('team-count-row');
  if (countRow) countRow.textContent = people.length ? people.length + ' people' : 'Cleaners & contractors';
  if (!people.length) { el.innerHTML = ''; return; }
  const roleColors = {Cleaner:'var(--moss)',Plumber:'#1565C0',Electrician:'#E65100',Landscaper:'#2E7D32',Builder:'#6A1B9A',Handyman:'#00838F',Other:'var(--stone)'};
  el.innerHTML = `<div class="card" style="padding:0 16px;overflow:hidden;margin-bottom:12px">` +
    people.map((c, i) => `
    <div class="settings-cat-item" onclick="openCleanerProfile(${c.id})" ${i===people.length-1?'style="border-bottom:none"':''}>
      <div style="display:flex;align-items:center;gap:12px">
        <div style="width:36px;height:36px;border-radius:50%;background:${roleColors[c.role]||'var(--stone)'};color:white;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;flex-shrink:0">${c.name.charAt(0)}</div>
        <div>
          <div style="font-weight:500;font-size:14px">${c.name}</div>
          <div style="font-size:12px;color:var(--text-soft)">${c.role||'Cleaner'}${c.email?' · '+c.email:c.phone?' · '+c.phone:''}</div>
        </div>
      </div>
      <div style="color:#C7C7CC;font-size:20px;font-weight:300">›</div>
    </div>`).join('') + `</div>`;
}
function openCleanerProfile(id) {
  const c = loadCleaners().find(x => x.id === id);
  if (!c) return;
  const PERM_LABELS = [
    { key: 'firstName',  label: 'Guest first name' },
    { key: 'fullName',   label: 'Full guest name' },
    { key: 'guests',     label: 'Number of guests' },
    { key: 'notes',      label: 'Check-in notes' },
    { key: 'payout',     label: 'Cleaning fee / payout' },
  ];
  const perm = c.permissions || {};
  const link = cleanerLinkForId(c);
  const roleColors = {Cleaner:'var(--moss)',Plumber:'#1565C0',Electrician:'#E65100',Landscaper:'#2E7D32',Builder:'#6A1B9A',Handyman:'#00838F',Other:'var(--stone)'};
  document.getElementById('cleaner-profile-content').innerHTML = `
    <div class="card" style="margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px">
        <div style="width:48px;height:48px;border-radius:50%;background:${roleColors[c.role]||'var(--stone)'};color:white;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:700;flex-shrink:0">${c.name.charAt(0)}</div>
        <div style="flex:1">
          <div style="font-weight:700;font-size:17px">${c.name}</div>
          <div style="font-size:12px;color:var(--text-soft)">${c.role||'Cleaner'}</div>
        </div>
        <button onclick="deleteCleaner(${c.id})" style="background:none;border:none;color:var(--red);font-size:13px;cursor:pointer;padding:4px 8px">Remove</button>
      </div>
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-soft);margin-bottom:10px">Contact</div>
      <label>Mobile</label>
      <input type="tel" id="cp-phone-${c.id}" value="${c.phone||''}" placeholder="e.g. 0412 345 678">
      <label>Email</label>
      <input type="email" id="cp-email-${c.id}" value="${c.email||''}" placeholder="e.g. ${c.name.toLowerCase()}@email.com">
      <button class="btn-secondary" onclick="saveCleanerContact(${c.id})" style="margin-top:4px">Save Contact</button>
      <div id="cp-contact-confirm-${c.id}" style="font-size:12px;color:var(--moss);margin-top:4px;display:none">✓ Saved</div>
    </div>
    <div class="card" style="margin-bottom:10px">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-soft);margin-bottom:10px">🔐 App Access</div>
      <label>PIN (4 digits)</label>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <div style="font-size:24px;font-weight:700;color:var(--forest);letter-spacing:8px;flex:1">${c.pin||'—'}</div>
        ${c.pin?`<button onclick="clearCleanerPinById(${c.id})" style="font-size:11px;color:var(--red);background:none;border:1px solid var(--red);border-radius:20px;padding:4px 10px;cursor:pointer;white-space:nowrap">Clear</button>`:''}
      </div>
      <input type="text" inputmode="numeric" pattern="\\d*" id="pin-input-${c.id}" placeholder="Set 4-digit PIN" maxlength="4"
        style="font-size:20px;letter-spacing:8px;text-align:center;padding:12px;border:1.5px solid var(--stone);border-radius:var(--radius-sm);font-family:'DM Sans',sans-serif;background:white;margin-bottom:8px;color:var(--text);width:100%"
        oninput="this.value=this.value.replace(/\\D/g,'').slice(0,4)">
      <button onclick="saveCleanerPinById(${c.id})" class="btn-primary" style="width:100%">Save PIN</button>
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-soft);margin-top:14px;margin-bottom:8px">🔗 App Link</div>
      <div style="background:var(--mist);border-radius:var(--radius-sm);padding:10px 12px;font-size:12px;color:var(--forest);font-weight:500;word-break:break-all;margin-bottom:8px;border:1px solid var(--warm)">${link}</div>
      <button onclick="copyCleanerLinkById(${c.id})" class="btn-primary" style="width:100%">📋 Copy Link</button>
    </div>
    <div class="card">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-soft);margin-bottom:10px">👁 What They Can See</div>
      ${PERM_LABELS.map(p => `
      <div class="ios-toggle-row" style="padding:6px 0">
        <div class="ios-toggle-label" style="font-size:13px">${p.label}</div>
        <label class="ios-toggle"><input type="checkbox" ${perm[p.key]?'checked':''} onchange="saveCleanerPerm(${c.id},'${p.key}',this.checked)"><div class="ios-toggle-track"></div><div class="ios-toggle-thumb"></div></label>
      </div>`).join('')}
    </div>`;
  openSettingsPanel('cleaner-profile');
}
function saveCleanerContact(id) {
  const list = loadCleaners();
  const c = list.find(x => x.id === id);
  if (!c) return;
  const phoneEl = document.getElementById('cp-phone-' + id);
  const emailEl = document.getElementById('cp-email-' + id);
  if (phoneEl) c.phone = phoneEl.value.trim();
  if (emailEl) c.email = emailEl.value.trim();
  saveCleaners(list);
  const conf = document.getElementById('cp-contact-confirm-' + id);
  if (conf) { conf.style.display='block'; setTimeout(()=>conf.style.display='none',2000); }
  populateCleanerSelect();
}
function populateCleanerSelect() {
  const cleaners = loadCleaners().filter(c => !c.role || c.role === 'Cleaner');
  const sel = document.getElementById('clean-name');
  if (!sel) return;
  if (cleaners.length > 0) {
    const lastCleaner = localStorage.getItem('gh-last-cleaner') || '';
    sel.innerHTML = cleaners.map(c => `<option value="${c.name}" data-phone="${c.phone||''}" ${c.name===lastCleaner?'selected':''}>${c.name}${c.phone?' — '+c.phone:''}</option>`).join('');
  } else {
    sel.innerHTML = '<option value="">No cleaners saved — add in Settings</option>';
  }
}
function populateContractorSelect() {
  const people = loadCleaners();
  const sel = document.getElementById('maint-contractor-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">None</option>' + people.map(c => `<option value="${c.name}">${c.name} (${c.role||'Cleaner'})</option>`).join('');
}

// ── PROPERTY TAB NAVIGATION ───────────────────────────────────────────────
let propFilter = 'expenses';
function filterProperty(f, btn) {
  propFilter = f;
  document.querySelectorAll('#section-property .tab-row .tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  ['expenses','maintenance','inventory'].forEach(s => {
    document.getElementById('prop-' + s).style.display = s === f ? 'block' : 'none';
  });
  renderProperty();
}

function renderProperty() {
  if (propFilter === 'expenses') renderExpenses();
  if (propFilter === 'maintenance') { renderMaintenance(); populateContractorSelect(); }
  if (propFilter === 'inventory') renderInventory();
  populateExpenseCatSelect();
}

// ── EXPENSES ──────────────────────────────────────────────────────────────
function populateExpenseCatSelect() {
  const cats = getExpenseCats();
  const sel = document.getElementById('exp-category');
  if (sel) sel.innerHTML = cats.map(c => `<option value="${c}">${c}</option>`).join('');
}

// ── MERCHANT AUTOCOMPLETE ────────────────────────────────────────────────────
function merchantAutocomplete(val) {
  const box = document.getElementById('merchant-suggest');
  if (!box) return;
  const q = val.trim().toLowerCase();
  if (!q || q.length < 2) { box.style.display = 'none'; return; }

  // Gather unique past merchants sorted by most recent
  const seen = new Set();
  const matches = [];
  [...expenses]
    .sort((a,b) => new Date(b.date) - new Date(a.date))
    .forEach(e => {
      const m = (e.merchant || '').trim();
      if (!m || seen.has(m.toLowerCase())) return;
      if (m.toLowerCase().includes(q)) {
        seen.add(m.toLowerCase());
        matches.push({ merchant: m, description: e.description || '', category: e.category || '', amount: e.amount });
      }
    });

  if (!matches.length) { box.style.display = 'none'; return; }

  box.innerHTML = matches.slice(0, 4).map((m, i) => `
    <div onmousedown="selectMerchantSuggest(${i})" style="padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--warm);display:flex;justify-content:space-between;align-items:center"
      onmouseover="this.style.background='var(--mist)'" onmouseout="this.style.background='white'">
      <div>
        <div style="font-weight:600;font-size:13px">${m.merchant}</div>
        ${m.description ? `<div style="font-size:11px;color:var(--text-soft)">${m.description}</div>` : ''}
      </div>
      <div style="font-size:11px;color:var(--text-soft);text-align:right;flex-shrink:0;margin-left:8px">
        <div>${m.category}</div>
        <div>$${Math.abs(Number(m.amount)).toFixed(2)}</div>
      </div>
    </div>`).join('');

  // Store matches for selection
  box._matches = matches;
  box.style.display = 'block';
}

function selectMerchantSuggest(i) {
  const box = document.getElementById('merchant-suggest');
  const m = box._matches?.[i];
  if (!m) return;
  document.getElementById('exp-merchant').value = m.merchant;
  // Autofill description if empty
  const descEl = document.getElementById('exp-description');
  if (descEl && !descEl.value) descEl.value = m.description;
  // Always fill category — find exact match first, then closest
  const catEl = document.getElementById('exp-category');
  if (catEl && m.category) {
    const opts = [...catEl.options];
    // Try exact match
    const exact = opts.find(o => o.value === m.category);
    if (exact) {
      catEl.value = m.category;
    } else {
      // Try partial match (e.g. old "Cleaning/Repairs" → "Cleaning")
      const partial = opts.find(o =>
        o.value.toLowerCase().includes(m.category.toLowerCase().split(/[/& ]/)[0]) ||
        m.category.toLowerCase().includes(o.value.toLowerCase().split(/[/& ]/)[0])
      );
      if (partial) catEl.value = partial.value;
    }
  }
  box.style.display = 'none';
}

function hideMerchantSuggest() {
  const box = document.getElementById('merchant-suggest');
  if (box) box.style.display = 'none';
}

let expenseListExpanded = false;
function toggleExpenseList() {
  expenseListExpanded = !expenseListExpanded;
  const btn = document.getElementById('expenses-toggle-btn');
  if (btn) btn.textContent = expenseListExpanded ? 'Show less ↑' : 'Show all expenses ↓';
  renderExpenses();
}
function clearExpenseFilters() {
  const s = document.getElementById('expense-search'); if (s) s.value = '';
  const c = document.getElementById('expense-filter-cat'); if (c) c.value = '';
  const f = document.getElementById('expense-filter-from'); if (f) f.value = '';
  const t = document.getElementById('expense-filter-to'); if (t) t.value = '';
  expenseListExpanded = false;
  renderExpenses();
}

// ── AI EXPENSE ANALYSER ───────────────────────────────────────────────────
async function analyseExpenses() {
  const resultEl = document.getElementById('expense-analysis-result');

  if (!expenses.length) {
    resultEl.style.display = 'block';
    resultEl.innerHTML = '⚠️ No expenses to analyse.';
    return;
  }

  resultEl.style.display = 'block';
  resultEl.innerHTML = '⟳ Analysing your expenses...';

  // Build a clean summary for Claude — no photos/base64
  const expenseSummary = expenses.map(e => ({
    date: e.date,
    amount: e.amount,
    category: e.category,
    merchant: e.merchant || e.vendor || '',
    description: e.description || '',
    hasReceipt: !!(e.receiptUrl || e.driveLink || e.receiptData)
    // NOTE: never include receiptData or photo — base64 would blow up token count
  }));

  const totalSpend = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const byCategory = {};
  expenses.forEach(e => {
    const cat = e.category || 'Uncategorised';
    byCategory[cat] = (byCategory[cat] || 0) + (Number(e.amount) || 0);
  });

  const ignoreList = loadAIIgnoreList();
  const ignoreContext = ignoreList.length
    ? `\n\nUSER'S IGNORE LIST — do NOT flag these items, the user has reviewed and accepted them:\n${ignoreList.map(i => `- [${i.type}] ${i.label}${i.reason ? ' (reason: ' + i.reason + ')' : ''}`).join('\n')}`
    : '';

  const prompt = `You are an accountant reviewing Airbnb rental property expenses for Glenhaven, a 4-bedroom cottage in Katoomba NSW.

Total expenses: A$${totalSpend.toFixed(2)} across ${expenses.length} items.
By category: ${JSON.stringify(byCategory)}
All expenses: ${JSON.stringify(expenseSummary)}${ignoreContext}

Analyse these expenses and identify:
1. DUPLICATES — same vendor + similar amount within 30 days
2. ANOMALIES — amounts way above normal for that category
3. MISSING RECEIPTS — expenses over $50 with no receipt attached
4. UNCATEGORISED — items in "Other" or blank category that should be recategorised
5. RECURRING CHARGES — subscriptions or regular charges (flag if they seem forgotten)
6. INSIGHTS — 2-3 useful observations about spending patterns

Return ONLY valid JSON, no markdown:
{
  "duplicates": [{"date1":"","date2":"","merchant":"","amount":0,"note":""}],
  "anomalies": [{"date":"","merchant":"","amount":0,"category":"","note":""}],
  "missingReceipts": [{"date":"","merchant":"","amount":0}],
  "uncategorised": [{"date":"","merchant":"","amount":0,"suggestedCategory":""}],
  "recurring": [{"merchant":"","frequency":"","totalSpend":0,"note":""}],
  "insights": ["insight1","insight2"]
}
Return empty arrays if nothing found in a category.`;

  try {
    const { response, data } = await AIService.request({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      system: 'You are a JSON API. You must respond with only a valid JSON object. No prose, no markdown, no explanation. Only the raw JSON object.',
      messages: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: '{' }
      ]
    });

    if (!response.ok) {
      throw new Error(data.error?.message || 'HTTP ' + response.status);
    }
    // We pre-filled the assistant turn with '{', so prepend it back
    let text = '{' + (data.content?.[0]?.text || '');
    // Strip any stray markdown fences just in case
    text = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    // Extract just the JSON object
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) throw new Error('No JSON found in response');
    text = text.slice(jsonStart, jsonEnd + 1);
    // Remove trailing commas before } or ]
    text = text.replace(/,(\s*[}\]])/g, '$1');
    let parsed;
    try { parsed = JSON.parse(text); }
    catch(e) { throw new Error('Parse failed: ' + e.message + '\n\nRaw: ' + text.slice(0, 200)); }

    resultEl.innerHTML = renderExpenseAnalysis(parsed);

  } catch(err) {
    resultEl.innerHTML = '✗ Error: ' + (err.message || 'Unknown error');
  }
}

// ── AI IGNORE LIST ────────────────────────────────────────────────────────────
function loadAIIgnoreList() {
  return JSON.parse(localStorage.getItem('gh-ai-ignore') || '[]');
}
function saveAIIgnoreList(list) {
  localStorage.setItem('gh-ai-ignore', JSON.stringify(list));
  scheduleAppDataSave('aiIgnore', list);
}
function addAIIgnoreItem(type, key, label, reason) {
  const list = loadAIIgnoreList();
  const id = Date.now();
  list.push({ id, type, key, label, reason: reason || '', addedDate: new Date().toISOString().split('T')[0] });
  saveAIIgnoreList(list);
  showBanner('✓ Added to ignore list — won\'t flag this again', 'ok');
}
function removeAIIgnoreItem(id) {
  saveAIIgnoreList(loadAIIgnoreList().filter(i => i.id !== id));
  renderAIIgnoreList();
  showBanner('✓ Removed from ignore list', 'ok');
}
function renderAIIgnoreList() {
  const el = document.getElementById('ai-ignore-list-display');
  if (!el) return;
  const list = loadAIIgnoreList();
  if (!list.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--text-soft)">Nothing ignored yet. Tap "Ignore" on any flagged item in the expense analysis.</div>';
    return;
  }
  const typeLabel = { duplicate:'Duplicate', anomaly:'Anomaly', missing:'Missing Receipt', uncategorised:'Uncategorised', recurring:'Recurring' };
  el.innerHTML = list.map(item => `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--warm);gap:8px">
      <div style="flex:1;min-width:0">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-soft);margin-bottom:2px">${typeLabel[item.type]||item.type}</div>
        <div style="font-size:13px;font-weight:500;color:var(--text)">${item.label}</div>
        ${item.reason ? `<div style="font-size:11px;color:var(--text-soft);margin-top:2px;font-style:italic">${item.reason}</div>` : ''}
        <div style="font-size:11px;color:var(--text-soft);margin-top:2px">Added ${item.addedDate}</div>
      </div>
      <button onclick="removeAIIgnoreItem(${item.id})" style="font-size:11px;color:var(--red);background:none;border:1px solid var(--red);border-radius:20px;padding:4px 10px;cursor:pointer;font-family:'DM Sans',sans-serif;white-space:nowrap;flex-shrink:0">Remove</button>
    </div>`).join('');
}
function promptIgnore(type, key, label) {
  showAppModal({
    title: '🚫 Ignore This?',
    msg: `Add a reason why (optional) — this helps Claude understand your spending:`,
    confirmText: 'Ignore',
    cancelText: 'Cancel',
    hasInput: true,
    inputPlaceholder: 'e.g. Two separate orders same day',
    inputType: 'text'
  }).then(reason => {
    if (reason === false || reason === null) return;
    addAIIgnoreItem(type, key, label, typeof reason === 'string' ? reason : '');
  });
}

function renderExpenseAnalysis(data) {
  const fmt = n => '$' + Number(n).toLocaleString('en-AU', {minimumFractionDigits:2, maximumFractionDigits:2});
  let html = '<div style="font-weight:700;font-size:14px;margin-bottom:12px">🔍 Expense Analysis</div>';

  const ignoreBtn = (type, key, label) =>
    `<button onclick="promptIgnore('${type}','${key.replace(/'/g,"\\'")}','${label.replace(/'/g,"\\'")}');event.stopPropagation()"
      style="font-size:10px;color:var(--text-soft);background:var(--warm);border:none;border-radius:12px;padding:3px 8px;cursor:pointer;font-family:'DM Sans',sans-serif;margin-top:6px;display:inline-block">
      🚫 Ignore this
    </button>`;

  const row = (main, sub, badge, type, key) => `
    <div style="background:white;border-radius:8px;padding:10px 12px;margin-bottom:6px;border-left:3px solid currentColor">
      <div style="font-weight:600;font-size:13px">${main}</div>
      <div style="font-size:12px;color:var(--text-soft);margin-top:2px">${sub}</div>
      ${badge ? `<div style="font-size:11px;margin-top:4px;color:var(--text-soft);font-style:italic">${badge}</div>` : ''}
      ${ignoreBtn(type, key, main)}
    </div>`;

  const section = (icon, title, color, items, renderFn) => {
    if (!items?.length) return '';
    let s = `<div style="margin-bottom:14px">
      <div style="font-weight:600;font-size:12px;color:${color};margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">${icon} ${title} (${items.length})</div>`;
    items.forEach(item => { s += renderFn(item); });
    s += '</div>';
    return s;
  };

  html += section('⚠️', 'Possible Duplicates', '#E65100', data.duplicates,
    d => row(`${d.merchant} — ${fmt(d.amount)}`, `${d.date1} and ${d.date2}`, d.note,
      'duplicate', `${d.merchant}-${d.amount}-${d.date1}`));

  html += section('🚨', 'Anomalies', '#C0392B', data.anomalies,
    d => row(`${d.merchant} — ${fmt(d.amount)}`, `${d.date} · ${d.category}`, d.note,
      'anomaly', `${d.merchant}-${d.amount}-${d.date}`));

  html += section('🧾', 'Missing Receipts', '#7B1FA2', data.missingReceipts,
    d => row(`${d.merchant || 'Unknown'} — ${fmt(d.amount)}`, d.date, '',
      'missing', `${d.merchant}-${d.amount}-${d.date}`));

  html += section('📂', 'Uncategorised', '#1565C0', data.uncategorised,
    d => row(`${d.merchant || 'Unknown'} — ${fmt(d.amount)}`, d.date, `Suggested: ${d.suggestedCategory}`,
      'uncategorised', `${d.merchant}-${d.amount}-${d.date}`));

  html += section('🔄', 'Recurring Charges', '#2E7D32', data.recurring,
    d => row(`${d.merchant}`, `${d.frequency} · Total: ${fmt(d.totalSpend)}`, d.note,
      'recurring', `${d.merchant}-${d.frequency}`));

  if (data.insights?.length) {
    html += `<div style="margin-bottom:8px">
      <div style="font-weight:600;font-size:12px;color:var(--forest);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">💡 Insights</div>`;
    data.insights.forEach(i => {
      html += `<div style="background:white;border-radius:8px;padding:10px 12px;margin-bottom:6px;font-size:13px">${i}</div>`;
    });
    html += '</div>';
  }

  const hasAnything = data.duplicates?.length || data.anomalies?.length ||
    data.missingReceipts?.length || data.uncategorised?.length || data.recurring?.length;
  if (!hasAnything) html += '<div style="color:var(--forest);font-weight:600">✓ No issues found — your expenses look clean!</div>';

  html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
    <button onclick="showSection('settings');openSettingsCat('aitools');openSettingsPanel('ai-ignore')"
      style="font-size:11px;color:var(--text-soft);background:none;border:none;cursor:pointer;text-decoration:underline">View ignore list</button>
    <button onclick="document.getElementById('expense-analysis-result').style.display='none'"
      style="font-size:12px;color:var(--text-soft);background:none;border:none;cursor:pointer">✕ Close</button>
  </div>`;

  return html;
}

function renderExpenses() {
  // Set today's date as default if field is empty
  const expDateEl = document.getElementById('exp-date');
  if (expDateEl && !expDateEl.value) expDateEl.value = new Date().toISOString().split('T')[0];

  // ── Read filter values FIRST before any DOM manipulation ──────────────────
  const q     = (document.getElementById('expense-search')?.value || '').toLowerCase().trim();
  const catF  = document.getElementById('expense-filter-cat')?.value || '';
  const fromF = document.getElementById('expense-filter-from')?.value || '';
  const toF   = document.getElementById('expense-filter-to')?.value || '';
  const isFiltering = !!(q || catF || fromF || toF);

  // ── Populate category filter dropdown (preserve selected value) ───────────
  const catFilterEl = document.getElementById('expense-filter-cat');
  if (catFilterEl) {
    const allCats = [...new Set(expenses.map(e => e.category).filter(Boolean))].sort();
    catFilterEl.innerHTML = '<option value="">All Categories</option>' +
      allCats.map(c => `<option value="${c}" ${c===catF?'selected':''}>${c}</option>`).join('');
  }

  // ── Totals summary (always from ALL expenses, ignoring filters) ────────────
  const totals = {};
  let grandTotal = 0;
  expenses.forEach(e => {
    totals[e.category] = (totals[e.category] || 0) + Number(e.amount);
    grandTotal += Number(e.amount);
  });
  const summaryEl = document.getElementById('expense-summary');
  if (summaryEl) summaryEl.innerHTML = `
    <div class="card" style="padding:12px 16px">
      <div style="display:flex;justify-content:space-between;align-items:center;padding-bottom:10px;border-bottom:1px solid var(--warm);margin-bottom:8px">
        <div style="font-weight:700;font-size:15px">Total Expenses</div>
        <div style="font-family:'DM Serif Display',serif;font-size:22px;color:var(--red)">$${grandTotal.toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
      </div>
      ${Object.entries(totals).sort((a,b)=>b[1]-a[1]).map(([c,amt]) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--warm)">
          <div style="font-size:13px;color:var(--text)">${c}</div>
          <div style="font-size:13px;font-weight:600;color:var(--forest)">$${amt.toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
        </div>`).join('')}
    </div>`;

  const listEl = document.getElementById('expenses-list');
  if (!listEl) return;
  if (!expenses.length) { listEl.innerHTML = '<div style="text-align:center;padding:28px 16px"><div style="font-size:36px;margin-bottom:10px">💸</div><div style="font-weight:600;font-size:14px;margin-bottom:4px">No expenses yet</div><div style="font-size:12px;color:var(--text-soft)">Add your first expense below</div></div>'; return; }

  // ── Apply filters ──────────────────────────────────────────────────────────
  let filtered = [...expenses].sort((a,b) => { const da = a.date||''; const db = b.date||''; return db > da ? 1 : db < da ? -1 : 0; });
  if (q)     filtered = filtered.filter(e =>
    (e.merchant||'').toLowerCase().includes(q) ||
    (e.description||'').toLowerCase().includes(q) ||
    String(e.receiptNum||'').toLowerCase().includes(q));
  if (catF)  filtered = filtered.filter(e => e.category === catF);
  if (fromF) filtered = filtered.filter(e => e.date >= fromF);
  if (toF)   filtered = filtered.filter(e => e.date <= toF);

  if (!filtered.length) {
    listEl.innerHTML = '<div style="padding:12px 0;color:var(--text-soft);font-size:13px">No results found</div>';
    const sm = document.getElementById('expenses-show-more'); if (sm) sm.style.display = 'none';
    return;
  }

  // ── Show last 3 collapsed unless expanded or filtering ─────────────────────
  const showAll = expenseListExpanded || isFiltering;
  const visible = showAll ? filtered : filtered.slice(0, 3);
  const hasMore = !isFiltering && filtered.length > 3;

  const expRow = e => `
    <div class="expense-item" data-expense-id="${e.id}" style="-webkit-user-select:none;user-select:none">
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${e.merchant||'Unknown'}</div>
        <div style="font-size:12px;color:var(--text-soft);margin-top:1px">${e.description||''}</div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:4px;flex-wrap:wrap">
          <span class="expense-cat-badge">${e.category||''}</span>
          <span style="font-size:11px;color:var(--text-soft)">${fmt(e.date)}</span>
          ${e.driveLink?`<a href="${e.driveLink}" target="_blank" style="font-size:11px;color:var(--moss);font-weight:600">📎 View Receipt</a>`:''}
          ${!e.driveLink && e.receiptType && e.receiptType!=='missing'?`<span style="font-size:11px;color:var(--moss)">✓ ${e.receiptType==='e-receipt'?'e-Receipt':'Printed'}</span>`:''}
          ${e.awaitingReceipt?`<span style="font-size:11px;color:var(--amber)">⚠ Awaiting receipt</span>`:''}
          ${!e.driveLink && (!e.receiptType || e.receiptType==='missing')?`<span style="font-size:11px;color:var(--red)">✕ No receipt</span>`:''}
        </div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0">
        <div style="font-weight:700;font-size:15px;color:${Number(e.amount)<0?'var(--moss)':'var(--red)'}">$${Math.abs(Number(e.amount)).toFixed(2)}</div>
        <div style="display:flex;gap:6px">
          <button onclick="openExpenseEdit(${e.id})" style="font-size:11px;color:var(--forest);background:var(--warm);border:none;border-radius:6px;padding:3px 8px;cursor:pointer;font-family:'DM Sans',sans-serif">Edit</button>
          <button onclick="deleteExpense(${e.id})" style="font-size:13px;color:var(--red);background:#FEF2F2;border:none;border-radius:6px;cursor:pointer;padding:5px 10px;font-family:'DM Sans',sans-serif">🗑</button>
        </div>
      </div>
    </div>`;

  listEl.innerHTML = visible.map(expRow).join('');
  animateList('#expenses-list');
  setTimeout(attachLongPress, 60);

  // Show/hide "show more" toggle
  const sm = document.getElementById('expenses-show-more');
  const tb = document.getElementById('expenses-toggle-btn');
  if (sm) {
    sm.style.display = hasMore || (expenseListExpanded && filtered.length > 3) ? 'block' : 'none';
    if (tb) tb.textContent = expenseListExpanded ? 'Show less ↑' : `Show all ${filtered.length} expenses ↓`;
  }
}

function addExpense(opts = {}) {
  const merchant = opts.merchant || document.getElementById('exp-merchant').value.trim();
  const amount = opts.amount || parseFloat(document.getElementById('exp-amount').value);
  const date = opts.date || document.getElementById('exp-date').value || new Date().toISOString().split('T')[0];
  const category = opts.category || document.getElementById('exp-category').value;
  if (!merchant || !amount) { showBanner('⚠ Please fill in merchant and amount', 'warn'); return; }
  if (expensePhotoConverting) { showBanner('⟳ Please wait — receipt is still converting...', 'warn'); return; }
  // Capture both photo and mediaType BEFORE any clearing happens
  const photoForUpload = expensePhotoBase64 || null;
  const mediaTypeForUpload = expensePhotoMediaType || 'image/jpeg';
  const exp = {
    id: Date.now(),
    merchant,
    description: opts.description || document.getElementById('exp-description').value.trim(),
    amount,
    date,
    category,
    receiptType: opts.receiptType || document.getElementById('exp-receipt-type').value,
    receiptNum: opts.receiptNum || document.getElementById('exp-receipt-num').value.trim(),
    photo: null,  // never store in localStorage — too large, causes silent crash
    awaitingReceipt: photoForUpload ? false : (opts.awaitingReceipt || false),
    driveLink: null
  };
  expenses.push(exp);
  try { savePropertyData(); } catch(storageErr) {
    showBanner('⚠ Storage full — expense saved without photo', 'warn');
  }

  // Try to upload photo to Drive and push to sheet
  const expWithPhoto = Object.assign({}, exp, { photo: photoForUpload, _mediaType: mediaTypeForUpload });
  saveExpenseToDriveAndSheet(expWithPhoto);

  if (!opts.silent) {
    // Clear all form fields
    ['exp-merchant','exp-description','exp-amount','exp-receipt-num'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    document.getElementById('exp-date').value = new Date().toISOString().split('T')[0];
    // Reset dropdowns to first option
    const catSel = document.getElementById('exp-category');
    if (catSel) catSel.selectedIndex = 0;
    const typeSel = document.getElementById('exp-receipt-type');
    if (typeSel) typeSel.selectedIndex = 0;
    // Clear photo completely
    expensePhotoBase64 = null;
    const photoInput = document.getElementById('expense-file-input');
    if (photoInput) photoInput.value = '';
    document.getElementById('expense-photo-preview').style.display = 'none';
    document.getElementById('expense-extract-status').style.display = 'none';
    // Scroll back to top of add form
    const addCard = document.querySelector('#prop-expenses .card');
    if (addCard) addCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    renderExpenses();
    if (!exp.photo) showBanner('✓ Expense saved', 'ok');
    else if (!localStorage.getItem('gh-drive-token')) showBanner('⚠ Expense saved locally — connect Google Drive in Settings to save receipt', 'warn');
    else showBanner('⟳ Uploading receipt...', 'info');
  }
  return exp;
}

async function saveExpenseToDriveAndSheet(exp) {
  const driveToken = getDriveToken();
  const scriptUrl = localStorage.getItem('gh-script-url') || DEFAULT_SCRIPT_URL;

  // ── Upload to Drive first so we can include the link in the sheet row ──────
  let driveLink = null;
  if (exp.photo) {
    if (!driveToken) {
      showBanner('⚠ Connect Google Drive in Settings to save receipts to cloud', 'warn');
    } else {
      try {
        showBanner('⟳ Uploading receipt to Google Drive...', 'info');
        const imgBlob = await receiptImageToPDF(exp);
        const fileName = generateReceiptFileName(exp);
        const folderId = await getOrCreateDriveFolder(driveToken);
        const metadata = { name: fileName, mimeType: 'application/pdf', parents: folderId ? [folderId] : [] };
        const form = new FormData();
        form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
        form.append('file', imgBlob);
        const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + driveToken },
          body: form
        });
        if (res.status === 401) {
          localStorage.removeItem('gh-drive-token');
          localStorage.removeItem('gh-drive-token-expiry');
          showBanner('⚠ Google Drive session expired — reconnect in Settings', 'warn');
        } else if (res.ok) {
          const file = await res.json();
          if (file.id) {
            await setDriveFilePublic(file.id, driveToken);
            driveLink = 'https://drive.google.com/file/d/' + file.id + '/view';
            // Save link locally
            const saved = expenses.find(e => e.id === exp.id);
            if (saved) { saved.driveLink = driveLink; savePropertyData(); renderExpenses(); }
            showBanner('✓ Receipt saved to Google Drive', 'ok');
          } else {
            showBanner('⚠ Drive upload failed — no file ID returned', 'warn');
          }
        } else {
          const errData = await res.json().catch(() => ({}));
          showBanner('⚠ Drive error ' + res.status + ': ' + ((errData.error && errData.error.message) || 'unknown'), 'warn');
        }
      } catch(e) {
        showBanner('⚠ Drive upload failed: ' + e.message, 'warn');
      }
    }
  }

  // ── Push to sheet with Drive link already included in one write ──────────
  if (scriptUrl && scriptUrl.includes('script.google.com')) {
    try {
      const expForSheet = Object.assign({}, exp, { driveLink: driveLink || exp.driveLink || '' });
      delete expForSheet.photo;
      delete expForSheet._mediaType;
      // Use POST to avoid GET URL length limit (Drive links push GET over ~2KB)
      const res = await fetch(scriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'addExpense', data: JSON.stringify(expForSheet) })
      });
      const json = await res.json();
      if (json.status === 'ok') showBanner('✓ Expense saved to sheet', 'ok');
      else showBanner('⚠ Sheet sync: ' + json.status, 'warn');
    } catch(e) {
      showBanner('⚠ Sheet sync failed — check script URL in Settings', 'warn');
    }
  }
}

function generateReceiptFileName(exp) {
  const d = exp.date ? exp.date.replace(/-/g,'').substring(2) : '';
  const merchant = (exp.merchant||'Receipt').replace(/[^a-zA-Z0-9]/g,'_').substring(0,30);
  const uid = String(exp.id || Date.now()).slice(-6);
  return merchant + '_' + d + '_' + uid + '.pdf';
}

async function receiptImageToPDF(exp) {
  // Convert the attached image/photo to a single-page PDF blob.
  // Uses exp._mediaType and exp.photo (captured at submit time) — never reads globals
  // which may have been cleared by the time this async function executes.
  const mediaType = exp._mediaType || 'image/jpeg';
  const photoData = exp.photo || null;

  if (mediaType === 'application/pdf' && photoData) {
    // Already a PDF — decode and return as-is
    const bytes = atob(photoData);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    return new Blob([arr], { type: 'application/pdf' });
  }

  // Render the image onto a canvas (A4 proportions: 794×1123)
  return new Promise((resolve, reject) => {
    const pageW = 794, pageH = 1123;
    const canvas = document.createElement('canvas');
    canvas.width = pageW; canvas.height = pageH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, pageW, pageH);

    const drawAndExport = (img) => {
      if (img) {
        const maxW = pageW - 40, maxH = pageH - 40;
        let w = img.width, h = img.height;
        if (w > maxW) { h = h * maxW / w; w = maxW; }
        if (h > maxH) { w = w * maxH / h; h = maxH; }
        ctx.drawImage(img, (pageW - w) / 2, 20, w, h);
      }
      // Get JPEG data URL from canvas, then wrap in a minimal single-image PDF
      const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.92);
      const jpegBase64 = jpegDataUrl.split(',')[1];
      const jpegBytes = atob(jpegBase64);
      const jpegLen = jpegBytes.length;

      // Build a minimal valid PDF with the JPEG embedded as an image
      const obj1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
      const obj2 = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';
      const obj3 = `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Contents 4 0 R /Resources << /XObject << /Img 5 0 R >> >> >>\nendobj\n`;
      const streamContent = `q ${pageW} 0 0 ${pageH} 0 0 cm /Img Do Q`;
      const obj4 = `4 0 obj\n<< /Length ${streamContent.length} >>\nstream\n${streamContent}\nendstream\nendobj\n`;
      const obj5header = `5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pageW} /Height ${pageH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegLen} >>\nstream\n`;
      const obj5footer = '\nendstream\nendobj\n';

      // Assemble PDF bytes
      const header = '%PDF-1.4\n';
      const enc = new TextEncoder();
      const parts = [
        enc.encode(header),
        enc.encode(obj1),
        enc.encode(obj2),
        enc.encode(obj3),
        enc.encode(obj4),
        enc.encode(obj5header),
      ];
      // JPEG bytes as Uint8Array
      const jpegArr = new Uint8Array(jpegLen);
      for (let i = 0; i < jpegLen; i++) jpegArr[i] = jpegBytes.charCodeAt(i);
      parts.push(jpegArr);
      parts.push(enc.encode(obj5footer));

      // Calculate xref offsets
      let offset = 0;
      const offsets = [];
      const preXref = parts.slice(0, -1); // everything before xref
      let runningOffset = header.length;
      offsets.push(runningOffset); runningOffset += obj1.length;
      offsets.push(runningOffset); runningOffset += obj2.length;
      offsets.push(runningOffset); runningOffset += obj3.length;
      offsets.push(runningOffset); runningOffset += obj4.length;
      offsets.push(runningOffset);

      const xref = `xref\n0 6\n0000000000 65535 f \n${offsets.map(o=>String(o).padStart(10,'0')+' 00000 n ').join('\n')}\n`;
      const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${runningOffset + obj5header.length + jpegLen + obj5footer.length}\n%%EOF`;

      parts.push(enc.encode(xref + trailer));

      // Merge all parts into a single Blob
      resolve(new Blob(parts, { type: 'application/pdf' }));
    };

    if (photoData) {
      const img = new Image();
      img.onload = () => drawAndExport(img);
      img.onerror = () => drawAndExport(null);
      img.src = 'data:' + mediaType + ';base64,' + photoData;
    } else {
      drawAndExport(null);
    }
  });
}

async function getOrCreateDriveFolder(token) {
  // Use cached folder ID if available
  const cached = localStorage.getItem('gh-drive-folder-id');
  if (cached) return cached;
  try {
    const q = encodeURIComponent("name='Glenhaven Receipts' and mimeType='application/vnd.google-apps.folder' and trashed=false");
    const search = await fetch('https://www.googleapis.com/drive/v3/files?q=' + q, {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (search.status === 401) return null; // token expired — handled by caller
    const data = await search.json();
    if (data.files && data.files.length > 0) {
      localStorage.setItem('gh-drive-folder-id', data.files[0].id);
      return data.files[0].id;
    }
    // Create the folder
    const create = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Glenhaven Receipts', mimeType: 'application/vnd.google-apps.folder' })
    });
    const folder = await create.json();
    if (folder.id) {
      localStorage.setItem('gh-drive-folder-id', folder.id);
      return folder.id;
    }
    return null;
  } catch(e) { return null; }
}

async function setDriveFilePublic(fileId, token) {
  // Make the file viewable by anyone with the link
  try {
    await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'reader', type: 'anyone' })
    });
  } catch(e) { /* non-fatal — link still works if user is signed in */ }
}

async function deleteExpense(id) {
  const ok = await showAppModal({ title: 'Delete Expense', msg: 'Remove this expense? This cannot be undone.', confirmText: 'Delete', confirmColor: 'var(--red)' });
  if (!ok) return;
  const exp = expenses.find(e => String(e.id) === String(id));
  expenses = expenses.filter(e => String(e.id) !== String(id));
  savePropertyData();
  renderExpenses();
  showBanner('✓ Expense deleted', 'ok');

  // Delete from Google Sheet
  if (exp) {
    const scriptUrl = localStorage.getItem('gh-script-url') || DEFAULT_SCRIPT_URL;
    if (scriptUrl && scriptUrl.includes('script.google.com')) {
      const expForSheet = { date: exp.date, merchant: exp.merchant, amount: exp.amount };
      fetch(scriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'deleteExpense', data: JSON.stringify(expForSheet) })
      })
        .then(r => r.json())
        .then(json => {
          if (json.status === 'not_found') showBanner('⚠ Expense deleted locally — row not found in sheet (may already be gone)', 'warn');
          else if (json.status !== 'ok') showBanner('⚠ Deleted locally but not from sheet: ' + json.status, 'warn');
        })
        .catch(() => showBanner('⚠ Deleted locally — sheet connection failed', 'warn'));
    }

    // Move receipt to Superseded folder in Google Drive if a link exists
    if (exp.driveLink) {
      const token = getDriveToken();
      if (!token) {
        showBanner('⚠ Receipt not moved in Drive — connect Google Drive in Settings', 'warn');
      } else {
        const match = exp.driveLink.match(/\/d\/([^/]+)/);
        if (match) {
          const fileId = match[1];
          // Get or create the Superseded folder, then move the file into it
          (async () => {
            try {
              // Find or create Superseded folder
              const q = encodeURIComponent("name='Superseded' and mimeType='application/vnd.google-apps.folder' and trashed=false");
              const search = await fetch('https://www.googleapis.com/drive/v3/files?q=' + q, {
                headers: { Authorization: 'Bearer ' + token }
              });
              if (search.status === 401) { showBanner('⚠ Receipt not moved — Google token expired, reconnect in Settings', 'warn'); return; }
              const searchData = await search.json();
              let supersededId = searchData.files && searchData.files.length > 0 ? searchData.files[0].id : null;
              if (!supersededId) {
                // Create it
                const create = await fetch('https://www.googleapis.com/drive/v3/files', {
                  method: 'POST',
                  headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ name: 'Superseded', mimeType: 'application/vnd.google-apps.folder' })
                });
                if (!create.ok) { showBanner('⚠ Could not create Superseded folder in Drive', 'warn'); return; }
                const createData = await create.json();
                supersededId = createData.id;
              }
              // Get current parents of the file
              const meta = await fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?fields=parents', {
                headers: { Authorization: 'Bearer ' + token }
              });
              if (meta.status === 404) { showBanner('⚠ Receipt not found in Drive — may have already been moved', 'warn'); return; }
              if (!meta.ok) { showBanner('⚠ Could not move receipt in Drive — error ' + meta.status, 'warn'); return; }
              const metaData = await meta.json();
              const currentParents = (metaData.parents || []).join(',');
              // Move: add new parent, remove old ones
              const move = await fetch(
                `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${supersededId}&removeParents=${currentParents}`,
                { method: 'PATCH', headers: { Authorization: 'Bearer ' + token } }
              );
              if (move.status === 401) showBanner('⚠ Receipt not moved — Google token expired, reconnect in Settings', 'warn');
              else if (!move.ok) showBanner('⚠ Could not move receipt to Superseded — error ' + move.status, 'warn');
            } catch(e) {
              showBanner('⚠ Receipt not moved in Drive — network error', 'warn');
            }
          })();
        }
      }
    }
  }
}

async function migrateCategoriesInSheet() {
  const scriptUrl = localStorage.getItem('gh-script-url') || DEFAULT_SCRIPT_URL;
  if (!scriptUrl || !scriptUrl.includes('script.google.com')) {
    showBanner('⚠ Set your Apps Script URL in Settings first', 'warn'); return;
  }
  const resultEl = document.getElementById('push-expenses-result');
  if (resultEl) { resultEl.style.display = 'block'; resultEl.style.background = '#E3F2FD'; resultEl.style.color = '#1565C0'; resultEl.textContent = '⟳ Migrating categories in sheet...'; }
  showBanner('⟳ Migrating categories...', 'info');
  try {
    const json = await sheetPost(scriptUrl, 'migrateCategories', {});
    if (json.status === 'ok') {
      const msg = `✓ Done — ${json.updated} row${json.updated !== 1 ? 's' : ''} updated`;
      showBanner(msg, 'ok');
      if (resultEl) { resultEl.style.background = '#E8F5E9'; resultEl.style.color = '#2E7D32'; resultEl.textContent = msg; }
      await pullExpensesFromSheet();
    } else {
      showBanner('⚠ Migration failed: ' + (json.status || 'unknown'), 'warn');
    }
  } catch(e) {
    const msg = '⚠ Migration failed: ' + (e.message || 'network error');
    showBanner(msg, 'warn');
    if (resultEl) { resultEl.style.display = 'block'; resultEl.style.background = '#FEF2F2'; resultEl.style.color = '#C0392B'; resultEl.textContent = msg; }
  }
}

// ── BACKUP & RESTORE ──────────────────────────────────────────────────────────
function buildBackupPayload() {
  return {
    version: 1,
    timestamp: new Date().toISOString(),
    bookings,
    cleans,
    notes,
    expenses: expenses.map(e => { const c = Object.assign({}, e); delete c.photo; return c; }),
    maintenance,
    inventory,
    cleaners: loadCleaners(),
    settings: {
      propertyData:    localStorage.getItem('gh-property-data'),
      scriptUrl:       localStorage.getItem('gh-script-url'),
      gDriveClientId:  localStorage.getItem('gh-gdrive-client-id'),
      cleaningFeeDefault: localStorage.getItem('gh-cleaning-fee'),
      smsTemplate:     localStorage.getItem('gh-sms-template'),
      expenseCats:     localStorage.getItem('gh-expense-cats'),
      invoiceSettings: localStorage.getItem('gh-invoice-settings'),
    }
  };
}

async function saveBackup() {
  const scriptUrl = localStorage.getItem('gh-script-url') || DEFAULT_SCRIPT_URL;
  if (!scriptUrl || !scriptUrl.includes('script.google.com')) {
    showBanner('⚠ Set your Apps Script URL in Settings → Google Sheets first', 'warn'); return;
  }
  const resultEl = document.getElementById('backup-result');
  if (resultEl) { resultEl.style.display = 'block'; resultEl.style.background = '#E3F2FD'; resultEl.style.color = '#1565C0'; resultEl.textContent = '⟳ Saving backup to Google Drive...'; }
  showBanner('⟳ Saving backup...', 'info');
  try {
    const payload = buildBackupPayload();
    const body = JSON.stringify({ action: 'saveBackup', data: JSON.stringify(payload) });
    // Use text/plain to avoid CORS preflight — Apps Script parses the body manually
    const resp = await fetch(scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body
    });
    const json = await resp.json();
    if (json.status === 'ok') {
      const now = new Date().toLocaleString('en-AU', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
      localStorage.setItem('gh-last-backup', now);
      const el = document.getElementById('backup-last-time');
      if (el) el.textContent = now;
      const msg = `✓ Backup saved — ${json.filename}`;
      showBanner(msg, 'ok');
      if (resultEl) { resultEl.style.background = '#E8F5E9'; resultEl.style.color = '#2E7D32'; resultEl.textContent = msg; }
    } else {
      throw new Error(json.message || json.status);
    }
  } catch(e) {
    const msg = '⚠ Backup failed: ' + (e.message || 'network error');
    showBanner(msg, 'warn');
    if (resultEl) { resultEl.style.background = '#FEF2F2'; resultEl.style.color = '#C0392B'; resultEl.textContent = msg; }
  }
}

async function listBackups() {
  const scriptUrl = localStorage.getItem('gh-script-url') || DEFAULT_SCRIPT_URL;
  if (!scriptUrl || !scriptUrl.includes('script.google.com')) {
    showBanner('⚠ Set your Apps Script URL in Settings → Google Sheets first', 'warn'); return;
  }
  const listEl = document.getElementById('backup-list');
  if (listEl) listEl.innerHTML = '<div style="font-size:13px;color:var(--text-soft)">⟳ Loading backups...</div>';
  try {
    const json = await sheetPost(scriptUrl, 'listBackups', {});
    if (json.status === 'ok') {
      const backups = json.backups || [];
      if (!backups.length) {
        if (listEl) listEl.innerHTML = '<div style="font-size:13px;color:var(--text-soft)">No backups found. Tap Backup Now to create your first one.</div>';
        return;
      }
      if (listEl) listEl.innerHTML = backups.map(b => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--warm)">
          <div>
            <div style="font-size:13px;font-weight:600">${b.date}</div>
            <div style="font-size:11px;color:var(--text-soft)">${(b.size/1024).toFixed(1)} KB</div>
          </div>
          <button onclick="restoreBackup('${b.id}', '${b.date}')"
            style="font-size:12px;background:#FEF2F2;color:var(--red);border:none;border-radius:8px;padding:7px 12px;cursor:pointer;font-weight:600;font-family:'DM Sans',sans-serif">
            Restore
          </button>
        </div>`).join('');
    } else {
      throw new Error(json.message || json.status);
    }
  } catch(e) {
    if (listEl) listEl.innerHTML = '<div style="font-size:13px;color:var(--red)">⚠ Could not load backups: ' + (e.message || 'network error') + '</div>';
  }
}

async function restoreBackup(fileId, dateLabel) {
  showAppModal(
    `Restore backup from ${dateLabel}?`,
    `This will replace ALL current data — bookings, expenses, cleans, notes, everything — with this backup. This cannot be undone.`,
    async () => {
      const scriptUrl = localStorage.getItem('gh-script-url') || DEFAULT_SCRIPT_URL;
      showBanner('⟳ Restoring backup...', 'info');
      try {
        const url = scriptUrl + '?action=restoreBackup&fileId=' + encodeURIComponent(fileId);
        const resp = await fetch(url);
        const json = await resp.json();
        if (json.status === 'ok' && json.data) {
          const d = json.data;
          bookings    = d.bookings    || [];
          cleans      = d.cleans      || [];
          notes       = d.notes       || [];
          expenses    = (d.expenses   || []).map(e => { if (!e.photo) e.photo = null; return e; });
          maintenance = d.maintenance || [];
          inventory   = d.inventory   || [];
          if (d.cleaners) saveCleaners(d.cleaners);
          if (d.settings) {
            if (d.settings.propertyData)       localStorage.setItem('gh-property-data',    d.settings.propertyData);
            if (d.settings.scriptUrl)          localStorage.setItem('gh-script-url',        d.settings.scriptUrl);
            if (d.settings.gDriveClientId)     localStorage.setItem('gh-gdrive-client-id',  d.settings.gDriveClientId);
            if (d.settings.cleaningFeeDefault)  localStorage.setItem('gh-cleaning-fee',      d.settings.cleaningFeeDefault);
            if (d.settings.smsTemplate)        localStorage.setItem('gh-sms-template',      d.settings.smsTemplate);
            if (d.settings.expenseCats)        localStorage.setItem('gh-expense-cats',      d.settings.expenseCats);
            if (d.settings.invoiceSettings)    localStorage.setItem('gh-invoice-settings',  d.settings.invoiceSettings);
          }
          save();
          savePropertyData();
          renderAll();
          showBanner(`✓ Restored backup from ${dateLabel}`, 'ok');
        } else {
          throw new Error(json.message || json.status);
        }
      } catch(e) {
        showBanner('⚠ Restore failed: ' + (e.message || 'network error'), 'warn');
      }
    },
    'Restore', 'Cancel'
  );
}

async function pullExpensesFromSheet() {
  const scriptUrl = localStorage.getItem('gh-script-url') || DEFAULT_SCRIPT_URL;
  if (!scriptUrl || !scriptUrl.includes('script.google.com')) {
    showBanner('⚠ Set your Apps Script URL in Settings → Google Sheets first', 'warn');
    return;
  }
  showBanner('⟳ Pulling expenses from sheet...', 'info');
  try {
    const json = await sheetPost(scriptUrl, 'getExpenses', {});
    if (json.status === 'ok' && json.expenses) {
      if (json.expenses.length > 0) {}
      let added = 0, linksUpdated = 0;
      json.expenses.forEach(row => {
        // Each row: [date, merchant, description, category, amount, receiptNum, receiptType, driveLink]
        if (!row[0] || !row[1]) return; // skip empty rows
        const amount = parseFloat(String(row[4]||'').replace(/[^0-9.-]/g,'')) || 0;
        const rowDate = toISO(String(row[0] || '').trim()); // normalise once
        // Deduplicate by normalised date+merchant+amount (both sides now ISO)
        const exists = expenses.find(e =>
          e.date === rowDate && e.merchant === row[1] && Math.abs(Number(e.amount) - amount) < 0.01);
        if (!exists) {
          expenses.push({
            id: Date.now() + Math.random(),
            date: rowDate,
            merchant: row[1] || '',
            description: row[2] || '',
            category: row[3] || 'Other',
            amount,
            receiptNum: row[5] || '',
            receiptType: String(row[6] || '').toLowerCase().trim(),
            driveLink: row[7] || null,
            photo: null,
            awaitingReceipt: false
          });
          added++;
        } else if (row[7] && row[7].startsWith('https://') && (!exists.driveLink || !exists.driveLink.startsWith('https://'))) {
          // Sheet has a valid URL but local is missing or broken — fix it, then leave it alone
          exists.driveLink = row[7];
          linksUpdated++;
        }
      });
      savePropertyData();
      renderExpenses();
      const parts = [`${added} new`];
      if (linksUpdated) parts.push(`${linksUpdated} receipt link${linksUpdated > 1 ? 's' : ''} synced`);
      showBanner(`✓ Pulled ${json.expenses.length} rows — ${parts.join(', ')}`, 'ok');
    } else {
      showBanner('⚠ Pull failed: ' + (json.status || 'no data'), 'warn');
    }
  } catch(e) { showBanner('⚠ Pull failed — check script URL in Settings', 'warn'); }
}

// ── RECEIPT PHOTO READER ──────────────────────────────────────────────────
let expensePhotoBase64 = null;
let expensePhotoMediaType = 'image/jpeg';
let expensePhotoConverting = false; // true while async canvas conversion is in progress

function attachExpensePhoto(input) {
  const file = input.files[0];
  if (!file) return;
  expensePhotoMediaType = 'image/jpeg';
  const reader = new FileReader();
  reader.onload = function(e) {
    const img = new Image();
    img.onload = function() {
      // Resize to max 4000px — same limit as booking screenshot
      const MAX = 4000;
      let w = img.width, h = img.height;
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
        else { w = Math.round(w * MAX / h); h = MAX; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob(blob => {
        const fr = new FileReader();
        fr.onload = function(ev) {
          expensePhotoBase64 = ev.target.result.split(',')[1];
          document.getElementById('expense-photo-img').src = ev.target.result;
          document.getElementById('expense-photo-preview').style.display = 'block';
          const status = document.getElementById('expense-extract-status');
          status.style.display = 'none'; status.textContent = '';
        };
        fr.readAsDataURL(blob);
      }, 'image/jpeg', 0.92);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function attachExpenseFile(input) {
  const file = input.files[0];
  if (!file) return;
  const isPDF = file.type === 'application/pdf';
  const pdfDiv = document.getElementById('expense-pdf-preview');
  const img = document.getElementById('expense-photo-img');
  const status = document.getElementById('expense-extract-status');

  if (isPDF) {
    // Already a PDF — read as-is
    const reader = new FileReader();
    reader.onload = function(e) {
      expensePhotoBase64 = e.target.result.split(',')[1];
      expensePhotoMediaType = 'application/pdf';
      img.style.display = 'none';
      pdfDiv.style.display = 'block';
      pdfDiv.textContent = '📄 ' + file.name;
      document.getElementById('expense-photo-preview').style.display = 'block';
      status.style.display = 'none'; status.textContent = '';
    };
    reader.readAsDataURL(file);
  } else {
    // Image — convert to PDF via canvas immediately
    const reader = new FileReader();
    reader.onload = function(e) {
      const dataUrl = e.target.result;
      expensePhotoConverting = true; // block submission until done
      pdfDiv.style.display = 'block';
      pdfDiv.textContent = '⟳ Converting to PDF...';
      img.style.display = 'none';
      document.getElementById('expense-photo-preview').style.display = 'block';
      status.style.display = 'none'; status.textContent = '';

      const image = new Image();
      image.onload = function() {
        const canvas = document.createElement('canvas');
        const pageW = 794, pageH = 1123;
        canvas.width = pageW; canvas.height = pageH;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, pageW, pageH);
        const maxW = pageW - 40, maxH = pageH - 40;
        let w = image.width, h = image.height;
        if (w > maxW) { h = h * maxW / w; w = maxW; }
        if (h > maxH) { w = w * maxH / h; h = maxH; }
        ctx.drawImage(image, (pageW - w) / 2, 20, w, h);
        canvas.toBlob(function(blob) {
          const fr = new FileReader();
          fr.onload = function(ev) {
            expensePhotoBase64 = ev.target.result.split(',')[1];
            expensePhotoMediaType = 'image/jpeg';
            expensePhotoConverting = false; // ready
            pdfDiv.textContent = '📄 Receipt (converted to PDF)';
          };
          fr.readAsDataURL(blob);
        }, 'image/jpeg', 0.92);
      };
      image.onerror = function() {
        expensePhotoConverting = false;
        pdfDiv.textContent = '⚠ Could not load image';
      };
      image.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }
}

function clearExpensePhoto() {
  expensePhotoBase64 = null;
  expensePhotoMediaType = 'image/jpeg';
  expensePhotoConverting = false;
  document.getElementById('expense-photo-preview').style.display = 'none';
  const fileInput = document.getElementById('expense-file-input');
  if (fileInput) fileInput.value = '';
  const pdfDiv = document.getElementById('expense-pdf-preview');
  if (pdfDiv) { pdfDiv.style.display = 'none'; pdfDiv.textContent = ''; }
  const img = document.getElementById('expense-photo-img');
  if (img) img.style.display = 'block';
  document.getElementById('expense-extract-status').style.display = 'none';
}

async function extractExpenseFromReceipt() {
  const status = document.getElementById('expense-extract-status');
  status.style.display = 'block';
  if (!expensePhotoBase64) {
    status.style.background = '#FFF8E1'; status.style.color = '#E65100';
    status.textContent = '⚠ Please attach a receipt image or PDF first';
    return;
  }
  status.style.background = '#FFF8E1'; status.style.color = '#E65100';
  status.textContent = '⟳ Reading receipt...';
  try {
    const cats = getExpenseCats();
    const { response, data } = await AIService.request({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          expensePhotoMediaType === 'application/pdf'
            ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: expensePhotoBase64 } }
            : { type: 'image', source: { type: 'base64', media_type: expensePhotoMediaType, data: expensePhotoBase64 } },
          { type: 'text', text: `This is a receipt or invoice. Return ONLY a JSON object with no markdown. Fields: merchant (store name), description (brief), amount (number, no $ sign, negative if refund), date (YYYY-MM-DD), receiptNum (or null), category (best match from: ${cats.join(', ')}). Null for missing.` }
        ]
      }]
    });
    if (!response.ok) throw new Error(data.error?.message || 'API error');
    const parsed = JSON.parse(data.content?.[0]?.text?.replace(/`/g,'').trim() || '{}');
    if (parsed.merchant) document.getElementById('exp-merchant').value = parsed.merchant;
    if (parsed.description) document.getElementById('exp-description').value = parsed.description;
    if (parsed.amount) document.getElementById('exp-amount').value = parsed.amount;
    if (parsed.date) document.getElementById('exp-date').value = parsed.date;
    if (parsed.receiptNum) document.getElementById('exp-receipt-num').value = parsed.receiptNum;
    if (parsed.category) {
      const sel = document.getElementById('exp-category');
      for (let opt of sel.options) { if (opt.value === parsed.category) { sel.value = parsed.category; break; } }
    }
    status.style.background = '#E8F5E9'; status.style.color = '#2E7D32';
    status.textContent = '✓ Receipt read — please review and adjust if needed';
  } catch(err) {
    status.style.background = '#FDECEA'; status.style.color = '#C0392B';
    status.textContent = '✗ Error: ' + (err.message || 'Could not read receipt');
  }
}

// ── GOOGLE DRIVE AUTH ─────────────────────────────────────────────────────
function getDriveToken() {
  const token = localStorage.getItem('gh-drive-token');
  if (!token) return null;
  const expiry = localStorage.getItem('gh-drive-token-expiry');
  if (expiry && Date.now() > Number(expiry) - 60000) {
    // Token expired or expiring within 1 min — clear it and prompt reconnect
    localStorage.removeItem('gh-drive-token');
    localStorage.removeItem('gh-drive-token-expiry');
    showBanner('⚠ Google session expired — reconnect Drive in Settings', 'warn');
    return null;
  }
  return token;
}

async function verifyDriveToken() {
  const token = getDriveToken();
  const statusEl = document.getElementById('gdrive-status');
  const connectBtn = document.getElementById('gdrive-connect-btn');

  if (!token) {
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--text-soft)">Not connected</span>';
    return;
  }

  if (statusEl) statusEl.innerHTML = '<span style="color:var(--text-soft)">⟳ Verifying...</span>';

  try {
    // Verify using Drive API — matches the drive.file scope we actually request
    const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=user', {
      headers: { Authorization: 'Bearer ' + token }
    });

    if (res.ok) {
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--moss)">✓ Google Drive & Calendar connected</span>';
    } else if (res.status === 401) {
      // Token expired — clear it and prompt reconnect
      localStorage.removeItem('gh-drive-token');
      localStorage.removeItem('gh-drive-token-expiry');
      if (statusEl) statusEl.innerHTML = '<span style="color:#C0392B">⚠ Session expired — please reconnect</span>';
      showAppModal({
        title: '🔗 Google Drive Disconnected',
        msg: 'Your Google Drive & Calendar session has expired. Tap OK to reconnect now, or go to Settings → Google & Sync later.',
        confirmText: 'Reconnect Now',
        cancelText: 'Later'
      }).then(confirmed => { if (confirmed) connectGoogleDrive(); });
    } else {
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--amber)">⚠ Could not verify connection</span>';
    }
  } catch(e) {
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--amber)">⚠ Could not verify — check connection</span>';
  }
}

function connectGoogleDrive() {
  const clientId = localStorage.getItem('gh-gdrive-client-id');
  if (!clientId) {
    showBanner('⚠ Enter your Google OAuth Client ID in Settings → Google Drive first','warn');
    return;
  }
  // Use exact current page URL (no hash, no query string)
  let redirectUri = window.location.origin + window.location.pathname;
  if (!redirectUri.endsWith('/')) redirectUri += '/';
  const scope = encodeURIComponent('https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/calendar.events');
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${scope}`;

  // Show user the exact URI they need to register
  const statusEl = document.getElementById('gdrive-status');
  if (statusEl) statusEl.innerHTML = `<span style="color:var(--amber)">⚠ Make sure this exact URL is in your Authorised redirect URIs:<br><strong style="word-break:break-all">${redirectUri}</strong></span>`;

  setTimeout(() => { window.location.href = url; }, 1500);
}

// Handle OAuth token from redirect
(function() {
  const hash = window.location.hash;
  if (hash.includes('access_token')) {
    const params = new URLSearchParams(hash.substring(1));
    const token = params.get('access_token');
    const expiresIn = params.get('expires_in');
    if (token) {
      localStorage.setItem('gh-drive-token', token);
      if (expiresIn) localStorage.setItem('gh-drive-token-expiry', String(Date.now() + Number(expiresIn) * 1000));
      history.replaceState(null, '', window.location.pathname);
      showBanner('✓ Google Drive connected', 'ok');
    }
  }
})();



// ── GOOGLE CALENDAR AUTO-SYNC ─────────────────────────────────────────────
async function pushBookingToCalendar(b) {
  if (b.gcalEventId) return; // already synced — skip
  if (!b.checkin || !b.checkout || new Date(b.checkout) < new Date()) return; // past — skip
  const token = getDriveToken();
  if (!token) return;
  const event = {
    summary: '🏡 ' + (b.name || 'Guest') + ' — Glenhaven',
    description: [
      (b.guests || '') + ' guests · ' + (b.nights || '') + ' nights',
      b.platform || '',
      b.netPayout ? 'Net: $' + Number(b.netPayout).toFixed(2) : ''
    ].filter(Boolean).join('\n'),
    start: { date: b.checkin },
    end:   { date: b.checkout },
    colorId: '2'
  };
  try {
    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });
    if (res.ok) {
      const data = await res.json();
      b.gcalEventId = data.id;
      save();
    } else if (res.status === 401) {
      showBanner('⚠ Google Calendar token expired — reconnect in Settings', 'warn');
    } else {
      const errData = await res.json().catch(()=>null);
      const msg = errData?.error?.message || `HTTP ${res.status}`;
      showBanner(`⚠ Calendar sync failed: ${msg}`, 'warn');
    }
  } catch(e) {} // silent fail — calendar sync is non-critical
}

async function updateBookingInCalendar(b) {
  if (!b.gcalEventId) { await pushBookingToCalendar(b); return; }
  const token = getDriveToken();
  if (!token) return;
  const event = {
    summary: '🏡 ' + (b.name || 'Guest') + ' — Glenhaven',
    description: [
      (b.guests || '') + ' guests · ' + (b.nights || '') + ' nights',
      b.platform || '',
      b.netPayout ? 'Net: $' + Number(b.netPayout).toFixed(2) : ''
    ].filter(Boolean).join('\n'),
    start: { date: b.checkin },
    end:   { date: b.checkout },
    colorId: '2'
  };
  try {
    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events/' + b.gcalEventId, {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });
    if (res.status === 401) showBanner('⚠ Google Calendar token expired — reconnect in Settings', 'warn');
    if (res.status === 404) {
      // Event was deleted from calendar — create fresh
      b.gcalEventId = null;
      await pushBookingToCalendar(b);
    }
  } catch(e) {}
}

async function syncNewBookingsToCalendar() {
  const token = getDriveToken();
  if (!token) return;
  const toSync = bookings.filter(b => !b.gcalEventId && b.checkin && new Date(b.checkout) >= new Date());
  for (const b of toSync) await pushBookingToCalendar(b);
}

// ── GOOGLE CALENDAR SYNC ──────────────────────────────────────────────────
async function syncToGoogleCalendar() {
  const token = getDriveToken();
  const resultEl = document.getElementById('gcal-sync-result');
  resultEl.style.display = 'block';
  resultEl.style.background = '#FFF8E1'; resultEl.style.color = '#E65100';

  if (!token) {
    resultEl.textContent = '⚠ Not connected — tap "Connect Google Drive & Calendar" first';
    return;
  }

  const upcoming = bookings.filter(b => b.checkin && b.checkout && new Date(b.checkout) >= new Date());
  if (!upcoming.length) { resultEl.textContent = '⚠ No upcoming bookings to sync'; return; }

  resultEl.textContent = '⟳ Syncing ' + upcoming.length + ' bookings...';

  let created = 0, updated = 0, failed = 0;
  for (const b of upcoming) {
    const event = {
      summary: '🏡 ' + (b.name || 'Guest') + ' — Glenhaven',
      description: `${b.guests || ''} guests · ${b.nights || ''} nights · ${b.platform || ''}
Net: $${Number(b.netPayout||0).toFixed(2)}`,
      start: { date: b.checkin },
      end:   { date: b.checkout },
      colorId: '2'
    };
    try {
      if (b.gcalEventId) {
        // Update existing — never duplicate
        const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events/' + b.gcalEventId, {
          method: 'PUT',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify(event)
        });
        if (res.ok) { updated++; }
        else if (res.status === 404) {
          // Deleted from calendar — recreate
          b.gcalEventId = null;
          const r2 = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify(event)
          });
          if (r2.ok) { const d = await r2.json(); b.gcalEventId = d.id; created++; } else failed++;
        } else if (res.status === 401) {
          resultEl.style.background = '#FDECEA'; resultEl.style.color = '#C0392B';
          resultEl.textContent = '✗ Token expired — reconnect Google Drive & Calendar'; return;
        } else failed++;
      } else {
        // New booking — create
        const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify(event)
        });
        if (res.ok) { const d = await res.json(); b.gcalEventId = d.id; created++; }
        else if (res.status === 401) {
          resultEl.style.background = '#FDECEA'; resultEl.style.color = '#C0392B';
          resultEl.textContent = '✗ Token expired — reconnect Google Drive & Calendar'; return;
        } else failed++;
      }
    } catch(e) { failed++; }
    resultEl.textContent = '⟳ ' + (created + updated + failed) + ' / ' + upcoming.length + '...';
  }
  save(); // persist gcalEventIds
  if (failed === 0) {
    resultEl.style.background = '#E8F5E9'; resultEl.style.color = '#2E7D32';
    resultEl.textContent = '✓ ' + created + ' created, ' + updated + ' updated';
    showBanner('✓ Calendar synced — ' + created + ' new, ' + updated + ' updated', 'ok');
  } else {
    resultEl.style.background = '#FFF8E1'; resultEl.style.color = '#E65100';
    resultEl.textContent = '⚠ ' + (created + updated) + ' synced, ' + failed + ' failed';
  }
}

// ── MAINTENANCE ───────────────────────────────────────────────────────────
function renderMaintenance() {
  const el = document.getElementById('maintenance-list');
  if (!maintenance.length) { el.innerHTML = '<div style="padding:12px 0;color:var(--text-soft);font-size:13px">No issues logged</div>'; return; }
  const order = {open:0,inprogress:1,resolved:2};
  const sorted = [...maintenance].sort((a,b) => (order[a.status]||0)-(order[b.status]||0));
  el.innerHTML = sorted.map(m => `
    <div class="maint-item">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div style="flex:1">
          <span class="maint-status-badge maint-${m.status}">${m.status==='open'?'🔴 Open':m.status==='inprogress'?'🔄 In Progress':'✅ Resolved'}</span>
          <div style="font-weight:600;font-size:14px;margin-top:4px">${m.description}</div>
          ${m.contractor?`<div style="font-size:12px;color:var(--text-soft);margin-top:2px">👤 ${m.contractor}</div>`:''}
          <div style="font-size:12px;color:var(--text-soft);margin-top:1px">${fmt(m.date)}${m.cost?` · $${Number(m.cost).toFixed(2)}`:''}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;flex-shrink:0">
          <button onclick="deleteMaintenance(${m.id})" style="font-size:10px;color:var(--text-soft);background:none;border:none;cursor:pointer">✕</button>
          ${m.status !== 'resolved' ? `
          <button onclick="resolveIssue(${m.id})" style="font-size:11px;background:var(--moss);color:white;border:none;border-radius:8px;padding:5px 10px;cursor:pointer;font-family:'DM Sans',sans-serif">Mark Resolved</button>
          <button onclick="setMaintInProgress(${m.id})" style="font-size:11px;background:var(--forest-light);color:var(--sage);border:none;border-radius:8px;padding:5px 10px;cursor:pointer;font-family:'DM Sans',sans-serif">In Progress</button>
          ` : ''}
        </div>
      </div>
    </div>`).join('');
}

function addMaintenance() {
  const desc = document.getElementById('maint-desc').value.trim();
  const date = document.getElementById('maint-date').value;
  if (!desc || !date) { showBanner('⚠ Please fill in description and date','warn'); return; }
  const contractorSel = document.getElementById('maint-contractor-select');
  maintenance.push({
    id: Date.now(),
    description: desc,
    status: 'open',
    cost: 0,
    contractor: contractorSel ? contractorSel.value : '',
    date
  });
  savePropertyData();
  document.getElementById('maint-desc').value = '';
  renderMaintenance();
  showBanner('✓ Issue logged', 'ok');
}

function setMaintInProgress(id) {
  const m = maintenance.find(m => m.id === id);
  if (m) { m.status = 'inprogress'; savePropertyData(); renderMaintenance(); }
}

async function resolveIssue(id) {
  const m = maintenance.find(m => m.id === id);
  if (!m) return;
  const costStr = await showAppModal({
    title: '✓ Mark Resolved',
    msg: `"${m.description}" — enter cost (leave blank if $0)`,
    confirmText: 'Resolve',
    hasInput: true,
    inputPlaceholder: '0.00',
    inputType: 'number'
  });
  if (costStr === null) return;
  const cost = parseFloat(costStr) || 0;
  m.status = 'resolved';
  m.cost = cost;
  savePropertyData();
  // Auto-create expense entry
  if (cost > 0) {
    const exp = {
      id: Date.now(),
      merchant: m.contractor || 'Contractor',
      description: m.description,
      amount: cost,
      date: new Date().toISOString().split('T')[0],
      category: 'Cleaning & Maintenance',
      receiptType: 'missing',
      receiptNum: '',
      awaitingReceipt: true,
      driveLink: null,
      photo: null
    };
    expenses.push(exp);
    savePropertyData();
    saveExpenseToDriveAndSheet(exp);
    showBanner('✓ Resolved · $' + cost.toFixed(2) + ' added to Expenses (awaiting receipt)', 'ok');
  } else {
    showBanner('✓ Issue resolved', 'ok');
  }
  renderMaintenance();
}

async function deleteMaintenance(id) {
  const _okIssue = await showAppModal({ title: 'Delete Issue', msg: 'Delete this maintenance issue?', confirmText: 'Delete', confirmColor: 'var(--red)' });
  if (!_okIssue) return;
  maintenance = maintenance.filter(m => m.id !== id);
  savePropertyData();
  renderMaintenance();
}

// ── INVENTORY ─────────────────────────────────────────────────────────────
let invView = 'all';
function setInvView(v, btn) {
  invView = v;
  document.querySelectorAll('#prop-inventory .tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  renderInventory();
}

function renderInventory() {
  const listEl = document.getElementById('inventory-list');
  const lowItems = inventory.filter(i => i.stock <= i.threshold);

  if (invView === 'low') {
    // Shopping list — name only, clean checklist feel
    if (!lowItems.length) {
      listEl.innerHTML = '<div class="card" style="text-align:center;color:var(--moss);padding:24px"><div style="font-size:28px;margin-bottom:6px">✅</div><div style="font-weight:600;font-size:15px">All stocked up!</div><div style="font-size:12px;color:var(--text-soft);margin-top:4px">Nothing needs reordering right now</div></div>';
      return;
    }
    listEl.innerHTML = `<div class="card" style="padding:0">
      <div style="padding:10px 16px 6px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-soft);border-bottom:1px solid var(--warm)">${lowItems.length} item${lowItems.length!==1?'s':''} to reorder</div>
      ` + lowItems.map(i => `
      <div onclick="restockItem(${i.id})" style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--warm);cursor:pointer;transition:background 0.15s" onmouseover="this.style.background='var(--mist)'" onmouseout="this.style.background=''">
        <div style="width:22px;height:22px;border-radius:5px;border:2px solid var(--stone);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:14px;color:var(--moss)">+</div>
        <div>
          <div style="font-weight:600;font-size:14px">${i.name}${i.unit?' <span style="font-size:12px;font-weight:400;color:var(--text-soft)">(${i.unit})</span>':''}</div>
          <div style="font-size:11px;color:var(--text-soft);margin-top:2px">Stock: ${i.stock} · Reorder below ${i.threshold}</div>
        </div>
      </div>`).join('') + `</div>`;
    return;
  }

  // All items view
  if (!inventory.length) { listEl.innerHTML = '<div style="color:var(--text-soft);font-size:13px;padding:8px 0">No items added yet</div>'; return; }
  listEl.innerHTML = `<div class="card" style="padding:0">` + inventory.map(i => {
    const isLow = i.stock <= i.threshold;
    return `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--warm);gap:8px">
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:14px;color:${isLow?'var(--red)':'var(--text)'}">${i.name}${isLow?' ⚠':''}</div>
        <div style="font-size:12px;color:var(--text-soft);margin-top:1px">Reorder below ${i.threshold}${i.unit?' '+i.unit:''}</div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
        <button onclick="adjustStock(${i.id},-1)" style="width:30px;height:30px;border-radius:50%;border:1px solid var(--stone);background:white;font-size:17px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;flex-shrink:0">−</button>
        <span style="font-weight:700;font-size:17px;min-width:26px;text-align:center;color:${isLow?'var(--red)':'var(--forest)'}">${i.stock}</span>
        <button onclick="adjustStock(${i.id},1)" style="width:30px;height:30px;border-radius:50%;border:none;background:var(--forest);color:white;font-size:17px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;flex-shrink:0">+</button>
        <button onclick="openInvEdit(${i.id})" style="width:30px;height:30px;border-radius:50%;border:1px solid var(--stone);background:white;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:var(--forest)">ℹ</button>
      </div>
    </div>`;
  }).join('') + `</div>`;
}

function addInventoryItem() {
  const name = document.getElementById('inv-item-name').value.trim();
  if (!name) { showBanner('⚠ Please enter an item name','warn'); return; }
  inventory.push({
    id: Date.now(),
    name,
    stock: parseInt(document.getElementById('inv-item-stock').value) || 0,
    threshold: parseInt(document.getElementById('inv-item-threshold').value) || 0,
    unit: document.getElementById('inv-item-unit').value.trim()
  });
  savePropertyData();
  ['inv-item-name','inv-item-stock','inv-item-threshold','inv-item-unit'].forEach(id => document.getElementById(id).value = '');
  renderInventory();
  showBanner('✓ Item added', 'ok');
}

function updateThreshold(id, val) {
  const item = inventory.find(i => i.id === id);
  if (item) { item.threshold = parseInt(val) || 0; savePropertyData(); renderInventory(); }
}

function adjustStock(id, delta) {
  const item = inventory.find(i => i.id === id);
  if (item) { item.stock = Math.max(0, item.stock + delta); savePropertyData(); renderInventory(); }
}

async function restockItem(id) {
  const item = inventory.find(i => String(i.id) === String(id));
  if (!item) return;
  const input = await showAppModal({
    title: '📦 Restock',
    msg: `How many ${item.unit || 'units'} of "${item.name}" did you buy? (Current: ${item.stock})`,
    confirmText: 'Add Stock',
    hasInput: true,
    inputPlaceholder: '0',
    inputType: 'number'
  });
  if (input === null) return;
  const bought = parseInt(input);
  if (isNaN(bought) || bought < 0) { showBanner('⚠ Please enter a valid number', 'warn'); return; }
  item.stock = item.stock + bought;
  savePropertyData();
  renderInventory();
  showBanner(`✓ ${item.name} updated — new stock: ${item.stock}${item.unit ? ' ' + item.unit : ''}`, 'ok');
}

async function deleteInventoryItem(id) {
  const ok = await showAppModal({ title: 'Remove Item', msg: 'Remove this item from inventory?', confirmText: 'Remove', confirmColor: 'var(--red)' });
  if (!ok) return;
  inventory = inventory.filter(i => i.id !== id);
  savePropertyData();
  renderInventory();
}

// ── EXPENSE EDIT ─────────────────────────────────────────────────────────────
let editingExpenseId = null;
let editingExpensePhotoBase64 = null;
let editingExpenseMediaType = 'image/jpeg';

function attachEditExpensePhoto(input) {
  const file = input.files[0];
  if (!file) return;
  editingExpenseMediaType = file.type || 'image/jpeg';
  const reader = new FileReader();
  reader.onload = function(ev) {
    editingExpensePhotoBase64 = ev.target.result.split(',')[1];
    document.getElementById('ee-photo-img').src = ev.target.result;
    document.getElementById('ee-photo-preview').style.display = 'block';
    document.getElementById('ee-receipt-label').textContent = 'New receipt selected — will upload on save';
  };
  reader.readAsDataURL(file);
}
function clearEditExpensePhoto() {
  editingExpensePhotoBase64 = null;
  document.getElementById('ee-photo-preview').style.display = 'none';
  document.getElementById('ee-file-input').value = '';
  const e = expenses.find(e => e.id === editingExpenseId);
  document.getElementById('ee-receipt-label').textContent = e && e.driveLink ? 'Upload a replacement receipt' : 'Upload receipt photo to Google Drive';
}
function openExpenseEdit(id) {
  const e = expenses.find(e => e.id === id);
  if (!e) return;
  editingExpenseId = id;
  editingExpensePhotoBase64 = null;
  document.getElementById('ee-merchant').value = e.merchant || '';
  document.getElementById('ee-description').value = e.description || '';
  document.getElementById('ee-amount').value = e.amount || '';
  document.getElementById('ee-date').value = e.date || '';
  document.getElementById('ee-receipt-num').value = e.receiptNum || '';
  const cats = getExpenseCats();
  const sel = document.getElementById('ee-category');
  sel.innerHTML = cats.map(c => `<option value="${c}" ${c===e.category?'selected':''}>${c}</option>`).join('');
  document.getElementById('ee-receipt-type').value = String(e.receiptType || 'missing').toLowerCase().trim();
  // Show existing drive link if present
  const currentReceiptEl = document.getElementById('ee-current-receipt');
  const receiptLinkEl = document.getElementById('ee-receipt-link');
  if (e.driveLink) {
    receiptLinkEl.href = e.driveLink;
    currentReceiptEl.style.display = 'block';
    document.getElementById('ee-receipt-label').textContent = 'Upload a replacement receipt';
  } else {
    currentReceiptEl.style.display = 'none';
    document.getElementById('ee-receipt-label').textContent = 'Upload receipt photo to Google Drive';
  }
  document.getElementById('ee-photo-preview').style.display = 'none';
  document.getElementById('ee-upload-status').style.display = 'none';
  document.getElementById('ee-file-input').value = '';
  document.getElementById('expense-edit-modal').classList.add('open'); document.body.style.overflow='hidden';
}
function closeExpenseEdit() {
  document.getElementById('expense-edit-modal').classList.remove('open'); _checkModalsClosed();
  editingExpenseId = null;
  editingExpensePhotoBase64 = null;
}
async function saveExpenseEdit() {
  const e = expenses.find(e => e.id === editingExpenseId);
  if (!e) return;
  e.merchant = document.getElementById('ee-merchant').value.trim();
  e.description = document.getElementById('ee-description').value.trim();
  e.amount = parseFloat(document.getElementById('ee-amount').value) || 0;
  e.date = document.getElementById('ee-date').value;
  e.category = document.getElementById('ee-category').value;
  e.receiptType = document.getElementById('ee-receipt-type').value;
  e.receiptNum = document.getElementById('ee-receipt-num').value.trim();

  // Upload new receipt photo if one was selected
  if (editingExpensePhotoBase64) {
    const driveToken = getDriveToken();
    const statusEl = document.getElementById('ee-upload-status');
    if (!driveToken) {
      statusEl.style.display = 'block';
      statusEl.style.color = 'var(--amber)';
      statusEl.textContent = '⚠ Connect Google Drive in Settings to upload receipts';
    } else {
      statusEl.style.display = 'block';
      statusEl.style.color = 'var(--text-soft)';
      statusEl.textContent = '⟳ Uploading receipt...';
      try {
        const fakeExp = Object.assign({}, e, { photo: editingExpensePhotoBase64, _mediaType: editingExpenseMediaType });
        const imgBlob = await receiptImageToPDF(fakeExp);
        const fileName = generateReceiptFileName(e);
        const folderId = await getOrCreateDriveFolder(driveToken);
        const metadata = { name: fileName, mimeType: 'application/pdf', parents: folderId ? [folderId] : [] };
        const form = new FormData();
        form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
        form.append('file', imgBlob);
        const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
          method: 'POST', headers: { Authorization: 'Bearer ' + driveToken }, body: form
        });
        if (res.ok) {
          const file = await res.json();
          if (file.id) {
            await setDriveFilePublic(file.id, driveToken);
            e.driveLink = 'https://drive.google.com/file/d/' + file.id + '/view';
            statusEl.style.color = 'var(--moss)';
            statusEl.textContent = '✓ Receipt uploaded';
          }
        } else {
          statusEl.style.color = 'var(--red)';
          statusEl.textContent = '⚠ Upload failed — expense saved without receipt';
        }
      } catch(err) {
        statusEl.style.color = 'var(--red)';
        statusEl.textContent = '⚠ Upload failed: ' + err.message;
      }
    }
  }

  savePropertyData();
  const scriptUrl = localStorage.getItem('gh-script-url') || DEFAULT_SCRIPT_URL;
  if (scriptUrl && scriptUrl.includes('script.google.com')) {
    const eForSheet = Object.assign({}, e); delete eForSheet.photo; delete eForSheet._mediaType;
    fetch(scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'updateExpense', data: JSON.stringify(eForSheet) })
    }).catch(() => {});
  }
  closeExpenseEdit();
  renderExpenses();
  showBanner('✓ Expense updated', 'ok');
}

// ── INVENTORY EDIT ────────────────────────────────────────────────────────────
let editingInvId = null;
function openInvEdit(id) {
  const i = inventory.find(i => i.id === id);
  if (!i) return;
  editingInvId = id;
  document.getElementById('ie-name').value = i.name || '';
  document.getElementById('ie-threshold').value = i.threshold ?? 0;
  document.getElementById('ie-unit').value = i.unit || '';
  document.getElementById('inv-edit-modal').classList.add('open'); document.body.style.overflow='hidden';
}
function closeInvEdit() {
  document.getElementById('inv-edit-modal').classList.remove('open'); _checkModalsClosed();
  editingInvId = null;
}
function saveInvEdit() {
  const i = inventory.find(i => i.id === editingInvId);
  if (!i) return;
  i.name = document.getElementById('ie-name').value.trim() || i.name;
  i.threshold = parseInt(document.getElementById('ie-threshold').value) || 0;
  i.unit = document.getElementById('ie-unit').value.trim();
  savePropertyData();
  closeInvEdit();
  renderInventory();
  showBanner('✓ Item updated', 'ok');
}
async function deleteInventoryItemFromEdit() {
  const _okInvEdit = await showAppModal({ title: 'Remove Item', msg: 'Remove this item from inventory?', confirmText: 'Remove', confirmColor: 'var(--red)' });
  if (!_okInvEdit) return;
  inventory = inventory.filter(i => i.id !== editingInvId);
  savePropertyData();
  closeInvEdit();
  renderInventory();
}

// ── PROPERTY DATA ─────────────────────────────────────────────────────────
let expenses    = JSON.parse(localStorage.getItem('gh-expenses')    || '[]');
let maintenance = JSON.parse(localStorage.getItem('gh-maintenance') || '[]');
let inventory   = JSON.parse(localStorage.getItem('gh-inventory')   || '[]');

const DEFAULT_EXPENSE_CATS = [
  'Cleaning & Garden','Maintenance & Repairs','Supplies & Consumables',
  'Utilities & Rates','Insurance','Furnishings & Equipment',
  'Renovation','Professional Services','Other'
];
function getExpenseCats() {
  const saved = localStorage.getItem('gh-expense-cats');
  return saved ? JSON.parse(saved) : DEFAULT_EXPENSE_CATS;
}
function savePropertyData() {
  localStorage.setItem('gh-expenses',    JSON.stringify(expenses));
  localStorage.setItem('gh-maintenance', JSON.stringify(maintenance));
  localStorage.setItem('gh-inventory',   JSON.stringify(inventory));
  scheduleAppDataSave('inventory',    inventory);
  scheduleAppDataSave('maintenance',  maintenance);
}

// ── SCREENSHOT TO BOOKING ─────────────────────────────────────────────────
let screenshotBase64 = null;
let screenshotMediaType = 'image/jpeg';

function readBookingScreenshot(input) {
  const file = input.files[0];
  if (!file) return;
  screenshotMediaType = 'image/jpeg'; // always output jpeg after resize
  const reader = new FileReader();
  reader.onload = function(e) {
    const img = new Image();
    img.onload = function() {
      // Resize to max 4000px on longest side (Claude API limit is 8000px)
      const MAX = 4000;
      let w = img.width, h = img.height;
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
        else { w = Math.round(w * MAX / h); h = MAX; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
      screenshotBase64 = dataUrl.split(',')[1];
      const prev = document.getElementById('screenshot-img');
      prev.src = dataUrl;
      document.getElementById('screenshot-preview').style.display = 'block';
      document.getElementById('screenshot-extract-btn').style.display = 'block';
      const status = document.getElementById('screenshot-status');
      status.style.display = 'block';
      status.style.background = '#E8F5E9';
      status.style.color = '#2E7D32';
      status.textContent = '✓ Screenshot loaded — tap Extract to read booking details';
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

async function extractBookingFromScreenshot() {
  if (!screenshotBase64) { showBanner('⚠ Please select a screenshot first', 'warn'); return; }
  const btn = document.getElementById('screenshot-extract-btn');
  const status = document.getElementById('screenshot-status');
  btn.disabled = true;
  btn.textContent = '⟳ Reading screenshot...';
  status.style.display = 'block';
  status.style.background = '#FFF8E1';
  status.style.color = '#E65100';
  status.textContent = '⟳ Analysing booking screenshot...';

  try {
    const { response, data } = await AIService.request({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: screenshotMediaType, data: screenshotBase64 }
          },
          {
            type: 'text',
            text: `This is a booking confirmation screenshot. Return ONLY a valid JSON object with no markdown, no backtick fences, no explanation. Fields: guestName (string), checkin (YYYY-MM-DD), checkout (YYYY-MM-DD), nights (number), guests (number), hostPayout (number no $ sign), cleaningFee (number no $ sign). Use null if not visible. Today's date is ${new Date().toISOString().slice(0,10)}. If a date has no year, use the current year — but if that date has already passed, use next year instead.`,
          }
        ]
      }]
    });
    if (!response.ok) {
      throw new Error('API error ' + response.status + ': ' + (data.error?.message || JSON.stringify(data)));
    }
    const text = data.content?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    // Switch to manual tab and fill in fields
    switchModalTab('manual', document.querySelectorAll('#modal .tab')[0]);

    if (parsed.guestName) document.getElementById('b-name').value = parsed.guestName;
    if (parsed.guests) document.getElementById('b-guests').value = parsed.guests;
    if (parsed.checkin) document.getElementById('b-checkin').value = parsed.checkin;
    if (parsed.checkout) document.getElementById('b-checkout').value = parsed.checkout;
    if (parsed.hostPayout) document.getElementById('b-hostpayout').value = parsed.hostPayout;
    if (parsed.cleaningFee) document.getElementById('b-cleaningfee').value = parsed.cleaningFee;
    calcNights();

    showBanner('✓ Booking details extracted — please review and confirm', 'ok');

  } catch(e) {
    status.style.background = '#FDECEA';
    status.style.color = '#C0392B';
    status.textContent = '✗ Error: ' + (e.message || JSON.stringify(e));
    btn.disabled = false;
    btn.textContent = '✨ Try Again';
  }
}


// ── CUSTOM MODALS (replace blocked confirm/prompt) ───────────────────────────
let _modalResolve = null;

function showAppModal({ title, msg, confirmText='Confirm', confirmColor='var(--forest)', cancelText='Cancel', hasInput=false, inputPlaceholder='', inputDefault='', inputType='number' }) {
  return new Promise(resolve => {
    _modalResolve = resolve;
    document.getElementById('app-modal-title').textContent = title;
    document.getElementById('app-modal-msg').textContent = msg;
    const inp = document.getElementById('app-modal-input');
    if (hasInput) {
      inp.style.display = 'block';
      inp.type = inputType;
      inp.placeholder = inputPlaceholder;
      inp.value = inputDefault;
      setTimeout(() => inp.focus(), 100);
    } else {
      inp.style.display = 'none';
    }
    document.getElementById('app-modal-confirm').textContent = confirmText;
    document.getElementById('app-modal-confirm').style.background = confirmColor;
    document.getElementById('app-modal-cancel').textContent = cancelText;
    const overlay = document.getElementById('app-modal-overlay');
    overlay.style.display = 'flex';
  });
}

function appModalConfirm() {
  const inp = document.getElementById('app-modal-input');
  const val = inp.style.display !== 'none' ? inp.value : true;
  document.getElementById('app-modal-overlay').style.display = 'none';
  if (_modalResolve) { _modalResolve(val); _modalResolve = null; }
}

function appModalCancel() {
  document.getElementById('app-modal-overlay').style.display = 'none';
  if (_modalResolve) { _modalResolve(null); _modalResolve = null; }
}


// ── STORAGE VIEWER ────────────────────────────────────────────────────────
function renderStorageViewer() {
  const el = document.getElementById('storage-viewer');
  if (!el) return;
  // Only show the meaningful data keys: bookings, cleans, expenses
  const DATA_KEYS = ['gh-bookings', 'gh-cleans', 'gh-expenses'];
  el.innerHTML = DATA_KEYS.map(k => {
    const val = localStorage.getItem(k);
    let items = [];
    let count = 0;
    try { items = JSON.parse(val || '[]'); count = Array.isArray(items) ? items.length : 0; } catch(e) {}
    const label = k === 'gh-bookings' ? '🏠 Bookings' : k === 'gh-cleans' ? '🧹 Cleans' : '💰 Expenses';
    return `
    <div style="padding:12px 0;border-bottom:1px solid var(--warm)">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div>
          <div style="font-weight:600;font-size:14px;color:var(--forest)">${label}</div>
          <div style="font-size:12px;color:var(--text-soft);margin-top:2px">${count} record${count!==1?'s':''} stored locally</div>
        </div>
        <button onclick="showAppModal({title:'Clear ${label}?',msg:'This removes all locally saved ${k==='gh-bookings'?'booking':'clean'} data. Sheet data is unaffected.',confirmText:'Clear',confirmColor:'var(--red)'}).then(ok=>{if(ok){localStorage.removeItem('${k}');renderStorageViewer();showBanner('Cleared ${label.replace(/[^a-zA-Z ]/,'')}','ok');}})" style="font-size:12px;color:var(--red);background:#FEF2F2;border:none;border-radius:8px;padding:5px 10px;cursor:pointer;font-family:'DM Sans',sans-serif;font-weight:600">Clear</button>
      </div>
      ${count > 0 ? `<div style="font-size:11px;color:var(--text-soft);font-family:monospace;margin-top:6px;white-space:pre-wrap;word-break:break-all">${JSON.stringify(items.slice(0,1), null, 1).substring(0, 100)}${count > 1 ? '\n...' : ''}</div>` : ''}
    </div>`;
  }).join('');
}

// ── INIT ──────────────────────────────────────────────────────────────────


// One-time category migration — runs silently on every load
(function migrateCats() {
  const MAP = {
    // Old app defaults → new
    'Cleaning':                   'Cleaning & Garden',
    'Garden':                     'Cleaning & Garden',
    'Landscaping & Garden':       'Cleaning & Garden',
    'Cleaning & Maintenance':     'Cleaning & Garden',
    'Cleaning/Repairs':           'Cleaning & Garden',
    'Supplies & Equipment':       'Supplies & Consumables',
    'Supplies & Consumables':     'Supplies & Consumables', // already correct
    'Groceries':                  'Supplies & Consumables',
    'Linen & Towels':             'Supplies & Consumables',
    'Appliances':                 'Furnishings & Equipment',
    'Furniture':                  'Furnishings & Equipment',
    'Furnishings & Equipment':    'Furnishings & Equipment', // already correct
    'Repairs':                    'Maintenance & Repairs',
    'Pest Control':               'Maintenance & Repairs',
    'Renovation & Building':      'Renovation',
    'Renovation':                 'Renovation', // already correct
    'Utilities & Services':       'Utilities & Rates',
    'Council Rates':              'Utilities & Rates',
    'Professional & Marketing':   'Professional Services',
    'Professional Services':      'Professional Services', // already correct
    'Professional Fees':          'Professional Services',
    'Administration':             'Professional Services',
    'Admin':                      'Professional Services',
    'Marketing':                  'Professional Services',
  };
  let changed = false;
  expenses.forEach(e => { if (MAP[e.category]) { e.category = MAP[e.category]; changed = true; } });
  if (changed) savePropertyData();
})();

// Clear expenses cache only if the script URL has changed since last load
const _scriptConfigured = (localStorage.getItem('gh-script-url') || DEFAULT_SCRIPT_URL || '').includes('script.google.com');
const _lastScriptUrl = localStorage.getItem('gh-last-script-url');
const _currentScriptUrl = localStorage.getItem('gh-script-url') || DEFAULT_SCRIPT_URL;
if (_scriptConfigured && _lastScriptUrl !== _currentScriptUrl) {
  localStorage.removeItem('gh-expenses');
  expenses = [];
  localStorage.setItem('gh-last-script-url', _currentScriptUrl);
}

// ── APP DATA SYNC (Sheet ↔ localStorage) ──────────────────────────────────────
// Debounce timers — prevents hammering Sheet on rapid changes (e.g. stock taps)
function scheduleAppDataSave(key, data) {
  const url = getScriptURL();
  if (!url) return; // no script URL configured yet
  clearTimeout(_appDataTimers[key]);
  _appDataTimers[key] = setTimeout(() => pushAppData(key, data), 3000);
}

function pushAppData(key, data) {
  const url = getScriptURL();
  if (!url) return;
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ action: 'setAppData', key, value: data })
  })
  .then(r => r.json())
  .then(j => { if (!j.success) console.warn('AppData save failed:', key, j); })
  .catch(e => console.warn('AppData push error:', key, e));
}

async function pushAllAppData() {
  const url = getScriptURL();
  if (!url) { showBanner('⚠ No script URL configured', 'warn'); return; }
  const btn = document.getElementById('push-appdata-btn');
  const result = document.getElementById('push-appdata-result');
  btn.textContent = 'Pushing…'; btn.disabled = true;
  const keys = {
    cleaners:    loadCleaners(),
    cleans:      cleans,
    notes:       notes,
    inventory:   inventory,
    maintenance: maintenance,
    aiIgnore:    loadAIIgnoreList(),
    pushSubs:    getPushSubs(),
  };
  const errors = [];
  for (const [key, data] of Object.entries(keys)) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'setAppData', key, value: data })
      });
      const j = await r.json();
      if (!j.success) errors.push(key + ': ' + (j.error || j.status || 'failed'));
    } catch(e) {
      errors.push(key + ': network error');
    }
  }
  btn.textContent = '⬆ Push App Data to Sheet'; btn.disabled = false;
  if (errors.length) {
    result.style.display = 'block';
    result.style.background = '#FDECEA'; result.style.color = 'var(--red)';
    result.textContent = '⚠ Some failed: ' + errors.join(', ');
  } else {
    result.style.display = 'block';
    result.style.background = '#EDF7ED'; result.style.color = 'var(--moss)';
    result.textContent = '✓ All data pushed to Sheet successfully';
    setTimeout(() => result.style.display = 'none', 4000);
  }
}

async function pullAppData(manual = false) {
  const url = getScriptURL();
  const btn = document.getElementById('pull-appdata-btn');
  const resultEl = document.getElementById('pull-appdata-result');

  function showResult(msg, ok) {
    if (!resultEl) return;
    resultEl.style.display = 'block';
    resultEl.style.background = ok ? '#F0FAF4' : '#FDECEA';
    resultEl.style.color = ok ? 'var(--moss)' : 'var(--red)';
    resultEl.textContent = msg;
  }

  if (!url) {
    if (manual) showResult('❌ No Apps Script URL configured.', false);
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = '…pulling'; }
  if (resultEl) resultEl.style.display = 'none';

  try {
    const resp = await fetch(url + '?action=getAppData');
    if (!resp.ok) {
      if (manual) showResult('❌ Server error: ' + resp.status + ' ' + resp.statusText, false);
      if (btn) { btn.disabled = false; btn.textContent = '↻ Pull App Data from Sheet'; }
      return;
    }
    const json = await resp.json();
    console.log('pullAppData response:', JSON.stringify(json).substring(0, 300));

    if (!json.success || !json.data) {
      if (manual) showResult('❌ Sheet returned: ' + JSON.stringify(json).substring(0, 100), false);
      if (btn) { btn.disabled = false; btn.textContent = '↻ Pull App Data from Sheet'; }
      return;
    }

    const d = json.data;
    let restored = [];

    if (d.cleaners && Array.isArray(d.cleaners) && d.cleaners.length > 0) {
      localStorage.setItem('gh-cleaners', JSON.stringify(d.cleaners));
      restored.push(d.cleaners.length + ' cleaners');
    }
    if (d.cleans && Array.isArray(d.cleans) && d.cleans.length > 0) {
      // Merge: prefer local confirmed/declined/done states over Sheet (in case Sheet is stale)
      const localCleans = JSON.parse(localStorage.getItem('gh-cleans') || '[]');
      const merged = d.cleans.map(sheetClean => {
        const local = localCleans.find(lc => String(lc.id) === String(sheetClean.id));
        if (local) {
          // Keep the most "advanced" state
          return Object.assign({}, sheetClean, {
            cleanerConfirmed: local.cleanerConfirmed || sheetClean.cleanerConfirmed,
            cleanerDeclined:  local.cleanerDeclined  || sheetClean.cleanerDeclined,
            done:             local.done             || sheetClean.done,
          });
        }
        return sheetClean;
      });
      // Also keep any local cleans not yet on the Sheet
      localCleans.forEach(lc => {
        if (!merged.find(m => String(m.id) === String(lc.id))) merged.push(lc);
      });
      cleans.length = 0;
      merged.forEach(c => cleans.push(c));
      localStorage.setItem('gh-cleans', JSON.stringify(cleans));
      // Sync booking.cleanerConfirmed from cleans
      cleans.forEach(c => {
        if (c.cleanerConfirmed) {
          const b = bookings.find(bk => bk.id === c.bookingId || bk.name === c.guestName);
          if (b) b.cleanerConfirmed = true;
        }
      });
      localStorage.setItem('gh-bookings', JSON.stringify(bookings));
      restored.push(merged.length + ' cleans');
    }
    if (d.notes && Array.isArray(d.notes)) {
      notes.length = 0;
      d.notes.forEach(n => notes.push(n));
      localStorage.setItem('gh-notes', JSON.stringify(notes));
      restored.push(d.notes.length + ' notes');
    }
    if (d.inventory && Array.isArray(d.inventory) && d.inventory.length > 0) {
      inventory.length = 0;
      d.inventory.forEach(i => inventory.push(i));
      localStorage.setItem('gh-inventory', JSON.stringify(inventory));
      restored.push(d.inventory.length + ' inventory items');
    }
    if (d.maintenance && Array.isArray(d.maintenance)) {
      maintenance.length = 0;
      d.maintenance.forEach(m => maintenance.push(m));
      localStorage.setItem('gh-maintenance', JSON.stringify(maintenance));
    }
    if (d.aiIgnore && Array.isArray(d.aiIgnore)) {
      localStorage.setItem('gh-ai-ignore', JSON.stringify(d.aiIgnore));
    }
    if (d.pushSubs && d.pushSubs.cleaners) {
      const local = getPushSubs();
      const merged = { owner: local.owner || d.pushSubs.owner, cleaners: Object.assign({}, d.pushSubs.cleaners, local.cleaners) };
      localStorage.setItem('gh-push-subs', JSON.stringify(merged));
    }

    renderAll();
    if (manual) {
      if (restored.length > 0) {
        showResult('✓ Restored: ' + restored.join(', '), true);
      } else {
        showResult('⚠️ Connected but no data found in AppData tab. Keys present: ' + Object.keys(d).join(', '), false);
      }
    } else {
      showBanner('✓ App data synced from Sheet', 'ok');
    }
  } catch(e) {
    console.error('pullAppData error:', e);
    if (manual) showResult('❌ Error: ' + e.message, false);
  }
  if (btn) { btn.disabled = false; btn.textContent = '↻ Pull App Data from Sheet'; }
}

// Render immediately from localStorage, then sync in background
render();
if (isCleanerMode()) {
  // Cleaner mode — only pull AppData (cleans, inventory, cleaners). Skip bookings CSV + expenses.
  pullAppData();
} else {
  syncFromSheets();
  if (_scriptConfigured) setTimeout(() => pullExpensesFromSheet(), 1200);
  if (_scriptConfigured) setTimeout(() => pullAppData(), 1800);
}
// Subscribe owner via manual button in Settings (iOS requires user gesture)

// Auto-prompt Drive connect if client ID saved but no token yet
setTimeout(() => {
  const clientId = localStorage.getItem('gh-gdrive-client-id');
  const token = localStorage.getItem('gh-drive-token');
  const dismissed = localStorage.getItem('gh-drive-connect-dismissed');
  if (clientId && !token && !dismissed) {
    showAppModal({
      title: '📁 Connect Google Drive',
      msg: 'Your Google Drive Client ID is saved but Drive isn\'t connected yet. Connect now to enable automatic receipt storage?',
      confirmText: 'Connect Now',
      cancelText: 'Later'
    }).then(ok => {
      if (ok) connectGoogleDrive();
      else localStorage.setItem('gh-drive-connect-dismissed', '1');
    });
  }
}, 3000);
// Verify Google Drive token on load — prompts reconnect if expired
if (localStorage.getItem('gh-drive-token')) setTimeout(() => verifyDriveToken(), 2000);
else if (localStorage.getItem('gh-gdrive-client-id')) {
  // Client ID configured but not connected — prompt once per session
  if (!sessionStorage.getItem('gh-drive-prompt-shown')) {
    sessionStorage.setItem('gh-drive-prompt-shown', '1');
    setTimeout(() => {
      showAppModal({
        title: '🔗 Connect Google Drive?',
        msg: 'Google Drive lets you save receipts automatically. Connect now?',
        confirmText: 'Connect Now',
        cancelText: 'Later'
      }).then(ok => { if (ok) connectGoogleDrive(); });
    }, 3000);
  }
}
// Safety net: re-render calendar after 100ms in case layout wasn't settled
setTimeout(renderCalendar, 100);

// Auto-refresh when user returns to app — throttled to once per 5 minutes
let _lastVisibilitySync = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const now = Date.now();
    if (now - _lastVisibilitySync > 5 * 60 * 1000) {
      _lastVisibilitySync = now;
      syncFromSheets(); // silent background sync
    }
    // Always pull AppData on focus to get latest cleaner states
    if (!isCleanerMode()) pullAppData();
  }
});
window.addEventListener('pageshow', (e) => { if (e.persisted) syncFromSheets(); });

// Auto-refresh cleaner app when it comes back into focus or on interval
if (isCleanerMode()) {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pullAppData();
  });
  setInterval(() => { if (!document.hidden) pullAppData(); }, 60000);
} else {
  // Owner app — pull AppData every 30 seconds to catch cleaner updates
  setInterval(() => { if (!document.hidden) pullAppData(); }, 30000);
}

// ── FEEL & GESTURES ───────────────────────────────────────────────────────────

// Default all on
const FX_DEFAULTS = { swipeBack:true, modalSpring:true, listBounce:true, longPress:true };

function getFx(key) {
  const stored = localStorage.getItem('gh-fx-' + key);
  return stored === null ? FX_DEFAULTS[key] : stored === 'true';
}
function saveFxSetting(key, val) {
  localStorage.setItem('gh-fx-' + key, val);
  if (key === 'modalSpring') applyModalSpring(val);
}
function applyModalSpring(on) {
  document.querySelectorAll('.modal').forEach(m => {
    m.style.transition = on
      ? 'transform 0.42s cubic-bezier(0.32,0.72,0,1)'
      : 'none';
  });
}
function initFxSettings() {
  ['swipeBack','modalSpring','listBounce','longPress'].forEach(k => {
    const el = document.getElementById('fx-' + k.replace(/([A-Z])/g, '-$1').toLowerCase());
    if (el) el.checked = getFx(k);
  });
  if (!getFx('modalSpring')) applyModalSpring(false);
}

// ── BUTTON PRESS FEEL ─────────────────────────────────────────────────────────
function attachButtonPress() {
  document.querySelectorAll('button, .settings-cat-item, .booking-item, .expense-item').forEach(el => {
    if (el.dataset.pressAttached) return;
    el.dataset.pressAttached = '1';
    el.addEventListener('touchstart', () => { el.classList.add('btn-press'); }, { passive:true });
    el.addEventListener('touchend',   () => { setTimeout(() => el.classList.remove('btn-press'), 100); });
    el.addEventListener('touchcancel',() => { el.classList.remove('btn-press'); });
  });
}

// ── LIST ENTRANCE ANIMATION ───────────────────────────────────────────────────
function animateList(containerSelector) {
  if (!getFx('listBounce')) return;
  const items = document.querySelectorAll(containerSelector + ' > *');
  items.forEach((el, i) => {
    el.classList.remove('list-animate');
    void el.offsetWidth; // force reflow
    el.style.animationDelay = (i * 40) + 'ms';
    el.classList.add('list-animate');
  });
}

// ── SWIPE TO GO BACK ──────────────────────────────────────────────────────────
let swipeStartX = 0, swipeStartY = 0, swipeActive = false;
const EDGE_ZONE = 30, MIN_SWIPE = 60;

function isSubScreenOpen() {
  return !!document.querySelector('[id^="settings-cat-"]:not(#settings-cat-pricing):not([style*="display:none"]):not([id="settings-menu"])') &&
    document.getElementById('settings-menu')?.style.display === 'none';
}

document.addEventListener('touchstart', e => {
  if (!getFx('swipeBack')) return;
  const t = e.touches[0];
  swipeStartX = t.clientX;
  swipeStartY = t.clientY;
  swipeActive = swipeStartX <= EDGE_ZONE && isSubScreenOpen();
  if (swipeActive) document.getElementById('swipe-back-hint').classList.add('visible');
}, { passive:true });

document.addEventListener('touchmove', e => {
  if (!swipeActive) return;
  const dx = e.touches[0].clientX - swipeStartX;
  const dy = Math.abs(e.touches[0].clientY - swipeStartY);
  if (dy > 40) { swipeActive = false; document.getElementById('swipe-back-hint').classList.remove('visible'); }
}, { passive:true });

document.addEventListener('touchend', e => {
  document.getElementById('swipe-back-hint').classList.remove('visible');
  if (!swipeActive) return;
  swipeActive = false;
  const dx = e.changedTouches[0].clientX - swipeStartX;
  if (dx >= MIN_SWIPE) { closeSettingsCat(); }
}, { passive:true });

// ── ACTION SHEET ──────────────────────────────────────────────────────────────
let longPressTimer = null;
let longPressTarget = null;

function showActionSheet(title, actions) {
  document.getElementById('action-sheet-title').textContent = title;
  const btnsEl = document.getElementById('action-sheet-buttons');
  btnsEl.innerHTML = actions.map(a =>
    `<button class="action-sheet-btn${a.destructive?' destructive':''}" onclick="closeActionSheet();(${a.fn})()">${a.label}</button>`
  ).join('');
  document.getElementById('action-sheet-overlay').classList.add('open');
}
function closeActionSheet() {
  document.getElementById('action-sheet-overlay').classList.remove('open');
}

function attachLongPress() {
  if (!getFx('longPress')) return;

  // Booking items
  document.querySelectorAll('.booking-item').forEach(el => {
    if (el.dataset.lpAttached) return;
    el.dataset.lpAttached = '1';
    const id = parseInt(el.dataset.bookingId);
    if (!id) return;
    el.addEventListener('touchstart', () => {
      longPressTimer = setTimeout(() => {
        const b = bookings.find(b => b.id === id);
        if (!b) return;
        showActionSheet(b.name, [
          { label: '✏️ Edit Booking',       fn: `() => showEditModal(${id})` },
          { label: '📱 Notify Cleaner',     fn: `() => { showSection('cleaning'); }` },
          { label: '📅 Push to Calendar',   fn: `() => pushBookingToCalendar(${id})` },
          { label: '🗑 Delete Booking',      fn: `() => deleteBooking(${id})`, destructive: true },
        ]);
      }, 500);
    }, { passive:true });
    el.addEventListener('touchend',    () => clearTimeout(longPressTimer));
    el.addEventListener('touchcancel', () => clearTimeout(longPressTimer));
    el.addEventListener('touchmove',   () => clearTimeout(longPressTimer), { passive:true });
  });

  // Expense items
  document.querySelectorAll('.expense-item').forEach(el => {
    if (el.dataset.lpAttached) return;
    el.dataset.lpAttached = '1';
    const id = parseInt(el.dataset.expenseId);
    if (!id) return;
    el.addEventListener('touchstart', () => {
      longPressTimer = setTimeout(() => {
        const e = expenses.find(e => e.id === id);
        if (!e) return;
        showActionSheet(e.merchant, [
          { label: '✏️ Edit Expense',  fn: `() => openExpenseEdit(${id})` },
          { label: '🗑 Delete Expense', fn: `() => deleteExpense(${id})`, destructive: true },
        ]);
      }, 500);
    }, { passive:true });
    el.addEventListener('touchend',    () => clearTimeout(longPressTimer));
    el.addEventListener('touchcancel', () => clearTimeout(longPressTimer));
    el.addEventListener('touchmove',   () => clearTimeout(longPressTimer), { passive:true });
  });
}

// ── MODAL HANDLE DRAG TO DISMISS ─────────────────────────────────────────────
function attachModalHandleDrag() {
  document.querySelectorAll('.modal-drag-zone').forEach(zone => {
    if (zone.dataset.dragAttached) return;
    zone.dataset.dragAttached = '1';

    const modal = zone.closest('.modal');
    const overlay = zone.closest('.modal-overlay');
    if (!modal || !overlay) return;

    let startY = 0, currentY = 0, dragging = false;

    zone.addEventListener('touchstart', e => {
      startY = e.touches[0].clientY;
      currentY = 0;
      dragging = true;
      modal.style.transition = 'none';
    }, { passive: true });

    zone.addEventListener('touchmove', e => {
      if (!dragging) return;
      const dy = e.touches[0].clientY - startY;
      if (dy < 0) return;
      currentY = dy;
      modal.style.transform = `translateY(${dy}px)`;
    }, { passive: true });

    zone.addEventListener('touchend', () => {
      if (!dragging) return;
      dragging = false;
      modal.style.transition = 'transform 0.42s cubic-bezier(0.32,0.72,0,1)';
      if (currentY > 80) {
        modal.style.transform = `translateY(100%)`;
        setTimeout(() => {
          modal.style.transform = '';
          if (overlay.id === 'modal') closeModal();
          else if (overlay.id === 'detail-modal') closeDetailModal();
          else if (overlay.id === 'notify-modal') closeNotifyModal();
          else if (overlay.id === 'expense-edit-modal') closeExpenseEdit();
          else if (overlay.id === 'inv-edit-modal') closeInvEdit();
          else { overlay.classList.remove('open'); _checkModalsClosed(); }
        }, 380);
      } else {
        modal.style.transform = 'translateY(0)';
        setTimeout(() => { modal.style.transform = ''; }, 420);
      }
    }, { passive: true });
  });
}

// ── CLEANER MODE ─────────────────────────────────────────────────────────────
function isCleanerMode() {
  const hash = window.location.hash; // e.g. #cleaner/123/ABC
  if (hash.startsWith('#cleaner/')) return true;
  const p = new URLSearchParams(window.location.search);
  return p.get('role') === 'cleaner';
}

function getCleanerParams() {
  // Hash format: #cleaner/ID/ENCODEDPIN
  const hash = window.location.hash;
  if (hash.startsWith('#cleaner/')) {
    const parts = hash.slice(1).split('/');
    return { id: parts[1] || null, encoded: parts[2] || null };
  }
  // Fallback: query string format (old links)
  const p = new URLSearchParams(window.location.search);
  return { id: p.get('id'), encoded: p.get('p') };
}
function getActiveCleaner() {
  const { id } = getCleanerParams();
  if (!id) return null;
  return loadCleaners().find(c => String(c.id) === String(id)) || null;
}
function isCleanerAuthed() {
  const { id } = getCleanerParams();
  return localStorage.getItem('gh-cleaner-authed-' + id) === '1';
}

// ── PIN ENTRY ─────────────────────────────────────────────────────────────────
let cleanerPinEntry = '';
function pinPress(digit) {
  if (cleanerPinEntry.length >= 4) return;
  cleanerPinEntry += digit;
  updatePinDots();
  if (cleanerPinEntry.length === 4) setTimeout(verifyCleanerPin, 120);
}
function pinDelete() {
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
function verifyCleanerPin() {
  const { id, encoded } = getCleanerParams();
  if (!encoded) {
    document.getElementById('pin-error').textContent = 'No PIN in link — ask owner to re-copy link from Settings';
    document.getElementById('pin-error').style.display = 'block';
    cleanerPinEntry = ''; updatePinDots(); return;
  }
  let stored;
  try { stored = atob(encoded); } catch(e) { stored = ''; }
  if (cleanerPinEntry === stored) {
    localStorage.setItem('gh-cleaner-authed-' + id, '1');
    document.body.classList.remove('cleaner-pin-active');
    document.body.classList.add('cleaner-mode');
    renderCleanerView();
    // Subscribe cleaner to push after auth
    setTimeout(() => subscribeToPush('cleaner', id), 1500);
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
async function cleanerRefresh() {
  const btn = document.getElementById('cleaner-refresh-btn');
  if (btn) { btn.textContent = '↻ …'; btn.disabled = true; }
  await pullAppData();
  if (btn) { btn.textContent = '↻ Refresh'; btn.disabled = false; }
  showBanner('✓ Updated', 'ok');
}

async function enableCleanerNotifications() {
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

function cleanerSignOut() {
  const { id } = getCleanerParams();
  localStorage.removeItem('gh-cleaner-authed-' + id);
  cleanerPinEntry = ''; updatePinDots();
  document.getElementById('pin-error').style.display = 'none';
  document.body.classList.remove('cleaner-mode');
  document.body.classList.add('cleaner-pin-active');
}

// ── CLEANER TAB SWITCHING ─────────────────────────────────────────────────────
let cleanerTab = 'cleans';
function switchCleanerTab(tab) {
  cleanerTab = tab;
  ['cleans','inventory'].forEach(t => {
    document.getElementById('ctab-' + t).classList.toggle('active', t === tab);
    document.getElementById('cleaner-' + t + '-view').style.display = t === tab ? 'block' : 'none';
  });
}

// ── CLEANER CLEANS VIEW ───────────────────────────────────────────────────────
let cleanerCleanTab = 'upcoming';

function switchCleanerCleanTab(tab) {
  cleanerCleanTab = tab;
  ['upcoming','new'].forEach(t => {
    const btn = document.getElementById('csubtab-' + t);
    const el = document.getElementById('cleaner-cleans-' + t);
    if (btn) {
      btn.style.color = t === tab ? 'var(--forest)' : 'var(--text-soft)';
      btn.style.fontWeight = t === tab ? '700' : '600';
      btn.style.borderBottomColor = t === tab ? 'var(--forest)' : 'transparent';
    }
    if (el) el.style.display = t === tab ? '' : 'none';
  });
}

function renderCleanerCleans() {
  const cleaner = getActiveCleaner();
  const today = new Date().toISOString().split('T')[0];
  const twoDaysAgo = new Date(Date.now() - 2*24*60*60*1000).toISOString().split('T')[0];
  const perm = (cleaner && cleaner.permissions) ? cleaner.permissions : {};

  const relevant = cleans.filter(c => {
    if (c.done) return false;
    if (c.date < twoDaysAgo) return false;
    if (cleaner) {
      return (c.cleanerId && String(c.cleanerId) === String(cleaner.id)) ||
             (!c.cleanerId && c.cleaner && c.cleaner === cleaner.name);
    }
    return true;
  }).sort((a,b) => a.date.localeCompare(b.date));

  // Badges on both tabs
  const newCount = relevant.filter(c => !c.cleanerConfirmed && !c.cleanerDeclined).length;
  const upcomingCount = relevant.filter(c => c.cleanerConfirmed && !c.cleanerDeclined).length;
  const newBadge = document.getElementById('csubtab-new-badge');
  const upBadge = document.getElementById('csubtab-upcoming-badge');
  const badgeStyle = 'border-radius:10px;padding:1px 7px;font-size:11px;margin-left:4px;font-weight:700';
  if (newBadge) newBadge.innerHTML = newCount > 0
    ? `<span style="background:var(--red);color:white;${badgeStyle}">${newCount}</span>`
    : `<span style="background:var(--stone);color:white;${badgeStyle}">0</span>`;
  if (upBadge) upBadge.innerHTML = `<span style="background:${upcomingCount > 0 ? 'var(--forest)' : 'var(--stone)'};color:white;${badgeStyle}">${upcomingCount}</span>`;

  const daysUntil = d => {
    const diff = (new Date(d) - new Date(today)) / 86400000;
    if (diff < -0.5) return null;
    if (diff < 0.5) return 'Today';
    if (diff < 1.5) return 'Tomorrow';
    return Math.ceil(diff) + ' days away';
  };

  function buildCard(c) {
    const booking = bookings.find(b => b.id === c.bookingId || b.name === c.guestName);
    const checkinStr = booking ? fmt(booking.checkin) : '—';
    const checkoutStr = booking ? fmt(booking.checkout) : fmt(c.date);
    const isToday = c.date === today;
    const showFirstName = perm.firstName && booking;
    const showFullName  = perm.fullName  && booking;
    const showGuests    = perm.guests    && booking;
    const showNotes     = perm.notes;
    const showPayout    = perm.payout    && booking;
    const nameDisplay   = showFullName ? booking.name : showFirstName ? (booking.name||'').split(' ')[0] : null;
    const urgency = daysUntil(c.date);

    return `<div class="clean-job-card ${isToday ? 'urgent' : ''}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
        <div>
          <div style="font-family:'DM Serif Display',serif;font-size:17px;color:var(--forest)">${urgency || 'Upcoming'}</div>
          <div style="font-size:12px;color:var(--text-soft);margin-top:2px">${c.date ? fmt(c.date) : '—'}</div>
          ${nameDisplay ? `<div style="font-size:13px;font-weight:600;color:var(--text);margin-top:4px">👤 ${nameDisplay}</div>` : ''}
        </div>
        ${isToday ? '<div style="font-size:11px;font-weight:600;color:var(--amber);background:#FFF5E6;padding:4px 10px;border-radius:20px">Today!</div>' : ''}
      </div>
      <div style="display:grid;grid-template-columns:${showGuests ? '1fr 1fr 1fr' : '1fr 1fr'};gap:8px;margin-bottom:12px">
        <div style="background:var(--mist);border-radius:8px;padding:8px 10px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-soft);margin-bottom:3px">Check-in</div>
          <div style="font-size:12px;font-weight:600">${checkinStr}</div>
        </div>
        <div style="background:var(--mist);border-radius:8px;padding:8px 10px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-soft);margin-bottom:3px">Check-out</div>
          <div style="font-size:12px;font-weight:600">${checkoutStr}</div>
        </div>
        ${showGuests ? `<div style="background:var(--mist);border-radius:8px;padding:8px 10px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-soft);margin-bottom:3px">Guests</div>
          <div style="font-size:12px;font-weight:600">${booking.guests}</div>
        </div>` : ''}
      </div>
      ${showPayout ? `<div style="background:#EDF7ED;border-radius:8px;padding:8px 12px;margin-bottom:10px;font-size:13px;color:var(--forest);font-weight:600">💰 Cleaning fee: $${Number(booking.cleaningFee||0).toLocaleString()}</div>` : ''}
      ${showNotes && c.notes ? `<div style="background:var(--mist);border-radius:8px;padding:8px 12px;margin-bottom:10px;font-size:12px;color:var(--text-soft)">📝 ${c.notes}</div>` : ''}
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
        <div style="font-family:'DM Serif Display',serif;font-size:18px;color:var(--forest);margin-bottom:6px">Nothing new!</div>
        <div style="font-size:13px;color:var(--text-soft)">New assignments will appear here</div>
      </div>`;
    } else {
      newEl.innerHTML = newCleans.map(c => {
        const buttons = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <button onclick="cleanerDecline('${c.id}')" style="background:#FDECEA;color:var(--red);border:none;border-radius:var(--radius-sm);padding:13px;font-size:13px;font-weight:600;font-family:'DM Sans',sans-serif;cursor:pointer">✗ Decline</button>
          <button onclick="cleanerAccept('${c.id}')" style="background:var(--forest);color:white;border:none;border-radius:var(--radius-sm);padding:13px;font-size:13px;font-weight:600;font-family:'DM Sans',sans-serif;cursor:pointer">✓ Accept</button>
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
        <div style="font-family:'DM Serif Display',serif;font-size:18px;color:var(--forest);margin-bottom:6px">No upcoming cleans</div>
        <div style="font-size:13px;color:var(--text-soft)">Cleans you've accepted will appear here</div>
      </div>`;
    } else {
      upcomingEl.innerHTML = upcomingCleans.map(c => {
        const buttons = `<button onclick="cleanerMarkDone('${c.id}')" style="width:100%;background:var(--forest);color:white;border:none;border-radius:var(--radius-sm);padding:13px;font-size:14px;font-weight:600;font-family:'DM Sans',sans-serif;cursor:pointer">✓ Mark as Complete</button>`;
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
      <div style="font-size:13px;color:var(--text-soft)">${lowItems.map(i=>`<strong>${i.name}</strong>`).join(', ')} ${lowItems.length===1?'is':'are'} running low</div>
    </div>`;
  }
  if (!inventory.length) {
    html += '<div style="text-align:center;padding:40px 16px;color:var(--text-soft);font-size:13px">No inventory items added yet</div>';
  } else {
    html += `<div class="card" style="padding:0">` + inventory.map(i => {
      const isLow = i.stock <= i.threshold;
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--warm);gap:8px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:14px;color:${isLow?'var(--red)':'var(--text)'}">${i.name}${isLow?' ⚠':''}</div>
          ${i.unit?`<div style="font-size:11px;color:var(--text-soft);margin-top:2px">${i.unit}</div>`:''}
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
          <button onclick="cleanerAdjustStock(${i.id},-1)" style="width:36px;height:36px;border-radius:50%;border:1.5px solid var(--stone);background:white;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1">−</button>
          <span style="font-weight:700;font-size:18px;min-width:28px;text-align:center;color:${isLow?'var(--red)':'var(--forest)'}">${i.stock}</span>
          <button onclick="cleanerAdjustStock(${i.id},1)" style="width:36px;height:36px;border-radius:50%;border:none;background:var(--forest);color:white;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1">+</button>
        </div>
      </div>`;
    }).join('') + `</div>`;
  }
  el.innerHTML = html;
}
async function cleanerAddInventoryItem() {
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
  scheduleAppDataSave('inventory', inventory);
  renderCleanerInventory();
  showBanner('✓ Item added', 'ok');
}

function cleanerAdjustStock(id, delta) {
  const item = inventory.find(i => i.id === id);
  if (!item) return;
  item.stock = Math.max(0, item.stock + delta);
  savePropertyData(); renderCleanerInventory();
}
async function cleanerAccept(cleanId) {
  const c = cleans.find(cl => String(cl.id) === String(cleanId));
  if (!c) return;
  c.cleanerConfirmed = true;
  c.cleanerDeclined = false;
  // Also update booking so owner sees confirmed status in detail
  const b = bookings.find(bk => bk.id === c.bookingId || bk.name === c.guestName);
  if (b) b.cleanerConfirmed = true;
  save();
  pushAppData('cleans', cleans);
  renderCleanerCleans();
  showBanner('✓ Clean accepted!', 'ok');
  // Push owner
  const ownerSub = await getFreshOwnerSub();
  if (ownerSub) {
    sendPushToDevice(ownerSub,
      '✅ Clean Confirmed',
      `${c.cleaner} accepted the clean for ${c.guestName || 'guest'} on ${fmt(c.date)}`,
      '/',
      'accept-' + cleanId
    );
  }
}

async function cleanerDecline(cleanId) {
  const c = cleans.find(cl => String(cl.id) === String(cleanId));
  if (!c) return;
  const ok = await showAppModal({
    title: '❌ Decline Clean?',
    msg: 'Are you sure you want to decline this clean? The owner will be notified.',
    confirmText: 'Decline',
    confirmColor: 'var(--red)',
    cancelText: 'Cancel'
  });
  if (!ok) return;
  c.cleanerDeclined = true;
  c.cleanerConfirmed = false;
  save();
  pushAppData('cleans', cleans); // push immediately
  renderCleanerCleans();
  showBanner('Clean declined', 'ok');
  // Push owner
  const ownerSub = await getFreshOwnerSub();
  if (ownerSub) {
    sendPushToDevice(ownerSub,
      '❌ Clean Declined',
      `${c.cleaner} cannot do the clean for ${c.guestName || 'guest'} on ${fmt(c.date)}. Reassign needed.`,
      '/',
      'decline-' + cleanId
    );
  }
}

async function cleanerMarkDone(cleanId) {
  const c = cleans.find(cl => String(cl.id) === String(cleanId));
  if (!c) return;
  const ok = await showAppModal({ title: '✅ Mark Complete', msg: 'Mark this clean as completed?', confirmText: 'Yes, done!', cancelText: 'Not yet' });
  if (!ok) return;
  c.done = true; c.cleanerConfirmed = true;
  save(); pushAppData('cleans', cleans); renderCleanerCleans();
  showBanner('✓ Clean marked as complete', 'ok');
  // Push owner
  const ownerSub = await getFreshOwnerSub();
  if (ownerSub) {
    sendPushToDevice(ownerSub,
      '🏡 Clean Complete!',
      `${c.cleaner} has finished the clean for ${c.guestName || 'guest'} on ${fmt(c.date)}`,
      '/',
      'done-' + cleanId
    );
  }
}
function renderCleanerView() {
  const cleaner = getActiveCleaner();
  const headerSub = document.querySelector('.cleaner-header .header-sub-name');
  if (headerSub && cleaner) headerSub.textContent = 'Hi, ' + cleaner.name.split(' ')[0] + ' 👋';
  renderCleanerCleans();
  renderCleanerInventory();
  updateCleanerNotifBtn();
}

// ── ASSIGN CLEANER TO BOOKING (from detail modal) ─────────────────────────────
async function assignCleanerToBooking(bookingId) {
  const cleanerId = parseInt(document.getElementById('detail-assign-cleaner').value);
  const date = document.getElementById('detail-assign-date').value;
  if (!cleanerId || !date) { showBanner('⚠ Select a cleaner and date', 'warn'); return; }
  const cleanerObj = loadCleaners().find(c => c.id === cleanerId);
  if (!cleanerObj) { showBanner('⚠ Cleaner not found', 'warn'); return; }
  const booking = bookings.find(b => b.id === bookingId);
  if (!booking) return;
  const existingIdx = cleans.findIndex(c => c.bookingId === bookingId);
  const newClean = {
    id: existingIdx >= 0 ? cleans[existingIdx].id : Date.now(),
    bookingId, guestName: booking.name,
    cleaner: cleanerObj.name, cleanerId: cleanerObj.id,
    date, done: false, notified: false, cleanerConfirmed: false
  };
  if (existingIdx >= 0) cleans[existingIdx] = newClean;
  else cleans.push(newClean);
  save();
  showBanner('✓ Assigned to ' + cleanerObj.name, 'ok');
  showDetail(bookingId);

  // Pull latest pushSubs from Sheet (cleaner sub lives on cleaner's device)
  try {
    const url = localStorage.getItem('gh-script-url') || DEFAULT_SCRIPT_URL;
    console.log('Fetching pushSubs from:', url);
    if (url && url.includes('script.google.com')) {
      const resp = await fetch(url + '?action=getAppData');
      const json = await resp.json();
      if (json.success && json.data && json.data.pushSubs) {
        const local = getPushSubs();
        const merged = {
          owner: local.owner || json.data.pushSubs.owner,
          cleaners: Object.assign({}, json.data.pushSubs.cleaners, local.cleaners)
        };
        localStorage.setItem('gh-push-subs', JSON.stringify(merged));
        console.log('Refreshed pushSubs. Cleaners:', Object.keys(merged.cleaners));
      } else {
        console.warn('getAppData response:', json);
      }
    }
  } catch(e) { console.warn('Could not refresh pushSubs:', e); }

  // Send push notification
  const cleanerSub = getCleanerSub(cleanerObj.id);
  console.log('Cleaner sub for id', cleanerObj.id, ':', cleanerSub ? 'found' : 'NOT FOUND');
  if (cleanerSub) {
    sendPushToDevice(cleanerSub,
      '🏡 New Clean Assigned',
      `${booking.name || 'Guest'} · ${fmt(date)}`,
      cleanerLinkForId(cleanerObj),
      'assign-' + bookingId
    );
  } else {
    console.warn('No push subscription found for cleaner', cleanerObj.id, '— cleaner needs to enable notifications');
  }

  // Send email notification via Gmail/Apps Script (fires silently in background)
  if (cleanerObj.email) {
    sendCleanerEmail({
      cleanerName: cleanerObj.name,
      cleanerEmail: cleanerObj.email,
      guestName: booking.name || 'Guest',
      checkin: fmt(booking.checkin),
      checkout: fmt(booking.checkout),
      cleanerLink: cleanerLinkForId(cleanerObj)
    }).then(result => {
      if (result.ok) showBanner('✉️ Email sent to ' + cleanerObj.name, 'ok');
      else if (result.reason !== 'no-key' && result.reason !== 'no-email') console.warn('Email failed:', result);
    });
  }
}

// ── EMAIL TEMPLATES ───────────────────────────────────────────────────────────
const EMAIL_TEMPLATE_DEFAULTS = {
  assignment: {
    subject: 'New clean assigned — {{guest_name}} ({{checkin}})',
    body: `Hi {{cleaner_name}},

You've been assigned a new clean at Glenhaven.

Guest: {{guest_name}}
Check-in: {{checkin}}
Check-out: {{checkout}}

Tap the button below to open your app and accept or decline.`,
    color: '#1E3A2F'
  },
  reminder: {
    subject: '⏰ Reminder: Clean tomorrow — {{guest_name}}',
    body: `Hi {{cleaner_name}},

Just a reminder — you have a clean tomorrow at Glenhaven.

Guest: {{guest_name}}
Clean date: {{clean_date}}

Tap the button below to open your app.`,
    color: '#E65100'
  }
};

const EMAIL_TEMPLATE_PRESETS = {
  assignment: [
    {
      label: 'Friendly',
      subject: 'New clean at Glenhaven — {{checkin}}',
      body: `Hi {{cleaner_name}},

You've been booked for a clean at Glenhaven! Here are the details:

Guest: {{guest_name}}
Check-in: {{checkin}}
Check-out: {{checkout}}

Please tap the button below to confirm you can make it.

Thanks so much! 🙏`,
      color: '#1E3A2F'
    },
    {
      label: 'Professional',
      subject: 'Clean assigned: {{guest_name}} checks out {{checkout}}',
      body: `Hi {{cleaner_name}},

A new clean has been assigned to you at Glenhaven.

Guest: {{guest_name}}
Check-in: {{checkin}}
Check-out: {{checkout}}

Open your app to accept or decline.`,
      color: '#1E3A2F'
    }
  ],
  reminder: [
    {
      label: 'Warm',
      subject: '⏰ Tomorrow\'s clean — {{guest_name}}',
      body: `Hi {{cleaner_name}},

Just a heads up — you have a clean tomorrow at Glenhaven after {{guest_name}} checks out.

Date: {{clean_date}}

Everything you need is in your app. See you there! 🏡`,
      color: '#E65100'
    },
    {
      label: 'Minimal',
      subject: 'Reminder: Glenhaven clean tomorrow',
      body: `Hi {{cleaner_name}},

Quick reminder that your clean at Glenhaven is tomorrow.

Guest: {{guest_name}}
Date: {{clean_date}}

Tap below to open your app.`,
      color: '#E65100'
    }
  ]
};

function applyPreset(type, idx) {
  const preset = EMAIL_TEMPLATE_PRESETS[type][idx];
  if (!preset) return;
  document.getElementById('etpl-subject').value = preset.subject;
  document.getElementById('etpl-body').value    = preset.body;
  document.getElementById('etpl-color').value   = preset.color;
  document.getElementById('etpl-color-preview').style.background = preset.color;
  // Highlight selected preset
  document.querySelectorAll('.etpl-preset-btn').forEach((b, i) => {
    b.style.background    = i === idx ? 'var(--forest)' : 'var(--mist)';
    b.style.color         = i === idx ? 'white' : 'var(--forest)';
    b.style.borderColor   = i === idx ? 'var(--forest)' : 'var(--stone)';
  });
  updateEmailPreview(type);
}

const EMAIL_TEMPLATE_VARS = [
  { tag: '{{cleaner_name}}', label: 'Cleaner name' },
  { tag: '{{guest_name}}',   label: 'Guest name' },
  { tag: '{{checkin}}',      label: 'Check-in date' },
  { tag: '{{checkout}}',     label: 'Check-out date' },
  { tag: '{{clean_date}}',   label: 'Clean date' },
  { tag: '{{cleaner_link}}', label: 'App link' },
];

function loadEmailTemplate(type) {
  const saved = loadJSON('gh-email-tpl-' + type);
  return saved || EMAIL_TEMPLATE_DEFAULTS[type];
}

function saveEmailTemplate(type) {
  const subject = document.getElementById('etpl-subject').value;
  const body    = document.getElementById('etpl-body').value;
  const color   = document.getElementById('etpl-color').value;
  const tpl = { subject, body, color };
  localStorage.setItem('gh-email-tpl-' + type, JSON.stringify(tpl));
  // Sync reminder template to AppData so Apps Script can use it
  if (type === 'reminder') scheduleAppDataSave('emailTplReminder', tpl);
  if (type === 'assignment') scheduleAppDataSave('emailTplAssignment', tpl);
  const conf = document.getElementById('etpl-save-confirm');
  if (conf) { conf.style.display = 'block'; setTimeout(() => conf.style.display = 'none', 2000); }
}

function resetEmailTemplate(type) {
  const def = EMAIL_TEMPLATE_DEFAULTS[type];
  document.getElementById('etpl-subject').value = def.subject;
  document.getElementById('etpl-body').value    = def.body;
  document.getElementById('etpl-color').value   = def.color;
  document.getElementById('etpl-color-preview').style.background = def.color;
}

function insertTemplateVar(tag) {
  const ta = document.getElementById('etpl-body');
  if (!ta) return;
  const start = ta.selectionStart, end = ta.selectionEnd;
  ta.value = ta.value.slice(0, start) + tag + ta.value.slice(end);
  ta.selectionStart = ta.selectionEnd = start + tag.length;
  ta.focus();
}

function openEmailTemplatePanel(type) {
  const tpl = loadEmailTemplate(type);
  const isAssignment = type === 'assignment';
  const title = isAssignment ? '📋 Assignment Email' : '⏰ Reminder Email';
  const desc  = isAssignment ? 'Sent when you assign a clean.' : 'Sent 24 hours before the clean.';

  document.getElementById('email-template-content').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:0">

      <!-- EDITOR PANE -->
      <div style="padding:0">
        <div class="card" style="margin-bottom:10px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
            <div class="card-title" style="margin-bottom:0">${title}</div>
            <div style="display:flex;gap:6px">
              <button onclick="resetEmailTemplate('${type}')" style="font-size:11px;background:none;border:1px solid var(--stone);border-radius:20px;padding:4px 10px;cursor:pointer;color:var(--text-soft);font-family:'DM Sans',sans-serif">Reset</button>
              <button onclick="saveEmailTemplate('${type}')" class="btn-primary" style="font-size:12px;padding:6px 14px">Save</button>
            </div>
          </div>
          <div id="etpl-save-confirm" style="font-size:12px;color:var(--moss);margin-bottom:6px;display:none">✓ Saved</div>
          <div style="font-size:12px;color:var(--text-soft);margin-bottom:12px">${desc}</div>

          <label>Presets</label>
          <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
            ${(EMAIL_TEMPLATE_PRESETS[type]||[]).map((p,i) => `<button class="etpl-preset-btn" onclick="applyPreset('${type}',${i})"
              style="font-size:12px;background:var(--mist);border:1px solid var(--stone);border-radius:20px;padding:6px 14px;cursor:pointer;font-family:'DM Sans',sans-serif;color:var(--forest);font-weight:500">${p.label}</button>`).join('')}
          </div>

          <label>Subject</label>
          <input type="text" id="etpl-subject" value="${(tpl.subject||'').replace(/"/g,'&quot;')}"
            style="font-size:14px;margin-bottom:10px"
            oninput="updateEmailPreview('${type}')">

          <label>Accent Colour</label>
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
            <input type="color" id="etpl-color" value="${tpl.color||'#1E3A2F'}"
              style="width:44px;height:44px;border:none;border-radius:8px;cursor:pointer;padding:2px;flex-shrink:0"
              oninput="document.getElementById('etpl-color-preview').style.background=this.value;updateEmailPreview('${type}')">
            <div id="etpl-color-preview" style="flex:1;height:44px;border-radius:8px;background:${tpl.color||'#1E3A2F'}"></div>
          </div>

          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
            <label style="margin:0">Body</label>
            <div style="display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end;max-width:65%">
              ${EMAIL_TEMPLATE_VARS.map(v => `<button onclick="insertTemplateVar('${v.tag}')"
                style="font-size:10px;background:var(--mist);border:1px solid var(--stone);border-radius:20px;padding:3px 8px;cursor:pointer;font-family:'DM Sans',sans-serif;color:var(--forest);white-space:nowrap">${v.label}</button>`).join('')}
            </div>
          </div>
          <textarea id="etpl-body" rows="7"
            style="font-size:13px;line-height:1.6;font-family:'DM Sans',sans-serif;resize:vertical;margin-bottom:0"
            oninput="updateEmailPreview('${type}')">${tpl.body||''}</textarea>
        </div>
      </div>

      <!-- PREVIEW PANE -->
      <div>
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-soft);padding:4px 4px 8px">Preview</div>
        <div style="border-radius:12px;overflow:hidden;border:1px solid var(--warm);background:white">
          <div style="background:#e8e8e8;padding:8px 12px;display:flex;align-items:center;gap:6px">
            <div style="width:10px;height:10px;border-radius:50%;background:#FF5F57"></div>
            <div style="width:10px;height:10px;border-radius:50%;background:#FEBC2E"></div>
            <div style="width:10px;height:10px;border-radius:50%;background:#28C840"></div>
            <div style="flex:1;background:white;border-radius:4px;padding:3px 8px;font-size:11px;color:#666;margin-left:4px" id="etpl-preview-subject">Subject preview</div>
          </div>
          <div id="etpl-preview-body" style="padding:16px;font-size:13px"></div>
        </div>
      </div>
    </div>`;

  document.getElementById('settings-panel-email-template').dataset.tplType = type;
  openSettingsPanel('email-template');
  setTimeout(() => updateEmailPreview(type), 50);
}

function updateEmailPreview(type) {
  const subject  = document.getElementById('etpl-subject')?.value || '';
  const body     = document.getElementById('etpl-body')?.value    || '';
  const color    = document.getElementById('etpl-color')?.value   || '#1E3A2F';

  // Fill with sample values
  function fillSample(str) {
    return str
      .replace(/{{cleaner_name}}/g, 'Megan')
      .replace(/{{guest_name}}/g,   'Sarah Johnson')
      .replace(/{{checkin}}/g,       '14 Jun 2025')
      .replace(/{{checkout}}/g,      '18 Jun 2025')
      .replace(/{{clean_date}}/g,    '18 Jun 2025')
      .replace(/{{cleaner_link}}/g,  '#');
  }

  const subjectEl = document.getElementById('etpl-preview-subject');
  if (subjectEl) subjectEl.textContent = fillSample(subject) || 'Subject preview';

  const bodyText = fillSample(body);
  const bodyHtml = bodyText.split('\n').map(line =>
    line.trim() === '' ? '<br>' : `<p style="margin:0 0 8px;font-size:13px;line-height:1.5">${line}</p>`
  ).join('');

  const previewEl = document.getElementById('etpl-preview-body');
  if (previewEl) previewEl.innerHTML = `
    <div style="font-family:sans-serif;color:#1a1a1a">
      <div style="background:${color};padding:16px 20px;border-radius:8px 8px 0 0;margin:-16px -16px 16px">
        <div style="color:white;font-size:16px;font-weight:700">🏡 Glenhaven</div>
      </div>
      ${bodyHtml}
      <div style="margin-top:16px">
        <div style="background:${color};color:white;text-align:center;padding:12px;border-radius:8px;font-weight:600;font-size:13px">Open My Cleaner App →</div>
      </div>
    </div>`;
}
function applyEmailTemplate(type, vars) {
  const tpl = loadEmailTemplate(type);
  function fill(str) {
    return str
      .replace(/{{cleaner_name}}/g, vars.cleanerName || '')
      .replace(/{{guest_name}}/g,   vars.guestName   || '')
      .replace(/{{checkin}}/g,      vars.checkin      || '')
      .replace(/{{checkout}}/g,     vars.checkout     || '')
      .replace(/{{clean_date}}/g,   vars.cleanDate    || vars.checkin || '')
      .replace(/{{cleaner_link}}/g, vars.cleanerLink  || '');
  }
  const subject = fill(tpl.subject || EMAIL_TEMPLATE_DEFAULTS[type].subject);
  const bodyText = fill(tpl.body   || EMAIL_TEMPLATE_DEFAULTS[type].body);
  const color    = tpl.color || EMAIL_TEMPLATE_DEFAULTS[type].color;
  // Convert plain text body to HTML (preserve line breaks, make link a button)
  const bodyHtml = bodyText
    .split('\n')
    .map(line => line.trim() === '' ? '<br>' : `<p style="margin:0 0 8px">${line}</p>`)
    .join('');
  const html = `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a">
    <div style="background:${color};padding:20px 24px;border-radius:10px 10px 0 0">
      <h1 style="color:white;margin:0;font-size:20px">🏡 Glenhaven</h1>
    </div>
    <div style="background:#f9f7f4;padding:24px;border-radius:0 0 10px 10px;border:1px solid #e8e0d8;border-top:none">
      ${bodyHtml}
      <div style="margin-top:20px">
        <a href="${vars.cleanerLink||'#'}" style="display:block;background:${color};color:white;text-align:center;padding:14px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">Open My Cleaner App →</a>
      </div>
    </div>
  </div>`;
  return { subject, html, text: bodyText };
}
async function sendCleanerEmail({ cleanerName, cleanerEmail, guestName, checkin, checkout, cleanerLink, cleanDate, type }) {
  const scriptUrl = localStorage.getItem('gh-script-url') || DEFAULT_SCRIPT_URL;
  if (!cleanerEmail) return { ok: false, reason: 'no-email' };
  const emailType = type || 'assignment';
  const { subject, html, text } = applyEmailTemplate(emailType, {
    cleanerName: cleanerName.split(' ')[0],
    guestName, checkin, checkout,
    cleanDate: cleanDate || checkin,
    cleanerLink
  });
  try {
    const resp = await fetch(scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'sendEmail', to: cleanerEmail, subject, html, text })
    });
    const data = await resp.json();
    return { ok: data.success, data };
  } catch(e) {
    return { ok: false, reason: e.message };
  }
}

async function debugCSVColumns() {
  const el = document.getElementById('csv-debug-result');
  el.style.display = 'block';
  if (window._csvDebug) {
    el.textContent = window._csvDebug;
    return;
  }
  el.textContent = 'Fetching…';
  try {
    const res = await fetch(SHEET_URL + '&t=' + Date.now());
    const csv = await res.text();
    const lines = csv.trim().split('\n').filter(l => l.trim());
    const headers = parseCSVLine(lines[0]);
    const firstRow = lines.length > 1 ? parseCSVLine(lines[1]) : [];
    let out = 'HEADERS:\n';
    headers.forEach((h, i) => { out += `[${i}] col ${String.fromCharCode(65+i)}: "${h}"\n`; });
    out += '\nFIRST DATA ROW:\n';
    firstRow.forEach((v, i) => { out += `[${i}]: ${JSON.stringify(v)}\n`; });
    el.textContent = out;
    window._csvDebug = out;
  } catch(e) {
    el.textContent = 'Error: ' + e.message;
  }
}

async function testCleanerEmail() {
  const resultEl = document.getElementById('email-test-result');
  if (resultEl) { resultEl.style.display = 'block'; resultEl.style.background = 'var(--warm)'; resultEl.style.color = 'var(--text-soft)'; resultEl.textContent = 'Sending…'; }
  const cleaners = loadCleaners().filter(c => c.email);
  if (!cleaners.length) {
    if (resultEl) { resultEl.style.background = '#FEF2F2'; resultEl.style.color = 'var(--red)'; resultEl.textContent = '⚠ Add an email to at least one team member first (Settings → Property → Team)'; }
    return;
  }
  const c = cleaners[0];
  const ownerEmail = localStorage.getItem('gh-owner-email') || localStorage.getItem('gh-invoice-email');
  const testTo = ownerEmail || c.email;
  const result = await sendCleanerEmail({
    cleanerName: c.name, cleanerEmail: testTo,
    guestName: 'Test Guest', checkin: 'Tomorrow', checkout: 'Day after',
    cleanerLink: cleanerLinkForId(c)
  });
  if (resultEl) {
    if (result.ok) { resultEl.style.background = '#F0FAF4'; resultEl.style.color = 'var(--moss)'; resultEl.textContent = '✓ Test email sent to ' + testTo; }
    else { resultEl.style.background = '#FEF2F2'; resultEl.style.color = 'var(--red)'; resultEl.textContent = '✕ Failed — check your Apps Script URL is saved and deployed'; }
  }
}

// ── CLEANER ACCESS SETTINGS ───────────────────────────────────────────────────
function openCleanerSettings() {
  renderCleanerAccessList();
}
function renderCleanerAccessList() {
  const el = document.getElementById('cleaner-access-list');
  if (!el) return;
  const cleaners = loadCleaners().filter(c => !c.role || c.role === 'Cleaner');
  if (!cleaners.length) {
    el.innerHTML = `<div class="card" style="margin-bottom:12px;text-align:center;padding:24px">
      <div style="font-size:32px;margin-bottom:8px">🧹</div>
      <div style="font-weight:600;font-size:14px;margin-bottom:6px">No cleaners added yet</div>
      <div style="font-size:12px;color:var(--text-soft);margin-bottom:14px">Go to Settings → Property → Team to add cleaners</div>
      <button onclick="openSettingsCat('property');openSettingsPanel('team')" class="btn-primary">Add Team Members</button>
    </div>`;
    return;
  }
  el.innerHTML = `<div class="card" style="padding:0 16px;overflow:hidden;margin-bottom:12px">` +
    cleaners.map((c, i) => `
    <div class="settings-cat-item" onclick="openCleanerProfile(${c.id})" ${i===cleaners.length-1?'style="border-bottom:none"':''}>
      <div style="display:flex;align-items:center;gap:12px">
        <div style="width:36px;height:36px;border-radius:50%;background:var(--forest);color:white;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;flex-shrink:0">${c.name.charAt(0)}</div>
        <div>
          <div style="font-weight:500;font-size:14px">${c.name}</div>
          <div style="font-size:12px;color:var(--text-soft)">${c.pin ? '🔐 PIN set' : '⚠️ No PIN'} · ${c.email ? '✉️ Email set' : 'No email'}</div>
        </div>
      </div>
      <div style="color:#C7C7CC;font-size:20px;font-weight:300">›</div>
    </div>`).join('') + `</div>
  <div class="card" style="padding:0 16px;overflow:hidden">
    <div class="settings-cat-item" onclick="openSettingsCat('property');setTimeout(()=>openSettingsPanel('team'),50)" style="border-bottom:none">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="width:36px;height:36px;border-radius:9px;background:#1E3A2F;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0">＋</div>
        <div style="font-weight:500;font-size:14px;color:var(--forest)">Add Person</div>
      </div>
      <div style="color:#C7C7CC;font-size:20px;font-weight:300">›</div>
    </div>
  </div>`;
}
function cleanerLinkForId(c) {
  const base = window.location.origin + window.location.pathname;
  return c.pin ? base + '#cleaner/' + c.id + '/' + btoa(c.pin) : base + '#cleaner/' + c.id;
}
function saveCleanerPinById(id) {
  const input = document.getElementById('pin-input-' + id);
  if (!input) return;
  const val = input.value.trim();
  if (!val || !/^\d{4}$/.test(val)) { showBanner('⚠ Please enter exactly 4 digits', 'warn'); return; }
  const list = loadCleaners();
  const c = list.find(x => x.id === id);
  if (!c) return;
  c.pin = val; input.value = '';
  saveCleaners(list);
  renderCleanerAccessList();
  showBanner('✓ PIN saved for ' + c.name, 'ok');
}
async function clearCleanerPinById(id) {
  const list = loadCleaners();
  const c = list.find(x => x.id === id);
  if (!c) return;
  const ok = await showAppModal({ title: 'Clear PIN', msg: `Remove PIN for ${c.name}?`, confirmText: 'Clear', confirmColor: 'var(--red)' });
  if (!ok) return;
  delete c.pin;
  localStorage.removeItem('gh-cleaner-authed-' + id);
  saveCleaners(list);
  renderCleanerAccessList();
  showBanner('✓ PIN cleared for ' + c.name, 'ok');
}
function saveCleanerPerm(id, key, val) {
  const list = loadCleaners();
  const c = list.find(x => x.id === id);
  if (!c) return;
  if (!c.permissions) c.permissions = {};
  c.permissions[key] = val;
  saveCleaners(list);
}
function copyCleanerLinkById(id) {
  const list = loadCleaners();
  const c = list.find(x => x.id === id);
  if (!c) return;
  if (!c.pin) { showBanner('⚠ Set a PIN for ' + c.name + ' first', 'warn'); return; }
  const url = cleanerLinkForId(c);
  navigator.clipboard.writeText(url).then(() => showBanner('✓ Link copied for ' + c.name, 'ok'))
    .catch(() => showBanner('⚠ Copy failed — select the link manually', 'warn'));
}

// Init on load
document.addEventListener('DOMContentLoaded', () => {
  initFxSettings();
  attachButtonPress();
  attachModalHandleDrag();
  // Cleaner mode detection
  if (isCleanerMode()) {
    if (isCleanerAuthed()) {
      document.body.classList.add('cleaner-mode');
      renderCleanerView();
    } else {
      document.body.classList.add('cleaner-pin-active');
    }
  }
});

// ── REPORT EXPORT ─────────────────────────────────────────────────────────────
function exportReportPDF() {
  if (!window.jspdf) { showBanner('⟳ PDF library loading, try again in a moment','warn'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const FOREST = [30, 58, 47];
  const SAGE   = [143, 175, 133];
  const SOFT   = [120, 120, 120];
  const fw = 190; // usable width
  let y = 15;

  // Header
  doc.setFillColor(...FOREST);
  doc.rect(0, 0, 210, 22, 'F');
  doc.setTextColor(255,255,255);
  doc.setFontSize(16); doc.setFont('helvetica','bold');
  doc.text('Glenhaven — Performance Report', 10, 14);
  doc.setFontSize(9); doc.setFont('helvetica','normal');
  doc.text(fyLabel(reportFY) + ' · Generated ' + new Date().toLocaleDateString('en-AU'), 200, 14, { align:'right' });
  y = 30;

  // KPI row
  doc.setTextColor(...FOREST);
  doc.setFontSize(9); doc.setFont('helvetica','bold');
  const months = fyMonths(reportFY);
  const fmt2 = n => '$' + Number(n).toLocaleString('en-AU',{minimumFractionDigits:0,maximumFractionDigits:0});
  function mdata(yr, mo) {
    const bs = bookings.filter(b => b.status !== 'cancelled' && (function(){ const d=new Date(b.checkin); return d.getFullYear()===yr&&d.getMonth()===mo; })());
    const avail = new Date(yr,mo+1,0).getDate();
    const booked = bs.reduce((s,b)=>s+Number(b.nights||0),0);
    const rev = bs.reduce((s,b)=>s+Number(b.hostPayout||0),0);
    const net = bs.reduce((s,b)=>s+Number(b.netPayout||0),0);
    return { bs, avail, booked, rev, net };
  }
  const allM = months.map(({year,month}) => ({ ...mdata(year,month), label:['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][month] }));
  const fyRev = allM.reduce((s,m)=>s+m.rev,0);
  const fyNet = allM.reduce((s,m)=>s+m.net,0);
  const fyNights = allM.reduce((s,m)=>s+m.booked,0);
  const fyAvail = allM.reduce((s,m)=>s+m.avail,0);
  const fyOcc = fyAvail ? (fyNights/fyAvail*100) : 0;
  const allExp = (JSON.parse(localStorage.getItem('gh-expenses')||'[]')).filter(e => {
    const d=new Date(e.date); const mo=d.getMonth(); const yr=d.getFullYear();
    return (yr===reportFY&&mo>=6)||(yr===reportFY+1&&mo<=5);
  });
  const fyTotalExp = allExp.reduce((s,e)=>s+Number(e.amount||0),0);
  const fyNetInc = fyNet - fyTotalExp;

  const kpis = [
    { label:'Total Revenue', val: fmt2(fyRev) },
    { label:'Net Payout',    val: fmt2(fyNet) },
    { label:'Net Income',    val: fmt2(Math.abs(fyNetInc)) + (fyNetInc<0?' (Loss)':'') },
    { label:'Occupancy',     val: fyOcc.toFixed(0)+'%' },
  ];
  const kw = fw/4;
  kpis.forEach((k,i) => {
    const x = 10 + i*kw;
    doc.setFillColor(240,246,240);
    doc.roundedRect(x, y, kw-3, 18, 2, 2, 'F');
    doc.setFontSize(14); doc.setFont('helvetica','bold'); doc.setTextColor(...FOREST);
    doc.text(k.val, x + (kw-3)/2, y+11, { align:'center' });
    doc.setFontSize(7); doc.setFont('helvetica','normal'); doc.setTextColor(...SOFT);
    doc.text(k.label.toUpperCase(), x + (kw-3)/2, y+16, { align:'center' });
  });
  y += 25;

  // Revenue by Platform
  doc.setFontSize(11); doc.setFont('helvetica','bold'); doc.setTextColor(...FOREST);
  doc.text('Revenue by Month & Platform', 10, y); y += 4;
  const platforms = ['Airbnb','VRBO','Direct'];
  doc.autoTable({
    startY: y, margin: { left:10, right:10 },
    head: [['Month','Airbnb','VRBO','Direct','Total']],
    body: [
      ...allM.map(m => [
        m.label,
        ...platforms.map(p => { const r=m.bs.filter(b=>b.platform===p).reduce((s,b)=>s+Number(b.hostPayout||0),0); return r?fmt2(r):'—'; }),
        m.rev ? fmt2(m.rev) : '—'
      ]),
      ['Total', ...platforms.map(p=>fmt2(allM.reduce((s,m)=>s+m.bs.filter(b=>b.platform===p).reduce((ss,b)=>ss+Number(b.hostPayout||0),0),0))), fmt2(fyRev)]
    ],
    headStyles: { fillColor: FOREST, textColor:[255,255,255], fontSize:8, fontStyle:'bold' },
    bodyStyles: { fontSize:9 },
    alternateRowStyles: { fillColor:[248,252,248] },
    foot: [], showFoot: 'never',
    didDrawRow: (data) => { if (data.row.index === allM.length) data.row.cells.forEach(c => { c.styles.fontStyle='bold'; c.styles.fillColor=[220,236,220]; }); }
  });
  y = doc.lastAutoTable.finalY + 8;

  // Occupancy & Performance
  doc.setFontSize(11); doc.setFont('helvetica','bold'); doc.setTextColor(...FOREST);
  doc.text('Occupancy & Performance', 10, y); y += 4;
  doc.autoTable({
    startY: y, margin: { left:10, right:10 },
    head: [['Month','Avail','Booked','Occ%','ADR','RevPAR']],
    body: [
      ...allM.map(m => [
        m.label, m.avail, m.booked,
        m.avail ? (m.booked/m.avail*100).toFixed(0)+'%' : '—',
        m.booked ? '$'+Math.round(m.rev/m.booked) : '—',
        m.avail  ? '$'+Math.round(m.rev/m.avail)  : '—',
      ]),
      ['FY Total', fyAvail, fyNights, fyOcc.toFixed(0)+'%', fyNights?'$'+Math.round(fyRev/fyNights):'—', '$'+Math.round(fyRev/fyAvail)]
    ],
    headStyles: { fillColor: FOREST, textColor:[255,255,255], fontSize:8, fontStyle:'bold' },
    bodyStyles: { fontSize:9 },
    alternateRowStyles: { fillColor:[248,252,248] },
  });
  y = doc.lastAutoTable.finalY + 4;
  doc.setFontSize(7); doc.setFont('helvetica','normal'); doc.setTextColor(...SOFT);
  doc.text('ADR = Revenue ÷ Booked Nights   ·   RevPAR = Revenue ÷ All Available Nights   ·   ALOS = Avg Length of Stay', 10, y);
  y += 8;

  // Expenses
  const expCats = getExpenseCats();
  const expByCategory = {};
  expCats.forEach(c => { expByCategory[c] = allExp.filter(e=>e.category===c).reduce((s,e)=>s+Number(e.amount||0),0); });
  if (allExp.length) {
    doc.setFontSize(11); doc.setFont('helvetica','bold'); doc.setTextColor(...FOREST);
    doc.text('Expenses by Category', 10, y); y += 4;
    doc.autoTable({
      startY: y, margin: { left:10, right:10 },
      head: [['Category','Amount','%']],
      body: [
        ...expCats.filter(c=>expByCategory[c]>0).sort((a,b)=>expByCategory[b]-expByCategory[a]).map(c => [
          c, fmt2(expByCategory[c]), fyTotalExp?(expByCategory[c]/fyTotalExp*100).toFixed(0)+'%':'—'
        ]),
        ['Total Expenses', fmt2(fyTotalExp), '100%']
      ],
      headStyles: { fillColor: FOREST, textColor:[255,255,255], fontSize:8 },
      bodyStyles: { fontSize:9 },
      alternateRowStyles: { fillColor:[248,252,248] },
    });
    y = doc.lastAutoTable.finalY + 8;
  }

  // Net Income Summary
  doc.setFontSize(11); doc.setFont('helvetica','bold'); doc.setTextColor(...FOREST);
  doc.text('Net Income Summary', 10, y); y += 4;
  doc.autoTable({
    startY: y, margin: { left:10, right:10 },
    head: [['Item','Amount']],
    body: [
      ['Total Revenue (Host Payout)', fmt2(fyRev)],
      ['Net Payout (after platform fees)', fmt2(fyNet)],
      ['Total Expenses', '- ' + fmt2(fyTotalExp)],
      ['Net Income', (fyNetInc<0?'- ':'')+fmt2(Math.abs(fyNetInc))],
    ],
    headStyles: { fillColor: FOREST, textColor:[255,255,255], fontSize:8 },
    bodyStyles: { fontSize:9 },
    alternateRowStyles: { fillColor:[248,252,248] },
    didDrawRow: data => { if (data.row.index===3) { data.row.cells.forEach(c => { c.styles.fontStyle='bold'; c.styles.fillColor=fyNetInc>=0?[220,236,220]:[254,226,226]; }); } }
  });

  doc.save(`Glenhaven-${fyLabel(reportFY).replace(' ','_')}.pdf`);
}

function exportReportCSV() {
  const months = fyMonths(reportFY);
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const rows = [['Glenhaven Performance Report — ' + fyLabel(reportFY)],[]];

  // Revenue table
  rows.push(['Revenue by Month & Platform']);
  rows.push(['Month','Airbnb','VRBO','Direct','Total']);
  months.forEach(({year,month}) => {
    const bs = bookings.filter(b => { const d=new Date(b.checkin); return d.getFullYear()===year&&d.getMonth()===month; });
    const rev = p => bs.filter(b=>b.platform===p).reduce((s,b)=>s+Number(b.hostPayout||0),0);
    const total = bs.reduce((s,b)=>s+Number(b.hostPayout||0),0);
    rows.push([mo[month], rev('Airbnb')||'', rev('VRBO')||'', rev('Direct')||'', total||'']);
  });
  rows.push([]);

  // Occupancy table
  rows.push(['Occupancy & Performance']);
  rows.push(['Month','Available Nights','Booked Nights','Occupancy%','ADR','RevPAR']);
  months.forEach(({year,month}) => {
    const bs = bookings.filter(b => { const d=new Date(b.checkin); return d.getFullYear()===year&&d.getMonth()===month; });
    const avail = new Date(year,month+1,0).getDate();
    const booked = bs.reduce((s,b)=>s+Number(b.nights||0),0);
    const rev = bs.reduce((s,b)=>s+Number(b.hostPayout||0),0);
    rows.push([mo[month], avail, booked,
      avail ? (booked/avail*100).toFixed(1)+'%' : '',
      booked ? (rev/booked).toFixed(2) : '',
      avail  ? (rev/avail).toFixed(2)  : ''
    ]);
  });
  rows.push([]);

  // Expenses
  const allExp = (JSON.parse(localStorage.getItem('gh-expenses')||'[]')).filter(e => {
    const d=new Date(e.date); const m=d.getMonth(); const yr=d.getFullYear();
    return (yr===reportFY&&m>=6)||(yr===reportFY+1&&m<=5);
  });
  rows.push(['Expenses by Category']);
  rows.push(['Category','Amount']);
  const expCats = getExpenseCats();
  expCats.forEach(c => {
    const total = allExp.filter(e=>e.category===c).reduce((s,e)=>s+Number(e.amount||0),0);
    if (total) rows.push([c, total.toFixed(2)]);
  });

  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `Glenhaven-${fyLabel(reportFY).replace(' ','_')}.csv`;
  a.click(); URL.revokeObjectURL(url);
  showBanner('✅ CSV downloaded','success');
}
