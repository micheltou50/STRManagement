/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Shared Email Scan Logic
   Extracted from gmail-scan-bookings.js & outlook-scan-bookings.js.
   Both providers delegate to these functions for booking parsing,
   property matching, push notifications, and booking upsert/update.
   ═══════════════════════════════════════════════════════════════════════════ */

const { sendPushToHost, hasRecentNotification } = require('./push-helper');
const { pushChange: pushCalendarChange } = require('./calendar-push-core');
const { notifyCleanerCancellation } = require('./notify-cleaner-cancellation');

// Best-effort outbound calendar push. Never throws — failures are logged
// inside pushChange and queued via pending_direction='to_provider' for the
// reconciler to retry.
function pushBookingToCalendar(uid, localId, op) {
  if (!uid || !localId) return;
  pushCalendarChange(uid, 'bookings', localId, op).catch(e => {
    console.warn('[email-scan-shared] calendar push failed:', e && e.message);
  });
}

// ── Pure helpers ────────────────────────────────────────────────────────────

function enc(s) { return encodeURIComponent(s); }

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function detectPlatform(from) {
  const f = (from || '').toLowerCase();
  if (f.includes('airbnb.com')) return 'Airbnb';
  if (f.includes('booking.com')) return 'Booking.com';
  if (f.includes('vrbo.com') || f.includes('homeaway.com')) return 'VRBO';
  if (f.includes('stayz.com')) return 'Stayz';
  if (f.includes('expedia.com')) return 'Expedia';
  return '';
}

function daysBetween(d1, d2) {
  const a = new Date(d1);
  const b = new Date(d2);
  return Math.max(0, Math.round((b - a) / 86400000));
}

/** Safely parse a fetch response as JSON. Throws a readable error on HTML / non-JSON. */
async function safeJson(res, label) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (_) {
    const preview = text.slice(0, 120).replace(/\n/g, ' ');
    throw new Error((label || 'API') + ' returned non-JSON (HTTP ' + res.status + '): ' + preview);
  }
}

// ── Pre-filter ──────────────────────────────────────────────────────────────

/** Quick local check — does the email look like a booking confirmation/cancellation/modification?
 *  Avoids sending marketing, payout, or promo emails to Claude. */
function looksLikeBookingEmail(subject, from, body) {
  const subLo = (subject || '').toLowerCase();
  const fromLo = (from || '').toLowerCase();
  const bodyLo = (body || '').toLowerCase().slice(0, 3000);

  const bookingPlatforms = ['airbnb.com', 'booking.com', 'vrbo.com', 'homeaway.com', 'stayz.com', 'expedia.com'];
  const isFromPlatform = bookingPlatforms.some(p => fromLo.includes(p));

  // Optional dev bypass — set EMAIL_SCAN_DEV_BYPASS_FROM (comma-separated addresses)
  // in Netlify env to allow specific senders through without keyword matching.
  // Production should leave this unset.
  const devBypass = (process.env.EMAIL_SCAN_DEV_BYPASS_FROM || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (devBypass.length && devBypass.some(addr => fromLo.includes(addr))) return true;

  // If the sender isn't a known booking platform, definitely not a booking email
  if (!isFromPlatform) return false;

  // Exclude known non-booking emails before checking keywords
  const skipSubjects = [
    'payout', 'earnings', 'tax', 'review', 'rate your',
    'how was', 'feedback', 'newsletter', 'tips for',
    'marketing', 'promote', 'superhost', 'performance',
    'monthly summary', 'annual summary', 'year in review',
    'account update', 'password', 'verify your', 'security',
    'invite', 'referral', 'coupon', 'discount',
    'reminder', 'coming soon', 'arriving', 'starts tomorrow',
    'check-in today', 'checkout today', 'leaving today',
    'experience', 'receipt', 'invoice',
    'welcome home', 'how to prepare', 'getting ready',
  ];
  if (skipSubjects.some(s => subLo.includes(s))) return false;

  const keywords = [
    'reservation', 'booking', 'confirmed', 'confirmation',
    'cancelled', 'canceled', 'cancellation',
    'check-in', 'checkin', 'check in',
    'checkout', 'check-out', 'check out',
    'arrival', 'guest', 'nights',
    'alteration', 'modified', 'modification',
    'itinerary',
  ];

  return keywords.some(kw => subLo.includes(kw) || bodyLo.includes(kw));
}

// ── Booking matching ────────────────────────────────────────────────────────

function findExistingBooking(bookings, confCode, guestName, checkin, propertyId) {
  if (!Array.isArray(bookings)) return null;

  // Tier 1: confirmation code (strongest)
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

  // Tier 2: property_id + checkin — catches iCal-seeded stubs once the email
  // resolves the property. iCal doesn't carry guest name or platform's
  // human-facing confirmation code, so this is the natural enrichment join.
  if (propertyId && checkin) {
    const byPropDate = bookings.find(b =>
      String(b.property_id) === String(propertyId) &&
      b.checkin === checkin &&
      b.status !== 'cancelled'
    );
    if (byPropDate) return byPropDate;
  }

  // Tier 3: guest name + checkin
  if (guestName && checkin) {
    const normName = guestName.toLowerCase().trim();
    const byNameDate = bookings.find(b =>
      b.guest_name && b.guest_name.toLowerCase().trim() === normName &&
      b.checkin === checkin
    );
    if (byNameDate) return byNameDate;
  }

  // Tier 4: guest name only when unique
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

// ── Property resolution ─────────────────────────────────────────────────────

function resolveProperty(parsed, isSingleProperty, propMap, defaultProp) {
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

  return { resolvedProp, propertyUnconfirmed };
}

// ── Property loading ────────────────────────────────────────────────────────

async function loadProperties(supabaseUrl, sbHeaders, uid, pidParam) {
  const propRes = await fetch(
    supabaseUrl + '/rest/v1/properties?user_id=eq.' + enc(uid) +
      '&select=id,name,address,suburb,state,mgmt_fee_rate,airbnb_listing_id,airbnb_listing_title&order=created_at.asc',
    { headers: sbHeaders }
  );
  const allProps = await safeJson(propRes, 'Supabase properties');
  if (!Array.isArray(allProps) || !allProps.length) return null;

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

  const defaultProp = (pidParam && propMap.find(p => p.id === pidParam)) || propMap[0];
  const isSingleProperty = propMap.length === 1;

  const propertyListStr = propMap.map((p, i) =>
    (i + 1) + '. "' + p.name + '"' +
    (p.airbnbListingTitle && p.airbnbListingTitle !== p.name
      ? ' (Airbnb listing: "' + p.airbnbListingTitle + '")'
      : '') +
    (p.address ? ' at ' + p.address : '') +
    (p.suburb ? ', ' + p.suburb : '') +
    (p.state ? ' ' + p.state : '')
  ).join('\n');

  return { propMap, defaultProp, isSingleProperty, propertyListStr };
}

// ── Load existing bookings and processed IDs ────────────────────────────────

async function loadExistingBookings(supabaseUrl, sbHeaders, uid) {
  const res = await fetch(
    supabaseUrl + '/rest/v1/bookings?user_id=eq.' + enc(uid) +
      '&select=id,local_id,confirmation_code,guest_name,checkin,checkout,guests,status,property_id,host_payout,cleaning_fee,platform,source,enrichment_status,ical_uid',
    { headers: sbHeaders }
  );
  return await safeJson(res, 'Supabase bookings list');
}

async function loadProcessedIds(supabaseUrl, sbHeaders, uid, sourceFilter) {
  const sourceClause = sourceFilter ? '&source=eq.' + enc(sourceFilter) : '';
  const res = await fetch(
    supabaseUrl + '/rest/v1/bookings?user_id=eq.' + enc(uid) +
      sourceClause + '&select=gmail_message_id&gmail_message_id=not.is.null',
    { headers: sbHeaders }
  );
  const rows = await safeJson(res, 'Supabase processed IDs');
  return new Set(
    (Array.isArray(rows) ? rows : []).map(r => r.gmail_message_id).filter(Boolean)
  );
}

// ── Booking insertion ───────────────────────────────────────────────────────

async function insertNewBooking(supabaseUrl, sbHeaders, uid, propertyId, msgId, parsed, mgmtFeeRate, propertyUnconfirmed, emailFrom, source) {
  const rate     = Number(mgmtFeeRate) || 0;
  const payout   = parsed.hostPayout  || 0;
  const cleaning = parsed.cleaningFee || 0;
  const mgmtBase   = payout - cleaning;
  const mgmtFee    = Math.round(mgmtBase * (rate / 100) * 100) / 100;
  const netPayout  = Math.round((mgmtBase - mgmtFee) * 100) / 100;
  const booking = {
    user_id: uid,
    property_id: propertyId,
    property_unconfirmed: !!propertyUnconfirmed,
    local_id: source + '-' + msgId,
    checkin: parsed.checkin,
    checkout: parsed.checkout,
    nights: daysBetween(parsed.checkin, parsed.checkout),
    guest_name: parsed.guestName || 'Guest',
    guests: parsed.guests || 1,
    host_payout: payout,
    cleaning_fee: cleaning,
    net_payout: netPayout,
    mgmt_fee_raw: rate,
    mgmt_fee: mgmtFee,
    mgmt_payout: mgmtFee,
    platform: parsed.platform || detectPlatform(emailFrom || ''),
    confirmation_code: parsed.confirmationCode || '',
    status: 'confirmed',
    source: source,
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
    console.warn('[' + source + '-scan] Insert failed for', msgId, errText);
    return false;
  }
  return true;
}

// ── Push notifications ──────────────────────────────────────────────────────

async function fetchBookingRowByMessageId(supabaseAdmin, uid, msgId) {
  const { data, error } = await supabaseAdmin
    .from('bookings')
    .select('id, property_id, guest_name, checkin, checkout, guests, platform, host_payout, status')
    .eq('user_id', uid)
    .eq('gmail_message_id', msgId)
    .limit(1);
  if (error || !data || !data.length) return null;
  return data[0];
}

async function notifyBookingOwnerPush(supabaseAdmin, { notifyType, propertyId, bookingRow, fallbackPropertyName, changes }) {
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
      const changeStr = Array.isArray(changes) && changes.length ? ' · ' + changes.join(' · ') : '';
      body = g + changeStr;
    } else if (notifyType === 'modification_notice') {
      title = '📝 Booking Modified — ' + propertyName;
      body = g + ' — check itinerary for updated details';
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

// ── Claude prompt & parsing ─────────────────────────────────────────────────

function buildParsingPrompt(subject, from, body, singlePropertyName, propertyList) {
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
      'If the email mentions the listing/property title (e.g. Airbnb: "Reservation confirmed - <title>"; Booking.com: "New Booking for <title>"), return it in "listingTitle".\n'
    : '';

  const propertyMatchJson = propertyList
    ? '  "propertyMatch": "exact property name from the list above, or null if unclear",\n'
    : '';

  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const currentYear = now.getFullYear();
  const nextYear = currentYear + 1;

  const yearRule =
    'Today is ' + todayStr + '. ' +
    'When a date in the email has no year, infer the year using this exact rule: ' +
    '(1) Combine the month and day with ' + currentYear + '. ' +
    '(2) If that date is today or still in the future, use ' + currentYear + '. ' +
    '(3) If that date has already passed, use ' + nextYear + '. ' +
    'Never use any year other than ' + currentYear + ' or ' + nextYear + '.';

  return (
    'You are a booking email parser for a short-term rental HOST who manages a property' + propContext + '.\n\n' +
    'You are analysing emails from the HOST\'s inbox. The host receives booking notifications when GUESTS book their property.\n\n' +
    'CRITICAL DISTINCTION:\n' +
    '- HOST emails say things like: "You have a new reservation", "Your guest X is arriving", "You\'ll earn $X", "Host payout", "New booking at ' + (singlePropertyName || 'your property') + '"\n' +
    '- PERSONAL TRAVEL emails say things like: "Your trip to X", "Your stay at Hotel Y", "Your booking at Restaurant Z", "Your flight"\n' +
    '- Only extract HOST booking notifications. If this looks like a personal travel/hotel/restaurant booking where the email recipient is the traveller, return {"not_a_booking": true}.\n\n' +
    'Analyse this email and return ONLY valid JSON with no other text.\n\n' +
    'Classify the email type:\n' +
    '- "new_booking" — a new guest reservation at the host\'s property (confirmed)\n' +
    '- "cancellation" — a guest booking has been cancelled\n' +
    '- "modification" — an existing guest booking is being modified, has been requested to be modified, or has already been modified. The email body contains the proposed or final NEW values for any of: dates, number of guests, payout. Subjects that indicate a modification (any of these = modification): "Hieu wants to change their reservation", "[Name] wants to change their reservation", "Reservation modified", "Reservation altered", "Trip update for [name]", "Reservation update request", "Alteration request". An alteration REQUEST email IS a modification — classify and extract optimistically, since modifications are nearly always accepted.\n' +
    '- "modification_notice" — a modification was made/accepted but the body does NOT contain the new values; it only links to the itinerary. Examples: subject "Reservation updated" with a body that just says "Your reservation has been updated. Go to itinerary." with NO numbers visible. If the body has any new value visible (e.g. "Requested Guests: 6 guests"), classify as "modification" instead, not "modification_notice".\n' +
    '- "not_a_booking" — marketing, review, payout receipt, enquiry, personal travel booking, message from guest, or anything else\n\n' +
    'If not_a_booking, return: {"not_a_booking": true}\n\n' +
    'For cancellation, return JSON with "emailType":"cancellation" plus guestName, confirmationCode, and checkin/checkout when present (for matching an existing booking).\n\n' +
    'For modification_notice, return JSON with "emailType":"modification_notice" plus guestName, confirmationCode, and listingTitle when present (for matching the existing booking). Extract the confirmation code from URLs if it appears there (e.g. /reservations/details/XXXX or /reservation/alteration/XXXX). Also try to extract checkin/checkout/guests/hostPayout/cleaningFee if any appear in the body (return null if not present) — but only when the body clearly contains a new value (e.g. "We\'ve updated guests to 4"). If the body is purely a link with no numbers, return nulls for those.\n\n' +
    'For new_booking or modification, return:\n' +
    '{\n' +
    '  "emailType": "new_booking" or "modification",\n' +
    '  "guestName": "Full name of the guest staying at the property",\n' +
    '  "checkin": "YYYY-MM-DD" (null if not found),\n' +
    '  "checkout": "YYYY-MM-DD" (null if not found),\n' +
    '  "guests": number of guests (integer, default 1),\n' +
    '  "hostPayout": host payout amount as a number (0 if not found),\n' +
    '  "cleaningFee": cleaning fee as a number (0 if not found),\n' +
    '  "platform": "airbnb" or "vrbo" or "booking.com" or "stayz" or "direct" or other,\n' +
    '  "airbnbListingId": "numeric Airbnb listing ID from a URL like airbnb.com/rooms/12345 (Airbnb emails only), or null",\n' +
    '  "listingTitle": "the property/listing title from the email subject or body (e.g. Airbnb: \'Reservation confirmed - Seaview Cottage\'; Booking.com: \'New Booking for Seaview Cottage\'), or null",\n' +
    propertyMatchJson +
    '  "confirmationCode": "confirmation/reservation code",\n' +
    '  "status": "confirmed" or "cancelled"\n' +
    '}\n\n' +
    'Rules:\n' +
    '- Dates must be YYYY-MM-DD. ' + yearRule + '\n' +
    '- confirmationCode is CRITICAL for matching. For Airbnb this is an alphanumeric code (e.g. HM2ABC123). For Booking.com this is typically a numeric booking number (e.g. 4567890123). Extract from the email body or URLs.\n' +
    '- hostPayout = amount the HOST receives. For Airbnb: look for "Total payout", "You\'ll earn", "Host payout". For Booking.com: look for total price minus commission, or "Payout", "Your revenue". If only total price and commission are shown, compute hostPayout = total - commission.\n' +
    '- Platform: detect from From address (@airbnb.com = "airbnb", @booking.com = "booking.com", @vrbo.com or @homeaway.com = "vrbo", @stayz.com = "stayz").\n' +
    '- Payout receipts ("your payout is on the way") = not_a_booking.\n' +
    '- Review requests = not_a_booking.\n' +
    '- Guest messages = not_a_booking.\n' +
    '- Do not classify a mere inquiry or "request to book" as new_booking; wait for confirmed reservation language.\n' +
    '- For modifications, when the email shows BOTH an original/previous value AND a new/requested value (e.g. Airbnb format: "Original Guests: 8 guests" struck through, "Requested Guests: 6 guests"), ALWAYS extract the NEW value, NOT the original. Labels that indicate the NEW value: "Requested Guests", "New Guests", "Updated Guests", "New check-in", "New checkout", "Requested dates", "New payout", "Updated payout", "Requested check-in". Labels that indicate the OLD value (do NOT use): "Original Guests", "Previous Guests", "Original check-in", "Original payout".\n' +
    '- A modification email NEVER has guests: null or 0 if the body shows any "Requested" or "New" guest count. Same for dates and payout.\n' +
    propertyMatchRule +
    '\nSubject: ' + subject + '\nFrom: ' + from + '\nBody:\n' + body
  );
}

async function callClaude(apiKey, prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error('Claude API ' + res.status + ': ' + errBody.slice(0, 200));
  }

  const data = await safeJson(res, 'Claude API');
  if (!data.content || !data.content[0] || !data.content[0].text) return null;

  const text = data.content[0].text.trim();
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(cleaned);
}

async function parseBookingEmail(apiKey, subject, from, body, singlePropertyName, propertyList) {
  try {
    const prompt = buildParsingPrompt(subject, from, body, singlePropertyName, propertyList);
    return await callClaude(apiKey, prompt);
  } catch (err) {
    console.warn('[email-scan] Claude parse error:', err.message);
    return null;
  }
}

// ── Core processing loop body ───────────────────────────────────────────────

/**
 * Process a single parsed email result — handles cancellation, modification,
 * modification_notice, and new_booking. Returns void; mutates `results`,
 * `needsReview`, and `newlySkipped` in place.
 *
 * @param {object} parsed - Claude parsed result
 * @param {string} msgId - message ID
 * @param {string} source - 'gmail' or 'outlook'
 * @param {object} ctx - shared context
 */
async function processEmailResult(parsed, msgId, source, ctx) {
  const {
    supabaseUrl, sbHeaders, uid, existingBookings, propMap, defaultProp,
    isSingleProperty, results, needsReview, newlySkipped, emailFrom,
    supabaseAdmin,
  } = ctx;

  if (!parsed) {
    results.skipped++;
    newlySkipped.push(msgId);
    results.details.push({ msgId, status: 'skipped', reason: 'No booking data returned — skipped' });
    return;
  }
  if (parsed.not_a_booking) {
    results.skipped++;
    newlySkipped.push(msgId);
    results.details.push({ msgId, status: 'skipped', reason: 'Not a host booking email' });
    return;
  }

  // Normalize email type across both providers
  const rawType = String(parsed.email_type || parsed.emailType || '').toLowerCase();
  const emailType = rawType === 'confirmation' ? 'new_booking' : rawType;

  // Skip non-actionable types
  if (
    emailType === 'not_a_booking' ||
    emailType === 'enquiry' ||
    emailType === 'other' ||
    emailType === 'payout_notification' ||
    (parsed.skipped === true && emailType !== 'cancellation' && emailType !== 'modification_notice')
  ) {
    results.skipped++;
    newlySkipped.push(msgId);
    results.details.push({
      msgId,
      status: 'skipped',
      reason: 'Non-actionable email' + (emailType ? ' (' + emailType + ')' : ''),
    });
    return;
  }

  // Property resolution
  const { resolvedProp, propertyUnconfirmed } = resolveProperty(parsed, isSingleProperty, propMap, defaultProp);
  const propertyId   = resolvedProp.id;
  const propertyName = resolvedProp.name;
  const mgmtFeeRate  = resolvedProp.mgmtFeeRate;
  const confCode = (parsed.confirmationCode || '').trim();

  // ── Cancellation ────────────────────────────────────────────────────
  if (emailType === 'cancellation') {
    const match = findExistingBooking(existingBookings, confCode, parsed.guestName, parsed.checkin, propertyId);
    if (match) {
      const wasCancelled = String(match.status || '').toLowerCase() === 'cancelled';
      await fetch(
        supabaseUrl + '/rest/v1/bookings?id=eq.' + enc(match.id),
        {
          method: 'PATCH',
          headers: { ...sbHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify({ status: 'cancelled', gmail_message_id: msgId, updated_at: new Date().toISOString() }),
        }
      );
      pushBookingToCalendar(uid, match.local_id, 'delete');
      results.cancelled++;
      results.details.push({ msgId, status: 'cancelled', guest: parsed.guestName || match.guest_name, confCode });
      // Mark this msgId as processed so it's not re-scanned (the booking's gmail_message_id
      // gets overwritten on subsequent updates, so we can't rely on it alone for dedup)
      newlySkipped.push(msgId);
      if (!wasCancelled && supabaseAdmin) {
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
        await notifyCleanerCancellation({
          supabaseUrl,
          sbHeaders,
          userId: uid,
          bookingId: match.id,
          bookingRow: {
            guest_name: parsed.guestName || match.guest_name,
            property_id: match.property_id,
            guests: match.guests,
          },
        });
      }
    } else {
      results.skipped++;
      newlySkipped.push(msgId);
      results.details.push({ msgId, status: 'skipped', reason: 'Cancellation but no matching booking found' });
    }
    return;
  }

  // ── Modification (with updated details) ─────────────────────────────
  if (emailType === 'modification') {
    const match = findExistingBooking(existingBookings, confCode, parsed.guestName, parsed.checkin, propertyId);
    if (match) {
      const datesChanged =
        (parsed.checkin && parsed.checkin !== match.checkin) ||
        (parsed.checkout && parsed.checkout !== match.checkout);
      const patch = {
        updated_at: new Date().toISOString(),
        gmail_message_id: msgId,
        modification_pending_at: new Date().toISOString(),
      };
      if (parsed.checkin)   patch.checkin  = parsed.checkin;
      if (parsed.checkout)  patch.checkout = parsed.checkout;
      if (parsed.checkin && parsed.checkout) patch.nights = daysBetween(parsed.checkin, parsed.checkout);
      if (parsed.guests)      patch.guests     = parsed.guests;
      if (parsed.hostPayout)  patch.host_payout  = parsed.hostPayout;
      if (parsed.cleaningFee) patch.cleaning_fee = parsed.cleaningFee;

      await fetch(
        supabaseUrl + '/rest/v1/bookings?id=eq.' + enc(match.id),
        { method: 'PATCH', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify(patch) }
      );
      pushBookingToCalendar(uid, match.local_id, 'upsert');
      results.updated++;
      results.details.push({ msgId, status: 'updated', guest: parsed.guestName, checkin: parsed.checkin });
      // Mark this msgId as processed so it's not re-scanned
      newlySkipped.push(msgId);

      // Push notification if dates or price changed
      const priceChanged =
        (parsed.hostPayout != null && Number(parsed.hostPayout) !== Number(match.host_payout || 0)) ||
        (parsed.cleaningFee != null && Number(parsed.cleaningFee) !== Number(match.cleaning_fee || 0));
      if ((datesChanged || priceChanged) && supabaseAdmin) {
        const modPropName = (propMap.find(p => p.id === match.property_id) || {}).name || propertyName;
        const { data: modRow, error: modFetchErr } = await supabaseAdmin
          .from('bookings')
          .select('id, property_id, guest_name, checkin, checkout, guests, platform, host_payout, status')
          .eq('id', match.id)
          .maybeSingle();
        if (!modFetchErr && modRow) {
          const changes = [];
          if (parsed.checkin && parsed.checkin !== match.checkin) changes.push('dates: ' + match.checkin + ' → ' + parsed.checkin);
          else if (parsed.checkout && parsed.checkout !== match.checkout) changes.push('dates: to ' + match.checkout + ' → ' + parsed.checkout);
          if (parsed.hostPayout != null && Number(parsed.hostPayout) !== Number(match.host_payout || 0)) {
            changes.push('payout: $' + Number(match.host_payout || 0).toFixed(2) + ' → $' + Number(parsed.hostPayout).toFixed(2));
          }
          await notifyBookingOwnerPush(supabaseAdmin, {
            notifyType: 'booking_modified',
            propertyId: match.property_id,
            bookingRow: modRow,
            fallbackPropertyName: modPropName,
            changes,
          });
        }
      }
    } else if (parsed.checkin && parsed.checkout) {
      // Modification with no matching original — insert as new
      await insertNewBooking(supabaseUrl, sbHeaders, uid, propertyId, msgId, parsed, mgmtFeeRate, propertyUnconfirmed, emailFrom, source);
      pushBookingToCalendar(uid, source + '-' + msgId, 'upsert');
      results.imported++;
      results.details.push({ msgId, status: 'imported', guest: parsed.guestName, checkin: parsed.checkin, note: 'modification without matching original' });
      // Mark this msgId as processed so it's not re-scanned
      newlySkipped.push(msgId);
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
    } else {
      results.skipped++;
      newlySkipped.push(msgId);
      results.details.push({ msgId, status: 'skipped', reason: 'Modification but no matching booking and missing dates' });
    }
    return;
  }

  // ── Modification notice (alteration accepted, no details) ───────────
  if (emailType === 'modification_notice') {
    const modMatch = findExistingBooking(existingBookings, confCode, parsed.guestName, parsed.checkin, propertyId);
    if (modMatch) {
      // Defense in depth: apply any actual values Claude extracted from the body
      // (e.g. when the request email said "wants to change to 8 guests" but
      // Claude still classified it as a notice rather than a full modification).
      const patch = {
        updated_at: new Date().toISOString(),
        modification_pending_at: new Date().toISOString(),
      };
      const appliedChanges = [];
      if (parsed.checkin && parsed.checkin !== modMatch.checkin) {
        patch.checkin = parsed.checkin;
        appliedChanges.push('checkin: ' + modMatch.checkin + ' → ' + parsed.checkin);
      }
      if (parsed.checkout && parsed.checkout !== modMatch.checkout) {
        patch.checkout = parsed.checkout;
        appliedChanges.push('checkout: ' + modMatch.checkout + ' → ' + parsed.checkout);
      }
      if (patch.checkin || patch.checkout) {
        patch.nights = daysBetween(patch.checkin || modMatch.checkin, patch.checkout || modMatch.checkout);
      }
      if (parsed.guests && Number(parsed.guests) !== Number(modMatch.guests)) {
        patch.guests = parsed.guests;
        appliedChanges.push('guests: ' + (modMatch.guests || 1) + ' → ' + parsed.guests);
      }
      if (parsed.hostPayout && Number(parsed.hostPayout) !== Number(modMatch.host_payout || 0)) {
        patch.host_payout = parsed.hostPayout;
        appliedChanges.push('payout: $' + Number(modMatch.host_payout || 0).toFixed(2) + ' → $' + Number(parsed.hostPayout).toFixed(2));
      }
      if (parsed.cleaningFee && Number(parsed.cleaningFee) !== Number(modMatch.cleaning_fee || 0)) {
        patch.cleaning_fee = parsed.cleaningFee;
      }
      await fetch(
        supabaseUrl + '/rest/v1/bookings?id=eq.' + enc(modMatch.id),
        { method: 'PATCH', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify(patch) }
      );
      pushBookingToCalendar(uid, modMatch.local_id, 'upsert');
      const modPropName = (propMap.find(p => p.id === modMatch.property_id) || {}).name || propertyName;
      if (supabaseAdmin) {
        await notifyBookingOwnerPush(supabaseAdmin, {
          notifyType: appliedChanges.length ? 'booking_modified' : 'modification_notice',
          propertyId: modMatch.property_id || propertyId,
          bookingRow: modMatch,
          fallbackPropertyName: modPropName,
          changes: appliedChanges.length ? appliedChanges : undefined,
        });
      }
      needsReview.push({
        guest: parsed.guestName || modMatch.guest_name || 'Guest',
        checkin: patch.checkin || modMatch.checkin,
        checkout: patch.checkout || modMatch.checkout,
        platform: modMatch.platform || '',
        gmail_message_id: msgId,
        assigned_property: modPropName,
        reason: appliedChanges.length
          ? 'Booking updated from email: ' + appliedChanges.join(', ')
          : 'Booking was modified on the platform — check itinerary for updated details',
      });
      results.updated++;
      results.details.push({ msgId, status: appliedChanges.length ? 'updated' : 'modification_notice', guest: parsed.guestName || modMatch.guest_name, changes: appliedChanges });
    } else {
      needsReview.push({
        guest: parsed.guestName || 'Guest',
        platform: parsed.platform || detectPlatform(emailFrom),
        gmail_message_id: msgId,
        reason: 'Modification detected but could not match to an existing booking',
      });
      results.details.push({ msgId, status: 'modification_notice_unmatched', guest: parsed.guestName });
    }
    newlySkipped.push(msgId);
    return;
  }

  // ── New booking ─────────────────────────────────────────────────────
  if (emailType !== 'new_booking') {
    results.skipped++;
    newlySkipped.push(msgId);
    results.details.push({
      msgId,
      status: 'skipped',
      reason: emailType ? 'Unexpected email_type: ' + emailType : 'Missing or invalid email_type',
    });
    return;
  }

  if (!parsed.checkin || !parsed.checkout) {
    results.skipped++;
    newlySkipped.push(msgId);
    results.details.push({ msgId, status: 'skipped', reason: 'Missing check-in or check-out date' });
    return;
  }

  // Enrich an iCal-seeded stub if one matches (by code, or property_id+checkin).
  // The stub already has dates/property; the email fills in guest name, payout,
  // cleaning fee, and the human-facing confirmation code.
  const stub = findExistingBooking(existingBookings, confCode, parsed.guestName, parsed.checkin, propertyId);
  if (stub) {
    const stubName = String(stub.guest_name || '').trim();
    const isStub = stub.source === 'ical' || stub.enrichment_status === 'pending' || stubName === 'Reserved' || stubName === 'Reserved — awaiting details';
    if (isStub || (stub.confirmation_code || '') !== confCode) {
      const rate = Number(mgmtFeeRate) || 0;
      const payout = parsed.hostPayout || 0;
      const cleaning = parsed.cleaningFee || 0;
      const mgmtBase = payout - cleaning;
      const mgmtFee = Math.round(mgmtBase * (rate / 100) * 100) / 100;
      const netPayout = Math.round((mgmtBase - mgmtFee) * 100) / 100;
      const patch = {
        guest_name: parsed.guestName || stub.guest_name || 'Guest',
        guests: parsed.guests || 1,
        host_payout: payout,
        cleaning_fee: cleaning,
        net_payout: netPayout,
        mgmt_fee_raw: rate,
        mgmt_fee: mgmtFee,
        mgmt_payout: mgmtFee,
        platform: parsed.platform || stub.platform || detectPlatform(emailFrom || ''),
        confirmation_code: confCode || stub.confirmation_code || '',
        enrichment_status: 'enriched',
        gmail_message_id: msgId,
        updated_at: new Date().toISOString(),
      };
      // If the email's checkin/checkout differ from the stub, trust the email.
      if (parsed.checkin && parsed.checkin !== stub.checkin) {
        patch.checkin = parsed.checkin;
      }
      if (parsed.checkout && parsed.checkout !== stub.checkout) {
        patch.checkout = parsed.checkout;
      }
      if (patch.checkin || patch.checkout) {
        patch.nights = daysBetween(patch.checkin || stub.checkin, patch.checkout || stub.checkout);
      }
      await fetch(
        supabaseUrl + '/rest/v1/bookings?id=eq.' + enc(stub.id),
        { method: 'PATCH', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify(patch) }
      );
      pushBookingToCalendar(uid, stub.local_id, 'upsert');
      results.updated++;
      results.details.push({ msgId, status: 'enriched', guest: parsed.guestName, checkin: parsed.checkin });
      newlySkipped.push(msgId);
      if (supabaseAdmin) {
        const enrichRow = {
          id: stub.id,
          property_id: stub.property_id,
          guest_name: parsed.guestName || stub.guest_name,
          checkin: patch.checkin || stub.checkin,
          checkout: patch.checkout || stub.checkout,
          guests: patch.guests,
          platform: patch.platform,
          host_payout: payout,
        };
        const enrichPropName = (propMap.find(p => p.id === stub.property_id) || {}).name || propertyName;
        await notifyBookingOwnerPush(supabaseAdmin, {
          notifyType: 'new_booking',
          propertyId: stub.property_id,
          bookingRow: enrichRow,
          fallbackPropertyName: enrichPropName,
        });
      }
      return;
    }
    // Same confirmation code, already enriched — true duplicate.
    results.skipped++;
    newlySkipped.push(msgId);
    results.details.push({ msgId, status: 'skipped', reason: 'Booking already enriched' });
    return;
  }

  const inserted = await insertNewBooking(supabaseUrl, sbHeaders, uid, propertyId, msgId, parsed, mgmtFeeRate, propertyUnconfirmed, emailFrom, source);
  if (inserted) pushBookingToCalendar(uid, source + '-' + msgId, 'upsert');
  if (inserted && supabaseAdmin) {
    results.imported++;
    const insRow = await fetchBookingRowByMessageId(supabaseAdmin, uid, msgId);
    if (insRow) {
      await notifyBookingOwnerPush(supabaseAdmin, {
        notifyType: 'new_booking',
        propertyId: insRow.property_id || propertyId,
        bookingRow: insRow,
        fallbackPropertyName: propertyName,
      });
    }
  } else {
    results.imported++;
  }
  results.details.push({ msgId, status: 'imported', guest: parsed.guestName, checkin: parsed.checkin });
  // Mark this msgId as processed so it's not re-scanned
  newlySkipped.push(msgId);
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
}

// ── Finalize results ────────────────────────────────────────────────────────

function capSkippedIds(skippedIds, newlySkipped) {
  newlySkipped.forEach(id => skippedIds.add(id));
  // Cap at 2000 — large enough to retain ~14 days of processed emails
  // (every successful action now adds to skipped list, not just not-a-booking)
  if (skippedIds.size > 2000) {
    const arr = [...skippedIds];
    return new Set(arr.slice(arr.length - 2000));
  }
  return skippedIds;
}

function buildSummaryResponse(allMessageIds, results, needsReview, batch) {
  const parts = [];
  if (results.imported) parts.push(results.imported + ' imported');
  if (results.updated) parts.push(results.updated + ' updated');
  if (results.cancelled) parts.push(results.cancelled + ' cancelled');
  const message = parts.length ? 'Bookings: ' + parts.join(', ') : 'No new booking changes found';

  return {
    found: allMessageIds.size,
    imported: results.imported,
    updated: results.updated,
    cancelled: results.cancelled,
    skipped: results.skipped,
    errors: results.errors,
    remaining: Math.max(0, (allMessageIds._totalNew || 0) - batch.length),
    details: results.details,
    needs_review: needsReview,
    message,
  };
}

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  enc,
  json,
  safeJson,
  detectPlatform,
  daysBetween,
  looksLikeBookingEmail,
  findExistingBooking,
  resolveProperty,
  loadProperties,
  loadExistingBookings,
  loadProcessedIds,
  insertNewBooking,
  fetchBookingRowByMessageId,
  notifyBookingOwnerPush,
  buildParsingPrompt,
  callClaude,
  parseBookingEmail,
  processEmailResult,
  capSkippedIds,
  buildSummaryResponse,
};
