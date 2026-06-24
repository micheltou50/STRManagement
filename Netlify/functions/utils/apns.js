/**
 * StayOps — minimal APNs sender (HTTP/2 + token auth) for native iOS push.
 *
 * Uses an APNs Auth Key (.p8) to sign a short-lived ES256 JWT — no certificates,
 * no extra npm deps (Node's built-in http2 + crypto only).
 *
 * Netlify env vars:
 *   APNS_KEY_ID      — the 10-char Key ID of the .p8 auth key
 *   APNS_TEAM_ID     — your Apple Developer Team ID
 *   APNS_AUTH_KEY    — the .p8 contents (PEM). May be stored base64-encoded
 *                      on a single line (decoded automatically here).
 *   APNS_BUNDLE_ID   — apns-topic (default com.mtmanagement.stayops)
 *   APNS_PRODUCTION  — 'false' => sandbox; anything else (incl. unset) => prod.
 *                      TestFlight/App Store builds use the production gateway.
 */

const http2 = require('http2');
const crypto = require('crypto');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function getAuthKeyPem() {
  let key = (process.env.APNS_AUTH_KEY || '').trim();
  if (!key) return '';
  // Allow the key to be stored base64-encoded (single line, survives env vars).
  if (!key.includes('BEGIN')) {
    try { key = Buffer.from(key, 'base64').toString('utf8').trim(); } catch (_) { /* keep as-is */ }
  }
  return key.replace(/\\n/g, '\n');
}

function isConfigured() {
  return !!(process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID && process.env.APNS_AUTH_KEY);
}

let _jwt = null;
let _jwtAt = 0;
function apnsJwt() {
  const now = Math.floor(Date.now() / 1000);
  // APNs provider tokens are valid up to 60 min; refresh every ~50 min.
  if (_jwt && (now - _jwtAt) < 3000) return _jwt;
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const pem = getAuthKeyPem();
  if (!keyId || !teamId || !pem) throw new Error('APNs not configured');
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const payload = b64url(JSON.stringify({ iss: teamId, iat: now }));
  const signingInput = header + '.' + payload;
  // ES256 JWT needs the raw r||s signature, not DER — dsaEncoding does that.
  const sig = crypto.createSign('SHA256').update(signingInput).sign({ key: pem, dsaEncoding: 'ieee-p1363' });
  _jwt = signingInput + '.' + b64url(sig);
  _jwtAt = now;
  return _jwt;
}

/**
 * Send an alert push to the given APNs device tokens.
 * @returns {Promise<{ sent: number, stale: string[] }>} stale tokens to delete.
 */
async function sendApns(tokens, { title, body, data } = {}) {
  const list = (Array.isArray(tokens) ? tokens : []).filter(Boolean);
  if (!list.length || !isConfigured()) return { sent: 0, stale: [] };

  const host = process.env.APNS_PRODUCTION === 'false'
    ? 'https://api.sandbox.push.apple.com'
    : 'https://api.push.apple.com';
  const topic = process.env.APNS_BUNDLE_ID || 'com.mtmanagement.stayops';

  let jwt;
  try { jwt = apnsJwt(); } catch (e) { console.log('[apns] jwt error:', e.message); return { sent: 0, stale: [] }; }

  const payload = JSON.stringify({
    aps: { alert: { title: title || 'StayOps', body: body || '' }, sound: 'default' },
    ...(data && typeof data === 'object' ? data : {}),
  });

  const client = http2.connect(host);
  const stale = [];
  let sent = 0;
  await new Promise((resolve) => {
    let pending = list.length;
    const done = () => { if (--pending <= 0) resolve(); };
    client.on('error', (e) => { console.log('[apns] connection error:', e.message); resolve(); });
    for (const token of list) {
      const req = client.request({
        ':method': 'POST',
        ':path': '/3/device/' + token,
        authorization: 'bearer ' + jwt,
        'apns-topic': topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
      });
      let status = 0;
      let respBody = '';
      req.on('response', (h) => { status = h[':status']; });
      req.setEncoding('utf8');
      req.on('data', (d) => { respBody += d; });
      req.on('end', () => {
        if (status === 200) {
          sent++;
        } else {
          let reason = '';
          try { reason = JSON.parse(respBody).reason || ''; } catch (_) { /* ignore */ }
          if (status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered') stale.push(token);
          console.log('[apns] failed token=' + String(token).slice(0, 8) + '… status=' + status + ' reason=' + reason);
        }
        done();
      });
      req.on('error', (e) => { console.log('[apns] request error:', e.message); done(); });
      req.end(payload);
    }
  });
  try { client.close(); } catch (_) { /* ignore */ }
  return { sent, stale };
}

module.exports = { sendApns, isConfigured };
