/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Smart Pricing v2: Generate Suggestions
   Server-side replacement for the in-browser AI call. Pulls rules/bookings
   from Supabase, computes per-night features, optionally fetches Open-Meteo
   weather, calls Anthropic, validates, and writes pricing_runs +
   pricing_suggestions.

   Modes:
     • User-initiated   — Authorization: Bearer <supabase access token>
         POST { property_id, trigger?, forecast_days? }
     • Scheduled/server — no bearer, X-Internal-Secret header or service
         POST { user_id, property_id, trigger, forecast_days? }

   Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY
   Optional env: INTERNAL_FN_SECRET (required for scheduled mode callers)
   ═══════════════════════════════════════════════════════════════════════════ */

const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Internal-Secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_FORECAST_DAYS = 60;
const MAX_FORECAST_DAYS = 365;
// Response sizing: base overhead + ~55 tokens per night (date + rate + rateType + short reason).
const TOKENS_PER_NIGHT = 55;
const TOKENS_OVERHEAD = 400;

// ── Holidays (NSW). Keep in sync with assets/js/smart-pricing.js ──────────
const NSW_SCHOOL_HOLIDAY_RANGES = [
  { start: '2026-04-11', end: '2026-04-26', label: 'NSW Autumn break 2026' },
  { start: '2026-07-04', end: '2026-07-19', label: 'NSW Winter break 2026' },
  { start: '2026-09-19', end: '2026-10-05', label: 'NSW Spring break 2026' },
  { start: '2026-12-21', end: '2027-01-27', label: 'NSW Summer break 2026-27' },
  { start: '2027-04-10', end: '2027-04-25', label: 'NSW Autumn break 2027' },
  { start: '2027-07-03', end: '2027-07-18', label: 'NSW Winter break 2027' },
];

const AU_PUBLIC_HOLIDAYS = [
  { date: '2026-01-01', name: "New Year's Day" },
  { date: '2026-01-26', name: 'Australia Day' },
  { date: '2026-04-03', name: 'Good Friday' },
  { date: '2026-04-04', name: 'Easter Saturday' },
  { date: '2026-04-05', name: 'Easter Sunday' },
  { date: '2026-04-06', name: 'Easter Monday' },
  { date: '2026-04-25', name: 'Anzac Day' },
  { date: '2026-06-08', name: "King's Birthday (NSW)" },
  { date: '2026-10-05', name: 'Labour Day (NSW)' },
  { date: '2026-12-25', name: 'Christmas Day' },
  { date: '2026-12-26', name: 'Boxing Day' },
  { date: '2026-12-28', name: 'Boxing Day (substitute)' },
  { date: '2027-01-01', name: "New Year's Day" },
  { date: '2027-01-26', name: 'Australia Day' },
  { date: '2027-03-26', name: 'Good Friday' },
  { date: '2027-03-29', name: 'Easter Monday' },
  { date: '2027-04-25', name: 'Anzac Day' },
  { date: '2027-06-14', name: "King's Birthday (NSW)" },
  { date: '2027-10-04', name: 'Labour Day (NSW)' },
  { date: '2027-12-25', name: 'Christmas Day' },
  { date: '2027-12-27', name: 'Christmas (substitute)' },
  { date: '2027-12-28', name: 'Boxing Day (substitute)' },
];

// ── helpers ──────────────────────────────────────────────────────────────

function json(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function pad2(n) { return String(n).padStart(2, '0'); }

function ymd(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseYmd(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function sydneyToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const y = Number(parts.find(p => p.type === 'year').value);
  const m = Number(parts.find(p => p.type === 'month').value);
  const d = Number(parts.find(p => p.type === 'day').value);
  return new Date(y, m - 1, d);
}

function isHolidayDate(ds) {
  return AU_PUBLIC_HOLIDAYS.find(h => h.date === ds) || null;
}

function schoolHolidayFor(ds) {
  return NSW_SCHOOL_HOLIDAY_RANGES.find(r => ds >= r.start && ds <= r.end) || null;
}

function eachNightYmd(checkin, checkout) {
  const out = [];
  const s = parseYmd(String(checkin).slice(0, 10));
  const e = parseYmd(String(checkout).slice(0, 10));
  for (let t = s.getTime(); t < e.getTime(); t += 86400000) {
    out.push(ymd(new Date(t)));
  }
  return out;
}

function isoWeekKey(d) {
  // ISO week of year, e.g. "2025-W14"
  const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${pad2(weekNum)}`;
}

// ── Open-Meteo ───────────────────────────────────────────────────────────

async function fetchWeatherForecast(lat, lon) {
  if (lat == null || lon == null) return null;
  const url = `https://api.open-meteo.com/v1/forecast`
    + `?latitude=${encodeURIComponent(lat)}`
    + `&longitude=${encodeURIComponent(lon)}`
    + `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum`
    + `&timezone=Australia%2FSydney`
    + `&forecast_days=16`;
  try {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) {
      console.warn('[StayOps] open-meteo non-ok', res.status);
      return null;
    }
    const data = await res.json();
    const daily = data && data.daily;
    if (!daily || !Array.isArray(daily.time)) return null;
    const byDate = Object.create(null);
    daily.time.forEach((ds, i) => {
      byDate[ds] = {
        tmax: Number(daily.temperature_2m_max?.[i] ?? null),
        tmin: Number(daily.temperature_2m_min?.[i] ?? null),
        precip_mm: Number(daily.precipitation_sum?.[i] ?? null),
      };
    });
    return byDate;
  } catch (e) {
    console.warn('[StayOps] open-meteo fetch failed', e.message || e);
    return null;
  }
}

// ── Feature engineering ──────────────────────────────────────────────────

function buildBookedNightMap(bookings) {
  const booked = new Map(); // date -> booking ref
  for (const b of bookings) {
    if (!b.checkin || !b.checkout) continue;
    if (b.status === 'cancelled') continue;
    for (const n of eachNightYmd(b.checkin, b.checkout)) {
      booked.set(n, b);
    }
  }
  return booked;
}

function computeGapLengths(bookedMap, startDate, endDate) {
  // For every night in [startDate, endDate], compute gap_before (nights since
  // previous booking end) and gap_after (nights until next booking start).
  const dates = [];
  for (let d = new Date(startDate); d <= endDate; d = addDays(d, 1)) {
    dates.push(ymd(d));
  }
  const out = Object.create(null);
  for (const ds of dates) {
    if (bookedMap.has(ds)) {
      out[ds] = { gap_before: 0, gap_after: 0, in_gap: false };
      continue;
    }
    // walk backward
    let gb = 0;
    let cursor = parseYmd(ds);
    while (true) {
      cursor = addDays(cursor, -1);
      if (bookedMap.has(ymd(cursor))) break;
      gb += 1;
      if (gb > 60) break;
    }
    // walk forward
    let ga = 0;
    cursor = parseYmd(ds);
    while (true) {
      cursor = addDays(cursor, 1);
      if (bookedMap.has(ymd(cursor))) break;
      ga += 1;
      if (ga > 60) break;
    }
    out[ds] = {
      gap_before: gb,
      gap_after: ga,
      in_gap: gb > 0 && ga > 0,
    };
  }
  return out;
}

function sameDateLastYear(ds) {
  const d = parseYmd(ds);
  return ymd(new Date(d.getFullYear() - 1, d.getMonth(), d.getDate()));
}

function buildHistoricalSignals(bookings, forecastDates) {
  const bookedByDate = buildBookedNightMap(bookings);
  // per-ISO-week occupancy last year
  const weekOcc = new Map(); // isoWeekKey -> { booked, total }
  for (const [ds] of bookedByDate) {
    const key = isoWeekKey(parseYmd(ds));
    const rec = weekOcc.get(key) || { booked: 0, total: 0 };
    rec.booked += 1;
    weekOcc.set(key, rec);
  }
  // We fill "total" by counting how many of each ISO-week's 7 nights exist in
  // the data span — for the purpose of a hint we just return booked count.

  // per-month avg nightly rate for prior 2 years
  const monthStats = new Map(); // "YYYY-MM" -> { revenue, nights, count }
  for (const b of bookings) {
    if (!b.checkin || b.status === 'cancelled') continue;
    const d = parseYmd(String(b.checkin).slice(0, 10));
    const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
    const rec = monthStats.get(key) || { revenue: 0, nights: 0, count: 0 };
    rec.revenue += Number(b.host_payout) || 0;
    rec.nights += Number(b.nights) || 0;
    rec.count += 1;
    monthStats.set(key, rec);
  }
  const monthAvg = Object.create(null);
  for (const [k, v] of monthStats) {
    monthAvg[k] = v.nights ? Math.round(v.revenue / v.nights) : 0;
  }

  // per-night: same date last year booked?
  const perNight = Object.create(null);
  for (const ds of forecastDates) {
    const ly = sameDateLastYear(ds);
    const d = parseYmd(ds);
    const iso = isoWeekKey(new Date(d.getFullYear() - 1, d.getMonth(), d.getDate()));
    const occ = weekOcc.get(iso);
    perNight[ds] = {
      same_date_last_year_booked: bookedByDate.has(ly),
      same_week_last_year_booked_nights: occ ? occ.booked : 0,
    };
  }

  // per-month lookup keys for the forecast window
  return { perNight, monthAvg };
}

function avgLeadTimeDays(bookings) {
  const leads = [];
  for (const b of bookings) {
    if (!b.checkin || b.status === 'cancelled') continue;
    const ts = b.booked_at || b.created_at;
    if (!ts) continue;
    const booked = new Date(ts);
    const ci = parseYmd(String(b.checkin).slice(0, 10));
    const days = Math.round((ci - booked) / 86400000);
    if (Number.isFinite(days) && days >= 0 && days <= 365) leads.push(days);
  }
  if (!leads.length) return null;
  const sum = leads.reduce((s, x) => s + x, 0);
  return Math.round(sum / leads.length);
}

function buildPerNightFeatures({ forecastDates, bookings, weather }) {
  const bookedMap = buildBookedNightMap(bookings);
  const firstD = parseYmd(forecastDates[0]);
  const lastD = parseYmd(forecastDates[forecastDates.length - 1]);
  const gaps = computeGapLengths(bookedMap, firstD, lastD);
  const today = sydneyToday();
  const hist = buildHistoricalSignals(bookings, forecastDates);

  return forecastDates.map(ds => {
    const d = parseYmd(ds);
    const dow = d.getDay(); // 0=Sun..6=Sat
    const isWeekend = dow === 5 || dow === 6; // Fri-Sat (NSW convention)
    const ph = isHolidayDate(ds);
    const sh = schoolHolidayFor(ds);
    const lead = Math.round((d - today) / 86400000);
    const g = gaps[ds] || { gap_before: 0, gap_after: 0, in_gap: false };
    const monthKey = `${d.getFullYear() - 1}-${pad2(d.getMonth() + 1)}`;
    const w = weather && weather[ds] ? weather[ds] : null;
    const hist_n = hist.perNight[ds] || {};
    return {
      date: ds,
      dow,
      is_weekend: isWeekend,
      is_public_holiday: !!ph,
      public_holiday_name: ph ? ph.name : null,
      is_school_holiday: !!sh,
      school_holiday_name: sh ? sh.label : null,
      lead_time_days: lead,
      is_booked: bookedMap.has(ds),
      gap_before_nights: g.gap_before,
      gap_after_nights: g.gap_after,
      in_gap: g.in_gap,
      avg_rate_same_month_last_year: hist.monthAvg[monthKey] || null,
      same_date_last_year_booked: hist_n.same_date_last_year_booked || false,
      same_week_last_year_booked_nights: hist_n.same_week_last_year_booked_nights || 0,
      weather: w,
    };
  });
}

// ── Prompt ───────────────────────────────────────────────────────────────

function buildPrompt({ propertyName, features, rules, today, avgLead }) {
  const rulesJson = JSON.stringify(rules.map(r => ({
    rule_type: r.rule_type,
    name: r.name,
    value: Number(r.value),
    condition_type: r.condition_type,
    condition_value: r.condition_value,
    is_default: r.is_default,
    meta: r.meta,
  })));

  // Strip booked nights from what the AI sees — server overlays them.
  const openNights = features.filter(f => !f.is_booked);

  return `You are a revenue manager for an Australian short-term rental in NSW.

Today is ${today}.
Property: ${propertyName}.
Average historical lead time (days): ${avgLead == null ? 'unknown' : avgLead}.

PRICING RULES (JSON):
${rulesJson}

PER-NIGHT FEATURES (only unbooked nights are listed; each row is one night you must price):
${JSON.stringify(openNights)}

TASK: Produce a suggested AUD nightly rate for every night listed above.
Apply the pricing rules. Use the features to reason about:
- Weekday base vs Fri-Sat weekend base.
- Discount rules when condition_type matches (stay_length, lead_time, last_minute, gap, day_of_week, date_range).
- Premium on public and school holiday nights.
- Gap-filler discount for short gaps (in_gap with small gap_before/after).
- Last-minute discount when lead_time_days is small.
- Historical signal from avg_rate_same_month_last_year / same_date_last_year_booked.
- Weather when present: cool/rainy may warrant small softening, warm clear weekend may warrant uplift.

Respond with ONLY valid JSON (no markdown fences, no preamble):
{
  "days": [
    { "date": "YYYY-MM-DD", "suggestedRate": 320, "reason": "Weekend base + school holiday uplift", "rateType": "peak" }
  ],
  "insight": "Two or three sentences summarising the main pricing moves."
}

rateType must be one of: "base", "weekend", "peak", "discounted".
Do NOT include booked nights in days[] (server overlays them).
Keep reason under 80 characters.`;
}

function parseAiJson(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

// ── Anthropic ────────────────────────────────────────────────────────────

async function callAnthropic({ model, prompt, nights }) {
  const maxTokens = Math.min(16000, TOKENS_OVERHEAD + (Math.max(1, Number(nights) || 60) * TOKENS_PER_NIGHT));
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ── Core worker ──────────────────────────────────────────────────────────

function resolveWindow({ forecast_start, forecast_end, forecast_days }) {
  const today = sydneyToday();
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  let startD;
  let endD;

  if (forecast_start && dateRe.test(forecast_start)) {
    const sd = parseYmd(forecast_start);
    startD = sd < today ? ymd(today) : forecast_start; // never start in the past
  } else {
    startD = ymd(today);
  }

  if (forecast_end && dateRe.test(forecast_end)) {
    endD = forecast_end;
  } else {
    const days = Math.max(1, Math.min(Number(forecast_days) || DEFAULT_FORECAST_DAYS, MAX_FORECAST_DAYS));
    endD = ymd(addDays(parseYmd(startD), days - 1));
  }

  // Validate + clamp to MAX_FORECAST_DAYS.
  const s = parseYmd(startD);
  let e = parseYmd(endD);
  if (e < s) throw new Error('forecast_end before forecast_start');
  const span = Math.round((e - s) / 86400000) + 1;
  if (span > MAX_FORECAST_DAYS) {
    e = addDays(s, MAX_FORECAST_DAYS - 1);
    endD = ymd(e);
  }
  return { startD, endD, nights: Math.round((e - s) / 86400000) + 1 };
}

async function generateForProperty(sb, { user_id, property_id, trigger, forecast_days, forecast_start, forecast_end }) {
  const { startD, endD, nights } = resolveWindow({ forecast_start, forecast_end, forecast_days });
  const today = sydneyToday();

  // rules
  const { data: rules, error: rulesErr } = await sb
    .from('pricing_rules')
    .select('*')
    .eq('user_id', user_id)
    .eq('property_id', property_id);
  if (rulesErr) throw new Error(`rules: ${rulesErr.message}`);
  if (!rules || !rules.length) throw new Error('no_pricing_rules');

  // bookings for THIS property — pull last 2 years for historical plus the
  // full forecast window for gap/overlap calculations.
  const historicalStart = ymd(addDays(today, -730));
  const { data: bookings, error: bkErr } = await sb
    .from('bookings')
    .select('id, checkin, checkout, nights, host_payout, status, booked_at, created_at')
    .eq('user_id', user_id)
    .eq('property_id', property_id)
    .neq('status', 'cancelled')
    .gte('checkin', historicalStart);
  if (bkErr) throw new Error(`bookings: ${bkErr.message}`);

  // property — for lat/lon + name
  let propertyName = 'Property';
  let lat = null;
  let lon = null;
  try {
    const { data: prop } = await sb
      .from('properties')
      .select('name, latitude, longitude')
      .eq('id', property_id)
      .single();
    if (prop) {
      propertyName = prop.name || propertyName;
      lat = prop.latitude ?? null;
      lon = prop.longitude ?? null;
    }
  } catch (_e) { /* table/column may not exist */ }

  // weather (optional)
  const weather = (lat != null && lon != null) ? await fetchWeatherForecast(lat, lon) : null;

  // features
  const forecastDates = [];
  const startDate = parseYmd(startD);
  const endDate = parseYmd(endD);
  for (let d = new Date(startDate); d <= endDate; d = addDays(d, 1)) {
    forecastDates.push(ymd(d));
  }
  const features = buildPerNightFeatures({ forecastDates, bookings: bookings || [], weather });
  const avgLead = avgLeadTimeDays(bookings || []);

  // prompt + call — max_tokens scales with nights so long windows don't truncate.
  const prompt = buildPrompt({ propertyName, features, rules, today: ymd(today), avgLead });
  const { ok, status, data } = await callAnthropic({ model: DEFAULT_MODEL, prompt, nights });
  if (!ok) {
    const msg = data && data.error && data.error.message ? data.error.message : `HTTP ${status}`;
    throw new Error(`anthropic: ${msg}`);
  }
  const text = data.content?.[0]?.text || '';
  let parsed;
  try {
    parsed = parseAiJson(text);
  } catch (_e) {
    throw new Error('parse_failed');
  }
  const aiDays = Array.isArray(parsed.days) ? parsed.days : [];
  const insight = String(parsed.insight || '');

  // validate + overlay booked nights
  const bookedMap = buildBookedNightMap(bookings || []);
  const featureByDate = Object.create(null);
  for (const f of features) featureByDate[f.date] = f;

  const byDate = Object.create(null);
  for (const row of aiDays) {
    if (!row || typeof row.date !== 'string') continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) continue;
    if (row.date < startD || row.date > endD) continue;
    const rate = Number(row.suggestedRate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100000) continue;
    const rt = ['base', 'weekend', 'peak', 'discounted'].includes(row.rateType) ? row.rateType : 'base';
    byDate[row.date] = {
      date: row.date,
      suggestedRate: Math.round(rate),
      rateType: rt,
      reason: String(row.reason || '').slice(0, 120),
    };
  }
  // overlay booked
  for (const ds of forecastDates) {
    if (bookedMap.has(ds)) {
      byDate[ds] = { date: ds, suggestedRate: 0, rateType: 'booked', reason: 'Booked' };
    }
  }

  const finalDays = forecastDates.map(ds => byDate[ds]).filter(Boolean);

  // persist run + suggestions
  const usage = data.usage || {};
  const { data: runRow, error: runErr } = await sb
    .from('pricing_runs')
    .insert({
      user_id,
      property_id,
      forecast_start: startD,
      forecast_end: endD,
      trigger: trigger || 'manual',
      model: DEFAULT_MODEL,
      prompt_tokens: usage.input_tokens || null,
      completion_tokens: usage.output_tokens || null,
      insight,
    })
    .select()
    .single();
  if (runErr) throw new Error(`run insert: ${runErr.message}`);

  const suggestionRows = finalDays.map(d => ({
    user_id,
    property_id,
    run_id: runRow.id,
    date: d.date,
    suggested_rate: d.suggestedRate,
    rate_type: d.rateType,
    reason: d.reason,
    signals: featureByDate[d.date] || null,
  }));
  if (suggestionRows.length) {
    const { error: sugErr } = await sb.from('pricing_suggestions').insert(suggestionRows);
    if (sugErr) throw new Error(`sugg insert: ${sugErr.message}`);
  }

  return {
    run_id: runRow.id,
    forecast_start: startD,
    forecast_end: endD,
    insight,
    days: finalDays,
    weather_used: !!weather,
  };
}

// ── Handler ──────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY || !ANTHROPIC_KEY) {
    return json(500, { error: 'Server misconfigured' });
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_e) { /* tolerate missing body */ }
  const property_id = body.property_id;
  const trigger = String(body.trigger || 'manual');
  const forecast_days = body.forecast_days;
  const forecast_start = body.forecast_start;
  const forecast_end = body.forecast_end;

  // Auth resolution: prefer bearer token; fall back to internal secret.
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const internalSecret = event.headers?.['x-internal-secret'] || event.headers?.['X-Internal-Secret'] || '';

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

  let user_id;
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    const { data: userData, error } = await sb.auth.getUser(token);
    if (error || !userData?.user?.id) return json(401, { error: 'Invalid token' });
    user_id = userData.user.id;
  } else {
    // Scheduled / internal caller
    const expected = process.env.INTERNAL_FN_SECRET || '';
    const ok = expected && internalSecret && internalSecret === expected;
    if (!ok) return json(401, { error: 'Unauthorized' });
    if (!body.user_id) return json(400, { error: 'user_id required for internal mode' });
    user_id = body.user_id;
  }

  if (!property_id) return json(400, { error: 'property_id required' });

  try {
    const result = await generateForProperty(sb, {
      user_id, property_id, trigger, forecast_days, forecast_start, forecast_end,
    });
    return json(200, { ok: true, ...result });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    console.warn('[StayOps] generate-pricing-suggestions failed', msg);
    // Log error row for diagnostics — best-effort window for the error row.
    let errStart = ymd(sydneyToday());
    let errEnd = ymd(addDays(sydneyToday(), DEFAULT_FORECAST_DAYS - 1));
    try {
      const w = resolveWindow({ forecast_start, forecast_end, forecast_days });
      errStart = w.startD;
      errEnd = w.endD;
    } catch (_e) { /* keep defaults */ }
    try {
      await sb.from('pricing_runs').insert({
        user_id,
        property_id,
        forecast_start: errStart,
        forecast_end: errEnd,
        trigger,
        model: DEFAULT_MODEL,
        error: msg,
      });
    } catch (_e) { /* ignore */ }
    return json(500, { error: msg });
  }
};
