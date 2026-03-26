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
   ═══════════════════════════════════════════════════════════════════════════ */

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

  try {
    // ── 1. Get Gmail config from app_config ─────────────────────────────
    const cfgRes = await fetch(
      SUPABASE_URL + '/rest/v1/app_config?user_id=eq.' + enc(uid) +
        '&select=gmail_refresh_token,gmail_email,gmail_last_scan,gmail_skipped_ids&limit=1',
      { headers: sbHeaders }
    );
    const cfgRows = await cfgRes.json();
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
    } catch (e) {}

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

    // ── 3. Get property ID ─────────────────────────────────────────────
    const propRes = await fetch(
      SUPABASE_URL + '/rest/v1/properties?user_id=eq.' + enc(uid) +
        '&select=id,name&order=updated_at.desc&limit=1',
      { headers: sbHeaders }
    );
    const props = await propRes.json();
    const propertyId = (props && props[0]) ? props[0].id : null;
    const propertyName = (props && props[0]) ? props[0].name : '';

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
      const searchData = await searchRes.json();
      if (searchData.messages) {
        searchData.messages.forEach(m => allMessageIds.add(m.id));
      }
    }

    if (!allMessageIds.size) {
      await updateLastScan(SUPABASE_URL, sbHeaders, uid, skippedIds);
      return json(200, { found: 0, imported: 0, updated: 0, cancelled: 0, skipped: 0, message: 'No booking emails found in the last ' + searchDays + ' days' });
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
      return json(200, { found: allMessageIds.size, imported: 0, updated: 0, cancelled: 0, skipped: allMessageIds.size, message: 'All booking emails already processed' });
    }

    // ── 6. Load existing bookings for matching ─────────────────────────
    const allBookingsRes = await fetch(
      SUPABASE_URL + '/rest/v1/bookings?user_id=eq.' + enc(uid) +
        '&select=id,local_id,confirmation_code,guest_name,checkin,checkout,status' +
        (propertyId ? '&property_id=eq.' + enc(propertyId) : ''),
      { headers: sbHeaders }
    );
    const existingBookings = await allBookingsRes.json();

    // ── 7. Fetch email bodies and parse with Claude ────────────────────
    const results = { imported: 0, updated: 0, cancelled: 0, skipped: 0, errors: 0, details: [] };
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

        const parsed = await parseBookingEmail(ANTHROPIC_KEY, emailSubject, emailFrom, emailBody, propertyName);
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

        const emailType = parsed.emailType || 'new_booking';
        const confCode = (parsed.confirmationCode || '').trim();

        // ── Cancellation ─────────────────────────────────────────────
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

        // ── Modification ─────────────────────────────────────────────
        if (emailType === 'modification') {
          const match = findExistingBooking(existingBookings, confCode, parsed.guestName, null);
          if (match) {
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
          } else if (parsed.checkin && parsed.checkout) {
            await insertNewBooking(SUPABASE_URL, sbHeaders, uid, propertyId, msgId, parsed);
            results.imported++;
            results.details.push({ msgId, status: 'imported', guest: parsed.guestName, checkin: parsed.checkin, note: 'modification without matching original' });
          } else {
            results.skipped++;
            newlySkipped.push(msgId);
            results.details.push({ msgId, status: 'skipped', reason: 'Modification but no matching booking and missing dates' });
          }
          continue;
        }

        // ── New booking ──────────────────────────────────────────────
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

        await insertNewBooking(SUPABASE_URL, sbHeaders, uid, propertyId, msgId, parsed);
        results.imported++;
        results.details.push({ msgId, status: 'imported', guest: parsed.guestName, checkin: parsed.checkin });

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

async function insertNewBooking(supabaseUrl, sbHeaders, uid, propertyId, msgId, parsed) {
  const booking = {
    user_id: uid,
    property_id: propertyId,
    local_id: 'gmail-' + msgId,
    checkin: parsed.checkin,
    checkout: parsed.checkout,
    nights: daysBetween(parsed.checkin, parsed.checkout),
    guest_name: parsed.guestName || 'Guest',
    guests: parsed.guests || 1,
    host_payout: parsed.hostPayout || 0,
    cleaning_fee: parsed.cleaningFee || 0,
    net_payout: (parsed.hostPayout || 0) - (parsed.cleaningFee || 0),
    platform: parsed.platform || '',
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

async function parseBookingEmail(apiKey, subject, from, body, propertyName) {
  const propContext = propertyName ? ' called "' + propertyName + '"' : '';

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
