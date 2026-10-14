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
const crypto = require('node:crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  } catch (_e) {
    return { error: { statusCode: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Auth verification failed' }) } };
  }
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a || ''));
  const B = Buffer.from(String(b || ''));
  return A.length > 0 && A.length === B.length && crypto.timingSafeEqual(A, B);
}

// Ask Supabase Auth whether a token has admin rights. Works for both the
// legacy JWT service_role key and the newer secret-key format, so the Netlify
// and Supabase sides don't have to hold byte-identical copies of the key.
async function isServiceRoleToken(supabaseUrl, token) {
  try {
    const res = await fetch(supabaseUrl + '/auth/v1/admin/users?page=1&per_page=1', {
      headers: { apikey: token, Authorization: 'Bearer ' + token },
    });
    return res.ok;
  } catch (_e) {
    return false;
  }
}

function requestedUid(event) {
  const q = (event && event.queryStringParameters) || {};
  if (q.uid) return String(q.uid).trim();
  try {
    const body = JSON.parse((event && event.body) || '{}');
    if (body && body.uid) return String(body.uid).trim();
  } catch (_e) { /* not JSON */ }
  return '';
}

/**
 * Like verifyAuth, but also accepts a server-to-server call authenticated with
 * the project's service-role key plus an explicit `uid` (query string or JSON
 * body). Used by scheduled scanners (Supabase poll-emails → gmail-scan-bookings)
 * that have no user session. Only a holder of the service key — who already
 * has full database access — can take this path, so trusting its `uid` is safe.
 *
 * Result carries `service: true` on the server path so callers can tell.
 */
async function verifyAuthOrService(event) {
  const user = await verifyAuth(event);
  if (!user.error) return user;
  if (user.error.statusCode !== 401) return user; // misconfigured server, etc.

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const token = getHeader(event.headers, 'authorization').replace(/^Bearer\s+/i, '').trim();
  const uid = requestedUid(event);
  if (!token || !uid) return user;

  const isService = safeEqual(token, supabaseKey) || await isServiceRoleToken(supabaseUrl, token);
  if (!isService) return user;
  if (!UUID_RE.test(uid)) {
    return { error: { statusCode: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'uid must be a UUID' }) } };
  }
  return { id: uid, email: null, user: null, service: true };
}

module.exports = { verifyAuth, verifyAuthOrService };
