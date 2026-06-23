// Proxies Anthropic /v1/messages for browser clients. Set ANTHROPIC_API_KEY in Netlify.
//
// Auth: requires a valid Supabase JWT (same verifyAuth pattern as send-email /
// send-push / fetch-listing). The frontend AI layer (ai-logic.js, bank-import.js)
// sends the user's access token as a Bearer Authorization header. This stops the
// proxy from being an open relay to the Anthropic API on the host's bill.
//
// Auth (Supabase JWT, checked below) is the real guard against abuse — without a
// valid session this proxy returns 401, so it is never an open relay. CORS is
// set to '*' so the Capacitor native shell (origin capacitor://localhost) can
// reach it too; same-origin web callers are unaffected.

const { captureError, flush } = require('./utils/sentry');
const { verifyAuth } = require('./utils/auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_TOKENS = 1000;
// Hard server-side ceiling. The largest legitimate caller asks for 8000
// (bank-import PDF parsing), so 8192 accommodates every real call while
// preventing a caller from requesting an unbounded (cost-amplifying) value.
const MAX_MAX_TOKENS = 8192;

const ALLOWED_MODELS = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6',
];

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

  // Require an authenticated Supabase session.
  const auth = await verifyAuth(event);
  if (auth.error) {
    return { ...auth.error, headers: { ...CORS, ...(auth.error.headers || {}), 'Content-Type': 'application/json' } };
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
  const requestedMaxTokens =
    typeof body.max_tokens === 'number' && Number.isFinite(body.max_tokens)
      ? body.max_tokens
      : DEFAULT_MAX_TOKENS;
  // Clamp to [1, MAX_MAX_TOKENS] — never trust a caller-supplied ceiling.
  const max_tokens = Math.min(Math.max(1, Math.floor(requestedMaxTokens)), MAX_MAX_TOKENS);
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : DEFAULT_MODEL;

  if (!ALLOWED_MODELS.includes(model)) {
    return {
      statusCode: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Model not allowed' }),
    };
  }

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
