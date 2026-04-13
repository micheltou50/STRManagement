// Netlify/functions/daily-notifications.js
//
// StayOps — daily digest for hosts (pg_cron → x-cron-secret).
//
// CRON / DST (Sydney):
//   21:00 UTC = 08:00 in Sydney during AEDT (UTC+11, roughly Oct–early Apr)
//              and 07:00 during AEST (UTC+10, roughly Apr–Oct).
//   If you need ~07:00 during AEDT, use 20:00 UTC instead (then ~06:00 in winter).
//   Adjust the pg_cron expression in Supabase manually — no automatic DST logic here.
//
// SCHEMA (existing): bookings (checkin, checkout, guest_name, guests, status, property_id, user_id),
//   cleans (clean_date, cleaner, cleaner_id, booking_id, property_id, done, cleaner_confirmed,
//   cleaner_declined, assigned_at, user_id), properties (id, name, user_id),
//   app_config (user_id, push_subscriptions jsonb[]),
//   notification_log (property_id, type, reference_id, title, body, sent_at).
//
// Push: ./utils/push-helper.js (sendPushToHost, hasRecentNotification).

const { createClient } = require('@supabase/supabase-js');
const { sendPushToHost, hasRecentNotification } = require('./utils/push-helper');
const { captureError, flush } = require('./utils/sentry');

const SYDNEY_TZ = 'Australia/Sydney';
const UNASSIGNED_WINDOW_HRS = 48;
const NO_RESPONSE_MIN_HRS = 12;
const DEDUP_MINUTES = 1380;

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}

function getHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const want = String(name).toLowerCase();
  for (const k of Object.keys(headers)) {
    if (String(k).toLowerCase() === want) return String(headers[k] || '');
  }
  return '';
}

function sydneyYmd(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SYDNEY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find(p => p.type === 'year')?.value;
  const m = parts.find(p => p.type === 'month')?.value;
  const day = parts.find(p => p.type === 'day')?.value;
  return `${y}-${m}-${day}`;
}

function addDaysYmd(ymd, n) {
  const [y, mo, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

function hoursUntilCleanDate(cleanDateYmd, now) {
  if (!cleanDateYmd || !/^\d{4}-\d{2}-\d{2}$/.test(cleanDateYmd)) return Infinity;
  const candidates = [
    Date.parse(`${cleanDateYmd}T10:00:00+10:00`),
    Date.parse(`${cleanDateYmd}T10:00:00+11:00`),
  ];
  for (const t of candidates) {
    if (Number.isNaN(t)) continue;
    if (sydneyYmd(new Date(t)) === cleanDateYmd) return (t - now.getTime()) / 3600000;
  }
  const fallback = candidates.find(t => !Number.isNaN(t));
  return fallback != null ? (fallback - now.getTime()) / 3600000 : Infinity;
}

function isCleanUnassigned(c) {
  const id = String(c.cleaner_id || '').trim();
  const name = String(c.cleaner || '').trim();
  return !id && !name;
}

exports.handler = async (event) => {
  const method = event.httpMethod || 'GET';
  if (method === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' };
  }
  if (method !== 'GET' && method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const hdr = getHeader(event.headers, 'x-cron-secret');
    if (hdr !== cronSecret) {
      console.log('[StayOps] daily-notifications: unauthorized cron request');
      return json(401, { error: 'Unauthorized' });
    }
  } else {
    console.warn(
      '[StayOps] daily-notifications: CRON_SECRET is not set — accepting request (configure CRON_SECRET + header in production)'
    );
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error('[StayOps] daily-notifications: missing Supabase URL or service key');
    return json(500, { error: 'Server misconfigured' });
  }

  const sb = createClient(supabaseUrl, supabaseKey);
  const now = new Date();
  const today = sydneyYmd(now);
  const twoDaysAhead = addDaysYmd(today, 2);

  const results = {
    checkins: 0,
    checkouts: 0,
    unassigned: 0,
    no_response: 0,
    errors: [],
  };

  console.log('[StayOps] daily-notifications: start, Sydney date =', today);

  try {
    try {
      const { data: checkins, error: err } = await sb
        .from('bookings')
        .select('id, property_id, guest_name, guests, status')
        .eq('checkin', today);

      if (err) throw err;

      const { data: props } = await sb.from('properties').select('id, name');
      const propNames = Object.fromEntries((props || []).map(p => [p.id, p.name || 'Property']));

      for (const b of checkins || []) {
        if ((b.status || '').toLowerCase() === 'cancelled') continue;
        const recent = await hasRecentNotification({
          supabaseAdmin: sb,
          type: 'checkin_today',
          referenceId: b.id,
          withinMinutes: DEDUP_MINUTES,
        });
        if (recent) continue;
        const propertyName = propNames[b.property_id] || 'Property';
        const n = Number(b.guests) || 1;
        const guest = (b.guest_name || 'Guest').trim();
        const pushRes = await sendPushToHost({
          supabaseAdmin: sb,
          propertyId: b.property_id,
          title: '🔑 Check-in Today — ' + propertyName,
          body: guest + ' · ' + n + ' guests',
          url: '/bookings',
          type: 'checkin_today',
          referenceId: b.id,
        });
        if (pushRes && pushRes.sent > 0) results.checkins++;
      }
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      console.error('[StayOps] daily-notifications: checkins section', message);
      results.errors.push({ section: 'checkins', message });
    }

    try {
      const { data: checkouts, error: err } = await sb
        .from('bookings')
        .select('id, property_id, guest_name, guests, status')
        .eq('checkout', today);

      if (err) throw err;

      const { data: props } = await sb.from('properties').select('id, name');
      const propNames = Object.fromEntries((props || []).map(p => [p.id, p.name || 'Property']));

      for (const b of checkouts || []) {
        if ((b.status || '').toLowerCase() === 'cancelled') continue;
        const recent = await hasRecentNotification({
          supabaseAdmin: sb,
          type: 'checkout_today',
          referenceId: b.id,
          withinMinutes: DEDUP_MINUTES,
        });
        if (recent) continue;
        const propertyName = propNames[b.property_id] || 'Property';
        const guest = (b.guest_name || 'Guest').trim();
        const pushRes = await sendPushToHost({
          supabaseAdmin: sb,
          propertyId: b.property_id,
          title: '🧹 Checkout Today — ' + propertyName,
          body: guest + ' · Clean needed',
          url: '/bookings',
          type: 'checkout_today',
          referenceId: b.id,
        });
        if (pushRes && pushRes.sent > 0) results.checkouts++;
      }
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      console.error('[StayOps] daily-notifications: checkouts section', message);
      results.errors.push({ section: 'checkouts', message });
    }

    try {
      const { data: tasks, error: err } = await sb
        .from('cleans')
        .select(
          'id, property_id, booking_id, guest_name, cleaner, cleaner_id, clean_date, done, cleaner_declined'
        )
        .gte('clean_date', today)
        .lte('clean_date', twoDaysAhead)
        .neq('done', true)
        .neq('cleaner_declined', true);

      if (err) throw err;

      const { data: props } = await sb.from('properties').select('id, name');
      const propNames = Object.fromEntries((props || []).map(p => [p.id, p.name || 'Property']));

      for (const c of tasks || []) {
        if (!isCleanUnassigned(c)) continue;
        const hrs = hoursUntilCleanDate(String(c.clean_date || '').slice(0, 10), now);
        if (hrs < 0 || hrs > UNASSIGNED_WINDOW_HRS) continue;
        const recent = await hasRecentNotification({
          supabaseAdmin: sb,
          type: 'unassigned_clean',
          referenceId: c.id,
          withinMinutes: DEDUP_MINUTES,
        });
        if (recent) continue;
        const propertyName = propNames[c.property_id] || 'Property';
        const hoursRounded = Math.max(0, Math.round(hrs));
        const pushRes = await sendPushToHost({
          supabaseAdmin: sb,
          propertyId: c.property_id,
          title: '⚠️ No Cleaner Assigned',
          body: propertyName + ' checkout in ' + hoursRounded + 'hrs, no cleaner',
          url: '/',
          type: 'unassigned_clean',
          referenceId: c.id,
        });
        if (pushRes && pushRes.sent > 0) results.unassigned++;
      }
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      console.error('[StayOps] daily-notifications: unassigned section', message);
      results.errors.push({ section: 'unassigned', message });
    }

    try {
      const twelveHoursAgo = new Date(now.getTime() - NO_RESPONSE_MIN_HRS * 3600000).toISOString();

      const { data: tasks, error: err } = await sb
        .from('cleans')
        .select(
          'id, property_id, cleaner, cleaner_id, clean_date, done, cleaner_confirmed, cleaner_declined, assigned_at'
        )
        .gte('clean_date', today)
        .neq('done', true)
        .neq('cleaner_declined', true)
        .not('assigned_at', 'is', null)
        .lt('assigned_at', twelveHoursAgo);

      if (err) throw err;

      const { data: props } = await sb.from('properties').select('id, name');
      const propNames = Object.fromEntries((props || []).map(p => [p.id, p.name || 'Property']));
      const taskPropIds = [...new Set((tasks || []).map(t => t.property_id).filter(Boolean))];
      let propsForCleaners = [];
      if (taskPropIds.length) {
        const { data: pw } = await sb.from('properties').select('id, user_id').in('id', taskPropIds);
        propsForCleaners = pw || [];
      }
      const cleanerUserIds = [...new Set(propsForCleaners.map(p => p.user_id).filter(Boolean))];
      let cleaners = [];
      if (cleanerUserIds.length) {
        const { data: cl } = await sb.from('cleaners').select('local_id, name').in('user_id', cleanerUserIds);
        cleaners = cl || [];
      }

      const cleanerNameByLocalId = Object.fromEntries(
        cleaners.map(cl => [String(cl.local_id || '').trim(), cl.name || ''])
      );

      for (const c of tasks || []) {
        if (isCleanUnassigned(c)) continue;
        if (c.cleaner_confirmed === true) continue;
        const recent = await hasRecentNotification({
          supabaseAdmin: sb,
          type: 'no_response',
          referenceId: c.id,
          withinMinutes: DEDUP_MINUTES,
        });
        if (recent) continue;
        const cid = String(c.cleaner_id || '').trim();
        const cleanerName =
          (cid && cleanerNameByLocalId[cid]) || String(c.cleaner || '').trim() || 'Cleaner';
        const propertyName = propNames[c.property_id] || 'Property';
        const pushRes = await sendPushToHost({
          supabaseAdmin: sb,
          propertyId: c.property_id,
          title: '⏰ No Cleaner Response',
          body: cleanerName + " hasn't responded for " + propertyName,
          url: '/',
          type: 'no_response',
          referenceId: c.id,
        });
        if (pushRes && pushRes.sent > 0) results.no_response++;
      }
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      console.error('[StayOps] daily-notifications: no_response section', message);
      results.errors.push({ section: 'no_response', message });
    }

    // ── Review cleaning cost: done cleans in last 3 days with no fee on booking ──
    try {
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 3600000).toISOString();
      const { data: doneCleans, error: dcErr } = await sb
        .from('cleans')
        .select('id, property_id, booking_id, guest_name, clean_date')
        .eq('done', true)
        .gte('completed_at', threeDaysAgo);

      if (dcErr) throw dcErr;
      results.review_cost = 0;

      for (const c of doneCleans || []) {
        if (!c.booking_id) continue;
        const recent = await hasRecentNotification({
          supabaseAdmin: sb,
          type: 'review_cleaning_cost',
          referenceId: c.id,
          withinMinutes: DEDUP_MINUTES,
        });
        if (recent) continue;

        // Check if booking has a cleaning fee entered
        const { data: bk } = await sb
          .from('bookings')
          .select('cleaning_fee')
          .or('local_id.eq.' + c.booking_id + ',id.eq.' + c.booking_id)
          .limit(1)
          .maybeSingle();

        if (bk && Number(bk.cleaning_fee)) continue; // fee already entered

        const { data: props } = await sb.from('properties').select('id, name').eq('id', c.property_id).limit(1);
        const propertyName = (props && props[0] && props[0].name) || 'Property';
        const guest = (c.guest_name || 'Guest').trim();

        const pushRes = await sendPushToHost({
          supabaseAdmin: sb,
          propertyId: c.property_id,
          title: '💰 Review Cleaning Cost',
          body: propertyName + ' · ' + guest + ' — clean completed, cost not entered',
          url: '/',
          type: 'review_cleaning_cost',
          referenceId: c.id,
        });
        if (pushRes && pushRes.sent > 0) results.review_cost++;
      }
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      console.error('[StayOps] daily-notifications: review_cost section', message);
      results.errors.push({ section: 'review_cost', message });
    }
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    console.error('[StayOps] daily-notifications: fatal', message);
    captureError(e, { tags: { function: 'daily-notifications' } });
    await flush();
    return json(500, { success: false, error: message });
  }

  console.log('[StayOps] Daily notifications complete:', results);
  return json(200, { success: true, summary: results });
};
