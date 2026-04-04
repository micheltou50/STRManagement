import {
  getAllProperties,
  getActivePropertyId,
  setActivePropertyId,
  getActivePropertyConfig,
  savePropertyConfig,
  addPropertyConfig,
  saveAllProperties,
  initPropertyUI,
} from './config.js';
/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Supabase Integration Layer v2
   Tables: host_config, properties, cleaners, cleaning_jobs,
           cleans, notes, expenses, inventory
   ═══════════════════════════════════════════════════════════════════════════ */

const SUPABASE_URL      = 'https://nbeuyypgiipptxlqnhel.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5iZXV5eXBnaWlwcHR4bHFuaGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMDg0MDEsImV4cCI6MjA4OTU4NDQwMX0.TfsTKhDDMiOptoMCRXD149KC4pYGvuFM2px9_auwDG0';

const SUPABASE_PROJECT_REF = (() => {
  try {
    return new URL(SUPABASE_URL).hostname.split('.')[0];
  } catch (_) {
    return 'nbeuyypgiipptxlqnhel';
  }
})();

function isRecoverableSessionError(error) {
  if (!error) return false;
  const msg = String(error.message || error || '');
  return (
    msg.includes('Refresh Token') ||
    msg.includes('Invalid') ||
    error.status === 400 ||
    error.status === 401
  );
}

export function handleAuthFailure() {
  console.warn('[StayOps] Auth failure — clearing stale session, showing login');

  const keysToRemove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('sb-')) keysToRemove.push(key);
  }
  keysToRemove.forEach((k) => localStorage.removeItem(k));

  sessionStorage.clear();

  window._supabaseUser = null;

  showLoginScreen();
  hideLoadingScreen();
}

// ── INIT ──────────────────────────────────────────────────────────────────────
(function initSupabase() {
  if (!window.supabase) {
    console.error('[StayOps] Supabase SDK not loaded');
    return;
  }
  window._sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  console.log('[StayOps] Supabase client ready');

  window._sb.auth.onAuthStateChange((event, session) => {
    if (event === 'TOKEN_REFRESHED' && !session) {
      console.warn('[StayOps] Token refresh failed — clearing session');
      localStorage.removeItem('sb-' + SUPABASE_PROJECT_REF + '-auth-token');
      handleAuthFailure();
    }
    if (event === 'SIGNED_OUT') {
      if (typeof showLoginScreen === 'function') showLoginScreen();
    }
  });
})();


// ── AUTH ──────────────────────────────────────────────────────────────────────

async function supabaseSignIn(email, password) {
  if (!window._sb) return { data: null, error: 'Supabase not ready' };
  try {
    const { data, error } = await window._sb.auth.signInWithPassword({ email, password });
    if (!error && data && data.user) window._supabaseUser = data.user;
    return { data, error };
  } catch (e) {
    return { data: null, error: e.message };
  }
}

async function supabaseSignInWithMagicLink(email) {
  if (!window._sb) return { error: 'Supabase not ready' };
  try {
    const { error } = await window._sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin }
    });
    return { error };
  } catch (e) {
    return { error: e.message };
  }
}

async function supabaseSignUp(email, password) {
  if (!window._sb) return { data: null, error: 'Supabase not ready' };
  try {
    const { data, error } = await window._sb.auth.signUp({ email, password });
    return { data, error };
  } catch (e) {
    return { data: null, error: e.message };
  }
}

async function supabaseSignOut() {
  if (!window._sb) return;
  await window._sb.auth.signOut();
  window._supabaseUser = null;
}

export async function detectUserRole() {
  if (!window._sb) return null;
  const { data: { user } } = await window._sb.auth.getUser();
  if (!user) return null;

  const { data: roles } = await window._sb
    .from('user_roles')
    .select('role')
    .eq('auth_user_id', user.id);

  if (roles?.some((r) => r.role === 'host')) return 'host';
  if (roles?.some((r) => r.role === 'cleaner')) return 'cleaner';
  return 'unlinked';
}

export async function loadCleanerDashboard() {
  if (!window._sb) return null;
  const { data: { user } } = await window._sb.auth.getUser();
  if (!user) return null;

  const { data: cleanerRecord } = await window._sb
    .from('cleaners')
    .select('id, name, email, phone')
    .eq('auth_user_id', user.id)
    .single();

  if (!cleanerRecord) return null;

  const { data: myCleans } = await window._sb
    .from('cleans')
    .select('*, properties:property_id (name, address, check_in_info)')
    .eq('cleaner_uuid', cleanerRecord.id)
    .order('clean_date', { ascending: true });

  return { cleanerRecord, myCleans: myCleans || [] };
}

export async function getSupabaseSession() {
  if (!window._sb) return null;
  try {
    const { data, error } = await window._sb.auth.getSession();
    if (error) {
      console.warn('[StayOps] getSession error:', error.message);
      if (isRecoverableSessionError(error)) {
        handleAuthFailure();
        return null;
      }
    }
    return data?.session || null;
  } catch (e) {
    console.warn('[StayOps] getSession exception:', e.message);
    handleAuthFailure();
    return null;
  }
}

export async function getCurrentSupabaseUser() {
  if (!window._sb) return null;
  if (window._supabaseUser) return window._supabaseUser;
  try {
    const { data, error } = await window._sb.auth.getUser();
    if (error) {
      console.warn('[StayOps] getUser error:', error.message);
      if (isRecoverableSessionError(error)) {
        handleAuthFailure();
        return null;
      }
    }
    if (data && data.user) {
      window._supabaseUser = data.user;
      return data.user;
    }
  } catch (e) {
    console.warn('[StayOps] getUser exception:', e.message);
    handleAuthFailure();
    return null;
  }
  return null;
}


// ── PROPERTIES ────────────────────────────────────────────────────────────────

async function loadPropertyFromCloud() {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user) {
      console.log('[StayOps] loadPropertyFromCloud: no user');
      return [];
    }

    const { data, error } = await window._sb
      .from('properties')
      .select('*')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false });

    if (error) {
      console.warn('[StayOps] loadPropertyFromCloud query error:', error);
      return [];
    }

    const rows = Array.isArray(data) ? data : [];
    console.log('[StayOps] loadPropertyFromCloud: found', rows.length, 'properties');
    return rows;
  } catch (e) {
    console.warn('[StayOps] loadPropertyFromCloud exception:', e);
    return [];
  }
}

/**
 * seedLocalConfigFromCloud — pre-flight helper.
 * If the user has a property in Supabase, seeds it into localStorage
 * so hasValidPropertyConfig() and isOnboardingComplete() pass.
 * Non-blocking: returns true if seeded, false if not (new user or error).
 */
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

    const toLocalPatch = (row, existing) => {
      existing = existing || {};
      const exBrand = existing.branding || {};
      const exProp  = existing.property || {};
      const exOwner = existing.owner || {};
      const exInteg = existing.integrations || {};
      const exPrice = existing.pricing || {};
      const suburb  = row.suburb || existing.suburb || '';
      const state   = row.state || existing.state || '';
      return {
        supabaseId: row.id,
        name: row.name || existing.name || '',
        address: row.address || existing.address || '',
        suburb, state,
        region: row.region || existing.region || '',
        country: row.country || existing.country || 'Australia',
        branding: {
          subtitle: [suburb, state].filter(Boolean).join(' · '),
          tagline: row.tagline || exBrand.tagline || [suburb, state].filter(Boolean).join(', ')
        },
        property: {
          bedrooms:  row.bedrooms   != null ? row.bedrooms   : (exProp.bedrooms  || 0),
          bathrooms: row.bathrooms  != null ? row.bathrooms  : (exProp.bathrooms || 0),
          maxGuests: row.max_guests != null ? row.max_guests : (exProp.maxGuests || 0),
          type:      row.property_type || exProp.type || 'house'
        },
        owner: {
          name:  row.owner_name  || exOwner.name  || '',
          email: row.owner_email || exOwner.email || '',
          phone: row.owner_phone || exOwner.phone || '',
          reportEmailSubject: row.report_email_subject != null ? row.report_email_subject : (exOwner.reportEmailSubject || ''),
          reportEmailBody:    row.report_email_body    != null ? row.report_email_body    : (exOwner.reportEmailBody || ''),
          autoSendReport:     row.auto_send_report     != null ? row.auto_send_report     : !!exOwner.autoSendReport,
          reportFrequency:    row.report_frequency || exOwner.reportFrequency || 'monthly',
          lastReportSentAt:   row.last_report_sent_at || exOwner.lastReportSentAt || null
        },
        integrations: {
          sheetCsvUrl:    row.sheets_url || exInteg.sheetCsvUrl || '',
          syncUrl:        row.script_url || exInteg.syncUrl || '',
          vapidPublicKey: row.vapid_public_key || exInteg.vapidPublicKey || ''
        },
        pricing: {
          baseRate: row.base_rate != null ? row.base_rate : (exPrice.baseRate || 0)
        },
        updated_at: row.updated_at || existing.updated_at || new Date().toISOString()
      };
    };

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
            savePropertyConfig(toLocalPatch(row, match));
          } else {
            savePropertyConfig({ supabaseId: row.id, updated_at: match.updated_at || row.updated_at || new Date().toISOString() });
          }
          window._cloudPropertyIds[match.propertyId] = row.id;
          if (!preferredActiveId) preferredActiveId = match.propertyId;
        } else {
          const created = addPropertyConfig(toLocalPatch(row, {}));
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
      mgmt_fee_rate:     (window._appConfig && window._appConfig.mgmt_fee_rate != null) ? window._appConfig.mgmt_fee_rate : null,
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


async function getCloudPropertyId() {
  window._cloudPropertyIds = window._cloudPropertyIds || {};

  const activeCfg = getActivePropertyConfig();
  const activePropertyId = (activeCfg && activeCfg.propertyId)
    || getActivePropertyId();

  if (!activePropertyId) return null;

  if (activeCfg && activeCfg.supabaseId) {
    window._cloudPropertyIds[activePropertyId] = activeCfg.supabaseId;
    return activeCfg.supabaseId;
  }

  if (window._cloudPropertyIds[activePropertyId]) return window._cloudPropertyIds[activePropertyId];

  const cloudProps = await loadPropertyFromCloud();
  if (!Array.isArray(cloudProps) || !cloudProps.length) return null;

  const normaliseLocalId = (raw) => String(raw || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const activeName = String((activeCfg && activeCfg.name) || '').trim().toLowerCase();

  const match =
    cloudProps.find(p => activeCfg && activeCfg.supabaseId && p.id === activeCfg.supabaseId) ||
    cloudProps.find(p => normaliseLocalId(p.name) === activePropertyId) ||
    cloudProps.find(p => String(p.name || '').trim().toLowerCase() === activeName) ||
    null;

  if (!match) return null;

  window._cloudPropertyIds[activePropertyId] = match.id;

  const prevHydrating = window._stayOpsHydrating;
  window._stayOpsHydrating = true;
  try {
    savePropertyConfig({ supabaseId: match.id, updated_at: (activeCfg && activeCfg.updated_at) || match.updated_at || new Date().toISOString() });
  } finally {
    window._stayOpsHydrating = prevHydrating;
  }

  return match.id;
}

// ── HOST CONFIG ───────────────────────────────────────────────────────────────

export async function saveHostConfigToCloud(configData) {
  // Delegate to savePropertyToCloud — same data, one source of truth
  if (configData) await savePropertyToCloud(configData);
}


// ── CLEANERS ──────────────────────────────────────────────────────────────────

async function loadCleanersFromCloud() {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user) return null;
    const { data, error } = await window._sb
      .from('cleaners')
      .select('*')
      .eq('user_id', user.id)
      .eq('active', true)
      .order('created_at', { ascending: true });
    if (error || !data) return null;
    return data.map(c => ({
      id:          c.local_id ? (isNaN(Number(c.local_id)) ? c.local_id : Number(c.local_id)) : c.id,
      _cloudId:    c.id,
      name:        c.name,
      email:       c.email  || '',
      phone:       c.phone  || '',
      role:        c.role   || 'Cleaner',
      pin:         c.pin    || '',
      permissions: c.permissions || {},
      active:      c.active !== false,
      invitation_status: c.invitation_status || 'pending',
      auth_user_id:      c.auth_user_id || null
    }));
  } catch (e) {
    console.warn('[StayOps] loadCleanersFromCloud failed', e);
    return null;
  }
}

export async function saveCleanersToCloud(cleanerList) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !Array.isArray(cleanerList)) return;
    for (const c of cleanerList) {
      if (!c || !c.name) continue;
      const payload = {
        user_id:     user.id,
        local_id:    String(c.id),
        name:        c.name,
        email:       c.email  || '',
        phone:       c.phone  || '',
        role:        c.role   || 'Cleaner',
        pin:         c.pin    || '',
        permissions: c.permissions || {},
        active:      c.active !== false,
        updated_at:  new Date().toISOString()
      };
      if (c._cloudId) {
        await window._sb.from('cleaners').upsert({ id: c._cloudId, ...payload });
      } else {
        const { data } = await window._sb.from('cleaners')
          .upsert(payload, { onConflict: 'user_id,local_id' })
          .select().single();
        if (data) c._cloudId = data.id;
      }
    }
  } catch (e) {
    console.warn('[StayOps] saveCleanersToCloud failed', e);
  }
}


// ── CLEANS ────────────────────────────────────────────────────────────────────

export async function loadCleansFromCloud() {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user) return null;
    const propertyId = await getCloudPropertyId();
    let query = window._sb.from('cleans').select('*').eq('user_id', user.id);
    if (propertyId) query = query.eq('property_id', propertyId);
    const { data, error } = await query.order('clean_date', { ascending: true });
    if (error || !data) return null;
    return data.map(c => ({
      id:               c.local_id ? Number(c.local_id) || c.local_id : c.id,
      _cloudId:         c.id,
      _propertyId:      c.property_id || null,
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
      notes:            c.notes        || ''
    }));
  } catch (e) {
    console.warn('[StayOps] loadCleansFromCloud failed', e);
    return null;
  }
}

export async function saveCleanToCloud(clean) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !clean) return;
    const propertyId = await getCloudPropertyId();
    const cleanersList = window._cleaners || [];
    const matchedCleaner = cleanersList.find(cl => String(cl.id) === String(clean.cleanerId) || String(cl._cloudId) === String(clean.cleanerId));
    const cleanerUuid = matchedCleaner ? (matchedCleaner._cloudId || null) : null;
    const basePayload = {
      user_id:          user.id,
      local_id:         String(clean.id),
      booking_id:       String(clean.bookingId || ''),
      guest_name:       clean.guestName   || '',
      cleaner:          clean.cleaner     || '',
      cleaner_id:       String(clean.cleanerId || ''),
      cleaner_uuid:     cleanerUuid,
      clean_date:       clean.date ? String(clean.date).slice(0, 10) : null,
      done:             clean.done             || false,
      cleaner_confirmed:clean.cleanerConfirmed || false,
      cleaner_declined: clean.cleanerDeclined  || false,
      notified:         clean.notified         || false,
      reminder_sent:    clean.reminderSent     || false,
      assigned_at:      clean.assignedAt  || null,
      confirmed_at:     clean.confirmedAt || null,
      notes:            clean.notes       || '',
      updated_at:       new Date().toISOString()
    };
    if (clean._cloudId) {
      // Guard: never update property_id on existing records.
      console.log('[StayOps] GUARD: property_id stripped from cleans update:', clean._cloudId);
      const { error } = await window._sb.from('cleans').update(basePayload).eq('id', clean._cloudId);
      if (error) throw error;
    } else {
      const insertPayload = { ...basePayload, property_id: propertyId || null };
      const { data: insData, error: insErr } = await window._sb
        .from('cleans')
        .insert(insertPayload)
        .select()
        .single();
      if (!insErr && insData) {
        clean._cloudId = insData.id;
        return;
      }
      // Conflict fallback: upsert without property_id
      console.log('[StayOps] GUARD: property_id stripped from cleans update:', String(clean.id));
      const { data: upData, error: upErr } = await window._sb
        .from('cleans')
        .upsert(basePayload, { onConflict: 'local_id,user_id' })
        .select()
        .single();
      if (upErr) throw upErr;
      if (upData) clean._cloudId = upData.id;
    }
  } catch (e) {
    console.warn('[StayOps] saveCleanToCloud failed', e);
  }
}

export async function saveCleansToCloud(cleansList) {
  if (!Array.isArray(cleansList)) return;
  for (const c of cleansList) await saveCleanToCloud(c);
}

// Keep old name working for backward compat
export async function saveCleaningJobToCloud(job) { return saveCleanToCloud(job); }
async function loadCleaningJobsFromCloud() { return loadCleansFromCloud(); }


// ── NOTES ─────────────────────────────────────────────────────────────────────

async function loadNotesFromCloud() {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user) return null;
    const propertyId = await getCloudPropertyId();
    let query = window._sb.from('notes').select('*').eq('user_id', user.id);
    if (propertyId) query = query.eq('property_id', propertyId);
    const { data, error } = await query.order('created_at', { ascending: true });
    if (error || !data) return null;
    return data.map(n => ({
      id:       n.local_id ? Number(n.local_id) || n.local_id : n.id,
      _cloudId: n.id,
      _propertyId: n.property_id || null,
      content:  n.content || '',
      date:     n.created_at || ''
    }));
  } catch (e) {
    console.warn('[StayOps] loadNotesFromCloud failed', e);
    return null;
  }
}

async function saveNoteToCloud(note) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !note) return;
    const propertyId = await getCloudPropertyId();
    const basePayload = {
      user_id:     user.id,
      local_id:    String(note.id),
      content:     note.content || note.text || note.body || String(note),
      updated_at:  new Date().toISOString()
    };
    if (note._cloudId) {
      console.log('[StayOps] GUARD: property_id stripped from notes update:', note._cloudId);
      const { error } = await window._sb.from('notes').update(basePayload).eq('id', note._cloudId);
      if (error) throw error;
    } else {
      const insertPayload = { ...basePayload, property_id: propertyId || null };
      const { data: insData, error: insErr } = await window._sb
        .from('notes')
        .insert(insertPayload)
        .select()
        .single();
      if (!insErr && insData) {
        note._cloudId = insData.id;
        return;
      }
      console.log('[StayOps] GUARD: property_id stripped from notes update:', String(note.id));
      const { data: upData, error: upErr } = await window._sb
        .from('notes')
        .upsert(basePayload, { onConflict: 'local_id,user_id' })
        .select()
        .single();
      if (upErr) throw upErr;
      if (upData) note._cloudId = upData.id;
    }
  } catch (e) {
    console.warn('[StayOps] saveNoteToCloud failed', e);
  }
}

export async function saveNotesToCloud(notesList) {
  if (!Array.isArray(notesList)) return;
  for (const n of notesList) await saveNoteToCloud(n);
}


// ── EXPENSES ──────────────────────────────────────────────────────────────────

async function loadExpensesFromCloud() {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user) return null;
    const propertyId = await getCloudPropertyId();
    let query = window._sb.from('expenses').select('*').eq('user_id', user.id);
    if (propertyId) query = query.eq('property_id', propertyId);
    const { data, error } = await query.order('date', { ascending: false });
    if (error || !data) return null;
    return data.map(e => ({
      id:          e.local_id ? Number(e.local_id) || e.local_id : e.id,
      _cloudId:    e.id,
      _propertyId: e.property_id || null,
      date:        e.date        || '',
      merchant:    e.merchant    || '',
      description: e.description || '',
      category:    e.category    || '',
      amount:      e.amount      || 0,
      receiptNum:  e.receipt_num  || '',
      receiptType: e.receipt_type || '',
      driveLink:   e.drive_link   || '',
      photo:       null
    }));
  } catch (e) {
    console.warn('[StayOps] loadExpensesFromCloud failed', e);
    return null;
  }
}

export async function saveExpenseToCloud(expense) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !expense) return;
    const propertyId = await getCloudPropertyId();
    const payload = {
      user_id:      user.id,
      property_id:  propertyId || null,
      local_id:     String(expense.id),
      date:         expense.date        || null,
      merchant:     expense.merchant    || '',
      description:  expense.description || '',
      category:     expense.category    || '',
      amount:       Number(expense.amount) || 0,
      receipt_num:  expense.receiptNum  || '',
      receipt_type: expense.receiptType || '',
      drive_link:   expense.driveLink   || '',
      updated_at:   new Date().toISOString()
    };
    if (expense._cloudId) {
      await window._sb.from('expenses').upsert({ id: expense._cloudId, ...payload });
    } else {
      const { data } = await window._sb
        .from('expenses')
        .upsert(payload, { onConflict: 'local_id,user_id' })
        .select().single();
      if (data) expense._cloudId = data.id;
    }
  } catch (e) {
    console.warn('[StayOps] saveExpenseToCloud failed', e);
  }
}

async function saveExpensesToCloud(expensesList) {
  if (!Array.isArray(expensesList)) return;
  for (const e of expensesList) await saveExpenseToCloud(e);
}

export async function deleteExpenseFromCloud(expense) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !expense) return;
    if (expense._cloudId) {
      await window._sb.from('expenses').delete().eq('id', expense._cloudId);
    } else {
      await window._sb.from('expenses').delete()
        .eq('user_id', user.id)
        .eq('local_id', String(expense.id));
    }
  } catch (e) {
    console.warn('[StayOps] deleteExpenseFromCloud failed', e);
  }
}


// ── INVENTORY ─────────────────────────────────────────────────────────────────

async function loadInventoryFromCloud() {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user) return null;
    const propertyId = await getCloudPropertyId();
    let query = window._sb.from('inventory').select('*').eq('user_id', user.id);
    if (propertyId) query = query.eq('property_id', propertyId);
    const { data, error } = await query.order('created_at', { ascending: true });
    if (error || !data) return null;
    return data.map(i => ({
      id:        i.local_id ? Number(i.local_id) || i.local_id : i.id,
      _cloudId:  i.id,
      _propertyId: i.property_id || null,
      name:      i.name      || '',
      stock:     i.stock     || 0,
      threshold: i.threshold || 0,
      unit:      i.unit      || ''
    }));
  } catch (e) {
    console.warn('[StayOps] loadInventoryFromCloud failed', e);
    return null;
  }
}

async function saveInventoryItemToCloud(item) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !item) return;
    const propertyId = await getCloudPropertyId();
    const basePayload = {
      user_id:     user.id,
      local_id:    String(item.id),
      name:        item.name      || '',
      stock:       item.stock     || 0,
      threshold:   item.threshold || 0,
      unit:        item.unit      || '',
      updated_at:  new Date().toISOString()
    };
    if (item._cloudId) {
      console.log('[StayOps] GUARD: property_id stripped from inventory update:', item._cloudId);
      const { error } = await window._sb.from('inventory').update(basePayload).eq('id', item._cloudId);
      if (error) throw error;
    } else {
      const insertPayload = { ...basePayload, property_id: propertyId || null };
      const { data: insData, error: insErr } = await window._sb
        .from('inventory')
        .insert(insertPayload)
        .select()
        .single();
      if (!insErr && insData) {
        item._cloudId = insData.id;
        return;
      }
      console.log('[StayOps] GUARD: property_id stripped from inventory update:', String(item.id));
      const { data: upData, error: upErr } = await window._sb
        .from('inventory')
        .upsert(basePayload, { onConflict: 'local_id,user_id' })
        .select()
        .single();
      if (upErr) throw upErr;
      if (upData) item._cloudId = upData.id;
    }
  } catch (e) {
    console.warn('[StayOps] saveInventoryItemToCloud failed', e);
  }
}

export async function saveInventoryToCloud(inventoryList) {
  if (!Array.isArray(inventoryList)) return;
  for (const i of inventoryList) await saveInventoryItemToCloud(i);
}

async function deleteInventoryItemFromCloud(item) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !item) return;
    if (item._cloudId) {
      await window._sb.from('inventory').delete().eq('id', item._cloudId);
    } else {
      await window._sb.from('inventory').delete()
        .eq('user_id', user.id)
        .eq('local_id', String(item.id));
    }
  } catch (e) {
    console.warn('[StayOps] deleteInventoryItemFromCloud failed', e);
  }
}


// ── MAINTENANCE ──────────────────────────────────────────────────────────────

async function loadMaintenanceFromCloud() {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user) return null;
    const propertyId = await getCloudPropertyId();
    let query = window._sb.from('maintenance').select('*').eq('user_id', user.id);
    if (propertyId) query = query.eq('property_id', propertyId);
    const { data, error } = await query.order('date', { ascending: false });
    if (error || !data) return null;
    return data.map(m => ({
      id:          m.local_id ? Number(m.local_id) || m.local_id : m.id,
      _cloudId:    m.id,
      _propertyId: m.property_id || null,
      description: m.description || '',
      status:      m.status      || 'open',
      cost:        m.cost        || 0,
      contractor:  m.contractor  || '',
      date:        m.date        || ''
    }));
  } catch (e) {
    console.warn('[StayOps] loadMaintenanceFromCloud failed', e);
    return null;
  }
}

async function saveMaintenanceItemToCloud(item) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !item) return;
    const propertyId = await getCloudPropertyId();
    const basePayload = {
      user_id:     user.id,
      local_id:    String(item.id),
      description: item.description || '',
      status:      item.status      || 'open',
      cost:        Number(item.cost) || 0,
      contractor:  item.contractor  || '',
      date:        item.date        || null,
      updated_at:  new Date().toISOString()
    };
    if (item._cloudId) {
      console.log('[StayOps] GUARD: property_id stripped from maintenance update:', item._cloudId);
      const { error } = await window._sb.from('maintenance').update(basePayload).eq('id', item._cloudId);
      if (error) throw error;
    } else {
      const insertPayload = { ...basePayload, property_id: propertyId || null };
      const { data: insData, error: insErr } = await window._sb
        .from('maintenance')
        .insert(insertPayload)
        .select()
        .single();
      if (!insErr && insData) {
        item._cloudId = insData.id;
        return;
      }
      console.log('[StayOps] GUARD: property_id stripped from maintenance update:', String(item.id));
      const { data: upData, error: upErr } = await window._sb
        .from('maintenance')
        .upsert(basePayload, { onConflict: 'local_id,user_id' })
        .select()
        .single();
      if (upErr) throw upErr;
      if (upData) item._cloudId = upData.id;
    }
  } catch (e) {
    console.warn('[StayOps] saveMaintenanceItemToCloud failed', e);
  }
}

export async function saveMaintenanceToCloud(maintenanceList) {
  if (!Array.isArray(maintenanceList)) return;
  for (const m of maintenanceList) await saveMaintenanceItemToCloud(m);
}

export async function deleteMaintenanceFromCloud(item) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !item) return;
    if (item._cloudId) {
      await window._sb.from('maintenance').delete().eq('id', item._cloudId);
    } else {
      await window._sb.from('maintenance').delete()
        .eq('user_id', user.id)
        .eq('local_id', String(item.id));
    }
  } catch (e) {
    console.warn('[StayOps] deleteMaintenanceFromCloud failed', e);
  }
}


// ── FULL HYDRATION ────────────────────────────────────────────────────────────

/**
 * hydrateFromCloud — called after finishAppInit so the property/storage
 * keys are already established. Pulls all cloud data into localStorage
 * then triggers a re-render.
 */

// ── BOOKINGS ──────────────────────────────────────────────────────────────────

async function loadBookingsFromCloud() {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user) return null;
    const propertyId = await getCloudPropertyId();
    let query = window._sb.from('bookings').select('*').eq('user_id', user.id);
    if (propertyId) query = query.eq('property_id', propertyId);
    const { data, error } = await query.order('checkin', { ascending: true });
    if (error || !data) return null;
    return data.map(b => ({
      id:               b.local_id ? (isNaN(Number(b.local_id)) ? b.local_id : Number(b.local_id)) : b.id,
      _cloudId:         b.id,
      _propertyId:      b.property_id || null,
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
    }));
  } catch (e) {
    console.warn('[StayOps] loadBookingsFromCloud failed', e);
    return null;
  }
}

export async function saveBookingToCloud(booking) {
  const user = await getCurrentSupabaseUser();
  if (!user || !booking) return;
  const propertyId = await getCloudPropertyId();
  const basePayload = {
    user_id:            user.id,
    local_id:           String(booking.id),
    checkin:            booking.checkin   ? String(booking.checkin).slice(0,10)   : null,
    checkout:           booking.checkout  ? String(booking.checkout).slice(0,10)  : null,
    nights:             booking.nights    || null,
    guest_name:         booking.name      || '',
    guests:             booking.guests    || 1,
    host_payout:        Number(booking.hostPayout)  || 0,
    cleaning_fee:       Number(booking.cleaningFee) || 0,
    mgmt_fee:           Number(booking.mgmtFee)     || 0,
    mgmt_fee_raw:       Number(booking.mgmtFeeRaw)  || 0,
    mgmt_payout:        Number(booking.mgmtPayout)  || 0,
    net_payout:         Number(booking.netPayout)   || 0,
    platform:           booking.platform    || '',
    confirmation_code:  booking.confirmCode || null,
    status:             booking.status      || 'confirmed',
    cleaner_confirmed:  booking.cleanerConfirmed || false,
    source:             booking.source      || 'sheet',
    phone:              booking.phone       || null,
    email:              booking.email       || null,
    updated_at:         new Date().toISOString(),
  };
  if (booking._cloudId) {
    // Guard: never update property_id on existing cloud bookings.
    console.log('[StayOps] GUARD: property_id stripped from booking update to prevent reassignment:', booking._cloudId);
    const { error } = await window._sb.from('bookings').update(basePayload).eq('id', booking._cloudId);
    if (error) throw new Error(error.message || 'Supabase update failed');
  } else {
    // Insert new booking WITH property_id. If it already exists (conflict), update WITHOUT property_id.
    const insertPayload = { ...basePayload, property_id: propertyId || null };
    const { data: insData, error: insErr } = await window._sb
      .from('bookings')
      .insert(insertPayload)
      .select()
      .single();
    if (!insErr && insData) {
      booking._cloudId = insData.id;
      return;
    }

    // Conflict or other insert failure — fall back to upsert/update without property_id.
    console.log('[StayOps] GUARD: property_id stripped from booking update to prevent reassignment:', String(booking.id));
    const { data: upData, error: upErr } = await window._sb
      .from('bookings')
      .upsert(basePayload, { onConflict: 'local_id,user_id' })
      .select()
      .single();
    if (upErr) throw new Error(upErr.message || 'Supabase upsert failed');
    if (upData) booking._cloudId = upData.id;
  }
}

export async function saveBookingsToCloud(bookingsList) {
  if (!Array.isArray(bookingsList) || !bookingsList.length) return;
  const user = await getCurrentSupabaseUser();
  if (!user) throw new Error('Not signed in — cannot save bookings to cloud');
  const propertyId = await getCloudPropertyId();
  const toBase = (b) => ({
    user_id:            user.id,
    local_id:           String(b.id),
    checkin:            b.checkin   ? String(b.checkin).slice(0,10)   : null,
    checkout:           b.checkout  ? String(b.checkout).slice(0,10)  : null,
    nights:             b.nights    || null,
    guest_name:         b.name      || '',
    guests:             b.guests    || 1,
    host_payout:        Number(b.hostPayout)  || 0,
    cleaning_fee:       Number(b.cleaningFee) || 0,
    mgmt_fee:           Number(b.mgmtFee)     || 0,
    mgmt_fee_raw:       Number(b.mgmtFeeRaw)  || 0,
    mgmt_payout:        Number(b.mgmtPayout)  || 0,
    net_payout:         Number(b.netPayout)   || 0,
    platform:           b.platform    || '',
    confirmation_code:  b.confirmCode || null,
    status:             b.status      || 'confirmed',
    cleaner_confirmed:  b.cleanerConfirmed || false,
    source:             b.source      || 'sheet',
    phone:              b.phone       || null,
    email:              b.email       || null,
    updated_at:         new Date().toISOString(),
  });

  // Safety: never update property_id during sync. Insert new bookings with property_id; update existing without it.
  const withCloud = bookingsList.filter(b => b && (b._cloudId || b.cloud_id));
  const withoutCloud = bookingsList.filter(b => b && !(b._cloudId || b.cloud_id));

  // 1) Update existing bookings (by cloud id) WITHOUT property_id
  for (const b of withCloud) {
    const cloudId = String(b._cloudId || b.cloud_id || '');
    if (!cloudId) continue;
    console.log('[StayOps] GUARD: property_id stripped from booking update to prevent reassignment:', cloudId);
    const { error } = await window._sb.from('bookings').update(toBase(b)).eq('id', cloudId);
    if (error) {
      console.warn('[StayOps] saveBookingsToCloud update error', error);
      throw new Error(error.message || 'Supabase update failed');
    }
  }

  // 2) Insert new bookings WITH property_id; if conflict, upsert WITHOUT property_id
  for (const b of withoutCloud) {
    const insertPayload = { ...toBase(b), property_id: propertyId || null };
    const { data: insData, error: insErr } = await window._sb
      .from('bookings')
      .insert(insertPayload)
      .select()
      .single();
    if (!insErr && insData) {
      b._cloudId = insData.id;
      continue;
    }

    console.log('[StayOps] GUARD: property_id stripped from booking update to prevent reassignment:', String(b.id));
    const { data: upData, error: upErr } = await window._sb
      .from('bookings')
      .upsert(toBase(b), { onConflict: 'local_id,user_id' })
      .select()
      .single();
    if (upErr) {
      console.warn('[StayOps] saveBookingsToCloud bulk upsert error', upErr);
      throw new Error(upErr.message || 'Supabase upsert failed');
    }
    if (upData) b._cloudId = upData.id;
  }
}

async function validatePropertyIds(userId) {
  try {
    if (!userId || !window._sb) return;
    const supabase = window._sb;
    const { data, error } = await supabase
      .from('bookings')
      .select('property_id')
      .eq('user_id', userId);
    if (error) {
      console.warn('[StayOps] validatePropertyIds: query failed', error);
      return;
    }
    if (data) {
      const counts = {};
      data.forEach(b => {
        const pid = b && b.property_id ? String(b.property_id) : 'null';
        counts[pid] = (counts[pid] || 0) + 1;
      });
      console.log('[StayOps] Property booking counts:', counts);
    }
  } catch (e) {
    console.warn('[StayOps] validatePropertyIds failed', e);
  }
}

export async function deleteBookingFromCloud(booking) {
  const user = await getCurrentSupabaseUser();
  if (!user || !booking || !window._sb) {
    console.log('[StayOps] deleteBookingFromCloud: skipped, reason: missing user, booking, or Supabase client');
    return { ok: false, skipped: true };
  }

  const supabase = window._sb;
  const localId = String(booking.id ?? '');
  const cloudId = booking._cloudId ? String(booking._cloudId) : '';
  console.log('[StayOps] deleteBookingFromCloud: deleting booking', { localId, cloudId, userId: user.id });

  try {
    let result;
    if (cloudId) {
      console.log('[StayOps] deleteBookingFromCloud: calling supabase delete by id...', { cloudId });
      result = await supabase
        .from('bookings')
        .delete()
        .eq('id', cloudId);
      const { data, error, status } = result || {};
      console.log('[StayOps] deleteBookingFromCloud: result', { data, error, status });
    } else {
      console.log('[StayOps] deleteBookingFromCloud: calling supabase delete by user/local_id...', { localId, userId: user.id });
      result = await supabase
        .from('bookings')
        .delete()
        .eq('user_id', user.id)
        .eq('local_id', localId);
      const { data, error, status } = result || {};
      console.log('[StayOps] deleteBookingFromCloud: result', { data, error, status });
    }

    const { error } = result || {};
    if (error) {
      console.error('[StayOps] deleteBookingFromCloud failed', error);
      throw error;
    }
    return result;
  } catch (e) {
    console.error('[StayOps] deleteBookingFromCloud threw', e);
    throw e;
  }
}


// ── RECEIPTS (Supabase Storage) ───────────────────────────────────────────────

export async function uploadReceiptToStorage(file, expenseId) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !file) return null;
    const propertyId = await getCloudPropertyId();
    const ext = file.name.split('.').pop();
    const path = `${user.id}/${propertyId || 'default'}/${expenseId || Date.now()}.${ext}`;
    const { data, error } = await window._sb.storage.from('receipts').upload(path, file, { upsert: true });
    if (error) { console.warn('[StayOps] uploadReceiptToStorage error', error); return null; }
    const { data: urlData } = window._sb.storage.from('receipts').getPublicUrl(path);
    return urlData && urlData.publicUrl ? urlData.publicUrl : null;
  } catch (e) {
    console.warn('[StayOps] uploadReceiptToStorage failed', e);
    return null;
  }
}

export async function hydrateFromCloud() {
  try {
    window._stayOpsHydrating = true;
    window._cloudPropertyIds = window._cloudPropertyIds || {};
    console.log('[StayOps] hydrateFromCloud starting...');

    // Phase 2: hydrate directly into in-memory arrays (no localStorage hop).
    const {
      bookings,
      cleans,
      notes,
      expenses,
      maintenance,
      inventory,
      replaceArrayInPlace,
    } = await import('./state.js');

    const normaliseLocalId = (raw) => String(raw || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

    const toLocalPatch = (row, existing) => {
      existing = existing || {};
      const exBrand = existing.branding || {};
      const exProp  = existing.property || {};
      const exOwner = existing.owner || {};
      const exInteg = existing.integrations || {};
      const exPrice = existing.pricing || {};
      const suburb = row.suburb || existing.suburb || '';
      const state  = row.state || existing.state || '';
      return {
        supabaseId: row.id,
        name: row.name || existing.name || '',
        address: row.address || existing.address || '',
        suburb, state,
        region: row.region || existing.region || '',
        country: row.country || existing.country || 'Australia',
        branding: {
          subtitle: [suburb, state].filter(Boolean).join(' · '),
          tagline: row.tagline || exBrand.tagline || [suburb, state].filter(Boolean).join(', ')
        },
        property: {
          bedrooms:  row.bedrooms   != null ? row.bedrooms   : (exProp.bedrooms  || 0),
          bathrooms: row.bathrooms  != null ? row.bathrooms  : (exProp.bathrooms || 0),
          maxGuests: row.max_guests != null ? row.max_guests : (exProp.maxGuests || 0),
          type:      row.property_type || exProp.type || 'house'
        },
        owner: {
          name:  row.owner_name  || exOwner.name  || '',
          email: row.owner_email || exOwner.email || '',
          phone: row.owner_phone || exOwner.phone || '',
          reportEmailSubject: row.report_email_subject != null ? row.report_email_subject : (exOwner.reportEmailSubject || ''),
          reportEmailBody:    row.report_email_body    != null ? row.report_email_body    : (exOwner.reportEmailBody || ''),
          autoSendReport:     row.auto_send_report     != null ? row.auto_send_report     : !!exOwner.autoSendReport,
          reportFrequency:    row.report_frequency || exOwner.reportFrequency || 'monthly',
          lastReportSentAt:   row.last_report_sent_at || exOwner.lastReportSentAt || null
        },
        integrations: {
          sheetCsvUrl:    row.sheets_url || exInteg.sheetCsvUrl || '',
          syncUrl:        row.script_url || exInteg.syncUrl || '',
          vapidPublicKey: row.vapid_public_key || exInteg.vapidPublicKey || ''
        },
        pricing: {
          baseRate: row.base_rate != null ? row.base_rate : (exPrice.baseRate || 0)
        },
        updated_at: row.updated_at || existing.updated_at || new Date().toISOString()
      };
    };

    // 0. Merge all cloud properties into local list
    const cloudProps = await loadPropertyFromCloud();
    const originalActiveId = getActivePropertyId();
    let preferredActiveId = null;

    if (Array.isArray(cloudProps) && cloudProps.length) {
      localStorage.setItem('gh-setup-complete', '1');

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
            savePropertyConfig(toLocalPatch(row, match));
          } else {
            savePropertyConfig({ supabaseId: row.id, updated_at: match.updated_at || row.updated_at || new Date().toISOString() });
          }
          window._cloudPropertyIds[match.propertyId] = row.id;
          if (!preferredActiveId) preferredActiveId = match.propertyId;
        } else {
          const created = addPropertyConfig(toLocalPatch(row, {}));
          if (created && created.propertyId) {
            window._cloudPropertyIds[created.propertyId] = row.id;
            if (!preferredActiveId) preferredActiveId = created.propertyId;
          }
        }
      }

      // ── Pruning step — cloud is source of truth ───────────────────────────
      // After merging, remove any local property whose supabaseId is present
      // but not found in the cloud response for this user. This handles:
      //   • stale properties from a previously signed-in account on this device
      //   • properties the user deleted on another device
      // Properties with no supabaseId (locally-created, never synced to cloud)
      // are intentionally preserved so offline-created properties are not lost.
      const cloudIds = new Set(cloudProps.map(p => p.id));
      const listBeforePrune = getAllProperties();
      const listAfterPrune = listBeforePrune.filter(p => {
        if (!p.supabaseId) return true;          // no cloud link — keep (offline-created)
        return cloudIds.has(p.supabaseId);        // only keep if present in cloud response
      });
      if (listAfterPrune.length !== listBeforePrune.length) {
        const pruned = listBeforePrune.length - listAfterPrune.length;
        console.log('[StayOps] hydrateFromCloud: pruned', pruned, 'stale local propert' + (pruned === 1 ? 'y' : 'ies') + ' not in cloud');
        saveAllProperties(listAfterPrune);
      }
      // ─────────────────────────────────────────────────────────────────────

      const finalList = getAllProperties();
      if (originalActiveId && finalList.find(p => p.propertyId === originalActiveId)) {
        setActivePropertyId(originalActiveId);
      } else if (preferredActiveId) {
        setActivePropertyId(preferredActiveId);
      } else if (finalList[0]) {
        setActivePropertyId(finalList[0].propertyId);
      }

      const activeCfg = getActivePropertyConfig();
      const activeCloud = activeCfg && activeCfg.supabaseId ? cloudProps.find(p => p.id === activeCfg.supabaseId) : null;
      // Note: api_key / mgmt_fee_rate are now routed through window._appConfig (below).

      console.log('[StayOps] Hydrated', cloudProps.length, 'properties from cloud');
    }

    // 1. Cleaners
    const cloudCleaners = await loadCleanersFromCloud();
    if (Array.isArray(cloudCleaners)) { window._cleaners = cloudCleaners; console.log('[StayOps] Hydrated', cloudCleaners.length, 'cleaners from cloud'); }

    // 2. Bookings
    const cloudBookings = await loadBookingsFromCloud();
    if (Array.isArray(cloudBookings)) { replaceArrayInPlace(bookings, cloudBookings); console.log('[StayOps] Hydrated', cloudBookings.length, 'bookings from cloud'); }

    // 3. Cleans
    const cloudCleans = await loadCleansFromCloud();
    if (Array.isArray(cloudCleans)) { replaceArrayInPlace(cleans, cloudCleans); console.log('[StayOps] Hydrated', cloudCleans.length, 'cleans from cloud'); }

    // 4. Notes
    const cloudNotes = await loadNotesFromCloud();
    if (Array.isArray(cloudNotes)) { replaceArrayInPlace(notes, cloudNotes); console.log('[StayOps] Hydrated', cloudNotes.length, 'notes from cloud'); }

    // 5. Expenses
    const cloudExpenses = await loadExpensesFromCloud();
    if (Array.isArray(cloudExpenses)) { replaceArrayInPlace(expenses, cloudExpenses); console.log('[StayOps] Hydrated', cloudExpenses.length, 'expenses from cloud'); }

    // 6. Inventory
    const cloudInventory = await loadInventoryFromCloud();
    if (Array.isArray(cloudInventory)) { replaceArrayInPlace(inventory, cloudInventory); console.log('[StayOps] Hydrated', cloudInventory.length, 'inventory items from cloud'); }

    // 7. Maintenance
    const cloudMaintenance = await loadMaintenanceFromCloud();
    if (Array.isArray(cloudMaintenance)) { replaceArrayInPlace(maintenance, cloudMaintenance); console.log('[StayOps] Hydrated', cloudMaintenance.length, 'maintenance items from cloud'); }

    // 8. App config
    const cloudAppConfig = await loadAppConfigFromCloud();
    if (cloudAppConfig) {
      const activeCfg = getActivePropertyConfig();
      const activeCloud = activeCfg && activeCfg.supabaseId ? (Array.isArray(cloudProps) ? cloudProps.find(p => p.id === activeCfg.supabaseId) : null) : null;

      window._appConfig = {
        sms_template: cloudAppConfig.sms_template || '',
        expense_cats: cloudAppConfig.expense_cats || [],
        email_templates: cloudAppConfig.email_templates || {},
        push_subs: cloudAppConfig.push_subs || {},
        gmail_email: cloudAppConfig.gmail_email || '',
        outlook_email: cloudAppConfig.outlook_email || '',
        ai_ignore: cloudAppConfig.ai_ignore || [],
        auto_assign_cleaner: cloudAppConfig.auto_assign_cleaner ?? true,
        api_key: cloudAppConfig.anthropic_api_key || (activeCloud && activeCloud.anthropic_api_key) || '',
        mgmt_fee_rate: cloudAppConfig.mgmt_fee_rate || (activeCloud && activeCloud.mgmt_fee_rate) || 0,
        notification_config: cloudAppConfig.notification_config || {},
      };
      console.log('[StayOps] Hydrated app config from cloud');
    }

    // 9. Host profile
    const cloudHost = await loadHostConfigFromSupabase();
    if (cloudHost && cloudHost.hostId) {
      const existing = typeof getHostProfile === 'function' ? getHostProfile() : null;
      if (!existing || cloudHost.name) {
        if (typeof saveHostProfile === 'function') saveHostProfile(cloudHost);
        console.log('[StayOps] Hydrated host profile from cloud');
      }
    }

    // Monitoring only: log booking counts by property_id to spot anomalies early.
    try {
      const user = await getCurrentSupabaseUser();
      if (user && user.id) await validatePropertyIds(user.id);
    } catch (e) { /* non-critical, ignore property ID validation failures */ }

    console.log('[StayOps] hydrateFromCloud complete');
  } catch (e) {
    console.warn('[StayOps] hydrateFromCloud error', e);
  } finally {
    window._stayOpsHydrating = false;
  }
}



// ── APP CONFIG ────────────────────────────────────────────────────────────────

async function loadAppConfigFromCloud() {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user) return null;
    const { data, error } = await window._sb
      .from('app_config')
      .select('*')
      .eq('user_id', user.id)
      .limit(1);
    if (error || !data || !data.length) return null;
    return data[0];
  } catch (e) {
    console.warn('[StayOps] loadAppConfigFromCloud failed', e);
    return null;
  }
}

export async function saveAppConfigToCloud(patch) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user) return;
    const payload = {
      user_id:    user.id,
      updated_at: new Date().toISOString(),
      ...patch,
    };
    await window._sb.from('app_config')
      .upsert(payload, { onConflict: 'user_id' });
  } catch (e) {
    console.warn('[StayOps] saveAppConfigToCloud failed', e);
  }
}


// ── HOST CONFIG (Supabase) ─────────────────────────────────────────────────────

export async function saveHostConfigToSupabase(profile) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !profile) return null;

    const payload = {
      user_id:    user.id,
      name:       profile.name     || null,
      company:    profile.company  || null,
      abn:        profile.abn      || null,
      acn:        profile.acn      || null,
      email:      profile.email    || null,
      phone:      profile.phone    || null,
      address:    profile.address  || null,
      host_id:    profile.hostId   || null,
      updated_at: new Date().toISOString(),
    };

    const clean = Object.fromEntries(
      Object.entries(payload).filter(([_, v]) => v !== null && v !== '')
    );
    clean.user_id    = user.id;
    clean.updated_at = payload.updated_at;

    const { data, error } = await window._sb
      .from('host_config')
      .upsert(clean, { onConflict: 'user_id' })
      .select()
      .single();

    if (error) { console.warn('[StayOps] saveHostConfigToSupabase error', error); return null; }
    return data;
  } catch (e) {
    console.warn('[StayOps] saveHostConfigToSupabase failed', e);
    return null;
  }
}

export async function loadHostConfigFromSupabase() {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user) return null;
    const { data, error } = await window._sb
      .from('host_config')
      .select('*')
      .eq('user_id', user.id)
      .limit(1);
    if (error || !data || !data.length) return null;
    const row = data[0];
    return {
      hostId:   row.host_id   || null,
      name:     row.name      || '',
      company:  row.company   || '',
      abn:      row.abn       || '',
      acn:      row.acn       || '',
      email:    row.email     || '',
      phone:    row.phone     || '',
      address:  row.address   || '',
    };
  } catch (e) {
    console.warn('[StayOps] loadHostConfigFromSupabase failed', e);
    return null;
  }
}


// ── EMAIL ─────────────────────────────────────────────────────────────────────

const DB = {
  async sendEmail(to, subject, html, text) {
    try {
      const res = await fetch('/.netlify/functions/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, subject, html, text }),
      });
      return await res.json();
    } catch (e) {
      console.warn('[StayOps] DB.sendEmail failed', e);
      return { ok: false };
    }
  }
};

// ── PRICING RULES (Smart Pricing) ─────────────────────────────────────────────
export async function fetchPricingRulesForProperty(propertyIdUuid) {
  if (!window._sb || !propertyIdUuid) return [];
  const user = await getCurrentSupabaseUser();
  if (!user) return [];
  const { data, error } = await window._sb
    .from('pricing_rules')
    .select('*')
    .eq('user_id', user.id)
    .eq('property_id', propertyIdUuid)
    .order('rule_type', { ascending: true })
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: true });
  if (error) {
    console.warn('[StayOps] fetchPricingRulesForProperty', error.message || error);
    return [];
  }
  return Array.isArray(data) ? data : [];
}

export async function insertPricingRules(rows) {
  if (!window._sb || !rows.length) return { error: 'no client' };
  const user = await getCurrentSupabaseUser();
  if (!user) return { error: 'not signed in' };
  const payload = rows.map((r) => ({
    ...r,
    user_id: user.id,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await window._sb.from('pricing_rules').insert(payload);
  if (error) console.warn('[StayOps] insertPricingRules', error.message || error);
  return { error: error ? error.message : null };
}

export async function updatePricingRule(id, patch) {
  if (!window._sb || !id) return { error: 'no client' };
  const user = await getCurrentSupabaseUser();
  if (!user) return { error: 'not signed in' };
  const { error } = await window._sb
    .from('pricing_rules')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id);
  if (error) console.warn('[StayOps] updatePricingRule', error.message || error);
  return { error: error ? error.message : null };
}

export async function deletePricingRuleRow(id) {
  if (!window._sb || !id) return { error: 'no client' };
  const user = await getCurrentSupabaseUser();
  if (!user) return { error: 'not signed in' };
  const { error } = await window._sb
    .from('pricing_rules')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id);
  if (error) console.warn('[StayOps] deletePricingRuleRow', error.message || error);
  return { error: error ? error.message : null };
}

export async function ensureDefaultPricingRules(propertyIdUuid, seed) {
  if (!window._sb || !propertyIdUuid) return;
  const user = await getCurrentSupabaseUser();
  if (!user) return;
  const existing = await fetchPricingRulesForProperty(propertyIdUuid);
  if (existing.length) return;
  const bn = Number(seed?.baseNightly) || 280;
  const bw = Number(seed?.baseWeekend) || Math.round(bn * 1.15);
  const mn = Number(seed?.minNights) || 2;
  const wPct = Number(seed?.weeklyPct) || 10;
  const mPct = Number(seed?.monthlyPct) || 15;
  const lmPct = Number(seed?.lastMinutePct) || 12;
  const lmDays = Number(seed?.lastMinuteDays) || 3;
  await insertPricingRules([
    { property_id: propertyIdUuid, rule_type: 'base_nightly', value: bn, is_default: true },
    { property_id: propertyIdUuid, rule_type: 'base_weekend', value: bw, is_default: true },
    { property_id: propertyIdUuid, rule_type: 'min_nights', value: mn, is_default: true },
    {
      property_id: propertyIdUuid,
      rule_type: 'discount',
      name: 'Weekly discount',
      value: wPct,
      condition_type: 'stay_length',
      condition_value: 7,
      is_default: true,
    },
    {
      property_id: propertyIdUuid,
      rule_type: 'discount',
      name: 'Monthly discount',
      value: mPct,
      condition_type: 'stay_length',
      condition_value: 28,
      is_default: true,
    },
    {
      property_id: propertyIdUuid,
      rule_type: 'discount',
      name: 'Last-minute',
      value: lmPct,
      condition_type: 'last_minute',
      condition_value: lmDays,
      is_default: true,
    },
  ]);
}


// ── LOADING / LOGIN SCREEN ────────────────────────────────────────────────────

export function showLoadingScreen(msg) {
  const el = document.getElementById('stayops-loading-screen');
  if (el) el.style.display = 'flex';
  if (msg) setLoadingStatus(msg);
}

export function hideLoadingScreen() {
  const el = document.getElementById('stayops-loading-screen');
  if (el) el.style.display = 'none';
}

export function setLoadingStatus(msg) {
  const el = document.getElementById('loading-status');
  if (el) el.textContent = msg || '';
}

export function showLoginScreen() {
  const login = document.getElementById('stayops-login-screen');
  const app   = document.getElementById('main-content');
  const nav   = document.querySelector('.nav');
  const hdr   = document.querySelector('.header');
  if (login) login.style.display = 'flex';
  if (app)   app.style.display   = 'none';
  if (nav)   nav.style.display   = 'none';
  if (hdr)   hdr.style.display   = 'none';
  hideLoadingScreen();
}

export function showAppChrome() {
  const login = document.getElementById('stayops-login-screen');
  const app   = document.getElementById('main-content');
  const nav   = document.querySelector('.nav');
  const hdr   = document.querySelector('.header');
  if (login) login.style.display = 'none';
  if (app)   app.style.display   = '';
  if (nav)   nav.style.display   = '';
  if (hdr)   hdr.style.display   = '';

  // Safety net: header property name before the app becomes visible. On first
  // private-mode load, an earlier initPropertyUI() can run before config is resolved.
  try {
    initPropertyUI();
  } catch (e) { /* non-critical */ }

  hideLoadingScreen();
}

export async function handleLoginSubmit() {
  const email    = (document.getElementById('login-email')    || {}).value || '';
  const password = (document.getElementById('login-password') || {}).value || '';
  const errEl    = document.getElementById('login-error');
  if (errEl) errEl.textContent = '';
  if (!email || !password) { if (errEl) errEl.textContent = 'Enter your email and password.'; return; }
  const btn = document.getElementById('login-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
  showLoadingScreen('Signing you in…');
  const { error } = await supabaseSignIn(email, password);
  if (error) {
    hideLoadingScreen();
    if (btn) { btn.disabled = false; btn.textContent = 'Sign In'; }
    if (errEl) errEl.textContent = (typeof error === 'object' ? error.message : error) || 'Sign in failed.';
    return;
  }
  const role = await detectUserRole();
  if (role === 'cleaner') {
    showCleanerApp();
    if (btn) { btn.disabled = false; btn.textContent = 'Sign In'; }
    return;
  }
  // Successful sign in — run the full boot sequence
  // Hide login screen immediately so boot-sequence modals are not blocked
  const loginEl = document.getElementById('stayops-login-screen');
  if (loginEl) loginEl.style.display = 'none';
  if (btn) { btn.disabled = false; btn.textContent = 'Sign In'; }
  try {
    if (typeof migrateConfigFromLegacySettings === 'function') migrateConfigFromLegacySettings();
    if (typeof setLoadingStatus === 'function') setLoadingStatus('Checking your account…');
    if (typeof seedLocalConfigFromCloud === 'function') await seedLocalConfigFromCloud();
    if (typeof ensureHostIdentityAndRestore === 'function') await ensureHostIdentityAndRestore();
    if (typeof setLoadingStatus === 'function') setLoadingStatus('Starting app…');
    if (typeof finishAppInit === 'function') await finishAppInit();
    if (typeof setLoadingStatus === 'function') setLoadingStatus('Loading your data…');
    if (typeof hydrateFromCloud === 'function') await hydrateFromCloud();
    if (typeof reloadInMemoryData === 'function') reloadInMemoryData();
    if (typeof _normalizeBookingCleanState === 'function') _normalizeBookingCleanState();
    if (typeof initPropertyUI === 'function') initPropertyUI();
    if (typeof window.applyPortfolioModeAfterHostHydrate === 'function') {
      await window.applyPortfolioModeAfterHostHydrate();
    }
    if (typeof isOnboardingComplete === 'function' && !isOnboardingComplete()) {
      if (typeof showOnboarding === 'function') showOnboarding();
      return;
    }
    if (typeof window.isPortfolioMode === 'function' && !window.isPortfolioMode() && typeof renderAll === 'function') {
      renderAll();
    }
    setTimeout(() => { if (typeof checkAutoSendReport === 'function') checkAutoSendReport(); }, 1500);
    setTimeout(() => { if (typeof maybeAutoScanGmail === 'function') maybeAutoScanGmail(); }, 3000);
    setTimeout(() => { if (typeof maybeAutoScanOutlook === 'function') maybeAutoScanOutlook(); }, 4500);
  } catch (e) {
    console.error('[StayOps] Boot after login failed:', e);
  } finally {
    if (typeof showAppChrome === 'function') showAppChrome();
  }
}

export async function handleMagicLinkSubmit() {
  const email = (document.getElementById('login-email') || {}).value || '';
  const errEl = document.getElementById('login-error');
  if (errEl) {
    errEl.style.color = '#FF3B30';
    errEl.textContent = '';
  }
  if (!email) {
    if (errEl) errEl.textContent = 'Enter your email address.';
    return;
  }

  const btn = document.getElementById('magic-link-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

  const { error } = await supabaseSignInWithMagicLink(email);

  if (btn) { btn.disabled = false; btn.textContent = 'Send Magic Link'; }

  if (error) {
    if (errEl) errEl.textContent = (typeof error === 'object' ? error.message : error) || 'Failed to send link.';
    return;
  }

  if (errEl) {
    errEl.style.color = '#34C759';
    errEl.textContent = 'Check your email — tap the link to sign in.';
  }
}

export function showCleanerApp() {
  // Hide everything host-related
  const mainContent = document.getElementById('main-content');
  const hostNav = document.querySelector('.nav:not(#cleaner-nav)');
  const header = document.querySelector('.header');
  const loginScreen = document.getElementById('stayops-login-screen');
  const legacyCleanerApp = document.getElementById('cleaner-app');

  if (mainContent) mainContent.style.display = 'none';
  if (hostNav) hostNav.style.display = 'none';
  if (header) header.style.display = 'none';
  if (loginScreen) loginScreen.style.display = 'none';
  if (legacyCleanerApp) legacyCleanerApp.style.display = 'none';

  // Remove old cleaner mode classes (CSS toggles #cleaner-app / PIN screen from these)
  document.body.classList.remove('cleaner-mode', 'cleaner-pin-active');

  // Hide any remaining node whose text reads as CLEANER VIEW (legacy header subtitle)
  try {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.nodeValue || !node.nodeValue.trim()) continue;
      if (!node.nodeValue.toUpperCase().includes('CLEANER VIEW')) continue;
      const el = node.parentElement;
      const block = el && el.closest ? el.closest('#cleaner-app, .cleaner-header') : null;
      if (block) block.style.display = 'none';
    }
  } catch (_) { /* ignore */ }

  // Show new cleaner UI
  const cleanerNav = document.getElementById('cleaner-nav');
  const cleanerContent = document.getElementById('cleaner-content');
  if (cleanerNav) cleanerNav.style.display = '';
  if (cleanerContent) cleanerContent.style.display = '';

  hideLoadingScreen();

  // Load cleaner data
  loadCleanerDashboard().then((data) => {
    if (data) {
      window._cleanerData = data;
      if (typeof renderNewCleanerView === 'function') renderNewCleanerView(data);
    }
  });
}

export function toggleSignUp() {
  const loginForm  = document.getElementById('login-signin-section');
  const signupForm = document.getElementById('login-signup-section');
  if (!loginForm || !signupForm) return;
  const isLogin = loginForm.style.display !== 'none';
  loginForm.style.display  = isLogin ? 'none' : '';
  signupForm.style.display = isLogin ? '' : 'none';
}

export async function handleSignUpSubmit() {
  const email    = (document.getElementById('signup-email')    || {}).value || '';
  const password = (document.getElementById('signup-password') || {}).value || '';
  const errEl    = document.getElementById('signup-error');
  if (errEl) errEl.textContent = '';
  if (!email || !password) { if (errEl) errEl.textContent = 'Enter your email and password.'; return; }
  const btn = document.getElementById('signup-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Creating account…'; }
  showLoadingScreen('Creating your account…');
  const { error } = await supabaseSignUp(email, password);
  hideLoadingScreen();
  if (btn) { btn.disabled = false; btn.textContent = 'Create Account'; }
  if (error) {
    if (errEl) errEl.textContent = (typeof error === 'object' ? error.message : error) || 'Sign up failed.';
    return;
  }
  if (errEl) errEl.textContent = 'Check your email to confirm your account.';
}


export async function hostSignOut() {
  await supabaseSignOut();
  window._cloudPropertyIds = {};
  window._cloudPropertyId = null;
  window._supabaseUser = null;
  showLoginScreen();
}
