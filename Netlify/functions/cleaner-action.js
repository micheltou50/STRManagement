/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Cleaner Actions
   Handles accept/decline/done for cleaner PWA (home screen has no Supabase
   auth session, so writes go through this function using the service key).

   POST body (JSON):
     uid       — host's Supabase user ID
     cleanerId — cleaner's local_id
     cleanId   — the clean's local_id
     action    — 'accept' | 'decline' | 'done'

   Required Netlify env vars:
     SUPABASE_URL
     SUPABASE_SERVICE_KEY
   ═══════════════════════════════════════════════════════════════════════════ */

const { createClient } = require('@supabase/supabase-js');
const { sendPushToHost } = require('./utils/push-helper');
const { captureError, flush } = require('./utils/sentry');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'POST only' });
  }

  let body;
  try { body = JSON.parse(event.body); } catch (_e) {
    return json(400, { error: 'Invalid JSON' });
  }

  const { uid, cleanerId, cleanId, action } = body || {};
  if (!uid || !cleanerId || !cleanId || !action) {
    return json(400, { error: 'Missing uid, cleanerId, cleanId, or action' });
  }
  if (!['accept', 'decline', 'done', 'acknowledge_cancel'].includes(action)) {
    return json(400, { error: 'Invalid action — must be accept, decline, done, or acknowledge_cancel' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return json(500, { error: 'Server misconfigured' });
  }

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal',
  };

  try {
    // 1. Verify cleaner exists and belongs to this user
    const cleanerRes = await fetch(
      SUPABASE_URL + '/rest/v1/cleaners?user_id=eq.' + enc(uid) +
        '&local_id=eq.' + enc(cleanerId) +
        '&active=eq.true&select=id,name&limit=1',
      { headers: { ...headers, Prefer: undefined } }
    );
    const cleaners = await cleanerRes.json();
    if (!Array.isArray(cleaners) || !cleaners.length) {
      return json(403, { error: 'Cleaner not found' });
    }
    const cleanerUuid = cleaners[0].id;

    // 2. Build update payload
    let patch = {};
    if (action === 'accept') {
      patch = { cleaner_confirmed: true, cleaner_declined: false, confirmed_at: new Date().toISOString() };
    } else if (action === 'decline') {
      patch = { cleaner_declined: true, cleaner_confirmed: false };
    } else if (action === 'done') {
      patch = { done: true, cleaner_confirmed: true, cleaner_declined: false };
    } else if (action === 'acknowledge_cancel') {
      patch = { cleaner_cancel_acknowledged: true, cleaner_cancel_acknowledged_at: new Date().toISOString() };
    }

    // 3. Update the clean
    const updateRes = await fetch(
      SUPABASE_URL + '/rest/v1/cleans?user_id=eq.' + enc(uid) +
        '&local_id=eq.' + enc(cleanId),
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify(patch),
      }
    );

    if (!updateRes.ok) {
      const errText = await updateRes.text();
      console.error('[cleaner-action] Update failed:', errText);
      return json(500, { error: 'Update failed' });
    }

    // Phase 5: auto-create a pending expense for the cleaner's fee when the
    // clean is marked done. Idempotent — repeat 'done' calls won't create
    // duplicates because we use a deterministic local_id and the existing
    // expenses_local_id_user_id_key unique constraint with
    // resolution=ignore-duplicates. Skips silently if the clean has no
    // cost set (host hasn't entered a cleaner fee yet).
    let autoExpense = null;
    if (action === 'done') {
      autoExpense = await autoCreateExpenseForCleanIfApplicable({
        SUPABASE_URL,
        SUPABASE_KEY,
        uid,
        cleanLocalId: cleanId,
        cleanerName: cleaners[0].name,
      }).catch(err => {
        console.log('[cleaner-action] autoExpense errored (non-fatal):', err && err.message);
        return { ok: false, error: String(err && err.message || err) };
      });
    }

    // Auto-message for the chat
    try {
      const cardTypes = { accept: 'clean_confirmed', decline: 'clean_declined', done: 'clean_complete', acknowledge_cancel: 'cancel_acknowledged' };
      const cardTitles = { accept: 'Cleaner confirmed', decline: 'Cleaner declined', done: 'Clean complete', acknowledge_cancel: 'Cancellation acknowledged' };
      const cardType = cardTypes[action];
      if (cardType && cleanerUuid) {
        await fetch(
          SUPABASE_URL + '/rest/v1/messages',
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              user_id: uid,
              cleaner_id: cleanerUuid,
              sender_type: 'system',
              message_type: 'card',
              card_type: cardType,
              card_data: { title: cardTitles[action], timestamp: new Date().toISOString() },
              created_at: new Date().toISOString(),
            }),
          }
        );
      }
    } catch (msgErr) {
      console.log('[StayOps] Auto-message insert failed (non-fatal):', msgErr.message);
    }

    // Push + email notification to host
    try {
      // Get property_id from the clean record
      const cleanRes = await fetch(
        SUPABASE_URL + '/rest/v1/cleans?user_id=eq.' + enc(uid) +
          '&local_id=eq.' + enc(cleanId) + '&select=property_id,guest_name,clean_date',
        { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY } }
      );
      const cleanRows = await cleanRes.json();
      const clean = Array.isArray(cleanRows) && cleanRows[0];
      if (clean && clean.property_id) {
        const cleanerName = cleaners[0].name || 'Cleaner';
        const titles = {
          accept: '✅ ' + cleanerName + ' confirmed',
          decline: '❌ ' + cleanerName + ' declined',
          done: '🏠 Clean complete',
          acknowledge_cancel: '✓ ' + cleanerName + ' acknowledged cancellation',
        };
        const bodies = {
          accept: 'Confirmed for ' + (clean.clean_date || 'upcoming clean'),
          decline: 'Declined clean on ' + (clean.clean_date || 'upcoming') + ' — needs reassignment',
          done: cleanerName + ' finished cleaning' + (clean.guest_name ? ' for ' + clean.guest_name : ''),
          acknowledge_cancel: cleanerName + ' confirmed they saw the cancellation' + (clean.guest_name ? ' for ' + clean.guest_name : ''),
        };
        const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
        await sendPushToHost({
          supabaseAdmin: sb,
          propertyId: clean.property_id,
          title: titles[action],
          body: bodies[action],
          url: '/cleaning',
          type: action === 'accept' ? 'cleaner_confirmed' : action === 'decline' ? 'cleaner_declined' : 'clean_done',
          referenceId: cleanId,
        });
      }
    } catch (pushErr) {
      console.log('[StayOps] cleaner-action push failed (non-fatal):', pushErr.message);
    }

    return json(200, { ok: true, action, autoExpense });

  } catch (err) {
    console.error('[cleaner-action] Error:', err);
    captureError(err, { tags: { function: 'cleaner-action' } });
    await flush();
    return json(500, { error: 'Internal error' });
  }
};

/**
 * Phase 5: when a clean is marked done, create a pending expense for the
 * cleaner fee so the host has a real expense row to confirm / categorize
 * / bank-match later. Eliminates the "I forgot to log Megan's payment"
 * gap that Phase 6 (owner statements) would otherwise compound.
 *
 * Behaviour:
 *  - Looks up the clean row to read cost / property / booking / dates
 *  - Skips silently if cost is null or <= 0 (no fee set yet, nothing
 *    meaningful to record)
 *  - Picks a sensible category from the host's app_config.expense_cats
 *    (any category whose name contains "clean", case-insensitive),
 *    falls back to "Cleaning & Garden"
 *  - Maps cleans.booking_id (TEXT, host's local_id) -> bookings.id (UUID)
 *    so the expense links into the per-booking Expected vs Received view
 *  - Uses local_id = "clean-<cleanLocalId>" + ignore-duplicates so the
 *    second 'done' fires for the same clean are idempotent no-ops
 *  - Sets paid_by='host', payment_status='pending' so the row is clearly
 *    distinguishable in the expense list until the host reviews it
 *
 * All failures are caught and reported in the return value — never blocks
 * the cleaner_action primary update.
 */
async function autoCreateExpenseForCleanIfApplicable({
  SUPABASE_URL, SUPABASE_KEY, uid, cleanLocalId, cleanerName,
}) {
  const adminHeaders = {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
  };

  // 1. Fetch the clean (need cost, property_id, booking_id, guest, date)
  const cleanRes = await fetch(
    SUPABASE_URL + '/rest/v1/cleans?user_id=eq.' + enc(uid) +
      '&local_id=eq.' + enc(cleanLocalId) +
      '&select=cost,property_id,booking_id,guest_name,clean_date&limit=1',
    { headers: adminHeaders }
  );
  if (!cleanRes.ok) {
    return { ok: false, skipped: true, reason: 'clean_fetch_failed' };
  }
  const cleanRows = await cleanRes.json();
  const clean = Array.isArray(cleanRows) && cleanRows[0];
  if (!clean) return { ok: false, skipped: true, reason: 'clean_not_found' };

  // Phase 5 fix: previously skipped when cost was null/0 — the host then
  // saw nothing happen and assumed it was broken. Now we ALWAYS create the
  // expense (with amount=0 if no fee set), and the description tells the
  // host to set the amount. The row appears in their expense list either
  // way, so the auto-create is visible feedback even when cost is missing.
  const cost = Number(clean.cost) || 0;
  const costMissing = !(cost > 0);

  // 2. Map cleans.booking_id (text local_id) -> bookings.id (uuid).
  //    Non-fatal if it fails — the expense can still be created without
  //    the booking link; the host can add it manually.
  let bookingUuid = null;
  if (clean.booking_id) {
    try {
      const bRes = await fetch(
        SUPABASE_URL + '/rest/v1/bookings?user_id=eq.' + enc(uid) +
          '&local_id=eq.' + enc(clean.booking_id) +
          '&select=id&limit=1',
        { headers: adminHeaders }
      );
      if (bRes.ok) {
        const bRows = await bRes.json();
        if (Array.isArray(bRows) && bRows[0] && bRows[0].id) {
          bookingUuid = bRows[0].id;
        }
      }
    } catch (_e) { /* non-fatal */ }
  }

  // 3. Pick the host's actual "Cleaning" category if they have one.
  //    Default is "Cleaning & Garden" which matches the seeded DEFAULT_EXPENSE_CATS.
  let category = 'Cleaning & Garden';
  try {
    const cfgRes = await fetch(
      SUPABASE_URL + '/rest/v1/app_config?user_id=eq.' + enc(uid) +
        '&select=expense_cats&limit=1',
      { headers: adminHeaders }
    );
    if (cfgRes.ok) {
      const cfgRows = await cfgRes.json();
      const cats = cfgRows && cfgRows[0] && cfgRows[0].expense_cats;
      if (Array.isArray(cats) && cats.length) {
        const cleanCat = cats.find(c => typeof c === 'string' && /clean/i.test(c));
        if (cleanCat) category = cleanCat;
      }
    }
  } catch (_e) { /* non-fatal */ }

  // 4. Build the expense payload with deterministic local_id for idempotency.
  const expenseLocalId = 'clean-' + cleanLocalId;
  const guestPart = clean.guest_name ? ' for ' + clean.guest_name : '';
  const baseDescription = 'Cleaning' + guestPart + ' (auto-created from completed clean)';
  const description = costMissing
    ? baseDescription + ' — SET AMOUNT (no clean cost was on the booking)'
    : baseDescription;
  const payload = {
    user_id: uid,
    property_id: clean.property_id || null,
    local_id: expenseLocalId,
    date: clean.clean_date || new Date().toISOString().split('T')[0],
    merchant: cleanerName || 'Cleaner',
    description,
    category,
    amount: cost, // 0 when costMissing — host edits in the expense list
    receipt_type: 'missing',
    receipt_num: '',
    drive_link: '',
    booking_id: bookingUuid,
    paid_by: 'host',
    recoverable_from_owner: false,
    payment_status: 'pending',
    status: 'active',
  };

  // 5. Insert with ignore-duplicates so repeat 'done' calls are no-ops.
  const insertRes = await fetch(
    SUPABASE_URL + '/rest/v1/expenses',
    {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'resolution=ignore-duplicates,return=representation',
      },
      body: JSON.stringify(payload),
    }
  );
  if (!insertRes.ok) {
    const errText = await insertRes.text();
    return { ok: false, error: errText };
  }
  const inserted = await insertRes.json();
  const newRow = Array.isArray(inserted) && inserted[0];
  if (!newRow) {
    // ignore-duplicates returns empty array when the row already existed
    return { ok: true, action: 'already_exists', expenseLocalId };
  }
  return {
    ok: true,
    action: 'created',
    expenseId: newRow.id,
    expenseLocalId,
    amount: cost,
    costMissing,
    category,
    bookingLinked: !!bookingUuid,
  };
}

function enc(s) { return encodeURIComponent(s); }
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
function json(status, body) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
