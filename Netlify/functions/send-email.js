// Netlify/functions/send-email.js
// Sends cleaner assignment emails via Resend API
// Set RESEND_API_KEY and RESEND_FROM in Netlify environment variables.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { to, subject, html } = payload;

  // API key and from address live server-side — never sent from the browser
  const apiKey = process.env.RESEND_API_KEY;
  const from   = process.env.RESEND_FROM || 'Glenhaven <noreply@glenhaven21.netlify.app>';

  if (!apiKey) {
    console.error('[send-email] RESEND_API_KEY env var is not set');
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Email not configured — set RESEND_API_KEY in Netlify environment variables' })
    };
  }

  if (!to || !subject || !html) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing required fields: to, subject, html' })
    };
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from, to, subject, html })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Resend error:', data);
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: data.message || 'Resend API error', detail: data })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, id: data.id })
    };
  } catch (err) {
    console.error('send-email error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
