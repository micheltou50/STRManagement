/**
 * Expense ↔ bank transaction reconciliation (StayOps).
 * Uses window._sb (Supabase client).
 */

function getSb() {
  return typeof window !== 'undefined' ? window._sb || null : null;
}

function toDateString(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    return value.trim().split('T')[0].split(' ')[0];
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return null;
}

function addDays(isoDate, delta) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

function dayDiffBetween(dateA, dateB) {
  const a = toDateString(dateA);
  const b = toDateString(dateB);
  if (!a || !b) return 999;
  const da = new Date(a + 'T12:00:00.000Z');
  const db = new Date(b + 'T12:00:00.000Z');
  return Math.round(Math.abs(da - db) / 86400000);
}

function amountDiff(a, b) {
  return Math.abs(Number(a) - Number(b));
}

/** @returns {{ score: number, matchReason: string } | null} */
function scoreExpenseToTransaction(expenseDate, expenseAmount, txnDate, txnAmount) {
  const days = dayDiffBetween(expenseDate, txnDate);
  if (days > 3) return null;
  const ad = amountDiff(expenseAmount, txnAmount);
  if (ad > 0.5) return null;
  const exactAmt = ad < 0.01;

  if (days === 0 && exactAmt) {
    return { score: 100, matchReason: 'Exact date and amount' };
  }
  if (days === 1 && exactAmt) {
    // Closer dates score higher. Previously 1-day=80 and 2-3 day=85 (inverted),
    // which caused worse matches to outrank better ones.
    return { score: 90, matchReason: 'Date within 1 day, exact amount' };
  }
  if (days >= 2 && days <= 3 && exactAmt) {
    return { score: 80, matchReason: 'Date within 2-3 days, exact amount' };
  }
  if (days === 0 && !exactAmt) {
    return { score: 50, matchReason: 'Exact date, amount within $0.50' };
  }
  if (days === 1 && !exactAmt) {
    return { score: 45, matchReason: 'Date within 1 day, amount within $0.50' };
  }
  if (days >= 2 && days <= 3 && !exactAmt) {
    return { score: 40, matchReason: 'Date within 2-3 days, amount within $0.50' };
  }
  return null;
}

function descriptionContainsVendor(description, vendor) {
  const d = String(description || '').toLowerCase();
  const v = String(vendor || '').trim().toLowerCase();
  if (!v) return false;
  return d.includes(v);
}

/**
 * @param {{ date: unknown, amount: unknown, description?: string }} transaction
 * @param {string} userId
 */
export async function findMatchesForTransaction(transaction, userId) {
  const sb = getSb();
  if (!sb || !userId) {
    console.log('[StayOps] findMatchesForTransaction: missing Supabase client or userId');
    return [];
  }

  const txnDate = toDateString(transaction.date);
  if (!txnDate) return [];

  const amt = Number(transaction.amount);
  if (!Number.isFinite(amt)) return [];

  const minDate = addDays(txnDate, -3);
  const maxDate = addDays(txnDate, 3);

  const { data, error } = await sb
    .from('expenses')
    .select('*')
    .eq('user_id', userId)
    .eq('reconciled', false)
    .gte('date', minDate)
    .lte('date', maxDate)
    .gte('amount', amt - 0.5)
    .lte('amount', amt + 0.5);

  if (error) {
    console.log('[StayOps] findMatchesForTransaction query error:', error.message || error);
    return [];
  }

  const scored = [];
  for (const expense of data || []) {
    const s = scoreExpenseToTransaction(expense.date, expense.amount, txnDate, amt);
    if (s) {
      scored.push({ expense, score: s.score, matchReason: s.matchReason });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * @param {{ date: unknown, amount: unknown, vendor?: string }} expense
 * @param {string} userId
 */
export async function findMatchesForExpense(expense, userId) {
  const sb = getSb();
  if (!sb || !userId) {
    console.log('[StayOps] findMatchesForExpense: missing Supabase client or userId');
    return [];
  }

  const expDate = toDateString(expense.date);
  if (!expDate) return [];

  const amt = Number(expense.amount);
  if (!Number.isFinite(amt)) return [];

  const minDate = addDays(expDate, -3);
  const maxDate = addDays(expDate, 3);

  const { data, error } = await sb
    .from('bank_transactions')
    .select('*')
    .eq('user_id', userId)
    .is('expense_id', null)
    .eq('is_personal', false)
    .eq('skipped', false)
    .gte('date', minDate)
    .lte('date', maxDate)
    .gte('amount', amt - 0.5)
    .lte('amount', amt + 0.5)
    // Debits only. Amounts are stored absolute with the sign carried by
    // `direction`, so without this a $500 deposit looks identical to a $500
    // payment and could be offered as settling an expense.
    .or('direction.is.null,direction.eq.debit');

  if (error) {
    console.log('[StayOps] findMatchesForExpense query error:', error.message || error);
    return [];
  }

  const vendor = expense.vendor;
  const scored = [];
  for (const transaction of data || []) {
    const s = scoreExpenseToTransaction(expDate, amt, transaction.date, transaction.amount);
    if (!s) continue;
    let score = s.score;
    let reason = s.matchReason;
    if (descriptionContainsVendor(transaction.description, vendor)) {
      score += 20;
      reason += '; description contains vendor';
    }
    scored.push({ transaction, score, matchReason: reason });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
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

/**
 * Set the classification flags on a bank transaction. `personal` and `skipped`
 * are mutually exclusive statuses; both false restores the row to "unaccounted".
 * @param {string} transactionId
 * @param {{isPersonal?: boolean, skipped?: boolean}} flags
 * @returns {Promise<{success: boolean}>}
 */
export async function setTransactionClassification(transactionId, flags = {}) {
  const sb = getSb();
  if (!sb || !transactionId) {
    console.log('[StayOps] setTransactionClassification: missing id');
    return { success: false };
  }
  const { error } = await sb
    .from('bank_transactions')
    .update({ is_personal: !!flags.isPersonal, skipped: !!flags.skipped })
    .eq('id', transactionId);
  if (error) {
    console.log('[StayOps] setTransactionClassification error:', error.message || error);
    return { success: false };
  }
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

// ── END PHASE 2c PAYOUT MATCHING ─────────────────────────────────────────────


/**
 * @param {string} transactionId
 */
export async function unlinkTransaction(transactionId) {
  const sb = getSb();
  if (!sb || !transactionId) {
    console.log('[StayOps] unlinkTransaction: missing id');
    return { success: false };
  }

  const { data: row, error: readErr } = await sb
    .from('bank_transactions')
    .select('expense_id')
    .eq('id', transactionId)
    .maybeSingle();

  if (readErr) {
    console.log('[StayOps] unlinkTransaction read error:', readErr.message || readErr);
    return { success: false };
  }

  const expenseId = row && row.expense_id;

  const { error: e1 } = await sb.from('bank_transactions').update({ expense_id: null }).eq('id', transactionId);

  if (e1) {
    console.log('[StayOps] unlinkTransaction bank update error:', e1.message || e1);
    return { success: false };
  }

  if (expenseId) {
    const { error: e2 } = await sb
      .from('expenses')
      .update({
        bank_transaction_id: null,
        reconciled: false,
        payment_status: 'unknown',
      })
      .eq('id', expenseId);

    if (e2) {
      console.log('[StayOps] unlinkTransaction expense update error:', e2.message || e2);
      return { success: false };
    }
  }

  return { success: true };
}

/**
 * @param {string} userId
 */
export async function autoReconcile(userId) {
  const sb = getSb();
  if (!sb || !userId) {
    console.log('[StayOps] autoReconcile: missing Supabase client or userId');
    return { autoLinked: 0, suggested: 0, unmatched: 0 };
  }

  // Debits only. Amounts are stored ABSOLUTE with the sign carried by
  // `direction`, so without this filter a $500 deposit and a $500 expense look
  // identical to findMatchesForTransaction and a payout could be auto-linked to
  // an expense. Credits belong to the payout path, not this one. Null direction
  // is treated as debit, matching the column default and getReconciliationSummary.
  const { data: rows, error } = await sb
    .from('bank_transactions')
    .select('id, date, amount, description')
    .eq('user_id', userId)
    .is('expense_id', null)
    .eq('is_personal', false)
    .eq('skipped', false)
    .or('direction.is.null,direction.eq.debit');

  if (error) {
    console.log('[StayOps] autoReconcile query error:', error.message || error);
    return { autoLinked: 0, suggested: 0, unmatched: 0 };
  }

  let autoLinked = 0;
  let suggested = 0;
  let unmatched = 0;

  for (const tx of rows || []) {
    const matches = await findMatchesForTransaction(
      { date: tx.date, amount: tx.amount, description: tx.description },
      userId
    );
    const top = matches[0];
    if (!top) {
      unmatched++;
      continue;
    }
    if (top.score >= 80) {
      const r = await linkTransactionToExpense(tx.id, top.expense.id);
      if (r.success) autoLinked++;
      else unmatched++;
    } else if (top.score >= 50 && top.score < 80) {
      suggested++;
    } else {
      unmatched++;
    }
  }

  console.log(
    `[StayOps] Auto-reconcile: ${autoLinked} linked, ${suggested} suggested, ${unmatched} unmatched`
  );
  return { autoLinked, suggested, unmatched };
}

/**
 * Fetch ALL bank transactions for a user with their classification status.
 * @param {string} userId
 * @returns {Promise<Array<{id:string,date:string,description:string,amount:number,status:string,expenseMerchant:string|null,expenseCategory:string|null,is_personal:boolean,skipped:boolean,expense_id:string|null}>>}
 */
export async function getAllTransactionsWithStatus(userId) {
  const sb = getSb();
  if (!sb || !userId) {
    console.log('[StayOps] getAllTransactionsWithStatus: missing Supabase client or userId');
    return [];
  }

  const { data: txns, error } = await sb
    .from('bank_transactions')
    .select('id, date, description, amount, expense_id, is_personal, skipped, direction')
    .eq('user_id', userId)
    .order('date', { ascending: false });

  if (error) {
    console.log('[StayOps] getAllTransactionsWithStatus query error:', error.message || error);
    return [];
  }

  if (!txns || txns.length === 0) return [];

  // Gather linked expense IDs to fetch merchant/category in one query
  const linkedExpenseIds = txns
    .filter(t => t.expense_id)
    .map(t => t.expense_id);

  let expenseMap = {};
  if (linkedExpenseIds.length > 0) {
    const { data: expRows, error: expErr } = await sb
      .from('expenses')
      .select('id, merchant, vendor, category')
      .in('id', linkedExpenseIds);

    if (!expErr && expRows) {
      for (const e of expRows) {
        // Manually-entered expenses populate `merchant`; bank-import-created ones
        // populate `vendor`. Coalesce so the matched-row badge shows a real name.
        expenseMap[e.id] = { merchant: e.merchant || e.vendor || null, category: e.category || null };
      }
    }
  }

  // Phase 2c: for credit rows, look up any platform_payout linked back to
  // this bank tx (via platform_payouts.bank_transaction_id). One query for
  // all credits at once, indexed.
  const creditTxnIds = txns.filter(t => t.direction === 'credit').map(t => t.id);
  let payoutMap = {};
  if (creditTxnIds.length > 0) {
    const { data: payRows, error: payErr } = await sb
      .from('platform_payouts')
      .select('id, platform, payout_reference, payout_date, net_amount, bank_transaction_id')
      .in('bank_transaction_id', creditTxnIds);
    if (!payErr && payRows) {
      for (const p of payRows) {
        if (!p.bank_transaction_id) continue;
        payoutMap[p.bank_transaction_id] = {
          id: p.id,
          platform: p.platform || null,
          payoutReference: p.payout_reference || null,
          payoutDate: p.payout_date || null,
          netAmount: Number(p.net_amount) || 0,
        };
      }
    }
  }

  return txns.map(t => {
    const isCredit = t.direction === 'credit';
    const linkedPayout = isCredit ? payoutMap[t.id] || null : null;
    let status;
    if (t.is_personal) status = 'personal';
    else if (t.skipped) status = 'skipped';
    else if (linkedPayout) status = 'matched_payout';
    else if (t.expense_id) status = 'matched';
    else status = 'unaccounted';

    const linkedExpense = t.expense_id ? expenseMap[t.expense_id] : null;

    return {
      id: t.id,
      date: t.date,
      description: t.description || '',
      amount: Number(t.amount) || 0,
      direction: t.direction || 'debit',
      status,
      expenseMerchant: linkedExpense ? linkedExpense.merchant : null,
      expenseCategory: linkedExpense ? linkedExpense.category : null,
      is_personal: !!t.is_personal,
      skipped: !!t.skipped,
      expense_id: t.expense_id || null,
      payout: linkedPayout, // null for debits / unmatched credits
    };
  });
}

/**
 * @param {string} userId
 */
export async function getReconciliationSummary(userId) {
  const sb = getSb();
  if (!sb || !userId) {
    console.log('[StayOps] getReconciliationSummary: missing Supabase client or userId');
    return { total: 0, reconciled: 0, unpaid: 0, unmatchedTransactions: 0 };
  }

  const [
    { count: total, error: e1 },
    { count: reconciled, error: e2 },
    { count: unpaid, error: e3 },
    { count: unmatchedTransactions, error: e4 },
  ] = await Promise.all([
    sb.from('expenses').select('*', { count: 'exact', head: true }).eq('user_id', userId),
    sb
      .from('expenses')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('reconciled', true),
    sb
      .from('expenses')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      // `receipt_url` does not exist on `expenses` — the receipt column is
      // `drive_link`. PostgREST rejected the whole query, so this count has
      // silently been 0 since it was written.
      .not('drive_link', 'is', null)
      .is('bank_transaction_id', null),
    sb
      .from('bank_transactions')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('expense_id', null)
      .eq('is_personal', false)
      .eq('skipped', false)
      .or('direction.is.null,direction.eq.debit'),
  ]);

  if (e1 || e2 || e3 || e4) {
    console.log(
      '[StayOps] getReconciliationSummary count error:',
      e1 || e2 || e3 || e4
    );
  }

  return {
    total: total ?? 0,
    reconciled: reconciled ?? 0,
    unpaid: unpaid ?? 0,
    unmatchedTransactions: unmatchedTransactions ?? 0,
  };
}
