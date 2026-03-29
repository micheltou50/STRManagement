import { AIService }     from './ai-logic.js';
import { SupabaseAdapter } from './adapter.js';
import { showSetupIfNeeded } from './setup.js';
import {
  lsKey,
  getAllProperties,
  getActivePropertyId,
  setActivePropertyId,
  getActivePropertyConfig,
  addPropertyConfig,
  getPropertyConfig,
  savePropertyConfig,
  saveAllProperties,
  hasValidPropertyConfig,
  getCurrentPropertyName,
  getCurrentPropertyTagline,
  getCurrentHostEmail,
  getVapidPublicKey,
  getPushFunctionUrl,
  getPropertyStats,
  getPricingConfig,
  getPropertyConfigGaps,
  migrateConfigFromLegacySettings,
  initPropertyUI,
} from './config.js';
import {
  getSupabaseSession,
  getCurrentSupabaseUser,
  seedLocalConfigFromCloud,
  hydrateFromCloud,
  savePropertyToCloud,
  saveCleanersToCloud,
  loadCleansFromCloud,
  saveCleanToCloud,
  saveCleansToCloud,
  saveCleaningJobToCloud,
  saveNotesToCloud,
  saveExpenseToCloud,
  deleteExpenseFromCloud,
  saveInventoryToCloud,
  saveMaintenanceToCloud,
  deleteMaintenanceFromCloud,
  saveBookingToCloud,
  saveBookingsToCloud,
  deleteBookingFromCloud,
  uploadReceiptToStorage,
  saveAppConfigToCloud,
  saveHostConfigToSupabase,
  loadHostConfigFromSupabase,
  showLoadingScreen,
  hideLoadingScreen,
  setLoadingStatus,
  showLoginScreen,
  showAppChrome,
  handleLoginSubmit,
  handleSignUpSubmit,
  toggleSignUp,
  hostSignOut,
} from './supabase.js';

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


function parseLocalDayStart(dateLike) {
  const key = String(dateLike || '').slice(0, 10);
  return key ? new Date(key + 'T00:00:00') : new Date('');
}

function fmtShort(dateStr) {
  if (!dateStr) return '';
  const d = parseLocalDayStart(dateStr);
  return Number.isNaN(d.getTime()) ? String(dateStr).slice(0, 10) : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

function isAwaitingCleanerResponse(clean, nowRef) {
  if (!clean) return false;
  if (!clean.cleaner && !clean.cleanerId) return false;
  if (clean.done || clean.cleanerDeclined || clean.cleanerConfirmed) return false;
  const now = nowRef instanceof Date ? nowRef : new Date();
  const assignedAt = clean.assignedAt ? new Date(clean.assignedAt) : null;
  const ageMs = assignedAt && !Number.isNaN(assignedAt.getTime()) ? (now.getTime() - assignedAt.getTime()) : 0;
  return ageMs >= 0;
}

function getAwaitingResponseMeta(clean, nowRef) {
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

// ── CONFIG ────────────────────────────────────────────────────────────────
const VAPID_PUBLIC_KEY = 'BO-fP_0TOY1foiCQtOZ40N7io1MAzoMUui6pmeHPJ3jLxbdNGh0SrRjxtvWVhuf4QKvf4q83eyS_wcICiS4cgc4';
const PUSH_FUNCTION_URL = '/.netlify/functions/send-push';

// ── PUSH NOTIFICATIONS ────────────────────────────────────────────────────────
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

function safePushStringify(v) {
  try { return JSON.stringify(v); } catch (_) { return '[unserializable]'; }
}


function getPushSubs() {
  return JSON.parse(localStorage.getItem(lsKey('push-subs')) || '{"cleaners":{}}');
}
function savePushSubsLocal(subs) {
  console.log('[Push] savePushSubsLocal: saving local + requesting AppData sync', {
    hasOwner: !!(subs && subs.owner),
    cleanerCount: Object.keys((subs && subs.cleaners) || {}).length
  });
  localStorage.setItem(lsKey('push-subs'), JSON.stringify(subs));
  // Save push subs to Supabase app_config
  if (typeof saveAppConfigToCloud === 'function') {
    saveAppConfigToCloud({ push_subs: subs }).catch(() => {});
  }
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
        : '❌ Could not enable notifications. Please try again.';
    }
    if (btn) { btn.disabled = false; btn.textContent = '🔔 Enable Notifications on This Device'; }
  }
}

async function resetPushOnly() {
  console.log('[Push] Reset Push Only started');
  const result = document.getElementById('notif-result');
  try {
    if (!('serviceWorker' in navigator)) throw new Error('serviceWorker unavailable');
    const reg = await navigator.serviceWorker.ready;
    const sub = reg && reg.pushManager ? await reg.pushManager.getSubscription() : null;
    if (sub) {
      const unsubscribed = await sub.unsubscribe();
      console.log('[Push] Reset Push Only unsubscribe result:', unsubscribed);
    } else {
      console.log('[Push] Reset Push Only: no existing subscription');
    }
    localStorage.removeItem(lsKey('push-subs'));
    localStorage.removeItem('gh-push-subs');
    console.log('[Push] Reset Push Only complete');
    if (result) {
      result.style.display = 'block';
      result.style.color = 'var(--moss)';
      result.textContent = '✓ Reset Push Only complete';
    }
    if (typeof updateNotifStatus === 'function') updateNotifStatus();
  } catch (e) {
    console.warn('[Push] Reset Push Only failed:', e);
    if (result) {
      result.style.display = 'block';
      result.style.color = 'var(--red)';
      result.textContent = '❌ Reset Push Only failed';
    }
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
  if (typeof refreshConnectionSummarySoon === 'function') refreshConnectionSummarySoon();
}

async function subscribeToPush(role, cleanerId) {
  console.log('[Push] subscribeToPush start', { role, cleanerId: cleanerId || null });
  console.log('[Push] serviceWorker available:', 'serviceWorker' in navigator);
  console.log('[Push] PushManager available:', 'PushManager' in window);
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('Push not supported on this browser');
    return null;
  }
  try {
    console.log('[Push] Notification.permission before request:', Notification.permission);
    console.log('[Push] waiting for navigator.serviceWorker.ready...');
    const reg = await navigator.serviceWorker.ready;
    console.log('[Push] navigator.serviceWorker.ready resolved:', !!reg);
    console.log('[Push] registration.pushManager exists:', !!(reg && reg.pushManager));
    console.log('SW ready, getting push subscription...');
    let sub = await reg.pushManager.getSubscription();
    console.log('[Push] existing subscription found:', !!sub);
    if (!sub) {
      console.log('[Push] calling Notification.requestPermission()');
      const permission = await Notification.requestPermission();
      console.log('Notification permission:', permission);
      if (permission !== 'granted') return null;
      console.log('[Push] calling pushManager.subscribe()');
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(getVapidPublicKey())
      });
      console.log('[Push] pushManager.subscribe() succeeded:', !!sub);
      const subscribedJson = sub && typeof sub.toJSON === 'function' ? sub.toJSON() : null;
      console.log('[Push] post-subscribe endpoint:', subscribedJson && subscribedJson.endpoint ? subscribedJson.endpoint : null);
      console.log('[Push] post-subscribe object:', safePushStringify(subscribedJson || sub || null));
    }
    const subJson = sub.toJSON();
    console.log('Subscription endpoint:', subJson.endpoint.substring(0, 60) + '...');
    console.log('[Push] subscription endpoint (full):', subJson.endpoint || null);
    console.log('[Push] subscription object (safe stringify):', safePushStringify(subJson || null));
    const subs = getPushSubs();
    if (role === 'owner') {
      subs.owner = subJson;
    } else if (role === 'cleaner' && cleanerId) {
      if (!subs.cleaners) subs.cleaners = {};
      subs.cleaners[String(cleanerId)] = subJson;
    }
    console.log('[Push] before saving subscription', { role, cleanerId: cleanerId || null, endpoint: subJson.endpoint || null });
    savePushSubsLocal(subs);
    console.log('[Push] after saving subscription', { role, cleanerId: cleanerId || null, endpoint: subJson.endpoint || null });
    console.log('Subscription saved for role:', role, cleanerId || '');
    return subJson;
  } catch(e) {
    console.warn('[Push] subscribeToPush caught error object:', e);
    console.warn('[Push] subscribeToPush error.name:', e && e.name);
    console.warn('[Push] subscribeToPush error.message:', e && e.message);
    console.warn('Push subscribe failed:', e);
    return null;
  }
}

async function sendPushToDevice(subscription, title, body, url, tag) {
  if (!subscription) { console.warn('sendPushToDevice called with no subscription'); return { ok: false, reason: 'no-subscription' }; }
  try {
    console.log('[Push] before sending push endpoint:', subscription && subscription.endpoint ? subscription.endpoint : null);
    console.log('[Push] before sending push subscription (safe stringify):', safePushStringify(subscription || null));
    console.log('Sending push "' + title + '" to endpoint:', subscription.endpoint.substring(0, 50) + '...');
    const res = await fetch(getPushFunctionUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription, title, body, url, tag })
    });
    console.log('[Push] send push HTTP status:', res.status);
    console.log('Push HTTP status:', res.status);
    const data = await res.json().catch(() => null);
    console.log('[Push] send push response body:', data);
    if (data === null) throw new Error('Invalid JSON from send-push function');
    console.log('Push function response:', data);
    const ok = !!(res.ok && data.ok);
    if (data.expired) {
      const subs = getPushSubs();
      if (subs.owner && JSON.stringify(subs.owner) === JSON.stringify(subscription)) delete subs.owner;
      Object.keys(subs.cleaners || {}).forEach(id => {
        if (JSON.stringify(subs.cleaners[id]) === JSON.stringify(subscription)) delete subs.cleaners[id];
      });
      savePushSubsLocal(subs);
    }
    if (!ok) console.warn('Push send not successful:', data);
    return { ok, data };
  } catch(e) {
    console.warn('Push send failed:', e);
    return { ok: false, reason: e && e.message ? e.message : 'push-send-failed' };
  }
}

function getOwnerSub() { return getPushSubs().owner || null; }
function getCleanerSub(cleanerId) { return (getPushSubs().cleaners || {})[String(cleanerId)] || null; }

async function getFreshOwnerSub() {
  return getOwnerSub();
}

// Register service worker on load
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(e => console.warn('SW register failed:', e));
}

// ── STATE ────────────────────────────────────────────────────────────────
let bookingFilter = 'upcoming';
let cleanFilter = 'upcoming';
function loadJSON(key, fallback) {
  fallback = fallback !== undefined ? fallback : [];
  try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
  catch(e) { console.warn('loadJSON failed for', key, e); return fallback; }
}

function getPlanStateLite() {
  const raw = localStorage.getItem('gh-plan-state') || 'free';
  return raw === 'pro' ? 'pro' : 'free';
}

function getUsageSnapshotLite() {
  const props = (typeof getAllProperties === 'function' ? getAllProperties() : []) || [];
  const propertyCount = props.length;
  const bookingCount = bookings.filter(b => b.status !== 'cancelled').length;
  const cleanerCount = loadCleaners().filter(c => isCleanerPerson(c)).length;
  return { propertyCount, bookingCount, cleanerCount };
}

function getPlanWarningLines(usage, planLimits) {
  const lines = [];
  const pushNudge = (label, count, limit) => {
    if (!Number.isFinite(limit) || limit >= 900) return;
    if (count >= limit) lines.push(`⚠ ${label}: ${count}/${limit} on Free — consider Pro when available.`);
    else if (count >= Math.ceil(limit * 0.8)) lines.push(`↗ ${label}: ${count}/${limit} — nearing the Free plan guide.`);
  };
  pushNudge('Properties', usage.propertyCount, planLimits.properties);
  pushNudge('Bookings', usage.bookingCount, planLimits.bookings);
  pushNudge('Cleaners', usage.cleanerCount, planLimits.cleaners);
  return lines;
}

function renderSettingsPlanUsageCard() {
  const planEl = document.getElementById('settings-plan-nudge');
  if (planEl) planEl.innerHTML = '';
}


function renderOnboardingGuidance(usageSnapshot) {
  const el = document.getElementById('dashboard-product-guidance');
  if (el) el.innerHTML = '';
}

function renderPlanNudges(usageSnapshot, planState) {
  const el = document.getElementById('dashboard-plan-nudges');
  if (el) el.innerHTML = '';
}

function renderConnectionSummary() {
  const wrap = document.getElementById('integrations-conn-list');
  if (!wrap) return;

  const user = window._supabaseUser;
  const feedUrl = user
    ? window.location.origin + '/.netlify/functions/calendar-feed?uid=' + user.id
    : '';

  const gmailEmail = localStorage.getItem('gh-gmail-email') || '';
  const gmailConnected = !!gmailEmail;

  const outlookEmail = localStorage.getItem('gh-outlook-email') || '';
  const outlookConnected = !!outlookEmail;

  wrap.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:var(--mist);border-radius:10px">
      <div style="font-size:13px;color:var(--text)">Supabase</div>
      <div style="font-size:12px;color:var(--moss)">✓ Connected</div>
    </div>

    <div style="padding:12px;background:var(--mist);border-radius:10px;margin-top:8px">
      <div style="font-size:12px;font-weight:700;color:var(--forest);margin-bottom:6px">📧 Gmail — Booking Import</div>
      ${gmailConnected ? `
        <div style="font-size:12px;color:var(--moss);margin-bottom:8px">✓ Connected: ${escHtml(gmailEmail)}</div>
        <div style="display:flex;gap:6px">
          <button onclick="scanGmailBookings()" id="gmail-scan-btn"
            style="flex:1;background:var(--forest);color:white;border:none;border-radius:8px;padding:10px 14px;font-size:13px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">📥 Scan for Bookings</button>
          <button onclick="connectGmail()" 
            style="background:var(--warm);color:var(--forest);border:none;border-radius:8px;padding:10px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif;white-space:nowrap">Reconnect</button>
        </div>
        <div id="gmail-scan-status" style="display:none;margin-top:8px;padding:10px;border-radius:8px;font-size:12px;line-height:1.5"></div>
      ` : `
        <div style="font-size:11px;color:var(--text-soft);margin-bottom:8px;line-height:1.5">Connect your Gmail to automatically import bookings from Airbnb, VRBO, Booking.com, and other platforms.</div>
        <button onclick="connectGmail()"
          style="width:100%;background:white;border:1.5px solid var(--stone);border-radius:10px;padding:12px;font-size:14px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif;display:flex;align-items:center;justify-content:center;gap:10px">
          <img src="https://www.google.com/favicon.ico" width="18" height="18" style="border-radius:3px"> Connect Gmail
        </button>
      `}
    </div>

    <div style="padding:12px;background:var(--mist);border-radius:10px;margin-top:8px">
      <div style="font-size:12px;font-weight:700;color:var(--forest);margin-bottom:6px">📧 Outlook — Booking Import</div>
      ${outlookConnected ? `
        <div style="font-size:12px;color:var(--moss);margin-bottom:8px">✓ Connected: ${escHtml(outlookEmail)}</div>
        <div style="display:flex;gap:6px">
          <button onclick="scanOutlookBookings()" id="outlook-scan-btn"
            style="flex:1;background:var(--forest);color:white;border:none;border-radius:8px;padding:10px 14px;font-size:13px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">📥 Scan for Bookings</button>
          <button onclick="connectOutlook()"
            style="background:var(--warm);color:var(--forest);border:none;border-radius:8px;padding:10px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif;white-space:nowrap">Reconnect</button>
        </div>
        <div id="outlook-scan-status" style="display:none;margin-top:8px;padding:10px;border-radius:8px;font-size:12px;line-height:1.5"></div>
      ` : `
        <div style="font-size:11px;color:var(--text-soft);margin-bottom:8px;line-height:1.5">Connect your Outlook / Hotmail account to automatically import bookings from Airbnb, VRBO, Booking.com, and other platforms.</div>
        <button onclick="connectOutlook()"
          style="width:100%;background:white;border:1.5px solid var(--stone);border-radius:10px;padding:12px;font-size:14px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif;display:flex;align-items:center;justify-content:center;gap:10px">
          <img src="https://www.microsoft.com/favicon.ico" width="18" height="18" style="border-radius:3px"> Connect Outlook
        </button>
      `}
    </div>

    ${feedUrl ? `
    <div style="padding:12px;background:var(--mist);border-radius:10px;margin-top:8px">
      <div style="font-size:12px;font-weight:700;color:var(--forest);margin-bottom:6px">📅 Calendar Feed</div>
      <div style="font-size:11px;color:var(--text-soft);margin-bottom:8px;line-height:1.5">Subscribe to this URL in Apple Calendar, Google Calendar, or Outlook to auto-sync your bookings.</div>
      <div style="display:flex;gap:6px">
        <input id="calendar-feed-url" type="text" value="${escHtml(feedUrl)}" readonly
          style="flex:1;font-size:11px;padding:8px 10px;border:1px solid var(--stone);border-radius:8px;background:white;font-family:monospace;color:var(--text);min-width:0"
          onclick="this.select()">
        <button onclick="copyCalendarFeedUrl()" id="copy-feed-btn"
          style="background:var(--forest);color:white;border:none;border-radius:8px;padding:8px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif;white-space:nowrap">Copy</button>
      </div>
    </div>` : ''}`
  ;
}

async function connectGmail() {
  const user = await getCurrentSupabaseUser();
  if (!user) { showBanner('⚠ Please sign in first', 'warn'); return; }
  window.location.href = '/.netlify/functions/gmail-oauth-start?state=' + encodeURIComponent(user.id);
}

async function connectOutlook() {
  const user = await getCurrentSupabaseUser();
  if (!user) { showBanner('⚠ Please sign in first', 'warn'); return; }
  window.location.href = '/.netlify/functions/outlook-oauth-start?state=' + encodeURIComponent(user.id);
}

// Silent background Gmail scan — runs automatically on boot, throttled to once per 30 min.
// Does not touch button UI; only refreshes data if bookings changed.
async function maybeAutoScanGmail() {
  try {
    const gmailEmail = localStorage.getItem('gh-gmail-email') || '';
    if (!gmailEmail) return; // Gmail not connected
    const user = window._supabaseUser;
    if (!user) return;

    // No throttle — scan runs every time the app is opened

    const _pid = (window._cloudPropertyIds && window._cloudPropertyIds[getActivePropertyId()]) || '';
    const res = await fetch('/.netlify/functions/gmail-scan-bookings?uid=' + encodeURIComponent(user.id) + (_pid ? '&pid=' + encodeURIComponent(_pid) : ''));
    if (!res.ok) return;
    const data = await res.json();

    const totalChanges = (data.imported || 0) + (data.updated || 0) + (data.cancelled || 0);
    if (totalChanges > 0) {
      if (typeof hydrateFromCloud === 'function') await hydrateFromCloud();
      reloadInMemoryData();
      renderAll();
      const parts = [];
      if (data.imported) parts.push(data.imported + ' imported');
      if (data.updated) parts.push(data.updated + ' updated');
      if (data.cancelled) parts.push(data.cancelled + ' cancelled');
      showBanner('✓ ' + parts.join(', ') + ' from Gmail', 'ok');
    }
    await processScanNeedsReview(data);
  } catch (e) {
    // Silent — auto-scan errors must never surface to the user
    console.warn('[gmail-auto-scan] background scan error:', e.message);
  }
}

async function scanGmailBookings() {
  const user = window._supabaseUser;
  if (!user) { showBanner('⚠ Please sign in first', 'warn'); return; }

  const btn = document.getElementById('gmail-scan-btn');
  const statusEl = document.getElementById('gmail-scan-status');
  if (btn) { btn.disabled = true; btn.textContent = '⟳ Scanning…'; }
  if (statusEl) {
    statusEl.style.display = 'block';
    statusEl.style.background = '#FFF8E1';
    statusEl.style.color = '#E65100';
    statusEl.textContent = 'Scanning Gmail for booking confirmations…';
  }

  try {
    const _pid = (window._cloudPropertyIds && window._cloudPropertyIds[getActivePropertyId()]) || '';
    const res = await fetch('/.netlify/functions/gmail-scan-bookings?uid=' + encodeURIComponent(user.id) + (_pid ? '&pid=' + encodeURIComponent(_pid) : ''));
    const data = await res.json();

    if (!res.ok) {
      if (statusEl) {
        statusEl.style.background = '#FEF2F2';
        statusEl.style.color = 'var(--red)';
        statusEl.textContent = '⚠ ' + (data.error || 'Scan failed');
      }
      if (btn) { btn.disabled = false; btn.textContent = '📥 Scan for Bookings'; }
      return;
    }

    if (statusEl) {
      const hasChanges = (data.imported || 0) + (data.updated || 0) + (data.cancelled || 0) > 0;
      statusEl.style.background = hasChanges ? '#EDF7ED' : 'var(--mist)';
      statusEl.style.color = hasChanges ? 'var(--forest)' : 'var(--text-soft)';

      let msg = data.message || 'Scan complete';
      if (data.details && data.details.length) {
        const actionItems = data.details
          .filter(d => d.status === 'imported' || d.status === 'updated' || d.status === 'cancelled')
          .map(d => {
            const label = d.status === 'cancelled' ? '❌' : d.status === 'updated' ? '✏️' : '✅';
            return label + ' ' + (d.guest || 'Guest') + (d.checkin ? ' (' + d.checkin + ')' : '');
          })
          .join(', ');
        if (actionItems) msg += ': ' + actionItems;
      }
      if (data.remaining > 0) msg += ' · ' + data.remaining + ' more emails to process — scan again';
      statusEl.textContent = (hasChanges ? '✓ ' : '') + msg;
    }

    // Refresh data if any bookings changed
    const totalChanges = (data.imported || 0) + (data.updated || 0) + (data.cancelled || 0);
    if (totalChanges > 0) {
      if (typeof hydrateFromCloud === 'function') await hydrateFromCloud();
      reloadInMemoryData();
      renderAll();
      const parts = [];
      if (data.imported) parts.push(data.imported + ' imported');
      if (data.updated) parts.push(data.updated + ' updated');
      if (data.cancelled) parts.push(data.cancelled + ' cancelled');
      showBanner('✓ ' + parts.join(', ') + ' from Gmail', 'ok');
    }

    await processScanNeedsReview(data);

  } catch (e) {
    if (statusEl) {
      statusEl.style.background = '#FEF2F2';
      statusEl.style.color = 'var(--red)';
      statusEl.textContent = '⚠ Network error — check connection';
    }
  }

  if (btn) { btn.disabled = false; btn.textContent = '📥 Scan for Bookings'; }
}

// Silent background Outlook scan — mirrors maybeAutoScanGmail exactly.
async function maybeAutoScanOutlook() {
  try {
    const outlookEmail = localStorage.getItem('gh-outlook-email') || '';
    if (!outlookEmail) return; // Outlook not connected
    const user = window._supabaseUser;
    if (!user) return;

    const _pid = (window._cloudPropertyIds && window._cloudPropertyIds[getActivePropertyId()]) || '';
    const res = await fetch('/.netlify/functions/outlook-scan-bookings?uid=' + encodeURIComponent(user.id) + (_pid ? '&pid=' + encodeURIComponent(_pid) : ''));
    if (!res.ok) return;
    const data = await res.json();

    const totalChanges = (data.imported || 0) + (data.updated || 0) + (data.cancelled || 0);
    if (totalChanges > 0) {
      if (typeof hydrateFromCloud === 'function') await hydrateFromCloud();
      reloadInMemoryData();
      renderAll();
      const parts = [];
      if (data.imported) parts.push(data.imported + ' imported');
      if (data.updated) parts.push(data.updated + ' updated');
      if (data.cancelled) parts.push(data.cancelled + ' cancelled');
      showBanner('✓ ' + parts.join(', ') + ' from Outlook', 'ok');
    }
    await processScanNeedsReview(data);
  } catch (e) {
    console.warn('[outlook-auto-scan] background scan error:', e.message);
  }
}

async function scanOutlookBookings() {
  const user = window._supabaseUser;
  if (!user) { showBanner('⚠ Please sign in first', 'warn'); return; }

  const btn = document.getElementById('outlook-scan-btn');
  const statusEl = document.getElementById('outlook-scan-status');
  if (btn) { btn.disabled = true; btn.textContent = '⟳ Scanning…'; }
  if (statusEl) {
    statusEl.style.display = 'block';
    statusEl.style.background = '#FFF8E1';
    statusEl.style.color = '#E65100';
    statusEl.textContent = 'Scanning Outlook for booking confirmations…';
  }

  try {
    const _pid = (window._cloudPropertyIds && window._cloudPropertyIds[getActivePropertyId()]) || '';
    const res = await fetch('/.netlify/functions/outlook-scan-bookings?uid=' + encodeURIComponent(user.id) + (_pid ? '&pid=' + encodeURIComponent(_pid) : ''));
    const data = await res.json();

    if (!res.ok) {
      if (statusEl) {
        statusEl.style.background = '#FEF2F2';
        statusEl.style.color = 'var(--red)';
        statusEl.textContent = '⚠ ' + (data.error || 'Scan failed');
      }
      if (btn) { btn.disabled = false; btn.textContent = '📥 Scan for Bookings'; }
      return;
    }

    if (statusEl) {
      const hasChanges = (data.imported || 0) + (data.updated || 0) + (data.cancelled || 0) > 0;
      statusEl.style.background = hasChanges ? '#EDF7ED' : 'var(--mist)';
      statusEl.style.color = hasChanges ? 'var(--forest)' : 'var(--text-soft)';

      let msg = data.message || 'Scan complete';
      if (data.details && data.details.length) {
        const actionItems = data.details
          .filter(d => d.status === 'imported' || d.status === 'updated' || d.status === 'cancelled')
          .map(d => {
            const label = d.status === 'cancelled' ? '❌' : d.status === 'updated' ? '✏️' : '✅';
            return label + ' ' + (d.guest || 'Guest') + (d.checkin ? ' (' + d.checkin + ')' : '');
          })
          .join(', ');
        if (actionItems) msg += ': ' + actionItems;
      }
      if (data.remaining > 0) msg += ' · ' + data.remaining + ' more emails to process — scan again';
      statusEl.textContent = (hasChanges ? '✓ ' : '') + msg;
    }

    const totalChanges = (data.imported || 0) + (data.updated || 0) + (data.cancelled || 0);
    if (totalChanges > 0) {
      if (typeof hydrateFromCloud === 'function') await hydrateFromCloud();
      reloadInMemoryData();
      renderAll();
      const parts = [];
      if (data.imported) parts.push(data.imported + ' imported');
      if (data.updated) parts.push(data.updated + ' updated');
      if (data.cancelled) parts.push(data.cancelled + ' cancelled');
      showBanner('✓ ' + parts.join(', ') + ' from Outlook', 'ok');
    }

    await processScanNeedsReview(data);

  } catch (e) {
    if (statusEl) {
      statusEl.style.background = '#FEF2F2';
      statusEl.style.color = 'var(--red)';
      statusEl.textContent = '⚠ Network error — check connection';
    }
  }

  if (btn) { btn.disabled = false; btn.textContent = '📥 Scan for Bookings'; }
}

function copyCalendarFeedUrl() {
  const input = document.getElementById('calendar-feed-url');
  const btn = document.getElementById('copy-feed-btn');
  if (!input) return;
  navigator.clipboard.writeText(input.value).then(() => {
    if (btn) { btn.textContent = '✓ Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 2000); }
  }).catch(() => {
    input.select();
    document.execCommand('copy');
    if (btn) { btn.textContent = '✓ Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 2000); }
  });
}

let _connectionSummaryTimer = null;
function refreshConnectionSummarySoon() {
  clearTimeout(_connectionSummaryTimer);
  _connectionSummaryTimer = setTimeout(() => {
    try { renderConnectionSummary(); } catch (e) { console.warn('renderConnectionSummary failed', e); }
  }, 120);
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
let bookings = loadJSON(lsKey('bookings'));
let cleans   = loadJSON(lsKey('cleans'));
let notes    = loadJSON(lsKey('notes'));
let calYear  = new Date().getFullYear();
let calMonth = new Date().getMonth();

/**
 * reloadInMemoryData — refresh all in-memory arrays from localStorage.
 * Must be called after hydrateFromCloud() writes cloud data into localStorage,
 * otherwise renderAll() sees the stale (empty) arrays from script parse time.
 */
function reloadInMemoryData() {
  if (typeof isPortfolioMode === 'function' && isPortfolioMode()) {
    return;
  }
  console.log('[StayOps] reloadInMemoryData: refreshing in-memory arrays from localStorage');
  bookings    = loadJSON(lsKey('bookings'));
  cleans      = loadJSON(lsKey('cleans'));
  notes       = loadJSON(lsKey('notes'));
  expenses    = JSON.parse(localStorage.getItem(lsKey('expenses'))    || '[]');
  maintenance = JSON.parse(localStorage.getItem(lsKey('maintenance')) || '[]');
  inventory   = JSON.parse(localStorage.getItem(lsKey('inventory'))   || '[]');
  // Keep clean records in sync with current booking identity data
  _normalizeBookingCleanState();
}

const _actionLocks = Object.create(null);
let _pendingUiRefresh = false;

function _acquireLock(map, key) {
  if (map[key]) return false;
  map[key] = true;
  return true;
}
function _releaseLock(map, key) {
  delete map[key];
}

function _hasOpenModal() {
  const modal = document.getElementById('modal');
  const detail = document.getElementById('detail-modal');
  const isOpen = (el) => !!(el && el.style && el.style.display !== 'none' && el.style.display !== '');
  return isOpen(modal) || isOpen(detail);
}

function _isUserEditingField() {
  const el = document.activeElement;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = String(el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

function _normalizeBookingCleanState() {
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

  const _skipPortfolioLs = typeof isPortfolioMode === 'function' && isPortfolioMode();
  if (cleansChanged && !_skipPortfolioLs) localStorage.setItem(lsKey('cleans'), JSON.stringify(cleans));
  if (bookingsChanged && !_skipPortfolioLs) localStorage.setItem(lsKey('bookings'), JSON.stringify(bookings));
  return cleansChanged || bookingsChanged;
}

function _refreshAfterDataChange(manual) {
  if (!manual && (_hasOpenModal() || _isUserEditingField())) {
    _pendingUiRefresh = true;
    return;
  }
  _pendingUiRefresh = false;
  renderAll();
}

function _flushPendingUiRefresh() {
  if (!_pendingUiRefresh) return;
  if (_hasOpenModal() || _isUserEditingField()) return;
  _pendingUiRefresh = false;
  render();
}

function _loadCleanerAutomationState() {
  const raw = loadJSON(lsKey('cleaner-automation')) || {};
  return {
    lastCleanerId: raw.lastCleanerId || null,
    freq: raw.freq && typeof raw.freq === 'object' ? raw.freq : {}
  };
}

function _saveCleanerAutomationState(state) {
  localStorage.setItem(lsKey('cleaner-automation'), JSON.stringify({
    lastCleanerId: state.lastCleanerId || null,
    freq: state.freq && typeof state.freq === 'object' ? state.freq : {}
  }));
}

function _cleanerUsageKey(cleanerObj) {
  if (!cleanerObj) return '';
  if (cleanerObj.id !== undefined && cleanerObj.id !== null) return 'id:' + String(cleanerObj.id);
  const name = _normName(cleanerObj.name || '');
  return name ? 'name:' + name : '';
}

function _findCleanerByUsageKey(key) {
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

function _recordCleanerAssignmentUsage(cleanerObj) {
  if (!cleanerObj) return;
  const st = _loadCleanerAutomationState();
  const usageKey = _cleanerUsageKey(cleanerObj);
  if (!usageKey) return;
  st.lastCleanerId = cleanerObj.id !== undefined ? cleanerObj.id : st.lastCleanerId;
  st.freq[usageKey] = Number(st.freq[usageKey] || 0) + 1;
  _saveCleanerAutomationState(st);
  if (cleanerObj.name) localStorage.setItem(lsKey('last-cleaner'), cleanerObj.name);
}

function getPreferredCleaner() {
  const all = loadCleaners().filter(c => isCleanerPerson(c));
  if (!all.length) return null;
  const st = _loadCleanerAutomationState();
  if (st.lastCleanerId !== null && st.lastCleanerId !== undefined) {
    const byLastId = all.find(c => String(c.id) === String(st.lastCleanerId));
    if (byLastId) return byLastId;
  }
  const legacyName = String(localStorage.getItem(lsKey('last-cleaner')) || '').trim();
  if (legacyName) {
    const byLegacy = all.find(c => _normName(c.name) === _normName(legacyName));
    if (byLegacy) return byLegacy;
  }
  const topKey = Object.entries(st.freq)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))[0]?.[0];
  if (topKey) {
    const byFreq = _findCleanerByUsageKey(topKey);
    if (byFreq) return byFreq;
  }
  return all[0] || null;
}

function _getSuggestedCleanerForBooking(booking) {
  const matched = booking ? _findMatchingCleanForBooking(booking) : null;
  if (matched && matched.cleanerId) {
    const byMatched = loadCleaners().find(c => String(c.id) === String(matched.cleanerId));
    if (byMatched) return byMatched;
  }
  return getPreferredCleaner();
}

function _maybeAutoAssignPreferredCleaner(booking, reason) {
  if (!booking || booking.status === 'cancelled') return false;
  if (!booking.checkout || new Date(booking.checkout) < new Date()) return false;
  // Check auto-assign toggle — default ON
  if (localStorage.getItem(lsKey('auto-assign-cleaner')) === 'off') return false;
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
  _recordCleanerAssignmentUsage(preferred);
  return true;
}

async function _sendCleanerAssignmentNotifications(booking, cleanerObj, date, tag) {
  let pushSent = false;
  let emailAttempted = false;
  let emailSent = false;

  const cleanerSub = getCleanerSub(cleanerObj.id);
  if (cleanerSub) {
    const pushRes = await sendPushToDevice(
      cleanerSub,
      '🏡 New Clean Assigned',
      `${booking.name || 'Guest'} · ${fmt(date)}`,
      cleanerLinkForId(cleanerObj),
      tag || ('assign-' + String(booking.id || Date.now()))
    );
    pushSent = !!(pushRes && pushRes.ok);
  } else {
    console.warn('No push subscription found for cleaner', cleanerObj.id, '— cleaner needs to enable notifications');
  }

  const cleanerEmail = String(cleanerObj.email || '').trim();
  if (cleanerEmail) {
    emailAttempted = true;
    const emailRes = await sendCleanerEmail({
      cleanerName: cleanerObj.name,
      cleanerEmail,
      guestName: booking.name || 'Guest',
      checkin: fmt(booking.checkin),
      checkout: fmt(booking.checkout),
      cleanerLink: cleanerLinkForId(cleanerObj),
      guests: booking.guests ? String(booking.guests) : '',
      nights: booking.nights ? String(booking.nights) : ''
    });
    emailSent = !!(emailRes && emailRes.ok);
    if (!emailSent && emailRes && emailRes.reason !== 'no-key' && emailRes.reason !== 'no-email') {
      console.warn('Email failed:', emailRes);
    }
  }
  return { pushSent, emailAttempted, emailSent };
}

async function quickAssignLastCleaner(bookingId) {
  const lockKey = 'quickAssign:' + String(bookingId);
  if (!_acquireLock(_actionLocks, lockKey)) return;
  try {
    const booking = bookings.find(b => String(b.id) === String(bookingId));
    if (!booking) return;
    const preferred = _getSuggestedCleanerForBooking(booking);
    if (!preferred) {
      showBanner('⚠ No preferred cleaner yet — assign one from booking details first.', 'warn');
      return;
    }
    if (booking.status === 'cancelled' || new Date(booking.checkout) < new Date()) {
      showBanner('Past/cancelled booking — cleaner assignment is disabled', 'warn');
      return;
    }
    if (!window.confirm(`Assign ${preferred.name} to ${booking.name} (checkout ${fmt(booking.checkout)})?`)) return;
    const matched = _findMatchingCleanForBooking(booking, booking.checkout);
    const existingIdx = matched ? cleans.findIndex(c => c.id === matched.id) : -1;
    const prev = existingIdx >= 0 ? cleans[existingIdx] : null;
    const sameAssignment = !!(prev && String(prev.cleanerId) === String(preferred.id) && String(prev.date || '').slice(0, 10) === String(booking.checkout || '').slice(0, 10));
    if (sameAssignment) {
      booking.cleanerConfirmed = !!prev.cleanerConfirmed;
      _normalizeBookingCleanState();
      save();
      showBanner('No changes — already assigned to ' + preferred.name, 'ok');
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
    _recordCleanerAssignmentUsage(preferred);
    _normalizeBookingCleanState();
    save();
    if (typeof saveCleanToCloud === 'function') saveCleanToCloud(newClean).catch(() => {});
    if (typeof saveBookingToCloud === 'function') saveBookingToCloud(booking).catch(() => {});
    showBanner('✓ Assigned to ' + preferred.name + ' — awaiting cleaner response', 'ok');
    renderBookings();
    renderNotes();
    populateSelects();
    if (currentSection === 'cleaning') renderCleaning();
    _sendCleanerAssignmentNotifications(booking, preferred, booking.checkout, 'quick-assign-' + bookingId)
      .then(notify => {
        if (notify.emailSent) {
          showBanner('✉️ Email sent to ' + preferred.name, 'ok');
        } else {
          if (window.confirm('Notify ' + preferred.name + ' via SMS?')) {
            newClean.notified = true;
            save();
            openNotifyModal(newClean.id);
          }
        }
      })
      .catch(() => {});
  } finally {
    _releaseLock(_actionLocks, lockKey);
  }
}

function save() {
  localStorage.setItem(lsKey('bookings'), JSON.stringify(bookings));
  localStorage.setItem(lsKey('cleans'),   JSON.stringify(cleans));
  localStorage.setItem(lsKey('notes'),    JSON.stringify(notes));
  // AppData sheet sync removed — Supabase is now source of truth
  // Sync bookings, cleans and notes to Supabase (non-blocking)
  if (typeof saveBookingsToCloud === 'function') saveBookingsToCloud(bookings).catch(() => {});
  if (typeof saveCleansToCloud === 'function') saveCleansToCloud(cleans).catch(() => {});
  if (typeof saveNotesToCloud === 'function') saveNotesToCloud(notes).catch(() => {});
}

let bannerTimer;
function showBanner(msg, type) {
  const banner = document.getElementById('sync-banner');
  const text = document.getElementById('sync-text');
  if (!banner || !text) return;

  const styles = {
    ok:      { bg: '#2E7D32', ms: 3200 },
    success: { bg: '#2E7D32', ms: 3200 },
    info:    { bg: '#2C4A3E', ms: 2600 },
    warn:    { bg: '#B9652C', ms: 4600 },
    error:   { bg: '#B24747', ms: 5200 }
  };
  const tone = styles[type] || styles.warn;

  banner.style.background = tone.bg;
  banner.style.display = 'flex';
  text.textContent = msg;
  if (typeof refreshConnectionSummarySoon === 'function') refreshConnectionSummarySoon();
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { banner.style.display = 'none'; }, tone.ms);
}

function isCleanerPerson(person) {
  const role = String((person && person.role) || '').trim().toLowerCase();
  return !role || role === 'cleaner';
}

function renderSetupWarningBanner() {
  const wrap = document.getElementById('setup-warning-banner');
  const titleEl = document.getElementById('setup-warning-title');
  const bodyEl = document.getElementById('setup-warning-body');
  if (!wrap || !titleEl || !bodyEl) return;

  if (typeof isCleanerMode === 'function' && isCleanerMode()) {
    wrap.style.display = 'none';
    return;
  }

  const gaps = (typeof getPropertyConfigGaps === 'function') ? getPropertyConfigGaps() : [];
  if (!gaps.length) {
    wrap.style.display = 'none';
    bodyEl.innerHTML = '';
    return;
  }

  const critical = gaps.filter(g => g.severity === 'critical');
  const heading = critical.length
    ? '⚠️ Setup Required'
    : 'ℹ️ Setup Recommendation';
  titleEl.textContent = heading;

  wrap.style.borderColor = critical.length ? '#F0AA4A' : '#E8D39B';
  wrap.style.background = critical.length ? '#FFF8E8' : '#FFFDF4';

  bodyEl.innerHTML = `
    <div style="margin-bottom:6px">
      Missing for <strong>${escHtml(getCurrentPropertyName())}</strong>:
    </div>
    <ul style="margin:0;padding-left:16px">
      ${gaps.map(g => `<li style="margin:0 0 3px 0"><strong>${escHtml(g.label)}</strong> — ${escHtml(g.detail)}</li>`).join('')}
    </ul>
    <div style="margin-top:8px">Fix in <strong>Settings → Property → Property Configuration</strong>.</div>
  `;

  wrap.style.display = 'block';
}

// ── NAV ───────────────────────────────────────────────────────────────────
let currentSection = 'today';
let portfolioMode = false;

function showSection(name) {
  if (name === 'dashboard') name = 'today';
  if (name === 'revenue' || name === 'management') name = 'finance';
  currentSection = name;
  document.querySelectorAll('[id^="section-"]').forEach(el => el.classList.add('section-hidden'));
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
  const sec = document.getElementById('section-' + name);
  if (sec) sec.classList.remove('section-hidden');
  const nav = document.getElementById('nav-' + name);
  if (nav) nav.classList.add('active');
  // FAB only on Today tab
  const fab = document.querySelector('.fab');
  if (fab) fab.style.display = name === 'today' ? 'flex' : 'none';
  // Only render what's needed for this section
  if (name === 'today') {
    renderDashboard();
  } else if (name === 'bookings') {
    document.querySelectorAll('#section-bookings .tab-row .tab').forEach(t => t.classList.remove('active'));
    const activeTab = document.querySelector(`#section-bookings .tab-row .tab[onclick*="${bookingFilter}"]`);
    if (activeTab) activeTab.classList.add('active');
    renderBookings();
    renderNotes();
    populateSelects();
  } else if (name === 'cleaning') {
    renderCleaning();
    populateSelects();
  } else if (name === 'finance') {
    renderFinance();
  } else if (name === 'notes') {
    showSection('bookings');
    return;
  } else if (name === 'property') {
    backToPropertyHub();
  } else if (name === 'settings') {
    // Show settings main menu, hide any open cats/panels
    _resetSettingsToMenu();
    renderSettings();
    renderConnectionSummary();
  }
  setTimeout(_flushPendingUiRefresh, 0);
}

function jumpToCleaningActionNeeded() {
  showSection('cleaning');
  cleanFilter = 'action';
  renderCleaning();
  document.querySelectorAll('#clean-schedule-card .tab-row .tab').forEach((t, i) => t.classList.toggle('active', i === 1));
}

function jumpToScheduleClean() {
  showSection('cleaning');
  switchCleaningView('add');
  cleanFilter = 'upcoming';
  renderCleaning();
  document.querySelectorAll('#clean-schedule-card .tab-row .tab').forEach((t, i) => t.classList.toggle('active', i === 0));
  setTimeout(() => {
    const card = document.getElementById('clean-add-card');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 80);
}

// ── RENDER ────────────────────────────────────────────────────────────────
function render() {
  // Always update the date badge and shared state
  renderHeaderDateBadge()
  // Set FAB visibility based on current section
  const fab = document.querySelector('.fab');
  const section = currentSection || 'today';
  if (fab) fab.style.display = section === 'today' ? 'flex' : 'none';
  if (section === 'today')        { renderDashboard(); return; }
  if (section === 'bookings')     { renderBookings(); renderNotes(); return; }
  if (section === 'cleaning')     { renderCleaning(); populateSelects(); return; }
  if (section === 'finance')      { renderFinance(); return; }
  if (section === 'notes')        { renderNotes(); populateSelects(); return; }
  if (section === 'property')     { renderProperty(); return; }
  if (section === 'settings')     { renderSettings(); renderConnectionSummary(); return; }
  renderDashboard(); // fallback
}

// Full render — used after major data changes like sheet sync
function renderAll() {
  // Portfolio-specific tab UI: use typeof isPortfolioMode === 'function' && isPortfolioMode() (Cards 2–6).
  if (isCleanerMode()) {
    renderCleanerView();
    return;
  }
  renderHeaderDateBadge()
  renderDashboard();
  renderBookings(); // always refresh booking list after sync
  populateSelects();
  populateExpenseCatSelect();
  const expDate = document.getElementById('exp-date');
  if (expDate && !expDate.value) expDate.value = new Date().toISOString().split('T')[0];
  const maintDate = document.getElementById('maint-date');
  if (maintDate && !maintDate.value) maintDate.value = new Date().toISOString().split('T')[0];
  // Also render whatever section is active
  const section = currentSection || 'today';
  if (section === 'cleaning')   { renderCleaning(); populateCleanerSelect(); }
  if (section === 'finance')    renderFinance();
  if (section === 'notes')      renderNotes();
  if (section === 'property')   renderProperty();
  if (section === 'settings')   { renderSettings(); renderConnectionSummary(); }
  setTimeout(() => { attachButtonPress(); attachLongPress(); }, 50);
}

let _expandedPortfolioCardIndex = null;

/** For onclick="fn('…')" — single-quoted JS string inside double-quoted HTML attribute. */
function escapeJsSingleQuotedHtmlAttr(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r\n|\r|\n/g, '\\n');
}

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
window.togglePropertyDetail = togglePropertyDetail;

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
    '<button type="button" onclick="event.stopPropagation();switchPropertyFromSheet(\'' + escapeJsSingleQuotedHtmlAttr(localId) + '\')" ' +
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
        ? escHtml(clean.cleaner) + ' · <span style="color:' + (clean.cleanerConfirmed ? '#1D9E75' : '#BA7517') + ';font-weight:600">' + (clean.cleanerConfirmed ? 'Confirmed' : 'Pending') + '</span>'
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
    const state = getBookingCleanerState(b);
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

function renderDashboard() {
  if (isPortfolioMode()) {
    renderPortfolioDashboard();
    return;
  }
  const singleDash = document.getElementById('dashboard-content');
  const portfolioDash = document.getElementById('portfolio-dashboard');
  if (singleDash) singleDash.style.display = '';
  if (portfolioDash) portfolioDash.style.display = 'none';

  const backLink = document.getElementById('back-to-portfolio-link');
  if (backLink) {
    const hasMultiple = typeof getAllProperties === 'function' && getAllProperties().length > 1;
    if (hasMultiple && !isPortfolioMode()) {
      backLink.style.display = '';
      backLink.onclick = () => {
        sessionStorage.setItem('stayops-portfolio-mode', 'true');
        if (typeof enterPortfolioMode === 'function') enterPortfolioMode();
      };
    } else {
      backLink.style.display = 'none';
    }
  }

  const statBookings = document.getElementById('stat-bookings');
  if (statBookings) statBookings.textContent = bookings.filter(b => b.status !== 'cancelled').length;
  renderCalendar();
  updateCalStats();

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(todayStart);
  const dayOfWeek = (weekStart.getDay() + 6) % 7; // Monday=0
  weekStart.setDate(weekStart.getDate() - dayOfWeek);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const next7 = new Date(todayStart); next7.setDate(next7.getDate() + 7);
  const next30 = new Date(todayStart); next30.setDate(next30.getDate() + 30);
  const safeNum = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  const safeDayLabel = (dateKey) => {
    const key = String(dateKey || '').slice(0, 10);
    if (!key) return '—';
    const d = parseLocalDayStart(key);
    return Number.isNaN(d.getTime()) ? key : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  };

  const activeBookings = bookings.filter(b => b.status !== 'cancelled');
  const upcomingBookings = activeBookings.filter(b => parseLocalDayStart(b.checkin) >= todayStart);
  const upcomingBookings7 = upcomingBookings.filter(b => parseLocalDayStart(b.checkin) < next7);
  const upcomingBookings30 = upcomingBookings.filter(b => parseLocalDayStart(b.checkin) < next30);
  const upcomingRevenue7 = upcomingBookings7.reduce((sum, b) => sum + safeNum(b.hostPayout), 0);
  const upcomingRevenue30 = upcomingBookings30.reduce((sum, b) => sum + safeNum(b.hostPayout), 0);
  const upcomingPayoutEstimate = upcomingBookings.reduce((sum, b) => sum + safeNum(b.netPayout), 0);
  const hostPayoutCoverage7 = upcomingBookings7.filter(b => Number.isFinite(Number(b.hostPayout))).length;
  const hostPayoutCoverage30 = upcomingBookings30.filter(b => Number.isFinite(Number(b.hostPayout))).length;
  const netPayoutCoverage = upcomingBookings.filter(b => Number.isFinite(Number(b.netPayout))).length;

  const checkinsThisWeek = activeBookings.filter(b => {
    const ci = new Date(b.checkin);
    return ci >= weekStart && ci < weekEnd;
  });
  const checkoutsThisWeek = activeBookings.filter(b => {
    const co = new Date(b.checkout);
    return co >= weekStart && co < weekEnd;
  });

  const upcomingCleans = cleans.filter(c => !c.done && !c.cleanerDeclined && c.date && parseLocalDayStart(c.date) >= todayStart);
  const cleansThisWeek = upcomingCleans.filter(c => {
    const d = new Date(c.date);
    return d >= weekStart && d < weekEnd;
  });

  const bookedNightsNext30 = activeBookings.reduce((sum, b) => {
    const start = new Date(Math.max(new Date(b.checkin).getTime(), todayStart.getTime()));
    const end = new Date(Math.min(new Date(b.checkout).getTime(), next30.getTime()));
    if (end <= start) return sum;
    return sum + Math.ceil((end - start) / 86400000);
  }, 0);

  // ── Monthly occupancy: booked nights in the current calendar month ────────
  const thisMonth      = now.getMonth();
  const thisYear       = now.getFullYear();
  const daysThisMonth  = new Date(thisYear, thisMonth + 1, 0).getDate();
  const monthStart     = new Date(thisYear, thisMonth, 1);
  const monthEnd       = new Date(thisYear, thisMonth + 1, 1);
  let bookedNightsMonth = 0;
  activeBookings.forEach(b => {
    if (!b.checkin || !b.checkout) return;
    const ci = new Date(Math.max(new Date(b.checkin).getTime(), monthStart.getTime()));
    const co = new Date(Math.min(new Date(b.checkout).getTime(), monthEnd.getTime()));
    if (co > ci) bookedNightsMonth += Math.round((co - ci) / 86400000);
  });
  const occupancyThisMonth = Math.max(0, Math.min(100, Math.round((bookedNightsMonth / daysThisMonth) * 100)));

  const dayLoad = {};
  activeBookings.forEach(b => {
    const ci = new Date(b.checkin);
    const co = new Date(b.checkout);
    if (ci >= weekStart && ci < weekEnd) {
      const ciKey = String(b.checkin || '').slice(0, 10);
      if (ciKey) dayLoad[ciKey] = (dayLoad[ciKey] || 0) + 1;
    }
    if (co >= weekStart && co < weekEnd) {
      const coKey = String(b.checkout || '').slice(0, 10);
      if (coKey) dayLoad[coKey] = (dayLoad[coKey] || 0) + 1;
    }
  });
  cleansThisWeek.forEach(c => {
    const key = String(c.date || '').slice(0, 10);
    if (key) dayLoad[key] = (dayLoad[key] || 0) + 1;
  });
  const busyDays = Object.entries(dayLoad)
    .filter(([, count]) => count >= 3)
    .sort((a, b) => a[0].localeCompare(b[0]));
  const multiCleans = Object.entries(cleansThisWeek.reduce((acc, c) => {
    const key = String(c.date || '').slice(0, 10);
    if (key) acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {})).filter(([, count]) => count > 1);

  const insightsEl = document.getElementById('dashboard-insights-content');
  if (insightsEl) {
    // Forward-looking revenue: lead with the 30-day figure, support with 7-day
    const rev30Str = `$${Math.round(upcomingRevenue30).toLocaleString()}`;
    const rev7Str  = `$${Math.round(upcomingRevenue7).toLocaleString()}`;
    const payoutStr = `$${Math.round(upcomingPayoutEstimate).toLocaleString()}`;
    const coverageNote = (!upcomingBookings7.length && !upcomingBookings30.length)
      ? 'No upcoming bookings in the next 30 days'
      : (hostPayoutCoverage7 < upcomingBookings7.length || hostPayoutCoverage30 < upcomingBookings30.length)
      ? `Partial data (${hostPayoutCoverage30}/${upcomingBookings30.length} bookings have payout figures)`
      : '';
    insightsEl.innerHTML = `
      <div style="font-size:22px;font-weight:700;color:var(--forest);letter-spacing:-0.3px;line-height:1">${rev30Str}</div>
      <div style="font-size:12px;color:var(--text-soft);margin-top:4px;line-height:1.4">Expected payout · next 30 days</div>
      <div style="margin-top:12px;display:flex;flex-direction:column;gap:6px">
        <div style="font-size:12px;color:var(--text-soft);line-height:1.4">Next 7 days <strong style="color:var(--forest)">${rev7Str}</strong> &nbsp;·&nbsp; Est. total payout <strong style="color:var(--forest)">${payoutStr}</strong></div>
        <div style="font-size:12px;color:var(--text-soft);line-height:1.4">${upcomingBookings.length} upcoming booking${upcomingBookings.length!==1?'s':''} &nbsp;·&nbsp; ${upcomingCleans.length} clean${upcomingCleans.length!==1?'s':''} scheduled</div>
        <div style="font-size:12px;color:var(--text-soft);line-height:1.4">Monthly Occ. <strong style="color:var(--forest)">${occupancyThisMonth}%</strong> &nbsp;(${now.toLocaleString('en-AU', {month:'long'})} ${thisYear})</div>
      </div>
      ${coverageNote ? `<div style="margin-top:8px;font-size:11px;color:var(--stone);line-height:1.4">${coverageNote}</div>` : ''}`;
  }

  // ── Cleaner Actions — highest-priority alert, rendered before calendar ────
  const cleanerAlertEl = document.getElementById('dashboard-cleaner-alert');
  if (cleanerAlertEl) cleanerAlertEl.innerHTML = '';

  const weekEl = document.getElementById('dashboard-week-content');
  if (weekEl) {
    const busyText = busyDays.length
      ? busyDays.slice(0, 2).map(([d, c]) => `${safeDayLabel(d)} (${c})`).join(', ')
      : null;
    const multiCleansText = multiCleans.length
      ? multiCleans.map(([d, c]) => `${safeDayLabel(d)} (${c} cleans)`).join(', ')
      : null;
    // Pill-style counts: compact, inline, lighter weight than the stats row
    const pill = (n, label) =>
      `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--mist);border-radius:20px;padding:4px 10px;font-size:12px;font-weight:600;color:var(--forest)">${n} <span style="font-weight:400;color:var(--text-soft)">${label}</span></span>`;
    weekEl.innerHTML = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        ${pill(checkinsThisWeek.length, 'arrival' + (checkinsThisWeek.length !== 1 ? 's' : ''))}
        ${pill(checkoutsThisWeek.length, 'departure' + (checkoutsThisWeek.length !== 1 ? 's' : ''))}
        ${pill(cleansThisWeek.length, 'clean' + (cleansThisWeek.length !== 1 ? 's' : ''))}
      </div>
      ${busyText ? `<div style="font-size:12px;color:var(--text-soft);margin-bottom:3px">⚡ Busy: ${busyText}</div>` : ''}
      ${multiCleansText ? `<div style="font-size:12px;color:var(--text-soft)">🧹 Stacked cleans: ${multiCleansText}</div>` : ''}
      ${!busyText && !multiCleansText ? `<div style="font-size:12px;color:var(--text-soft)">Week looks well balanced</div>` : ''}`;
  }

  const usageSnapshot = getUsageSnapshotLite();
  const planState = getPlanStateLite();
  renderOnboardingGuidance(usageSnapshot);
  renderPlanNudges(usageSnapshot, planState);

  // ── Next Check-in card — tappable shortcut to booking detail ─────────────
  const upcoming = [...bookings]
    .filter(b => b.status !== 'cancelled' && b.checkin && parseLocalDayStart(b.checkin) >= todayStart)
    .sort((a, b) => parseLocalDayStart(a.checkin) - parseLocalDayStart(b.checkin));
  const nc = document.getElementById('next-checkin-content');
  if (nc) {
    if (upcoming.length > 0) {
      const b = upcoming[0];
      const ciDays = Math.ceil((parseLocalDayStart(b.checkin) - todayStart) / 86400000);
      const ciPill = ciDays <= 0 ? 'Today' : ciDays === 1 ? 'Tomorrow' : `In ${ciDays}d`;
      const ciPillColor = ciDays <= 2 ? 'background:#fef3e2;color:#854f0b' : 'background:#e8f4ed;color:#1a4f3a';
      nc.innerHTML = `<div onclick="showDetail('${escapeJsSingleQuotedHtmlAttr(String(b._cloudId || b.id))}')" style="cursor:pointer">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-soft)">Next check-in</div>
          <span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;${ciPillColor}">${ciPill}</span>
        </div>
        <div style="font-size:17px;font-weight:600;color:var(--text);margin-bottom:8px">${escHtml(b.name)}</div>
        <div style="display:flex;gap:16px">
          <div style="display:flex;flex-direction:column">
            <span style="font-size:15px;font-weight:600;color:var(--text)">${fmt(b.checkin)}</span>
            <span style="font-size:11px;color:var(--text-soft);text-transform:uppercase;letter-spacing:0.4px">Arrives</span>
          </div>
          <div style="display:flex;flex-direction:column">
            <span style="font-size:15px;font-weight:600;color:var(--text)">${b.nights}</span>
            <span style="font-size:11px;color:var(--text-soft);text-transform:uppercase;letter-spacing:0.4px">Night${b.nights!==1?'s':''}</span>
          </div>
          <div style="display:flex;flex-direction:column">
            <span style="font-size:15px;font-weight:600;color:var(--text)">${b.guests}</span>
            <span style="font-size:11px;color:var(--text-soft);text-transform:uppercase;letter-spacing:0.4px">Guests</span>
          </div>
        </div>
      </div>`;
    } else {
      nc.innerHTML = '<div style="color:var(--text-soft);font-size:13px;">No upcoming bookings</div>';
    }
  }

  const localNow = new Date();
  const todayStr = localNow.getFullYear() + '-' + String(localNow.getMonth()+1).padStart(2,'0') + '-' + String(localNow.getDate()).padStart(2,'0');

  // ── Next Clean card — carry bookingId so the row can open booking detail ──
  const fromCleans = cleans
    .filter(c => !c.done && c.date && c.date >= todayStr)
    .map(c => ({
      date: c.date,
      name: c.cleaner,
      sub: 'After ' + (c.guestName || ''),
      bookingId: c.bookingId || null
    }));
  const fromBookings = bookings
    .filter(b => b.checkout && b.checkout >= todayStr)
    .map(b => ({ booking: b, state: getBookingCleanerState(b) }))
    .filter(({ state }) => state.key === 'confirmed' || state.key === 'done')
    .filter(({ state }) => !state.clean || !!state.clean.done)
    .map(({ booking, state }) => {
      const cl = state.clean;
      return {
        date: cl ? cl.date : booking.checkout,
        name: cl ? cl.cleaner : '—',
        sub: 'After ' + booking.name,
        bookingId: booking._cloudId || booking.id
      };
    });
  const allNextCleans = [...fromCleans, ...fromBookings]
    .filter((v, i, a) => a.findIndex(x => x.sub === v.sub) === i) // dedupe by guest
    .sort((a, b) => a.date.localeCompare(b.date));

  const ncc = document.getElementById('next-clean-content');

  // ── Alerts: low stock + open maintenance (passive alerts, below calendar) ─
  const alertsEl = document.getElementById('dashboard-alerts');
  const lowStock = inventory.filter(i => i.stock <= i.threshold);
  const openIssues = maintenance.filter(m => m.status === 'open' || m.status === 'inprogress');
  // Match the Cleaning tab's totalActionCount: awaiting responses + unassigned/declined
  const awaitingResponses = cleans.filter(c => isAwaitingCleanerResponse(c, localNow) && !_isCleanLinkedToCancelledBooking(c));
  const unassignedOrDeclined = bookings.filter(b => {
    if (b.status === 'cancelled' || new Date(b.checkout) < localNow) return false;
    const st = getBookingCleanerState(b).key;
    return st === 'unassigned' || st === 'declined';
  });
  const totalCleanerActions = awaitingResponses.length + unassignedOrDeclined.length;

  // Cleaner alert: own element, before calendar, hidden when zero
  if (cleanerAlertEl) {
    cleanerAlertEl.innerHTML = totalCleanerActions > 0
      ? `<div class="card" style="border-left:3px solid var(--amber);padding:10px 14px;cursor:pointer" onclick="jumpToCleaningActionNeeded()">
          <div style="font-weight:600;font-size:13px;margin-bottom:4px">⏳ Cleaner Actions Needed (${totalCleanerActions})</div>
          <div style="font-size:12px;color:var(--text-soft)">Tap to open Action tab</div>
        </div>`
      : '';
  }

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

  // ── Next Clean render — tappable shortcut to booking detail if available ──
  if (ncc && allNextCleans.length > 0) {
    const c = allNextCleans[0];
    const days = Math.ceil((new Date(c.date) - localNow) / 86400000);
    const urgClass = days <= 0 ? 'urgent' : days <= 1 ? 'urgent' : days <= 3 ? 'soon' : 'ok';
    const urgText = days <= 0 ? 'Today!' : days === 1 ? 'Tomorrow' : `In ${days} days`;
    // Resolve booking ID: prefer explicit bookingId, fall back to name match
    const linkedBookingId = c.bookingId ||
      (bookings.find(bk => bk.name && c.sub && c.sub.includes(bk.name))
        ? (bk => bk._cloudId || bk.id)(bookings.find(bk => bk.name && c.sub && c.sub.includes(bk.name)))
        : null);
    const clickAttr = linkedBookingId
      ? `onclick="showDetail('${escapeJsSingleQuotedHtmlAttr(String(linkedBookingId))}')" style="cursor:pointer"`
      : `onclick="jumpToCleaningActionNeeded()" style="cursor:pointer"`;
    const csState = linkedBookingId
      ? getBookingCleanerState(bookings.find(bk => (bk._cloudId || String(bk.id)) === String(linkedBookingId)) || {})
      : { key: 'pending', tone: 'warn' };
    // Override: if the allNextCleans entry came from the raw cleans array,
    // read confirmed/declined directly from it rather than via booking lookup.
    const rawClean = c.bookingId
      ? cleans.find(cl => String(cl.bookingId) === String(c.bookingId) && cl.date === c.date)
      : null;
    const effectiveKey = rawClean
      ? (rawClean.done ? 'done' : rawClean.cleanerDeclined ? 'declined' : rawClean.cleanerConfirmed ? 'confirmed' : 'pending')
      : csState.key;
    const effectiveCleanId = rawClean ? rawClean.id : (csState.clean ? csState.clean.id : null);
    const csPillStyle = effectiveKey === 'done' || effectiveKey === 'confirmed'
      ? 'background:#e8f4ed;color:#1a4f3a'
      : effectiveKey === 'declined'
      ? 'background:#fef0f0;color:#993c1d'
      : 'background:#fef3e2;color:#854f0b';
    const csLabel = effectiveKey === 'done' ? '✓ Done'
      : effectiveKey === 'confirmed' ? '✓ Confirmed'
      : effectiveKey === 'declined' ? '✕ Declined'
      : 'Awaiting reply';
    const cleanId = effectiveCleanId;
    const initials = c.name && c.name !== '—'
      ? c.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()
      : '?';
    ncc.innerHTML = `<div style="padding:14px 16px">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-soft);margin-bottom:10px">Next clean</div>
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:34px;height:34px;border-radius:50%;background:#e8f4ed;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#1a4f3a;flex-shrink:0">${initials}</div>
          <div>
            <div style="font-size:15px;font-weight:600;color:var(--text)">${escHtml(c.name)}</div>
            <div style="font-size:12px;color:var(--text-soft)">${fmt(c.date)} · after checkout</div>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
          <span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;${csPillStyle}">${csLabel}</span>
          ${cleanId ? `<button onclick="event.stopPropagation();openNotifyModal('${cleanId}')" style="-webkit-tap-highlight-color:transparent;background:#1a4f3a;color:#fff;border:none;border-radius:8px;padding:5px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">SMS</button>` : ''}
        </div>
      </div>
    </div>`;
  } else if (ncc) {
    ncc.innerHTML = '<div style="color:var(--text-soft);font-size:13px;">No cleans scheduled</div>';
  }
}

function calPrev() { calMonth--; if (calMonth<0){calMonth=11;calYear--;} renderCalendar(); updateCalStats(); }
function calNext() { calMonth++; if (calMonth>11){calMonth=0;calYear++;} renderCalendar(); updateCalStats(); }

function updateCalStats() {
  // ── Annual occupancy: booked nights across the full calYear ──────────────
  const isLeap = (calYear % 4 === 0 && calYear % 100 !== 0) || calYear % 400 === 0;
  const daysInYear = isLeap ? 366 : 365;
  const yearStart = new Date(calYear, 0, 1);
  const yearEnd   = new Date(calYear + 1, 0, 1);
  let bookedNightsYear = 0;
  bookings.filter(b => b.status !== 'cancelled').forEach(b => {
    if (!b.checkin || !b.checkout) return;
    const ci = new Date(Math.max(new Date(b.checkin).getTime(), yearStart.getTime()));
    const co = new Date(Math.min(new Date(b.checkout).getTime(), yearEnd.getTime()));
    if (co > ci) bookedNightsYear += Math.round((co - ci) / 86400000);
  });
  const annualOcc = Math.round((bookedNightsYear / daysInYear) * 100);

  // ── Monthly revenue: bookings whose check-in falls in calMonth/calYear ───
  const monthRev = bookings.filter(b => {
    const d = new Date(b.checkin);
    return b.status !== 'cancelled' && d.getMonth() === calMonth && d.getFullYear() === calYear;
  }).reduce((s, b) => s + Number(b.hostPayout || 0), 0);

  const occEl = document.getElementById('stat-occupancy');
  const revEl = document.getElementById('stat-revenue');
  if (occEl) occEl.textContent = annualOcc + '%';
  if (revEl) revEl.textContent = '$' + monthRev.toLocaleString();

  // Hero card occupancy bubble — keep in sync with annual figure
  const o2 = document.getElementById('stat-occupancy2');
  if (o2) o2.textContent = annualOcc + '%';
}

function renderCalendar() {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const calTitle = document.getElementById('cal-title');
  if (calTitle) calTitle.textContent = months[calMonth] + ' ' + calYear;

  // Tag each day: start = checkin, end = checkout, mid = in between
  // Also map each booked day → booking id for the preview
  const starts = new Set(), ends = new Set(), mids = new Set();
  const dayBooking = {}; // day → booking id
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
      dayBooking[day] = b._cloudId || b.id;
    }
  });

  const now = new Date();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const firstDay = new Date(calYear, calMonth, 1).getDay();

  let html = ['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => `<div class="cal-day-label">${d}</div>`).join('');
  for (let i = 0; i < firstDay; i++) html += '<div class="cal-day"></div>';

  for (let d = 1; d <= daysInMonth; d++) {
    const isToday  = d === now.getDate() && calMonth === now.getMonth() && calYear === now.getFullYear();
    const isStart  = starts.has(d);
    const isEnd    = ends.has(d);
    const isMid    = mids.has(d);
    const isBooked = isStart || isEnd || isMid;
    const classes  = ['cal-day', isStart?'booked-start':'', isEnd?'booked-end':'', isMid?'booked-mid':'', isToday?'today':''].filter(Boolean).join(' ');
    const click    = isBooked ? ` onclick="openCalPreview('${escHtml(dayBooking[d])}')" style="cursor:pointer"` : '';
    html += `<div class="${classes}"${click}><span class="cal-num">${d}</span></div>`;
  }
  document.getElementById('cal-grid').innerHTML = html;
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
      ${b.platform ? `<span class="cp-chip">${b.platform === 'Airbnb' ? '🏠' : b.platform === 'VRBO' ? '🏡' : '📋'} ${escHtml(b.platform)}</span>` : ''}
    </div>
    ${payout ? `<div class="cp-payout">$${payout.toLocaleString()}</div><div class="cp-payout-label">Host payout</div>` : ''}
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
  sheet.addEventListener('transitionend', () => { sheet.style.display = 'none'; }, { once: true });
}

function renderPortfolioBookings(filter) {
  if (filter) bookingFilter = filter;
  const list = document.getElementById('bookings-list');
  const notesView = document.getElementById('bookings-notes-view');
  if (notesView) notesView.style.display = bookingFilter === 'notes' ? '' : 'none';
  if (list) list.style.display = bookingFilter === 'notes' ? 'none' : '';
  if (bookingFilter === 'notes') { renderNotes(); return; }

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
          const cs = getBookingCleanerState(b);
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
            platformIcon(b.platform, 42) +
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

  animateList('#bookings-list');
  setTimeout(attachLongPress, 60);
}

function renderBookings(filter) {
  if (filter) bookingFilter = filter;
  if (isPortfolioMode()) {
    renderPortfolioBookings(filter);
    return;
  }
  const list = document.getElementById('bookings-list');
  const notesView = document.getElementById('bookings-notes-view');
  if (notesView) notesView.style.display = bookingFilter === 'notes' ? '' : 'none';
  if (list) list.style.display = bookingFilter === 'notes' ? 'none' : '';
  if (bookingFilter === 'notes') {
    renderNotes();
    return;
  }

  let filtered;
  if (bookingFilter==='all') filtered = bookings.filter(b => b.status !== 'cancelled');
  else if (bookingFilter==='upcoming') filtered = bookings.filter(b => b.status !== 'cancelled' && new Date(b.checkout)>=new Date());
  else if (bookingFilter==='completed') filtered = bookings.filter(b => b.status !== 'cancelled' && new Date(b.checkout)<new Date());
  else if (bookingFilter==='cancelled') filtered = bookings.filter(b => b.status === 'cancelled');
  else filtered = bookings.filter(b => b.status !== 'cancelled' && new Date(b.checkout)>=new Date());

  if (!filtered.length) {
    const hasAny = bookings.length > 0;
    const _emptyLabels = { upcoming: 'Nothing upcoming', completed: 'No past bookings', cancelled: 'No cancelled bookings', all: 'No bookings found' };
    const _emptyHints  = { upcoming: 'Past and cancelled bookings live in other tabs', completed: 'Completed stays will appear here', cancelled: 'Cancelled bookings will appear here', all: 'Add a booking with the + button above' };
    const _emptyTitle  = hasAny ? (_emptyLabels[bookingFilter] || 'No bookings found') : 'No bookings yet';
    const _emptyHint   = hasAny ? (_emptyHints[bookingFilter]  || 'Try switching tabs above') : 'Tap + Add Booking above to get started';
    list.innerHTML = `<div class="card" style="text-align:center;padding:40px 24px 36px"><div style="font-size:36px;margin-bottom:14px;opacity:0.45">📅</div><div style="font-weight:700;font-size:15px;color:var(--forest);margin-bottom:6px">${_emptyTitle}</div><div style="font-size:12.5px;color:var(--text-soft);line-height:1.5">${_emptyHint}</div></div>`;
    return;
  }

  const sorted = [...filtered].sort((a,b)=>new Date(a.checkin)-new Date(b.checkin));
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
        const isHosting = !isCancelled && new Date(b.checkin)<=new Date() && new Date(b.checkout)>=new Date();
        const isPast = !isCancelled && new Date(b.checkout)<new Date();
        const statusClass = isCancelled ? 'status-cancelled' : isHosting ? 'status-upcoming' : isPast ? 'status-completed' : 'status-upcoming';
        const statusLabel = isCancelled ? '✕ Cancelled' : isHosting ? '🏡 Hosting' : isPast ? 'Past' : 'Upcoming';

        // Cleaner row — only for upcoming and currently hosting bookings
        const showCleaner = !isCancelled && !isPast;
        let cleanerRowHtml = '';
        if (showCleaner) {
          const cs = getBookingCleanerState(b);
          const cleanerName = cs.clean ? escHtml(cs.clean.cleaner || 'Unknown') : 'Not assigned';
          const iconBg = cs.tone === 'ok' ? 'background:#e8f4ed' : cs.tone === 'bad' ? 'background:#fef0f0' : 'background:#fef3e2';
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
          cleanerRowHtml = `<div style="border-top:1px solid var(--warm);margin-top:8px;padding-top:7px;display:flex;align-items:center;gap:6px"><span style="font-size:12px;opacity:0.7">🧹</span><span style="font-size:12px;color:var(--text-soft)">${cleanerName}</span><span style="font-size:11px;font-weight:600;padding:2px 7px;border-radius:20px;margin-left:auto;${pillStyle}">${pillLabel}</span></div>`;
        }

        return `<div class="card" onclick="showDetail('${escapeJsSingleQuotedHtmlAttr(String(b._cloudId || b.id))}')" style="cursor:pointer${isCancelled?';opacity:0.6':''}" data-booking-id="${b.id}"><div class="booking-item" style="border:none;padding:0" data-booking-id="${b.id}">${platformIcon(b.platform, 42)}<div class="booking-info"><div class="booking-name">${escHtml(b.name)}</div><div class="booking-dates">${escHtml(fmt(b.checkin))} → ${escHtml(fmt(b.checkout))}</div><div class="booking-guests">${escHtml(b.guests)} guests · ${escHtml(b.nights)} night${b.nights!==1?'s':''}</div></div><div class="booking-right"><div class="booking-amount" style="${isCancelled?'text-decoration:line-through;color:var(--text-soft)':''}">$${Number(b.hostPayout||0).toLocaleString()}</div><div class="booking-status ${statusClass}">${statusLabel}</div></div></div>${cleanerRowHtml}</div>`;
      }).join('')}
    </div>`).join('');

  animateList('#bookings-list');
  setTimeout(attachLongPress, 60);
}

let cleaningView = 'schedule';
function switchCleaningView(view, btn) {
  cleaningView = 'schedule';
}

function filterCleans(f, btn) {
  cleanFilter = f;
  document.querySelectorAll('#clean-schedule-card .tab-row .tab').forEach(t=>t.classList.remove('active'));
  btn.classList.add('active');
  renderCleaning();
}

function renderPortfolioCleaning() {
  const list = document.getElementById('cleaning-list');
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  const upcomingCleanCount = cleans.filter(c => !c.done && !c.cleanerDeclined && c.date >= todayStr && !_isCleanLinkedToCancelledBooking(c)).length;
  const pendingAwaitingCount = cleans.filter(c => isAwaitingCleanerResponse(c, now) && !_isCleanLinkedToCancelledBooking(c)).length;
  const pendingAssignCount = bookings.filter(b => {
    if (b.status === 'cancelled' || new Date(b.checkout) < now) return false;
    const st = getBookingCleanerState(b).key;
    return st === 'unassigned' || st === 'declined';
  }).length;
  const confirmedCount = cleans.filter(c => !c.done && c.cleanerConfirmed && c.date >= todayStr && !_isCleanLinkedToCancelledBooking(c)).length;
  const totalActionCount = pendingAssignCount + pendingAwaitingCount;

  const summaryEl = document.getElementById('cleaning-summary-strip');
  if (summaryEl) {
    summaryEl.innerHTML = '<div style="background:#fff;border-radius:12px;padding:10px 14px;display:flex;justify-content:space-around;text-align:center">' +
      '<div><div style="font-size:18px;font-weight:700;color:var(--forest)">' + upcomingCleanCount + '</div><div style="font-size:10px;color:var(--text-soft);text-transform:uppercase">Scheduled</div></div>' +
      '<div><div style="font-size:18px;font-weight:700;color:' + (totalActionCount > 0 ? 'var(--red)' : 'var(--forest)') + '">' + totalActionCount + '</div><div style="font-size:10px;color:var(--text-soft);text-transform:uppercase">Action</div></div>' +
      '<div><div style="font-size:18px;font-weight:700;color:var(--moss)">' + confirmedCount + '</div><div style="font-size:10px;color:var(--text-soft);text-transform:uppercase">Confirmed</div></div>' +
    '</div>';
  }

  function findBookingForClean(c) {
    return bookings.find(bk =>
      String(bk.id) === String(c.bookingId) ||
      (bk._cloudId && String(bk._cloudId) === String(c.bookingId)) ||
      _normName(bk.name) === _normName(c.guestName)
    );
  }

  function pCleanCard(c, b) {
    const colour = getPropertyColourById(c._propertyId || (b && b._propertyId));
    const propName = getPropertyNameById(c._propertyId || (b && b._propertyId));
    const days = Math.ceil((new Date(c.date) - now) / 86400000);
    const urgText = days < 0 ? 'Overdue' : days === 0 ? 'Today!' : days === 1 ? 'Tomorrow' : 'In ' + days + 'd';
    const urgBg = days <= 0 ? 'rgba(192,57,43,0.09)' : days <= 2 ? 'rgba(193,127,62,0.10)' : 'rgba(46,113,87,0.08)';
    const urgColor = days <= 0 ? 'var(--red)' : days <= 2 ? 'var(--amber)' : 'var(--moss)';
    const statusText = c.done ? 'Done' : c.cleanerDeclined ? 'Declined' : c.cleanerConfirmed ? 'Accepted' : 'Awaiting';
    const statusBg = c.done ? 'rgba(46,113,87,0.09)' : c.cleanerDeclined ? 'rgba(192,57,43,0.09)' : c.cleanerConfirmed ? 'rgba(46,113,87,0.09)' : 'rgba(193,127,62,0.10)';
    const statusColor = c.done ? 'var(--moss)' : c.cleanerDeclined ? 'var(--red)' : c.cleanerConfirmed ? 'var(--moss)' : 'var(--amber)';
    const cleanerLine = c.cleaner
      ? escHtml(c.cleaner) + ' · ' + escHtml(fmt(c.date))
      : '<span style="color:var(--red);font-weight:600">No cleaner assigned</span> · ' + escHtml(fmt(c.date));

    return '<div style="padding:12px 14px;border-bottom:1px solid var(--warm);border-left:3px solid ' + colour + '">' +
      '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:6px">' +
        '<div style="min-width:0">' +
          '<div style="font-weight:700;font-size:15px;line-height:1.2;margin-bottom:4px">' + escHtml(b ? b.name : (c.guestName || '—')) + '</div>' +
          '<div style="font-size:12px;margin-bottom:4px">' + cleanerLine + '</div>' +
          '<span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:99px;background:' + statusBg + ';color:' + statusColor + '">' + statusText + '</span>' +
        '</div>' +
        '<div style="flex-shrink:0"><span style="font-size:11px;font-weight:700;padding:3px 9px;border-radius:99px;background:' + urgBg + ';color:' + urgColor + '">' + urgText + '</span></div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:5px;margin-top:4px">' +
        '<div style="width:7px;height:7px;border-radius:50%;background:' + colour + ';flex-shrink:0"></div>' +
        '<span style="font-size:11px;color:var(--text-soft)">' + escHtml(propName) + '</span>' +
      '</div>' +
    '</div>';
  }

  if (cleanFilter === 'upcoming') {
    const upcoming = cleans
      .filter(c => !c.done && !c.cleanerDeclined && c.date >= todayStr && !_isCleanLinkedToCancelledBooking(c))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));

    if (!upcoming.length) {
      list.innerHTML = '<div style="text-align:center;padding:28px 16px"><div style="font-size:36px;margin-bottom:10px">🧹</div>' +
        '<div style="font-weight:600;font-size:14px;margin-bottom:4px">No upcoming cleans</div>' +
        '<div style="font-size:12px;color:var(--text-soft)">Across all properties</div></div>';
      return;
    }
    list.innerHTML = upcoming.map(c => pCleanCard(c, findBookingForClean(c))).join('');
    return;
  }

  if (cleanFilter === 'action') {
    const awaiting = cleans
      .filter(c => isAwaitingCleanerResponse(c, now) && !_isCleanLinkedToCancelledBooking(c))
      .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

    const unassigned = bookings
      .filter(b => {
        if (b.status === 'cancelled' || new Date(b.checkout) < now) return false;
        const st = getBookingCleanerState(b).key;
        return st === 'unassigned' || st === 'declined';
      })
      .sort((a, b) => new Date(a.checkout) - new Date(b.checkout));

    if (!awaiting.length && !unassigned.length) {
      list.innerHTML = '<div style="text-align:center;padding:28px 16px"><div style="font-size:36px;margin-bottom:10px">✅</div>' +
        '<div style="font-weight:600;font-size:14px;margin-bottom:4px">All good!</div>' +
        '<div style="font-size:12px;color:var(--text-soft)">No action needed across any property</div></div>';
      return;
    }

    let html = '';
    if (awaiting.length) {
      html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:var(--amber);padding:4px 0 6px;margin-top:2px">Awaiting response</div>';
      html += awaiting.map(c => pCleanCard(c, findBookingForClean(c))).join('');
    }
    if (unassigned.length) {
      html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:var(--red);padding:10px 0 6px">Needs assignment</div>';
      html += unassigned.map(b => {
        const colour = getPropertyColourById(b._propertyId);
        const propName = getPropertyNameById(b._propertyId);
        return '<div style="padding:12px 14px;border-bottom:1px solid var(--warm);border-left:3px solid ' + colour + '">' +
          '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">' +
            '<div>' +
              '<div style="font-weight:700;font-size:15px;margin-bottom:4px">' + escHtml(b.name) + '</div>' +
              '<div style="font-size:12px;color:var(--text-soft)">Checkout ' + escHtml(fmt(b.checkout)) + ' · <span style="color:var(--red);font-weight:600">No cleaner</span></div>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:5px;margin-top:4px">' +
            '<div style="width:7px;height:7px;border-radius:50%;background:' + colour + ';flex-shrink:0"></div>' +
            '<span style="font-size:11px;color:var(--text-soft)">' + escHtml(propName) + '</span>' +
          '</div>' +
        '</div>';
      }).join('');
    }
    list.innerHTML = html;
    return;
  }

  if (cleanFilter === 'done') {
    const done = cleans
      .filter(c => c.done)
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    if (!done.length) {
      list.innerHTML = '<div style="text-align:center;padding:28px 16px"><div style="font-size:36px;margin-bottom:10px">🧹</div>' +
        '<div style="font-weight:600;font-size:14px;margin-bottom:4px">No completed cleans yet</div>' +
        '<div style="font-size:12px;color:var(--text-soft)">Across all properties</div></div>';
      return;
    }
    list.innerHTML = done.map(c => pCleanCard(c, findBookingForClean(c))).join('');
    return;
  }

  cleanFilter = 'upcoming';
  renderPortfolioCleaning();
}

function renderCleaning() {
  switchCleaningView(cleaningView || 'schedule');
  if (isPortfolioMode()) {
    renderPortfolioCleaning();
    return;
  }
  const list = document.getElementById('cleaning-list');
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const upcomingBookingCount = bookings.filter(b => b.status !== 'cancelled' && new Date(b.checkout) >= now).length;
  const upcomingCleanCount = cleans.filter(c => !c.done && !c.cleanerDeclined && c.date >= todayStr && !_isCleanLinkedToCancelledBooking(c)).length;
  const pendingAwaitingCount = cleans.filter(c => isAwaitingCleanerResponse(c, now) && !_isCleanLinkedToCancelledBooking(c)).length;
  const pendingAssignCount = bookings.filter(b => {
    if (b.status === 'cancelled' || new Date(b.checkout) < now) return false;
    const st = getBookingCleanerState(b).key;
    return st === 'unassigned' || st === 'declined';
  }).length;
  const totalActionCount = pendingAssignCount + pendingAwaitingCount;
  const summaryEl = document.getElementById('cleaning-summary-strip');
  if (summaryEl) summaryEl.innerHTML = `<div class="cleaning-summary-slim">Bookings <strong>${upcomingBookingCount}</strong> · Scheduled <strong>${upcomingCleanCount}</strong> · Action <strong>${totalActionCount}</strong></div>`;

  function cleanCard(c, b, extra) {
    const days = Math.ceil((new Date(c.date) - now) / 86400000);
    const urgClass = days <= 0 ? 'urgent' : days <= 2 ? 'soon' : 'ok';
    const urgText = days < 0 ? 'Overdue' : days === 0 ? 'Today!' : days === 1 ? 'Tomorrow' : `In ${days}d`;
    const urgBg   = days <= 0 ? 'rgba(192,57,43,0.09)' : days <= 2 ? 'rgba(193,127,62,0.10)' : 'rgba(46,113,87,0.08)';
    const statusColor = c.done ? 'var(--moss)' : c.cleanerDeclined ? 'var(--red)' : c.cleanerConfirmed ? 'var(--moss)' : 'var(--amber)';
    const statusBg    = c.done ? 'rgba(46,113,87,0.09)' : c.cleanerDeclined ? 'rgba(192,57,43,0.09)' : c.cleanerConfirmed ? 'rgba(46,113,87,0.09)' : 'rgba(193,127,62,0.10)';
    const statusText  = c.done ? 'Done' : c.cleanerDeclined ? 'Declined' : c.cleanerConfirmed ? 'Accepted' : 'Awaiting';
    const waitingMeta = isAwaitingCleanerResponse(c, now) ? getAwaitingResponseMeta(c, now) : null;
    const cleanerLine = c.cleaner
      ? `<span style="font-weight:500;color:var(--text)">${escHtml(c.cleaner)}</span><span style="color:var(--text-soft)"> · ${escHtml(fmt(c.date))}</span>`
      : `<span style="color:var(--text-soft)">No cleaner · ${escHtml(fmt(c.date))}</span>`;
    return `<div style="padding:12px 0;border-bottom:1px solid var(--warm)">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:10px">
        <div style="min-width:0">
          <div style="font-weight:700;font-size:15px;line-height:1.2;margin-bottom:4px">${escHtml(b ? b.name : (c.guestName || '—'))}</div>
          <div style="font-size:12px;margin-bottom:4px">${cleanerLine}</div>
          <span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:99px;background:${statusBg};color:${statusColor}">${statusText}${waitingMeta ? ' · ' + escHtml(waitingMeta.label) : ''}</span>
        </div>
        <div style="flex-shrink:0;text-align:right">
          <span style="font-size:11px;font-weight:700;padding:3px 9px;border-radius:99px;background:${urgBg};color:var(--${urgClass === 'urgent' ? 'red' : urgClass === 'soon' ? 'amber' : 'moss'})">${urgText}</span>
        </div>
      </div>
      ${extra || ''}
    </div>`;
  }

  // ── UPCOMING: all future assigned cleans ──────────────────────────────────
  if (cleanFilter === 'upcoming') {
    const upcoming = cleans
      .filter(c => !c.done && !c.cleanerDeclined && c.date >= todayStr && !_isCleanLinkedToCancelledBooking(c))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!upcoming.length) {
      list.innerHTML = '<div style="text-align:center;padding:28px 16px"><div style="font-size:36px;margin-bottom:10px">🧹</div><div style="font-weight:600;font-size:14px;margin-bottom:4px">No upcoming cleans</div><div style="font-size:12px;color:var(--text-soft)">Assign a cleaner to a booking to get started</div></div>';
      return;
    }
    list.innerHTML = upcoming.map(c => {
      const b = bookings.find(bk => String(bk.id) === String(c.bookingId) || (bk._cloudId && String(bk._cloudId) === String(c.bookingId)) || _normName(bk.name) === _normName(c.guestName));
      const extra = `<div style="display:flex;gap:8px">
        <button onclick="openNotifyModal('${c.id}')" style="flex:1;background:var(--forest-light);color:var(--sage);border:none;border-radius:8px;padding:9px;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">💬 SMS</button>
        <button onclick="reassignClean('${c.id}')" style="flex:1;background:var(--mist);color:var(--text);border:none;border-radius:8px;padding:9px;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">↺ Reassign</button>
      </div>`;
      return cleanCard(c, b, extra);
    }).join('');
    return;
  }

  // ── ACTION: declined + unassigned bookings ────────────────────────────────
  if (cleanFilter === 'action') {
    const actionable = bookings
      .filter(b => b.status !== 'cancelled' && new Date(b.checkout) >= now)
      .map(b => ({ booking: b, state: getBookingCleanerState(b) }));
    const awaiting = cleans
      .filter(c => isAwaitingCleanerResponse(c, now) && !_isCleanLinkedToCancelledBooking(c))
      .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
    const declined = actionable
      .filter(x => x.state.key === 'declined')
      .sort((a, b) => String(a.state.clean?.date || a.booking.checkout).localeCompare(String(b.state.clean?.date || b.booking.checkout)));
    const unassigned = actionable
      .filter(x => x.state.key === 'unassigned')
      .map(x => x.booking)
      .sort((a, b) => new Date(a.checkout) - new Date(b.checkout));

    if (!awaiting.length && !declined.length && !unassigned.length) {
      list.innerHTML = '<div style="text-align:center;padding:28px 16px"><div style="font-size:36px;margin-bottom:10px">✅</div><div style="font-weight:600;font-size:14px;margin-bottom:4px">All good!</div><div style="font-size:12px;color:var(--text-soft)">No action needed</div></div>';
      return;
    }

    let html = '';
    if (awaiting.length) {
      html += `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:var(--amber);padding:4px 0 6px;margin-top:2px">Awaiting response</div>`;
      html += awaiting.map(c => {
        const b = bookings.find(bk => String(bk.id) === String(c.bookingId) || (bk._cloudId && String(bk._cloudId) === String(c.bookingId)) || _normName(bk.name) === _normName(c.guestName));
        const meta = getAwaitingResponseMeta(c, now);
        const extra = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">
          <button onclick="markCleanerConfirmed('${c.id}')" style="flex:1;min-width:100px;background:rgba(46,113,87,0.10);color:var(--moss);border:1px solid rgba(46,113,87,0.20);border-radius:8px;padding:9px;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">✓ Confirm</button>
          <button onclick="markCleanDeclined('${c.id}')" style="flex:1;min-width:100px;background:rgba(192,57,43,0.08);color:var(--red);border:1px solid rgba(192,57,43,0.18);border-radius:8px;padding:9px;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">✕ Decline</button>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button onclick="sendCleanerReminder('${c.id}')" style="flex:1;min-width:100px;background:${meta.isOverdue ? 'var(--amber)' : 'var(--mist)'};color:${meta.isOverdue ? 'white' : 'var(--text-soft)'};border:none;border-radius:8px;padding:7px 9px;font-size:11px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">${meta.isOverdue ? '⚠️ Remind now' : '💬 Remind'}</button>
          <button onclick="reassignClean('${c.id}')" style="flex:1;min-width:100px;background:var(--mist);color:var(--text-soft);border:none;border-radius:8px;padding:7px 9px;font-size:11px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">↺ Reassign</button>
        </div>`;
        return cleanCard(c, b, extra);
      }).join('');
    }
    if (declined.length) {
      html += `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:var(--red);padding:4px 0 6px;margin-top:2px">Declined — reassign needed</div>`;
      html += declined.map(({ booking, state }) => {
        const c = state.clean;
        const preferred = _getSuggestedCleanerForBooking(booking);
        const assignLastBtn = preferred
          ? `<button onclick="quickAssignLastCleaner('${booking.id}')" style="flex:1;background:var(--mist);color:var(--text);border:none;border-radius:8px;padding:9px;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">⚡ Assign Last</button>`
          : '';
        const extra = c
          ? `<div style="display:flex;gap:8px"><button onclick="reassignClean('${c.id}')" style="flex:1;background:var(--forest);color:white;border:none;border-radius:8px;padding:9px;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">↺ Reassign Cleaner</button>${assignLastBtn}</div>`
          : '';
        return cleanCard(c || { date: booking.checkout, cleaner: '', guestName: booking.name, cleanerDeclined: true }, booking, extra);
      }).join('');
    }
    if (unassigned.length) {
      html += `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;color:var(--amber);padding:4px 0 6px;margin-top:${declined.length?'12px':'2px'}">No cleaner assigned</div>`;
      html += unassigned.map(b => {
        const days = Math.ceil((new Date(b.checkout) - now) / 86400000);
        const urgClass = days <= 3 ? 'urgent' : days <= 7 ? 'soon' : 'ok';
        const preferred = _getSuggestedCleanerForBooking(b);
        const uDays = days;
        const uUrgBg = uDays <= 3 ? 'rgba(192,57,43,0.09)' : uDays <= 7 ? 'rgba(193,127,62,0.10)' : 'rgba(46,113,87,0.08)';
        const uUrgColor = uDays <= 3 ? 'var(--red)' : uDays <= 7 ? 'var(--amber)' : 'var(--moss)';
        const uUrgText = uDays <= 0 ? 'Today!' : uDays === 1 ? 'Tomorrow' : `In ${uDays}d`;
        return `<div style="padding:12px 0;border-bottom:1px solid var(--warm)">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:${preferred ? '10px' : '0'}">
            <div style="min-width:0">
              <div style="font-weight:700;font-size:15px;line-height:1.2;margin-bottom:4px">${escHtml(b.name || '')}</div>
              <div style="font-size:12px;color:var(--text-soft);margin-bottom:4px">Checkout ${escHtml(fmt(b.checkout))} · ${escHtml(b.guests || 0)} guests</div>
              <span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:99px;background:rgba(193,127,62,0.10);color:var(--amber)">No cleaner</span>
            </div>
            <div style="flex-shrink:0">
              <span style="font-size:11px;font-weight:700;padding:3px 9px;border-radius:99px;background:${uUrgBg};color:${uUrgColor}">${uUrgText}</span>
            </div>
          </div>
          ${preferred ? `<div><button onclick="quickAssignLastCleaner('${b.id}')" style="width:100%;background:var(--mist);color:var(--text);border:none;border-radius:10px;padding:9px;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">⚡ Assign to last cleaner (${escHtml(preferred.name || 'Cleaner')})</button></div>` : ''}
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
      const b = bookings.find(bk => String(bk.id) === String(c.bookingId) || (bk._cloudId && String(bk._cloudId) === String(c.bookingId)) || _normName(bk.name) === _normName(c.guestName));
      return cleanCard(c, b, '');
    }).join('');
    return;
  }
}

function reassignClean(cleanId) {
  const c = cleans.find(cl => String(cl.id) === String(cleanId));
  if (c) {
    c.cleanerDeclined = false;
    c.cleanerConfirmed = false;
    c.notified = false;
    _normalizeBookingCleanState();
    save();
    if (typeof saveCleanToCloud === 'function') saveCleanToCloud(c).catch(() => {});
  } else {
    console.log('[StayOps]] reassignClean: clean not found', cleanId);
    showDetail(cleanId);
    return;
  }
  const b = bookings.find(bk => String(bk.id) === String(c.bookingId) || (bk._cloudId && String(bk._cloudId) === String(c.bookingId)) || _normName(bk.name) === _normName(c.guestName));
  if (b) {
    showDetail(b.id);
  } else {
    showBanner('⚠ Booking not found — delete and reassign manually', 'warn');
  }
}

function markCleanerConfirmed(id) {
  const c = cleans.find(c => String(c.id) === String(id));
  if (!c) return;
  c.cleanerConfirmed = true;
  c.cleanerDeclined  = false;
  const b = bookings.find(bk => String(bk.id) === String(c.bookingId) || (bk._cloudId && String(bk._cloudId) === String(c.bookingId)));
  if (b) b.cleanerConfirmed = true;
  _normalizeBookingCleanState();
  save();
  if (typeof saveCleanToCloud === 'function') saveCleanToCloud(c).catch(() => {});
  if (b && typeof saveBookingToCloud === 'function') saveBookingToCloud(b).catch(() => {});
  showBanner('✅ Cleaner confirmed', 'ok');
  renderCleaning();
  renderBookings();
}

function markCleanDeclined(id) {
  if (!window.confirm('Mark this cleaner as unavailable? The clean will need reassigning.')) return;
  const c = cleans.find(c => String(c.id) === String(id));
  if (!c) return;
  c.cleanerDeclined  = true;
  c.cleanerConfirmed = false;
  const b = bookings.find(bk => String(bk.id) === String(c.bookingId) || (bk._cloudId && String(bk._cloudId) === String(c.bookingId)));
  if (b) b.cleanerConfirmed = false;
  _normalizeBookingCleanState();
  save();
  if (typeof saveCleanToCloud === 'function') saveCleanToCloud(c).catch(() => {});
  if (b && typeof saveBookingToCloud === 'function') saveBookingToCloud(b).catch(() => {});
  showBanner('Clean marked as declined — reassign when ready', 'warn');
  renderCleaning();
  renderBookings();
}


let financeTab = 'expenses';
// ── FINANCE HUB NAVIGATION ───────────────────────────────────────────────────

/** Show the top-level Finance hub. Called on back-nav from any Finance sub-view. */
function backToFinanceHub() {
  const pfin = document.getElementById('portfolio-finance');
  if (pfin) pfin.style.display = 'none';
  const finc = document.getElementById('finance-content');
  if (finc) finc.style.display = '';
  const hub = document.getElementById('finance-hub');
  if (hub) hub.style.display = 'block';
  ['finance-expenses-view', 'finance-reports-view'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  financeTab = null;
}

/** Toggle the Add Expense form panel open/closed. */
function toggleExpenseAddForm() {
  const panel   = document.getElementById('expense-add-form-panel');
  const chevron = document.getElementById('expense-add-chevron');
  if (!panel) return;
  const opening = panel.style.display === 'none';
  panel.style.display = opening ? 'block' : 'none';
  if (chevron) chevron.textContent = opening ? '∨' : '›';
  if (opening) {
    // Populate today's date when opening the form
    const expDateEl = document.getElementById('exp-date');
    if (expDateEl && !expDateEl.value) expDateEl.value = new Date().toISOString().split('T')[0];
    populateExpenseCatSelect();
    // Scroll the form into view
    setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  }
}

/** Close the Add Expense form panel (called after a successful save). */
function closeExpenseAddForm() {
  const panel   = document.getElementById('expense-add-form-panel');
  const chevron = document.getElementById('expense-add-chevron');
  if (panel)   panel.style.display = 'none';
  if (chevron) chevron.textContent = '›';
}

/** Navigate into a Finance sub-view (expenses or reports). */
function showFinanceSub(sub) {
  financeTab = sub;
  const hub = document.getElementById('finance-hub');
  if (hub) hub.style.display = 'none';
  ['finance-expenses-view', 'finance-reports-view'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  if (sub === 'expenses') {
    const el = document.getElementById('finance-expenses-view');
    if (el) el.style.display = 'block';
    renderExpenses();
    populateExpenseCatSelect();
  } else if (sub === 'reports') {
    const el = document.getElementById('finance-reports-view');
    if (el) el.style.display = 'block';
    // Default to Owner Reports sub-tab
    switchReportsSubTab('reports', document.getElementById('rpt-tab-reports'));
  }
}

/** Switch sub-tabs within the Reports section (Owner Reports / Payouts / Management). */
function switchReportsSubTab(sub, btn) {
  document.querySelectorAll('#finance-reports-view > .tab-row .tab').forEach(t => t.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const inner   = document.getElementById('finance-reports-inner');
  const payouts = document.getElementById('finance-payouts-view');
  const mgmt    = document.getElementById('finance-mgmt-view');
  if (inner)   inner.style.display   = sub === 'reports'  ? '' : 'none';
  if (payouts) payouts.style.display = sub === 'payouts'  ? '' : 'none';
  if (mgmt)    mgmt.style.display    = sub === 'mgmt'     ? '' : 'none';
  if (sub === 'reports')  renderReport();
  if (sub === 'payouts')  renderRevenue();
  if (sub === 'mgmt')     renderManagement();
}

/**
 * Open a Finance settings panel from the Finance hub.
 * Passes returnSection='finance' so the back button returns to Finance, not Settings.
 */
function openFinancePanelFromHub(panelId) {
  openSettingsPanel(panelId, 'finance');
}

/**
 * switchFinanceTab — backward-compat shim.
 * Maps old tab names to the new hub navigation.
 */
function switchFinanceTab(tab, btn) {
  financeTab = tab;
  if (tab === 'expenses') { showFinanceSub('expenses'); return; }
  if (tab === 'reports')  { showFinanceSub('reports');  return; }
  // payouts and mgmt are now sub-tabs inside Reports
  if (tab === 'payouts' || tab === 'mgmt') {
    showFinanceSub('reports');
    switchReportsSubTab(tab, document.getElementById('rpt-tab-' + tab));
    return;
  }
  // fallback — show hub
  backToFinanceHub();
}

function switchPayoutsSubTab(sub, btn) {
  document.querySelectorAll('#finance-payouts-view > .tab-row .tab').forEach(t => t.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.getElementById('pay-monthly-view').style.display = sub === 'monthly' ? '' : 'none';
  document.getElementById('pay-fy-view').style.display      = sub === 'fy'      ? '' : 'none';
  if (sub === 'monthly') renderRevenue();
  if (sub === 'fy')      renderReport();
}

function switchMgmtSubTab(sub, btn) {
  document.querySelectorAll('#finance-mgmt-view > .tab-row .tab').forEach(t => t.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.getElementById('mgmt-monthly-view').style.display = sub === 'monthly' ? '' : 'none';
  document.getElementById('mgmt-fy-view').style.display      = sub === 'fy'      ? '' : 'none';
  if (sub === 'monthly') renderManagement();
  if (sub === 'fy')      renderMgmtFY();
}

// switchReportSubTab removed — Reports tab is now a single FY view with send buttons
function switchReportSubTab(sub, btn) {
  renderReport(); // always render the FY report
}

function renderMgmtFY() {
  const el = document.getElementById('mgmt-fy-content');
  if (!el) return;
  const months = fyMonths(reportFY);
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const mdata = months.map(({year, month}) => {
    const bs = bookings.filter(b => b.status !== 'cancelled' && (()=>{ const d=new Date(b.checkin); return d.getFullYear()===year&&d.getMonth()===month; })());
    return { label: mo[month], total: bs.reduce((s,b)=>s+Number(b.mgmtPayout||0),0), count: bs.length };
  });
  const fyTotal = mdata.reduce((s,m)=>s+m.total, 0);
  el.innerHTML = `
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <button onclick="fyPrev();renderMgmtFY()" style="background:var(--warm);border:none;border-radius:8px;width:32px;height:32px;font-size:16px;cursor:pointer">‹</button>
        <div style="font-family:'DM Serif Display',serif;font-size:18px;color:var(--forest)">${fyLabel(reportFY)} Management</div>
        <button onclick="fyNext();renderMgmtFY()" style="background:var(--warm);border:none;border-radius:8px;width:32px;height:32px;font-size:16px;cursor:pointer">›</button>
      </div>
      <div style="text-align:center;padding:12px;background:var(--forest);border-radius:var(--radius-sm);margin-bottom:12px">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.6px;color:var(--sage);margin-bottom:4px">Total Management Payout</div>
        <div style="font-family:'DM Serif Display',serif;font-size:32px;color:white">$${fyTotal.toLocaleString('en-AU',{minimumFractionDigits:0,maximumFractionDigits:0})}</div>
      </div>
      ${mdata.map(m=>`<div class="revenue-row"><div class="rl">${m.label} <span style="color:var(--text-soft);font-size:11px">${m.count} booking${m.count!==1?'s':''}</span></div><div class="rr">$${m.total.toLocaleString('en-AU',{minimumFractionDigits:0,maximumFractionDigits:0})}</div></div>`).join('')}
    </div>`;
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

function renderFinance() {
  if (isPortfolioMode()) {
    renderPortfolioFinance();
    return;
  }
  const singleFin = document.getElementById('finance-content');
  const portfolioFin = document.getElementById('portfolio-finance');
  if (singleFin) singleFin.style.display = '';
  if (portfolioFin) portfolioFin.style.display = 'none';
  // Finance opens on the hub — user taps a row to enter a sub-section
  backToFinanceHub();
}

// switchRevTab is superseded by switchPayoutsSubTab / switchReportSubTab
function switchRevTab(tab) {
  if (tab === 'report') switchPayoutsSubTab('fy', document.getElementById('pay-tab-fy'));
  else switchPayoutsSubTab('monthly', document.getElementById('pay-tab-monthly'));
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
  const rptTitle = document.getElementById('rpt-fy-title');
  if (rptTitle) rptTitle.textContent = fyLabel(reportFY);
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
  // Also populate the Payouts FY view copy (if visible)
  const payoutsCopy = document.getElementById('report-content-payouts');
  if (payoutsCopy) payoutsCopy.innerHTML = html;
}

let revYear = new Date().getFullYear();
let revMonth = new Date().getMonth();
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
// ── Invoice identity helper ───────────────────────────────────────────────
// Returns the HOST's business identity (the "issued by" side of the invoice).
// Owner = the property owner/client (bill-to). Host = you/your business.
// host_config has no live Supabase row yet, so host identity reads from
// Prefers host_config (Supabase via getHostProfile) then falls back to
// legacy inv-* localStorage keys for backward compatibility.
function _getInvoiceIdentity() {
  const host = (typeof getHostProfile === 'function') ? (getHostProfile() || {}) : {};
  const ls   = k => localStorage.getItem(lsKey(k)) || '';
  return {
    name:    host.name    || ls('inv-name'),
    email:   host.email   || ls('inv-email'),
    address: host.address || ls('inv-address'),
    company: host.company || ls('inv-company'),
    abn:     host.abn     || ls('inv-abn'),
    acn:     host.acn     || ls('inv-acn'),
  };
}
function buildInvoicePDF(selected, client) {
  const inv = _getInvoiceIdentity();
  const bank = {
    name: localStorage.getItem(lsKey('bank-name')) || '',
    bsb: localStorage.getItem(lsKey('bank-bsb')) || '',
    acc: localStorage.getItem(lsKey('bank-acc')) || '',
    bank: localStorage.getItem(lsKey('bank-bank')) || ''
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
      <h1>${inv.company || inv.name || getCurrentPropertyName()}</h1>
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
    🏡 <strong>${getCurrentPropertyName()}</strong> · ${getCurrentPropertyTagline()}<br>
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
  <div class="footer">${getCurrentPropertyName()} Property Management · ${[getPropertyConfig().suburb, getPropertyConfig().state].filter(Boolean).join(' ')} · Generated ${today}</div>
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
  if (typeof isPortfolioMode === 'function' && isPortfolioMode()) {
    list.innerHTML = '<div class="card" style="text-align:center;padding:28px 16px"><div style="font-size:36px;margin-bottom:10px">📝</div><div style="font-weight:600;font-size:14px;margin-bottom:4px">Select a property to view notes</div><div style="font-size:12px;color:var(--text-soft)">Notes are per property — open the property switcher and choose one property.</div></div>';
    return;
  }
  if (!notes.length) { list.innerHTML='<div class="card" style="text-align:center;padding:28px 16px"><div style="font-size:36px;margin-bottom:10px">📝</div><div style="font-weight:600;font-size:14px;margin-bottom:4px">No notes yet</div><div style="font-size:12px;color:var(--text-soft)">Add notes about guests, special requests or anything useful</div></div>'; return; }
  list.innerHTML = [...notes].sort((a,b)=>new Date(b.date)-new Date(a.date)).map(n=>`
    <div class="note-item">
      <div class="note-guest"><span class="note-tag tag-${n.tag}">${n.tag}</span>${n.guestName}</div>
      <div class="note-text">${n.text}</div>
      <div class="note-date">${fmt(n.date)}</div>
    </div>`).join('');
}

// ── SETTINGS NAVIGATION ──────────────────────────────────────────────────────
// Settings lives in its own section (section-settings). These functions manage
// navigation within that section: main menu → category → panel → back.

function _resetSettingsToMenu() {
  // Show main menu, hide all cats and panels
  const sm = document.getElementById('settings-menu');
  if (sm) {
    sm.style.display = '';
    // Retrigger the fade-in animation each time the menu is shown.
    sm.style.animation = 'none';
    sm.offsetHeight; // force reflow
    sm.style.animation = '';
  }
  document.querySelectorAll('[id^="settings-cat-"]').forEach(el => el.style.display = 'none');
  document.querySelectorAll('[id^="settings-panel-"]').forEach(el => el.style.display = 'none');
}

function _ensureSettingsVisible() {
  // If we're not on the settings section, switch to it
  if (currentSection !== 'settings') showSection('settings');
  // Scroll to top so the panel is visible
  const mc = document.getElementById('main-content');
  if (mc) mc.scrollTop = 0;
  else window.scrollTo(0, 0);
}

function openSettingsCat(cat, returnSection) {
  _ensureSettingsVisible();
  const sm = document.getElementById('settings-menu');
  if (sm) sm.style.display = 'none';
  document.querySelectorAll('[id^="settings-cat-"]').forEach(el => el.style.display = 'none');
  document.querySelectorAll('[id^="settings-panel-"]').forEach(el => el.style.display = 'none');
  const el = document.getElementById('settings-cat-' + cat);
  if (el) {
    el.style.display = 'block';
    if (returnSection) el.dataset.returnSection = returnSection;
    else delete el.dataset.returnSection;
  }
  if (cat === 'property') {
    setTimeout(updateNotifStatus, 100);
    const sr = document.getElementById('notif-status-row-menu');
    if (sr) { const p = Notification.permission; sr.textContent = p === 'granted' ? '✅ Enabled' : p === 'denied' ? '❌ Blocked' : 'Tap to set up'; }
  }
  if (cat === 'cleaner') { openCleanerSettings(); }
}

function openSettingsPanel(panelId, returnSection) {
  _ensureSettingsVisible();
  // track which cat we came from
  const activeCat = document.querySelector('[id^="settings-cat-"]:not([style*="display: none"]):not([style*="display:none"])');
  const prevCat = activeCat ? activeCat.id.replace('settings-cat-', '') : null;
  // track which panel we came from (for panel→panel navigation)
  const activePanel = document.querySelector('[id^="settings-panel-"]:not([style*="display: none"]):not([style*="display:none"])');
  const prevPanel = activePanel ? activePanel.id.replace('settings-panel-', '') : null;
  const sm = document.getElementById('settings-menu');
  if (sm) sm.style.display = 'none';
  document.querySelectorAll('[id^="settings-cat-"]').forEach(el => el.style.display = 'none');
  document.querySelectorAll('[id^="settings-panel-"]').forEach(el => el.style.display = 'none');
  const panel = document.getElementById('settings-panel-' + panelId);
  if (!panel) return;
  panel.style.display = 'block';
  if (prevCat) panel.dataset.prevCat = prevCat;
  else delete panel.dataset.prevCat;
  if (prevPanel) panel.dataset.prevPanel = prevPanel;
  else delete panel.dataset.prevPanel;
  if (returnSection) panel.dataset.returnSection = returnSection;
  else delete panel.dataset.returnSection;

  // populate panel data on open
  if (panelId === 'sms-template') {
    const defaultTemplate = `Hi {cleanerFirstName}\n\nNew Booking - please see below\n\nCheck in: {checkin}\nCheck out: {checkout}\nName: {guestFirstName}\nNumber of guests: {guests}\n\nPlease let me know if you are available`;
    const el = document.getElementById('settings-sms-template');
    if (el) el.value = localStorage.getItem(lsKey('sms-template')) || defaultTemplate;
  }
  if (panelId === 'team') {
    renderTeamList();
    _renderAutoAssignToggle();
  }
  if (panelId === 'property-switcher') {
    renderPropertySwitcher();
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
      if (el) el.value = localStorage.getItem(lsKey('inv-'+k)) || '';
    });
  }
  if (panelId === 'bank-details') {
    ['name','bsb','acc','bank'].forEach(k => {
      const el = document.getElementById('inv-bank-'+k);
      if (el) el.value = localStorage.getItem(lsKey('inv-bank-'+k)) || '';
    });
  }
  if (panelId === 'invoice-clients') {
    renderClientsList();
  }
  if (panelId === 'backup') {
    const el = document.getElementById('backup-last-time');
    if (el) el.textContent = localStorage.getItem(lsKey('last-backup')) || 'Never';
  }
  if (panelId === 'ai-import') {
    const el = document.getElementById('settings-api-key');
    if (el) el.value = localStorage.getItem('gh-api-key') || '';
  }
  if (panelId === 'smart-pricing') {
    const saved = localStorage.getItem(lsKey('base-rate'));
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
  if (panelId === 'connection-checker') {
    resetConnectionCheckerResults();
  }
  if (panelId === 'integrations') {
    renderConnectionSummary();
  }
  if (panelId === 'owner-report') {
    populateOwnerReportPanel();
  }
  if (panelId === 'mgmt-fee') {
    populateMgmtFeePanel();
  }
  if (panelId === 'host-profile') {
    populateHostProfilePanel();
  }
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
  if (!id || typeof setActivePropertyId !== 'function') return;
  const current = getActivePropertyId();
  if (id === current) return;

  const ok = setActivePropertyId(id);
  if (!ok) {
    showBanner('⚠ Could not switch property', 'warn');
    renderPropertySwitcher();
    return;
  }

  sessionStorage.setItem('stayops-portfolio-mode', 'false');

  showBanner('✓ Switched to ' + getCurrentPropertyName(), 'ok');

  // Reload to ensure all property-scoped module state is rehydrated cleanly.
  setTimeout(() => window.location.reload(), 120);
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
    reloadInMemoryData();
    if (typeof initPropertyUI === 'function') initPropertyUI();
    showSection('cleaning');
    cleanFilter = 'action';
    renderCleaning();
    document.querySelectorAll('#clean-schedule-card .tab-row .tab').forEach((t, i) => t.classList.toggle('active', i === 1));
    return;
  }
  sessionStorage.setItem('stayops-post-switch-action', 'cleaning-action');
  switchActiveProperty(localId);
}
window.jumpToPropertyCleaningAction = jumpToPropertyCleaningAction;

function applyStayopsPostSwitchAction() {
  const postAction = sessionStorage.getItem('stayops-post-switch-action');
  if (!postAction) return;
  sessionStorage.removeItem('stayops-post-switch-action');
  if (postAction === 'cleaning-action') {
    showSection('cleaning');
    cleanFilter = 'action';
    renderCleaning();
    document.querySelectorAll('#clean-schedule-card .tab-row .tab').forEach((t, i) => t.classList.toggle('active', i === 1));
  }
}

function closeSettingsPanel() {
  const panel = document.querySelector('[id^="settings-panel-"]:not([style*="display: none"]):not([style*="display:none"])');
  const returnCat     = panel?.dataset.prevCat;
  const returnPanel   = panel?.dataset.prevPanel;
  const returnSection = panel?.dataset.returnSection;
  const _doClose = () => {
    document.querySelectorAll('[id^="settings-panel-"]').forEach(el => { el.style.display = 'none'; el.style.animation = ''; });
    if (returnPanel)        openSettingsPanel(returnPanel);
    else if (returnCat)     openSettingsCat(returnCat);
    else if (returnSection) showSection(returnSection);
    else                    closeSettingsCat();
  };
  if (panel) {
    panel.style.animation = 'settingsPanelOut 0.18s cubic-bezier(0.32,0.72,0,1) both';
    setTimeout(_doClose, 170);
  } else {
    _doClose();
  }
}

function closeSettingsCat() {
  const activeCat = document.querySelector('[id^="settings-cat-"]:not([style*="display: none"]):not([style*="display:none"])');
  const returnSection = activeCat && activeCat.dataset.returnSection;
  const _doClose = () => {
    if (activeCat) { activeCat.style.animation = ''; }
    _resetSettingsToMenu();
    if (returnSection) showSection(returnSection);
  };
  if (activeCat) {
    activeCat.style.animation = 'settingsCatOut 0.18s cubic-bezier(0.32,0.72,0,1) both';
    setTimeout(_doClose, 170);
  } else {
    _doClose();
  }
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
  if (newName.trim()) { cats[index] = newName.trim(); localStorage.setItem(lsKey('expense-cats'), JSON.stringify(cats)); if (typeof saveAppConfigToCloud === 'function') saveAppConfigToCloud({ expense_cats: cats }).catch(() => {}); populateExpenseCatSelect(); }
}

function addExpenseCat() {
  const val = document.getElementById('new-expense-cat').value.trim();
  if (!val) return;
  const cats = getExpenseCats();
  cats.push(val);
  localStorage.setItem(lsKey('expense-cats'), JSON.stringify(cats));
  if (typeof saveAppConfigToCloud === 'function') saveAppConfigToCloud({ expense_cats: cats }).catch(() => {});
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
  localStorage.setItem(lsKey('expense-cats'), JSON.stringify(cats));
  if (typeof saveAppConfigToCloud === 'function') saveAppConfigToCloud({ expense_cats: cats }).catch(() => {});
  renderExpenseCatSettings();
  populateExpenseCatSelect();
}

async function resetExpenseCats() {
  const _okReset = await showAppModal({ title: 'Reset Categories', msg: "Reset to default categories? This won't affect existing expenses.", confirmText: 'Reset' });
  if (!_okReset) return;
  localStorage.removeItem(lsKey('expense-cats'));
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
  if (baseRate) localStorage.setItem(lsKey('base-rate'), baseRate);

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

  const pCfg   = getPricingConfig();
  const pStats = getPropertyStats();
  const prompt = `You are a short-term rental pricing expert for ${pCfg.locationContext}. Property: ${getCurrentPropertyName()} — ${pStats.bedrooms}-bedroom, ${pStats.maxGuests}-guest property.

Booking history (${history.length} bookings, avg host payout A$${avgPayout}):
${JSON.stringify(history.slice(-10))}

Base rate: A$${baseRate || pCfg.baseRate || '350'}/night. Today: ${now.toISOString().split('T')[0]}. Forecast: ${periodLabel}.

LOCATION-SPECIFIC DEMAND FACTORS:
${pCfg.locationFactors || '- No specific demand factors configured. Use general STR pricing principles for the location.'}

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
  renderHostProfileRow();
  renderConnectionSummary();
  // Quick actions — only show if setup has gaps
  const qaWrap = document.getElementById('settings-quick-actions');
  const fixBtn = document.getElementById('settings-fix-setup-btn');
  const setupGaps = (typeof getPropertyConfigGaps === 'function') ? getPropertyConfigGaps() : [];
  if (qaWrap) qaWrap.style.display = setupGaps.length ? '' : 'none';
  if (fixBtn) fixBtn.onclick = () => { openSettingsCat('property'); reopenPropertySetup(); };
  // Team count on main menu
  const teamMenuEl = document.getElementById('team-count-row-menu');
  if (teamMenuEl) {
    const cleaners = loadCleaners ? loadCleaners() : [];
    teamMenuEl.textContent = cleaners.length ? cleaners.length + ' people' : 'Cleaners & contractors';
  }
  // Header property name + chevron
  const headerName = document.getElementById('header-property-name');
  if (headerName) headerName.textContent = getCurrentPropertyName();
  const props = typeof getAllProperties === 'function' ? getAllProperties() : [];
  // Always show chevron — even with 1 property, tap opens sheet with Add Property
  const chevron = document.getElementById('prop-switcher-chevron');
  if (chevron) chevron.style.display = '';
  const chevronHeader = document.getElementById('prop-switcher-chevron-header');
  if (chevronHeader) chevronHeader.style.display = '';
  setTimeout(updateNotifStatus, 100);
}

function populateSelects() {
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

function _normName(v) {
  return String(v || '').trim().toLowerCase();
}

function _findMatchingCleanForBooking(booking, preferredDate) {
  if (!booking) return null;
  const byBookingId = cleans.find(c => String(c.bookingId) === String(booking.id));
  if (byBookingId) return byBookingId;

  const targetDate = String(preferredDate || booking.checkout || '').slice(0, 10);
  const name = _normName(booking.name);
  if (name && targetDate) {
    const byGuestAndDate = cleans.find(c => _normName(c.guestName) === name && String(c.date || '').slice(0, 10) === targetDate);
    if (byGuestAndDate) return byGuestAndDate;
  }

  return null;
}

function _isCleanLinkedToCancelledBooking(clean) {
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

function getBookingCleanerState(booking) {
  if (booking && booking.status === 'cancelled') return { key: 'cancelled', label: 'Cancelled — no cleaner required', tone: 'ok' };
  const clean = _findMatchingCleanForBooking(booking);
  if (!clean) return { key: 'unassigned', label: 'Needs cleaner assignment', tone: 'warn' };
  if (clean.done) return { key: 'done', label: 'Clean completed', tone: 'ok', clean };
  if (clean.cleanerDeclined) return { key: 'declined', label: 'Cleaner declined — reassign needed', tone: 'bad', clean };
  if (clean.cleanerConfirmed) return { key: 'confirmed', label: 'Cleaner confirmed', tone: 'ok', clean };
  return { key: 'pending', label: 'Assigned — awaiting cleaner response', tone: 'warn', clean };
}

// ── BOOKING DETAIL ────────────────────────────────────────────────────────
function showDetail(id) {
  const b = bookings.find(b => b._cloudId === id || String(b.id) === String(id));
  if (!b) return;
  const isCancelled = b.status === 'cancelled';
  // A booking is "past" once its checkout date is strictly before today.
  // Current and upcoming bookings keep the full cleaner workflow.
  const todayStr = new Date().toISOString().split('T')[0];
  const isPast = !isCancelled && b.checkout && String(b.checkout).slice(0, 10) < todayStr;
  const bn = notes.filter(n=>n.bookingId===id);
  const matchedClean = _findMatchingCleanForBooking(b);
  const cleanerState = getBookingCleanerState(b);
  const bc = matchedClean ? [matchedClean] : [];
  // Cancelled booking: minimal record view — no financials, no cleaner controls
  if (isCancelled) {
    document.getElementById('detail-content').innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <div style="display:flex;align-items:center;gap:12px">
          ${platformIcon(b.platform, 52)}
          <div>
            <div style="font-family:'DM Serif Display',serif;font-size:20px;opacity:0.6">${b.name}</div>
            <div class="booking-status status-cancelled" style="margin-top:4px">✕ Cancelled</div>
          </div>
        </div>
        <button onclick="deleteBooking(${b.id})" style="background:#FDECEA;color:var(--red);border:none;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer">Delete</button>
      </div>
      <div class="card" style="margin-bottom:10px">
        <div class="card-title">Stay Details</div>
        <div class="detail-row"><span class="detail-label">Check-in</span><span class="detail-val">${fmt(b.checkin)}</span></div>
        <div class="detail-row"><span class="detail-label">Check-out</span><span class="detail-val">${fmt(b.checkout)}</span></div>
        <div class="detail-row"><span class="detail-label">Nights</span><span class="detail-val">${b.nights}</span></div>
        <div class="detail-row"><span class="detail-label">Guests</span><span class="detail-val">${b.guests}</span></div>
        ${b.platform ? `<div class="detail-row"><span class="detail-label">Platform</span><span class="detail-val">${b.platform==='Airbnb'?'🏠 Airbnb':b.platform==='VRBO'?'🏡 VRBO':'📋 Direct'}</span></div>` : ''}
      </div>
    `;
    document.getElementById('detail-modal').classList.add('open'); document.body.style.overflow='hidden';
    setTimeout(attachModalHandleDrag, 0);
    return;
  }

  document.getElementById('detail-content').innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <div style="display:flex;align-items:center;gap:12px">
        ${platformIcon(b.platform, 52)}
        <div>
          <div style="font-family:'DM Serif Display',serif;font-size:20px">${b.name}</div>
          <div class="booking-status status-${b.status}">${b.status}</div>
        </div>
      </div>
      <button onclick="showEditModal('${b._cloudId || b.id}')" style="background:var(--amber);color:white;border:none;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer">Edit</button>
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
      ${bc.length
        ? `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0 10px">
            <div>
              <div style="font-weight:600;font-size:15px;color:var(--forest)">${escHtml(bc[0].cleaner)}</div>
              <div style="font-size:12px;color:var(--text-soft);margin-top:2px">Clean date: ${fmt(bc[0].date)}</div>
            </div>
            <span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:99px;background:${cleanerState.tone==='ok'?'rgba(46,113,87,0.09)':cleanerState.tone==='bad'?'rgba(192,57,43,0.09)':'rgba(193,127,62,0.11)'};color:${cleanerState.tone==='ok'?'var(--moss)':cleanerState.tone==='bad'?'var(--red)':'var(--amber)'}">${cleanerState.key==='done'?'Done':cleanerState.key==='confirmed'?'Confirmed':cleanerState.key==='declined'?'Declined':'Awaiting'}</span>
          </div>`
        : `<div style="font-size:13px;color:var(--text-soft);padding:8px 0 10px">No cleaner assigned yet</div>`
      }
      ${cleanerState.key === 'confirmed'
        ? `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0 2px;border-top:1px solid var(--warm)">
            <div style="font-size:13px;font-weight:500;color:var(--moss)">✓ Cleaner confirmed</div>
          </div>
          <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--warm)">
            <button onclick="revealCleanerReassign('${b._cloudId || b.id}')" id="detail-change-cleaner-btn" style="width:100%;background:var(--warm);color:var(--text);border:1px solid var(--card-border);border-radius:10px;padding:9px;font-size:13px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">Change Cleaner</button>
            <div id="detail-reassign-form" style="display:none;margin-top:12px">${(()=>{
              const cls = loadCleaners().filter(c => isCleanerPerson(c));
              const assigned = bc[0];
              if (!cls.length) return '<div style="font-size:12px;color:var(--text-soft)">No cleaners set up yet — add in Settings → Property &amp; People</div>';
              const opts = cls.map(c => '<option value="' + c.id + '" ' + (assigned && String(assigned.cleanerId) === String(c.id) ? 'selected' : '') + '>' + c.name + '</option>').join('');
              return '<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-soft);margin-bottom:8px">Change Cleaner</div><select id="detail-assign-cleaner" style="margin-bottom:8px"><option value="">— Not assigned —</option>' + opts + '</select><input type="date" id="detail-assign-date" value="' + (assigned ? assigned.date : b.checkout) + '" style="margin-bottom:8px"><button onclick="assignCleanerToBooking(' + b.id + ')" class="btn-primary" style="width:100%" id="detail-assign-btn">💾 Save Assignment</button>';
            })()}</div>
          </div>`
        : `<div class="toggle-wrap" style="border-top:1px solid var(--warm);padding-top:10px;margin-top:2px">
            <div style="font-size:13px;font-weight:500">Cleaner confirmed</div>
            <button class="toggle ${(matchedClean?.cleanerConfirmed ?? b.cleanerConfirmed)?'on':''}" onclick="toggleCleanerConfirmed(${b.id})"></button>
          </div>
          <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--warm)">
            <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-soft);margin-bottom:8px">${bc.length ? 'Change Cleaner' : 'Assign Cleaner'}</div>
            ${(()=>{
              const cls = loadCleaners().filter(c => isCleanerPerson(c));
              const assigned = bc[0];
              const suggested = _getSuggestedCleanerForBooking(b);
              if (!cls.length) return '<div style="font-size:12px;color:var(--text-soft)">No cleaners set up yet — add in Settings → Property &amp; People</div>';
              const opts = cls.map(c => '<option value="' + c.id + '" ' + (((assigned && String(assigned.cleanerId) === String(c.id)) || (!assigned && suggested && String(suggested.id) === String(c.id))) ? 'selected' : '') + '>' + c.name + '</option>').join('');
              const suggestHint = (!assigned && suggested) ? '<div style="font-size:11px;color:var(--text-soft);margin:-2px 0 8px 0">Suggested: ' + escHtml(suggested.name || '') + '</div>' : '';
              return '<select id="detail-assign-cleaner" style="margin-bottom:8px"><option value="">— Not assigned —</option>' + opts + '</select>' + suggestHint + '<input type="date" id="detail-assign-date" value="' + (assigned ? assigned.date : b.checkout) + '" style="margin-bottom:8px"><button onclick="assignCleanerToBooking(' + b.id + ')" class="btn-primary" style="width:100%" id="detail-assign-btn">💾 Save Assignment</button>';
            })()}
          </div>`
      }
    </div>
    ${isPast ? `<div class="card" style="margin-bottom:10px">
      <div class="card-title">Cleaning Cost</div>
      <div id="clean-cost-view" style="display:flex;align-items:center;justify-content:space-between;padding:4px 0 2px">
        <span style="font-size:22px;font-family:'DM Serif Display',serif;color:var(--forest)">$${Number(b.cleaningFee||0).toLocaleString()}</span>
        <button onclick="document.getElementById('clean-cost-view').style.display='none';document.getElementById('clean-cost-edit').style.display=''" style="background:none;border:1px solid var(--card-border);border-radius:8px;padding:5px 12px;font-size:12px;font-weight:600;color:var(--text-soft);cursor:pointer;font-family:'DM Sans',sans-serif">Edit</button>
      </div>
      <div id="clean-cost-edit" style="display:none;margin-top:8px">
        <div style="display:flex;gap:8px;align-items:center">
          <input type="number" id="actual-clean-fee" value="${Number(b.cleaningFee||0)}" placeholder="0" style="flex:1;padding:10px;border:1px solid var(--warm);border-radius:8px;font-size:14px;font-family:'DM Sans',sans-serif">
          <button onclick="saveCleaningFee(${b.id})" style="background:var(--forest);color:white;border:none;border-radius:8px;padding:10px 14px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap">Save</button>
        </div>
      </div>
    </div>` : ''}
    ${bn.length?`<div class="card" style="margin-bottom:10px">
      <div class="card-title">Notes</div>
      ${bn.map(n=>`<div class="note-item" style="margin-bottom:6px"><span class="note-tag tag-${n.tag}">${n.tag}</span><div class="note-text">${n.text}</div></div>`).join('')}
    </div>`:''}
    <button class="btn-secondary" style="margin-bottom:8px;background:#FDECEA;color:var(--red)" onclick="deleteBooking(${b.id})">Delete Booking</button>
  `;
  document.getElementById('detail-modal').classList.add('open'); document.body.style.overflow='hidden';
  setTimeout(attachModalHandleDrag, 0);
}
function showEditModal(id) {
  const b = bookings.find(b => b._cloudId === id || String(b.id) === String(id));
  if (!b) return;
  const safeId = b._cloudId || b.id;
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
    <button class="btn-primary" onclick="saveEdit('${safeId}')" id="save-edit-btn">Save & Sync</button>
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
  const host = Number(document.getElementById('e-hostpayout').value) || 0;
  const clean = Number(document.getElementById('e-cleaningfee').value) || 0;
  const mgmtPct = Number(document.getElementById('e-mgmtfee').value) || 0;
  const mgmtBase = host - clean;
  const mgmtAmt = Math.round(mgmtBase * mgmtPct / 100 * 100) / 100;
  const net = Math.round(mgmtBase * 100) / 100;
  const mgmtEl = document.getElementById('e-mgmtpayout');
  const netEl  = document.getElementById('e-netpayout');
  if (mgmtEl) mgmtEl.value = mgmtPct ? '$' + mgmtAmt.toFixed(2) : '';
  if (netEl)  netEl.value  = host ? '$' + net.toFixed(2) : '';
}

function saveEdit(id) {
  const b = bookings.find(b => b._cloudId === id || String(b.id) === String(id));
  if (!b) return;
  const btn = document.getElementById('save-edit-btn');
  btn.textContent = 'Saving...'; btn.disabled = true;

  b.name        = document.getElementById('e-name').value.trim();
  b.checkin     = document.getElementById('e-checkin').value;
  b.checkout    = document.getElementById('e-checkout').value;
  b.nights      = Number(document.getElementById('e-nights').value) || 1;
  b.guests      = Number(document.getElementById('e-guests').value) || 1;
  b.hostPayout  = Number(document.getElementById('e-hostpayout').value) || 0;
  b.cleaningFee = Number(document.getElementById('e-cleaningfee').value) || 0;

  const mgmtPct  = Number(document.getElementById('e-mgmtfee').value) || 0;
  const mgmtBase = b.hostPayout - b.cleaningFee;
  b.mgmtFeeRaw   = mgmtPct;
  b.mgmtFee      = Math.round(mgmtBase * mgmtPct / 100 * 100) / 100;
  b.mgmtPayout   = b.mgmtFee;                                          // manager's cut
  b.netPayout    = Math.round((mgmtBase - b.mgmtFee) * 100) / 100;    // owner's take-home

  if (!b.status) b.status = 'confirmed';
  // Refresh stale guestName / checkin on any linked clean records before saving
  _normalizeBookingCleanState();
  save();
  if (typeof saveBookingToCloud === 'function') saveBookingToCloud(b).catch(() => {});
  showBanner('✅ Booking saved', 'ok');
  setTimeout(() => { closeDetailModal(); renderAll(); }, 500);
}

function revealCleanerReassign(id) {
  if (!confirm('This cleaner is already confirmed. Change the assignment?')) return;
  const form = document.getElementById('detail-reassign-form');
  const btn  = document.getElementById('detail-change-cleaner-btn');
  if (form) form.style.display = '';
  if (btn)  btn.style.display  = 'none';
}

function toggleCleanerConfirmed(id) {
  const b = bookings.find(b => b._cloudId === id || String(b.id) === String(id));
  if (!b) return;
  if (b.status === 'cancelled') {
    showBanner('Cancelled booking — cleaner confirmation is disabled', 'warn');
    return;
  }
  const next = !b.cleanerConfirmed;
  const matchedClean = _findMatchingCleanForBooking(b);
  b.cleanerConfirmed = next;
  if (matchedClean) {
    matchedClean.cleanerConfirmed = next;
    if (!next) matchedClean.cleanerDeclined = false;
    if (typeof saveCleaningJobToCloud === 'function') saveCleaningJobToCloud(matchedClean);
  }
  _normalizeBookingCleanState();
  save();
  if (typeof saveCleansToCloud === 'function') saveCleansToCloud(cleans).catch(() => {});
  // Fix: also persist the booking's cleaner_confirmed to Supabase so both
  // tables stay in sync (previously only the clean record was saved).
  if (typeof saveBookingToCloud === 'function') saveBookingToCloud(b).catch(() => {});
  showDetail(id);
  renderBookings();
  renderCleaning();
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
  document.querySelectorAll('#section-bookings .tab-row .tab').forEach(t=>t.classList.remove('active'));
  if (btn) btn.classList.add('active');
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
  bookings.push(newB);
  const autoAssigned = _maybeAutoAssignPreferredCleaner(newB, 'booking-create');
  _normalizeBookingCleanState();
  save();
  if (autoAssigned) if (typeof saveCleansToCloud === 'function') saveCleansToCloud(cleans).catch(() => {});
  closeModal(); render();
  if (typeof saveBookingToCloud === 'function') {
    saveBookingToCloud(newB).then(() => {
      console.log('[StayOps] Booking saved to Supabase');
    }).catch(e => {
      console.error('[StayOps] Failed to save booking to Supabase', e);
      showBanner('⚠ Booking saved locally but cloud sync failed: ' + (e.message || 'unknown error'), 'warn');
    });
  }
  showBanner('✅ Booking added', 'ok');
}
function autoFillCleanDate() {
  const bookingIdRaw = document.getElementById('clean-booking-select').value;
  if (!bookingIdRaw) return;
  const booking = bookings.find(b => String(b.id) === String(bookingIdRaw) || (b._cloudId && String(b._cloudId) === String(bookingIdRaw)));
  if (booking && booking.checkout) {
    document.getElementById('clean-date').value = booking.checkout;
  }
}

function loadCleanerLearning() {
  return loadJSON(lsKey('cleaner-learning')) || { lastCleanerId: null, frequency: {} };
}

function saveCleanerLearning(state) {
  localStorage.setItem(lsKey('cleaner-learning'), JSON.stringify(state || { lastCleanerId: null, frequency: {} }));
}

function updateCleanerLearning(cleanerObj, assignmentSource) {
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
  // Keep existing suggestion behavior that relies on the cleaner name.
  localStorage.setItem(lsKey('last-cleaner'), cleanerObj.name || '');
}

function addClean() {
  if (!_acquireLock(_actionLocks, 'addClean')) return;
  const bookingIdRaw = document.getElementById('clean-booking-select').value;
  const selectEl = document.getElementById('clean-name-select');
  const cleaner = selectEl ? selectEl.value.trim() : document.getElementById('clean-name').value.trim();
  const date=document.getElementById('clean-date').value;
  if (!bookingIdRaw||!cleaner||!date){showBanner('⚠ Please fill all fields','warn'); _releaseLock(_actionLocks, 'addClean'); return;}
  localStorage.setItem(lsKey('last-cleaner'), cleaner);
  const booking = bookings.find(b => String(b.id) === String(bookingIdRaw) || (b._cloudId && String(b._cloudId) === String(bookingIdRaw)));
  if (!booking) { showBanner('⚠ Booking not found — it may have been deleted', 'warn'); _releaseLock(_actionLocks, 'addClean'); return; }
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
  if (cleanerObj) _recordCleanerAssignmentUsage(cleanerObj);
  save();
  if (typeof saveCleansToCloud === 'function') saveCleansToCloud(cleans).catch(() => {});
  showBanner('✅ Clean scheduled for ' + newClean.date, 'ok');
  // Prompt to send SMS — only mark notified if user confirms
  showAppModal({ title: '💬 Send SMS?', msg: `Notify ${cleaner} about this booking now?`, confirmText: 'Send SMS', cancelText: 'Later' })
    .then(ok => {
      if (ok) {
        newClean.notified = true;
        save();
        cleanFilter = 'upcoming';
        document.querySelectorAll('#clean-schedule-card .tab-row .tab').forEach((t,i) => t.classList.toggle('active', i===0));
        renderCleaning();
        renderBookings();
        openNotifyModal(newClean.id);
      } else {
        cleanFilter = 'upcoming';
        document.querySelectorAll('#clean-schedule-card .tab-row .tab').forEach((t,i) => t.classList.toggle('active', i===0));
        renderCleaning();
        renderBookings();
      }
    })
    .catch(() => {})
    .finally(() => _releaseLock(_actionLocks, 'addClean'));
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
      document.querySelectorAll('#clean-schedule-card .tab-row .tab').forEach((t,i)=>{
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
  const b = bookings.find(b => b._cloudId === id || String(b.id) === String(id));
  const _okBk = await showAppModal({ title: 'Delete Booking', msg: 'Remove this booking? This cannot be undone.', confirmText: 'Delete', confirmColor: 'var(--red)' }); if (!_okBk) return;
  const deletedBooking = bookings.find(b => b._cloudId === id || String(b.id) === String(id));

  // Plan (Bug 2): capture linked cleans/notes first, then after save() explicitly delete
  // their Supabase rows by _cloudId or local_id+user_id to prevent orphan re-hydration.
  const orphanedCleans = cleans.filter(c => String(c.bookingId) === String(id) || (deletedBooking && c.guestName === deletedBooking.name));
  const orphanedNotes = notes.filter(n => String(n.bookingId) === String(id) || (deletedBooking && n.guestName === deletedBooking.name));

  bookings=bookings.filter(b=>b.id!==id);
  cleans=cleans.filter(c=>String(c.bookingId)!==String(id) && !(deletedBooking && c.guestName===deletedBooking.name));
  notes=notes.filter(n=>String(n.bookingId)!==String(id) && !(deletedBooking && n.guestName===deletedBooking.name));
  save();

  if (deletedBooking && typeof deleteBookingFromCloud === 'function') deleteBookingFromCloud(deletedBooking).catch(e => console.warn('[StayOps] Failed to delete booking from cloud', e));

  const user = typeof getCurrentSupabaseUser === 'function' ? await getCurrentSupabaseUser() : null;
  if (user && window._sb) {
    if (orphanedCleans.length) {
      const cleanIds = orphanedCleans.map(c => c._cloudId || String(c.id));
      console.log('[StayOps] Deleting orphaned cleans from Supabase:', cleanIds);
      for (const c of orphanedCleans) {
        try {
          if (c._cloudId) {
            await window._sb.from('cleans').delete().eq('id', c._cloudId);
          } else {
            await window._sb.from('cleans').delete()
              .eq('user_id', user.id)
              .eq('local_id', String(c.id));
          }
        } catch (e) { console.warn('[StayOps] Failed to delete orphaned clean from cloud', e); }
      }
    }

    if (orphanedNotes.length) {
      const noteIds = orphanedNotes.map(n => n._cloudId || String(n.id));
      console.log('[StayOps] Deleting orphaned notes from Supabase:', noteIds);
      for (const n of orphanedNotes) {
        try {
          if (n._cloudId) {
            await window._sb.from('notes').delete().eq('id', n._cloudId);
          } else {
            await window._sb.from('notes').delete()
              .eq('user_id', user.id)
              .eq('local_id', String(n.id));
          }
        } catch (e) { console.warn('[StayOps] Failed to delete orphaned note from cloud', e); }
      }
    }
  }

  closeDetailModal(); render();
  showBanner('✅ Booking deleted', 'ok');
}

// ── CSV IMPORT ────────────────────────────────────────────────────────────
function importAirbnbCSV(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async function(e) {
    const lines = e.target.result.trim().split('\n');
    if (lines.length < 2) return;

    // Parse header row to get column indices by name
    const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().trim());
    const col = name => headers.indexOf(name);

    const iCode     = col('confirmation code');
    const iStatus   = col('status');
    const iName     = col('guest name');
    const iContact  = col('contact');
    const iAdults   = col('# of adults');
    const iChildren = col('# of children');
    const iStart    = col('start date');
    const iEnd      = col('end date');
    const iNights   = col('# of nights');
    const iEarnings = col('earnings');

    if (iName === -1 || iStart === -1) {
      document.getElementById('import-preview').textContent = '✕ This does not look like an Airbnb reservations CSV.';
      return;
    }

    const existingCodes = new Set(bookings.map(b => (b.confirmCode || b.confirmation_code || '')));
    let imported = 0, skipped = 0;

    const newBookings = [];
    lines.forEach((line, i) => {
      if (i === 0) return;
      const p = parseCSVLine(line);
      if (!p[iName] && !p[iStart]) return;

      const confirmCode = p[iCode] ? p[iCode].trim() : '';
      if (confirmCode && existingCodes.has(confirmCode)) { skipped++; return; }

      const statusRaw = (p[iStatus] || '').trim().toLowerCase();
      const status = statusRaw === 'cancelled' ? 'cancelled' : 'confirmed';
      const adults   = parseInt(p[iAdults]   || '0', 10) || 0;
      const children = parseInt(p[iChildren] || '0', 10) || 0;
      const guests   = adults + children || 1;
      const checkin  = toISO((p[iStart] || '').trim());
      const checkout = toISO((p[iEnd]   || '').trim());
      const nights   = parseInt(p[iNights] || '0', 10) || 0;
      const payout   = toNum(p[iEarnings] || '');
      const name     = (p[iName] || '').trim();
      const phone    = iContact !== -1 ? (p[iContact] || '').trim() : '';

      if (!name || !checkin) return;

      newBookings.push({
        id:           Date.now() + i,
        checkin, checkout, nights, name, guests,
        hostPayout:   payout,
        cleaningFee:  0,
        mgmtFee:      0,
        mgmtPayout:   0,
        netPayout:    payout,
        mgmtFeeRaw:   0,
        platform:     'Airbnb',
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
      const msg = skipped > 0
        ? `All ${skipped} booking${skipped!==1?'s':''} already exist — nothing new to import.`
        : 'No valid bookings found in this file.';
      document.getElementById('airbnb-import-preview').textContent = msg;
      return;
    }

    bookings.push(...newBookings);
    save();

    // Push to Supabase
    if (typeof saveBookingsToCloud === 'function') {
      try { await saveBookingsToCloud(newBookings); } catch(e) { console.warn('[Import] Cloud save failed', e); }
    }

    const msg = skipped > 0
      ? `✓ Imported ${imported} booking${imported!==1?'s':''}. Skipped ${skipped} duplicate${skipped!==1?'s':''}.`
      : `✓ Imported ${imported} booking${imported!==1?'s':''} from Airbnb.`;
    document.getElementById('airbnb-import-preview').textContent = msg;
    setTimeout(() => { closeModal(); render(); }, 1400);
  };
  reader.readAsText(file);
}

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
function switchModalTab(tab,btn){
  document.querySelectorAll('#modal .tab').forEach(t=>t.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('modal-manual').style.display=tab==='manual'?'block':'none';
  document.getElementById('modal-screenshot').style.display=tab==='screenshot'?'block':'none';
  document.getElementById('modal-import').style.display=tab==='import'?'block':'none';
}

function openQuickAddMenu() {
  document.getElementById('quick-add-overlay').classList.add('open');
  document.getElementById('quick-add-fab').classList.add('qa-open');
}

function closeQuickAddMenu() {
  document.getElementById('quick-add-overlay').classList.remove('open');
  document.getElementById('quick-add-fab').classList.remove('qa-open');
}

async function runFullRefresh() {
  const btn = document.getElementById('header-refresh-btn');
  if (btn) { btn.disabled = true; btn.textContent = '↻ Syncing…'; }

  let cloudOk = false;
  let errors = [];

  try {
    // Step 1: Pull from Supabase (primary source)
    if (typeof hydrateFromCloud === 'function') {
      try {
        await hydrateFromCloud();
        cloudOk = true;
      } catch (e) {
        console.warn('[Refresh] hydrateFromCloud failed:', e);
        errors.push('cloud sync');
      }
    }

    // Reload in-memory data from localStorage then re-render
    reloadInMemoryData();
    renderAll();

    if (errors.length) {
      showBanner('↻ Refreshed (some sources unavailable)', 'warn');
    } else {
      showBanner('✓ All data refreshed', 'ok');
    }
  } catch (e) {
    console.error('[Refresh] Unexpected error:', e);
    // Still reload from localStorage so UI is not stale
    reloadInMemoryData();
    renderAll();
    showBanner('⚠ Refresh failed — showing cached data', 'warn');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '↻ Refresh'; }
  }
}

function openPropertySettingsMenu() {
  showSection('settings');
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
  // Legacy Sheets serial number
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
function getBookingIdentityKey(booking) {
  if (!booking) return '';
  const name = String(booking.name || '').trim().toLowerCase();
  const checkin = String(booking.checkin || '').trim();
  const checkout = String(booking.checkout || '').trim();
  const confirmCode = String(booking.confirmCode || '').trim().toLowerCase();
  return [name, checkin, checkout, confirmCode].join('|');
}

function fmt(dateStr){
  if (!dateStr) return '';
  const d=new Date(dateStr+'T00:00:00');
  return d.toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric'});
}

function renderHeaderDateBadge() {
  const todayBadge = document.getElementById('todayBadge');
  if (todayBadge) {
    todayBadge.textContent = new Date().toLocaleDateString('en-AU', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    });
  }
}

// ── NOTIFY CLEANER ───────────────────────────────────────────────────────
let notifyPhone = '';
let currentNotifyCleanId = null;

function openNotifyModal(cleanId, mode = 'assign') {
  currentNotifyCleanId = cleanId;
  const c = cleans.find(c => c.id === cleanId);
  if (!c) return;
  const b = bookings.find(b => String(b.id) === String(c.bookingId))
    || bookings.find(b => _normName(b.name) === _normName(c.guestName) && String(b.checkout || '').slice(0, 10) === String(c.date || '').slice(0, 10));
  if (!b) console.warn('[StayOps] openNotifyModal: no booking found for clean', c);
  const isReminder = String(mode || '') === 'reminder';

  // Build message
  const checkinRaw = b ? (b.checkin || b.checkIn || b.startDate) : (c.checkin || '');
  const checkoutRaw = b ? (b.checkout || b.checkOut || b.endDate) : c.date;
  const guestsRaw = b ? (b.guests ?? b.numGuests ?? b.guestCount) : null;
  const checkin = checkinRaw ? fmt(checkinRaw) : 'TBC';
  const checkout = checkoutRaw ? fmt(checkoutRaw) : 'TBC';
  const guests = (guestsRaw !== null && guestsRaw !== undefined && String(guestsRaw).trim() !== '') ? guestsRaw : '?';

  // Use saved template or default
  const defaultTemplate = `Hi {cleanerFirstName}\n\nNew Booking - please see below\n\nCheck in: {checkin}\nCheck out: {checkout}\nName: {guestFirstName}\nNumber of guests: {guests}\n\nPlease let me know if you are available`;
  const reminderTemplate = `Hi {cleanerFirstName}\n\nQuick follow-up for the clean after {guestFirstName} on {checkout}.\n\nPlease let me know if you're available when you can. Thanks!`;
  const template = isReminder ? reminderTemplate : (localStorage.getItem(lsKey('sms-template')) || defaultTemplate);
  const msg = template
    .replace('{cleanerFirstName}', (c.cleaner||'').split(' ')[0])
    .replace('{cleanerName}', c.cleaner)
    .replace('{guestFirstName}', (c.guestName||'').split(' ')[0])
    .replace('{guestName}', c.guestName)
    .replace('{checkin}', checkin)
    .replace('{checkout}', checkout)
    .replace('{guests}', guests);

  document.getElementById('notify-message').value = msg;
  const modalTitle = document.getElementById('notify-modal-title');
  if (modalTitle) modalTitle.textContent = isReminder ? 'Send Reminder' : 'Notify Cleaner';
  document.getElementById('notify-clean-info').textContent = `${c.cleaner} · After ${c.guestName} · ${fmt(c.date)}`;
  // Find phone from cleaners list by name
  const cleaners = loadCleaners();
  const matchedCleaner = cleaners.find(cl => cl.name.toLowerCase() === c.cleaner.toLowerCase());
  if (matchedCleaner && matchedCleaner.phone) notifyPhone = matchedCleaner.phone;
  document.getElementById('notify-number-display').textContent = notifyPhone ? '📱 ' + notifyPhone : 'No number saved — go to Settings > Cleaning to add cleaner details';
  document.getElementById('notify-modal').classList.add('open'); document.body.style.overflow='hidden';
}

function sendCleanerReminder(cleanId) {
  openNotifyModal(cleanId, 'reminder');
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
  document.querySelectorAll('#clean-schedule-card .tab-row .tab').forEach((t,i) => t.classList.toggle('active', i===0));
  renderCleaning();
  populateSelects();
}

function closeNotifyModal() {
  document.getElementById('notify-modal').classList.remove('open'); _checkModalsClosed();
}

// ── SETTINGS ─────────────────────────────────────────────────────────────
function chooseGoogleAccount() {}

function syncToSheet() {}


// ── CLEAR CACHE (SAFE) ───────────────────────────────────────────────────────
function clearCacheAndResync() {
  showAppModal({
    title: '🗑 Clear booking cache?',
    msg: 'This will clear synced bookings, cleans, notes and expenses, then re-pull from Legacy Sheets.\n\nYour inventory, cleaners, maintenance records and all settings will be kept.',
    confirmText: 'Clear & Re-sync',
    cancelText: 'Cancel'
  }).then(ok => {
    if (!ok) return;
    // Only clear the data that comes from the sheet — preserve everything else
    ['gh-bookings','gh-cleans','gh-notes','gh-expenses','gh-last-sync'].map(k => lsKey(k.replace('gh-',''))).forEach(k => localStorage.removeItem(k));
    location.reload();
  });
}

// ── SAVE SMS TEMPLATE ────────────────────────────────────────────────────────
function saveSMSTemplate() {
  const val = document.getElementById('settings-sms-template');
  if (!val) return;
  localStorage.setItem(lsKey('sms-template'), val.value);
  if (typeof saveAppConfigToCloud === 'function') {
    saveAppConfigToCloud({ sms_template: val.value }).catch(() => {});
  }
  showBanner('✓ SMS template saved', 'ok');
}

// ── SAVE CLEANING FEE ────────────────────────────────────────────────────────
function saveCleaningFee(bookingId) {
  const b = bookings.find(b => String(b.id) === String(bookingId) || (b._cloudId && String(b._cloudId) === String(bookingId)));
  const input = document.getElementById('actual-clean-fee');
  if (!b || !input) return;
  b.cleaningFee = Number(input.value) || 0;
  save();
  if (typeof saveBookingToCloud === 'function') saveBookingToCloud(b).catch(() => {});
  showBanner('✓ Cleaning fee saved & synced', 'ok');
}

function saveBankDetails() {
  ['name','bsb','acc','bank'].forEach(k => {
    const val = document.getElementById('inv-bank-'+k)?.value?.trim();
    if (val !== undefined) localStorage.setItem(lsKey('bank-')+k, val);
  });
  const el = document.getElementById('inv-bank-confirm');
  el.style.display='block'; setTimeout(()=>el.style.display='none',2000);
  showBanner('✓ Settings saved: bank details', 'ok');
}

function loadClients() { return JSON.parse(localStorage.getItem(lsKey('clients'))||'[]'); }
function saveClients(c) { localStorage.setItem(lsKey('clients'), JSON.stringify(c)); }

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
  if (!key) { showBanner('⚠ Could not save: Gemini key is empty', 'warn'); return; }
  localStorage.setItem('gh-gemini-key', key);
  const el = document.getElementById('gemini-key-confirm');
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 2000);
  showBanner('✓ Settings saved: Gemini key', 'ok');
}
function saveApiKey() {
  const key = document.getElementById('settings-api-key').value.trim();
  if (!key) { showBanner('⚠ Could not save: API key is empty', 'warn'); return; }
  localStorage.setItem('gh-api-key', key);
  const el = document.getElementById('api-key-confirm');
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 2000);
  showBanner('✓ Settings saved: API key', 'ok');
  // Sync to Supabase
  if (typeof savePropertyToCloud === 'function') {
    const cfg = (typeof getActivePropertyConfig === 'function') ? getActivePropertyConfig() : {};
    savePropertyToCloud(cfg).catch(() => {});
  }
}
function getApiKey() {
  return localStorage.getItem('gh-api-key') || '';
}

// ── HOST IDENTITY ─────────────────────────────────────────────────────────────
const HOST_PROFILE_KEY = 'gh-host-profile';

function getHostProfile() {
  try {
    const raw = localStorage.getItem(HOST_PROFILE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || typeof p !== 'object') return null;
    if (!p.hostId) return null;
    return p;
  } catch (e) {
    return null;
  }
}

function saveHostProfile(profile) {
  if (!profile || !profile.hostId) return;
  localStorage.setItem(HOST_PROFILE_KEY, JSON.stringify(profile));
}

async function ensureHostIdentityAndRestore() {
  if (isCleanerMode()) return;
  let host = getHostProfile();

  // One-time migration: push inv-* localStorage to host_config in Supabase.
  // Owner fields (owner_name, owner_email) are NOT used here.
  // Host and owner are distinct identities in StayOps.
  const migrationKey = 'gh-host-migrated-v2';
  if (!localStorage.getItem(migrationKey) && typeof saveHostConfigToSupabase === 'function') {
    const ls = k => localStorage.getItem(lsKey(k)) || '';
    const invName = ls('inv-name');
    if (invName) {
      const hostId = 'host-' + invName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) + '-' + Date.now().toString().slice(-6);
      const migrated = {
        hostId,
        name:    invName,
        company: ls('inv-company'),
        abn:     ls('inv-abn'),
        acn:     ls('inv-acn'),
        email:   ls('inv-email'),
        address: ls('inv-address'),
        createdAt: new Date().toISOString(),
      };
      saveHostProfile(migrated);
      saveHostConfigToSupabase(migrated).then(() => {
        localStorage.setItem(migrationKey, '1');
        console.log('[StayOps] Host identity migrated to Supabase');
      }).catch(e => console.warn('[StayOps] Host migration failed', e));
      host = migrated;
    } else {
      localStorage.setItem(migrationKey, '1');
    }
  }

  // Restore host profile from Supabase if localStorage is empty (private mode / new device).
  if (!host && typeof loadHostConfigFromSupabase === 'function') {
    try {
      const cloudHost = await loadHostConfigFromSupabase();
      if (cloudHost && cloudHost.hostId) {
        saveHostProfile(cloudHost);
        host = cloudHost;
        console.log('[StayOps] Restored host profile from Supabase (private mode / new device)');
      }
    } catch (e) {
      console.warn('[StayOps] Cloud host profile restore failed', e);
    }
  }

  // Beginner-friendly prompt once, non-blocking if skipped.
  if (!host) {
    const entered = await showAppModal({
      title: 'Welcome',
      msg: "What should we call you? We'll use this to restore your non-sensitive settings on this device.",
      confirmText: 'Continue',
      cancelText: 'Skip',
      hasInput: true,
      inputPlaceholder: 'Your name',
      inputType: 'text'
    });
    if (entered && String(entered).trim()) {
      const name = String(entered).trim();
      const hostId = ('host-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) + '-' + Date.now().toString().slice(-6)).slice(0, 48);
      host = { hostId, name, email: '', createdAt: new Date().toISOString() };
      saveHostProfile(host);
      if (typeof saveHostConfigToSupabase === 'function') {
        saveHostConfigToSupabase(host).catch(e => console.warn('[StayOps] host config sync failed', e));
      }
      showBanner('Host profile created', 'ok');
    }
  }

  renderHostProfileRow();
}

async function manageHostIdentity() {
  // Legacy entry point — route to the new panel
  openSettingsPanel('host-profile');
}

function populateHostProfilePanel() {
  const existing = getHostProfile() || {};
  const cfg = getActivePropertyConfig();
  // Pre-populate: existing host profile > active property config > legacy inv-* keys
  const _inv = _getInvoiceIdentity();
  const _v = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
  _v('host-profile-name',    existing.name    || _inv.name);
  _v('host-profile-company', existing.company || _inv.company);
  _v('host-profile-abn',     existing.abn     || _inv.abn);
  _v('host-profile-acn',     existing.acn     || _inv.acn);
  _v('host-profile-email',   existing.email   || _inv.email);
  _v('host-profile-phone',   existing.phone   || '');
  _v('host-profile-address', existing.address || _inv.address);
}

async function saveHostProfilePanel() {
  const _g = id => (document.getElementById(id) || {}).value?.trim() || '';
  const name    = _g('host-profile-name');
  if (!name) { showBanner('⚠ Name is required', 'warn'); return; }
  const profile = {
    ...(getHostProfile() || {}),
    name,
    company: _g('host-profile-company'),
    abn:     _g('host-profile-abn'),
    acn:     _g('host-profile-acn'),
    email:   _g('host-profile-email'),
    phone:   _g('host-profile-phone'),
    address: _g('host-profile-address'),
    updatedAt: new Date().toISOString(),
  };
  if (!profile.hostId) {
    profile.hostId = 'host-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) + '-' + Date.now().toString().slice(-6);
    profile.createdAt = profile.updatedAt;
  }
  // Mirror to invoice-detail keys for backward compat
  if (profile.name)    localStorage.setItem(lsKey('inv-name'),    profile.name);
  if (profile.company) localStorage.setItem(lsKey('inv-company'), profile.company);
  if (profile.abn)     localStorage.setItem(lsKey('inv-abn'),     profile.abn);
  if (profile.acn)     localStorage.setItem(lsKey('inv-acn'),     profile.acn);
  if (profile.email)   localStorage.setItem(lsKey('inv-email'),   profile.email);
  if (profile.address) localStorage.setItem(lsKey('inv-address'), profile.address);

  saveHostProfile(profile);
  renderHostProfileRow();

  // Sync to Supabase
  if (typeof saveHostConfigToSupabase === 'function') {
    saveHostConfigToSupabase(profile).catch(e => console.warn('[StayOps] host config sync failed', e));
  }

  showBanner('✓ Host profile saved', 'ok');
}

function renderHostProfileRow() {
  const row = document.getElementById('host-profile-row');
  if (!row) return;
  const host = getHostProfile();
  if (!host || !host.name) {
    row.textContent = 'Name, company, ABN, contact';
    return;
  }
  const bits = [host.name];
  if (host.company) bits.push(host.company);
  if (host.abn) bits.push('ABN ' + host.abn);
  row.textContent = bits.join(' · ');
}

// ── PROPERTY SWITCHER (header) ─────────────────────────────────
let _propSwitcherOpenedAt = 0;
function openPropertySwitcherSheet() {
  console.log('[StayOps] openPropertySwitcherSheet called');
  const props = typeof getAllProperties === 'function' ? getAllProperties() : [];
  const activeId = getActivePropertyId();
  const list = document.getElementById('property-switcher-sheet-list');
  if (list) {
    const propRows = props.map(p => {
      const isActive = !portfolioMode && p.propertyId === activeId;
      return '<div onclick="switchPropertyFromSheet(\'' + escHtml(p.propertyId) + '\')" style="display:flex;align-items:center;justify-content:space-between;padding:14px 4px;border-bottom:1px solid var(--border);cursor:pointer">' +
        '<div style="font-weight:' + (isActive ? '700' : '400') + ';font-size:15px;color:var(--text,#1A1A1A)">' + escHtml(p.name || p.propertyId) + '</div>' +
        (isActive ? '<div style="background:var(--forest,#1E3A2F);color:#fff;font-size:11px;font-weight:700;letter-spacing:0.4px;padding:4px 10px;border-radius:20px">✓ Active</div>' : '') +
        '</div>';
    }).join('');
    const addRow = '<div onclick="closePropertySwitcherSheet();openAddPropertySetup()" style="display:flex;align-items:center;gap:12px;padding:14px 4px;cursor:pointer;color:var(--forest)">' +
      '<div style="width:28px;height:28px;border-radius:50%;background:var(--forest);color:white;display:flex;align-items:center;justify-content:center;font-size:18px">+</div>' +
      '<div style="font-weight:600;font-size:15px">Add Property</div></div>';
    const allPropsRow = props.length > 1
      ? '<div onclick="switchToPortfolioFromSheet()" style="display:flex;align-items:center;justify-content:space-between;padding:14px 4px;border-bottom:1px solid var(--border);cursor:pointer">' +
          '<div style="font-weight:' + (portfolioMode ? '700' : '400') + ';font-size:15px;color:var(--text,#1A1A1A)">All Properties</div>' +
          (portfolioMode ? '<div style="background:var(--forest,#1E3A2F);color:#fff;font-size:11px;font-weight:700;letter-spacing:0.4px;padding:4px 10px;border-radius:20px">✓ Active</div>' : '') +
        '</div>'
      : '';
    list.innerHTML = allPropsRow + propRows + addRow;
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

function closePropertySwitcherSheet() {
  // Guard against ghost-click: on mobile, a tap on the header button can fire
  // a second click event on the backdrop that now sits under the finger,
  // immediately closing the sheet. Ignore close requests within 350ms of open.
  if (Date.now() - _propSwitcherOpenedAt < 350) return;
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
  closePropertySwitcherSheet();
  sessionStorage.setItem('stayops-portfolio-mode', 'false');
  if (typeof switchActiveProperty === 'function') switchActiveProperty(id);
}
function saveInvoiceDetails() {
  ['name','company','abn','acn','email','address'].forEach(k => {
    const val = document.getElementById('inv-'+k)?.value?.trim();
    if (val !== undefined) localStorage.setItem(lsKey('inv-')+k, val);
  });
  const el = document.getElementById('inv-save-confirm');
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 2000);
  showBanner('✓ Settings saved: invoice details', 'ok');
}
function loadCleaners() {
  return loadJSON(lsKey('cleaners'));
}
function saveCleaners(list) {
  localStorage.setItem(lsKey('cleaners'), JSON.stringify(list));
  if (typeof saveCleanersToCloud === 'function') {
    saveCleanersToCloud(list).catch(e => console.warn('[StayOps] Cloud cleaner sync failed', e));
  }
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
  const cleaners = loadCleaners().filter(c => isCleanerPerson(c));
  const sel = document.getElementById('clean-name');
  if (!sel) return;
  if (cleaners.length > 0) {
    const lastCleaner = localStorage.getItem(lsKey('last-cleaner')) || '';
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

// ── PROPERTY HUB NAVIGATION ───────────────────────────────────────────────

let propFilter = 'hub';

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

    const propIdJs = JSON.stringify(p.propertyId);
    return '<div onclick="switchPropertyFromSheet(' + propIdJs + ')" ' +
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
  if (propFilter === 'maintenance') { renderMaintenance(); populateContractorSelect(); }
  if (propFilter === 'inventory')   renderInventory();
}

/** UI-only placeholder — Access & Rules screen to be built in a later step */
function openPropertyAccessRules() {
  showBanner('Access & Rules — coming soon', 'info');
}

/**
 * Open Property Details from the Property hub.
 * Passes returnSection='property' so the back button returns to Property, not Settings.
 */
function openPropertyDetailsFromHub() {
  openSettingsCat('property', 'property');
}

/**
 * Open Owner Reports panel from the Property hub.
 * Passes returnSection='property' so the back button returns to Property, not Settings.
 */
function openOwnerReportFromHub() {
  openSettingsPanel('owner-report', 'property');
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
// Tracks per-month collapse state. null = defaults (newest open, rest closed).
// A Set of month-label strings that are currently COLLAPSED.
let _expMonthCollapsed = null;

function toggleExpenseList() {
  // Expand/collapse all months
  if (!_expMonthCollapsed) {
    // Default state (newest open) — collapse all
    _expMonthCollapsed = new Set(_allExpenseMonthKeys());
    expenseListExpanded = false;
  } else if (_expMonthCollapsed.size > 0) {
    // Some collapsed — expand all
    _expMonthCollapsed = new Set();
    expenseListExpanded = true;
  } else {
    // All expanded — reset to default
    _expMonthCollapsed = null;
    expenseListExpanded = false;
  }
  renderExpenses();
}

/** Toggle a single month section open/closed. */
function toggleExpenseMonth(key) {
  if (!_expMonthCollapsed) {
    // First explicit toggle — initialise from default state
    const allKeys = _allExpenseMonthKeys();
    _expMonthCollapsed = new Set(allKeys.slice(1)); // all except newest are closed
  }
  if (_expMonthCollapsed.has(key)) {
    _expMonthCollapsed.delete(key);
  } else {
    _expMonthCollapsed.add(key);
  }
  renderExpenses();
}

/** Returns all month keys (newest first) derived from the current expenses array. */
function _allExpenseMonthKeys() {
  const sorted = [...expenses].sort((a, b) => {
    const da = a.date || ''; const db = b.date || '';
    return db > da ? 1 : db < da ? -1 : 0;
  });
  const keys = [];
  sorted.forEach(e => {
    const key = new Date(e.date || Date.now()).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
    if (!keys.includes(key)) keys.push(key);
  });
  return keys;
}

function clearExpenseFilters() {
  const s = document.getElementById('expense-search'); if (s) s.value = '';
  const c = document.getElementById('expense-filter-cat'); if (c) c.value = '';
  const f = document.getElementById('expense-filter-from'); if (f) f.value = '';
  const t = document.getElementById('expense-filter-to'); if (t) t.value = '';
  expenseListExpanded = false;
  _expMonthCollapsed = null; // reset to defaults on filter clear
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

  const prompt = `You are an accountant reviewing Airbnb rental property expenses for ${getCurrentPropertyName()}.

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
  return JSON.parse(localStorage.getItem(lsKey('ai-ignore')) || '[]');
}
function saveAIIgnoreList(list) {
  localStorage.setItem(lsKey('ai-ignore'), JSON.stringify(list));
  if (typeof saveAppConfigToCloud === 'function') saveAppConfigToCloud({ ai_ignore: list }).catch(() => {});
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
    <button onclick="openSettingsCat('advanced');openSettingsPanel('ai-ignore');"
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

  const expRow = e => {
    const isRefund = Number(e.amount) < 0;
    const amtColor = isRefund ? '#27AE60' : '#C0392B';
    const amtLabel = isRefund
      ? `<span style="font-size:10px;font-weight:600;color:#27AE60;letter-spacing:0.2px">refund</span>`
      : '';
    // Receipt badge — stopPropagation so link tap doesn't also fire row tap
    const receiptBadge = e.driveLink
      ? `<a href="${e.driveLink}" target="_blank" onclick="event.stopPropagation()" style="font-size:11px;color:var(--moss);font-weight:600;text-decoration:none">📎 receipt</a>`
      : e.awaitingReceipt
        ? `<span style="font-size:11px;color:var(--amber)">⚠ awaiting</span>`
        : (!e.receiptType || e.receiptType === 'missing')
          ? `<span style="font-size:11px;color:var(--red)">✕ no receipt</span>`
          : `<span style="font-size:11px;color:var(--moss)">✓ ${e.receiptType === 'e-receipt' ? 'e-receipt' : 'printed'}</span>`;
    return `
    <div class="expense-item" data-expense-id="${e.id}"
         onclick="openExpenseView(${e.id})"
         style="display:flex;justify-content:space-between;align-items:flex-start;
                padding:9px 0;border-bottom:1px solid var(--warm);
                cursor:pointer;-webkit-tap-highlight-color:transparent;
                -webkit-user-select:none;user-select:none">
      <div style="flex:1;min-width:0;padding-right:12px">
        <div style="display:flex;align-items:baseline;gap:6px">
          <span style="font-weight:600;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px;display:inline-block">${e.merchant||'Unknown'}</span>
          ${e.description ? `<span style="font-size:12px;color:var(--text-soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100px;display:inline-block">${escHtml(e.description)}</span>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:5px;margin-top:3px;flex-wrap:wrap">
          <span style="font-size:10px;color:var(--text-soft)">${e.category||''}</span>
          <span style="font-size:11px;color:var(--text-soft)">· ${fmt(e.date)}</span>
          ${receiptBadge}
        </div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:5px;flex-shrink:0">
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:1px">
          <span style="font-family:'DM Serif Display',serif;font-size:15px;font-weight:700;color:${amtColor}">$${Math.abs(Number(e.amount)).toFixed(2)}</span>
          ${amtLabel}
        </div>
        <div style="display:flex;gap:4px">
          <button onclick="event.stopPropagation();openExpenseEdit(${e.id})"
                  style="font-size:11px;color:var(--forest);background:none;border:none;
                         padding:2px 0;cursor:pointer;font-family:'DM Sans',sans-serif;font-weight:600;
                         text-decoration:underline;text-underline-offset:2px">Edit</button>
          <button onclick="event.stopPropagation();deleteExpense(${e.id})"
                  style="font-size:12px;color:var(--red);background:none;border:none;
                         cursor:pointer;padding:2px 4px;font-family:'DM Sans',sans-serif">✕</button>
        </div>
      </div>
    </div>`;
  };

  // ── Group ALL filtered expenses by calendar month (collapse handled per-month) ──
  const grouped = filtered.reduce((acc, e) => {
    const d = new Date(e.date || Date.now());
    const key = d.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
    if (!acc[key]) acc[key] = { items: [], total: 0 };
    acc[key].items.push(e);
    acc[key].total += Number(e.amount) || 0;
    return acc;
  }, {});

  const monthKeys = Object.keys(grouped); // newest-first from sort above

  listEl.innerHTML = monthKeys.map((monthLabel, idx) => {
    const { items, total } = grouped[monthLabel];
    const count = items.length;
    const monthTotal = total.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    // Default (null): newest month open, all others closed; filter mode: all open
    const collapsed = isFiltering ? false
      : _expMonthCollapsed ? _expMonthCollapsed.has(monthLabel)
      : idx > 0;
    const safeKey = monthLabel.replace(/[^a-zA-Z0-9]/g, '_');
    const chevron = collapsed ? '›' : '∨';
    const escapedLabel = monthLabel.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `
    <div class="exp-month-group" style="margin-bottom:4px">
      <div onclick="toggleExpenseMonth('${escapedLabel}')"
           style="display:flex;justify-content:space-between;align-items:center;
                  padding:11px 0 10px;border-bottom:2px solid var(--warm);
                  cursor:pointer;-webkit-tap-highlight-color:transparent;user-select:none">
        <div style="display:flex;align-items:baseline;gap:0">
          <span style="font-size:15px;font-weight:700;color:var(--text)">${escHtml(monthLabel)}</span>
          <span style="font-size:11px;font-weight:400;color:var(--text-soft);margin-left:7px">${count} expense${count !== 1 ? 's' : ''}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-family:'DM Serif Display',serif;font-size:16px;color:var(--forest)">$${monthTotal}</span>
          <span style="font-size:16px;color:#C7C7CC;font-weight:300;width:14px;text-align:center">${chevron}</span>
        </div>
      </div>
      <div id="exp-month-${safeKey}" style="display:${collapsed ? 'none' : 'block'}">
        ${items.map(expRow).join('')}
      </div>
    </div>`;
  }).join('');

  animateList('#expenses-list');
  setTimeout(attachLongPress, 60);

  // Show/hide expand-all toggle (repurposes existing expenses-show-more)
  const sm = document.getElementById('expenses-show-more');
  const tb = document.getElementById('expenses-toggle-btn');
  if (sm) {
    const hasMultipleMonths = monthKeys.length > 1;
    sm.style.display = (!isFiltering && hasMultipleMonths) ? 'block' : 'none';
    if (tb) {
      const allExpanded = _expMonthCollapsed !== null && _expMonthCollapsed.size === 0;
      tb.textContent = allExpanded ? 'Collapse months ↑' : 'Expand all months ↓';
    }
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
  // Sync to Supabase (non-blocking)
  if (typeof saveExpenseToCloud === 'function') saveExpenseToCloud(exp).catch(() => {});

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
    // Close the add form and scroll receipts into view
    closeExpenseAddForm();
    renderExpenses();
    const receiptsCard = document.querySelector('#finance-expenses-view .card:last-of-type');
    if (receiptsCard) receiptsCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!exp.photo) showBanner('✓ Expense saved', 'ok');
    // receipt handled separately via Supabase Storage
    else showBanner('⟳ Uploading receipt...', 'info');
  }
  return exp;
}

async function saveExpenseToDriveAndSheet(exp) {
  // ── Upload receipt to Supabase Storage ──────────────────────────────────────
  let driveLink = null;
  if (exp.photo) {
    try {
      showBanner('⟳ Uploading receipt...', 'info');
      const imgBlob = await receiptImageToPDF(exp);
      const fileName = generateReceiptFileName(exp);
      const file = new File([imgBlob], fileName, { type: 'application/pdf' });
      if (typeof uploadReceiptToStorage === 'function') {
        const url = await uploadReceiptToStorage(file, exp.id);
        if (url) {
          driveLink = url;
          const saved = expenses.find(e => e.id === exp.id);
          if (saved) {
            saved.driveLink = driveLink;
            savePropertyData();
            renderExpenses();
            if (typeof saveExpenseToCloud === 'function') saveExpenseToCloud(saved).catch(() => {});
          }
          showBanner('✓ Receipt uploaded', 'ok');
        } else {
          showBanner('⚠ Receipt upload failed', 'warn');
        }
      }
    } catch(e) {
      showBanner('⚠ Receipt upload failed: ' + e.message, 'warn');
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

async function deleteExpense(id) {
  const ok = await showAppModal({ title: 'Delete Expense', msg: 'Remove this expense? This cannot be undone.', confirmText: 'Delete', confirmColor: 'var(--red)' });
  if (!ok) return;
  const exp = expenses.find(e => String(e.id) === String(id));
  expenses = expenses.filter(e => String(e.id) !== String(id));
  savePropertyData();
  renderExpenses();
  showBanner('✓ Expense deleted', 'ok');
  // Sync deletion to Supabase (non-blocking)
  if (exp && typeof deleteExpenseFromCloud === 'function') deleteExpenseFromCloud(exp).catch(() => {});
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
  const removed = maintenance.find(m => m.id === id);
  maintenance = maintenance.filter(m => m.id !== id);
  savePropertyData();
  renderMaintenance();
  if (removed && typeof deleteMaintenanceFromCloud === 'function') deleteMaintenanceFromCloud(removed).catch(() => {});
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
  document.getElementById('ee-receipt-label').textContent = e && e.driveLink ? 'Upload a replacement receipt' : 'Upload receipt photo';
}
function openExpenseView(id) {
  const e = expenses.find(x => x.id === id);
  if (!e) return;
  const isRefund   = Number(e.amount) < 0;
  const amtColor   = isRefund ? '#27AE60' : '#C0392B';
  const amtDisplay = (isRefund ? '−' : '') + '$' + Math.abs(Number(e.amount)).toFixed(2);

  // ── Receipt action block ────────────────────────────────────────────────────
  let receiptBlock;
  if (e.driveLink) {
    receiptBlock = `
      <a href="${e.driveLink}" target="_blank"
         style="display:flex;align-items:center;justify-content:center;gap:8px;
                width:100%;padding:11px;box-sizing:border-box;
                background:var(--mist);border:1.5px solid var(--moss);border-radius:10px;
                color:var(--moss);font-weight:600;font-size:13px;text-decoration:none;
                font-family:'DM Sans',sans-serif">
        📎 View Receipt
      </a>`;
  } else if (e.awaitingReceipt) {
    receiptBlock = `<div style="font-size:13px;color:var(--amber);padding:4px 0">⚠ Receipt awaiting upload</div>`;
  } else if (!e.receiptType || e.receiptType === 'missing') {
    receiptBlock = `<div style="font-size:13px;color:var(--red);padding:4px 0">✕ No receipt on file</div>`;
  } else {
    receiptBlock = `<div style="font-size:13px;color:var(--moss);padding:4px 0">✓ Receipt on file (${e.receiptType === 'e-receipt' ? 'e-receipt' : 'printed'})</div>`;
  }

  document.getElementById('detail-content').innerHTML = `
    <!-- ── Header: merchant + amount ── -->
    <div style="margin-bottom:16px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
        <div style="min-width:0;flex:1">
          <div style="font-family:'DM Serif Display',serif;font-size:24px;line-height:1.15;
                      word-break:break-word">${escHtml(e.merchant||'Unknown')}</div>
          ${e.description ? `<div style="font-size:13px;color:var(--text-soft);margin-top:4px">${escHtml(e.description)}</div>` : ''}
        </div>
        <div style="flex-shrink:0;text-align:right">
          <div style="font-family:'DM Serif Display',serif;font-size:26px;font-weight:700;
                      color:${amtColor};line-height:1">${amtDisplay}</div>
          ${isRefund ? `<div style="font-size:10px;font-weight:600;color:#27AE60;letter-spacing:0.3px;margin-top:2px;text-transform:uppercase">Refund</div>` : ''}
        </div>
      </div>
    </div>

    <!-- ── Supporting details ── -->
    <div class="card" style="margin-bottom:14px">
      <div class="detail-row">
        <span class="detail-label">Date</span>
        <span class="detail-val">${fmt(e.date)}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Category</span>
        <span class="detail-val">${escHtml(e.category||'—')}</span>
      </div>
      <div class="detail-row" style="${!e.receiptNum ? 'border-bottom:none' : ''}">
        <span class="detail-label">Receipt type</span>
        <span class="detail-val">${e.receiptType ? (e.receiptType === 'e-receipt' ? 'e-Receipt' : e.receiptType.charAt(0).toUpperCase() + e.receiptType.slice(1)) : '—'}</span>
      </div>
      ${e.receiptNum ? `
      <div class="detail-row" style="border-bottom:none">
        <span class="detail-label">Receipt #</span>
        <span class="detail-val">${escHtml(String(e.receiptNum))}</span>
      </div>` : ''}
    </div>

    <!-- ── Receipt access ── -->
    <div style="margin-bottom:20px">${receiptBlock}</div>

    <!-- ── Primary action ── -->
    <button class="btn-primary" style="width:100%;margin-bottom:8px"
            onclick="closeDetailModal();openExpenseEdit(${e.id})">✏️ Edit Expense</button>

    <!-- ── Destructive action (secondary) ── -->
    <button class="btn-secondary" style="width:100%;margin-bottom:8px;background:#FDECEA;color:var(--red);border-color:#FDECEA"
            onclick="closeDetailModal();deleteExpense(${e.id})">🗑 Delete Expense</button>
  `;
  document.getElementById('detail-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(attachModalHandleDrag, 0);
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
    document.getElementById('ee-receipt-label').textContent = 'Upload receipt photo';
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
    const statusEl = document.getElementById('ee-upload-status');
    statusEl.style.display = 'block';
    statusEl.style.color = 'var(--text-soft)';
    statusEl.textContent = '⟳ Uploading receipt...';
    try {
      const fakeExp = Object.assign({}, e, { photo: editingExpensePhotoBase64, _mediaType: editingExpenseMediaType });
      const imgBlob = await receiptImageToPDF(fakeExp);
      const fileName = generateReceiptFileName(e);
      const file = new File([imgBlob], fileName, { type: 'application/pdf' });
      if (typeof uploadReceiptToStorage === 'function') {
        const url = await uploadReceiptToStorage(file, e.id);
        if (url) {
          e.driveLink = url;
          statusEl.style.color = 'var(--moss)';
          statusEl.textContent = '✓ Receipt uploaded';
          showBanner('✓ Receipt saved', 'ok');
        } else {
          statusEl.style.color = 'var(--red)';
          statusEl.textContent = '⚠ Upload failed';
          showBanner('⚠ Receipt upload failed', 'warn');
        }
      }
    } catch(err) {
      statusEl.style.color = 'var(--red)';
      statusEl.textContent = '⚠ Upload failed: ' + err.message;
      showBanner('⚠ Upload failed: ' + err.message, 'warn');
    }
  }

  savePropertyData();
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
let expenses    = JSON.parse(localStorage.getItem(lsKey('expenses'))    || '[]');
let maintenance = JSON.parse(localStorage.getItem(lsKey('maintenance')) || '[]');
let inventory   = JSON.parse(localStorage.getItem(lsKey('inventory'))   || '[]');

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
      bookings = allBookings.map(b => ({
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
      }));
    }

    const { data: allCleans } = await window._sb
      .from('cleans')
      .select('*')
      .eq('user_id', uid)
      .order('clean_date', { ascending: true });

    if (allCleans) {
      cleans = allCleans.map(c => ({
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
      }));
    }

    const { data: allExpenses } = await window._sb
      .from('expenses')
      .select('*')
      .eq('user_id', uid)
      .order('date', { ascending: false });

    if (allExpenses) {
      expenses = allExpenses.map(e => ({
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
      }));
    }

    _normalizeBookingCleanState();
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
    renderAll();
  } catch (e) {
    console.warn('[StayOps] enterPortfolioMode: portfolio load failed', e);
    portfolioMode = false;
    reloadInMemoryData();
    initPropertyUI();
    renderAll();
  }
}

function exitPortfolioMode() {
  portfolioMode = false;
  sessionStorage.setItem('stayops-portfolio-mode', 'false');
  reloadInMemoryData();
  initPropertyUI();
  renderAll();
}

const DEFAULT_EXPENSE_CATS = [
  'Cleaning & Garden','Maintenance & Repairs','Supplies & Consumables',
  'Utilities & Rates','Insurance','Furnishings & Equipment',
  'Renovation','Professional Services','Other'
];
function getExpenseCats() {
  const saved = localStorage.getItem(lsKey('expense-cats'));
  if (!saved) return DEFAULT_EXPENSE_CATS;
  try {
    const parsed = JSON.parse(saved);
    // Validate: must be a non-empty array of non-blank strings.
    // Falls back to defaults if cloud hydration wrote empty/malformed data.
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(c => typeof c === 'string' && c.trim())) {
      return parsed;
    }
  } catch (e) {
    // Malformed JSON — clear it so it doesn't keep failing
    localStorage.removeItem(lsKey('expense-cats'));
  }
  return DEFAULT_EXPENSE_CATS;
}
function savePropertyData() {
  localStorage.setItem(lsKey('expenses'),    JSON.stringify(expenses));
  localStorage.setItem(lsKey('maintenance'), JSON.stringify(maintenance));
  localStorage.setItem(lsKey('inventory'),   JSON.stringify(inventory));
  // Sync to Supabase (non-blocking)
  if (typeof saveInventoryToCloud === 'function') saveInventoryToCloud(inventory).catch(() => {});
  if (typeof saveMaintenanceToCloud === 'function') saveMaintenanceToCloud(maintenance).catch(() => {});
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
window.showPropertyPicker = showPropertyPicker;

async function reassignBookingProperty(gmailMessageId, newPropertyId) {
  if (!window._sb) return;
  const user = window._supabaseUser;
  if (!user) return;
  const { error } = await window._sb
    .from('bookings')
    .update({
      property_id: newPropertyId,
      property_unconfirmed: false,
      updated_at: new Date().toISOString(),
    })
    .eq('gmail_message_id', gmailMessageId)
    .eq('user_id', user.id);
  if (error) console.warn('[StayOps] reassignBookingProperty failed', error);
}
window.reassignBookingProperty = reassignBookingProperty;

async function processScanNeedsReview(data) {
  if (!data || !data.needs_review || !data.needs_review.length || typeof getAllProperties !== 'function') return;
  const props = getAllProperties().map(p => ({
    id: (window._cloudPropertyIds && window._cloudPropertyIds[p.propertyId])
        || p.supabaseId || p.propertyId,
    name: p.name || p.propertyId,
    subtitle: [p.suburb, p.state].filter(Boolean).join(', '),
  }));
  if (props.length <= 1) return;
  for (const item of data.needs_review) {
    const pickedId = await showPropertyPicker({
      guest: item.guest,
      checkin: item.checkin,
      checkout: item.checkout,
      platform: item.platform,
      properties: props,
    });
    if (pickedId) await reassignBookingProperty(item.gmail_message_id, pickedId);
  }
  if (typeof hydrateFromCloud === 'function') await hydrateFromCloud();
  reloadInMemoryData();
  renderAll();
}

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
    overlay.style.opacity = '0';
    requestAnimationFrame(() => requestAnimationFrame(() => { overlay.style.opacity = '1'; }));
  });
}

function appModalConfirm() {
  const inp = document.getElementById('app-modal-input');
  const val = inp.style.display !== 'none' ? inp.value : true;
  const overlay = document.getElementById('app-modal-overlay');
  overlay.style.opacity = '0';
  setTimeout(() => { overlay.style.display = 'none'; }, 200);
  if (_modalResolve) { _modalResolve(val); _modalResolve = null; }
}

function appModalCancel() {
  const overlay = document.getElementById('app-modal-overlay');
  overlay.style.opacity = '0';
  setTimeout(() => { overlay.style.display = 'none'; }, 200);
  if (_modalResolve) { _modalResolve(null); _modalResolve = null; }
}


// ── STORAGE VIEWER ────────────────────────────────────────────────────────
function renderStorageViewer() {
  const el = document.getElementById('storage-viewer');
  if (!el) return;
  // Only show the meaningful data keys: bookings, cleans, expenses
  const DATA_KEYS = [lsKey('bookings'), lsKey('cleans'), lsKey('expenses')];
  el.innerHTML = DATA_KEYS.map(k => {
    const val = localStorage.getItem(k);
    let items = [];
    let count = 0;
    try { items = JSON.parse(val || '[]'); count = Array.isArray(items) ? items.length : 0; } catch(e) {}
    const label = k.endsWith('bookings') ? '🏠 Bookings' : k.endsWith('cleans') ? '🧹 Cleans' : '💰 Expenses';
    return `
    <div style="padding:12px 0;border-bottom:1px solid var(--warm)">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div>
          <div style="font-weight:600;font-size:14px;color:var(--forest)">${label}</div>
          <div style="font-size:12px;color:var(--text-soft);margin-top:2px">${count} record${count!==1?'s':''} stored locally</div>
        </div>
        <button onclick="showAppModal({title:'Clear ${label}?',msg:'This removes all locally saved data. Sheet data is unaffected.',confirmText:'Clear',confirmColor:'var(--red)'}).then(ok=>{if(ok){localStorage.removeItem('${k}');renderStorageViewer();showBanner('Cleared ${label.replace(/[^a-zA-Z ]/g,'')}','ok');}})" style="font-size:12px;color:var(--red);background:#FEF2F2;border:none;border-radius:8px;padding:5px 10px;cursor:pointer;font-family:'DM Sans',sans-serif;font-weight:600">Clear</button>
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

// Cleaner mode class setup (actual hydration happens in DOMContentLoaded boot)
if (isCleanerMode()) {
  if (isCleanerAuthed()) document.body.classList.add('cleaner-mode');
  else document.body.classList.add('cleaner-pin-active');
}

// Google Drive prompts removed — receipts now use Supabase Storage
// Safety net: re-render calendar after 100ms in case layout wasn't settled
setTimeout(renderCalendar, 100);

// Auto-refresh when user returns to app — throttled to once per 5 minutes
let _lastVisibilitySync = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && hasValidPropertyConfig()) {
    const now = Date.now();
    if (now - _lastVisibilitySync > 5 * 60 * 1000) {
      _lastVisibilitySync = now;
      // Supabase is now the source — trigger a silent re-hydrate instead
      if (typeof hydrateFromCloud === 'function') hydrateFromCloud().then(() => {
        if (typeof reloadInMemoryData === 'function') reloadInMemoryData();
        if (typeof renderAll === 'function') renderAll();
      });
    }
    setTimeout(_flushPendingUiRefresh, 120);
  }
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted && hasValidPropertyConfig()) {
    if (typeof hydrateFromCloud === 'function') hydrateFromCloud().then(() => {
      if (typeof reloadInMemoryData === 'function') reloadInMemoryData();
      if (typeof renderAll === 'function') renderAll();
    });
  }
  setTimeout(_flushPendingUiRefresh, 120);
});

// Auto-refresh cleaner app when it comes back into focus or on interval
if (isCleanerMode()) {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      // Refresh from Netlify function for cleaner mode
      hydrateCleanerFromFunction().then(ok => {
        if (ok && typeof renderCleanerView === 'function') renderCleanerView();
      }).catch(() => {});
      setTimeout(_flushPendingUiRefresh, 120);
    }
  });
} else {
  // Owner app — poll Supabase every 60 seconds to catch cleaner updates.
  setInterval(() => {
    if (!document.hidden && hasValidPropertyConfig()) {
      if (typeof loadCleansFromCloud === 'function') {
        loadCleansFromCloud().then(cloudCleans => {
          if (Array.isArray(cloudCleans) && cloudCleans.length) {
            localStorage.setItem(lsKey('cleans'), JSON.stringify(cloudCleans));
            cleans = cloudCleans;  // keep in-memory in sync so renderAll() uses fresh data
            if (typeof renderAll === 'function') renderAll();
          }
        }).catch(() => {});
      }
    }
  }, 60000);
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
  // A settings cat or panel is open (not the main menu)
  if (currentSection !== 'settings') return false;
  const sm = document.getElementById('settings-menu');
  if (sm && sm.style.display !== 'none' && sm.offsetParent !== null) return false; // main menu visible = not a sub-screen
  return !!document.querySelector('[id^="settings-cat-"]:not([style*="display:none"]):not([style*="display: none"])') ||
         !!document.querySelector('[id^="settings-panel-"]:not([style*="display:none"]):not([style*="display: none"])');
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
  if (dx >= MIN_SWIPE) {
    // Go back one level: panel→cat, cat→menu
    const openPanel = document.querySelector('[id^="settings-panel-"]:not([style*="display:none"]):not([style*="display: none"])');
    if (openPanel) closeSettingsPanel();
    else closeSettingsCat();
  }
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

  const clearLP = () => clearTimeout(longPressTimer);

  // Booking items
  document.querySelectorAll('.booking-item').forEach(el => {
    if (el.dataset.lpAttached) return;
    el.dataset.lpAttached = '1';
    const rawId = el.dataset.bookingId;
    const id = isNaN(Number(rawId)) ? rawId : parseInt(rawId);
    if (!id) return;
    let startX = 0, startY = 0;
    el.addEventListener('touchstart', e => {
      if (!e.touches || e.touches.length !== 1) return;
      const t = e.touches[0];
      startX = t.clientX; startY = t.clientY;
      clearLP();
      longPressTimer = setTimeout(() => {
        const b = bookings.find(b => b._cloudId === id || String(b.id) === String(id));
        if (!b) return;
        const safeId = b._cloudId || b.id;
        showActionSheet(b.name, [
          { label: '✏️ Edit Booking',       fn: `() => showEditModal('${safeId}')` },
          { label: '📱 Notify Cleaner',     fn: `() => { showSection('cleaning'); }` },
          { label: '🗑 Delete Booking',      fn: `() => deleteBooking('${safeId}')`, destructive: true },
        ]);
      }, 550);
    }, { passive:true });
    el.addEventListener('touchend', clearLP, { passive:true });
    el.addEventListener('touchcancel', clearLP, { passive:true });
    el.addEventListener('touchmove', e => {
      if (!e.touches || !e.touches.length) { clearLP(); return; }
      const t = e.touches[0];
      if (Math.abs(t.clientX - startX) > 8 || Math.abs(t.clientY - startY) > 8) clearLP();
    }, { passive:true });
  });

  // Expense items
  document.querySelectorAll('.expense-item').forEach(el => {
    if (el.dataset.lpAttached) return;
    el.dataset.lpAttached = '1';
    const id = parseInt(el.dataset.expenseId);
    if (!id) return;
    let startX = 0, startY = 0;
    el.addEventListener('touchstart', e => {
      if (!e.touches || e.touches.length !== 1) return;
      const t = e.touches[0];
      startX = t.clientX; startY = t.clientY;
      clearLP();
      longPressTimer = setTimeout(() => {
        const eItem = expenses.find(x => x.id === id);
        if (!eItem) return;
        showActionSheet(eItem.merchant, [
          { label: '✏️ Edit Expense',  fn: `() => openExpenseEdit(${id})` },
          { label: '🗑 Delete Expense', fn: `() => deleteExpense(${id})`, destructive: true },
        ]);
      }, 550);
    }, { passive:true });
    el.addEventListener('touchend', clearLP, { passive:true });
    el.addEventListener('touchcancel', clearLP, { passive:true });
    el.addEventListener('touchmove', e => {
      if (!e.touches || !e.touches.length) { clearLP(); return; }
      const t = e.touches[0];
      if (Math.abs(t.clientX - startX) > 8 || Math.abs(t.clientY - startY) > 8) clearLP();
    }, { passive:true });
  });
}

// ── MODAL HANDLE DRAG TO DISMISS ─────────────────────────────────────────────
function attachModalHandleDrag() {
  const closeForOverlay = (overlay) => {
    if (!overlay) return;
    if (overlay.id === 'modal') closeModal();
    else if (overlay.id === 'detail-modal') closeDetailModal();
    else if (overlay.id === 'notify-modal') closeNotifyModal();
    else if (overlay.id === 'expense-edit-modal') closeExpenseEdit();
    else if (overlay.id === 'inv-edit-modal') closeInvEdit();
    else { overlay.classList.remove('open'); _checkModalsClosed(); }
  };

  document.querySelectorAll('.modal-drag-zone').forEach(zone => {
    if (zone.dataset.dragAttached) return;
    zone.dataset.dragAttached = '1';

    const modal = zone.closest('.modal');
    const overlay = zone.closest('.modal-overlay');
    if (!modal || !overlay) return;

    let startY = 0;
    let currentY = 0;
    let dragging = false;

    const beginDrag = (clientY) => {
      startY = clientY;
      currentY = 0;
      dragging = true;
      modal.style.transition = 'none';
    };

    const moveDrag = (clientY) => {
      if (!dragging) return;
      const dy = clientY - startY;
      if (dy < 0) return;
      currentY = dy;
      modal.style.transform = `translateY(${dy}px)`;
    };

    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      modal.style.transition = 'transform 0.42s cubic-bezier(0.32,0.72,0,1)';
      if (currentY > 80) {
        modal.style.transform = 'translateY(100%)';
        setTimeout(() => {
          modal.style.transform = '';
          closeForOverlay(overlay);
        }, 280);
      } else {
        modal.style.transform = 'translateY(0)';
        setTimeout(() => { modal.style.transform = ''; }, 320);
      }
    };

    zone.addEventListener('touchstart', e => beginDrag(e.touches[0].clientY), { passive: true });
    zone.addEventListener('touchmove', e => {
      moveDrag(e.touches[0].clientY);
      if (dragging) e.preventDefault();
    }, { passive: false });
    zone.addEventListener('touchend', endDrag, { passive: true });
    zone.addEventListener('touchcancel', endDrag, { passive: true });

    zone.addEventListener('pointerdown', e => beginDrag(e.clientY));
    zone.addEventListener('pointermove', e => { if (dragging) moveDrag(e.clientY); });
    zone.addEventListener('pointerup', endDrag);
    zone.addEventListener('pointercancel', endDrag);
    zone.addEventListener('mouseup', endDrag);
    zone.addEventListener('mouseleave', () => { if (dragging && currentY > 80) endDrag(); });
  });
}

// ── CLEANER MODE ─────────────────────────────────────────────────────────────
function isCleanerMode() {
  const hash = window.location.hash; // e.g. #cleaner/123/ABC
  if (hash.startsWith('#cleaner/')) return true;
  const p = new URLSearchParams(window.location.search);
  if (p.get('role') === 'cleaner') return true;
  // Fallback: cleaner params were saved to localStorage on first auth
  return !!localStorage.getItem('gh-cleaner-session');
}

function getCleanerParams() {
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
  } catch (e) {}
  return { id: null, encoded: null, uid: null };
}
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
async function hydrateCleanerFromFunction() {
  const { id, uid } = getCleanerParams();
  if (!id || !uid) {
    console.log('[StayOps] hydrateCleanerFromFunction: missing id or uid');
    return false;
  }
  try {
    console.log('[StayOps] hydrateCleanerFromFunction: fetching data…');
    const res = await fetch('/.netlify/functions/cleaner-data?cleanerId=' + encodeURIComponent(id) + '&uid=' + encodeURIComponent(uid));
    if (!res.ok) {
      console.warn('[StayOps] hydrateCleanerFromFunction: HTTP ' + res.status);
      return false;
    }
    const data = await res.json();
    if (!data || !data.cleaner) {
      console.warn('[StayOps] hydrateCleanerFromFunction: no cleaner in response');
      return false;
    }

    // Populate localStorage so loadCleaners/getActiveCleaner work
    const cleanerRecord = data.cleaner;
    // Ensure the cleaner's local_id is a number if it was originally
    if (cleanerRecord.id && !isNaN(Number(cleanerRecord.id))) {
      cleanerRecord.id = Number(cleanerRecord.id);
    }
    localStorage.setItem(lsKey('cleaners'), JSON.stringify([cleanerRecord]));

    // Populate cleans
    if (Array.isArray(data.cleans)) {
      cleans = data.cleans;
      localStorage.setItem(lsKey('cleans'), JSON.stringify(cleans));
    }

    // Populate bookings
    if (Array.isArray(data.bookings)) {
      bookings = data.bookings;
      localStorage.setItem(lsKey('bookings'), JSON.stringify(bookings));
    }

    // Populate inventory
    if (Array.isArray(data.inventory)) {
      inventory = data.inventory;
      localStorage.setItem(lsKey('inventory'), JSON.stringify(inventory));
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
async function postCleanerAction(cleanId, action) {
  const { id: cleanerId, uid } = getCleanerParams();
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
function _showCleanerLinkError(msg) {
  // Repurpose the PIN screen to show a clear error instead of a blank cleaner view.
  // Removes cleaner-mode so the cleaner shell is hidden, keeps the PIN screen bg.
  document.body.classList.remove('cleaner-mode');
  document.body.classList.add('cleaner-pin-active');
  const dots = document.getElementById('pin-dots');
  if (dots) dots.style.display = 'none';
  const errEl = document.getElementById('pin-error');
  if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
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
async function verifyCleanerPin() {
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
async function cleanerRefresh() {
  const btn = document.getElementById('cleaner-refresh-btn');
  if (btn) { btn.textContent = '↻ …'; btn.disabled = true; }
  await hydrateCleanerFromFunction();
  renderCleanerView();
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
  localStorage.removeItem('gh-cleaner-session');
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
    const tabBtn = document.getElementById('ctab-' + t);
    const viewEl = document.getElementById('cleaner-' + t + '-view');
    if (tabBtn) tabBtn.classList.toggle('active', t === tab);
    if (viewEl) viewEl.style.display = t === tab ? 'block' : 'none';
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
      btn.style.background = t === tab ? 'rgba(31,90,67,0.08)' : 'transparent';
      btn.style.borderRadius = '10px 10px 0 0';
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
    if (_isCleanLinkedToCancelledBooking(c)) return false;
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
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.55px;color:var(--text-soft);margin-bottom:6px">Your jobs today</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <div class="mini-status-chip chip-new">New: <strong>${newCount}</strong></div>
        <div class="mini-status-chip chip-upcoming">Upcoming: <strong>${upcomingCount}</strong></div>
      </div>
      <div style="font-size:11px;color:var(--text-soft);margin-top:7px">${newCount > 0 ? 'Start in New to accept/decline your latest jobs.' : 'No new responses needed right now.'}</div>
    `;
  }
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
    const booking = bookings.find(b => String(b.id) === String(c.bookingId) || _normName(b.name) === _normName(c.guestName));
    const checkinStr = booking ? fmt(booking.checkin) : (c.checkin ? fmt(c.checkin) : '—');
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
        <div style="font-size:12px;color:var(--text-soft);margin-top:8px">If you were just assigned, tap <strong>↻ Refresh</strong>.</div>
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
        <div style="font-size:12px;color:var(--text-soft);margin-top:8px">Accept a clean from the <strong>New</strong> tab first.</div>
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
  const lockKey = 'cleanerAccept:' + String(cleanId);
  if (!_acquireLock(_actionLocks, lockKey)) return;
  const c = cleans.find(cl => String(cl.id) === String(cleanId));
  if (!c) { _releaseLock(_actionLocks, lockKey); return; }
  c.cleanerConfirmed = true;
  c.cleanerDeclined = false;
  // Also update booking so owner sees confirmed status in detail
  const b = bookings.find(bk => String(bk.id) === String(c.bookingId) || (bk._cloudId && String(bk._cloudId) === String(c.bookingId)) || _normName(bk.name) === _normName(c.guestName));
  if (b) b.cleanerConfirmed = true;
  try {
    _normalizeBookingCleanState();
    save();
    // Try direct Supabase first (works in Safari), fall back to Netlify function (home screen PWA)
    if (typeof saveCleansToCloud === 'function' && window._supabaseUser) {
      saveCleansToCloud(cleans).catch(() => {});
    } else {
      postCleanerAction(cleanId, 'accept');
    }
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
  } finally {
    _releaseLock(_actionLocks, lockKey);
  }
}

async function cleanerDecline(cleanId) {
  const lockKey = 'cleanerDecline:' + String(cleanId);
  if (!_acquireLock(_actionLocks, lockKey)) return;
  const c = cleans.find(cl => String(cl.id) === String(cleanId));
  if (!c) { _releaseLock(_actionLocks, lockKey); return; }
  const ok = await showAppModal({
    title: '❌ Decline Clean?',
    msg: 'Are you sure you want to decline this clean? The owner will be notified.',
    confirmText: 'Decline',
    confirmColor: 'var(--red)',
    cancelText: 'Cancel'
  });
  if (!ok) { _releaseLock(_actionLocks, lockKey); return; }
  c.cleanerDeclined = true;
  c.cleanerConfirmed = false;
  const b = bookings.find(bk => String(bk.id) === String(c.bookingId) || (bk._cloudId && String(bk._cloudId) === String(c.bookingId)) || _normName(bk.name) === _normName(c.guestName));
  if (b) b.cleanerConfirmed = false;
  try {
    _normalizeBookingCleanState();
    save();
    if (typeof saveCleansToCloud === 'function' && window._supabaseUser) {
      saveCleansToCloud(cleans).catch(() => {});
    } else {
      postCleanerAction(cleanId, 'decline');
    }
    if (typeof saveCleaningJobToCloud === 'function' && window._supabaseUser) saveCleaningJobToCloud(c);
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
  } finally {
    _releaseLock(_actionLocks, lockKey);
  }
}

async function cleanerMarkDone(cleanId) {
  const lockKey = 'cleanerDone:' + String(cleanId);
  if (!_acquireLock(_actionLocks, lockKey)) return;
  const c = cleans.find(cl => String(cl.id) === String(cleanId));
  if (!c) { _releaseLock(_actionLocks, lockKey); return; }
  const ok = await showAppModal({ title: '✅ Mark Complete', msg: 'Mark this clean as completed?', confirmText: 'Yes, done!', cancelText: 'Not yet' });
  if (!ok) { _releaseLock(_actionLocks, lockKey); return; }
  c.done = true; c.cleanerConfirmed = true;
  const b = bookings.find(bk => String(bk.id) === String(c.bookingId) || (bk._cloudId && String(bk._cloudId) === String(c.bookingId)) || _normName(bk.name) === _normName(c.guestName));
  if (b) b.cleanerConfirmed = true;
  try {
    _normalizeBookingCleanState();
    save();
    if (typeof saveCleansToCloud === 'function' && window._supabaseUser) {
      saveCleansToCloud(cleans).catch(() => {});
    } else {
      postCleanerAction(cleanId, 'done');
    }
    renderCleanerCleans();
    if (typeof saveCleaningJobToCloud === 'function' && window._supabaseUser) saveCleaningJobToCloud(c);
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
  } finally {
    _releaseLock(_actionLocks, lockKey);
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

// ── AUTO-ASSIGN CLEANER TOGGLE ────────────────────────────────────────────────

function getAutoAssignCleaner() {
  return localStorage.getItem(lsKey('auto-assign-cleaner')) !== 'off';
}

function toggleAutoAssignCleaner() {
  const current = getAutoAssignCleaner();
  const newVal = !current;
  localStorage.setItem(lsKey('auto-assign-cleaner'), newVal ? 'on' : 'off');
  if (typeof saveAppConfigToCloud === 'function') {
    saveAppConfigToCloud({ auto_assign_cleaner: newVal }).catch(() => {});
  }
  _renderAutoAssignToggle();
  showBanner(newVal ? '✓ Auto-assign enabled' : '✓ Auto-assign disabled', 'ok');
}

function _renderAutoAssignToggle() {
  const on = getAutoAssignCleaner();
  const track = document.getElementById('auto-assign-toggle');
  const thumb = document.getElementById('auto-assign-thumb');
  if (track) track.style.background = on ? 'var(--forest)' : 'var(--border)';
  if (thumb) thumb.style.transform = on ? 'translateX(18px)' : 'translateX(0)';
}

// ── END AUTO-ASSIGN TOGGLE ────────────────────────────────────────────────────

async function assignCleanerToBooking(bookingId) {
  const lockKey = 'assignCleaner:' + String(bookingId);
  if (!_acquireLock(_actionLocks, lockKey)) return;
  const saveBtn = document.getElementById('detail-assign-btn');
  if (saveBtn && saveBtn.disabled) { _releaseLock(_actionLocks, lockKey); return; }
  const cleanerInput = document.getElementById('detail-assign-cleaner');
  const dateInput = document.getElementById('detail-assign-date');
  if (!cleanerInput || !dateInput) { _releaseLock(_actionLocks, lockKey); return; }
  const cleanerId = String(cleanerInput.value || '').trim();
  const date = dateInput.value;
  if (!cleanerId || !date) { showBanner('⚠ Select a cleaner and date', 'warn'); _releaseLock(_actionLocks, lockKey); return; }
  const cleanerObj = loadCleaners().find(c => String(c.id) === cleanerId);
  if (!cleanerObj) { showBanner('⚠ Cleaner not found', 'warn'); _releaseLock(_actionLocks, lockKey); return; }
  const booking = bookings.find(b => String(b.id) === String(bookingId) || (b._cloudId && String(b._cloudId) === String(bookingId)));
  if (!booking) { _releaseLock(_actionLocks, lockKey); return; }
  if (booking.status === 'cancelled') { showBanner('Cancelled booking — cleaner assignment is disabled', 'warn'); _releaseLock(_actionLocks, lockKey); return; }
  // Plan (Bug 1): Reuse an existing clean's local/cloud IDs by bookingId during reassignment,
  // so saveCleanToCloud upserts the same row instead of inserting duplicates.
  const matched = _findMatchingCleanForBooking(booking, date);
  const existingByBookingIdx = cleans.findIndex(c => String(c.bookingId) === String(bookingId));
  const existingIdx = matched ? cleans.findIndex(c => c.id === matched.id) : existingByBookingIdx;
  const prev = existingIdx >= 0 ? cleans[existingIdx] : null;
  if (prev && String(prev.bookingId) === String(bookingId)) {
    console.log('[StayOps] Reusing existing clean for booking:', bookingId);
  } else {
    console.log('[StayOps] Creating new clean for booking:', bookingId);
  }
  const sameAssignment = !!(prev && String(prev.cleanerId) === String(cleanerObj.id) && String(prev.date || '').slice(0, 10) === String(date || '').slice(0, 10));
  const alreadyConfirmed = !!(prev && prev.cleanerConfirmed);
  if (sameAssignment && !alreadyConfirmed) {
    booking.cleanerConfirmed = !!prev.cleanerConfirmed;
    _normalizeBookingCleanState();
    save();
    showBanner('No changes — already assigned to ' + cleanerObj.name, 'ok');
    showDetail(bookingId);
    _releaseLock(_actionLocks, lockKey);
    return;
  }
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
  const newClean = {
    id: prev ? prev.id : Date.now(),
    _cloudId: prev ? prev._cloudId : undefined,
    bookingId, guestName: booking.name,
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
    _normalizeBookingCleanState();
    _recordCleanerAssignmentUsage(cleanerObj);
    save();
    if (typeof saveCleanToCloud === 'function') {
      await saveCleanToCloud(newClean);
    }
    showBanner('✓ Assigned to ' + cleanerObj.name + ' — awaiting cleaner response', 'ok');
    showDetail(bookingId);

    // Send push notification
    const cleanerSub = getCleanerSub(cleanerObj.id);
    let pushSent = false;
    console.log('Cleaner sub for id', cleanerObj.id, ':', cleanerSub ? 'found' : 'NOT FOUND');
    if (cleanerSub) {
      pushSent = true;
      sendPushToDevice(cleanerSub,
        '🏡 New Clean Assigned',
        `${booking.name || 'Guest'} · ${fmt(date)}`,
        cleanerLinkForId(cleanerObj),
        'assign-' + bookingId
      );
    } else {
      console.warn('No push subscription found for cleaner', cleanerObj.id, '— cleaner needs to enable notifications');
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
        if (result.ok) showBanner('✉️ Email sent to ' + cleanerObj.name, 'ok');
        else if (result.reason !== 'no-key' && result.reason !== 'no-email') console.warn('Email failed:', result);
      });
    }
    if (!cleanerEmail && !pushSent) {
      showBanner('⚠ Assigned, but no cleaner email or push subscription is configured', 'warn');
    }
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Assignment';
    }
    _releaseLock(_actionLocks, lockKey);
  }
}

// ── EMAIL TEMPLATES ───────────────────────────────────────────────────────────
const EMAIL_TEMPLATE_DEFAULTS = {
  assignment: {
    subject: 'New clean assigned — {{guest_name}} ({{checkin}})',
    body: `Hi {{cleaner_name}},

You've been assigned a new clean at ${getCurrentPropertyName()}.

Guest: {{guest_name}}
Check-in: {{checkin}}
Check-out: {{checkout}}

Tap the button below to open your app and accept or decline.`,
    color: '#1E3A2F'
  },
  reminder: {
    subject: '⏰ Reminder: Clean tomorrow — {{guest_name}}',
    body: `Hi {{cleaner_name}},

Just a reminder — you have a clean tomorrow at ${getCurrentPropertyName()}.

Guest: {{guest_name}}
Clean date: {{clean_date}}

Tap the button below to open your app.`,
    color: '#E65100'
  },
  cancellation: {
    subject: '❌ Booking cancelled — {{guest_name}}',
    body: `Hi {{cleaner_name}},

The booking for {{guest_name}} has been cancelled at ${getCurrentPropertyName()}.

Original stay dates:
Check-in: {{checkin}}
Check-out: {{checkout}}

No clean is required for this booking now.

Tap the button below to open your app.`,
    color: '#C0392B'
  }
};

const EMAIL_TEMPLATE_PRESETS = {
  assignment: [
    {
      label: 'Friendly',
      subject: `New clean at ${getCurrentPropertyName()} — {{checkin}}`,
      body: `Hi {{cleaner_name}},

You've been booked for a clean at ${getCurrentPropertyName()}! Here are the details:

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

A new clean has been assigned to you at ${getCurrentPropertyName()}.

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

Just a heads up — you have a clean tomorrow at ${getCurrentPropertyName()} after {{guest_name}} checks out.

Date: {{clean_date}}

Everything you need is in your app. See you there! 🏡`,
      color: '#E65100'
    },
    {
      label: 'Minimal',
      subject: `Reminder: ${getCurrentPropertyName()} clean tomorrow`,
      body: `Hi {{cleaner_name}},

Quick reminder that your clean at ${getCurrentPropertyName()} is tomorrow.

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
  const saved = loadJSON(lsKey('email-tpl-' + type));
  return saved || EMAIL_TEMPLATE_DEFAULTS[type];
}

function saveEmailTemplate(type) {
  const subject = document.getElementById('etpl-subject').value;
  const body    = document.getElementById('etpl-body').value;
  const color   = document.getElementById('etpl-color').value;
  const tpl = { subject, body, color };
  localStorage.setItem(lsKey('email-tpl-' + type), JSON.stringify(tpl));
  // Sync email templates to Supabase
  if (typeof saveAppConfigToCloud === 'function') {
    const templates = {};
    templates[type] = tpl;
    saveAppConfigToCloud({ email_templates: templates }).catch(() => {});
  }
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
        <div style="color:white;font-size:16px;font-weight:700">🏡 ${getCurrentPropertyName()}</div>
      </div>
      ${bodyHtml}
      <div style="margin-top:16px">
        <div style="background:${color};color:white;text-align:center;padding:12px;border-radius:8px;font-weight:600;font-size:13px">Open My Cleaner App →</div>
      </div>
    </div>`;
}
function applyEmailTemplate(type, vars) {
  const propName    = getCurrentPropertyName();
  const propConfig  = (typeof getActivePropertyConfig === 'function') ? getActivePropertyConfig() : ((typeof getPropertyConfig === 'function') ? getPropertyConfig() : {});
  // Address comes from properties table in Supabase via getActivePropertyConfig()
  const addressLine = propConfig.address || [propConfig.suburb, propConfig.state].filter(Boolean).join(', ') || '';

  const headerColors = { assignment: '#1a4f3a', reminder: '#7a3a00', cancellation: '#5a1a1a' };
  const pillLabels   = { assignment: 'Clean assignment', reminder: 'Reminder', cancellation: 'Cancellation' };
  const color = headerColors[type] || '#1a4f3a';
  const pill  = pillLabels[type]   || 'Notification';

  const cleanerFirst = (vars.cleanerName || 'there').split(' ')[0];

  // ── Build subject ──
  const subjects = {
    assignment:   `Clean assignment — ${propName}, ${vars.cleanDate || vars.checkout || ''}`,
    reminder:     `Reminder: ${propName} clean tomorrow, ${vars.cleanDate || vars.checkout || ''}`,
    cancellation: `Clean cancelled — ${propName}, ${vars.cleanDate || vars.checkout || ''}`
  };
  const subject = subjects[type] || subjects.assignment;

  // ── Build detail rows ──
  function detailRow(label, value) {
    if (!value) return '';
    return `<tr>
      <td style="padding:9px 14px;font-size:11px;font-weight:500;color:#999;text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap;border-bottom:1px solid #f0ede8">${label}</td>
      <td style="padding:9px 14px;font-size:13px;color:#1a1a1a;text-align:right;border-bottom:1px solid #f0ede8">${value}</td>
    </tr>`;
  }

  let rows = '';
  if (type === 'assignment') {
    rows += detailRow('Clean date',      vars.cleanDate || vars.checkout || '');
    rows += detailRow('Available from',  vars.checkoutTime ? vars.checkoutTime + ' (after checkout)' : 'After checkout');
    rows += detailRow('Required by',     vars.checkinTime  ? vars.checkinTime  + ' (next check-in)'  : '');
    rows += detailRow('Departing guest', vars.guestName || '');
    rows += detailRow('Party size',      vars.guests && vars.nights ? `${vars.guests} guests · ${vars.nights} night${vars.nights!=='1'?'s':''}` : (vars.guests ? `${vars.guests} guests` : ''));
  } else if (type === 'reminder') {
    rows += detailRow('Clean date',      vars.cleanDate || vars.checkout || '');
    rows += detailRow('Available from',  vars.checkoutTime ? vars.checkoutTime + ' (after checkout)' : 'After checkout');
    rows += detailRow('Required by',     vars.checkinTime  ? vars.checkinTime  + (vars.windowHours ? ` · ${vars.windowHours}-hour window` : ' (next check-in)') : '');
    rows += detailRow('Departing guest', vars.guestName || '');
    rows += detailRow('Arriving guest',  vars.nextGuestName ? vars.nextGuestName + (vars.nextGuests ? ` · ${vars.nextGuests} guests` : '') : '');
  } else if (type === 'cancellation') {
    rows += detailRow('Clean date', `<span style="text-decoration:line-through;color:#bbb">${vars.cleanDate || vars.checkout || ''}</span>`);
    rows += detailRow('Guest',      `<span style="text-decoration:line-through;color:#bbb">${vars.guestName || ''}</span>`);
  }
  // Remove last row's border
  rows = rows.replace(/border-bottom:1px solid #f0ede8([^"]*)"([^>]*)>(?![\s\S]*border-bottom:1px solid #f0ede8)/g, (m) => m.replace('border-bottom:1px solid #f0ede8', 'border-bottom:none'));

  // ── Intro text ──
  const intros = {
    assignment:   `A cleaning assignment has been scheduled for you at ${propName}. Please confirm your availability using the buttons below.`,
    reminder:     `This is a reminder that your cleaning assignment at ${propName} is scheduled for tomorrow.`,
    cancellation: `Please be advised that the following cleaning assignment has been cancelled. No action is required on your part.`
  };

  // ── Note (reminder only) ──
  const noteHtml = (type === 'reminder' && vars.checkinTime)
    ? `<div style="font-size:12px;color:#5a4a2a;line-height:1.55;margin-bottom:16px;padding:10px 14px;background:#fef9f0;border-left:3px solid #e89020;border-radius:0 6px 6px 0">The property must be ready by ${vars.checkinTime}. Please allow sufficient time for a full turnaround.</div>`
    : '';

  // ── CTA buttons ──
  const ctaHtml = type === 'assignment'
    ? `<table style="width:100%;border-collapse:collapse;margin-bottom:4px"><tr>
        <td style="padding-right:6px"><a href="${vars.cleanerLink||'#'}" style="display:block;background:#1a4f3a;color:white;text-align:center;padding:13px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px">Confirm availability</a></td>
        <td style="padding-left:6px"><a href="${(vars.cleanerLink||'#') + '?action=decline'}" style="display:block;background:#f7f5f2;color:#444;text-align:center;padding:13px;border-radius:8px;text-decoration:none;font-size:13px;border:1px solid #e0dbd4">Decline</a></td>
      </tr></table>`
    : type === 'reminder'
    ? `<a href="${vars.cleanerLink||'#'}" style="display:block;background:#7a3a00;color:white;text-align:center;padding:13px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px;margin-bottom:4px">Open cleaner app</a>`
    : '';

  const detailsOpacity = type === 'cancellation' ? 'opacity:0.55;' : '';

  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
    <div style="background:${color};padding:20px 24px 16px;border-radius:10px 10px 0 0">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:3px">
        <span style="font-size:17px;font-weight:700;color:#fff">${propName}</span>
        <span style="font-size:10px;font-weight:600;padding:3px 9px;border-radius:20px;background:rgba(255,255,255,0.15);color:rgba(255,255,255,0.8);letter-spacing:0.5px;text-transform:uppercase">${pill}</span>
      </div>
      ${addressLine ? `<div style="font-size:12px;color:rgba(255,255,255,0.55);margin-top:1px">${addressLine}</div>` : ''}
    </div>
    <div style="background:white;padding:22px 24px;border:1px solid #ebe7e2;border-top:none">
      <p style="font-size:14px;color:#1a1a1a;margin:0 0 10px">Dear ${cleanerFirst},</p>
      <p style="font-size:13px;color:#444;margin:0 0 16px;line-height:1.55">${intros[type]}</p>
      ${rows ? `<table style="width:100%;border-collapse:collapse;border:1px solid #ebe7e2;border-radius:8px;overflow:hidden;margin-bottom:16px;${detailsOpacity}">${rows}</table>` : ''}
      ${noteHtml}
      ${ctaHtml}
    </div>
    <div style="padding:13px 24px;background:#f7f5f2;border:1px solid #ebe7e2;border-top:none;border-radius:0 0 10px 10px">
      <p style="font-size:11px;color:#bbb;margin:0;line-height:1.5">Sent via StayOps &middot; Replies go directly to your host</p>
    </div>
  </div>`;

  const textLines = [
    `Dear ${cleanerFirst},`, '',
    intros[type], '',
    type !== 'cancellation' ? `Clean date: ${vars.cleanDate || vars.checkout || ''}` : `Cancelled: ${vars.cleanDate || vars.checkout || ''}`,
    vars.guestName ? `Guest: ${vars.guestName}` : '',
    vars.guests ? `Guests: ${vars.guests}` : '',
  ].filter(l => l !== undefined).join('\n');

  return { subject, html, text: textLines };
}
async function sendCleanerEmail({ cleanerName, cleanerEmail, guestName, checkin, checkout, cleanerLink, cleanDate, type, guests, nights, checkoutTime, checkinTime, nextGuestName, nextGuests, windowHours }) {
  if (!cleanerEmail) return { ok: false, reason: 'no-email' };
  const emailType = type || 'assignment';
  const { subject, html, text } = applyEmailTemplate(emailType, {
    cleanerName: String(cleanerName || 'Cleaner').split(' ')[0],
    guestName, checkin, checkout,
    cleanDate: cleanDate || checkout,
    cleanerLink,
    guests, nights, checkoutTime, checkinTime, nextGuestName, nextGuests, windowHours
  });
  try {
    const data = await DB.sendEmail(cleanerEmail, subject, html, text);
    return { ok: !!(data && (data.success || data.status === 'ok')), data };
  } catch(e) {
    return { ok: false, reason: e.message };
  }
}

function _setConnectionCheckResult(id, status, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = 'block';
  el.textContent = msg;

  if (status === 'ok') {
    el.style.background = '#F0FAF4';
    el.style.color = 'var(--moss)';
  } else if (status === 'loading') {
    el.style.background = 'var(--warm)';
    el.style.color = 'var(--text-soft)';
  } else {
    el.style.background = '#FEF2F2';
    el.style.color = 'var(--red)';
  }
}

function resetConnectionCheckerResults() {
  const el = document.getElementById('conn-notif-result');
  if (el) el.style.display = 'none';
}



async function testNotificationConfig() {
  _setConnectionCheckResult('conn-notif-result', 'loading', 'Checking notification/email configuration…');

  const ownerEmail = (getCurrentHostEmail() || '').trim(); // host email, not owner/investor
  const pushFunctionUrl = (getPushFunctionUrl() || '').trim();
  const pushSupported = ('Notification' in window);
  const perm = pushSupported ? Notification.permission : 'unsupported';
  const ownerSub = getOwnerSub();

  const checks = [];
  if (ownerEmail) checks.push('Owner email configured');
  if (pushFunctionUrl) checks.push('Push function URL configured');
  if (pushSupported) checks.push('Browser supports notifications');
  if (perm === 'granted' && ownerSub) checks.push('Push enabled on this device');

  const missing = [];
  if (!ownerEmail) missing.push('owner email missing');
  if (!pushFunctionUrl) missing.push('push function URL missing');

  const mode = 'configuration check only (no live send)';
  if (missing.length) {
    _setConnectionCheckResult('conn-notif-result', 'fail', `⚠️ ${mode}: ${checks.length ? checks.join(' · ') + '. ' : ''}Missing: ${missing.join(', ')}.`);
    return;
  }

  const pushMsg = !pushSupported
    ? 'push not supported on this browser'
    : (perm === 'granted' && ownerSub)
      ? 'push ready on this device'
      : 'push not enabled on this device yet';

  _setConnectionCheckResult('conn-notif-result', 'ok', `✅ ${mode}: email/push prerequisites look valid (${pushMsg}).`);
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
  const testTo = getCurrentHostEmail() || c.email; // send test to host, not property owner
  const result = await sendCleanerEmail({
    cleanerName: c.name, cleanerEmail: testTo,
    guestName: 'Test Guest', checkin: 'Tomorrow', checkout: 'Day after',
    cleanerLink: cleanerLinkForId(c)
  });
  if (resultEl) {
    if (result.ok) { resultEl.style.background = '#F0FAF4'; resultEl.style.color = 'var(--moss)'; resultEl.textContent = '✓ Test email sent to ' + testTo; }
    else { resultEl.style.background = '#FEF2F2'; resultEl.style.color = 'var(--red)'; resultEl.textContent = '✕ Failed — check your Legacy Sync URL is saved and deployed'; }
  }
}

// ── CLEANER ACCESS SETTINGS ───────────────────────────────────────────────────
function openCleanerSettings() {
  renderCleanerAccessList();
}
function renderCleanerAccessList() {
  const el = document.getElementById('cleaner-access-list');
  if (!el) return;
  const cleaners = loadCleaners().filter(c => isCleanerPerson(c));
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
  const uid = window._supabaseUser ? window._supabaseUser.id : '';
  return c.pin
    ? (base + '?role=cleaner&id=' + encodeURIComponent(c.id) + '&p=' + encodeURIComponent(btoa(c.pin)) + '&uid=' + encodeURIComponent(uid) + '#cleaner/' + c.id + '/' + btoa(c.pin))
    : (base + '?role=cleaner&id=' + encodeURIComponent(c.id) + '&uid=' + encodeURIComponent(uid) + '#cleaner/' + c.id);
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

/**
// hydrateFromCloud and finishAppInit live in supabase.js

/**
 * finishAppInit — runs standard app init after login or session restore.
 */
async function finishAppInit() {
  migrateConfigFromLegacySettings();
  renderPropertySwitcher();
  initFxSettings();
  attachButtonPress();
  attachModalHandleDrag();
  document.getElementById('modal').addEventListener('click', function(e) { if (e.target === this) closeModal(); });
  document.getElementById('detail-modal').addEventListener('click', function(e) { if (e.target === this) closeDetailModal(); });
  document.getElementById('notify-modal').addEventListener('click', function(e) { if (e.target === this) closeNotifyModal(); });
  if (isCleanerMode()) {
    const { uid } = getCleanerParams();
    if (!uid) {
      _showCleanerLinkError('Invalid cleaner link — ask the owner to re-send your link from Settings.');
    } else if (isCleanerAuthed()) {
      document.body.classList.add('cleaner-mode');
      const ok = await hydrateCleanerFromFunction();
      if (ok) {
        renderCleanerView();
      } else {
        _showCleanerLinkError('Could not load your cleaning data — check your connection and try again.');
      }
    } else {
      document.body.classList.add('cleaner-pin-active');
    }
  } else {
    await showSetupIfNeeded();
  }
}

// ── ONBOARDING FLOW ───────────────────────────────────────────────────────────

const _OB_PLATFORMS = new Set();

function showOnboarding() {
  const el = document.getElementById('stayops-onboarding');
  if (el) el.style.display = 'flex';
  const app   = document.getElementById('main-content');
  const nav   = document.querySelector('.nav');
  const hdr   = document.querySelector('.header');
  if (app) app.style.display = 'none';
  if (nav) nav.style.display = 'none';
  if (hdr) hdr.style.display = 'none';
  _obGoToStep(1);
}

function hideOnboarding() {
  const el = document.getElementById('stayops-onboarding');
  if (el) el.style.display = 'none';
  // Restore app chrome hidden by showOnboarding()
  const app = document.getElementById('main-content');
  const nav = document.querySelector('.nav');
  const hdr = document.querySelector('.header');
  if (app) app.style.display = '';
  if (nav) nav.style.display = '';
  if (hdr) hdr.style.display = '';
}

function _obGoToStep(step) {
  [1, 2, 3].forEach(n => {
    const s = document.getElementById('onboard-step-' + n);
    const d = document.getElementById('onboard-dot-' + n);
    if (s) s.style.display = n === step ? '' : 'none';
    if (d) d.classList.toggle('active', n <= step);
  });
}

// Step 1 — Property details
function onboardStep1Next() {
  const name   = (document.getElementById('ob-prop-name') || {}).value?.trim() || '';
  const suburb = (document.getElementById('ob-suburb')    || {}).value?.trim() || '';
  const state  = (document.getElementById('ob-state')     || {}).value?.trim() || '';
  const beds   = parseFloat((document.getElementById('ob-beds')   || {}).value || '0');
  const baths  = parseFloat((document.getElementById('ob-baths')  || {}).value || '0');
  const guests = parseFloat((document.getElementById('ob-guests') || {}).value || '0');
  const type   = (document.getElementById('ob-type') || {}).value || 'house';
  const errEl  = document.getElementById('ob-step1-error');

  const errors = [];
  if (!name)        errors.push('Property name is required.');
  if (!suburb)      errors.push('Suburb is required.');
  if (!state)       errors.push('State is required.');
  if (!beds || beds < 1)    errors.push('Bedrooms must be at least 1.');
  if (isNaN(baths) || baths < 0) errors.push('Bathrooms cannot be negative.');
  if (!guests || guests < 1) errors.push('Max guests must be at least 1.');

  if (errors.length) {
    if (errEl) errEl.textContent = errors[0];
    return;
  }
  if (errEl) errEl.textContent = '';

  // Save property config
  savePropertyConfig({
    name, suburb, state,
    country: 'Australia',
    property: { bedrooms: beds, bathrooms: baths, maxGuests: guests, type },
    branding: { subtitle: suburb + ' · ' + state, tagline: suburb + ', ' + state },
  });
  localStorage.setItem('gh-setup-complete', '1');

  // Sync property to Supabase
  if (!window._stayOpsHydrating && typeof savePropertyToCloud === 'function') {
    savePropertyToCloud(getActivePropertyConfig()).catch(() => {});
  }

  _obGoToStep(2);
}

// Step 2 — Connect email
async function onboardConnectGoogle() {
  const user = await getCurrentSupabaseUser();
  if (!user) { showBanner('⚠ Please sign in first', 'warn'); return; }
  // Redirect to Netlify OAuth start function, passing user_id as state
  window.location.href = '/.netlify/functions/gmail-oauth-start?state=' + encodeURIComponent(user.id);
}

async function onboardConnectMicrosoft() {
  const user = await getCurrentSupabaseUser();
  if (!user) { showBanner('⚠ Please sign in first', 'warn'); return; }
  window.location.href = '/.netlify/functions/outlook-oauth-start?state=' + encodeURIComponent(user.id);
}

// Called by OAuth callback when connection succeeds
function onboardEmailConnected(provider, email) {
  const connectedEl = document.getElementById('ob-email-connected');
  const continueBtn = document.getElementById('ob-step2-continue');
  if (connectedEl) {
    connectedEl.style.display = 'block';
    connectedEl.textContent = '✓ ' + email + ' connected';
  }
  if (continueBtn) {
    continueBtn.disabled = false;
    continueBtn.onclick = () => _obGoToStep(3);
  }
  // Save provider to localStorage for now
  localStorage.setItem('ob-email-provider', provider);
  localStorage.setItem('ob-email-address', email);
}

function onboardStep2Skip() {
  _obGoToStep(3);
}

// Step 3 — Platforms
function onboardTogglePlatform(platform) {
  if (_OB_PLATFORMS.has(platform)) {
    _OB_PLATFORMS.delete(platform);
  } else {
    _OB_PLATFORMS.add(platform);
  }
  // Update UI
  ['airbnb', 'vrbo', 'direct'].forEach(p => {
    const label = document.getElementById('ob-plat-' + p);
    const check = document.getElementById('ob-check-' + p);
    const active = _OB_PLATFORMS.has(p);
    if (label) label.style.borderColor = active ? 'var(--forest,#1E3A2F)' : 'transparent';
    if (check) {
      check.style.background  = active ? 'var(--forest,#1E3A2F)' : 'transparent';
      check.style.borderColor = active ? 'var(--forest,#1E3A2F)' : '#E5E5EA';
      check.innerHTML = active ? '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 7L5.5 10.5L12 3.5" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '';
    }
  });
}

async function onboardFinish() {
  const errEl = document.getElementById('ob-step3-error');
  if (_OB_PLATFORMS.size === 0) {
    if (errEl) errEl.textContent = 'Please select at least one platform.';
    return;
  }
  if (errEl) errEl.textContent = '';

  // Save platforms to property config
  const platforms = Array.from(_OB_PLATFORMS);
  savePropertyConfig({ platforms });

  // Save to Supabase
  if (typeof savePropertyToCloud === 'function') {
    await savePropertyToCloud(getActivePropertyConfig());
  }

  // No localStorage flag needed — completion is determined by
  // whether the user has a property record in Supabase

  // Boot the app
  hideOnboarding();
  if (typeof showLoadingScreen === 'function') showLoadingScreen('Setting up your account…');
  if (typeof finishAppInit === 'function') await finishAppInit();
  if (typeof hydrateFromCloud === 'function') await hydrateFromCloud();
  reloadInMemoryData();
  if (typeof initPropertyUI === 'function') initPropertyUI();
  if (typeof applyPortfolioModeAfterHostHydrate === 'function') await applyPortfolioModeAfterHostHydrate();
  if (typeof showAppChrome === 'function') showAppChrome();
  if (!(typeof isPortfolioMode === 'function' && isPortfolioMode()) && typeof renderAll === 'function') renderAll();
  setTimeout(() => { if (typeof checkAutoSendReport === 'function') checkAutoSendReport(); }, 1500);
}

// Check if onboarding is needed
function isOnboardingComplete() {
  // A real property must exist in the list before any other flag matters.
  // gh-setup-complete is set by the property setup overlay on submit regardless
  // of whether valid property data was actually saved (e.g. empty name field).
  // Without this guard, an authenticated user with 0 cloud properties lands on
  // a blank "NSW / 0 beds" dashboard instead of the Add Property / onboarding screen.
  try {
    const props = typeof getAllProperties === 'function' ? getAllProperties() : [];
    if (!props.length) return false;
  } catch(e) {}
  if (localStorage.getItem('gh-setup-complete') === '1') return true;
  try {
    const cfg = typeof getActivePropertyConfig === 'function' ? getActivePropertyConfig() : null;
    if (cfg && cfg.name) return true;
  } catch(e) {}
  return false;
}

// ── END ONBOARDING FLOW ───────────────────────────────────────────────────────

// ── OWNER REPORT ──────────────────────────────────────────────────────────────

/**
 * populateOwnerReportPanel — fills the owner-report panel with current config.
 * Called by openSettingsPanel('owner-report').
 */
function populateOwnerReportPanel() {
  const cfg = getActivePropertyConfig();
  const owner = cfg.owner || {};

  _setVal('owner-report-name',    owner.name  || '');
  _setVal('owner-report-email',   owner.email || '');
  _setVal('owner-report-phone',   owner.phone || '');
  _setVal('owner-report-subject', owner.reportEmailSubject || '');
  _setVal('owner-report-body',    owner.reportEmailBody    || '');

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
    const currentFY = reportFY;
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


function populateMgmtFeePanel() {
  const rate = localStorage.getItem(lsKey("mgmt-fee-rate"));
  const el = document.getElementById("settings-mgmt-fee-rate");
  if (el) el.value = rate !== null ? rate : "";
}

async function saveMgmtFeeRate() {
  const el = document.getElementById("settings-mgmt-fee-rate");
  if (!el) return;
  const rate = parseFloat(el.value);
  if (isNaN(rate) || rate < 0 || rate > 100) { showBanner("⚠ Enter a valid fee between 0 and 100", "warn"); return; }
  localStorage.setItem(lsKey("mgmt-fee-rate"), String(rate));
  // Save to properties table in Supabase
  if (typeof savePropertyToCloud === "function") {
    const cfg = (typeof getActivePropertyConfig === "function") ? getActivePropertyConfig() : {};
    savePropertyToCloud(cfg).catch(() => {});
  }
  const confirm = document.getElementById("mgmt-fee-confirm");
  if (confirm) { confirm.style.display = "block"; setTimeout(() => { confirm.style.display = "none"; }, 2000); }
  showBanner("✓ Management fee rate saved", "ok");
}

function _setVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}

function _updateOwnerReportToggleUI(on) {
  const track = document.getElementById('owner-autosend-toggle');
  const thumb = document.getElementById('owner-autosend-thumb');
  if (track) track.style.background = on ? 'var(--forest, #1E3A2F)' : 'var(--border, #C7C7CC)';
  if (thumb) thumb.style.transform  = on ? 'translateX(18px)' : 'translateX(0)';
}

function ownerAutoSendToggle() {
  window._ownerAutoSend = !window._ownerAutoSend;
  _updateOwnerReportToggleUI(window._ownerAutoSend);
}

/**
 * saveOwnerReportSettings — reads the panel fields and persists to config + Supabase.
 */
function saveOwnerReportSettings() {
  const name    = (document.getElementById('owner-report-name')    || {}).value || '';
  const email   = (document.getElementById('owner-report-email')   || {}).value || '';
  const phone   = (document.getElementById('owner-report-phone')   || {}).value || '';
  const subject = (document.getElementById('owner-report-subject') || {}).value || '';
  const body    = (document.getElementById('owner-report-body')    || {}).value || '';
  const autoSend = !!window._ownerAutoSend;
  const freq    = (document.getElementById('owner-report-frequency') || {}).value || 'monthly';

  // Preserve lastReportSentAt — don't overwrite it here
  const existing = getActivePropertyConfig().owner || {};

  savePropertyConfig({
    owner: {
      name,
      email,
      phone,
      reportEmailSubject: subject,
      reportEmailBody:    body,
      autoSendReport:     autoSend,
      reportFrequency:    freq,
      lastReportSentAt:   existing.lastReportSentAt || null,
    }
  });

  showBanner('✓ Owner & report settings saved', 'ok');
}

/**
 * sendOwnerReport — generates the PDF for the chosen FY and emails it via Legacy Sync.
 */
async function sendOwnerReport() {
  if (!window.jspdf) { showBanner('⟳ PDF library loading — try again in a moment', 'warn'); return; }

  const cfg     = getActivePropertyConfig();
  const owner   = cfg.owner || {};
  const ownerEmail = owner.email || '';

  if (!ownerEmail) {
    showBanner('⚠ No owner email set — add one in Owner & Reports settings', 'warn');
    return;
  }

  const fyEl = document.getElementById('owner-report-send-fy');
  const fy   = fyEl ? Number(fyEl.value) : reportFY;

  const btn    = document.getElementById('owner-report-send-btn');
  const status = document.getElementById('owner-report-send-status');
  if (btn)    { btn.disabled = true; btn.textContent = 'Sending…'; }
  if (status) { status.style.color = 'var(--text-soft)'; status.textContent = 'Building PDF…'; }

  try {
    // 1. Build PDF and get base64 string
    const doc      = _buildReportDoc(fy);
    const pdfB64   = doc.output('datauristring').split(',')[1]; // base64 only
    const fileName = `${getCurrentPropertyName().replace(/[^a-zA-Z0-9]/g,'-')}-${fyLabel(fy).replace(/\s/g,'_')}.pdf`;

    // 2. Compose email
    const propName = getCurrentPropertyName();
    const defaultSubject = `${propName} — ${fyLabel(fy)} Performance Report`;
    const subject  = (owner.reportEmailSubject || '').trim() || defaultSubject;
    const bodyIntro = (owner.reportEmailBody || '').trim()
      || `Hi${owner.name ? ' ' + owner.name.split(' ')[0] : ''},\n\nPlease find attached the ${fyLabel(fy)} financial performance report for ${propName}.\n\nKind regards`;

    if (status) status.textContent = 'Sending email…';

    // 3. Send via Netlify function (Resend API) with PDF attachment
    const html = bodyIntro.replace(/\n/g, '<br>');
    const res = await fetch('/.netlify/functions/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: ownerEmail, subject, html,
        attachments: [{ filename: fileName, content: pdfB64 }]
      })
    });
    const json = await res.json().catch(() => ({}));

    if (json.success || json.status === 'ok') {
      // 4. Record timestamp
      const now = new Date().toISOString();
      const existingOwner = getActivePropertyConfig().owner || {};
      savePropertyConfig({ owner: { ...existingOwner, lastReportSentAt: now } });

      if (status) { status.style.color = 'var(--forest)'; status.textContent = '✓ Report sent to ' + ownerEmail; }
      showBanner('✅ Report emailed to ' + ownerEmail, 'ok');

      // Refresh the last-sent label
      const lastSentEl = document.getElementById('owner-report-last-sent-row');
      if (lastSentEl) {
        const d = new Date(now);
        lastSentEl.textContent = 'Last sent: ' + d.toLocaleDateString('en-AU', { day:'numeric', month:'short', year:'numeric' });
      }
    } else {
      const errMsg = json.error || json.message || 'Unknown error';
      if (status) { status.style.color = 'var(--red)'; status.textContent = '✗ Failed: ' + errMsg; }
      showBanner('⚠ Report send failed — ' + errMsg, 'warn');
    }
  } catch (e) {
    if (status) { status.style.color = 'var(--red)'; status.textContent = '✗ Error: ' + e.message; }
    showBanner('⚠ Report send error — ' + e.message, 'warn');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Send Report'; }
  }
}

/**
 * checkAutoSendReport — called once after hydrateFromCloud + renderAll.
 * If auto-send is on and a report is due, shows a non-intrusive prompt banner.
 */
function checkAutoSendReport() {
  try {
    const owner = (getActivePropertyConfig() || {}).owner || {};
    if (!owner.autoSendReport || !owner.email) return;

    const freq        = owner.reportFrequency || 'monthly';
    const lastSent    = owner.lastReportSentAt ? new Date(owner.lastReportSentAt) : null;
    const now         = new Date();
    const daysSince   = lastSent ? Math.floor((now - lastSent) / 86400000) : Infinity;
    const threshold   = freq === 'quarterly' ? 85 : 28; // ~1 month / ~3 months

    if (daysSince < threshold) return;

    // Determine which FY the due period belongs to
    const dueMonth = lastSent
      ? new Date(lastSent.getFullYear(), lastSent.getMonth() + (freq === 'quarterly' ? 3 : 1), 1)
      : now;
    const fy = dueMonth.getMonth() >= 6 ? dueMonth.getFullYear() : dueMonth.getFullYear() - 1;
    const label = fyLabel(fy);

    showBanner(
      `📊 ${label} report ready — <a href="#" onclick="openSettingsCat('property');openSettingsPanel('owner-report');return false;" style="color:inherit;font-weight:600">Send to owner ›</a>`,
      'info',
      12000
    );
  } catch (e) {
    // Non-critical — silently ignore
  }
}


// ── ONE-TIME BOOKING MIGRATION ────────────────────────────────────────────────
/**
// ── REPORT EXPORT ─────────────────────────────────────────────────────────────
/**
 * _buildReportDoc(fy) — shared PDF builder. Returns a jsPDF doc object.
 * Used by both exportReportPDF() and sendOwnerReport().
 */
function _buildReportDoc(fy) {
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
  doc.text(getCurrentPropertyName() + ' — Performance Report', 10, 14);
  doc.setFontSize(9); doc.setFont('helvetica','normal');
  doc.text(fyLabel(fy) + ' · Generated ' + new Date().toLocaleDateString('en-AU'), 200, 14, { align:'right' });
  y = 30;

  // KPI row
  doc.setTextColor(...FOREST);
  doc.setFontSize(9); doc.setFont('helvetica','bold');
  const months = fyMonths(fy);
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
  const allExp = (JSON.parse(localStorage.getItem(lsKey('expenses'))||'[]')).filter(e => {
    const d=new Date(e.date); const mo=d.getMonth(); const yr=d.getFullYear();
    return (yr===fy&&mo>=6)||(yr===fy+1&&mo<=5);
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

  return doc;
}

function exportReportPDF() {
  if (!window.jspdf) { showBanner('⟳ PDF library loading, try again in a moment','warn'); return; }
  const doc = _buildReportDoc(reportFY);
  doc.save(`${getCurrentPropertyName()}-${fyLabel(reportFY).replace(' ','_')}.pdf`);
}


function exportReportCSV() {
  const months = fyMonths(reportFY);
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const rows = [[getCurrentPropertyName() + ' Performance Report — ' + fyLabel(reportFY)],[]];

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
  const allExp = (JSON.parse(localStorage.getItem(lsKey('expenses'))||'[]')).filter(e => {
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
  a.href = url; a.download = `${getCurrentPropertyName()}-${fyLabel(reportFY).replace(' ','_')}.csv`;
  a.click(); URL.revokeObjectURL(url);
  showBanner('✅ CSV downloaded','success');
}

// ── Calendar swipe navigation + slide animation ───────────────────────────
let _calNavigate;
(function() {
  var _calSwipeX = 0, _calSwipeY = 0;
  var _calAnimating = false;

  function _calReset(grid) {
    grid.style.transition = 'none';
    grid.style.transform  = '';
    grid.style.opacity    = '1';
  }

  _calNavigate = function _calNavigate(direction) {
    var grid = document.getElementById('cal-grid');
    if (!grid || _calAnimating) return;
    _calAnimating = true;

    var outX = direction === 'next' ? '-60%' : '60%';
    var inX  = direction === 'next' ? '60%'  : '-60%';

    // Step 1: fade + slide out
    grid.style.transition = 'transform 0.16s cubic-bezier(0.32,0.72,0,1), opacity 0.16s ease';
    grid.style.transform  = 'translateX(' + outX + ')';
    grid.style.opacity    = '0';

    setTimeout(function() {
      // Step 2: update month data
      if (direction === 'next') calNext(); else calPrev();

      // Step 3: snap to incoming side (no transition)
      grid.style.transition = 'none';
      grid.style.transform  = 'translateX(' + inX + ')';
      grid.style.opacity    = '0';

      // Step 4: double rAF to slide in
      requestAnimationFrame(function() {
        requestAnimationFrame(function() {
          grid.style.transition = 'transform 0.2s cubic-bezier(0.32,0.72,0,1), opacity 0.16s ease';
          grid.style.transform  = 'translateX(0)';
          grid.style.opacity    = '1';
          // Step 5: clean up after animation
          setTimeout(function() {
            _calReset(grid);
            _calAnimating = false;
          }, 220);
        });
      });
    }, 160);
  }

  function attachCalSwipe() {
    var el = document.querySelector('.dashboard-calendar');
    if (!el) return;

    // Ensure grid starts visible
    var grid = document.getElementById('cal-grid');
    if (grid) _calReset(grid);

    el.addEventListener('touchstart', function(e) {
      var t = e.touches[0];
      _calSwipeX = t.clientX;
      _calSwipeY = t.clientY;
    }, { passive: true });

    el.addEventListener('touchend', function(e) {
      var t = e.changedTouches[0];
      var dx = t.clientX - _calSwipeX;
      var dy = t.clientY - _calSwipeY;
      if (Math.abs(dx) < 44 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      _calNavigate(dx < 0 ? 'next' : 'prev');
    }, { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachCalSwipe);
  } else {
    attachCalSwipe();
  }
})();

// ── GLOBAL SCOPE ASSIGNMENTS ───────────────────────────────────────────────────
// ES modules are scoped — functions are not automatically global.
// These expose functions that index.html onclick handlers, dynamically generated
// HTML, and cross-module calls depend on.

// Called from index.html onclick/onchange handlers
window.handleLoginSubmit        = handleLoginSubmit;
window.handleSignUpSubmit       = handleSignUpSubmit;
window.toggleSignUp             = toggleSignUp;
window.hostSignOut              = hostSignOut;
window.addBooking               = addBooking;
window.addClean                 = addClean;
window.addCleaner               = addCleaner;
window.addExpense               = addExpense;
window.addExpenseCat            = addExpenseCat;
window.addInventoryItem         = addInventoryItem;
window.addMaintenance           = addMaintenance;
window.addNote                  = addNote;
window.analyseExpenses          = analyseExpenses;
window.appModalCancel           = appModalCancel;
window.appModalConfirm          = appModalConfirm;
window.attachEditExpensePhoto   = attachEditExpensePhoto;
window.attachExpenseFile        = attachExpenseFile;
window.autoFillCleanDate        = autoFillCleanDate;
window.backToFinanceHub         = backToFinanceHub;
window.backToPropertyHub        = backToPropertyHub;
window.calcNet                  = calcNet;
window.calcNights               = calcNights;
window.cleanerAddInventoryItem  = cleanerAddInventoryItem;
window.cleanerRefresh           = cleanerRefresh;
window.cleanerSignOut           = cleanerSignOut;
window.clearCacheAndResync      = clearCacheAndResync;
window.clearEditExpensePhoto    = clearEditExpensePhoto;
window.clearExpenseFilters      = clearExpenseFilters;
window.clearExpensePhoto        = clearExpensePhoto;
window.closeActionSheet         = closeActionSheet;
window.closeCalPreview          = closeCalPreview;
window.closeDetailModal         = closeDetailModal;
window.closeExpenseEdit         = closeExpenseEdit;
window.closeInvEdit             = closeInvEdit;
window.closeModal               = closeModal;
window.closeNotifyModal         = closeNotifyModal;
window.closePropertySwitcherSheet = closePropertySwitcherSheet;
window.closeQuickAddMenu        = closeQuickAddMenu;
window.closeSettingsCat         = closeSettingsCat;
window.closeSettingsPanel       = closeSettingsPanel;
window.confirmInvoiceClient     = confirmInvoiceClient;
window.deleteInventoryItemFromEdit = deleteInventoryItemFromEdit;
window.enableCleanerNotifications = enableCleanerNotifications;
window.enableNotificationsManually = enableNotificationsManually;
window.extractBookingFromScreenshot = extractBookingFromScreenshot;
window.extractExpenseFromReceipt = extractExpenseFromReceipt;
window.filterBookings           = filterBookings;
window.filterCleans             = filterCleans;
window.fyNext                   = fyNext;
window.fyPrev                   = fyPrev;
window.generateInvoice          = generateInvoice;
window.getSmartPricing          = getSmartPricing;
window.importAirbnbCSV          = importAirbnbCSV;
window.importCSV                = importCSV;
window.merchantAutocomplete     = merchantAutocomplete;
window.mgmtNext                 = mgmtNext;
window.mgmtPrev                 = mgmtPrev;
window.onboardConnectGoogle     = onboardConnectGoogle;
window.onboardConnectMicrosoft  = onboardConnectMicrosoft;
window.onboardFinish            = onboardFinish;
window.onboardStep1Next         = onboardStep1Next;
window.onboardTogglePlatform    = onboardTogglePlatform;
window.openFinancePanelFromHub  = openFinancePanelFromHub;
window.openModal                = openModal;
window.openOwnerReportFromHub   = openOwnerReportFromHub;
window.openPropertyAccessRules  = openPropertyAccessRules;
window.openPropertyDetailsFromHub = openPropertyDetailsFromHub;
window.openPropertySettingsMenu = openPropertySettingsMenu;
window.openPropertySwitcherSheet = openPropertySwitcherSheet;
window.openSettingsCat          = openSettingsCat;
window.openSettingsPanel        = openSettingsPanel;
window.ownerAutoSendToggle      = ownerAutoSendToggle;
window.pickContact              = pickContact;
window.pinDelete                = pinDelete;
window.pinPress                 = pinPress;
window.readBookingScreenshot    = readBookingScreenshot;
window.renderAIIgnoreList       = renderAIIgnoreList;
window.renderExpenses           = renderExpenses;
window.renderMgmtFY             = renderMgmtFY;
window.renderReport             = renderReport;
window.renderStorageViewer      = renderStorageViewer;
window.resetExpenseCats         = resetExpenseCats;
window.resetPushOnly            = resetPushOnly;
window.revNext                  = revNext;
window.revPrev                  = revPrev;
window.runFullRefresh           = runFullRefresh;
window.saveApiKey               = saveApiKey;
window.saveBankDetails          = saveBankDetails;
window.saveExpenseEdit          = saveExpenseEdit;
window.saveHostProfilePanel     = saveHostProfilePanel;
window.saveInvEdit              = saveInvEdit;
window.saveMgmtFeeRate          = saveMgmtFeeRate;
window.saveOwnerReportSettings  = saveOwnerReportSettings;
window.saveSMSTemplate          = saveSMSTemplate;
window.saveFxSetting            = saveFxSetting;
window.sendOwnerReport          = sendOwnerReport;
window.sendSMS                  = sendSMS;
window.setInvView               = setInvView;
window.showFinanceSub           = showFinanceSub;
window.showPropertySub          = showPropertySub;
window.showSection              = showSection;
window.switchActiveProperty     = switchActiveProperty;
window.switchCleanerCleanTab    = switchCleanerCleanTab;
window.switchCleanerTab         = switchCleanerTab;
window.switchMgmtSubTab         = switchMgmtSubTab;
window.switchModalTab           = switchModalTab;
window.switchPayoutsSubTab      = switchPayoutsSubTab;
window.switchReportsSubTab      = switchReportsSubTab;
window.testCleanerEmail         = testCleanerEmail;
window.testNotificationConfig   = testNotificationConfig;
window.toggleAutoAssignCleaner  = toggleAutoAssignCleaner;
window.toggleExpenseAddForm     = toggleExpenseAddForm;
window.toggleExpenseList        = toggleExpenseList;

// Called from dynamically generated HTML (onclick strings in template literals)
window.adjustStock              = adjustStock;
window.applyPreset              = applyPreset;
window.assignCleanerToBooking   = assignCleanerToBooking;
window.cleanerAccept            = cleanerAccept;
window.cleanerAdjustStock       = cleanerAdjustStock;
window.cleanerDecline           = cleanerDecline;
window.cleanerMarkDone          = cleanerMarkDone;
window.clearCleanerPinById      = clearCleanerPinById;
window.connectGmail             = connectGmail;
window.connectOutlook           = connectOutlook;
window.copyCalendarFeedUrl      = copyCalendarFeedUrl;
window.copyCleanerLinkById      = copyCleanerLinkById;
window.deleteBooking            = deleteBooking;
window.deleteCleaner            = deleteCleaner;
window.deleteClient             = deleteClient;
window.deleteExpenseCat         = deleteExpenseCat;
window.deleteMaintenance        = deleteMaintenance;
window.exportReportCSV          = exportReportCSV;
window.exportReportPDF          = exportReportPDF;
window.insertTemplateVar        = insertTemplateVar;
window.jumpToCleaningActionNeeded = jumpToCleaningActionNeeded;
window.markCleanDeclined        = markCleanDeclined;
window.markCleanerConfirmed     = markCleanerConfirmed;
window.openCalPreview           = openCalPreview;
window.openCleanerProfile       = openCleanerProfile;
window.openExpenseView          = openExpenseView;
window.openInvEdit              = openInvEdit;
window.openNotifyModal          = openNotifyModal;
window.promptIgnore             = promptIgnore;
window.quickAssignLastCleaner   = quickAssignLastCleaner;
window.reassignClean            = reassignClean;
window.removeAIIgnoreItem       = removeAIIgnoreItem;
window.resetEmailTemplate       = resetEmailTemplate;
window.resolveIssue             = resolveIssue;
window.restockItem              = restockItem;
window.revealCleanerReassign    = revealCleanerReassign;
window.saveCleanerContact       = saveCleanerContact;
window.saveCleanerPerm          = saveCleanerPerm;
window.saveCleanerPinById       = saveCleanerPinById;
window.saveCleaningFee          = saveCleaningFee;
window.saveEdit                 = saveEdit;
window.saveEmailTemplate        = saveEmailTemplate;
window.scanGmailBookings        = scanGmailBookings;
window.scanOutlookBookings      = scanOutlookBookings;
window.selectMerchantSuggest    = selectMerchantSuggest;
window.sendCleanerReminder      = sendCleanerReminder;
window.setMaintInProgress       = setMaintInProgress;
window.showAppModal             = showAppModal;
window.showDetail               = showDetail;
window.showEditModal            = showEditModal;
window.switchPropertyFromSheet  = switchPropertyFromSheet;
window.switchToPortfolioFromSheet = switchToPortfolioFromSheet;
window.isPortfolioMode          = isPortfolioMode;
window.enterPortfolioMode       = enterPortfolioMode;
window.exitPortfolioMode        = exitPortfolioMode;
window.getPropertyColour        = getPropertyColour;
window.getPropertyColourById    = getPropertyColourById;
window.getPropertyNameById      = getPropertyNameById;
window.toggleCleanerConfirmed   = toggleCleanerConfirmed;
window.toggleExpenseMonth       = toggleExpenseMonth;
window.toggleMgmtSelect         = toggleMgmtSelect;

// Called from supabase.js typeof window.X guards (boot sequence)
window.getAllProperties          = getAllProperties;
window.getActivePropertyId      = getActivePropertyId;
window.setActivePropertyId      = setActivePropertyId;
window.getActivePropertyConfig  = getActivePropertyConfig;
window.addPropertyConfig        = addPropertyConfig;
window.savePropertyConfig       = savePropertyConfig;
window.lsKey                    = lsKey;
window.hasValidPropertyConfig   = hasValidPropertyConfig;
window.ensureHostIdentityAndRestore = ensureHostIdentityAndRestore;
window.finishAppInit            = finishAppInit;
window.reloadInMemoryData       = reloadInMemoryData;
window._normalizeBookingCleanState = _normalizeBookingCleanState;
window.isOnboardingComplete     = isOnboardingComplete;
window.showOnboarding           = showOnboarding;
window.renderAll                = renderAll;
window.checkAutoSendReport      = checkAutoSendReport;
window.maybeAutoScanGmail       = maybeAutoScanGmail;
window.maybeAutoScanOutlook     = maybeAutoScanOutlook;
window._obGoToStep              = _obGoToStep;

// Internal reference used by calendar navigation
window._calNavigate             = _calNavigate;

// DB adapter instance
window.DB = new SupabaseAdapter();

/**
 * After hydrate + reloadInMemoryData + normalize + initPropertyUI, apply multi-property
 * portfolio mode when appropriate. Used by boot IIFE and post-login (handleLoginSubmit).
 */
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
      renderAll();
    } catch (e) {
      console.warn('[StayOps] Portfolio auto-load failed, falling back to single property', e);
      portfolioMode = false;
      reloadInMemoryData();
      initPropertyUI();
    }
  }
}
window.applyPortfolioModeAfterHostHydrate = applyPortfolioModeAfterHostHydrate;

// Init on load
(async () => {
  // Handle OAuth redirect back from Google/Microsoft
  const urlParams = new URLSearchParams(window.location.search);
  const oauthSuccess = urlParams.get('oauth_success');
  const oauthEmail   = urlParams.get('oauth_email') || urlParams.get('email');
  const oauthError   = urlParams.get('oauth_error');
  if (oauthSuccess && oauthEmail) {
    // Clean URL
    window.history.replaceState({}, '', window.location.pathname);
    // Save Gmail connection for connection summary UI
    if (oauthSuccess === 'google') {
      localStorage.setItem('gh-gmail-email', decodeURIComponent(oauthEmail));
    }
    // Save Outlook connection for connection summary UI
    if (oauthSuccess === 'microsoft') {
      localStorage.setItem('gh-outlook-email', decodeURIComponent(oauthEmail));
    }
    // Show onboarding step 2 connected state after app loads
    window._oauthConnected = { provider: oauthSuccess, email: decodeURIComponent(oauthEmail) };
  }
  if (oauthError) {
    window.history.replaceState({}, '', window.location.pathname);
    window._oauthError = decodeURIComponent(oauthError);
  }

  // Cleaner mode bypasses host auth entirely
  if (isCleanerMode()) {
    migrateConfigFromLegacySettings();
    initPropertyUI();
    attachButtonPress();
    attachModalHandleDrag();
    document.getElementById('modal').addEventListener('click', function(e) { if (e.target === this) closeModal(); });
    document.getElementById('detail-modal').addEventListener('click', function(e) { if (e.target === this) closeDetailModal(); });
    document.getElementById('notify-modal').addEventListener('click', function(e) { if (e.target === this) closeNotifyModal(); });
    const { uid } = getCleanerParams();
    if (!uid) {
      _showCleanerLinkError('Invalid cleaner link — ask the owner to re-send your link from Settings.');
    } else if (isCleanerAuthed()) {
      document.body.classList.add('cleaner-mode');
      // Hydrate from Netlify function (handles home screen PWA with no Supabase session)
      const ok = await hydrateCleanerFromFunction();
      if (ok) {
        renderCleanerView();
      } else {
        _showCleanerLinkError('Could not load your cleaning data — check your connection and try again.');
      }
    } else {
      document.body.classList.add('cleaner-pin-active');
    }
    return;
  }

  if (typeof showLoadingScreen === 'function') showLoadingScreen('Checking your session…');

  // Check for active Supabase session
  let session = null;
  if (typeof getSupabaseSession === 'function') {
    session = await getSupabaseSession();
  }

  if (!session) {
    // No session — show login screen and wait
    console.log('[StayOps] No session — showing login screen');
    if (typeof showLoginScreen === 'function') showLoginScreen();
    else if (typeof hideLoadingScreen === 'function') hideLoadingScreen();
    return;
  }

  // Existing session — init app FIRST (establishes property/storage keys),
  // THEN hydrate from cloud so data lands under the correct scoped keys.
  console.log('[StayOps] Boot step: session found, starting boot');
  if (typeof showLoadingScreen === 'function') showLoadingScreen('Signing you in…');

  try {
    migrateConfigFromLegacySettings();
    if (typeof setLoadingStatus === 'function') setLoadingStatus('Checking your account…');
    if (typeof seedLocalConfigFromCloud === 'function') await seedLocalConfigFromCloud();
    console.log('[StayOps] Boot step: seedLocalConfigFromCloud complete');
    await ensureHostIdentityAndRestore();
    console.log('[StayOps] Boot step: ensureHostIdentityAndRestore complete');
    if (typeof setLoadingStatus === 'function') setLoadingStatus('Starting app…');
    await finishAppInit();
    console.log('[StayOps] Boot step: finishAppInit complete');
    if (typeof setLoadingStatus === 'function') setLoadingStatus('Loading your data…');
    if (typeof hydrateFromCloud === 'function') await hydrateFromCloud();
    console.log('[StayOps] Boot step: hydrateFromCloud complete');

    // Refresh in-memory arrays and property UI after cloud hydration
    reloadInMemoryData();
    // Fix: reconcile bookings vs cleans cleaner_confirmed before first render
    // so any divergence that existed in Supabase does not reach the UI.
    _normalizeBookingCleanState();
    initPropertyUI();

    await applyPortfolioModeAfterHostHydrate();

    // Check if onboarding is needed (new user on fresh device)
    if (typeof isOnboardingComplete === 'function' && !isOnboardingComplete()) {
      if (typeof showOnboarding === 'function') {
        showOnboarding();
        // If returning from OAuth flow, jump to step 2 and show connected state
        if (window._oauthConnected) {
          _obGoToStep(2);
          onboardEmailConnected(window._oauthConnected.provider, window._oauthConnected.email);
          delete window._oauthConnected;
        }
        if (window._oauthError) {
          _obGoToStep(2);
          const errEl = document.getElementById('ob-step2-error');
          if (errEl) errEl.textContent = '⚠ Connection failed: ' + window._oauthError;
          delete window._oauthError;
        }
      }
      return;
    }

    console.log('[StayOps] Boot step: renderAll called');
    if (!isPortfolioMode()) {
      renderAll();
    }
    applyStayopsPostSwitchAction();
    // Prompt if an owner report is due (non-blocking, runs after UI is visible)
    setTimeout(checkAutoSendReport, 1500);
    // Auto-scan Gmail for new booking emails
    setTimeout(maybeAutoScanGmail, 3000);
    // Auto-scan Outlook for new booking emails
    setTimeout(maybeAutoScanOutlook, 4500);
    // Periodic re-scan every 15 minutes while app is open
    setInterval(maybeAutoScanGmail, 15 * 60 * 1000);
    setInterval(maybeAutoScanOutlook, 15 * 60 * 1000 + 1500);
  } catch (e) {
    console.error('[StayOps] Boot failed:', e);
  } finally {
    if (typeof showAppChrome === 'function') showAppChrome();
  }
})();
