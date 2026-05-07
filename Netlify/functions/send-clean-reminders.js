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
const { cleanReminder: buildCleanReminderHtml } = require('./utils/email-templates');

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

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00Z');
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
  const ownerEmailContentCfg = {};
  for (const oid of ownerIds) {
    const { data: cfg } = await sb.from('app_config').select('notification_config, email_content_config').eq('user_id', oid).maybeSingle();
    if (cfg && cfg.notification_config && cfg.notification_config.email_reminder === false) {
      disabledOwners.add(oid);
      console.log('[send-clean-reminders] email_reminder disabled for user', oid);
    }
    if (cfg && cfg.email_content_config) ownerEmailContentCfg[oid] = cfg.email_content_config;
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
    const ecc = ownerEmailContentCfg[clean.user_id] || {};
    const cleanerName = cleanerRecord?.name || clean.cleaner || 'there';
    const guestName   = ecc.show_guest_name !== false ? (clean.guest_name || 'the guest') : '';
    const cleanDate   = formatDate(clean.clean_date);
    const subject     = `⏰ Reminder: Clean tomorrow${guestName ? ' — ' + guestName : ''}`;

    const html = buildCleanReminderHtml({
      cleaner_name: cleanerName,
      guest_name: guestName,
      clean_date: cleanDate,
      property_name: propertyName,
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
