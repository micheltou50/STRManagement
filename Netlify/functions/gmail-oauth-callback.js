/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Gmail OAuth Callback
   Exchanges auth code for tokens, stores refresh_token in Supabase
   email_connections, then redirects back to the app with success/error status.

   Required Netlify env vars:
     GOOGLE_CLIENT_ID
     GOOGLE_CLIENT_SECRET
     SITE_URL
     SUPABASE_URL
     SUPABASE_SERVICE_KEY
   ═══════════════════════════════════════════════════════════════════════════ */

const { createClient } = require('@supabase/supabase-js');
const { captureError, flush } = require('./utils/sentry');

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const code = params.code;
  const state = params.state; // user_id
  const error = params.error;

  const SITE_URL = process.env.SITE_URL || process.env.URL || '';

  if (error) {
    return redirect(SITE_URL + '/?oauth_error=' + encodeURIComponent(error));
  }
  if (!code || !state) {
    return redirect(SITE_URL + '/?oauth_error=missing_code_or_state');
  }

  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!CLIENT_ID || !CLIENT_SECRET || !SUPABASE_URL || !SUPABASE_KEY) {
    return redirect(SITE_URL + '/?oauth_error=server_misconfigured');
  }

  const redirectUri = SITE_URL + '/.netlify/functions/gmail-oauth-callback';

  try {
    // 1. Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });

    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.access_token) {
      console.error('[gmail-oauth-callback] Token exchange failed:', tokens);
      return redirect(SITE_URL + '/?oauth_error=token_exchange_failed');
    }

    // 2. Get user email
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: 'Bearer ' + tokens.access_token },
    });
    const profile = await profileRes.json();
    const email = profile.email || '';

    // 3. Store refresh token + email in Supabase email_connections
    const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

    const { error: dbError } = await sb
      .from('email_connections')
      .upsert({
        user_id:       state,
        email,
        provider:      'google',
        refresh_token: tokens.refresh_token || null,
        updated_at:    new Date().toISOString(),
      }, { onConflict: 'user_id,provider' });

    if (dbError) {
      console.error('[gmail-oauth-callback] Upsert failed:', dbError.message);
    }

    // Log whether refresh token was received
    console.log('[gmail-oauth-callback] refresh_token received:', !!tokens.refresh_token, 'email:', email);

    // 4. Redirect back to app
    return redirect(SITE_URL + '/?oauth_success=google&oauth_email=' + encodeURIComponent(email));

  } catch (err) {
    console.error('[gmail-oauth-callback] Error:', err);
    captureError(err, { tags: { function: 'gmail-oauth-callback' } });
    await flush();
    return redirect(SITE_URL + '/?oauth_error=internal_error');
  }
};

function redirect(url) {
  return { statusCode: 302, headers: { Location: url }, body: '' };
}
