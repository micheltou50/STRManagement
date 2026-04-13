/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Channel Manager: Test Connection
   Validates an API key against the chosen provider (beds24 / hostaway),
   stores credentials in app_config on success, and returns properties.

   POST body: { uid, provider, apiKey, tier }
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
    console.error('[StayOps] cm-test-connection: invalid JSON body', e.message);
    return json(400, { error: 'Invalid JSON' });
  }

  const { uid, provider, apiKey, tier } = body;

  if (!uid || !provider || !apiKey) {
    return json(400, { error: 'Missing required fields: uid, provider, apiKey' });
  }
  if (!['beds24', 'hostaway'].includes(provider)) {
    return json(400, { error: 'Invalid provider — must be beds24 or hostaway' });
  }
  if (tier && !['self_serve', 'managed'].includes(tier)) {
    return json(400, { error: 'Invalid tier — must be self_serve or managed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return json(500, { error: 'Server misconfigured' });
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

  try {
    let properties = [];
    let refreshToken = null;

    // ── Test connection per provider ──────────────────────────────────────
    if (provider === 'beds24') {
      // Step 1: Exchange refresh token for access token
      console.log('[StayOps] cm-test-connection: testing beds24 key');
      const tokenRes = await fetch('https://beds24.com/api/v2/authentication/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: apiKey }),
      });
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || !tokenData.token) {
        console.error('[StayOps] cm-test-connection: beds24 token exchange failed', tokenData);
        return json(200, { connected: false, error: 'Invalid Beds24 API key — token exchange failed' });
      }
      refreshToken = apiKey;
      const accessToken = tokenData.token;

      // Step 2: Fetch properties
      const propRes = await fetch('https://beds24.com/api/v2/properties?includeAllRooms=true', {
        headers: { Authorization: 'Bearer ' + accessToken },
      });
      const propData = await propRes.json();
      if (!propRes.ok) {
        console.error('[StayOps] cm-test-connection: beds24 properties fetch failed', propData);
        return json(200, { connected: false, error: 'Could not fetch Beds24 properties' });
      }
      properties = normalizeBeds24Properties(propData);

    } else if (provider === 'hostaway') {
      console.log('[StayOps] cm-test-connection: testing hostaway key');
      const listRes = await fetch('https://api.hostaway.com/v1/listings', {
        headers: { Authorization: 'Bearer ' + apiKey },
      });
      if (!listRes.ok) {
        console.error('[StayOps] cm-test-connection: hostaway listings fetch failed', listRes.status);
        return json(200, { connected: false, error: 'Invalid Hostaway API key — could not fetch listings' });
      }
      const listData = await listRes.json();
      properties = normalizeHostawayProperties(listData);
    }

    // ── Store credentials ────────────────────────────────────────────────
    console.log('[StayOps] cm-test-connection: storing credentials for uid:', uid);
    const { error: updateErr } = await sb
      .from('app_config')
      .update({
        channel_manager_provider: provider,
        channel_manager_api_key: apiKey,
        channel_manager_refresh_token: refreshToken,
        channel_manager_connected: true,
        channel_manager_tier: tier || 'self_serve',
        channel_manager_sync_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', uid);

    if (updateErr) {
      console.error('[StayOps] cm-test-connection: supabase update failed', updateErr);
      return json(500, { error: 'Failed to store credentials' });
    }

    console.log('[StayOps] cm-test-connection: success — found', properties.length, 'properties');
    return json(200, { connected: true, provider, properties });

  } catch (err) {
    console.error('[StayOps] cm-test-connection: unexpected error', err.message);
    captureError(err, { tags: { function: 'cm-test-connection' } });
    await flush();
    return json(200, { connected: false, error: err.message || 'Connection test failed' });
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
