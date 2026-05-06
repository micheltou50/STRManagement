/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Gmail OAuth Start
   Redirects user to Google OAuth consent screen.
   State param = Supabase user ID (passed back in callback).

   Required Netlify env vars:
     GOOGLE_CLIENT_ID
     GOOGLE_CLIENT_SECRET
     SITE_URL               — e.g. https://app.stayops.com.au
   ═══════════════════════════════════════════════════════════════════════════ */

exports.handler = async (event) => {
  const state = (event.queryStringParameters || {}).state || '';
  if (!state) {
    return { statusCode: 400, body: 'Missing state (user ID)' };
  }

  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const SITE_URL = process.env.SITE_URL || process.env.URL || '';

  if (!CLIENT_ID || !SITE_URL) {
    return { statusCode: 500, body: 'Server misconfigured — missing GOOGLE_CLIENT_ID or SITE_URL' };
  }

  const redirectUri = SITE_URL + '/.netlify/functions/gmail-oauth-callback';
  const scope = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/userinfo.email',
  ].join(' ');

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });

  return {
    statusCode: 302,
    headers: { Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString() },
    body: '',
  };
};
