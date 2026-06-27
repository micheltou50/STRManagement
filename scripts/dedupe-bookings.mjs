#!/usr/bin/env node
/**
 * StayOps — duplicate booking finder / cleanup (SAFE, dry-run by default)
 * ----------------------------------------------------------------------------
 * Finds bookings that are the SAME reservation registered more than once
 * (the within-batch dedup bug fixed in email-scan-shared.js could create these)
 * and, when run with --apply, soft-cancels the redundant copies. It NEVER
 * hard-deletes: it mirrors the email scanner's own cancellation PATCH
 * (status='cancelled', cancelled_at, cancellation_billable, updated_at).
 *
 * Matching mirrors findExistingBooking(), tuned to the real-world pair where
 * the duplicate had a first-name-only guest ("Viola") and a rounded payout
 * ($1305) vs the fuller record ("Viola Douaihy", $1305.45):
 *   1. confirmation_code — if BOTH rows have one, they match iff equal.
 *   2. otherwise property_id + checkin (+ checkout & guests when both present),
 *      with the guest name treated as compatible when one is a prefix of the
 *      other (so "Viola" matches "Viola Douaihy"). Two distinct reservations
 *      cannot occupy the same property on the same check-in date, so this is a
 *      safe duplicate signal even when names/amounts differ slightly.
 *
 * Which row is KEPT: the most complete / enriched one — has a confirmation
 * code, enrichment_status='enriched', a fuller guest name, and a precise
 * (non-rounded) payout. Earliest created_at breaks ties. Every OTHER active
 * row in the group is what gets soft-cancelled.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * USAGE
 *
 *   # 1. Provide your Supabase project credentials (service-role key — this
 *   #    script writes, so the anon key is not enough). PowerShell:
 *   $env:SUPABASE_URL         = "https://<project-ref>.supabase.co"
 *   $env:SUPABASE_SERVICE_KEY = "<service-role-key>"
 *   #    bash/zsh:
 *   export SUPABASE_URL="https://<project-ref>.supabase.co"
 *   export SUPABASE_SERVICE_KEY="<service-role-key>"
 *
 *   # 2. DRY RUN (default) — reports the duplicate groups, changes nothing:
 *   node scripts/dedupe-bookings.mjs
 *   node scripts/dedupe-bookings.mjs --uid=<user_id>   # limit to one host
 *
 *   # 3. APPLY — soft-cancel the redundant copies (after you've reviewed #2):
 *   node scripts/dedupe-bookings.mjs --apply
 *   node scripts/dedupe-bookings.mjs --apply --uid=<user_id>
 *
 *   # See the report format on built-in sample data (no DB, no network):
 *   node scripts/dedupe-bookings.mjs --demo
 *
 * Notes:
 *   - SUPABASE_SERVICE_ROLE_KEY is accepted as an alias for SUPABASE_SERVICE_KEY.
 *   - Requires Node 18+ (uses the built-in global fetch). No npm install needed.
 *   - --apply only ever PATCHes status→cancelled; rows are never deleted.
 * ──────────────────────────────────────────────────────────────────────────
 */

// ── CLI / env ────────────────────────────────────────────────────────────────
const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const valOf = (name) => {
  const hit = ARGS.find((a) => a.startsWith(name + '='));
  return hit ? hit.slice(name.length + 1) : null;
};

const APPLY = has('--apply');
const DEMO = has('--demo');
const UID = valOf('--uid');
const HELP = has('--help') || has('-h');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Columns we need to match, score, and report.
const SELECT_COLS = [
  'id', 'local_id', 'user_id', 'confirmation_code', 'guest_name',
  'checkin', 'checkout', 'nights', 'guests', 'status', 'property_id',
  'host_payout', 'source', 'enrichment_status', 'platform', 'created_at',
].join(',');

// ── Matching helpers (mirror email-scan-shared.findExistingBooking) ───────────

function normName(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

const STUB_NAMES = new Set(['', 'reserved', 'reserved — awaiting details', 'reserved - awaiting details', 'guest']);

/** First-name-only ("Viola") is compatible with the fuller name ("Viola Douaihy"). */
function namesCompatible(a, b) {
  const x = normName(a);
  const y = normName(b);
  if (STUB_NAMES.has(x) || STUB_NAMES.has(y)) return true; // a bare stub matches anything
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  // word-boundary prefix: "viola" ⊂ "viola douaihy"
  return long === short || long.startsWith(short + ' ');
}

const code = (b) => String(b.confirmation_code || '').toLowerCase().trim();

/** Would the scanner consider these two rows the same reservation? */
function sameReservation(a, b) {
  const ca = code(a);
  const cb = code(b);
  // Tier 1: both carry a confirmation code → authoritative.
  if (ca && cb) return ca === cb;

  // Tier 2: property + check-in, with checkout/guests cross-checked when known.
  if (!a.property_id || !b.property_id) return false;
  if (String(a.property_id) !== String(b.property_id)) return false;
  if (!a.checkin || !b.checkin || a.checkin !== b.checkin) return false;
  if (a.checkout && b.checkout && a.checkout !== b.checkout) return false;
  if (a.guests != null && b.guests != null && Number(a.guests) !== Number(b.guests)) return false;
  return namesCompatible(a.guest_name, b.guest_name);
}

// ── Completeness scoring (which row to KEEP) ──────────────────────────────────

function hasCents(n) {
  const v = Number(n);
  return Number.isFinite(v) && !Number.isInteger(v);
}

function completeness(b) {
  let s = 0;
  if (code(b)) s += 1000;                                   // human-facing code present
  if (String(b.enrichment_status || '') === 'enriched') s += 200;
  const name = normName(b.guest_name);
  if (!STUB_NAMES.has(name)) {
    s += name.split(' ').filter(Boolean).length * 50;       // fuller name wins
    s += Math.min(name.length, 60);
  }
  if (hasCents(b.host_payout)) s += 100;                     // precise $1305.45 > rounded $1305
  if (Number(b.host_payout) > 0) s += 10;
  if (String(b.source || '') !== 'ical') s += 20;           // email-enriched over thin stub
  return s;
}

function isActive(b) {
  return String(b.status || '').toLowerCase() !== 'cancelled';
}

/** Earliest created_at, then smallest id — stable tiebreak. */
function olderFirst(a, b) {
  const ca = String(a.created_at || '');
  const cb = String(b.created_at || '');
  if (ca && cb && ca !== cb) return ca < cb ? -1 : 1;
  return String(a.id) < String(b.id) ? -1 : 1;
}

/** Pick the keeper: highest completeness, ties broken by oldest. */
function chooseKeeper(group) {
  return [...group].sort((a, b) => {
    const d = completeness(b) - completeness(a);
    if (d !== 0) return d;
    return olderFirst(a, b);
  })[0];
}

// ── Grouping (union-find over the same-reservation relation) ──────────────────

function groupDuplicates(bookings) {
  const parent = bookings.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (i, j) => { const ri = find(i), rj = find(j); if (ri !== rj) parent[ri] = rj; };

  for (let i = 0; i < bookings.length; i++) {
    for (let j = i + 1; j < bookings.length; j++) {
      if (sameReservation(bookings[i], bookings[j])) union(i, j);
    }
  }

  const byRoot = new Map();
  for (let i = 0; i < bookings.length; i++) {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(bookings[i]);
  }
  // Only groups with 2+ ACTIVE members are actionable duplicates.
  return [...byRoot.values()].filter((g) => g.filter(isActive).length >= 2);
}

// ── Reporting ─────────────────────────────────────────────────────────────────

function money(n) {
  const v = Number(n);
  return Number.isFinite(v) ? '$' + v.toFixed(2) : '$?';
}

function describe(b) {
  return [
    'id=' + b.id,
    JSON.stringify(b.guest_name || ''),
    money(b.host_payout),
    (b.checkin || '?') + '→' + (b.checkout || '?'),
    (b.guests != null ? b.guests + 'g' : '?g'),
    'code=' + (b.confirmation_code || '∅'),
    'src=' + (b.source || '?'),
    'enr=' + (b.enrichment_status || '?'),
    'status=' + (b.status || '?'),
  ].join('  ');
}

function report(groups) {
  const toCancel = [];
  console.log('');
  console.log('════════════════════════════════════════════════════════════════');
  console.log(' DUPLICATE BOOKING REPORT' + (APPLY ? '  [APPLY — will soft-cancel]' : '  [DRY RUN — no changes]'));
  console.log('════════════════════════════════════════════════════════════════');

  if (!groups.length) {
    console.log('\n  No duplicate reservations found. Nothing to do.\n');
    return toCancel;
  }

  groups.forEach((group, gi) => {
    const active = group.filter(isActive);
    const keeper = chooseKeeper(active);
    const extras = active.filter((b) => b.id !== keeper.id);
    const alreadyCancelled = group.filter((b) => !isActive(b));

    console.log('\n  ── Group ' + (gi + 1) + ' ' + '─'.repeat(48));
    console.log('   KEEP    ✔  ' + describe(keeper) + '   (completeness=' + completeness(keeper) + ')');
    extras.forEach((b) => {
      console.log('   CANCEL  ✗  ' + describe(b) + '   (completeness=' + completeness(b) + ')');
      toCancel.push(b);
    });
    alreadyCancelled.forEach((b) => {
      console.log('   (already cancelled)  ' + describe(b));
    });
  });

  console.log('\n────────────────────────────────────────────────────────────────');
  console.log('  Groups: ' + groups.length + '   |   Rows to soft-cancel: ' + toCancel.length);
  console.log('────────────────────────────────────────────────────────────────\n');
  return toCancel;
}

// ── Supabase REST ─────────────────────────────────────────────────────────────

function sbHeaders() {
  return {
    apikey: SERVICE_KEY,
    Authorization: 'Bearer ' + SERVICE_KEY,
    'Content-Type': 'application/json',
  };
}

async function fetchAllBookings() {
  const base = SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/bookings';
  const filter = UID ? '&user_id=eq.' + encodeURIComponent(UID) : '';
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const url = base + '?select=' + SELECT_COLS + filter + '&order=created_at.asc';
    const res = await fetch(url, { headers: { ...sbHeaders(), Range: from + '-' + to, 'Range-Unit': 'items' } });
    if (!res.ok) throw new Error('Fetch bookings failed (HTTP ' + res.status + '): ' + (await res.text()).slice(0, 300));
    const page = await res.json();
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

async function softCancel(b) {
  const now = new Date().toISOString();
  const url = SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/bookings?id=eq.' + encodeURIComponent(b.id);
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...sbHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: 'cancelled',
      cancelled_at: now,
      cancellation_billable: false, // a dedup cleanup is not a guest cancellation — never bill
      updated_at: now,
    }),
  });
  if (!res.ok) throw new Error('PATCH id=' + b.id + ' failed (HTTP ' + res.status + '): ' + (await res.text()).slice(0, 300));
}

// ── Demo data (no DB) ─────────────────────────────────────────────────────────

function demoBookings() {
  return [
    // The real reported pair — same reservation, name + amount differ slightly.
    { id: 'A', user_id: 'u1', confirmation_code: 'HMAVIOLA1', guest_name: 'Viola Douaihy', checkin: '2026-07-02', checkout: '2026-07-04', nights: 2, guests: 7, status: 'confirmed', property_id: 'prop-1', host_payout: 1305.45, source: 'gmail', enrichment_status: 'enriched', platform: 'airbnb', created_at: '2026-06-08T09:00:00Z' },
    { id: 'B', user_id: 'u1', confirmation_code: '',          guest_name: 'Viola',          checkin: '2026-07-02', checkout: '2026-07-04', nights: 2, guests: 7, status: 'confirmed', property_id: 'prop-1', host_payout: 1305,    source: 'gmail', enrichment_status: 'pending',  platform: 'airbnb', created_at: '2026-06-08T09:00:05Z' },
    // A genuinely distinct booking — must NOT be grouped.
    { id: 'C', user_id: 'u1', confirmation_code: 'HMXBOBLEE', guest_name: 'Bob Lee', checkin: '2026-08-10', checkout: '2026-08-12', nights: 2, guests: 2, status: 'confirmed', property_id: 'prop-1', host_payout: 600, source: 'gmail', enrichment_status: 'enriched', platform: 'airbnb', created_at: '2026-06-09T10:00:00Z' },
    // A 3-way duplicate incl. a thin iCal stub — keep the enriched one.
    { id: 'D', user_id: 'u1', confirmation_code: 'HMZSMITH9', guest_name: 'Jane Smith', checkin: '2026-09-01', checkout: '2026-09-05', nights: 4, guests: 3, status: 'confirmed', property_id: 'prop-2', host_payout: 980.20, source: 'gmail', enrichment_status: 'enriched', platform: 'airbnb', created_at: '2026-06-07T12:00:00Z' },
    { id: 'E', user_id: 'u1', confirmation_code: '',          guest_name: 'Reserved — awaiting details', checkin: '2026-09-01', checkout: '2026-09-05', nights: 4, guests: 3, status: 'confirmed', property_id: 'prop-2', host_payout: 0, source: 'ical', enrichment_status: 'pending', platform: 'airbnb', created_at: '2026-06-06T08:00:00Z' },
    { id: 'F', user_id: 'u1', confirmation_code: '',          guest_name: 'Jane', checkin: '2026-09-01', checkout: '2026-09-05', nights: 4, guests: 3, status: 'confirmed', property_id: 'prop-2', host_payout: 980, source: 'gmail', enrichment_status: 'pending', platform: 'airbnb', created_at: '2026-06-07T12:00:09Z' },
    // An already-resolved group (one active, one cancelled) — not actionable.
    { id: 'G', user_id: 'u1', confirmation_code: 'HMQOLD', guest_name: 'Tom Old', checkin: '2026-10-01', checkout: '2026-10-03', nights: 2, guests: 1, status: 'confirmed', property_id: 'prop-1', host_payout: 400, source: 'gmail', enrichment_status: 'enriched', platform: 'airbnb', created_at: '2026-06-01T00:00:00Z' },
    { id: 'H', user_id: 'u1', confirmation_code: 'HMQOLD', guest_name: 'Tom', checkin: '2026-10-01', checkout: '2026-10-03', nights: 2, guests: 1, status: 'cancelled', property_id: 'prop-1', host_payout: 400, source: 'gmail', enrichment_status: 'pending', platform: 'airbnb', created_at: '2026-06-01T00:00:04Z' },
  ];
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (HELP) {
    console.log('See the comment block at the top of this file for usage.');
    return;
  }

  let bookings;
  if (DEMO) {
    console.log('[demo] Using built-in sample data — no database connection.');
    bookings = demoBookings();
  } else {
    if (!SUPABASE_URL || !SERVICE_KEY) {
      console.error('ERROR: set SUPABASE_URL and SUPABASE_SERVICE_KEY (service-role key) env vars.');
      console.error('       Or run with --demo to preview the report format on sample data.');
      process.exitCode = 1;
      return;
    }
    console.log('[stayops] Fetching bookings' + (UID ? ' for user ' + UID : ' (all users)') + ' …');
    bookings = await fetchAllBookings();
    console.log('[stayops] Loaded ' + bookings.length + ' bookings.');
  }

  const groups = groupDuplicates(bookings);
  const toCancel = report(groups);

  if (!APPLY) {
    if (toCancel.length) {
      console.log('  DRY RUN — nothing changed. Re-run with --apply to soft-cancel the ' +
        toCancel.length + ' row(s) marked CANCEL above.\n');
    }
    return;
  }

  if (DEMO) {
    console.log('  --apply ignored in --demo mode (no database).\n');
    return;
  }

  console.log('  Applying soft-cancellations …');
  let ok = 0;
  for (const b of toCancel) {
    try {
      await softCancel(b);
      ok++;
      console.log('   ✓ cancelled id=' + b.id + ' (' + (b.guest_name || '') + ')');
    } catch (e) {
      console.error('   ✗ FAILED id=' + b.id + ': ' + e.message);
    }
  }
  console.log('\n  Done. Soft-cancelled ' + ok + '/' + toCancel.length + ' row(s). No rows were deleted.\n');
}

main().catch((e) => {
  console.error('Fatal: ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
});
