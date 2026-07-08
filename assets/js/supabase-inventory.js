/**
 * StayOps — inventory: per-property inventory items CRUD (the `inventory` table).
 * Split out of supabase.js 2026-07-09 (by-entity data-layer split). supabase.js
 * re-exports saveInventoryToCloud + deleteInventoryFromCloud and imports
 * loadInventoryFromCloud back for hydrateFromCloud. window._sb is the global
 * client; shared helpers are imported from the barrel at call-time (safe cycle).
 */
import { getCurrentSupabaseUser, getCloudPropertyId, sbWrite, _notifyWriteFailure } from './supabase.js';

// ── INVENTORY ─────────────────────────────────────────────────────────────────

export async function loadInventoryFromCloud() {
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
    if (!user || !item) return { ok: true, noUser: true };
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
      return { ok: true };
    } else {
      const insertPayload = { ...basePayload, property_id: propertyId || null };
      const { data: insData, error: insErr } = await window._sb
        .from('inventory')
        .insert(insertPayload)
        .select()
        .single();
      if (!insErr && insData) {
        item._cloudId = insData.id;
        return { ok: true };
      }
      console.log('[StayOps] GUARD: property_id stripped from inventory update:', String(item.id));
      const { data: upData, error: upErr } = await window._sb
        .from('inventory')
        .upsert(basePayload, { onConflict: 'local_id,user_id' })
        .select()
        .single();
      if (upErr) throw upErr;
      if (upData) item._cloudId = upData.id;
      return { ok: true };
    }
  } catch (e) {
    console.warn('[StayOps] saveInventoryItemToCloud failed', e);
    _notifyWriteFailure('inventory item');
    return { ok: false, error: e };
  }
}

export async function saveInventoryToCloud(inventoryList) {
  if (!Array.isArray(inventoryList)) return { ok: true };
  let ok = true;
  for (const i of inventoryList) {
    const r = await saveInventoryItemToCloud(i);
    if (r && r.ok === false) ok = false;
  }
  return { ok };
}

// Hard-delete an inventory row from the cloud. Without this, removed items
// were only dropped from the in-memory array — saveInventoryToCloud upserts the
// survivors but never deletes the removed row, so it resurrected on next
// hydration (report 1.26 / 3.2).
export async function deleteInventoryFromCloud(item) {
  const user = await getCurrentSupabaseUser();
  if (!user || !item) return { ok: true, noUser: true };
  const builder = item._cloudId
    ? window._sb.from('inventory').delete().eq('id', item._cloudId)
    : window._sb.from('inventory').delete().eq('user_id', user.id).eq('local_id', String(item.id));
  return sbWrite(builder, { label: 'inventory removal' });
}


