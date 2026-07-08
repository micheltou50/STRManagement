/**
 * StayOps — cleaners: the cleaner roster CRUD (the `cleaners` table, user-scoped).
 * Split out of supabase.js 2026-07-09 (by-entity data-layer split). supabase.js
 * re-exports saveCleanersToCloud and imports loadCleanersFromCloud back for
 * hydration. window._sb is the global client; shared helpers imported from the
 * barrel at call-time (safe cycle).
 */
import { getCurrentSupabaseUser, sbWrite, _notifyWriteFailure } from './supabase.js';

// ── CLEANERS ──────────────────────────────────────────────────────────────────

export async function loadCleanersFromCloud() {
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
    if (!user || !Array.isArray(cleanerList)) return { ok: true, noUser: true };
    let ok = true;
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
        const r = await sbWrite(
          window._sb.from('cleaners').upsert({ id: c._cloudId, ...payload }),
          { label: 'cleaner' });
        if (!r.ok) ok = false;
      } else {
        const r = await sbWrite(
          window._sb.from('cleaners').upsert(payload, { onConflict: 'user_id,local_id' }).select().single(),
          { label: 'cleaner' });
        if (!r.ok) ok = false;
        else if (r.data) c._cloudId = r.data.id;
      }
    }
    return { ok };
  } catch (e) {
    console.warn('[StayOps] saveCleanersToCloud failed', e);
    _notifyWriteFailure('cleaner');
    return { ok: false, error: e };
  }
}


