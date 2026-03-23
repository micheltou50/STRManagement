// ── Netlify function: outlook-oauth-start.js ─────────────────────────────────
// Redirects the user to Microsoft's OAuth consent screen.
// Called from the client when they tap "Connect Outlook / Hotmail".
//
// Required environment variables:
//   MICROSOFT_CLIENT_ID    — from Azure Portal → App registrations
//   MICROSOFT_REDIRECT_URI — e.g. https://strmanagement.netlify.app/.netlify/functions/outlook-oauth-callback
//   MICROSOFT_TENANT_ID    — use 'common' to support personal + work accounts

exports.handler = async (event) => {
  const clientId    = process.env.MICROSOFT_CLIENT_ID;
  const tenantId    = process.env.MICROSOFT_TENANT_ID || 'common';
  const redirectUri = process.env.MICROSOFT_REDIRECT_URI
    || 'https://strmanagement.netlify.app/.netlify/functions/outlook-oauth-callback';

  if (!clientId) {
    return { statusCode: 500, body: JSON.stringify({ error: 'MICROSOFT_CLIENT_ID not set' }) };
  }

  const state = event.queryStringParameters?.state || '';

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope: [
      'https://graph.microsoft.com/Mail.Read',
      'https://graph.microsoft.com/User.Read',
      'offline_access',  // required to get refresh token
    ].join(' '),
    response_mode: 'query',
    state,
  });

  return {
    statusCode: 302,
    headers: {
      Location: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?` + params.toString()
    },
    body: '',
  };
};
