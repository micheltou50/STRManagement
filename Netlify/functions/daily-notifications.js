// Netlify/functions/daily-notifications.js
//
// StayOps — morning digest (intended 7:00 Australia/Sydney via Supabase pg_cron).
// Queries users with push subscriptions, evaluates bookings/cleans, sends web-push.
//
// Dedupe: app_config.daily_notifications_last_aest_date === today (Sydney) → skip user.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
//      VAPID_SUBJECT (optional)

const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

const SYDNEY_TZ = 'Australia/Sydney';
const UNASSIGNED_WINDOW_HRS = 48;
const NO_RESPONSE_MIN_HRS = 12;

let _vapidReady = false;
function ensureVapid() {
  if (_vapidReady) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@glenhaven21.netlify.app',
    pub,
    priv
  );
  _vapidReady = true;
  return true;
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}

/** Calendar YYYY-MM-DD in Australia/Sydney for instant `d`. */
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

function parsePushSubscription(raw) {
  if (raw == null || raw === '') return null;
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (o && typeof o.endpoint === 'string' && o.keys && o.keys.p256dh && o.keys.auth) return o;
  } catch (_) {}
  return null;
}

/** Hours from `now` until 10:00 Australia/Sydney on checkout calendar day. */
function hoursUntilCheckout(checkoutYmd, now) {
  if (!checkoutYmd || !/^\d{4}-\d{2}-\d{2}$/.test(checkoutYmd)) return Infinity;
  const candidates = [
    Date.parse(`${checkoutYmd}T10:00:00+10:00`),
    Date.parse(`${checkoutYmd}T10:00:00+11:00`),
  ];
  for (const t of candidates) {
    if (Number.isNaN(t)) continue;
    if (sydneyYmd(new Date(t)) === checkoutYmd) return (t - now.getTime()) / 3600000;
  }
  const fallback = candidates.find(t => !Number.isNaN(t));
  return fallback != null ? (fallback - now.getTime()) / 3600000 : Infinity;
}

function isCleanUnassigned(c) {
  const id = String(c.cleaner_id || '').trim();
  const name = String(c.cleaner || '').trim();
  return !id && !name;
}

async function sendPush(subscription, title, body, tag) {
  console.log('[StayOps] daily-notifications: sending push —', title);
  await webpush.sendNotification(
    subscription,
    JSON.stringify({
      title,
      body: body || '',
      url: '/',
      tag: tag || 'stayops-daily',
    })
  );
}

async function trySendPush(subscription, title, body, tag, summary, userId) {
  try {
    await sendPush(subscription, title, body, tag);
    return true;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    console.warn('[StayOps] daily-notifications: push failed —', title, msg);
    summary.errors.push({ user_id: userId, step: 'push', title, message: msg });
    return false;
  }
}

function findBookingForClean(clean, bookings) {
  const bid = clean.booking_id != null ? String(clean.booking_id).trim() : '';
  if (!bid) return null;
  let b = bookings.find(x => String(x.id) === bid);
  if (!b) b = bookings.find(x => String(x.local_id) === bid);
  return b || null;
}

exports.handler = async (event) => {
  const method = event.httpMethod || 'GET';
  if (method === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' };
  }
  if (method !== 'GET' && method !== 'POST') {
    return json(405, { ok: false, error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('[StayOps] daily-notifications: missing Supabase env');
    return json(500, { ok: false, error: 'Server misconfigured (Supabase)' });
  }
  if (!ensureVapid()) {
    console.error('[StayOps] daily-notifications: missing VAPID keys');
    return json(500, { ok: false, error: 'Server misconfigured (VAPID)' });
  }

  const now = new Date();
  const todaySydney = sydneyYmd(now);
  console.log('[StayOps] daily-notifications: run start, Sydney date =', todaySydney);

  const sb = createClient(supabaseUrl, supabaseKey);

  const summary = {
    ok: true,
    sydneyDate: todaySydney,
    usersConsidered: 0,
    usersSkippedAlreadyNotified: 0,
    usersSkippedNoSubscription: 0,
    usersProcessed: 0,
    pushesSent: { checkin: 0, checkout: 0, unassignedClean: 0, noCleanerResponse: 0 },
    errors: [],
  };

  const { data: configs, error: cfgErr } = await sb
    .from('app_config')
    .select('user_id, push_subscription, daily_notifications_last_aest_date')
    .not('push_subscription', 'is', null);

  if (cfgErr) {
    console.error('[StayOps] daily-notifications: app_config query failed', cfgErr);
    return json(500, { ok: false, error: cfgErr.message });
  }

  const rows = Array.isArray(configs) ? configs : [];
  console.log('[StayOps] daily-notifications: app_config rows =', rows.length);

  for (const row of rows) {
    const uid = row.user_id;
    if (!uid) continue;

    const sub = parsePushSubscription(row.push_subscription);
    if (!sub) {
      summary.usersSkippedNoSubscription++;
      continue;
    }

    summary.usersConsidered++;

    const last = (row.daily_notifications_last_aest_date || '').trim();
    if (last === todaySydney) {
      console.log('[StayOps] daily-notifications: skip user (already sent today)', uid);
      summary.usersSkippedAlreadyNotified++;
      continue;
    }

    try {
      const { data: bookings, error: bErr } = await sb
        .from('bookings')
        .select('id, local_id, user_id, property_id, checkin, checkout, guest_name, guests, status')
        .eq('user_id', uid);

      if (bErr) throw new Error('bookings: ' + bErr.message);
      const bookList = Array.isArray(bookings) ? bookings : [];

      const { data: cleans, error: cErr } = await sb
        .from('cleans')
        .select(
          'id, user_id, property_id, booking_id, guest_name, cleaner, cleaner_id, clean_date, done, cleaner_confirmed, cleaner_declined, assigned_at'
        )
        .eq('user_id', uid);

      if (cErr) throw new Error('cleans: ' + cErr.message);
      const cleanList = Array.isArray(cleans) ? cleans : [];

      const { data: properties, error: pErr } = await sb
        .from('properties')
        .select('id, name')
        .eq('user_id', uid);

      if (pErr) throw new Error('properties: ' + pErr.message);
      const propMap = Object.fromEntries((properties || []).map(p => [p.id, p.name || '']));

      const { data: cleaners, error: clErr } = await sb
        .from('cleaners')
        .select('local_id, name')
        .eq('user_id', uid);

      if (clErr) throw new Error('cleaners: ' + clErr.message);
      const cleanerNameByLocalId = Object.fromEntries(
        (cleaners || []).map(c => [String(c.local_id || '').trim(), c.name || ''])
      );

      function propertyName(propertyId) {
        return (propertyId && propMap[propertyId]) || 'Property';
      }

      for (const b of bookList) {
        if ((b.status || '').toLowerCase() === 'cancelled') continue;
        const cin = (b.checkin || '').slice(0, 10);
        const cout = (b.checkout || '').slice(0, 10);
        const guest = (b.guest_name || 'Guest').trim();
        const nGuests = Number(b.guests) || 1;
        const pname = propertyName(b.property_id);

        if (cin === todaySydney) {
          const ok = await trySendPush(
            sub,
            'Check-in Today — ' + pname,
            guest + ' · ' + nGuests + ' guests',
            'stayops-checkin-' + b.id,
            summary,
            uid
          );
          if (ok) summary.pushesSent.checkin++;
        }

        if (cout === todaySydney) {
          const ok = await trySendPush(
            sub,
            'Checkout Today — ' + pname,
            guest + ' · Clean needed',
            'stayops-checkout-' + b.id,
            summary,
            uid
          );
          if (ok) summary.pushesSent.checkout++;
        }
      }

      for (const c of cleanList) {
        if (c.done || c.cleaner_declined) continue;

        const linked = findBookingForClean(c, bookList);
        if (linked && (linked.status || '').toLowerCase() === 'cancelled') continue;

        const checkoutYmd = linked
          ? String(linked.checkout || '').slice(0, 10)
          : String(c.clean_date || '').slice(0, 10);

        if (isCleanUnassigned(c)) {
          const hrs = hoursUntilCheckout(checkoutYmd, now);
          if (hrs >= 0 && hrs <= UNASSIGNED_WINDOW_HRS) {
            const pname = propertyName(c.property_id);
            const x = Math.max(0, Math.round(hrs));
            const ok = await trySendPush(
              sub,
              'Urgent: No Cleaner Assigned',
              pname + ' checkout in ' + x + 'hrs, no cleaner',
              'stayops-unassigned-' + c.id,
              summary,
              uid
            );
            if (ok) summary.pushesSent.unassignedClean++;
          }
          continue;
        }

        if (!c.cleaner_confirmed && c.assigned_at) {
          const assignedMs = new Date(c.assigned_at).getTime();
          const ageHrs = (now.getTime() - assignedMs) / 3600000;
          if (!Number.isNaN(assignedMs) && ageHrs >= NO_RESPONSE_MIN_HRS) {
            const cid = String(c.cleaner_id || '').trim();
            const cleanerName =
              (cid && cleanerNameByLocalId[cid]) || String(c.cleaner || '').trim() || 'Cleaner';
            const pname = propertyName(c.property_id);
            const ok = await trySendPush(
              sub,
              'No Cleaner Response',
              cleanerName + " hasn't responded for " + pname,
              'stayops-noresponse-' + c.id,
              summary,
              uid
            );
            if (ok) summary.pushesSent.noCleanerResponse++;
          }
        }
      }

      const { error: patchErr } = await sb
        .from('app_config')
        .update({
          daily_notifications_last_aest_date: todaySydney,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', uid);

      if (patchErr) {
        console.error('[StayOps] daily-notifications: failed to update last sent date', uid, patchErr);
        summary.errors.push({ user_id: uid, step: 'patch_app_config', message: patchErr.message });
      } else {
        console.log('[StayOps] daily-notifications: marked sent for user', uid, todaySydney);
      }

      summary.usersProcessed++;
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      console.error('[StayOps] daily-notifications: user error', uid, msg);
      summary.errors.push({ user_id: uid, message: msg });
    }
  }

  const totalPushes =
    summary.pushesSent.checkin +
    summary.pushesSent.checkout +
    summary.pushesSent.unassignedClean +
    summary.pushesSent.noCleanerResponse;

  console.log(
    '[StayOps] daily-notifications: done — usersProcessed=',
    summary.usersProcessed,
    'pushes=',
    totalPushes,
    summary.pushesSent
  );

  return json(200, summary);
};
