/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Channel Manager: Push Availability
   Pushes a block/unblock update to the connected channel manager
   for a specific property and date range.

   POST body: { uid, propertyId, checkin, checkout, action }
              action = 'block' | 'unblock'
   ═══════════════════════════════════════════════════════════════════════════ */

const { createClient } = require('@supabase/supabase-js');
const { captureError, flush } = require('./utils/sentry');

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

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    console.error('[StayOps] cm-push-availability: invalid JSON body', e.message);
    return json(400, { error: 'Invalid JSON' });
  }

  const { uid, propertyId, checkin, checkout, action } = body;

  if (!uid || !propertyId || !checkin || !checkout || !action) {
    return json(400, { error: 'Missing required fields: uid, propertyId, checkin, checkout, action' });
  }
  if (!['block', 'unblock'].includes(action)) {
    return json(400, { error: 'Invalid action — must be block or unblock' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return json(500, { error: 'Server misconfigured' });
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

  try {
    // ── 1. Load CM credentials ─────────────────────────────────────────
    const { data: cfg, error: cfgErr } = await sb
      .from('app_config')
      .select('channel_manager_provider, channel_manager_api_key, channel_manager_refresh_token, channel_manager_connected')
      .eq('user_id', uid)
      .single();

    if (cfgErr || !cfg || !cfg.channel_manager_connected) {
      console.log('[StayOps] cm-push-availability: CM not connected, skipping for uid:', uid);
      return json(200, { skipped: true, reason: 'channel manager not connected' });
    }

    const provider = cfg.channel_manager_provider;
    const apiKey = cfg.channel_manager_api_key;
    const refreshToken = cfg.channel_manager_refresh_token;

    // ── 2. Load property mapping ───────────────────────────────────────
    const { data: mapping, error: mapErr } = await sb
      .from('channel_property_map')
      .select('cm_property_id, cm_room_id, push_availability')
      .eq('user_id', uid)
      .eq('property_id', propertyId)
      .maybeSingle();

    if (mapErr || !mapping) {
      console.log('[StayOps] cm-push-availability: no mapping for property:', propertyId);
      return json(200, { skipped: true, reason: 'no property mapping found' });
    }
    if (mapping.push_availability === false) {
      console.log('[StayOps] cm-push-availability: push_availability disabled for property:', propertyId);
      return json(200, { skipped: true, reason: 'push_availability disabled for this property' });
    }

    // ── 3. Push to provider ────────────────────────────────────────────
    if (provider === 'beds24') {
      // Refresh access token
      const tokenRes = await fetch('https://beds24.com/api/v2/authentication/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: refreshToken }),
      });
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || !tokenData.token) {
        console.error('[StayOps] cm-push-availability: beds24 token refresh failed');
        return json(502, { error: 'Beds24 token expired' });
      }
      const accessToken = tokenData.token;

      // Beds24 uses "last night" convention — subtract 1 day from checkout
      const endDate = subtractDay(checkout);
      const roomId = mapping.cm_room_id || mapping.cm_property_id;
      const numAvail = action === 'block' ? 0 : 1;

      console.log('[StayOps] cm-push-availability: beds24 push room:', roomId, 'from:', checkin, 'to:', endDate, 'avail:', numAvail);

      const pushRes = await fetch('https://beds24.com/api/v2/inventory/rooms/calendar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + accessToken,
        },
        body: JSON.stringify([{
          roomId: roomId,
          dateFrom: checkin,
          dateTo: endDate,
          numAvail: numAvail,
        }]),
      });

      if (!pushRes.ok) {
        const errBody = await pushRes.text();
        console.error('[StayOps] cm-push-availability: beds24 push failed', pushRes.status, errBody);
        return json(502, { error: 'Beds24 availability push failed' });
      }

    } else if (provider === 'hostaway') {
      const listingId = mapping.cm_property_id;

      console.log('[StayOps] cm-push-availability: hostaway push listing:', listingId, 'from:', checkin, 'to:', checkout, 'action:', action);

      const status = action === 'block' ? 'blocked' : 'available';
      const pushRes = await fetch('https://api.hostaway.com/v1/listings/' + encodeURIComponent(listingId) + '/calendar', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey,
        },
        body: JSON.stringify({
          dateFrom: checkin,
          dateTo: checkout,
          status: status,
        }),
      });

      if (!pushRes.ok) {
        const errBody = await pushRes.text();
        console.error('[StayOps] cm-push-availability: hostaway push failed', pushRes.status, errBody);
        return json(502, { error: 'Hostaway availability push failed' });
      }

    } else {
      return json(400, { error: 'Unknown provider: ' + provider });
    }

    console.log('[StayOps] cm-push-availability: pushed successfully');
    return json(200, { pushed: true, provider, action, propertyId, checkin, checkout });

  } catch (err) {
    console.error('[StayOps] cm-push-availability: unexpected error', err.message);
    captureError(err, { tags: { function: 'cm-push-availability' } });
    await flush();
    return json(500, { error: err.message || 'Availability push failed' });
  }
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function subtractDay(dateString) {
  const d = new Date(dateString + 'T12:00:00Z');
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
