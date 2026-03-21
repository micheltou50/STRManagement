/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Supabase Integration Layer
   Handles: Auth, host config cloud sync, cleaners cloud sync, cleaning jobs
   ═══════════════════════════════════════════════════════════════════════════ */

const SUPABASE_URL     = 'https://nbeuyypgiipptxlqnhel.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5iZXV5eXBnaWlwcHR4bHFuaGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMDg0MDEsImV4cCI6MjA4OTU4NDQwMX0.TfsTKhDDMiOptoMCRXD149KC4pYGvuFM2px9_auwDG0';

// ── INIT ──────────────────────────────────────────────────────────────────────
// Supabase JS SDK is loaded via CDN before this file runs.
// window._sb is the shared client — use it everywhere.
(function initSupabase() {
  if (!window.supabase) {
    console.error('[StayOps] Supabase SDK not loaded — check CDN script tag in index.html');
    return;
  }
  window._sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  console.log('[StayOps] Supabase client ready');
})();


// ── AUTH ──────────────────────────────────────────────────────────────────────

/**
 * Sign in with email + password.
 * Returns { data, error }
 */
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

/**
 * Create a new host account.
 * Returns { data, error }
 */
async function supabaseSignUp(email, password) {
  if (!window._sb) return { data: null, error: 'Supabase not ready' };
  try {
    const { data, error } = await window._sb.auth.signUp({ email, password });
    return { data, error };
  } catch (e) {
    return { data: null, error: e.message };
  }
}

/**
 * Sign the current user out and clear local cache.
 */
async function supabaseSignOut() {
  if (!window._sb) return;
  await window._sb.auth.signOut();
  window._supabaseUser = null;
}

/**
 * Returns the active session, or null if not logged in.
 */
async function getSupabaseSession() {
  if (!window._sb) return null;
  try {
    const { data } = await window._sb.auth.getSession();
    return (data && data.session) ? data.session : null;
  } catch (e) {
    return null;
  }
}

/**
 * Returns the current user object (cached after first call).
 */
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


// ── HOST CONFIG ───────────────────────────────────────────────────────────────

/**
 * Load this host's config row from Supabase.
 * Returns the row object, or null if not found / not logged in.
 */
async function loadHostConfigFromCloud() {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user) return null;
    const { data, error } = await window._sb
      .from('host_config')
      .select('*')
      .eq('user_id', user.id)
      .single();
    if (error || !data) return null;
    return data;
  } catch (e) {
    console.warn('[StayOps] loadHostConfigFromCloud failed', e);
    return null;
  }
}

/**
 * Save / upsert the active property config to Supabase.
 * Safe to call on every savePropertyConfig — it's non-blocking.
 * @param {object} configData  The full property config object.
 */
async function saveHostConfigToCloud(configData) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !configData) return;
    const payload = {
      user_id:       user.id,
      property_name: configData.name || '',
      beds:          (configData.property && configData.property.bedrooms)  || 0,
      baths:         (configData.property && configData.property.bathrooms) || 0,
      max_guests:    (configData.property && configData.property.maxGuests) || 0,
      timezone:      'Australia/Sydney',
      sheets_url:    (configData.integrations && configData.integrations.sheetCsvUrl) || '',
      updated_at:    new Date().toISOString()
    };
    const { error } = await window._sb
      .from('host_config')
      .upsert(payload, { onConflict: 'user_id' });
    if (error) console.warn('[StayOps] saveHostConfigToCloud upsert error', error);
  } catch (e) {
    console.warn('[StayOps] saveHostConfigToCloud failed', e);
  }
}


// ── CLEANERS ──────────────────────────────────────────────────────────────────

/**
 * Load all cleaners for this host from Supabase.
 * Returns array of cleaner objects (app-shaped), or null on failure.
 */
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
    // Map Supabase column names → app field names
    return data.map(c => ({
      id:       c.local_id || c.id,   // prefer local numeric id if stored
      _cloudId: c.id,                 // UUID for future updates
      name:     c.name,
      email:    c.email  || '',
      phone:    c.phone  || '',
      role:     c.role   || 'Cleaner',
      pin:      c.pin    || '',
      active:   c.active !== false
    }));
  } catch (e) {
    console.warn('[StayOps] loadCleanersFromCloud failed', e);
    return null;
  }
}

/**
 * Sync the full cleaners list to Supabase.
 * Upserts each cleaner. Backfills _cloudId on new entries.
 * @param {Array} cleanerList  The local cleaners array.
 */
async function saveCleanersToCloud(cleanerList) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !Array.isArray(cleanerList)) return;

    for (const c of cleanerList) {
      if (!c || !c.name) continue;
      const payload = {
        user_id:   user.id,
        local_id:  c.id,          // keep the local numeric id so we can reconcile
        name:      c.name,
        email:     c.email  || '',
        phone:     c.phone  || '',
        role:      c.role   || 'Cleaner',
        pin:       c.pin    || '',
        active:    c.active !== false
      };
      if (c._cloudId) {
        // Already synced before — update the existing row
        await window._sb.from('cleaners').upsert({ id: c._cloudId, ...payload });
      } else {
        // New cleaner — insert and store the returned cloud UUID
        const { data } = await window._sb
          .from('cleaners')
          .insert(payload)
          .select()
          .single();
        if (data) c._cloudId = data.id;
      }
    }
  } catch (e) {
    console.warn('[StayOps] saveCleanersToCloud failed', e);
  }
}


// ── CLEANING JOBS ─────────────────────────────────────────────────────────────

/**
 * Load all cleaning jobs for this host from Supabase.
 * Returns array, or null on failure.
 */
async function loadCleaningJobsFromCloud() {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user) return null;
    const { data, error } = await window._sb
      .from('cleaning_jobs')
      .select('*')
      .eq('user_id', user.id)
      .order('clean_date', { ascending: true });
    if (error || !data) return null;
    return data;
  } catch (e) {
    console.warn('[StayOps] loadCleaningJobsFromCloud failed', e);
    return null;
  }
}

/**
 * Save / upsert a single cleaning job to Supabase.
 * Backfills job._cloudId if this is a new record.
 * @param {object} job  A clean object from the local cleans array.
 */
async function saveCleaningJobToCloud(job) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !job) return;
    const status = job.done
      ? 'done'
      : job.cleanerConfirmed
        ? 'confirmed'
        : job.cleanerDeclined
          ? 'declined'
          : 'pending';

    const payload = {
      user_id:      user.id,
      booking_ref:  String(job.bookingId || job.guestName || ''),
      cleaner_id:   job._cleanerCloudId || null,
      clean_date:   job.date ? String(job.date).slice(0, 10) : null,
      status,
      notes:        job.notes || '',
      assigned_at:  job.assignedAt  || null,
      confirmed_at: job.confirmedAt || null,
      completed_at: job.done ? (job.completedAt || new Date().toISOString()) : null,
      updated_at:   new Date().toISOString()
    };

    if (job._cloudId) {
      await window._sb.from('cleaning_jobs').upsert({ id: job._cloudId, ...payload });
    } else {
      const { data } = await window._sb
        .from('cleaning_jobs')
        .insert(payload)
        .select()
        .single();
      if (data) job._cloudId = data.id;
    }
  } catch (e) {
    console.warn('[StayOps] saveCleaningJobToCloud failed', e);
  }
}

/**
 * Sync all cleaning jobs to Supabase.
 * Non-blocking — call fire-and-forget after a local save.
 */
async function syncAllCleaningJobsToCloud(cleansList) {
  if (!Array.isArray(cleansList)) return;
  for (const job of cleansList) {
    await saveCleaningJobToCloud(job);
  }
}


// ── LOGIN UI ──────────────────────────────────────────────────────────────────

/**
 * Show the host login screen.
 * Called from DOMContentLoaded when no active session is found.
 */
function showLoginScreen() {
  const el = document.getElementById('stayops-login-screen');
  if (el) el.style.display = 'flex';
  // Hide the main app shell so nothing leaks through
  const app = document.getElementById('main-content');
  const nav = document.querySelector('.nav');
  const hdr = document.querySelector('.header');
  if (app) app.style.display = 'none';
  if (nav) nav.style.display = 'none';
  if (hdr) hdr.style.display = 'none';
}

/**
 * Hide the login screen and show the app.
 */
function hideLoginScreen() {
  const el = document.getElementById('stayops-login-screen');
  if (el) el.style.display = 'none';
  const app = document.getElementById('main-content');
  const nav = document.querySelector('.nav');
  const hdr = document.querySelector('.header');
  if (app) app.style.display = '';
  if (nav) nav.style.display = '';
  if (hdr) hdr.style.display = '';
}

/**
 * Handle the login form submit.
 */
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

  // Signed in — hydrate app from cloud then show it
  hideLoginScreen();
  if (typeof hydrateFromCloud === 'function') await hydrateFromCloud();
  if (typeof finishAppInit === 'function') await finishAppInit();
}

/**
 * Handle the sign up form toggle.
 */
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

/**
 * Handle the create account form submit.
 */
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

  // Supabase sends a confirmation email by default — show a message
  if (errEl) {
    errEl.style.color = 'var(--moss, #4A7C59)';
    errEl.textContent = '✓ Account created! Check your email to confirm, then sign in.';
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Create Account'; }
}

/**
 * Host logout — called from a settings button we'll add later.
 */
async function hostSignOut() {
  await supabaseSignOut();
  showLoginScreen();
}
