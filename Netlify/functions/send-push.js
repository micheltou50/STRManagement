const webpush = require('web-push');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' })
    };
  }

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

    const { subscription, user_id, title, body, url, tag } = payload;

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
      process.env.VAPID_SUBJECT || 'mailto:micheltou50@gmail.com',
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
    } catch (_) {}
    console.error('[send-push] Push failed status=' + status + ' reason=' + apnsReason + ' msg=' + (err.message || ''));
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
