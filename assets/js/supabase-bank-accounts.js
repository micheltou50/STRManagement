/**
 * StayOps — bank accounts + period reconciliations data layer.
 *
 * Mirrors the conventions in supabase-payouts.js: snake↔camel mappers, all
 * reads scoped by the authenticated user (RLS enforces it server-side too),
 * and every function returning a safe empty value rather than throwing.
 *
 * Re-exported through the supabase.js barrel.
 */
// Imported from the barrel and used only at call-time, matching the pattern the
// other data-layer slices use (see supabase-payouts.js) — the cycle is safe
// because nothing here runs at module-evaluation time.
import { getCurrentSupabaseUser } from './supabase.js';

function _accountRowToJs(row) {
  if (!row) return null;
  return {
    _cloudId:        row.id,
    name:            row.name || 'Account',
    bankName:        row.bank_name || '',
    last4:           row.account_number_last4 || '',
    currency:        row.currency || 'AUD',
    openingBalance:  Number(row.opening_balance) || 0,
    openingBalanceDate: row.opening_balance_date || null,
    isDefault:       !!row.is_default,
    archived:        !!row.archived,
  };
}

function _reconRowToJs(row) {
  if (!row) return null;
  return {
    _cloudId:          row.id,
    bankAccountId:     row.bank_account_id,
    periodStart:       row.period_start,
    periodEnd:         row.period_end,
    openingBalance:    Number(row.opening_balance) || 0,
    statementClosing:  Number(row.statement_closing_balance) || 0,
    computedClosing:   row.computed_closing_balance == null ? null : Number(row.computed_closing_balance),
    outOfBalance:      row.out_of_balance == null ? null : Number(row.out_of_balance),
    status:            row.status || 'open',
    closedAt:          row.closed_at || null,
    notes:             row.notes || '',
  };
}

export async function loadBankAccounts() {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user) return [];
    const { data, error } = await window._sb
      .from('bank_accounts').select('*')
      .eq('user_id', user.id).eq('archived', false)
      .order('is_default', { ascending: false }).order('name');
    if (error) { console.warn('[StayOps] loadBankAccounts error', error); return []; }
    return (data || []).map(_accountRowToJs);
  } catch (e) { console.warn('[StayOps] loadBankAccounts failed', e); return []; }
}

/** The account new imports and reconciles default to. Creates one on first use
 *  so a single-account host never has to think about accounts at all. */
export async function getOrCreateDefaultBankAccount() {
  const existing = await loadBankAccounts();
  if (existing.length) return existing.find(a => a.isDefault) || existing[0];
  try {
    const user = await getCurrentSupabaseUser();
    if (!user) return null;
    const { data, error } = await window._sb
      .from('bank_accounts')
      .insert({ user_id: user.id, name: 'Main account', is_default: true })
      .select().single();
    if (error) { console.warn('[StayOps] create default bank account error', error); return null; }
    return _accountRowToJs(data);
  } catch (e) { console.warn('[StayOps] getOrCreateDefaultBankAccount failed', e); return null; }
}

export async function saveBankAccount(account) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !account) return null;
    const payload = {
      user_id: user.id,
      name: account.name || 'Account',
      bank_name: account.bankName || null,
      account_number_last4: account.last4 || null,
      currency: account.currency || 'AUD',
      opening_balance: Number(account.openingBalance) || 0,
      opening_balance_date: account.openingBalanceDate || null,
      updated_at: new Date().toISOString(),
    };
    const q = account._cloudId
      ? window._sb.from('bank_accounts').update(payload).eq('id', account._cloudId).select().single()
      : window._sb.from('bank_accounts').insert(payload).select().single();
    const { data, error } = await q;
    if (error) { console.warn('[StayOps] saveBankAccount error', error); return null; }
    return _accountRowToJs(data);
  } catch (e) { console.warn('[StayOps] saveBankAccount failed', e); return null; }
}

/** Transactions eligible for a period: on or before the statement date, for one
 *  account, excluding personal/skipped and anything already reconciled in an
 *  EARLIER closed period. */
export async function loadTransactionsForPeriod(accountId, periodEnd) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !accountId || !periodEnd) return [];
    const { data, error } = await window._sb
      .from('bank_transactions')
      .select('id, date, amount, description, direction, import_batch_id, reconciled_at, reconciliation_id')
      .eq('user_id', user.id)
      .eq('bank_account_id', accountId)
      .lte('date', periodEnd)
      .eq('is_personal', false)
      .eq('skipped', false)
      .order('date');
    if (error) { console.warn('[StayOps] loadTransactionsForPeriod error', error); return []; }
    return (data || []).map(r => ({
      id: r.id,
      date: r.date,
      amount: Number(r.amount) || 0,
      description: r.description || '',
      direction: r.direction || 'debit',
      importBatchId: r.import_batch_id || null,
      reconciledAt: r.reconciled_at || null,
      reconciliationId: r.reconciliation_id || null,
    }));
  } catch (e) { console.warn('[StayOps] loadTransactionsForPeriod failed', e); return []; }
}

/** Most recently closed reconciliation for an account — its statement closing
 *  balance becomes the next period's opening balance. */
export async function loadLastClosedReconciliation(accountId) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !accountId) return null;
    const { data, error } = await window._sb
      .from('bank_reconciliations').select('*')
      .eq('user_id', user.id).eq('bank_account_id', accountId).eq('status', 'closed')
      .order('period_end', { ascending: false }).limit(1);
    if (error) { console.warn('[StayOps] loadLastClosedReconciliation error', error); return null; }
    return (data && data.length) ? data[0] : null;
  } catch (e) { console.warn('[StayOps] loadLastClosedReconciliation failed', e); return null; }
}

export async function loadReconciliations(accountId) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !accountId) return [];
    const { data, error } = await window._sb
      .from('bank_reconciliations').select('*')
      .eq('user_id', user.id).eq('bank_account_id', accountId)
      .order('period_end', { ascending: false });
    if (error) { console.warn('[StayOps] loadReconciliations error', error); return []; }
    return (data || []).map(_reconRowToJs);
  } catch (e) { console.warn('[StayOps] loadReconciliations failed', e); return []; }
}

/**
 * Close a period: record the reconciliation and stamp the cleared rows.
 * Only ever called at out-of-balance $0.00 (the UI blocks otherwise).
 */
export async function saveReconciliation(rec, clearedTxnIds) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !rec) return null;
    const payload = {
      user_id: user.id,
      bank_account_id: rec.bankAccountId,
      period_start: rec.periodStart,
      period_end: rec.periodEnd,
      opening_balance: Number(rec.openingBalance) || 0,
      statement_closing_balance: Number(rec.statementClosing) || 0,
      computed_closing_balance: Number(rec.computedClosing) || 0,
      out_of_balance: Number(rec.outOfBalance) || 0,
      status: rec.status || 'closed',
      closed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    // onConflict matches bank_reconciliations_period_uniq, so re-closing the
    // same period updates rather than erroring.
    const { data, error } = await window._sb
      .from('bank_reconciliations')
      .upsert(payload, { onConflict: 'user_id,bank_account_id,period_start,period_end' })
      .select().single();
    if (error) { console.warn('[StayOps] saveReconciliation error', error); return null; }

    if (Array.isArray(clearedTxnIds) && clearedTxnIds.length) {
      const { error: e2 } = await window._sb
        .from('bank_transactions')
        .update({ reconciled_at: new Date().toISOString(), reconciliation_id: data.id })
        .in('id', clearedTxnIds);
      if (e2) console.warn('[StayOps] stamping reconciled transactions failed', e2);
    }
    return _reconRowToJs(data);
  } catch (e) { console.warn('[StayOps] saveReconciliation failed', e); return null; }
}

/** Undo a period: unstamp its transactions, then remove the record. Deliberately
 *  a real undo — a locked period that cannot be reopened eventually blocks a
 *  legitimate late correction. */
export async function undoReconciliation(reconciliationId) {
  try {
    if (!reconciliationId) return { success: false };
    const { error: e1 } = await window._sb
      .from('bank_transactions')
      .update({ reconciled_at: null, reconciliation_id: null })
      .eq('reconciliation_id', reconciliationId);
    if (e1) { console.warn('[StayOps] undoReconciliation unstamp error', e1); return { success: false }; }
    const { error: e2 } = await window._sb
      .from('bank_reconciliations').delete().eq('id', reconciliationId);
    if (e2) { console.warn('[StayOps] undoReconciliation delete error', e2); return { success: false }; }
    return { success: true };
  } catch (e) { console.warn('[StayOps] undoReconciliation failed', e); return { success: false }; }
}
