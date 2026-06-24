/**
 * StayOps — shared web-push + app_config / notification_log helpers for Netlify functions.
 * CommonJS; requires web-push and a Supabase service-role client as supabaseAdmin.
 */

const webpush = require('web-push');
const { notification: buildNotificationHtml } = require('./email-templates');

const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:noreply@app.stayops.com.au';

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
  } catch (_) { /* ignore malformed subscription JSON */ }
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
async function sendPushToHost({
  supabaseAdmin,
  propertyId,
  title,
  body,
  url,
  type,
  referenceId,
}) {
  if (!supabaseAdmin || !propertyId) {
    console.log('[StayOps] push-helper: sendPushToHost missing supabaseAdmin or propertyId');
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
    .select('push_subscriptions, notification_config, native_push_tokens')
    .eq('user_id', uid)
    .limit(1);

  if (cErr) {
    console.log('[StayOps] push-helper: app_config read failed', cErr.message);
    return { sent: 0, removed: 0 };
  }

  const row = Array.isArray(cfgRows) && cfgRows.length ? cfgRows[0] : null;

  // Check notification_config toggles
  if (row && row.notification_config && type) {
    const nc = row.notification_config;
    // Map notification types to config keys
    const typeToKey = {
      checkin_today: 'push_checkin',
      checkout_today: 'push_checkout',
      unassigned_clean: 'push_unassigned_clean',
      no_response: 'push_no_response',
      review_cleaning_cost: 'push_review_cost',
      monthly_summary: 'push_monthly_summary',
      cleaner_confirmed: 'push_cleaner_confirm',
      cleaner_declined: 'push_cleaner_decline',
      clean_done: 'push_clean_done',
    };
    const cfgKey = typeToKey[type];
    if (cfgKey && nc[cfgKey] === false) {
      console.log('[StayOps] push-helper: notification disabled by config —', type, '→', cfgKey);
      return { sent: 0, removed: 0 };
    }
  }

  // ── Push notifications (only if subscriptions exist) ──
  const subs = subscriptionsFromAppConfigRow(row);
  let sent = 0;
  let staleCount = 0;

  if (subs.length && ensureVapid()) {
    const staleEndpoints = new Set();
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

    staleCount = staleEndpoints.size;
    if (staleCount) {
      await persistAppConfigAfterStalePushEndpoints(supabaseAdmin, uid, row, staleEndpoints);
    }
  } else {
    console.log('[StayOps] push-helper: no push subscriptions — skipping push, will still email');
  }

  // ── Native iOS (APNs) push to the host's registered device tokens ──
  try {
    const { sendApns, isConfigured: apnsConfigured } = require('./apns');
    const rawTokens = Array.isArray(row && row.native_push_tokens) ? row.native_push_tokens : [];
    const tokens = rawTokens.map(t => t && t.token).filter(Boolean);
    if (tokens.length && apnsConfigured()) {
      const r = await sendApns(tokens, { title, body, data: { url: url || '/', type: type || '' } });
      sent += r.sent;
      if (r.stale.length) {
        const keep = rawTokens.filter(t => t && t.token && !r.stale.includes(t.token));
        await supabaseAdmin.from('app_config').update({ native_push_tokens: keep, updated_at: new Date().toISOString() }).eq('user_id', uid);
        console.log('[StayOps] push-helper: removed ' + r.stale.length + ' stale APNs tokens');
      }
      console.log('[StayOps] push-helper: APNs sent=' + r.sent + ' stale=' + r.stale.length);
    }
  } catch (apnsErr) { console.log('[StayOps] push-helper: APNs send failed —', apnsErr && apnsErr.message); }

  // ── Always log notification (regardless of push subscription state) ──
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

  // ── Always send email to host (regardless of push subscription state) ──
  try {
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) { console.log('[StayOps] push-helper: RESEND_API_KEY not set — skipping email'); }
    else {
      const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(uid);
      const hostEmail = authUser && authUser.user && authUser.user.email;
      if (hostEmail) {
        const emailHtml = buildNotificationHtml(title, body);
        const from = process.env.RESEND_FROM || 'StayOps <info@stayops.com.au>';
        const maxAttempts = 3;
        let emailSent = false;
        for (let attempt = 1; attempt <= maxAttempts && !emailSent; attempt++) {
          try {
            const emailRes = await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
              body: JSON.stringify({ from, to: hostEmail, subject: title, html: emailHtml }),
            });
            if (emailRes.ok) {
              emailSent = true;
              console.log('[StayOps] push-helper: Resend email sent to', hostEmail);
            } else {
              const errBody = await emailRes.text().catch(() => '');
              console.log('[StayOps] push-helper: Resend attempt', attempt, 'failed:', emailRes.status, errBody);
            }
          } catch (resendErr) {
            console.log('[StayOps] push-helper: Resend attempt', attempt, 'failed:', resendErr.message);
          }
          if (!emailSent && attempt < maxAttempts) await new Promise(r => setTimeout(r, 1000 * attempt));
        }
        if (!emailSent) console.error('[StayOps] push-helper: Resend email failed after', maxAttempts, 'attempts to', hostEmail);
      }
    }
  } catch (emailErr) {
    console.log('[StayOps] push-helper: email send error (non-fatal)', emailErr.message);
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
  sendPushToHost,
  hasRecentNotification,
};
