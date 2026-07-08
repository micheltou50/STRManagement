/**
 * StayOps — app config: the per-user app_config row (settings, push subs, email
 * templates, invoices ledger). Split out of supabase.js 2026-07-09 (by-entity
 * data-layer split). supabase.js re-exports saveAppConfigToCloud and imports
 * loadAppConfigFromCloud back for hydration. window._sb is global; shared helpers
 * imported from the barrel at call-time (safe cycle).
 */
import { getCurrentSupabaseUser, sbWrite } from './supabase.js';

// ── APP CONFIG ────────────────────────────────────────────────────────────────

export async function loadAppConfigFromCloud() {
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
  const user = await getCurrentSupabaseUser();
  if (!user) return { ok: true, noUser: true };
  const payload = {
    user_id:    user.id,
    updated_at: new Date().toISOString(),
    ...patch,
  };
  return sbWrite(
    window._sb.from('app_config').upsert(payload, { onConflict: 'user_id' }),
    { label: 'settings' });
}


