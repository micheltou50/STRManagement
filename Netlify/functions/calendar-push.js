/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Calendar Push (outbound: app → provider)

   POST { uid, table, id, op }
     uid   — user id
     table — 'bookings' | 'cleans' | 'maintenance'
     id    — local row id (number/string used in local_id)
     op    — 'upsert' | 'delete'

   Pushes the change to every connected calendar provider for that user.
   Records the resulting provider_event_id + etag in calendar_sync_state so
   the inbound webhook can de-echo.

   Per-row push logic lives in utils/calendar-push-core.js so server-side
   scanners (gmail/outlook/ical) can share it.
   ═══════════════════════════════════════════════════════════════════════════ */

const { verifyAuth } = require('./utils/auth');
const { pushChange } = require('./utils/calendar-push-core');

function json(status, body) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, { ok: true });
  if (event.httpMethod !== 'POST')   return json(405, { error: 'Method not allowed' });

  const auth = await verifyAuth(event);
  if (auth.error) return auth.error;

  let body;
  try { body = event.body ? JSON.parse(event.body) : {}; }
  catch (_) { return json(400, { error: 'Invalid JSON' }); }

  const { table, id, op } = body || {};
  if (!table || !id || !op) return json(400, { error: 'Missing table/id/op' });
  if (!['bookings', 'cleans', 'maintenance'].includes(table)) return json(400, { error: 'Bad table' });
  if (!['upsert', 'delete'].includes(op)) return json(400, { error: 'Bad op' });

  const results = await pushChange(auth.id, table, id, op);
  return json(200, { ok: true, results });
};
