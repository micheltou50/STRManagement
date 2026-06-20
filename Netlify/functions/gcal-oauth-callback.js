/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Google Calendar OAuth Callback
   Exchanges auth code for tokens, creates a dedicated "StayOps" calendar
   in the user's account, registers a push channel for change notifications,
   and stores everything in email_connections (provider='google_calendar').

   Required Netlify env vars:
     GOOGLE_CLIENT_ID
     GOOGLE_CLIENT_SECRET
     SITE_URL
     SUPABASE_URL
     SUPABASE_SERVICE_KEY
   ═══════════════════════════════════════════════════════════════════════════ */

const { createClient } = require('@supabase/supabase-js');
const { captureError, flush } = require('./utils/sentry');
const { verifyState } = require('./utils/oauth-state');
const gcal = require('./utils/gcal-client');
const crypto = require('crypto');

const CALENDAR_NAME = 'StayOps';

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const code = params.code;
  let state = params.state;
  const oauthErr = params.error;

  const SITE_URL = process.env.SITE_URL || process.env.URL || '';

  if (oauthErr) return redirect(SITE_URL + '/?cal_oauth_error=' + encodeURIComponent(oauthErr));
  if (!code || !state) return redirect(SITE_URL + '/?cal_oauth_error=missing_code_or_state');
  // 4.5: `state` is a signed token minted from the authenticated session.
  // Verify it and replace it with the trusted user id (also used below as the
  // watch channel token). A forged or expired state is rejected here.
  state = verifyState(state);
  if (!state) return redirect(SITE_URL + '/?cal_oauth_error=invalid_state');

  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!CLIENT_ID || !CLIENT_SECRET || !SUPABASE_URL || !SUPABASE_KEY) {
    return redirect(SITE_URL + '/?cal_oauth_error=server_misconfigured');
  }

  const redirectUri = SITE_URL + '/.netlify/functions/gcal-oauth-callback';

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
      console.error('[gcal-oauth-callback] Token exchange failed:', tokens);
      return redirect(SITE_URL + '/?cal_oauth_error=token_exchange_failed');
    }

    // 2. Get user email
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: 'Bearer ' + tokens.access_token },
    });
    const profile = await profileRes.json();
    const email = profile.email || '';

    // 3. Reuse an existing StayOps calendar if present, else create one
    let calendarId = null;
    try {
      const listRes = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
        headers: { Authorization: 'Bearer ' + tokens.access_token },
      });
      const list = await listRes.json();
      const existing = (list.items || []).find(c => c.summary === CALENDAR_NAME);
      if (existing) calendarId = existing.id;
    } catch (e) {
      console.warn('[gcal-oauth-callback] calendarList probe failed:', e.message);
    }
    if (!calendarId) {
      const cal = await gcal.createCalendar(tokens.access_token, CALENDAR_NAME);
      calendarId = cal.id;
    }

    // 4. Register push channel (events.watch). Best-effort — failure is non-fatal,
    //    polling fallback (calendar-sync-reconcile) covers it.
    let watchChannelId = null;
    let watchResourceId = null;
    let watchExpiresAt = null;
    try {
      const channelId = 'stayops-' + state + '-' + Date.now();
      const watchUrl = SITE_URL + '/.netlify/functions/gcal-webhook';
      const watch = await gcal.watchEvents(tokens.access_token, calendarId, channelId, watchUrl, state);
      watchChannelId = watch.id;
      watchResourceId = watch.resourceId;
      watchExpiresAt = watch.expiration ? new Date(Number(watch.expiration)).toISOString() : null;
    } catch (e) {
      console.warn('[gcal-oauth-callback] watch registration failed (non-fatal):', e.message);
    }

    // 5. Persist
    const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
    const expiry = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;

    // Only include refresh_token if Google actually sent one — avoid overwriting a valid token with null
    const upsertPayload = {
      user_id:           state,
      email,
      provider:          'google_calendar',
      access_token:      tokens.access_token,
      token_expiry:      expiry,
      calendar_id:       calendarId,
      watch_channel_id:  watchChannelId,
      watch_resource_id: watchResourceId,
      watch_expires_at:  watchExpiresAt,
      sync_token:        null,
      updated_at:        new Date().toISOString(),
    };
    if (tokens.refresh_token) {
      upsertPayload.refresh_token = tokens.refresh_token;
    }

    const { error: dbError } = await sb
      .from('email_connections')
      .upsert(upsertPayload, { onConflict: 'user_id,provider' });

    if (dbError) {
      console.error('[gcal-oauth-callback] Upsert failed:', dbError.message);
      return redirect(SITE_URL + '/?cal_oauth_error=db_upsert_failed');
    }

    return redirect(SITE_URL + '/?cal_oauth_success=google&cal_email=' + encodeURIComponent(email));
  } catch (err) {
    console.error('[gcal-oauth-callback] Error:', err);
    captureError(err, { tags: { function: 'gcal-oauth-callback' } });
    await flush();
    return redirect(SITE_URL + '/?cal_oauth_error=internal_error');
  }
};

function redirect(url) {
  return { statusCode: 302, headers: { Location: url }, body: '' };
}

// crypto imported but not used — silence linters that flag unused requires.
void crypto;
