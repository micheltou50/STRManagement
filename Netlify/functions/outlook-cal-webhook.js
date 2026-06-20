/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Outlook (Microsoft Graph) Calendar Webhook

   Two responsibilities:
     1. Validation handshake — when Graph creates the subscription it sends
        GET/POST with ?validationToken=… and expects a 200 + the raw token
        as text/plain within 10 seconds. Otherwise the subscription is
        rejected.
     2. Change notifications — POST body { value: [{ subscriptionId,
        clientState, resource, resourceData: { id }, ... }] }. We look up
        the subscription → user, verify clientState, and run the delta
        reconciler. Always respond 200/202 even on internal errors so Graph
        doesn't retry-storm.
   ═══════════════════════════════════════════════════════════════════════════ */

const { reconcileOutlook } = require('./utils/calendar-reconcile-outlook');

function getQueryParam(event, name) {
  const q = event.queryStringParameters || {};
  return q[name] || q[name.toLowerCase()] || null;
}

exports.handler = async (event) => {
  // 1. Validation handshake
  const validationToken = getQueryParam(event, 'validationToken') || getQueryParam(event, 'validationtoken');
  if (validationToken) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/plain' },
      body: validationToken,
    };
  }

  if (event.httpMethod !== 'POST') return { statusCode: 200, body: '' };

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch (_) { payload = null; }
  const notifications = (payload && Array.isArray(payload.value)) ? payload.value : [];
  if (!notifications.length) return { statusCode: 202, body: '' };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const sbH = {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
  };

  // Group notifications by subscriptionId so we run reconcile at most once per user.
  const subIds = new Set(notifications.map(n => n.subscriptionId).filter(Boolean));
  for (const subId of subIds) {
    try {
      const res = await fetch(SUPABASE_URL + '/rest/v1/email_connections' +
        '?provider=eq.outlook_calendar' +
        '&outlook_subscription_id=eq.' + encodeURIComponent(subId) +
        '&select=user_id,outlook_client_state&limit=1',
        { headers: sbH });
      const rows = await res.json();
      const conn = Array.isArray(rows) && rows[0] ? rows[0] : null;
      if (!conn) continue;

      // Verify clientState matches at least one notification for this sub
      const matching = notifications.filter(n => n.subscriptionId === subId);
      const expected = conn.outlook_client_state || '';
      // When a clientState is configured, EVERY notification for this sub must
      // present it exactly. The previous check passed when clientState was
      // missing (`n.clientState && ...` is falsy for a tokenless notification),
      // letting a forged notification with no clientState bypass verification.
      if (expected && !matching.every(n => n.clientState === expected)) {
        console.warn('[outlook-cal-webhook] clientState missing or mismatched for sub', subId);
        continue;
      }

      await reconcileOutlook(conn.user_id);
    } catch (e) {
      console.warn('[outlook-cal-webhook] sub', subId, 'failed:', e.message);
    }
  }

  return { statusCode: 202, body: '' };
};
