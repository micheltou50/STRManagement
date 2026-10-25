/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Scheduled review scan (hourly)

   Captures Airbnb guest reviews from the host's mailbox WITHOUT anyone
   opening StayOps. For every connected Gmail / Outlook account it searches
   the last 14 days for Airbnb "review" emails and runs the same capture the
   on-open scan uses (looksLikeReviewEmail → parseReviewEmail →
   processReviewResult). Captured reviews land in the shared `reviews` table
   as status='pending' for the booking website's admin. StayOps shows nothing
   and sends nothing about them. Booking emails are not touched here.

   Processed message ids go into email_connections.skipped_ids — shared with
   the on-open scan — so neither scan re-reads an email.

   Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY
        GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET        (Gmail accounts)
        MICROSOFT_CLIENT_ID + MICROSOFT_CLIENT_SECRET  (Outlook accounts;
        MICROSOFT_TENANT_ID optional, defaults to "common")
   ═══════════════════════════════════════════════════════════════════════════ */

const { schedule } = require('@netlify/functions');
const {
  enc, json, safeJson,
  loadProperties, loadProcessedIds, capSkippedIds,
  looksLikeReviewEmail, extractReviewHints, parseReviewEmail, processReviewResult,
} = require('./utils/email-scan-shared');
const { getHeader, extractGmailBody, extractOutlookBody } = require('./utils/email-body');

const SEARCH_DAYS = 14;
// Hourly cadence and a review email is a rare event, so a small batch keeps
// each run well inside the function budget (one Claude call per review).
const MAX_EMAILS_PER_ACCOUNT = 6;
const FETCH_TIMEOUT_MS = 15000;

function tfetch(url, init) {
  return fetch(url, { ...(init || {}), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

function sbHeadersFor(key) {
  return { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
}

// ── Per-account plumbing ────────────────────────────────────────────────────

async function prepareAccount(conn, supabaseUrl, sbHeaders) {
  const uid = conn.user_id;
  const props = await loadProperties(supabaseUrl, sbHeaders, uid, '');
  if (!props) return null;
  let skippedIds = new Set();
  try { if (conn.skipped_ids) skippedIds = new Set(JSON.parse(conn.skipped_ids)); } catch (_e) { /* malformed */ }
  const processed = new Set([...(await loadProcessedIds(supabaseUrl, sbHeaders, uid, null)), ...skippedIds]);
  const results = { imported: 0, updated: 0, cancelled: 0, reviews: 0, skipped: 0, errors: 0, details: [] };
  const ctx = {
    supabaseUrl, sbHeaders, uid,
    existingBookings: [],
    propMap: props.propMap, defaultProp: props.defaultProp, isSingleProperty: props.isSingleProperty,
    propertyListStr: props.propertyListStr,
    results, needsReview: [], newlySkipped: [],
    supabaseAdmin: null, // silent: no push from this path
  };
  return { uid, skippedIds, processed, ctx };
}

async function handleMessage({ msgId, subject, from, body }, source, ctx, anthropicKey) {
  const { results, newlySkipped } = ctx;
  if (!body || body.length < 50 || !looksLikeReviewEmail(subject, from, body)) {
    // Not a published review (reminder, "wrote you a review", or unrelated) —
    // remember the id so no scan fetches it again.
    results.skipped++;
    newlySkipped.push(msgId);
    return;
  }
  const hints = extractReviewHints(subject, body);
  const parsed = await parseReviewEmail(
    anthropicKey, subject, from, body,
    ctx.isSingleProperty ? ctx.propMap[0].name : null,
    ctx.isSingleProperty ? null : ctx.propertyListStr
  );
  await processReviewResult(parsed, hints, msgId, source, ctx);
}

async function persistSkipped(supabaseUrl, sbHeaders, uid, provider, skippedIds, newlySkipped) {
  if (!newlySkipped.length) return;
  const merged = capSkippedIds(skippedIds, newlySkipped);
  const res = await tfetch(
    supabaseUrl + '/rest/v1/email_connections?user_id=eq.' + enc(uid) + '&provider=eq.' + enc(provider),
    {
      method: 'PATCH',
      headers: { ...sbHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ skipped_ids: JSON.stringify([...merged]), updated_at: new Date().toISOString() }),
    }
  );
  if (!res.ok) console.warn('[review-scan] skipped_ids PATCH failed', res.status);
}

function fold(summary, conn, provider, ctx) {
  const r = ctx.results;
  summary.reviews += r.reviews || 0;
  summary.skipped += r.skipped || 0;
  summary.errors += r.errors || 0;
  for (const d of r.details) summary.details.push({ user: conn.user_id, provider, ...d });
}

// ── Gmail ───────────────────────────────────────────────────────────────────

async function scanGmail(conn, env, summary) {
  const { supabaseUrl, sbHeaders, anthropicKey, google } = env;
  const prep = await prepareAccount(conn, supabaseUrl, sbHeaders);
  if (!prep) return;
  const { uid, skippedIds, processed, ctx } = prep;

  const tokenRes = await tfetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: google.id, client_secret: google.secret,
      refresh_token: conn.refresh_token, grant_type: 'refresh_token',
    }).toString(),
  });
  const tokenData = await safeJson(tokenRes, 'Google OAuth');
  if (!tokenRes.ok || !tokenData.access_token) {
    summary.errors++;
    summary.details.push({ user: uid, provider: 'google', status: 'error', reason: 'Gmail token refresh failed — reconnect Gmail in StayOps settings' });
    return;
  }
  const auth = { Authorization: 'Bearer ' + tokenData.access_token };

  const after = new Date(Date.now() - SEARCH_DAYS * 86400000).toISOString().slice(0, 10).replace(/-/g, '/');
  const q = 'from:(airbnb.com) subject:(review) after:' + after;
  const searchRes = await tfetch(
    'https://www.googleapis.com/gmail/v1/users/me/messages?q=' + encodeURIComponent(q) + '&maxResults=50',
    { headers: auth }
  );
  if (!searchRes.ok) {
    summary.errors++;
    summary.details.push({ user: uid, provider: 'google', status: 'error', reason: 'Gmail search HTTP ' + searchRes.status });
    return;
  }
  const searchData = await safeJson(searchRes, 'Gmail search');
  const ids = (searchData.messages || []).map(m => m.id).filter(id => !processed.has(id)).slice(0, MAX_EMAILS_PER_ACCOUNT);

  for (const msgId of ids) {
    try {
      const msgRes = await tfetch('https://www.googleapis.com/gmail/v1/users/me/messages/' + msgId + '?format=full', { headers: auth });
      const msg = await safeJson(msgRes, 'Gmail message');
      if (!msg || !msg.payload) { ctx.results.skipped++; ctx.newlySkipped.push(msgId); continue; }
      await handleMessage({
        msgId,
        subject: getHeader(msg.payload.headers, 'Subject') || '',
        from: getHeader(msg.payload.headers, 'From') || '',
        body: extractGmailBody(msg),
      }, 'gmail', ctx, anthropicKey);
    } catch (e) {
      ctx.results.errors++;
      ctx.results.details.push({ msgId, status: 'error', reason: e && e.message });
    }
  }

  await persistSkipped(supabaseUrl, sbHeaders, uid, 'google', skippedIds, ctx.newlySkipped);
  fold(summary, conn, 'google', ctx);
}

// ── Outlook ─────────────────────────────────────────────────────────────────

async function scanOutlook(conn, env, summary) {
  const { supabaseUrl, sbHeaders, anthropicKey, microsoft } = env;
  const prep = await prepareAccount(conn, supabaseUrl, sbHeaders);
  if (!prep) return;
  const { uid, skippedIds, processed, ctx } = prep;

  const tokenRes = await tfetch('https://login.microsoftonline.com/' + microsoft.tenant + '/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: microsoft.id, client_secret: microsoft.secret,
      refresh_token: conn.refresh_token, grant_type: 'refresh_token',
      scope: 'https://graph.microsoft.com/Mail.Read offline_access',
    }).toString(),
  });
  const tokenData = await safeJson(tokenRes, 'Microsoft OAuth');
  if (!tokenRes.ok || !tokenData.access_token) {
    summary.errors++;
    summary.details.push({ user: uid, provider: 'microsoft', status: 'error', reason: 'Outlook token refresh failed — reconnect Outlook in StayOps settings' });
    return;
  }
  // Same persistence as the on-open scan: Microsoft rotates refresh tokens.
  const tokenPatch = { access_token: tokenData.access_token, updated_at: new Date().toISOString() };
  if (tokenData.refresh_token) tokenPatch.refresh_token = tokenData.refresh_token;
  if (tokenData.expires_in) tokenPatch.token_expiry = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
  await tfetch(
    supabaseUrl + '/rest/v1/email_connections?user_id=eq.' + enc(uid) + '&provider=eq.microsoft',
    { method: 'PATCH', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify(tokenPatch) }
  );
  const auth = { Authorization: 'Bearer ' + tokenData.access_token };

  const afterIso = new Date(Date.now() - SEARCH_DAYS * 86400000).toISOString();
  const graphUrl = 'https://graph.microsoft.com/v1.0/me/messages' +
    '?$filter=receivedDateTime ge ' + afterIso + ' and contains(subject,\'review\')' +
    '&$select=id,subject,from,receivedDateTime,body&$top=50&$orderby=receivedDateTime desc';
  const searchRes = await tfetch(graphUrl, { headers: auth });
  const searchData = await safeJson(searchRes, 'Graph search');
  if (!searchRes.ok) {
    summary.errors++;
    summary.details.push({ user: uid, provider: 'microsoft', status: 'error', reason: 'Graph search HTTP ' + searchRes.status });
    return;
  }
  const messages = (searchData.value || []).filter(m => m && m.id && !processed.has(m.id)).slice(0, MAX_EMAILS_PER_ACCOUNT);

  for (const msg of messages) {
    try {
      await handleMessage({
        msgId: msg.id,
        subject: msg.subject || '',
        from: (msg.from && msg.from.emailAddress && msg.from.emailAddress.address) || '',
        body: extractOutlookBody(msg),
      }, 'outlook', ctx, anthropicKey);
    } catch (e) {
      ctx.results.errors++;
      ctx.results.details.push({ msgId: msg.id, status: 'error', reason: e && e.message });
    }
  }

  await persistSkipped(supabaseUrl, sbHeaders, uid, 'microsoft', skippedIds, ctx.newlySkipped);
  fold(summary, conn, 'microsoft', ctx);
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function runReviewScan() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY || !ANTHROPIC_KEY) {
    console.error('[review-scan] server misconfigured (SUPABASE_URL / SUPABASE_SERVICE_KEY / ANTHROPIC_API_KEY)');
    return json(500, { error: 'misconfigured' });
  }
  const env = {
    supabaseUrl: SUPABASE_URL,
    sbHeaders: sbHeadersFor(SUPABASE_KEY),
    anthropicKey: ANTHROPIC_KEY,
    google: { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET },
    microsoft: {
      id: process.env.MICROSOFT_CLIENT_ID, secret: process.env.MICROSOFT_CLIENT_SECRET,
      tenant: process.env.MICROSOFT_TENANT_ID || 'common',
    },
  };

  const summary = { accounts: 0, reviews: 0, skipped: 0, errors: 0, details: [] };
  let conns;
  try {
    const res = await tfetch(
      SUPABASE_URL + '/rest/v1/email_connections?refresh_token=not.is.null&select=user_id,provider,email,refresh_token,skipped_ids',
      { headers: env.sbHeaders }
    );
    conns = await safeJson(res, 'Supabase email_connections');
  } catch (e) {
    console.error('[review-scan] could not load email_connections:', e && e.message);
    return json(500, { error: 'email_connections unavailable' });
  }
  if (!Array.isArray(conns) || !conns.length) {
    return json(200, { ...summary, message: 'No connected mailboxes' });
  }

  for (const conn of conns) {
    const provider = String(conn.provider || '').toLowerCase();
    try {
      if (provider === 'google') {
        if (!env.google.id || !env.google.secret) continue;
        summary.accounts++;
        await scanGmail(conn, env, summary);
      } else if (provider === 'microsoft') {
        if (!env.microsoft.id || !env.microsoft.secret) continue;
        summary.accounts++;
        await scanOutlook(conn, env, summary);
      }
    } catch (e) {
      summary.errors++;
      summary.details.push({ user: conn.user_id, provider, status: 'error', reason: e && e.message });
      console.warn('[review-scan] account failed', provider, e && e.message);
    }
  }

  const message = summary.reviews
    ? summary.reviews + (summary.reviews === 1 ? ' review' : ' reviews') + ' captured as pending'
    : 'No new reviews';
  console.log('[review-scan]', message, JSON.stringify({ accounts: summary.accounts, skipped: summary.skipped, errors: summary.errors }));
  return json(200, { ...summary, message });
}

// 23 past every hour. schedule() marks the function scheduled-only at deploy,
// so Netlify rejects external HTTP to this endpoint.
exports.handler = schedule('23 * * * *', async () => runReviewScan());
exports.runReviewScan = runReviewScan;
