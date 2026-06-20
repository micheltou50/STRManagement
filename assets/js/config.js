/* ═══════════════════════════════════════════════════════════════════════════
   PROPERTY CONFIG — Glenhaven Property Manager (Product Version)
   ═══════════════════════════════════════════════════════════════════════════ */

import { makeUuid } from './utils.js';

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

// ── DEFAULTS ───────────────────────────────────────────────────────────────────
export const DEFAULT_PROPERTY_CONFIG = {
  propertyId: '',
  name:       '',
  address:    '',
  suburb:     '',
  state:      'NSW',
  region:     '',
  country:    'Australia',

  platforms: [],

  airbnbListingUrl:   '',
  airbnbListingId:    '',
  airbnbListingTitle: '',
  bookingComUrl:      '',
  stayzUrl:           '',
  vrboUrl:            '',

  branding: {
    subtitle: '',
    tagline:  '',
  },

  property: {
    bedrooms:  0,
    maxGuests: 0,
    bathrooms: 0,
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
  },

  pricing: {
    baseRate:        0,
    locationContext: '',
    locationFactors: '',
    currency:        'AUD',
  },

  settings: {
    maxBackups:            30,
    autoSyncIntervalMs:    30000,
    cleanerSyncIntervalMs: 60000,
    expense_payout_mode:   'deduct', // 'deduct' = deduct from owner payout | 'separate' = show separately
    owner_paid_categories: ['mortgage', 'insurance', 'council_rates', 'strata'], // categories NOT deducted from payout
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
  'gh-push-subs', 'gh-property-data', 'gh-api-key', 'gh-gemini-key', 'gh-base-rate',
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
function _normalizePropertyId(raw, fallbackName) {
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

export function getAllProperties() {
  try {
    const raw = localStorage.getItem(PROPERTIES_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list
      .filter(Boolean)
      .filter(p => p.name || p.propertyId !== 'property')
      .map(p => {
        const merged = _deepMerge(_cloneDefaults(), p || {});
        merged.propertyId = merged.propertyId || merged.id || _normalizePropertyId('', merged.name);
        merged.id = merged.propertyId;
        return merged;
      });
  } catch (e) {
    console.warn('[Config] Failed to load gh-properties.', e);
    return [];
  }
}

export function saveAllProperties(list) {
  try {
    const safe = (Array.isArray(list) ? list : [])
      .filter(Boolean)
      .map((p, i) => {
        const merged = _deepMerge(_cloneDefaults(), p || {});
        merged.propertyId = merged.propertyId || merged.id || _normalizePropertyId('', merged.name || ('property-' + (i + 1)));
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

export function getActivePropertyId() {
  const id = localStorage.getItem(ACTIVE_PROPERTY_ID_KEY);
  if (id) return id;
  const list = getAllProperties();
  return (list[0] && list[0].propertyId) || null;
}

export function setActivePropertyId(id) {
  const list = getAllProperties();
  const found = list.find(p => p.propertyId === id || p.id === id);
  if (!found) return false;
  localStorage.setItem(ACTIVE_PROPERTY_ID_KEY, found.propertyId);
  _syncLegacyMirrorsFromActive();

  const supabaseUUID = found && found.supabaseId ? found.supabaseId : null;
  if (supabaseUUID && window._sb && window._supabaseUser) {
    window._sb
      .from('app_config')
      .update({ active_property_id: supabaseUUID, updated_at: new Date().toISOString() })
      .eq('user_id', window._supabaseUser.id)
      .then(({ error }) => {
        // supabase-js v2 RESOLVES (doesn't reject) on a DB error, so the old
        // .then(() => 'synced') logged success even on failure (3.2).
        if (error) console.warn('[StayOps] Active property sync failed', error.message);
        else console.log('[StayOps] Active property synced to cloud');
      })
      .catch(e => console.warn('[StayOps] Active property sync failed', e));
  }
  return true;
}

export function saveUiPreferenceToCloud(key, value) {
  if (!key) return;
  window._appConfig = window._appConfig || {};
  window._appConfig.ui_preferences = window._appConfig.ui_preferences || {};
  window._appConfig.ui_preferences[key] = value;

  if (window._sb && window._supabaseUser) {
    window._sb
      .from('app_config')
      .update({ ui_preferences: { ...window._appConfig.ui_preferences, [key]: value } })
      .eq('user_id', window._supabaseUser.id)
      .then(({ error }) => {  // {error} resolves (not rejects) on DB failure (3.2)
        if (error) console.warn('[StayOps] UI preference sync failed', error.message);
      })
      .catch(e => console.warn('[StayOps] UI preference sync failed', e));
  }
}

export function getPropertyById(id) {
  const list = getAllProperties();
  const hit = list.find(p => p.propertyId === id || p.id === id);
  return hit ? _deepMerge(_cloneDefaults(), hit) : null;
}

export function getActivePropertyConfig() {
  const activeId = getActivePropertyId();
  if (!activeId) return _cloneDefaults();
  return getPropertyById(activeId) || _cloneDefaults();
}

export function addPropertyConfig(property) {
  const list = getAllProperties();
  const next = _deepMerge(_cloneDefaults(), property || {});

  next.propertyId = _normalizePropertyId(next.propertyId || next.id, next.name);
  next.id = next.propertyId;
  next.supabaseId = next.supabaseId || makeUuid();
  next.updated_at = next.updated_at || new Date().toISOString();

  list.push(next);
  saveAllProperties(list);
  localStorage.setItem(ACTIVE_PROPERTY_ID_KEY, next.propertyId);
  _syncLegacyMirrorsFromActive();
  return next;
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
  } catch (_e) { /* ignore malformed localStorage JSON */ }

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
  merged.propertyId = _normalizePropertyId(merged.propertyId || merged.id, merged.name);
  merged.id = merged.propertyId;
  saveAllProperties([merged]);
  localStorage.setItem(ACTIVE_PROPERTY_ID_KEY, merged.propertyId);
  localStorage.setItem('gh-setup-complete', '1');
  _syncLegacyMirrorsFromActive();
}


// ── FIRST-BOOT DETECTION ───────────────────────────────────────────────────────
export function hasValidPropertyConfig() {
  if (localStorage.getItem('gh-setup-complete') === '1') return true;
  const active = getActivePropertyConfig();
  return !!(active && active.name);
}


// ── COMPAT: SINGLE-PROPERTY API NOW TARGETS ACTIVE PROPERTY ───────────────────
export function getPropertyConfig() {
  return getActivePropertyConfig();
}

export function savePropertyConfig(updates) {
  const active = getActivePropertyConfig();
  const activeId = getActivePropertyId();

  const ts = (updates && updates.updated_at) || new Date().toISOString();

  // First save path on fresh setup where no property exists yet.
  if (!activeId || !getPropertyById(activeId)) {
    const first = _deepMerge(active, updates || {});
    first.propertyId = _normalizePropertyId(first.propertyId, first.name);
    first.id = first.propertyId;
    first.supabaseId = first.supabaseId || makeUuid();
    first.updated_at = ts;

    saveAllProperties([first]);
    localStorage.setItem(ACTIVE_PROPERTY_ID_KEY, first.propertyId);
    localStorage.setItem(PROPERTY_CONFIG_KEY, JSON.stringify(first));
    _syncLegacyMirrorsFromActive();

    if (!window._stayOpsHydrating && typeof globalThis.saveHostConfigToCloud === 'function') {
      globalThis.saveHostConfigToCloud(first);
    }
    return first;
  }

  const current = getPropertyById(activeId) || active || {};
  const merged = _deepMerge(current, updates || {});
  merged.propertyId = current.propertyId || activeId;
  merged.id = merged.propertyId;
  merged.supabaseId = merged.supabaseId || current.supabaseId || makeUuid();
  merged.updated_at = ts;

  const list = getAllProperties();
  const idx = list.findIndex(p => p.propertyId === activeId || p.id === activeId);
  if (idx !== -1) {
    list[idx] = merged;
    saveAllProperties(list);
  }

  localStorage.setItem(PROPERTY_CONFIG_KEY, JSON.stringify(merged));
  _syncLegacyMirrorsFromActive();

  if (!window._stayOpsHydrating && typeof globalThis.saveHostConfigToCloud === 'function') {
    globalThis.saveHostConfigToCloud(merged);
  }
  if (typeof globalThis.renderOnboardingGuidance === 'function') globalThis.renderOnboardingGuidance();
  return merged;
}


// ── ACCESSOR HELPERS ───────────────────────────────────────────────────────────

export function getCurrentPropertyName() {
  return getActivePropertyConfig().name || 'Property';
}

function getCurrentPropertySubtitle() {
  const c = getActivePropertyConfig();
  if (c.branding && c.branding.subtitle) return c.branding.subtitle;
  return [c.suburb, c.state].filter(Boolean).join(' · ');
}

export function getCurrentPropertyTagline() {
  const c = getActivePropertyConfig();
  if (c.branding && c.branding.tagline) return c.branding.tagline;
  return [[c.suburb, c.state].filter(Boolean).join(', '), c.region].filter(Boolean).join(' · ');
}

export function getCurrentHostName() {
  try {
    const profile = JSON.parse(localStorage.getItem('gh-host-profile') || 'null');
    if (profile && profile.name) return profile.name;
  } catch (_e) { /* ignore */ }
  return '';
}

export function getCurrentHostEmail() {
  try {
    const profile = JSON.parse(localStorage.getItem('gh-host-profile') || 'null');
    if (profile && profile.email) return profile.email;
  } catch (_e) { /* ignore malformed profile JSON */ }
  return localStorage.getItem('gh-inv-email') || '';
}

// getCurrentOwnerEmail — the PROPERTY OWNER's email (the investor/client).
// Use this ONLY for owner reports. Do NOT use for host notifications.
export function getCurrentOwnerEmail() {
  const c = getActivePropertyConfig();
  return (c.owner && c.owner.email)
    || localStorage.getItem('gh-owner-email')
    || '';
}

export function getVapidPublicKey() {
  return 'BO-fP_0TOY1foiCQtOZ40N7io1MAzoMUui6pmeHPJ3jLxbdNGh0SrRjxtvWVhuf4QKvf4q83eyS_wcICiS4cgc4';
}

export function getPushFunctionUrl() {
  const c = getActivePropertyConfig();
  return (c.integrations && c.integrations.pushFunctionUrl) || '/.netlify/functions/send-push';
}

export function getPropertyStats() {
  const c = getActivePropertyConfig();
  return {
    bedrooms:  (c.property && c.property.bedrooms)  || 0,
    maxGuests: (c.property && c.property.maxGuests) || 0,
    bathrooms: (c.property && c.property.bathrooms) || 0,
  };
}

export function getPricingConfig() {
  return getActivePropertyConfig().pricing || DEFAULT_PROPERTY_CONFIG.pricing;
}

export function getPropertyConfigGaps() {
  // All data is stored in Supabase — no external service gaps to check.
  return [];
}

// ── MIGRATION ──────────────────────────────────────────────────────────────────
export function migrateConfigFromLegacySettings() {
  const MIGRATION_FLAG = 'gh-config-migrated-v1';
  if (localStorage.getItem(MIGRATION_FLAG)) return;

  migrateLegacySinglePropertyConfig();

  const updates = { integrations: {}, owner: {} };
  const email = localStorage.getItem('gh-inv-email');
  const ownerName = localStorage.getItem('gh-inv-name');
  const baseRate = localStorage.getItem('gh-base-rate');

  if (email)      updates.owner.email = email;
  if (ownerName)  updates.owner.name = ownerName;
  if (baseRate)   updates.pricing = { baseRate: Number(baseRate) || 350 };

  // Only write if there is something real to migrate.
  // Calling savePropertyConfig with an empty payload triggers the first-save
  // path which creates a phantom property from _cloneDefaults() (state:'NSW',
  // no name) in a fresh private/incognito session — bypassing onboarding and
  // rendering a blank "0 beds / NSW" dashboard instead.
  if (email || ownerName || baseRate) {
    savePropertyConfig(updates);
  }

  localStorage.setItem(MIGRATION_FLAG, '1');
  _syncLegacyMirrorsFromActive();
}


// ── DOM INIT ───────────────────────────────────────────────────────────────────
export function initPropertyUI() {
  const cfg = getActivePropertyConfig();
  const stats = getPropertyStats();

  const _portfolio = typeof window !== 'undefined' && typeof window.isPortfolioMode === 'function' && window.isPortfolioMode();
  if (_portfolio) {
    document.title = 'All Properties — Property Manager';
  } else {
    document.title = cfg.name + ' — Property Manager';
  }
  const headerNameEl = document.getElementById('header-property-name');
  if (_portfolio) {
    if (headerNameEl) headerNameEl.textContent = 'All Properties';
    _setText('header-sub-title', getAllProperties().length + ' properties');
  } else {
    if (headerNameEl) headerNameEl.textContent = cfg.name || 'StayOps';
    _setText('header-sub-title', getCurrentPropertySubtitle());
  }
  const chevronHeader = document.getElementById('prop-switcher-chevron-header');
  if (chevronHeader) chevronHeader.style.display = '';
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
  try { localStorage.setItem(PROPERTY_CONFIG_KEY, JSON.stringify(cfg)); } catch (_e) { /* ignore storage quota errors */ }
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
