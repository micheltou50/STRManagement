/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Google Calendar Webhook (inbound: provider → app)

   Google posts a header-only notification when our watched calendar changes.
   We look up the channel → user, then run the incremental sync (events.list
   with stored sync_token) and apply changes locally.

   Headers Google sends:
     X-Goog-Channel-ID
     X-Goog-Channel-Token
     X-Goog-Resource-ID
     X-Goog-Resource-State   (sync | exists | not_exists)
     X-Goog-Message-Number
   ═══════════════════════════════════════════════════════════════════════════ */

const { reconcileGoogle } = require('./utils/calendar-reconcile-google');

function getHeader(headers, name) {
  if (!headers) return '';
  const want = String(name).toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === want) return String(headers[k] || '');
  }
  return '';
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 200, body: '' };

  const channelId = getHeader(event.headers, 'x-goog-channel-id');
  const channelToken = getHeader(event.headers, 'x-goog-channel-token');
  const state = getHeader(event.headers, 'x-goog-resource-state');

  if (!channelId) return { statusCode: 200, body: '' };

  // The 'sync' notification fires once when the channel is first established
  // — nothing to reconcile yet, but Google requires a 200.
  if (state === 'sync') return { statusCode: 200, body: '' };

  // Look up which user this channel belongs to.
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const sbH = {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
  };

  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/email_connections' +
      '?provider=eq.google_calendar' +
      '&watch_channel_id=eq.' + encodeURIComponent(channelId) +
      '&select=user_id&limit=1',
      { headers: sbH });
    const rows = await res.json();
    const userId = Array.isArray(rows) && rows[0] ? rows[0].user_id : null;
    if (!userId) {
      console.warn('[gcal-webhook] unknown channel', channelId);
      return { statusCode: 200, body: '' };
    }

    // Shared-secret check — channel_token is set to the user_id at watch
    // creation, so Google echoes it on every notification. Require it
    // present AND matching: a MISSING token must not bypass the guard
    // (the previous `channelToken &&` let a tokenless request straight through).
    if (channelToken !== userId) {
      console.warn('[gcal-webhook] channel token missing or mismatched');
      return { statusCode: 200, body: '' };
    }

    await reconcileGoogle(userId);
    return { statusCode: 200, body: '' };
  } catch (e) {
    console.error('[gcal-webhook] error:', e.message);
    return { statusCode: 200, body: '' }; // always 200 so Google doesn't retry-storm
  }
};
