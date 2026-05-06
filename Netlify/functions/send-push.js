const webpush = require('web-push');
const { captureError, flush } = require('./utils/sentry');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// ── Email alongside push ────────────────────────────────────────────────
function buildNotificationEmailHtml(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F0EDE8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F0EDE8;padding:24px 0">
<tr><td align="center">
<table width="100%" style="max-width:520px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08)">
  <tr><td style="background:#1E3A2F;padding:20px 24px">
    <span style="font-family:Georgia,'Times New Roman',serif;font-size:20px;color:#fff">Stay</span><span style="font-family:Georgia,'Times New Roman',serif;font-size:20px;color:#8FAF85;font-style:italic">Ops</span>
  </td></tr>
  <tr><td style="padding:28px 24px 12px">
    <div style="font-size:18px;font-weight:600;color:#1A1A1A;margin-bottom:8px">${title}</div>
    <div style="font-size:14px;color:#6B6B6B;line-height:1.6">${body || ''}</div>
  </td></tr>
  <tr><td style="padding:12px 24px 28px">
    <a href="https://app.stayops.com.au" style="display:inline-block;background:#1E3A2F;color:#fff;text-decoration:none;padding:10px 24px;border-radius:8px;font-size:13px;font-weight:600">Open StayOps</a>
  </td></tr>
  <tr><td style="padding:16px 24px;border-top:1px solid #E8E0D5;font-size:11px;color:#999">
    Sent by StayOps &middot; You received this because a notification was triggered in your account.
  </td></tr>
</table>
</td></tr></table></body></html>`;
}

async function sendEmailAlongside(recipientEmail, title, body) {
  if (!recipientEmail) return;
  const subject = (title || 'StayOps Notification').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim();
  const html = buildNotificationEmailHtml(title, body);

  // Primary: Gmail SMTP
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  if (gmailUser && gmailPass) {
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com', port: 587, secure: false,
        auth: { user: gmailUser, pass: gmailPass },
      });
      await transporter.sendMail({
        from: process.env.GMAIL_FROM || ('StayOps <' + gmailUser + '>'),
        to: recipientEmail, subject, html,
      });
      console.log('[send-push] Gmail email sent to', recipientEmail);
      return;
    } catch (gmailErr) {
      console.log('[send-push] Gmail failed, trying Resend:', gmailErr.message);
    }
  }

  // Fallback: Resend
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.log('[send-push] No RESEND_API_KEY — skipping email'); return; }
  const from = process.env.RESEND_FROM || 'StayOps <noreply@app.stayops.com.au>';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from, to: recipientEmail, subject, html,
        text: (title || '') + '\n\n' + (body || '') + '\n\n— StayOps',
      }),
    });
    const data = await res.json();
    if (res.ok) {
      console.log('[send-push] Resend email sent to', recipientEmail, 'id:', data.id || 'n/a');
    } else {
      console.log('[send-push] Resend email failed:', data.message || res.status);
    }
  } catch (e) {
    console.error('[send-push] Email failed:', e.message);
  }
}

async function resolveUserEmail(sb, userId) {
  try {
    // Try auth.users first (most reliable)
    const { data } = await sb.auth.admin.getUserById(userId);
    if (data && data.user && data.user.email) return data.user.email;
  } catch (_) { /* ignore */ }
  try {
    // Fallback: app_config table
    const { data } = await sb.from('app_config').select('owner_email').eq('user_id', userId).maybeSingle();
    if (data && data.owner_email) return data.owner_email;
  } catch (_) { /* ignore */ }
  return null;
}

const { verifyAuth } = require('./utils/auth');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { ...CORS, 'Access-Control-Allow-Headers': 'Content-Type, Authorization' }, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' })
    };
  }

  const authUser = await verifyAuth(event);
  if (authUser.error) return authUser.error;

  try {
    let payload;
    try {
      payload = JSON.parse(event.body || '{}');
    } catch (parseErr) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ ok: false, error: 'Invalid JSON body', code: 'INVALID_JSON', details: parseErr.message })
      };
    }

    const { subscription, user_id, title, body, url, tag, skipEmail, email: directEmail } = payload;

    if (!title) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ ok: false, error: 'Missing title', code: 'MISSING_FIELDS' })
      };
    }

    if (!subscription && !user_id) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ ok: false, error: 'Missing subscription or user_id', code: 'MISSING_FIELDS' })
      };
    }

    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
      return {
        statusCode: 500,
        headers: CORS,
        body: JSON.stringify({
          ok: false,
          error: 'Missing VAPID environment variables',
          code: 'MISSING_VAPID_ENV',
          missing: [
            !process.env.VAPID_PUBLIC_KEY ? 'VAPID_PUBLIC_KEY' : null,
            !process.env.VAPID_PRIVATE_KEY ? 'VAPID_PRIVATE_KEY' : null
          ].filter(Boolean)
        })
      };
    }

    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:noreply@app.stayops.com.au',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );

    const pushPayload = JSON.stringify({ title, body: body || '', url: url || '/', tag: tag || 'stayops' });

    // ── user_id mode: look up all subscriptions from app_config ──
    if (user_id) {
      const { createClient } = require('@supabase/supabase-js');
      const sbUrl = process.env.SUPABASE_URL;
      const sbKey = process.env.SUPABASE_SERVICE_KEY;
      if (!sbUrl || !sbKey) {
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: 'Supabase not configured', code: 'NO_SUPABASE' }) };
      }
      const sb = createClient(sbUrl, sbKey);
      const { data, error: dbErr } = await sb
        .from('app_config')
        .select('push_subscriptions')
        .eq('user_id', user_id)
        .maybeSingle();

      if (dbErr || !data) {
        console.log('[send-push] No app_config for user_id', user_id, dbErr);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, sent: 0, reason: 'no-config' }) };
      }

      const rawSubs = Array.isArray(data.push_subscriptions) ? data.push_subscriptions : [];
      const subs = rawSubs.filter(s => s && typeof s === 'object' && typeof s.endpoint === 'string' && s.keys && s.keys.p256dh && s.keys.auth);
      if (!subs.length) {
        console.log('[send-push] No valid push_subscriptions for user_id', user_id, '(raw count:', rawSubs.length + ')');
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, sent: 0, reason: 'no-subscriptions' }) };
      }

      let sent = 0, failed = 0;
      const staleEndpoints = [];
      for (const sub of subs) {
        try {
          await webpush.sendNotification(sub, pushPayload);
          sent++;
        } catch (e) {
          const sc = e && e.statusCode;
          console.warn('[send-push] Push failed for endpoint:', sub.endpoint, sc || e.message);
          if (sc === 404 || sc === 410) {
            staleEndpoints.push(sub.endpoint);
          }
          failed++;
        }
      }

      // Clean up stale (expired/unsubscribed) endpoints
      if (staleEndpoints.length) {
        const filtered = rawSubs.filter(s => s && s.endpoint && !staleEndpoints.includes(s.endpoint));
        await sb
          .from('app_config')
          .update({ push_subscriptions: filtered, updated_at: new Date().toISOString() })
          .eq('user_id', user_id)
          .then(() => console.log('[send-push] Removed', staleEndpoints.length, 'stale endpoints'))
          .catch(e => console.warn('[send-push] Stale cleanup failed:', e.message));
      }
      console.log('[send-push] user_id mode: sent=' + sent + ' failed=' + failed + ' stale=' + staleEndpoints.length);

      // Send email alongside push (unless skipEmail)
      if (!skipEmail) {
        const recipientEmail = directEmail || await resolveUserEmail(sb, user_id);
        await sendEmailAlongside(recipientEmail, title, body);
      }

      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, sent, failed }) };
    }

    // ── Direct subscription mode (original) ──
    if (!subscription.endpoint || !subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ ok: false, error: 'Invalid push subscription payload', code: 'INVALID_SUBSCRIPTION' })
      };
    }

    await webpush.sendNotification(subscription, pushPayload);

    // Send email alongside push for direct subscription mode
    if (!skipEmail && directEmail) {
      await sendEmailAlongside(directEmail, title, body);
    } else if (!skipEmail && user_id) {
      // If user_id was somehow passed with subscription, resolve email
      const { createClient } = require('@supabase/supabase-js');
      const sb2 = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const email = await resolveUserEmail(sb2, user_id);
      await sendEmailAlongside(email, title, body);
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };

  } catch (err) {
    // 404/410 = subscription is no longer valid (user unsubscribed / expired)
    const status = err.statusCode || 500;
    const expired = status === 404 || status === 410;
    const isWebPushConfigError = /vapid|subject|key/i.test(err && err.message ? err.message : '');
    // Parse Apple/FCM error body so the client can see the real reason code
    let apnsReason = null;
    try {
      if (err.body) {
        const parsed = typeof err.body === 'string' ? JSON.parse(err.body) : err.body;
        apnsReason = parsed.reason || parsed.error || null;
      }
    } catch (_) { /* ignore JSON parse error on push error body */ }
    console.error('[send-push] Push failed status=' + status + ' reason=' + apnsReason + ' msg=' + (err.message || ''));
    captureError(err, { tags: { function: 'send-push' } });
    await flush();
    return {
      statusCode: status,
      headers: CORS,
      body: JSON.stringify({
        ok: false,
        error: err.message || 'Push send failed',
        code: isWebPushConfigError ? 'WEBPUSH_CONFIG_ERROR' : 'PUSH_SEND_FAILED',
        apnsReason,
        expired
      })
    };
  }
};
