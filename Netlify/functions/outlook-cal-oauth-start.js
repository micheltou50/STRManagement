/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Outlook Calendar OAuth Start
   Redirects user to Microsoft's OAuth consent screen with calendar scope.
   State param = Supabase user ID (passed back in callback).

   Required Netlify env vars:
     MICROSOFT_CLIENT_ID
     MICROSOFT_TENANT_ID            (default 'common')
     MICROSOFT_CAL_REDIRECT_URI     (optional, falls back to SITE_URL + path)
     SITE_URL
   ═══════════════════════════════════════════════════════════════════════════ */

exports.handler = async (event) => {
  const state = (event.queryStringParameters || {}).state || '';
  if (!state) return { statusCode: 400, body: 'Missing state (user ID)' };

  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const tenantId = process.env.MICROSOFT_TENANT_ID || 'common';
  const SITE_URL = process.env.SITE_URL || process.env.URL || '';
  const redirectUri = process.env.MICROSOFT_CAL_REDIRECT_URI
    || (SITE_URL + '/.netlify/functions/outlook-cal-oauth-callback');

  if (!clientId) {
    return { statusCode: 500, body: JSON.stringify({ error: 'MICROSOFT_CLIENT_ID not set' }) };
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope: [
      'https://graph.microsoft.com/Calendars.ReadWrite',
      'https://graph.microsoft.com/User.Read',
      'offline_access',
    ].join(' '),
    prompt: 'consent',
    state,
  });

  return {
    statusCode: 302,
    headers: { Location: 'https://login.microsoftonline.com/' + tenantId + '/oauth2/v2.0/authorize?' + params.toString() },
    body: '',
  };
};
