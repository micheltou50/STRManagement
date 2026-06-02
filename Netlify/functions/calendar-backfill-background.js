/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Calendar Backfill (Background)
   Pushes all existing confirmed bookings and pending cleans to connected
   calendar providers via shared pushChange() — which patches if a sync_state
   row already exists, or inserts otherwise. Safe to run multiple times.

   POST { uid }   — backfill for a specific user
   ═══════════════════════════════════════════════════════════════════════════ */

const { sbHeaders } = require('./utils/calendar-token');
const { pushChange } = require('./utils/calendar-push-core');

function activeBookingQuery(uid) {
  return process.env.SUPABASE_URL + '/rest/v1/bookings' +
    '?user_id=eq.' + encodeURIComponent(uid) +
    '&status=neq.cancelled' +
    '&or=(enrichment_status.is.null,enrichment_status.neq.pending)' +
    '&select=local_id';
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' }, body: '' };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (_e) { return json(400, { error: 'Invalid JSON' }); }
  const uid = body.uid;
  if (!uid) return json(400, { error: 'Missing uid' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const results = { bookings: { pushed: 0, errors: 0 }, cleans: { pushed: 0, errors: 0 } };

  // Bookings
  try {
    const res = await fetch(activeBookingQuery(uid), { headers: sbHeaders() });
    const bookings = await res.json();
    for (const b of (bookings || [])) {
      if (!b.local_id) continue;
      try {
        await pushChange(uid, 'bookings', b.local_id, 'upsert');
        results.bookings.pushed++;
      } catch (e) {
        console.warn('[backfill] booking', b.local_id, 'failed:', e.message);
        results.bookings.errors++;
      }
    }
  } catch (e) {
    console.error('[backfill] bookings load failed:', e.message);
  }

  // Cleans
  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/cleans' +
      '?user_id=eq.' + encodeURIComponent(uid) +
      '&done=eq.false&select=local_id', { headers: sbHeaders() });
    const cleans = await res.json();
    for (const c of (cleans || [])) {
      if (!c.local_id) continue;
      try {
        await pushChange(uid, 'cleans', c.local_id, 'upsert');
        results.cleans.pushed++;
      } catch (e) {
        console.warn('[backfill] clean', c.local_id, 'failed:', e.message);
        results.cleans.errors++;
      }
    }
  } catch (e) {
    console.error('[backfill] cleans load failed:', e.message);
  }

  return json(200, { ok: true, results });
};
