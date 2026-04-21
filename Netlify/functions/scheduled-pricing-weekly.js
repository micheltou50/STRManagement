/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Smart Pricing v2: Weekly scheduled generator
   Iterates every (user_id, property_id) with pricing_rules and invokes
   generate-pricing-suggestions with trigger='scheduled_weekly'.
   Schedule configured in netlify.toml.

   Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, INTERNAL_FN_SECRET, URL
   ═══════════════════════════════════════════════════════════════════════════ */

const { createClient } = require('@supabase/supabase-js');
const { schedule } = require('@netlify/functions');

// Cron source of truth lives here (removed from netlify.toml). schedule() is
// a no-op at runtime (just returns the handler); its purpose is to mark this
// function as scheduled-only during deploy. Netlify's edge router then
// rejects external HTTP to this endpoint — the actual security boundary is
// platform-side, not in this file.
// 30 18 * * 1 = Monday 18:30 UTC = Tue 04:30 AEST / 05:30 AEDT, Sydney.
exports.handler = schedule('30 18 * * 1', async () => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const INTERNAL_SECRET = process.env.INTERNAL_FN_SECRET;
  const SITE_URL = process.env.URL || process.env.DEPLOY_URL;

  if (!SUPABASE_URL || !SUPABASE_KEY || !INTERNAL_SECRET || !SITE_URL) {
    console.error('[StayOps] scheduled-pricing-weekly: server misconfigured');
    return { statusCode: 500, body: 'misconfigured' };
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Find every distinct (user_id, property_id) pair that has rules configured.
  const { data: rows, error } = await sb
    .from('pricing_rules')
    .select('user_id, property_id');
  if (error) {
    console.error('[StayOps] scheduled-pricing-weekly: rules query failed', error);
    return { statusCode: 500, body: 'query failed' };
  }

  const seen = new Set();
  const targets = [];
  for (const r of rows || []) {
    const key = `${r.user_id}::${r.property_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ user_id: r.user_id, property_id: r.property_id });
  }

  console.log(`[StayOps] scheduled-pricing-weekly: ${targets.length} target(s)`);

  const results = { total: targets.length, ok: 0, failed: 0, errors: [] };

  // Bounded concurrency — fan out in small waves so we don't hammer the
  // downstream function (each call invokes Anthropic) while still finishing
  // faster than a serial loop. Each call also has a hard timeout so a single
  // slow property can't starve the scheduler within Netlify's 10-min budget.
  const CONCURRENCY = 4;
  const PER_CALL_TIMEOUT_MS = 90_000;
  const runOne = async (t) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PER_CALL_TIMEOUT_MS);
    try {
      const res = await fetch(`${SITE_URL}/.netlify/functions/generate-pricing-suggestions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': INTERNAL_SECRET,
        },
        body: JSON.stringify({
          user_id: t.user_id,
          property_id: t.property_id,
          trigger: 'scheduled_weekly',
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        results.failed += 1;
        results.errors.push({ ...t, status: res.status, body: txt.slice(0, 200) });
        return;
      }
      results.ok += 1;
    } catch (e) {
      results.failed += 1;
      const msg = e && e.name === 'AbortError' ? `timeout after ${PER_CALL_TIMEOUT_MS}ms` : (e.message || String(e));
      results.errors.push({ ...t, error: msg });
    } finally {
      clearTimeout(timer);
    }
  };

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const slice = targets.slice(i, i + CONCURRENCY);
    await Promise.all(slice.map(runOne));
  }

  console.log('[StayOps] scheduled-pricing-weekly: done', JSON.stringify(results));
  return { statusCode: 200, body: JSON.stringify(results) };
});
