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
