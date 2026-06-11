/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — iCal Sync
   Polls each active row in `property_ical_feeds`, parses VEVENTs, and upserts
   thin booking stubs (dates + property only). Matching guest-name / payout
   data is filled in later by the email scanner (gmail/outlook-scan-bookings).

   Two modes:
   - POST { uid }       → sync just that user's feeds (called from settings UI
                          and from the boot auto-sync in main.js).
   - Scheduled cron     → sync ALL users' active feeds every 15 min (declared
                          in netlify.toml).

   Required env: SUPABASE_URL, SUPABASE_SERVICE_KEY
   ═══════════════════════════════════════════════════════════════════════════ */

const { parseICS } = require('./utils/ical-parse');
const { pushChange: pushCalendarChange } = require('./utils/calendar-push-core');
const { notifyCleanerCancellation } = require('./utils/notify-cleaner-cancellation');
const { isCancellationBillable, loadCancellationConfig } = require('./utils/cancellation-policy');
const { verifyAuth } = require('./utils/auth');

// Best-effort outbound calendar push — never throws. Failures are queued
// inside pushChange via pending_direction='to_provider' for the reconciler.
function pushBookingToCalendar(uid, localId, op) {
  if (!uid || !localId) return;
  pushCalendarChange(uid, 'bookings', localId, op).catch(e => {
    console.warn('[ical-sync] calendar push failed:', e && e.message);
  });
}

function json(status, body) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body: JSON.stringify(body),
  };
}

function daysBetween(d1, d2) {
  if (!d1 || !d2) return 0;
  const a = new Date(d1);
  const b = new Date(d2);
  return Math.max(0, Math.round((b - a) / 86400000));
}

async function fetchFeed(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'StayOps/1.0' } });
  if (!res.ok) throw new Error('Feed HTTP ' + res.status);
  return res.text();
}

async function syncOneFeed(supabaseUrl, sbHeaders, feed) {
  const result = { feedId: feed.id, imported: 0, updated: 0, cancelled: 0, errors: 0 };
  const cancellationConfig = await loadCancellationConfig(supabaseUrl, sbHeaders, feed.user_id);

  let icsText;
  try {
    icsText = await fetchFeed(feed.ical_url);
  } catch (e) {
    await fetch(supabaseUrl + '/rest/v1/property_ical_feeds?id=eq.' + encodeURIComponent(feed.id), {
      method: 'PATCH',
      headers: { ...sbHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ last_error: e.message, last_synced_at: new Date().toISOString() }),
    });
    result.errors++;
    return result;
  }

  const events = parseICS(icsText, feed.platform);
  const liveUids = new Set(events.filter(e => !e.cancelled).map(e => e.uid));

  // Load existing iCal-sourced bookings for this feed
  const existRes = await fetch(
    supabaseUrl + '/rest/v1/bookings?user_id=eq.' + encodeURIComponent(feed.user_id) +
      '&ical_feed_id=eq.' + encodeURIComponent(feed.id) +
      '&select=id,local_id,ical_uid,checkin,checkout,status,enrichment_status,guest_name,guests,property_id',
    { headers: sbHeaders }
  );
  const existing = await existRes.json();
  const byUid = {};
  (Array.isArray(existing) ? existing : []).forEach(b => { byUid[b.ical_uid] = b; });

  for (const ev of events) {
    if (!ev.uid || !ev.checkin || !ev.checkout) continue;
    const prior = byUid[ev.uid];

    if (ev.cancelled) {
      if (prior && prior.status !== 'cancelled') {
        const cancelledAt = new Date().toISOString();
        await fetch(supabaseUrl + '/rest/v1/bookings?id=eq.' + encodeURIComponent(prior.id), {
          method: 'PATCH',
          headers: { ...sbHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify({
            status: 'cancelled',
            cancelled_at: cancelledAt,
            cancellation_billable: isCancellationBillable(prior, cancelledAt, cancellationConfig),
            updated_at: cancelledAt,
          }),
        });
        pushBookingToCalendar(feed.user_id, prior.local_id, 'delete');
        await notifyCleanerCancellation({
          supabaseUrl,
          sbHeaders,
          userId: feed.user_id,
          bookingId: prior.id,
          bookingRow: {
            guest_name: prior.guest_name,
            property_id: prior.property_id,
            guests: prior.guests,
          },
        });
        result.cancelled++;
      }
      continue;
    }

    if (!prior) {
      // Insert new stub
      const stub = {
        user_id: feed.user_id,
        property_id: feed.property_id,
        local_id: 'ical-' + feed.id + '-' + ev.uid,
        ical_uid: ev.uid,
        ical_feed_id: feed.id,
        checkin: ev.checkin,
        checkout: ev.checkout,
        nights: daysBetween(ev.checkin, ev.checkout),
        guest_name: 'Reserved — awaiting details',
        guests: 1,
        host_payout: 0,
        cleaning_fee: 0,
        platform: feed.platform || '',
        confirmation_code: ev.confirmationCode || '',
        status: 'confirmed',
        source: 'ical',
        enrichment_status: 'pending',
        property_unconfirmed: false,
        updated_at: new Date().toISOString(),
      };
      const insRes = await fetch(supabaseUrl + '/rest/v1/bookings', {
        method: 'POST',
        headers: { ...sbHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(stub),
      });
      if (insRes.ok || insRes.status === 201) result.imported++;
      else result.errors++;
    } else {
      // Update if dates shifted, or revive from cancelled state
      const datesChanged = prior.checkin !== ev.checkin || prior.checkout !== ev.checkout;
      const needsRevive = prior.status === 'cancelled';
      if (datesChanged || needsRevive) {
        const patch = { updated_at: new Date().toISOString() };
        if (datesChanged) {
          patch.checkin = ev.checkin;
          patch.checkout = ev.checkout;
          patch.nights = daysBetween(ev.checkin, ev.checkout);
        }
        if (needsRevive) patch.status = 'confirmed';
        await fetch(supabaseUrl + '/rest/v1/bookings?id=eq.' + encodeURIComponent(prior.id), {
          method: 'PATCH',
          headers: { ...sbHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify(patch),
        });
        pushBookingToCalendar(feed.user_id, prior.local_id, 'upsert');
        result.updated++;
      }
    }
  }

  // Guard against empty / garbage feeds before the disappearance sweep.
  // A 200 response that is truncated, an HTML error page, or an empty body
  // parses to ZERO events — which would make the sweep below soft-cancel
  // EVERY booking on this feed (and notify cleaners + delete calendar events).
  // A feed that legitimately has no upcoming bookings is indistinguishable
  // from a transient bad fetch here, so we err on the safe side: only run the
  // disappearance sweep when the body looks like real iCal AND parsed at least
  // one live event. A genuine single cancellation still flips via the
  // STATUS:CANCELLED path above, or is caught on a later healthy sync.
  const looksLikeICal = /BEGIN:VCALENDAR/i.test(icsText || '');
  const hasLiveEvents = liveUids.size > 0;
  if (!looksLikeICal || !hasLiveEvents) {
    console.warn(
      '[ical-sync] feed', feed.id,
      '— skipping disappearance sweep (looksLikeICal=' + looksLikeICal +
      ', liveEvents=' + liveUids.size + ', parsedEvents=' + events.length +
      ', bytes=' + (icsText ? icsText.length : 0) + ')'
    );
    await fetch(supabaseUrl + '/rest/v1/property_ical_feeds?id=eq.' + encodeURIComponent(feed.id), {
      method: 'PATCH',
      headers: { ...sbHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({
        last_error: looksLikeICal ? null : 'Feed did not look like valid iCal (no BEGIN:VCALENDAR)',
        last_synced_at: new Date().toISOString(),
      }),
    });
    return result;
  }

  // Bookings whose UID has disappeared from the feed → soft-cancel.
  // (Some platforms remove cancelled events instead of marking STATUS:CANCELLED.)
  for (const uid in byUid) {
    if (!liveUids.has(uid) && byUid[uid].status !== 'cancelled') {
      const stale = byUid[uid];
      const cancelledAt = new Date().toISOString();
      await fetch(supabaseUrl + '/rest/v1/bookings?id=eq.' + encodeURIComponent(stale.id), {
        method: 'PATCH',
        headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'cancelled',
          cancelled_at: cancelledAt,
          cancellation_billable: isCancellationBillable(stale, cancelledAt, cancellationConfig),
          updated_at: cancelledAt,
        }),
      });
      pushBookingToCalendar(feed.user_id, stale.local_id, 'delete');
      await notifyCleanerCancellation({
        supabaseUrl,
        sbHeaders,
        userId: feed.user_id,
        bookingId: stale.id,
        bookingRow: {
          guest_name: stale.guest_name,
          property_id: stale.property_id,
          guests: stale.guests,
        },
      });
      result.cancelled++;
    }
  }

  await fetch(supabaseUrl + '/rest/v1/property_ical_feeds?id=eq.' + encodeURIComponent(feed.id), {
    method: 'PATCH',
    headers: { ...sbHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({ last_error: null, last_synced_at: new Date().toISOString() }),
  });

  return result;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, { ok: true });
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (_) {
    return json(400, { error: 'Invalid JSON' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return json(500, { error: 'Server not configured' });
  }
  const sbHeaders = {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
  };

  // Auth model:
  //  • Manual call (frontend "Sync now" / boot auto-sync) sends { uid }. Require
  //    a valid JWT and derive the user from it — never trust the body uid (it's
  //    a non-secret leaked in cleaner links + the public calendar feed). This is
  //    what closes the per-user trigger/false-cancel abuse vector.
  //  • Scheduled cron (netlify.toml, every 15 min) sends no body/uid and runs
  //    over ALL users' feeds server-side. That path is intentionally left open
  //    here because Netlify's internal scheduler can't attach an Authorization
  //    header; it returns only aggregate totals (no PII). See note in summary.
  let scopedUid = null;
  if (body && body.uid) {
    const auth = await verifyAuth(event);
    if (auth.error) return auth.error;
    scopedUid = auth.id;
  }

  const uidFilter = scopedUid ? '&user_id=eq.' + encodeURIComponent(scopedUid) : '';
  const feedRes = await fetch(
    SUPABASE_URL + '/rest/v1/property_ical_feeds?active=eq.true' + uidFilter +
      '&select=id,user_id,property_id,platform,ical_url',
    { headers: sbHeaders }
  );
  const feeds = await feedRes.json();
  if (!Array.isArray(feeds)) {
    return json(500, { error: 'Failed to load feeds: ' + JSON.stringify(feeds).slice(0, 200) });
  }

  const totals = { imported: 0, updated: 0, cancelled: 0, errors: 0, feeds: feeds.length };
  for (const feed of feeds) {
    try {
      const r = await syncOneFeed(SUPABASE_URL, sbHeaders, feed);
      totals.imported += r.imported;
      totals.updated += r.updated;
      totals.cancelled += r.cancelled;
      totals.errors += r.errors;
    } catch (e) {
      console.warn('[ical-sync] feed', feed.id, 'failed:', e.message);
      totals.errors++;
    }
  }

  return json(200, totals);
};
