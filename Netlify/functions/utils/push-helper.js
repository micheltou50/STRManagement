/**
 * StayOps — shared web-push + app_config / notification_log helpers for Netlify functions.
 * CommonJS; requires web-push and a Supabase service-role client as supabaseAdmin.
 */

const webpush = require('web-push');

const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:noreply@strmanagement.netlify.app';

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
    .select('push_subscriptions, notification_config')
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

  // Log notification
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

  // Also send email to host (best-effort, non-blocking)
  try {
    const gmailUser = process.env.GMAIL_USER;
    const gmailPass = process.env.GMAIL_APP_PASSWORD;
    const resendKey = process.env.RESEND_API_KEY;

    if (gmailUser || resendKey) {
      const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(uid);
      const hostEmail = authUser && authUser.user && authUser.user.email;
      if (hostEmail) {
        const emailHtml = '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px">' +
          '<div style="background:#1E3A2F;color:#fff;padding:16px 20px;border-radius:12px 12px 0 0">' +
            '<div style="font-size:18px;font-weight:700">StayOps</div>' +
          '</div>' +
          '<div style="background:#fff;border:1px solid #e5e5e5;border-top:none;padding:20px;border-radius:0 0 12px 12px">' +
            '<div style="font-size:16px;font-weight:700;color:#1E3A2F;margin-bottom:8px">' + (title || '') + '</div>' +
            '<div style="font-size:14px;color:#666;line-height:1.5">' + (body || '') + '</div>' +
            '<div style="margin-top:16px"><a href="https://strmanagement.netlify.app" style="display:inline-block;background:#1E3A2F;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600">Open StayOps</a></div>' +
          '</div>' +
        '</div>';

        let emailSent = false;

        // Primary: Gmail SMTP
        if (gmailUser && gmailPass && !emailSent) {
          try {
            const nodemailer = require('nodemailer');
            const transporter = nodemailer.createTransport({
              host: 'smtp.gmail.com', port: 587, secure: false,
              auth: { user: gmailUser, pass: gmailPass },
            });
            await transporter.sendMail({
              from: process.env.GMAIL_FROM || ('StayOps <' + gmailUser + '>'),
              to: hostEmail,
              subject: title,
              html: emailHtml,
            });
            emailSent = true;
            console.log('[StayOps] push-helper: Gmail email sent to', hostEmail);
          } catch (gmailErr) {
            console.log('[StayOps] push-helper: Gmail email failed, trying Resend:', gmailErr.message);
          }
        }

        // Fallback: Resend
        if (resendKey && !emailSent) {
          const from = process.env.RESEND_FROM || 'StayOps <noreply@strmanagement.netlify.app>';
          const emailRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from, to: hostEmail, subject: title, html: emailHtml }),
          });
          if (emailRes.ok) {
            console.log('[StayOps] push-helper: Resend email sent to', hostEmail);
          } else {
            const errBody = await emailRes.text().catch(() => '');
            console.log('[StayOps] push-helper: Resend email failed', emailRes.status, errBody);
          }
        }
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
