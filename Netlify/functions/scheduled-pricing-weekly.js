/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Smart Pricing v2: Weekly scheduled generator
   Iterates every (user_id, property_id) with pricing_rules and invokes
   generate-pricing-suggestions with trigger='scheduled_weekly'.
   Schedule configured in netlify.toml.

   Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, INTERNAL_FN_SECRET, URL
   ═══════════════════════════════════════════════════════════════════════════ */

const { createClient } = require('@supabase/supabase-js');

exports.handler = async () => {
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
  for (const t of targets) {
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
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        results.failed += 1;
        results.errors.push({ ...t, status: res.status, body: txt.slice(0, 200) });
        continue;
      }
      results.ok += 1;
    } catch (e) {
      results.failed += 1;
      results.errors.push({ ...t, error: e.message || String(e) });
    }
  }

  console.log('[StayOps] scheduled-pricing-weekly: done', JSON.stringify(results));
  return { statusCode: 200, body: JSON.stringify(results) };
};
