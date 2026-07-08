/**
 * StayOps — notes: per-property notes CRUD (the `notes` table). Split out of
 * supabase.js 2026-07-08 (by-entity data-layer split). supabase.js stays the
 * barrel and re-exports saveNotesToCloud; it imports loadNotesFromCloud back for
 * hydrateFromCloud.
 *
 * window._sb is the global client (no import). getCurrentSupabaseUser /
 * getCloudPropertyId / _notifyWriteFailure are imported from the barrel and used
 * only at call-time (safe cycle — hoisted exports).
 */
import { getCurrentSupabaseUser, getCloudPropertyId, _notifyWriteFailure } from './supabase.js';

// ── NOTES ─────────────────────────────────────────────────────────────────────

export async function loadNotesFromCloud() {
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
    if (!user || !note) return { ok: true, noUser: true };
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
      return { ok: true };
    } else {
      const insertPayload = { ...basePayload, property_id: propertyId || null };
      const { data: insData, error: insErr } = await window._sb
        .from('notes')
        .insert(insertPayload)
        .select()
        .single();
      if (!insErr && insData) {
        note._cloudId = insData.id;
        return { ok: true };
      }
      console.log('[StayOps] GUARD: property_id stripped from notes update:', String(note.id));
      const { data: upData, error: upErr } = await window._sb
        .from('notes')
        .upsert(basePayload, { onConflict: 'local_id,user_id' })
        .select()
        .single();
      if (upErr) throw upErr;
      if (upData) note._cloudId = upData.id;
      return { ok: true };
    }
  } catch (e) {
    console.warn('[StayOps] saveNoteToCloud failed', e);
    _notifyWriteFailure('note');
    return { ok: false, error: e };
  }
}

export async function saveNotesToCloud(notesList) {
  if (!Array.isArray(notesList)) return { ok: true };
  let ok = true;
  for (const n of notesList) {
    const r = await saveNoteToCloud(n);
    if (r && r.ok === false) ok = false;
  }
  return { ok };
}
