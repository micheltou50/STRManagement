/**
 * StayOps — shared token helper for calendar providers.
 *
 * Loads the email_connections row for (user_id, provider) and returns a fresh
 * access token, refreshing via the provider's token endpoint when needed.
 *
 * Currently supports provider='google_calendar'. Outlook is added in PR 2.
 */

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
function microsoftTokenUrl() {
  const tenant = process.env.MICROSOFT_TENANT_ID || 'common';
  return 'https://login.microsoftonline.com/' + tenant + '/oauth2/v2.0/token';
}

function sbHeaders() {
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    apikey: key,
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
  };
}

async function loadConnection(userId, provider) {
  const url = process.env.SUPABASE_URL +
    '/rest/v1/email_connections' +
    '?user_id=eq.' + encodeURIComponent(userId) +
    '&provider=eq.' + encodeURIComponent(provider) +
    '&select=user_id,email,provider,access_token,refresh_token,token_expiry,calendar_id,sync_token,watch_channel_id,watch_resource_id,watch_expires_at,outlook_subscription_id,outlook_delta_link' +
    '&limit=1';
  const res = await fetch(url, { headers: sbHeaders() });
  if (!res.ok) throw new Error('email_connections fetch failed: ' + res.status);
  const rows = await res.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function patchConnection(userId, provider, patch) {
  const url = process.env.SUPABASE_URL +
    '/rest/v1/email_connections' +
    '?user_id=eq.' + encodeURIComponent(userId) +
    '&provider=eq.' + encodeURIComponent(provider);
  await fetch(url, {
    method: 'PATCH',
    headers: { ...sbHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
}

async function refreshGoogle(refreshToken) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const tokens = await res.json();
  if (!res.ok || !tokens.access_token) {
    const err = new Error('Google token refresh failed: ' + JSON.stringify(tokens));
    err.statusCode = res.status;
    throw err;
  }
  return tokens;
}

async function refreshMicrosoft(refreshToken) {
  const res = await fetch(microsoftTokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: 'https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/User.Read offline_access',
    }).toString(),
  });
  const tokens = await res.json();
  if (!res.ok || !tokens.access_token) {
    const err = new Error('Microsoft token refresh failed: ' + JSON.stringify(tokens));
    err.statusCode = res.status;
    throw err;
  }
  return tokens; // { access_token, refresh_token?, expires_in, ... }
}

/**
 * Returns { accessToken, connection } for the given user+provider.
 * Refreshes if the cached access_token is missing or within 60s of expiry.
 */
async function getFreshAccessToken(userId, provider) {
  const conn = await loadConnection(userId, provider);
  if (!conn) throw new Error('No ' + provider + ' connection for user ' + userId);

  const now = Date.now();
  const expiry = conn.token_expiry ? new Date(conn.token_expiry).getTime() : 0;
  if (conn.access_token && expiry - now > 60_000) {
    return { accessToken: conn.access_token, connection: conn };
  }

  if (provider === 'google_calendar') {
    if (!conn.refresh_token) throw new Error('Google Calendar refresh_token missing — user must reconnect');
    const tokens = await refreshGoogle(conn.refresh_token);
    const newExpiry = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;
    await patchConnection(userId, provider, {
      access_token: tokens.access_token,
      token_expiry: newExpiry,
    });
    return {
      accessToken: tokens.access_token,
      connection: { ...conn, access_token: tokens.access_token, token_expiry: newExpiry },
    };
  }

  if (provider === 'outlook_calendar') {
    if (!conn.refresh_token) throw new Error('Outlook Calendar refresh_token missing — user must reconnect');
    const tokens = await refreshMicrosoft(conn.refresh_token);
    const newExpiry = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;
    const patch = {
      access_token: tokens.access_token,
      token_expiry: newExpiry,
    };
    // Microsoft may rotate the refresh token; persist if so.
    if (tokens.refresh_token && tokens.refresh_token !== conn.refresh_token) {
      patch.refresh_token = tokens.refresh_token;
    }
    await patchConnection(userId, provider, patch);
    return {
      accessToken: tokens.access_token,
      connection: { ...conn, ...patch },
    };
  }

  throw new Error('Unsupported provider in getFreshAccessToken: ' + provider);
}

module.exports = {
  getFreshAccessToken,
  loadConnection,
  patchConnection,
  sbHeaders,
};
