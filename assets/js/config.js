/* ═══════════════════════════════════════════════════════════════════════════
   PROPERTY CONFIG — Glenhaven Property Manager (Product Version)
   ═══════════════════════════════════════════════════════════════════════════ */

const PROPERTY_CONFIG_KEY = 'gh-property-config'; // legacy single-property key
const PROPERTIES_KEY = 'gh-properties';
const ACTIVE_PROPERTY_ID_KEY = 'gh-active-property-id';

// ── KEY NAMESPACING ────────────────────────────────────────────────────────────
/**
 * Returns a namespaced localStorage key for the current property.
 *
 * For propertyId 'glenhaven' the prefix is 'gh-' so all existing keys are
 * preserved unchanged — zero migration cost for the live app.
 * Any other propertyId produces '{id}-{key}', isolating each property's data.
 *
 * Usage: localStorage.getItem(lsKey('bookings'))  → 'gh-bookings' or 'seaview-bookings'
 *
 * @param {string} key  Short key name without prefix, e.g. 'bookings'.
 * @returns {string}
 */
function lsKey(key) {
  try {
    const raw  = localStorage.getItem(PROPERTY_CONFIG_KEY);
    const id   = (raw ? JSON.parse(raw).propertyId : null) || 'glenhaven';
    const safe = id.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/^-+|-+$/g, '');
    const prefix = safe === 'glenhaven' ? 'gh-' : safe + '-';
    return prefix + key;
  } catch (e) {
    return 'gh-' + key; // safe fallback — never breaks existing data
  }
}

// ── DEFAULTS ───────────────────────────────────────────────────────────────────
const DEFAULT_PROPERTY_CONFIG = {
  propertyId: 'glenhaven',
  name:       '',
  address:    '',
  suburb:     '',
  state:      'NSW',
  region:     '',
  country:    'Australia',

  branding: {
    subtitle: '',
    tagline:  '',
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
    reportEmailSubject: '',
    reportEmailBody:    '',
    autoSendReport:     false,
    reportFrequency:    'monthly',  // 'monthly' | 'quarterly'
    lastReportSentAt:   null,
  },

  integrations: {
    vapidPublicKey:  'BO-fP_0TOY1foiCQtOZ40N7io1MAzoMUui6pmeHPJ3jLxbdNGh0SrRjxtvWVhuf4QKvf4q83eyS_wcICiS4cgc4',
    pushFunctionUrl: '/.netlify/functions/send-push',
    calendarId:      'primary',
    driveFolderId:   null,
  },

  pricing: {
    baseRate:        350,
    locationContext: '',
    locationFactors: '',
    currency:        'AUD',
  },

  settings: {
    maxBackups:            30,
    autoSyncIntervalMs:    30000,
    cleanerSyncIntervalMs: 60000,
  },
};

// ── PROPERTY-SCOPED STORAGE PATCH ─────────────────────────────────────────────
// Keep shared config keys global; scope operational gh-* keys by active property.
const _GLOBAL_GH_KEYS = new Set([
  PROPERTY_CONFIG_KEY,
  PROPERTIES_KEY,
  ACTIVE_PROPERTY_ID_KEY,
  'gh-config-migrated-v1',
  'gh-setup-complete'
]);
const _SCOPED_KEY_PREFIXES = [
  'gh-bookings', 'gh-cleans', 'gh-notes', 'gh-expenses', 'gh-maintenance', 'gh-inventory',
  'gh-cleaners', 'gh-last-sync', 'gh-last-push', 'gh-last-backup', 'gh-last-cleaner',
  'gh-push-subs', 'gh-property-data', 'gh-drive-folder-id', 'gh-drive-token', 'gh-drive-token-expiry',
  'gh-drive-connect-dismissed', 'gh-gdrive-client-id', 'gh-api-key', 'gh-gemini-key', 'gh-base-rate',
  'gh-cleaning-fee', 'gh-clients', 'gh-expense-cats', 'gh-invoice-settings', 'gh-sms-template',
  'gh-owner-email', 'gh-inv-', 'gh-bank-', 'gh-cleaner-authed-', 'gh-email-tpl-', 'gh-fx-',
  'gh-ai-ignore'
];

(function patchLocalStorageForActiveProperty() {
  if (window.__ghScopedStoragePatched) return;
  window.__ghScopedStoragePatched = true;

  const p = Storage.prototype;
  const _get = p.getItem;
  const _set = p.setItem;
  const _remove = p.removeItem;

  const rawActiveId = () => {
    const id = _get.call(localStorage, ACTIVE_PROPERTY_ID_KEY);
    return id || 'default';
  };

  const shouldScope = (key) => {
    if (!key || typeof key !== 'string') return false;
    if (!key.startsWith('gh-')) return false;
    if (_GLOBAL_GH_KEYS.has(key)) return false;
    return _SCOPED_KEY_PREFIXES.some(prefix => key.startsWith(prefix));
  };

  const scopedKey = key => key + '::' + rawActiveId();

  p.getItem = function(key) {
    if (shouldScope(key)) {
      const scoped = _get.call(this, scopedKey(key));
      if (scoped !== null) return scoped;
    }
    return _get.call(this, key);
  };

  p.setItem = function(key, value) {
    if (shouldScope(key)) return _set.call(this, scopedKey(key), value);
    return _set.call(this, key, value);
  };

  p.removeItem = function(key) {
    if (shouldScope(key)) {
      _remove.call(this, scopedKey(key));
      // also remove legacy unscoped key when explicitly deleting
      _remove.call(this, key);
      return;
    }
    _remove.call(this, key);
  };
})();


// ── MULTI-PROPERTY HELPERS ────────────────────────────────────────────────────
function _normalisePropertyId(raw, fallbackName) {
  const base = String(raw || fallbackName || 'property')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'property';

  const ids = new Set(getAllProperties().map(p => p && p.propertyId).filter(Boolean));
  if (!ids.has(base)) return base;
  let i = 2;
  while (ids.has(base + '-' + i)) i++;
  return base + '-' + i;
}

function getAllProperties() {
  try {
    const raw = localStorage.getItem(PROPERTIES_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list
      .filter(Boolean)
      .map(p => {
        const merged = _deepMerge(_cloneDefaults(), p || {});
        merged.propertyId = merged.propertyId || merged.id || _normalisePropertyId('', merged.name);
        merged.id = merged.propertyId;
        return merged;
      });
  } catch (e) {
    console.warn('[Config] Failed to load gh-properties.', e);
    return [];
  }
}

function saveAllProperties(list) {
  try {
    const safe = (Array.isArray(list) ? list : [])
      .filter(Boolean)
      .map((p, i) => {
        const merged = _deepMerge(_cloneDefaults(), p || {});
        merged.propertyId = merged.propertyId || merged.id || _normalisePropertyId('', merged.name || ('property-' + (i + 1)));
        merged.id = merged.propertyId;
        return merged;
      });
    localStorage.setItem(PROPERTIES_KEY, JSON.stringify(safe));
    return safe;
  } catch (e) {
    console.warn('[Config] Failed to save gh-properties.', e);
    return null;
  }
}

function getActivePropertyId() {
  const id = localStorage.getItem(ACTIVE_PROPERTY_ID_KEY);
  if (id) return id;
  const list = getAllProperties();
  return (list[0] && list[0].propertyId) || null;
}

function setActivePropertyId(id) {
  const list = getAllProperties();
  const found = list.find(p => p.propertyId === id || p.id === id);
  if (!found) return false;
  localStorage.setItem(ACTIVE_PROPERTY_ID_KEY, found.propertyId);
  _syncLegacyMirrorsFromActive();
  return true;
}

function getPropertyById(id) {
  const list = getAllProperties();
  const hit = list.find(p => p.propertyId === id || p.id === id);
  return hit ? _deepMerge(_cloneDefaults(), hit) : null;
}

function getActivePropertyConfig() {
  const activeId = getActivePropertyId();
  if (!activeId) return _cloneDefaults();
  return getPropertyById(activeId) || _cloneDefaults();
}

function addPropertyConfig(property) {
  const list = getAllProperties();
  const next = _deepMerge(_cloneDefaults(), property || {});
  next.propertyId = _normalisePropertyId(next.propertyId || next.id, next.name);
  next.id = next.propertyId;
  list.push(next);
  saveAllProperties(list);
  localStorage.setItem(ACTIVE_PROPERTY_ID_KEY, next.propertyId);
  _syncLegacyMirrorsFromActive();
  return next;
}

function updatePropertyConfig(id, patch) {
  const list = getAllProperties();
  const idx = list.findIndex(p => p.propertyId === id || p.id === id);
  if (idx === -1) return null;
  const merged = _deepMerge(list[idx], patch || {});
  merged.propertyId = list[idx].propertyId;
  merged.id = merged.propertyId;
  list[idx] = merged;
  saveAllProperties(list);
  if (getActivePropertyId() === id) _syncLegacyMirrorsFromActive();
  return merged;
}

function removePropertyConfig(id) {
  const list = getAllProperties();
  if (list.length <= 1) return false;
  const next = list.filter(p => p.propertyId !== id);
  if (next.length === list.length) return false;
  saveAllProperties(next);
  if (getActivePropertyId() === id) {
    localStorage.setItem(ACTIVE_PROPERTY_ID_KEY, next[0].propertyId);
    _syncLegacyMirrorsFromActive();
  }
  return true;
}

function migrateLegacySinglePropertyConfig() {
  const existing = getAllProperties();
  if (existing.length) {
    const active = getActivePropertyId();
    if (!active || !existing.find(p => p.propertyId === active)) {
      localStorage.setItem(ACTIVE_PROPERTY_ID_KEY, existing[0].propertyId);
    }
    return;
  }

  let source = null;
  try {
    const raw = localStorage.getItem(PROPERTY_CONFIG_KEY);
    if (raw) source = JSON.parse(raw);
  } catch (e) {}

  if (!source) {
    // Legacy fallback from older keys
    const email = localStorage.getItem('gh-inv-email') || '';
    const ownerName = localStorage.getItem('gh-inv-name') || '';
    const baseRate = Number(localStorage.getItem('gh-base-rate') || 0) || 0;
    if (email || ownerName || baseRate) {
      source = {
        owner: { email, name: ownerName },
        pricing: { baseRate: baseRate || 350 }
      };
    }
  }

  if (!source) return;

  const merged = _deepMerge(_cloneDefaults(), source);
  merged.propertyId = _normalisePropertyId(merged.propertyId || merged.id, merged.name);
  merged.id = merged.propertyId;
  saveAllProperties([merged]);
  localStorage.setItem(ACTIVE_PROPERTY_ID_KEY, merged.propertyId);
  localStorage.setItem('gh-setup-complete', '1');
  _syncLegacyMirrorsFromActive();
}


// ── FIRST-BOOT DETECTION ───────────────────────────────────────────────────────
function hasValidPropertyConfig() {
  if (localStorage.getItem('gh-setup-complete') === '1') return true;
  const active = getActivePropertyConfig();
  return !!(active && active.name);
}


// ── COMPAT: SINGLE-PROPERTY API NOW TARGETS ACTIVE PROPERTY ───────────────────
function getPropertyConfig() {
  return getActivePropertyConfig();
}

function savePropertyConfig(updates) {
  const active = getActivePropertyConfig();
  const activeId = getActivePropertyId();

  // First save path on fresh setup where no property exists yet.
  if (!activeId || !getPropertyById(activeId)) {
    const first = _deepMerge(active, updates || {});
    first.propertyId = _normalisePropertyId(first.propertyId, first.name);
    first.updated_at = new Date().toISOString();
    saveAllProperties([first]);
    localStorage.setItem(ACTIVE_PROPERTY_ID_KEY, first.propertyId);
    localStorage.setItem(PROPERTY_CONFIG_KEY, JSON.stringify(first));
    _syncLegacyMirrorsFromActive();
    // Only sync to cloud when not hydrating — during hydration cloud is already source of truth
    if (!window._stayOpsHydrating && typeof saveHostConfigToCloud === 'function') {
      saveHostConfigToCloud(first);
    }
    return first;
  }

  const merged = updatePropertyConfig(activeId, updates || {});
  if (merged) {
    merged.updated_at = new Date().toISOString();
    // Re-save with timestamp
    const list = getAllProperties();
    const idx = list.findIndex(p => p.propertyId === activeId || p.id === activeId);
    if (idx !== -1) { list[idx] = merged; saveAllProperties(list); }
    localStorage.setItem(PROPERTY_CONFIG_KEY, JSON.stringify(merged));
    // Only sync to cloud when not hydrating
    if (!window._stayOpsHydrating && typeof saveHostConfigToCloud === 'function') {
      saveHostConfigToCloud(merged);
    }
  }
  return merged;
}


// ── ACCESSOR HELPERS ───────────────────────────────────────────────────────────

function getCurrentPropertyName() {
  return getActivePropertyConfig().name || 'Property';
}

function getCurrentPropertySubtitle() {
  const c = getActivePropertyConfig();
  if (c.branding && c.branding.subtitle) return c.branding.subtitle;
  return [c.suburb, c.state].filter(Boolean).join(' · ');
}

function getCurrentPropertyTagline() {
  const c = getActivePropertyConfig();
  if (c.branding && c.branding.tagline) return c.branding.tagline;
  return [[c.suburb, c.state].filter(Boolean).join(', '), c.region].filter(Boolean).join(' · ');
}

function getCurrentOwnerEmail() {
  const c = getActivePropertyConfig();
  return (c.owner && c.owner.email)
    || localStorage.getItem('gh-inv-email')
    || localStorage.getItem('gh-owner-email')
    || '';
}

function getVapidPublicKey() {
  const c = getActivePropertyConfig();
  if (c.integrations && c.integrations.vapidPublicKey) return c.integrations.vapidPublicKey;
  return (typeof VAPID_PUBLIC_KEY !== 'undefined') ? VAPID_PUBLIC_KEY : '';
}

function getPushFunctionUrl() {
  const c = getActivePropertyConfig();
  return (c.integrations && c.integrations.pushFunctionUrl) || '/.netlify/functions/send-push';
}

function getReceiptsFolderName() { return getCurrentPropertyName() + ' Receipts'; }
function getBackupsFolderName()  { return getCurrentPropertyName() + ' Backups';  }

function getPropertyStats() {
  const c = getActivePropertyConfig();
  return {
    bedrooms:  (c.property && c.property.bedrooms)  || 0,
    maxGuests: (c.property && c.property.maxGuests) || 0,
    bathrooms: (c.property && c.property.bathrooms) || 0,
  };
}

function getPricingConfig() {
  return getActivePropertyConfig().pricing || DEFAULT_PROPERTY_CONFIG.pricing;
}

function buildCalendarEventSummary(guestName) {
  return '🏡 ' + (guestName || 'Guest') + ' — ' + getCurrentPropertyName();
}

function getDriveFolderId() {
  const c = getActivePropertyConfig();
  if (c.integrations && c.integrations.driveFolderId) return c.integrations.driveFolderId;
  return localStorage.getItem('gh-drive-folder-id') || null;
}

function getDriveClientId() {
  return localStorage.getItem('gh-gdrive-client-id') || '';
}

function getPropertyConfigGaps() {
  // All data is stored in Supabase — no external service gaps to check.
  return [];
}

function saveDriveFolderId(storageKey) {
  localStorage.setItem('gh-drive-folder-id', storageKey);
  savePropertyConfig({ integrations: { driveFolderId: storageKey } });
}

// ── MIGRATION ──────────────────────────────────────────────────────────────────
function migrateConfigFromLegacySettings() {
  const MIGRATION_FLAG = 'gh-config-migrated-v1';
  if (localStorage.getItem(MIGRATION_FLAG)) {
    migrateLegacySinglePropertyConfig();
    return;
  }

  migrateLegacySinglePropertyConfig();

  const updates = { integrations: {}, owner: {} };
  const email = localStorage.getItem('gh-inv-email');
  const ownerName = localStorage.getItem('gh-inv-name');
  const storageKey = localStorage.getItem('gh-drive-folder-id');
  const baseRate = localStorage.getItem('gh-base-rate');

  if (storageKey)   updates.integrations.driveFolderId = storageKey;
  if (email)      updates.owner.email = email;
  if (ownerName)  updates.owner.name = ownerName;
  if (baseRate)   updates.pricing = { baseRate: Number(baseRate) || 350 };

  savePropertyConfig(updates);
  localStorage.setItem(MIGRATION_FLAG, '1');

  _syncLegacyMirrorsFromActive();
}


// ── DOM INIT ───────────────────────────────────────────────────────────────────
function initPropertyUI() {
  const cfg = getActivePropertyConfig();
  const stats = getPropertyStats();

  document.title = cfg.name + ' — Property Manager';
  const headerNameEl = document.getElementById('header-property-name');
  if (headerNameEl) headerNameEl.textContent = cfg.name || 'StayOps';
  const chevronHeader = document.getElementById('prop-switcher-chevron-header');
  if (chevronHeader) chevronHeader.style.display = '';

  _setText('header-sub-title', getCurrentPropertySubtitle());
  _setText('prop-hero-name', cfg.name);
  _setText('prop-hero-tagline', getCurrentPropertyTagline());
  _setText('prop-hero-beds', stats.bedrooms);
  _setText('prop-hero-guests', stats.maxGuests);
  _setText('prop-hero-baths', stats.bathrooms);

  _setText('prop-info-name', cfg.name);
  _setText('prop-info-location', [cfg.suburb, cfg.state].filter(Boolean).join(', '));
  _setText('prop-info-beds', stats.bedrooms);
  _setText('prop-info-guests', stats.maxGuests);
  _setText('prop-info-baths', stats.bathrooms);
  _setText('active-property-name', cfg.name);

  if (typeof renderPropertySwitcher === 'function') renderPropertySwitcher();
  if (typeof renderSetupWarningBanner === 'function') renderSetupWarningBanner();
}

function _setText(id, value) {
  const el = document.getElementById(id);
  if (el && value !== undefined && value !== null) el.textContent = String(value);
}

function _syncLegacyMirrorsFromActive() {
  const cfg = getActivePropertyConfig();
  if (!cfg) return;

  if (cfg.owner && cfg.owner.email) localStorage.setItem('gh-inv-email', cfg.owner.email);
  if (cfg.owner && cfg.owner.name) localStorage.setItem('gh-inv-name', cfg.owner.name);

  // Keep single-property shadow for backward-compatible reads.
  try { localStorage.setItem(PROPERTY_CONFIG_KEY, JSON.stringify(cfg)); } catch (e) {}
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
