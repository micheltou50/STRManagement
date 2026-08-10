/**
 * StayOps — the Money In ledger model.
 *
 * There are not two lists. There is ONE ledger of money-in, produced by a full
 * outer join between what the platform SAYS it paid (`platform_payouts`) and
 * what actually LANDED (`bank_transactions` where direction='credit'), joined on
 * `platform_payouts.bank_transaction_id`.
 *
 * Three row kinds fall out of that join:
 *   matched      — statement and deposit agree (show variance, allow unlink)
 *   payout_only  — the platform says it paid, no deposit found
 *   credit_only  — money arrived, nothing explains it
 *
 * Two invariants this file exists to protect:
 *
 * 1. ONE DEPOSIT CAN SETTLE N PAYOUTS. Airbnb batches. So the join groups by
 *    bank_transaction_id rather than assuming 1:1, and `bank_transaction_id` is
 *    deliberately NOT unique in the schema. The variance on a matched row is
 *    `sum(payout net) - credit amount`, which is what makes the Stage 4 balance
 *    arithmetic hold when a single deposit covers several statements.
 *
 * 2. AMOUNTS ARE ABSOLUTE; `direction` CARRIES THE SIGN. Every import path
 *    stores Math.abs(...). A signed row would silently corrupt the totals, so
 *    every amount is defensively re-absoluted here.
 *
 * Pure: no window/document access at module scope, so it is importable from the
 * CJS test harness in tests/frontend-pure.test.js.
 */

/** Cents, as an integer. Float accumulation over a statement is exactly what
 *  leaves an out-of-balance figure sitting at $0.0000001 forever. */
export function toCents(n) {
  return Math.round((Number(n) || 0) * 100);
}

export function centsToAmount(c) {
  return (Number(c) || 0) / 100;
}

/**
 * @param {object} args
 * @param {Array} args.payouts     platform payouts (camelCase, from _payoutRowToJs)
 * @param {Array} args.creditTxns  bank transactions already filtered to credits
 * @returns {Array} ledger rows, newest first
 */
export function buildMoneyInLedger({ payouts = [], creditTxns = [] } = {}) {
  const byBankId = new Map();
  for (const p of payouts) {
    if (!p) continue;
    if (String(p.status || 'active') === 'deleted') continue;
    const key = p.bankTransactionId ? String(p.bankTransactionId) : null;
    if (!key) continue;
    if (!byBankId.has(key)) byBankId.set(key, []);
    byBankId.get(key).push(p);
  }

  const rows = [];
  const claimed = new Set();

  // 1. Every credit becomes a row: matched if payouts point at it, else unexplained.
  for (const t of creditTxns) {
    if (!t) continue;
    const id = String(t.id);
    const linked = byBankId.get(id) || [];
    linked.forEach(p => claimed.add(String(p._cloudId)));
    const creditCents = Math.abs(toCents(t.amount));
    const payoutCents = linked.reduce((s, p) => s + Math.abs(toCents(p.net)), 0);
    rows.push({
      key: 'credit:' + id,
      kind: linked.length ? 'matched' : 'credit_only',
      date: t.date || null,
      description: t.description || '',
      txnId: id,
      amountCents: creditCents,
      payoutTotalCents: linked.length ? payoutCents : null,
      // Positive means the statements claim MORE than the bank received.
      varianceCents: linked.length ? payoutCents - creditCents : null,
      payouts: linked,
      payoutIds: linked.map(p => String(p._cloudId)),
      platform: linked.length ? (linked[0].platform || null) : null,
      reference: linked.length ? (linked[0].payoutReference || null) : null,
      isPersonal: !!t.isPersonal,
      skipped: !!t.skipped,
    });
  }

  // 2. Payouts nothing claimed — declared but never seen in the bank.
  for (const p of payouts) {
    if (!p) continue;
    if (String(p.status || 'active') === 'deleted') continue;
    const pid = String(p._cloudId);
    if (claimed.has(pid)) continue;
    // A payout carrying a bank_transaction_id we did not load (outside the
    // window) is still expected-not-seen from this view's perspective.
    rows.push({
      key: 'payout:' + pid,
      kind: 'payout_only',
      date: p.expectedArrivalDate || p.payoutDate || null,
      description: (p.platform || 'platform') + (p.payoutReference ? ' · ' + p.payoutReference : ''),
      txnId: null,
      amountCents: Math.abs(toCents(p.net)),
      payoutTotalCents: Math.abs(toCents(p.net)),
      varianceCents: null,
      payouts: [p],
      payoutIds: [pid],
      platform: p.platform || null,
      reference: p.payoutReference || null,
      isPersonal: false,
      skipped: false,
    });
  }

  rows.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return rows;
}

function _addDays(iso, n) {
  const d = new Date(String(iso) + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Work out which unsettled payouts can be linked to which unclaimed deposits.
 *
 * Payouts and deposits were only ever matchable one at a time, by hand. With 34
 * payouts against 29 deposits that is not a workflow anyone completes, so the
 * money-in view sat permanently unreconciled.
 *
 * ONLY genuine one-to-one matches are proposed. A payout is linked when it has
 * exactly one candidate deposit AND no other payout wants that same deposit.
 * Anything else is returned as ambiguous for the host to decide, because a wrong
 * link is worse than no link: it hides a genuinely missing deposit behind a
 * plausible one, and that is precisely the kind of silent error the reconcile
 * screen exists to make impossible.
 *
 * Window: a payout is issued on payoutDate and lands a few days later, so the
 * deposit is looked for from payoutDate - daysBefore to expectedArrival +
 * daysAfter. ISO date strings compare correctly as strings.
 *
 * @returns {{links:Array<{payout,credit}>, ambiguous:Array, unmatched:Array}}
 */
export function planPayoutAutoMatch({ payouts = [], creditTxns = [], daysBefore = 2, daysAfter = 7 } = {}) {
  // A deposit already settling some payout is off the table.
  const taken = new Set();
  for (const p of payouts) {
    if (p && p.bankTransactionId) taken.add(String(p.bankTransactionId));
  }

  const open = payouts.filter(p =>
    p && String(p.status || 'active') !== 'deleted' && !p.bankTransactionId);
  const free = creditTxns.filter(t =>
    t && t.id != null && !t.isPersonal && !t.skipped && !taken.has(String(t.id)));

  // Candidates for every payout first — claiming as we go would let an early
  // payout take a deposit that a later one needed uniquely.
  const candidates = new Map();
  for (const p of open) {
    const target = Math.abs(toCents(p.net));
    const from = p.payoutDate || p.expectedArrivalDate;
    const to = p.expectedArrivalDate || p.payoutDate;
    if (!from || !to || !target) { candidates.set(String(p._cloudId), []); continue; }
    const lo = _addDays(from, -daysBefore);
    const hi = _addDays(to, daysAfter);
    candidates.set(String(p._cloudId), free.filter(t =>
      t.date && lo && hi && t.date >= lo && t.date <= hi
      && Math.abs(toCents(t.amount)) === target));
  }

  // How many payouts are competing for each deposit.
  const wantedBy = new Map();
  for (const hits of candidates.values()) {
    for (const t of hits) {
      const k = String(t.id);
      wantedBy.set(k, (wantedBy.get(k) || 0) + 1);
    }
  }

  const links = [];
  const ambiguous = [];
  const unmatched = [];
  for (const p of open) {
    const hits = candidates.get(String(p._cloudId)) || [];
    if (!hits.length) { unmatched.push(p); continue; }
    if (hits.length === 1 && wantedBy.get(String(hits[0].id)) === 1) {
      links.push({ payout: p, credit: hits[0] });
    } else {
      ambiguous.push({ payout: p, candidates: hits });
    }
  }
  return { links, ambiguous, unmatched };
}

/** Headline counts for the summary tiles. Money-in specific — "matched /
 *  unaccounted / personal" never described this side of the ledger. */
export function summariseMoneyIn(rows = []) {
  const out = {
    receivedCents: 0, received: 0,
    expectedCents: 0, expected: 0,
    unexplainedCents: 0, unexplained: 0,
    varianceCents: 0,
  };
  for (const r of rows) {
    if (r.isPersonal || r.skipped) continue;
    if (r.kind === 'matched') {
      out.received += 1;
      out.receivedCents += r.amountCents;
      out.varianceCents += (r.varianceCents || 0);
    } else if (r.kind === 'payout_only') {
      out.expected += 1;
      out.expectedCents += r.amountCents;
    } else if (r.kind === 'credit_only') {
      out.unexplained += 1;
      out.unexplainedCents += r.amountCents;
    }
  }
  return out;
}
