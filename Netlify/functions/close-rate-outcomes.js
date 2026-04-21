/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Smart Pricing v2: Close rate outcomes (daily)
   For every night that ended yesterday (Australia/Sydney), match the most
   recent pricing_suggestion for that (user, property, date) with whether a
   booking actually covered the night, and write rate_outcomes for the
   feedback loop.

   Env: SUPABASE_URL, SUPABASE_SERVICE_KEY
   ═══════════════════════════════════════════════════════════════════════════ */

const { createClient } = require('@supabase/supabase-js');
const { schedule } = require('@netlify/functions');

function pad2(n) { return String(n).padStart(2, '0'); }

function sydneyDateParts(offsetDays = 0) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const y = Number(parts.find(p => p.type === 'year').value);
  const m = Number(parts.find(p => p.type === 'month').value);
  const d = Number(parts.find(p => p.type === 'day').value);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + offsetDays);
  return base.toISOString().slice(0, 10);
}

function parseYmd(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function ymdLocal(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function eachNight(checkin, checkout) {
  // Iterate in local calendar space to match generate-pricing-suggestions.js
  // (which uses parseYmd / local-date arithmetic). Date-only inputs like
  // "YYYY-MM-DD" are treated as the start of local day — same domain as the
  // target date produced by sydneyDateParts().
  const out = [];
  const s = parseYmd(String(checkin).slice(0, 10));
  const e = parseYmd(String(checkout).slice(0, 10));
  for (let t = s.getTime(); t < e.getTime(); t += 86400000) {
    out.push(ymdLocal(new Date(t)));
  }
  return out;
}

// Cron source of truth lives here (removed from netlify.toml). schedule() is
// a no-op wrapper at runtime — its purpose is to mark the function as
// scheduled-only during deploy so Netlify's edge router rejects external
// HTTP. The real security boundary is platform-side, not in this file.
// 30 14 * * * = 14:30 UTC = 00:30 AEDT / 01:30 AEST; target is yesterday (Sydney).
exports.handler = schedule('30 14 * * *', async () => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[StayOps] close-rate-outcomes: misconfigured');
    return { statusCode: 500, body: 'misconfigured' };
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Close everything up to yesterday. On first run we only process yesterday
  // to avoid blowing up; subsequent runs likewise.
  const targetDate = sydneyDateParts(-1);
  console.log(`[StayOps] close-rate-outcomes: target date ${targetDate}`);

  // Explicit upper bound. At one suggestion per (user, property, date) plus
  // history from older runs that targeted the same date, we expect well under
  // 1k rows — but set a hard cap and warn if we ever hit it so silent
  // truncation never masks a scaling problem. We fetch LIMIT+1 and trim to
  // LIMIT so we can tell "exactly LIMIT rows" apart from "actually truncated".
  const QUERY_LIMIT = 5000;

  // Pull every suggestion for that date that has no outcome yet.
  let { data: suggestions, error: sugErr } = await sb
    .from('pricing_suggestions')
    .select('user_id, property_id, date, suggested_rate, rate_type, generated_at')
    .eq('date', targetDate)
    .order('generated_at', { ascending: false })
    .limit(QUERY_LIMIT + 1);
  if (sugErr) {
    console.error('[StayOps] close-rate-outcomes: suggestions query failed', sugErr);
    return { statusCode: 500, body: 'query failed' };
  }
  if (suggestions && suggestions.length > QUERY_LIMIT) {
    console.warn(`[StayOps] close-rate-outcomes: suggestions query exceeded cap of ${QUERY_LIMIT} — trimming and continuing`);
    suggestions = suggestions.slice(0, QUERY_LIMIT);
  }

  // Collapse to the latest suggestion per (user, property, date).
  const latest = new Map();
  for (const s of suggestions || []) {
    const key = `${s.user_id}::${s.property_id}::${s.date}`;
    if (!latest.has(key)) latest.set(key, s);
  }

  // Also capture (user, property, date) tuples with bookings but no
  // suggestions, so we still record actual_rate history.
  const byKey = new Map(latest);

  // Find bookings covering this date for all users. LIMIT+1/trim pattern
  // mirrors the suggestions query above.
  let { data: bookings, error: bkErr } = await sb
    .from('bookings')
    .select('id, user_id, property_id, checkin, checkout, host_payout, nights, status')
    .neq('status', 'cancelled')
    .lte('checkin', targetDate)
    .gt('checkout', targetDate)
    .limit(QUERY_LIMIT + 1);
  if (bkErr) {
    console.error('[StayOps] close-rate-outcomes: bookings query failed', bkErr);
    return { statusCode: 500, body: 'query failed' };
  }
  if (bookings && bookings.length > QUERY_LIMIT) {
    console.warn(`[StayOps] close-rate-outcomes: bookings query exceeded cap of ${QUERY_LIMIT} — trimming and continuing`);
    bookings = bookings.slice(0, QUERY_LIMIT);
  }

  const bookingByKey = new Map();
  for (const b of bookings || []) {
    if (!b.checkin || !b.checkout) continue;
    const nights = eachNight(String(b.checkin).slice(0, 10), String(b.checkout).slice(0, 10));
    if (!nights.includes(targetDate)) continue;
    const key = `${b.user_id}::${b.property_id}::${targetDate}`;
    bookingByKey.set(key, b);
    if (!byKey.has(key)) {
      // Booking exists but no suggestion — still record actual outcome.
      byKey.set(key, {
        user_id: b.user_id,
        property_id: b.property_id,
        date: targetDate,
        suggested_rate: null,
        rate_type: null,
      });
    }
  }

  // Build outcome rows.
  const rows = [];
  for (const [key, s] of byKey) {
    const bk = bookingByKey.get(key) || null;
    const actual_rate = bk && bk.nights ? Math.round(Number(bk.host_payout || 0) / Number(bk.nights)) : null;
    rows.push({
      user_id: s.user_id,
      property_id: s.property_id,
      date: s.date,
      suggested_rate: s.suggested_rate ?? null,
      rate_type: s.rate_type ?? null,
      actual_rate,
      booked: !!bk,
      booking_cloud_id: bk ? bk.id : null,
    });
  }

  if (!rows.length) {
    console.log('[StayOps] close-rate-outcomes: nothing to record');
    return { statusCode: 200, body: JSON.stringify({ ok: true, recorded: 0 }) };
  }

  const { error: upErr } = await sb
    .from('rate_outcomes')
    .upsert(rows, { onConflict: 'user_id,property_id,date' });
  if (upErr) {
    console.error('[StayOps] close-rate-outcomes: upsert failed', upErr);
    return { statusCode: 500, body: 'upsert failed' };
  }

  console.log(`[StayOps] close-rate-outcomes: recorded ${rows.length} outcome(s) for ${targetDate}`);
  return { statusCode: 200, body: JSON.stringify({ ok: true, recorded: rows.length, date: targetDate }) };
});
