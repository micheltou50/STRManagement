/**
 * StayOps — shared web-push + app_config / notification_log helpers for Netlify functions.
 * CommonJS; requires web-push and a Supabase service-role client as supabaseAdmin.
 */

const webpush = require('web-push');

const VAPID_SUBJECT = 'mailto:micheltou50@gmail.com';

let _vapidConfigured = false;

function ensureVapid() {
  if (_vapidConfigured) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    console.log('[StayOps] push-helper: VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY missing');
    return false;
  }
  webpush.setVapidDetails(VAPID_SUBJECT, pub, priv);
  _vapidConfigured = true;
  return true;
}

function parsePushSubscription(raw) {
  if (raw == null || raw === '') return null;
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (o && typeof o.endpoint === 'string' && o.keys && o.keys.p256dh && o.keys.auth) return o;
  } catch (_) {}
  return null;
}

function subscriptionsFromAppConfigRow(row) {
  if (!row) return [];
  const multi = row.push_subscriptions;
  return Array.isArray(multi) ? multi.map(parsePushSubscription).filter(Boolean) : [];
}

async function persistAppConfigAfterStalePushEndpoints(supabaseAdmin, userId, rawRow, staleEndpoints) {
  if (!userId || !staleEndpoints || !staleEndpoints.size) return;
  let plural = rawRow && rawRow.push_subscriptions;
  if (!Array.isArray(plural)) plural = [];
  const filteredPlural = plural.filter(entry => {
    const ep =
      entry && typeof entry === 'object' && typeof entry.endpoint === 'string' ? entry.endpoint : '';
    return ep && !staleEndpoints.has(ep);
  });
  const patch = {
    push_subscriptions: filteredPlural,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabaseAdmin.from('app_config').update(patch).eq('user_id', userId);
  if (error) {
    console.log('[StayOps] push-helper: stale subscription cleanup update failed', error.message);
  } else {
    console.log('[StayOps] push-helper: removed stale push endpoints from app_config', [...staleEndpoints]);
  }
}

/**
 * @param {object} params
 * @param {import('@supabase/supabase-js').SupabaseClient} params.supabaseAdmin
 * @param {string} params.propertyId
 * @param {string} params.title
 * @param {string} params.body
 * @param {string} [params.url]
 * @param {string} params.type
 * @param {string} params.referenceId
 * @returns {Promise<{ sent: number, removed: number }>}
 */
async function sendPushToOwner({
  supabaseAdmin,
  propertyId,
  title,
  body,
  url,
  type,
  referenceId,
}) {
  if (!supabaseAdmin || !propertyId) {
    console.log('[StayOps] push-helper: sendPushToOwner missing supabaseAdmin or propertyId');
    return { sent: 0, removed: 0 };
  }

  const { data: prop, error: pErr } = await supabaseAdmin
    .from('properties')
    .select('user_id')
    .eq('id', propertyId)
    .maybeSingle();

  if (pErr || !prop || !prop.user_id) {
    console.log('[StayOps] push-helper: property or user_id not found', propertyId, pErr && pErr.message);
    return { sent: 0, removed: 0 };
  }

  const uid = prop.user_id;

  const { data: cfgRows, error: cErr } = await supabaseAdmin
    .from('app_config')
    .select('push_subscriptions')
    .eq('user_id', uid)
    .limit(1);

  if (cErr) {
    console.log('[StayOps] push-helper: app_config read failed', cErr.message);
    return { sent: 0, removed: 0 };
  }

  const row = Array.isArray(cfgRows) && cfgRows.length ? cfgRows[0] : null;
  const subs = subscriptionsFromAppConfigRow(row);

  if (!subs.length) {
    console.log('[StayOps] No push subscriptions found');
    return { sent: 0, removed: 0 };
  }

  if (!ensureVapid()) {
    return { sent: 0, removed: 0 };
  }

  const staleEndpoints = new Set();
  let sent = 0;
  const payload = JSON.stringify({
    title,
    body: body || '',
    url: url || '/',
    type: type || '',
  });

  for (const sub of subs) {
    try {
      console.log('[StayOps] push-helper: sending push —', title);
      await webpush.sendNotification(sub, payload);
      sent++;
    } catch (e) {
      const statusCode = e && e.statusCode != null ? Number(e.statusCode) : NaN;
      if (statusCode === 404 || statusCode === 410) {
        staleEndpoints.add(sub.endpoint);
        console.log('[StayOps] push-helper: subscription stale (HTTP ' + statusCode + ')');
      }
      console.log('[StayOps] push-helper: send failed —', e && e.message ? e.message : String(e));
    }
  }

  const staleCount = staleEndpoints.size;
  if (staleCount) {
    await persistAppConfigAfterStalePushEndpoints(supabaseAdmin, uid, row, staleEndpoints);
  }

  if (sent > 0) {
    const { error: logErr } = await supabaseAdmin.from('notification_log').insert({
      property_id: propertyId,
      type,
      reference_id: String(referenceId),
      title,
      body: body || '',
      sent_at: new Date().toISOString(),
    });
    if (logErr) {
      console.log('[StayOps] push-helper: notification_log insert failed', logErr.message);
    }
  }

  return { sent, removed: staleCount };
}

/**
 * @param {object} params
 * @param {import('@supabase/supabase-js').SupabaseClient} params.supabaseAdmin
 * @param {string} params.type
 * @param {string} params.referenceId
 * @param {number} [params.withinMinutes]
 * @returns {Promise<boolean>}
 */
async function hasRecentNotification({ supabaseAdmin, type, referenceId, withinMinutes = 60 }) {
  if (!supabaseAdmin || !type || referenceId == null) return false;
  const since = new Date(Date.now() - withinMinutes * 60 * 1000).toISOString();
  const { data, error } = await supabaseAdmin
    .from('notification_log')
    .select('id')
    .eq('type', type)
    .eq('reference_id', String(referenceId))
    .gte('sent_at', since)
    .limit(1);

  if (error) {
    console.log('[StayOps] push-helper: hasRecentNotification query error', error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

module.exports = {
  sendPushToOwner,
  hasRecentNotification,
};
