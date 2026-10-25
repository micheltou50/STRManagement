// Netlify/functions/cleaner-handoff.js
//
// StayOps — a cleaner hands one of their cleans to a teammate.
//
//   POST /.netlify/functions/cleaner-handoff   (cleaner's Supabase JWT)
//   { cleanId: <cleans.id>, toCleanerId: <cleaners.id> }
//
// WHY A FUNCTION: RLS lets a cleaner update only their OWN cleans
// (cleaner_update_own_cleans), and the moment cleaner_uuid points at someone
// else the row stops being theirs — so the reassignment has to run with the
// service key, after checking here that the caller really holds the clean and
// that the target is an active teammate under the same host.
//
// WHAT IT DOES
//   1. verifyAuth → the calling cleaner's auth user; load their cleaners rows
//      (one per host they work for).
//   2. The clean must belong to one of those rows and not be done.
//   3. The teammate must be active, under the clean's host (same user_id), and
//      not be another row of the caller's own login.
//   4. Re-point the clean: cleaner_uuid / cleaner_id / cleaner to the teammate,
//      back to "awaiting response" (cleaner_confirmed false), progress reset
//      (started_at null, checklist_done []), assigned_at now, notified false so
//      the host dashboard shows "Cleaner not notified" and the host sends the
//      proper assignment notice. Photos are kept (they are evidence either way).
//   5. Push the host ("🔁 Megan handed the Seaview clean to Sam") and, when the
//      teammate has a login, push them too.
//
// The teammate list the cleaner picks from comes from cleaner_dashboard_context()
// (id + name + host only); this function never returns contact details either.
//
// Required env: SUPABASE_URL, SUPABASE_SERVICE_KEY (+ VAPID keys for push)

const { createClient } = require('@supabase/supabase-js');
const { verifyAuth } = require('./utils/auth');
const { sendPushToHost, sendPushToUser } = require('./utils/push-helper');
const { captureError, flush } = require('./utils/sentry');

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    body: JSON.stringify(body),
  };
}

function fmtDay(ymd) {
  const d = new Date(String(ymd || '').slice(0, 10) + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return String(ymd || '');
  return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  const auth = await verifyAuth(event);
  if (auth.error) return auth.error;

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (_e) {
    return json(400, { error: 'Invalid JSON' });
  }
  const cleanId = body && body.cleanId != null ? String(body.cleanId) : '';
  const toCleanerId = body && body.toCleanerId != null ? String(body.toCleanerId) : '';
  if (!cleanId || !toCleanerId) return json(400, { error: 'Missing cleanId or toCleanerId' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) return json(500, { error: 'Server misconfigured' });
  const sb = createClient(supabaseUrl, supabaseKey);

  try {
    // 1. The caller's cleaner rows (one per host).
    const { data: mineRows, error: mineErr } = await sb
      .from('cleaners')
      .select('id, name, user_id, active')
      .eq('auth_user_id', auth.id);
    if (mineErr) throw new Error('cleaners lookup failed: ' + mineErr.message);
    const mine = (mineRows || []).filter(r => r.active !== false);
    if (!mine.length) return json(403, { error: 'No cleaner profile for this login' });
    const myIds = new Set(mine.map(r => String(r.id)));

    // 2. The clean must be the caller's and still open.
    const { data: clean, error: cleanErr } = await sb
      .from('cleans')
      .select('id, user_id, property_id, cleaner_uuid, guest_name, clean_date, done')
      .eq('id', cleanId)
      .maybeSingle();
    if (cleanErr) throw new Error('clean lookup failed: ' + cleanErr.message);
    if (!clean || !myIds.has(String(clean.cleaner_uuid))) return json(403, { error: 'That clean is not yours' });
    if (clean.done) return json(409, { error: 'That clean is already done' });
    const from = mine.find(r => String(r.id) === String(clean.cleaner_uuid)) || mine[0];

    // 3. The teammate: active, same host as the clean, not the caller.
    const { data: to, error: toErr } = await sb
      .from('cleaners')
      .select('id, local_id, name, user_id, auth_user_id, active')
      .eq('id', toCleanerId)
      .maybeSingle();
    if (toErr) throw new Error('teammate lookup failed: ' + toErr.message);
    if (!to || to.active === false || String(to.user_id) !== String(clean.user_id)) {
      return json(400, { error: 'That cleaner does not work for this host' });
    }
    if (myIds.has(String(to.id)) || (to.auth_user_id && String(to.auth_user_id) === String(auth.id))) {
      return json(400, { error: 'You cannot hand a clean to yourself' });
    }

    // 4. Re-point the clean.
    const now = new Date().toISOString();
    const patch = {
      cleaner_uuid: to.id,
      cleaner_id: String(to.local_id != null && to.local_id !== '' ? to.local_id : to.id),
      cleaner: to.name || '',
      cleaner_confirmed: false,
      cleaner_declined: false,
      confirmed_at: null,
      started_at: null,
      checklist_done: [],
      assigned_at: now,
      notified: false,
      reminder_sent: false,
      updated_at: now,
    };
    const { error: updErr } = await sb.from('cleans').update(patch).eq('id', clean.id);
    if (updErr) throw new Error('clean update failed: ' + updErr.message);

    // 5. Tell the host, then the teammate.
    let propName = 'the property';
    if (clean.property_id) {
      const { data: prop } = await sb.from('properties').select('name').eq('id', clean.property_id).maybeSingle();
      if (prop && prop.name) propName = prop.name;
    }
    const when = clean.clean_date ? ' on ' + fmtDay(clean.clean_date) : '';
    const fromName = from.name || 'Your cleaner';
    const toName = to.name || 'a teammate';

    let hostNotified = 0;
    if (clean.property_id) {
      try {
        const r = await sendPushToHost({
          supabaseAdmin: sb,
          propertyId: clean.property_id,
          title: '🔁 ' + fromName + ' handed a clean to ' + toName,
          body: propName + when + (clean.guest_name ? ' · ' + clean.guest_name : '') + '. ' + toName + ' still needs to accept it.',
          url: '/',
          type: 'cleaner_handoff',
          referenceId: String(clean.id),
        });
        hostNotified = r && r.sent ? r.sent : 0;
      } catch (e) {
        console.warn('[cleaner-handoff] host push failed:', e && e.message);
      }
    }

    let teammateNotified = 0;
    if (to.auth_user_id) {
      try {
        const r = await sendPushToUser({
          supabaseAdmin: sb,
          userId: to.auth_user_id,
          title: '🏡 ' + fromName + ' handed you a clean',
          body: propName + when + (clean.guest_name ? ' · ' + clean.guest_name : '') + '. Open StayOps to accept or decline.',
          url: '/',
          type: 'cleaner_handoff',
          tag: 'handoff-' + clean.id,
        });
        teammateNotified = r && r.sent ? r.sent : 0;
      } catch (e) {
        console.warn('[cleaner-handoff] teammate push failed:', e && e.message);
      }
    }

    console.log('[cleaner-handoff]', from.name, '→', to.name, 'clean', clean.id, 'host push', hostNotified, 'teammate push', teammateNotified);
    return json(200, { ok: true, cleanId: clean.id, to: { id: to.id, name: to.name || '' }, hostNotified, teammateNotified });
  } catch (err) {
    console.error('[cleaner-handoff] Error:', err);
    captureError(err, { tags: { function: 'cleaner-handoff' } });
    await flush();
    return json(500, { error: 'Internal error' });
  }
};
