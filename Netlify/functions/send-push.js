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

    const { subscription, title, body, url, tag } = payload;

    if (!subscription || !title) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ ok: false, error: 'Missing subscription or title', code: 'MISSING_FIELDS' })
      };
    }

    if (!subscription.endpoint || !subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ ok: false, error: 'Invalid push subscription payload', code: 'INVALID_SUBSCRIPTION' })
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
      process.env.VAPID_SUBJECT || 'mailto:admin@glenhaven21.netlify.app',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );

    await webpush.sendNotification(
      subscription,
      JSON.stringify({ title, body: body || '', url: url || '/', tag: tag || 'glenhaven' })
    );

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
