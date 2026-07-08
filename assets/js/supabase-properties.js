/**
 * StayOps — properties (partial): seedLocalConfigFromCloud + savePropertyToCloud —
 * the property-config <-> cloud sync. Split out of supabase.js 2026-07-09.
 * The property-resolution CORE (loadPropertyFromCloud, _toLocalPatch,
 * getCloudPropertyId) stays in the barrel because every property-scoped slice
 * depends on it; this slice imports loadPropertyFromCloud + _toLocalPatch back.
 * Config helpers come from ./config.js (same as the barrel). window._sb is global.
 */
import { getActivePropertyId, getAllProperties, setActivePropertyId, savePropertyConfig, addPropertyConfig, getActivePropertyConfig } from './config.js';
import { getCurrentSupabaseUser, loadPropertyFromCloud, _toLocalPatch } from './supabase.js';

export async function seedLocalConfigFromCloud() {
  console.log('[StayOps] seedLocalConfigFromCloud: starting...');
  try {
    // ── Cross-user guard ─────────────────────────────────────────────────────
    // gh-properties is a global (unscoped) localStorage key shared across all
    // accounts on the same device. When a different user signs in, their boot
    // sequence would merge cloud properties on top of the previous user's local
    // list. This guard detects a user change and wipes the global property keys
    // before any hydration runs, so the new user starts from a clean slate.
    // Safe for same-user offline: IDs match → no wipe, local cache preserved.
    const _authUser = await getCurrentSupabaseUser();
    if (_authUser) {
      const storedUserId = localStorage.getItem('gh-current-user-id');
      if (storedUserId && storedUserId !== _authUser.id) {
        console.log('[StayOps] seedLocalConfigFromCloud: user changed — clearing stale local property store');
        localStorage.removeItem('gh-properties');
        localStorage.removeItem('gh-property-config');
        localStorage.removeItem('gh-active-property-id');
        localStorage.removeItem('gh-setup-complete');
        localStorage.removeItem('gh-config-migrated-v1');
        localStorage.removeItem('gh-gmail-email');
        localStorage.removeItem('gh-outlook-email');
      }
      localStorage.setItem('gh-current-user-id', _authUser.id);
    }
    // ────────────────────────────────────────────────────────────────────────

    const cloudProps = await loadPropertyFromCloud();
    if (!Array.isArray(cloudProps) || !cloudProps.length) {
      console.log('[StayOps] seedLocalConfigFromCloud: no cloud properties');
      return false;
    }

    const normaliseLocalId = (raw) => String(raw || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);

    localStorage.setItem('gh-setup-complete', '1');
    window._stayOpsHydrating = true;
    window._cloudPropertyIds = window._cloudPropertyIds || {};

    const originalActiveId = getActivePropertyId();
    let preferredActiveId = null;

    try {
      for (const row of cloudProps) {
        const localList = getAllProperties();
        const byNameSlug = normaliseLocalId(row.name);
        let match = localList.find(p => p && p.supabaseId === row.id);
        if (!match && byNameSlug) match = localList.find(p => p && p.propertyId === byNameSlug);
        if (!match && row.name) {
          const lowerName = String(row.name).trim().toLowerCase();
          match = localList.find(p => String((p && p.name) || '').trim().toLowerCase() === lowerName);
        }

        if (match) {
          const localTs = match.updated_at ? new Date(match.updated_at).getTime() : 0;
          const cloudTs = row.updated_at   ? new Date(row.updated_at).getTime()   : 0;
          setActivePropertyId(match.propertyId);
          if (cloudTs >= localTs) {
            savePropertyConfig(_toLocalPatch(row, match));
          } else {
            savePropertyConfig({ supabaseId: row.id, updated_at: match.updated_at || row.updated_at || new Date().toISOString() });
          }
          window._cloudPropertyIds[match.propertyId] = row.id;
          if (!preferredActiveId) preferredActiveId = match.propertyId;
        } else {
          const created = addPropertyConfig(_toLocalPatch(row, {}));
          if (created && created.propertyId) {
            window._cloudPropertyIds[created.propertyId] = row.id;
            if (!preferredActiveId) preferredActiveId = created.propertyId;
          }
        }
      }
    } finally {
      const finalList = getAllProperties();
      if (originalActiveId && finalList.find(p => p.propertyId === originalActiveId)) {
        setActivePropertyId(originalActiveId);
      } else if (preferredActiveId) {
        setActivePropertyId(preferredActiveId);
      } else if (finalList[0]) {
        setActivePropertyId(finalList[0].propertyId);
      }
      window._stayOpsHydrating = false;
    }

    const activeCfg = getActivePropertyConfig();
    const activeCloud = activeCfg && activeCfg.supabaseId ? cloudProps.find(p => p.id === activeCfg.supabaseId) : null;
    if (activeCloud) {
      if (activeCloud.anthropic_api_key) localStorage.setItem('gh-api-key', activeCloud.anthropic_api_key);
      if (activeCloud.script_url) localStorage.setItem('gh-script-url', activeCloud.script_url);
      // mgmt_fee_rate is now sourced from window._appConfig
    }

    console.log('[StayOps] seedLocalConfigFromCloud: merged', cloudProps.length, 'properties');
    return true;
  } catch (e) {
    console.warn('[StayOps] seedLocalConfigFromCloud failed:', e);
    window._stayOpsHydrating = false;
    return false;
  }
}


export async function savePropertyToCloud(cfg) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !cfg) return null;

    const makeUuid = () => {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : ((r & 0x3) | 0x8);
        return v.toString(16);
      });
    };

    const activeCfg = getActivePropertyConfig();
    const activePropertyId = getActivePropertyId();
    const localPropertyId = cfg.propertyId || activeCfg.propertyId || activePropertyId || null;
    let cloudId = cfg.supabaseId || cfg._cloudId || activeCfg.supabaseId || null;
    if (!cloudId) cloudId = makeUuid();

    window._cloudPropertyIds = window._cloudPropertyIds || {};
    if (localPropertyId) window._cloudPropertyIds[localPropertyId] = cloudId;

    const raw = {
      id:                cloudId,
      user_id:           user.id,
      name:              cfg.name || null,
      address:           cfg.address || null,
      suburb:            cfg.suburb || null,
      state:             cfg.state || null,
      country:           cfg.country || null,
      region:            cfg.region || null,
      tagline:           (cfg.branding && cfg.branding.tagline) || null,
      bedrooms:          (cfg.property && cfg.property.bedrooms  != null) ? cfg.property.bedrooms  : null,
      bathrooms:         (cfg.property && cfg.property.bathrooms != null) ? cfg.property.bathrooms : null,
      max_guests:        (cfg.property && cfg.property.maxGuests != null) ? cfg.property.maxGuests : null,
      property_type:     (cfg.property && cfg.property.type) || null,
      timezone:          'Australia/Sydney',
      sheets_url:        (cfg.integrations && cfg.integrations.sheetCsvUrl) || null,
      script_url:        (cfg.integrations && cfg.integrations.syncUrl) || null,
      calendar_id:       null,
      vapid_public_key:  (cfg.integrations && cfg.integrations.vapidPublicKey) || null,
      base_rate:         (cfg.pricing && cfg.pricing.baseRate != null) ? cfg.pricing.baseRate : null,
      owner_name:        (cfg.owner && cfg.owner.name) || null,
      owner_email:       (cfg.owner && cfg.owner.email) || null,
      owner_phone:       (cfg.owner && cfg.owner.phone) || null,
      report_email_subject: (cfg.owner && cfg.owner.reportEmailSubject) || null,
      report_email_body:    (cfg.owner && cfg.owner.reportEmailBody) || null,
      auto_send_report:     (cfg.owner && cfg.owner.autoSendReport != null) ? cfg.owner.autoSendReport : null,
      report_frequency:     (cfg.owner && cfg.owner.reportFrequency) || null,
      last_report_sent_at:  (cfg.owner && cfg.owner.lastReportSentAt) || null,
      anthropic_api_key: localStorage.getItem('gh-api-key') || null,
      platforms:            Array.isArray(cfg.platforms) ? cfg.platforms : null,
      airbnb_listing_id:    cfg.airbnbListingId || null,
      airbnb_listing_url:   cfg.airbnbListingUrl || null,
      airbnb_listing_title: cfg.airbnbListingTitle || null,
      booking_com_url:      cfg.bookingComUrl || null,
      stayz_url:            cfg.stayzUrl || null,
      vrbo_url:             cfg.vrboUrl || null,
      mgmt_fee_rate:     (window._appConfig && window._appConfig.mgmt_fee_rate != null) ? window._appConfig.mgmt_fee_rate : null,
      // Phase 6: false = host manages this property for an owner (statement
      // renders in owner-payable mode). true (or absent) = host owns it
      // (statement renders in host-earned mode).
      is_self_managed:   (cfg.isSelfManaged === false) ? false : true,
      updated_at:        cfg.updated_at || new Date().toISOString()
    };

    const payload = Object.fromEntries(
      Object.entries(raw).filter(([key, value]) => {
        if (key === 'id' || key === 'user_id' || key === 'updated_at') return true;
        return value !== null && value !== '';
      })
    );

    const { data, error } = await window._sb
      .from('properties')
      .upsert(payload, { onConflict: 'id' })
      .select()
      .single();

    if (error) { console.warn('[StayOps] savePropertyToCloud error', error); return null; }

    const savedId = (data && data.id) || cloudId;
    if (localPropertyId) window._cloudPropertyIds[localPropertyId] = savedId;

    const isActiveProperty = !!(activePropertyId && localPropertyId === activePropertyId);
    if (isActiveProperty) {
      const prevHydrating = window._stayOpsHydrating;
      window._stayOpsHydrating = true;
      try {
        savePropertyConfig({ supabaseId: savedId, updated_at: payload.updated_at });
      } finally {
        window._stayOpsHydrating = prevHydrating;
      }
    }

    return data || { id: savedId, ...payload };
  } catch (e) {
    console.warn('[StayOps] savePropertyToCloud failed', e);
    return null;
  }
}


