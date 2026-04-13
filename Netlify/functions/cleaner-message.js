/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Cleaner Message
   Lets a cleaner send a message to the host from the PWA (no Supabase
   auth session — uses service key, same auth model as cleaner-action.js).

   POST body (JSON):
     uid           — host's Supabase user ID
     cleanerId     — cleaner's local_id (from cleaner link)
     body          — message text
     attachmentUrl — optional photo / file URL

   Required Netlify env vars:
     SUPABASE_URL
     SUPABASE_SERVICE_KEY
   ═══════════════════════════════════════════════════════════════════════════ */

const { createClient } = require('@supabase/supabase-js');
const { sendPushToHost } = require('./utils/push-helper');
const { captureError, flush } = require('./utils/sentry');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'POST only' });
  }

  let payload;
  try { payload = JSON.parse(event.body); } catch (e) {
    return json(400, { error: 'Invalid JSON' });
  }

  const { uid, cleanerId, body: msgBody, attachmentUrl } = payload || {};
  if (!uid || !cleanerId) {
    return json(400, { error: 'Missing uid or cleanerId' });
  }
  if (!msgBody && !attachmentUrl) {
    return json(400, { error: 'Missing body or attachmentUrl' });
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
    Prefer: 'return=representation',
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
    const cleanerUuid = cleaners[0].id;
    const cleanerName = cleaners[0].name || 'Cleaner';

    // 2. Insert the message
    const messagePayload = {
      user_id: uid,
      cleaner_id: cleanerUuid,
      sender_type: 'cleaner',
      message_type: attachmentUrl ? 'photo' : 'text',
      body: msgBody || '',
      attachment_url: attachmentUrl || null,
      created_at: new Date().toISOString(),
    };

    const insertRes = await fetch(
      SUPABASE_URL + '/rest/v1/messages',
      {
        method: 'POST',
        headers,
        body: JSON.stringify(messagePayload),
      }
    );

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      console.error('[cleaner-message] Insert failed:', errText);
      return json(500, { error: 'Message insert failed' });
    }

    const inserted = await insertRes.json();
    const messageId = Array.isArray(inserted) && inserted.length ? inserted[0].id : null;

    // 3. Send push notification to host (best-effort)
    try {
      const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

      // Look up the host's first property for push routing
      const { data: props } = await sb
        .from('properties')
        .select('id')
        .eq('user_id', uid)
        .limit(1);

      const propertyId = props && props.length ? props[0].id : null;

      if (propertyId) {
        await sendPushToHost({
          supabaseAdmin: sb,
          propertyId,
          title: 'Message from ' + cleanerName,
          body: msgBody ? (msgBody.length > 80 ? msgBody.slice(0, 80) + '...' : msgBody) : 'Sent a photo',
          url: '/',
          type: 'cleaner_message',
          referenceId: messageId || cleanerUuid,
        });
      }
    } catch (pushErr) {
      console.log('[cleaner-message] Push failed (non-fatal):', pushErr.message);
    }

    return json(200, { ok: true, messageId });

  } catch (err) {
    console.error('[cleaner-message] Error:', err);
    captureError(err, { tags: { function: 'cleaner-message' } });
    await flush();
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
