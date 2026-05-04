/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Scheduled Calendar Reconciler

   Every 15 minutes:
     1. For every connected user × provider, run incremental reconcile.
     2. Renew push subscriptions nearing expiry (Google channels ~7d, Graph
        subscriptions ~3d).
     3. Clear rows with pending_direction='to_provider' (failed outbound
        pushes); the next mutation will retry.

   Also exposed as POST { uid } for manual "Sync now" from settings.
   ═══════════════════════════════════════════════════════════════════════════ */

const { reconcileGoogle } = require('./utils/calendar-reconcile-google');
const { reconcileOutlook } = require('./utils/calendar-reconcile-outlook');
const { getFreshAccessToken, sbHeaders, patchConnection } = require('./utils/calendar-token');
const gcal = require('./utils/gcal-client');
const ocal = require('./utils/outlook-cal-client');
const crypto = require('crypto');

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}

async function loadConnections(provider, userIdFilter) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  let url = SUPABASE_URL + '/rest/v1/email_connections' +
    '?provider=eq.' + encodeURIComponent(provider) +
    '&select=user_id,provider,calendar_id,watch_channel_id,watch_resource_id,watch_expires_at,outlook_subscription_id,outlook_client_state';
  if (userIdFilter) url += '&user_id=eq.' + encodeURIComponent(userIdFilter);
  const res = await fetch(url, { headers: sbHeaders() });
  if (!res.ok) throw new Error('connections fetch failed: ' + res.status);
  return res.json();
}

async function renewGoogleWatchIfNeeded(userId, conn) {
  const SITE_URL = process.env.SITE_URL || process.env.URL || '';
  if (!SITE_URL) return;
  const expiry = conn.watch_expires_at ? new Date(conn.watch_expires_at).getTime() : 0;
  const oneDay = 86400000;
  if (expiry && expiry - Date.now() > oneDay) return;

  try {
    const { accessToken } = await getFreshAccessToken(userId, 'google_calendar');
    if (conn.watch_channel_id && conn.watch_resource_id) {
      try { await gcal.stopChannel(accessToken, conn.watch_channel_id, conn.watch_resource_id); }
      catch (_) { void 0; }
    }
    const channelId = 'stayops-' + userId + '-' + Date.now();
    const watchUrl = SITE_URL + '/.netlify/functions/gcal-webhook';
    const watch = await gcal.watchEvents(accessToken, conn.calendar_id, channelId, watchUrl, userId);
    await patchConnection(userId, 'google_calendar', {
      watch_channel_id: watch.id,
      watch_resource_id: watch.resourceId,
      watch_expires_at: watch.expiration ? new Date(Number(watch.expiration)).toISOString() : null,
    });
  } catch (e) {
    console.warn('[reconcile] google watch renewal failed for', userId, ':', e.message);
  }
}

async function renewOutlookSubscriptionIfNeeded(userId, conn) {
  const SITE_URL = process.env.SITE_URL || process.env.URL || '';
  if (!SITE_URL) return;
  const expiry = conn.watch_expires_at ? new Date(conn.watch_expires_at).getTime() : 0;
  const sixHours = 6 * 3600 * 1000;
  // Graph subscriptions are short-lived (~3d max). Renew aggressively.
  if (conn.outlook_subscription_id && expiry && expiry - Date.now() > sixHours) return;

  try {
    const { accessToken } = await getFreshAccessToken(userId, 'outlook_calendar');
    if (conn.outlook_subscription_id && expiry > Date.now()) {
      // Healthy — just bump expiration.
      const sub = await ocal.renewSubscription(accessToken, conn.outlook_subscription_id);
      await patchConnection(userId, 'outlook_calendar', {
        watch_expires_at: sub.expirationDateTime || null,
      });
      return;
    }
    // Recreate (also drops any stale subscription server-side via best-effort delete).
    if (conn.outlook_subscription_id) {
      try { await ocal.deleteSubscription(accessToken, conn.outlook_subscription_id); } catch (_) { void 0; }
    }
    const clientState = crypto.randomBytes(16).toString('hex');
    const notificationUrl = SITE_URL + '/.netlify/functions/outlook-cal-webhook';
    const sub = await ocal.createSubscription(accessToken, conn.calendar_id, notificationUrl, clientState);
    await patchConnection(userId, 'outlook_calendar', {
      outlook_subscription_id: sub.id,
      outlook_client_state: clientState,
      watch_expires_at: sub.expirationDateTime || null,
    });
  } catch (e) {
    console.warn('[reconcile] outlook subscription renewal failed for', userId, ':', e.message);
  }
}

async function clearPendingOutbound(userId) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const url = SUPABASE_URL + '/rest/v1/calendar_sync_state' +
    '?user_id=eq.' + encodeURIComponent(userId) +
    '&pending_direction=eq.to_provider' +
    '&select=local_table,local_id&limit=50';
  const res = await fetch(url, { headers: sbHeaders() });
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  await fetch(SUPABASE_URL + '/rest/v1/calendar_sync_state' +
    '?user_id=eq.' + encodeURIComponent(userId) +
    '&pending_direction=eq.to_provider', {
    method: 'PATCH',
    headers: { ...sbHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({ pending_direction: null }),
  });
  return rows.length;
}

async function runForUser(userId, provider, conn) {
  const out = { userId, provider, reconcile: null, renewed: false, pendingCleared: 0 };
  try {
    if (provider === 'google_calendar')  out.reconcile = await reconcileGoogle(userId);
    if (provider === 'outlook_calendar') out.reconcile = await reconcileOutlook(userId);
  } catch (e) {
    out.error = e.message;
  }
  try {
    if (provider === 'google_calendar')  await renewGoogleWatchIfNeeded(userId, conn);
    if (provider === 'outlook_calendar') await renewOutlookSubscriptionIfNeeded(userId, conn);
    out.renewed = true;
  } catch (_) { void 0; }
  try { out.pendingCleared = await clearPendingOutbound(userId); } catch (_) { void 0; }
  return out;
}

exports.handler = async (event) => {
  let uid = null;
  if (event && event.httpMethod === 'POST') {
    try { uid = (JSON.parse(event.body || '{}') || {}).uid || null; } catch (_) { void 0; }
  }

  if (!process.env.SUPABASE_URL || !(process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)) {
    return json(500, { error: 'Server not configured' });
  }

  const results = [];
  for (const provider of ['google_calendar', 'outlook_calendar']) {
    let conns;
    try { conns = await loadConnections(provider, uid); }
    catch (e) { console.warn('[reconcile] load', provider, 'failed:', e.message); continue; }
    for (const c of (conns || [])) {
      results.push(await runForUser(c.user_id, provider, c));
    }
  }
  return json(200, { results });
};
