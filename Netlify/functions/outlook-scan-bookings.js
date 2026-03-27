/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Outlook Scan Bookings v1
   Reads recent booking emails from Outlook/Hotmail via Microsoft Graph,
   parses them with Claude Haiku (same prompt as gmail-scan-bookings),
   and upserts/updates/cancels bookings in Supabase.

   Mirrors the structure of gmail-scan-bookings.js exactly.
   The only provider-specific differences are:
     - Token source  : email_connections table (not app_config)
     - Token refresh : Microsoft identity platform (not Google OAuth2)
     - Mail fetch    : Microsoft Graph /me/messages (not Gmail API)
     - Body extract  : flat msg.body.content (not Gmail MIME tree)
     - Skipped IDs  : email_connections.skipped_ids column

   Query params:
     uid — Supabase user ID

   Required Netlify env vars:
     MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT_ID
     SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY
   ═══════════════════════════════════════════════════════════════════════════ */

exports.handler = async (event) => {
  const uid = (event.queryStringParameters || {}).uid;
  if (!uid) return json(400, { error: 'Missing uid' });

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
    const userOutlookAddress = row.email || '';

    // Load previously skipped message IDs
    let skippedIds = new Set();
    try {
      const raw = row.skipped_ids;
      if (raw) skippedIds = new Set(JSON.parse(raw));
    } catch (e) {}

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

    // ── 3. Get property ───────────────────────────────────────────────
    const propRes = await fetch(
      SUPABASE_URL + '/rest/v1/properties?user_id=eq.' + enc(uid) +
        '&select=id,name,mgmt_fee_rate&order=updated_at.desc&limit=1',
      { headers: sbHeaders }
    );
    const props = await propRes.json();
    const propertyId   = (props && props[0]) ? props[0].id   : null;
    const propertyName = (props && props[0]) ? props[0].name : '';
    const mgmtFeeRate  = (props && props[0] && props[0].mgmt_fee_rate != null) ? Number(props[0].mgmt_fee_rate) : 0;

    // ── 4. Search Outlook via Microsoft Graph ────────────────────────
    // Graph filter: messages from booking platforms in the last 14 days
    const searchDays = 14;
    const afterDate  = new Date(Date.now() - searchDays * 24 * 60 * 60 * 1000);
    const afterStr   = afterDate.toISOString(); // ISO 8601 — Graph requires this format

    // Graph uses OData $filter, not Gmail query syntax
    const senderDomains = ['airbnb.com', 'vrbo.com', 'booking.com', 'stayz.com', 'expedia.com'];
    // Build: (from/emailAddress/address eq 'x@airbnb.com') or ... — Graph doesn't support "contains domain"
    // so we use $search on sender name/address which is broader, then let Claude filter false positives.
    // The most reliable Graph approach: fetch all messages from last N days matching a keyword filter.
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
      return json(200, { found: 0, imported: 0, updated: 0, cancelled: 0, skipped: 0, message: 'No booking emails found in the last ' + searchDays + ' days' });
    }

    // ── 5. Get already-processed Outlook message IDs ─────────────────
    const existingRes = await fetch(
      SUPABASE_URL + '/rest/v1/bookings?user_id=eq.' + enc(uid) +
        '&source=eq.outlook&select=gmail_message_id&gmail_message_id=not.is.null',
      { headers: sbHeaders }
    );
    const existingRows = await existingRes.json();
    const processedIds = new Set(
      (Array.isArray(existingRows) ? existingRows : [])
        .map(r => r.gmail_message_id).filter(Boolean)
    );

    const allProcessedIds = new Set([...processedIds, ...skippedIds]);
    const msgMap = {};
    messages.forEach(m => { msgMap[m.id] = m; });
    const newMessageIds = [...allMessageIds].filter(id => !allProcessedIds.has(id));

    if (!newMessageIds.length) {
      await updateLastScan(SUPABASE_URL, sbHeaders, uid, skippedIds);
      return json(200, { found: allMessageIds.size, imported: 0, updated: 0, cancelled: 0, skipped: allMessageIds.size, message: 'All booking emails already processed' });
    }

    // ── 6. Load existing bookings for matching ────────────────────────
    const allBookingsRes = await fetch(
      SUPABASE_URL + '/rest/v1/bookings?user_id=eq.' + enc(uid) +
        '&select=id,local_id,confirmation_code,guest_name,checkin,checkout,status' +
        (propertyId ? '&property_id=eq.' + enc(propertyId) : ''),
      { headers: sbHeaders }
    );
    const existingBookings = await allBookingsRes.json();

    // ── 7. Parse emails with Claude ───────────────────────────────────
    const results = { imported: 0, updated: 0, cancelled: 0, skipped: 0, errors: 0, details: [] };
    const batch = newMessageIds.slice(0, 20);
    const newlySkipped = [];

    for (const msgId of batch) {
      try {
        // Messages were fetched with body already included in the search response
        const msg = msgMap[msgId];
        if (!msg) { results.skipped++; newlySkipped.push(msgId); continue; }

        const emailBody    = extractOutlookBody(msg);
        const emailSubject = msg.subject || '';
        const emailFrom    = (msg.from && msg.from.emailAddress && msg.from.emailAddress.address) || '';

        if (!emailBody || emailBody.length < 50) {
          results.skipped++;
          newlySkipped.push(msgId);
          continue;
        }

        const parsed = await parseBookingEmail(ANTHROPIC_KEY, emailSubject, emailFrom, emailBody, propertyName);
        if (!parsed) {
          results.errors++;
          results.details.push({ msgId, status: 'skipped', reason: 'Parse failed — will retry next scan' });
          continue;
        }
        if (parsed.not_a_booking) {
          results.skipped++;
          newlySkipped.push(msgId);
          results.details.push({ msgId, status: 'skipped', reason: 'Not a host booking email' });
          continue;
        }

        const emailType = parsed.emailType || 'new_booking';
        const confCode  = (parsed.confirmationCode || '').trim();

        // ── Cancellation ────────────────────────────────────────────
        if (emailType === 'cancellation') {
          const match = findExistingBooking(existingBookings, confCode, parsed.guestName, parsed.checkin);
          if (match) {
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
          } else {
            results.skipped++;
            newlySkipped.push(msgId);
            results.details.push({ msgId, status: 'skipped', reason: 'Cancellation but no matching booking found' });
          }
          continue;
        }

        // ── Modification ────────────────────────────────────────────
        if (emailType === 'modification') {
          const match = findExistingBooking(existingBookings, confCode, parsed.guestName, null);
          if (match) {
            const patch = { updated_at: new Date().toISOString(), gmail_message_id: msgId };
            if (parsed.checkin)   patch.checkin  = parsed.checkin;
            if (parsed.checkout)  patch.checkout = parsed.checkout;
            if (parsed.checkin && parsed.checkout) patch.nights = daysBetween(parsed.checkin, parsed.checkout);
            if (parsed.guests)    patch.guests     = parsed.guests;
            if (parsed.hostPayout)  patch.host_payout  = parsed.hostPayout;
            if (parsed.cleaningFee) patch.cleaning_fee = parsed.cleaningFee;
            await fetch(
              SUPABASE_URL + '/rest/v1/bookings?id=eq.' + enc(match.id),
              { method: 'PATCH', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify(patch) }
            );
            results.updated++;
            results.details.push({ msgId, status: 'updated', guest: parsed.guestName, checkin: parsed.checkin });
          } else if (parsed.checkin && parsed.checkout) {
            await insertNewBooking(SUPABASE_URL, sbHeaders, uid, propertyId, msgId, parsed, mgmtFeeRate);
            results.imported++;
            results.details.push({ msgId, status: 'imported', guest: parsed.guestName, checkin: parsed.checkin, note: 'modification without matching original' });
          } else {
            results.skipped++;
            newlySkipped.push(msgId);
            results.details.push({ msgId, status: 'skipped', reason: 'Modification but no matching booking and missing dates' });
          }
          continue;
        }

        // ── New booking ─────────────────────────────────────────────
        if (!parsed.checkin || !parsed.checkout) {
          results.skipped++;
          newlySkipped.push(msgId);
          results.details.push({ msgId, status: 'skipped', reason: 'Missing check-in or check-out date' });
          continue;
        }

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

        await insertNewBooking(SUPABASE_URL, sbHeaders, uid, propertyId, msgId, parsed, mgmtFeeRate);
        results.imported++;
        results.details.push({ msgId, status: 'imported', guest: parsed.guestName, checkin: parsed.checkin });

      } catch (emailErr) {
        console.warn('[outlook-scan] Error processing message', msgId, emailErr.message);
        results.errors++;
      }
    }

    // ── 8. Persist skipped IDs ────────────────────────────────────────
    newlySkipped.forEach(id => skippedIds.add(id));
    if (skippedIds.size > 500) {
      const arr = [...skippedIds];
      skippedIds = new Set(arr.slice(arr.length - 500));
    }
    await updateLastScan(SUPABASE_URL, sbHeaders, uid, skippedIds);

    const parts = [];
    if (results.imported)  parts.push(results.imported  + ' imported');
    if (results.updated)   parts.push(results.updated   + ' updated');
    if (results.cancelled) parts.push(results.cancelled + ' cancelled');
    const message = parts.length ? 'Bookings: ' + parts.join(', ') : 'No new booking changes found';

    return json(200, {
      found:     allMessageIds.size,
      imported:  results.imported,
      updated:   results.updated,
      cancelled: results.cancelled,
      skipped:   results.skipped,
      errors:    results.errors,
      remaining: Math.max(0, newMessageIds.length - batch.length),
      details:   results.details,
      message,
    });

  } catch (err) {
    console.error('[outlook-scan] Error:', err);
    return json(500, { error: 'Scan failed: ' + (err.message || 'unknown error') });
  }
};


// ── HELPERS ──────────────────────────────────────────────────────────────────

function enc(s)  { return encodeURIComponent(s); }
function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}

async function updateLastScan(supabaseUrl, headers, uid, skippedIds) {
  await fetch(
    supabaseUrl + '/rest/v1/email_connections?user_id=eq.' + enc(uid) + '&provider=eq.microsoft',
    {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({
        skipped_ids: JSON.stringify([...skippedIds]),
        updated_at:  new Date().toISOString(),
      }),
    }
  );
}

// Extract plain text from a Microsoft Graph message object.
// Graph returns body as { contentType: 'html'|'text', content: '...' }
// This is completely different from Gmail's MIME tree — there is no base64,
// no payload.parts[], and no recursive walk needed.
function extractOutlookBody(msg) {
  if (!msg.body || !msg.body.content) return '';
  const { contentType, content } = msg.body;

  if (contentType === 'text') {
    return content.trim().slice(0, 8000);
  }

  // HTML — strip tags the same way gmail-scan-bookings does for HTML parts
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

async function insertNewBooking(supabaseUrl, sbHeaders, uid, propertyId, msgId, parsed, mgmtFeeRate) {
  const rate     = Number(mgmtFeeRate) || 0;
  const payout   = parsed.hostPayout  || 0;
  const cleaning = parsed.cleaningFee || 0;
  const mgmtBase  = payout - cleaning;
  const mgmtFee   = Math.round(mgmtBase * (rate / 100) * 100) / 100;
  const netPayout = Math.round((mgmtBase - mgmtFee) * 100) / 100;

  const booking = {
    user_id:           uid,
    property_id:       propertyId,
    local_id:          'outlook-' + msgId,   // distinct from gmail- prefix
    checkin:           parsed.checkin,
    checkout:          parsed.checkout,
    nights:            daysBetween(parsed.checkin, parsed.checkout),
    guest_name:        parsed.guestName || 'Guest',
    guests:            parsed.guests || 1,
    host_payout:       payout,
    cleaning_fee:      cleaning,
    net_payout:        netPayout,
    mgmt_fee_raw:      rate,
    mgmt_fee:          mgmtFee,
    mgmt_payout:       mgmtFee,
    platform:          parsed.platform || '',
    confirmation_code: parsed.confirmationCode || '',
    status:            'confirmed',
    source:            'outlook',
    gmail_message_id:  msgId,               // reuses existing column — no schema change needed
    updated_at:        new Date().toISOString(),
  };

  const res = await fetch(supabaseUrl + '/rest/v1/bookings', {
    method: 'POST',
    headers: { ...sbHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(booking),
  });

  if (!res.ok && res.status !== 201) {
    const errText = await res.text();
    console.warn('[outlook-scan] Insert failed for', msgId, errText);
  }
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

function daysBetween(d1, d2) {
  return Math.max(0, Math.round((new Date(d2) - new Date(d1)) / 86400000));
}


// ── CLAUDE PARSING (identical prompt to gmail-scan-bookings) ─────────────────

async function parseBookingEmail(apiKey, subject, from, body, propertyName) {
  const propContext = propertyName ? ' called "' + propertyName + '"' : '';

  const now        = new Date();
  const todayStr   = now.toISOString().split('T')[0];
  const currentYear = now.getFullYear();
  const nextYear   = currentYear + 1;

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
    '- HOST emails say things like: "You have a new reservation", "Your guest X is arriving", "You\'ll earn $X", "Host payout", "New booking at ' + (propertyName || 'your property') + '"\n' +
    '- PERSONAL TRAVEL emails say things like: "Your trip to X", "Your stay at Hotel Y", "Your booking at Restaurant Z", "Your flight"\n' +
    '- Only extract HOST booking notifications. If this looks like a personal travel/hotel/restaurant booking where the email recipient is the traveller, return not_a_booking.\n\n' +
    'Analyse this email and return ONLY valid JSON with no other text.\n\n' +
    'Classify the email type:\n' +
    '- "new_booking" — a new guest reservation at the host\'s property\n' +
    '- "cancellation" — a guest booking has been cancelled\n' +
    '- "modification" — an existing guest booking\'s dates, guests, or payout have changed\n' +
    '- "not_a_booking" — marketing, review, payout receipt, personal travel booking, message from guest, or anything else\n\n' +
    'If not_a_booking, return: {"not_a_booking": true}\n\n' +
    'Otherwise return:\n' +
    '{\n' +
    '  "emailType": "new_booking" or "cancellation" or "modification",\n' +
    '  "guestName": "Full name of the guest staying at the property",\n' +
    '  "checkin": "YYYY-MM-DD" (null if not found),\n' +
    '  "checkout": "YYYY-MM-DD" (null if not found),\n' +
    '  "guests": number of guests (integer, default 1),\n' +
    '  "hostPayout": host payout amount as a number (0 if not found),\n' +
    '  "cleaningFee": cleaning fee as a number (0 if not found),\n' +
    '  "platform": "airbnb" or "vrbo" or "booking.com" or "stayz" or "direct" or other,\n' +
    '  "confirmationCode": "confirmation/reservation code",\n' +
    '  "status": "confirmed" or "cancelled"\n' +
    '}\n\n' +
    'Rules:\n' +
    '- Dates must be YYYY-MM-DD. ' + yearRule + '\n' +
    '- confirmationCode is CRITICAL for matching cancellations/modifications.\n' +
    '- hostPayout = amount the HOST receives. Look for "Total payout", "You\'ll earn", "Host payout".\n' +
    '- Platform: detect from From address (@airbnb.com = "airbnb").\n' +
    '- Payout receipts ("your payout is on the way") = not_a_booking.\n' +
    '- Review requests = not_a_booking.\n' +
    '- Guest messages = not_a_booking.\n\n' +
    'Subject: ' + subject + '\nFrom: ' + from + '\nBody:\n' + body;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await res.json();
    if (!data.content || !data.content[0] || !data.content[0].text) {
      console.warn('[outlook-scan] Claude returned no content');
      return null;
    }

    const text    = data.content[0].text.trim();
    const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.warn('[outlook-scan] Claude parse error:', err.message);
    return null;
  }
}
