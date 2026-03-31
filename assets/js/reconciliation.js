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
    return { score: 80, matchReason: 'Date within 1 day, exact amount' };
  }
  if (days >= 2 && days <= 3 && exactAmt) {
    return { score: 60, matchReason: 'Date within 2-3 days, exact amount' };
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
    .lte('amount', amt + 0.5);

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

  const { data: rows, error } = await sb
    .from('bank_transactions')
    .select('id, date, amount, description')
    .eq('user_id', userId)
    .is('expense_id', null)
    .eq('is_personal', false)
    .eq('skipped', false);

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
      .not('receipt_url', 'is', null)
      .neq('receipt_url', '')
      .is('bank_transaction_id', null),
    sb
      .from('bank_transactions')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('expense_id', null),
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
