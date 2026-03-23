// ── Supabase Edge Function: poll-emails ───────────────────────────────────────
// Runs on a schedule via pg_cron every 3 minutes.
// For each connected email account, reads unread booking emails,
// parses them with Claude Haiku, and writes bookings to Supabase.
//
// Deploy: supabase functions deploy poll-emails
//
// Required Supabase secrets:
//   ANTHROPIC_API_KEY   — your Anthropic API key
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   MICROSOFT_CLIENT_ID
//   MICROSOFT_CLIENT_SECRET
//
// The function reads/writes these tables:
//   email_connections  — OAuth tokens per user
//   bookings           — parsed booking records
//   properties         — to get property name for routing

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ANTHROPIC_API_KEY    = Deno.env.get('ANTHROPIC_API_KEY') || '';
const GOOGLE_CLIENT_ID     = Deno.env.get('GOOGLE_CLIENT_ID') || '';
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') || '';
const MICROSOFT_CLIENT_ID     = Deno.env.get('MICROSOFT_CLIENT_ID') || '';
const MICROSOFT_CLIENT_SECRET = Deno.env.get('MICROSOFT_CLIENT_SECRET') || '';
const SUPABASE_URL            = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

// Booking email senders to watch
const AIRBNB_SENDERS  = ['automated@airbnb.com', 'express@airbnb.com', 'noreply@airbnb.com'];
const VRBO_SENDERS    = ['no-reply@vrbo.com', 'do-not-reply@homeaway.com'];
const ALL_SENDERS     = [...AIRBNB_SENDERS, ...VRBO_SENDERS];

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────

Deno.serve(async (_req) => {
  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // 1. Get all connected email accounts
    const { data: connections, error: connError } = await sb
      .from('email_connections')
      .select('*')
      .not('refresh_token', 'is', null);

    if (connError) throw new Error('Failed to load connections: ' + connError.message);
    if (!connections || connections.length === 0) {
      return new Response(JSON.stringify({ ok: true, message: 'No connections' }), { status: 200 });
    }

    console.log(`[poll-emails] Processing ${connections.length} connection(s)`);

    const results = [];

    for (const conn of connections) {
      try {
        const result = await processConnection(sb, conn);
        results.push({ user_id: conn.user_id, ...result });
      } catch (err) {
        console.error(`[poll-emails] Error for user ${conn.user_id}:`, err.message);
        results.push({ user_id: conn.user_id, error: err.message });
      }
    }

    return new Response(JSON.stringify({ ok: true, results }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[poll-emails] Fatal error:', err.message);
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500 });
  }
});

// ── PROCESS ONE CONNECTION ─────────────────────────────────────────────────────

async function processConnection(sb, conn) {
  // 1. Refresh token if needed
  const accessToken = await ensureFreshToken(sb, conn);
  if (!accessToken) throw new Error('Could not refresh token');

  // 2. Get property details for this user
  const { data: property } = await sb
    .from('properties')
    .select('id, name')
    .eq('user_id', conn.user_id)
    .single();

  const propertyName = property?.name || '';
  const propertyId   = property?.id   || null;

  // 3. Fetch unread booking emails
  const emails = conn.provider === 'google'
    ? await fetchGmailBookings(accessToken)
    : await fetchOutlookBookings(accessToken);

  if (!emails || emails.length === 0) {
    return { emails_found: 0, bookings_created: 0 };
  }

  console.log(`[poll-emails] Found ${emails.length} email(s) for user ${conn.user_id}`);

  let bookingsCreated = 0;
  let bookingsUpdated = 0;

  // 4. Parse each email with Claude
  for (const email of emails) {
    try {
      const parsed = await parseEmailWithClaude(email.subject, email.body, propertyName);
      if (!parsed || parsed.action === 'ignore') continue;
      if (!parsed.guestName || !parsed.checkin) continue;

      // 5. Write to Supabase
      const result = await upsertBooking(sb, conn.user_id, propertyId, parsed, email.id);
      if (result === 'created') bookingsCreated++;
      if (result === 'updated' || result === 'cancelled') bookingsUpdated++;

      // 6. Mark email as read/processed
      if (conn.provider === 'google') {
        await markGmailRead(accessToken, email.id);
      } else {
        await markOutlookRead(accessToken, email.id);
      }
    } catch (err) {
      console.error(`[poll-emails] Failed to parse email ${email.id}:`, err.message);
    }
  }

  return { emails_found: emails.length, bookings_created: bookingsCreated, bookings_updated: bookingsUpdated };
}

// ── TOKEN REFRESH ─────────────────────────────────────────────────────────────

async function ensureFreshToken(sb, conn) {
  const now = new Date();
  const expiry = conn.token_expiry ? new Date(conn.token_expiry) : null;

  // If token is still valid (with 5 min buffer), return it
  if (expiry && expiry.getTime() - now.getTime() > 5 * 60 * 1000) {
    return conn.access_token;
  }

  // Refresh the token
  if (!conn.refresh_token) return null;

  try {
    let newTokens;
    if (conn.provider === 'google') {
      newTokens = await refreshGoogleToken(conn.refresh_token);
    } else {
      newTokens = await refreshMicrosoftToken(conn.refresh_token);
    }

    if (!newTokens?.access_token) return null;

    // Save new tokens to Supabase
    const newExpiry = newTokens.expires_in
      ? new Date(Date.now() + newTokens.expires_in * 1000).toISOString()
      : null;

    await sb.from('email_connections').update({
      access_token:  newTokens.access_token,
      refresh_token: newTokens.refresh_token || conn.refresh_token,
      token_expiry:  newExpiry,
      updated_at:    new Date().toISOString(),
    }).eq('user_id', conn.user_id);

    return newTokens.access_token;
  } catch (err) {
    console.error('[poll-emails] Token refresh failed:', err.message);
    return null;
  }
}

async function refreshGoogleToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  });
  return res.json();
}

async function refreshMicrosoftToken(refreshToken) {
  const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     MICROSOFT_CLIENT_ID,
      client_secret: MICROSOFT_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
      scope:         'https://graph.microsoft.com/Mail.Read offline_access',
    }),
  });
  return res.json();
}

// ── GMAIL API ─────────────────────────────────────────────────────────────────

async function fetchGmailBookings(accessToken) {
  // Build search query for booking emails from known senders
  const fromQuery = ALL_SENDERS.map(s => `from:${s}`).join(' OR ');
  const query = `(${fromQuery}) is:unread`;

  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=20`,
    { headers: { Authorization: 'Bearer ' + accessToken } }
  );

  const listData = await listRes.json();
  if (!listData.messages || listData.messages.length === 0) return [];

  const emails = [];
  for (const msg of listData.messages.slice(0, 10)) {
    try {
      const detail = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
        { headers: { Authorization: 'Bearer ' + accessToken } }
      );
      const data = await detail.json();

      const headers = data.payload?.headers || [];
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      const from    = headers.find(h => h.name === 'From')?.value || '';

      // Only process from known booking senders
      const isBookingSender = ALL_SENDERS.some(s => from.toLowerCase().includes(s));
      if (!isBookingSender) continue;

      const body = extractGmailBody(data.payload);
      emails.push({ id: msg.id, subject, body });
    } catch (err) {
      console.error('[poll-emails] Gmail fetch error:', err.message);
    }
  }

  return emails;
}

function extractGmailBody(payload) {
  if (!payload) return '';

  // Try plain text first
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return atob(payload.body.data.replace(/-/g, '+').replace(/_/g, '/'));
  }

  // Try parts
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return atob(part.body.data.replace(/-/g, '+').replace(/_/g, '/'));
      }
    }
    // Fall back to HTML
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        const html = atob(part.body.data.replace(/-/g, '+').replace(/_/g, '/'));
        return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
    }
  }

  return '';
}

async function markGmailRead(accessToken, messageId) {
  await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
    }
  );
}

// ── OUTLOOK / MICROSOFT GRAPH API ─────────────────────────────────────────────

async function fetchOutlookBookings(accessToken) {
  // Filter for unread emails from booking platforms
  const senderFilters = ALL_SENDERS
    .map(s => `from/emailAddress/address eq '${s}'`)
    .join(' or ');

  const filter = encodeURIComponent(`isRead eq false and (${senderFilters})`);
  const url = `https://graph.microsoft.com/v1.0/me/messages?$filter=${filter}&$top=20&$select=id,subject,from,body`;

  const res = await fetch(url, {
    headers: { Authorization: 'Bearer ' + accessToken },
  });

  const data = await res.json();
  if (!data.value || data.value.length === 0) return [];

  return data.value.slice(0, 10).map(msg => ({
    id:      msg.id,
    subject: msg.subject || '',
    body:    msg.body?.content
      ? msg.body.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      : '',
  }));
}

async function markOutlookRead(accessToken, messageId) {
  await fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${messageId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ isRead: true }),
    }
  );
}

// ── CLAUDE PARSING ────────────────────────────────────────────────────────────

async function parseEmailWithClaude(subject, body, propertyName) {
  const propertyContext = propertyName
    ? `The property being managed is called "${propertyName}".`
    : 'This is a short-term rental property.';

  const prompt = `You are a booking data extractor for a short-term rental property manager.
${propertyContext}

Analyse this email and extract booking information. Return ONLY a valid JSON object, no markdown, no explanation.

The JSON must have this exact structure:
{
  "action": "new" | "cancel" | "modify" | "ignore",
  "platform": "Airbnb" | "VRBO" | "Direct" | "Unknown",
  "guestName": "Full name of guest",
  "checkin": "YYYY-MM-DD",
  "checkout": "YYYY-MM-DD",
  "nights": number,
  "guests": number,
  "hostPayout": number,
  "cleaningFee": number,
  "confirmationCode": "code or null",
  "notes": "any useful info"
}

Rules:
- If NOT a booking email set action to "ignore"
- For hostPayout look for "You will receive", "You earn", "Host payout" — NOT the guest charge
- All dates must be YYYY-MM-DD format
- For year inference: if month/day is today or in the future use current year, if already passed use next year
- Never assume a past year

EMAIL SUBJECT: ${subject}

EMAIL BODY:
${body.substring(0, 8000)}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages:   [{ role: 'user', content: prompt }],
    }),
  });

  const data = await res.json();
  if (!data.content?.[0]?.text) throw new Error('Claude returned no content');

  const text = data.content[0].text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  const parsed = JSON.parse(text);

  // Normalise dates — never allow past dates
  parsed.checkin  = normaliseFutureDate(parsed.checkin);
  parsed.checkout = normaliseFutureDate(parsed.checkout);

  // Validate checkout is after checkin
  if (parsed.checkin && parsed.checkout) {
    const ci = new Date(parsed.checkin + 'T00:00:00');
    const co = new Date(parsed.checkout + 'T00:00:00');
    if (!isNaN(ci) && !isNaN(co) && co <= ci) {
      co.setFullYear(co.getFullYear() + 1);
      parsed.checkout = co.toISOString().split('T')[0];
    }
    if (!isNaN(ci) && !isNaN(co)) {
      parsed.nights = Math.ceil((new Date(parsed.checkout) - new Date(parsed.checkin)) / 86400000);
    }
  }

  return parsed;
}

function normaliseFutureDate(dateStr) {
  if (!dateStr) return dateStr;
  const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return dateStr;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(d.getTime())) return dateStr;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (d < today) d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().split('T')[0];
}

// ── SUPABASE BOOKING UPSERT ───────────────────────────────────────────────────

async function upsertBooking(sb, userId, propertyId, parsed, emailId) {
  const confirmCode = String(parsed.confirmationCode || '').trim().toUpperCase();

  // Try to find existing booking by confirmation code or guest+checkin
  let existing = null;

  if (confirmCode) {
    const { data } = await sb
      .from('bookings')
      .select('id, status')
      .eq('user_id', userId)
      .eq('confirmation_code', confirmCode)
      .single();
    existing = data;
  }

  if (!existing && parsed.guestName && parsed.checkin) {
    const { data } = await sb
      .from('bookings')
      .select('id, status')
      .eq('user_id', userId)
      .eq('guest_name', parsed.guestName)
      .eq('checkin', parsed.checkin)
      .single();
    existing = data;
  }

  const payload = {
    user_id:           userId,
    property_id:       propertyId,
    checkin:           parsed.checkin,
    checkout:          parsed.checkout,
    nights:            parsed.nights || null,
    guest_name:        parsed.guestName || '',
    guests:            parsed.guests || 1,
    host_payout:       parsed.hostPayout || 0,
    cleaning_fee:      parsed.cleaningFee || 0,
    net_payout:        parsed.hostPayout ? (parsed.hostPayout - (parsed.cleaningFee || 0)) : 0,
    platform:          parsed.platform || 'Unknown',
    confirmation_code: confirmCode || null,
    status:            parsed.action === 'cancel' ? 'cancelled' : 'confirmed',
    source:            'email',
    raw_email_id:      emailId,
    updated_at:        new Date().toISOString(),
  };

  if (parsed.action === 'cancel' && existing) {
    await sb.from('bookings').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', existing.id);
    return 'cancelled';
  }

  if (existing) {
    await sb.from('bookings').update(payload).eq('id', existing.id);
    return 'updated';
  }

  await sb.from('bookings').insert(payload);
  return 'created';
}
