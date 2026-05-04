/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Google Calendar OAuth Start
   Redirects user to Google's OAuth consent screen with calendar scope.
   State param = Supabase user ID (passed back in callback).

   Required Netlify env vars:
     GOOGLE_CLIENT_ID
     SITE_URL
   ═══════════════════════════════════════════════════════════════════════════ */

exports.handler = async (event) => {
  const state = (event.queryStringParameters || {}).state || '';
  if (!state) return { statusCode: 400, body: 'Missing state (user ID)' };

  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const SITE_URL = process.env.SITE_URL || process.env.URL || '';
  if (!CLIENT_ID || !SITE_URL) {
    return { statusCode: 500, body: 'Server misconfigured — missing GOOGLE_CLIENT_ID or SITE_URL' };
  }

  const redirectUri = SITE_URL + '/.netlify/functions/gcal-oauth-callback';
  const scope = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/userinfo.email',
  ].join(' ');

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });

  return {
    statusCode: 302,
    headers: { Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString() },
    body: '',
  };
};
