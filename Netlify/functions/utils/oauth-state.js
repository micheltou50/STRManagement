// Netlify/functions/utils/oauth-state.js
//
// Signed, expiring OAuth `state` tokens (ANALYSIS 4.5).
//
// The OAuth connect flows are top-level browser navigations, so they can't carry
// the Supabase JWT. Trusting a raw client-supplied `state=<uid>` let an attacker
// bind their own mailbox/calendar to a victim's account (account-linking CSRF).
// Instead the user id is minted into a signed token from a VERIFIED session
// (see oauth-state.js endpoint) and verified here in the callbacks — never
// trusted as a raw value.

const crypto = require('crypto');

const TTL_MS = 15 * 60 * 1000; // 15 minutes

function _secret() {
  // Prefer a dedicated secret; fall back to the service key (always present in
  // these functions' env) so the flow works without adding a new env var.
  return (
    process.env.OAUTH_STATE_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    ''
  );
}

function _b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function _hmac(payloadB64) {
  return _b64url(crypto.createHmac('sha256', _secret()).update(payloadB64).digest());
}

/** Mint a signed state token for an authenticated user id. */
function signState(uid) {
  if (!uid) throw new Error('signState: uid required');
  const payloadB64 = _b64url(JSON.stringify({ uid: String(uid), exp: Date.now() + TTL_MS }));
  return payloadB64 + '.' + _hmac(payloadB64);
}

/** Verify a state token; returns the uid if the signature is valid and the
 *  token is unexpired, otherwise null. */
function verifyState(state) {
  if (!state || typeof state !== 'string' || !_secret()) return null;
  const dot = state.lastIndexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = state.slice(0, dot);
  const sig = Buffer.from(state.slice(dot + 1));
  const expected = Buffer.from(_hmac(payloadB64));
  // Constant-time compare; differing lengths can't match (timingSafeEqual throws).
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    );
  } catch (_e) {
    return null;
  }
  if (!payload || !payload.uid || !payload.exp || Date.now() > payload.exp) return null;
  return String(payload.uid);
}

module.exports = { signState, verifyState };
