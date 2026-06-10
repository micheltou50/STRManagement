#!/usr/bin/env node
/**
 * StayOps — duplicate-booking cleanup (dry-run by default).
 *
 * Finds reservations that were registered more than once in the `bookings`
 * table (the duplicate-registration bug: two emails about one reservation
 * arriving in the same scan batch, an iCal stub plus its email enrichment,
 * etc.) and SOFT-CANCELS the redundant rows, keeping the most-enriched one.
 *
 * It NEVER hard-deletes. Redundant rows are PATCHed to status='cancelled'
 * with cancelled_at / cancellation_billable=false / updated_at — the same
 * soft-delete path the app uses, so the rows stay queryable.
 *
 * ── Matching ─────────────────────────────────────────────────────────────
 * Two rows for the same property are the same reservation when:
 *   1. both carry a non-empty confirmation_code and the codes match
 *      (case-insensitive); OR
 *   2. they share checkin (and checkout/guests agree where both are present)
 *      AND their guest names are compatible — equal, one a prefix of the
 *      other ("Viola" ⊂ "Viola Douaihy"), or one is an unenriched placeholder
 *      ("Reserved", "Reserved — awaiting details", "Guest", blank).
 *
 * ── Keeper selection ─────────────────────────────────────────────────────
 * The most-enriched row wins: enrichment_status='enriched' > has a precise
 * (fractional) amount > fuller guest name > has a confirmation_code > larger
 * payout. All others in the group are soft-cancelled.
 *
 * ── Usage ────────────────────────────────────────────────────────────────
 *   Required env (service-role key — bypasses RLS, server-side only):
 *     SUPABASE_URL=https://xxxx.supabase.co
 *     SUPABASE_SERVICE_KEY=eyJhbGciOi...   (service_role secret)
 *   Optional env:
 *     SUPABASE_USER_ID=<uuid>   limit to one host (omit = all users)
 *
 *   Dry run (default — prints the report, changes NOTHING):
 *     SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/cleanup-duplicate-bookings.mjs
 *
 *   Apply (actually soft-cancels the duplicates):
 *     SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/cleanup-duplicate-bookings.mjs --apply
 *
 *   PowerShell:
 *     $env:SUPABASE_URL="https://xxxx.supabase.co"
 *     $env:SUPABASE_SERVICE_KEY="eyJ..."
 *     node scripts/cleanup-duplicate-bookings.mjs            # dry run
 *     node scripts/cleanup-duplicate-bookings.mjs --apply    # apply
 */

import { pathToFileURL } from 'node:url';

const RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m';

const SELECT = [
  'id', 'local_id', 'confirmation_code', 'guest_name', 'checkin', 'checkout',
  'guests', 'status', 'property_id', 'host_payout', 'cleaning_fee', 'platform',
  'source', 'enrichment_status', 'ical_uid',
].join(',');

// ── Helpers (pure — importable for testing) ───────────────────────────────

const PLACEHOLDER_NAMES = new Set(['', 'guest', 'reserved', 'reserved — awaiting details', 'reserved - awaiting details']);

function norm(s) { return String(s == null ? '' : s).toLowerCase().trim(); }

function isPlaceholderName(name) { return PLACEHOLDER_NAMES.has(norm(name)); }

/** "Viola" is compatible with "Viola Douaihy": equal, prefix-on-word-boundary, or a placeholder. */
function namesCompatible(a, b) {
  const na = norm(a), nb = norm(b);
  if (na === nb) return true;
  if (isPlaceholderName(a) || isPlaceholderName(b)) return true;
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  // Prefix match on a word boundary so "Vi" doesn't match "Viola", but
  // "Viola" matches "Viola Douaihy".
  return longer === shorter || longer.startsWith(shorter + ' ');
}

/** Same reservation? Tier 1 confirmation_code, else Tier 2 property+date(+guests)+name. */
function sameReservation(a, b) {
  if (String(a.property_id) !== String(b.property_id)) return false;

  const ca = norm(a.confirmation_code), cb = norm(b.confirmation_code);
  if (ca && cb) return ca === cb; // both coded: codes are authoritative

  // Otherwise fall back to property + checkin, with checkout/guests agreeing
  // where both are present, plus name compatibility.
  if (!a.checkin || !b.checkin || a.checkin !== b.checkin) return false;
  if (a.checkout && b.checkout && a.checkout !== b.checkout) return false;
  if (a.guests != null && b.guests != null && Number(a.guests) !== Number(b.guests)) return false;
  return namesCompatible(a.guest_name, b.guest_name);
}

function nameTokens(name) {
  return norm(name).split(/\s+/).filter(t => t && !PLACEHOLDER_NAMES.has(t)).length;
}

function hasPreciseAmount(b) {
  const v = Number(b.host_payout);
  return Number.isFinite(v) && Math.abs(v % 1) > 1e-9; // has cents
}

/** Higher = keep. Most-enriched record wins. */
function enrichmentScore(b) {
  let s = 0;
  if (norm(b.enrichment_status) === 'enriched') s += 1000;
  if (hasPreciseAmount(b)) s += 200;
  s += nameTokens(b.guest_name) * 50;                 // fuller name
  if (norm(b.confirmation_code)) s += 100;
  s += norm(b.guest_name).length;                     // tiebreak: longer name
  s += Math.min(Number(b.host_payout) || 0, 100000) / 100000; // tiebreak: larger payout
  return s;
}

/** Union-find grouping of duplicates within a user's bookings. */
function groupDuplicates(rows) {
  const parent = rows.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (i, j) => { const ri = find(i), rj = find(j); if (ri !== rj) parent[ri] = rj; };

  // Bucket by property_id first to keep the pairwise scan cheap.
  const byProp = new Map();
  rows.forEach((r, i) => {
    const k = String(r.property_id);
    if (!byProp.has(k)) byProp.set(k, []);
    byProp.get(k).push(i);
  });

  for (const idxs of byProp.values()) {
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        if (sameReservation(rows[idxs[a]], rows[idxs[b]])) union(idxs[a], idxs[b]);
      }
    }
  }

  const groups = new Map();
  rows.forEach((_, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(rows[i]);
  });

  return [...groups.values()].filter(g => g.length > 1);
}

// ── Supabase REST ─────────────────────────────────────────────────────────

async function fetchAllBookings(env) {
  const out = [];
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const userClause = env.USER_ID ? '&user_id=eq.' + encodeURIComponent(env.USER_ID) : '';
    const url = env.SUPABASE_URL + '/rest/v1/bookings?status=neq.cancelled' + userClause +
      '&select=' + SELECT + '&order=property_id.asc,checkin.asc';
    const res = await fetch(url, {
      headers: { ...env.sbHeaders, Range: from + '-' + (from + pageSize - 1), Prefer: 'count=exact' },
    });
    if (!res.ok && res.status !== 206) {
      fail('bookings fetch failed (HTTP ' + res.status + '): ' + (await res.text()).slice(0, 200));
    }
    const batch = await res.json();
    out.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

async function softCancel(env, row) {
  const now = new Date().toISOString();
  const res = await fetch(env.SUPABASE_URL + '/rest/v1/bookings?id=eq.' + encodeURIComponent(row.id), {
    method: 'PATCH',
    headers: { ...env.sbHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: 'cancelled',
      cancelled_at: now,
      cancellation_billable: false, // a dedup is not a real cancellation — never bill
      updated_at: now,
    }),
  });
  if (!res.ok && res.status !== 204) {
    throw new Error('PATCH failed for ' + row.id + ' (HTTP ' + res.status + '): ' + (await res.text()).slice(0, 200));
  }
}

function fail(msg) {
  console.error(RED + 'ERROR: ' + RESET + msg);
  process.exit(1);
}

// ── Reporting ──────────────────────────────────────────────────────────────

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 'n/a';
  return '$' + (Math.abs(n % 1) < 1e-9 ? String(n) : n.toFixed(2));
}

function describe(b) {
  return [
    'id=' + b.id,
    '"' + (b.guest_name || '') + '"',
    (b.checkin || '?') + '→' + (b.checkout || '?'),
    (b.guests != null ? b.guests + 'g' : '?g'),
    money(b.host_payout),
    b.platform || '?',
    'code=' + (b.confirmation_code || '∅'),
    'enrich=' + (b.enrichment_status || '∅'),
    'src=' + (b.source || '?'),
  ].join('  ');
}

function printGroup(n, group) {
  const ranked = [...group].sort((a, b) => enrichmentScore(b) - enrichmentScore(a));
  const keeper = ranked[0];
  const cancel = ranked.slice(1);

  console.log(BOLD + '\nDuplicate group #' + n + RESET + DIM + '  (property ' + keeper.property_id + ', ' + group.length + ' rows)' + RESET);
  console.log('  ' + GREEN + 'KEEP   ' + RESET + describe(keeper) + DIM + '  [score ' + enrichmentScore(keeper).toFixed(1) + ']' + RESET);
  for (const c of cancel) {
    console.log('  ' + YELLOW + 'CANCEL ' + RESET + describe(c) + DIM + '  [score ' + enrichmentScore(c).toFixed(1) + ']' + RESET);
  }
  return { keeper, cancel };
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const APPLY = process.argv.includes('--apply');
  const env = {
    SUPABASE_URL: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY || '',
    USER_ID: process.env.SUPABASE_USER_ID || '',
  };
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    fail('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set. See the usage block at the top of this file.');
  }
  env.sbHeaders = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: 'Bearer ' + env.SUPABASE_SERVICE_KEY,
    'Content-Type': 'application/json',
  };

  console.log(BOLD + 'StayOps duplicate-booking cleanup' + RESET +
    '  —  mode: ' + (APPLY ? RED + 'APPLY (will soft-cancel)' + RESET : GREEN + 'DRY RUN (no changes)' + RESET));
  console.log(DIM + 'Supabase: ' + env.SUPABASE_URL + (env.USER_ID ? '  user=' + env.USER_ID : '  (all users)') + RESET);

  const rows = await fetchAllBookings(env);
  console.log(DIM + 'Loaded ' + rows.length + ' active bookings.' + RESET);

  const groups = groupDuplicates(rows);

  if (!groups.length) {
    console.log(GREEN + '\nNo duplicate reservations found. Nothing to do.' + RESET);
    process.exit(0);
  }

  let toCancel = 0;
  const plan = [];
  groups.forEach((g, i) => {
    const { keeper, cancel } = printGroup(i + 1, g);
    toCancel += cancel.length;
    plan.push({ keeper, cancel });
  });

  console.log(BOLD + '\nSummary: ' + RESET + groups.length + ' duplicate group(s), ' +
    toCancel + ' row(s) would be soft-cancelled, ' + groups.length + ' kept.');

  if (!APPLY) {
    console.log(YELLOW + '\nDry run — no changes written. Re-run with --apply to soft-cancel the rows above.' + RESET);
    process.exit(0);
  }

  console.log(RED + '\nApplying soft-cancellations...' + RESET);
  let done = 0, errors = 0;
  for (const { cancel } of plan) {
    for (const row of cancel) {
      try {
        await softCancel(env, row);
        done++;
        console.log('  ' + GREEN + '✓' + RESET + ' cancelled id=' + row.id);
      } catch (e) {
        errors++;
        console.log('  ' + RED + '✗' + RESET + ' id=' + row.id + ' — ' + (e.message || e));
      }
    }
  }
  console.log(BOLD + '\nDone. ' + RESET + done + ' soft-cancelled' + (errors ? ', ' + RED + errors + ' error(s)' + RESET : '') + '.');
  process.exit(errors ? 1 : 0);
}

// Pure helpers are exported for tests; main() runs only on direct execution.
export { namesCompatible, sameReservation, enrichmentScore, groupDuplicates, printGroup, describe };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
