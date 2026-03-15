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
    return { statusCode: 405, headers: CORS, body: 'Method not allowed' };
  }

  try {
    const { subscription, title, body, url, tag } = JSON.parse(event.body || '{}');

    if (!subscription || !title) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing subscription or title' }) };
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
    // 410 Gone = subscription is no longer valid (user unsubscribed)
    const status = err.statusCode || 500;
    return {
      statusCode: status,
      headers: CORS,
      body: JSON.stringify({ error: err.message, expired: status === 410 })
    };
  }
};
