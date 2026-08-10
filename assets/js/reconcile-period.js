/**
 * StayOps — period reconcile arithmetic (the MYOB "Reconcile accounts" close).
 *
 *   calculated closing = opening + Σcredits − Σdebits   (over CLEARED rows)
 *   out of balance     = statement closing − calculated closing
 *
 * You are not finished until out-of-balance is $0.00. That figure is the only
 * thing in the app that can prove nothing is missing or double-counted — which
 * is exactly the gap that let an expense be subtracted twice from owner payout
 * without anything noticing.
 *
 * Everything is integer CENTS. Accumulating floats over ~90 rows is what leaves
 * an out-of-balance figure stuck at $0.0000001 and never reaching zero, which
 * would make the whole feature useless.
 *
 * `direction` carries the sign; amounts are stored absolute by every import
 * path. Null direction is treated as 'debit' to match the column default.
 *
 * Pure: no window/document at module scope, so tests/frontend-pure.test.js can
 * import it.
 */

import { toCents, centsToAmount } from './money-in-model.js';

export { toCents, centsToAmount };

/**
 * @param {object} args
 * @param {number} args.openingBalanceCents
 * @param {number} args.statementClosingCents
 * @param {Array}  args.transactions  [{ id, amount, direction, cleared }]
 * @returns {{creditsCents,debitsCents,calculatedClosingCents,outOfBalanceCents,balanced,clearedCount,unclearedCount}}
 */
export function computePeriodReconcile({
  openingBalanceCents = 0,
  statementClosingCents = 0,
  transactions = [],
} = {}) {
  let creditsCents = 0;
  let debitsCents = 0;
  let clearedCount = 0;
  let unclearedCount = 0;

  for (const t of transactions) {
    if (!t) continue;
    if (!t.cleared) { unclearedCount += 1; continue; }
    clearedCount += 1;
    // Defensive abs: a single signed row would silently flip a total.
    const cents = Math.abs(toCents(t.amount));
    if (String(t.direction || 'debit') === 'credit') creditsCents += cents;
    else debitsCents += cents;
  }

  const calculatedClosingCents = openingBalanceCents + creditsCents - debitsCents;
  const outOfBalanceCents = statementClosingCents - calculatedClosingCents;

  return {
    creditsCents,
    debitsCents,
    calculatedClosingCents,
    outOfBalanceCents,
    balanced: outOfBalanceCents === 0,
    clearedCount,
    unclearedCount,
  };
}

/** Opening balance for a new period: the previous period's statement closing,
 *  else the account's own opening balance. Chaining is what stops a period
 *  being reconciled in isolation against a number nobody checked. */
export function deriveOpeningBalanceCents(priorReconcile, account) {
  if (priorReconcile && priorReconcile.statement_closing_balance != null) {
    return toCents(priorReconcile.statement_closing_balance);
  }
  if (account && account.opening_balance != null) return toCents(account.opening_balance);
  if (account && account.openingBalance != null) return toCents(account.openingBalance);
  return 0;
}

/**
 * Turn a non-zero out-of-balance into something actionable. A bare number is a
 * dead end; these are the standard causes, cheapest first.
 * @returns {Array<{kind:string, message:string, txnIds?:string[]}>}
 */
export function explainOutOfBalance(outOfBalanceCents, transactions = [], payouts = []) {
  const hints = [];
  if (!outOfBalanceCents) return hints;
  const target = Math.abs(outOfBalanceCents);
  const money = c => '$' + (c / 100).toFixed(2);

  // Leads, because when it fires it is almost always the whole answer, and no
  // amount-matching hint below can see it. A stretch of the period with money
  // going out and none coming in means the deposits for that stretch were never
  // imported: early imports captured debits only, so a re-imported account can
  // hold months of expenses with zero income against them. That gap is
  // arithmetically unreconcilable no matter what the host ticks.
  const dated = transactions
    .filter(t => t && t.date)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (dated.length) {
    const isCredit = t => String(t.direction || 'debit') === 'credit';
    const firstIn = dated.find(isCredit);
    const from = String(dated[0].date);
    const until = String(firstIn ? firstIn.date : dated[dated.length - 1].date);
    const days = Math.round((new Date(until) - new Date(from)) / 86400000);
    const outCount = dated.filter(t => String(t.date) < until && !isCredit(t)).length;
    // 45 days: long enough that a real account with no income is implausible,
    // short enough to still catch a single missed statement.
    if (days >= 45 && outCount > 0) {
      hints.push({
        kind: 'missing-deposits',
        message: firstIn
          ? `No money in at all between ${from} and ${until} — ${outCount} payments went out over those ${days} days and nothing came in. Those deposits were almost certainly never imported. Re-import the bank statement covering that stretch, then reconcile again.`
          : `No money in anywhere in this period — ${outCount} payments went out and nothing came in. The deposits were never imported. Re-import the bank statement for this period, then reconcile again.`,
      });
    }
  }

  // Exactly one transaction's amount → that row is missing, or counted twice.
  const exact = transactions.filter(t => t && Math.abs(toCents(t.amount)) === target);
  for (const t of exact.slice(0, 3)) {
    hints.push({
      kind: 'single-transaction',
      message: `Off by exactly ${money(target)} — the same as "${t.description || 'a transaction'}" on ${t.date || '?'}. It may be missing from the statement, or ticked when it should not be.`,
      txnIds: [String(t.id)],
    });
  }

  // Exactly double a transaction → that row is duplicated.
  const dbl = transactions.filter(t => t && Math.abs(toCents(t.amount)) * 2 === target);
  for (const t of dbl.slice(0, 2)) {
    hints.push({
      kind: 'duplicate',
      message: `Off by exactly twice "${t.description || 'a transaction'}" (${money(Math.abs(toCents(t.amount)))}) — that line is probably imported twice.`,
      txnIds: [String(t.id)],
    });
  }

  // Matches an expected-but-not-received payout → a deposit was never imported.
  const p = payouts.find(x => x && Math.abs(toCents(x.net)) === target);
  if (p) {
    hints.push({
      kind: 'missing-deposit',
      message: `Off by exactly ${money(target)} — the same as the ${p.platform || 'platform'} payout dated ${p.payoutDate || '?'} that has no matching deposit. That statement may not be imported yet.`,
    });
  }

  // Whole import batch missing or doubled.
  const batches = new Map();
  for (const t of transactions) {
    if (!t || !t.importBatchId) continue;
    const k = String(t.importBatchId);
    const signed = String(t.direction || 'debit') === 'credit'
      ? Math.abs(toCents(t.amount)) : -Math.abs(toCents(t.amount));
    batches.set(k, (batches.get(k) || 0) + signed);
  }
  for (const [k, sum] of batches) {
    if (Math.abs(sum) === target) {
      hints.push({
        kind: 'import-batch',
        message: `Off by exactly the net of one whole import (${money(target)}) — that file may have been imported twice, or not at all.`,
        batchId: k,
      });
      break;
    }
  }

  if (!hints.length) {
    hints.push({
      kind: 'generic',
      message: `Off by ${money(target)}. Check for a transaction on the statement that is not in StayOps, an amount typed differently, or a line imported twice.`,
    });
  }
  return hints;
}
