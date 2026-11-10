// Netlify/functions/cleaner-morning-digest.js
//
// StayOps — the cleaner's morning push: one notification with the shape of the
// day, instead of a buzz per event.
//
//   🧹 Today: 3 cleans
//   First out 10am at Seaview · 1 same-day turnover (Hilltop, next guest 3pm) · 1 awaiting your reply
//
// SCHEDULE (netlify.toml): 20:00 UTC = 07:00 Sydney during AEDT (Oct–early Apr),
// 06:00 during AEST. No DST logic here; adjust the cron if that drifts too early.
//
// WHO: every cleaner with cleans today (cleaner_uuid set, not done, not declined,
// booking not cancelled) AND an auth_user_id. Delivery goes to the cleaner's
// own devices via push-helper sendPushToUser (app_config.push_subscriptions
// under cleaners.auth_user_id — the cleaner PWA saves them there). Cleaners
// without push enabled are skipped quietly; the 24h reminder EMAIL
// (send-clean-reminders.js) still covers them.
//
// DEDUP: one digest per cleaner LOGIN per day via notification_log
// (type cleaner_digest, reference_id <auth_user_id>:<date>), so a manual re-run
// or a double schedule fire cannot double-buzz, and a cleaner with rows under
// two hosts gets a single digest spanning both.
//
// AUTH: Netlify's scheduler invokes the function with a JSON body carrying
// `next_run`; anything else must present x-cron-secret = CRON_SECRET (same
// pattern as daily-notifications.js) or is refused.
//
// Turnover maths: ./utils/cleaner-turnover.js (shared with the calendar feed).
//
// Required env: SUPABASE_URL, SUPABASE_SERVICE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY

const { createClient } = require('@supabase/supabase-js');
const { sendPushToUser, hasRecentNotification } = require('./utils/push-helper');
const { resolveTurnover, mins, clock } = require('./utils/cleaner-turnover');
const { captureError, flush } = require('./utils/sentry');

const SYDNEY_TZ = 'Australia/Sydney';
const DEDUP_MINUTES = 1380; // 23h — the cron is daily

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
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

/** Today's date in Sydney as "YYYY-MM-DD". */
function sydneyYmd(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SYDNEY_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const pick = t => (parts.find(p => p.type === t) || {}).value;
  return pick('year') + '-' + pick('month') + '-' + pick('day');
}

/** Scheduled invocations carry `next_run`; manual ones must present the cron secret. */
function isAuthorised(event) {
  try {
    const body = event && event.body ? JSON.parse(event.body) : null;
    if (body && typeof body === 'object' && body.next_run) return true;
  } catch (_e) { /* not JSON */ }
  const secret = process.env.CRON_SECRET;
  return !!secret && getHeader(event && event.headers, 'x-cron-secret') === secret;
}

/**
 * Compose the digest for one cleaner from their resolved cleans.
 * @param {Array<{propertyName:string, turnover:object, awaiting:boolean}>} items
 * @returns {{title:string, body:string}}
 */
function composeDigest(items) {
  const n = items.length;
  const title = '🧹 Today: ' + n + (n === 1 ? ' clean' : ' cleans');
  const byDeadline = items.slice().sort((a, b) => {
    const ka = a.turnover.sameDay ? mins(a.turnover.nextTime) : 1440 + mins(a.turnover.checkout);
    const kb = b.turnover.sameDay ? mins(b.turnover.nextTime) : 1440 + mins(b.turnover.checkout);
    return ka - kb;
  });
  const earliestOut = items.slice().sort((a, b) => mins(a.turnover.checkout) - mins(b.turnover.checkout))[0];
  const turnovers = byDeadline.filter(i => i.turnover.sameDay);
  const awaiting = items.filter(i => i.awaiting).length;
  const parts = [];
  if (earliestOut) parts.push('First out ' + clock(earliestOut.turnover.checkout) + ' at ' + earliestOut.propertyName);
  if (turnovers.length) {
    const first = turnovers[0];
    parts.push(turnovers.length + ' same-day turnover' + (turnovers.length === 1 ? '' : 's') +
      ' (' + first.propertyName + ', next guest ' + clock(first.turnover.nextTime) + (turnovers.length > 1 ? ', …' : '') + ')');
  }
  if (awaiting) parts.push(awaiting + ' awaiting your reply');
  return { title, body: parts.join(' · ') };
}

exports.handler = async (event) => {
  if (!isAuthorised(event)) {
    console.log('[cleaner-morning-digest] refusing: not a scheduled invocation and no valid x-cron-secret');
    return json(401, { ok: false, error: 'Unauthorised' });
  }
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error('[cleaner-morning-digest] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
    return json(500, { ok: false, error: 'Supabase env vars not set' });
  }

  const sb = createClient(supabaseUrl, supabaseKey);
  const today = sydneyYmd(new Date());
  const summary = { ok: true, date: today, cleaners: 0, sent: 0, skipped: 0 };

  try {
    // 1. Today's live cleans that have a cleaner
    const { data: cleans, error: cErr } = await sb
      .from('cleans')
      .select('id, user_id, property_id, booking_id, cleaner_uuid, guest_name, clean_date, cleaner_confirmed')
      .eq('clean_date', today)
      .neq('done', true)
      .neq('cleaner_declined', true)
      .neq('cleaner_cancel_notified', true)
      .not('cleaner_uuid', 'is', null);
    if (cErr) throw new Error('cleans query failed: ' + cErr.message);
    const live = (cleans || []).filter(c => c.cleaner_uuid);
    if (!live.length) return json(200, summary);

    // 2. Cleaners, properties, bookings (same host as each clean — local_id is per host)
    const cleanerIds = [...new Set(live.map(c => c.cleaner_uuid))];
    const propIds = [...new Set(live.map(c => c.property_id).filter(Boolean))];
    const [{ data: cleaners }, { data: properties }, { data: bookings }] = await Promise.all([
      sb.from('cleaners').select('id, name, auth_user_id, active').in('id', cleanerIds),
      propIds.length ? sb.from('properties').select('id, name').in('id', propIds) : Promise.resolve({ data: [] }),
      propIds.length
        ? sb.from('bookings')
            .select('id, local_id, property_id, user_id, checkin, checkout, checkin_time, checkout_time, guests, status')
            .in('property_id', propIds)
            .lte('checkin', today)
            .gte('checkout', today)
        : Promise.resolve({ data: [] }),
    ]);
    const cleanerById = {};
    (cleaners || []).forEach(c => { cleanerById[c.id] = c; });
    const propName = {};
    (properties || []).forEach(p => { propName[p.id] = p.name || 'Property'; });

    // 3. Group by the cleaner's LOGIN (auth_user_id), not by cleaner row — a
    //    cleaner working for two hosts has two rows and should get one digest
    //    covering both. Drop cancelled bookings, compose, push.
    const byAuth = {};
    live.forEach(c => {
      const cleaner = cleanerById[c.cleaner_uuid];
      if (!cleaner || cleaner.active === false || !cleaner.auth_user_id) { summary.skipped++; return; }
      const g = byAuth[cleaner.auth_user_id] = byAuth[cleaner.auth_user_id] || { cleaner, cleans: [] };
      g.cleans.push(c);
    });

    for (const authId of Object.keys(byAuth)) {
      const { cleaner, cleans: mine } = byAuth[authId];

      const items = mine
        .map(c => {
          const sameHost = (bookings || []).filter(b => !c.user_id || String(b.user_id) === String(c.user_id));
          const turnover = resolveTurnover(c, sameHost);
          return turnover.cancelled ? null : { propertyName: propName[c.property_id] || 'Property', turnover, awaiting: !c.cleaner_confirmed, propertyId: c.property_id };
        })
        .filter(Boolean);
      if (!items.length) { summary.skipped++; continue; }

      const referenceId = authId + ':' + today;
      if (await hasRecentNotification({ supabaseAdmin: sb, type: 'cleaner_digest', referenceId, withinMinutes: DEDUP_MINUTES })) {
        summary.skipped++;
        continue;
      }

      summary.cleaners++;
      const { title, body } = composeDigest(items);
      const r = await sendPushToUser({ supabaseAdmin: sb, userId: cleaner.auth_user_id, title, body, url: '/', type: 'cleaner_digest', tag: 'cleaner-digest-' + today });
      summary.sent += r.sent;

      const { error: logErr } = await sb.from('notification_log').insert({
        property_id: items[0].propertyId || null,
        type: 'cleaner_digest',
        reference_id: referenceId,
        title,
        body,
        sent_at: new Date().toISOString(),
      });
      if (logErr) console.log('[cleaner-morning-digest] notification_log insert failed:', logErr.message);
    }

    console.log('[cleaner-morning-digest]', JSON.stringify(summary));
    return json(200, summary);
  } catch (err) {
    console.error('[cleaner-morning-digest] Error:', err);
    captureError(err, { tags: { function: 'cleaner-morning-digest' } });
    await flush();
    return json(500, { ok: false, error: 'Internal error' });
  }
};

exports._composeDigest = composeDigest;
