/**
 * StayOps — smart pricing: pricing rules CRUD + pricing suggestions/runs + the
 * debounced rerun scheduler (schedulePricingRerun, imported one-way by the
 * barrel's booking writes). Split out of supabase.js 2026-07-09 (by-entity
 * data-layer split). supabase.js re-exports all pricing fns and imports
 * schedulePricingRerun back. window._sb is global; getCurrentSupabaseUser + apiUrl
 * imported from the barrel at call-time (safe cycle).
 */
import { getCurrentSupabaseUser, apiUrl } from './supabase.js';

// ── PRICING RULES (Smart Pricing) ─────────────────────────────────────────────
export async function fetchPricingRulesForProperty(propertyIdUuid) {
  if (!window._sb || !propertyIdUuid) return [];
  const user = await getCurrentSupabaseUser();
  if (!user) return [];
  const { data, error } = await window._sb
    .from('pricing_rules')
    .select('*')
    .eq('user_id', user.id)
    .eq('property_id', propertyIdUuid)
    .order('rule_type', { ascending: true })
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: true });
  if (error) {
    console.warn('[StayOps] fetchPricingRulesForProperty', error.message || error);
    return [];
  }
  return Array.isArray(data) ? data : [];
}

export async function insertPricingRules(rows) {
  if (!window._sb || !rows.length) return { error: 'no client' };
  const user = await getCurrentSupabaseUser();
  if (!user) return { error: 'not signed in' };
  const payload = rows.map((r) => ({
    ...r,
    user_id: user.id,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await window._sb.from('pricing_rules').insert(payload);
  if (error) console.warn('[StayOps] insertPricingRules', error.message || error);
  return { error: error ? error.message : null };
}

export async function updatePricingRule(id, patch) {
  if (!window._sb || !id) return { error: 'no client' };
  const user = await getCurrentSupabaseUser();
  if (!user) return { error: 'not signed in' };
  const { error } = await window._sb
    .from('pricing_rules')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id);
  if (error) console.warn('[StayOps] updatePricingRule', error.message || error);
  return { error: error ? error.message : null };
}

export async function deletePricingRuleRow(id) {
  if (!window._sb || !id) return { error: 'no client' };
  const user = await getCurrentSupabaseUser();
  if (!user) return { error: 'not signed in' };
  const { error } = await window._sb
    .from('pricing_rules')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id);
  if (error) console.warn('[StayOps] deletePricingRuleRow', error.message || error);
  return { error: error ? error.message : null };
}

export async function ensureDefaultPricingRules(propertyIdUuid, seed) {
  if (!window._sb || !propertyIdUuid) return;
  const user = await getCurrentSupabaseUser();
  if (!user) return;
  const existing = await fetchPricingRulesForProperty(propertyIdUuid);
  if (existing.length) return;
  const bn = Number(seed?.baseNightly) || 280;
  const bw = Number(seed?.baseWeekend) || Math.round(bn * 1.15);
  const mn = Number(seed?.minNights) || 2;
  const wPct = Number(seed?.weeklyPct) || 10;
  const mPct = Number(seed?.monthlyPct) || 15;
  const lmPct = Number(seed?.lastMinutePct) || 12;
  const lmDays = Number(seed?.lastMinuteDays) || 3;
  await insertPricingRules([
    { property_id: propertyIdUuid, rule_type: 'base_nightly', value: bn, is_default: true },
    { property_id: propertyIdUuid, rule_type: 'base_weekend', value: bw, is_default: true },
    { property_id: propertyIdUuid, rule_type: 'min_nights', value: mn, is_default: true },
    {
      property_id: propertyIdUuid,
      rule_type: 'discount',
      name: 'Weekly discount',
      value: wPct,
      condition_type: 'stay_length',
      condition_value: 7,
      is_default: true,
    },
    {
      property_id: propertyIdUuid,
      rule_type: 'discount',
      name: 'Monthly discount',
      value: mPct,
      condition_type: 'stay_length',
      condition_value: 28,
      is_default: true,
    },
    {
      property_id: propertyIdUuid,
      rule_type: 'discount',
      name: 'Last-minute',
      value: lmPct,
      condition_type: 'last_minute',
      condition_value: lmDays,
      is_default: true,
    },
  ]);
}

// ── PRICING SUGGESTIONS (Smart Pricing v2) ────────────────────────────────────

export async function fetchLatestPricingRun(propertyIdUuid) {
  if (!window._sb || !propertyIdUuid) return null;
  const user = await getCurrentSupabaseUser();
  if (!user) return null;
  const { data, error } = await window._sb
    .from('pricing_runs')
    .select('*')
    .eq('user_id', user.id)
    .eq('property_id', propertyIdUuid)
    .is('error', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn('[StayOps] fetchLatestPricingRun', error.message || error);
    return null;
  }
  return data || null;
}

export async function fetchPricingSuggestionsForRun(runId) {
  if (!window._sb || !runId) return [];
  const user = await getCurrentSupabaseUser();
  if (!user) return [];
  const { data, error } = await window._sb
    .from('pricing_suggestions')
    .select('*')
    .eq('user_id', user.id)
    .eq('run_id', runId)
    .order('date', { ascending: true });
  if (error) {
    console.warn('[StayOps] fetchPricingSuggestionsForRun', error.message || error);
    return [];
  }
  return Array.isArray(data) ? data : [];
}

// Debounce map per-property so batch booking imports don't spam the AI endpoint.
const _pricingRerunTimers = Object.create(null);
const PRICING_RERUN_DEBOUNCE_MS = 60000;

export function schedulePricingRerun(propertyId, trigger = 'booking_changed') {
  if (!propertyId) return;
  const key = String(propertyId);
  if (_pricingRerunTimers[key]) clearTimeout(_pricingRerunTimers[key]);
  _pricingRerunTimers[key] = setTimeout(() => {
    delete _pricingRerunTimers[key];
    // Fire and forget — don't block callers, never throw.
    // Omit forecastDays so the server inherits the span from the user's most
    // recent manual run (keeps long-range views from shrinking to 60d).
    requestPricingGeneration({ propertyId, trigger })
      .then((r) => {
        if (!r.ok) console.warn('[StayOps] pricing rerun failed:', r.error);
        else console.log('[StayOps] pricing rerun complete', r.run_id);
      })
      .catch((e) => console.warn('[StayOps] pricing rerun threw', e.message || e));
  }, PRICING_RERUN_DEBOUNCE_MS);
}

// Cancel any pending booking-change debounce — call this when a manual
// generation is initiated so we don't follow up with a redundant rerun.
export function cancelPricingRerun(propertyId) {
  if (!propertyId) return;
  const key = String(propertyId);
  if (_pricingRerunTimers[key]) {
    clearTimeout(_pricingRerunTimers[key]);
    delete _pricingRerunTimers[key];
  }
}

export async function requestPricingGeneration({
  propertyId,
  trigger = 'manual',
  forecastDays = null,
  forecastStart = null,
  forecastEnd = null,
} = {}) {
  if (!window._sb || !propertyId) return { ok: false, error: 'missing inputs' };
  const { data: { session } = {} } = await window._sb.auth.getSession();
  const token = session?.access_token;
  if (!token) return { ok: false, error: 'not signed in' };
  try {
    const payload = { property_id: propertyId, trigger };
    if (forecastStart) payload.forecast_start = forecastStart;
    if (forecastEnd) payload.forecast_end = forecastEnd;
    // Only send forecast_days when explicitly provided; otherwise let the
    // server inherit the span from the last manual run (or fall back to 60d).
    if (!forecastStart && !forecastEnd && Number.isFinite(Number(forecastDays))) {
      payload.forecast_days = Number(forecastDays);
    }
    const res = await fetch(apiUrl('/.netlify/functions/generate-pricing-suggestions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: true, ...data };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}


