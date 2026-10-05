/**
 * StayOps — bank lines data layer (the Bank screen's reads and writes).
 *
 * Mirrors supabase-bank-accounts.js: snake↔camel mappers, every read scoped to
 * the signed-in user (RLS enforces it server-side too), every function
 * returning a safe empty value rather than throwing. Re-exported through the
 * supabase.js barrel.
 *
 * Schema: supabase/migrations/20261004_100000_bank_line_kinds.sql.
 */
import { getCurrentSupabaseUser } from './supabase.js';
import { undoReconciliation } from './supabase-bank-accounts.js';

const CHUNK = 150; // ids per .in() — keeps the PostgREST URL well under its limit

function _sb() { return window._sb; }

function _chunks(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK));
  return out;
}

export function bankLineRowToJs(row) {
  if (!row) return null;
  return {
    id:               row.id,
    date:             row.date || '',
    amount:           Math.abs(Number(row.amount) || 0),
    description:      row.description || '',
    direction:        row.direction === 'credit' ? 'credit' : 'debit',
    kind:             row.kind || null,
    kindSource:       row.kind_source || null,
    kindConfidence:   row.kind_confidence == null ? null : Number(row.kind_confidence),
    needsReview:      row.needs_review !== false,
    counterparty:     row.counterparty || '',
    expenseId:        row.expense_id || null,
    bookingId:        row.booking_id || null,
    bankAccountId:    row.bank_account_id || null,
    importBatchId:    row.import_batch_id || null,
    isPersonal:       !!row.is_personal,
    skipped:          !!row.skipped,
    reconciliationId: row.reconciliation_id || null,
    reconciledAt:     row.reconciled_at || null,
    notes:            row.notes || '',
    reviewedAt:       row.reviewed_at || null,
    createdAt:        row.created_at || null,
    // Attached by loadBankLines():
    expense:          null,
    payouts:          [],
    booking:          null,
  };
}

function _expenseRowToJs(e) {
  if (!e) return null;
  return {
    id:                 e.id,
    date:               e.date || '',
    amount:             Number(e.amount) || 0,
    merchant:           e.merchant || '',
    vendor:             e.vendor || '',
    description:        e.description || '',
    category:           e.category || '',
    propertyId:         e.property_id || null,
    bankTransactionId:  e.bank_transaction_id || null,
    refundOfExpenseId:  e.refund_of_expense_id || null,
    paidVia:            e.paid_via || 'unknown',
    localId:            e.local_id || null,
    status:             e.status || 'active',
    driveLink:          e.drive_link || '',
  };
}

const EXPENSE_COLS = 'id, date, amount, merchant, vendor, description, category, property_id, bank_transaction_id, refund_of_expense_id, paid_via, local_id, status, drive_link';

function _patchToRow(patch) {
  const map = {
    kind: 'kind', kindSource: 'kind_source', kindConfidence: 'kind_confidence', needsReview: 'needs_review',
    counterparty: 'counterparty', expenseId: 'expense_id', bookingId: 'booking_id', notes: 'notes',
    reviewedAt: 'reviewed_at', isPersonal: 'is_personal', skipped: 'skipped',
    reconciliationId: 'reconciliation_id', reconciledAt: 'reconciled_at',
  };
  const row = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (map[k]) row[map[k]] = v;
  }
  return row;
}

// ── Lines ─────────────────────────────────────────────────────────────────────

/** Attach the linked expense, the payouts settled by each credit, and the
 *  booking, in three batched queries. Mutates and returns `lines`. */
export async function attachBankLineLinks(lines) {
  const sb = _sb();
  if (!sb || !Array.isArray(lines) || !lines.length) return lines || [];
  const byId = new Map(lines.map(l => [String(l.id), l]));

  const expenseIds = [...new Set(lines.map(l => l.expenseId).filter(Boolean))];
  for (const ids of _chunks(expenseIds)) {
    const { data, error } = await sb.from('expenses').select(EXPENSE_COLS).in('id', ids);
    if (error) { console.warn('[StayOps] attachBankLineLinks expenses', error); continue; }
    const m = new Map((data || []).map(e => [String(e.id), _expenseRowToJs(e)]));
    for (const l of lines) if (l.expenseId && m.has(String(l.expenseId))) l.expense = m.get(String(l.expenseId));
  }

  const creditIds = lines.filter(l => l.direction === 'credit').map(l => l.id);
  for (const ids of _chunks(creditIds)) {
    const { data, error } = await sb.from('platform_payouts')
      .select('id, platform, payout_reference, payout_date, net_amount, bank_transaction_id')
      .in('bank_transaction_id', ids).neq('status', 'deleted');
    if (error) { console.warn('[StayOps] attachBankLineLinks payouts', error); continue; }
    for (const p of data || []) {
      const l = byId.get(String(p.bank_transaction_id));
      if (!l) continue;
      l.payouts.push({ id: p.id, platform: p.platform || null, reference: p.payout_reference || '', payoutDate: p.payout_date || null, net: Number(p.net_amount) || 0 });
    }
  }

  const bookingIds = [...new Set(lines.map(l => l.bookingId).filter(Boolean))];
  for (const ids of _chunks(bookingIds)) {
    const { data, error } = await sb.from('bookings').select('id, guest_name, checkin, checkout, host_payout, platform').in('id', ids);
    if (error) { console.warn('[StayOps] attachBankLineLinks bookings', error); continue; }
    const m = new Map((data || []).map(b => [String(b.id), { id: b.id, guestName: b.guest_name || '', checkin: b.checkin, checkout: b.checkout, hostPayout: Number(b.host_payout) || 0, platform: b.platform || '' }]));
    for (const l of lines) if (l.bookingId && m.has(String(l.bookingId))) l.booking = m.get(String(l.bookingId));
  }
  return lines;
}

/** Bank lines for one account in a date range, newest first, with links. */
export async function loadBankLines({ accountId = null, from = null, to = null, withLinks = true } = {}) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user) return [];
    let q = _sb().from('bank_transactions').select('*').eq('user_id', user.id);
    if (accountId) q = q.eq('bank_account_id', accountId);
    if (from) q = q.gte('date', from);
    if (to) q = q.lte('date', to);
    const { data, error } = await q.order('date', { ascending: false }).order('created_at', { ascending: false });
    if (error) { console.warn('[StayOps] loadBankLines error', error); return []; }
    const lines = (data || []).map(bankLineRowToJs);
    return withLinks ? attachBankLineLinks(lines) : lines;
  } catch (e) { console.warn('[StayOps] loadBankLines failed', e); return []; }
}

export async function updateBankLine(id, patch) {
  try {
    if (!id) return false;
    const row = _patchToRow(patch);
    if (!Object.keys(row).length) return true;
    const { error } = await _sb().from('bank_transactions').update(row).eq('id', id);
    if (error) { console.warn('[StayOps] updateBankLine error', error); return false; }
    return true;
  } catch (e) { console.warn('[StayOps] updateBankLine failed', e); return false; }
}

export async function updateBankLines(ids, patch) {
  try {
    const list = (ids || []).filter(Boolean);
    if (!list.length) return true;
    const row = _patchToRow(patch);
    if (!Object.keys(row).length) return true;
    for (const chunk of _chunks(list)) {
      const { error } = await _sb().from('bank_transactions').update(row).in('id', chunk);
      if (error) { console.warn('[StayOps] updateBankLines error', error); return false; }
    }
    return true;
  } catch (e) { console.warn('[StayOps] updateBankLines failed', e); return false; }
}

/** Insert parsed statement rows as bank lines. Each row: { date, amount,
 *  description, direction, counterparty, bankAccountId, importBatchId,
 *  bankName }. Amounts are stored ABSOLUTE; direction carries the sign. */
export async function insertBankLines(rows) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !Array.isArray(rows) || !rows.length) return [];
    const payload = rows.map(r => ({
      user_id: user.id,
      date: r.date,
      amount: Math.abs(Number(r.amount) || 0),
      description: r.description || '',
      direction: r.direction === 'credit' ? 'credit' : 'debit',
      counterparty: r.counterparty || null,
      bank_account_id: r.bankAccountId || null,
      import_batch_id: r.importBatchId || null,
      bank_name: r.bankName || null,
      is_personal: false,
      skipped: false,
      needs_review: true,
    }));
    const out = [];
    for (const chunk of _chunks(payload)) {
      const { data, error } = await _sb().from('bank_transactions').insert(chunk).select();
      if (error) { console.warn('[StayOps] insertBankLines error', error); throw error; }
      for (const row of data || []) out.push(bankLineRowToJs(row));
    }
    return out;
  } catch (e) { console.warn('[StayOps] insertBankLines failed', e); throw e; }
}

// ── Memory ────────────────────────────────────────────────────────────────────

/** Map of `${direction}|${counterpartyKey}` → remembered decision. */
export async function loadBankMemory() {
  const memory = new Map();
  try {
    const user = await getCurrentSupabaseUser();
    if (!user) return memory;
    const { data, error } = await _sb().from('bank_memory').select('*').eq('user_id', user.id);
    if (error) { console.warn('[StayOps] loadBankMemory error', error); return memory; }
    for (const r of data || []) {
      memory.set(`${r.direction === 'credit' ? 'credit' : 'debit'}|${r.counterparty_key}`, {
        id: r.id,
        key: r.counterparty_key,
        direction: r.direction,
        kind: r.kind,
        category: r.category || null,
        propertyId: r.property_id || null,
        platform: r.platform || null,
        timesUsed: Number(r.times_used) || 1,
        label: r.counterparty_key,
      });
    }
    return memory;
  } catch (e) { console.warn('[StayOps] loadBankMemory failed', e); return memory; }
}

/** Upsert one remembered decision; bumps times_used when it already exists. */
export async function rememberBankDecision({ counterpartyKey, direction, kind, category = null, propertyId = null, platform = null }) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !counterpartyKey || !kind) return null;
    const dir = direction === 'credit' ? 'credit' : 'debit';
    const { data: existing } = await _sb().from('bank_memory').select('id, times_used')
      .eq('user_id', user.id).eq('counterparty_key', counterpartyKey).eq('direction', dir).maybeSingle();
    const payload = {
      user_id: user.id,
      counterparty_key: counterpartyKey,
      direction: dir,
      kind,
      category: category || null,
      property_id: propertyId || null,
      platform: platform || null,
      times_used: (existing && Number(existing.times_used)) ? Number(existing.times_used) + 1 : 1,
      last_used_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await _sb().from('bank_memory')
      .upsert(payload, { onConflict: 'user_id,counterparty_key,direction' }).select().single();
    if (error) { console.warn('[StayOps] rememberBankDecision error', error); return null; }
    return data;
  } catch (e) { console.warn('[StayOps] rememberBankDecision failed', e); return null; }
}

/** Bulk upsert, used once to seed memory from the links that already existed
 *  before kinds did. rows: [{ counterpartyKey, direction, kind, category,
 *  propertyId, platform, timesUsed }]. Existing keys are left alone. */
export async function seedBankMemory(rows) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !Array.isArray(rows) || !rows.length) return 0;
    const existing = await loadBankMemory();
    const fresh = rows.filter(r => r && r.counterpartyKey && r.kind
      && !existing.has(`${r.direction === 'credit' ? 'credit' : 'debit'}|${r.counterpartyKey}`));
    if (!fresh.length) return 0;
    const payload = fresh.map(r => ({
      user_id: user.id,
      counterparty_key: r.counterpartyKey,
      direction: r.direction === 'credit' ? 'credit' : 'debit',
      kind: r.kind,
      category: r.category || null,
      property_id: r.propertyId || null,
      platform: r.platform || null,
      times_used: Math.max(1, Number(r.timesUsed) || 1),
    }));
    let n = 0;
    for (const chunk of _chunks(payload)) {
      const { error } = await _sb().from('bank_memory')
        .upsert(chunk, { onConflict: 'user_id,counterparty_key,direction', ignoreDuplicates: true });
      if (error) { console.warn('[StayOps] seedBankMemory error', error); continue; }
      n += chunk.length;
    }
    return n;
  } catch (e) { console.warn('[StayOps] seedBankMemory failed', e); return 0; }
}

export async function forgetBankDecision(counterpartyKey, direction) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !counterpartyKey) return false;
    const { error } = await _sb().from('bank_memory').delete()
      .eq('user_id', user.id).eq('counterparty_key', counterpartyKey)
      .eq('direction', direction === 'credit' ? 'credit' : 'debit');
    if (error) { console.warn('[StayOps] forgetBankDecision error', error); return false; }
    return true;
  } catch (e) { console.warn('[StayOps] forgetBankDecision failed', e); return false; }
}

// ── Import batches ────────────────────────────────────────────────────────────

function _batchRowToJs(r) {
  if (!r) return null;
  return {
    id: r.id,
    importDate: r.import_date || null,
    filename: r.filename || '',
    totalRows: Number(r.total_rows) || 0,
    imported: Number(r.imported) || 0,
    skipped: Number(r.skipped) || 0,
    duplicates: Number(r.duplicates) || 0,
    bankAccountId: r.bank_account_id || null,
    periodStart: r.period_start || null,
    periodEnd: r.period_end || null,
    openingBalance: r.opening_balance == null ? null : Number(r.opening_balance),
    closingBalance: r.closing_balance == null ? null : Number(r.closing_balance),
    sourceType: r.source_type || null,
  };
}

/** Create the log row BEFORE the lines, so import_batch_id (an FK) can point at it. */
export async function createBankImportBatch({ accountId, filename, totalRows, sourceType, periodStart, periodEnd, openingBalance, closingBalance } = {}) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user) return null;
    const { data, error } = await _sb().from('bank_import_log').insert({
      user_id: user.id,
      import_date: new Date().toISOString(),
      filename: filename || '',
      total_rows: Number(totalRows) || 0,
      bank_account_id: accountId || null,
      period_start: periodStart || null,
      period_end: periodEnd || null,
      opening_balance: openingBalance == null ? null : Number(openingBalance),
      closing_balance: closingBalance == null ? null : Number(closingBalance),
      source_type: sourceType || null,
    }).select().single();
    if (error) { console.warn('[StayOps] createBankImportBatch error', error); return null; }
    return _batchRowToJs(data);
  } catch (e) { console.warn('[StayOps] createBankImportBatch failed', e); return null; }
}

export async function updateBankImportBatch(id, patch = {}) {
  try {
    if (!id) return false;
    const row = {};
    if (patch.imported != null) row.imported = Number(patch.imported) || 0;
    if (patch.skipped != null) row.skipped = Number(patch.skipped) || 0;
    if (patch.duplicates != null) row.duplicates = Number(patch.duplicates) || 0;
    if ('openingBalance' in patch) row.opening_balance = patch.openingBalance == null ? null : Number(patch.openingBalance);
    if ('closingBalance' in patch) row.closing_balance = patch.closingBalance == null ? null : Number(patch.closingBalance);
    if (patch.periodStart) row.period_start = patch.periodStart;
    if (patch.periodEnd) row.period_end = patch.periodEnd;
    const { error } = await _sb().from('bank_import_log').update(row).eq('id', id);
    if (error) { console.warn('[StayOps] updateBankImportBatch error', error); return false; }
    return true;
  } catch (e) { console.warn('[StayOps] updateBankImportBatch failed', e); return false; }
}

/** Batches whose period overlaps [from, to], oldest first. Batches with no
 *  period recorded (pre-kinds imports) are excluded; they carry no balances. */
export async function loadBankImportBatches({ accountId = null, from = null, to = null } = {}) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user) return [];
    let q = _sb().from('bank_import_log').select('*').eq('user_id', user.id).not('period_end', 'is', null);
    if (accountId) q = q.eq('bank_account_id', accountId);
    if (from) q = q.gte('period_end', from);
    if (to) q = q.lte('period_start', to);
    const { data, error } = await q.order('period_start');
    if (error) { console.warn('[StayOps] loadBankImportBatches error', error); return []; }
    return (data || []).map(_batchRowToJs);
  } catch (e) { console.warn('[StayOps] loadBankImportBatches failed', e); return []; }
}

// ── Expenses the bank side creates or links ───────────────────────────────────

/** Expenses (all properties) dated in a range, for candidate lists and the
 *  engine's evidence. */
export async function loadExpensesInRange(from, to) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user) return [];
    let q = _sb().from('expenses').select(EXPENSE_COLS).eq('user_id', user.id)
      .or('status.is.null,status.neq.deleted');
    if (from) q = q.gte('date', from);
    if (to) q = q.lte('date', to);
    const { data, error } = await q.order('date', { ascending: false });
    if (error) { console.warn('[StayOps] loadExpensesInRange error', error); return []; }
    return (data || []).map(_expenseRowToJs);
  } catch (e) { console.warn('[StayOps] loadExpensesInRange failed', e); return []; }
}

export async function loadBookingsInRange(from, to) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user) return [];
    let q = _sb().from('bookings').select('id, guest_name, checkin, checkout, host_payout, platform, status').eq('user_id', user.id)
      .or('status.is.null,status.neq.cancelled');
    if (from) q = q.gte('checkout', from);
    if (to) q = q.lte('checkin', to);
    const { data, error } = await q.order('checkin', { ascending: false });
    if (error) { console.warn('[StayOps] loadBookingsInRange error', error); return []; }
    return (data || []).map(b => ({ id: b.id, guestName: b.guest_name || '', checkin: b.checkin, checkout: b.checkout, hostPayout: Number(b.host_payout) || 0, platform: b.platform || '', status: b.status || 'confirmed' }));
  } catch (e) { console.warn('[StayOps] loadBookingsInRange failed', e); return []; }
}

/**
 * Create the expense a bank line IS — a payment becomes an expense, a card
 * refund becomes a credit note (negative amount, refund_of_expense_id set).
 * Links both sides. local_id 'bank-<line id>' marks it as bank-created, so
 * undoing the line can delete it again without touching hand-entered rows.
 */
export async function createExpenseFromBankLine(line, { category, propertyId, merchant, description, amount, refundOfExpenseId = null, bookingId = null } = {}) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !line || !line.id) return null;
    const signed = Number(amount);
    const payload = {
      user_id: user.id,
      property_id: propertyId || null,
      local_id: 'bank-' + String(line.id),
      date: line.date,
      merchant: merchant || line.counterparty || '',
      description: description != null ? description : (line.description || ''),
      category: category || 'Other',
      amount: Number.isFinite(signed) ? signed : Math.abs(Number(line.amount) || 0),
      vendor: line.counterparty || null,
      receipt_type: 'missing',
      reconciled: true,
      bank_transaction_id: line.id,
      payment_status: 'paid',
      paid_via: 'this_account',
      refund_of_expense_id: refundOfExpenseId || null,
      booking_id: bookingId || null,
      booking_allocations: bookingId ? [{ booking_id: String(bookingId), amount: Number.isFinite(signed) ? signed : Math.abs(Number(line.amount) || 0) }] : [],
      status: 'active',
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await _sb().from('expenses')
      .upsert(payload, { onConflict: 'local_id,user_id' }).select(EXPENSE_COLS).single();
    if (error) { console.warn('[StayOps] createExpenseFromBankLine error', error); return null; }
    const { error: linkErr } = await _sb().from('bank_transactions').update({ expense_id: data.id }).eq('id', line.id);
    if (linkErr) { console.warn('[StayOps] createExpenseFromBankLine link error', linkErr); return null; }
    return _expenseRowToJs(data);
  } catch (e) { console.warn('[StayOps] createExpenseFromBankLine failed', e); return null; }
}

/** Patch a bank-created expense in place (category, property, merchant). */
export async function updateExpenseFields(expenseId, { category, propertyId, merchant, description, paidVia } = {}) {
  try {
    if (!expenseId) return false;
    const row = { updated_at: new Date().toISOString() };
    if (category != null) row.category = category;
    if (propertyId !== undefined) row.property_id = propertyId || null;
    if (merchant != null) row.merchant = merchant;
    if (description != null) row.description = description;
    if (paidVia != null) row.paid_via = paidVia;
    const { error } = await _sb().from('expenses').update(row).eq('id', expenseId);
    if (error) { console.warn('[StayOps] updateExpenseFields error', error); return false; }
    return true;
  } catch (e) { console.warn('[StayOps] updateExpenseFields failed', e); return false; }
}

export async function linkBankLineToExpense(lineId, expenseId) {
  try {
    if (!lineId || !expenseId) return false;
    const w1 = await _sb().from('bank_transactions').update({ expense_id: expenseId }).eq('id', lineId);
    if (w1.error) { console.warn('[StayOps] linkBankLineToExpense (line)', w1.error); return false; }
    const w2 = await _sb().from('expenses')
      .update({ reconciled: true, bank_transaction_id: lineId, payment_status: 'paid', paid_via: 'this_account', updated_at: new Date().toISOString() })
      .eq('id', expenseId);
    if (w2.error) { console.warn('[StayOps] linkBankLineToExpense (expense)', w2.error); return false; }
    return true;
  } catch (e) { console.warn('[StayOps] linkBankLineToExpense failed', e); return false; }
}

/** Detach a line from its expense. A bank-created expense (local_id 'bank-…')
 *  is soft-deleted with it, because it only ever existed to mirror this line;
 *  a hand-entered one is left as an unpaid expense. */
export async function unlinkBankLineExpense(line) {
  try {
    if (!line || !line.id) return false;
    const expenseId = line.expenseId || (line.expense && line.expense.id);
    const w1 = await _sb().from('bank_transactions').update({ expense_id: null }).eq('id', line.id);
    if (w1.error) { console.warn('[StayOps] unlinkBankLineExpense (line)', w1.error); return false; }
    if (!expenseId) return true;
    const createdHere = !!(line.expense && String(line.expense.localId || '').startsWith('bank-'));
    const patch = createdHere
      ? { status: 'deleted', reconciled: false, bank_transaction_id: null, payment_status: 'unknown', updated_at: new Date().toISOString() }
      : { reconciled: false, bank_transaction_id: null, payment_status: 'unknown', paid_via: 'unknown', updated_at: new Date().toISOString() };
    const w2 = await _sb().from('expenses').update(patch).eq('id', expenseId);
    if (w2.error) { console.warn('[StayOps] unlinkBankLineExpense (expense)', w2.error); return false; }
    return true;
  } catch (e) { console.warn('[StayOps] unlinkBankLineExpense failed', e); return false; }
}

/** Bulk "paid elsewhere": unlinked, still-unknown expenses in a date range. */
export async function markExpensesPaidVia({ from, to, paidVia = 'other_account' } = {}) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !from || !to) return 0;
    const { data, error } = await _sb().from('expenses')
      .update({ paid_via: paidVia, updated_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .is('bank_transaction_id', null)
      .eq('paid_via', 'unknown')
      .or('status.is.null,status.neq.deleted')
      .gte('date', from).lte('date', to)
      .select('id');
    if (error) { console.warn('[StayOps] markExpensesPaidVia error', error); return 0; }
    return (data || []).length;
  } catch (e) { console.warn('[StayOps] markExpensesPaidVia failed', e); return 0; }
}

// ── Locks (a closed period) ───────────────────────────────────────────────────

function _lockRowToJs(r) {
  if (!r) return null;
  return {
    id: r.id,
    bankAccountId: r.bank_account_id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    openingBalance: r.opening_balance == null ? null : Number(r.opening_balance),
    statementClosing: r.statement_closing_balance == null ? null : Number(r.statement_closing_balance),
    computedClosing: r.computed_closing_balance == null ? null : Number(r.computed_closing_balance),
    outOfBalance: r.out_of_balance == null ? null : Number(r.out_of_balance),
    status: r.status || 'open',
    closedAt: r.closed_at || null,
    notes: r.notes || '',
  };
}

export async function loadBankLocks(accountId) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !accountId) return [];
    const { data, error } = await _sb().from('bank_reconciliations').select('*')
      .eq('user_id', user.id).eq('bank_account_id', accountId).eq('status', 'closed')
      .order('period_end', { ascending: false });
    if (error) { console.warn('[StayOps] loadBankLocks error', error); return []; }
    return (data || []).map(_lockRowToJs);
  } catch (e) { console.warn('[StayOps] loadBankLocks failed', e); return []; }
}

/** Close a period: one bank_reconciliations row, every line in the range
 *  stamped. Balances may be null (a bulk-marked year has none). */
export async function lockBankPeriod({ accountId, periodStart, periodEnd, openingBalance = null, closingBalance = null, computedClosing = null, notes = '' } = {}) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !accountId || !periodStart || !periodEnd) return null;
    const oob = (closingBalance != null && computedClosing != null)
      ? Math.round((Number(closingBalance) - Number(computedClosing)) * 100) / 100
      : null;
    const payload = {
      user_id: user.id,
      bank_account_id: accountId,
      period_start: periodStart,
      period_end: periodEnd,
      opening_balance: openingBalance == null ? 0 : Number(openingBalance),
      statement_closing_balance: closingBalance == null ? 0 : Number(closingBalance),
      computed_closing_balance: computedClosing == null ? null : Number(computedClosing),
      out_of_balance: oob,
      status: 'closed',
      closed_at: new Date().toISOString(),
      notes: notes || null,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await _sb().from('bank_reconciliations')
      .upsert(payload, { onConflict: 'user_id,bank_account_id,period_start,period_end' })
      .select().single();
    if (error) { console.warn('[StayOps] lockBankPeriod error', error); return null; }
    const { error: e2 } = await _sb().from('bank_transactions')
      .update({ reconciled_at: new Date().toISOString(), reconciliation_id: data.id })
      .eq('user_id', user.id).eq('bank_account_id', accountId)
      .gte('date', periodStart).lte('date', periodEnd);
    if (e2) console.warn('[StayOps] lockBankPeriod stamping failed', e2);
    return _lockRowToJs(data);
  } catch (e) { console.warn('[StayOps] lockBankPeriod failed', e); return null; }
}

export async function unlockBankPeriod(lockId) {
  return undoReconciliation(lockId);
}

/** Money paid out to the owner in a date range: bank lines explained as
 *  Owner funds, money out. Feeds "Paid to owner" on the monthly statement. */
export async function loadOwnerFundsOut({ from = null, to = null } = {}) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user) return { total: 0, rows: [] };
    let q = _sb().from('bank_transactions')
      .select('id, date, amount, description, counterparty')
      .eq('user_id', user.id).eq('kind', 'owner_funds').eq('direction', 'debit');
    if (from) q = q.gte('date', from);
    if (to) q = q.lte('date', to);
    const { data, error } = await q.order('date');
    if (error) { console.warn('[StayOps] loadOwnerFundsOut error', error); return { total: 0, rows: [] }; }
    const rows = (data || []).map(r => ({ id: r.id, date: r.date, amount: Math.abs(Number(r.amount) || 0), description: r.description || '', counterparty: r.counterparty || '' }));
    const total = Math.round(rows.reduce((s, r) => s + r.amount * 100, 0)) / 100;
    return { total, rows };
  } catch (e) { console.warn('[StayOps] loadOwnerFundsOut failed', e); return { total: 0, rows: [] }; }
}

