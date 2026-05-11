/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Notify cleaner of cancellation (shared helper)

   When a booking is soft-cancelled by a backend path (iCal sync, email scan),
   the linked clean rows still exist. This helper:
     1. Finds cleans for that booking that haven't been cancel-notified yet.
     2. Emails each assigned cleaner via Resend using the cancellation template.
     3. Marks cleaner_cancel_notified = true on each clean.

   Skips silently if the user has disabled the email_cancellation flag in
   notification_config. Never throws — all errors are caught and logged so
   the calling function (ical-sync, email-scan) is never broken by a notify
   failure.

   Uses raw REST (supabaseUrl + sbHeaders) so it works from both ical-sync
   (which uses raw REST) and email-scan-shared (which also has these handy).
   ═══════════════════════════════════════════════════════════════════════════ */

const { cancellation: buildCancellationHtml } = require('./email-templates');

function enc(s) { return encodeURIComponent(s); }

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(String(dateStr).slice(0, 10) + 'T12:00:00Z');
    return d.toLocaleDateString('en-AU', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
  } catch (_) {
    return String(dateStr);
  }
}

async function notifyCleanerCancellation({ supabaseUrl, sbHeaders, userId, bookingId, bookingRow }) {
  if (!supabaseUrl || !sbHeaders || !userId || !bookingId) return { notified: 0, skipped: 0 };

  const result = { notified: 0, skipped: 0 };

  try {
    // 1. Check the host's notification_config — bail if email_cancellation is off.
    let emailCancellationEnabled = true;
    try {
      const cfgRes = await fetch(
        supabaseUrl + '/rest/v1/app_config?user_id=eq.' + enc(userId) +
          '&select=notification_config',
        { headers: sbHeaders }
      );
      const cfgRows = await cfgRes.json();
      const cfg = Array.isArray(cfgRows) && cfgRows.length ? cfgRows[0] : null;
      if (cfg && cfg.notification_config && cfg.notification_config.email_cancellation === false) {
        emailCancellationEnabled = false;
      }
    } catch (e) {
      console.warn('[notify-cleaner-cancellation] config lookup failed:', e && e.message);
    }

    // 2. Find linked cleans that haven't been cancel-notified.
    const cleansRes = await fetch(
      supabaseUrl + '/rest/v1/cleans?user_id=eq.' + enc(userId) +
        '&booking_id=eq.' + enc(String(bookingId)) +
        '&cleaner_cancel_notified=is.false' +
        '&select=id,cleaner,cleaner_id,clean_date,property_id',
      { headers: sbHeaders }
    );
    const cleans = await cleansRes.json();
    if (!Array.isArray(cleans) || !cleans.length) return result;

    // 3. Resolve property name (one lookup, shared across cleans for the same booking).
    let propertyName = 'the property';
    if (bookingRow && bookingRow.property_id) {
      try {
        const propRes = await fetch(
          supabaseUrl + '/rest/v1/properties?id=eq.' + enc(bookingRow.property_id) +
            '&select=name',
          { headers: sbHeaders }
        );
        const propRows = await propRes.json();
        if (Array.isArray(propRows) && propRows.length && propRows[0].name) {
          propertyName = propRows[0].name;
        }
      } catch (_) { /* fall through to default */ }
    }

    const resendApiKey = process.env.RESEND_API_KEY;
    const resendFrom = process.env.RESEND_FROM || 'StayOps <info@stayops.com.au>';

    for (const clean of cleans) {
      // Always mark as cancel-notified so the daily reminder cron skips it,
      // even if we can't actually send an email (no cleaner, no email, etc.).
      let cleanerEmail = '';
      let cleanerName = clean.cleaner || 'there';

      try {
        // Look up cleaner — prefer local_id match, fall back to name match.
        let cleanerRow = null;
        if (clean.cleaner_id) {
          const cRes = await fetch(
            supabaseUrl + '/rest/v1/cleaners?user_id=eq.' + enc(userId) +
              '&local_id=eq.' + enc(String(clean.cleaner_id)) +
              '&select=name,email&limit=1',
            { headers: sbHeaders }
          );
          const cRows = await cRes.json();
          if (Array.isArray(cRows) && cRows.length) cleanerRow = cRows[0];
        }
        if (!cleanerRow && clean.cleaner) {
          const cRes = await fetch(
            supabaseUrl + '/rest/v1/cleaners?user_id=eq.' + enc(userId) +
              '&name=ilike.' + enc(clean.cleaner) +
              '&select=name,email&limit=1',
            { headers: sbHeaders }
          );
          const cRows = await cRes.json();
          if (Array.isArray(cRows) && cRows.length) cleanerRow = cRows[0];
        }
        if (cleanerRow) {
          cleanerEmail = (cleanerRow.email || '').trim();
          if (cleanerRow.name) cleanerName = cleanerRow.name;
        }
      } catch (e) {
        console.warn('[notify-cleaner-cancellation] cleaner lookup failed:', e && e.message);
      }

      // 4. Send the email (best-effort).
      let emailSent = false;
      if (emailCancellationEnabled && resendApiKey && cleanerEmail) {
        try {
          const html = buildCancellationHtml({
            cleaner_name: cleanerName,
            property_name: propertyName,
            guest_name: (bookingRow && bookingRow.guest_name) || 'the guest',
            guest_count: (bookingRow && bookingRow.guests) || '',
            clean_date: formatDate(clean.clean_date),
            clean_time: '',
            cancel_reason: 'Booking cancelled',
            host_name: 'the host',
            schedule_link: '',
          });
          const subject = '❌ Clean cancelled' +
            (bookingRow && bookingRow.guest_name ? ' — ' + bookingRow.guest_name : '');
          const sendRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + resendApiKey,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ from: resendFrom, to: cleanerEmail, subject, html }),
          });
          emailSent = sendRes.ok;
          if (!emailSent) {
            const errBody = await sendRes.text();
            console.warn('[notify-cleaner-cancellation] Resend non-OK for',
              cleanerEmail, sendRes.status, errBody.slice(0, 200));
          }
        } catch (e) {
          console.warn('[notify-cleaner-cancellation] Resend fetch failed:', e && e.message);
        }
      }

      // 5. Flip cleaner_cancel_notified regardless of email outcome —
      // this is the canonical "this clean is cancelled" signal.
      try {
        await fetch(
          supabaseUrl + '/rest/v1/cleans?id=eq.' + enc(clean.id),
          {
            method: 'PATCH',
            headers: { ...sbHeaders, Prefer: 'return=minimal' },
            body: JSON.stringify({
              cleaner_cancel_notified: true,
              updated_at: new Date().toISOString(),
            }),
          }
        );
        if (emailSent) result.notified++;
        else result.skipped++;
      } catch (e) {
        console.warn('[notify-cleaner-cancellation] clean PATCH failed:', e && e.message);
        result.skipped++;
      }
    }
  } catch (e) {
    console.warn('[notify-cleaner-cancellation] fatal:', e && e.message);
  }

  return result;
}

module.exports = { notifyCleanerCancellation };
