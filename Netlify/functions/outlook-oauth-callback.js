// ── Netlify function: outlook-oauth-callback.js ──────────────────────────────
// Handles the OAuth callback from Microsoft after the user grants permission.
//
// Required environment variables:
//   MICROSOFT_CLIENT_ID
//   MICROSOFT_CLIENT_SECRET  — from Azure Portal
//   MICROSOFT_REDIRECT_URI
//   MICROSOFT_TENANT_ID      — 'common' for personal + work accounts
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY

const { createClient } = require('@supabase/supabase-js');
const { captureError, flush } = require('./utils/sentry');
const { verifyState } = require('./utils/oauth-state');

exports.handler = async (event) => {
  const code   = event.queryStringParameters?.code;
  let state    = event.queryStringParameters?.state || '';
  const error  = event.queryStringParameters?.error;

  const appUrl   = process.env.URL || 'https://app.stayops.com.au';
  const tenantId = process.env.MICROSOFT_TENANT_ID || 'common';

  if (error) {
    return { statusCode: 302, headers: { Location: appUrl + '?oauth_error=' + error }, body: '' };
  }

  if (!code) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing code' }) };
  }

  // 4.5: `state` is a signed token minted from the authenticated session.
  // Verify it and replace it with the trusted user id; a forged, expired, or
  // EMPTY state (the old code accepted empty state -> a user_id:null row) is
  // rejected here.
  state = verifyState(state);
  if (!state) {
    return { statusCode: 302, headers: { Location: appUrl + '?oauth_error=invalid_state' }, body: '' };
  }

  const clientId     = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const redirectUri  = process.env.MICROSOFT_REDIRECT_URI
    || appUrl + '/.netlify/functions/outlook-oauth-callback';

  try {
    // 1. Exchange code for tokens
    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id:     clientId,
          client_secret: clientSecret,
          redirect_uri:  redirectUri,
          grant_type:    'authorization_code',
          scope: 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read offline_access',
        }),
      }
    );

    const tokens = await tokenRes.json();
    if (!tokens.access_token) {
      throw new Error('Token exchange failed: ' + JSON.stringify(tokens));
    }

    // 2. Get user's email address via Microsoft Graph
    const userRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: 'Bearer ' + tokens.access_token },
    });
    const userInfo = await userRes.json();
    const email = userInfo.mail || userInfo.userPrincipalName;

    // 3. Store tokens in Supabase
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const expiry = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;

    // Only include refresh_token if provider actually sent one — avoid overwriting a valid token with null
    const upsertPayload = {
      user_id:       state || null,
      email,
      provider:      'microsoft',
      access_token:  tokens.access_token,
      token_expiry:  expiry,
      updated_at:    new Date().toISOString(),
    };
    if (tokens.refresh_token) {
      upsertPayload.refresh_token = tokens.refresh_token;
    }

    const { error: dbError } = await sb
      .from('email_connections')
      .upsert(upsertPayload, { onConflict: 'user_id,provider' });

    if (dbError) throw new Error('Supabase error: ' + dbError.message);

    // 4. Redirect back to app with success
    return {
      statusCode: 302,
      headers: { Location: appUrl + '?oauth_success=microsoft&email=' + encodeURIComponent(email) },
      body: '',
    };
  } catch (err) {
    console.error('[outlook-oauth-callback] Error:', err.message);
    captureError(err, { tags: { function: 'outlook-oauth-callback' } });
    await flush();
    return {
      statusCode: 302,
      headers: { Location: appUrl + '?oauth_error=' + encodeURIComponent(err.message) },
      body: '',
    };
  }
};
