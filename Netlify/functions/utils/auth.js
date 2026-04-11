/**
 * StayOps — lightweight auth guard for Netlify functions.
 *
 * Verifies the caller is an authenticated Supabase user by checking
 * the Authorization header against Supabase Auth.
 *
 * Usage:
 *   const { verifyAuth } = require('./utils/auth');
 *   const user = await verifyAuth(event);
 *   if (user.error) return user.error; // returns a 401 response object
 *   // user.id is the authenticated user ID
 */

const { createClient } = require('@supabase/supabase-js');

function getHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const want = String(name).toLowerCase();
  for (const k of Object.keys(headers)) {
    if (String(k).toLowerCase() === want) return String(headers[k] || '');
  }
  return '';
}

async function verifyAuth(event) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return { error: { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Server misconfigured' }) } };
  }

  const authHeader = getHeader(event.headers, 'authorization');
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (!token) {
    return { error: { statusCode: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Missing authorization token' }) } };
  }

  try {
    const sb = createClient(supabaseUrl, supabaseKey);
    const { data, error } = await sb.auth.getUser(token);
    if (error || !data || !data.user) {
      return { error: { statusCode: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Invalid or expired token' }) } };
    }
    return { id: data.user.id, email: data.user.email, user: data.user };
  } catch (e) {
    return { error: { statusCode: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Auth verification failed' }) } };
  }
}

module.exports = { verifyAuth };
