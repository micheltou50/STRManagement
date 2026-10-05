/**
 * StayOps — bank line ↔ expense / payout links (the writes the Bank screen
 * shares with payout matching). Deciding what a line is lives in
 * bank-explain.js; the list and sheet in finance-bank.js.
 * Uses window._sb (Supabase client).
 */

function getSb() {
  return typeof window !== 'undefined' ? window._sb || null : null;
}

/**
 * @param {string} transactionId
 * @param {string} expenseId
 */
export async function linkTransactionToExpense(transactionId, expenseId) {
  const sb = getSb();
  if (!sb || !transactionId || !expenseId) {
    console.log('[StayOps] linkTransactionToExpense: missing id(s)');
    return { success: false };
  }

  const { error: e1 } = await sb.from('bank_transactions').update({ expense_id: expenseId }).eq('id', transactionId);

  if (e1) {
    console.log('[StayOps] linkTransactionToExpense bank update error:', e1.message || e1);
    return { success: false };
  }

  const { error: e2 } = await sb
    .from('expenses')
    .update({
      bank_transaction_id: transactionId,
      reconciled: true,
      payment_status: 'paid',
    })
    .eq('id', expenseId);

  if (e2) {
    console.log('[StayOps] linkTransactionToExpense expense update error:', e2.message || e2);
    return { success: false };
  }

  console.log(`[StayOps] Reconciled: expense ${expenseId} ↔ transaction ${transactionId}`);
  return { success: true };
}

// ── PHASE 2c: PAYOUT MATCHING ────────────────────────────────────────────────
// Bank CREDITS (money in) match to platform_payouts (Phase 1 model), not to
// expenses. The functions below mirror the expense matchers but target the
// payouts table. The existing one-way FK platform_payouts.bank_transaction_id
// is the source of truth; setting it = a bank_transactions.id marks both
// "reconciled".

/**
 * Find platform_payouts (active, not yet bank-matched) that plausibly
 * correspond to a given bank CREDIT. Scoring favours exact amount + nearby
 * date, with a small bonus when the bank description name-drops the platform.
 * @param {{ id?: string, date: string, amount: number, description?: string }} bankTxn
 * @param {string} userId
 * @returns {Promise<Array<{ payout: object, score: number, matchReason: string }>>}
 */
/**
 * The settlement state of a platform payout — THREE states, deliberately not two.
 *
 * Two independent markers exist and they mean different things:
 *   - `bank_transaction_id` is EVIDENCE: a real deposit was matched to it.
 *   - `received_at` is an ATTESTATION: the host ticked "Mark received" in the
 *     booking detail. It says someone believes it arrived; it proves nothing.
 *
 * Collapsing them with `receivedAt || bankTransactionId` (as the booking panel
 * did) is what made the payout list and the Transaction Map disagree — a payout
 * ticked in Bookings still showed as an unmatched deposit here. It also cannot
 * be used for balance arithmetic: only bank evidence belongs in a bank total.
 *
 * @returns {'settled'|'attested'|'outstanding'}
 */
export function payoutSettlementState(payout) {
  if (!payout) return 'outstanding';
  const bankId = payout.bank_transaction_id ?? payout.bankTransactionId ?? null;
  if (bankId) return 'settled';
  const received = payout.received_at ?? payout.receivedAt ?? null;
  if (received) return 'attested';
  return 'outstanding';
}

export async function findPayoutMatchesForBankTransaction(bankTxn, userId, opts = {}) {
  const sb = getSb();
  if (!sb || !userId || !bankTxn || !bankTxn.date || bankTxn.amount == null) return [];

  // opts.includeLinked: also return payouts already linked to a bank tx, so the
  // match modal can show them as "Linked" instead of hiding them. Default false
  // keeps auto-reconcile (which only ever links unlinked payouts) unchanged.
  const includeLinked = !!opts.includeLinked;

  // ±5 day window — platform-to-bank arrival can lag a few business days
  const tDate = new Date(bankTxn.date);
  const from = new Date(tDate); from.setDate(from.getDate() - 5);
  const to   = new Date(tDate); to.setDate(to.getDate() + 5);
  const fromStr = from.toISOString().split('T')[0];
  const toStr   = to.toISOString().split('T')[0];

  // Window on BOTH date columns. The score below measures distance from
  // `expected_arrival_date || payout_date`, so filtering on payout_date alone
  // silently dropped exactly the payouts that score best: one whose expected
  // arrival lands on the deposit but whose payout_date is more than 5 days
  // earlier was never even fetched.
  let query = sb
    .from('platform_payouts')
    .select('id, platform, payout_reference, payout_date, expected_arrival_date, net_amount, currency, status, bank_transaction_id, received_at')
    .eq('user_id', userId)
    .neq('status', 'deleted')
    .or(`and(payout_date.gte.${fromStr},payout_date.lte.${toStr}),`
      + `and(expected_arrival_date.gte.${fromStr},expected_arrival_date.lte.${toStr})`);
  if (!includeLinked) query = query.is('bank_transaction_id', null);
  const { data, error } = await query;
  if (error) {
    console.log('[StayOps] findPayoutMatchesForBankTransaction error:', error.message || error);
    return [];
  }

  const txnAmount = Number(bankTxn.amount) || 0;
  const desc = String(bankTxn.description || '').toLowerCase();
  const out = [];
  for (const p of (data || [])) {
    const net = Number(p.net_amount) || 0;
    const diff = Math.abs(net - txnAmount);
    if (diff > 1 && diff > txnAmount * 0.01) continue; // require ≤$1 or 1% match

    // Date distance: prefer expected_arrival_date if set, otherwise payout_date
    const refDate = new Date(p.expected_arrival_date || p.payout_date);
    const dayDiff = Math.abs((tDate - refDate) / 86400000);

    let score = 50;
    if (diff < 0.01) score += 30; else if (diff < 0.50) score += 20;
    if (dayDiff <= 1) score += 15;
    else if (dayDiff <= 3) score += 10;
    else if (dayDiff <= 5) score += 5;

    // Bonus if the bank description mentions the platform name
    if (p.platform && desc.includes(p.platform.replace('_', ''))) score += 10;
    // Bonus if it mentions known platform aliases
    if (desc.includes('airbnb') && p.platform === 'airbnb') score += 5;
    if (desc.includes('booking.com') && p.platform === 'booking_com') score += 5;
    if (desc.includes('vrbo') && p.platform === 'vrbo') score += 5;
    if (desc.includes('stayz') && p.platform === 'stayz') score += 5;

    const reason = `${diff < 0.01 ? 'exact $' : 'approx $'}${dayDiff <= 1 ? ' / ±1d' : ' / ±' + Math.round(dayDiff) + 'd'}`;
    out.push({
      payout: p,
      score: Math.min(100, score),
      matchReason: reason,
      // Lets the match sheet distinguish "already bank-matched" from "the host
      // says this arrived but nothing proves it" — the latter is still worth
      // linking, and is the one the old two-state boolean hid.
      settlementState: payoutSettlementState(p),
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * Set platform_payouts.bank_transaction_id = bankTxId — marks the payout
 * reconciled to a real bank deposit. Does NOT touch the bank_transactions
 * row (the reverse FK isn't on bank_transactions in the current schema; the
 * relationship is denormalized through the platform_payouts side only).
 * @param {string} bankTxId
 * @param {string} payoutId
 */
export async function linkTransactionToPayout(bankTxId, payoutId, opts = {}) {
  const sb = getSb();
  if (!sb || !bankTxId || !payoutId) {
    console.log('[StayOps] linkTransactionToPayout: missing id(s)');
    return { success: false };
  }
  const { error } = await sb
    .from('platform_payouts')
    .update({ bank_transaction_id: bankTxId, updated_at: new Date().toISOString() })
    .eq('id', payoutId);
  if (error) {
    console.log('[StayOps] linkTransactionToPayout error:', error.message || error);
    return { success: false };
  }
  // Bank evidence implies it arrived, so fill the attestation date too — but
  // only when empty, so a host's own earlier claim is never overwritten. The
  // `.is(null)` guard is the whole point: a plain update would clobber it.
  // Separate statement because PostgREST cannot express coalesce() in an update.
  if (opts.bankDate) {
    const { error: rErr } = await sb
      .from('platform_payouts')
      .update({ received_at: opts.bankDate })
      .eq('id', payoutId)
      .is('received_at', null);
    if (rErr) console.log('[StayOps] linkTransactionToPayout received_at fill:', rErr.message || rErr);
  }
  console.log(`[StayOps] Reconciled: payout ${payoutId} ↔ bank tx ${bankTxId}`);
  return { success: true };
}

/** Reverse a payout↔bank link. */
export async function unlinkPayoutFromTransaction(payoutId) {
  const sb = getSb();
  if (!sb || !payoutId) return { success: false };
  const { error } = await sb
    .from('platform_payouts')
    .update({ bank_transaction_id: null, updated_at: new Date().toISOString() })
    .eq('id', payoutId);
  if (error) {
    console.log('[StayOps] unlinkPayoutFromTransaction error:', error.message || error);
    return { success: false };
  }
  return { success: true };
}
