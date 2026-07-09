/**
 * StayOps — onboarding wizard: the new-user setup flow (property type, address,
 * platforms, integrations, notifications) + isOnboardingComplete / checkAutoSendReport.
 * Split out of render.js 2026-07-10 (first render.js slice). render.js stays the barrel:
 * it imports these back and re-exports them, so main.js's 92-name import contract is
 * unchanged. Back-imports from the render core (showBanner/finishAppInit/reloadInMemoryData/
 * renderAll) are call-time only (safe cycle). Most cross-module calls are guarded
 * globalThis.* (savePropertyToCloud, hydrateFromCloud, subscribeToPush, ...) — left as-is.
 */
import { getActivePropertyConfig, savePropertyConfig, getAllProperties, initPropertyUI } from './config.js';
import { isPortfolioMode, applyPortfolioModeAfterHostHydrate } from './property.js';
import { escHtml, fyLabel } from './utils.js';
import { showBanner, finishAppInit, reloadInMemoryData, renderAll } from './render.js';

// ── ONBOARDING FLOW ───────────────────────────────────────────────────────────

const _OB_PLATFORMS = new Set();
const _OB_INTEGRATIONS = new Set();
let _OB_PROPERTY_TYPE = '';
const _OB_STEPS = [0, 1, 2, 3, 4, 5, 6];

export function showOnboarding() {
  const el = document.getElementById('stayops-onboarding');
  if (el) el.style.display = 'flex';
  const app   = document.getElementById('main-content');
  const nav   = document.querySelector('.nav');
  const hdr   = document.querySelector('.header');
  if (app) app.style.display = 'none';
  if (nav) nav.style.display = 'none';
  if (hdr) hdr.style.display = 'none';
  _obGoToStep(0);
}

export function hideOnboarding() {
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

// Step IDs (some are strings, like 'live')
const _OB_STEP_ORDER = [0, 1, 2, 3, 'live', 4, 5, 6];
// Progress label for the X / 4 indicator (PDF treats setup as 4 sections)
const _OB_PROGRESS_LABELS = {
  0: '3 / 4', 1: '3 / 4', 2: null,    // cleaner is OPTIONAL — no counter
  3: '4 / 4', live: null,
  4: '4 / 4', 5: null, 6: null
};

export function _obGoToStep(step) {
  _OB_STEP_ORDER.forEach(n => {
    const s = document.getElementById('onboard-step-' + n);
    if (s) s.style.display = n === step ? '' : 'none';
  });
  // Update progress label + bar fill
  const label = document.getElementById('ob-progress-label');
  const lblText = _OB_PROGRESS_LABELS[step];
  if (label) {
    label.textContent = lblText || '';
    label.style.visibility = lblText ? 'visible' : 'hidden';
  }
  const fill = document.getElementById('ob-progress-fill');
  if (fill) {
    const idx = _OB_STEP_ORDER.indexOf(step);
    const pct = Math.max(8, Math.round(((idx + 1) / _OB_STEP_ORDER.length) * 100));
    fill.style.width = pct + '%';
  }
  // Hide back button on first step
  const back = document.getElementById('ob-back-btn');
  if (back) back.style.visibility = step === 0 ? 'hidden' : 'visible';
  // Build quick-start list when arriving at step 6
  if (step === 6) renderQuickStartList();
  // Populate property summary when arriving at live
  if (step === 'live') renderLiveSummary();
  // Scroll to top on step change
  const wrap = document.getElementById('stayops-onboarding');
  if (wrap) wrap.scrollTop = 0;
  // Track current step for back nav
  window._obCurrentStep = step;
}

export function onboardBack() {
  const cur = window._obCurrentStep;
  const idx = _OB_STEP_ORDER.indexOf(cur);
  if (idx > 0) _obGoToStep(_OB_STEP_ORDER[idx - 1]);
}

// Step 0 — Property type
export function onboardSetPropertyType(type) {
  _OB_PROPERTY_TYPE = type;
  ['whole', 'room', 'multi', 'other'].forEach(t => {
    const card  = document.getElementById('ob-ptype-' + t);
    const check = document.getElementById('ob-ptype-check-' + t);
    const active = (t === type);
    if (card) card.classList.toggle('selected', active);
    if (check) check.classList.toggle('on', active);
  });
  const errEl = document.getElementById('ob-step0-error');
  if (errEl) errEl.textContent = '';
  const btn = document.getElementById('ob-step0-btn');
  if (btn) btn.disabled = false;
}

// Stepper helpers (Property details bedrooms/bathrooms)
export function obStepperAdjust(inputId, delta) {
  const input = document.getElementById(inputId);
  const valSpan = document.getElementById(inputId + '-val');
  if (!input) return;
  const min = inputId === 'ob-baths' ? 0 : 1;
  let cur = parseInt(input.value, 10) || min;
  cur = Math.max(min, Math.min(20, cur + delta));
  input.value = cur;
  if (valSpan) valSpan.textContent = cur;
}

// Max-guests pills
export function obSetGuests(n) {
  const input = document.getElementById('ob-guests');
  if (input) input.value = n;
  document.querySelectorAll('#ob-guests-pills .so-pill-opt').forEach(el => {
    el.classList.toggle('on', parseInt(el.getAttribute('data-g'), 10) === n);
  });
}

// Step 1 — skip address
export function onboardStep1SkipAddress() {
  const suburb = document.getElementById('ob-suburb');
  if (suburb && !suburb.value) suburb.value = '—';
  onboardStep1Next();
}

// Render property summary on the "Property is live" step
export function renderLiveSummary() {
  try {
    const cfg = (typeof getActivePropertyConfig === 'function' ? getActivePropertyConfig() : null) || {};
    const nameEl = document.getElementById('ob-live-name');
    const metaEl = document.getElementById('ob-live-meta');
    if (nameEl) nameEl.textContent = cfg.name || 'Your property';
    if (metaEl) {
      const p = cfg.property || {};
      const parts = [];
      if (cfg.suburb && cfg.suburb !== '—') parts.push(cfg.suburb);
      if (p.bedrooms) parts.push(p.bedrooms + ' bd');
      if (p.bathrooms) parts.push(p.bathrooms + ' ba');
      if (p.maxGuests) parts.push('sleeps ' + p.maxGuests);
      metaEl.textContent = parts.join(' · ');
    }
  } catch (_) { /* non-critical */ }
}

export function onboardLiveContinue() { _obGoToStep(4); }

export function onboardStep0Next() {
  const errEl = document.getElementById('ob-step0-error');
  if (!_OB_PROPERTY_TYPE) {
    if (errEl) errEl.textContent = 'Please choose one to continue.';
    return;
  }
  if (errEl) errEl.textContent = '';
  // Persist on the active property config (stored as propertyType so we don't
  // collide with the existing property.type field used for "house/apartment")
  try { savePropertyConfig({ propertyType: _OB_PROPERTY_TYPE }); } catch(_) { /* non-critical */ }
  _obGoToStep(1);
}

// Step 1 — Property details
export function onboardStep1Next() {
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
  if (!window._stayOpsHydrating && typeof globalThis.savePropertyToCloud === 'function') {
    globalThis.savePropertyToCloud(getActivePropertyConfig()).catch(e => console.warn("[StayOps] silent error:", e));
  }

  _obGoToStep(2);
}

// Step 2 — Add cleaner (optional)
export async function onboardStep2Next() {
  const name  = (document.getElementById('ob-cleaner-name')  || {}).value?.trim() || '';
  const phone = (document.getElementById('ob-cleaner-phone') || {}).value?.trim() || '';
  const email = (document.getElementById('ob-cleaner-email') || {}).value?.trim() || '';
  const errEl = document.getElementById('ob-step2-error');
  if (!name) {
    if (errEl) errEl.textContent = 'Cleaner name is required, or skip this step.';
    return;
  }
  if (errEl) errEl.textContent = '';
  // Push to in-memory cleaners array and sync to cloud
  try {
    window._cleaners = window._cleaners || [];
    const list = window._cleaners;
    const newCleaner = {
      id: Date.now(),
      name, phone, email,
      role: 'Cleaner',
      pin: '',
      permissions: {},
      active: true,
      invitation_status: 'pending'
    };
    list.push(newCleaner);
    if (typeof globalThis.saveCleanersToCloud === 'function') {
      globalThis.saveCleanersToCloud([newCleaner]).catch(e => console.warn('[StayOps] saveCleanersToCloud silent error:', e));
    }
  } catch (e) { console.warn('[StayOps] add cleaner during onboarding failed', e); }
  _obGoToStep(3);
}

// Generic skip — advance to next step without saving the current step's data
export function onboardSkipStep(currentStep) {
  const next = currentStep + 1;
  if (next > 6) { onboardFinish(); return; }
  _obGoToStep(next);
}

// Step 2 — Connect email (kept for OAuth callback compatibility)
export async function onboardConnectGoogle() {
  const user = typeof globalThis.getCurrentSupabaseUser === 'function' ? await globalThis.getCurrentSupabaseUser() : null;
  if (!user) { showBanner('⚠ Please sign in first', 'warn'); return; }
  await globalThis.beginOAuthConnect('/.netlify/functions/gmail-oauth-start');
}

export async function onboardConnectMicrosoft() {
  const user = typeof globalThis.getCurrentSupabaseUser === 'function' ? await globalThis.getCurrentSupabaseUser() : null;
  if (!user) { showBanner('⚠ Please sign in first', 'warn'); return; }
  await globalThis.beginOAuthConnect('/.netlify/functions/outlook-oauth-start');
}

// Called by OAuth callback when connection succeeds
export function onboardEmailConnected(provider, email) {
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
  if (typeof globalThis.renderOnboardingGuidance === 'function') globalThis.renderOnboardingGuidance();
}

export function onboardStep2Skip() {
  _obGoToStep(3);
}

// Step 3 — Platforms
export function onboardTogglePlatform(platform) {
  if (_OB_PLATFORMS.has(platform)) {
    _OB_PLATFORMS.delete(platform);
  } else {
    _OB_PLATFORMS.add(platform);
  }
  // Update UI
  ['airbnb', 'booking', 'stayz', 'vrbo', 'direct'].forEach(p => {
    const label = document.getElementById('ob-plat-' + p);
    const check = document.getElementById('ob-check-' + p);
    const active = _OB_PLATFORMS.has(p);
    if (label) label.style.borderColor = active ? 'var(--primary)' : 'transparent';
    if (check) {
      check.style.background  = active ? 'var(--primary)' : 'transparent';
      check.style.borderColor = active ? 'var(--primary)' : '#E5E5EA';
      check.innerHTML = active ? '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 7L5.5 10.5L12 3.5" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '';
    }
  });
}

// Step 3 — Platforms (advance to integrations)
export async function onboardStep3Next() {
  const errEl = document.getElementById('ob-step3-error');
  if (_OB_PLATFORMS.size === 0) {
    if (errEl) errEl.textContent = 'Please select at least one platform.';
    return;
  }
  if (errEl) errEl.textContent = '';
  const platforms = Array.from(_OB_PLATFORMS);
  savePropertyConfig({ platforms });
  if (typeof globalThis.savePropertyToCloud === 'function') {
    globalThis.savePropertyToCloud(getActivePropertyConfig()).catch(e => console.warn('[StayOps] silent save error:', e));
  }
  _obGoToStep('live');
}

// Step 4 — Integrations (optional, multi-select)
export function onboardToggleIntegration(key) {
  if (_OB_INTEGRATIONS.has(key)) _OB_INTEGRATIONS.delete(key);
  else _OB_INTEGRATIONS.add(key);
  ['calendar', 'email', 'ical', 'sheet', 'receipts'].forEach(k => {
    const card  = document.getElementById('ob-int-' + k);
    const active = _OB_INTEGRATIONS.has(k);
    if (card) {
      card.classList.toggle('selected', active);
      const btn = card.querySelector('.ob-int-btn');
      if (btn) {
        if (active) {
          btn.textContent = '✓ Connected';
          btn.style.background = 'var(--primary)';
          btn.style.color = '#fff';
        } else {
          btn.textContent = 'Connect';
          btn.style.background = 'var(--sage-tint,#EAF1E6)';
          btn.style.color = 'var(--primary)';
        }
      }
    }
  });
}

export function onboardStep4Next() {
  if (_OB_INTEGRATIONS.size) {
    const integrationsToConnect = Array.from(_OB_INTEGRATIONS);
    try { savePropertyConfig({ pendingIntegrations: integrationsToConnect }); } catch(_) { /* non-critical */ }
  }
  _obGoToStep(5);
}

// Step 5 — Notifications
export async function onboardEnableNotifications() {
  const btn = document.getElementById('ob-notif-enable-btn');
  const result = document.getElementById('ob-notif-result');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    if (typeof globalThis.subscribeToPush === 'function') {
      const sub = await globalThis.subscribeToPush('host');
      if (sub) {
        if (result) { result.style.display = 'block'; result.textContent = '✓ Notifications on.'; }
        if (btn) { btn.textContent = '✓ Enabled'; btn.disabled = true; }
        setTimeout(() => _obGoToStep(6), 700);
        return;
      }
    }
    if (result) { result.style.display = 'block'; result.style.color = '#FF6B6B'; result.textContent = "Couldn't enable — check browser permissions."; }
    if (btn) { btn.disabled = false; btn.textContent = 'Try again'; }
  } catch (e) {
    console.warn('[StayOps] notif enable failed', e);
    if (btn) { btn.disabled = false; btn.textContent = 'Try again'; }
  }
}

// Step 6 — Quick start checklist
export function renderQuickStartList() {
  const wrap = document.getElementById('ob-quickstart-list');
  if (!wrap) return;
  const cleanersCount = (() => {
    try { return (window._cleaners || []).length; } catch(_) { return 0; }
  })();
  const cfg = (() => { try { return getActivePropertyConfig() || {}; } catch(_) { return {}; } })();
  const propertyDone = !!(cfg && cfg.name);
  const integrationsConnected = !!(cfg.pendingIntegrations && cfg.pendingIntegrations.length);
  const items = [
    { label: 'Add your first property',  meta: '1 min', done: propertyDone,           optional: false },
    { label: 'Add your cleaner',         meta: '1 min', done: cleanersCount > 0,      optional: false },
    { label: 'Import or add a booking',  meta: '2 min', done: false,                  optional: false },
    { label: 'Schedule your first clean',meta: '1 min', done: false,                  optional: false },
    { label: 'Connect Airbnb calendar',  meta: '2 min', done: integrationsConnected,  optional: true  },
    { label: 'Log an expense or receipt',meta: '1 min', done: false,                  optional: true  }
  ];
  const doneCount = items.filter(i => i.done).length;
  const totalCount = items.length;
  // Update header pill + bar
  const pill = document.getElementById('ob-qs-count');
  if (pill) pill.textContent = doneCount + ' of ' + totalCount + ' done';
  const bar = document.getElementById('ob-qs-bar');
  if (bar) bar.style.width = Math.round((doneCount / totalCount) * 100) + '%';

  wrap.innerHTML = items.map(item => `
    <div class="so-card" style="display:flex;align-items:center;gap:14px;${item.done ? 'background:var(--sage-tint,#EAF1E6);border-color:var(--sage-soft,#D6E3D2);' : ''}">
      <div class="so-radio ${item.done ? 'on' : ''}" style="${item.done ? '' : 'border-color:var(--line,#E4DCC9);'}">
        ${item.done ? '' : ''}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;font-weight:600;color:var(--ink,#1B2A24);${item.done ? 'text-decoration:line-through;color:var(--ink-muted,#6F7568);' : ''}">${item.label}</div>
        <div style="font-family:'JetBrains Mono','SF Mono',monospace;font-size:11px;color:var(--ink-muted,#6F7568);margin-top:2px">${item.meta}</div>
      </div>
      ${item.optional ? '<span class="so-pill optional">Optional</span>' : ''}
      ${item.done ? '' : '<span style="color:var(--ink-muted,#6F7568);font-size:18px;line-height:1">›</span>'}
    </div>
  `).join('');
}

export async function onboardFinish() {
  // Boot the app
  hideOnboarding();
  if (typeof globalThis.showLoadingScreen === 'function') globalThis.showLoadingScreen('Setting up your workspace…');
  if (typeof finishAppInit === 'function') await finishAppInit();
  if (typeof globalThis.hydrateFromCloud === 'function') await globalThis.hydrateFromCloud();
  reloadInMemoryData();
  if (typeof initPropertyUI === 'function') initPropertyUI();
  if (typeof applyPortfolioModeAfterHostHydrate === 'function') await applyPortfolioModeAfterHostHydrate();
  if (typeof globalThis.showAppChrome === 'function') globalThis.showAppChrome();
  if (!(typeof isPortfolioMode === 'function' && isPortfolioMode()) && typeof renderAll === 'function') renderAll();
  // Show success toast for "Property live" moment
  if (typeof globalThis.showSuccessToast === 'function') {
    setTimeout(() => globalThis.showSuccessToast('✓ Your workspace is live.'), 400);
  }
  setTimeout(() => { if (typeof checkAutoSendReport === 'function') checkAutoSendReport(); }, 1500);
}

// Check if onboarding is needed
export function isOnboardingComplete() {
  // A real property must exist in the list before any other flag matters.
  // gh-setup-complete is set by the property setup overlay on submit regardless
  // of whether valid property data was actually saved (e.g. empty name field).
  // Without this guard, an authenticated user with 0 cloud properties lands on
  // a blank "NSW / 0 beds" dashboard instead of the Add Property / onboarding screen.
  try {
    const props = typeof getAllProperties === 'function' ? getAllProperties() : [];
    if (!props.length) return false;
  } catch(_e) { /* ignore if getAllProperties is not yet defined */ }
  if (localStorage.getItem('gh-setup-complete') === '1') return true;
  try {
    const cfg = typeof getActivePropertyConfig === 'function' ? getActivePropertyConfig() : null;
    if (cfg && cfg.name) return true;
  } catch(_e) { /* ignore if getActivePropertyConfig is not yet defined */ }
  return false;
}

// ── END ONBOARDING FLOW ───────────────────────────────────────────────────────


/**
 * checkAutoSendReport — called once after hydrateFromCloud + renderAll.
 * If auto-send is on and a report is due, shows a non-intrusive prompt banner.
 */
export function checkAutoSendReport() {
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
  } catch (_e) {
    // Non-critical — silently ignore
  }
}
