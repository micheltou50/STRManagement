/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Outlook Calendar OAuth Callback
   Exchanges auth code for tokens, finds-or-creates a "StayOps" calendar in
   the user's Outlook account, registers a Graph subscription, and stores
   everything in email_connections (provider='outlook_calendar').

   Required Netlify env vars:
     MICROSOFT_CLIENT_ID
     MICROSOFT_CLIENT_SECRET
     MICROSOFT_TENANT_ID
     MICROSOFT_CAL_REDIRECT_URI    (optional)
     SITE_URL
     SUPABASE_URL
     SUPABASE_SERVICE_KEY
   ═══════════════════════════════════════════════════════════════════════════ */

const { createClient } = require('@supabase/supabase-js');
const { captureError, flush } = require('./utils/sentry');
const { verifyState } = require('./utils/oauth-state');
const out = require('./utils/outlook-cal-client');
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
  // Verify it and replace it with the trusted user id; a forged or expired
  // state is rejected here.
  state = verifyState(state);
  if (!state) return redirect(SITE_URL + '/?cal_oauth_error=invalid_state');

  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const tenantId = process.env.MICROSOFT_TENANT_ID || 'common';
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const redirectUri = process.env.MICROSOFT_CAL_REDIRECT_URI
    || (SITE_URL + '/.netlify/functions/outlook-cal-oauth-callback');

  if (!clientId || !clientSecret || !SUPABASE_URL || !SUPABASE_KEY) {
    return redirect(SITE_URL + '/?cal_oauth_error=server_misconfigured');
  }

  try {
    // 1. Exchange code for tokens
    const tokenRes = await fetch(
      'https://login.microsoftonline.com/' + tenantId + '/oauth2/v2.0/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          scope: 'https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/User.Read offline_access',
        }),
      }
    );
    const tokens = await tokenRes.json();
    if (!tokens.access_token) {
      console.error('[outlook-cal-oauth-callback] Token exchange failed:', tokens);
      return redirect(SITE_URL + '/?cal_oauth_error=token_exchange_failed');
    }

    // 2. Get user email
    const meRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: 'Bearer ' + tokens.access_token },
    });
    const me = await meRes.json();
    const email = me.mail || me.userPrincipalName || '';

    // 3. Find-or-create StayOps calendar
    let calendarId = null;
    try {
      const existing = await out.findCalendarByName(tokens.access_token, CALENDAR_NAME);
      if (existing) calendarId = existing.id;
    } catch (e) {
      console.warn('[outlook-cal-oauth-callback] calendar list probe failed:', e.message);
    }
    if (!calendarId) {
      const cal = await out.createCalendar(tokens.access_token, CALENDAR_NAME);
      calendarId = cal.id;
    }

    // 4. Register change-notification subscription (best-effort).
    let subscriptionId = null;
    let subscriptionExpiresAt = null;
    const clientState = crypto.randomBytes(16).toString('hex');
    try {
      const notificationUrl = SITE_URL + '/.netlify/functions/outlook-cal-webhook';
      const sub = await out.createSubscription(tokens.access_token, calendarId, notificationUrl, clientState);
      subscriptionId = sub.id;
      subscriptionExpiresAt = sub.expirationDateTime || null;
    } catch (e) {
      console.warn('[outlook-cal-oauth-callback] subscription creation failed (non-fatal):', e.message);
    }

    // 5. Persist
    const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
    const expiry = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;

    // Only include refresh_token if provider actually sent one — avoid overwriting a valid token with null
    const upsertPayload = {
      user_id: state,
      email,
      provider: 'outlook_calendar',
      access_token: tokens.access_token,
      token_expiry: expiry,
      calendar_id: calendarId,
      outlook_subscription_id: subscriptionId,
      outlook_client_state: clientState,
      watch_expires_at: subscriptionExpiresAt,
      outlook_delta_link: null,
      updated_at: new Date().toISOString(),
    };
    if (tokens.refresh_token) {
      upsertPayload.refresh_token = tokens.refresh_token;
    }

    const { error: dbError } = await sb
      .from('email_connections')
      .upsert(upsertPayload, { onConflict: 'user_id,provider' });

    if (dbError) {
      console.error('[outlook-cal-oauth-callback] Upsert failed:', dbError.message);
      return redirect(SITE_URL + '/?cal_oauth_error=db_upsert_failed');
    }

    return redirect(SITE_URL + '/?cal_oauth_success=microsoft&cal_email=' + encodeURIComponent(email));
  } catch (err) {
    console.error('[outlook-cal-oauth-callback] Error:', err);
    captureError(err, { tags: { function: 'outlook-cal-oauth-callback' } });
    await flush();
    return redirect(SITE_URL + '/?cal_oauth_error=internal_error');
  }
};

function redirect(url) {
  return { statusCode: 302, headers: { Location: url }, body: '' };
}
