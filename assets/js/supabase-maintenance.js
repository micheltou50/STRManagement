/**
 * StayOps — maintenance: per-property maintenance items CRUD (the `maintenance`
 * table). Split out of supabase.js 2026-07-09 (by-entity data-layer split).
 * supabase.js re-exports saveMaintenanceToCloud + deleteMaintenanceFromCloud and
 * imports loadMaintenanceFromCloud back for hydration. window._sb is global;
 * shared helpers imported from the barrel at call-time (safe cycle).
 */
import { getCurrentSupabaseUser, getCloudPropertyId, sbWrite, _notifyWriteFailure } from './supabase.js';

// ── MAINTENANCE ──────────────────────────────────────────────────────────────

export async function loadMaintenanceFromCloud() {
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
    if (!user || !item) return { ok: true, noUser: true };
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
      return { ok: true };
    } else {
      const insertPayload = { ...basePayload, property_id: propertyId || null };
      const { data: insData, error: insErr } = await window._sb
        .from('maintenance')
        .insert(insertPayload)
        .select()
        .single();
      if (!insErr && insData) {
        item._cloudId = insData.id;
        return { ok: true };
      }
      console.log('[StayOps] GUARD: property_id stripped from maintenance update:', String(item.id));
      const { data: upData, error: upErr } = await window._sb
        .from('maintenance')
        .upsert(basePayload, { onConflict: 'local_id,user_id' })
        .select()
        .single();
      if (upErr) throw upErr;
      if (upData) item._cloudId = upData.id;
      return { ok: true };
    }
  } catch (e) {
    console.warn('[StayOps] saveMaintenanceItemToCloud failed', e);
    _notifyWriteFailure('maintenance item');
    return { ok: false, error: e };
  }
}

export async function saveMaintenanceToCloud(maintenanceList) {
  if (!Array.isArray(maintenanceList)) return { ok: true };
  let ok = true;
  for (const m of maintenanceList) {
    const r = await saveMaintenanceItemToCloud(m);
    if (r && r.ok === false) ok = false;
  }
  return { ok };
}

export async function deleteMaintenanceFromCloud(item) {
  const user = await getCurrentSupabaseUser();
  if (!user || !item) return { ok: true, noUser: true };
  const builder = item._cloudId
    ? window._sb.from('maintenance').delete().eq('id', item._cloudId)
    : window._sb.from('maintenance').delete().eq('user_id', user.id).eq('local_id', String(item.id));
  return sbWrite(builder, { label: 'maintenance removal' });
}


