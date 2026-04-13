// Proxies Anthropic /v1/messages for browser clients (CORS). Set ANTHROPIC_API_KEY in Netlify.

const { captureError, flush } = require('./utils/sentry');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_TOKENS = 1000;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'API key not configured' }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    console.error('[StayOps] ai-proxy: invalid JSON body', e && e.message ? e.message : e);
    return {
      statusCode: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON' }),
    };
  }

  const system = body.system;
  const messages = body.messages;
  const max_tokens =
    typeof body.max_tokens === 'number' && Number.isFinite(body.max_tokens)
      ? body.max_tokens
      : DEFAULT_MAX_TOKENS;
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : DEFAULT_MODEL;

  const payload = { model, max_tokens, messages };
  if (system != null && system !== '') payload.system = system;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    return {
      statusCode: response.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  } catch (e) {
    console.error('[StayOps] ai-proxy:', e && e.message ? e.message : e);
    captureError(e, { tags: { function: 'ai-proxy' } });
    await flush();
    return {
      statusCode: 502,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Upstream request failed' }),
    };
  }
};
