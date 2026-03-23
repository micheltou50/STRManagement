// ── Netlify function: gmail-oauth-callback.js ─────────────────────────────────
// Handles the OAuth callback from Google after the user grants permission.
// Exchanges the auth code for tokens and stores them in Supabase.
//
// Required environment variables:
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET  — from Google Cloud Console
//   GOOGLE_REDIRECT_URI
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY  — use service role key (not anon) to write to email_connections

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const code   = event.queryStringParameters?.code;
  const state  = event.queryStringParameters?.state || ''; // user_id passed through
  const error  = event.queryStringParameters?.error;

  const appUrl = process.env.URL || 'https://strmanagement.netlify.app';

  if (error) {
    return { statusCode: 302, headers: { Location: appUrl + '?oauth_error=' + error }, body: '' };
  }

  if (!code) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing code' }) };
  }

  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri  = process.env.GOOGLE_REDIRECT_URI
    || appUrl + '/.netlify/functions/gmail-oauth-callback';

  try {
    // 1. Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
      }),
    });

    const tokens = await tokenRes.json();
    if (!tokens.access_token) {
      throw new Error('Token exchange failed: ' + JSON.stringify(tokens));
    }

    // 2. Get user's email address
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: 'Bearer ' + tokens.access_token },
    });
    const userInfo = await userRes.json();
    const email = userInfo.email;

    // 3. Store tokens in Supabase
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const expiry = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;

    const { error: dbError } = await sb
      .from('email_connections')
      .upsert({
        user_id:       state || null,  // Supabase user ID passed as state
        email,
        provider:      'google',
        access_token:  tokens.access_token,
        refresh_token: tokens.refresh_token || null,
        token_expiry:  expiry,
        updated_at:    new Date().toISOString(),
      }, { onConflict: 'user_id' });

    if (dbError) throw new Error('Supabase error: ' + dbError.message);

    // 4. Redirect back to app with success signal
    return {
      statusCode: 302,
      headers: { Location: appUrl + '?oauth_success=google&email=' + encodeURIComponent(email) },
      body: '',
    };
  } catch (err) {
    console.error('[gmail-oauth-callback] Error:', err.message);
    return {
      statusCode: 302,
      headers: { Location: appUrl + '?oauth_error=' + encodeURIComponent(err.message) },
      body: '',
    };
  }
};
