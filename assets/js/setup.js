/* ═══════════════════════════════════════════════════════════════════════════
   SETUP FLOW — Glenhaven Property Manager (Product Version)
   ═══════════════════════════════════════════════════════════════════════════

   First-boot property configuration screen.
   Shows a single-page form when no valid config exists, saving into
   localStorage via savePropertyConfig() from config.js.

   Load order: config.js → setup.js → adapter.js → main.js

   Public surface:
     showSetupIfNeeded()    → Promise — resolves immediately if config valid,
                              or after user completes + saves the form.
     reopenPropertySetup()  → void — re-opens form from Settings (edit mode).

   Internal helpers are all prefixed _setup to avoid collisions.
═══════════════════════════════════════════════════════════════════════════ */

// ── ENTRY POINTS ──────────────────────────────────────────────────────────────

/**
 * Show the setup screen if no valid config exists.
 * Returns a Promise that resolves when the app is ready to boot.
 * In the normal case (config exists) it resolves synchronously.
 * @returns {Promise<void>}
 */
function showSetupIfNeeded() {
  if (hasValidPropertyConfig()) return Promise.resolve();
  return _setupShowOverlay(false);
}

/**
 * Re-open the setup form in edit mode from the Settings screen.
 * Pre-fills all fields from the current config. Does not block the app.
 */
function reopenPropertySetup() {
  _setupShowOverlay(true, false).catch(() => {});
}

function openAddPropertySetup() {
  _setupShowOverlay(true, true).catch(() => {});
}


// ── OVERLAY ───────────────────────────────────────────────────────────────────

function _setupShowOverlay(editMode, createMode) {
  return new Promise(resolve => {
    _setupInjectStyles();

    const overlay = _setupBuildOverlay(editMode, createMode, () => {
      // Clean up and unblock app boot.
      overlay.style.opacity   = '0';
      overlay.style.transform = 'translateY(16px)';
      setTimeout(() => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        document.body.style.overflow = '';
        // Clean up the global submit handler.
        delete window._setupSubmit;
        resolve();
      }, 280);
    });

    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    // Focus first text input for accessibility / mobile keyboards.
    requestAnimationFrame(() => {
      const first = overlay.querySelector('input[type="text"], input[type="url"]');
      if (first) first.focus();
    });
  });
}

function _setupBuildOverlay(editMode, createMode, onDone) {
  const cfg   = createMode ? _setupBlankConfig() : getActivePropertyConfig();
  const stats = cfg.property    || {};
  const integ = cfg.integrations || {};
  const owner = cfg.owner        || {};
  const price = cfg.pricing      || {};
  const branding = cfg.branding  || {};

  // ── Helper: safe attribute-escaped string ──
  const ea = s => String(s || '')
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // ── Helper: should we pre-fill a default value?
  // In first-boot mode we leave Glenhaven defaults blank so the host types
  // their own values. In edit mode we always show whatever is saved.
  const preGlenhaven = {
    name:        'Glenhaven',
    suburb:      'Katoomba',
    state:       'NSW',
    region:      'Blue Mountains',
    tagline:     'Katoomba, NSW · Blue Mountains',
    // Suppress Glenhaven's live URLs on first-boot so a new host cannot
    // accidentally submit the form pointing at Glenhaven's real data.
    sheetCsvUrl: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTlssTFmteUx1q3NkqRz2hAIqtJbt8OlRxl8VcX1x5gW6mI8W52n3xutATDO13qlRNoobKSsmVPciDR/pub?gid=0&single=true&output=csv',
    scriptUrl:   'https://script.google.com/macros/s/AKfycbzM0wcdsUqK03faXxk2VqTAEqzno4GCAMzFYGrUXc4y1LKDwd8GbCKhNJruvbXJGhOflw/exec',
  };
  const pre = (field, saved) => {
    if (editMode) return ea(saved);
    // First-boot: suppress the Glenhaven default so the field appears empty.
    return (saved && saved !== preGlenhaven[field]) ? ea(saved) : '';
  };

  const overlay = document.createElement('div');
  overlay.id = 'setup-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', createMode ? 'Add property configuration' : (editMode ? 'Edit property configuration' : 'Property setup')); 

  overlay.innerHTML = `
    <div id="setup-card">

      <!-- ── Header ── -->
      <div id="setup-header">
        <div id="setup-icon">🏡</div>
        <div>
          <div id="setup-title">${createMode ? 'Add Property' : (editMode ? 'Edit Property Configuration' : 'Welcome — Set Up Your Property')}</div>
          <div id="setup-desc">${createMode
            ? 'Create another property profile. It will become your active property after save.'
            : (editMode
                ? 'Update your property details. Changes take effect immediately.'
                : 'Fill in your property details to get started. You can edit these any time in Settings → Property Setup.')
          }</div>
        </div>
      </div>

      <form id="setup-form" novalidate>

        <!-- ══ SECTION: PROPERTY ══ -->
        <div class="ss-label">Property</div>

        <div class="ss-row">
          <div class="ss-field ss-wide">
            <label class="ss-lbl" for="s-name">Property Name <span class="ss-req" aria-hidden="true">*</span></label>
            <input type="text" id="s-name" class="ss-inp"
              placeholder="e.g. Seaview Cottage" maxlength="60"
              value="${pre('name', cfg.name)}" autocomplete="off">
            <div class="ss-hint">Used in reports, invoices, calendar events and cleaner emails.</div>
          </div>
          <div class="ss-field">
            <label class="ss-lbl" for="s-type">Property Type</label>
            <select id="s-type" class="ss-inp">
              ${['house','apartment','villa','cabin','other'].map(t =>
                `<option value="${t}" ${stats.type === t ? 'selected' : ''}>${t.charAt(0).toUpperCase()+t.slice(1)}</option>`
              ).join('')}
            </select>
          </div>
        </div>

        <div class="ss-row">
          <div class="ss-field">
            <label class="ss-lbl" for="s-suburb">Suburb / Town <span class="ss-req" aria-hidden="true">*</span></label>
            <input type="text" id="s-suburb" class="ss-inp"
              placeholder="e.g. Byron Bay"
              value="${pre('suburb', cfg.suburb)}">
          </div>
          <div class="ss-field">
            <label class="ss-lbl" for="s-state">State <span class="ss-req" aria-hidden="true">*</span></label>
            <input type="text" id="s-state" class="ss-inp"
              placeholder="e.g. NSW" maxlength="10"
              value="${pre('state', cfg.state)}">
          </div>
        </div>

        <div class="ss-row">
          <div class="ss-field">
            <label class="ss-lbl" for="s-region">Region <span class="ss-opt">(optional)</span></label>
            <input type="text" id="s-region" class="ss-inp"
              placeholder="e.g. Northern Rivers"
              value="${pre('region', cfg.region)}">
          </div>
          <div class="ss-field">
            <label class="ss-lbl" for="s-tagline">Tagline <span class="ss-opt">(optional)</span></label>
            <input type="text" id="s-tagline" class="ss-inp"
              placeholder="e.g. Katoomba, NSW · Blue Mountains"
              value="${ea(branding.tagline || '')}">
          </div>
        </div>

        <div class="ss-row">
          <div class="ss-field">
            <label class="ss-lbl" for="s-country">Country</label>
            <input type="text" id="s-country" class="ss-inp"
              placeholder="Australia" maxlength="40"
              value="${ea(cfg.country || 'Australia')}">
          </div>
          <div class="ss-field"></div>
        </div>

        <!-- ══ SECTION: DETAILS ══ -->
        <div class="ss-label">Property Details</div>

        <div class="ss-row ss-row-3">
          <div class="ss-field">
            <label class="ss-lbl" for="s-beds">Bedrooms <span class="ss-req" aria-hidden="true">*</span></label>
            <input type="number" id="s-beds" class="ss-inp"
              min="1" max="20" step="1" placeholder="4"
              value="${editMode && stats.bedrooms ? stats.bedrooms : ''}">
          </div>
          <div class="ss-field">
            <label class="ss-lbl" for="s-guests">Max Guests <span class="ss-req" aria-hidden="true">*</span></label>
            <input type="number" id="s-guests" class="ss-inp"
              min="1" max="99" step="1" placeholder="8"
              value="${editMode && stats.maxGuests ? stats.maxGuests : ''}">
          </div>
          <div class="ss-field">
            <label class="ss-lbl" for="s-baths">Bathrooms <span class="ss-req" aria-hidden="true">*</span></label>
            <input type="number" id="s-baths" class="ss-inp"
              min="0" max="20" step="0.5" placeholder="2"
              value="${editMode && stats.bathrooms ? stats.bathrooms : ''}">
          </div>
        </div>

        <div class="ss-row">
          <div class="ss-field">
            <label class="ss-lbl" for="s-rate">Base Nightly Rate ($) <span class="ss-opt">(optional)</span></label>
            <input type="number" id="s-rate" class="ss-inp"
              min="1" placeholder="350"
              value="${ea(price.baseRate || '')}">
          </div>
          <div class="ss-field">
            <label class="ss-lbl" for="s-currency">Currency</label>
            <input type="text" id="s-currency" class="ss-inp"
              placeholder="AUD" maxlength="3"
              value="${ea(price.currency || 'AUD')}">
          </div>
        </div>

        <!-- ══ SECTION: OWNER ══ -->
        <div class="ss-label">Your Contact Details</div>

        <div class="ss-row">
          <div class="ss-field">
            <label class="ss-lbl" for="s-owner-name">Your Name</label>
            <input type="text" id="s-owner-name" class="ss-inp"
              placeholder="e.g. Alex Smith" autocomplete="name"
              value="${ea(owner.name || '')}">
          </div>
          <div class="ss-field">
            <label class="ss-lbl" for="s-owner-email">Your Email <span class="ss-req" aria-hidden="true">*</span></label>
            <input type="email" id="s-owner-email" class="ss-inp"
              placeholder="you@example.com" autocomplete="email"
              value="${ea(owner.email || '')}">
          </div>
        </div>

        <!-- ══ SECTION: GOOGLE ══ -->
        <div class="ss-label">Google Integration</div>

        <div class="ss-field" style="margin-bottom:14px">
          <label class="ss-lbl" for="s-sheet-url">Google Sheet CSV URL <span class="ss-req" aria-hidden="true">*</span></label>
          <input type="url" id="s-sheet-url" class="ss-inp"
            placeholder="https://docs.google.com/spreadsheets/d/e/…/pub?…&output=csv"
            value="${pre('sheetCsvUrl', integ.sheetCsvUrl || '')}">
          <div class="ss-hint">
            In your bookings spreadsheet: <strong>File → Share → Publish to web</strong>
            → choose the bookings sheet → CSV → Publish. Paste that URL here.
          </div>
        </div>

        <div class="ss-field" style="margin-bottom:4px">
          <label class="ss-lbl" for="s-script-url">Apps Script URL <span class="ss-req" aria-hidden="true">*</span></label>
          <input type="url" id="s-script-url" class="ss-inp"
            placeholder="https://script.google.com/macros/s/…/exec"
            value="${pre('scriptUrl', integ.scriptUrl || '')}">
          <div class="ss-hint">
            In Apps Script: <strong>Deploy → Manage deployments → copy the /exec URL</strong>.
          </div>
        </div>

        <!-- ── Error area ── -->
        <div id="setup-errors" role="alert" aria-live="assertive" style="display:none"></div>

        <!-- ── Action buttons ── -->
        <div id="setup-actions">
          ${editMode
            ? `<button type="button" id="setup-cancel" class="ss-btn-secondary">Cancel</button>`
            : ''
          }
          <button type="submit" id="setup-save" class="ss-btn-primary">
            ${createMode ? '✓ Add Property' : (editMode ? '💾 Save Changes' : '✓ Save & Continue')}
          </button>
        </div>

      </form>
    </div>
  `;

  // ── Wire up submit ────────────────────────────────────────────────────────
  const form    = overlay.querySelector('#setup-form');
  const saveBtn = overlay.querySelector('#setup-save');
  const errEl   = overlay.querySelector('#setup-errors');

  const doSubmit = (e) => {
    if (e) e.preventDefault();

    const errors = _setupValidate(overlay);
    if (errors.length) {
      errEl.style.display = 'block';
      errEl.innerHTML = errors
        .map(msg => `<div class="ss-error-row"><span aria-hidden="true">⚠</span> ${msg}</div>`)
        .join('');
      // Scroll the first error into view inside the card.
      errEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }

    errEl.style.display = 'none';

    const currentSheetUrl = (integ.sheetCsvUrl || '').trim();
    const currentScriptUrl = (integ.scriptUrl || '').trim();
    const nextSheetUrl = (((overlay.querySelector('#s-sheet-url') || {}).value) || '').trim();
    const nextScriptUrl = (((overlay.querySelector('#s-script-url') || {}).value) || '').trim();
    const changedSheetUrl = currentSheetUrl && nextSheetUrl !== currentSheetUrl;
    const changedScriptUrl = currentScriptUrl && nextScriptUrl !== currentScriptUrl;

    if (changedSheetUrl || changedScriptUrl) {
      const targets = [];
      if (changedSheetUrl) targets.push('Google Sheet CSV URL');
      if (changedScriptUrl) targets.push('Apps Script URL');
      const ok = window.confirm(
        `You changed ${targets.join(' and ')}. This can affect bookings sync and Google integrations. Save these changes?`
      );
      if (!ok) return;
    }

    const newCfg = _setupBuildConfig(overlay);
    savePropertyConfig(newCfg);
    // Only set the flag during first-boot; in edit mode it is already set.
    if (!editMode) localStorage.setItem('gh-setup-complete', '1');

    // Mirror critical values to legacy keys so existing code paths work immediately.
    localStorage.setItem('gh-script-url', newCfg.integrations.scriptUrl);
    if (newCfg.owner.email) localStorage.setItem('gh-inv-email',  newCfg.owner.email);
    if (newCfg.owner.name)  localStorage.setItem('gh-inv-name',   newCfg.owner.name);

    // Update DB adapter thunks pick up the new scriptUrl on the next call.
    // (No action needed — thunks call getCurrentScriptURL() at call time.)

    // Reflect changes in the DOM immediately.
    if (typeof initPropertyUI === 'function') initPropertyUI();

    // Brief success state on the button before dismissing.
    saveBtn.textContent = '✓ Saved!';
    saveBtn.disabled = true;
    setTimeout(onDone, 550);
  };

  form.addEventListener('submit', doSubmit);

  // Cancel button — edit mode only.
  const cancelBtn = overlay.querySelector('#setup-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', onDone);

  return overlay;
}


// ── VALIDATION ────────────────────────────────────────────────────────────────
/**
 * Validates the setup form. Returns array of error message strings.
 * Empty array = valid.
 * @param {HTMLElement} overlay
 * @returns {string[]}
 */
function _setupValidate(overlay) {
  const v  = id => (overlay.querySelector('#' + id) || {}).value || '';
  const errors = [];

  const name      = v('s-name').trim();
  const suburb    = v('s-suburb').trim();
  const state     = v('s-state').trim();
  const beds      = parseFloat(v('s-beds'));
  const guests    = parseFloat(v('s-guests'));
  const baths     = parseFloat(v('s-baths'));
  const email     = v('s-owner-email').trim();
  const sheetUrl  = v('s-sheet-url').trim();
  const scriptUrl = v('s-script-url').trim();

  if (!name)   errors.push('Property name is required.');
  if (!suburb) errors.push('Suburb / town is required.');
  if (!state)  errors.push('State is required.');

  if (!beds   || beds < 1)    errors.push('Bedrooms must be at least 1.');
  if (!guests || guests < 1)  errors.push('Max guests must be at least 1.');
  if (isNaN(baths) || baths < 0) errors.push('Bathrooms cannot be negative.');

  if (!email) {
    errors.push('Owner email is required.');
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push('Owner email doesn\'t look valid (e.g. you@example.com).');
  }

  if (!sheetUrl) {
    errors.push('Google Sheet CSV URL is required.');
  } else if (!sheetUrl.toLowerCase().includes('docs.google.com/spreadsheets')) {
    errors.push('Google Sheet URL should start with docs.google.com/spreadsheets…');
  } else if (!sheetUrl.includes('output=csv')) {
    errors.push('Google Sheet URL should end in &output=csv — publish as CSV first.');
  }

  if (!scriptUrl) {
    errors.push('Apps Script URL is required.');
  } else if (!scriptUrl.toLowerCase().includes('script.google.com/macros')) {
    errors.push('Apps Script URL should contain script.google.com/macros.');
  } else if (!scriptUrl.endsWith('/exec')) {
    errors.push('Apps Script URL should end in /exec (the deployed web-app URL).');
  }

  return errors;
}


// ── CONFIG BUILDER ────────────────────────────────────────────────────────────
/**
 * Reads form values and returns a partial config object ready for
 * savePropertyConfig(). Does not include unchanged / empty optional fields.
 * @param {HTMLElement} overlay
 * @returns {Object}
 */
function _setupBuildConfig(overlay, createMode) {
  const v  = id => ((overlay.querySelector('#' + id) || {}).value || '').trim();
  const vF = id => parseFloat(v(id)) || 0;

  const name   = v('s-name');
  const suburb = v('s-suburb');
  const state  = v('s-state');
  const region = v('s-region');
  const tagline = v('s-tagline');

  // Read existing config once here so integrations AND pricing blocks can
  // both use it without separate getPropertyConfig() calls (fix #6).
  const _existing      = getPropertyConfig();
  const _existingInteg = _existing.integrations || {};
  const _existingPrice = _existing.pricing      || {};
  const _activeId = (typeof getActivePropertyId === 'function') ? getActivePropertyId() : null;
  const _hasExistingProperty = !!(_activeId && typeof getPropertyById === 'function' && getPropertyById(_activeId));

  return {
    propertyId: createMode
      ? undefined
      : (_existing.propertyId || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'property'),
    name,
    suburb,
    state,
    region:  region  || undefined,
    country: v('s-country') || 'Australia',

    branding: {
      subtitle: [suburb, state].filter(Boolean).join(' · '),
      tagline:  tagline || ((_existing.branding || {}).tagline) || [[suburb, state].filter(Boolean).join(', '), region].filter(Boolean).join(' · '),
    },

    property: {
      bedrooms:  vF('s-beds'),
      maxGuests: vF('s-guests'),
      bathrooms: vF('s-baths'),
      type:      v('s-type') || 'house',
    },

    owner: {
      name:  v('s-owner-name'),
      email: v('s-owner-email'),
      phone: '',
    },

    integrations: {
      sheetCsvUrl:     v('s-sheet-url'),
      scriptUrl:       v('s-script-url'),
      // Preserve existing push / calendar / drive config — not in the form.
      vapidPublicKey:  _existingInteg.vapidPublicKey
                         || (typeof VAPID_PUBLIC_KEY !== 'undefined' ? VAPID_PUBLIC_KEY : ''),
      pushFunctionUrl: _existingInteg.pushFunctionUrl || '/.netlify/functions/send-push',
      calendarId:      _existingInteg.calendarId      || 'primary',
      driveFolderId:   _existingInteg.driveFolderId   || null,
    },

    pricing: {
      baseRate:        parseFloat(v('s-rate')) || 350,
      currency:        (v('s-currency') || 'AUD').toUpperCase(),
      locationContext: [suburb, state, v('s-country') || 'Australia'].filter(Boolean).join(', '),
      // Preserve any locationFactors the host configured elsewhere.
      // On a brand-new install this is '' (empty default), which lets the AI
      // pricing prompt fall back to generic STR principles.
      locationFactors: _existingPrice.locationFactors || '',
    },
  };
}


function _setupBlankConfig() {
  const d = (typeof DEFAULT_PROPERTY_CONFIG !== 'undefined') ? DEFAULT_PROPERTY_CONFIG : {};
  return {
    propertyId: '',
    name: '',
    suburb: '',
    state: '',
    region: '',
    country: d.country || 'Australia',
    branding: { subtitle: '', tagline: '' },
    property: { bedrooms: '', maxGuests: '', bathrooms: '', type: 'house' },
    owner: { name: '', email: '', phone: '' },
    integrations: {
      sheetCsvUrl: '',
      scriptUrl: '',
      vapidPublicKey: (d.integrations && d.integrations.vapidPublicKey) || '',
      pushFunctionUrl: (d.integrations && d.integrations.pushFunctionUrl) || '/.netlify/functions/send-push',
      calendarId: (d.integrations && d.integrations.calendarId) || 'primary',
      driveFolderId: null
    },
    pricing: {
      baseRate: (d.pricing && d.pricing.baseRate) || 350,
      currency: (d.pricing && d.pricing.currency) || 'AUD',
      locationContext: '',
      locationFactors: ''
    }
  };
}

// ── STYLES ────────────────────────────────────────────────────────────────────
function _setupInjectStyles() {
  if (document.getElementById('setup-styles')) return;
  const s = document.createElement('style');
  s.id = 'setup-styles';
  s.textContent = `
    /* ── Overlay backdrop ── */
    #setup-overlay {
      position: fixed;
      inset: 0;
      z-index: 10000;
      background: rgba(8, 18, 12, 0.74);
      display: flex;
      align-items: flex-start;
      justify-content: center;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      padding: env(safe-area-inset-top, 20px) 12px 48px;
      transition: opacity 0.28s ease, transform 0.28s ease;
    }

    /* ── Card ── */
    #setup-card {
      width: 100%;
      max-width: 540px;
      background: #fff;
      border-radius: 20px;
      overflow: hidden;
      box-shadow: 0 28px 64px rgba(0, 0, 0, 0.30);
      font-family: 'DM Sans', sans-serif;
      margin-top: 12px;
    }

    /* ── Header ── */
    #setup-header {
      background: var(--forest, #1E3A2F);
      padding: 22px 22px 18px;
      display: flex;
      align-items: flex-start;
      gap: 14px;
    }
    #setup-icon {
      font-size: 30px;
      line-height: 1;
      flex-shrink: 0;
      margin-top: 3px;
    }
    #setup-title {
      font-family: 'DM Serif Display', serif;
      font-size: 19px;
      color: #fff;
      line-height: 1.25;
      margin-bottom: 5px;
    }
    #setup-desc {
      font-size: 12px;
      color: var(--sage, #8FAF85);
      line-height: 1.5;
    }

    /* ── Form body ── */
    #setup-form {
      padding: 0 18px;
    }

    /* ── Section labels ── */
    .ss-label {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--text-soft, #6B6560);
      padding: 16px 0 9px;
      border-top: 1px solid var(--warm, #F0EDE8);
      margin-top: 2px;
    }
    .ss-label:first-of-type { border-top: none; padding-top: 16px; }

    /* ── Grid rows ── */
    .ss-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-bottom: 10px;
    }
    .ss-row-3 { grid-template-columns: 1fr 1fr 1fr; }
    .ss-wide  { grid-column: 1 / -1; }

    /* ── Field / label / input ── */
    .ss-field {
      display: flex;
      flex-direction: column;
    }
    .ss-lbl {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.45px;
      color: var(--text-soft, #6B6560);
      margin-bottom: 5px;
    }
    .ss-req { color: var(--red, #C0392B); font-size: 13px; }
    .ss-opt {
      font-weight: 400;
      font-style: italic;
      text-transform: none;
      letter-spacing: 0;
      font-size: 10px;
    }
    .ss-inp {
      width: 100%;
      box-sizing: border-box;
      background: var(--mist, #F8F6F3);
      border: 1.5px solid var(--stone, #C4BDB5);
      border-radius: 10px;
      padding: 10px 12px;
      font-family: 'DM Sans', sans-serif;
      font-size: 14px;
      color: var(--text, #1A1A1A);
      -webkit-appearance: none;
      transition: border-color 0.14s, box-shadow 0.14s;
    }
    .ss-inp:focus {
      outline: none;
      border-color: var(--forest, #1E3A2F);
      box-shadow: 0 0 0 3px rgba(30, 58, 47, 0.10);
    }
    .ss-inp::placeholder { color: var(--stone, #C4BDB5); }
    .ss-inp.ss-error     { border-color: var(--red, #C0392B); }
    .ss-hint {
      font-size: 11px;
      color: var(--text-soft, #6B6560);
      margin-top: 4px;
      line-height: 1.45;
    }

    /* ── Error banner ── */
    #setup-errors {
      margin-top: 14px;
      background: #FEF2F2;
      border: 1px solid #FECACA;
      border-radius: 10px;
      padding: 12px 14px;
    }
    .ss-error-row {
      display: flex;
      gap: 7px;
      align-items: baseline;
      font-size: 12px;
      font-weight: 600;
      color: var(--red, #C0392B);
      margin-bottom: 4px;
      line-height: 1.4;
    }
    .ss-error-row:last-child { margin-bottom: 0; }

    /* ── Sticky footer with action buttons ── */
    #setup-actions {
      position: sticky;
      bottom: 0;
      background: #fff;
      border-top: 1px solid var(--warm, #F0EDE8);
      margin: 14px -18px 0;
      padding: 14px 18px calc(14px + env(safe-area-inset-bottom, 0px));
      display: flex;
      gap: 10px;
    }
    .ss-btn-primary {
      flex: 1;
      background: var(--forest, #1E3A2F);
      color: #fff;
      border: none;
      border-radius: 12px;
      padding: 14px;
      font-family: 'DM Sans', sans-serif;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      transition: opacity 0.14s, transform 0.1s;
      -webkit-tap-highlight-color: transparent;
    }
    .ss-btn-primary:active  { opacity: 0.82; transform: scale(0.98); }
    .ss-btn-primary:disabled { opacity: 0.55; cursor: default; transform: none; }
    .ss-btn-secondary {
      background: var(--warm, #F0EDE8);
      color: var(--forest, #1E3A2F);
      border: none;
      border-radius: 12px;
      padding: 14px 20px;
      font-family: 'DM Sans', sans-serif;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      -webkit-tap-highlight-color: transparent;
    }

    /* ── Responsive narrow screens ── */
    @media (max-width: 400px) {
      .ss-row     { grid-template-columns: 1fr; }
      .ss-row-3   { grid-template-columns: 1fr 1fr; }
      #setup-header { padding: 18px 16px 16px; }
      #setup-form   { padding: 0 14px; }
      #setup-actions { margin: 14px -14px 0; padding: 14px 14px calc(14px + env(safe-area-inset-bottom, 0px)); }
    }
  `;
  document.head.appendChild(s);
}
