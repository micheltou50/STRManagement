/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Cleaner Data Feed
   Returns cleaner's assigned cleans, related bookings, and inventory.
   Called by cleaner PWA on boot (home screen has no Supabase auth session).

   Query params:
     uid       — host's Supabase user ID (from cleaner link)
     cleanerId — cleaner's local_id (from cleaner link)

   Required Netlify env vars:
     SUPABASE_URL
     SUPABASE_SERVICE_KEY
   ═══════════════════════════════════════════════════════════════════════════ */

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const uid = params.uid;
  const cleanerId = params.cleanerId;

  if (!uid || !cleanerId) {
    return json(400, { error: 'Missing uid or cleanerId' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[cleaner-data] Missing env vars');
    return json(500, { error: 'Server misconfigured' });
  }

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
  };

  try {
    // 1. Get cleaner record to verify it exists and belongs to this user
    const cleanerRes = await fetch(
      SUPABASE_URL + '/rest/v1/cleaners?user_id=eq.' + enc(uid) +
        '&local_id=eq.' + enc(cleanerId) +
        '&active=eq.true&select=*&limit=1',
      { headers }
    );
    const cleaners = await cleanerRes.json();
    if (!Array.isArray(cleaners) || !cleaners.length) {
      return json(404, { error: 'Cleaner not found' });
    }
    const cleaner = cleaners[0];

    // 2. Get property
    const propRes = await fetch(
      SUPABASE_URL + '/rest/v1/properties?user_id=eq.' + enc(uid) +
        '&select=id,name,suburb,state&order=updated_at.desc&limit=1',
      { headers }
    );
    const properties = await propRes.json();
    const property = (properties && properties[0]) || { name: 'Property' };

    // 3. Get cleans assigned to this cleaner (recent + future)
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const cleanerName = cleaner.name || '';
    // Match by cleaner_id OR cleaner name
    const cleansRes = await fetch(
      SUPABASE_URL + '/rest/v1/cleans?user_id=eq.' + enc(uid) +
        '&clean_date=gte.' + enc(twoDaysAgo) +
        '&done=eq.false' +
        '&or=(cleaner_id.eq.' + enc(cleanerId) + ',cleaner.eq.' + enc(cleanerName) + ')' +
        '&select=*&order=clean_date.asc',
      { headers }
    );
    const cleans = await cleansRes.json();

    // 4. Get bookings related to those cleans
    const bookingIds = (Array.isArray(cleans) ? cleans : [])
      .map(c => c.booking_id).filter(Boolean);
    let relatedBookings = [];
    if (bookingIds.length) {
      const uniqueIds = [...new Set(bookingIds)];
      const bookingsRes = await fetch(
        SUPABASE_URL + '/rest/v1/bookings?user_id=eq.' + enc(uid) +
          '&local_id=in.(' + uniqueIds.map(enc).join(',') + ')' +
          '&select=local_id,checkin,checkout,guest_name,guests,host_payout,cleaning_fee,status',
        { headers }
      );
      relatedBookings = await bookingsRes.json();
    }

    // 5. Get inventory
    const invRes = await fetch(
      SUPABASE_URL + '/rest/v1/inventory?user_id=eq.' + enc(uid) +
        '&select=*&order=name.asc',
      { headers }
    );
    const inventory = await invRes.json();

    // 6. Build response
    const permissions = typeof cleaner.permissions === 'string'
      ? JSON.parse(cleaner.permissions || '{}')
      : (cleaner.permissions || {});

    return json(200, {
      cleaner: {
        id: cleaner.local_id,
        _cloudId: cleaner.id,
        name: cleaner.name,
        email: cleaner.email || '',
        phone: cleaner.phone || '',
        role: cleaner.role || 'Cleaner',
        pin: cleaner.pin || '',
        permissions: permissions,
      },
      cleans: (Array.isArray(cleans) ? cleans : []).map(c => ({
        id: c.local_id ? Number(c.local_id) || c.local_id : c.id,
        _cloudId: c.id,
        bookingId: c.booking_id || '',
        guestName: c.guest_name || '',
        cleaner: c.cleaner || '',
        cleanerId: c.cleaner_id || '',
        date: c.clean_date || '',
        done: c.done || false,
        cleanerConfirmed: c.cleaner_confirmed || false,
        cleanerDeclined: c.cleaner_declined || false,
        notified: c.notified || false,
        notes: c.notes || '',
      })),
      bookings: (Array.isArray(relatedBookings) ? relatedBookings : []).map(b => ({
        id: b.local_id ? (isNaN(Number(b.local_id)) ? b.local_id : Number(b.local_id)) : b.id,
        checkin: b.checkin || '',
        checkout: b.checkout || '',
        name: b.guest_name || '',
        guests: b.guests || 1,
        hostPayout: b.host_payout || 0,
        cleaningFee: b.cleaning_fee || 0,
        status: b.status || 'confirmed',
      })),
      inventory: Array.isArray(inventory) ? inventory.map(i => ({
        id: i.id,
        name: i.name || '',
        qty: i.qty || 0,
        minQty: i.min_qty || 0,
        category: i.category || '',
      })) : [],
      property: {
        name: property.name || 'Property',
        suburb: property.suburb || '',
        state: property.state || '',
      },
    });

  } catch (err) {
    console.error('[cleaner-data] Error:', err);
    return json(500, { error: 'Internal error' });
  }
};

function enc(s) { return encodeURIComponent(s); }
function json(status, body) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
