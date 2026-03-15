// Netlify/functions/ai.js
// Proxies Claude API calls server-side so the API key never touches the browser.
// Set ANTHROPIC_API_KEY in your Netlify site's environment variables.

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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[ai] ANTHROPIC_API_KEY env var is not set');
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'AI not configured — set ANTHROPIC_API_KEY in Netlify environment variables' })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { model, max_tokens, messages, system } = body;

  if (!model || !Array.isArray(messages) || !messages.length) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing required fields: model, messages' }) };
  }

  // Block models we don't use (defence in depth — prevent abuse if endpoint is hit directly)
  const ALLOWED_MODELS = [
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-20250514',
  ];
  if (!ALLOWED_MODELS.includes(model)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Model not permitted' }) };
  }

  const payload = {
    model,
    max_tokens: Math.min(Number(max_tokens) || 1000, 8000), // cap tokens
    messages
  };
  if (system) payload.system = system;
  // Prefill assistant turn if provided (used by expense analyser)
  // Already included in messages array from client, no special handling needed

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    return {
      statusCode: response.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    };
  } catch (err) {
    console.error('[ai] Anthropic API error:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message })
    };
  }
};
