/**
 * Pass 3 — push, SMS notify modal, cleaner email templates & sends.
 */
import {
  getVapidPublicKey,
  getPushFunctionUrl,
  getCurrentPropertyName,
  getActivePropertyConfig,
  getPropertyConfig,
  getCurrentHostEmail,
} from './config.js';
import { saveAppConfigToCloud, getCurrentSupabaseUser } from './supabase.js';
import { bookings, cleans } from './state.js';
import { fmt, _normName } from './utils.js';

function loadCleaners() {
  return (window._cleaners || []);
}

// ── PUSH NOTIFICATIONS ────────────────────────────────────────────────────────
export function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

function safePushStringify(v) {
  try { return JSON.stringify(v); } catch (_) { return '[unserializable]'; }
}

/** Resolve actual Supabase client instance (not the global library object). */
function getSupabaseClient() {
  const directClient = globalThis._sb || window._sb || null;
  if (directClient && typeof directClient.from === 'function') return directClient;

  const maybeSupabase = globalThis.supabase || window.supabase || null;
  if (maybeSupabase && typeof maybeSupabase.from === 'function') return maybeSupabase;

  return null;
}

function parsePushSubscriptionsArray(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

/**
 * Add this device's host subscription to app_config.push_subscriptions (dedup by endpoint).
 */
async function mergeHostPushSubscriptionToCloud(subJson) {
  if (!subJson || !subJson.endpoint) return;
  const sb = getSupabaseClient();
  const user = await getCurrentSupabaseUser();
  if (!sb || !user) {
    console.log('[StayOps] push_subscriptions sync skipped — no Supabase client or signed-in user');
    return;
  }
  const { data: row, error: readErr } = await sb
    .from('app_config')
    .select('push_subscriptions')
    .eq('user_id', user.id)
    .maybeSingle();
  if (readErr) {
    console.warn('[StayOps] push_subscriptions read failed', readErr.message);
    return;
  }
  const existing = parsePushSubscriptionsArray(row && row.push_subscriptions);
  if (existing.some(e => e && e.endpoint === subJson.endpoint)) {
    console.log('[StayOps] Push subscription already registered for this device');
    return;
  }
  const newEntry = {
    endpoint: subJson.endpoint,
    keys: {
      p256dh: subJson.keys && subJson.keys.p256dh,
      auth: subJson.keys && subJson.keys.auth,
    },
    user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    subscribed_at: new Date().toISOString(),
  };
  const updatedArray = existing.concat([newEntry]);
  const ts = new Date().toISOString();
  if (row != null) {
    const { error: upErr } = await sb
      .from('app_config')
      .update({ push_subscriptions: updatedArray, updated_at: ts })
      .eq('user_id', user.id);
    if (upErr) console.warn('[StayOps] push_subscriptions update failed', upErr.message);
  } else {
    const { error: upErr } = await sb
      .from('app_config')
      .upsert(
        { user_id: user.id, push_subscriptions: updatedArray, updated_at: ts },
        { onConflict: 'user_id' }
      );
    if (upErr) console.warn('[StayOps] push_subscriptions upsert failed', upErr.message);
  }
}

async function removeHostPushSubscriptionFromCloudByEndpoint(endpoint) {
  if (!endpoint) return;
  const sb = getSupabaseClient();
  const user = await getCurrentSupabaseUser();
  if (!sb || !user) return;
  const { data: row, error: readErr } = await sb
    .from('app_config')
    .select('push_subscriptions')
    .eq('user_id', user.id)
    .maybeSingle();
  if (readErr) {
    console.warn('[StayOps] push_subscriptions read failed (unsubscribe)', readErr.message);
    return;
  }
  const existing = parsePushSubscriptionsArray(row && row.push_subscriptions);
  const filtered = existing.filter(e => e && e.endpoint !== endpoint);
  if (filtered.length === existing.length) return;
  const { error: upErr } = await sb
    .from('app_config')
    .update({ push_subscriptions: filtered, updated_at: new Date().toISOString() })
    .eq('user_id', user.id);
  if (upErr) console.warn('[StayOps] push_subscriptions update failed (unsubscribe)', upErr.message);
}

/** Unsubscribe this browser from push and remove its endpoint from push_subscriptions. */
export async function unsubscribeHostPushNotifications() {
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = reg && reg.pushManager ? await reg.pushManager.getSubscription() : null;
  if (!sub) {
    console.log('[StayOps] unsubscribeHostPushNotifications: no active subscription');
    return;
  }
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await removeHostPushSubscriptionFromCloudByEndpoint(endpoint);
  console.log('[StayOps] Device unsubscribed from push notifications');
}

export function getPushSubs() {
  const subs = (window._appConfig && window._appConfig.push_subs) || null;
  return (subs && typeof subs === 'object') ? subs : { cleaners: {} };
}
export function savePushSubsLocal(subs) {
  console.log('[Push] savePushSubsLocal: saving local + requesting AppData sync', {
    hasHost: !!(subs && subs.host),
    cleanerCount: Object.keys((subs && subs.cleaners) || {}).length
  });
  window._appConfig = window._appConfig || {};
  window._appConfig.push_subs = subs && typeof subs === 'object' ? subs : { cleaners: {} };
  if (typeof saveAppConfigToCloud === 'function') {
    saveAppConfigToCloud({ push_subs: subs }).catch(() => {});
  }
}

export async function enableNotificationsManually() {
  const btn = document.getElementById('notif-enable-btn');
  const result = document.getElementById('notif-result');
  if (result) result.style.display = 'none';
  if (btn) { btn.disabled = true; btn.textContent = '…'; }

  if (!('Notification' in window)) {
    if (result) { result.style.display = 'block'; result.style.color = 'var(--red)'; result.textContent = '❌ This browser does not support notifications.'; }
    if (btn) { btn.disabled = false; btn.textContent = '🔔 Enable Notifications on This Device'; }
    return;
  }

  const sub = await subscribeToPush('host');
  if (result) result.style.display = 'block';
  if (sub) {
    if (result) { result.style.color = 'var(--moss)'; result.textContent = '✓ Notifications enabled on this device!'; }
    if (btn) btn.textContent = '✓ Enabled';
    updateNotifStatus();
    if (typeof globalThis.renderOnboardingGuidance === 'function') globalThis.renderOnboardingGuidance();
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

export async function resetPushOnly() {
  console.log('[Push] Reset Push Only started');
  const result = document.getElementById('notif-result');
  try {
    if (!('serviceWorker' in navigator)) throw new Error('serviceWorker unavailable');
    const reg = await navigator.serviceWorker.ready;
    const sub = reg && reg.pushManager ? await reg.pushManager.getSubscription() : null;
    if (sub) {
      const endpoint = sub.endpoint;
      const unsubscribed = await sub.unsubscribe();
      console.log('[Push] Reset Push Only unsubscribe result:', unsubscribed);
      await removeHostPushSubscriptionFromCloudByEndpoint(endpoint);
      console.log('[StayOps] Device unsubscribed from push notifications');
    } else {
      console.log('[Push] Reset Push Only: no existing subscription');
    }
    window._appConfig = window._appConfig || {};
    window._appConfig.push_subs = { cleaners: {} };
    if (typeof saveAppConfigToCloud === 'function') {
      saveAppConfigToCloud({ push_subs: window._appConfig.push_subs }).catch(() => {});
    }
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

export function updateNotifStatus() {
  const el = document.getElementById('notif-status');
  const menuRow = document.getElementById('notif-status-row-menu');
  if (!el && !menuRow) return;
  if (!('Notification' in window)) {
    if (el) { el.textContent = '⚠️ Notifications not supported on this browser.'; el.style.background = '#FDECEA'; el.style.color = 'var(--red)'; }
    if (menuRow) menuRow.textContent = '⚠️ Not supported';
    return;
  }
  const perm = Notification.permission;
  const sub = getHostSub();
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
  if (typeof globalThis.refreshConnectionSummarySoon === 'function') {
    globalThis.refreshConnectionSummarySoon();
  }
}

export async function subscribeToPush(role, cleanerId) {
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
    if (sub) {
      console.log('[Push] unsubscribing old subscription to refresh VAPID key');
      await sub.unsubscribe();
      sub = null;
    }
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
    if (role === 'host') {
      subs.host = subJson;
    } else if (role === 'cleaner' && cleanerId) {
      if (!subs.cleaners) subs.cleaners = {};
      subs.cleaners[String(cleanerId)] = subJson;
    }
    console.log('[Push] before saving subscription', { role, cleanerId: cleanerId || null, endpoint: subJson.endpoint || null });
    savePushSubsLocal(subs);
    if (role === 'host') {
      await mergeHostPushSubscriptionToCloud(subJson);
    }
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
globalThis.subscribeToPush = subscribeToPush;

export async function sendPushToDevice(subscription, title, body, url, tag, opts) {
  if (!subscription) { console.warn('sendPushToDevice called with no subscription'); return { ok: false, reason: 'no-subscription' }; }
  const extra = opts || {};
  try {
    console.log('[Push] before sending push endpoint:', subscription && subscription.endpoint ? subscription.endpoint : null);
    console.log('[Push] before sending push subscription (safe stringify):', safePushStringify(subscription || null));
    console.log('Sending push "' + title + '" to endpoint:', subscription.endpoint.substring(0, 50) + '...');
    const res = await fetch(getPushFunctionUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription, title, body, url, tag, ...extra })
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
      if (subs.host && JSON.stringify(subs.host) === JSON.stringify(subscription)) delete subs.host;
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
globalThis.sendPushToDevice = sendPushToDevice;

export function getHostSub() { return getPushSubs().host || null; }
export function getCleanerSub(cleanerId) {
  const cleaners = getPushSubs().cleaners || {};
  // Try exact match first (could be local_id or UUID depending on how cleaner subscribed)
  if (cleaners[String(cleanerId)]) return cleaners[String(cleanerId)];
  // Also check the cleaner's cloud ID — subscription may be stored under UUID while lookup uses local_id
  const allCleaners = window._cleaners || [];
  const cleaner = allCleaners.find(c =>
    String(c.id) === String(cleanerId) || String(c._cloudId) === String(cleanerId)
  );
  if (cleaner) {
    // Try both the local_id and cloud UUID
    if (cleaner._cloudId && cleaners[String(cleaner._cloudId)]) return cleaners[String(cleaner._cloudId)];
    if (cleaner.id && cleaners[String(cleaner.id)]) return cleaners[String(cleaner.id)];
  }
  return null;
}

export async function getFreshHostSub() {
  return getHostSub();
}
globalThis.getFreshHostSub = getFreshHostSub;

export async function _sendCleanerAssignmentNotifications(booking, cleanerObj, date, tag) {
  // Check if assignment notifications are disabled in admin config
  if (typeof globalThis.isNotifEnabled === 'function' && !globalThis.isNotifEnabled('notif_assignment')) {
    console.log('[StayOps] Assignment notifications disabled by admin config');
    return { pushSent: false, emailAttempted: false, emailSent: false };
  }

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
      tag || ('assign-' + String(booking.id || Date.now())),
      { skipEmail: true } // email already sent via sendCleanerEmail below
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

// ── NOTIFY CLEANER (SMS) ────────────────────────────────────────────────────
let notifyPhone = '';
let currentNotifyCleanId = null;

export function openNotifyModal(cleanId, mode = 'assign') {
  currentNotifyCleanId = cleanId;
  const c = cleans.find(c => String(c.id) === String(cleanId));
  if (!c) return;
  const b = bookings.find(b => String(b.id) === String(c.bookingId))
    || bookings.find(b => _normName(b.name) === _normName(c.guestName) && String(b.checkout || '').slice(0, 10) === String(c.date || '').slice(0, 10));
  if (!b) console.warn('[StayOps] openNotifyModal: no booking found for clean', c);
  const isReminder = String(mode || '') === 'reminder';

  const checkinRaw = b ? (b.checkin || b.checkIn || b.startDate) : (c.checkin || '');
  const checkoutRaw = b ? (b.checkout || b.checkOut || b.endDate) : c.date;
  const guestsRaw = b ? (b.guests ?? b.numGuests ?? b.guestCount) : null;
  const checkin = checkinRaw ? fmt(checkinRaw) : 'TBC';
  const checkout = checkoutRaw ? fmt(checkoutRaw) : 'TBC';
  const guests = (guestsRaw !== null && guestsRaw !== undefined && String(guestsRaw).trim() !== '') ? guestsRaw : '?';

  const defaultTemplate = `Hi {cleanerFirstName}\n\nNew Booking - please see below\n\nCheck in: {checkin}\nCheck out: {checkout}\nName: {guestFirstName}\nNumber of guests: {guests}\n\nPlease let me know if you are available`;
  const reminderTemplate = `Hi {cleanerFirstName}\n\nQuick follow-up for the clean after {guestFirstName} on {checkout}.\n\nPlease let me know if you're available when you can. Thanks!`;
  const template = isReminder
    ? reminderTemplate
    : (((window._appConfig && window._appConfig.sms_template) || '') || defaultTemplate);
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
  const cleaners = loadCleaners();
  const matchedCleaner = cleaners.find(cl => cl.name.toLowerCase() === c.cleaner.toLowerCase());
  if (matchedCleaner && matchedCleaner.phone) notifyPhone = matchedCleaner.phone;
  document.getElementById('notify-number-display').textContent = notifyPhone ? '📱 ' + notifyPhone : 'No number saved — go to Settings > Cleaning to add cleaner details';
  document.getElementById('notify-modal').classList.add('open'); document.body.style.overflow='hidden';
}

export function sendCleanerReminder(cleanId) {
  openNotifyModal(cleanId, 'reminder');
}

export async function pickContact() {
  const showAppModal = globalThis.showAppModal;
  if (typeof showAppModal !== 'function') return;
  if (!('contacts' in navigator && 'ContactsManager' in window)) {
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

export function sendSMS() {
  const msg = document.getElementById('notify-message').value;
  if (!notifyPhone) {
    if (typeof globalThis.showBanner === 'function') {
      globalThis.showBanner('⚠ No phone number — add one in Settings → People & SMS','warn');
    }
    return;
  }
  const smsUrl = `sms:${notifyPhone}?&body=${encodeURIComponent(msg)}`;
  window.location.href = smsUrl;
  if (currentNotifyCleanId) {
    const c = cleans.find(c => c.id === currentNotifyCleanId);
    if (c) { c.notified = true; c.cleanerConfirmed = false; }
  }
  closeNotifyModal();
  if (typeof globalThis.switchCleanView === 'function') globalThis.switchCleanView('timeline');
  if (typeof globalThis.populateSelects === 'function') globalThis.populateSelects();
}

export function closeNotifyModal() {
  document.getElementById('notify-modal').classList.remove('open');
  const anyOpen = !!document.querySelector('.modal-overlay.open');
  if (!anyOpen) document.body.style.overflow = '';
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

export function applyPreset(type, idx) {
  const preset = EMAIL_TEMPLATE_PRESETS[type][idx];
  if (!preset) return;
  document.getElementById('etpl-subject').value = preset.subject;
  document.getElementById('etpl-body').value    = preset.body;
  document.getElementById('etpl-color').value   = preset.color;
  document.getElementById('etpl-color-preview').style.background = preset.color;
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

export function loadEmailTemplate(type) {
  const cache = (window._appConfig && window._appConfig.email_templates) || {};
  const saved = cache && typeof cache === 'object' ? cache[type] : null;
  return saved || EMAIL_TEMPLATE_DEFAULTS[type];
}

export function saveEmailTemplate(type) {
  const subject = document.getElementById('etpl-subject').value;
  const body    = document.getElementById('etpl-body').value;
  const color   = document.getElementById('etpl-color').value;
  const tpl = { subject, body, color };
  window._appConfig = window._appConfig || {};
  window._appConfig.email_templates = window._appConfig.email_templates && typeof window._appConfig.email_templates === 'object'
    ? window._appConfig.email_templates
    : {};
  window._appConfig.email_templates[type] = tpl;
  if (typeof saveAppConfigToCloud === 'function') {
    saveAppConfigToCloud({ email_templates: window._appConfig.email_templates }).catch(() => {});
  }
  const conf = document.getElementById('etpl-save-confirm');
  if (conf) { conf.style.display = 'block'; setTimeout(() => conf.style.display = 'none', 2000); }
}

export function resetEmailTemplate(type) {
  const def = EMAIL_TEMPLATE_DEFAULTS[type];
  document.getElementById('etpl-subject').value = def.subject;
  document.getElementById('etpl-body').value    = def.body;
  document.getElementById('etpl-color').value   = def.color;
  document.getElementById('etpl-color-preview').style.background = def.color;
}

export function insertTemplateVar(tag) {
  const ta = document.getElementById('etpl-body');
  if (!ta) return;
  const start = ta.selectionStart, end = ta.selectionEnd;
  ta.value = ta.value.slice(0, start) + tag + ta.value.slice(end);
  ta.selectionStart = ta.selectionEnd = start + tag.length;
  ta.focus();
}

export function openEmailTemplatePanel(type) {
  const tpl = loadEmailTemplate(type);
  const isAssignment = type === 'assignment';
  const title = isAssignment ? '📋 Assignment Email' : '⏰ Reminder Email';
  const desc  = isAssignment ? 'Sent when you assign a clean.' : 'Sent 24 hours before the clean.';

  let mount = document.getElementById('email-template-content');
  if (!mount) {
    mount = document.createElement('div');
    mount.id = 'email-template-content';
    const tab = document.getElementById('admin-tab-templates');
    if (tab) tab.appendChild(mount);
    else { console.warn('[StayOps] email-template-content mount not found'); return; }
  }
  mount.innerHTML = `
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
  if (typeof globalThis.openSettingsPanel === 'function') {
    globalThis.openSettingsPanel('email-template');
  }
  setTimeout(() => updateEmailPreview(type), 50);
}

export function updateEmailPreview(type) {
  const subject  = document.getElementById('etpl-subject')?.value || '';
  const body     = document.getElementById('etpl-body')?.value    || '';
  const color    = document.getElementById('etpl-color')?.value   || '#1E3A2F';

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

export function applyEmailTemplate(type, vars) {
  const propName    = getCurrentPropertyName();
  const propConfig  = (typeof getActivePropertyConfig === 'function') ? getActivePropertyConfig() : ((typeof getPropertyConfig === 'function') ? getPropertyConfig() : {});

  const addressLine = propConfig.address || [propConfig.suburb, propConfig.state].filter(Boolean).join(', ') || '';

  const headerColors = { assignment: '#1a4f3a', reminder: '#7a3a00', cancellation: '#5a1a1a' };
  const pillLabels   = { assignment: 'Clean assignment', reminder: 'Reminder', cancellation: 'Cancellation' };
  const color = headerColors[type] || '#1a4f3a';
  const pill  = pillLabels[type]   || 'Notification';

  const cleanerFirst = (vars.cleanerName || 'there').split(' ')[0];

  const subjects = {
    assignment:   `Clean assignment — ${propName}, ${vars.cleanDate || vars.checkout || ''}`,
    reminder:     `Reminder: ${propName} clean tomorrow, ${vars.cleanDate || vars.checkout || ''}`,
    cancellation: `Clean cancelled — ${propName}, ${vars.cleanDate || vars.checkout || ''}`
  };
  const subject = subjects[type] || subjects.assignment;

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
  rows = rows.replace(/border-bottom:1px solid #f0ede8([^"]*)"([^>]*)>(?![\s\S]*border-bottom:1px solid #f0ede8)/g, (m) => m.replace('border-bottom:1px solid #f0ede8', 'border-bottom:none'));

  const intros = {
    assignment:   `A cleaning assignment has been scheduled for you at ${propName}. Sign in to StayOps to view your assignment.`,
    reminder:     `This is a reminder that your cleaning assignment at ${propName} is scheduled for tomorrow. Sign in to StayOps to view details in the app.`,
    cancellation: `Please be advised that the following cleaning assignment has been cancelled. No action is required on your part.`
  };

  const noteHtml = (type === 'reminder' && vars.checkinTime)
    ? `<div style="font-size:12px;color:#5a4a2a;line-height:1.55;margin-bottom:16px;padding:10px 14px;background:#fef9f0;border-left:3px solid #e89020;border-radius:0 6px 6px 0">The property must be ready by ${vars.checkinTime}. Please allow sufficient time for a full turnaround.</div>`
    : '';

  const ctaHtml = type === 'assignment'
    ? `<p style="font-size:13px;color:#444;margin:0 0 14px;line-height:1.55">Open StayOps and sign in with your email to accept or decline this clean.</p>
        <a href="${vars.cleanerLink||'#'}" style="display:block;background:#1a4f3a;color:white;text-align:center;padding:13px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px">Open StayOps</a>`
    : type === 'reminder'
    ? `<p style="font-size:13px;color:#444;margin:0 0 14px;line-height:1.55">Open StayOps and sign in with your email to view this assignment.</p>
        <a href="${vars.cleanerLink||'#'}" style="display:block;background:#7a3a00;color:white;text-align:center;padding:13px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px;margin-bottom:4px">Open StayOps</a>`
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
    type === 'assignment' ? 'Open StayOps and sign in with your email to accept or decline this clean.' : undefined,
    type === 'reminder' ? 'Open StayOps and sign in with your email to view this assignment.' : undefined,
  ].filter(l => l !== undefined).join('\n');

  return { subject, html, text: textLines };
}

export async function sendCleanerEmail({ cleanerName, cleanerEmail, guestName, checkin, checkout, cleanerLink, cleanDate, type, guests, nights, checkoutTime, checkinTime, nextGuestName, nextGuests, windowHours }) {
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
    const DB = globalThis.DB;
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

export async function testNotificationConfig() {
  _setConnectionCheckResult('conn-notif-result', 'loading', 'Checking notification/email configuration…');

  const ownerEmail = (getCurrentHostEmail() || '').trim();
  const pushFunctionUrl = (getPushFunctionUrl() || '').trim();
  const pushSupported = ('Notification' in window);
  const perm = pushSupported ? Notification.permission : 'unsupported';
  const hostSub = getHostSub();

  const checks = [];
  if (ownerEmail) checks.push('Owner email configured');
  if (pushFunctionUrl) checks.push('Push function URL configured');
  if (pushSupported) checks.push('Browser supports notifications');
  if (perm === 'granted' && hostSub) checks.push('Push enabled on this device');

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
    : (perm === 'granted' && hostSub)
      ? 'push ready on this device'
      : 'push not enabled on this device yet';

  _setConnectionCheckResult('conn-notif-result', 'ok', `✅ ${mode}: email/push prerequisites look valid (${pushMsg}).`);
}

export async function testCleanerEmail() {
  const resultEl = document.getElementById('email-test-result');
  if (resultEl) { resultEl.style.display = 'block'; resultEl.style.background = 'var(--warm)'; resultEl.style.color = 'var(--text-soft)'; resultEl.textContent = 'Sending…'; }
  const cleaners = loadCleaners().filter(c => c.email);
  if (!cleaners.length) {
    if (resultEl) { resultEl.style.background = '#FEF2F2'; resultEl.style.color = 'var(--red)'; resultEl.textContent = '⚠ Add an email to at least one team member first (Settings → Property → Team)'; }
    return;
  }
  const c = cleaners[0];
  const testTo = getCurrentHostEmail() || c.email;
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

export function cleanerLinkForId(c) {
  const base = window.location.origin + window.location.pathname;
  const uid = window._supabaseUser ? window._supabaseUser.id : '';
  return c.pin
    ? (base + '?role=cleaner&id=' + encodeURIComponent(c.id) + '&p=' + encodeURIComponent(btoa(c.pin)) + '&uid=' + encodeURIComponent(uid) + '#cleaner/' + c.id + '/' + btoa(c.pin))
    : (base + '?role=cleaner&id=' + encodeURIComponent(c.id) + '&uid=' + encodeURIComponent(uid) + '#cleaner/' + c.id);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(e => console.warn('SW register failed:', e));
}
