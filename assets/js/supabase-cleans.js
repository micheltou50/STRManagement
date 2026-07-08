/**
 * StayOps — cleans: cleaning jobs CRUD (the `cleans` table) plus the
 * saveCleaningJobToCloud / loadCleaningJobsFromCloud back-compat aliases. Split
 * out of supabase.js 2026-07-09 (by-entity data-layer split). supabase.js
 * re-exports the public CRUD fns and imports loadCleansFromCloud back for
 * hydration. window._sb is global; shared helpers imported from the barrel.
 */
import { getCurrentSupabaseUser, getCloudPropertyId, sbWrite, _notifyWriteFailure } from './supabase.js';

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
      notes:            c.notes        || '',
      cost:             c.cost != null ? Number(c.cost) : null,
      cleanerCancelNotified: c.cleaner_cancel_notified || false,
      cleanerCancelAcknowledged: c.cleaner_cancel_acknowledged || false,
      cleanerCancelAcknowledgedAt: c.cleaner_cancel_acknowledged_at || null,
    }));
  } catch (e) {
    console.warn('[StayOps] loadCleansFromCloud failed', e);
    return null;
  }
}

export async function saveCleanToCloud(clean) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !clean) return { ok: true, noUser: true };
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
      cost:             clean.cost != null ? Number(clean.cost) : null,
      cleaner_cancel_notified: clean.cleanerCancelNotified || false,
      cleaner_cancel_acknowledged: clean.cleanerCancelAcknowledged || false,
      cleaner_cancel_acknowledged_at: clean.cleanerCancelAcknowledgedAt || null,
      updated_at:       new Date().toISOString()
    };
    if (clean._cloudId) {
      // Guard: never update property_id on existing records.
      console.log('[StayOps] GUARD: property_id stripped from cleans update:', clean._cloudId);
      const { error } = await window._sb.from('cleans').update(basePayload).eq('id', clean._cloudId);
      if (error) throw error;
      return { ok: true };
    } else {
      const insertPayload = { ...basePayload, property_id: propertyId || null };
      const { data: insData, error: insErr } = await window._sb
        .from('cleans')
        .insert(insertPayload)
        .select()
        .single();
      if (!insErr && insData) {
        clean._cloudId = insData.id;
        return { ok: true };
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
      return { ok: true };
    }
  } catch (e) {
    console.warn('[StayOps] saveCleanToCloud failed', e);
    _notifyWriteFailure('clean');
    return { ok: false, error: e };
  }
}

export async function saveCleansToCloud(cleansList) {
  if (!Array.isArray(cleansList)) return { ok: true };
  let ok = true;
  for (const c of cleansList) {
    const r = await saveCleanToCloud(c);
    if (r && r.ok === false) ok = false;
  }
  return { ok };
}

// Hard-delete a clean row from the cloud. Wrapped by calendar-sync-outbound so
// the clean's calendar event is also deleted (enqueues a 'cleans' delete push).
// Resolving the row by _cloudId, falling back to (user_id, local_id).
export async function deleteCleanFromCloud(clean) {
  const user = await getCurrentSupabaseUser();
  if (!user || !clean || !window._sb) return { ok: true, noUser: true };
  const builder = clean._cloudId
    ? window._sb.from('cleans').delete().eq('id', clean._cloudId)
    : window._sb.from('cleans').delete().eq('user_id', user.id).eq('local_id', String(clean.id));
  return sbWrite(builder, { label: 'clean removal' });
}

// Keep old name working for backward compat
export async function saveCleaningJobToCloud(job) { return saveCleanToCloud(job); }
// eslint-disable-next-line no-unused-vars
async function loadCleaningJobsFromCloud() { return loadCleansFromCloud(); }




