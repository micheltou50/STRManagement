/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Cleaner Actions
   Handles accept/decline/done for cleaner PWA (home screen has no Supabase
   auth session, so writes go through this function using the service key).

   POST body (JSON):
     uid       — host's Supabase user ID
     cleanerId — cleaner's local_id
     cleanId   — the clean's local_id
     action    — 'accept' | 'decline' | 'done'

   Required Netlify env vars:
     SUPABASE_URL
     SUPABASE_SERVICE_KEY
   ═══════════════════════════════════════════════════════════════════════════ */

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'POST only' });
  }

  let body;
  try { body = JSON.parse(event.body); } catch (e) {
    return json(400, { error: 'Invalid JSON' });
  }

  const { uid, cleanerId, cleanId, action } = body || {};
  if (!uid || !cleanerId || !cleanId || !action) {
    return json(400, { error: 'Missing uid, cleanerId, cleanId, or action' });
  }
  if (!['accept', 'decline', 'done'].includes(action)) {
    return json(400, { error: 'Invalid action — must be accept, decline, or done' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return json(500, { error: 'Server misconfigured' });
  }

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal',
  };

  try {
    // 1. Verify cleaner exists and belongs to this user
    const cleanerRes = await fetch(
      SUPABASE_URL + '/rest/v1/cleaners?user_id=eq.' + enc(uid) +
        '&local_id=eq.' + enc(cleanerId) +
        '&active=eq.true&select=id,name&limit=1',
      { headers: { ...headers, Prefer: undefined } }
    );
    const cleaners = await cleanerRes.json();
    if (!Array.isArray(cleaners) || !cleaners.length) {
      return json(403, { error: 'Cleaner not found' });
    }

    // 2. Build update payload
    let patch = {};
    if (action === 'accept') {
      patch = { cleaner_confirmed: true, cleaner_declined: false, confirmed_at: new Date().toISOString() };
    } else if (action === 'decline') {
      patch = { cleaner_declined: true, cleaner_confirmed: false };
    } else if (action === 'done') {
      patch = { done: true, cleaner_confirmed: true, cleaner_declined: false };
    }

    // 3. Update the clean
    const updateRes = await fetch(
      SUPABASE_URL + '/rest/v1/cleans?user_id=eq.' + enc(uid) +
        '&local_id=eq.' + enc(cleanId),
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify(patch),
      }
    );

    if (!updateRes.ok) {
      const errText = await updateRes.text();
      console.error('[cleaner-action] Update failed:', errText);
      return json(500, { error: 'Update failed' });
    }

    return json(200, { ok: true, action });

  } catch (err) {
    console.error('[cleaner-action] Error:', err);
    return json(500, { error: 'Internal error' });
  }
};

function enc(s) { return encodeURIComponent(s); }
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
function json(status, body) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
