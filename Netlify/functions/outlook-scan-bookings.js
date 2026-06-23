/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Outlook Scan Bookings v2
   Reads recent booking emails from Outlook/Hotmail via Microsoft Graph,
   parses them with Claude, and upserts/updates/cancels bookings in Supabase.

   Provider-specific: Microsoft OAuth, Graph API search, flat body extraction.
   Shared logic lives in utils/email-scan-shared.js.

   Query params:
     uid — Supabase user ID

   Required Netlify env vars:
     MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT_ID
     SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY
   ═══════════════════════════════════════════════════════════════════════════ */

const { createClient } = require('@supabase/supabase-js');
const { captureError, flush } = require('./utils/sentry');
const { verifyAuth } = require('./utils/auth');
const { isPreflight, preflightResponse } = require('./utils/cors');
const {
  enc, json, safeJson, looksLikeBookingEmail,
  loadProperties, loadExistingBookings, loadProcessedIds,
  parseBookingEmail, processEmailResult,
  capSkippedIds, buildSummaryResponse,
} = require('./utils/email-scan-shared');

// ── Outlook-specific helpers ────────────────────────────────────────────────

function extractOutlookBody(msg) {
  if (!msg.body || !msg.body.content) return '';
  const { contentType, content } = msg.body;

  if (contentType === 'text') {
    return content.trim().slice(0, 8000);
  }

  const stripped = content
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return stripped.slice(0, 8000);
}

async function updateLastScan(supabaseUrl, sbHeaders, uid, skippedIds) {
  await fetch(
    supabaseUrl + '/rest/v1/email_connections?user_id=eq.' + enc(uid) + '&provider=eq.microsoft',
    {
      method: 'PATCH',
      headers: { ...sbHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({
        skipped_ids: JSON.stringify([...skippedIds]),
        updated_at: new Date().toISOString(),
      }),
    }
  );
}

// ── Handler ─────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (isPreflight(event)) return preflightResponse();
  // Require a real authenticated Supabase session and derive the user from the
  // JWT — the old `?uid=` query param was a non-secret leaked in cleaner links
  // and the public calendar feed (see gmail-scan-bookings for the rationale).
  const auth = await verifyAuth(event);
  if (auth.error) return auth.error;
  const uid = auth.id;

  const SUPABASE_URL        = process.env.SUPABASE_URL;
  const SUPABASE_KEY        = process.env.SUPABASE_SERVICE_KEY;
  const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
  const MICROSOFT_SECRET    = process.env.MICROSOFT_CLIENT_SECRET;
  const MICROSOFT_TENANT    = process.env.MICROSOFT_TENANT_ID || 'common';
  const ANTHROPIC_KEY       = process.env.ANTHROPIC_API_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY || !MICROSOFT_CLIENT_ID || !MICROSOFT_SECRET || !ANTHROPIC_KEY) {
    return json(500, { error: 'Server misconfigured' });
  }

  const sbHeaders = {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
  };

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_KEY);

  try {
    // ── 1. Get Outlook tokens from email_connections ──────────────────
    const connRes = await fetch(
      SUPABASE_URL + '/rest/v1/email_connections?user_id=eq.' + enc(uid) +
        '&provider=eq.microsoft&select=access_token,refresh_token,token_expiry,email,skipped_ids&limit=1',
      { headers: sbHeaders }
    );
    const connRows = await connRes.json();
    if (!connRows || !connRows.length || !connRows[0].refresh_token) {
      return json(400, { error: 'Outlook not connected — connect in Settings first' });
    }
    const row = connRows[0];

    let skippedIds = new Set();
    try {
      const raw = row.skipped_ids;
      if (raw) skippedIds = new Set(JSON.parse(raw));
    } catch (_e) { /* ignore malformed skipped-IDs JSON */ }

    // ── 2. Refresh access token via Microsoft identity platform ───────
    const tokenRes = await fetch(
      'https://login.microsoftonline.com/' + MICROSOFT_TENANT + '/oauth2/v2.0/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id:     MICROSOFT_CLIENT_ID,
          client_secret: MICROSOFT_SECRET,
          refresh_token: row.refresh_token,
          grant_type:    'refresh_token',
          scope: 'https://graph.microsoft.com/Mail.Read offline_access',
        }).toString(),
      }
    );
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('[outlook-scan] Token refresh failed:', tokenData);
      return json(401, { error: 'Outlook token expired — reconnect Outlook in Settings' });
    }
    const accessToken = tokenData.access_token;

    // Persist the new access token (and refresh token if rotated)
    const tokenPatch = {
      access_token: tokenData.access_token,
      updated_at:   new Date().toISOString(),
    };
    if (tokenData.refresh_token) tokenPatch.refresh_token = tokenData.refresh_token;
    if (tokenData.expires_in) {
      tokenPatch.token_expiry = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
    }
    await fetch(
      SUPABASE_URL + '/rest/v1/email_connections?user_id=eq.' + enc(uid) + '&provider=eq.microsoft',
      { method: 'PATCH', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify(tokenPatch) }
    );

    // ── 3. Load properties ────────────────────────────────────────────
    const pidParam = (event.queryStringParameters || {}).pid || '';
    const props = await loadProperties(SUPABASE_URL, sbHeaders, uid, pidParam);
    if (!props) return json(400, { error: 'No properties found — add a property first' });
    const { propMap, defaultProp, isSingleProperty, propertyListStr } = props;

    // ── 4. Search Outlook via Microsoft Graph ─────────────────────────
    const searchDays = 14;
    const afterDate  = new Date(Date.now() - searchDays * 24 * 60 * 60 * 1000);
    const afterStr   = afterDate.toISOString();

    const graphUrl =
      'https://graph.microsoft.com/v1.0/me/messages' +
      '?$filter=receivedDateTime ge ' + afterStr +
      ' and (contains(subject,\'reservation\') or contains(subject,\'booking\') or contains(subject,\'confirmed\') or contains(subject,\'cancelled\') or contains(subject,\'canceled\') or contains(subject,\'modified\') or contains(subject,\'alteration\'))' +
      '&$select=id,subject,from,receivedDateTime,body' +
      '&$top=50' +
      '&$orderby=receivedDateTime desc';

    const searchRes = await fetch(graphUrl, {
      headers: { Authorization: 'Bearer ' + accessToken },
    });
    const searchData = await searchRes.json();

    if (!searchRes.ok) {
      console.error('[outlook-scan] Graph search failed:', searchData);
      return json(500, { error: 'Graph API error: ' + (searchData.error?.message || 'unknown') });
    }

    const messages = searchData.value || [];
    const allMessageIds = new Set(messages.map(m => m.id));

    if (!allMessageIds.size) {
      await updateLastScan(SUPABASE_URL, sbHeaders, uid, skippedIds);
      return json(200, { found: 0, imported: 0, updated: 0, cancelled: 0, skipped: 0, needs_review: [], message: 'No booking emails found in the last ' + searchDays + ' days' });
    }

    // ── 5. Filter already-processed messages ──────────────────────────
    const processedIds = await loadProcessedIds(SUPABASE_URL, sbHeaders, uid, 'outlook');
    const allProcessedIds = new Set([...processedIds, ...skippedIds]);
    const msgMap = {};
    messages.forEach(m => { msgMap[m.id] = m; });
    const newMessageIds = [...allMessageIds].filter(id => !allProcessedIds.has(id));

    if (!newMessageIds.length) {
      await updateLastScan(SUPABASE_URL, sbHeaders, uid, skippedIds);
      return json(200, { found: allMessageIds.size, imported: 0, updated: 0, cancelled: 0, skipped: allMessageIds.size, needs_review: [], message: 'All booking emails already processed' });
    }

    // ── 6. Load existing bookings for matching ────────────────────────
    const existingBookings = await loadExistingBookings(SUPABASE_URL, sbHeaders, uid);

    // ── 7. Parse emails with Claude ───────────────────────────────────
    const results = { imported: 0, updated: 0, cancelled: 0, skipped: 0, errors: 0, details: [] };
    const needsReview = [];
    const batch = newMessageIds.slice(0, 20);
    const newlySkipped = [];

    const ctx = {
      supabaseUrl: SUPABASE_URL, sbHeaders, uid, existingBookings, propMap,
      defaultProp, isSingleProperty, results, needsReview, newlySkipped,
      supabaseAdmin,
    };

    for (const msgId of batch) {
      try {
        const msg = msgMap[msgId];
        if (!msg) { results.skipped++; newlySkipped.push(msgId); continue; }

        const emailBody    = extractOutlookBody(msg);
        const emailSubject = msg.subject || '';
        const emailFrom    = (msg.from && msg.from.emailAddress && msg.from.emailAddress.address) || '';
        ctx.emailFrom = emailFrom;

        if (!emailBody || emailBody.length < 50) {
          results.skipped++;
          newlySkipped.push(msgId);
          continue;
        }

        // Pre-filter: skip emails that don't look like bookings (saves Claude credits)
        if (!looksLikeBookingEmail(emailSubject, emailFrom, emailBody)) {
          results.skipped++;
          newlySkipped.push(msgId);
          results.details.push({ msgId, status: 'skipped', reason: 'No booking keywords — skipped without AI parse' });
          continue;
        }

        const parsed = await parseBookingEmail(
          ANTHROPIC_KEY, emailSubject, emailFrom, emailBody,
          isSingleProperty ? propMap[0].name : null,
          isSingleProperty ? null : propertyListStr
        );

        await processEmailResult(parsed, msgId, 'outlook', ctx);

      } catch (emailErr) {
        console.warn('[outlook-scan] Error processing message', msgId, emailErr.message);
        results.errors++;
      }
    }

    // ── 8. Persist skipped IDs ────────────────────────────────────────
    skippedIds = capSkippedIds(skippedIds, newlySkipped);
    await updateLastScan(SUPABASE_URL, sbHeaders, uid, skippedIds);

    allMessageIds._totalNew = newMessageIds.length;
    return json(200, buildSummaryResponse(allMessageIds, results, needsReview, batch));

  } catch (err) {
    console.error('[outlook-scan] Error:', err);
    captureError(err, { tags: { function: 'outlook-scan-bookings' } });
    await flush();
    return json(500, { error: 'Scan failed: ' + (err.message || 'unknown error') });
  }
};
