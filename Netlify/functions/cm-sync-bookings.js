/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Channel Manager: Sync Bookings
   Pulls bookings from the connected channel manager (beds24 / hostaway),
   deduplicates against existing records via 3-layer matching, and
   upserts into the bookings table.

   Manual mode:    POST { uid }        — sync a single user
   Scheduled mode: POST (no body/uid)  — iterate all connected users

   Required env: SUPABASE_URL, SUPABASE_SERVICE_KEY
   ═══════════════════════════════════════════════════════════════════════════ */

const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return json(500, { error: 'Server misconfigured' });
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    body = {};
  }

  const manualUid = body.uid || null;

  try {
    // ── Determine which users to sync ────────────────────────────────────
    let users = [];

    if (manualUid) {
      // Single-user manual mode
      const { data, error } = await sb
        .from('app_config')
        .select('user_id, channel_manager_provider, channel_manager_api_key, channel_manager_refresh_token')
        .eq('user_id', manualUid)
        .eq('channel_manager_connected', true)
        .single();

      if (error || !data) {
        return json(400, { error: 'Channel manager not connected' });
      }
      users = [data];
    } else {
      // Scheduled mode — all connected users
      console.log('[StayOps] cm-sync-bookings: scheduled mode — fetching all connected users');
      const { data, error } = await sb
        .from('app_config')
        .select('user_id, channel_manager_provider, channel_manager_api_key, channel_manager_refresh_token')
        .eq('channel_manager_connected', true);

      if (error) {
        console.error('[StayOps] cm-sync-bookings: failed to load connected users', error);
        return json(500, { error: 'Failed to load connected users' });
      }
      users = data || [];
    }

    if (!users.length) {
      console.log('[StayOps] cm-sync-bookings: no connected users to sync');
      return json(200, { message: 'No connected users', results: [] });
    }

    // ── Process each user ────────────────────────────────────────────────
    const results = [];
    for (const user of users) {
      const result = await syncUserBookings(sb, user);
      results.push({ uid: user.user_id, ...result });
    }

    console.log('[StayOps] cm-sync-bookings: completed for', results.length, 'user(s)');
    return json(200, manualUid ? results[0] : { results });

  } catch (err) {
    console.error('[StayOps] cm-sync-bookings: unexpected error', err.message);
    return json(500, { error: err.message || 'Sync failed' });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// Per-user sync logic
// ═════════════════════════════════════════════════════════════════════════════

async function syncUserBookings(sb, user) {
  const { user_id, channel_manager_provider: provider, channel_manager_api_key: apiKey, channel_manager_refresh_token: refreshToken } = user;

  console.log('[StayOps] cm-sync-bookings: syncing uid:', user_id, 'provider:', provider);

  try {
    // ── 1. Load property mappings ──────────────────────────────────────
    const { data: mappings, error: mapErr } = await sb
      .from('channel_property_map')
      .select('*')
      .eq('user_id', user_id);

    if (mapErr || !mappings || !mappings.length) {
      console.log('[StayOps] cm-sync-bookings: no property mappings for uid:', user_id);
      return { skipped: true, reason: 'no property mappings' };
    }

    // ── 2. Get access token ────────────────────────────────────────────
    let accessToken = apiKey;
    if (provider === 'beds24') {
      const tokenRes = await fetch('https://beds24.com/api/v2/authentication/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: refreshToken }),
      });
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || !tokenData.token) {
        console.error('[StayOps] cm-sync-bookings: beds24 token refresh failed for uid:', user_id);
        await setSyncError(sb, user_id, 'Beds24 token expired');
        return { error: 'Beds24 token expired' };
      }
      accessToken = tokenData.token;
    }

    // ── 3. Fetch bookings from provider ────────────────────────────────
    const cmPropertyIds = mappings.map(m => m.cm_property_id);
    let rawBookings = [];

    if (provider === 'beds24') {
      rawBookings = await fetchBeds24Bookings(accessToken, cmPropertyIds);
    } else if (provider === 'hostaway') {
      rawBookings = await fetchHostawayBookings(accessToken, cmPropertyIds);
    }

    console.log('[StayOps] cm-sync-bookings: fetched', rawBookings.length, 'raw bookings from', provider);

    // ── 4. Normalize bookings ──────────────────────────────────────────
    // Build a lookup: cm_property_id -> local property_id
    const cmToLocal = {};
    for (const m of mappings) {
      cmToLocal[String(m.cm_property_id)] = m.property_id;
    }

    const normalized = rawBookings
      .map(b => provider === 'beds24' ? normalizeBeds24Booking(b) : normalizeHostawayBooking(b))
      .filter(b => b && cmToLocal[b.cm_property_id]);

    // Attach local property_id
    for (const b of normalized) {
      b.property_id = cmToLocal[b.cm_property_id];
    }

    // ── 5. Dedup + upsert ──────────────────────────────────────────────
    let found = normalized.length;
    let imported = 0;
    let updated = 0;
    let cancelled = 0;
    let skipped = 0;

    for (const booking of normalized) {
      const result = await dedupAndUpsert(sb, user_id, booking);
      if (result === 'inserted') imported++;
      else if (result === 'updated') updated++;
      else if (result === 'cancelled') cancelled++;
      else skipped++;
    }

    // ── 6. Update last-sync timestamp ──────────────────────────────────
    await sb
      .from('app_config')
      .update({
        channel_manager_last_sync: new Date().toISOString(),
        channel_manager_sync_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', user_id);

    console.log('[StayOps] cm-sync-bookings: uid:', user_id, '— found:', found, 'imported:', imported, 'updated:', updated, 'cancelled:', cancelled, 'skipped:', skipped);
    return { found, imported, updated, cancelled, skipped };

  } catch (err) {
    console.error('[StayOps] cm-sync-bookings: error for uid:', user_id, err.message);
    await setSyncError(sb, user_id, err.message);
    return { error: err.message };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Provider-specific fetch
// ═════════════════════════════════════════════════════════════════════════════

async function fetchBeds24Bookings(accessToken, propertyIds) {
  const now = new Date();
  const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const to = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

  const fromStr = dateStr(from);
  const toStr = dateStr(to);

  // Beds24 may need per-property fetch or support comma-separated IDs
  const allBookings = [];
  for (const propId of propertyIds) {
    try {
      const url = 'https://beds24.com/api/v2/bookings?' +
        'propertyId=' + encodeURIComponent(propId) +
        '&arrivalFrom=' + fromStr +
        '&arrivalTo=' + toStr;

      const res = await fetch(url, {
        headers: { Authorization: 'Bearer ' + accessToken },
      });
      if (res.ok) {
        const data = await res.json();
        const list = Array.isArray(data) ? data : (data.data || data.bookings || []);
        allBookings.push(...list);
      } else {
        console.error('[StayOps] cm-sync-bookings: beds24 bookings fetch failed for prop:', propId, res.status);
      }
    } catch (err) {
      console.error('[StayOps] cm-sync-bookings: beds24 fetch error for prop:', propId, err.message);
    }
  }
  return allBookings;
}

async function fetchHostawayBookings(accessToken, listingIds) {
  const allBookings = [];
  for (const listingId of listingIds) {
    try {
      const url = 'https://api.hostaway.com/v1/reservations?listingId=' + encodeURIComponent(listingId);
      const res = await fetch(url, {
        headers: { Authorization: 'Bearer ' + accessToken },
      });
      if (res.ok) {
        const data = await res.json();
        const list = Array.isArray(data) ? data : (data.result || data.data || []);
        allBookings.push(...list);
      } else {
        console.error('[StayOps] cm-sync-bookings: hostaway reservations fetch failed for listing:', listingId, res.status);
      }
    } catch (err) {
      console.error('[StayOps] cm-sync-bookings: hostaway fetch error for listing:', listingId, err.message);
    }
  }
  return allBookings;
}

// ═════════════════════════════════════════════════════════════════════════════
// Booking normalization
// ═════════════════════════════════════════════════════════════════════════════

function normalizeBeds24Booking(b) {
  if (!b) return null;
  // beds24 status: 1 = confirmed, 3 = cancelled
  const statusMap = { 1: 'confirmed', 3: 'cancelled' };
  const status = statusMap[b.status] || 'confirmed';

  // beds24 uses "lastNight" — checkout is lastNight + 1 day
  let checkout = b.lastNight;
  if (checkout) {
    const d = new Date(checkout + 'T12:00:00Z');
    d.setDate(d.getDate() + 1);
    checkout = dateStr(d);
  }

  const guestFirst = (b.guestFirstName || '').trim();
  const guestLast = (b.guestName || b.guestLastName || '').trim();
  const guestName = [guestFirst, guestLast].filter(Boolean).join(' ') || 'Guest';

  return {
    cm_booking_id: String(b.id || b.bookingId || ''),
    cm_property_id: String(b.propId || b.propertyId || ''),
    confirmation_code: b.apiReference || b.channelBookingId || '',
    checkin: b.firstNight || '',
    checkout: checkout || '',
    guest_name: guestName,
    host_payout: parseFloat(b.price) || 0,
    guests: (parseInt(b.numAdult) || 0) + (parseInt(b.numChild) || 0),
    platform: mapPlatformName(b.referer || b.referrer || ''),
    status: status,
  };
}

function normalizeHostawayBooking(b) {
  if (!b) return null;
  const status = (b.status || '').toLowerCase() === 'cancelled' ? 'cancelled' : 'confirmed';

  return {
    cm_booking_id: String(b.id || b.reservationId || ''),
    cm_property_id: String(b.listingMapId || b.listingId || ''),
    confirmation_code: b.confirmationCode || b.hostConfirmationCode || '',
    checkin: b.arrivalDate || '',
    checkout: b.departureDate || '',
    guest_name: (b.guestName || 'Guest').trim(),
    host_payout: parseFloat(b.totalPrice) || 0,
    guests: parseInt(b.numberOfGuests) || 1,
    platform: mapPlatformName(b.channelName || ''),
    status: status,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 3-Layer dedup + upsert
// ═════════════════════════════════════════════════════════════════════════════

async function dedupAndUpsert(sb, userId, booking) {
  const { cm_booking_id, confirmation_code, guest_name, checkin, property_id } = booking;

  // ── Layer 1: Exact match by cm_booking_id ────────────────────────────
  if (cm_booking_id) {
    const { data: match1 } = await sb
      .from('bookings')
      .select('id, status')
      .eq('user_id', userId)
      .eq('cm_booking_id', cm_booking_id)
      .limit(1)
      .maybeSingle();

    if (match1) {
      return await updateExisting(sb, match1, booking);
    }
  }

  // ── Layer 2: Cross-source match by confirmation_code + property_id ───
  if (confirmation_code && property_id) {
    const { data: match2 } = await sb
      .from('bookings')
      .select('id, status')
      .eq('user_id', userId)
      .eq('confirmation_code', confirmation_code)
      .eq('property_id', property_id)
      .limit(1)
      .maybeSingle();

    if (match2) {
      return await updateExisting(sb, match2, booking);
    }
  }

  // ── Layer 3: Fuzzy match by guest_name + checkin + property_id ───────
  if (guest_name && checkin && property_id) {
    const { data: match3 } = await sb
      .from('bookings')
      .select('id, status')
      .eq('user_id', userId)
      .ilike('guest_name', guest_name)
      .eq('checkin', checkin)
      .eq('property_id', property_id)
      .limit(1)
      .maybeSingle();

    if (match3) {
      return await updateExisting(sb, match3, booking);
    }
  }

  // ── No match — INSERT new booking ────────────────────────────────────
  const { error: insErr } = await sb
    .from('bookings')
    .insert({
      user_id: userId,
      property_id: property_id,
      guest_name: booking.guest_name,
      checkin: booking.checkin,
      checkout: booking.checkout,
      host_payout: booking.host_payout,
      guests: booking.guests,
      platform: booking.platform,
      status: booking.status,
      confirmation_code: booking.confirmation_code || null,
      cm_booking_id: booking.cm_booking_id || null,
      cm_synced_at: new Date().toISOString(),
      source: 'channel_manager',
    });

  if (insErr) {
    console.error('[StayOps] cm-sync-bookings: insert failed', insErr.message);
    return 'skipped';
  }
  return 'inserted';
}

async function updateExisting(sb, existing, booking) {
  const updates = {
    guest_name: booking.guest_name,
    checkin: booking.checkin,
    checkout: booking.checkout,
    host_payout: booking.host_payout,
    guests: booking.guests,
    platform: booking.platform,
    confirmation_code: booking.confirmation_code || undefined,
    cm_booking_id: booking.cm_booking_id || undefined,
    cm_synced_at: new Date().toISOString(),
  };

  // Remove undefined values
  Object.keys(updates).forEach(k => updates[k] === undefined && delete updates[k]);

  // Handle cancellations
  if (booking.status === 'cancelled' && existing.status !== 'cancelled') {
    updates.status = 'cancelled';
    const { error } = await sb.from('bookings').update(updates).eq('id', existing.id);
    if (error) console.error('[StayOps] cm-sync-bookings: cancel update failed', error.message);
    return 'cancelled';
  }

  // Regular update (backfill cm_booking_id, cm_synced_at, etc.)
  const { error } = await sb.from('bookings').update(updates).eq('id', existing.id);
  if (error) console.error('[StayOps] cm-sync-bookings: update failed', error.message);
  return 'updated';
}

// ═════════════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════════════

function mapPlatformName(raw) {
  const lower = (raw || '').toLowerCase();
  if (lower.includes('airbnb')) return 'Airbnb';
  if (lower.includes('booking.com') || lower.includes('bookingcom')) return 'Booking.com';
  if (lower.includes('vrbo') || lower.includes('homeaway')) return 'VRBO';
  if (lower.includes('expedia')) return 'Expedia';
  if (lower.includes('direct') || lower.includes('website')) return 'Direct';
  if (lower.includes('agoda')) return 'Agoda';
  if (lower.includes('tripadvisor') || lower.includes('trip advisor')) return 'TripAdvisor';
  return raw || 'Other';
}

function dateStr(d) {
  return d.toISOString().split('T')[0];
}

async function setSyncError(sb, userId, message) {
  try {
    await sb
      .from('app_config')
      .update({
        channel_manager_sync_error: message,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId);
  } catch (e) {
    console.error('[StayOps] cm-sync-bookings: failed to set sync error', e.message);
  }
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
