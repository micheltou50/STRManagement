// Netlify/functions/oauth-state.js
//
// Mints a short-lived, signed OAuth `state` token bound to the AUTHENTICATED
// user (ANALYSIS 4.5). The connect buttons call this (with the Supabase JWT)
// before redirecting to a *-oauth-start function, so the user id carried in
// `state` comes from a verified session — not a client-supplied query param.

const { verifyAuth } = require('./utils/auth');
const { signState } = require('./utils/oauth-state');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'POST only' }) };
  }
  const authUser = await verifyAuth(event);
  if (authUser.error) return authUser.error;
  try {
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: signState(authUser.id) }),
    };
  } catch (_e) {
    return { statusCode: 500, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Could not mint state' }) };
  }
};
