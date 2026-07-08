/**
 * StayOps — expenses: expense CRUD (the `expenses` table), the offline retry
 * queue (localStorage EXPENSE_SYNC_QUEUE_KEY), and the normalizeDriveLinks helper.
 * Split out of supabase.js 2026-07-09 (by-entity data-layer split). supabase.js
 * re-exports the public fns and imports loadExpensesFromCloud back for hydration.
 * window._sb is global; shared helpers imported from the barrel at call-time.
 */
import { getCurrentSupabaseUser, getCloudPropertyId, sbWrite } from './supabase.js';

// ── EXPENSES ──────────────────────────────────────────────────────────────────

export function normalizeDriveLinks(rawValue) {
  if (!rawValue) return [];
  if (Array.isArray(rawValue)) return rawValue.filter(Boolean);
  const str = String(rawValue).trim();
  if (!str) return [];
  if (str.startsWith('[')) {
    try { return JSON.parse(str).filter(Boolean); } catch (_e) { /* malformed JSON */ }
  }
  return [str];
}

export async function loadExpensesFromCloud() {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user) return null;
    const propertyId = await getCloudPropertyId();
    let query = window._sb.from('expenses').select('*').eq('user_id', user.id);
    if (propertyId) query = query.eq('property_id', propertyId);
    // Hide soft-deleted expenses; tolerate legacy rows with NULL status.
    query = query.or('status.is.null,status.neq.deleted');
    const { data, error } = await query.order('date', { ascending: false });
    if (error || !data) return null;
    return data.map(e => ({
      id:          e.local_id ? Number(e.local_id) || e.local_id : e.id,
      _cloudId:    e.id,
      _propertyId: e.property_id || null,
      date:        e.date        || '',
      merchant:    e.merchant    || '',
      description: e.description || '',
      category:    e.category    || '',
      amount:      e.amount      || 0,
      receiptNum:  e.receipt_num  || '',
      receiptType: e.receipt_type || '',
      driveLink:   normalizeDriveLinks(e.drive_link),
      photo:       e.photo || null,
      bookingId:   e.booking_id   || null,
      // Phase 0 finance scaffolding:
      taxNote:                e.tax_note || '',
      paidBy:                 e.paid_by || 'host',
      recoverableFromOwner:   e.recoverable_from_owner === true,
      // Surface existing reconciliation columns so consumers can read them
      // without going through the raw cloud row:
      reconciled:             e.reconciled === true,
      bank_transaction_id:    e.bank_transaction_id || null,
      paymentStatus:          e.payment_status || 'unknown',
    }));
  } catch (e) {
    console.warn('[StayOps] loadExpensesFromCloud failed', e);
    return null;
  }
}

const EXPENSE_SYNC_QUEUE_KEY = 'stayops-expense-sync-queue';

function _queueExpenseForRetry(expense) {
  try {
    const queue = JSON.parse(localStorage.getItem(EXPENSE_SYNC_QUEUE_KEY) || '[]');
    const exists = queue.some(q => String(q.id) === String(expense.id));
    if (!exists) {
      queue.push({
        id: expense.id,
        _cloudId: expense._cloudId || null,
        _propertyId: expense._propertyId || null,
        merchant: expense.merchant || '',
        description: expense.description || '',
        amount: expense.amount || 0,
        date: expense.date || '',
        category: expense.category || '',
        receiptType: expense.receiptType || '',
        receiptNum: expense.receiptNum || '',
        driveLink: expense.driveLink || null,
        bookingId: expense.bookingId || null,
        _queuedAt: new Date().toISOString()
      });
      localStorage.setItem(EXPENSE_SYNC_QUEUE_KEY, JSON.stringify(queue));
    }
  } catch (_e) { /* localStorage full or unavailable */ }
}

export async function retryQueuedExpenses() {
  let queue;
  try {
    queue = JSON.parse(localStorage.getItem(EXPENSE_SYNC_QUEUE_KEY) || '[]');
  } catch (_e) { return; }
  if (!queue.length) return;

  const { expenses } = await import('./state.js');
  console.log('[StayOps] Retrying', queue.length, 'queued expense(s)...');
  const failed = [];
  for (const exp of queue) {
    const result = await saveExpenseToCloud(exp);
    if (result) {
      const inMem = expenses.find(e => String(e.id) === String(exp.id));
      if (!inMem) {
        exp._cloudId = result._cloudId || result.id || exp._cloudId;
        expenses.push(exp);
      } else if (!inMem._cloudId) {
        inMem._cloudId = result._cloudId || result.id;
      }
    } else {
      failed.push(exp);
    }
  }
  localStorage.setItem(EXPENSE_SYNC_QUEUE_KEY, JSON.stringify(failed));
  if (failed.length) {
    console.warn('[StayOps]', failed.length, 'expense(s) still failed to sync');
    if (typeof globalThis.showBanner === 'function') {
      globalThis.showBanner('⚠ ' + failed.length + ' expense(s) could not sync — will retry next time', 'warn');
    }
  } else if (queue.length) {
    console.log('[StayOps] All queued expenses synced successfully');
    if (typeof globalThis.showBanner === 'function') {
      globalThis.showBanner('✓ ' + queue.length + ' previously-queued expense(s) synced', 'ok');
    }
  }
}

export async function saveExpenseToCloud(expense) {
  try {
    const user = await getCurrentSupabaseUser();
    if (!user || !expense) return;
    const propertyId = await getCloudPropertyId();
    const payload = {
      user_id:      user.id,
      property_id:  propertyId || null,
      local_id:     String(expense.id),
      date:         expense.date        || null,
      merchant:     expense.merchant    || '',
      description:  expense.description || '',
      category:     expense.category    || '',
      amount:       Number(expense.amount) || 0,
      receipt_num:  expense.receiptNum  || '',
      receipt_type: expense.receiptType || '',
      drive_link:   Array.isArray(expense.driveLink) && expense.driveLink.length
        ? JSON.stringify(expense.driveLink)
        : (typeof expense.driveLink === 'string' && expense.driveLink ? expense.driveLink : ''),
      booking_id:   expense.bookingId || null,
      // Phase 0 finance scaffolding (nullable / safe defaults in DB):
      tax_note:                 expense.taxNote || null,
      paid_by:                  expense.paidBy || 'host',
      recoverable_from_owner:   expense.recoverableFromOwner === true,
      updated_at:   new Date().toISOString()
    };
    if (expense._cloudId) {
      const { data, error } = await window._sb
        .from('expenses')
        .upsert({ id: expense._cloudId, ...payload })
        .select().single();
      if (error) {
        console.warn('[StayOps] saveExpenseToCloud upsert(by id) error', error);
        _queueExpenseForRetry(expense);
        if (typeof globalThis.showBanner === 'function') {
          globalThis.showBanner('⚠ Expense changes queued — cloud sync will retry', 'warn');
        }
        return null;
      }
      return data || expense;
    } else {
      const { data, error } = await window._sb
        .from('expenses')
        .upsert(payload, { onConflict: 'local_id,user_id' })
        .select().single();
      if (error) {
        console.warn('[StayOps] saveExpenseToCloud upsert(by local_id) error', error);
        _queueExpenseForRetry(expense);
        if (typeof globalThis.showBanner === 'function') {
          globalThis.showBanner('⚠ Expense saved locally — cloud sync will retry', 'warn');
        }
        return null;
      }
      if (data) expense._cloudId = data.id;
      return data;
    }
  } catch (e) {
    console.warn('[StayOps] saveExpenseToCloud failed', e);
    _queueExpenseForRetry(expense);
    if (typeof globalThis.showBanner === 'function') {
      globalThis.showBanner('⚠ Expense saved locally — cloud sync will retry', 'warn');
    }
    return null;
  }
}


export async function deleteExpenseFromCloud(expense) {
  const user = await getCurrentSupabaseUser();
  if (!user || !expense) return { ok: true, noUser: true };
  const builder = expense._cloudId
    ? window._sb.from('expenses').delete().eq('id', expense._cloudId)
    : window._sb.from('expenses').delete().eq('user_id', user.id).eq('local_id', String(expense.id));
  return sbWrite(builder, { label: 'expense removal' });
}




