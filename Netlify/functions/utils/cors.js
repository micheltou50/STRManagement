/**
 * StayOps — shared CORS for Netlify functions reachable from the native shell.
 *
 * The Capacitor iOS app calls these functions from `capacitor://localhost`,
 * which is cross-origin to the Netlify deployment. Any request carrying an
 * Authorization header (or a non-simple Content-Type) triggers a CORS
 * preflight, so cross-origin-reachable functions must answer OPTIONS and echo
 * permissive headers. `*` is safe here: these endpoints authenticate with a
 * Supabase bearer token, never cookies, so credentialed-CORS rules don't apply.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

/** True when `event` is a CORS preflight (OPTIONS) request. */
function isPreflight(event) {
  return !!event && event.httpMethod === 'OPTIONS';
}

/** Standard 204 response for a CORS preflight. */
function preflightResponse() {
  return { statusCode: 204, headers: CORS_HEADERS, body: '' };
}

/** Merge the shared CORS headers into an existing headers object. */
function withCors(headers) {
  return { ...CORS_HEADERS, ...(headers || {}) };
}

module.exports = { CORS_HEADERS, isPreflight, preflightResponse, withCors };
