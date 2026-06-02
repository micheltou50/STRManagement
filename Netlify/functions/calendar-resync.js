/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Calendar Resync (synchronous)
   Same logic as calendar-backfill-background, but synchronous so callers can
   see per-row results / errors. Used to nudge already-synced events to the
   latest mapper format (e.g. switching bookings from all-day to 3pm/10am).

   POST { uid }
   ═══════════════════════════════════════════════════════════════════════════ */

const { sbHeaders } = require('./utils/calendar-token');
const { pushChange } = require('./utils/calendar-push-core');

function activeBookingQuery(uid) {
  return process.env.SUPABASE_URL + '/rest/v1/bookings' +
    '?user_id=eq.' + encodeURIComponent(uid) +
    '&status=neq.cancelled' +
    '&or=(enrichment_status.is.null,enrichment_status.neq.pending)' +
    '&select=local_id,guest_name,source,enrichment_status';
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, { ok: true });
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (_e) { return json(400, { error: 'Invalid JSON' }); }
  const uid = body.uid;
  if (!uid) return json(400, { error: 'Missing uid' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const out = { bookings: [], cleans: [] };

  try {
    const res = await fetch(activeBookingQuery(uid), { headers: sbHeaders() });
    const bookings = await res.json();
    for (const b of (bookings || [])) {
      if (!b.local_id) continue;
      try {
        const r = await pushChange(uid, 'bookings', b.local_id, 'upsert');
        out.bookings.push({ local_id: b.local_id, guest: b.guest_name, result: r });
      } catch (e) {
        out.bookings.push({ local_id: b.local_id, guest: b.guest_name, error: e.message });
      }
    }
  } catch (e) {
    return json(500, { error: 'bookings fetch failed: ' + e.message });
  }

  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/cleans' +
      '?user_id=eq.' + encodeURIComponent(uid) +
      '&done=eq.false&select=local_id', { headers: sbHeaders() });
    const cleans = await res.json();
    for (const c of (cleans || [])) {
      if (!c.local_id) continue;
      try {
        const r = await pushChange(uid, 'cleans', c.local_id, 'upsert');
        out.cleans.push({ local_id: c.local_id, result: r });
      } catch (e) {
        out.cleans.push({ local_id: c.local_id, error: e.message });
      }
    }
  } catch (e) {
    out.cleans_error = e.message;
  }

  return json(200, { ok: true, ...out });
};
