/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Channel Manager: Get Properties
   Fetches the property list from the connected channel manager provider
   and returns a normalized shape for both beds24 and hostaway.

   POST body: { uid }
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
    console.error('[StayOps] cm-get-properties: invalid JSON body', e.message);
    return json(400, { error: 'Invalid JSON' });
  }

  const { uid } = body;
  if (!uid) {
    return json(400, { error: 'Missing required field: uid' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return json(500, { error: 'Server misconfigured' });
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

  try {
    // ── 1. Load CM config ────────────────────────────────────────────────
    const { data: cfg, error: cfgErr } = await sb
      .from('app_config')
      .select('channel_manager_provider, channel_manager_api_key, channel_manager_refresh_token, channel_manager_connected')
      .eq('user_id', uid)
      .single();

    if (cfgErr || !cfg) {
      console.error('[StayOps] cm-get-properties: config lookup failed', cfgErr);
      return json(400, { error: 'User config not found' });
    }
    if (!cfg.channel_manager_connected) {
      return json(400, { error: 'Channel manager not connected' });
    }

    const provider = cfg.channel_manager_provider;
    const apiKey = cfg.channel_manager_api_key;
    const refreshToken = cfg.channel_manager_refresh_token;

    let properties = [];

    // ── 2. Fetch properties per provider ─────────────────────────────────
    if (provider === 'beds24') {
      // Refresh the access token first
      console.log('[StayOps] cm-get-properties: refreshing beds24 token');
      const tokenRes = await fetch('https://beds24.com/api/v2/authentication/token', {
        method: 'GET',
        headers: { refreshToken: refreshToken },
      });
      const tokenData = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok || !tokenData.token) {
        console.error('[StayOps] cm-get-properties: beds24 token refresh failed', tokenData);
        return json(401, { error: 'Beds24 token expired — reconnect in Settings' });
      }
      const accessToken = tokenData.token;

      const propRes = await fetch('https://beds24.com/api/v2/properties?includeAllRooms=true', {
        headers: { Authorization: 'Bearer ' + accessToken },
      });
      const propData = await propRes.json();
      if (!propRes.ok) {
        console.error('[StayOps] cm-get-properties: beds24 properties fetch failed', propData);
        return json(502, { error: 'Failed to fetch Beds24 properties' });
      }
      properties = normalizeBeds24Properties(propData);

    } else if (provider === 'hostaway') {
      console.log('[StayOps] cm-get-properties: fetching hostaway listings');
      const listRes = await fetch('https://api.hostaway.com/v1/listings', {
        headers: { Authorization: 'Bearer ' + apiKey },
      });
      if (!listRes.ok) {
        console.error('[StayOps] cm-get-properties: hostaway listings failed', listRes.status);
        return json(502, { error: 'Failed to fetch Hostaway listings' });
      }
      const listData = await listRes.json();
      properties = normalizeHostawayProperties(listData);

    } else {
      return json(400, { error: 'Unknown provider: ' + provider });
    }

    console.log('[StayOps] cm-get-properties: returning', properties.length, 'properties');
    return json(200, { properties });

  } catch (err) {
    console.error('[StayOps] cm-get-properties: unexpected error', err.message);
    captureError(err, { tags: { function: 'cm-get-properties' } });
    await flush();
    return json(500, { error: err.message || 'Failed to fetch properties' });
  }
};

// ── Normalizers ──────────────────────────────────────────────────────────────

function normalizeBeds24Properties(data) {
  const list = Array.isArray(data) ? data : (data.properties || data.data || []);
  return list.map(p => ({
    id: String(p.id || p.propId),
    name: p.name || 'Unnamed Property',
    rooms: (p.rooms || []).map(r => ({
      id: String(r.id || r.roomId),
      name: r.name || 'Unnamed Room',
    })),
  }));
}

function normalizeHostawayProperties(data) {
  const list = Array.isArray(data) ? data : (data.result || data.data || []);
  return list.map(p => ({
    id: String(p.id),
    name: p.name || 'Unnamed Listing',
    rooms: [],
  }));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(status, body) {
  return {
    statusCode: status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
