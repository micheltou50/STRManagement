/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Gmail Scan Bookings v4
   Reads recent booking emails from Gmail, parses them with Claude,
   and upserts/updates/cancels bookings in Supabase.

   Provider-specific: Gmail OAuth, Gmail API search, MIME body extraction.
   Shared logic lives in utils/email-scan-shared.js.

   Query params:
     uid — Supabase user ID

   Required Netlify env vars:
     GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
     SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY
     VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (optional; push skipped if missing)
   ═══════════════════════════════════════════════════════════════════════════ */

const { createClient } = require('@supabase/supabase-js');
const { captureError, captureMessage, flush } = require('./utils/sentry');
const {
  enc, json, safeJson, looksLikeBookingEmail,
  loadProperties, loadExistingBookings, loadProcessedIds,
  parseBookingEmail, processEmailResult,
  capSkippedIds, buildSummaryResponse,
} = require('./utils/email-scan-shared');

// ── Gmail-specific helpers ──────────────────────────────────────────────────

function getHeader(headers, name) {
  if (!headers) return '';
  const h = headers.find(h => h.name && h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function decodeBase64(data) {
  const safe = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(safe, 'base64').toString('utf-8');
}

function extractEmailBody(msg) {
  const parts = msg.payload.parts || [];
  let plain = '';
  let html = '';

  function walk(part) {
    if (part.mimeType === 'text/plain' && part.body && part.body.data) {
      plain += decodeBase64(part.body.data) + '\n';
    }
    if (part.mimeType === 'text/html' && part.body && part.body.data) {
      html += decodeBase64(part.body.data) + '\n';
    }
    if (part.parts) part.parts.forEach(walk);
  }

  if (msg.payload.body && msg.payload.body.data) {
    if (msg.payload.mimeType === 'text/plain') {
      plain = decodeBase64(msg.payload.body.data);
    } else {
      html = decodeBase64(msg.payload.body.data);
    }
  }
  parts.forEach(walk);

  if (plain.trim()) return plain.trim().slice(0, 8000);

  if (html.trim()) {
    const stripped = html
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

  return '';
}

async function updateLastScan(supabaseUrl, headers, uid, skippedIds) {
  const patch = {
    gmail_last_scan: new Date().toISOString(),
    gmail_skipped_ids: JSON.stringify([...skippedIds]),
    updated_at: new Date().toISOString(),
  };
  await fetch(supabaseUrl + '/rest/v1/app_config?user_id=eq.' + enc(uid), {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
}

// ── Handler ─────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const uid = (event.queryStringParameters || {}).uid;
  if (!uid) return json(400, { error: 'Missing uid' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !ANTHROPIC_KEY) {
    return json(500, { error: 'Server misconfigured' });
  }

  const sbHeaders = {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
  };

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_KEY);

  try {
    // ── 1. Get Gmail config from app_config ─────────────────────────────
    const cfgRes = await fetch(
      SUPABASE_URL + '/rest/v1/app_config?user_id=eq.' + enc(uid) +
        '&select=gmail_refresh_token,gmail_email,gmail_last_scan,gmail_skipped_ids&limit=1',
      { headers: sbHeaders }
    );
    const cfgRows = await safeJson(cfgRes, 'Supabase app_config');
    console.log('[gmail-scan] uid:', uid);
    console.log('[gmail-scan] cfgRes status:', cfgRes.status);
    console.log('[gmail-scan] cfgRows:', JSON.stringify(cfgRows));
    console.log('[gmail-scan] has refresh token:', !!(cfgRows && cfgRows.length && cfgRows[0] && cfgRows[0].gmail_refresh_token));
    if (!cfgRows || !cfgRows.length || !cfgRows[0].gmail_refresh_token) {
      return json(400, { error: 'Gmail not connected — connect in Settings first' });
    }
    const refreshToken = cfgRows[0].gmail_refresh_token;

    let skippedIds = new Set();
    try {
      const raw = cfgRows[0].gmail_skipped_ids;
      if (raw) skippedIds = new Set(JSON.parse(raw));
    } catch (_e) { /* ignore malformed skipped-IDs JSON */ }

    // ── 2. Exchange refresh token for access token ──────────────────────
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });
    const tokenData = await safeJson(tokenRes, 'Google OAuth');
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('[gmail-scan] Token refresh failed:', tokenData);
      captureMessage('Gmail token expired — user needs to reconnect', 'warning', { user_id: uid, tags: { function: 'gmail-scan-bookings' } });
      await flush();
      return json(401, { error: 'Gmail token expired — reconnect Gmail in Settings' });
    }
    const accessToken = tokenData.access_token;

    // ── 3. Load properties ────────────────────────────────────────────
    const pidParam = (event.queryStringParameters || {}).pid || '';
    const props = await loadProperties(SUPABASE_URL, sbHeaders, uid, pidParam);
    if (!props) return json(400, { error: 'No properties found — add a property first' });
    const { propMap, defaultProp, isSingleProperty, propertyListStr } = props;

    // ── 4. Search Gmail ───────────────────────────────────────────────
    const searchDays = 14;
    const afterDate = new Date(Date.now() - searchDays * 24 * 60 * 60 * 1000);
    const afterStr = afterDate.toISOString().split('T')[0].replace(/-/g, '/');

    const senders = 'from:(airbnb.com OR vrbo.com OR homeaway.com OR messages.homeaway.com OR booking.com OR stayz.com OR expedia.com OR mtoubia96@gmail.com)';
    const searchQueries = [
      senders + ' subject:(reservation OR booking OR confirmed OR cancelled OR canceled OR modified OR updated OR alteration OR request OR arrival) after:' + afterStr,
      'from:mtoubia96@gmail.com after:' + afterStr,
    ];

    const allMessageIds = new Set();
    let gmailAuthFailed = false;
    for (const q of searchQueries) {
      const searchRes = await fetch(
        'https://www.googleapis.com/gmail/v1/users/me/messages?q=' + encodeURIComponent(q) + '&maxResults=50',
        { headers: { Authorization: 'Bearer ' + accessToken } }
      );
      if (!searchRes.ok) {
        console.log('[gmail-scan] Search failed:', searchRes.status);
        if (searchRes.status === 403 || searchRes.status === 401) gmailAuthFailed = true;
        continue;
      }
      const searchData = await safeJson(searchRes, 'Gmail search');
      if (searchData.messages) searchData.messages.forEach(m => allMessageIds.add(m.id));
    }

    if (gmailAuthFailed && !allMessageIds.size) {
      console.error('[gmail-scan] Gmail API returned 403/401 — token scopes insufficient or API not enabled');
      captureMessage('Gmail API 403 — user needs to reconnect', 'warning', { user_id: uid, tags: { function: 'gmail-scan-bookings' } });
      await flush();
      return json(401, { error: 'Gmail permissions expired — please disconnect and reconnect Gmail in Settings' });
    }

    if (!allMessageIds.size) {
      await updateLastScan(SUPABASE_URL, sbHeaders, uid, skippedIds);
      return json(200, { found: 0, imported: 0, updated: 0, cancelled: 0, skipped: 0, needs_review: [], message: 'No booking emails found in the last ' + searchDays + ' days' });
    }

    // ── 5. Filter already-processed messages ──────────────────────────
    const processedIds = await loadProcessedIds(SUPABASE_URL, sbHeaders, uid, null);
    const allProcessedIds = new Set([...processedIds, ...skippedIds]);
    const newMessageIds = [...allMessageIds].filter(id => !allProcessedIds.has(id));

    if (!newMessageIds.length) {
      await updateLastScan(SUPABASE_URL, sbHeaders, uid, skippedIds);
      return json(200, { found: allMessageIds.size, imported: 0, updated: 0, cancelled: 0, skipped: allMessageIds.size, needs_review: [], message: 'All booking emails already processed' });
    }

    // ── 6. Load existing bookings for matching ────────────────────────
    const existingBookings = await loadExistingBookings(SUPABASE_URL, sbHeaders, uid);

    // ── 7. Fetch email bodies and process with Claude ─────────────────
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
        const msgRes = await fetch(
          'https://www.googleapis.com/gmail/v1/users/me/messages/' + msgId + '?format=full',
          { headers: { Authorization: 'Bearer ' + accessToken } }
        );
        const msg = await safeJson(msgRes, 'Gmail message');
        if (!msg.payload) {
          results.skipped++;
          newlySkipped.push(msgId);
          continue;
        }

        const emailBody = extractEmailBody(msg);
        const emailSubject = getHeader(msg.payload.headers, 'Subject') || '';
        const emailFrom = getHeader(msg.payload.headers, 'From') || '';
        ctx.emailFrom = emailFrom;

        if (!emailBody || emailBody.length < 50) {
          results.skipped++;
          newlySkipped.push(msgId);
          continue;
        }

        if (!looksLikeBookingEmail(emailSubject, emailFrom, emailBody)) {
          results.skipped++;
          newlySkipped.push(msgId);
          results.details.push({ msgId, status: 'skipped', reason: 'No booking keywords — skipped without AI parse' });
          continue;
        }

        console.log('[gmail-scan] SENDING TO CLAUDE:', { msgId, subject: emailSubject, from: emailFrom, bodyLen: emailBody.length });

        const parsed = await parseBookingEmail(
          ANTHROPIC_KEY, emailSubject, emailFrom, emailBody,
          isSingleProperty ? propMap[0].name : null,
          isSingleProperty ? null : propertyListStr
        );

        await processEmailResult(parsed, msgId, 'gmail', ctx);

      } catch (emailErr) {
        console.warn('[gmail-scan] Error processing message', msgId, emailErr.message);
        results.errors++;
      }
    }

    // ── 8. Save skipped IDs + update last scan ────────────────────────
    skippedIds = capSkippedIds(skippedIds, newlySkipped);
    await updateLastScan(SUPABASE_URL, sbHeaders, uid, skippedIds);

    allMessageIds._totalNew = newMessageIds.length;
    return json(200, buildSummaryResponse(allMessageIds, results, needsReview, batch));

  } catch (err) {
    console.error('[gmail-scan] Error:', err);
    captureError(err, { tags: { function: 'gmail-scan-bookings' }, user_id: uid });
    await flush();
    return json(500, { error: 'Scan failed: ' + (err.message || 'unknown error') });
  }
};
