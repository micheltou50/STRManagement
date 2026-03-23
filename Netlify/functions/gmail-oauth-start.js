// ── Netlify function: gmail-oauth-start.js ────────────────────────────────────
// Redirects the user to Google's OAuth consent screen.
// Called from the client when they tap "Connect Gmail".
//
// Required environment variables:
//   GOOGLE_CLIENT_ID     — from Google Cloud Console → OAuth 2.0 credentials
//   GOOGLE_REDIRECT_URI  — must match exactly what's in Google Cloud Console
//                          e.g. https://strmanagement.netlify.app/.netlify/functions/gmail-oauth-callback
//
// Usage: redirect the browser to /.netlify/functions/gmail-oauth-start?state=<user_id>

exports.handler = async (event) => {
  const clientId    = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI
    || 'https://strmanagement.netlify.app/.netlify/functions/gmail-oauth-callback';

  if (!clientId) {
    return { statusCode: 500, body: JSON.stringify({ error: 'GOOGLE_CLIENT_ID not set' }) };
  }

  const state = event.queryStringParameters?.state || '';

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ].join(' '),
    access_type:   'offline',   // get refresh token
    prompt:        'consent',   // always show consent so we always get refresh token
    state,
  });

  return {
    statusCode: 302,
    headers: { Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString() },
    body: '',
  };
};
