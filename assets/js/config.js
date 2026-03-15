/* ═══════════════════════════════════════════════════════════════════════════
   PROPERTY CONFIG — Glenhaven Property Manager (Product Version)
   ═══════════════════════════════════════════════════════════════════════════

   Load order in index.html:
     <script src="/assets/js/config.js"></script>   ← first
     <script src="/assets/js/setup.js"></script>    ← second
     <script src="/assets/js/adapter.js"></script>
     <script src="/assets/js/main.js"></script>

   v2 changes:
     + hasValidPropertyConfig()  — first-boot detection for setup.js
     + migrateConfigFromLegacySettings() now sets 'gh-setup-complete' when
       legacy keys exist, so existing Glenhaven users never see setup screen.
═══════════════════════════════════════════════════════════════════════════ */

const PROPERTY_CONFIG_KEY = 'gh-property-config';

// ── DEFAULTS ───────────────────────────────────────────────────────────────────
// Glenhaven values are safe defaults for the live app.
// For a new product deployment, set integrations.scriptUrl / sheetCsvUrl to ''
// so the first-boot setup flow is triggered for new hosts.
const DEFAULT_PROPERTY_CONFIG = {
  propertyId: 'glenhaven',
  name:       'Glenhaven',
  address:    '21 Glencoe Road, Katoomba NSW 2780',
  suburb:     'Katoomba',
  state:      'NSW',
  region:     'Blue Mountains',
  country:    'Australia',

  branding: {
    subtitle: 'Katoomba · NSW',
    tagline:  'Katoomba, NSW · Blue Mountains',
  },

  property: {
    bedrooms:  4,
    maxGuests: 8,
    bathrooms: 2.5,
    type:      'house',
  },

  owner: {
    name:  '',
    email: '',
    phone: '',
  },

  integrations: {
    sheetCsvUrl:     'https://docs.google.com/spreadsheets/d/e/2PACX-1vTlssTFmteUx1q3NkqRz2hAIqtJbt8OlRxl8VcX1x5gW6mI8W52n3xutATDO13qlRNoobKSsmVPciDR/pub?gid=0&single=true&output=csv',
    scriptUrl:       'https://script.google.com/macros/s/AKfycbzM0wcdsUqK03faXxk2VqTAEqzno4GCAMzFYGrUXc4y1LKDwd8GbCKhNJruvbXJGhOflw/exec',
    vapidPublicKey:  'BFOGuTUHozPz0HabwMEzAoaHk_31ftyhqBpxecKWa7BajCsgai-pa8CIimCTGzN4zKet9poURZOeho74KblxPfE',
    pushFunctionUrl: '/.netlify/functions/send-push',
    calendarId:      'primary',
    driveFolderId:   null,
  },

  pricing: {
    baseRate:        350,
    locationContext: 'Katoomba, Blue Mountains, NSW, Australia',
    locationFactors: '',
    // ↑ Intentionally empty. The AI pricing prompt falls back to generic STR
    //   principles when this is blank. Glenhaven's specific factors (Winter Magic
    //   Festival, Yulefest etc.) must not be the default for hosts in other markets.
    currency:        'AUD',
  },

  settings: {
    maxBackups:            30,
    autoSyncIntervalMs:    30000,
    cleanerSyncIntervalMs: 60000,
  },
};


// ── FIRST-BOOT DETECTION ───────────────────────────────────────────────────────
/**
 * Returns true when a usable property config already exists.
 * Called by setup.js before deciding whether to show the setup screen.
 * Must never throw.
 *
 * Three paths to "valid":
 *   1. 'gh-setup-complete' is set — user finished the setup flow.
 *   2. Legacy Glenhaven user: gh-config-migrated-v1 + gh-script-url present.
 *   3. Config object in localStorage has name + scriptUrl populated.
 */
function hasValidPropertyConfig() {
  if (localStorage.getItem('gh-setup-complete') === '1') return true;

  if (localStorage.getItem('gh-config-migrated-v1') &&
      localStorage.getItem('gh-script-url'))             return true;

  try {
    const raw = localStorage.getItem(PROPERTY_CONFIG_KEY);
    if (!raw) return false;
    const c = JSON.parse(raw);
    return !!(c && c.name && c.integrations && c.integrations.scriptUrl);
  } catch (e) { return false; }
}


// ── CONFIG READ / WRITE ────────────────────────────────────────────────────────
/**
 * Returns the merged config (saved ← defaults).
 * Never throws — returns defaults on parse error.
 */
function getPropertyConfig() {
  try {
    const saved = localStorage.getItem(PROPERTY_CONFIG_KEY);
    if (!saved) return _cloneDefaults();
    return _deepMerge(_cloneDefaults(), JSON.parse(saved));
  } catch (e) {
    console.warn('[Config] Failed to load property config — using defaults.', e);
    return _cloneDefaults();
  }
}

/**
 * Deep-merges `updates` into the current config and persists.
 * Empty strings and nulls do not overwrite existing values.
 * @param {Object} updates  Partial config (may be nested).
 * @returns {Object|null}
 */
function savePropertyConfig(updates) {
  try {
    const merged = _deepMerge(getPropertyConfig(), updates);
    localStorage.setItem(PROPERTY_CONFIG_KEY, JSON.stringify(merged));
    return merged;
  } catch (e) {
    console.warn('[Config] Failed to save property config.', e);
    return null;
  }
}


// ── ACCESSOR HELPERS ───────────────────────────────────────────────────────────

/** Apps Script URL. Priority: config → legacy gh-script-url → constant. */
function getCurrentScriptURL() {
  const cfg = getPropertyConfig();
  if (cfg.integrations && cfg.integrations.scriptUrl) return cfg.integrations.scriptUrl;
  const legacy = localStorage.getItem('gh-script-url');
  if (legacy) return legacy;
  return (typeof DEFAULT_SCRIPT_URL !== 'undefined') ? DEFAULT_SCRIPT_URL : '';
}

/** Published bookings CSV URL. Priority: config → SHEET_URL constant. */
function getPropertySheetCsvUrl() {
  const cfg = getPropertyConfig();
  if (cfg.integrations && cfg.integrations.sheetCsvUrl) return cfg.integrations.sheetCsvUrl;
  return (typeof SHEET_URL !== 'undefined') ? SHEET_URL : '';
}

function getCurrentPropertyName() {
  return getPropertyConfig().name || 'Property';
}

function getCurrentPropertySubtitle() {
  const c = getPropertyConfig();
  if (c.branding && c.branding.subtitle) return c.branding.subtitle;
  return [c.suburb, c.state].filter(Boolean).join(' · ');
}

function getCurrentPropertyTagline() {
  const c = getPropertyConfig();
  if (c.branding && c.branding.tagline) return c.branding.tagline;
  return [[c.suburb, c.state].filter(Boolean).join(', '), c.region].filter(Boolean).join(' · ');
}

/** Owner email. Priority: config → gh-inv-email → gh-owner-email → ''. */
function getCurrentOwnerEmail() {
  const c = getPropertyConfig();
  return (c.owner && c.owner.email)
    || localStorage.getItem('gh-inv-email')
    || localStorage.getItem('gh-owner-email')
    || '';
}

function getVapidPublicKey() {
  const c = getPropertyConfig();
  if (c.integrations && c.integrations.vapidPublicKey) return c.integrations.vapidPublicKey;
  return (typeof VAPID_PUBLIC_KEY !== 'undefined') ? VAPID_PUBLIC_KEY : '';
}

function getPushFunctionUrl() {
  const c = getPropertyConfig();
  return (c.integrations && c.integrations.pushFunctionUrl) || '/.netlify/functions/send-push';
}

function getReceiptsFolderName() { return getCurrentPropertyName() + ' Receipts'; }
function getBackupsFolderName()  { return getCurrentPropertyName() + ' Backups';  }

function getPropertyStats() {
  const c = getPropertyConfig();
  return {
    bedrooms:  (c.property && c.property.bedrooms)  || 0,
    maxGuests: (c.property && c.property.maxGuests) || 0,
    bathrooms: (c.property && c.property.bathrooms) || 0,
  };
}

function getPricingConfig() {
  return getPropertyConfig().pricing || DEFAULT_PROPERTY_CONFIG.pricing;
}

function buildCalendarEventSummary(guestName) {
  return '🏡 ' + (guestName || 'Guest') + ' — ' + getCurrentPropertyName();
}

function getDriveFolderId() {
  const c = getPropertyConfig();
  if (c.integrations && c.integrations.driveFolderId) return c.integrations.driveFolderId;
  return localStorage.getItem('gh-drive-folder-id') || null;
}

function saveDriveFolderId(folderId) {
  localStorage.setItem('gh-drive-folder-id', folderId);
  savePropertyConfig({ integrations: { driveFolderId: folderId } });
}

/**
 * Persists script URL to both legacy key AND config.
 * Call from saveScriptURL() in main.js.
 */
function persistScriptUrl(url) {
  if (!url) return;
  localStorage.setItem('gh-script-url', url);
  savePropertyConfig({ integrations: { scriptUrl: url } });
}


// ── MIGRATION ──────────────────────────────────────────────────────────────────
/**
 * One-time migration: copies legacy localStorage keys into config.
 * Sets 'gh-setup-complete' when legacy keys exist so existing users never
 * see the setup screen. Safe to call repeatedly.
 */
function migrateConfigFromLegacySettings() {
  const MIGRATION_FLAG = 'gh-config-migrated-v1';
  if (localStorage.getItem(MIGRATION_FLAG)) return;

  const updates     = { integrations: {}, owner: {} };
  const scriptUrl   = localStorage.getItem('gh-script-url');
  const email       = localStorage.getItem('gh-inv-email');
  const ownerName   = localStorage.getItem('gh-inv-name');
  const folderId    = localStorage.getItem('gh-drive-folder-id');
  const baseRate    = localStorage.getItem('gh-base-rate');

  if (scriptUrl)  updates.integrations.scriptUrl     = scriptUrl;
  if (folderId)   updates.integrations.driveFolderId  = folderId;
  if (email)      updates.owner.email                 = email;
  if (ownerName)  updates.owner.name                  = ownerName;
  if (baseRate)   updates.pricing = { baseRate: Number(baseRate) || 350 };

  savePropertyConfig(updates);
  localStorage.setItem(MIGRATION_FLAG, '1');

  // Existing user with a script URL → mark setup complete so they never
  // see the setup flow on first load after deploying this version.
  if (scriptUrl) localStorage.setItem('gh-setup-complete', '1');

  console.log('[Config] Legacy settings migrated to property config.');
}


// ── DOM INIT ───────────────────────────────────────────────────────────────────
/**
 * Patches static HTML elements with live config values.
 * Called after DOMContentLoaded and after setup form is saved.
 * Missing elements are silently skipped.
 */
function initPropertyUI() {
  const cfg   = getPropertyConfig();
  const stats = getPropertyStats();

  document.title = cfg.name + ' — Property Manager';

  _setText('header-sub-title',  getCurrentPropertySubtitle());
  _setText('prop-hero-name',    cfg.name);
  _setText('prop-hero-tagline', getCurrentPropertyTagline());
  _setText('prop-hero-beds',    stats.bedrooms);
  _setText('prop-hero-guests',  stats.maxGuests);
  _setText('prop-hero-baths',   stats.bathrooms);

  _setText('prop-info-name',     cfg.name);
  _setText('prop-info-location', [cfg.suburb, cfg.state].filter(Boolean).join(', '));
  _setText('prop-info-beds',     stats.bedrooms);
  _setText('prop-info-guests',   stats.maxGuests);
  _setText('prop-info-baths',    stats.bathrooms);
}

function _setText(id, value) {
  const el = document.getElementById(id);
  if (el && value !== undefined && value !== null) el.textContent = String(value);
}


// ── INTERNAL UTILS ─────────────────────────────────────────────────────────────
function _cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_PROPERTY_CONFIG));
}

function _deepMerge(target, source) {
  const out = Object.assign({}, target);
  for (const key of Object.keys(source || {})) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (srcVal === undefined || srcVal === null || srcVal === '') continue;
    if (Array.isArray(srcVal)) {
      out[key] = srcVal;
    } else if (srcVal && typeof srcVal === 'object') {
      out[key] = _deepMerge(tgtVal && typeof tgtVal === 'object' ? tgtVal : {}, srcVal);
    } else {
      out[key] = srcVal;
    }
  }
  return out;
}
