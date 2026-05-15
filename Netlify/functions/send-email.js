// Netlify/functions/send-email.js
// Sends emails via Resend API with retry. No Gmail fallback.
//
// Required env: RESEND_API_KEY (+ optional RESEND_FROM)

const { verifyAuth } = require('./utils/auth');
const { captureError, flush } = require('./utils/sentry');
const emailTemplates = require('./utils/email-templates');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' }, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const authUser = await verifyAuth(event);
  if (authUser.error) return authUser.error;

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { to, subject, html: rawHtml, attachments, template, templateData } = payload;

  let html = rawHtml;
  if (template && templateData && emailTemplates[template]) {
    html = emailTemplates[template](templateData);
  }

  if (!to || !subject || !html) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing required fields: to, subject, html (or template + templateData)' })
    };
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.error('[send-email] RESEND_API_KEY not set');
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Email not configured — set RESEND_API_KEY' })
    };
  }

  const from = process.env.RESEND_FROM || 'StayOps <info@stayops.com.au>';
  const maxAttempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + resendKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ from, to, subject, html, ...(attachments ? { attachments } : {}) })
      });

      const data = await response.json();

      if (response.ok) {
        console.log('[send-email] Resend sent:', data.id, 'to:', to);
        return {
          statusCode: 200,
          body: JSON.stringify({ success: true, id: data.id, provider: 'resend' })
        };
      }
      lastError = data.message || 'Resend API error';
      console.error('[send-email] Resend attempt', attempt, 'failed:', lastError);
    } catch (err) {
      lastError = err.message;
      console.error('[send-email] Resend attempt', attempt, 'failed:', lastError);
    }
    if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 1000 * attempt));
  }

  captureError(new Error('Resend failed after ' + maxAttempts + ' attempts: ' + lastError), { tags: { function: 'send-email' } });
  await flush();
  return {
    statusCode: 500,
    body: JSON.stringify({ error: 'Email send failed after ' + maxAttempts + ' attempts', lastError })
  };
};
