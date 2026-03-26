/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Supabase Integration Layer v2
   Tables: host_config, properties, cleaners, cleaning_jobs,
           cleans, notes, expenses, inventory
   ═══════════════════════════════════════════════════════════════════════════ */

const SUPABASE_URL      = 'https://nbeuyypgiipptxlqnhel.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5iZXV5eXBnaWlwcHR4bHFuaGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMDg0MDEsImV4cCI6MjA4OTU4NDQwMX0.TfsTKhDDMiOptoMCRXD149KC4pYGvuFM2px9_auwDG0';

// ── INIT ──────────────────────────────────────────────────────────────────────
(function initSupabase() {
  if (!window.supabase) {
    console.error('[StayOps] Supabase SDK not loaded');
    return;
  }
  window._sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  console.log('[StayOps] Supabase client ready');
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

async function getSupabaseSession() {
  if (!window._sb) return null;
  try {
    const { data } = await window._sb.auth.getSession();
    return (data && data.session) ? data.session : null;
  } catch (e) {
    return null;
  }
}

async function getCurrentSupabaseUser() {
  if (!window._sb) return null;
  if (window._supabaseUser) return window._supabaseUser;
  try {
    const { data } = await window._sb.auth.getUser();
    if (data && data.user) {
      window._supabaseUser = data.user;
      return data.user;
    }
  } catch (e) {}
  return null;
}


// ── PROPERTIES ────────────────────────────────────────────────────────────────

async function loadPropertyFromCloud() {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user) { console.log('[PreFlight] loadPropertyFromCloud: no user'); return null; }
    const { data, error } = await window._sb
      .from('properties')
      .select('*')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false })
      .limit(1);
    if (error) { console.warn('[PreFlight] loadPropertyFromCloud query error:', error); return null; }
    if (!data || !data.length) { console.log('[PreFlight] loadPropertyFromCloud: no rows'); return null; }
    console.log('[PreFlight] loadPropertyFromCloud: found property "' + data[0].name + '" id=' + data[0].id);
    return data[0];
  } catch (e) {
    console.warn('[PreFlight] loadPropertyFromCloud exception:', e);
    return null;
  }
}

/**
 * seedLocalConfigFromCloud — pre-flight helper.
 * If the user has a property in Supabase, seeds it into localStorage
 * so hasValidPropertyConfig() and isOnboardingComplete() pass.
 * Non-blocking: returns true if seeded, false if not (new user or error).
 */
async function seedLocalConfigFromCloud() {
  console.log('[PreFlight] seedLocalConfigFromCloud: starting...');
  try {
    const cloudProp = await loadPropertyFromCloud();
    if (!cloudProp || !cloudProp.name) {
      console.log('[PreFlight] seedLocalConfigFromCloud: no cloud property with name — new user, onboarding will show');
      return false;
    }

    console.log('[PreFlight] seedLocalConfigFromCloud: found "' + cloudProp.name + '", seeding localStorage...');

    // 1. Set the setup-complete flag so hasValidPropertyConfig() returns true
    localStorage.setItem('gh-setup-complete', '1');
    console.log('[PreFlight] gh-setup-complete set to 1');

    // 2. Cache the cloud property ID for booking saves
    window._cloudPropertyId = cloudProp.id;
    console.log('[PreFlight] _cloudPropertyId set to', cloudProp.id);

    // 3. Seed the full property config into localStorage
    //    Wrap in _stayOpsHydrating to suppress cloud write-back
    window._stayOpsHydrating = true;
    try {
      if (typeof savePropertyConfig === 'function') {
        const localCfg = {
          name:    cloudProp.name,
          suburb:  cloudProp.suburb  || '',
          state:   cloudProp.state   || '',
          region:  cloudProp.region  || '',
          country: cloudProp.country || 'Australia',
          branding: {
            subtitle: [cloudProp.suburb, cloudProp.state].filter(Boolean).join(' · '),
            tagline:  cloudProp.tagline || [cloudProp.suburb, cloudProp.state].filter(Boolean).join(', '),
          },
          property: {
            bedrooms:  cloudProp.bedrooms      || 4,
            maxGuests: cloudProp.max_guests    || 8,
            bathrooms: cloudProp.bathrooms     || 2,
            type:      cloudProp.property_type || 'house',
          },
          owner: {
            name:  cloudProp.owner_name  || '',
            email: cloudProp.owner_email || '',
            phone: cloudProp.owner_phone || '',
          },
          integrations: {
            sheetCsvUrl:    cloudProp.sheets_url       || '',
            syncUrl:      cloudProp.script_url       || '',
            vapidPublicKey: cloudProp.vapid_public_key || '',
          },
          pricing: {
            baseRate: cloudProp.base_rate || 350,
          },
          updated_at: cloudProp.updated_at || new Date().toISOString(),
        };
        savePropertyConfig(localCfg);
        console.log('[PreFlight] savePropertyConfig() called successfully');

        // Verify it worked
        if (typeof getActivePropertyConfig === 'function') {
          const verify = getActivePropertyConfig();
          console.log('[PreFlight] Verify — getActivePropertyConfig().name =', verify && verify.name);
        }
        if (typeof hasValidPropertyConfig === 'function') {
          console.log('[PreFlight] Verify — hasValidPropertyConfig() =', hasValidPropertyConfig());
        }
      } else {
        console.warn('[PreFlight] savePropertyConfig not available — config.js may not be loaded yet');
      }
    } finally {
      window._stayOpsHydrating = false;
    }

    // 4. Also restore API keys to localStorage if present
    if (cloudProp.anthropic_api_key) localStorage.setItem('gh-api-key', cloudProp.anthropic_api_key);
    if (cloudProp.script_url) localStorage.setItem('gh-script-url', cloudProp.script_url);
    if (cloudProp.mgmt_fee_rate != null) localStorage.setItem(lsKey('mgmt-fee-rate'), String(cloudProp.mgmt_fee_rate));

    console.log('[PreFlight] seedLocalConfigFromCloud: DONE — setup gates should now pass');
    return true;
  } catch (e) {
    console.warn('[PreFlight] seedLocalConfigFromCloud failed (non-fatal, onboarding may show):', e);
    window._stayOpsHydrating = false;
    return false;
  }
}

async function savePropertyToCloud(cfg) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !cfg) return null;

    // Build payload — only include fields that have real values
    // Never write empty strings — let the existing cloud value stand
    const raw = {
      user_id:           user.id,
      name:              cfg.name         || null,
      address:           cfg.address      || null,
      suburb:            cfg.suburb       || null,
      state:             cfg.state        || null,
      country:           cfg.country      || null,
      region:            cfg.region       || null,
      tagline:           (cfg.branding && cfg.branding.tagline)       || null,
      bedrooms:          (cfg.property && cfg.property.bedrooms)      || null,
      bathrooms:         (cfg.property && cfg.property.bathrooms)     || null,
      max_guests:        (cfg.property && cfg.property.maxGuests)     || null,
      property_type:     (cfg.property && cfg.property.type)          || null,
      timezone:          'Australia/Sydney',
      sheets_url:        (cfg.integrations && cfg.integrations.sheetCsvUrl)   || null,
      script_url:        (cfg.integrations && cfg.integrations.syncUrl)     || null,
      calendar_id:       null,
      vapid_public_key:  (cfg.integrations && cfg.integrations.vapidPublicKey) || null,
      base_rate:         (cfg.pricing && cfg.pricing.baseRate)         || null,
      owner_name:              (cfg.owner && cfg.owner.name)                 || null,
      owner_email:             (cfg.owner && cfg.owner.email)                || null,
      owner_phone:             (cfg.owner && cfg.owner.phone)                || null,
      report_email_subject:    (cfg.owner && cfg.owner.reportEmailSubject)   || null,
      report_email_body:       (cfg.owner && cfg.owner.reportEmailBody)      || null,
      auto_send_report:        (cfg.owner && cfg.owner.autoSendReport != null) ? cfg.owner.autoSendReport : null,
      report_frequency:        (cfg.owner && cfg.owner.reportFrequency)      || null,
      last_report_sent_at:     (cfg.owner && cfg.owner.lastReportSentAt)     || null,
      anthropic_api_key: localStorage.getItem('gh-api-key')            || null,
      mgmt_fee_rate:     parseFloat(localStorage.getItem(lsKey('mgmt-fee-rate')) || '0') || null,
      // Use config's own updated_at if present so timestamp reflects when user actually saved
      updated_at:        cfg.updated_at || new Date().toISOString()
    };

    // Strip null values so we never overwrite real cloud data with nulls
    const payload = Object.fromEntries(
      Object.entries(raw).filter(([_, v]) => v !== null && v !== '')
    );
    // Always include user_id and updated_at even if stripped
    payload.user_id    = user.id;
    payload.updated_at = raw.updated_at;

    const { data, error } = await window._sb
      .from('properties')
      .upsert(payload, { onConflict: 'user_id' })
      .select()
      .single();
    if (error) { console.warn('[StayOps] savePropertyToCloud error', error); return null; }
    window._cloudPropertyId = data && data.id;
    return data;
  } catch (e) {
    console.warn('[StayOps] savePropertyToCloud failed', e);
    return null;
  }
}

async function getCloudPropertyId() {
  if (window._cloudPropertyId) return window._cloudPropertyId;
  const prop = await loadPropertyFromCloud();
  if (prop) { window._cloudPropertyId = prop.id; return prop.id; }
  return null;
}


// ── HOST CONFIG ───────────────────────────────────────────────────────────────

async function saveHostConfigToCloud(configData) {
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
      active:      c.active !== false
    }));
  } catch (e) {
    console.warn('[StayOps] loadCleanersFromCloud failed', e);
    return null;
  }
}

async function saveCleanersToCloud(cleanerList) {
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

async function loadCleansFromCloud() {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user) return null;
    const { data, error } = await window._sb
      .from('cleans')
      .select('*')
      .eq('user_id', user.id)
      .order('clean_date', { ascending: true });
    if (error || !data) return null;
    return data.map(c => ({
      id:               c.local_id ? Number(c.local_id) || c.local_id : c.id,
      _cloudId:         c.id,
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

async function saveCleanToCloud(clean) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !clean) return;
    const propertyId = await getCloudPropertyId();
    const payload = {
      user_id:          user.id,
      property_id:      propertyId || null,
      local_id:         String(clean.id),
      booking_id:       String(clean.bookingId || ''),
      guest_name:       clean.guestName   || '',
      cleaner:          clean.cleaner     || '',
      cleaner_id:       String(clean.cleanerId || ''),
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
      await window._sb.from('cleans').upsert({ id: clean._cloudId, ...payload });
    } else {
      const { data } = await window._sb
        .from('cleans')
        .upsert(payload, { onConflict: 'local_id,user_id' })
        .select().single();
      if (data) clean._cloudId = data.id;
    }
  } catch (e) {
    console.warn('[StayOps] saveCleanToCloud failed', e);
  }
}

async function saveCleansToCloud(cleansList) {
  if (!Array.isArray(cleansList)) return;
  for (const c of cleansList) await saveCleanToCloud(c);
}

// Keep old name working for backward compat
async function saveCleaningJobToCloud(job) { return saveCleanToCloud(job); }
async function loadCleaningJobsFromCloud() { return loadCleansFromCloud(); }


// ── NOTES ─────────────────────────────────────────────────────────────────────

async function loadNotesFromCloud() {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user) return null;
    const { data, error } = await window._sb
      .from('notes')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true });
    if (error || !data) return null;
    return data.map(n => ({
      id:       n.local_id ? Number(n.local_id) || n.local_id : n.id,
      _cloudId: n.id,
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
    const payload = {
      user_id:     user.id,
      property_id: propertyId || null,
      local_id:    String(note.id),
      content:     note.content || note.text || note.body || String(note),
      updated_at:  new Date().toISOString()
    };
    if (note._cloudId) {
      await window._sb.from('notes').upsert({ id: note._cloudId, ...payload });
    } else {
      const { data } = await window._sb
        .from('notes')
        .upsert(payload, { onConflict: 'local_id,user_id' })
        .select().single();
      if (data) note._cloudId = data.id;
    }
  } catch (e) {
    console.warn('[StayOps] saveNoteToCloud failed', e);
  }
}

async function saveNotesToCloud(notesList) {
  if (!Array.isArray(notesList)) return;
  for (const n of notesList) await saveNoteToCloud(n);
}


// ── EXPENSES ──────────────────────────────────────────────────────────────────

async function loadExpensesFromCloud() {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user) return null;
    const { data, error } = await window._sb
      .from('expenses')
      .select('*')
      .eq('user_id', user.id)
      .order('date', { ascending: false });
    if (error || !data) return null;
    return data.map(e => ({
      id:          e.local_id ? Number(e.local_id) || e.local_id : e.id,
      _cloudId:    e.id,
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

async function saveExpenseToCloud(expense) {
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

async function deleteExpenseFromCloud(expense) {
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
    const { data, error } = await window._sb
      .from('inventory')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true });
    if (error || !data) return null;
    return data.map(i => ({
      id:        i.local_id ? Number(i.local_id) || i.local_id : i.id,
      _cloudId:  i.id,
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
    const payload = {
      user_id:     user.id,
      property_id: propertyId || null,
      local_id:    String(item.id),
      name:        item.name      || '',
      stock:       item.stock     || 0,
      threshold:   item.threshold || 0,
      unit:        item.unit      || '',
      updated_at:  new Date().toISOString()
    };
    if (item._cloudId) {
      await window._sb.from('inventory').upsert({ id: item._cloudId, ...payload });
    } else {
      const { data } = await window._sb
        .from('inventory')
        .upsert(payload, { onConflict: 'local_id,user_id' })
        .select().single();
      if (data) item._cloudId = data.id;
    }
  } catch (e) {
    console.warn('[StayOps] saveInventoryItemToCloud failed', e);
  }
}

async function saveInventoryToCloud(inventoryList) {
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
    const { data, error } = await window._sb
      .from('maintenance')
      .select('*')
      .eq('user_id', user.id)
      .order('date', { ascending: false });
    if (error || !data) return null;
    return data.map(m => ({
      id:          m.local_id ? Number(m.local_id) || m.local_id : m.id,
      _cloudId:    m.id,
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
    const payload = {
      user_id:     user.id,
      property_id: propertyId || null,
      local_id:    String(item.id),
      description: item.description || '',
      status:      item.status      || 'open',
      cost:        Number(item.cost) || 0,
      contractor:  item.contractor  || '',
      date:        item.date        || null,
      updated_at:  new Date().toISOString()
    };
    if (item._cloudId) {
      await window._sb.from('maintenance').upsert({ id: item._cloudId, ...payload });
    } else {
      const { data } = await window._sb
        .from('maintenance')
        .upsert(payload, { onConflict: 'local_id,user_id' })
        .select().single();
      if (data) item._cloudId = data.id;
    }
  } catch (e) {
    console.warn('[StayOps] saveMaintenanceItemToCloud failed', e);
  }
}

async function saveMaintenanceToCloud(maintenanceList) {
  if (!Array.isArray(maintenanceList)) return;
  for (const m of maintenanceList) await saveMaintenanceItemToCloud(m);
}

async function deleteMaintenanceFromCloud(item) {
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
async function hydrateFromCloud() {
  try {
    // Set hydration flag — suppresses cloud writes and renders during hydration
    window._stayOpsHydrating = true;
    console.log('[StayOps] hydrateFromCloud starting…');

    // 1. Cleaners — cloud is source of truth
    const cloudCleaners = await loadCleanersFromCloud();
    if (Array.isArray(cloudCleaners)) {
      localStorage.setItem(lsKey('cleaners'), JSON.stringify(cloudCleaners));
      console.log('[StayOps] Hydrated', cloudCleaners.length, 'cleaners from cloud');
    }

    // 0. Bookings — primary source now Supabase (replaces Sheet CSV)
    const cloudBookings = await loadBookingsFromCloud();
    if (Array.isArray(cloudBookings)) {
      localStorage.setItem(lsKey('bookings'), JSON.stringify(cloudBookings));
      console.log('[StayOps] Hydrated', cloudBookings.length, 'bookings from cloud');
    }

    // 2. Cleans — cloud is source of truth
    const cloudCleans = await loadCleansFromCloud();
    if (Array.isArray(cloudCleans)) {
      localStorage.setItem(lsKey('cleans'), JSON.stringify(cloudCleans));
      console.log('[StayOps] Hydrated', cloudCleans.length, 'cleans from cloud');
    }

    // 3. Notes
    const cloudNotes = await loadNotesFromCloud();
    if (Array.isArray(cloudNotes)) {
      localStorage.setItem(lsKey('notes'), JSON.stringify(cloudNotes));
      console.log('[StayOps] Hydrated', cloudNotes.length, 'notes from cloud');
    }

    // 4. Expenses
    const cloudExpenses = await loadExpensesFromCloud();
    if (Array.isArray(cloudExpenses)) {
      localStorage.setItem(lsKey('expenses'), JSON.stringify(cloudExpenses));
      console.log('[StayOps] Hydrated', cloudExpenses.length, 'expenses from cloud');
    }

    // 5. Inventory
    const cloudInventory = await loadInventoryFromCloud();
    if (Array.isArray(cloudInventory)) {
      localStorage.setItem(lsKey('inventory'), JSON.stringify(cloudInventory));
      console.log('[StayOps] Hydrated', cloudInventory.length, 'inventory items from cloud');
    }

    // 5b. Maintenance
    const cloudMaintenance = await loadMaintenanceFromCloud();
    if (Array.isArray(cloudMaintenance)) {
      localStorage.setItem(lsKey('maintenance'), JSON.stringify(cloudMaintenance));
      console.log('[StayOps] Hydrated', cloudMaintenance.length, 'maintenance items from cloud');
    }

    // 6. Property config — timestamp-based merge: newer wins
    const cloudProp = await loadPropertyFromCloud();
    if (cloudProp) {
      window._cloudPropertyId = cloudProp.id;

      // Restore API settings to localStorage
      if (cloudProp.anthropic_api_key) localStorage.setItem('gh-api-key', cloudProp.anthropic_api_key);
      if (cloudProp.mgmt_fee_rate != null) localStorage.setItem(lsKey('mgmt-fee-rate'), String(cloudProp.mgmt_fee_rate));

      const existingCfg = (typeof getActivePropertyConfig === 'function') ? getActivePropertyConfig() : {};
      const localUpdatedAt  = existingCfg.updated_at ? new Date(existingCfg.updated_at).getTime()  : 0;
      const cloudUpdatedAt  = cloudProp.updated_at   ? new Date(cloudProp.updated_at).getTime()    : 0;

      // Cloud wins if it's newer OR if local has no timestamp (fresh device)
      if (cloudUpdatedAt >= localUpdatedAt) {
        const updates = {
          name:    cloudProp.name    || existingCfg.name,
          address: cloudProp.address || existingCfg.address,
          suburb:  cloudProp.suburb  || existingCfg.suburb,
          state:   cloudProp.state   || existingCfg.state,
          region:  cloudProp.region  || existingCfg.region,
          country: cloudProp.country || existingCfg.country,
          branding: {
            tagline: cloudProp.tagline || (existingCfg.branding && existingCfg.branding.tagline) || ''
          },
          property: {
            bedrooms:  cloudProp.bedrooms   || (existingCfg.property && existingCfg.property.bedrooms),
            bathrooms: cloudProp.bathrooms  || (existingCfg.property && existingCfg.property.bathrooms),
            maxGuests: cloudProp.max_guests || (existingCfg.property && existingCfg.property.maxGuests),
            type:      cloudProp.property_type || (existingCfg.property && existingCfg.property.type) || 'house'
          },
          owner: {
            name:  cloudProp.owner_name  || (existingCfg.owner && existingCfg.owner.name)  || '',
            email: cloudProp.owner_email || (existingCfg.owner && existingCfg.owner.email) || '',
            phone: cloudProp.owner_phone || (existingCfg.owner && existingCfg.owner.phone) || '',
            reportEmailSubject: cloudProp.report_email_subject || (existingCfg.owner && existingCfg.owner.reportEmailSubject) || '',
            reportEmailBody:    cloudProp.report_email_body    || (existingCfg.owner && existingCfg.owner.reportEmailBody)    || '',
            autoSendReport:     cloudProp.auto_send_report     != null ? cloudProp.auto_send_report : ((existingCfg.owner && existingCfg.owner.autoSendReport) || false),
            reportFrequency:    cloudProp.report_frequency     || (existingCfg.owner && existingCfg.owner.reportFrequency)    || 'monthly',
            lastReportSentAt:   cloudProp.last_report_sent_at  || (existingCfg.owner && existingCfg.owner.lastReportSentAt)   || null,
          },
          integrations: {
            sheetCsvUrl:    cloudProp.sheets_url      || (existingCfg.integrations && existingCfg.integrations.sheetCsvUrl),
            syncUrl:      cloudProp.script_url      || (existingCfg.integrations && existingCfg.integrations.syncUrl),
            vapidPublicKey: cloudProp.vapid_public_key || (existingCfg.integrations && existingCfg.integrations.vapidPublicKey),
          },
          pricing: {
            baseRate: cloudProp.base_rate || (existingCfg.pricing && existingCfg.pricing.baseRate)
          },
          // Preserve the cloud timestamp so next merge comparison is accurate
          updated_at: cloudProp.updated_at
        };
        // savePropertyConfig is called with hydrating=true so it won't trigger cloud write or render
        if (typeof savePropertyConfig === 'function') savePropertyConfig(updates);
        console.log('[StayOps] Property config: cloud wins (cloud newer or fresh device)');
      } else {
        console.log('[StayOps] Property config: local wins (local is newer)');
      }
    }

    // 7b. App config (push subs, templates, expense cats)
    const cloudAppConfig = await loadAppConfigFromCloud();
    if (cloudAppConfig) {
      if (cloudAppConfig.sms_template) localStorage.setItem(lsKey('sms-template'), cloudAppConfig.sms_template);
      if (cloudAppConfig.expense_cats) localStorage.setItem(lsKey('expense-cats'), JSON.stringify(cloudAppConfig.expense_cats));
      if (cloudAppConfig.email_templates) localStorage.setItem(lsKey('email-tpl-cache'), JSON.stringify(cloudAppConfig.email_templates));
      if (cloudAppConfig.push_subs) localStorage.setItem(lsKey('push-subs'), JSON.stringify(cloudAppConfig.push_subs));
      console.log('[StayOps] Hydrated app config from cloud');
    }

    // 7. Host profile
    const cloudHost = await loadHostConfigFromSupabase();
    if (cloudHost && cloudHost.hostId) {
      const existing = typeof getHostProfile === 'function' ? getHostProfile() : null;
      // Cloud wins if local has no profile or cloud is more complete
      if (!existing || cloudHost.name) {
        if (typeof saveHostProfile === 'function') saveHostProfile(cloudHost);
        console.log('[StayOps] Hydrated host profile from cloud');
      }
    }

    console.log('[StayOps] hydrateFromCloud complete');
  } catch (e) {
    console.warn('[StayOps] hydrateFromCloud error', e);
  } finally {
    // Always clear the hydration flag
    window._stayOpsHydrating = false;
  }
}

/**
 * migrateLocalDataToCloud — one-time push of all localStorage data to Supabase.
 * Run once from the console: migrateLocalDataToCloud()
 */
async function migrateLocalDataToCloud() {
  console.log('[StayOps] Starting migration to cloud…');

  // Property config first (needed for property_id on other tables)
  const cfg = (typeof getActivePropertyConfig === 'function') ? getActivePropertyConfig() : null;
  if (cfg) {
    await savePropertyToCloud(cfg);
    console.log('[StayOps] ✓ Property config migrated');
  }

  // Cleaners
  const cleaners = (typeof loadCleaners === 'function') ? loadCleaners() : [];
  if (cleaners.length) {
    await saveCleanersToCloud(cleaners);
    if (typeof saveCleaners === 'function') saveCleaners(cleaners); // save back with _cloudId
    console.log('[StayOps] ✓', cleaners.length, 'cleaners migrated');
  }

  // Cleans
  const cleans = JSON.parse(localStorage.getItem(lsKey('cleans')) || '[]');
  if (cleans.length) {
    await saveCleansToCloud(cleans);
    localStorage.setItem(lsKey('cleans'), JSON.stringify(cleans));
    console.log('[StayOps] ✓', cleans.length, 'cleans migrated');
  }

  // Notes
  const notes = JSON.parse(localStorage.getItem(lsKey('notes')) || '[]');
  if (notes.length) {
    await saveNotesToCloud(notes);
    localStorage.setItem(lsKey('notes'), JSON.stringify(notes));
    console.log('[StayOps] ✓', notes.length, 'notes migrated');
  }

  // Expenses
  const expenses = JSON.parse(localStorage.getItem(lsKey('expenses')) || '[]');
  if (expenses.length) {
    await saveExpensesToCloud(expenses);
    localStorage.setItem(lsKey('expenses'), JSON.stringify(expenses));
    console.log('[StayOps] ✓', expenses.length, 'expenses migrated');
  }

  // Inventory
  const inventory = JSON.parse(localStorage.getItem(lsKey('inventory')) || '[]');
  if (inventory.length) {
    await saveInventoryToCloud(inventory);
    localStorage.setItem(lsKey('inventory'), JSON.stringify(inventory));
    console.log('[StayOps] ✓', inventory.length, 'inventory items migrated');
  }

  // Maintenance
  const maintenance = JSON.parse(localStorage.getItem(lsKey('maintenance')) || '[]');
  if (maintenance.length) {
    await saveMaintenanceToCloud(maintenance);
    localStorage.setItem(lsKey('maintenance'), JSON.stringify(maintenance));
    console.log('[StayOps] ✓', maintenance.length, 'maintenance items migrated');
  }

  console.log('[StayOps] Migration complete! Run hydrateFromCloud() on other devices.');
}


// ── HOST CONFIG ───────────────────────────────────────────────────────────────

async function saveHostConfigToSupabase(profile) {
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

    // Strip nulls so we never overwrite real data with nulls
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

async function loadHostConfigFromSupabase() {
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
    }));
  } catch (e) {
    console.warn('[StayOps] loadBookingsFromCloud failed', e);
    return null;
  }
}

async function saveBookingToCloud(booking) {
  const user = await getCurrentSupabaseUser();
  if (!user || !booking) return;
  const propertyId = await getCloudPropertyId();
  const payload = {
    user_id:            user.id,
    property_id:        propertyId || null,
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
    updated_at:         new Date().toISOString(),
  };
  if (booking._cloudId) {
    const { error } = await window._sb.from('bookings').upsert({ id: booking._cloudId, ...payload });
    if (error) { console.warn('[StayOps] saveBookingToCloud upsert error', error); throw error; }
  } else {
    const { data, error } = await window._sb
      .from('bookings')
      .upsert(payload, { onConflict: 'local_id,user_id' })
      .select().single();
    if (error) { console.warn('[StayOps] saveBookingToCloud insert error', error); throw error; }
    if (data) booking._cloudId = data.id;
  }
}

async function saveBookingsToCloud(bookingsList) {
  if (!Array.isArray(bookingsList) || !bookingsList.length) return;
  const user = await getCurrentSupabaseUser();
  if (!user) throw new Error('Not signed in — cannot save bookings to cloud');
  const propertyId = await getCloudPropertyId();
  const payload = bookingsList.map(b => ({
    user_id:            user.id,
    property_id:        propertyId || null,
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
    updated_at:         new Date().toISOString(),
  }));
  const { error } = await window._sb
    .from('bookings')
    .upsert(payload, { onConflict: 'local_id,user_id' });
  if (error) {
    console.warn('[StayOps] saveBookingsToCloud bulk upsert error', error);
    throw new Error(error.message || 'Supabase upsert failed');
  }
}

async function deleteBookingFromCloud(booking) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !booking) return;
    if (booking._cloudId) {
      await window._sb.from('bookings').delete().eq('id', booking._cloudId);
    } else {
      await window._sb.from('bookings').delete()
        .eq('user_id', user.id)
        .eq('local_id', String(booking.id));
    }
  } catch (e) {
    console.warn('[StayOps] deleteBookingFromCloud failed', e);
  }
}

// ── RECEIPTS (Supabase Storage) ───────────────────────────────────────────────

async function uploadReceiptToStorage(file, expenseId) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !file) return null;
    const propertyId = await getCloudPropertyId();
    const ext = file.name ? file.name.split('.').pop() : 'pdf';
    const path = `${user.id}/${propertyId || 'default'}/${expenseId || Date.now()}.${ext}`;
    const { data, error } = await window._sb.storage
      .from('receipts')
      .upload(path, file, { upsert: true, contentType: file.type || 'application/pdf' });
    if (error) { console.warn('[StayOps] Receipt upload error', error); return null; }
    // Get public URL — storage is private so use signed URL (1 year expiry)
    const { data: urlData } = await window._sb.storage
      .from('receipts')
      .createSignedUrl(path, 365 * 24 * 60 * 60);
    return urlData?.signedUrl || null;
  } catch (e) {
    console.warn('[StayOps] uploadReceiptToStorage failed', e);
    return null;
  }
}

async function getReceiptUrl(expenseId, userId, propertyId) {
  try {
    const path = `${userId}/${propertyId || 'default'}/${expenseId}`;
    const { data } = await window._sb.storage
      .from('receipts')
      .createSignedUrl(path, 60 * 60); // 1 hour
    return data?.signedUrl || null;
  } catch (e) {
    return null;
  }
}

// ── APP CONFIG (push subs, templates, expense cats) ───────────────────────────

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

async function saveAppConfigToCloud(patch) {
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


// ── LOADING SCREEN ────────────────────────────────────────────────────────────

function _setHostChrome(show) {
  const app = document.getElementById('main-content');
  const nav = document.querySelector('.nav');
  const hdr = document.querySelector('.header');
  const val = show ? '' : 'none';
  if (app) app.style.display = val;
  if (nav) nav.style.display = val;
  if (hdr) hdr.style.display = val;
}

function showLoadingScreen(msg) {
  document.getElementById('stayops-login-screen').style.display = 'none';
  document.getElementById('stayops-loading-screen').style.display = 'flex';
  const s = document.getElementById('loading-status');
  if (s) s.textContent = msg || 'Loading…';
  _setHostChrome(false);
}

function hideLoadingScreen() {
  document.getElementById('stayops-loading-screen').style.display = 'none';
  // Do NOT restore host chrome here — caller decides what comes next
}

function showLoginScreen() {
  document.getElementById('stayops-loading-screen').style.display = 'none';
  document.getElementById('stayops-login-screen').style.display = 'flex';
  _setHostChrome(false);
}

function hideLoginScreen() {
  document.getElementById('stayops-login-screen').style.display = 'none';
}

function showAppChrome() {
  document.getElementById('stayops-loading-screen').style.display = 'none';
  document.getElementById('stayops-login-screen').style.display = 'none';
  _setHostChrome(true);
}

function setLoadingStatus(msg) {
  const s = document.getElementById('loading-status');
  if (s) s.textContent = msg || '';
}


// ── LOGIN UI ──────────────────────────────────────────────────────────────────

async function handleLoginSubmit() {
  const email    = (document.getElementById('login-email')    || {}).value || '';
  const password = (document.getElementById('login-password') || {}).value || '';
  const errEl    = document.getElementById('login-error');
  const btn      = document.getElementById('login-btn');

  if (!email || !password) {
    if (errEl) errEl.textContent = 'Please enter your email and password.';
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
  if (errEl) errEl.textContent = '';

  const { data, error } = await supabaseSignIn(email, password);

  if (error || !data || !data.user) {
    if (errEl) errEl.textContent = typeof error === 'string' ? error : (error && error.message) || 'Sign in failed — check your email and password.';
    if (btn) { btn.disabled = false; btn.textContent = 'Sign In'; }
    return;
  }

  hideLoginScreen();
  showLoadingScreen('Signing you in…');

  try {
    // ── Pre-flight: check Supabase for an existing property BEFORE finishAppInit ──
    // On a fresh device localStorage is empty, so hasValidPropertyConfig() and
    // isOnboardingComplete() both fail. Seed from cloud so returning users skip setup.
    setLoadingStatus('Checking your account…');
    await seedLocalConfigFromCloud();
    console.log('[StayOps] Login boot: seedLocalConfigFromCloud complete');
    setLoadingStatus('Starting app…');
    if (typeof finishAppInit === 'function') await finishAppInit();
    console.log('[StayOps] Login boot: finishAppInit complete');
    setLoadingStatus('Loading your data…');
    await hydrateFromCloud();
    console.log('[StayOps] Login boot: hydrateFromCloud complete');

    // Refresh in-memory arrays and property UI after cloud hydration
    if (typeof reloadInMemoryData === 'function') reloadInMemoryData();
    if (typeof initPropertyUI === 'function') initPropertyUI();

    // Check if onboarding is needed (new user)
    if (typeof isOnboardingComplete === 'function' && !isOnboardingComplete()) {
      if (typeof showOnboarding === 'function') showOnboarding();
      return;
    }

    if (typeof renderHeaderDateBadge === 'function') renderHeaderDateBadge();
    if (typeof renderAll === 'function') renderAll();
    // Prompt if an owner report is due
    setTimeout(() => { if (typeof checkAutoSendReport === 'function') checkAutoSendReport(); }, 1500);
  } catch (e) {
    console.error('[StayOps] Login boot failed:', e);
  } finally {
    showAppChrome();
  }
}

function toggleSignUp() {
  const signInFields = document.getElementById('login-signin-section');
  const signUpFields = document.getElementById('login-signup-section');
  const toggle       = document.getElementById('login-toggle-link');
  if (!signInFields || !signUpFields) return;
  const isSignUp = signUpFields.style.display !== 'none';
  signInFields.style.display = isSignUp ? '' : 'none';
  signUpFields.style.display = isSignUp ? 'none' : '';
  if (toggle) toggle.textContent = isSignUp ? "Don't have an account? Create one" : 'Already have an account? Sign in';
}

async function handleSignUpSubmit() {
  const email    = (document.getElementById('signup-email')    || {}).value || '';
  const password = (document.getElementById('signup-password') || {}).value || '';
  const errEl    = document.getElementById('signup-error');
  const btn      = document.getElementById('signup-btn');

  if (!email || !password) {
    if (errEl) errEl.textContent = 'Please enter an email and password.';
    return;
  }
  if (password.length < 6) {
    if (errEl) errEl.textContent = 'Password must be at least 6 characters.';
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Creating account…'; }
  if (errEl) errEl.textContent = '';

  const { data, error } = await supabaseSignUp(email, password);
  if (error) {
    if (errEl) errEl.textContent = (error && error.message) || 'Sign up failed.';
    if (btn) { btn.disabled = false; btn.textContent = 'Create Account'; }
    return;
  }
  if (errEl) {
    errEl.style.color = 'var(--moss, #4A7C59)';
    errEl.textContent = '✓ Account created! Check your email to confirm, then sign in.';
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Create Account'; }
}

async function hostSignOut() {
  await supabaseSignOut();
  window._cloudPropertyId = null;
  window._supabaseUser = null;
  showLoginScreen();
}
