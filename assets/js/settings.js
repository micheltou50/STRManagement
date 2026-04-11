/**
 * StayOps — settings UI and integrations (Pass 8).
 */
import { getActivePropertyId, getActivePropertyConfig, getCurrentPropertyName, getAllProperties, getPropertyConfigGaps } from './config.js';
import { escHtml, fadeTransition } from './utils.js';
import {
  getCurrentSupabaseUser,
  saveAppConfigToCloud,
  saveCleanersToCloud,
  saveHostConfigToSupabase,
  savePropertyToCloud,
} from './supabase.js';
import { updateNotifStatus, cleanerLinkForId } from './notifications.js';
import { renderPropertySwitcher, populateOwnerReportPanel } from './property.js';
import { reopenPropertySetup } from './setup.js';
import {
  populateCleanerSelect,
  isCleanerPerson,
} from './cleaning.js';
import {
  renderExpenseCatSettings,
  renderClientsList,
  populateMgmtFeePanel,
  _getInvoiceIdentity,
} from './finance.js';
import { renderAIIgnoreList } from './ai.js';
import { renderSmartPricingPanel } from './smart-pricing.js';

function renderConnectionSummary() {
  const wrap = document.getElementById('integrations-conn-list');
  if (!wrap) return;

  const gmailEmail = (window._appConfig && window._appConfig.gmail_email) || '';
  const gmailTokenExpired = !!(window._appConfig && window._appConfig._gmailTokenExpired);
  const gmailConnected = !!gmailEmail && !gmailTokenExpired;

  const outlookEmail = (window._appConfig && window._appConfig.outlook_email) || '';
  const outlookConnected = !!outlookEmail;

  wrap.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:var(--mist);border-radius:10px">
      <div style="font-size:13px;color:var(--text)">Supabase</div>
      <div style="font-size:12px;color:var(--moss)">✓ Connected</div>
    </div>

    <div style="padding:12px;background:var(--mist);border-radius:10px;margin-top:8px">
      <div style="font-size:12px;font-weight:700;color:var(--forest);margin-bottom:6px">📧 Gmail — Booking Import</div>
      ${gmailTokenExpired && gmailEmail ? `
        <div style="font-size:12px;color:var(--red);margin-bottom:8px">⚠ Disconnected — token expired for ${escHtml(gmailEmail)}</div>
        <div style="font-size:11px;color:var(--text-soft);margin-bottom:8px;line-height:1.4">Your Gmail access has expired. Reconnect to resume automatic booking imports.</div>
        <button onclick="connectGmail()"
          style="width:100%;background:var(--forest);color:white;border:none;border-radius:10px;padding:12px;font-size:14px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">🔄 Reconnect Gmail</button>
      ` : gmailConnected ? `
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

    ${_renderCMCard()}`
  ;
}
async function connectGmail() {
  const user = await getCurrentSupabaseUser();
  if (!user) { globalThis.showBanner('⚠ Please sign in first', 'warn'); return; }
  window.location.href = '/.netlify/functions/gmail-oauth-start?state=' + encodeURIComponent(user.id);
}

async function connectOutlook() {
  const user = await getCurrentSupabaseUser();
  if (!user) { globalThis.showBanner('⚠ Please sign in first', 'warn'); return; }
  window.location.href = '/.netlify/functions/outlook-oauth-start?state=' + encodeURIComponent(user.id);
}
async function maybeAutoScanGmail() {
  try {
    const gmailEmail = (window._appConfig && window._appConfig.gmail_email) || '';
    if (!gmailEmail) return; // Gmail not connected
    const user = window._supabaseUser;
    if (!user) return;

    // No throttle — scan runs every time the app is opened

    const _pid = (window._cloudPropertyIds && window._cloudPropertyIds[getActivePropertyId()]) || '';
    const res = await fetch('/.netlify/functions/gmail-scan-bookings?uid=' + encodeURIComponent(user.id) + (_pid ? '&pid=' + encodeURIComponent(_pid) : ''));
    if (!res.ok) {
      if (res.status === 401) {
        globalThis.showBanner('⚠ Gmail disconnected — reconnect in Settings → Integrations', 'warn');
        window._appConfig = window._appConfig || {};
        window._appConfig._gmailTokenExpired = true;
      }
      return;
    }
    const data = await res.json();

    const totalChanges = (data.imported || 0) + (data.updated || 0) + (data.cancelled || 0);
    if (totalChanges > 0) {
      if (typeof hydrateFromCloud === 'function') await globalThis.hydrateFromCloud();
      globalThis.reloadInMemoryData();
      globalThis.renderAll();
      const parts = [];
      if (data.imported) parts.push(data.imported + ' imported');
      if (data.updated) parts.push(data.updated + ' updated');
      if (data.cancelled) parts.push(data.cancelled + ' cancelled');
      globalThis.showBanner('✓ ' + parts.join(', ') + ' from Gmail', 'ok');
    }
    await globalThis.processScanNeedsReview(data);
  } catch (e) {
    // Silent — auto-scan errors must never surface to the user
    console.warn('[gmail-auto-scan] background scan error:', e.message);
  }
}

async function scanGmailBookings() {
  const user = window._supabaseUser;
  if (!user) { globalThis.showBanner('⚠ Please sign in first', 'warn'); return; }

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
      if (res.status === 401) {
        window._appConfig = window._appConfig || {};
        window._appConfig._gmailTokenExpired = true;
        renderConnectionSummary();
      }
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
      if (typeof hydrateFromCloud === 'function') await globalThis.hydrateFromCloud();
      globalThis.reloadInMemoryData();
      globalThis.renderAll();
      const parts = [];
      if (data.imported) parts.push(data.imported + ' imported');
      if (data.updated) parts.push(data.updated + ' updated');
      if (data.cancelled) parts.push(data.cancelled + ' cancelled');
      globalThis.showBanner('✓ ' + parts.join(', ') + ' from Gmail', 'ok');
    }

    await globalThis.processScanNeedsReview(data);

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
    const outlookEmail = (window._appConfig && window._appConfig.outlook_email) || '';
    if (!outlookEmail) return; // Outlook not connected
    const user = window._supabaseUser;
    if (!user) return;

    const _pid = (window._cloudPropertyIds && window._cloudPropertyIds[getActivePropertyId()]) || '';
    const res = await fetch('/.netlify/functions/outlook-scan-bookings?uid=' + encodeURIComponent(user.id) + (_pid ? '&pid=' + encodeURIComponent(_pid) : ''));
    if (!res.ok) return;
    const data = await res.json();

    const totalChanges = (data.imported || 0) + (data.updated || 0) + (data.cancelled || 0);
    if (totalChanges > 0) {
      if (typeof hydrateFromCloud === 'function') await globalThis.hydrateFromCloud();
      globalThis.reloadInMemoryData();
      globalThis.renderAll();
      const parts = [];
      if (data.imported) parts.push(data.imported + ' imported');
      if (data.updated) parts.push(data.updated + ' updated');
      if (data.cancelled) parts.push(data.cancelled + ' cancelled');
      globalThis.showBanner('✓ ' + parts.join(', ') + ' from Outlook', 'ok');
    }
    await globalThis.processScanNeedsReview(data);
  } catch (e) {
    console.warn('[outlook-auto-scan] background scan error:', e.message);
  }
}

async function scanOutlookBookings() {
  const user = window._supabaseUser;
  if (!user) { globalThis.showBanner('⚠ Please sign in first', 'warn'); return; }

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
      if (typeof hydrateFromCloud === 'function') await globalThis.hydrateFromCloud();
      globalThis.reloadInMemoryData();
      globalThis.renderAll();
      const parts = [];
      if (data.imported) parts.push(data.imported + ' imported');
      if (data.updated) parts.push(data.updated + ' updated');
      if (data.cancelled) parts.push(data.cancelled + ' cancelled');
      globalThis.showBanner('✓ ' + parts.join(', ') + ' from Outlook', 'ok');
    }

    await globalThis.processScanNeedsReview(data);

  } catch (e) {
    if (statusEl) {
      statusEl.style.background = '#FEF2F2';
      statusEl.style.color = 'var(--red)';
      statusEl.textContent = '⚠ Network error — check connection';
    }
  }

  if (btn) { btn.disabled = false; btn.textContent = '📥 Scan for Bookings'; }
}
const CALENDAR_FEED_PUBLIC_URL = 'https://strmanagement.netlify.app/.netlify/functions/calendar-feed';

async function populateCalendarFeedPanel() {
  const input = document.getElementById('settings-calendar-feed-url');
  const hint = document.getElementById('settings-calendar-feed-unavailable');
  const confirmEl = document.getElementById('settings-calendar-feed-copy-confirm');
  if (confirmEl) confirmEl.style.display = 'none';
  let user = window._supabaseUser;
  if (!user && typeof getCurrentSupabaseUser === 'function') {
    try { user = await getCurrentSupabaseUser(); } catch (e) { user = null; }
  }
  if (input) {
    input.value = user && user.id ? CALENDAR_FEED_PUBLIC_URL + '?user_id=' + encodeURIComponent(user.id) : '';
  }
  if (hint) hint.style.display = user && user.id ? 'none' : 'block';
}

function copyCalendarFeedUrl() {
  const input = document.getElementById('settings-calendar-feed-url') || document.getElementById('calendar-feed-url');
  const btn = document.getElementById('settings-calendar-feed-copy-btn') || document.getElementById('copy-feed-btn');
  const confirmEl = document.getElementById('settings-calendar-feed-copy-confirm');
  if (!input) return;
  const url = String(input.value || '').trim();
  if (!url) {
    if (typeof showBanner === 'function') globalThis.showBanner('⚠ Sign in to copy your calendar feed URL', 'warn');
    return;
  }
  const defaultLabel = btn && btn.id === 'settings-calendar-feed-copy-btn' ? 'Copy URL' : 'Copy';
  const done = () => {
    if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = defaultLabel; }, 2000); }
    if (confirmEl) { confirmEl.style.display = 'block'; setTimeout(() => { confirmEl.style.display = 'none'; }, 2000); }
  };
  navigator.clipboard.writeText(url).then(done).catch(() => {
    input.select();
    try { document.execCommand('copy'); } catch (e) { /* deprecated API, ignore failures */ }
    done();
  });
}
let _connectionSummaryTimer = null;
function refreshConnectionSummarySoon() {
  clearTimeout(_connectionSummaryTimer);
  _connectionSummaryTimer = setTimeout(() => {
    try { renderConnectionSummary(); } catch (e) { console.warn('renderConnectionSummary failed', e); }
  }, 120);
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
  const sec = typeof globalThis.getCurrentSection === 'function' ? globalThis.getCurrentSection() : '';
  if (sec !== 'settings') globalThis.showSection('settings');
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
  fadeTransition(panel, true);
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
    if (el) el.value = ((window._appConfig && window._appConfig.sms_template) || '') || defaultTemplate;
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
    const inv = (window._appConfig && window._appConfig.invoice_details) || {};
    ['name','company','abn','acn','email','address'].forEach(k => {
      const el = document.getElementById('inv-'+k);
      if (el) el.value = inv[k] || '';
    });
  }
  if (panelId === 'bank-details') {
    const bank = (window._appConfig && window._appConfig.bank_details) || {};
    ['name','bsb','acc','bank'].forEach(k => {
      const el = document.getElementById('inv-bank-'+k);
      if (el) el.value = bank[k] || '';
    });
  }
  if (panelId === 'invoice-clients') {
    renderClientsList();
  }
  if (panelId === 'backup') {
    const el = document.getElementById('backup-last-time');
    // TODO: migrate backup metadata to Supabase
    if (el) el.textContent = (window._appConfig && window._appConfig.last_backup) || 'Never';
  }
  if (panelId === 'ai-import') {
    const el = document.getElementById('settings-api-key');
    if (el) el.value = (window._appConfig && window._appConfig.api_key) || '';
  }
  if (panelId === 'smart-pricing') {
    renderSmartPricingPanel();
  }
  if (panelId === 'ai-ignore') {
    renderAIIgnoreList();
  }
  if (panelId === 'app-data') {
    renderStorageViewer();
  }
  if (panelId === 'feel') {
    initFxSettings();
  }
  if (panelId === 'connection-checker') {
    resetConnectionCheckerResults();
  }
  if (panelId === 'calendar-feed') {
    populateCalendarFeedPanel();
  }
  if (panelId === 'integrations') {
    renderConnectionSummary();
  }
  if (panelId === 'cm-mapping') {
    loadCMMapping();
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
function closeSettingsPanel() {
  const panel = document.querySelector('[id^="settings-panel-"]:not([style*="display: none"]):not([style*="display:none"])');
  const returnCat     = panel?.dataset.prevCat;
  const returnPanel   = panel?.dataset.prevPanel;
  const returnSection = panel?.dataset.returnSection;
  const _doClose = () => {
    document.querySelectorAll('[id^="settings-panel-"]').forEach(el => { el.style.display = 'none'; el.style.animation = ''; });
    if (returnPanel)        openSettingsPanel(returnPanel);
    else if (returnCat)     openSettingsCat(returnCat);
    else if (returnSection) globalThis.showSection(returnSection);
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
    if (returnSection) globalThis.showSection(returnSection);
  };
  if (activeCat) {
    activeCat.style.animation = 'settingsCatOut 0.18s cubic-bezier(0.32,0.72,0,1) both';
    setTimeout(_doClose, 170);
  } else {
    _doClose();
  }
}


function renderSettings() {
  // Profile card (host profile)
  const host = getHostProfile();
  const nameEl = document.getElementById('settings-profile-name');
  const companyEl = document.getElementById('settings-profile-company');
  const initialsEl = document.getElementById('settings-profile-initials');
  if (nameEl && companyEl && initialsEl) {
    if (host && host.name) {
      nameEl.textContent = host.name;
      companyEl.textContent = host.company || 'Tap to add company details';
      const parts = String(host.name).trim().split(/\s+/).filter(Boolean);
      const initials = (parts[0] ? parts[0][0] : '') + (parts[1] ? parts[1][0] : '');
      initialsEl.textContent = initials.toUpperCase() || '--';
    } else {
      nameEl.textContent = 'Set up your profile';
      companyEl.textContent = 'Add your company name';
      initialsEl.textContent = '--';
    }
  }

  // Connection status summary (used inside Integrations panel)
  renderConnectionSummary();

  // Quick actions — only show if setup has gaps
  const qaWrap = document.getElementById('settings-quick-actions');
  const fixBtn = document.getElementById('settings-fix-setup-btn');
  const setupGaps = (typeof getPropertyConfigGaps === 'function') ? getPropertyConfigGaps() : [];
  if (qaWrap) qaWrap.style.display = setupGaps.length ? '' : 'none';
  if (fixBtn) fixBtn.onclick = () => { reopenPropertySetup(); };

  // Team count on main menu
  const teamMenuEl = document.getElementById('team-count-row-menu');
  if (teamMenuEl) {
    const cleaners = loadCleaners ? loadCleaners() : [];
    teamMenuEl.textContent = cleaners.length ? cleaners.length + ' people' : 'Cleaners & contractors';
  }

  // Gmail / Outlook status on main menu
  const gmailStatusEl = document.getElementById('gmail-status-row-menu');
  const outlookStatusEl = document.getElementById('outlook-status-row-menu');
  if (gmailStatusEl) {
    const gmailEmail = (window._appConfig && window._appConfig.gmail_email) || '';
    if (gmailEmail) {
      gmailStatusEl.textContent = 'Connected';
      gmailStatusEl.style.color = 'var(--moss)';
    } else {
      gmailStatusEl.textContent = 'Not connected';
      gmailStatusEl.style.color = 'var(--text-soft)';
    }
  }
  if (outlookStatusEl) {
    const outlookEmail = (window._appConfig && window._appConfig.outlook_email) || '';
    if (outlookEmail) {
      outlookStatusEl.textContent = 'Connected';
      outlookStatusEl.style.color = 'var(--moss)';
    } else {
      outlookStatusEl.textContent = 'Not connected';
      outlookStatusEl.style.color = 'var(--text-soft)';
    }
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
function chooseGoogleAccount() {}

function syncToSheet() {}
function clearCacheAndResync() {
  globalThis.showAppModal({
    title: '🗑 Clear booking cache?',
    msg: 'This will clear synced bookings, cleans, notes and expenses, then re-pull from Legacy Sheets.\n\nYour inventory, cleaners, maintenance records and all settings will be kept.',
    confirmText: 'Clear & Re-sync',
    cancelText: 'Cancel'
  }).then(ok => {
    if (!ok) return;
    // Only clear the data that comes from the sheet — preserve everything else
    // TODO: legacy sheet cache clear (localStorage-scoped keys removed in Supabase migration)
    window.location.href = window.location.origin + window.location.pathname;
  });
}
function saveSMSTemplate() {
  const val = document.getElementById('settings-sms-template');
  if (!val) return;
  window._appConfig = window._appConfig || {};
  window._appConfig.sms_template = val.value;
  if (typeof saveAppConfigToCloud === 'function') {
    saveAppConfigToCloud({ sms_template: val.value }).catch(e => console.warn("[StayOps] silent error:", e));
  }
  globalThis.showBanner('✓ SMS template saved', 'ok');
}
function saveGeminiKey() {
  const key = document.getElementById('settings-gemini-key').value.trim();
  if (!key) { globalThis.showBanner('⚠ Could not save: Gemini key is empty', 'warn'); return; }
  localStorage.setItem('gh-gemini-key', key);
  const el = document.getElementById('gemini-key-confirm');
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 2000);
  globalThis.showBanner('✓ Settings saved: Gemini key', 'ok');
}
function saveApiKey() {
  const key = document.getElementById('settings-api-key').value.trim();
  if (!key) { globalThis.showBanner('⚠ Could not save: API key is empty', 'warn'); return; }
  window._appConfig = window._appConfig || {};
  window._appConfig.api_key = key;
  const el = document.getElementById('api-key-confirm');
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 2000);
  globalThis.showBanner('✓ Settings saved: API key', 'ok');
  if (typeof saveAppConfigToCloud === 'function') {
    saveAppConfigToCloud({ anthropic_api_key: key }).catch(e => console.warn("[StayOps] silent error:", e));
  }
}
function getApiKey() {
  return (window._appConfig && window._appConfig.api_key) || '';
}
// ── HOST IDENTITY ─────────────────────────────────────────────────────────────
const HOST_PROFILE_KEY = 'gh-host-profile';

function getHostProfile() {
  try {
    const p = window._hostProfile;
    if (!p || typeof p !== 'object') return null;
    if (!p.hostId) return null;
    return p;
  } catch (e) {
    return null;
  }
}

function saveHostProfile(profile) {
  if (!profile || !profile.hostId) return;
  window._hostProfile = profile;
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
  if (!name) { globalThis.showBanner('⚠ Name is required', 'warn'); return; }
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
  // Store invoice-like identity in app config (Phase 2 staging).
  window._appConfig = window._appConfig || {};
  window._appConfig.invoice_details = {
    ...(window._appConfig.invoice_details || {}),
    name: profile.name || '',
    company: profile.company || '',
    abn: profile.abn || '',
    acn: profile.acn || '',
    email: profile.email || '',
    address: profile.address || '',
  };
  if (typeof saveAppConfigToCloud === 'function') {
    saveAppConfigToCloud({ invoice_details: window._appConfig.invoice_details }).catch(e => console.warn("[StayOps] silent error:", e));
  }

  saveHostProfile(profile);
  renderHostProfileRow();

  // Sync to Supabase
  if (typeof saveHostConfigToSupabase === 'function') {
    saveHostConfigToSupabase(profile).catch(e => console.warn('[StayOps] host config sync failed', e));
  }

  globalThis.showBanner('✓ Host profile saved', 'ok');
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

function loadCleaners() {
  return (window._cleaners || []);
}
function saveCleaners(list) {
  window._cleaners = Array.isArray(list) ? list : [];
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
  if (!name) { globalThis.showBanner('⚠ Please enter a name','warn'); return; }
  if (pin && !/^\d{4}$/.test(pin)) { globalThis.showBanner('⚠ PIN must be exactly 4 digits','warn'); return; }
  const people = loadCleaners();
  people.push({ id: Date.now(), name, phone, email: email || '', pin: pin || '', role });
  saveCleaners(people);
  document.getElementById('new-cleaner-name').value = '';
  document.getElementById('new-cleaner-phone').value = '';
  document.getElementById('new-cleaner-email').value = '';
  document.getElementById('new-cleaner-pin').value = '';
  populateCleanerSelect();
  populateContractorSelect();
  globalThis.showBanner('✓ ' + name + ' added', 'ok');
  if (typeof globalThis.renderOnboardingGuidance === 'function') globalThis.renderOnboardingGuidance();
  // Go back to team list
  openSettingsPanel('team');
}
function deleteCleaner(id) {
  saveCleaners(loadCleaners().filter(c => String(c.id) !== String(id)));
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
    <div class="settings-cat-item" onclick="openCleanerProfile('${c.id}')" ${i===people.length-1?'style="border-bottom:none"':''}>
      <div style="display:flex;align-items:center;gap:12px">
        <div style="width:36px;height:36px;border-radius:50%;background:${roleColors[c.role]||'var(--stone)'};color:white;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;flex-shrink:0">${c.name.charAt(0)}</div>
        <div>
          <div style="font-weight:500;font-size:14px">${c.name}</div>
          <div style="font-size:12px;color:var(--text-soft)">${c.role||'Cleaner'}${c.email?' · '+c.email:c.phone?' · '+c.phone:''}</div>
          <div style="margin-top:6px" onclick="event.stopPropagation()">${typeof window.getInviteButtonHtml === 'function' ? window.getInviteButtonHtml(c) : ''}</div>
        </div>
      </div>
      <div style="color:#C7C7CC;font-size:20px;font-weight:300">›</div>
    </div>`).join('') + `</div>`;
}
function openCleanerProfile(id) {
  const c = loadCleaners().find(x => String(x.id) === String(id));
  if (!c) return;
  const PERM_LABELS = [
    { key: 'firstName',  label: 'Guest first name' },
    { key: 'fullName',   label: 'Full guest name' },
    { key: 'guests',     label: 'Number of guests' },
    { key: 'notes',      label: 'Check-in notes' },
    { key: 'payout',     label: 'Cleaning fee / payout' },
  ];
  const perm = c.permissions || {};
  let inviteHtml = '';
  if (!c.email) {
    inviteHtml = '<div style="font-size:12px;color:#999;font-style:italic">Add an email address to invite this cleaner to the app</div>';
  } else if (c.auth_user_id || c.invitation_status === 'active') {
    inviteHtml = '<span style="font-size:12px;color:#3B6D11;font-weight:700;background:#EAF3DE;padding:6px 10px;border-radius:10px;display:inline-block">✓ Account linked</span>';
  } else {
    const cloudId = c._cloudId || c.cloud_id;
    if (!cloudId) {
      inviteHtml = '<div style="font-size:12px;color:#999;font-style:italic">Save team to sync cleaner before inviting</div>';
    } else if (c.invitation_status === 'invited') {
      inviteHtml = '<button id="invite-btn-' + cloudId + '" onclick="inviteCleaner(\'' + (c._cloudId || c.cloud_id) + '\')" style="font-size:13px;padding:10px 14px;background:transparent;color:var(--forest,#1E3A2F);border:1.5px solid var(--forest,#1E3A2F);border-radius:10px;font-weight:700;cursor:pointer">Resend Invite</button>';
    } else {
      inviteHtml = '<button id="invite-btn-' + cloudId + '" onclick="inviteCleaner(\'' + (c._cloudId || c.cloud_id) + '\')" style="font-size:13px;padding:10px 14px;background:var(--forest,#1E3A2F);color:white;border:none;border-radius:10px;font-weight:700;cursor:pointer">Invite to App</button>';
    }
  }
  const roleColors = {Cleaner:'var(--moss)',Plumber:'#1565C0',Electrician:'#E65100',Landscaper:'#2E7D32',Builder:'#6A1B9A',Handyman:'#00838F',Other:'var(--stone)'};
  document.getElementById('cleaner-profile-content').innerHTML = `
    <div class="card" style="margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px">
        <div style="width:48px;height:48px;border-radius:50%;background:${roleColors[c.role]||'var(--stone)'};color:white;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:700;flex-shrink:0">${c.name.charAt(0)}</div>
        <div style="flex:1">
          <div style="font-weight:700;font-size:17px">${c.name}</div>
          <div style="font-size:12px;color:var(--text-soft)">${c.role||'Cleaner'}</div>
        </div>
        <button onclick="deleteCleaner('${c.id}')" style="background:none;border:none;color:var(--red);font-size:13px;cursor:pointer;padding:4px 8px">Remove</button>
      </div>
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-soft);margin-bottom:10px">Contact</div>
      <label>Mobile</label>
      <input type="tel" id="cp-phone-${c.id}" value="${c.phone||''}" placeholder="e.g. 0412 345 678">
      <label>Email</label>
      <input type="email" id="cp-email-${c.id}" value="${c.email||''}" placeholder="e.g. ${c.name.toLowerCase()}@email.com">
      <button class="btn-secondary" onclick="saveCleanerContact('${c.id}')" style="margin-top:4px">Save Contact</button>
      <div id="cp-contact-confirm-${c.id}" style="font-size:12px;color:var(--moss);margin-top:4px;display:none">✓ Saved</div>
    </div>
    <div class="card" style="margin-bottom:10px">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-soft);margin-bottom:10px">Invite to App</div>
      ${inviteHtml}
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
  const c = list.find(x => String(x.id) === String(id));
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
function populateContractorSelect() {
  const people = loadCleaners();
  const sel = document.getElementById('maint-contractor-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">None</option>' + people.map(c => `<option value="${c.name}">${c.name} (${c.role||'Cleaner'})</option>`).join('');
}
function renderStorageViewer() {
  const el = document.getElementById('storage-viewer');
  if (!el) return;
  // Only show the meaningful data keys: bookings, cleans, expenses
  const DATA_KEYS = [];
  el.innerHTML = DATA_KEYS.map(k => {
    const val = localStorage.getItem(k);
    let items = [];
    let count = 0;
    try { items = JSON.parse(val || '[]'); count = Array.isArray(items) ? items.length : 0; } catch(e) { /* ignore malformed localStorage JSON */ }
    const label = k.endsWith('bookings') ? '🏠 Bookings' : k.endsWith('cleans') ? '🧹 Cleans' : '💰 Expenses';
    return `
    <div style="padding:12px 0;border-bottom:1px solid var(--warm)">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div>
          <div style="font-weight:600;font-size:14px;color:var(--forest)">${label}</div>
          <div style="font-size:12px;color:var(--text-soft);margin-top:2px">${count} record${count!==1?'s':''} stored locally</div>
        </div>
        <button onclick="globalThis.showAppModal({title:'Clear ${label}?',msg:'This removes all locally saved data. Sheet data is unaffected.',confirmText:'Clear',confirmColor:'var(--red)'}).then(ok=>{if(ok){localStorage.removeItem('${k}');renderStorageViewer();globalThis.showBanner('Cleared ${label.replace(/[^a-zA-Z ]/g,'')}','ok');}})" style="font-size:12px;color:var(--red);background:#FEF2F2;border:none;border-radius:8px;padding:5px 10px;cursor:pointer;font-family:'DM Sans',sans-serif;font-weight:600">Clear</button>
      </div>
      ${count > 0 ? `<div style="font-size:11px;color:var(--text-soft);font-family:monospace;margin-top:6px;white-space:pre-wrap;word-break:break-all">${JSON.stringify(items.slice(0,1), null, 1).substring(0, 100)}${count > 1 ? '\n...' : ''}</div>` : ''}
    </div>`;
  }).join('');
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
let swipeStartX = 0, swipeStartY = 0, swipeActive = false;
const EDGE_ZONE = 30, MIN_SWIPE = 60;

function isSubScreenOpen() {
  // A settings cat or panel is open (not the main menu)
  const sec = typeof globalThis.getCurrentSection === 'function' ? globalThis.getCurrentSection() : '';
  if (sec !== 'settings') return false;
  const sm = document.getElementById('settings-menu');
  if (sm && sm.style.display !== 'none' && sm.offsetParent !== null) return false; // main menu visible = not a sub-screen
  return !!document.querySelector('[id^="settings-cat-"]:not([style*="display:none"]):not([style*="display: none"])') ||
         !!document.querySelector('[id^="settings-panel-"]:not([style*="display:none"]):not([style*="display: none"])');
}

/** Register swipe-from-left-edge to go back inside Settings (main.js calls this from finishAppInit). */
function initSettingsSwipeBack() {
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
      const openPanel = document.querySelector('[id^="settings-panel-"]:not([style*="display:none"]):not([style*="display: none"])');
      if (openPanel) closeSettingsPanel();
      else closeSettingsCat();
    }
  }, { passive:true });
}
function getAutoAssignCleaner() {
  const v = window._appConfig && window._appConfig.auto_assign_cleaner;
  return v === undefined ? true : !!v;
}

function toggleAutoAssignCleaner() {
  const current = getAutoAssignCleaner();
  const newVal = !current;
  window._appConfig = window._appConfig || {};
  window._appConfig.auto_assign_cleaner = newVal;
  if (typeof saveAppConfigToCloud === 'function') {
    saveAppConfigToCloud({ auto_assign_cleaner: newVal }).catch(e => console.warn("[StayOps] silent error:", e));
  }
  _renderAutoAssignToggle();
  globalThis.showBanner(newVal ? '✓ Auto-assign enabled' : '✓ Auto-assign disabled', 'ok');
}

function _renderAutoAssignToggle() {
  const on = getAutoAssignCleaner();
  const track = document.getElementById('auto-assign-toggle');
  const thumb = document.getElementById('auto-assign-thumb');
  if (track) track.style.background = on ? 'var(--forest)' : 'var(--border)';
  if (thumb) thumb.style.transform = on ? 'translateX(18px)' : 'translateX(0)';
}

// ── END AUTO-ASSIGN TOGGLE ────────────────────────────────────────────────────


function resetConnectionCheckerResults() {
  const el = document.getElementById('conn-notif-result');
  if (el) el.style.display = 'none';
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
    <div class="settings-cat-item" onclick="openCleanerProfile('${c.id}')" ${i===cleaners.length-1?'style="border-bottom:none"':''}>
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
        <div style="width:36px;height:36px;border-radius:10px;background:var(--warm);display:flex;align-items:center;justify-content:center;flex-shrink:0"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1E3A2F" stroke-width="1.5"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="17" y1="11" x2="23" y2="11"/></svg></div>
        <div style="font-weight:500;font-size:14px;color:var(--forest)">Add Person</div>
      </div>
      <div style="color:#C7C7CC;font-size:20px;font-weight:300">›</div>
    </div>
  </div>`;
}
function saveCleanerPinById(id) {
  const input = document.getElementById('pin-input-' + id);
  if (!input) return;
  const val = input.value.trim();
  if (!val || !/^\d{4}$/.test(val)) { globalThis.showBanner('⚠ Please enter exactly 4 digits', 'warn'); return; }
  const list = loadCleaners();
  const c = list.find(x => String(x.id) === String(id));
  if (!c) return;
  c.pin = val; input.value = '';
  saveCleaners(list);
  renderCleanerAccessList();
  globalThis.showBanner('✓ PIN saved for ' + c.name, 'ok');
}
async function clearCleanerPinById(id) {
  const list = loadCleaners();
  const c = list.find(x => String(x.id) === String(id));
  if (!c) return;
  const ok = await globalThis.showAppModal({ title: 'Clear PIN', msg: `Remove PIN for ${c.name}?`, confirmText: 'Clear', confirmColor: 'var(--red)' });
  if (!ok) return;
  delete c.pin;
  localStorage.removeItem('gh-cleaner-authed-' + id);
  saveCleaners(list);
  renderCleanerAccessList();
  globalThis.showBanner('✓ PIN cleared for ' + c.name, 'ok');
}
function saveCleanerPerm(id, key, val) {
  const list = loadCleaners();
  const c = list.find(x => String(x.id) === String(id));
  if (!c) return;
  if (!c.permissions) c.permissions = {};
  c.permissions[key] = val;
  saveCleaners(list);
}
function copyCleanerLinkById(id) {
  const list = loadCleaners();
  const c = list.find(x => String(x.id) === String(id));
  if (!c) return;
  if (!c.pin) { globalThis.showBanner('⚠ Set a PIN for ' + c.name + ' first', 'warn'); return; }
  const url = cleanerLinkForId(c);
  navigator.clipboard.writeText(url).then(() => globalThis.showBanner('✓ Link copied for ' + c.name, 'ok'))
    .catch(() => globalThis.showBanner('⚠ Copy failed — select the link manually', 'warn'));
}

// ── CHANNEL MANAGER ──────────────────────────────────────────────────────────

function _renderCMCard() {
  const cmConnected = window._appConfig && window._appConfig.channel_manager_connected;
  if (cmConnected) {
    const provider = escHtml((window._appConfig.channel_manager_provider || '').toUpperCase());
    const tier = escHtml(window._appConfig.channel_manager_tier || 'self-serve');
    const lastSync = window._appConfig.channel_manager_last_sync;
    const syncError = window._appConfig.channel_manager_sync_error || '';
    let lastSyncFormatted = '';
    if (lastSync) {
      try { lastSyncFormatted = new Date(lastSync).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }); } catch(e) { lastSyncFormatted = lastSync; }
    }
    return `<div style="background:var(--mist);padding:14px 16px;border-radius:10px;margin-top:8px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div style="font-weight:600;font-size:14px">📡 Channel Manager</div>
        <span style="font-size:11px;color:var(--moss)">✓ Connected</span>
      </div>
      <div style="font-size:12px;color:var(--text-soft);margin-bottom:8px">
        Provider: <strong>${provider}</strong> · Tier: <strong>${tier}</strong>
        ${lastSync ? ' · Last sync: ' + lastSyncFormatted : ''}
        ${syncError ? '<br><span style="color:var(--red)">⚠ ' + escHtml(syncError) + '</span>' : ''}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button onclick="syncCMBookings()" class="btn-primary" style="padding:8px 14px;font-size:12px" id="cm-sync-btn">🔄 Sync Now</button>
        <button onclick="openSettingsPanel('cm-mapping')" style="padding:8px 14px;font-size:12px;background:var(--warm);border:none;border-radius:var(--radius-sm);cursor:pointer;font-weight:600;color:var(--forest)">🗺️ Properties</button>
        <button onclick="disconnectCM()" style="padding:8px 14px;font-size:12px;background:none;border:1px solid var(--red);border-radius:var(--radius-sm);cursor:pointer;color:var(--red)">Disconnect</button>
      </div>
    </div>`;
  }
  // Not connected
  return `<div style="background:var(--mist);padding:14px 16px;border-radius:10px;margin-top:8px">
    <div style="font-weight:600;font-size:14px;margin-bottom:4px">📡 Channel Manager</div>
    <div style="font-size:11px;color:var(--text-soft);margin-bottom:12px;line-height:1.5">Sync bookings in real-time across Airbnb, Booking.com, VRBO, and more. No more double bookings.</div>
    <div style="display:flex;gap:8px">
      <button onclick="openSettingsPanel('cm-connect')" class="btn-primary" style="flex:1;padding:10px;font-size:13px">I have an account</button>
      <button onclick="openSettingsPanel('cm-request')" style="flex:1;padding:10px;font-size:13px;background:var(--warm);border:none;border-radius:var(--radius-sm);cursor:pointer;font-weight:600;color:var(--forest)">Set it up for me</button>
    </div>
  </div>`;
}

async function testCMConnection() {
  const user = await getCurrentSupabaseUser();
  if (!user) { globalThis.showBanner('⚠ Please sign in first', 'warn'); return; }

  const provider = document.getElementById('cm-provider')?.value || 'beds24';
  const apiKey = (document.getElementById('cm-api-key')?.value || '').trim();
  if (!apiKey) { globalThis.showBanner('⚠ Please enter your API key', 'warn'); return; }

  const btn = document.getElementById('cm-connect-btn');
  const statusEl = document.getElementById('cm-connect-status');
  if (btn) { btn.disabled = true; btn.textContent = '⟳ Testing…'; }
  if (statusEl) { statusEl.style.color = 'var(--text-soft)'; statusEl.textContent = 'Connecting…'; }

  try {
    const res = await fetch('/.netlify/functions/cm-test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: user.id, provider, apiKey })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Connection failed');

    // Save to app config
    if (!window._appConfig) window._appConfig = {};
    window._appConfig.channel_manager_provider = provider;
    window._appConfig.channel_manager_connected = true;
    window._appConfig.channel_manager_tier = 'self-serve';
    await saveAppConfigToCloud({
      channel_manager_provider: provider,
      channel_manager_connected: true,
      channel_manager_tier: 'self-serve',
    });

    if (statusEl) { statusEl.style.color = 'var(--moss)'; statusEl.textContent = '✓ Connected! Redirecting to property mapping…'; }
    globalThis.showBanner('✓ Channel manager connected', 'ok');
    setTimeout(() => openSettingsPanel('cm-mapping'), 800);
  } catch (e) {
    if (statusEl) { statusEl.style.color = 'var(--red)'; statusEl.textContent = '⚠ ' + e.message; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Test & Connect'; }
  }
}

async function syncCMBookings() {
  const user = await getCurrentSupabaseUser();
  if (!user) { globalThis.showBanner('⚠ Please sign in first', 'warn'); return; }

  const btn = document.getElementById('cm-sync-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⟳ Syncing…'; }

  try {
    const res = await fetch('/.netlify/functions/cm-sync-bookings?uid=' + encodeURIComponent(user.id));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Sync failed');

    // Update last sync time in app config
    if (!window._appConfig) window._appConfig = {};
    window._appConfig.channel_manager_last_sync = new Date().toISOString();
    window._appConfig.channel_manager_sync_error = null;
    await saveAppConfigToCloud({
      channel_manager_last_sync: window._appConfig.channel_manager_last_sync,
      channel_manager_sync_error: null,
    });

    const totalChanges = (data.imported || 0) + (data.updated || 0) + (data.cancelled || 0);
    if (totalChanges > 0) {
      if (typeof globalThis.hydrateFromCloud === 'function') await globalThis.hydrateFromCloud();
      globalThis.reloadInMemoryData();
      globalThis.renderAll();
      const parts = [];
      if (data.imported) parts.push(data.imported + ' imported');
      if (data.updated) parts.push(data.updated + ' updated');
      if (data.cancelled) parts.push(data.cancelled + ' cancelled');
      globalThis.showBanner('✓ CM sync: ' + parts.join(', '), 'ok');
    } else {
      globalThis.showBanner('✓ Channel manager in sync — no new bookings', 'ok');
    }
    renderConnectionSummary();
  } catch (e) {
    if (!window._appConfig) window._appConfig = {};
    window._appConfig.channel_manager_sync_error = e.message;
    globalThis.showBanner('⚠ CM sync failed: ' + e.message, 'warn');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔄 Sync Now'; }
  }
}

async function requestCMSetup() {
  const user = await getCurrentSupabaseUser();
  if (!user) { globalThis.showBanner('⚠ Please sign in first', 'warn'); return; }

  const btn = document.getElementById('cm-request-btn');
  const statusEl = document.getElementById('cm-request-status');
  if (btn) { btn.disabled = true; btn.textContent = '⟳ Sending…'; }

  try {
    // Get host email for the notification
    const hostProfile = typeof getHostProfile === 'function' ? getHostProfile() : {};
    const hostEmail = user.email || (hostProfile && hostProfile.email) || 'unknown';

    // Send push notification to admin
    const res = await globalThis.authFetch('/.netlify/functions/send-push', {
      method: 'POST',
      body: JSON.stringify({
        uid: user.id,
        title: '🛎️ Channel Manager Setup Request',
        body: 'User ' + hostEmail + ' (uid: ' + user.id + ') requested managed CM setup.',
        admin: true,
      })
    });

    // Update app config to mark tier as managed
    if (!window._appConfig) window._appConfig = {};
    window._appConfig.channel_manager_tier = 'managed';
    await saveAppConfigToCloud({ channel_manager_tier: 'managed' });

    if (statusEl) { statusEl.style.color = 'var(--moss)'; statusEl.textContent = '✓ Request sent! We will be in touch shortly.'; }
    globalThis.showBanner('✓ Setup request sent', 'ok');
  } catch (e) {
    if (statusEl) { statusEl.style.color = 'var(--red)'; statusEl.textContent = '⚠ Failed to send request'; }
    globalThis.showBanner('⚠ Could not send request: ' + e.message, 'warn');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Request Setup'; }
  }
}

async function disconnectCM() {
  globalThis.showAppModal(
    'Disconnect Channel Manager?',
    'This will stop syncing bookings from your channel manager. Your existing bookings won\'t be affected.',
    async () => {
      try {
        const user = await getCurrentSupabaseUser();
        if (!user) return;

        // Clear channel manager fields from app config
        if (!window._appConfig) window._appConfig = {};
        window._appConfig.channel_manager_provider = '';
        window._appConfig.channel_manager_connected = false;
        window._appConfig.channel_manager_tier = '';
        window._appConfig.channel_manager_last_sync = null;
        window._appConfig.channel_manager_sync_error = null;
        await saveAppConfigToCloud({
          channel_manager_provider: '',
          channel_manager_connected: false,
          channel_manager_tier: '',
          channel_manager_last_sync: null,
          channel_manager_sync_error: null,
        });

        // Delete channel property mappings
        try {
          await window._sb.from('channel_property_map').delete().eq('user_id', user.id);
        } catch (e) {
          console.warn('[StayOps] Failed to delete CM property mappings:', e.message);
        }

        renderConnectionSummary();
        globalThis.showBanner('✓ Channel manager disconnected', 'ok');
      } catch (e) {
        globalThis.showBanner('⚠ Disconnect failed: ' + e.message, 'warn');
      }
    }
  );
}

async function loadCMMapping() {
  const user = await getCurrentSupabaseUser();
  if (!user) return;
  const listEl = document.getElementById('cm-mapping-list');
  const statusEl = document.getElementById('cm-mapping-status');
  if (!listEl) return;
  listEl.innerHTML = '<div style="font-size:12px;color:var(--text-soft)">Loading properties…</div>';

  try {
    // Fetch CM properties from the API
    const res = await fetch('/.netlify/functions/cm-get-properties?uid=' + encodeURIComponent(user.id));
    const cmData = await res.json();
    if (!res.ok) throw new Error(cmData.error || 'Failed to load CM properties');
    const cmProperties = cmData.properties || [];

    // Fetch current mappings from Supabase
    const { data: mappings } = await window._sb
      .from('channel_property_map')
      .select('*')
      .eq('user_id', user.id);
    const mappingsByProp = {};
    (mappings || []).forEach(m => { mappingsByProp[m.property_id] = m; });

    // Get local StayOps properties
    const allProps = typeof getAllProperties === 'function' ? getAllProperties() : [];
    if (!allProps.length) {
      listEl.innerHTML = '<div style="font-size:12px;color:var(--text-soft)">No StayOps properties found. Add a property first.</div>';
      return;
    }

    let html = '';
    allProps.forEach(prop => {
      const propId = prop.supabaseId || prop.id;
      const propName = prop.name || prop.id;
      const existing = mappingsByProp[propId];
      const selectedCmId = existing ? existing.cm_property_id : '';

      html += `<div style="background:var(--mist);padding:12px;border-radius:10px;margin-bottom:8px">
        <div style="font-weight:600;font-size:13px;margin-bottom:6px">${escHtml(propName)}</div>
        <select onchange="saveCMMapping('${escHtml(propId)}', this.value, '', this.options[this.selectedIndex].text)"
          style="width:100%;padding:8px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;font-family:inherit;background:var(--card-bg)">
          <option value="">— Not mapped —</option>
          ${cmProperties.map(cp =>
            `<option value="${escHtml(cp.id)}" ${String(cp.id) === String(selectedCmId) ? 'selected' : ''}>${escHtml(cp.name || cp.id)}</option>`
          ).join('')}
        </select>
      </div>`;
    });
    listEl.innerHTML = html;
  } catch (e) {
    listEl.innerHTML = '<div style="font-size:12px;color:var(--red)">⚠ ' + escHtml(e.message) + '</div>';
    console.warn('[StayOps] loadCMMapping error:', e);
  }
}

async function saveCMMapping(propertyId, cmPropId, cmRoomId, cmPropName) {
  const user = await getCurrentSupabaseUser();
  if (!user) return;
  const statusEl = document.getElementById('cm-mapping-status');

  try {
    if (!cmPropId) {
      // Remove mapping
      await window._sb.from('channel_property_map').delete()
        .eq('user_id', user.id)
        .eq('property_id', propertyId);
      if (statusEl) { statusEl.style.color = 'var(--text-soft)'; statusEl.textContent = 'Mapping removed'; }
      return;
    }
    // Upsert mapping
    const { error } = await window._sb.from('channel_property_map').upsert({
      user_id: user.id,
      property_id: propertyId,
      cm_property_id: cmPropId,
      cm_room_id: cmRoomId || null,
      cm_property_name: cmPropName || '',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,property_id' });
    if (error) throw new Error(error.message);
    if (statusEl) { statusEl.style.color = 'var(--moss)'; statusEl.textContent = '✓ Mapping saved'; }
  } catch (e) {
    if (statusEl) { statusEl.style.color = 'var(--red)'; statusEl.textContent = '⚠ ' + e.message; }
    globalThis.showBanner('⚠ Failed to save mapping: ' + e.message, 'warn');
  }
}

async function maybeAutoSyncCM() {
  try {
    if (!window._appConfig || !window._appConfig.channel_manager_connected) return;
    const user = window._supabaseUser;
    if (!user) return;

    // Only run if last sync was > 4 hours ago
    const lastSync = window._appConfig.channel_manager_last_sync;
    if (lastSync) {
      const elapsed = Date.now() - new Date(lastSync).getTime();
      if (elapsed < 4 * 60 * 60 * 1000) return;
    }

    const res = await fetch('/.netlify/functions/cm-sync-bookings?uid=' + encodeURIComponent(user.id));
    if (!res.ok) return;
    const data = await res.json();

    // Update last sync time silently
    window._appConfig.channel_manager_last_sync = new Date().toISOString();
    window._appConfig.channel_manager_sync_error = null;
    saveAppConfigToCloud({
      channel_manager_last_sync: window._appConfig.channel_manager_last_sync,
      channel_manager_sync_error: null,
    }).catch(e => console.warn("[StayOps] silent error:", e));

    const totalChanges = (data.imported || 0) + (data.updated || 0) + (data.cancelled || 0);
    if (totalChanges > 0) {
      if (typeof globalThis.hydrateFromCloud === 'function') await globalThis.hydrateFromCloud();
      globalThis.reloadInMemoryData();
      globalThis.renderAll();
      const parts = [];
      if (data.imported) parts.push(data.imported + ' imported');
      if (data.updated) parts.push(data.updated + ' updated');
      if (data.cancelled) parts.push(data.cancelled + ' cancelled');
      globalThis.showBanner('✓ ' + parts.join(', ') + ' from channel manager', 'ok');
    }
  } catch (e) {
    console.warn('[cm-auto-sync] background sync error:', e.message);
  }
}

/** Navigate to Settings section (main settings menu). */
function openSettings() {
  globalThis.showSection('settings');
}

export {
  initSettingsSwipeBack,
  openSettings,
  renderConnectionSummary,
  refreshConnectionSummarySoon,
  connectGmail,
  connectOutlook,
  maybeAutoScanGmail,
  scanGmailBookings,
  maybeAutoScanOutlook,
  scanOutlookBookings,
  populateCalendarFeedPanel,
  copyCalendarFeedUrl,
  _resetSettingsToMenu,
  _ensureSettingsVisible,
  openSettingsCat,
  openSettingsPanel,
  closeSettingsPanel,
  closeSettingsCat,
  renderSettings,
  chooseGoogleAccount,
  syncToSheet,
  clearCacheAndResync,
  saveSMSTemplate,
  saveGeminiKey,
  saveApiKey,
  getApiKey,
  HOST_PROFILE_KEY,
  getHostProfile,
  saveHostProfile,
  manageHostIdentity,
  populateHostProfilePanel,
  saveHostProfilePanel,
  renderHostProfileRow,
  loadCleaners,
  saveCleaners,
  addCleaner,
  deleteCleaner,
  renderCleanersList,
  renderTeamList,
  openCleanerProfile,
  saveCleanerContact,
  populateContractorSelect,
  renderStorageViewer,
  getFx,
  saveFxSetting,
  applyModalSpring,
  initFxSettings,
  getAutoAssignCleaner,
  toggleAutoAssignCleaner,
  _renderAutoAssignToggle,
  resetConnectionCheckerResults,
  openCleanerSettings,
  renderCleanerAccessList,
  saveCleanerPinById,
  clearCleanerPinById,
  saveCleanerPerm,
  copyCleanerLinkById,
  testCMConnection,
  syncCMBookings,
  requestCMSetup,
  disconnectCM,
  loadCMMapping,
  saveCMMapping,
  maybeAutoSyncCM,
};
