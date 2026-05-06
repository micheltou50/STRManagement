// Netlify/functions/send-clean-reminders.js
//
// Scheduled function — runs daily at 10:00 PM UTC (8:00 AM AEST).
// Finds all cleans where:
//   • clean_date = tomorrow (local date at time of run)
//   • cleaner has an email address
//   • reminder_sent is not true
//   • clean is not done, not declined
// Sends a reminder email via Resend and marks reminder_sent = true.
//
// Required Netlify env vars:
//   RESEND_API_KEY       — Resend API key
//   RESEND_FROM          — sender address (e.g. "StayOps <noreply@yourdomain.com>")
//   SUPABASE_URL         — your Supabase project URL
//   SUPABASE_SERVICE_KEY — Supabase service role key (NOT anon key — needs write access)

const { createClient } = require('@supabase/supabase-js');
const { captureError, flush } = require('./utils/sentry');

// ── helpers ───────────────────────────────────────────────────────────────────

function tomorrowDateStr() {
  // Must use Sydney timezone — this cron fires at 22:00 UTC = 08:00 AEST.
  // Using UTC+1 would return "today" in Sydney terms, not "tomorrow".
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = Number(parts.find(p => p.type === 'year').value);
  const m = Number(parts.find(p => p.type === 'month').value);
  const d = Number(parts.find(p => p.type === 'day').value);
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1));
  return tomorrow.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function buildEmailHtml({ cleanerName, guestName, cleanDate, propertyName, cleanerLink, color }) {
  const safeColor = color || '#E65100';
  const prop      = propertyName || 'the property';
  const link      = cleanerLink  || '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:'Helvetica Neue',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06)">

        <!-- Header bar -->
        <tr><td style="background:${safeColor};padding:24px 32px">
          <p style="margin:0;font-size:13px;font-weight:600;color:rgba(255,255,255,0.8);text-transform:uppercase;letter-spacing:0.8px">StayOps · Cleaning reminder</p>
          <h1 style="margin:6px 0 0;font-size:22px;font-weight:700;color:#ffffff">Clean tomorrow ⏰</h1>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:28px 32px">
          <p style="margin:0 0 16px;font-size:16px;color:#1a1a1a">Hi <strong>${escapeHtml(cleanerName)}</strong>,</p>
          <p style="margin:0 0 20px;font-size:15px;color:#333;line-height:1.6">
            Just a reminder — you have a clean <strong>tomorrow</strong> at <strong>${escapeHtml(prop)}</strong>.
          </p>

          <!-- Details card -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fa;border-radius:8px;margin-bottom:24px">
            <tr><td style="padding:16px 20px">
              <table width="100%" cellpadding="4" cellspacing="0">
                <tr>
                  <td style="font-size:12px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;width:40%">Guest</td>
                  <td style="font-size:14px;color:#1a1a1a;font-weight:600">${escapeHtml(guestName)}</td>
                </tr>
                <tr>
                  <td style="font-size:12px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:0.6px">Clean date</td>
                  <td style="font-size:14px;color:#1a1a1a;font-weight:600">${escapeHtml(cleanDate)}</td>
                </tr>
              </table>
            </td></tr>
          </table>

          ${link ? `
          <p style="margin:0 0 8px;text-align:center">
            <a href="${link}" style="display:inline-block;background:${safeColor};color:#ffffff;text-decoration:none;padding:13px 28px;border-radius:8px;font-size:15px;font-weight:600">
              Open StayOps →
            </a>
          </p>` : ''}

        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:16px 32px 24px;border-top:1px solid #f0f0f0">
          <p style="margin:0;font-size:12px;color:#aaa;text-align:center">
            Sent automatically by StayOps · 24h before your scheduled clean
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00Z'); // noon UTC avoids timezone flip
  return d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

// ── main handler ──────────────────────────────────────────────────────────────

exports.handler = async (_event) => {
  const supabaseUrl        = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
  const resendApiKey       = process.env.RESEND_API_KEY;
  const resendFrom         = process.env.RESEND_FROM || 'StayOps <noreply@app.stayops.com.au>';

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('[send-clean-reminders] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
    return { statusCode: 500, body: 'Supabase env vars not set' };
  }
  if (!resendApiKey) {
    console.error('[send-clean-reminders] Missing RESEND_API_KEY');
    return { statusCode: 500, body: 'RESEND_API_KEY not set' };
  }

  try {
  const sb       = createClient(supabaseUrl, supabaseServiceKey);
  const tomorrow = tomorrowDateStr();
  console.log(`[send-clean-reminders] Running for tomorrow: ${tomorrow}`);

  // ── 1. Fetch cleans due tomorrow that haven't been reminded ──────────────
  const { data: cleans, error: cleanErr } = await sb
    .from('cleans')
    .select('id, user_id, guest_name, cleaner, cleaner_id, clean_date, done, cleaner_declined, reminder_sent, property_id')
    .eq('clean_date', tomorrow)
    .neq('done', true)
    .neq('cleaner_declined', true)
    .neq('reminder_sent', true);

  if (cleanErr) {
    console.error('[send-clean-reminders] Error fetching cleans:', cleanErr);
    return { statusCode: 500, body: cleanErr.message };
  }

  if (!cleans || !cleans.length) {
    console.log('[send-clean-reminders] No cleans to remind today.');
    return { statusCode: 200, body: 'No reminders needed' };
  }

  console.log(`[send-clean-reminders] Found ${cleans.length} clean(s) to process`);

  // ── 1b. Check notification_config — bail if email_reminder is disabled ──
  // Group cleans by user_id to check config once per owner
  const ownerIds = [...new Set(cleans.map(c => c.user_id).filter(Boolean))];
  const disabledOwners = new Set();
  for (const oid of ownerIds) {
    const { data: cfg } = await sb.from('app_config').select('notification_config').eq('user_id', oid).maybeSingle();
    if (cfg && cfg.notification_config && cfg.notification_config.email_reminder === false) {
      disabledOwners.add(oid);
      console.log('[send-clean-reminders] email_reminder disabled for user', oid);
    }
  }

  // ── 2. For each clean, look up the cleaner email ─────────────────────────
  let sent = 0, skipped = 0;

  for (const clean of cleans) {
    // Skip if owner has disabled email reminders
    if (disabledOwners.has(clean.user_id)) { skipped++; continue; }

    // Resolve cleaner email — try cleaner_id first, then name match
    let cleanerRecord = null;

    if (clean.cleaner_id) {
      const { data: byId } = await sb
        .from('cleaners')
        .select('id, name, email')
        .eq('user_id', clean.user_id)
        .eq('local_id', String(clean.cleaner_id))
        .single();
      cleanerRecord = byId;
    }

    if (!cleanerRecord && clean.cleaner) {
      const { data: byName } = await sb
        .from('cleaners')
        .select('id, name, email')
        .eq('user_id', clean.user_id)
        .ilike('name', clean.cleaner)
        .single();
      cleanerRecord = byName;
    }

    const cleanerEmail = (cleanerRecord?.email || '').trim();

    if (!cleanerEmail) {
      console.log(`[send-clean-reminders] No email for cleaner "${clean.cleaner}" — skipping clean ${clean.id}`);
      skipped++;
      continue;
    }

    // ── 3. Fetch property name for this user ─────────────────────────────
    let propertyName = 'the property';
    if (clean.property_id) {
      const { data: prop } = await sb
        .from('properties')
        .select('name')
        .eq('id', clean.property_id)
        .single();
      if (prop?.name) propertyName = prop.name;
    }

    // ── 4. Build and send email ──────────────────────────────────────────
    const cleanerName = cleanerRecord?.name || clean.cleaner || 'there';
    const guestName   = clean.guest_name || 'the guest';
    const cleanDate   = formatDate(clean.clean_date);
    const subject     = `⏰ Reminder: Clean tomorrow — ${guestName}`;

    const html = buildEmailHtml({
      cleanerName,
      guestName,
      cleanDate,
      propertyName,
      color: '#E65100'
    });

    let emailOk = false;
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ from: resendFrom, to: cleanerEmail, subject, html })
      });
      const result = await res.json();
      emailOk = res.ok;
      if (!emailOk) console.warn(`[send-clean-reminders] Resend error for ${cleanerEmail}:`, result);
      else console.log(`[send-clean-reminders] ✓ Sent to ${cleanerEmail} for clean ${clean.id}`);
    } catch (err) {
      console.error(`[send-clean-reminders] Fetch error for ${cleanerEmail}:`, err);
    }

    // ── 5. Mark reminder_sent = true regardless of email success ────────
    // (prevents duplicate sends on retry; if email failed, manual SMS is fallback)
    if (emailOk) {
      await sb.from('cleans').update({ reminder_sent: true }).eq('id', clean.id);
      sent++;
    }
  }

  const summary = `Done. Sent: ${sent}, skipped (no email): ${skipped}`;
  console.log(`[send-clean-reminders] ${summary}`);
  return { statusCode: 200, body: summary };
  } catch (err) {
    console.error('[send-clean-reminders] Fatal error:', err);
    captureError(err, { tags: { function: 'send-clean-reminders' } });
    await flush();
    return { statusCode: 500, body: 'Internal error' };
  }
};
