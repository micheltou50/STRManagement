/**
 * StayOps — Admin module
 * Only accessible to micheltou50@gmail.com (hardcoded owner check).
 * Provides notification toggles, email template previews, notification logs, and push device management.
 */
import { saveAppConfigToCloud, getCurrentSupabaseUser } from './supabase.js';
import { getActivePropertyConfig } from './config.js';

const ADMIN_EMAIL = 'micheltou50@gmail.com';

/* ── Default notification_config ─────────────────────────────────────────── */
const DEFAULT_CONFIG = {
  push_checkin:          true,
  push_checkout:         true,
  push_unassigned_clean: true,
  push_no_response:      true,
  push_review_cost:      true,
  push_monthly_summary:  true,
  push_cleaner_confirm:  true,
  push_cleaner_decline:  true,
  push_clean_done:       true,
  notif_assignment:      true,
  email_reminder:        true,
  email_cancellation:    false,
};

/* ── In-memory config (hydrated from _appConfig on first render) ────────── */
let notifConfig = null;

function getNotifConfig() {
  if (notifConfig) return notifConfig;
  notifConfig = { ...DEFAULT_CONFIG, ...(window._appConfig && window._appConfig.notification_config) };
  return notifConfig;
}

export function getNotificationConfig() {
  return getNotifConfig();
}

export function isNotifEnabled(key) {
  const cfg = getNotifConfig();
  return cfg[key] !== false;
}

async function persistConfig() {
  window._appConfig = window._appConfig || {};
  window._appConfig.notification_config = { ...notifConfig };
  await saveAppConfigToCloud({ notification_config: notifConfig });
}

/* ── Access guard ────────────────────────────────────────────────────────── */
export async function isAdmin() {
  try {
    const user = await getCurrentSupabaseUser();
    return user && user.email === ADMIN_EMAIL;
  } catch { return false; }
}

export function isAdminSync() {
  try {
    if (window._supabaseUser && window._supabaseUser.email === ADMIN_EMAIL) return true;
    if (window._sb && window._sb.auth) {
      const session = window._sb.auth.session && window._sb.auth.session();
      if (session && session.user && session.user.email === ADMIN_EMAIL) return true;
    }
  } catch { /* ignore */ }
  return false;
}

/* ── TOGGLE DEFINITIONS ─────────────────────────────────────────────────── */
const TOGGLE_GROUPS = [
  {
    header: 'Push Notifications',
    toggles: [
      { key: 'push_checkin',          label: 'Check-in Today',           desc: 'Owner push — daily cron at 7 AM AEST', channel: 'push' },
      { key: 'push_checkout',         label: 'Checkout Today',           desc: 'Owner push — daily cron at 7 AM AEST', channel: 'push' },
      { key: 'push_unassigned_clean', label: 'Unassigned Clean Alert',   desc: 'Owner push — daily cron, within 48h', channel: 'push' },
      { key: 'push_no_response',      label: 'No Cleaner Response',      desc: 'Owner push — daily cron, 12h+ since assigned', channel: 'push' },
      { key: 'push_review_cost',      label: 'Review Cleaning Cost',     desc: 'Owner push — daily cron, clean done without fee', channel: 'push' },
      { key: 'push_monthly_summary',  label: 'Revenue + Portfolio Summary', desc: 'Owner push — 1st of each month', channel: 'push' },
    ],
  },
  {
    header: 'Cleaner Events',
    toggles: [
      { key: 'push_cleaner_confirm',  label: 'Cleaner Confirmed',  desc: 'Owner push — fired when cleaner accepts', channel: 'push' },
      { key: 'push_cleaner_decline',  label: 'Cleaner Declined',   desc: 'Owner push — fired when cleaner declines', channel: 'push' },
      { key: 'push_clean_done',       label: 'Clean Completed',    desc: 'Owner push — fired when cleaner marks done', channel: 'push' },
    ],
  },
  {
    header: 'Cleaner Emails',
    toggles: [
      { key: 'notif_assignment',   label: 'Assignment Email + Push', desc: 'Sent to cleaner on assignment', channel: 'both' },
      { key: 'email_reminder',     label: '24h Reminder Email',      desc: 'Automatic reminder 24h before clean (10 PM UTC)', channel: 'email' },
      { key: 'email_cancellation', label: 'Cancellation Email',      desc: 'Notifies cleaner when booking cancelled', channel: 'email' },
    ],
  },
];

/* ── TEMPLATE DEFINITIONS ─────────────────────────────────────────────── */
const TEMPLATES = [
  { id: 'assignment',    name: 'Assignment',         color: '#1E3A2F', subject: 'New clean assigned — {{guest_name}}' },
  { id: 'reminder',      name: 'Reminder',           color: '#E65100', subject: '⏰ Reminder: Clean tomorrow — {{guest_name}}' },
  { id: 'cancellation',  name: 'Cancellation',       color: '#C0392B', subject: '❌ Booking cancelled — {{guest_name}}' },
  { id: 'owner_push',    name: 'Push + Email (Owner)', color: '#8FAF85', subject: 'Auto-generated from push notification content', readonly: true },
];

const TEMPLATE_VARS = ['{{cleaner_name}}', '{{guest_name}}', '{{checkin}}', '{{checkout}}', '{{clean_date}}', '{{cleaner_link}}'];

/* ── SCHEDULED JOBS INFO ─────────────────────────────────────────────── */
const CRON_JOBS = [
  { icon: '⏰', name: 'Daily Notifications',  time: 'Cron: 0 21 * * * (21:00 UTC → 7 AM AEST)', bg: '#e8f5e9', fg: '#2e7d32' },
  { icon: '📧', name: 'Clean Reminders',      time: 'Cron: 0 22 * * * (22:00 UTC → 8 AM AEST)', bg: '#fff3e0', fg: '#e65100' },
  { icon: '📊', name: 'Monthly Revenue',       time: 'Cron: 0 21 1 * * (1st of month, 21:00 UTC)', bg: '#e3f2fd', fg: '#1565c0' },
  { icon: '📬', name: 'Gmail Polling',         time: 'Edge Function: */30 * * * * (every 30 min)', bg: '#f3e5f5', fg: '#7b1fa2' },
];

/* ── Helpers ──────────────────────────────────────────────────────────── */
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function channelDot(channel) {
  if (channel === 'push')  return '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--moss);margin-right:4px;vertical-align:middle" title="Push"></span>';
  if (channel === 'email') return '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--amber);margin-right:4px;vertical-align:middle" title="Email"></span>';
  if (channel === 'both')  return '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--moss);margin-right:4px;vertical-align:middle" title="Push"></span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--amber);margin-right:4px;vertical-align:middle" title="Email"></span>';
  return '';
}

function pillHtml(on) {
  return on
    ? '<span class="admin-pill admin-pill-on">Active</span>'
    : '<span class="admin-pill admin-pill-off">Disabled</span>';
}

/* ── RENDER: Tab switcher ────────────────────────────────────────────── */
let activeAdminTab = 'toggles';

export function switchAdminTab(tab, btn) {
  activeAdminTab = tab;
  document.querySelectorAll('#admin-tab-bar button').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.querySelectorAll('.admin-tab-content').forEach(s => s.style.display = 'none');
  const el = document.getElementById('admin-tab-' + tab);
  if (el) el.style.display = 'block';
  // Lazy-load log and devices tabs
  if (tab === 'logs') renderLogTab();
  if (tab === 'devices') renderDevicesTab();
}

/* ── RENDER: Main ────────────────────────────────────────────────────── */
export function renderAdmin() {
  const sec = document.getElementById('section-admin');
  if (!sec) return;
  const cfg = getNotifConfig();

  sec.innerHTML = `
    <div class="admin-header">
      <a class="admin-back-link" onclick="showSection('property')">&#8249; Back</a>
      <h1 class="admin-title">Admin</h1>
      <p class="admin-subtitle">NOTIFICATION &amp; EMAIL CONTROL</p>
    </div>
    <div class="admin-tab-bar" id="admin-tab-bar">
      <button class="${activeAdminTab === 'toggles' ? 'active' : ''}" onclick="switchAdminTab('toggles', this)">Toggles</button>
      <button class="${activeAdminTab === 'templates' ? 'active' : ''}" onclick="switchAdminTab('templates', this)">Templates</button>
      <button class="${activeAdminTab === 'logs' ? 'active' : ''}" onclick="switchAdminTab('logs', this)">Activity</button>
      <button class="${activeAdminTab === 'devices' ? 'active' : ''}" onclick="switchAdminTab('devices', this)">Devices</button>
    </div>
    <div id="admin-tab-toggles" class="admin-tab-content" style="display:${activeAdminTab === 'toggles' ? 'block' : 'none'}">
      ${renderTogglesTab(cfg)}
    </div>
    <div id="admin-tab-templates" class="admin-tab-content" style="display:${activeAdminTab === 'templates' ? 'block' : 'none'}">
      ${renderTemplatesTab()}
    </div>
    <div id="admin-tab-logs" class="admin-tab-content" style="display:${activeAdminTab === 'logs' ? 'block' : 'none'}">
      <div style="text-align:center;padding:40px 16px;color:var(--text-soft);font-size:13px">Loading activity log...</div>
    </div>
    <div id="admin-tab-devices" class="admin-tab-content" style="display:${activeAdminTab === 'devices' ? 'block' : 'none'}">
      <div style="text-align:center;padding:40px 16px;color:var(--text-soft);font-size:13px">Loading devices...</div>
    </div>
  `;

  // If log or devices tab is already active, render them now
  if (activeAdminTab === 'logs') renderLogTab();
  if (activeAdminTab === 'devices') renderDevicesTab();
}

/* ── RENDER: Toggles tab ──────────────────────────────────────────────── */
function renderTogglesTab(cfg) {
  let html = `
    <div class="admin-info-banner">
      <div class="admin-info-icon">🔔</div>
      <div class="admin-info-text">
        <strong>Control all notifications from here.</strong><br>
        Disabling a toggle stops that notification type immediately. Email templates remain saved.
      </div>
    </div>
  `;

  TOGGLE_GROUPS.forEach(group => {
    html += `<div class="admin-section-header">${esc(group.header)}</div><div class="card">`;
    group.toggles.forEach(t => {
      const on = cfg[t.key] !== false;
      html += `
        <div class="admin-toggle-row">
          <div class="admin-toggle-info">
            <div class="admin-toggle-label">${channelDot(t.channel)}${esc(t.label)} ${pillHtml(on)}</div>
            <div class="admin-toggle-desc">${esc(t.desc)}</div>
          </div>
          <label class="ios-toggle">
            <input type="checkbox" ${on ? 'checked' : ''} onchange="adminHandleToggle('${t.key}', this)">
            <span class="slider"></span>
          </label>
        </div>`;
    });
    html += '</div>';
  });

  // Scheduled Jobs (informational)
  html += '<div class="admin-section-header">Scheduled Jobs</div><div class="card">';
  CRON_JOBS.forEach(j => {
    html += `
      <div class="admin-schedule-card">
        <div class="admin-schedule-icon" style="background:${j.bg};color:${j.fg}">${j.icon}</div>
        <div class="admin-schedule-info">
          <div class="admin-schedule-name">${esc(j.name)}</div>
          <div class="admin-schedule-time">${esc(j.time)}</div>
        </div>
        <span class="admin-pill admin-pill-on">Running</span>
      </div>`;
  });
  html += '</div>';

  return html;
}

/* ── RENDER: Templates tab ────────────────────────────────────────────── */
function renderTemplatesTab() {
  const propCfg = getActivePropertyConfig();
  const propName = (propCfg && propCfg.name) || 'Your Property';

  let html = `
    <div class="admin-info-banner">
      <div class="admin-info-icon">✉️</div>
      <div class="admin-info-text">
        <strong>Preview &amp; edit cleaner email templates.</strong><br>
        Variables like <code style="background:rgba(255,255,255,0.2);padding:1px 4px;border-radius:3px;font-size:11px">{{guest_name}}</code> are replaced with real data when sent.
      </div>
    </div>
    <div class="admin-template-list">
  `;

  TEMPLATES.forEach((t, i) => {
    const expanded = i === 0;
    html += `
      <div class="admin-template-card ${expanded ? 'expanded' : ''}" onclick="adminToggleTemplate(this)">
        <div class="admin-template-header">
          <div style="display:flex;align-items:center;gap:10px">
            <div class="admin-type-dot" style="background:${t.color}"></div>
            <div>
              <div class="admin-type-name">${esc(t.name)}</div>
              <div class="admin-type-subject">${esc(t.subject)}</div>
            </div>
          </div>
          <span class="admin-chevron">&#8250;</span>
        </div>
        <div class="admin-template-preview">
          ${renderEmailPreview(t, propName)}
          <div class="admin-template-actions">
            ${t.readonly
              ? '<button class="admin-btn-test" style="flex:1" onclick="event.stopPropagation()">ℹ️ Auto-generated (not editable)</button>'
              : `<button class="admin-btn-edit" onclick="event.stopPropagation(); openEmailTemplatePanel('${t.id}')">Edit Template</button>
                 <button class="admin-btn-test" onclick="event.stopPropagation(); adminSendTestEmail('${t.id}')">Send Test</button>`
            }
          </div>
        </div>
      </div>`;
  });

  html += '</div>';

  // Template Variables reference
  html += `
    <div class="card" style="margin-top:12px">
      <div style="font-family:'DM Serif Display',serif;font-size:15px;color:var(--forest);margin-bottom:4px">Template Variables</div>
      <div style="font-size:12px;color:var(--text-soft);margin-bottom:12px">Available placeholders for cleaner emails</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${TEMPLATE_VARS.map(v => `<code style="background:var(--mist);padding:4px 8px;border-radius:6px;font-size:11px;color:var(--forest)">${esc(v)}</code>`).join('')}
      </div>
    </div>`;

  return html;
}

function renderEmailPreview(t, propName) {
  if (t.id === 'assignment') {
    return `<div class="admin-ep-frame">
      <div class="admin-ep-header" style="background:${t.color}">${esc(propName)}<div class="admin-ep-pill">Clean assignment</div></div>
      <div class="admin-ep-body">
        <p style="margin-bottom:10px">Hi <strong>Maria</strong>,</p>
        <p style="margin-bottom:12px">A new clean has been scheduled for you. Here are the details:</p>
        <div class="admin-ep-row"><span class="admin-ep-label">Guest</span><span class="admin-ep-value">James Wilson</span></div>
        <div class="admin-ep-row"><span class="admin-ep-label">Check-in</span><span class="admin-ep-value">15 Apr 2026</span></div>
        <div class="admin-ep-row"><span class="admin-ep-label">Checkout</span><span class="admin-ep-value">18 Apr 2026</span></div>
        <div class="admin-ep-row"><span class="admin-ep-label">Clean Date</span><span class="admin-ep-value">15 Apr 2026</span></div>
        <a class="admin-ep-cta" style="background:${t.color}" href="#">View in StayOps</a>
      </div>
      <div class="admin-ep-footer">Sent by StayOps</div>
    </div>`;
  }
  if (t.id === 'reminder') {
    return `<div class="admin-ep-frame">
      <div class="admin-ep-header" style="background:${t.color}">${esc(propName)}<div class="admin-ep-pill">Reminder</div></div>
      <div class="admin-ep-body">
        <p style="margin-bottom:10px">Hi <strong>Maria</strong>,</p>
        <p style="margin-bottom:12px">Just a reminder — you have a clean scheduled for tomorrow.</p>
        <div class="admin-ep-row"><span class="admin-ep-label">Guest</span><span class="admin-ep-value">Sarah Chen</span></div>
        <div class="admin-ep-row"><span class="admin-ep-label">Clean Date</span><span class="admin-ep-value">16 Apr 2026</span></div>
        <div class="admin-ep-row"><span class="admin-ep-label">Check-in</span><span class="admin-ep-value">16 Apr 2026</span></div>
        <a class="admin-ep-cta" style="background:${t.color}" href="#">View in StayOps</a>
      </div>
      <div class="admin-ep-footer">Sent automatically by StayOps</div>
    </div>`;
  }
  if (t.id === 'cancellation') {
    return `<div class="admin-ep-frame">
      <div class="admin-ep-header" style="background:${t.color}">${esc(propName)}<div class="admin-ep-pill">Cancellation</div></div>
      <div class="admin-ep-body">
        <p style="margin-bottom:10px">Hi <strong>Maria</strong>,</p>
        <p style="margin-bottom:12px">The following booking has been cancelled. Your scheduled clean is no longer needed.</p>
        <div class="admin-ep-row"><span class="admin-ep-label">Guest</span><span class="admin-ep-value">Tom Richards</span></div>
        <div class="admin-ep-row"><span class="admin-ep-label">Was Due</span><span class="admin-ep-value">20 Apr 2026</span></div>
      </div>
      <div class="admin-ep-footer">Sent by StayOps</div>
    </div>`;
  }
  if (t.id === 'owner_push') {
    return `<div class="admin-ep-frame">
      <div class="admin-ep-header" style="background:#1E3A2F">Stay<span style="color:#8FAF85;font-style:italic">Ops</span><div class="admin-ep-pill">Notification</div></div>
      <div class="admin-ep-body">
        <p style="margin-bottom:10px"><strong>🏠 Check-in Today — ${esc(propName)}</strong></p>
        <p style="margin-bottom:12px">James Wilson checks in today (3 guests, 3 nights). Checkout time is 10:00 AM.</p>
        <a class="admin-ep-cta" style="background:#1E3A2F" href="#">Open StayOps</a>
      </div>
      <div class="admin-ep-footer">You're receiving this because push + email fallback is enabled</div>
    </div>`;
  }
  return '';
}

/* ── RENDER: Activity Log tab ─────────────────────────────────────────── */
async function renderLogTab() {
  const container = document.getElementById('admin-tab-logs');
  if (!container) return;

  container.innerHTML = `
    <div class="admin-info-banner">
      <div class="admin-info-icon">📋</div>
      <div class="admin-info-text">
        <strong>Recent notification activity.</strong><br>
        Pulled from the <code style="background:rgba(255,255,255,0.2);padding:1px 4px;border-radius:3px;font-size:11px">notification_log</code> table. Shows the last 7 days.
      </div>
    </div>
    <div style="text-align:center;padding:24px;color:var(--text-soft);font-size:13px">Loading...</div>
  `;

  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !window._sb) { container.innerHTML += '<div class="card">Could not load logs.</div>'; return; }

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: logs, error } = await window._sb
      .from('notification_log')
      .select('*')
      .gte('sent_at', since)
      .order('sent_at', { ascending: false })
      .limit(100);

    if (error) { container.innerHTML = '<div class="card">Error loading logs: ' + esc(error.message) + '</div>'; return; }

    if (!logs || !logs.length) {
      container.innerHTML = `
        <div class="admin-info-banner">
          <div class="admin-info-icon">📋</div>
          <div class="admin-info-text"><strong>Recent notification activity.</strong><br>Shows the last 7 days.</div>
        </div>
        <div class="card" style="text-align:center;padding:24px;color:var(--text-soft)">No notifications logged in the last 7 days.</div>`;
      return;
    }

    // Group by day
    const groups = {};
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();
    logs.forEach(log => {
      const d = new Date(log.sent_at);
      let label = d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
      if (d.toDateString() === today) label = 'Today';
      else if (d.toDateString() === yesterday) label = 'Yesterday';
      if (!groups[label]) groups[label] = [];
      groups[label].push(log);
    });

    let html = `
      <div class="admin-info-banner">
        <div class="admin-info-icon">📋</div>
        <div class="admin-info-text"><strong>Recent notification activity.</strong><br>Shows the last 7 days.</div>
      </div>`;

    const LOG_DOT_COLORS = {
      checkin_today:        'var(--moss)',
      checkout_today:       'var(--moss)',
      unassigned_clean:     'var(--amber)',
      no_response:          'var(--red)',
      review_cleaning_cost: 'var(--sage)',
      monthly_summary:      '#7b1fa2',
      clean_reminder:       '#E65100',
      assignment:           'var(--forest)',
      cancellation:         'var(--red)',
      cleaner_confirmed:    'var(--moss)',
      cleaner_declined:     'var(--red)',
      clean_done:           'var(--sage)',
    };

    for (const [label, entries] of Object.entries(groups)) {
      html += `<div class="card"><div style="font-family:'DM Serif Display',serif;font-size:15px;color:var(--forest);margin-bottom:8px">${esc(label)}</div>`;
      entries.forEach(log => {
        const time = new Date(log.sent_at).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', hour12: true }).toUpperCase();
        const dotColor = LOG_DOT_COLORS[log.type] || 'var(--stone)';
        html += `
          <div class="admin-log-entry">
            <div class="admin-log-dot" style="background:${dotColor}"></div>
            <div class="admin-log-text"><strong>${esc(log.title || log.type || 'Notification')}</strong>${log.body ? ' — ' + esc(log.body.substring(0, 80)) : ''}</div>
            <div class="admin-log-time">${time}</div>
          </div>`;
      });
      html += '</div>';
    }

    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = '<div class="card">Error: ' + esc(e.message) + '</div>';
  }
}

/* ── RENDER: Devices tab ──────────────────────────────────────────────── */
async function renderDevicesTab() {
  const container = document.getElementById('admin-tab-devices');
  if (!container) return;

  container.innerHTML = `
    <div class="admin-info-banner">
      <div class="admin-info-icon">📱</div>
      <div class="admin-info-text">
        <strong>Push subscription endpoints &amp; email status.</strong><br>
        Stale devices are auto-removed when push delivery fails.
      </div>
    </div>
    <div style="text-align:center;padding:24px;color:var(--text-soft);font-size:13px">Loading...</div>
  `;

  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !window._sb) { container.innerHTML += '<div class="card">Could not load device info.</div>'; return; }

    const { data: row, error } = await window._sb
      .from('app_config')
      .select('push_subscriptions')
      .eq('user_id', user.id)
      .maybeSingle();

    if (error) { container.innerHTML = '<div class="card">Error: ' + esc(error.message) + '</div>'; return; }

    const subs = (row && Array.isArray(row.push_subscriptions)) ? row.push_subscriptions : [];
    const ownerEmail = user.email || '—';

    // Check Resend API status
    let resendStatus = 'Unknown';
    try {
      const res = await fetch('/.netlify/functions/send-push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '__ping', subscription: { endpoint: 'https://test', keys: { p256dh: 'x', auth: 'x' } } }),
      });
      resendStatus = res.status === 500 ? 'VAPID misconfigured' : 'Reachable';
    } catch { resendStatus = 'Unreachable'; }

    let html = `
      <div class="admin-info-banner">
        <div class="admin-info-icon">📱</div>
        <div class="admin-info-text"><strong>Push subscriptions &amp; email fallback.</strong><br>Stale devices are auto-removed on failed delivery.</div>
      </div>
      <div class="admin-section-header">Owner Email Fallback</div>
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px">
          <span style="color:var(--text-soft)">Fallback email</span>
          <strong>${esc(ownerEmail)}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;margin-top:8px;padding-top:8px;border-top:1px solid var(--mist)">
          <span style="color:var(--text-soft)">Send-push endpoint</span>
          <span class="admin-pill ${resendStatus === 'Reachable' ? 'admin-pill-on' : 'admin-pill-off'}">${esc(resendStatus)}</span>
        </div>
      </div>
      <div class="admin-section-header">Push Subscriptions (${subs.length})</div>
    `;

    if (!subs.length) {
      html += '<div class="card" style="text-align:center;padding:20px;color:var(--text-soft);font-size:13px">No push subscriptions registered. Enable notifications from the app to add a device.</div>';
    } else {
      html += '<div class="card">';
      subs.forEach((sub, i) => {
        const endpoint = sub && sub.endpoint ? sub.endpoint : '—';
        const ua = sub && sub.user_agent ? sub.user_agent : '';
        const subscribed = sub && sub.subscribed_at ? new Date(sub.subscribed_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
        const short = endpoint.length > 50 ? endpoint.substring(0, 50) + '...' : endpoint;
        const isStale = sub && sub.subscribed_at && (Date.now() - new Date(sub.subscribed_at).getTime() > 90 * 86400000);
        html += `
          <div style="padding:10px 0;${i > 0 ? 'border-top:1px solid var(--mist)' : ''}">
            <div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:4px">${ua ? esc(ua.substring(0, 40)) : 'Device ' + (i + 1)} ${isStale ? '<span class="admin-pill admin-pill-off" style="font-size:9px">Stale?</span>' : ''}</div>
            <div style="font-size:10px;color:var(--text-soft);word-break:break-all">${esc(short)}</div>
            <div style="font-size:10px;color:var(--text-soft);margin-top:2px">Subscribed: ${esc(subscribed)}</div>
          </div>`;
      });
      html += '</div>';
    }

    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = '<div class="card">Error: ' + esc(e.message) + '</div>';
  }
}

/* ── HANDLERS ─────────────────────────────────────────────────────────── */
export async function adminHandleToggle(key, input) {
  const cfg = getNotifConfig();
  cfg[key] = input.checked;
  notifConfig = cfg;

  // Update pill
  const row = input.closest('.admin-toggle-row');
  if (row) {
    const pill = row.querySelector('.admin-pill');
    if (pill) {
      pill.className = input.checked ? 'admin-pill admin-pill-on' : 'admin-pill admin-pill-off';
      pill.textContent = input.checked ? 'Active' : 'Disabled';
    }
  }

  await persistConfig();
  const label = key.replace(/_/g, ' ').replace(/\bpush\b/, '').replace(/\bemail\b/, '').trim();
  const name = label.charAt(0).toUpperCase() + label.slice(1);
  globalThis.showBanner((input.checked ? '✓ ' : '') + name + (input.checked ? ' enabled' : ' disabled'), input.checked ? 'ok' : 'warn');
}

export function adminToggleTemplate(card) {
  const wasExpanded = card.classList.contains('expanded');
  document.querySelectorAll('.admin-template-card').forEach(c => c.classList.remove('expanded'));
  if (!wasExpanded) card.classList.add('expanded');
}

export async function adminSendTestEmail(templateId) {
  try {
    globalThis.showBanner('Sending test email...', 'ok');
    const DB = globalThis.DB;
    if (!DB || typeof DB.sendEmail !== 'function') {
      globalThis.showBanner('Email service not available', 'warn');
      return;
    }
    const propCfg = getActivePropertyConfig();
    const propName = (propCfg && propCfg.name) || 'Test Property';

    let subject, html;
    if (templateId === 'assignment') {
      subject = 'Test: New clean assigned — Test Guest';
      html = buildTestEmailHtml(propName, '#1E3A2F', 'Clean assignment', 'Maria', 'A new clean has been scheduled for you.', { Guest: 'Test Guest', 'Check-in': '15 Apr 2026', Checkout: '18 Apr 2026', 'Clean Date': '15 Apr 2026' });
    } else if (templateId === 'reminder') {
      subject = 'Test: Reminder — Clean tomorrow';
      html = buildTestEmailHtml(propName, '#E65100', 'Reminder', 'Maria', 'Just a reminder — you have a clean scheduled for tomorrow.', { Guest: 'Test Guest', 'Clean Date': '16 Apr 2026' });
    } else if (templateId === 'cancellation') {
      subject = 'Test: Booking cancelled — Test Guest';
      html = buildTestEmailHtml(propName, '#C0392B', 'Cancellation', 'Maria', 'The following booking has been cancelled. Your scheduled clean is no longer needed.', { Guest: 'Test Guest', 'Was Due': '20 Apr 2026' });
    } else {
      globalThis.showBanner('Cannot test auto-generated template', 'warn');
      return;
    }

    const data = await DB.sendEmail(ADMIN_EMAIL, subject, html, subject);
    if (data && (data.success || data.status === 'ok')) {
      globalThis.showBanner('✉️ Test email sent to ' + ADMIN_EMAIL, 'ok');
    } else {
      globalThis.showBanner('Email send failed', 'warn');
    }
  } catch (e) {
    globalThis.showBanner('Error: ' + e.message, 'warn');
  }
}

function buildTestEmailHtml(propName, color, badge, name, message, details) {
  let rows = '';
  for (const [k, v] of Object.entries(details)) {
    rows += `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f0f0f0;font-size:12px"><span style="color:#999">${esc(k)}</span><span style="font-weight:600">${esc(v)}</span></div>`;
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#F0EDE8;font-family:-apple-system,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F0EDE8;padding:24px 0"><tr><td align="center">
<table width="100%" style="max-width:520px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08)">
  <tr><td style="background:${color};padding:16px;text-align:center;color:white;font-weight:700;font-size:14px">${esc(propName)}<div style="display:inline-block;background:rgba(255,255,255,0.25);padding:2px 10px;border-radius:20px;font-size:10px;font-weight:600;margin-top:6px">${esc(badge)}</div></td></tr>
  <tr><td style="padding:20px 24px">
    <p style="margin:0 0 10px">Hi <strong>${esc(name)}</strong>,</p>
    <p style="margin:0 0 12px;font-size:13px;color:#555">${esc(message)}</p>
    ${rows}
    <a href="https://strmanagement.netlify.app" style="display:block;text-align:center;padding:10px;border-radius:8px;color:white;font-weight:700;font-size:13px;margin-top:12px;text-decoration:none;background:${color}">View in StayOps</a>
  </td></tr>
  <tr><td style="padding:12px 24px;border-top:1px solid #f0f0f0;text-align:center;font-size:10px;color:#aaa">Test email sent by StayOps Admin</td></tr>
</table></td></tr></table></body></html>`;
}
