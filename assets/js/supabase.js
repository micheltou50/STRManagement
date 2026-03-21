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
    if (!user) return null;
    const { data, error } = await window._sb
      .from('properties')
      .select('*')
      .eq('user_id', user.id)
      .single();
    if (error || !data) return null;
    return data;
  } catch (e) {
    console.warn('[StayOps] loadPropertyFromCloud failed', e);
    return null;
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
      script_url:        (cfg.integrations && cfg.integrations.scriptUrl)     || null,
      calendar_id:       (cfg.integrations && cfg.integrations.calendarId)    || null,
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
      drive_client_id:   localStorage.getItem('gh-gdrive-client-id')   || null,
      drive_folder_id:   localStorage.getItem('gh-drive-folder-id')    || null,
      anthropic_api_key: localStorage.getItem('gh-api-key')            || null,
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
      permissions: c.permissions ? (typeof c.permissions === 'string' ? JSON.parse(c.permissions) : c.permissions) : {},
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
        permissions: JSON.stringify(c.permissions || {}),
        active:      c.active !== false
      };
      if (c._cloudId) {
        await window._sb.from('cleaners').upsert({ id: c._cloudId, ...payload });
      } else {
        const { data } = await window._sb.from('cleaners').insert(payload).select().single();
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

    // 2. Cleans — cloud is source of truth
    const cloudCleans = await loadCleansFromCloud();
    if (Array.isArray(cloudCleans) && cloudCleans.length) {
      localStorage.setItem(lsKey('cleans'), JSON.stringify(cloudCleans));
      console.log('[StayOps] Hydrated', cloudCleans.length, 'cleans from cloud');
    }

    // 3. Notes
    const cloudNotes = await loadNotesFromCloud();
    if (Array.isArray(cloudNotes) && cloudNotes.length) {
      localStorage.setItem(lsKey('notes'), JSON.stringify(cloudNotes));
      console.log('[StayOps] Hydrated', cloudNotes.length, 'notes from cloud');
    }

    // 4. Expenses
    const cloudExpenses = await loadExpensesFromCloud();
    if (Array.isArray(cloudExpenses) && cloudExpenses.length) {
      localStorage.setItem(lsKey('expenses'), JSON.stringify(cloudExpenses));
      console.log('[StayOps] Hydrated', cloudExpenses.length, 'expenses from cloud');
    }

    // 5. Inventory
    const cloudInventory = await loadInventoryFromCloud();
    if (Array.isArray(cloudInventory) && cloudInventory.length) {
      localStorage.setItem(lsKey('inventory'), JSON.stringify(cloudInventory));
      console.log('[StayOps] Hydrated', cloudInventory.length, 'inventory items from cloud');
    }

    // 6. Property config — timestamp-based merge: newer wins
    const cloudProp = await loadPropertyFromCloud();
    if (cloudProp) {
      window._cloudPropertyId = cloudProp.id;

      // Restore Drive and API settings to localStorage FIRST
      // so renderConnectionSummary sees them when it runs
      if (cloudProp.drive_client_id) localStorage.setItem('gh-gdrive-client-id', cloudProp.drive_client_id);
      if (cloudProp.drive_folder_id) localStorage.setItem('gh-drive-folder-id',  cloudProp.drive_folder_id);
      if (cloudProp.anthropic_api_key) localStorage.setItem('gh-api-key', cloudProp.anthropic_api_key);

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
            scriptUrl:      cloudProp.script_url      || (existingCfg.integrations && existingCfg.integrations.scriptUrl),
            calendarId:     cloudProp.calendar_id     || (existingCfg.integrations && existingCfg.integrations.calendarId) || 'primary',
            vapidPublicKey: cloudProp.vapid_public_key || (existingCfg.integrations && existingCfg.integrations.vapidPublicKey),
            driveFolderId:  cloudProp.drive_folder_id  || (existingCfg.integrations && existingCfg.integrations.driveFolderId)
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
  // Also captures Drive client ID, folder ID, and API key from localStorage
  const cfg = (typeof getActivePropertyConfig === 'function') ? getActivePropertyConfig() : null;
  if (cfg) {
    await savePropertyToCloud(cfg);
    console.log('[StayOps] ✓ Property config migrated (includes Drive + API settings)');
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

  console.log('[StayOps] Migration complete! Run hydrateFromCloud() on other devices.');
}


// ── LOADING SCREEN ────────────────────────────────────────────────────────────

function showLoginScreen() {
  const el = document.getElementById('stayops-login-screen');
  if (el) el.style.display = 'flex';
  const app = document.getElementById('main-content');
  const nav = document.querySelector('.nav');
  const hdr = document.querySelector('.header');
  if (app) app.style.display = 'none';
  if (nav) nav.style.display = 'none';
  if (hdr) hdr.style.display = 'none';
}

function hideLoginScreen() {
  const el = document.getElementById('stayops-login-screen');
  if (el) el.style.display = 'none';
}

function showLoadingScreen(msg) {
  const el = document.getElementById('stayops-loading-screen');
  if (el) el.style.display = 'flex';
  const status = document.getElementById('loading-status');
  if (status) status.textContent = msg || 'Loading…';
  const app = document.getElementById('main-content');
  const nav = document.querySelector('.nav');
  const hdr = document.querySelector('.header');
  if (app) app.style.display = 'none';
  if (nav) nav.style.display = 'none';
  if (hdr) hdr.style.display = 'none';
}

function hideLoadingScreen() {
  const el = document.getElementById('stayops-loading-screen');
  if (el) el.style.display = 'none';
  const app = document.getElementById('main-content');
  const nav = document.querySelector('.nav');
  const hdr = document.querySelector('.header');
  if (app) app.style.display = '';
  if (nav) nav.style.display = '';
  if (hdr) hdr.style.display = '';
}

function setLoadingStatus(msg) {
  const status = document.getElementById('loading-status');
  if (status) status.textContent = msg || '';
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
  setLoadingStatus('Starting app…');
  if (typeof finishAppInit === 'function') await finishAppInit();
  setLoadingStatus('Loading your data…');
  await hydrateFromCloud();
  hideLoadingScreen();
  if (typeof renderAll === 'function') renderAll();
  // Prompt if an owner report is due
  setTimeout(() => { if (typeof checkAutoSendReport === 'function') checkAutoSendReport(); }, 1500);
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
