// ── Supabase Edge Function: poll-emails ───────────────────────────────────────
// Scheduled via pg_cron every 30 minutes.
// Finds every user with a connected Gmail account and calls the Netlify
// gmail-scan-bookings function for each — all parsing logic lives there.
//
// Deploy:
//   supabase functions deploy poll-emails
//
// Required Supabase secrets (set via Dashboard > Edge Functions > Secrets):
//   NETLIFY_URL   — your Netlify site URL, e.g. https://yourapp.netlify.app
//                   (no trailing slash)
//
// Schedule (run once in Supabase SQL editor after deploying):
//   select cron.schedule(
//     'poll-emails-every-30min',
//     '*/30 * * * *',
//     $$select net.http_post(
//       url := 'https://<your-project-ref>.supabase.co/functions/v1/poll-emails',
//       headers := '{"Authorization": "Bearer <your-anon-key>"}'::jsonb,
//       body := '{}'::jsonb
//     )$$
//   );
//
// Tables read:
//   app_config  — gmail_refresh_token, user_id (one row per user)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const NETLIFY_URL          = Deno.env.get('NETLIFY_URL') || '';

Deno.serve(async (_req) => {
  try {
    if (!NETLIFY_URL) {
      throw new Error('NETLIFY_URL secret is not set — add it in Supabase Edge Function secrets');
    }

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Debug — log env state (no secrets logged)
    console.log('[poll-emails] SUPABASE_URL set:', !!SUPABASE_URL);
    console.log('[poll-emails] SERVICE_KEY set:', !!SUPABASE_SERVICE_KEY);
    console.log('[poll-emails] NETLIFY_URL set:', !!NETLIFY_URL);

    // Find all users who have Gmail connected
    const { data: users, error } = await sb
      .from('app_config')
      .select('user_id')
      .not('gmail_refresh_token', 'is', null);

    console.log('[poll-emails] query error:', error?.message || 'none');
    console.log('[poll-emails] users found:', users?.length ?? 'null');

    if (error) throw new Error('Failed to load app_config: ' + error.message);
    if (!users || users.length === 0) {
      return respond({ ok: true, message: 'No Gmail-connected users found', scanned: 0 });
    }

    console.log(`[poll-emails] Scanning ${users.length} user(s)`);

    const results = [];

    for (const { user_id } of users) {
      try {
        const url = `${NETLIFY_URL}/.netlify/functions/gmail-scan-bookings?uid=${encodeURIComponent(user_id)}`;
        const res  = await fetch(url);
        const data = await res.json();

        console.log(`[poll-emails] user=${user_id} imported=${data.imported ?? 0} updated=${data.updated ?? 0} cancelled=${data.cancelled ?? 0}`);
        results.push({ user_id, ok: res.ok, ...pick(data, ['imported', 'updated', 'cancelled', 'skipped', 'errors', 'message']) });
      } catch (err) {
        console.error(`[poll-emails] Error scanning user ${user_id}:`, err.message);
        results.push({ user_id, ok: false, error: err.message });
      }
    }

    return respond({ ok: true, scanned: users.length, results });

  } catch (err) {
    console.error('[poll-emails] Fatal:', err.message);
    return respond({ ok: false, error: err.message }, 500);
  }
});

function respond(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}
