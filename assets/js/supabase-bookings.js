/**
 * StayOps — bookings: the core bookings CRUD (the `bookings` table). Split out of
 * supabase.js 2026-07-09 (by-entity data-layer split). supabase.js re-exports the
 * public CRUD fns and imports loadBookingsFromCloud + validatePropertyIds back for
 * hydration. window._sb is global; getCurrentSupabaseUser / getCloudPropertyId from
 * the barrel; schedulePricingRerun from supabase-pricing.js (one-way bookings->pricing).
 *
 * NOTE: deleteBookingFromCloud issues a .delete() but a DB trigger soft-cancels
 * (status='cancelled') instead of removing the row — behaviour unchanged (verbatim).
 */
import { getCurrentSupabaseUser, getCloudPropertyId } from './supabase.js';
import { schedulePricingRerun } from './supabase-pricing.js';

// ── BOOKINGS ──────────────────────────────────────────────────────────────────

export async function loadBookingsFromCloud() {
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
      checkinTime:      b.checkin_time  || null,
      checkoutTime:     b.checkout_time || null,
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
      cancelledAt:      b.cancelled_at || null,
      cancellationBillable: b.cancellation_billable == null ? null : !!b.cancellation_billable,
      cleanerConfirmed: b.cleaner_confirmed || false,
      source:           b.source        || 'sheet',
      // iCal stub fields — used by booking-list-card.js to show the
      // "Reserved — awaiting details" pulse badge while enrichment is pending.
      enrichment_status: b.enrichment_status || null,
      ical_uid:          b.ical_uid          || null,
      ical_feed_id:      b.ical_feed_id      || null,
      phone:            b.phone         || '',
      email:            b.email         || '',
      updatedAt:        b.updated_at    || '',
      modificationPendingAt: b.modification_pending_at || null,
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
    checkin_time:       booking.checkinTime  || null,
    checkout_time:      booking.checkoutTime || null,
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
    cancelled_at:       booking.cancelledAt || booking.cancelled_at || null,
    cancellation_billable: booking.cancellationBillable ?? booking.cancellation_billable ?? null,
    cleaner_confirmed:  booking.cleanerConfirmed || false,
    source:             booking.source      || 'sheet',
    phone:              booking.phone       || null,
    email:              booking.email       || null,
    modification_pending_at: booking.modificationPendingAt || null,
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
    } else {
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

  // Trigger debounced smart-pricing rerun for this property.
  const rerunPid = booking.property_id || booking._propertyId || propertyId;
  if (rerunPid) schedulePricingRerun(rerunPid, 'booking_added');
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
    checkin_time:       b.checkinTime  || null,
    checkout_time:      b.checkoutTime || null,
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
    cancelled_at:       b.cancelledAt || b.cancelled_at || null,
    cancellation_billable: b.cancellationBillable ?? b.cancellation_billable ?? null,
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

export async function validatePropertyIds(userId) {
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

    // Trigger debounced smart-pricing rerun — note deleteBooking in this
    // codebase is a soft-delete (status=cancelled), so the freed nights are
    // now vacant and should be repriced.
    const rerunPid = booking.property_id || booking._propertyId || null;
    if (rerunPid) schedulePricingRerun(rerunPid, 'booking_cancelled');

    return result;
  } catch (e) {
    console.error('[StayOps] deleteBookingFromCloud threw', e);
    throw e;
  }
}


