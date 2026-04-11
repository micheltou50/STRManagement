/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Gmail Scan Bookings v3
   Reads recent booking emails from Gmail, parses them with Claude Haiku,
   and upserts/updates/cancels bookings in Supabase.

   Handles: new bookings, cancellations, and modifications.
   Tracks skipped emails so they are not re-processed.

   Query params:
     uid — Supabase user ID

   Required Netlify env vars:
     GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
     SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY
     VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (optional; push skipped if missing)
   ═══════════════════════════════════════════════════════════════════════════ */

const { createClient } = require('@supabase/supabase-js');
const { sendPushToHost, hasRecentNotification } = require('./utils/push-helper');

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
    const cfgRows = await cfgRes.json();
    console.log('[gmail-scan] uid:', uid);
    console.log('[gmail-scan] cfgRes status:', cfgRes.status);
    console.log('[gmail-scan] cfgRows:', JSON.stringify(cfgRows));
    console.log('[gmail-scan] has refresh token:', !!(cfgRows && cfgRows.length && cfgRows[0] && cfgRows[0].gmail_refresh_token));
    if (!cfgRows || !cfgRows.length || !cfgRows[0].gmail_refresh_token) {
      return json(400, { error: 'Gmail not connected — connect in Settings first' });
    }
    const refreshToken = cfgRows[0].gmail_refresh_token;
    const userGmailAddress = cfgRows[0].gmail_email || '';

    // Load previously skipped message IDs
    let skippedIds = new Set();
    try {
      const raw = cfgRows[0].gmail_skipped_ids;
      if (raw) skippedIds = new Set(JSON.parse(raw));
    } catch (e) { /* ignore malformed skipped-IDs JSON */ }

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
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('[gmail-scan] Token refresh failed:', tokenData);
      return json(401, { error: 'Gmail token expired — reconnect Gmail in Settings' });
    }
    const accessToken = tokenData.access_token;

    // ── 3. Load ALL properties for this user ───────────────────────────
    const pidParam = (event.queryStringParameters || {}).pid || '';
    const propRes = await fetch(
      SUPABASE_URL + '/rest/v1/properties?user_id=eq.' + enc(uid) +
        '&select=id,name,address,suburb,state,mgmt_fee_rate,airbnb_listing_id,airbnb_listing_title&order=created_at.asc',
      { headers: sbHeaders }
    );
    const allProps = await propRes.json();
    if (!Array.isArray(allProps) || !allProps.length) {
      return json(400, { error: 'No properties found — add a property first' });
    }

    const propMap = allProps.map(p => ({
      id:          p.id,
      name:        p.name || '',
      address:     p.address || '',
      suburb:      p.suburb || '',
      state:       p.state || '',
      mgmtFeeRate: p.mgmt_fee_rate != null ? Number(p.mgmt_fee_rate) : 0,
      airbnbListingId: p.airbnb_listing_id || '',
      airbnbListingTitle: p.airbnb_listing_title || '',
    }));

    // Default property: prefer pid from frontend, else first property
    const defaultProp = (pidParam && propMap.find(p => p.id === pidParam)) || propMap[0];
    const isSingleProperty = propMap.length === 1;

    // Build property list string for the Haiku prompt (multi-property only)
    const propertyListStr = propMap.map((p, i) =>
      (i + 1) + '. "' + p.name + '"' +
      (p.airbnbListingTitle && p.airbnbListingTitle !== p.name
        ? ' (Airbnb listing: "' + p.airbnbListingTitle + '")'
        : '') +
      (p.address ? ' at ' + p.address : '') +
      (p.suburb ? ', ' + p.suburb : '') +
      (p.state ? ' ' + p.state : '')
    ).join('\n');

    // ── 4. Search Gmail ────────────────────────────────────────────────
    const searchDays = 14;
    const afterDate = new Date(Date.now() - searchDays * 24 * 60 * 60 * 1000);
    const afterStr = afterDate.toISOString().split('T')[0].replace(/-/g, '/');

    // Only search from known booking platforms + user's own email (for testing)
    const senders = 'from:(airbnb.com OR vrbo.com OR booking.com OR stayz.com OR expedia.com OR mtoubia96@gmail.com)';
    const searchQueries = [
      senders + ' subject:(reservation OR booking OR confirmed OR cancelled OR canceled OR modified OR updated OR alteration OR request OR arrival) after:' + afterStr,
      // Catch all emails from the test address regardless of subject
      'from:mtoubia96@gmail.com after:' + afterStr,
    ];

    const allMessageIds = new Set();
    for (const q of searchQueries) {
      const searchRes = await fetch(
        'https://www.googleapis.com/gmail/v1/users/me/messages?q=' + encodeURIComponent(q) + '&maxResults=50',
        { headers: { Authorization: 'Bearer ' + accessToken } }
      );
      if (!searchRes.ok) { console.log('[gmail-scan] Search failed:', searchRes.status); continue; }
      const searchData = await searchRes.json();
      if (searchData.messages) {
        searchData.messages.forEach(m => allMessageIds.add(m.id));
      }
    }

    if (!allMessageIds.size) {
      await updateLastScan(SUPABASE_URL, sbHeaders, uid, skippedIds);
      return json(200, { found: 0, imported: 0, updated: 0, cancelled: 0, skipped: 0, needs_review: [], message: 'No booking emails found in the last ' + searchDays + ' days' });
    }

    // ── 5. Get already-processed message IDs ───────────────────────────
    const existingRes = await fetch(
      SUPABASE_URL + '/rest/v1/bookings?user_id=eq.' + enc(uid) +
        '&select=gmail_message_id&gmail_message_id=not.is.null',
      { headers: sbHeaders }
    );
    const existingRows = await existingRes.json();
    const processedIds = new Set(
      (Array.isArray(existingRows) ? existingRows : [])
        .map(r => r.gmail_message_id).filter(Boolean)
    );

    // Combine with skipped IDs — both should be excluded
    const allProcessedIds = new Set([...processedIds, ...skippedIds]);
    const newMessageIds = [...allMessageIds].filter(id => !allProcessedIds.has(id));

    if (!newMessageIds.length) {
      await updateLastScan(SUPABASE_URL, sbHeaders, uid, skippedIds);
      return json(200, { found: allMessageIds.size, imported: 0, updated: 0, cancelled: 0, skipped: allMessageIds.size, needs_review: [], message: 'All booking emails already processed' });
    }

    // ── 6. Load existing bookings for matching ─────────────────────────
    const allBookingsRes = await fetch(
      SUPABASE_URL + '/rest/v1/bookings?user_id=eq.' + enc(uid) +
        '&select=id,local_id,confirmation_code,guest_name,checkin,checkout,status,property_id,host_payout,cleaning_fee,platform',
      { headers: sbHeaders }
    );
    const existingBookings = await allBookingsRes.json();

    // ── 7. Fetch email bodies and parse with Claude ────────────────────
    const results = { imported: 0, updated: 0, cancelled: 0, skipped: 0, errors: 0, details: [] };
    const needsReview = [];
    const batch = newMessageIds.slice(0, 20);
    const newlySkipped = [];

    for (const msgId of batch) {
      try {
        const msgRes = await fetch(
          'https://www.googleapis.com/gmail/v1/users/me/messages/' + msgId + '?format=full',
          { headers: { Authorization: 'Bearer ' + accessToken } }
        );
        const msg = await msgRes.json();
        if (!msg.payload) {
          results.skipped++;
          newlySkipped.push(msgId);
          continue;
        }

        const emailBody = extractEmailBody(msg);
        const emailSubject = getHeader(msg.payload.headers, 'Subject') || '';
        const emailFrom = getHeader(msg.payload.headers, 'From') || '';

        if (!emailBody || emailBody.length < 50) {
          results.skipped++;
          newlySkipped.push(msgId);
          continue;
        }

        const parsed = await parseBookingEmail(
          ANTHROPIC_KEY, emailSubject, emailFrom, emailBody,
          isSingleProperty ? propMap[0].name : null,
          isSingleProperty ? null : propertyListStr
        );
        if (!parsed) {
          // Transient failure (Claude API/network error) — do NOT permanently skip; retry next scan
          results.errors++;
          results.details.push({ msgId, status: 'skipped', reason: 'Parse failed — will retry next scan' });
          continue;
        }
        if (parsed.not_a_booking) {
          // Definitively not a booking — permanently skip
          results.skipped++;
          newlySkipped.push(msgId);
          results.details.push({ msgId, status: 'skipped', reason: 'Not a host booking email' });
          continue;
        }

        const rawEmailType = String(parsed.email_type || parsed.emailType || '').toLowerCase();
        if (
          (parsed.skipped === true && rawEmailType !== 'cancellation') ||
          rawEmailType === 'enquiry' ||
          rawEmailType === 'other' ||
          rawEmailType === 'payout_notification'
        ) {
          results.skipped++;
          newlySkipped.push(msgId);
          results.details.push({
            msgId,
            status: 'skipped',
            reason: 'Non-confirmation email' + (rawEmailType ? ' (' + rawEmailType + ')' : ''),
          });
          continue;
        }

        let resolvedProp = defaultProp;
        let propertyUnconfirmed = false;

        if (!isSingleProperty && parsed && !parsed.not_a_booking) {
          let matched = false;

          // Tier 1: Match by Airbnb listing ID (bulletproof)
          if (parsed.airbnbListingId) {
            const byListingId = propMap.find(p =>
              p.airbnbListingId && p.airbnbListingId === String(parsed.airbnbListingId)
            );
            if (byListingId) { resolvedProp = byListingId; matched = true; }
          }

          // Tier 2: Match by listing title
          if (!matched && parsed.listingTitle) {
            const lt = String(parsed.listingTitle).toLowerCase().trim();
            const byTitle = propMap.find(p =>
              p.airbnbListingTitle && (
                p.airbnbListingTitle.toLowerCase().trim() === lt ||
                p.airbnbListingTitle.toLowerCase().includes(lt) ||
                lt.includes(p.airbnbListingTitle.toLowerCase())
              )
            );
            if (byTitle) { resolvedProp = byTitle; matched = true; }
          }

          // Tier 3: Fuzzy match by property name (existing fallback)
          if (!matched && parsed.propertyMatch) {
            const matchName = String(parsed.propertyMatch).toLowerCase().trim();
            const found = propMap.find(p =>
              p.name.toLowerCase().trim() === matchName ||
              p.name.toLowerCase().includes(matchName) ||
              matchName.includes(p.name.toLowerCase())
            );
            if (found) { resolvedProp = found; matched = true; }
          }

          if (!matched) { propertyUnconfirmed = true; }
        }

        const propertyId   = resolvedProp.id;
        const propertyName = resolvedProp.name;
        const mgmtFeeRate  = resolvedProp.mgmtFeeRate;

        const emailType = rawEmailType;
        const confCode = (parsed.confirmationCode || '').trim();

        // ── Cancellation ─────────────────────────────────────────────
        if (emailType === 'cancellation') {
          const match = findExistingBooking(existingBookings, confCode, parsed.guestName, parsed.checkin);
          if (match) {
            const wasCancelled = String(match.status || '').toLowerCase() === 'cancelled';
            await fetch(
              SUPABASE_URL + '/rest/v1/bookings?id=eq.' + enc(match.id),
              {
                method: 'PATCH',
                headers: { ...sbHeaders, Prefer: 'return=minimal' },
                body: JSON.stringify({ status: 'cancelled', gmail_message_id: msgId, updated_at: new Date().toISOString() }),
              }
            );
            results.cancelled++;
            results.details.push({ msgId, status: 'cancelled', guest: parsed.guestName || match.guest_name, confCode });
            if (!wasCancelled) {
              const pname = (propMap.find(p => p.id === match.property_id) || {}).name || propertyName;
              await notifyBookingOwnerPush(supabaseAdmin, {
                notifyType: 'cancellation',
                propertyId: match.property_id,
                bookingRow: {
                  id: match.id,
                  guest_name: parsed.guestName || match.guest_name,
                  checkin: match.checkin,
                  checkout: match.checkout,
                  platform: match.platform,
                  host_payout: match.host_payout,
                },
                fallbackPropertyName: pname,
              });
            }
          } else {
            results.skipped++;
            newlySkipped.push(msgId);
            results.details.push({ msgId, status: 'skipped', reason: 'Cancellation but no matching booking found' });
          }
          continue;
        }

        // ── Confirmation only: insert/update booking rows ────────────
        if (emailType !== 'confirmation') {
          results.skipped++;
          newlySkipped.push(msgId);
          results.details.push({
            msgId,
            status: 'skipped',
            reason: rawEmailType ? 'Expected confirmation, got: ' + rawEmailType : 'Missing or invalid email_type',
          });
          continue;
        }

        const match = findExistingBooking(existingBookings, confCode, parsed.guestName, null);
        if (match) {
          const datesChanged =
            (parsed.checkin && parsed.checkin !== match.checkin) ||
            (parsed.checkout && parsed.checkout !== match.checkout);
          const patch = { updated_at: new Date().toISOString(), gmail_message_id: msgId };
          if (parsed.checkin) patch.checkin = parsed.checkin;
          if (parsed.checkout) patch.checkout = parsed.checkout;
          if (parsed.checkin && parsed.checkout) patch.nights = daysBetween(parsed.checkin, parsed.checkout);
          if (parsed.guests) patch.guests = parsed.guests;
          if (parsed.hostPayout) patch.host_payout = parsed.hostPayout;
          if (parsed.cleaningFee) patch.cleaning_fee = parsed.cleaningFee;

          await fetch(
            SUPABASE_URL + '/rest/v1/bookings?id=eq.' + enc(match.id),
            {
              method: 'PATCH',
              headers: { ...sbHeaders, Prefer: 'return=minimal' },
              body: JSON.stringify(patch),
            }
          );
          results.updated++;
          results.details.push({ msgId, status: 'updated', guest: parsed.guestName, checkin: parsed.checkin });
          const priceChanged =
            (parsed.hostPayout != null && Number(parsed.hostPayout) !== Number(match.host_payout || 0)) ||
            (parsed.cleaningFee != null && Number(parsed.cleaningFee) !== Number(match.cleaning_fee || 0));
          if (datesChanged || priceChanged) {
            const modPropName = (propMap.find(p => p.id === match.property_id) || {}).name || propertyName;
            const { data: modRow, error: modFetchErr } = await supabaseAdmin
              .from('bookings')
              .select('id, property_id, guest_name, checkin, checkout, guests, platform, host_payout, status')
              .eq('id', match.id)
              .maybeSingle();
            if (!modFetchErr && modRow) {
              await notifyBookingOwnerPush(supabaseAdmin, {
                notifyType: 'booking_modified',
                propertyId: match.property_id,
                bookingRow: modRow,
                fallbackPropertyName: modPropName,
              });
            }
          }
          continue;
        }

        if (!parsed.checkin || !parsed.checkout) {
          results.skipped++;
          newlySkipped.push(msgId);
          results.details.push({ msgId, status: 'skipped', reason: 'Missing check-in or check-out date' });
          continue;
        }

        // Duplicate check by confirmation code
        if (confCode) {
          const dup = existingBookings.find(b =>
            b.confirmation_code && b.confirmation_code.toLowerCase() === confCode.toLowerCase()
          );
          if (dup) {
            results.skipped++;
            newlySkipped.push(msgId);
            results.details.push({ msgId, status: 'skipped', reason: 'Booking with this confirmation code already exists' });
            continue;
          }
        }

        const insertedNew = await insertNewBooking(SUPABASE_URL, sbHeaders, uid, propertyId, msgId, parsed, mgmtFeeRate, propertyUnconfirmed, emailFrom);
        if (insertedNew) {
          results.imported++;
          const insRow = await fetchBookingRowByGmailMessageId(supabaseAdmin, uid, msgId);
          if (insRow) {
            await notifyBookingOwnerPush(supabaseAdmin, {
              notifyType: 'new_booking',
              propertyId: insRow.property_id || propertyId,
              bookingRow: insRow,
              fallbackPropertyName: propertyName,
            });
          }
        }
        results.details.push({ msgId, status: 'imported', guest: parsed.guestName, checkin: parsed.checkin });
        if (propertyUnconfirmed) {
          needsReview.push({
            guest: parsed.guestName || 'Guest',
            checkin: parsed.checkin,
            checkout: parsed.checkout,
            platform: parsed.platform || '',
            gmail_message_id: msgId,
            assigned_property: propertyName,
          });
        }

      } catch (emailErr) {
        console.warn('[gmail-scan] Error processing message', msgId, emailErr.message);
        // Transient error — do NOT permanently skip; will retry on next scan
        results.errors++;
      }
    }

    // ── 8. Save skipped IDs + update last scan ─────────────────────────
    newlySkipped.forEach(id => skippedIds.add(id));
    // Cap at 500 to prevent unlimited growth — remove oldest
    if (skippedIds.size > 500) {
      const arr = [...skippedIds];
      skippedIds = new Set(arr.slice(arr.length - 500));
    }
    await updateLastScan(SUPABASE_URL, sbHeaders, uid, skippedIds);

    const parts = [];
    if (results.imported) parts.push(results.imported + ' imported');
    if (results.updated) parts.push(results.updated + ' updated');
    if (results.cancelled) parts.push(results.cancelled + ' cancelled');
    const message = parts.length ? 'Bookings: ' + parts.join(', ') : 'No new booking changes found';

    return json(200, {
      found: allMessageIds.size,
      imported: results.imported,
      updated: results.updated,
      cancelled: results.cancelled,
      skipped: results.skipped,
      errors: results.errors,
      remaining: Math.max(0, newMessageIds.length - batch.length),
      details: results.details,
      needs_review: needsReview,
      message,
    });

  } catch (err) {
    console.error('[gmail-scan] Error:', err);
    return json(500, { error: 'Scan failed: ' + (err.message || 'unknown error') });
  }
};


// ── HELPERS ──────────────────────────────────────────────────────────────────

function enc(s) { return encodeURIComponent(s); }
function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}

async function fetchBookingRowByGmailMessageId(supabaseAdmin, uid, msgId) {
  const { data, error } = await supabaseAdmin
    .from('bookings')
    .select('id, property_id, guest_name, checkin, checkout, guests, platform, host_payout, status')
    .eq('user_id', uid)
    .eq('gmail_message_id', msgId)
    .limit(1);
  if (error || !data || !data.length) return null;
  return data[0];
}

/**
 * Owner push via shared push-helper (notification_log + multi-device subscriptions).
 */
async function notifyBookingOwnerPush(supabaseAdmin, { notifyType, propertyId, bookingRow, fallbackPropertyName }) {
  try {
    if (!bookingRow || !bookingRow.id || !propertyId) return;
    const recent = await hasRecentNotification({
      supabaseAdmin,
      type: notifyType,
      referenceId: bookingRow.id,
      withinMinutes: 30,
    });
    if (recent) {
      console.log('[StayOps] push skipped (dedup within 30m)', notifyType, bookingRow.id);
      return;
    }
    const { data: prop, error: pErr } = await supabaseAdmin
      .from('properties')
      .select('name')
      .eq('id', propertyId)
      .maybeSingle();
    if (pErr) {
      console.log('[StayOps] Push notification failed:', pErr.message || 'property lookup');
      return;
    }
    const propertyName = (prop && prop.name) || fallbackPropertyName || 'Property';
    const g = (bookingRow.guest_name || 'Guest').trim();
    const ci = String(bookingRow.checkin || '').slice(0, 10);
    const co = String(bookingRow.checkout || '').slice(0, 10);
    const plat = bookingRow.platform || 'Direct';
    const priceNum = bookingRow.host_payout != null ? Number(bookingRow.host_payout) : 0;
    const priceStr = Math.abs(priceNum % 1) < 1e-9 ? String(priceNum) : priceNum.toFixed(2);

    let title;
    let body;
    if (notifyType === 'new_booking') {
      title = '🏠 New Booking — ' + propertyName;
      body = g + ' · ' + ci + ' to ' + co + ' · ' + plat + ' · $' + priceStr;
    } else if (notifyType === 'cancellation') {
      title = '❌ Cancelled — ' + propertyName;
      body = g + ' · ' + ci + ' to ' + co;
    } else if (notifyType === 'booking_modified') {
      title = '📝 Booking Updated — ' + propertyName;
      body = g + ' · ' + ci + ' to ' + co + ' · $' + priceStr;
    } else {
      return;
    }

    await sendPushToHost({
      supabaseAdmin,
      propertyId,
      title,
      body,
      url: '/bookings',
      type: notifyType,
      referenceId: bookingRow.id,
    });
  } catch (e) {
    console.log('[StayOps] Push notification failed:', e && e.message ? e.message : String(e));
  }
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

async function insertNewBooking(supabaseUrl, sbHeaders, uid, propertyId, msgId, parsed, mgmtFeeRate, propertyUnconfirmed, emailFrom) {
  const rate     = Number(mgmtFeeRate) || 0;
  const payout   = parsed.hostPayout  || 0;
  const cleaning = parsed.cleaningFee || 0;
  const mgmtBase   = payout - cleaning;
  const mgmtFee    = Math.round(mgmtBase * (rate / 100) * 100) / 100;
  const netPayout  = Math.round((mgmtBase - mgmtFee) * 100) / 100; // owner's take-home
  const booking = {
    user_id: uid,
    property_id: propertyId,
    property_unconfirmed: !!propertyUnconfirmed,
    local_id: 'gmail-' + msgId,
    checkin: parsed.checkin,
    checkout: parsed.checkout,
    nights: daysBetween(parsed.checkin, parsed.checkout),
    guest_name: parsed.guestName || 'Guest',
    guests: parsed.guests || 1,
    host_payout: payout,
    cleaning_fee: cleaning,
    net_payout: netPayout,       // owner's take-home (after mgmt fee)
    mgmt_fee_raw: rate,
    mgmt_fee: mgmtFee,
    mgmt_payout: mgmtFee,        // manager's cut
    platform: parsed.platform || detectPlatform(emailFrom),
    confirmation_code: parsed.confirmationCode || '',
    status: 'confirmed',
    source: 'gmail',
    gmail_message_id: msgId,
    updated_at: new Date().toISOString(),
  };

  const res = await fetch(supabaseUrl + '/rest/v1/bookings', {
    method: 'POST',
    headers: { ...sbHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(booking),
  });

  if (!res.ok && res.status !== 201) {
    const errText = await res.text();
    console.warn('[gmail-scan] Insert failed for', msgId, errText);
    return false;
  }
  return true;
}

function findExistingBooking(bookings, confCode, guestName, checkin) {
  if (!Array.isArray(bookings)) return null;

  if (confCode) {
    const byCode = bookings.find(b =>
      b.confirmation_code &&
      b.confirmation_code.toLowerCase() === confCode.toLowerCase() &&
      b.status !== 'cancelled'
    );
    if (byCode) return byCode;
    const byCodeAny = bookings.find(b =>
      b.confirmation_code &&
      b.confirmation_code.toLowerCase() === confCode.toLowerCase()
    );
    if (byCodeAny) return byCodeAny;
  }

  if (guestName && checkin) {
    const normName = guestName.toLowerCase().trim();
    return bookings.find(b =>
      b.guest_name && b.guest_name.toLowerCase().trim() === normName &&
      b.checkin === checkin
    ) || null;
  }

  if (guestName) {
    const normName = guestName.toLowerCase().trim();
    const matches = bookings.filter(b =>
      b.guest_name && b.guest_name.toLowerCase().trim() === normName &&
      b.status !== 'cancelled'
    );
    if (matches.length === 1) return matches[0];
  }

  return null;
}

function detectPlatform(from) {
  const f = (from || '').toLowerCase();
  if (f.includes('@airbnb')) return 'Airbnb';
  if (f.includes('@vrbo') || f.includes('@homeaway')) return 'VRBO';
  if (f.includes('@booking.com')) return 'Booking.com';
  if (f.includes('@stayz')) return 'Stayz';
  return 'Direct';
}

function getHeader(headers, name) {
  if (!headers) return '';
  const h = headers.find(h => h.name && h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
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

function decodeBase64(data) {
  const safe = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(safe, 'base64').toString('utf-8');
}

function daysBetween(d1, d2) {
  const a = new Date(d1);
  const b = new Date(d2);
  return Math.max(0, Math.round((b - a) / 86400000));
}


// ── CLAUDE PARSING ───────────────────────────────────────────────────────────

async function parseBookingEmail(apiKey, subject, from, body, singlePropertyName, propertyList) {
  const propContext = singlePropertyName
    ? ' called "' + singlePropertyName + '"'
    : (propertyList ? ' managing multiple properties' : '');

  const propertyMatchRule = propertyList
    ? '\n\nPROPERTY MATCHING:\n' +
      'The host manages these properties:\n' + propertyList + '\n' +
      'Identify which property this booking email is about based on the property name, ' +
      'address, listing title, or location mentioned in the email body or subject. ' +
      'Return the EXACT property name from the list above in a "propertyMatch" field.\n' +
      'If you cannot confidently determine which property, set "propertyMatch" to null.\n' +
      'If the email contains an Airbnb listing URL (e.g. airbnb.com/rooms/12345), extract the numeric listing ID into "airbnbListingId".\n' +
      'If the email mentions the listing title (often in the subject like "Reservation confirmed - <title>"), return it in "listingTitle".\n'
    : '';

  const propertyMatchJson = propertyList
    ? '  "propertyMatch": "exact property name from the list above, or null if unclear",\n'
    : '';

  // Compute today's date server-side so the model has an authoritative anchor.
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const currentYear = now.getFullYear();
  const nextYear = currentYear + 1;

  const yearRule =
    'Today is ' + todayStr + '. ' +
    'When a date in the email has no year, infer the year using this exact rule: ' +
    '(1) Combine the month and day with ' + currentYear + '. ' +
    '(2) If that date is today or still in the future, use ' + currentYear + '. ' +
    '(3) If that date has already passed, use ' + nextYear + '. ' +
    'Never use any year other than ' + currentYear + ' or ' + nextYear + '.';

  const prompt =
    'You are a booking email parser for a short-term rental HOST who manages a property' + propContext + '.\n\n' +
    'You are analysing emails from the HOST\'s inbox. The host receives booking notifications when GUESTS book their property.\n\n' +
    'CRITICAL DISTINCTION:\n' +
    '- HOST emails say things like: "You have a new reservation", "Your guest X is arriving", "You\'ll earn $X", "Host payout", "New booking at ' + (singlePropertyName || 'your property') + '"\n' +
    '- PERSONAL TRAVEL emails say things like: "Your trip to X", "Your stay at Hotel Y", "Your booking at Restaurant Z", "Your flight"\n' +
    '- Only extract HOST booking notifications. If this looks like a personal travel/hotel/restaurant booking where the email recipient is the traveller, return {"email_type":"other","skipped":true}.\n\n' +
    'First determine the email type. Only extract booking details (guest, dates, payout, confirmation code, etc.) if it is a confirmation.\n\n' +
    'Classify each email as exactly one of:\n' +
    '- "enquiry" — a booking request or inquiry that is NOT yet confirmed (e.g. pending, awaiting host response, pre-approval, inquiry thread).\n' +
    '- "confirmation" — the reservation is confirmed for the host (new booking OR a confirmed change to dates/guests/payout for an existing reservation).\n' +
    '- "cancellation" — the guest booking has been cancelled; include whatever identifiers you can for matching (guest name, confirmation code, dates).\n' +
    '- "payout_notification" — payout on the way, payout sent, remittance, or earnings notices without a full reservation confirmation.\n' +
    '- "other" — marketing, review requests, guest chat messages, unrelated content, or anything that does not fit above.\n\n' +
    'For any email where email_type is NOT "confirmation", return ONLY a minimal object with no booking fields, e.g.:\n' +
    '{"email_type":"enquiry","skipped":true}\n' +
    'Use skipped: true for enquiry, payout_notification, and other.\n\n' +
    'For email_type "cancellation", return JSON with "email_type":"cancellation", "skipped": false, plus guestName, confirmationCode, and checkin/checkout when present (for matching an existing booking). Do not include full booking extraction for non-confirmation types except cancellation as above.\n\n' +
    'If the email is not a host booking-related message at all, return: {"not_a_booking": true}\n\n' +
    'For email_type "confirmation" ONLY, return valid JSON with no other text:\n' +
    '{\n' +
    '  "email_type": "confirmation",\n' +
    '  "skipped": false,\n' +
    '  "guestName": "Full name of the guest staying at the property",\n' +
    '  "checkin": "YYYY-MM-DD" (null if not found),\n' +
    '  "checkout": "YYYY-MM-DD" (null if not found),\n' +
    '  "guests": number of guests (integer, default 1),\n' +
    '  "hostPayout": host payout amount as a number (0 if not found),\n' +
    '  "cleaningFee": cleaning fee as a number (0 if not found),\n' +
    '  "platform": "airbnb" or "vrbo" or "booking.com" or "stayz" or "direct" or other,\n' +
    '  "airbnbListingId": "numeric Airbnb listing ID if a URL like airbnb.com/rooms/12345 appears in the email, or null",\n' +
    '  "listingTitle": "the Airbnb listing title from the email subject or body (e.g. from \'Reservation confirmed - Seaview Cottage\'), or null",\n' +
    propertyMatchJson +
    '  "confirmationCode": "confirmation/reservation code",\n' +
    '  "status": "confirmed" or "cancelled"\n' +
    '}\n\n' +
    'Rules:\n' +
    '- Dates must be YYYY-MM-DD. ' + yearRule + '\n' +
    '- confirmationCode is CRITICAL for matching cancellations and updates.\n' +
    '- hostPayout = amount the HOST receives. Look for "Total payout", "You\'ll earn", "Host payout".\n' +
    '- Platform: detect from From address (@airbnb.com = "airbnb").\n' +
    '- Do not classify a mere inquiry or "request to book" as confirmation; wait for the language of a confirmed reservation.\n' +
    propertyMatchRule +
    '\nSubject: ' + subject + '\nFrom: ' + from + '\nBody:\n' + body;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await res.json();
    if (!data.content || !data.content[0] || !data.content[0].text) {
      console.warn('[gmail-scan] Claude returned no content');
      return null;
    }

    const text = data.content[0].text.trim();
    const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();

    return JSON.parse(cleaned);
  } catch (err) {
    console.warn('[gmail-scan] Claude parse error:', err.message);
    return null;
  }
}
