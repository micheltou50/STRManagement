/**
 * StayOps — finance, expenses, reports, invoices (Pass 7).
 */
import {
  getPropertyConfig,
  getCurrentPropertyName,
  getActivePropertyId,
  getActivePropertyConfig,
  savePropertyConfig,
  getAllProperties,
} from './config.js';
import {
  parseCSV,
  parseBankFileWithAI,
  categoriseTransactions,
  checkDuplicates,
  confirmTransaction,
  skipTransaction,
  logImportSession,
} from './bank-import.js';
import { findMatchesForTransaction, getReconciliationSummary, getAllTransactionsWithStatus, findPayoutMatchesForBankTransaction, linkTransactionToPayout, setTransactionClassification } from './reconciliation.js';
import { bookings, cleans, expenses, replaceArrayInPlace } from './state.js';
import { escHtml, fmt, fmt2, fyLabel, fyMonths, escapeJsSingleQuotedHtmlAttr, fadeTransition, localDateStr } from './utils.js';
import { renderPortfolioFinance, isPortfolioMode } from './property.js';
import {
  clearExpensePhoto,
  clearExpensePhoto2,
  getExpensePhotoUploadSnapshot,
  getExpensePhoto2UploadSnapshot,
  isExpensePhotoConverting,
} from './ai.js';
import { uploadReceiptToStorage, getReceiptViewUrl, saveExpenseToCloud, deleteExpenseFromCloud, getCurrentSupabaseUser, savePlatformPayout, insertPayoutLines } from './supabase.js';
import { AIService } from './ai-logic.js';
import {
  bookingRevenue,
  bookingCleaningFee,
  bookingMgmtFee,
  bookingMgmtPayout,
  bookingNetPayout,
  isRevenueBearingBooking,
} from './booking-revenue.js';

/**
 * Normalize a booking's platform field to a stable canonical name. Real
 * data has both "Airbnb" and "airbnb", "vrbo" and "VRBO", etc — because
 * iCal sync writes lowercase and the manual-add UI writes title-case.
 * Without this normaliser, lookups against ['Airbnb','VRBO','Direct']
 * silently mis-bucket the lowercase rows into 'Direct', inflating that
 * column in tax/finance reports.
 */
function _canonicalPlatformName(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return 'Direct';
  if (s === 'airbnb' || s === 'air bnb' || s === 'ab') return 'Airbnb';
  if (s === 'vrbo' || s === 'homeaway' || s === 'home away') return 'VRBO';
  if (s === 'booking' || s === 'booking.com' || s === 'bookingcom' || s === 'booking_com') return 'Booking.com';
  if (s === 'stayz') return 'Stayz';
  if (s === 'direct' || s === 'direct booking' || s === 'website') return 'Direct';
  // Unknown platform — keep its original spelling so the user can see it
  // and rename, rather than silently bucketing into Direct.
  return String(raw).trim();
}

let _financeTab = 'expenses';
/** Keeps Finance hub vs sub-screens across renderFinance() / sync refresh. */
let financeSubView = 'hub';
let financeReportsMainTab = 'payouts';
let financeReportsPeriodTab = 'monthly';
/** @type {'cat'|'receipt'|'date'|null} */
let _expFilterDropdownKind = null;
let _expShowOlderMonths = false;

const FINANCE_CATEGORY_COLOR_MAP = {
  'Cleaning & Garden': '#1D9E75',
  'Utilities & Rates': '#D4A017',
  'Furnishings & Equipment': '#534AB7',
  Insurance: '#185FA5',
  'Supplies & Consumables': '#1D9E75',
  'Professional Services': '#378ADD',
  'Maintenance & Repairs': '#993C1D',
  Renovation: '#D85A30',
  Mortgage: '#7B1FA2',
  'Council Rates': '#C17F3E',
  Strata: '#5D4E37',
  Advertising: '#0277BD',
  Linen: '#00897B',
  Gardening: '#2E7D32',
  'Pest Control': '#E65100',
  Other: '#888780',
};
const FINANCE_CATEGORY_COLOR_FALLBACK = [
  '#1D9E75',
  '#D4A017',
  '#534AB7',
  '#185FA5',
  '#378ADD',
  '#993C1D',
  '#D85A30',
  '#888780',
];

/* ── ATO Tax Category Mapping (Phase 1A) ──────────────────────────────────── */
const ATO_CATEGORY_MAP = {
  // Current default categories — MUST stay in sync with DEFAULT_EXPENSE_CATS, or
  // the ATO export silently dumps council rates / mortgage / utilities /
  // advertising into "Sundry" on a tax document (report 1.18).
  'Cleaning & Garden':       'cleaning',
  'Maintenance & Repairs':   'repairs',
  'Supplies & Consumables':  'sundry',
  'Utilities':               'water_rates',
  'Council Rates & Strata':  'council_rates',
  'Insurance':               'insurance',
  'Mortgage':                'interest',
  'Furnishings & Linen':     'depreciation',
  'Professional Services':   'accounting_legal',
  'Advertising':             'advertising',
  'Other':                   'sundry',
  // Legacy category names kept for back-compat with older saved expenses.
  'Utilities & Rates':       'water_rates',
  'Furnishings & Equipment': 'depreciation',
  'Renovation':              'capital_works',
};

const ATO_FIELD_LABELS = {
  advertising:      'Advertising',
  body_corporate:   'Body Corporate',
  borrowing:        'Borrowing Expenses',
  cleaning:         'Cleaning',
  council_rates:    'Council Rates',
  capital_works:    'Capital Works',
  depreciation:     'Depreciation',
  gardening:        'Gardening',
  insurance:        'Insurance',
  interest:         'Interest on Loans',
  land_tax:         'Land Tax',
  legal:            'Legal Fees',
  accounting_legal: 'Accounting & Legal',
  pest_control:     'Pest Control',
  repairs:          'Repairs & Maintenance',
  stationery:       'Stationery & Postage',
  travel:           'Travel',
  water_rates:      'Water & Rates',
  sundry:           'Sundry / Other'
};

function getAtoField(category) {
  if (!category) return 'sundry';
  if (ATO_CATEGORY_MAP[category]) return ATO_CATEGORY_MAP[category];
  // Strip a "Parent > Sub" suffix and try the parent (e.g. "Mortgage > Interest").
  const parent = String(category).split('>')[0].trim();
  return ATO_CATEGORY_MAP[parent] || 'sundry';
}

function getAtoFieldLabel(category) {
  return ATO_FIELD_LABELS[getAtoField(category)] || 'Sundry / Other';
}

function _finPad2(n) {
  return String(n).padStart(2, '0');
}

function _bookingPropertyId(b) {
  return String((b && (b.propertyId || b._propertyId || b.property_id)) || '');
}

function _expensePropertyId(e) {
  return String((e && (e.propertyId || e._propertyId || e.property_id)) || '');
}

function _financeActiveCloudPropertyId() {
  const cloudIds = window._cloudPropertyIds || {};
  const cfg = getActivePropertyConfig ? (getActivePropertyConfig() || {}) : {};
  return String(cloudIds[getActivePropertyId?.()] || cloudIds[cfg.propertyId] || cfg.supabaseId || '');
}

function _financeScopedBookings() {
  const all = Array.isArray(bookings) ? bookings : [];
  if (isPortfolioMode()) return all;
  const activePid = _financeActiveCloudPropertyId();
  if (!activePid) return all;
  return all.filter((b) => _bookingPropertyId(b) === activePid);
}

function _financeScopedExpenses() {
  const all = Array.isArray(expenses) ? expenses : [];
  if (isPortfolioMode()) return all;
  const activePid = _financeActiveCloudPropertyId();
  if (!activePid) return all;
  return all.filter((e) => _expensePropertyId(e) === activePid);
}

/** Left border + category text colour for expense rows */
export function getCategoryColor(categoryName) {
  const name = categoryName || 'Other';
  if (FINANCE_CATEGORY_COLOR_MAP[name]) return FINANCE_CATEGORY_COLOR_MAP[name];
  const cats = getExpenseCats();
  const i = cats.indexOf(name);
  const idx = i >= 0 ? i : 0;
  return FINANCE_CATEGORY_COLOR_FALLBACK[idx % FINANCE_CATEGORY_COLOR_FALLBACK.length];
}

// ── BANK CSV IMPORT (review UI) ───────────────────────────────────────────────
let _bankImportReviewActive = false;
let _bankImportBackupHtml = null;
/** 'single' = finance-expenses-view, 'portfolio' = portfolio-finance */
let _bankImportViewMode = 'single';
let _bankImportRows = [];
let _bankImportFilename = '';
let _bankImportCreatedExpenseIds = [];
let _bankImportJustImported = false;

function bankImportGetContainer() {
  if (_bankImportViewMode === 'portfolio') {
    return document.getElementById('portfolio-finance');
  }
  return document.getElementById('finance-expenses-view');
}

function getOrCreateBankCsvFileInput() {
  let input = document.getElementById('bank-csv-file-input');
  if (input) return input;
  input = document.createElement('input');
  input.type = 'file';
  input.id = 'bank-csv-file-input';
  // Phase 2c+: also accept PDFs and images. The handler branches on type
  // and routes PDF/image files through Claude vision (parseBankFileWithAI)
  // instead of the synchronous CSV parser.
  input.accept = '.csv,text/csv,application/pdf,image/*';
  input.style.display = 'none';
  input.onchange = (ev) => bankImportOnFileSelected(ev);
  document.body.appendChild(input);
  console.log('[StayOps] Bank import: created shared file input (CSV + PDF + image)');
  return input;
}

const BANK_IMPORT_EXPENSE_CATS = [
  'cleaning',
  'maintenance',
  'supplies',
  'utilities',
  'insurance',
  'council_rates',
  'strata',
  'mortgage',
  'advertising',
  'furniture',
  'linen',
  'gardening',
  'pest_control',
  'accounting',
  'other',
];

function bankImportFormatCategoryLabel(cat) {
  return String(cat || '')
    .split('_')
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : ''))
    .join(' ');
}

function bankImportFmtDayMon(dateStr) {
  const d = new Date(String(dateStr || '').slice(0, 10) + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

function bankImportTruncate(s, n) {
  const t = String(s || '');
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

/** After categorisation, resolve invoice match hints for review UI. */
async function bankImportApplyMatchPreviews(rows, userId) {
  if (!userId) return;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.isDuplicate) continue;
    if (r.skip && r.reason === 'personal') continue;
    try {
      const matches = await findMatchesForTransaction(r, userId);
      const top = matches[0];
      if (top && top.score >= 80) {
        r._bankMatchPreview = { level: 'high', expense: top.expense };
        r._bankMatchLocked = true;
        const ex = top.expense;
        if (ex.property_id) r.propertyId = String(ex.property_id);
        if (ex.category != null && String(ex.category).trim()) {
          // Normalize display-name categories to snake_case dropdown values
          const catMap = { 'cleaning & garden': 'cleaning', 'maintenance & repairs': 'maintenance', 'supplies & consumables': 'supplies', 'utilities & rates': 'utilities', 'furnishings & equipment': 'furniture', 'professional services': 'accounting', 'renovation': 'maintenance', 'council rates': 'council_rates', 'pest control': 'pest_control' };
          const lower = String(ex.category).trim().toLowerCase();
          r.category = catMap[lower] || BANK_IMPORT_EXPENSE_CATS.find(c => c === lower) || String(ex.category);
        }
        r.uiConfirmed = true;
      } else if (top && top.score >= 50 && top.score < 80) {
        r._bankMatchPreview = { level: 'medium', expense: top.expense };
        r._bankMatchLocked = false;
      }
    } catch (err) {
      console.log('[StayOps] Bank import match preview failed:', err && err.message ? err.message : err);
    }
  }
}

function bankImportMatchStripHtml(row) {
  const pr = row && row._bankMatchPreview;
  if (!pr || !pr.expense) return '';
  const ex = pr.expense;
  const label = escHtml(
    bankImportTruncate((ex.vendor && String(ex.vendor).trim()) || ex.description || 'Expense', 40)
  );
  const d = bankImportFmtDayMon(ex.date);
  const amt = '$' + Number(ex.amount || 0).toFixed(2);
  const idx = _bankImportRows.indexOf(row);
  const dismissBtn = idx >= 0 ? `<button onclick="event.stopPropagation();globalThis.bankImportDismissMatch(${idx})" style="flex-shrink:0;border:none;background:none;font-size:14px;cursor:pointer;color:inherit;opacity:0.6;padding:0 2px" title="Dismiss match">✕</button>` : '';
  if (pr.level === 'high') {
    return `<div style="font-size:12px;font-weight:600;color:#14532d;background:#dcfce7;padding:8px 10px;border-radius:8px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center"><span>Matches: ${label} on ${escHtml(d)} · ${escHtml(amt)}</span>${dismissBtn}</div>`;
  }
  if (pr.level === 'medium') {
    return `<div style="font-size:12px;font-weight:600;color:#92400e;background:#fef3c7;padding:8px 10px;border-radius:8px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center"><span>Possible match: ${label} · ${escHtml(amt)}</span>${dismissBtn}</div>`;
  }
  return '';
}

function ensureFinanceReconciliationSummaryEl() {
  let el = document.getElementById('finance-reconciliation-summary');
  if (el) return el;
  const parent = document.getElementById('finance-expenses-view');
  if (!parent) return null;
  const anchor = document.getElementById('expenses-main-block') || document.getElementById('expenses-list');
  el = document.createElement('div');
  el.id = 'finance-reconciliation-summary';
  el.style.cssText =
    'margin:10px 0 0;padding:0 16px 8px;font-size:13px;color:var(--muted-2);line-height:1.45;display:none;font-family:\'Plus Jakarta Sans\',sans-serif';
  if (anchor && anchor.parentNode === parent) {
    anchor.insertAdjacentElement('afterend', el);
  } else {
    parent.appendChild(el);
  }
  return el;
}

async function refreshFinanceReconciliationSummary() {
  const el = ensureFinanceReconciliationSummaryEl();
  if (!el) return;
  const userId = window._supabaseUser && window._supabaseUser.id;
  const sb = window._sb;
  if (!userId || !sb) {
    el.style.display = 'none';
    return;
  }
  try {
    const { count: bankCnt, error: cErr } = await sb
      .from('bank_transactions')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);
    if (cErr) {
      console.log('[StayOps] refreshFinanceReconciliationSummary bank count error:', cErr.message || cErr);
      el.style.display = 'none';
      return;
    }
    if (!bankCnt) {
      el.style.display = 'none';
      return;
    }
    const sum = await getReconciliationSummary(userId);
    el.textContent =
      sum.reconciled +
      ' reconciled · ' +
      sum.unpaid +
      ' awaiting payment · ' +
      sum.unmatchedTransactions +
      ' unmatched transactions';
    el.style.display = 'block';
  } catch (e) {
    console.log('[StayOps] refreshFinanceReconciliationSummary:', e && e.message ? e.message : e);
    el.style.display = 'none';
  }
}

function ensureBankImportToolbar() {
  if (document.getElementById('exp-bank-import-link')) {
    getOrCreateBankCsvFileInput();
    return;
  }
  const listEl = document.getElementById('expenses-list');
  if (!listEl || _bankImportReviewActive) return;
  const card = listEl.closest('.card');
  const header = card && card.querySelector(':scope > div:first-child');
  if (!header) return;
  if (document.getElementById('bank-import-trigger-btn')) return;
  const titleRow = header.querySelector('div[style*="justify-content:space-between"]');
  if (!titleRow) return;
  titleRow.style.flexWrap = 'wrap';
  titleRow.style.gap = '8px';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'bank-import-trigger-btn';
  btn.textContent = 'Import Bank Statement';
  btn.style.cssText =
    "font-size:12px;color:var(--primary);background:transparent;border:1px solid var(--primary);border-radius:8px;padding:6px 12px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;font-weight:600;white-space:nowrap";
  btn.onclick = () => getOrCreateBankCsvFileInput().click();
  titleRow.appendChild(btn);
  getOrCreateBankCsvFileInput();
}

function ensureBankImportToolbarPortfolio() {
  const root = document.getElementById('portfolio-finance');
  if (!root || _bankImportReviewActive) return;
  if (document.getElementById('bank-import-trigger-btn-portfolio')) return;
  const wrap = document.createElement('div');
  wrap.id = 'bank-import-portfolio-toolbar';
  wrap.style.cssText =
    'margin-bottom:12px;display:flex;justify-content:flex-end;align-items:center;padding:0 2px';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'bank-import-trigger-btn-portfolio';
  btn.textContent = 'Import Bank Statement';
  btn.style.cssText =
    "font-size:12px;color:var(--primary);background:transparent;border:1px solid var(--primary);border-radius:8px;padding:6px 12px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;font-weight:600;white-space:nowrap";
  btn.onclick = () => getOrCreateBankCsvFileInput().click();
  wrap.appendChild(btn);
  root.insertBefore(wrap, root.firstChild);
  getOrCreateBankCsvFileInput();
}

function exitBankImportReview() {
  const container = bankImportGetContainer();
  if (container && _bankImportBackupHtml != null) {
    container.innerHTML = _bankImportBackupHtml;
    _bankImportBackupHtml = null;
  }
  _bankImportReviewActive = false;
  _bankImportRows = [];
  _bankImportFilename = '';
  const wasPortfolio = _bankImportViewMode === 'portfolio';
  _bankImportViewMode = 'single';
  if (wasPortfolio) {
    ensureBankImportToolbarPortfolio();
  } else {
    renderExpenses();
  }
}

/**
 * Bulk action: mark every reviewable row in _bankImportRows as user-skipped.
 * Rows that are locked to an existing expense match (_bankMatchLocked) are
 * left alone — they're already known good and don't need skipping. Re-renders
 * the review list with everything greyed out, so the user can then either
 * Cancel Import or selectively Undo a few rows to keep.
 */
function bankImportSkipAll() {
  if (!Array.isArray(_bankImportRows) || !_bankImportRows.length) return;
  const skippable = _bankImportRows.filter(r => !r._bankMatchLocked);
  if (!skippable.length) {
    if (typeof globalThis.showBanner === 'function') {
      globalThis.showBanner('Nothing to skip — all rows are locked matches', 'warn');
    }
    return;
  }
  for (const r of skippable) {
    r.userMarkedSkip = true;
    r.uiConfirmed = true;
  }
  renderBankImportReview();
  if (typeof globalThis.showBanner === 'function') {
    globalThis.showBanner('✓ Marked ' + skippable.length + ' rows to skip — click Cancel Import to discard, or Undo on individual rows to keep', 'ok');
  }
}
globalThis.bankImportSkipAll = bankImportSkipAll;

/**
 * Bulk action: abandon the entire import session and return to Expenses
 * without writing anything to the DB. Wraps exitBankImportReview with a
 * confirm prompt so the user doesn't lose state by accident.
 */
async function bankImportCancel() {
  const n = (_bankImportRows || []).length;
  const msg = 'Cancel this import? ' + n + ' row' + (n === 1 ? '' : 's') + ' will be discarded — nothing saved to your books.';
  let ok = false;
  if (typeof globalThis.showAppModal === 'function') {
    ok = await globalThis.showAppModal({
      title: 'Cancel Import',
      msg,
      confirmText: 'Cancel Import',
      confirmColor: 'var(--red)',
    });
  } else {
    ok = window.confirm(msg);
  }
  if (!ok) return;
  exitBankImportReview();
  if (typeof globalThis.showBanner === 'function') {
    globalThis.showBanner('Import cancelled — no transactions saved', 'ok');
  }
}
globalThis.bankImportCancel = bankImportCancel;

function bankImportRestoreBackup() {
  const container = bankImportGetContainer();
  if (container && _bankImportBackupHtml != null) {
    container.innerHTML = _bankImportBackupHtml;
    _bankImportBackupHtml = null;
  }
  _bankImportReviewActive = false;
  _bankImportRows = [];
  const wasPortfolio = _bankImportViewMode === 'portfolio';
  _bankImportViewMode = 'single';
  if (wasPortfolio) {
    ensureBankImportToolbarPortfolio();
  } else {
    renderExpenses();
  }
}

function bankImportShowLoading() {
  const container = bankImportGetContainer();
  if (!container) return;
  if (_bankImportBackupHtml == null) {
    _bankImportBackupHtml = container.innerHTML;
  }
  container.innerHTML = `
    <div class="settings-back" onclick="globalThis.bankImportCancelLoad()">‹ Finance</div>
    <div class="card" style="margin:20px 16px;padding:24px;text-align:center">
      <div style="font-size:15px;font-weight:600;margin-bottom:8px;color:var(--primary)">Analysing transactions…</div>
      <div style="font-size:13px;color:var(--muted-2)">Please wait while we check for duplicates and categorise entries.</div>
    </div>`;
}

function canBankImportRow(r) {
  if (r.skip && r.reason === 'personal') return false;
  if (r.userMarkedSkip) return false;
  if (r.userMarkedPersonal) return false;
  if (r.isDuplicate) return false;
  const pid = String(r.propertyId || '').trim();
  const cat = String(r.category || '').trim();
  if (!pid || !cat) return false;
  return true;
}

/** True if user confirmed (e.g. changed a dropdown) but property is still empty — blocks bulk import. */
function bankImportHasConfirmedWithoutProperty() {
  return _bankImportRows.some((r) => {
    if (r.skip && r.reason === 'personal') return false;
    if (r.userMarkedSkip) return false;
    if (!r.uiConfirmed) return false;
    const pid = String(r.propertyId || '').trim();
    return !pid;
  });
}

function bankImportSummaryCounts() {
  let ready = 0;
  let skipped = 0;
  let dups = 0;
  let autoPersonal = 0;
  _bankImportRows.forEach((r) => {
    if (r.isDuplicate) dups++;
    if (r.skip && r.reason === 'personal') {
      autoPersonal++;
      skipped++;
    } else if (r.userMarkedSkip || r.userMarkedPersonal) {
      skipped++;
    }
    if (canBankImportRow(r)) ready++;
  });
  return { ready, skipped, dups, autoPersonal, total: _bankImportRows.length };
}

function renderBankImportReview() {
  const container = bankImportGetContainer();
  if (!container) return;
  const { ready, skipped, dups, autoPersonal, total } = bankImportSummaryCounts();
  const _importBlocked = ready < 1 || bankImportHasConfirmedWithoutProperty();
  const props = getAllProperties() || [];
  const propOptions =
    '<option value="">— Select property —</option>' +
    '<option value="__skip__">Skip</option>' +
    props
      .map((p) => {
        const uuid = p.supabaseId || '';
        if (!uuid) return '';
        const nm = escHtml(p.name || 'Property');
        return `<option value="${uuid}">${nm}</option>`;
      })
      .join('');
  const catOptions = BANK_IMPORT_EXPENSE_CATS.map(
    (c) => `<option value="${c}">${escHtml(bankImportFormatCategoryLabel(c))}</option>`
  ).join('');

  const allDupOrPersonal =
    _bankImportRows.length &&
    _bankImportRows.every((t) => t.isDuplicate || (t.skip && t.reason === 'personal'));

  if (allDupOrPersonal) {
    container.innerHTML = `
      <div class="settings-back" onclick="globalThis.exitBankImportReview()">‹ Finance</div>
      <div class="card" style="margin:16px;padding:24px;text-align:center">
        <div style="font-size:15px;font-weight:600;margin-bottom:10px">All transactions already imported or marked as personal.</div>
        <button type="button" onclick="globalThis.exitBankImportReview()" class="btn-primary" style="margin-top:8px">Back to Finance</button>
      </div>`;
    return;
  }

  const headerHtml = `
    <div class="settings-back" onclick="globalThis.exitBankImportReview()">‹ Finance</div>
    <div style="padding:4px 16px 8px">
      <div style="font-family:inherit;font-size:16px;font-weight:500;color:var(--ink-1)">Review Transactions</div>
      <div style="font-size:13px;font-weight:400;color:#999;margin-top:4px">${total} transactions · ${autoPersonal} auto-skipped (personal)</div>
    </div>
    <div id="bank-import-sticky-summary" style="position:sticky;top:0;z-index:5;background:var(--color-background-primary,var(--surface2));padding:12px 16px;border-bottom:0.5px solid var(--border-tertiary,var(--hairline-1));margin-bottom:8px">
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between">
        <div style="font-size:13px;color:var(--text)">
          <strong>${ready}</strong> ready to import · <strong>${skipped}</strong> skipped · <strong>${dups}</strong> duplicates
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          <button type="button" onclick="globalThis.bankImportSkipAll()" style="font-size:12px;padding:8px 14px;border-radius:8px;border:1px solid var(--hairline-1);background:#fff;color:var(--muted-2);font-weight:600;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif">Skip All</button>
          <button type="button" onclick="globalThis.bankImportCancel()" style="font-size:12px;padding:8px 14px;border-radius:8px;border:1px solid #FCA5A5;background:#fff;color:#991B1B;font-weight:600;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif">Cancel Import</button>
          <button type="button" id="bank-import-run-btn" onclick="globalThis.bankImportRunImport()" style="font-size:12px;padding:8px 14px;border-radius:8px;border:none;background:var(--primary);color:white;font-weight:600;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif">Import All</button>
        </div>
      </div>
    </div>`;

  const cards = _bankImportRows
    .map((row, i) => {
      const isPersonal = !!(row.skip && row.reason === 'personal');
      const dup = !!row.isDuplicate;
      const matchLocked = !!(row._bankMatchLocked && !dup && !isPersonal);
      const greyed = isPersonal || row.userMarkedSkip;
      const hasValidProp =
        String(row.propertyId || '').trim() && String(row.propertyId || '').trim() !== '__skip__';
      const hasValidCat = String(row.category || '').trim();
      const confirmed =
        !!row.uiConfirmed &&
        hasValidProp &&
        hasValidCat &&
        !row.userMarkedSkip &&
        !isPersonal &&
        !row.userMarkedPersonal;
      let borderLeft = '0.5px solid var(--border-tertiary,var(--hairline-1))';
      if (confirmed && !dup) borderLeft = '3px solid var(--moss, #2d6a4f)';
      else if (dup) borderLeft = '3px solid #e67e22';

      let confDot = '#999';
      let confLabel = 'Unmatched';
      if (row.confidence === 'learned') {
        confDot = 'var(--moss, #2d6a4f)';
        confLabel = 'Remembered';
      } else if (row.confidence === 'ai') {
        confDot = '#2563eb';
        confLabel = 'AI suggested';
      }

      const amountStr = '$' + Number(row.amount || 0).toFixed(2);

      return `
        <div class="bank-import-card" data-idx="${i}" style="background:white;border:0.5px solid var(--border-tertiary,var(--hairline-1));border-radius:12px;padding:14px 16px;margin:0 16px 8px;opacity:${greyed ? 0.5 : 1};border-left:${borderLeft}">
          ${bankImportMatchStripHtml(row)}
          ${dup ? `<div style="font-size:12px;color:#b45309;background:#fff7ed;padding:8px 10px;border-radius:8px;margin-bottom:10px">Possible duplicate</div>` : ''}
          ${isPersonal ? `<div style="font-size:12px;font-weight:600;color:var(--muted-2);margin-bottom:8px">Personal — skipped</div>` : ''}
          <div style="display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:flex-start">
            <div style="flex:1;min-width:140px">
              <div style="font-size:13px;font-weight:600;color:var(--text)">${bankImportFmtDayMon(row.date)}</div>
              <div style="font-size:13px;color:var(--text);margin-top:4px;word-break:break-word;line-height:1.4">${escHtml(row.description || '')}</div>
              <div style="font-size:16px;font-weight:700;margin-top:8px;font-family:'Newsreader',serif">${amountStr}</div>
            </div>
            <div style="flex:1;min-width:200px;display:flex;flex-direction:column;gap:8px">
              <select id="bank-import-prop-${i}" onchange="globalThis.bankImportOnPropChange(${i})" ${isPersonal || matchLocked ? 'disabled' : ''}
                style="width:100%;box-sizing:border-box;font-size:13px;padding:8px 10px;border:1px solid var(--hairline-1);border-radius:8px;background:${matchLocked ? 'var(--hairline-2)' : 'var(--surface2)'};font-family:'Plus Jakarta Sans',sans-serif;color:${matchLocked ? 'var(--muted-2)' : 'inherit'}">
                ${propOptions}
              </select>
              <select id="bank-import-cat-${i}" onchange="globalThis.bankImportOnCatChange(${i})" ${isPersonal || matchLocked ? 'disabled' : ''}
                style="width:100%;box-sizing:border-box;font-size:13px;padding:8px 10px;border:1px solid var(--hairline-1);border-radius:8px;background:${matchLocked ? 'var(--hairline-2)' : 'var(--surface2)'};font-family:'Plus Jakarta Sans',sans-serif;color:${matchLocked ? 'var(--muted-2)' : 'inherit'}">
                <option value="">— Category —</option>
                ${catOptions}
              </select>
              <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted-2)">
                <span style="width:8px;height:8px;border-radius:50%;background:${confDot};flex-shrink:0"></span>
                <span>${confLabel}</span>
              </div>
              <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:4px">
                ${isPersonal || row.userMarkedSkip ? `<button type="button" onclick="globalThis.bankImportUndoSkip(${i})" style="font-size:12px;padding:6px 10px;border-radius:8px;border:1px solid var(--moss);color:var(--moss);background:#f0faf4;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif">Undo</button>` : `<button type="button" onclick="globalThis.bankImportSkipRow(${i})" style="font-size:12px;padding:6px 10px;border-radius:8px;border:1px solid var(--hairline-1);background:white;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif">Skip</button>
                <button type="button" onclick="globalThis.bankImportPersonalRow(${i})" style="font-size:12px;padding:6px 10px;border-radius:8px;border:1px solid var(--red);color:var(--red);background:#fff5f5;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif">Personal</button>`}
              </div>
            </div>
          </div>
        </div>`;
    })
    .join('');

  container.innerHTML = headerHtml + `<div id="bank-import-list">${cards}</div>`;

  _bankImportRows.forEach((row, i) => {
    const ps = document.getElementById('bank-import-prop-' + i);
    const cs = document.getElementById('bank-import-cat-' + i);
    if (ps) {
      const v = row.userMarkedSkip ? '__skip__' : String(row.propertyId || '');
      ps.value = v || '';
    }
    if (cs && row.category) cs.value = row.category;
  });
}

async function bankImportOnFileSelected(ev) {
  const file = ev.target && ev.target.files && ev.target.files[0];
  if (ev.target) ev.target.value = '';
  if (!file) return;
  const userId = window._supabaseUser && window._supabaseUser.id;
  if (!userId) {
    globalThis.showBanner('Sign in to import bank transactions', 'warn');
    return;
  }

  _bankImportViewMode =
    typeof isPortfolioMode === 'function' && isPortfolioMode() ? 'portfolio' : 'single';
  console.log(
    '[StayOps] Bank import:',
    file.name,
    '—',
    _bankImportViewMode === 'portfolio' ? 'portfolio (all properties)' : 'single-property'
  );

  // Branch on file type: text CSV uses the synchronous parser, PDF/image
  // goes through Claude vision via parseBankFileWithAI (returns the same row
  // shape so the downstream pipeline is unchanged).
  const lowerName = (file.name || '').toLowerCase();
  const mime = file.type || '';
  const isPdf   = mime === 'application/pdf' || lowerName.endsWith('.pdf');
  const isImage = mime.startsWith('image/');
  const useAI   = isPdf || isImage;

  const processParsed = async (parsed, sourceLabel) => {
    console.log('[StayOps] Bank import parsed:', parsed.length, 'rows from', sourceLabel);
    if (!parsed.length) {
      globalThis.showBanner(
        useAI
          ? 'AI did not find transactions in that file — try a clearer PDF/screenshot, or use a CSV export'
          : 'No expense transactions found — check the file format (CSV or tab-delimited)',
        'warn'
      );
      _bankImportViewMode =
        typeof isPortfolioMode === 'function' && isPortfolioMode() ? 'portfolio' : 'single';
      return;
    }

    bankImportShowLoading();
    try {
      console.log('[StayOps] Bank import: analysing', parsed.length, 'parsed rows');
      let rows = await checkDuplicates(parsed, userId);
      rows = await categoriseTransactions(rows, userId);
      rows = await checkDuplicates(rows, userId);

      const activePid = (() => {
        try {
          const cfg = getActivePropertyConfig && getActivePropertyConfig();
          return cfg && cfg.supabaseId ? String(cfg.supabaseId) : '';
        } catch (_) {
          return '';
        }
      })();

      const fromPortfolio = _bankImportViewMode === 'portfolio';
      _bankImportRows = rows.map((r) => ({
        ...r,
        propertyId: fromPortfolio ? (r.propertyId || '') : (activePid || r.propertyId || ''),
        category: r.category || '',
        uiConfirmed: false,
        userMarkedSkip: false,
        userMarkedPersonal: false,
      }));
      await bankImportApplyMatchPreviews(_bankImportRows, userId);
      _bankImportFilename = file.name || 'statement';
      _bankImportReviewActive = true;

      renderBankImportReview();
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.error('[StayOps] Bank import failed:', msg, err);
      globalThis.showBanner('Import error: ' + msg.slice(0, 80), 'warn');
      bankImportRestoreBackup();
    }
  };

  const reader = new FileReader();
  reader.onerror = () => {
    globalThis.showBanner('Could not read file', 'warn');
    bankImportRestoreBackup();
  };

  if (useAI) {
    globalThis.showBanner('⏳ Reading bank statement with AI — this can take 10-30 sec', 'info');
    reader.onload = async (e) => {
      const dataUrl = (e.target && e.target.result) ? String(e.target.result) : '';
      const commaIdx = dataUrl.indexOf(',');
      const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : '';
      const mediaType = isPdf ? 'application/pdf' : (mime || 'image/jpeg');
      let parsed = [];
      try {
        parsed = await parseBankFileWithAI(base64, mediaType);
      } catch (err) {
        console.error('[StayOps] parseBankFileWithAI threw:', err);
        globalThis.showBanner('AI extraction failed — see console', 'warn');
        return;
      }
      await processParsed(parsed, (isPdf ? 'PDF' : 'image') + ' via AI');
    };
    reader.readAsDataURL(file);
  } else {
    reader.onload = async (e) => {
      const fileText = e.target && e.target.result ? String(e.target.result) : '';
      const parsed = await parseCSV(fileText);
      await processParsed(parsed, fileText.length + ' chars of CSV');
    };
    reader.readAsText(file);
  }
}

function bankImportOnPropChange(i) {
  const row = _bankImportRows[i];
  if (!row) return;
  if (row._bankMatchLocked) return;
  const ps = document.getElementById('bank-import-prop-' + i);
  if (!ps) return;
  const v = ps.value;
  if (v === '__skip__') {
    row.userMarkedSkip = true;
    row.propertyId = '';
  } else {
    row.userMarkedSkip = false;
    row.propertyId = v;
  }
  row.uiConfirmed = true;
  renderBankImportReview();
}

function bankImportOnCatChange(i) {
  const row = _bankImportRows[i];
  if (!row) return;
  if (row._bankMatchLocked) return;
  const cs = document.getElementById('bank-import-cat-' + i);
  if (!cs) return;
  row.category = cs.value;
  row.uiConfirmed = true;
  renderBankImportReview();
}

function bankImportSkipRow(i) {
  const row = _bankImportRows[i];
  if (!row) return;
  row.userMarkedSkip = true;
  row.propertyId = '';
  renderBankImportReview();
}

async function bankImportPersonalRow(i) {
  const row = _bankImportRows[i];
  if (!row) return;
  const userId = window._supabaseUser && window._supabaseUser.id;
  row.userMarkedPersonal = true;
  row.userMarkedSkip = true;
  if (userId) {
    try {
      await skipTransaction(row, userId, true);
    } catch (err) {
      console.log('[StayOps] skipTransaction (personal) failed:', err && err.message ? err.message : err);
    }
  }
  renderBankImportReview();
}

async function bankImportUndoSkip(i) {
  const row = _bankImportRows[i];
  if (!row) return;
  row.userMarkedPersonal = false;
  row.userMarkedSkip = false;
  row.skip = false;
  row.reason = null;
  // Remove the is_personal flag from vendor_mappings so it won't auto-skip next time
  const userId = window._supabaseUser && window._supabaseUser.id;
  if (userId && window._sb) {
    const pattern = row.vendorPattern || row.vendor || '';
    if (pattern) {
      window._sb.from('vendor_mappings').update({ is_personal: false }).eq('user_id', userId).eq('vendor_pattern', pattern).then(() => {
        console.log('[StayOps] vendor_mapping is_personal cleared for', pattern);
      }).catch(e => console.warn("[StayOps] silent error:", e));
    }
  }
  renderBankImportReview();
  globalThis.showBanner('Row restored — ready to import', 'ok');
}
globalThis.bankImportUndoSkip = bankImportUndoSkip;

function bankImportDismissMatch(i) {
  const row = _bankImportRows[i];
  if (!row) return;
  row._bankMatchPreview = null;
  row._bankMatchLocked = false;
  row.uiConfirmed = false;
  renderBankImportReview();
  globalThis.showBanner('Match dismissed — assign property and category manually', 'ok');
}
globalThis.bankImportDismissMatch = bankImportDismissMatch;

function bankImportConfirmAllSuggested() {
  _bankImportRows.forEach((row) => {
    if (row.skip && row.reason === 'personal') return;
    if (row.isDuplicate) return;
    const hasProp = !!String(row.propertyId || '').trim();
    const hasCat = !!String(row.category || '').trim();
    const okLearned = row.confidence === 'learned';
    const okAiHigh = row.confidence === 'ai' && String(row.aiConfidence || '').toLowerCase() === 'high';
    if (row._bankMatchLocked && hasProp && hasCat) row.uiConfirmed = true;
    else if (hasProp && hasCat && (okLearned || okAiHigh)) row.uiConfirmed = true;
  });
  renderBankImportReview();
}

async function bankImportRunImport() {
  const userId = window._supabaseUser && window._supabaseUser.id;
  if (!userId) {
    globalThis.showBanner('Sign in to import', 'warn');
    return;
  }
  const toImport = _bankImportRows.map((r, i) => ({ r, i })).filter(({ r }) => canBankImportRow(r));
  if (!toImport.length) {
    globalThis.showBanner('Confirm property and category for at least one transaction', 'warn');
    return;
  }

  let imported = 0;
  let matchedCount = 0;
  let createdCount = 0;
  _bankImportCreatedExpenseIds = [];
  const duplicates = _bankImportRows.filter((r) => r.isDuplicate).length;

  try {
    for (let n = 0; n < toImport.length; n++) {
      const { r } = toImport[n];
      globalThis.showBanner('Importing ' + (n + 1) + ' of ' + toImport.length + '…', 'ok');
      try {
        const row = await confirmTransaction(r, userId, r.propertyId, r.category);
        if (row && row.action === 'matched') matchedCount++;
        else if (row && row.action === 'created') {
          createdCount++;
          if (row.expense && row.expense.id) _bankImportCreatedExpenseIds.push({ id: row.expense.id, description: r.description, amount: r.amount, date: r.date });
        }
        imported++;
        // Only mirror a NEWLY-CREATED debit expense into the in-memory array.
        // - action 'matched': the expense already lives in `expenses` (it was
        //   matched to it); pushing again double-counts totals/tax until reload.
        // - credit rows (Airbnb payouts / deposits → action 'matched_payout' or
        //   'credit_unmatched') carry no expense id/amount and must never be
        //   booked as an expense — they'd fall back to r.amount and persist a
        //   payout as a cost.
        if (row && row.action === 'created') {
          const local = {
            id: Date.now() + n,
            _cloudId: row.id,
            _propertyId: row.property_id,
            merchant: row.vendor || r.vendor || '',
            description: row.description || r.description || '',
            amount: Number(row.amount != null ? row.amount : r.amount),
            date: row.date || r.date,
            category: row.category || r.category,
            receiptType: 'missing',
            receiptNum: '',
            driveLink: '',
            photo: null,
          };
          expenses.push(local);
        }
      } catch (err) {
        console.log('[StayOps] confirmTransaction failed:', err && err.message ? err.message : err);
        globalThis.showBanner('Some rows failed to import — check console', 'warn');
      }
    }

    const skippedZ = bankImportSummaryCounts().skipped;

    try {
      globalThis.savePropertyData();
    } catch (_) { /* ignore if savePropertyData is not available */ }

    await logImportSession(userId, _bankImportFilename, {
      total: _bankImportRows.length,
      imported,
      skipped: Math.max(0, _bankImportRows.length - imported),
      duplicates,
    });

    globalThis.showBanner(
      matchedCount +
        ' matched to existing invoices · ' +
        createdCount +
        ' new expenses created · ' +
        skippedZ +
        ' skipped',
      'ok'
    );

    // Show receipt prompt for newly created expenses, then go to Transaction Map
    _bankImportJustImported = true;
    if (_bankImportCreatedExpenseIds.length) {
      setTimeout(() => _showBankImportReceiptPrompt(), 600);
    } else {
      // No new expenses — go straight to Transaction Map
      setTimeout(() => showReconciliationView(), 600);
    }
  } finally {
    exitBankImportReview();
  }
}
function _showBankImportReceiptPrompt() {
  const items = _bankImportCreatedExpenseIds;
  if (!items.length) return;
  const fmtAmt = (n) => '$' + Math.abs(Number(n || 0)).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const list = items.map((e, i) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;${i < items.length - 1 ? 'border-bottom:0.5px solid rgba(0,0,0,0.06)' : ''}">
      <div style="min-width:0;flex:1">
        <div style="font-size:13px;font-weight:500;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml((e.description || '').slice(0, 40))}</div>
        <div style="font-size:11px;color:var(--muted-2);margin-top:2px">${e.date ? fmt(e.date) : ''} · ${fmtAmt(e.amount)}</div>
      </div>
      <button onclick="document.getElementById('bank-receipt-prompt-overlay').style.display='none';document.body.style.overflow='';openExpenseEdit('${e.id}')" style="flex-shrink:0;margin-left:10px;padding:6px 12px;border-radius:8px;border:1.5px solid var(--primary);background:white;color:var(--primary);font-size:12px;font-weight:600;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif">Add Receipt</button>
    </div>`).join('');

  let overlay = document.getElementById('bank-receipt-prompt-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'bank-receipt-prompt-overlay';
    document.body.appendChild(overlay);
  }
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;background:rgba(0,0,0,0.4);display:flex;align-items:flex-end;justify-content:center';
  overlay.innerHTML = `
    <div style="background:white;border-radius:16px 16px 0 0;width:100%;max-width:500px;max-height:70vh;overflow-y:auto;padding:20px 16px env(safe-area-inset-bottom,0);animation:settingsPanelIn 0.28s cubic-bezier(0.32,0.72,0,1)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <div>
          <div style="font-size:15px;font-weight:700;color:var(--primary)">Add Receipts</div>
          <div style="font-size:12px;color:var(--muted-2);margin-top:2px">${items.length} expense${items.length !== 1 ? 's' : ''} created — attach receipts now or later</div>
        </div>
        <button onclick="document.getElementById('bank-receipt-prompt-overlay').style.display='none';document.body.style.overflow=''" style="width:28px;height:28px;border-radius:50%;border:none;background:var(--surface2);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--muted-2)">×</button>
      </div>
      ${list}
      <button onclick="document.getElementById('bank-receipt-prompt-overlay').style.display='none';document.body.style.overflow='';if(typeof showReconciliationView==='function')showReconciliationView()" style="width:100%;margin-top:14px;padding:12px;border-radius:10px;border:none;background:var(--primary);color:white;font-size:13px;font-weight:600;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif">View Transaction Map →</button>
    </div>`;
  document.body.style.overflow = 'hidden';
}

// ── FINANCE HUB NAVIGATION ───────────────────────────────────────────────────

/** Call when leaving the Finance tab (except when opening Settings from Finance). */
export function resetFinanceSubViewToHub() {
  financeSubView = 'hub';
}

function _syncFinanceNav(active) {
  const nav = document.getElementById('finance-desktop-nav');
  if (!nav) return;
  nav.querySelectorAll('.fin-nav-item').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-fin-nav') === active);
  });
}

/** Show the top-level Finance hub. Called on back-nav from any Finance sub-view. */
function backToFinanceHub() {
  financeSubView = 'hub';
  const pfin = document.getElementById('portfolio-finance');
  if (pfin) pfin.style.display = 'none';
  const finc = document.getElementById('finance-content');
  if (finc) finc.style.display = '';
  const hub = document.getElementById('finance-hub');
  if (hub) fadeTransition(hub, true);
  ['finance-expenses-view', 'finance-reports-view', 'finance-reconciliation-view', 'finance-recurring-view', 'finance-depreciation-view', 'finance-tax-export-view'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  renderFinanceHubCounts();
  _financeTab = null;
  _syncFinanceNav('hub');
}

function renderFinanceHubCounts() {
  const expEl = document.getElementById('finance-hub-count-expenses');
  const rptEl = document.getElementById('finance-hub-count-reports');
  const catEl = document.getElementById('finance-hub-count-cats');
  const priEl = document.getElementById('finance-hub-count-pricing');
  if (expEl) {
    const total = (expenses || []).length;
    const missing = (expenses || []).filter(e => Number(e.amount) > 0 && !expenseHasReceiptAttached(e)).length;
    expEl.innerHTML = total + ' items' + (missing ? ' <span style="display:inline-block;background:#D44;color:#fff;font-size:10px;font-weight:600;border-radius:8px;padding:1px 6px;margin-left:6px;vertical-align:middle">' + missing + ' no receipt</span>' : '');
  }
  if (rptEl) rptEl.textContent = '3 items';
  if (catEl) {
    try {
      const n = (getExpenseCats() || []).length;
      catEl.textContent = `${n} items`;
    } catch (_) {
      catEl.textContent = '0 items';
    }
  }
  if (priEl) priEl.textContent = 'AI';
  const recEl = document.getElementById('finance-hub-count-recurring');
  if (recEl) {
    try {
      const n = typeof globalThis.getRecurringTemplates === 'function' ? globalThis.getRecurringTemplates().length : 0;
      recEl.textContent = n ? n + ' template' + (n > 1 ? 's' : '') : 'Auto-generated expenses';
    } catch (_) {
      recEl.textContent = 'Auto-generated expenses';
    }
  }

  const recentMount = document.getElementById('finance-hub-recent');
  if (recentMount) {
    const sorted = [...(expenses || [])].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 3);
    if (sorted.length) {
      const fmtDate = d => { if (!d) return ''; const dt = new Date(d + 'T00:00:00'); return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };
      const cards = sorted.map(e => {
        const amt = Number(e.amount) || 0;
        const cat = e.category || 'Uncategorized';
        return `<div style="background:#fff;border-radius:14px;padding:12px;border:1px solid var(--hairline-1);display:flex;align-items:center;gap:12px">
          <div style="width:38px;height:38px;border-radius:10px;background:var(--surface2);display:flex;align-items:center;justify-content:center">
            <div style="width:8px;height:8px;border-radius:50%;background:var(--warn)"></div>
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13.5px;font-weight:600;color:var(--ink-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(e.description || e.merchant || 'Expense')}</div>
            <div style="font-size:11px;color:var(--muted-2);margin-top:2px">${escHtml(cat)} · ${fmtDate(e.date)}</div>
          </div>
          <div style="font-family:'Newsreader',serif;font-size:16px;font-weight:600;color:var(--warn);white-space:nowrap">−$${amt.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>`;
      }).join('');
      recentMount.innerHTML =
        `<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px">` +
        `<div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--muted-2);letter-spacing:1px;text-transform:uppercase">Recent</div>` +
        `<div onclick="showFinanceSub('expenses')" style="font-size:12px;color:var(--primary);font-weight:600;cursor:pointer">See all</div>` +
        `</div>` +
        `<div style="display:flex;flex-direction:column;gap:8px">${cards}</div>`;
    } else {
      recentMount.innerHTML = '';
    }
  }

  const heroNet = document.getElementById('finance-hero-net');
  const heroSub = document.getElementById('finance-hero-sub');
  if (heroNet) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const revenueThisMonth = (bookings || [])
      .filter(b => {
        const ci = new Date(b.checkin + 'T00:00:00');
        return !Number.isNaN(ci.getTime()) && ci >= monthStart && ci < monthEnd;
      })
      .reduce((s, b) => s + bookingRevenue(b), 0);
    const expensesThisMonth = (expenses || [])
      .filter(e => {
        const d = new Date((e.date || '') + 'T00:00:00');
        return !Number.isNaN(d.getTime()) && d >= monthStart && d < monthEnd;
      })
      .reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const net = revenueThisMonth - expensesThisMonth;
    heroNet.textContent = '$' + Math.round(net).toLocaleString();
  }
  if (heroSub) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const revenueThisMonth = (bookings || [])
      .filter(b => {
        const ci = new Date(b.checkin + 'T00:00:00');
        return !Number.isNaN(ci.getTime()) && ci >= monthStart && ci < monthEnd;
      })
      .reduce((s, b) => s + bookingRevenue(b), 0);
    const expensesThisMonth = (expenses || [])
      .filter(e => {
        const d = new Date((e.date || '') + 'T00:00:00');
        return !Number.isNaN(d.getTime()) && d >= monthStart && d < monthEnd;
      })
      .reduce((s, e) => s + (Number(e.amount) || 0), 0);
    heroSub.innerHTML =
      `<span>↑ $${Math.round(revenueThisMonth).toLocaleString()} earned</span>` +
      `<span>↓ $${Math.round(expensesThisMonth).toLocaleString()} spent</span>`;
  }
}

/** Toggle the Add Expense form panel open/closed. */
function toggleExpenseAddForm() {
  const panel   = document.getElementById('expense-add-form-panel');
  const chevron = document.getElementById('expense-add-chevron');
  if (!panel) return;
  const opening = panel.style.display === 'none';
  panel.style.display = opening ? 'block' : 'none';
  if (chevron) chevron.textContent = opening ? '∨' : '›';
  if (opening) {
    // Populate today's date when opening the form
    const expDateEl = document.getElementById('exp-date');
    if (expDateEl && !expDateEl.value) expDateEl.value = localDateStr();
    populateExpenseCatSelect();
    // Scroll the form into view
    setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  } else {
    // Collapsing without saving — discard any staged (unuploaded) receipts so
    // they don't linger into the next expense.
    clearExpensePhoto();
    clearExpensePhoto2();
  }
}

/** Close the Add Expense form panel (called after a successful save). */
function closeExpenseAddForm() {
  const panel   = document.getElementById('expense-add-form-panel');
  const chevron = document.getElementById('expense-add-chevron');
  if (panel)   panel.style.display = 'none';
  if (chevron) chevron.textContent = '›';
  const suggestCard = document.getElementById('exp-ai-suggest-card');
  if (suggestCard) suggestCard.style.display = 'none';
  // Discard any staged receipts that weren't attached to a saved expense.
  clearExpensePhoto();
  clearExpensePhoto2();
}

/** Navigate into a Finance sub-view (expenses, reports, reconciliation, or recurring). */
function showFinanceSub(sub) {
  if (sub === 'expenses') financeSubView = 'expenses';
  else if (sub === 'reports') financeSubView = 'reports';
  else if (sub === 'reconciliation') financeSubView = 'reconciliation';
  else if (sub === 'recurring') financeSubView = 'recurring';
  else if (sub === 'depreciation') financeSubView = 'depreciation';
  else if (sub === 'tax-export') financeSubView = 'tax-export';
  else if (sub === 'statement') financeSubView = 'statement';
  _financeTab = sub;
  _syncFinanceNav(sub);
  const hub = document.getElementById('finance-hub');
  if (hub) hub.style.display = 'none';
  ['finance-expenses-view', 'finance-reports-view', 'finance-reconciliation-view', 'finance-recurring-view', 'finance-depreciation-view', 'finance-tax-export-view', 'finance-statement-view'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  if (sub === 'expenses') {
    const el = document.getElementById('finance-expenses-view');
    if (el) fadeTransition(el, true);
    renderExpenses();
    populateExpenseCatSelect();
  } else if (sub === 'reconciliation') {
    showReconciliationView();
  } else if (sub === 'recurring') {
    showRecurringView();
  } else if (sub === 'depreciation') {
    showDepreciationView();
  } else if (sub === 'tax-export') {
    showTaxExportView();
  } else if (sub === 'statement') {
    const sEl = document.getElementById('finance-statement-view');
    if (sEl) fadeTransition(sEl, true);
    _renderStatement();
  } else if (sub === 'reports') {
    const el = document.getElementById('finance-reports-view');
    if (el) fadeTransition(el, true);
    ensureFinanceReportsSegBound();
    financeReportsMainTab = 'payouts';
    financeReportsPeriodTab = 'monthly';
    syncFinanceReportsMainUI();
    syncFinanceReportsPeriodUI();
    const pp = document.getElementById('fr-payouts-panel');
    const mp = document.getElementById('fr-mgmt-panel');
    if (pp) pp.style.display = '';
    if (mp) mp.style.display = 'none';
    const pm = document.getElementById('pay-monthly-view');
    const pf = document.getElementById('pay-fy-view');
    if (pm) pm.style.display = '';
    if (pf) pf.style.display = 'none';
    renderRevenue();
  }
}

function showRecurringView() {
  document.getElementById('finance-hub').style.display = 'none';
  fadeTransition(document.getElementById('finance-recurring-view'), true);
  if (typeof globalThis.renderRecurringPanel === 'function') globalThis.renderRecurringPanel();
  // Populate category dropdown
  const catSel = document.getElementById('rec-category');
  if (catSel) {
    catSel.innerHTML = '';
    getExpenseCats().forEach(c => {
      const o = document.createElement('option');
      o.value = c; o.textContent = c;
      catSel.appendChild(o);
    });
  }
}

function showDepreciationView() {
  document.getElementById('finance-hub').style.display = 'none';
  fadeTransition(document.getElementById('finance-depreciation-view'), true);
  if (typeof globalThis.renderDepreciationPanel === 'function') globalThis.renderDepreciationPanel();
  // Populate preset dropdown
  const presetSel = document.getElementById('dep-preset');
  if (presetSel && presetSel.options.length <= 1 && typeof globalThis.DEPRECIATION_PRESETS !== 'undefined') {
    globalThis.DEPRECIATION_PRESETS.forEach((p, i) => {
      const o = document.createElement('option');
      o.value = i;
      o.textContent = p.label + (p.usefulLife ? ' (' + p.usefulLife + ' yr)' : '');
      presetSel.appendChild(o);
    });
  }
}

function ensureFinanceReportsSegBound() {
  if (globalThis._finReportsSegBound) return;
  globalThis._finReportsSegBound = true;
  document.getElementById('fr-main-seg')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-fr-main]');
    if (!b) return;
    switchFinanceReportsMain(b.getAttribute('data-fr-main'));
  });
  document.getElementById('fr-period-seg')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-fr-period]');
    if (!b) return;
    switchFinanceReportsPeriod(b.getAttribute('data-fr-period'));
  });
}

function syncFinanceReportsMainUI() {
  document.querySelectorAll('#fr-main-seg .fin-seg-opt').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-fr-main') === financeReportsMainTab);
  });
}

function syncFinanceReportsPeriodUI() {
  document.querySelectorAll('#fr-period-seg .fin-seg-opt').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-fr-period') === financeReportsPeriodTab);
  });
}

function switchFinanceReportsMain(tab) {
  financeReportsMainTab = tab;
  syncFinanceReportsMainUI();
  const payPanel = document.getElementById('fr-payouts-panel');
  const mgmtPanel = document.getElementById('fr-mgmt-panel');
  if (payPanel) payPanel.style.display = tab === 'payouts' ? '' : 'none';
  if (mgmtPanel) mgmtPanel.style.display = tab === 'mgmt' ? '' : 'none';
  if (tab === 'mgmt') mgmtSelected.clear();
  switchFinanceReportsPeriod(financeReportsPeriodTab);
}

function switchFinanceReportsPeriod(sub) {
  financeReportsPeriodTab = sub;
  syncFinanceReportsPeriodUI();
  const isPay = financeReportsMainTab === 'payouts';
  if (isPay) {
    const mv = document.getElementById('pay-monthly-view');
    const fv = document.getElementById('pay-fy-view');
    if (mv) mv.style.display = sub === 'monthly' ? '' : 'none';
    if (fv) fv.style.display = sub === 'fy' ? '' : 'none';
    if (sub === 'monthly') renderRevenue();
    else renderReport();
  } else {
    const mm = document.getElementById('mgmt-monthly-view');
    const mf = document.getElementById('mgmt-fy-view');
    if (mm) mm.style.display = sub === 'monthly' ? '' : 'none';
    if (mf) mf.style.display = sub === 'fy' ? '' : 'none';
    mgmtSelected.clear();
    _mgmtFYSelectedMonths.clear();
    if (sub === 'monthly') renderManagement();
    else renderMgmtFY();
  }
}

/** @deprecated Legacy tabs — maps to Payouts / Management segmented UI */
function switchReportsSubTab(sub, _btn) {
  ensureFinanceReportsSegBound();
  if (sub === 'reports') {
    switchFinanceReportsMain('payouts');
    switchFinanceReportsPeriod('fy');
    return;
  }
  if (sub === 'payouts') switchFinanceReportsMain('payouts');
  if (sub === 'mgmt') switchFinanceReportsMain('mgmt');
}

/**
 * Open a Finance settings panel from the Finance hub.
 * Passes returnSection='finance' so the back button returns to Finance, not Settings.
 */
function openFinancePanelFromHub(panelId) {
  globalThis.openSettingsPanel(panelId, 'finance');
  if (panelId === 'expense-cats') { financeSubView = 'categories'; _syncFinanceNav('categories'); }
  else if (panelId === 'smart-pricing') { financeSubView = 'smartpricing'; _syncFinanceNav('smartpricing'); }
  else if (panelId === 'bank-details') { financeSubView = 'bankdetails'; _syncFinanceNav('bankdetails'); }
}

/**
 * switchFinanceTab — backward-compat shim.
 * Maps old tab names to the new hub navigation.
 */
function switchFinanceTab(tab, _btn) {
  _financeTab = tab;
  if (tab === 'expenses') { showFinanceSub('expenses'); return; }
  if (tab === 'reports')  { showFinanceSub('reports');  return; }
  // payouts and mgmt are now sub-tabs inside Reports
  if (tab === 'payouts' || tab === 'mgmt') {
    showFinanceSub('reports');
    switchFinanceReportsMain(tab);
    return;
  }
  // fallback — show hub
  backToFinanceHub();
}

function switchPayoutsSubTab(sub, _btn) {
  ensureFinanceReportsSegBound();
  switchFinanceReportsMain('payouts');
  switchFinanceReportsPeriod(sub);
}

function switchMgmtSubTab(sub, _btn) {
  ensureFinanceReportsSegBound();
  switchFinanceReportsMain('mgmt');
  switchFinanceReportsPeriod(sub);
}

// switchReportSubTab removed — Reports tab is now a single FY view with send buttons
function switchReportSubTab(_sub, _btn) {
  renderReport(); // always render the FY report
}

let _mgmtFYSelectedMonths = new Set();

function _mgmtFYMonthKey(year, month) { return year + '-' + month; }

function _mgmtFYGetMonthBookings(year, month) {
  return _financeScopedBookings().filter(b => {
    if (!isRevenueBearingBooking(b)) return false;
    const d = new Date(b.checkin);
    return d.getFullYear() === year && d.getMonth() === month;
  });
}

function _mgmtFYToggleMonth(year, month) {
  const key = _mgmtFYMonthKey(year, month);
  const invMap = _getBookingInvoiceMap();
  const bs = _mgmtFYGetMonthBookings(year, month).filter(b => !invMap.has(String(b.id)));
  if (!bs.length) return;
  if (_mgmtFYSelectedMonths.has(key)) {
    _mgmtFYSelectedMonths.delete(key);
    bs.forEach(b => mgmtSelected.delete(_mgmtBookingKey(b)));
  } else {
    _mgmtFYSelectedMonths.add(key);
    bs.forEach(b => mgmtSelected.add(_mgmtBookingKey(b)));
  }
  renderMgmtFY();
}

function renderMgmtFY() {
  const el = document.getElementById('mgmt-fy-content');
  if (!el) return;
  const months = fyMonths(reportFY);
  const mo = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const propertyBookings = _financeScopedBookings();
  const invMap = _getBookingInvoiceMap();
  const mdata = months.map(({year, month}) => {
    const bs = propertyBookings.filter(b => isRevenueBearingBooking(b) && (()=>{ const d=new Date(b.checkin); return d.getFullYear()===year&&d.getMonth()===month; })());
    const key = _mgmtFYMonthKey(year, month);
    const invoicedCount = bs.filter(b => invMap.has(String(b.id))).length;
    const uninvoicedCount = bs.length - invoicedCount;
    return { label: mo[month], year, month, key, total: bs.reduce((s,b)=>s+bookingMgmtPayout(b),0), count: bs.length, invoicedCount, uninvoicedCount, bookings: bs };
  });
  const fyTotal = mdata.reduce((s,m)=>s+m.total, 0);

  const selBookings = propertyBookings.filter(b => mgmtSelected.has(_mgmtBookingKey(b)));
  const selTotal = selBookings.reduce((s,b)=>s+bookingMgmtPayout(b),0);
  const hasSelection = selBookings.length > 0;

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <button type="button" onclick="fyPrev();_mgmtFYSelectedMonths.clear();mgmtSelected.clear();renderMgmtFY()" style="background:var(--hairline-2);border:none;border-radius:8px;width:32px;height:32px;font-size:16px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif">‹</button>
      <div style="font-size:15px;font-weight:500;color:var(--ink-1);font-family:'Plus Jakarta Sans',sans-serif">${fyLabel(reportFY)}</div>
      <button type="button" onclick="fyNext();_mgmtFYSelectedMonths.clear();mgmtSelected.clear();renderMgmtFY()" style="background:var(--hairline-2);border:none;border-radius:8px;width:32px;height:32px;font-size:16px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif">›</button>
    </div>
    <div style="text-align:center;padding:16px;background:#fff;border-radius:12px;margin-bottom:12px;border:0.5px solid rgba(0,0,0,0.08)">
      <div style="font-size:11px;color:var(--muted-2)">Total management payout</div>
      <div style="font-family:'Plus Jakarta Sans',sans-serif;font-size:28px;font-weight:500;color:var(--ink-1);margin-top:6px">$${fyTotal.toLocaleString('en-AU',{minimumFractionDigits:0,maximumFractionDigits:0})}</div>
    </div>
    <div style="font-size:11px;color:var(--muted-2);margin-bottom:8px;padding:0 2px">Tap months to select for invoice</div>
    <div style="background:#fff;border-radius:12px;padding:0 16px;border:0.5px solid rgba(0,0,0,0.08)">
      ${mdata.map(m => {
        const sel = _mgmtFYSelectedMonths.has(m.key);
        const allInvoiced = m.count > 0 && m.uninvoicedCount === 0;
        const hasSelectable = m.uninvoicedCount > 0;
        const subLabel = allInvoiced
          ? `${m.count} booking${m.count !== 1 ? 's' : ''} · All invoiced`
          : m.invoicedCount > 0
            ? `${m.uninvoicedCount} of ${m.count} available · ${m.invoicedCount} invoiced`
            : `${m.count} booking${m.count !== 1 ? 's' : ''}`;
        return `<div class="fin-rev-row mgmt-fy-month-row" data-year="${m.year}" data-month="${m.month}" style="cursor:${hasSelectable ? 'pointer' : 'default'};${allInvoiced ? 'opacity:0.45;' : ''}${sel ? 'background:var(--primary-soft,#dde8e1);margin:0 -16px;padding:12px 16px;' : ''}">
          <div style="display:flex;align-items:center;gap:10px">
            <span class="mgmt-fy-month-check" style="position:relative;display:inline-flex;width:20px;height:20px;flex-shrink:0">
              <span style="width:20px;height:20px;border:1.5px solid ${allInvoiced ? '#ddd' : sel ? '#2f5d4e' : '#C8C6BF'};border-radius:4px;background:${allInvoiced ? '#f0f0f0' : sel ? '#2f5d4e' : '#fff'};display:flex;align-items:center;justify-content:center;box-sizing:border-box">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="display:${sel ? 'block' : 'none'}"><polyline points="20 6 9 17 4 12"></polyline></svg>
              </span>
            </span>
            <div>
              <div style="font-size:14px;font-weight:500">${m.label}</div>
              <div style="font-size:11px;color:var(--muted-2);margin-top:2px">${subLabel}</div>
            </div>
          </div>
          <div style="font-size:14px;font-weight:500;color:${allInvoiced ? 'var(--muted-2)' : '#1D9E75'}">$${m.total.toLocaleString('en-AU',{minimumFractionDigits:0,maximumFractionDigits:0})}</div>
        </div>`;
      }).join('')}
    </div>
    <button type="button" id="mgmt-fy-gen-invoice-btn" ${hasSelection ? '' : 'disabled'}
      style="width:100%;background:var(--primary);color:#fff;border:none;border-radius:12px;padding:14px;font-size:14px;font-weight:500;font-family:'Plus Jakarta Sans',sans-serif;display:flex;justify-content:space-between;align-items:center;margin-top:12px;opacity:${hasSelection ? '1' : '0.4'};pointer-events:${hasSelection ? 'auto' : 'none'}">
      <span>Generate invoice</span>
      <span>${selBookings.length} selected · $${selTotal.toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
    </button>
    <div id="mgmt-fy-invoice-history" style="margin-top:16px"></div>`;

  el.querySelectorAll('.mgmt-fy-month-row').forEach(row => {
    row.addEventListener('click', () => {
      const yr = Number(row.dataset.year);
      const mo2 = Number(row.dataset.month);
      const bs = _mgmtFYGetMonthBookings(yr, mo2);
      if (!bs.length) return;
      _mgmtFYToggleMonth(yr, mo2);
    });
  });

  const invBtn = el.querySelector('#mgmt-fy-gen-invoice-btn');
  if (invBtn) invBtn.addEventListener('click', () => generateInvoice());

  renderInvoiceHistory('mgmt-fy-invoice-history');
}

function _restoreFinanceExpensesView() {
  const pfin = document.getElementById('portfolio-finance');
  if (pfin) pfin.style.display = 'none';
  const finc = document.getElementById('finance-content');
  if (finc) finc.style.display = '';
  const hub = document.getElementById('finance-hub');
  if (hub) hub.style.display = 'none';
  ['finance-expenses-view', 'finance-reports-view'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = id === 'finance-expenses-view' ? 'block' : 'none';
  });
  _financeTab = 'expenses';
  renderExpenses();
  populateExpenseCatSelect();
}

function _restoreFinanceReportsView() {
  const pfin = document.getElementById('portfolio-finance');
  if (pfin) pfin.style.display = 'none';
  const finc = document.getElementById('finance-content');
  if (finc) finc.style.display = '';
  const hub = document.getElementById('finance-hub');
  if (hub) hub.style.display = 'none';
  const ex = document.getElementById('finance-expenses-view');
  const rv = document.getElementById('finance-reports-view');
  if (ex) ex.style.display = 'none';
  if (rv) rv.style.display = 'block';
  _financeTab = 'reports';
  ensureFinanceReportsSegBound();
  syncFinanceReportsMainUI();
  syncFinanceReportsPeriodUI();
  const payPanel = document.getElementById('fr-payouts-panel');
  const mgmtPanel = document.getElementById('fr-mgmt-panel');
  if (payPanel) payPanel.style.display = financeReportsMainTab === 'payouts' ? '' : 'none';
  if (mgmtPanel) mgmtPanel.style.display = financeReportsMainTab === 'mgmt' ? '' : 'none';
  if (financeReportsMainTab === 'payouts') {
    const mv = document.getElementById('pay-monthly-view');
    const fv = document.getElementById('pay-fy-view');
    if (mv) mv.style.display = financeReportsPeriodTab === 'monthly' ? '' : 'none';
    if (fv) fv.style.display = financeReportsPeriodTab === 'fy' ? '' : 'none';
    if (financeReportsPeriodTab === 'monthly') renderRevenue();
    else renderReport();
  } else {
    const mm = document.getElementById('mgmt-monthly-view');
    const mf = document.getElementById('mgmt-fy-view');
    if (mm) mm.style.display = financeReportsPeriodTab === 'monthly' ? '' : 'none';
    if (mf) mf.style.display = financeReportsPeriodTab === 'fy' ? '' : 'none';
    if (financeReportsPeriodTab === 'monthly') renderManagement();
    else renderMgmtFY();
  }
}

function renderFinance() {
  if (isPortfolioMode()) {
    renderPortfolioFinance();
    ensureBankImportToolbarPortfolio();
    return;
  }
  const singleFin = document.getElementById('finance-content');
  const portfolioFin = document.getElementById('portfolio-finance');
  if (singleFin) singleFin.style.display = '';
  if (portfolioFin) portfolioFin.style.display = 'none';
  // Categories / smart pricing live under Settings; if we're on the Finance tab, show the hub.
  if (financeSubView === 'categories' || financeSubView === 'smartpricing') {
    financeSubView = 'hub';
  }
  if (financeSubView === 'hub') {
    backToFinanceHub();
  } else if (financeSubView === 'expenses') {
    _restoreFinanceExpensesView();
  } else if (financeSubView === 'reports') {
    _restoreFinanceReportsView();
  } else if (financeSubView === 'reconciliation') {
    showFinanceSub('reconciliation');
  } else if (financeSubView === 'tax-export') {
    showFinanceSub('tax-export');
  } else {
    backToFinanceHub();
  }
  renderFinanceHubCounts();
}

function switchRevTab(tab) {
  ensureFinanceReportsSegBound();
  switchFinanceReportsMain('payouts');
  switchFinanceReportsPeriod(tab === 'report' ? 'fy' : 'monthly');
}

// Financial Year helpers (Jul–Jun)
let reportFY = (() => {
  const now = new Date();
  return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
})();
function fyPrev() { reportFY--; renderReport(); }
function fyNext() { reportFY++; renderReport(); }

function renderReport() {
  const rptTitle = document.getElementById('rpt-fy-title');
  if (rptTitle) rptTitle.textContent = fyLabel(reportFY);
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const months = fyMonths(reportFY);
  const platforms = ['Airbnb','VRBO','Direct'];
  const expCats = getExpenseCats();

  const propertyBookings = _financeScopedBookings();
  const propertyExpenses = _financeScopedExpenses();

  // Helper: bookings in a given month
  function monthBookings(year, month) {
    return propertyBookings.filter(b => isRevenueBearingBooking(b) && (function(){ const d = new Date(b.checkin); return d.getFullYear()===year && d.getMonth()===month; })());
  }
  // Helper: expenses in FY — use live array, not stale localStorage read
  function fyExpenses() {
    return propertyExpenses.filter(e => {
      const d = new Date(e.date);
      const m = d.getMonth(); const y = d.getFullYear();
      return (y === reportFY && m >= 6) || (y === reportFY+1 && m <= 5);
    });
  }

  // Build monthly data
  const mdata = months.map(({year, month}) => {
    const bs = monthBookings(year, month);
    const availNights = new Date(year, month+1, 0).getDate();
    const bookedNights = bs.reduce((s,b) => s + Number(b.nights||0), 0);
    const revenue = bs.reduce((s,b) => s + bookingRevenue(b), 0);
    const netPayout = bs.reduce((s,b) => s + bookingNetPayout(b), 0);
    const platformRev = {};
    platforms.forEach(p => { platformRev[p] = bs.filter(b=>_canonicalPlatformName(b.platform)===p).reduce((s,b)=>s+bookingRevenue(b),0); });
    return { label: mo[month], year, month, bs, availNights, bookedNights, revenue, netPayout, platformRev, bookingCount: bs.length };
  });

  // FY totals
  const fyTotalRev = mdata.reduce((s,m)=>s+m.revenue,0);
  const fyTotalNet = mdata.reduce((s,m)=>s+m.netPayout,0);
  const fyTotalNights = mdata.reduce((s,m)=>s+m.bookedNights,0);
  const fyTotalAvail = mdata.reduce((s,m)=>s+m.availNights,0);
  const fyOccupancy = fyTotalAvail ? (fyTotalNights/fyTotalAvail*100) : 0;
  const fyADR = fyTotalNights ? fyTotalRev/fyTotalNights : 0;
  const fyRevPAR = fyTotalAvail ? fyTotalRev/fyTotalAvail : 0;
  const fyBookings = mdata.reduce((s,m)=>s+m.bookingCount,0);
  const fyALOS = fyBookings ? fyTotalNights/fyBookings : 0;

  // Expense data
  const allExp = fyExpenses();
  const expByCategory = {};
  expCats.forEach(c => { expByCategory[c] = allExp.filter(e=>e.category===c).reduce((s,e)=>s+Number(e.amount||0),0); });
  const fyTotalExp = allExp.reduce((s,e)=>s+Number(e.amount||0),0);
  const fyNetIncome = fyTotalNet - fyTotalExp;

  const _fmtPct = n => n ? (n*100).toFixed(0)+'%' : '—';
  const fmtDec = n => n ? '$'+n.toFixed(0) : '—';

  const html = `
  <div id="print-report">
    <!-- FY Navigator -->
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <button onclick="fyPrev()" style="background:var(--hairline-2);border:none;border-radius:8px;width:32px;height:32px;font-size:16px;cursor:pointer">‹</button>
        <div style="font-family:inherit;font-size:16px;font-weight:500;color:var(--ink-1)">${fyLabel(reportFY)}</div>
        <button onclick="fyNext()" style="background:var(--hairline-2);border:none;border-radius:8px;width:32px;height:32px;font-size:16px;cursor:pointer">›</button>
      </div>
      <div style="margin-top:12px" class="report-kpi-grid">
        <div class="report-kpi"><div class="report-kpi-val">${fmt2(fyTotalRev)}</div><div class="report-kpi-label">Total Revenue</div></div>
        <div class="report-kpi"><div class="report-kpi-val">${fmt2(fyTotalNet)}</div><div class="report-kpi-label">Owner Payout</div></div>
        <div class="report-kpi" style="background:${fyNetIncome>=0?'#EDF7ED':'#FEF2F2'}"><div class="report-kpi-val" style="color:${fyNetIncome>=0?'var(--primary)':'var(--red)'}">${fmt2(Math.abs(fyNetIncome))}</div><div class="report-kpi-label">Net Income ${fyNetIncome<0?'(Loss)':''}</div></div>
        <div class="report-kpi"><div class="report-kpi-val">${fyOccupancy.toFixed(0)}%</div><div class="report-kpi-label">Occupancy</div></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px">
        <button onclick="exportReportPDF()" class="no-print" style="background:var(--primary);color:white;border:none;border-radius:var(--radius-sm);padding:12px;font-size:14px;font-weight:600;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif">⬇ Export PDF</button>
        <button onclick="exportReportCSV()" class="no-print" style="background:var(--surface2);color:var(--primary);border:1.5px solid var(--primary);border-radius:var(--radius-sm);padding:12px;font-size:14px;font-weight:600;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif">⬇ Export CSV</button>
      </div>
    </div>

    <!-- Revenue by Month & Platform -->
    <div class="card" style="margin-bottom:12px;overflow-x:auto">
      <div class="report-section-title">Revenue by Month & Platform</div>
      <table class="report-table">
        <thead><tr>
          <th>Month</th><th>Airbnb</th><th>VRBO</th><th>Direct</th><th>Total</th>
        </tr></thead>
        <tbody>
          ${mdata.map(m => `<tr>
            <td>${m.label}</td>
            <td>${m.platformRev['Airbnb'] ? fmt2(m.platformRev['Airbnb']) : '—'}</td>
            <td>${m.platformRev['VRBO'] ? fmt2(m.platformRev['VRBO']) : '—'}</td>
            <td>${m.platformRev['Direct'] ? fmt2(m.platformRev['Direct']) : '—'}</td>
            <td>${m.revenue ? fmt2(m.revenue) : '—'}</td>
          </tr>`).join('')}
          <tr><td>Total</td>
            <td>${fmt2(mdata.reduce((s,m)=>s+m.platformRev['Airbnb'],0))}</td>
            <td>${fmt2(mdata.reduce((s,m)=>s+m.platformRev['VRBO'],0))}</td>
            <td>${fmt2(mdata.reduce((s,m)=>s+m.platformRev['Direct'],0))}</td>
            <td>${fmt2(fyTotalRev)}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Occupancy & ADR -->
    <div class="card" style="margin-bottom:12px;overflow-x:auto">
      <div class="report-section-title">Occupancy & Performance</div>
      <table class="report-table">
        <thead><tr>
          <th>Month</th><th>Avail</th><th>Booked</th><th>Occ%</th>
          <th>ADR <span class="no-print" title="Average Daily Rate — revenue per booked night" style="cursor:help;font-size:10px;opacity:0.7">ⓘ</span></th>
          <th>RevPAR <span class="no-print" title="Revenue Per Available Night — revenue divided by all available nights, including empty ones" style="cursor:help;font-size:10px;opacity:0.7">ⓘ</span></th>
        </tr></thead>
        <tbody>
          ${mdata.map(m => `<tr>
            <td>${m.label}</td>
            <td>${m.availNights}</td>
            <td>${m.bookedNights}</td>
            <td>${m.availNights ? (m.bookedNights/m.availNights*100).toFixed(0)+'%' : '—'}</td>
            <td>${m.bookedNights ? fmtDec(m.revenue/m.bookedNights) : '—'}</td>
            <td>${m.availNights ? fmtDec(m.revenue/m.availNights) : '—'}</td>
          </tr>`).join('')}
          <tr><td>FY Total</td>
            <td>${fyTotalAvail}</td>
            <td>${fyTotalNights}</td>
            <td>${fyOccupancy.toFixed(0)}%</td>
            <td>${fmtDec(fyADR)}</td>
            <td>${fmtDec(fyRevPAR)}</td>
          </tr>
        </tbody>
      </table>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px">
        <div style="font-size:11px;color:var(--muted-2);background:var(--hairline-2);padding:8px 10px;border-radius:var(--radius-sm)"><b>ALOS</b> ${fyALOS.toFixed(1)} nights avg</div>
        <div style="font-size:11px;color:var(--muted-2);background:var(--hairline-2);padding:8px 10px;border-radius:var(--radius-sm)"><b>Bookings</b> ${fyBookings} total</div>
      </div>
      <div style="margin-top:10px;font-size:11px;color:var(--muted-2);line-height:1.6;border-top:1px solid var(--hairline-2);padding-top:8px">
        <b>ADR</b> Average Daily Rate — revenue ÷ booked nights &nbsp;·&nbsp; <b>RevPAR</b> Revenue Per Available Night — revenue ÷ all available nights &nbsp;·&nbsp; <b>ALOS</b> Average Length of Stay
      </div>
    </div>

    <!-- Expense Breakdown -->
    <div class="card" style="margin-bottom:12px">
      <div class="report-section-title">Expenses by Category</div>
      ${allExp.length === 0 ? '<div style="color:var(--muted-2);font-size:13px">No expenses recorded for this financial year.</div>' : `
      <table class="report-table">
        <thead><tr><th>Category</th><th>Amount</th><th>%</th></tr></thead>
        <tbody>
          ${expCats.filter(c=>expByCategory[c]>0).sort((a,b)=>expByCategory[b]-expByCategory[a]).map(c=>`
            <tr><td>${c}</td><td>${fmt2(expByCategory[c])}</td><td>${fyTotalExp?(expByCategory[c]/fyTotalExp*100).toFixed(0)+'%':'—'}</td></tr>
          `).join('')}
          <tr><td>Total Expenses</td><td>${fmt2(fyTotalExp)}</td><td>100%</td></tr>
        </tbody>
      </table>`}
    </div>

    <!-- Net Income Summary -->
    <div class="card">
      <div class="report-section-title">Net Income Summary</div>
      <table class="report-table">
        <tbody>
          <tr><td>Total Revenue (Gross)</td><td>${fmt2(fyTotalRev)}</td></tr>
          <tr><td>Owner Payout (after fees)</td><td>${fmt2(fyTotalNet)}</td></tr>
          <tr><td>Total Expenses</td><td style="color:var(--red)">− ${fmt2(fyTotalExp)}</td></tr>
          <tr class="highlight-row"><td>Net Income</td><td style="color:${fyNetIncome>=0?'var(--primary)':'var(--red)'}">${fyNetIncome<0?'−':''} ${fmt2(Math.abs(fyNetIncome))}</td></tr>
        </tbody>
      </table>
    </div>
  </div>`;

  document.getElementById('report-content').innerHTML = html;
  // Also populate the Payouts FY view copy (if visible)
  const payoutsCopy = document.getElementById('report-content-payouts');
  if (payoutsCopy) payoutsCopy.innerHTML = html;
}

let revYear = new Date().getFullYear();
let revMonth = new Date().getMonth();
function revPrev() { revMonth--; if(revMonth<0){revMonth=11;revYear--;} renderRevenue(); }
function revNext() { revMonth++; if(revMonth>11){revMonth=0;revYear++;} renderRevenue(); }

function _fmtAud(n) { return Math.abs(n).toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function _fmtPayout(n) { return n < 0 ? '− $' + _fmtAud(n) : '$' + _fmtAud(n); }

/** Normalize display category names to snake_case keys for matching against owner_paid_categories */
const _categoryKeyMap = {
  'cleaning & garden': 'cleaning', 'cleaning': 'cleaning', 'gardening': 'gardening',
  'maintenance & repairs': 'maintenance', 'maintenance': 'maintenance', 'renovation': 'maintenance',
  'supplies & consumables': 'supplies', 'supplies': 'supplies',
  'utilities & rates': 'utilities', 'utilities': 'utilities',
  'insurance': 'insurance',
  'furnishings & equipment': 'furniture', 'furniture': 'furniture',
  'professional services': 'accounting', 'accounting': 'accounting',
  'council rates': 'council_rates', 'council_rates': 'council_rates',
  'council rates & strata': 'council_rates',
  'strata': 'strata', 'strata/body corp': 'strata',
  'mortgage': 'mortgage',
  'advertising': 'advertising',
  'linen': 'linen',
  'pest control': 'pest_control', 'pest_control': 'pest_control',
  'other': 'other',
};
function _normCategoryKey(cat) {
  if (!cat) return 'other';
  // Strip a "Parent > Sub" suffix so e.g. "Mortgage > Interest" resolves to the
  // parent's key and still matches owner-paid lists keyed on the parent (1.19).
  const lower = String(cat).split('>')[0].trim().toLowerCase();
  return _categoryKeyMap[lower] || lower.replace(/\s+/g, '_');
}

function _getOwnerPaidCategories() {
  const cfg = getActivePropertyConfig();
  return (cfg.settings && cfg.settings.owner_paid_categories) || ['mortgage', 'insurance', 'council_rates', 'strata'];
}

function _isOwnerPaidExpense(expense) {
  const ownerPaid = _getOwnerPaidCategories();
  const key = _normCategoryKey(expense.category);
  return ownerPaid.includes(key);
}

function renderRevenue() {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  document.getElementById('rev-month-title').textContent = months[revMonth] + ' ' + revYear;
  const propertyBookings = _financeScopedBookings();
  const monthBookings = propertyBookings.filter(b => {
    const d = new Date(b.checkin);
    return isRevenueBearingBooking(b) && d.getMonth()===revMonth && d.getFullYear()===revYear;
  });
  const totalHost = monthBookings.reduce((s,b)=>s+bookingRevenue(b),0);
  const totalMgmt = monthBookings.reduce((s,b)=>s+bookingMgmtFee(b),0);

  // ── Expenses for this month — split into operational vs owner-paid ──
  const monthExpenses = _financeScopedExpenses().filter(e => {
    const d = new Date(e.date);
    return d.getMonth() === revMonth && d.getFullYear() === revYear;
  });
  const operationalExpenses = monthExpenses.filter(e => !_isOwnerPaidExpense(e));
  const ownerPaidExpenses = monthExpenses.filter(e => _isOwnerPaidExpense(e));
  const totalOperational = operationalExpenses.reduce((s,e) => s + Math.abs(Number(e.amount || 0)), 0);
  const totalOwnerPaid = ownerPaidExpenses.reduce((s,e) => s + Math.abs(Number(e.amount || 0)), 0);
  // ── Cleaning costs from clean records (linked to bookings) ──
  const monthBookingIds = new Set(monthBookings.map(b => String(b.id)).concat(monthBookings.filter(b => b._cloudId).map(b => String(b._cloudId))));
  const monthCleanCosts = cleans.filter(c => c.cost != null && c.cost > 0 && monthBookingIds.has(String(c.bookingId)));
  const totalCleanCost = monthCleanCosts.reduce((s, c) => s + Number(c.cost || 0), 0);

  const expenseMode = getExpensePayoutMode();
  const isDeduct = expenseMode === 'deduct';
  const totalNetBeforeExpenses = totalHost - totalMgmt - totalCleanCost;
  const finalPayout = isDeduct ? totalNetBeforeExpenses - totalOperational : totalNetBeforeExpenses;

  // ── Header cards ──
  document.getElementById('total-revenue').textContent = '$' + _fmtAud(totalHost);
  const netEl = document.getElementById('total-net');
  if (netEl) { netEl.textContent = _fmtPayout(finalPayout); netEl.style.color = finalPayout >= 0 ? '#1D9E75' : '#E24B4A'; }
  document.getElementById('revenue-sub').textContent = monthBookings.length + ' booking' + (monthBookings.length!==1?'s':'');

  // ── Expense detail row builder ──
  const _expRow = (e) => {
    const verified = !!(e.reconciled || e.bank_transaction_id);
    const badge = verified ? '<span style="font-size:10px;color:#1D9E75;margin-left:4px">✓ Bank</span>' : '';
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;font-size:12px;border-bottom:0.5px solid rgba(0,0,0,0.05)"><div style="min-width:0"><div style="color:var(--text);font-weight:500">${escHtml(e.category||'Uncategorised')}${badge}</div><div style="color:var(--muted-2);font-size:11px;margin-top:1px">${escHtml(e.description||'')}${e.date ? ' · ' + fmt(e.date) : ''}</div></div><div style="flex-shrink:0;color:#E24B4A;font-weight:500;margin-left:12px">$${_fmtAud(Math.abs(Number(e.amount||0)))}</div></div>`;
  };
  const opDetailHtml = operationalExpenses.length ? [...operationalExpenses].sort((a,b) => new Date(a.date) - new Date(b.date)).map(_expRow).join('') : '<div style="color:var(--muted-2);font-size:12px;padding:8px 0">No operational expenses this month.</div>';
  const ownerDetailHtml = ownerPaidExpenses.length ? [...ownerPaidExpenses].sort((a,b) => new Date(a.date) - new Date(b.date)).map(_expRow).join('') : '';

  // ── Summary section ──
  // ── Clean cost detail row builder ──
  const _cleanCostRow = (c) => {
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;font-size:12px;border-bottom:0.5px solid rgba(0,0,0,0.05)"><div style="min-width:0"><div style="color:var(--text);font-weight:500">${escHtml(c.cleaner || 'Cleaner')}</div><div style="color:var(--muted-2);font-size:11px;margin-top:1px">${escHtml(c.guestName || '')}${c.date ? ' · ' + fmt(c.date) : ''}</div></div><div style="flex-shrink:0;color:#E24B4A;font-weight:500;margin-left:12px">$${_fmtAud(Number(c.cost||0))}</div></div>`;
  };
  const cleanCostDetailHtml = monthCleanCosts.length ? [...monthCleanCosts].sort((a,b) => new Date(a.date) - new Date(b.date)).map(_cleanCostRow).join('') : '';

  let summaryHtml = `<div class="finance-summary">
    <div class="finance-row"><span class="finance-label">Gross revenue</span><span class="finance-val" style="color:var(--ink-1);font-weight:500">$${_fmtAud(totalHost)}</span></div>
    <div class="finance-row"><span class="finance-label">Management fees</span><span class="finance-val" style="color:#E24B4A;font-weight:500">− $${_fmtAud(totalMgmt)}</span></div>`;

  if (totalCleanCost > 0) {
    summaryHtml += `
    <div class="finance-row" style="cursor:pointer;border-radius:6px;margin:0 -4px;padding:10px 4px;transition:background 0.15s" onclick="var d=document.getElementById('rev-clean-cost-detail');var open=d.style.display!=='none';d.style.display=open?'none':'block';this.querySelector('.cc-chevron').textContent=open?'▾':'▴'" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background=''">
      <span class="finance-label" style="display:flex;align-items:center;gap:4px">Cleaning costs (${monthCleanCosts.length}) <span class="cc-chevron" style="font-size:9px;color:var(--muted-2);transition:transform 0.2s">▾</span></span>
      <span class="finance-val" style="color:#E24B4A;font-weight:500">− $${_fmtAud(totalCleanCost)}</span>
    </div>
    <div id="rev-clean-cost-detail" style="display:none;padding:10px 14px;margin:2px 0 6px;background:var(--surface2);border-radius:10px">${cleanCostDetailHtml}</div>`;
  }

  if (isDeduct && totalOperational > 0) {
    // Model A: operational expenses deducted before payout
    summaryHtml += `
    <div class="finance-row" style="cursor:pointer;border-radius:6px;margin:0 -4px;padding:10px 4px;transition:background 0.15s" onclick="var d=document.getElementById('rev-expense-detail');var open=d.style.display!=='none';d.style.display=open?'none':'block';this.querySelector('.exp-chevron').textContent=open?'▾':'▴'" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background=''">
      <span class="finance-label" style="display:flex;align-items:center;gap:4px">Expenses (${operationalExpenses.length}) <span class="exp-chevron" style="font-size:9px;color:var(--muted-2);transition:transform 0.2s">▾</span></span>
      <span class="finance-val" style="color:#E24B4A;font-weight:500">− $${_fmtAud(totalOperational)}</span>
    </div>
    <div id="rev-expense-detail" style="display:none;padding:10px 14px;margin:2px 0 6px;background:var(--surface2);border-radius:10px">${opDetailHtml}</div>`;
  }

  const payoutColor = finalPayout >= 0 ? '#1D9E75' : '#E24B4A';
  summaryHtml += `
    <div class="finance-row finance-total" style="border-top:1.5px solid var(--hairline-1);padding-top:12px;margin-top:4px"><span class="finance-label" style="font-size:14px">Owner payout</span><span class="finance-val" style="color:${payoutColor};font-size:14px">${_fmtPayout(finalPayout)}</span></div>
  </div>`;

  // Owner-paid costs section (shown in both modes when they exist)
  if (ownerPaidExpenses.length > 0) {
    summaryHtml += `
    <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--hairline-2)">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--muted-2);margin-bottom:8px;cursor:pointer;display:flex;justify-content:space-between;align-items:center" onclick="var d=document.getElementById('rev-owner-cost-detail');var open=d.style.display!=='none';d.style.display=open?'none':'block';this.querySelector('.oc-chevron').textContent=open?'▾':'▴'">
        <span>OWNER COSTS (${ownerPaidExpenses.length}) <span class="oc-chevron" style="font-size:9px;transition:transform 0.2s">▾</span></span>
        <span style="font-size:13px;font-weight:600;color:var(--muted-2);letter-spacing:0;text-transform:none">$${_fmtAud(totalOwnerPaid)}</span>
      </div>
      <div style="font-size:11px;color:var(--muted-2);margin-bottom:8px;line-height:1.4">Not deducted from payout — paid by owner directly</div>
      <div id="rev-owner-cost-detail" style="display:none;padding:10px 14px;background:var(--surface2);border-radius:10px">${ownerDetailHtml}</div>
    </div>`;
  }

  if (!isDeduct && monthExpenses.length > 0) {
    // Model B: ALL expenses shown separately below (not just owner-paid)
    const allDetailHtml = [...monthExpenses].sort((a,b) => new Date(a.date) - new Date(b.date)).map(_expRow).join('');
    summaryHtml += `
    <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--hairline-2)">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--muted-2);margin-bottom:8px;cursor:pointer;display:flex;justify-content:space-between;align-items:center" onclick="var d=document.getElementById('rev-all-expense-detail');var open=d.style.display!=='none';d.style.display=open?'none':'block';this.querySelector('.exp-chevron').textContent=open?'▾':'▴'">
        <span>ALL EXPENSES (${monthExpenses.length}) <span class="exp-chevron" style="font-size:9px;transition:transform 0.2s">▾</span></span>
        <span style="font-size:13px;font-weight:600;color:#E24B4A;letter-spacing:0;text-transform:none">$${_fmtAud(totalOperational + totalOwnerPaid)}</span>
      </div>
      <div id="rev-all-expense-detail" style="display:none;padding:10px 14px;background:var(--surface2);border-radius:10px">${allDetailHtml}</div>
    </div>`;
  }

  document.getElementById('finance-summary-content').innerHTML = summaryHtml;

  // ── Per-booking breakdown ──
  const _revSorted = monthBookings.length ? [...monthBookings].sort((a,b)=>new Date(a.checkin)-new Date(b.checkin)) : [];
  const _revBreakdownEl = document.getElementById('revenue-breakdown');
  if (_revBreakdownEl) {
    if (!_revSorted.length) {
      _revBreakdownEl.innerHTML = '<div style="color:var(--muted-2);font-size:13px;padding:14px 0">No bookings this month.</div>';
    } else if (window.innerWidth >= 1024) {
      const _fmtSh = d => { if (!d) return ''; return new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { day:'numeric', month:'short' }); };
      const _revRows = _revSorted.map(b => `<tr><td><strong>${escHtml(b.name||'')}</strong></td><td>${_fmtSh(b.checkin)}</td><td>${_fmtSh(b.checkout)}</td><td>${b.nights||''}</td><td>$${_fmtAud(bookingRevenue(b))}</td><td style="color:#E24B4A">$${_fmtAud(bookingCleaningFee(b))}</td><td style="color:#E24B4A">$${_fmtAud(bookingMgmtFee(b))}</td><td style="color:#1D9E75;font-weight:600">$${_fmtAud(bookingNetPayout(b))}</td></tr>`).join('');
      _revBreakdownEl.innerHTML = '<div class="card" style="padding:0;overflow:hidden;overflow-x:auto"><table class="desktop-table"><thead><tr><th>Guest</th><th>Check-in</th><th>Check-out</th><th>Nights</th><th>Gross</th><th>Clean</th><th>Mgmt Fee</th><th>Net Payout</th></tr></thead><tbody>' + _revRows + '</tbody></table></div>';
    } else {
      _revBreakdownEl.innerHTML = _revSorted.map(b=>`
        <div class="fin-rev-row">
          <div style="min-width:0"><div style="font-weight:500;font-size:14px;color:var(--ink-1)">${escHtml(b.name||'')}</div><div style="font-size:11px;color:var(--muted-2);margin-top:2px">${fmt(b.checkin)} · ${b.nights}n</div></div>
          <div style="text-align:right;flex-shrink:0">
            <div style="font-size:14px;font-weight:500;color:var(--ink-1);font-family:'Plus Jakarta Sans',sans-serif">$${bookingRevenue(b).toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
            <div style="font-size:11px;color:#1D9E75;margin-top:2px;font-family:'Plus Jakarta Sans',sans-serif">$${bookingNetPayout(b).toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
          </div>
        </div>`).join('');
    }
  }
}

let mgmtYear = new Date().getFullYear();
let mgmtMonth = new Date().getMonth();
function mgmtPrev() { mgmtMonth--; if(mgmtMonth<0){mgmtMonth=11;mgmtYear--;} mgmtSelected.clear(); renderManagement(); }
function mgmtNext() { mgmtMonth++; if(mgmtMonth>11){mgmtMonth=0;mgmtYear++;} mgmtSelected.clear(); renderManagement(); }

function _mgmtBookingKey(bookingOrId) {
  if (bookingOrId && typeof bookingOrId === 'object') return String(bookingOrId.id);
  return String(bookingOrId);
}

function _getMgmtMonthBookings() {
  const propertyBookings = _financeScopedBookings();
  return propertyBookings.filter((b) => {
    const d = new Date(b.checkin);
    return isRevenueBearingBooking(b) && d.getMonth() === mgmtMonth && d.getFullYear() === mgmtYear;
  });
}

function _syncMgmtSelectAllLabel(monthBookings) {
  const allSel =
    monthBookings.length > 0 &&
    monthBookings.every((b) => mgmtSelected.has(_mgmtBookingKey(b)));
  const selBtn = document.getElementById('mgmt-select-all-btn');
  if (selBtn) selBtn.textContent = allSel ? 'Deselect all' : 'Select all';
}

function _setMgmtCheckboxUi(cb) {
  const box = cb.closest('.mgmt-booking-check-wrap')?.querySelector('.mgmt-booking-box');
  const tick = box?.querySelector('svg');
  if (!box || !tick) return;
  if (cb.checked) {
    box.style.background = '#2f5d4e';
    box.style.borderColor = '#2f5d4e';
    tick.style.display = 'block';
  } else {
    box.style.background = '#fff';
    box.style.borderColor = '#C8C6BF';
    tick.style.display = 'none';
  }
}

function _bindMgmtActionButtons() {
  const selBtn = document.getElementById('mgmt-select-all-btn');
  if (selBtn && !selBtn.dataset.bound) {
    selBtn.dataset.bound = '1';
    selBtn.removeAttribute('onclick');
    selBtn.addEventListener('click', () => mgmtToggleSelectAll());
  }
  const invBtn = document.getElementById('mgmt-gen-invoice-btn');
  if (invBtn && !invBtn.dataset.bound) {
    invBtn.dataset.bound = '1';
    invBtn.removeAttribute('onclick');
    invBtn.addEventListener('click', () => generateInvoice());
  }
}

function _bindMgmtBookingCheckboxes() {
  document.querySelectorAll('.mgmt-booking-check').forEach((cb) => {
    if (cb.dataset.bound) return;
    cb.dataset.bound = '1';
    cb.addEventListener('change', (ev) => {
      const target = ev.currentTarget;
      const id = target.getAttribute('data-booking-id');
      mgmtCheckboxChange(id, target.checked);
      _setMgmtCheckboxUi(target);
    });
  });
  document.querySelectorAll('.mgmt-booking-check').forEach((cb) => _setMgmtCheckboxUi(cb));
}

function renderManagement() {
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const titleEl = document.getElementById('mgmt-month-title');
  if (titleEl) titleEl.textContent = monthNames[mgmtMonth] + ' ' + mgmtYear;
  const monthBookings = _getMgmtMonthBookings();
  const totalMgmtPayout = monthBookings.reduce((s,b)=>s+bookingMgmtPayout(b),0);
  const totalEl = document.getElementById('total-mgmt');
  if (totalEl) totalEl.textContent = '$' + totalMgmtPayout.toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2});
  const pctSample = monthBookings.length
    ? monthBookings.reduce((s, b) => {
        const p = b.mgmtFeeRaw != null ? Number(b.mgmtFeeRaw) : (b.mgmtFee && b.hostPayout ? Math.round((b.mgmtFee/b.hostPayout)*1000)/10 : 0);
        return s + p;
      }, 0) / monthBookings.length
    : 0;
  const pctDisp = Math.round(pctSample * 10) / 10;
  const subEl = document.getElementById('mgmt-sub');
  if (subEl) {
    const base = `${monthBookings.length} booking${monthBookings.length !== 1 ? 's' : ''}`;
    const feeSuffix =
      monthBookings.length > 0 && Number.isFinite(pctDisp) ? ` · ${pctDisp}% fee` : '';
    subEl.textContent = base + feeSuffix;
  }
  _syncMgmtSelectAllLabel(monthBookings);
  const bd = document.getElementById('mgmt-breakdown');
  if (bd) {
    const invMap = _getBookingInvoiceMap();
    const _mgmtSorted = monthBookings.length ? [...monthBookings].sort((a,b)=>new Date(a.checkin)-new Date(b.checkin)) : [];
    if (!_mgmtSorted.length) {
      bd.innerHTML = '<div style="color:var(--muted-2);font-size:13px;padding:14px 0">No bookings this month.</div>';
    } else if (window.innerWidth >= 1024) {
      const _fmtSh = d => { if (!d) return ''; return new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { day:'numeric', month:'short' }); };
      const _mgmtRows = _mgmtSorted.map(b => {
        const invoiced = invMap.has(String(b.id));
        const checked = !invoiced && mgmtSelected.has(_mgmtBookingKey(b)) ? 'checked' : '';
        const bookingId = escHtml(_mgmtBookingKey(b));
        if (invoiced) mgmtSelected.delete(_mgmtBookingKey(b));
        const invNums = invoiced ? invMap.get(String(b.id)) : null;
        const invBadge = invNums ? ' <span class="mgmt-invoiced-badge">' + escHtml(invNums[invNums.length - 1]) + '</span>' : '';
        return `<tr style="${invoiced ? 'opacity:0.45' : 'cursor:pointer'}"><td style="width:36px"><label style="margin:0;cursor:pointer;display:flex"><span class="mgmt-booking-check-wrap" style="position:relative;display:inline-flex;width:20px;height:20px"><input class="mgmt-booking-check" data-booking-id="${bookingId}" type="checkbox" ${checked} ${invoiced ? 'disabled' : ''} style="position:absolute;inset:0;opacity:0;margin:0;cursor:pointer;z-index:2"><span class="mgmt-booking-box" style="width:20px;height:20px;border:1.5px solid ${invoiced ? '#ddd' : '#C8C6BF'};border-radius:4px;background:${invoiced ? '#f0f0f0' : '#fff'};display:flex;align-items:center;justify-content:center;box-sizing:border-box"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="display:none"><polyline points="20 6 9 17 4 12"></polyline></svg></span></span></label></td><td><strong>${escHtml(b.name||'')}</strong>${invBadge}</td><td>${_fmtSh(b.checkin)}</td><td>${_fmtSh(b.checkout)}</td><td>${b.nights||''}</td><td>$${_fmtAud(bookingRevenue(b))}</td><td style="color:${invoiced ? 'var(--muted-2)' : '#1D9E75'};font-weight:600">$${_fmtAud(bookingMgmtPayout(b))}</td></tr>`;
      }).join('');
      bd.innerHTML = '<div class="card" style="padding:0;overflow:hidden;overflow-x:auto"><table class="desktop-table"><thead><tr><th style="width:36px"></th><th>Guest</th><th>Check-in</th><th>Check-out</th><th>Nights</th><th>Gross</th><th>Mgmt Payout</th></tr></thead><tbody>' + _mgmtRows + '</tbody></table></div>';
    } else {
      bd.innerHTML = _mgmtSorted.map(b => {
        const invoiced = invMap.has(String(b.id));
        const checked = !invoiced && mgmtSelected.has(_mgmtBookingKey(b)) ? 'checked' : '';
        const bookingId = escHtml(_mgmtBookingKey(b));
        if (invoiced) mgmtSelected.delete(_mgmtBookingKey(b));
        const invNums = invoiced ? invMap.get(String(b.id)) : null;
        const invBadge = invNums ? '<span class="mgmt-invoiced-badge">' + escHtml(invNums[invNums.length - 1]) + '</span>' : '';
        return `<label class="fin-mgmt-book-row" style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:0.5px solid rgba(0,0,0,0.08);${invoiced ? 'opacity:0.45;cursor:default' : 'cursor:pointer'};margin:0;text-transform:none">
          <span class="mgmt-booking-check-wrap" style="position:relative;display:inline-flex;width:20px;height:20px;flex-shrink:0">
            <input class="mgmt-booking-check" data-booking-id="${bookingId}" type="checkbox" ${checked} ${invoiced ? 'disabled' : ''}
              style="position:absolute;inset:0;opacity:0;margin:0;${invoiced ? 'pointer-events:none' : 'cursor:pointer'};z-index:2">
            <span class="mgmt-booking-box" style="width:20px;height:20px;border:1.5px solid ${invoiced ? '#ddd' : '#C8C6BF'};border-radius:4px;background:${invoiced ? '#f0f0f0' : '#fff'};display:flex;align-items:center;justify-content:center;box-sizing:border-box">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="display:none">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            </span>
          </span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:500;font-size:14px;color:var(--ink-1);text-transform:none">${escHtml(b.name||'')}${invBadge}</div>
            <div style="font-size:11px;color:var(--muted-2);margin-top:2px">${fmt(b.checkin)} · ${b.nights}n · Host $${bookingRevenue(b).toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}${invoiced ? ' · Invoiced' : ''}</div>
          </div>
          <div style="font-size:14px;font-weight:500;color:${invoiced ? 'var(--muted-2)' : '#1D9E75'};font-family:'Plus Jakarta Sans',sans-serif;flex-shrink:0">$${bookingMgmtPayout(b).toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
        </label>`;
      }).join('');
    }
  }
  _bindMgmtActionButtons();
  _bindMgmtBookingCheckboxes();
  updateMgmtGenInvoiceBtn();
  renderInvoiceHistory();
}

let mgmtSelected = new Set();

function mgmtCheckboxChange(id, checked) {
  const key = _mgmtBookingKey(id);
  if (checked) mgmtSelected.add(key);
  else mgmtSelected.delete(key);
  const monthBookings = _getMgmtMonthBookings();
  _syncMgmtSelectAllLabel(monthBookings);
  updateMgmtGenInvoiceBtn();
}

function mgmtToggleSelectAll() {
  const invMap = _getBookingInvoiceMap();
  const monthBookings = _getMgmtMonthBookings().filter(b => !invMap.has(String(b.id)));
  const allOn =
    monthBookings.length > 0 &&
    monthBookings.every((b) => mgmtSelected.has(_mgmtBookingKey(b)));
  if (allOn) monthBookings.forEach((b) => mgmtSelected.delete(_mgmtBookingKey(b)));
  else monthBookings.forEach((b) => mgmtSelected.add(_mgmtBookingKey(b)));
  renderManagement();
}

function updateMgmtGenInvoiceBtn() {
  const btn = document.getElementById('mgmt-gen-invoice-btn');
  const meta = document.getElementById('mgmt-gen-invoice-meta');
  if (!btn || !meta) return;
  const sel = _financeScopedBookings().filter((b) => mgmtSelected.has(_mgmtBookingKey(b)));
  const sum = sel.reduce((s,b)=>s+bookingMgmtPayout(b),0);
  meta.textContent = `${sel.length} selected · $${sum.toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
  const active = sel.length > 0;
  btn.disabled = !active;
  btn.style.opacity = active ? '1' : '0.4';
  btn.style.pointerEvents = active ? '' : 'none';
}

/** @deprecated */
function toggleMgmtSelect(id) {
  mgmtCheckboxChange(id, !mgmtSelected.has(id));
  renderManagement();
}

function generateInvoice() {
  const selected = _financeScopedBookings().filter((b) => mgmtSelected.has(_mgmtBookingKey(b)));
  if (!selected.length) { globalThis.showBanner('⚠ Tap bookings above to select them first', 'warn'); return; }

  // Pick client
  const clients = loadClients();
  if (clients.length) {
    // Show inline client picker
    pendingInvoiceBookings = selected;
    const picker = document.getElementById('invoice-client-picker');
    const sel = document.getElementById('invoice-client-select');
    sel.innerHTML = '<option value="">— No client (skip) —</option>' +
      clients.map((c,i) => `<option value="${i}">${c.name}</option>`).join('');
    picker.classList.add('open'); document.body.style.overflow='hidden';
  } else {
    buildInvoicePDF(selected, null);
  }
}

let pendingInvoiceBookings = [];
function confirmInvoiceClient() {
  const sel = document.getElementById('invoice-client-select');
  const clients = loadClients();
  const idx = parseInt(sel.value);
  const client = (!isNaN(idx) && clients[idx]) ? clients[idx] : null;
  document.getElementById('invoice-client-picker').classList.remove('open'); globalThis._checkModalsClosed();
  buildInvoicePDF(pendingInvoiceBookings, client);
  pendingInvoiceBookings = [];
}
// ── Invoice identity helper ───────────────────────────────────────────────
// Returns the HOST's business identity (the "issued by" side of the invoice).
// Owner = the property owner/client (bill-to). Host = you/your business.
// host_config has no live Supabase row yet, so host identity reads from
// Prefers host_config (Supabase via getHostProfile) then falls back to
// legacy inv-* localStorage keys for backward compatibility.
function _getInvoiceIdentity() {
  const host = (typeof globalThis.getHostProfile === 'function') ? (globalThis.getHostProfile() || {}) : {};
  const inv = (window._appConfig && window._appConfig.invoice_details) || {};
  return {
    name:    host.name    || inv.name    || '',
    email:   host.email   || inv.email   || '',
    phone:   host.phone   || inv.phone   || '',
    address: host.address || inv.address || '',
    company: host.company || inv.company || '',
    abn:     host.abn     || inv.abn     || '',
    acn:     host.acn     || inv.acn     || '',
    logo:    (window._appConfig && window._appConfig.invoice_logo) || '',
  };
}

// ── Invoice numbering helpers (INV<YY><NNN>) ───────────────────────────────
// Format: INV26001 = INV + 2-digit year (from invoice date) + 3-digit
// sequence that resets each year. Existing invoices are preserved as-is.
function _getInvoiceYearCode(date) {
  const d = (date instanceof Date) ? date : new Date(date);
  if (isNaN(d.getTime())) return String(new Date().getFullYear()).slice(-2);
  return String(d.getFullYear()).slice(-2);
}

function _formatInvoiceSequence(seq) {
  return String(Math.max(1, parseInt(seq, 10) || 1)).padStart(3, '0');
}

// Strict parser: only accepts INV<YY><NNN+> (no dashes, no spaces). Older
// timestamp-based numbers like 'INV-123456' are intentionally returned as
// null so they can't poison the year-based counter.
function _parseInvoiceNumber(num) {
  if (!num || typeof num !== 'string') return null;
  const m = num.match(/^INV(\d{2})(\d{3,})$/);
  if (!m) return null;
  return { yearCode: m[1], sequence: parseInt(m[2], 10) };
}

function _getNextInvoiceNumber(existingInvoices, invoiceDate) {
  const yc = _getInvoiceYearCode(invoiceDate);
  const list = Array.isArray(existingInvoices) ? existingInvoices : [];
  let highest = 0;
  for (const rec of list) {
    if (!rec) continue;
    const parsed = _parseInvoiceNumber(rec.number || rec.invoiceNumber);
    if (parsed && parsed.yearCode === yc && parsed.sequence > highest) {
      highest = parsed.sequence;
    }
  }
  return 'INV' + yc + _formatInvoiceSequence(highest + 1);
}

function _getIssuedInvoices() {
  const list = (window._appConfig && window._appConfig.invoices) || [];
  return Array.isArray(list) ? list : [];
}

function _normalizeInvoiceRecord(rec) {
  if (!rec) return null;
  return {
    number: rec.number || rec.invoiceNumber || '',
    date: rec.date || '',
    total: Number(rec.total || 0),
    clientName: rec.clientName || '',
    bookingIds: Array.isArray(rec.bookingIds) ? rec.bookingIds : [],
    status: (rec.status === 'paid' || rec.status === 'cancelled') ? rec.status : 'unpaid',
    paidDate: rec.paidDate || null,
    cancelledDate: rec.cancelledDate || null,
  };
}

let _bookingInvoiceMapCache = null;
let _bookingInvoiceMapArr = null;

function _getBookingInvoiceMap() {
  const invoices = _getIssuedInvoices();
  // Key the cache on array identity, not length: hydrateFromCloud swaps in a
  // fresh invoices array on property switch / config saves, and a cancel changes
  // a record's status without changing length — both must force a rebuild so
  // cancelled invoices correctly free their bookings.
  if (_bookingInvoiceMapCache && _bookingInvoiceMapArr === invoices) {
    return _bookingInvoiceMapCache;
  }
  const map = new Map();
  for (const raw of invoices) {
    const rec = _normalizeInvoiceRecord(raw);
    if (!rec || !rec.number) continue;
    if (rec.status === 'cancelled') continue;
    for (const bid of rec.bookingIds) {
      if (!map.has(bid)) map.set(bid, []);
      map.get(bid).push(rec.number);
    }
  }
  _bookingInvoiceMapCache = map;
  _bookingInvoiceMapArr = invoices;
  return map;
}

function _recordIssuedInvoice(record) {
  try {
    if (!record || !record.number) return;
    window._appConfig = window._appConfig || {};
    const list = Array.isArray(window._appConfig.invoices) ? window._appConfig.invoices.slice() : [];
    if (list.some(r => r && (r.number || r.invoiceNumber) === record.number)) return;
    list.push(_normalizeInvoiceRecord(record));
    window._appConfig.invoices = list;
    _bookingInvoiceMapCache = null;
    if (typeof saveAppConfigToCloud === 'function') {
      saveAppConfigToCloud({ invoices: list }).catch(e => console.warn('[StayOps] silent error:', e));
    }
  } catch (_e) { /* fail silently — never block invoice generation */ }
}

function _updateInvoiceStatus(invoiceNumber, newStatus) {
  if (!invoiceNumber || (newStatus !== 'paid' && newStatus !== 'unpaid')) return;
  window._appConfig = window._appConfig || {};
  const list = Array.isArray(window._appConfig.invoices) ? window._appConfig.invoices.slice() : [];
  const idx = list.findIndex(r => r && (r.number || r.invoiceNumber) === invoiceNumber);
  if (idx < 0) return;
  if (_normalizeInvoiceRecord(list[idx]).status === 'cancelled') return;
  list[idx] = { ...list[idx], status: newStatus, paidDate: newStatus === 'paid' ? new Date().toISOString() : null, cancelledDate: null };
  window._appConfig.invoices = list;
  _bookingInvoiceMapCache = null;
  if (typeof saveAppConfigToCloud === 'function') {
    saveAppConfigToCloud({ invoices: list }).catch(e => console.warn('[StayOps] silent error:', e));
  }
  renderInvoiceHistory();
}

// Void an unpaid invoice: keep the record so its number stays reserved (audit),
// but mark it cancelled so its bookings free up to be re-invoiced. Paid invoices
// can't be cancelled.
function _cancelInvoice(invoiceNumber) {
  if (!invoiceNumber) return;
  window._appConfig = window._appConfig || {};
  const list = Array.isArray(window._appConfig.invoices) ? window._appConfig.invoices.slice() : [];
  const idx = list.findIndex(r => r && (r.number || r.invoiceNumber) === invoiceNumber);
  if (idx < 0) return;
  const cur = _normalizeInvoiceRecord(list[idx]);
  if (cur.status === 'cancelled') return;
  if (cur.status === 'paid') {
    if (typeof globalThis.showBanner === 'function') globalThis.showBanner('⚠ Paid invoices can’t be cancelled', 'warn');
    return;
  }
  if (typeof globalThis.confirm === 'function' &&
      !globalThis.confirm('Cancel invoice ' + invoiceNumber + '? Its bookings become available to re-invoice; the number stays reserved.')) return;
  list[idx] = { ...list[idx], status: 'cancelled', cancelledDate: new Date().toISOString(), paidDate: null };
  window._appConfig.invoices = list;
  _bookingInvoiceMapCache = null;
  if (typeof saveAppConfigToCloud === 'function') {
    saveAppConfigToCloud({ invoices: list }).catch(e => console.warn('[StayOps] silent error:', e));
  }
  if (typeof globalThis.showBanner === 'function') globalThis.showBanner('Invoice ' + invoiceNumber + ' cancelled', 'ok');
  const ov = document.getElementById('invoice-overlay');
  if (ov) ov.remove();
  renderInvoiceHistory();
  if (typeof renderManagement === 'function') renderManagement();
}

function _viewHistoricalInvoice(invoiceNumber) {
  const invoices = _getIssuedInvoices();
  const raw = invoices.find(r => (r.number || r.invoiceNumber) === invoiceNumber);
  if (!raw) return;
  const rec = _normalizeInvoiceRecord(raw);
  const allBookings = _financeScopedBookings().length ? _financeScopedBookings() : (Array.isArray(bookings) ? bookings : []);
  const matched = rec.bookingIds
    .map(bid => allBookings.find(b => String(b.id) === bid))
    .filter(Boolean);
  if (!matched.length) {
    if (typeof globalThis.showBanner === 'function') globalThis.showBanner('Bookings for this invoice are no longer available', 'warn');
    return;
  }
  const clients = loadClients();
  const client = rec.clientName ? clients.find(c => c.name === rec.clientName) || { name: rec.clientName } : null;
  buildInvoicePDF(matched, client, rec);
}

let _expandedInvoiceNum = null;

function renderInvoiceHistory(containerId) {
  const el = document.getElementById(containerId || 'mgmt-invoice-history');
  if (!el) return;
  const allInvoices = _getIssuedInvoices().map(_normalizeInvoiceRecord).filter(Boolean).reverse();
  if (!allInvoices.length) { el.innerHTML = ''; return; }
  const allBookingsArr = _financeScopedBookings().length ? _financeScopedBookings() : (Array.isArray(bookings) ? bookings : []);
  const rows = allInvoices.map(inv => {
    const isExpanded = _expandedInvoiceNum === inv.number;
    const isPaid = inv.status === 'paid';
    const isCancelled = inv.status === 'cancelled';
    const pillClass = isCancelled ? 'inv-status-cancelled' : (isPaid ? 'inv-status-paid' : 'inv-status-unpaid');
    const pillText = isCancelled ? 'Cancelled' : (isPaid ? 'Paid' : 'Unpaid');
    const d = new Date(inv.date);
    const dateStr = isNaN(d) ? '' : d.toLocaleDateString('en-AU', { day:'numeric', month:'short', year:'numeric' });
    const totalStr = '$' + inv.total.toLocaleString('en-AU', { minimumFractionDigits:2, maximumFractionDigits:2 });
    let detail = '';
    if (isExpanded) {
      const matchedBookings = inv.bookingIds
        .map(bid => allBookingsArr.find(b => String(b.id) === bid))
        .filter(Boolean);
      const bookingLines = matchedBookings.length
        ? matchedBookings.map(b => {
            const ci = new Date(b.checkin);
            const ciStr = isNaN(ci) ? '' : ci.toLocaleDateString('en-AU', { day:'numeric', month:'short' });
            return `<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:12px;color:var(--ink-1)"><span>${escHtml(b.name||'Guest')} · ${ciStr}</span><span style="color:#1D9E75;font-weight:500">$${bookingMgmtPayout(b).toFixed(2)}</span></div>`;
          }).join('')
        : (inv.bookingIds.length
            ? '<div style="font-size:12px;color:var(--muted-2);padding:6px 0">Booking details no longer available</div>'
            : '<div style="font-size:12px;color:var(--muted-2);padding:6px 0">No linked bookings (legacy invoice)</div>');
      const viewBtn = inv.bookingIds.length
        ? `<button onclick="viewHistoricalInvoice('${escHtml(inv.number)}')" style="font-size:12px;font-weight:500;color:var(--primary);background:none;border:1px solid var(--primary);border-radius:8px;padding:6px 14px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif">View invoice</button>`
        : '';
      let actionBtns = '';
      if (!isCancelled) {
        const toggleLabel = isPaid ? 'Mark unpaid' : 'Mark paid';
        const toggleStatus = isPaid ? 'unpaid' : 'paid';
        actionBtns += `<button onclick="toggleInvoiceStatus('${escHtml(inv.number)}','${toggleStatus}')" style="font-size:12px;font-weight:500;color:#fff;background:var(--primary);border:none;border-radius:8px;padding:6px 14px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif">${toggleLabel}</button>`;
        if (!isPaid) {
          actionBtns += `<button onclick="cancelInvoice('${escHtml(inv.number)}')" style="font-size:12px;font-weight:500;color:#A32D2D;background:none;border:1px solid #E24B4A;border-radius:8px;padding:6px 14px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif">Cancel invoice</button>`;
        }
      }
      detail = `<div style="padding:4px 0 8px;border-top:0.5px solid rgba(0,0,0,0.06);margin-top:4px">
        ${bookingLines}
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
          ${actionBtns}
          ${viewBtn}
        </div>
      </div>`;
    }
    const clientStr = inv.clientName ? ` · ${escHtml(inv.clientName)}` : '';
    return `<div onclick="toggleInvoiceDetail('${escHtml(inv.number)}')" style="padding:12px 0;border-bottom:0.5px solid rgba(0,0,0,0.08);cursor:pointer">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div style="flex:1;min-width:0">
          <div style="font-weight:500;font-size:13px;color:var(--ink-1)">${escHtml(inv.number)}<span style="font-weight:400;color:var(--muted-2);font-size:12px;margin-left:8px">${dateStr}${clientStr}</span></div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
          <span style="font-size:14px;font-weight:500;color:var(--ink-1);font-family:'Plus Jakarta Sans',sans-serif">${totalStr}</span>
          <span class="inv-status-pill ${pillClass}">${pillText}</span>
        </div>
      </div>
      ${detail}
    </div>`;
  }).join('');
  el.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;padding:0 2px;margin-top:4px">
      <span class="fin-section-hdr" style="margin:0">Past invoices</span>
    </div>
    <div style="background:#fff;border-radius:12px;padding:0 16px;border:0.5px solid rgba(0,0,0,0.08)">${rows}</div>`;
}

// One source of truth for a single invoice line's numbers, shared by the
// on-screen invoice (buildInvoicePDF) and the downloadable PDF (_buildInvoiceDoc)
// so the two can never disagree. Returns raw numbers + an unescaped description.
function _invoiceLineData(b) {
  const amt = bookingMgmtPayout(b);
  const gross = bookingRevenue(b);
  const cleaning = bookingCleaningFee(b);
  const feeBase = gross - cleaning;
  const pctRaw = b.mgmtFeeRaw != null ? Number(b.mgmtFeeRaw) : (b.mgmtFee && feeBase ? (b.mgmtFee / feeBase) * 100 : 0);
  const pct = Number.isFinite(pctRaw) ? Math.round(pctRaw * 10) / 10 : 0;
  const ci = new Date(b.checkin), co = new Date(b.checkout);
  const fmtShort = d => isNaN(d) ? '' : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  const desc = `Management fee — ${b.name || 'Guest'} booking, ${fmtShort(ci)}–${fmtShort(co)}`;
  return { amt, gross, cleaning, feeBase, pct, desc };
}

function buildInvoicePDF(selected, client, existing) {
  const inv = _getInvoiceIdentity();
  const bank = (window._appConfig && window._appConfig.bank_details) || { name:'', bsb:'', acc:'', bank:'' };

  // When re-viewing a previously-issued invoice, reuse its stored number and
  // date instead of minting a fresh sequence number / today's date — otherwise
  // every view renumbers it and "Mark as issued" creates a duplicate (1.25).
  const existingNum = existing && (existing.number || existing.invoiceNumber);
  const invDate = existing && existing.date ? new Date(existing.date) : new Date();
  const invNum = existingNum || _getNextInvoiceNumber(_getIssuedInvoices(), invDate);
  const today = invDate.toLocaleDateString('en-AU', { day:'numeric', month:'long', year:'numeric' });
  const dueDate = new Date(invDate.getTime() + 14 * 24 * 60 * 60 * 1000)
    .toLocaleDateString('en-AU', { day:'numeric', month:'long', year:'numeric' });

  // Management fee is calculated on booking revenue EXCLUDING cleaning fees.
  let invoiceTotal = 0;
  const rows = selected.map(b => {
    const { amt, gross, cleaning, feeBase, pct, desc: rawDesc } = _invoiceLineData(b);
    invoiceTotal += amt;
    const desc = escHtml(rawDesc);
    return `<tr>
      <td class="cell desc">${desc}</td>
      <td class="cell num">$${gross.toFixed(2)}</td>
      <td class="cell num">${cleaning ? '−$' + cleaning.toFixed(2) : '$0.00'}</td>
      <td class="cell num">${feeBase < 0 ? '−$' + Math.abs(feeBase).toFixed(2) : '$' + feeBase.toFixed(2)}</td>
      <td class="cell num">${pct ? pct + '%' : '—'}</td>
      <td class="cell num">$${amt.toFixed(2)}</td>
    </tr>`;
  }).join('');

  const reference = (client && (client.reference || client.po)) ? escHtml(String(client.reference || client.po)) : '';

  const billToBlock = client ? `
    <div class="bill-to">
      <div class="meta-label">Bill To</div>
      <div class="bill-to-name">${escHtml(client.name || '')}</div>
      ${client.contact?`<div class="muted">${escHtml(client.contact)}</div>`:''}
      ${client.email?`<div class="muted">${escHtml(client.email)}</div>`:''}
      ${client.address?`<div class="muted">${escHtml(client.address)}</div>`:''}
    </div>` : '';

  const bankBlock = (bank.bsb && bank.acc) ? `
    <div class="pay-due"><strong>Due Date: ${dueDate}</strong></div>
    <div class="pay-block">
      <div class="pay-intro">Please pay on invoice</div>
      <div class="pay-method">Direct Deposit${bank.bank ? ' — ' + bank.bank : ''}${bank.name ? ' — ' + bank.name : ''}</div>
      <div class="pay-detail">BSB: ${bank.bsb}</div>
      <div class="pay-detail">Acc: ${bank.acc}</div>
    </div>` : `
    <div class="pay-due"><strong>Due Date: ${dueDate}</strong></div>
    <div class="pay-block">
      <div class="pay-intro">Bank details not configured — set them in Finance → Bank Details.</div>
    </div>`;

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Invoice ${invNum}</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:'Helvetica Neue','Helvetica','Arial',sans-serif;color:#222;background:#fff;max-width:760px;margin:40px auto;padding:0 28px;font-size:13px;line-height:1.5}
    h1{font-size:32px;color:#222;margin:0;font-weight:800;letter-spacing:0.3px}
    .header{display:grid;grid-template-columns:1fr auto 1fr;align-items:start;margin-bottom:32px;gap:32px}
    .sender{font-size:12px;color:#444}
    .sender .biz-line{margin-top:2px}
    .meta-col{font-size:12px}
    .meta-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;color:#888;margin-bottom:2px}
    .meta-row{margin-bottom:10px}
    .meta-row .meta-val{font-size:13px;color:#222;font-weight:600}
    .right-block{text-align:right;font-size:12px;color:#444}
    .right-block .biz-name{font-weight:700;color:#222;font-size:14px}
    .bill-to{margin-bottom:24px}
    .bill-to-name{font-weight:700;font-size:14px;color:#222}
    .muted{color:#666;font-size:12px}
    table.lines{width:100%;border-collapse:collapse;margin-top:8px;font-size:12px}
    table.lines th{border-bottom:2px solid #333;padding:8px 6px;text-align:left;font-weight:700;color:#222;font-size:11px;text-transform:uppercase;letter-spacing:0.5px}
    table.lines th.num,table.lines td.num{text-align:right}
    table.lines td.cell{border-bottom:1px solid #ddd;padding:10px 6px;vertical-align:top}
    table.lines td.desc{color:#222}
    .totals{margin-top:16px;display:flex;justify-content:flex-end}
    .totals-inner{min-width:280px;font-size:13px}
    .totals-inner .row{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #eee}
    .totals-inner .row .lbl{color:#555}
    .totals-inner .row .val{color:#222;font-variant-numeric:tabular-nums}
    .totals-inner .row.grand{border-bottom:2px solid #333;font-weight:700;font-size:14px}
    .totals-inner .row.due{border-bottom:2px solid #333;font-weight:700}
    .gst-note{text-align:right;margin-top:8px;font-size:12px;color:#555}
    .pay-due{margin-top:40px;font-size:13px;color:#222}
    .pay-block{margin-top:16px;font-size:13px;color:#222}
    .pay-intro{margin-bottom:6px}
    .pay-method{font-weight:600;margin-bottom:2px}
    .pay-detail{font-weight:600}
    .footer{margin-top:40px;font-size:10px;color:#999;text-align:center;border-top:1px solid #eee;padding-top:12px}
    .actions{text-align:center;margin-top:28px;display:flex;gap:12px;justify-content:center}
    .actions button{font-family:inherit;font-size:13px;font-weight:600;border:none;border-radius:6px;padding:10px 20px;cursor:pointer}
    .actions .primary{background:#222;color:#fff}
    .actions .secondary{background:#eee;color:#222}
    @media print{
      body{margin:0;padding:24px;max-width:none}
      .actions{display:none}
    }
  </style></head><body>
  <div class="header">
    <div class="sender">
      <h1>INVOICE</h1>
      ${inv.company ? `<div class="biz-line"><strong>${escHtml(inv.company)}</strong></div>` : ''}
      ${inv.name && inv.name !== inv.company ? `<div class="biz-line">${escHtml(inv.name)}</div>` : ''}
      ${inv.address ? `<div class="biz-line">${escHtml(inv.address)}</div>` : ''}
      ${inv.abn ? `<div class="biz-line">ABN: ${escHtml(inv.abn)}</div>` : ''}
    </div>
    <div class="meta-col">
      <div class="meta-row"><div class="meta-label">Invoice Date</div><div class="meta-val">${today}</div></div>
      <div class="meta-row"><div class="meta-label">Invoice Number</div><div class="meta-val">${invNum}</div></div>
      ${reference ? `<div class="meta-row"><div class="meta-label">Reference / PO</div><div class="meta-val">${reference}</div></div>` : `<div class="meta-row"><div class="meta-label">Reference / PO</div><div class="meta-val">&nbsp;</div></div>`}
    </div>
    <div class="right-block">
      ${inv.logo ? `<div style="margin-bottom:8px"><img src="${inv.logo}" style="max-width:100px;max-height:70px" alt="Logo"></div>` : ''}
      ${inv.company || inv.name ? `<div class="biz-name">${escHtml(inv.company || inv.name)}</div>` : ''}
      ${inv.address ? `<div>${escHtml(inv.address)}</div>` : ''}
      ${inv.phone ? `<div>${escHtml(inv.phone)}</div>` : ''}
      ${inv.email ? `<div>${escHtml(inv.email)}</div>` : ''}
      ${inv.abn ? `<div>A.B.N ${inv.abn}</div>` : ''}
      ${inv.acn ? `<div>ACN: ${inv.acn}</div>` : ''}
    </div>
  </div>

  ${billToBlock}

  <table class="lines">
    <thead><tr>
      <th>Description</th>
      <th class="num">Gross</th>
      <th class="num">Cleaning</th>
      <th class="num">Fee Base</th>
      <th class="num">Fee Rate</th>
      <th class="num">Amount AUD</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="totals">
    <div class="totals-inner">
      <div class="row grand"><span class="lbl">Invoice Total AUD</span><span class="val">$${invoiceTotal.toFixed(2)}</span></div>
      <div class="row"><span class="lbl">Total Net Payments AUD</span><span class="val">$0.00</span></div>
      <div class="row due"><span class="lbl">Amount Due AUD</span><span class="val">$${invoiceTotal.toFixed(2)}</span></div>
    </div>
  </div>
  <div class="gst-note">Management fee is calculated on booking revenue excluding cleaning fees. Not registered for GST.</div>

  ${bankBlock}

  <div class="footer">${getCurrentPropertyName()} · ${[getPropertyConfig().suburb, getPropertyConfig().state].filter(Boolean).join(' ')} · Generated ${today}</div>
</body></html>`;

  // Determine lifecycle state FIRST. Only a fresh (not-yet-recorded) invoice
  // gets a pending record + the _confirmInvoiceIssued global, so re-opening an
  // already issued/paid/cancelled invoice can never re-record it.
  const _issuedList = _getIssuedInvoices();
  const _existingRec = existing || _issuedList.find(r => (r.number || r.invoiceNumber) === invNum);
  const _recStatus = _existingRec ? _normalizeInvoiceRecord(_existingRec).status : null;

  if (_existingRec) {
    globalThis._pendingInvoiceRecord = null;
    globalThis._confirmInvoiceIssued = null;
  } else {
    const pendingRecord = {
      number: invNum,
      date: invDate.toISOString(),
      total: Number(invoiceTotal.toFixed(2)),
      clientName: (client && client.name) || '',
      bookingIds: selected.map(b => String(b.id)),
      status: 'unpaid',
      paidDate: null,
    };
    globalThis._pendingInvoiceRecord = pendingRecord;
    globalThis._confirmInvoiceIssued = function(num) {
      if (!globalThis._pendingInvoiceRecord || globalThis._pendingInvoiceRecord.number !== num) return;
      _recordIssuedInvoice(globalThis._pendingInvoiceRecord);
      globalThis._pendingInvoiceRecord = null;
      if (typeof globalThis.showBanner === 'function') {
        globalThis.showBanner('✓ Invoice ' + num + ' recorded', 'ok');
      }
      renderManagement();
      renderMgmtFY();
    };
  }

  // Render the invoice in a same-page overlay instead of a popup window
  // (window.open is blocked in browsers and a no-op in the iOS WebView). The
  // toolbar reflects the invoice's lifecycle: Mark-as-issued for a fresh one,
  // Issued/Paid tags + Cancel for one already recorded.
  _showInvoiceOverlay(html, invNum, {
    issued: !!_existingRec,
    status: _recStatus,
    onSavePdf: () => _saveInvoicePdf(selected, client, invNum, invDate),
    onMarkIssued: _existingRec ? null : function () {
      if (typeof globalThis._confirmInvoiceIssued === 'function') globalThis._confirmInvoiceIssued(invNum);
    },
    onCancel: (_existingRec && _recStatus === 'unpaid') ? function () { _cancelInvoice(invNum); } : null,
  });
}

// Full-screen, same-origin invoice viewer used in place of window.open().
// Works inside the Capacitor WebView, where popups silently fail.
function _showInvoiceOverlay(html, invNum, opts) {
  opts = opts || {};
  const existing = document.getElementById('invoice-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'invoice-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.45);display:flex;flex-direction:column';

  const bar = document.createElement('div');
  // Pad the toolbar below the iOS status bar / notch / Dynamic Island, matching
  // the app header pattern — otherwise the buttons sit under the OS chrome and
  // can't be tapped inside the Capacitor WebView (needs viewport-fit=cover, set
  // on the index.html viewport meta).
  bar.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:flex-end;padding:calc(env(safe-area-inset-top, 20px) + 10px) 14px 10px;background:#1b1b1f;flex-wrap:wrap';

  const mkBtn = (label, bg) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = "appearance:none;border:none;border-radius:10px;padding:10px 16px;font-size:14px;font-weight:600;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;color:#fff;background:" + bg;
    return b;
  };
  const mkTag = (label, color) => {
    const s = document.createElement('span');
    s.textContent = label;
    s.style.cssText = "align-self:center;padding:8px 14px;border-radius:10px;font-size:13px;font-weight:600;font-family:'Plus Jakarta Sans',sans-serif;background:rgba(255,255,255,0.14);color:" + (color || '#fff');
    return s;
  };

  const frame = document.createElement('iframe');
  frame.title = 'Invoice ' + invNum;
  frame.style.cssText = 'flex:1;width:100%;border:none;background:#fff';
  frame.srcdoc = html;

  const items = [];

  // Save as PDF builds a real (vector) PDF and opens the native share sheet on
  // iOS — window.print() is a no-op inside the WebView.
  const saveBtn = mkBtn('Save as PDF', '#3B6EF5');
  saveBtn.onclick = () => { if (typeof opts.onSavePdf === 'function') opts.onSavePdf(); };
  items.push(saveBtn);

  if (opts.issued) {
    if (opts.status === 'paid') {
      items.push(mkTag('Paid ✓', '#9FE1CB'));
    } else if (opts.status === 'cancelled') {
      items.push(mkTag('Cancelled', '#D3D1C7'));
    } else {
      items.push(mkTag('Issued ✓', '#9FE1CB'));
      if (typeof opts.onCancel === 'function') {
        const cancelBtn = mkBtn('Cancel invoice', '#A32D2D');
        cancelBtn.onclick = () => { opts.onCancel(); };
        items.push(cancelBtn);
      }
    }
  } else if (typeof opts.onMarkIssued === 'function') {
    const issueBtn = mkBtn('Mark as issued', '#1D9E75');
    let done = false;
    issueBtn.onclick = () => {
      if (done) return;
      done = true;
      opts.onMarkIssued();
      issueBtn.textContent = 'Issued ✓';
      issueBtn.disabled = true;
      issueBtn.style.opacity = '0.5';
    };
    items.push(issueBtn);
  }

  const closeBtn = mkBtn('Close', '#5a5a5f');
  closeBtn.onclick = () => overlay.remove();
  items.push(closeBtn);

  items.forEach(el => bar.appendChild(el));
  overlay.append(bar, frame);
  document.body.appendChild(overlay);
}

async function _saveInvoicePdf(selected, client, invNum, invDate) {
  if (!(window.jspdf && window.jspdf.jsPDF)) {
    if (typeof globalThis.showBanner === 'function') globalThis.showBanner('⟳ PDF library still loading — try again in a moment', 'warn');
    return;
  }
  try {
    const doc = _buildInvoiceDoc(selected, client, invNum, invDate);
    const filename = invNum + '.pdf';
    // Prefer the native share sheet (works inside the iOS WebView, where a direct
    // download or print does nothing). Fall back to a download on desktop web.
    const blob = doc.output('blob');
    const file = new File([blob], filename, { type: 'application/pdf' });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Invoice ' + invNum });
      } catch (err) {
        // AbortError = user dismissed the share sheet; otherwise fall back.
        if (!err || err.name !== 'AbortError') doc.save(filename);
      }
      return;
    }
    doc.save(filename);
  } catch (e) {
    console.warn('[StayOps] invoice PDF failed', e);
    if (typeof globalThis.showBanner === 'function') globalThis.showBanner('⚠ Could not build the PDF', 'warn');
  }
}

// Build the invoice as a real (vector) PDF via jsPDF + autotable, using the same
// per-line numbers as the on-screen invoice (_invoiceLineData) so they match.
function _buildInvoiceDoc(selected, client, invNum, invDate) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const inv = _getInvoiceIdentity();
  const bank = (window._appConfig && window._appConfig.bank_details) || {};
  const money = n => '$' + Number(n || 0).toFixed(2);
  const d0 = (invDate instanceof Date) ? invDate : new Date(invDate || Date.now());
  const today = d0.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
  const dueDate = new Date(d0.getTime() + 14 * 864e5).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });

  let invoiceTotal = 0;
  const bodyRows = selected.map(b => {
    const { amt, gross, cleaning, feeBase, pct, desc } = _invoiceLineData(b);
    invoiceTotal += amt;
    const feeBaseStr = feeBase < 0 ? '-$' + Math.abs(feeBase).toFixed(2) : money(feeBase);
    return [desc, money(gross), cleaning ? '-' + money(cleaning) : money(0), feeBaseStr, pct ? pct + '%' : '—', money(amt)];
  });

  doc.setFontSize(26); doc.setFont('helvetica', 'bold'); doc.setTextColor(34, 34, 34);
  doc.text('INVOICE', 12, 20);
  doc.setFontSize(10); doc.setFont('helvetica', 'normal'); doc.setTextColor(60, 60, 60);
  let hy = 28;
  [inv.company, (inv.name && inv.name !== inv.company) ? inv.name : '', inv.address, inv.abn ? ('ABN: ' + inv.abn) : ''].filter(Boolean).forEach(line => { doc.text(String(line), 12, hy); hy += 5; });
  doc.setFontSize(8); doc.setTextColor(120, 120, 120);
  doc.text('INVOICE DATE', 150, 16); doc.text('INVOICE NUMBER', 150, 26);
  doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.setTextColor(34, 34, 34);
  doc.text(today, 150, 21); doc.text(String(invNum), 150, 31);

  let y = Math.max(hy, 40) + 2;
  if (client && client.name) {
    doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(120, 120, 120);
    doc.text('BILL TO', 12, y); y += 5;
    doc.setFontSize(10); doc.setFont('helvetica', 'normal'); doc.setTextColor(34, 34, 34);
    [client.name, client.contact, client.email, client.address].filter(Boolean).forEach(line => { doc.text(String(line), 12, y); y += 5; });
    y += 2;
  }

  doc.autoTable({
    startY: y, margin: { left: 12, right: 12 },
    head: [['Description', 'Gross', 'Cleaning', 'Fee base', 'Rate', 'Amount AUD']],
    body: bodyRows,
    headStyles: { fillColor: [30, 58, 47], textColor: [255, 255, 255], fontSize: 8, fontStyle: 'bold' },
    bodyStyles: { fontSize: 9 },
    columnStyles: { 0: { cellWidth: 66 }, 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
    alternateRowStyles: { fillColor: [248, 252, 248] },
  });
  y = doc.lastAutoTable.finalY + 8;

  doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.setTextColor(34, 34, 34);
  doc.text('Invoice Total AUD', 130, y); doc.text(money(invoiceTotal), 198, y, { align: 'right' }); y += 6;
  doc.text('Amount Due AUD', 130, y); doc.text(money(invoiceTotal), 198, y, { align: 'right' }); y += 10;

  doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(90, 90, 90);
  doc.text('Management fee is calculated on booking revenue excluding cleaning fees. Not registered for GST.', 12, y); y += 8;

  doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(34, 34, 34);
  doc.text('Due Date: ' + dueDate, 12, y); y += 6;
  if (bank.bsb && bank.acc) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    doc.text('Direct Deposit' + (bank.bank ? (' — ' + bank.bank) : '') + (bank.name ? (' — ' + bank.name) : ''), 12, y); y += 5;
    doc.text('BSB: ' + bank.bsb + '     Acc: ' + bank.acc, 12, y); y += 5;
  }

  return doc;
}
// ── EXPENSE CATEGORY MANAGEMENT ───────────────────────────────────────────
function bindExpenseCatRowHandlers(i, name) {
  const wrap = document.querySelector(`[data-expcat-idx="${i}"]`);
  const inner = document.querySelector(`[data-expcat-inner="${i}"]`);
  if (!wrap || !inner) return;

  // Delete button is always visible now (rendered with a × icon on the right).
  // The old swipe-left-to-reveal flow is gone — desktop users had no way to
  // trigger it. Long-press on touch still works as a power-user shortcut.
  let lp = null;
  wrap.addEventListener('touchstart', () => {
    lp = setTimeout(() => { deleteExpenseCat(i); }, 550);
  }, { passive: true });
  wrap.addEventListener('touchend',  () => { if (lp) clearTimeout(lp); }, { passive: true });
  wrap.addEventListener('touchmove', () => { if (lp) clearTimeout(lp); }, { passive: true });

  // Clicking the row turns the category name into an inline rename input.
  inner.addEventListener('click', () => {
    const sp = inner.querySelector(`[data-expcat-txt="${i}"]`);
    if (!sp || inner.querySelector('input')) return;
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = name;
    inp.style.cssText =
      "flex:1;min-width:0;font-size:14px;padding:6px 8px;border-radius:8px;border:0.5px solid rgba(0,0,0,0.15);font-family:'Plus Jakarta Sans',sans-serif";
    sp.replaceWith(inp);
    inp.focus();
    inp.select();
    const done = () => {
      updateExpenseCat(i, inp.value);
      renderExpenseCatSettings();
    };
    inp.onblur = done;
    inp.onkeydown = (ev) => {
      if (ev.key === 'Enter') inp.blur();
    };
  });
}

function renderExpenseCatSettings() {
  const cats = getExpenseCats();
  const el = document.getElementById('expense-cats-list');
  if (!el) return;
  const counts = {};
  expenses.forEach((e) => {
    const c = e.category || 'Other';
    counts[c] = (counts[c] || 0) + 1;
  });
  el.innerHTML = `<div style="background:#fff;border-radius:12px;border:0.5px solid rgba(0,0,0,0.08);overflow:hidden">
    ${cats
      .map(
        (c, i) => `
      <div class="expcat-swipe-wrap" data-expcat-idx="${i}" style="position:relative;overflow:hidden;touch-action:pan-y">
        <button type="button" data-expcat-del="${i}" aria-label="Delete category" onclick="event.stopPropagation();deleteExpenseCat(${i})"
          style="position:absolute;right:8px;top:50%;transform:translateY(-50%);width:32px;height:32px;border:none;border-radius:8px;background:transparent;color:#991B1B;font-size:18px;line-height:1;font-family:'Plus Jakarta Sans',sans-serif;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.15s ease" onmouseover="this.style.background='#FEE2E2'" onmouseout="this.style.background='transparent'">×</button>
        <div data-expcat-inner="${i}" style="display:flex;align-items:center;justify-content:space-between;padding:14px 52px 14px 16px;border-bottom:0.5px solid rgba(0,0,0,0.08);background:#fff;cursor:pointer">
          <span data-expcat-txt="${i}" style="font-size:14px;color:var(--ink-1);font-family:'Plus Jakarta Sans',sans-serif">${escHtml(c)}</span>
          <span style="font-size:12px;color:var(--muted-2);font-family:'Plus Jakarta Sans',sans-serif">${counts[c] != null ? counts[c] : 0} expenses</span>
        </div>
      </div>`
      )
      .join('')}
  </div>`;
  cats.forEach((c, i) => bindExpenseCatRowHandlers(i, c));
}

function updateExpenseCat(index, newName) {
  const cats = getExpenseCats();
  if (newName.trim()) {
    cats[index] = newName.trim();
    window._appConfig = window._appConfig || {};
    window._appConfig.expense_cats = cats;
    if (typeof saveAppConfigToCloud === 'function') saveAppConfigToCloud({ expense_cats: cats }).catch(e => console.warn("[StayOps] silent error:", e));
    populateExpenseCatSelect();
  }
}

function addExpenseCat() {
  const val = document.getElementById('new-expense-cat').value.trim();
  if (!val) return;
  const cats = getExpenseCats();
  cats.push(val);
  window._appConfig = window._appConfig || {};
  window._appConfig.expense_cats = cats;
  if (typeof saveAppConfigToCloud === 'function') saveAppConfigToCloud({ expense_cats: cats }).catch(e => console.warn("[StayOps] silent error:", e));
  document.getElementById('new-expense-cat').value = '';
  renderExpenseCatSettings();
  populateExpenseCatSelect();
  globalThis.showBanner('✓ Category added', 'ok');
}

async function deleteExpenseCat(index) {
  const cats = getExpenseCats();
  const _okCat = await globalThis.showAppModal({ title: 'Delete Category', msg: 'Delete category "' + cats[index] + '"?', confirmText: 'Delete', confirmColor: 'var(--red)' });
  if (!_okCat) return;
  cats.splice(index, 1);
  window._appConfig = window._appConfig || {};
  window._appConfig.expense_cats = cats;
  if (typeof saveAppConfigToCloud === 'function') saveAppConfigToCloud({ expense_cats: cats }).catch(e => console.warn("[StayOps] silent error:", e));
  renderExpenseCatSettings();
  populateExpenseCatSelect();
}

async function resetExpenseCats() {
  const _okReset = await globalThis.showAppModal({ title: 'Reset Categories', msg: "Reset to default categories? This won't affect existing expenses.", confirmText: 'Reset' });
  if (!_okReset) return;
  window._appConfig = window._appConfig || {};
  delete window._appConfig.expense_cats;
  if (typeof saveAppConfigToCloud === 'function') saveAppConfigToCloud({ expense_cats: null }).catch(e => console.warn("[StayOps] silent error:", e));
  renderExpenseCatSettings();
  populateExpenseCatSelect();
  globalThis.showBanner('✓ Categories reset', 'ok');
}
function saveBankDetails() {
  window._appConfig = window._appConfig || {};
  window._appConfig.bank_details = window._appConfig.bank_details || {};
  ['name','bsb','acc','bank'].forEach(k => {
    const val = document.getElementById('inv-bank-'+k)?.value?.trim();
    if (val !== undefined) window._appConfig.bank_details[k] = val;
  });
  if (typeof saveAppConfigToCloud === 'function') saveAppConfigToCloud({ bank_details: window._appConfig.bank_details }).catch(e => console.warn("[StayOps] silent error:", e));
  const el = document.getElementById('inv-bank-confirm');
  el.style.display='block'; setTimeout(()=>el.style.display='none',2000);
  globalThis.showBanner('✓ Settings saved: bank details', 'ok');
}

function loadClients() {
  const list = (window._appConfig && window._appConfig.clients) || [];
  return Array.isArray(list) ? list : [];
}
function saveClients(c) {
  window._appConfig = window._appConfig || {};
  window._appConfig.clients = Array.isArray(c) ? c : [];
  if (typeof saveAppConfigToCloud === 'function') {
    saveAppConfigToCloud({ clients: window._appConfig.clients }).catch(e => console.warn("[StayOps] silent error:", e));
  }
}

function renderClientsList() {
  const clients = loadClients();
  const el = document.getElementById('clients-list');
  if (!el) return;
  if (!clients.length) { el.innerHTML='<div style="font-size:13px;color:var(--muted-2)">No clients yet</div>'; return; }
  el.innerHTML = clients.map((c,i) => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--hairline-2)">
      <div>
        <div style="font-weight:600;font-size:14px">${escHtml(c.name)}</div>
        ${c.contact?`<div style="font-size:12px;color:var(--muted-2)">${escHtml(c.contact)}</div>`:''}
        ${c.email?`<div style="font-size:12px;color:var(--muted-2)">${escHtml(c.email)}</div>`:''}
      </div>
      <button onclick="deleteClient(${i})" style="background:none;border:none;color:var(--red);font-size:18px;cursor:pointer;padding:4px">✕</button>
    </div>`).join('');
}

function addClient() {
  const name = document.getElementById('new-client-name').value.trim();
  if (!name) { globalThis.showBanner('⚠ Please enter a client name','warn'); return; }
  const clients = loadClients();
  clients.push({
    name,
    contact: document.getElementById('new-client-contact').value.trim(),
    email: document.getElementById('new-client-email').value.trim(),
    address: document.getElementById('new-client-address').value.trim()
  });
  saveClients(clients);
  ['name','contact','email','address'].forEach(k => { const el = document.getElementById('new-client-'+k); if(el) el.value=''; });
  renderClientsList();
  globalThis.showBanner('✓ Client added','ok');
}

async function deleteClient(i) {
  const _okClient = await globalThis.showAppModal({ title: 'Remove Client', msg: 'Remove this client?', confirmText: 'Remove', confirmColor: 'var(--red)' });
  if (!_okClient) return;
  const clients = loadClients();
  clients.splice(i,1);
  saveClients(clients);
  renderClientsList();
}
function saveInvoiceDetails() {
  window._appConfig = window._appConfig || {};
  window._appConfig.invoice_details = window._appConfig.invoice_details || {};
  ['name','company','abn','acn','email','address'].forEach(k => {
    const val = document.getElementById('inv-'+k)?.value?.trim();
    if (val !== undefined) window._appConfig.invoice_details[k] = val;
  });
  if (typeof saveAppConfigToCloud === 'function') saveAppConfigToCloud({ invoice_details: window._appConfig.invoice_details }).catch(e => console.warn("[StayOps] silent error:", e));
  const el = document.getElementById('inv-save-confirm');
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 2000);
  globalThis.showBanner('✓ Settings saved: invoice details', 'ok');
}
// ── EXPENSES ──────────────────────────────────────────────────────────────
function populateExpenseCatSelect() {
  renderExpenseCatPicker();
}

// ── MERCHANT AUTOCOMPLETE ────────────────────────────────────────────────────
function merchantAutocomplete(val) {
  const box = document.getElementById('merchant-suggest');
  if (!box) return;
  const q = val.trim().toLowerCase();
  if (!q || q.length < 2) { box.style.display = 'none'; return; }

  // Gather unique past merchants sorted by most recent
  const seen = new Set();
  const matches = [];
  [...expenses]
    .sort((a,b) => new Date(b.date) - new Date(a.date))
    .forEach(e => {
      const m = (e.merchant || '').trim();
      if (!m || seen.has(m.toLowerCase())) return;
      if (m.toLowerCase().includes(q)) {
        seen.add(m.toLowerCase());
        matches.push({ merchant: m, description: e.description || '', category: e.category || '', amount: e.amount });
      }
    });

  if (!matches.length) { box.style.display = 'none'; return; }

  box.innerHTML = matches.slice(0, 4).map((m, i) => `
    <div onmousedown="selectMerchantSuggest(${i})" style="padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--hairline-2);display:flex;justify-content:space-between;align-items:center"
      onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background='white'">
      <div>
        <div style="font-weight:600;font-size:13px">${escHtml(m.merchant)}</div>
        ${m.description ? `<div style="font-size:11px;color:var(--muted-2)">${escHtml(m.description)}</div>` : ''}
      </div>
      <div style="font-size:11px;color:var(--muted-2);text-align:right;flex-shrink:0;margin-left:8px">
        <div>${m.category}</div>
        <div>$${Math.abs(Number(m.amount)).toFixed(2)}</div>
      </div>
    </div>`).join('');

  // Store matches for selection
  box._matches = matches;
  box.style.display = 'block';
}

function selectMerchantSuggest(i) {
  const box = document.getElementById('merchant-suggest');
  const m = box._matches?.[i];
  if (!m) return;
  document.getElementById('exp-merchant').value = m.merchant;
  // Autofill description if empty
  const descEl = document.getElementById('exp-description');
  if (descEl && !descEl.value) descEl.value = m.description;
  const catEl = document.getElementById('exp-category');
  if (catEl && m.category) {
    const cats = getExpenseCats();
    const exact = cats.find(c => c === m.category);
    if (exact) {
      catEl.value = m.category;
    } else {
      const partial = cats.find(c =>
        c.toLowerCase().includes(m.category.toLowerCase().split(/[/& ]/)[0]) ||
        m.category.toLowerCase().includes(c.toLowerCase().split(/[/& ]/)[0])
      );
      if (partial) catEl.value = partial;
    }
    renderExpenseCatPicker();
  }
  box.style.display = 'none';
}

function hideMerchantSuggest() {
  const box = document.getElementById('merchant-suggest');
  if (box) box.style.display = 'none';
}

function toggleExpenseList() {
  _expShowOlderMonths = true;
  renderExpenses();
}

/** @deprecated Month groups are always visible */
function toggleExpenseMonth() {
  renderExpenses();
}

function normalizeDriveLinks(rawValue) {
  if (!rawValue) return [];
  if (Array.isArray(rawValue)) return rawValue.filter(Boolean);
  const str = String(rawValue).trim();
  if (!str) return [];
  if (str.startsWith('[')) {
    try { return JSON.parse(str).filter(Boolean); } catch (_e) { /* malformed JSON, treat as single path */ }
  }
  return [str];
}

function expenseHasReceiptAttached(e) {
  if (normalizeDriveLinks(e.driveLink).length > 0) return true;
  if (e.photo && String(e.photo).trim()) return true;
  return false;
}

/** Show a once-daily banner nudge for expenses older than 7 days without receipts (Phase 1B). */
function checkReceiptNudge() {
  try {
    const todayStr = localDateStr();
    if (localStorage.getItem('receipt-nudge-last') === todayStr) return;
    const sevenDaysAgo = localDateStr(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    const allExp = Array.isArray(expenses) ? expenses : [];
    const count = allExp.filter(e =>
      Number(e.amount) > 0 &&
      !expenseHasReceiptAttached(e) &&
      (e.date || '') <= sevenDaysAgo
    ).length;
    if (count > 0) {
      globalThis.showBanner('\u{1F4CE} ' + count + ' expense' + (count === 1 ? ' is' : 's are') + ' missing receipts', 'warn');
    }
    localStorage.setItem('receipt-nudge-last', todayStr);
  } catch (_) { /* silent */ }
}

function _setExpensePillLabel(btnId, text) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.replaceChildren();
  btn.append(document.createTextNode(`${text} `));
  const chev = document.createElement('span');
  chev.className = 'exp-pill-chev';
  chev.style.cssText = 'opacity:0.5;display:inline-flex;align-items:center';
  chev.innerHTML =
    '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>';
  btn.appendChild(chev);
}

function closeExpFilterDropdown() {
  const dd = document.getElementById('exp-filter-dropdown');
  const dp = document.getElementById('exp-date-panel');
  if (dd) {
    dd.style.display = 'none';
    dd.innerHTML = '';
  }
  if (dp) dp.style.display = 'none';
  _expFilterDropdownKind = null;
}

function openExpFilterDropdown(kind) {
  const dd = document.getElementById('exp-filter-dropdown');
  const dp = document.getElementById('exp-date-panel');
  if (!dd) return;
  if (_expFilterDropdownKind === kind) {
    closeExpFilterDropdown();
    return;
  }
  _expFilterDropdownKind = kind;
  if (kind === 'date') {
    dd.style.display = 'none';
    dd.innerHTML = '';
    if (dp) dp.style.display = 'block';
    return;
  }
  if (dp) dp.style.display = 'none';
  dd.style.display = 'block';
  if (kind === 'cat') {
    const ddCat = dd;
    ddCat.innerHTML = '';
    const addCatOpt = (val, lab) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = lab;
      btn.style.cssText =
        'display:block;width:100%;text-align:left;padding:8px 4px;border:none;border-bottom:0.5px solid rgba(0,0,0,0.08);background:none;font-size:13px;cursor:pointer;font-family:\'Plus Jakarta Sans\',sans-serif;color:var(--ink-1)';
      btn.onclick = () => {
        const sel = document.getElementById('expense-filter-cat');
        if (sel) sel.value = val;
        closeExpFilterDropdown();
        renderExpenses();
      };
      ddCat.appendChild(btn);
    };
    addCatOpt('', 'All categories');
    getExpenseCats().forEach((c) => addCatOpt(c, c));
  }
  if (kind === 'receipt') {
    const opts = [
      ['', 'All receipts'],
      ['attached', 'Receipt attached'],
      ['none', 'No receipt'],
    ];
    dd.innerHTML = opts
      .map(
        ([val, lab]) =>
          `<button type="button" class="exp-dd-rec" data-rec="${val}" style="display:block;width:100%;text-align:left;padding:8px 4px;border:none;border-bottom:0.5px solid rgba(0,0,0,0.08);background:none;font-size:13px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;color:var(--ink-1)">${lab}</button>`
      )
      .join('');
    dd.querySelectorAll('.exp-dd-rec').forEach((btn) => {
      btn.onclick = () => {
        const v = btn.getAttribute('data-rec') || '';
        const h = document.getElementById('expense-filter-receipt');
        if (h) h.value = v;
        closeExpFilterDropdown();
        renderExpenses();
      };
    });
  }
}

function syncExpensePillStyles() {
  const catF = document.getElementById('expense-filter-cat')?.value || '';
  const recF = document.getElementById('expense-filter-receipt')?.value || '';
  const fromF = document.getElementById('expense-filter-from')?.value || '';
  const toF = document.getElementById('expense-filter-to')?.value || '';
  const mk = (id, on) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (on) {
      el.style.background = '#2f5d4e';
      el.style.color = '#fff';
      el.style.borderColor = '#2f5d4e';
    } else {
      el.style.background = '#fff';
      el.style.color = 'var(--muted-2)';
      el.style.borderColor = 'rgba(0,0,0,0.12)';
    }
  };
  mk('exp-pill-cat', !!catF);
  mk('exp-pill-receipt', !!recF);
  mk('exp-pill-date', !!(fromF || toF));
  _setExpensePillLabel('exp-pill-cat', catF || 'All categories');
  _setExpensePillLabel('exp-pill-receipt', recF === 'attached' ? 'Receipt attached' : recF === 'none' ? 'No receipt' : 'All receipts');
  let dateLab = 'All dates';
  if (fromF && toF) dateLab = `${fromF} → ${toF}`;
  else if (fromF) dateLab = `From ${fromF}`;
  else if (toF) dateLab = `To ${toF}`;
  _setExpensePillLabel('exp-pill-date', dateLab);
}

function bindExpenseFilterUi() {
  // Use onclick assignment instead of addEventListener to avoid stale/duplicate bindings
  const search = document.getElementById('expense-search');
  if (search && !search._expBound) { search.addEventListener('input', () => renderExpenses()); search._expBound = true; }
  const pillCat = document.getElementById('exp-pill-cat');
  if (pillCat) pillCat.onclick = (ev) => { ev.stopPropagation(); openExpFilterDropdown('cat'); };
  const pillRec = document.getElementById('exp-pill-receipt');
  if (pillRec) pillRec.onclick = (ev) => { ev.stopPropagation(); openExpFilterDropdown('receipt'); };
  const pillDate = document.getElementById('exp-pill-date');
  if (pillDate) pillDate.onclick = (ev) => { ev.stopPropagation(); openExpFilterDropdown('date'); };
  document.getElementById('expense-filter-from')?.addEventListener('change', () => {
    renderExpenses();
  });
  document.getElementById('expense-filter-to')?.addEventListener('change', () => {
    renderExpenses();
  });
  document.addEventListener('click', (e) => {
    if (
      e.target.closest('#exp-filter-pills') ||
      e.target.closest('#exp-filter-dropdown') ||
      e.target.closest('#exp-date-panel')
    )
      return;
    closeExpFilterDropdown();
  });
}

function clearExpenseFilters() {
  const s = document.getElementById('expense-search');
  if (s) s.value = '';
  const c = document.getElementById('expense-filter-cat');
  if (c) c.value = '';
  const f = document.getElementById('expense-filter-from');
  if (f) f.value = '';
  const t = document.getElementById('expense-filter-to');
  if (t) t.value = '';
  const r = document.getElementById('expense-filter-receipt');
  if (r) r.value = '';
  _expShowOlderMonths = false;
  closeExpFilterDropdown();
  renderExpenses();
}

function renderExpenses() {
  if (_bankImportReviewActive) return;
  bindExpenseFilterUi();
  ensureBankImportToolbar();
  const refreshReconciliationFooter = () => void refreshFinanceReconciliationSummary();
  const expDateEl = document.getElementById('exp-date');
  if (expDateEl && !expDateEl.value) expDateEl.value = localDateStr();

  const propertyExpenses = _financeScopedExpenses();
  const q = (document.getElementById('expense-search')?.value || '').toLowerCase().trim();
  const catF = document.getElementById('expense-filter-cat')?.value || '';
  const fromF = document.getElementById('expense-filter-from')?.value || '';
  const toF = document.getElementById('expense-filter-to')?.value || '';
  const recF = document.getElementById('expense-filter-receipt')?.value || '';

  const catFilterEl = document.getElementById('expense-filter-cat');
  if (catFilterEl) {
    const seen = new Set();
    const allCats = [];
    getExpenseCats().forEach((c) => {
      if (c && !seen.has(c)) {
        seen.add(c);
        allCats.push(c);
      }
    });
    propertyExpenses.forEach((e) => {
      const c = e.category;
      if (c && !seen.has(c)) {
        seen.add(c);
        allCats.push(c);
      }
    });
    allCats.sort((a, b) => a.localeCompare(b));
    catFilterEl.innerHTML = '';
    const o0 = document.createElement('option');
    o0.value = '';
    o0.textContent = 'All Categories';
    catFilterEl.appendChild(o0);
    allCats.forEach((c) => {
      const o = document.createElement('option');
      o.value = c;
      o.textContent = c;
      if (c === catF) o.selected = true;
      catFilterEl.appendChild(o);
    });
  }

  const listEl = document.getElementById('expenses-list');
  if (!listEl) {
    refreshReconciliationFooter();
    return;
  }

  const svgClip =
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#185FA5" stroke-width="2" style="flex-shrink:0"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>';

  if (!propertyExpenses.length) {
    listEl.innerHTML =
      '<div style="text-align:center;padding:28px 16px;font-family:\'Plus Jakarta Sans\',sans-serif"><div style="font-weight:500;font-size:14px;margin-bottom:4px;color:var(--ink-1)">No expenses yet</div><div style="font-size:12px;color:var(--muted-2)">Add your first expense above</div></div>';
    syncExpensePillStyles();
    refreshReconciliationFooter();
    return;
  }

  let filtered = [...propertyExpenses].sort((a, b) => {
    const da = a.date || '';
    const db = b.date || '';
    return db > da ? 1 : db < da ? -1 : 0;
  });
  if (q)
    filtered = filtered.filter(
      (e) =>
        (e.merchant || '').toLowerCase().includes(q) ||
        (e.description || '').toLowerCase().includes(q) ||
        String(e.receiptNum || '').toLowerCase().includes(q)
    );
  if (catF) filtered = filtered.filter((e) => e.category === catF);
  if (fromF) filtered = filtered.filter((e) => e.date >= fromF);
  if (toF) filtered = filtered.filter((e) => e.date <= toF);
  if (recF === 'attached') filtered = filtered.filter(expenseHasReceiptAttached);
  if (recF === 'none') filtered = filtered.filter((e) => !expenseHasReceiptAttached(e));

  const now = new Date();
  const ym = `${now.getFullYear()}-${_finPad2(now.getMonth() + 1)}`;
  let monthSum = 0;
  let monthCnt = 0;
  let totalSum = 0;
  filtered.forEach((e) => {
    const a = Number(e.amount) || 0;
    totalSum += a;
    if ((e.date || '').length >= 7 && (e.date || '').slice(0, 7) === ym) {
      monthSum += a;
      monthCnt++;
    }
  });
  const smVal = document.getElementById('exp-stat-month-val');
  const stVal = document.getElementById('exp-stat-total-val');
  const scVal = document.getElementById('exp-stat-count-val');
  if (smVal)
    smVal.textContent =
      (monthSum < 0 ? '−' : '') +
      '$' +
      Math.abs(monthSum).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (stVal)
    stVal.textContent =
      (totalSum < 0 ? '−' : '') +
      '$' +
      Math.abs(totalSum).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (scVal) scVal.textContent = String(monthCnt);

  if (!filtered.length) {
    listEl.innerHTML =
      '<div style="padding:16px 0;color:var(--muted-2);font-size:13px;text-align:center;font-family:\'Plus Jakarta Sans\',sans-serif">No results match your filters</div>';
    const sm = document.getElementById('expenses-show-more');
    if (sm) sm.style.display = 'none';
    syncExpensePillStyles();
    refreshReconciliationFooter();
    return;
  }

  // ── Missing-receipt card (Phase 1B) ──
  const _missingReceiptCount = propertyExpenses.filter(e => Number(e.amount) > 0 && !expenseHasReceiptAttached(e)).length;
  const _missingReceiptCard = (_missingReceiptCount > 0 && recF !== 'none')
    ? '<div style="background:#FFF8F0;border:1px solid #F0DCC8;border-radius:10px;padding:12px 16px;margin:0 0 12px;display:flex;align-items:center;justify-content:space-between;cursor:pointer" onclick="document.getElementById(\'expense-filter-receipt\').value=\'none\';renderExpenses()">'
      + '<div style="display:flex;align-items:center;gap:10px">'
      + '<span style="font-size:18px">\u{1F4CE}</span>'
      + '<div>'
      + '<div style="font-weight:500;font-size:14px;color:var(--ink-1);font-family:\'Plus Jakarta Sans\',sans-serif">' + _missingReceiptCount + ' expense' + (_missingReceiptCount === 1 ? '' : 's') + ' missing receipts</div>'
      + '<div style="font-size:12px;color:var(--muted-2);font-family:\'Plus Jakarta Sans\',sans-serif">Tap to view</div>'
      + '</div></div>'
      + '<div style="color:#C7C7CC;font-size:20px;font-weight:300">\u203A</div></div>'
    : '';

  const svgBank = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle"><path d="M3 21h18"/><path d="M3 10h18"/><path d="M12 3l9 7H3l9-7z"/><path d="M5 10v8"/><path d="M10 10v8"/><path d="M14 10v8"/><path d="M19 10v8"/></svg>';

  const expRow = (e) => {
    const isRefund = Number(e.amount) < 0;
    const amtColor = isRefund ? '#1D9E75' : '#E24B4A';
    const prefix = isRefund ? '+' : '−';
    const catCol = getCategoryColor(e.category);
    const hasRec = expenseHasReceiptAttached(e);
    const isBankVerified = !!(e.reconciled || e.bank_transaction_id);
    const descPart = (e.description || '').trim();
    const line2 = `${descPart ? `${escHtml(descPart)} · ` : ''}${fmt(e.date)}`;
    const recBlock = hasRec
      ? `<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#185FA5;font-family:'Plus Jakarta Sans',sans-serif">${svgClip}Receipt</span>`
      : `<span style="font-size:11px;color:#A32D2D;font-family:'Plus Jakarta Sans',sans-serif">No receipt</span>`;
    const bankBlock = isBankVerified
      ? `<span style="display:inline-flex;align-items:center;gap:3px;font-size:11px;color:#1D9E75;font-family:'Plus Jakarta Sans',sans-serif">${svgBank} Bank verified</span>`
      : '';
    return `<div class="expense-item" data-expense-id="${e.id}" onclick="openExpenseView('${e.id}')"
      style="background:#fff;border-radius:10px;padding:12px 14px;display:flex;gap:12px;align-items:flex-start;cursor:pointer;border:0.5px solid rgba(0,0,0,0.06);
      box-shadow:0 1px 2px rgba(0,0,0,0.02);border-left:3px solid ${catCol};border-top-left-radius:0;border-bottom-left-radius:0;
      -webkit-tap-highlight-color:transparent;-webkit-user-select:none;user-select:none;font-family:'Plus Jakarta Sans',sans-serif">
      <div style="flex:1;min-width:0">
        <div style="font-weight:500;font-size:14px;color:var(--ink-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(e.merchant || 'Unknown')}</div>
        <div style="font-size:12px;color:var(--muted-2);margin-top:2px">${line2}</div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:4px;flex-wrap:wrap">
          <span style="font-size:11px;font-weight:600;color:${catCol}">${escHtml(e.category || '')}</span>
          ${recBlock}
          ${bankBlock}
        </div>
      </div>
      <div style="font-size:15px;font-weight:500;color:${amtColor};flex-shrink:0;font-family:'Plus Jakarta Sans',sans-serif">${prefix}$${Math.abs(Number(e.amount)).toFixed(2)}</div>
    </div>`;
  };

  const grouped = filtered.reduce((acc, e) => {
    const d = new Date(e.date || Date.now());
    const sk = `${d.getFullYear()}-${_finPad2(d.getMonth() + 1)}`;
    const label = d
      .toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })
      .toUpperCase();
    if (!acc[sk]) acc[sk] = { label, items: [], total: 0 };
    acc[sk].items.push(e);
    acc[sk].total += Number(e.amount) || 0;
    return acc;
  }, {});
  const monthKeys = Object.keys(grouped).sort((a, b) => b.localeCompare(a));
  let displayKeys = monthKeys;
  if (!_expShowOlderMonths && monthKeys.length > 6) displayKeys = monthKeys.slice(0, 6);

  // Desktop: table view for expenses
  if (window.innerWidth >= 1024) {
    const allFiltered = monthKeys.flatMap(sk => grouped[sk].items);
    const tblRows = allFiltered.map(e => {
      const isRefund = Number(e.amount) < 0;
      const amtColor = isRefund ? '#1D9E75' : '#A32D2D';
      const prefix = isRefund ? '+' : '';
      const catCol = getCategoryColor(e.category);
      const hasRec = expenseHasReceiptAttached(e);
      const recHtml = hasRec ? '<span style="color:#185FA5;font-size:11px">Attached</span>' : '<span style="color:#A32D2D;font-size:11px">None</span>';
      const descShort = (e.description || '').length > 40 ? (e.description || '').slice(0, 40) + '...' : (e.description || '');
      return `<tr onclick="openExpenseView('${escapeJsSingleQuotedHtmlAttr(String(e.id))}')" style="cursor:pointer">
        <td style="white-space:nowrap">${fmt(e.date)}</td>
        <td><strong style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(e.merchant || 'Unknown')}</strong>${descShort ? '<div style="font-size:11px;color:var(--muted-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(descShort) + '</div>' : ''}</td>
        <td style="white-space:nowrap"><span style="font-size:11px;font-weight:600;color:${catCol};background:${catCol}15;padding:2px 8px;border-radius:6px">${escHtml(e.category || '')}</span></td>
        <td style="white-space:nowrap">${recHtml}</td>
        <td style="text-align:right;font-weight:500;color:${amtColor};white-space:nowrap">${prefix}$${Math.abs(Number(e.amount)).toFixed(2)}</td>
      </tr>`;
    }).join('');

    // Expense categories breakdown
    const catTotals = {};
    allFiltered.forEach(e => {
      const cat = e.category || 'Other';
      catTotals[cat] = (catTotals[cat] || 0) + Math.abs(Number(e.amount) || 0);
    });
    const catBreakdown = Object.entries(catTotals)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, total]) => {
        const col = getCategoryColor(cat);
        return '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f0ede8;font-size:13px"><span style="display:flex;align-items:center;gap:6px"><span style="width:8px;height:8px;border-radius:50%;background:' + col + '"></span>' + escHtml(cat) + '</span><span style="font-weight:500">$' + total.toFixed(0) + '</span></div>';
      }).join('');

    listEl.innerHTML = _missingReceiptCard + '<div class="expenses-desktop-grid">' +
      '<div class="card expenses-table-card" style="padding:0;overflow:hidden;overflow-x:auto"><table class="desktop-table"><thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Receipt</th><th style="text-align:right">Amount</th></tr></thead><tbody>' + tblRows + '</tbody></table></div>' +
      '<div class="expenses-summary" style="display:flex;flex-direction:column;gap:16px">' +
        '<div class="card"><div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:var(--muted-2);margin-bottom:12px">This Month</div>' +
          '<div style="font-family:\'Newsreader\',serif;font-size:28px;color:var(--primary)">$' + Math.abs(monthSum).toFixed(0) + '</div>' +
          '<div style="font-size:12px;color:var(--muted-2);margin-top:4px">' + monthCnt + ' expenses</div></div>' +
        '<div class="card"><div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:var(--muted-2);margin-bottom:12px">By Category</div>' + catBreakdown + '</div>' +
      '</div></div>';
  } else {
    listEl.innerHTML = _missingReceiptCard + displayKeys
      .map((sk) => {
        const { items, label } = grouped[sk];
        return `<div class="fin-month-hdr">${escHtml(label)}</div>
          <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px">${items.map(expRow).join('')}</div>`;
      })
      .join('');
  }

  globalThis.animateList('#expenses-list');
  setTimeout(globalThis.attachLongPress, 60);

  const sm = document.getElementById('expenses-show-more');
  const tb = document.getElementById('expenses-toggle-btn');
  if (sm && tb) {
    const showEarlier = monthKeys.length > 6 && !_expShowOlderMonths;
    sm.style.display = showEarlier ? 'block' : 'none';
    tb.textContent = 'Show earlier months';
  }

  syncExpensePillStyles();
  refreshReconciliationFooter();
  checkReceiptNudge();
}

function addExpense(opts = {}) {
  const merchant = opts.merchant || document.getElementById('exp-merchant').value.trim();
  const rawAmount = opts.amount != null ? Number(opts.amount) : parseFloat(document.getElementById('exp-amount').value);
  const isRefund = opts.isRefund != null
    ? !!opts.isRefund
    : (document.getElementById('exp-is-refund')?.checked || false);
  const amount = Number.isFinite(rawAmount)
    ? (isRefund ? -Math.abs(rawAmount) : Math.abs(rawAmount))
    : NaN;
  const date = opts.date || document.getElementById('exp-date').value || localDateStr();
  const category = opts.category || document.getElementById('exp-category').value;
  const bookingId = opts.bookingId !== undefined
    ? (opts.bookingId || null)
    : (document.getElementById('exp-booking-link')?.value || null);
  if (!merchant || !amount) { globalThis.showBanner('⚠ Please fill in merchant and amount', 'warn'); return; }
  if (isExpensePhotoConverting()) { globalThis.showBanner('⟳ Please wait — receipt is still converting...', 'warn'); return; }
  // Collect up to 2 staged receipts (slot 0 = primary, slot 1 = optional second).
  const pendingReceipts = [getExpensePhotoUploadSnapshot(), getExpensePhoto2UploadSnapshot()]
    .filter(snap => snap && snap.base64);
  const exp = {
    id: Date.now(),
    merchant,
    description: opts.description || document.getElementById('exp-description').value.trim(),
    amount,
    date,
    category,
    receiptType: opts.receiptType || document.getElementById('exp-receipt-type').value,
    receiptNum: opts.receiptNum || document.getElementById('exp-receipt-num').value.trim(),
    taxNote: opts.taxNote || (document.getElementById('exp-tax-note')?.value.trim() || ''),
    photo: null,  // never store in localStorage — too large, causes silent crash
    awaitingReceipt: pendingReceipts.length ? false : (opts.awaitingReceipt || false),
    driveLink: null,
    bookingId: bookingId || null,
  };
  // Tag with active property cloud ID so the property filter shows it immediately
  // (without this, the expense is invisible until the app reloads from cloud)
  const activePid = _financeActiveCloudPropertyId();
  if (activePid) exp._propertyId = activePid;
  expenses.push(exp);
  try { globalThis.savePropertyData(); } catch(_storageErr) {
    globalThis.showBanner('⚠ Storage full — expense saved without photo', 'warn');
  }
  // Sync to Supabase (non-blocking), then auto-link to bank transaction if pending
  if (typeof saveExpenseToCloud === 'function') {
    saveExpenseToCloud(exp).then(saved => {
      const cloudId = saved && (saved.id || saved._cloudId);
      if (cloudId && typeof _autoLinkPendingReconTxn === 'function') _autoLinkPendingReconTxn(cloudId);
    }).catch(e => console.warn("[StayOps] silent error:", e));
  }

  // If this expense is linked to a booking, push the amount into that
  // booking's clean.cost and trigger the mgmt fee + net payout recompute.
  if (exp.bookingId && typeof globalThis.applyExpenseToBookingClean === 'function') {
    globalThis.applyExpenseToBookingClean(exp.bookingId, Math.abs(Number(exp.amount) || 0))
      .catch(e => console.warn('[StayOps] applyExpenseToBookingClean failed:', e));
  }

  // Upload any staged receipts (up to 2) to Supabase Storage.
  saveExpenseReceipts(exp, pendingReceipts);

  if (!opts.silent) {
    // Clear all form fields
    ['exp-merchant','exp-description','exp-amount','exp-receipt-num','exp-tax-note'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    const refundReset = document.getElementById('exp-is-refund');
    if (refundReset) refundReset.checked = false;
    const bookingLinkReset = document.getElementById('exp-booking-link');
    if (bookingLinkReset) bookingLinkReset.value = '';
    document.getElementById('exp-date').value = localDateStr();
    resetExpenseCatPicker();
    const typeSel = document.getElementById('exp-receipt-type');
    if (typeSel) typeSel.selectedIndex = 0;
    clearExpensePhoto();
    clearExpensePhoto2();
    // Close the add form and scroll receipts into view
    closeExpenseAddForm();
    renderExpenses();
    document.getElementById('expenses-main-block')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Receipts (if any) are uploaded separately via Supabase Storage by saveExpenseReceipts().
    if (!pendingReceipts.length) globalThis.showBanner('✓ Expense saved', 'ok');
    else globalThis.showBanner('⟳ Uploading receipt' + (pendingReceipts.length > 1 ? 's' : '') + '...', 'info');
  }
  return exp;
}

/**
 * Upload up to 2 staged receipts for a freshly-created expense to Supabase
 * Storage and persist their paths as the expense's driveLink array.
 * @param {object} exp - the saved expense (already in the `expenses` array)
 * @param {Array<{base64:string, mediaType:string}>} pendingReceipts - staged receipts
 */
async function saveExpenseReceipts(exp, pendingReceipts) {
  if (!pendingReceipts || !pendingReceipts.length) return;
  if (typeof uploadReceiptToStorage !== 'function') return;
  try {
    globalThis.showBanner('⟳ Uploading receipt' + (pendingReceipts.length > 1 ? 's' : '') + '...', 'info');
    const urls = [];
    for (let i = 0; i < pendingReceipts.length; i++) {
      const snap = pendingReceipts[i];
      const fakeExp = Object.assign({}, exp, { photo: snap.base64, _mediaType: snap.mediaType });
      const imgBlob = await receiptImageToPDF(fakeExp);
      const fileName = generateReceiptFileName(exp);
      const file = new File([imgBlob], fileName, { type: 'application/pdf' });
      // Upload to the compacted slot index so there are never holes in the array.
      const url = await uploadReceiptToStorage(file, exp.id, urls.length);
      if (url) urls.push(url);
    }
    if (urls.length) {
      const saved = expenses.find(e => String(e.id) === String(exp.id));
      if (saved) {
        saved.driveLink = urls;
        globalThis.savePropertyData();
        renderExpenses();
        if (typeof saveExpenseToCloud === 'function') saveExpenseToCloud(saved).catch(e => console.warn("[StayOps] silent error:", e));
        globalThis.showBanner('✓ Receipt' + (urls.length > 1 ? 's' : '') + ' uploaded', 'ok');
      } else {
        // The expense vanished mid-upload (deleted or app rehydrated) — don't
        // claim success when the receipts couldn't actually be linked.
        globalThis.showBanner('⚠ Receipt uploaded but the expense was no longer available to link', 'warn');
      }
    } else {
      const why = globalThis._lastReceiptUploadError ? ': ' + globalThis._lastReceiptUploadError : '';
      globalThis.showBanner('⚠ Receipt upload failed' + why, 'warn');
    }
  } catch (e) {
    globalThis.showBanner('⚠ Receipt upload failed: ' + e.message, 'warn');
  }
}

async function saveExpenseToDriveAndSheet(exp) {
  // ── Upload receipt to Supabase Storage ──────────────────────────────────────
  let driveLink;
  if (exp.photo) {
    try {
      globalThis.showBanner('⟳ Uploading receipt...', 'info');
      const imgBlob = await receiptImageToPDF(exp);
      const fileName = generateReceiptFileName(exp);
      const file = new File([imgBlob], fileName, { type: 'application/pdf' });
      if (typeof uploadReceiptToStorage === 'function') {
        const url = await uploadReceiptToStorage(file, exp.id, 0);
        if (url) {
          driveLink = url;
          const saved = expenses.find(e => String(e.id) === String(exp.id));
          if (saved) {
            saved.driveLink = [driveLink];
            globalThis.savePropertyData();
            renderExpenses();
            if (typeof saveExpenseToCloud === 'function') saveExpenseToCloud(saved).catch(e => console.warn("[StayOps] silent error:", e));
          }
          globalThis.showBanner('✓ Receipt uploaded', 'ok');
        } else {
          globalThis.showBanner('⚠ Receipt upload failed', 'warn');
        }
      }
    } catch(e) {
      globalThis.showBanner('⚠ Receipt upload failed: ' + e.message, 'warn');
    }
  }
}

function generateReceiptFileName(exp) {
  // ATO record-keeping format: YYYY-MM-DD_Category_Supplier_Amount
  const clean = (s, max) => String(s || '').trim().replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'NA';
  const date = (exp.date && /^\d{4}-\d{2}-\d{2}/.test(exp.date)) ? exp.date.slice(0, 10) : localDateStr();
  const category = clean(exp.category, 24);
  const supplier = clean(exp.merchant, 40);
  // dot-free amount so the only "." in the name is the .pdf extension: 45.90 -> 45-90
  const amount = Math.abs(Number(exp.amount) || 0).toFixed(2).replace('.', '-');
  return `${date}_${category}_${supplier}_${amount}.pdf`;
}

async function receiptImageToPDF(exp) {
  // Convert the attached image/photo to a single-page PDF blob.
  // Uses exp._mediaType and exp.photo (captured at submit time) — never reads globals
  // which may have been cleared by the time this async function executes.
  const mediaType = exp._mediaType || 'image/jpeg';
  const photoData = exp.photo || null;

  if (mediaType === 'application/pdf' && photoData) {
    // Already a PDF — decode and return as-is
    const bytes = atob(photoData);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    return new Blob([arr], { type: 'application/pdf' });
  }

  // Render the image onto a canvas (A4 proportions: 794×1123)
  return new Promise((resolve, _reject) => {
    const pageW = 794, pageH = 1123;
    const canvas = document.createElement('canvas');
    canvas.width = pageW; canvas.height = pageH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, pageW, pageH);

    const drawAndExport = (img) => {
      if (img) {
        const maxW = pageW - 40, maxH = pageH - 40;
        let w = img.width, h = img.height;
        if (w > maxW) { h = h * maxW / w; w = maxW; }
        if (h > maxH) { w = w * maxH / h; h = maxH; }
        ctx.drawImage(img, (pageW - w) / 2, 20, w, h);
      }
      // Get JPEG data URL from canvas, then wrap in a minimal single-image PDF
      const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.92);
      const jpegBase64 = jpegDataUrl.split(',')[1];
      const jpegBytes = atob(jpegBase64);
      const jpegLen = jpegBytes.length;

      // Build a minimal valid PDF with the JPEG embedded as an image
      const obj1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
      const obj2 = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';
      const obj3 = `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Contents 4 0 R /Resources << /XObject << /Img 5 0 R >> >> >>\nendobj\n`;
      const streamContent = `q ${pageW} 0 0 ${pageH} 0 0 cm /Img Do Q`;
      const obj4 = `4 0 obj\n<< /Length ${streamContent.length} >>\nstream\n${streamContent}\nendstream\nendobj\n`;
      const obj5header = `5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pageW} /Height ${pageH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegLen} >>\nstream\n`;
      const obj5footer = '\nendstream\nendobj\n';

      // Assemble PDF bytes
      const header = '%PDF-1.4\n';
      const enc = new TextEncoder();
      const parts = [
        enc.encode(header),
        enc.encode(obj1),
        enc.encode(obj2),
        enc.encode(obj3),
        enc.encode(obj4),
        enc.encode(obj5header),
      ];
      // JPEG bytes as Uint8Array
      const jpegArr = new Uint8Array(jpegLen);
      for (let i = 0; i < jpegLen; i++) jpegArr[i] = jpegBytes.charCodeAt(i);
      parts.push(jpegArr);
      parts.push(enc.encode(obj5footer));

      // Calculate xref offsets
      let _offset = 0;
      const offsets = [];
      const _preXref = parts.slice(0, -1); // everything before xref
      let runningOffset = header.length;
      offsets.push(runningOffset); runningOffset += obj1.length;
      offsets.push(runningOffset); runningOffset += obj2.length;
      offsets.push(runningOffset); runningOffset += obj3.length;
      offsets.push(runningOffset); runningOffset += obj4.length;
      offsets.push(runningOffset);

      const xref = `xref\n0 6\n0000000000 65535 f \n${offsets.map(o=>String(o).padStart(10,'0')+' 00000 n ').join('\n')}\n`;
      const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${runningOffset + obj5header.length + jpegLen + obj5footer.length}\n%%EOF`;

      parts.push(enc.encode(xref + trailer));

      // Merge all parts into a single Blob
      resolve(new Blob(parts, { type: 'application/pdf' }));
    };

    if (photoData) {
      const img = new Image();
      img.onload = () => drawAndExport(img);
      img.onerror = () => drawAndExport(null);
      img.src = 'data:' + mediaType + ';base64,' + photoData;
    } else {
      drawAndExport(null);
    }
  });
}

async function deleteExpense(id) {
  const ok = await globalThis.showAppModal({ title: 'Delete Expense', msg: 'Remove this expense? This cannot be undone.', confirmText: 'Delete', confirmColor: 'var(--red)' });
  if (!ok) return;
  const exp = expenses.find(e => String(e.id) === String(id));
  replaceArrayInPlace(expenses, expenses.filter(e => String(e.id) !== String(id)));
  globalThis.savePropertyData();
  renderExpenses();
  globalThis.showBanner('✓ Expense deleted', 'ok');
  // Sync deletion to Supabase (non-blocking)
  if (exp && typeof deleteExpenseFromCloud === 'function') deleteExpenseFromCloud(exp).catch(e => console.warn("[StayOps] silent error:", e));
}
// ── EXPENSE EDIT ─────────────────────────────────────────────────────────────
let editingExpenseId = null;
let editingExpensePhotoBase64 = null;
let editingExpenseMediaType = 'image/jpeg';

function attachEditExpensePhoto(input) {
  const file = input.files[0];
  if (!file) return;
  editingExpenseMediaType = file.type || 'image/jpeg';
  const reader = new FileReader();
  reader.onload = function(ev) {
    editingExpensePhotoBase64 = ev.target.result.split(',')[1];
    document.getElementById('ee-photo-img').src = ev.target.result;
    document.getElementById('ee-photo-preview').style.display = 'block';
    document.getElementById('ee-receipt-label').textContent = 'New receipt selected — will upload on save';
  };
  reader.readAsDataURL(file);
}
function clearEditExpensePhoto() {
  editingExpensePhotoBase64 = null;
  editingReceiptTargetIndex = 0;
  document.getElementById('ee-photo-preview').style.display = 'none';
  document.getElementById('ee-file-input').value = '';
  const e = expenses.find(x => String(x.id) === String(editingExpenseId) || String(x._cloudId) === String(editingExpenseId));
  if (e) refreshEditReceiptUI(e);
}
function openExpenseView(id) {
  const e = expenses.find(x => String(x.id) === String(id) || String(x._cloudId) === String(id));
  if (!e) return;
  const isRefund   = Number(e.amount) < 0;
  const amtColor   = isRefund ? '#27AE60' : '#C0392B';
  const amtDisplay = (isRefund ? '−' : '') + '$' + Math.abs(Number(e.amount)).toFixed(2);

  // ── Receipt action block ────────────────────────────────────────────────────
  const receiptLinks = normalizeDriveLinks(e.driveLink);
  let receiptBlock;
  if (receiptLinks.length > 0) {
    receiptBlock = receiptLinks.map((link, i) => `
      <button onclick="openReceiptViewer('${escapeJsSingleQuotedHtmlAttr(link)}', this, '${escapeJsSingleQuotedHtmlAttr(generateReceiptFileName(e))}')"
         style="display:flex;align-items:center;justify-content:center;gap:8px;
                width:100%;padding:11px;box-sizing:border-box;
                background:var(--surface2);border:1.5px solid var(--moss);border-radius:10px;
                color:var(--moss);font-weight:600;font-size:13px;cursor:pointer;
                font-family:'Plus Jakarta Sans',sans-serif${i > 0 ? ';margin-top:8px' : ''}">
        📎 View Receipt${receiptLinks.length > 1 ? ' ' + (i + 1) : ''}
      </button>`).join('');
  } else if (e.awaitingReceipt) {
    receiptBlock = `<div style="font-size:13px;color:var(--amber);padding:4px 0">⚠ Receipt awaiting upload</div>`;
  } else if (!e.receiptType || e.receiptType === 'missing') {
    receiptBlock = `<div style="font-size:13px;color:var(--red);padding:4px 0">✕ No receipt on file</div>`;
  } else {
    receiptBlock = `<div style="font-size:13px;color:var(--moss);padding:4px 0">✓ Receipt on file (${e.receiptType === 'e-receipt' ? 'e-receipt' : 'printed'})</div>`;
  }

  document.getElementById('detail-content').innerHTML = `
    <!-- ── Header: merchant + amount ── -->
    <div style="margin-bottom:16px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
        <div style="min-width:0;flex:1">
          <div style="font-family:inherit;font-size:16px;font-weight:500;color:var(--ink-1);line-height:1.15;
                      word-break:break-word">${escHtml(e.merchant||'Unknown')}</div>
          ${e.description ? `<div style="font-size:13px;font-weight:400;color:#999;margin-top:4px">${escHtml(e.description)}</div>` : ''}
        </div>
        <div style="flex-shrink:0;text-align:right">
          <div style="font-family:'Newsreader',serif;font-size:26px;font-weight:700;
                      color:${amtColor};line-height:1">${amtDisplay}</div>
          ${isRefund ? `<div style="font-size:10px;font-weight:600;color:#27AE60;letter-spacing:0.3px;margin-top:2px;text-transform:uppercase">Refund</div>` : ''}
        </div>
      </div>
    </div>

    <!-- ── Supporting details ── -->
    <div class="card" style="margin-bottom:14px">
      <div class="detail-row">
        <span class="detail-label">Date</span>
        <span class="detail-val">${fmt(e.date)}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Category</span>
        <span class="detail-val">${escHtml(e.category||'—')}</span>
      </div>
      <div class="detail-row" style="${!e.receiptNum ? 'border-bottom:none' : ''}">
        <span class="detail-label">Receipt type</span>
        <span class="detail-val">${e.receiptType ? (e.receiptType === 'e-receipt' ? 'e-Receipt' : e.receiptType.charAt(0).toUpperCase() + e.receiptType.slice(1)) : '—'}</span>
      </div>
      ${e.receiptNum ? `
      <div class="detail-row" style="border-bottom:none">
        <span class="detail-label">Receipt #</span>
        <span class="detail-val">${escHtml(String(e.receiptNum))}</span>
      </div>` : ''}
    </div>

    <!-- ── Receipt access ── -->
    <div style="margin-bottom:20px">${receiptBlock}</div>

    <!-- ── Primary action ── -->
    <button class="btn-primary" style="width:100%;margin-bottom:8px"
            onclick="globalThis.closeDetailModal();openExpenseEdit('${e.id}')">✏️ Edit Expense</button>

    <!-- ── Destructive action (secondary) ── -->
    <button class="btn-secondary" style="width:100%;margin-bottom:8px;background:#FDECEA;color:var(--red);border-color:#FDECEA"
            onclick="globalThis.closeDetailModal();deleteExpense('${e.id}')">🗑 Delete Expense</button>
  `;
  document.getElementById('detail-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(globalThis.attachModalHandleDrag, 0);
}

let editingReceiptTargetIndex = 0;

function openExpenseEdit(id) {
  const e = expenses.find(x => String(x.id) === String(id) || String(x._cloudId) === String(id));
  if (!e) return;
  editingExpenseId = id;
  editingExpensePhotoBase64 = null;
  editingReceiptTargetIndex = 0;
  document.getElementById('ee-merchant').value = e.merchant || '';
  document.getElementById('ee-description').value = e.description || '';
  const eeAmt = Number(e.amount) || 0;
  document.getElementById('ee-amount').value = eeAmt ? Math.abs(eeAmt) : '';
  const eeRefund = document.getElementById('ee-is-refund');
  if (eeRefund) eeRefund.checked = eeAmt < 0;
  document.getElementById('ee-date').value = e.date || '';
  document.getElementById('ee-receipt-num').value = e.receiptNum || '';
  const eeTaxNote = document.getElementById('ee-tax-note');
  if (eeTaxNote) eeTaxNote.value = e.taxNote || '';
  const eeHidden = document.getElementById('ee-category');
  if (eeHidden) eeHidden.value = e.category || '';
  renderExpenseCatPickerFor('ee');
  document.getElementById('ee-receipt-type').value = String(e.receiptType || 'missing').toLowerCase().trim();
  if (typeof renderExpenseBookingPicker === 'function') renderExpenseBookingPicker('ee', e.bookingId || '');
  refreshEditReceiptUI(e);
  document.getElementById('ee-photo-preview').style.display = 'none';
  document.getElementById('ee-upload-status').style.display = 'none';
  document.getElementById('ee-file-input').value = '';
  document.getElementById('expense-edit-modal').classList.add('open'); document.body.style.overflow='hidden';
}

function refreshEditReceiptUI(e) {
  const links = normalizeDriveLinks(e.driveLink);
  const slot1 = document.getElementById('ee-receipt-slot-1');
  const slot2 = document.getElementById('ee-receipt-slot-2');
  const link1El = document.getElementById('ee-receipt-link-1');
  const link2El = document.getElementById('ee-receipt-link-2');
  const addAnotherBtn = document.getElementById('ee-add-another-btn');
  const uploadBtn = document.getElementById('ee-upload-btn');
  const labelEl = document.getElementById('ee-receipt-label');

  if (links[0]) {
    slot1.style.display = 'block';
    link1El.href = '#';
    link1El.onclick = (ev) => { ev.preventDefault(); window.openReceiptViewer(links[0], null, generateReceiptFileName(e)); };
    link1El.textContent = '📎 Receipt 1';
  } else {
    slot1.style.display = 'none';
  }

  if (links[1]) {
    slot2.style.display = 'block';
    link2El.href = '#';
    link2El.onclick = (ev) => { ev.preventDefault(); window.openReceiptViewer(links[1], null, generateReceiptFileName(e)); };
    link2El.textContent = '📎 Receipt 2';
  } else {
    slot2.style.display = 'none';
  }

  if (links.length === 1) {
    addAnotherBtn.style.display = 'inline-block';
    uploadBtn.style.display = 'inline-block';
    labelEl.textContent = 'Replace receipt or add another';
  } else if (links.length >= 2) {
    addAnotherBtn.style.display = 'none';
    uploadBtn.style.display = 'none';
    labelEl.textContent = 'Maximum 2 receipts attached';
  } else {
    addAnotherBtn.style.display = 'none';
    uploadBtn.style.display = 'inline-block';
    labelEl.textContent = 'Upload receipt photo';
  }
  editingReceiptTargetIndex = links.length === 1 ? 0 : 0;
}

function triggerSecondReceiptUpload() {
  editingReceiptTargetIndex = 1;
  document.getElementById('ee-file-input').click();
  document.getElementById('ee-receipt-label').textContent = 'Upload second receipt';
}

function removeEditReceipt(index) {
  const e = expenses.find(x => String(x.id) === String(editingExpenseId) || String(x._cloudId) === String(editingExpenseId));
  if (!e) return;
  const links = normalizeDriveLinks(e.driveLink);
  links.splice(index, 1);
  e.driveLink = links.length ? links : [];
  refreshEditReceiptUI(e);
  globalThis.savePropertyData();
  if (typeof saveExpenseToCloud === 'function') saveExpenseToCloud(e).catch(err => console.warn('[StayOps] saveExpenseToCloud failed:', err));
  renderExpenses();
}
function closeExpenseEdit() {
  document.getElementById('expense-edit-modal').classList.remove('open'); globalThis._checkModalsClosed();
  const eeSuggest = document.getElementById('ee-ai-suggest-card');
  if (eeSuggest) eeSuggest.style.display = 'none';
  editingExpenseId = null;
  editingExpensePhotoBase64 = null;
}
async function saveExpenseEdit() {
  const e = expenses.find(x => String(x.id) === String(editingExpenseId) || String(x._cloudId) === String(editingExpenseId));
  if (!e) return;
  e.merchant = document.getElementById('ee-merchant').value.trim();
  e.description = document.getElementById('ee-description').value.trim();
  const eeRaw = parseFloat(document.getElementById('ee-amount').value) || 0;
  const eeIsRefund = document.getElementById('ee-is-refund')?.checked || false;
  e.amount = eeIsRefund ? -Math.abs(eeRaw) : Math.abs(eeRaw);
  e.date = document.getElementById('ee-date').value;
  e.category = document.getElementById('ee-category').value;
  e.receiptType = document.getElementById('ee-receipt-type').value;
  e.receiptNum = document.getElementById('ee-receipt-num').value.trim();
  e.taxNote = (document.getElementById('ee-tax-note')?.value || '').trim();
  const prevBookingId = e.bookingId || null;
  e.bookingId = document.getElementById('ee-booking-link')?.value || null;

  // Upload new receipt photo if one was selected
  if (editingExpensePhotoBase64) {
    const statusEl = document.getElementById('ee-upload-status');
    statusEl.style.display = 'block';
    statusEl.style.color = 'var(--muted-2)';
    statusEl.textContent = '⟳ Uploading receipt...';
    try {
      const fakeExp = Object.assign({}, e, { photo: editingExpensePhotoBase64, _mediaType: editingExpenseMediaType });
      const imgBlob = await receiptImageToPDF(fakeExp);
      const fileName = generateReceiptFileName(e);
      const file = new File([imgBlob], fileName, { type: 'application/pdf' });
      if (typeof uploadReceiptToStorage === 'function') {
        const url = await uploadReceiptToStorage(file, e.id, editingReceiptTargetIndex);
        if (url) {
          const links = normalizeDriveLinks(e.driveLink);
          links[editingReceiptTargetIndex] = url;
          e.driveLink = links;
          statusEl.style.color = 'var(--moss)';
          statusEl.textContent = '✓ Receipt uploaded';
          globalThis.showBanner('✓ Receipt saved', 'ok');
        } else {
          statusEl.style.color = 'var(--red)';
          statusEl.textContent = '⚠ Upload failed';
          globalThis.showBanner('⚠ Receipt upload failed', 'warn');
        }
      }
    } catch(err) {
      statusEl.style.color = 'var(--red)';
      statusEl.textContent = '⚠ Upload failed: ' + err.message;
      globalThis.showBanner('⚠ Upload failed: ' + err.message, 'warn');
    }
    editingReceiptTargetIndex = 0;
  }

  globalThis.savePropertyData();
  if (typeof saveExpenseToCloud === 'function') saveExpenseToCloud(e).catch(err => console.warn('[StayOps] saveExpenseToCloud failed:', err));

  // Mirror the expense amount onto the linked booking's clean cost (and
  // recompute mgmt fee + net payout). When the user unlinks a previously
  // linked expense, clear the cost on the old booking.
  if (prevBookingId && prevBookingId !== e.bookingId && typeof globalThis.clearExpenseFromBookingClean === 'function') {
    globalThis.clearExpenseFromBookingClean(prevBookingId)
      .catch(err => console.warn('[StayOps] clearExpenseFromBookingClean failed:', err));
  }
  if (e.bookingId && typeof globalThis.applyExpenseToBookingClean === 'function') {
    globalThis.applyExpenseToBookingClean(e.bookingId, Math.abs(Number(e.amount) || 0))
      .catch(err => console.warn('[StayOps] applyExpenseToBookingClean failed:', err));
  }

  closeExpenseEdit();
  renderExpenses();
  globalThis.showBanner('✓ Expense updated', 'ok');
}
// ── PROPERTY DATA ─────────────────────────────────────────────────────────


const DEFAULT_EXPENSE_CATS = [
  'Cleaning & Garden',
  'Maintenance & Repairs',
  'Supplies & Consumables',
  'Utilities',
  'Council Rates & Strata',
  'Insurance',
  'Mortgage',
  'Furnishings & Linen',
  'Professional Services',
  'Advertising',
  'Other'
];
/** Populate the booking-link <select> beneath the cleaning category. Lists
 *  past confirmed bookings in the last 120 days (newest first). Hidden until
 *  the category includes "cleaning". */
function renderExpenseBookingPicker(prefix, currentValue) {
  prefix = prefix || 'exp';
  const sel = document.getElementById(prefix + '-booking-link');
  const wrap = document.getElementById(prefix + '-booking-link-wrap');
  if (!sel) return;

  const todayStr = localDateStr();
  const cutoff = localDateStr(new Date(Date.now() - 120 * 86400000));
  const list = (Array.isArray(bookings) ? bookings : [])
    .filter(b => b && isRevenueBearingBooking(b) && b.checkout && b.checkout <= todayStr && b.checkout >= cutoff)
    .sort((a, b) => String(b.checkout).localeCompare(String(a.checkout)));

  sel.innerHTML = '<option value="">— No booking —</option>' + list.map(b => {
    const id = String(b._cloudId || b.id || '');
    const label = `${b.name || 'Guest'} · ${b.checkin || '?'} → ${b.checkout || '?'}`;
    return `<option value="${escHtml(id)}">${escHtml(label)}</option>`;
  }).join('');
  if (currentValue) sel.value = String(currentValue);

  // Show / hide based on category
  const cat = (document.getElementById(prefix + '-category')?.value || '').toLowerCase();
  if (wrap) wrap.style.display = cat.includes('cleaning') ? 'block' : 'none';
}
globalThis.renderExpenseBookingPicker = renderExpenseBookingPicker;

function getExpenseCats() {
  const cats = window._appConfig && window._appConfig.expense_cats;
  if (Array.isArray(cats) && cats.length > 0 && cats.every(c => typeof c === 'string' && c.trim())) {
    return cats;
  }
  return DEFAULT_EXPENSE_CATS;
}
globalThis.getExpenseCats = getExpenseCats;

// Subcategories rendered as <optgroup> children under the parent category in
// the picker. Keep the parent value selectable as "<parent> (general)" so
// pre-existing rows that just say "Mortgage" or "Furnishings & Linen" stay
// valid — only new entries need to pick a subcat.
//
// Mortgage split: interest is a P&L expense, principal is a balance-sheet
// item, fees are sometimes deductible. Lumping them all under "Mortgage"
// inflates costs in the P&L. Split them so the accountant export is honest.
//
// Furnishings split: linen/towels are consumables; furniture and appliances
// are usually depreciable capital assets — they need to be tracked separately
// for the depreciation schedule.
const EXPENSE_SUBCATS = {
  'Mortgage': ['Interest', 'Principal', 'Bank/Loan Fees'],
  'Furnishings & Linen': ['Linen & Towels', 'Furniture', 'Appliances'],
};

function renderExpenseCatPickerFor(prefix) {
  prefix = prefix || 'exp';
  const sel = document.getElementById(prefix + '-category');
  if (!sel || sel.tagName !== 'SELECT') return;
  const cats = getExpenseCats();
  const currentVal = sel.value || '';

  sel.innerHTML = '<option value="">Select a category…</option>';
  cats.forEach(c => {
    const subs = EXPENSE_SUBCATS[c] || [];
    if (subs.length) {
      const og = document.createElement('optgroup');
      og.label = c;
      const top = document.createElement('option');
      top.value = c; top.textContent = c + ' (general)';
      if (currentVal === c) top.selected = true;
      og.appendChild(top);
      subs.forEach(s => {
        const o = document.createElement('option');
        o.value = c + ' > ' + s; o.textContent = s;
        if (currentVal === c + ' > ' + s) o.selected = true;
        og.appendChild(o);
      });
      sel.appendChild(og);
    } else {
      const o = document.createElement('option');
      o.value = c; o.textContent = c;
      if (currentVal === c) o.selected = true;
      sel.appendChild(o);
    }
  });

  // Re-render the booking picker so it shows/hides based on the new category.
  // Attach once per <select> via a sentinel data attribute.
  if (!sel.dataset.bookingLinkWired) {
    sel.addEventListener('change', () => renderExpenseBookingPicker(prefix, document.getElementById(prefix + '-booking-link')?.value || ''));
    sel.dataset.bookingLinkWired = '1';
  }
  renderExpenseBookingPicker(prefix, document.getElementById(prefix + '-booking-link')?.value || '');
}
globalThis.renderExpenseCatPickerFor = renderExpenseCatPickerFor;

function renderExpenseCatPicker() { renderExpenseCatPickerFor('exp'); }
globalThis.renderExpenseCatPicker = renderExpenseCatPicker;

function toggleExpenseCat(cat, prefix) {
  prefix = prefix || 'exp';
  const sel = document.getElementById(prefix + '-category');
  if (!sel) return;
  sel.value = sel.value === cat ? '' : cat;
}
globalThis.toggleExpenseCat = toggleExpenseCat;

function selectExpenseSubcat(cat, sub, prefix) {
  prefix = prefix || 'exp';
  const sel = document.getElementById(prefix + '-category');
  if (!sel) return;
  sel.value = cat + ' > ' + sub;
}
globalThis.selectExpenseSubcat = selectExpenseSubcat;

function resetExpenseCatPicker() {
  const sel = document.getElementById('exp-category');
  if (sel) sel.value = '';
}
globalThis.resetExpenseCatPicker = resetExpenseCatPicker;

// ── OWNER REPORT ──────────────────────────────────────────────────────────────

function populateMgmtFeePanel() {
  const rate = (window._appConfig && window._appConfig.mgmt_fee_rate) != null
    ? String(window._appConfig.mgmt_fee_rate)
    : '';
  const el = document.getElementById("settings-mgmt-fee-rate");
  if (el) el.value = rate !== null ? rate : "";
  _renderExpensePayoutModeUI(getExpensePayoutMode());
  _renderExpenseCatToggles();
}

async function saveMgmtFeeRate() {
  const el = document.getElementById("settings-mgmt-fee-rate");
  if (!el) return;
  const rate = parseFloat(el.value);
  if (isNaN(rate) || rate < 0 || rate > 100) { globalThis.showBanner("⚠ Enter a valid fee between 0 and 100", "warn"); return; }
  window._appConfig = window._appConfig || {};
  window._appConfig.mgmt_fee_rate = rate;
  if (typeof saveAppConfigToCloud === 'function') {
    saveAppConfigToCloud({ mgmt_fee_rate: rate }).catch(e => console.warn("[StayOps] silent error:", e));
  }
  const confirm = document.getElementById("mgmt-fee-confirm");
  if (confirm) { confirm.style.display = "block"; setTimeout(() => { confirm.style.display = "none"; }, 2000); }
  globalThis.showBanner("✓ Management fee rate saved", "ok");
}

function getExpensePayoutMode() {
  const cfg = getActivePropertyConfig();
  return (cfg.settings && cfg.settings.expense_payout_mode) || 'deduct';
}

function setExpensePayoutMode(mode) {
  if (mode !== 'deduct' && mode !== 'separate') return;
  const cfg = getActivePropertyConfig();
  savePropertyConfig({ settings: { ...(cfg.settings || {}), expense_payout_mode: mode } });
  _renderExpensePayoutModeUI(mode);
  globalThis.showBanner(mode === 'deduct' ? '✓ Expenses will be deducted from owner payout' : '✓ Expenses will be shown separately', 'ok');
}
globalThis.setExpensePayoutMode = setExpensePayoutMode;

function _renderExpensePayoutModeUI(mode) {
  const deductRadio   = document.getElementById('expense-mode-deduct');
  const separateRadio = document.getElementById('expense-mode-separate');
  const deductLabel   = document.getElementById('expense-mode-deduct-label');
  const separateLabel = document.getElementById('expense-mode-separate-label');
  if (deductRadio)   deductRadio.checked   = mode === 'deduct';
  if (separateRadio) separateRadio.checked  = mode === 'separate';
  if (deductLabel)   deductLabel.style.borderColor   = mode === 'deduct'   ? 'var(--primary)' : 'var(--hairline-1)';
  if (separateLabel) separateLabel.style.borderColor  = mode === 'separate' ? 'var(--primary)' : 'var(--hairline-1)';
}

function _renderExpenseCatToggles() {
  const container = document.getElementById('expense-cat-toggles');
  if (!container) return;
  const ownerPaid = _getOwnerPaidCategories();
  const cats = BANK_IMPORT_EXPENSE_CATS.filter(c => c !== 'other');
  container.innerHTML = cats.map(cat => {
    const isOwner = ownerPaid.includes(cat);
    const label = bankImportFormatCategoryLabel(cat);
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:0.5px solid rgba(0,0,0,0.06)">
      <span style="font-size:13px;font-weight:500;color:var(--text)">${escHtml(label)}</span>
      <div style="display:flex;gap:0;border-radius:6px;overflow:hidden;border:1px solid var(--hairline-1)">
        <button onclick="toggleExpenseCatMode('${cat}','deduct')" id="ecat-${cat}-deduct" style="padding:5px 10px;font-size:11px;font-weight:600;border:none;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;transition:background 0.15s;background:${!isOwner ? 'var(--primary)' : 'white'};color:${!isOwner ? 'white' : 'var(--muted-2)'}">Deduct</button>
        <button onclick="toggleExpenseCatMode('${cat}','owner')" id="ecat-${cat}-owner" style="padding:5px 10px;font-size:11px;font-weight:600;border:none;border-left:1px solid var(--hairline-1);cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;transition:background 0.15s;background:${isOwner ? '#E24B4A' : 'white'};color:${isOwner ? 'white' : 'var(--muted-2)'}">Owner pays</button>
      </div>
    </div>`;
  }).join('');
}

function toggleExpenseCatMode(cat, mode) {
  const cfg = getActivePropertyConfig();
  const current = (cfg.settings && cfg.settings.owner_paid_categories) || ['mortgage', 'insurance', 'council_rates', 'strata'];
  let updated;
  if (mode === 'owner') {
    updated = current.includes(cat) ? current : [...current, cat];
  } else {
    updated = current.filter(c => c !== cat);
  }
  savePropertyConfig({ settings: { ...(cfg.settings || {}), owner_paid_categories: updated } });
  _renderExpenseCatToggles();
  const label = bankImportFormatCategoryLabel(cat);
  globalThis.showBanner(mode === 'owner' ? label + ' → owner pays directly' : label + ' → deducted from payout', 'ok');
}
globalThis.toggleExpenseCatMode = toggleExpenseCatMode;

function _setVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}

function _updateOwnerReportToggleUI(on) {
  const track = document.getElementById('owner-autosend-toggle');
  const thumb = document.getElementById('owner-autosend-thumb');
  if (track) track.style.background = on ? 'var(--primary)' : 'var(--border, #C7C7CC)';
  if (thumb) thumb.style.transform  = on ? 'translateX(18px)' : 'translateX(0)';
}

function ownerAutoSendToggle() {
  window._ownerAutoSend = !window._ownerAutoSend;
  _updateOwnerReportToggleUI(window._ownerAutoSend);
}

/**
 * saveOwnerReportSettings — reads the panel fields and persists to config + Supabase.
 */
function saveOwnerReportSettings() {
  const name    = (document.getElementById('owner-report-name')    || {}).value || '';
  const email   = (document.getElementById('owner-report-email')   || {}).value || '';
  const phone   = (document.getElementById('owner-report-phone')   || {}).value || '';
  const subject = (document.getElementById('owner-report-subject') || {}).value || '';
  const body    = (document.getElementById('owner-report-body')    || {}).value || '';
  const autoSend = !!window._ownerAutoSend;
  const freq    = (document.getElementById('owner-report-frequency') || {}).value || 'monthly';
  // Phase 6: ON toggle = host manages this property for the owner.
  // isSelfManaged is the OPPOSITE: true when host owns it.
  const isSelfManaged = !window._propManagedForOwner;

  // Preserve lastReportSentAt — don't overwrite it here
  const existing = getActivePropertyConfig().owner || {};

  savePropertyConfig({
    isSelfManaged,
    owner: {
      name,
      email,
      phone,
      reportEmailSubject: subject,
      reportEmailBody:    body,
      autoSendReport:     autoSend,
      reportFrequency:    freq,
      lastReportSentAt:   existing.lastReportSentAt || null,
    }
  });

  globalThis.showBanner('✓ Owner & report settings saved', 'ok');
}

/**
 * sendOwnerReport — generates the PDF for the chosen FY and emails it via Legacy Sync.
 */
async function sendOwnerReport() {
  if (!window.jspdf) { globalThis.showBanner('⟳ PDF library loading — try again in a moment', 'warn'); return; }

  const cfg     = getActivePropertyConfig();
  const owner   = cfg.owner || {};
  const ownerEmail = owner.email || '';

  if (!ownerEmail) {
    globalThis.showBanner('⚠ No owner email set — add one in Owner & Reports settings', 'warn');
    return;
  }

  const fyEl = document.getElementById('owner-report-send-fy');
  const fy   = fyEl ? Number(fyEl.value) : reportFY;

  const btn    = document.getElementById('owner-report-send-btn');
  const status = document.getElementById('owner-report-send-status');
  if (btn)    { btn.disabled = true; btn.textContent = 'Sending…'; }
  if (status) { status.style.color = 'var(--muted-2)'; status.textContent = 'Building PDF…'; }

  try {
    // 1. Build PDF and get base64 string
    const doc      = _buildReportDoc(fy);
    const pdfB64   = doc.output('datauristring').split(',')[1]; // base64 only
    const fileName = `${getCurrentPropertyName().replace(/[^a-zA-Z0-9]/g,'-')}-${fyLabel(fy).replace(/\s/g,'_')}.pdf`;

    // 2. Compose email
    const propName = getCurrentPropertyName();
    const defaultSubject = `${propName} — ${fyLabel(fy)} Performance Report`;
    const subject  = (owner.reportEmailSubject || '').trim() || defaultSubject;
    const bodyIntro = (owner.reportEmailBody || '').trim()
      || `Hi${owner.name ? ' ' + owner.name.split(' ')[0] : ''},\n\nPlease find attached the ${fyLabel(fy)} financial performance report for ${propName}.\n\nKind regards`;

    if (status) status.textContent = 'Sending email…';

    // 3. Send via Netlify function (Resend API) with PDF attachment
    const html = bodyIntro.replace(/\n/g, '<br>');
    const _af = typeof globalThis.authFetch === 'function' ? globalThis.authFetch : fetch;
    const res = await _af('/.netlify/functions/send-email', {
      method: 'POST',
      body: JSON.stringify({
        to: ownerEmail, subject, html,
        attachments: [{ filename: fileName, content: pdfB64 }]
      })
    });
    const json = await res.json().catch(() => ({}));

    if (json.success || json.status === 'ok') {
      // 4. Record timestamp
      const now = new Date().toISOString();
      const existingOwner = getActivePropertyConfig().owner || {};
      savePropertyConfig({ owner: { ...existingOwner, lastReportSentAt: now } });

      if (status) { status.style.color = 'var(--primary)'; status.textContent = '✓ Report sent to ' + ownerEmail; }
      globalThis.showBanner('✅ Report emailed to ' + ownerEmail, 'ok');

      // Refresh the last-sent label
      const lastSentEl = document.getElementById('owner-report-last-sent-row');
      if (lastSentEl) {
        const d = new Date(now);
        lastSentEl.textContent = 'Last sent: ' + d.toLocaleDateString('en-AU', { day:'numeric', month:'short', year:'numeric' });
      }
    } else {
      const errMsg = json.error || json.message || 'Unknown error';
      if (status) { status.style.color = 'var(--red)'; status.textContent = '✗ Failed: ' + errMsg; }
      globalThis.showBanner('⚠ Report send failed — ' + errMsg, 'warn');
    }
  } catch (e) {
    if (status) { status.style.color = 'var(--red)'; status.textContent = '✗ Error: ' + e.message; }
    globalThis.showBanner('⚠ Report send error — ' + e.message, 'warn');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Send Report'; }
  }
}

// ── REPORT EXPORT ─────────────────────────────────────────────────────────────
/**
 * _buildReportDoc(fy) — shared PDF builder. Returns a jsPDF doc object.
 * Used by both exportReportPDF() and sendOwnerReport().
 */
function _buildReportDoc(fy) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const FOREST = [30, 58, 47];
  const _SAGE   = [143, 175, 133];
  const SOFT   = [120, 120, 120];
  const fw = 190; // usable width
  let y = 15;

  // Header
  doc.setFillColor(...FOREST);
  doc.rect(0, 0, 210, 22, 'F');
  doc.setTextColor(255,255,255);
  doc.setFontSize(16); doc.setFont('helvetica','bold');
  doc.text(getCurrentPropertyName() + ' — Performance Report', 10, 14);
  doc.setFontSize(9); doc.setFont('helvetica','normal');
  doc.text(fyLabel(fy) + ' · Generated ' + new Date().toLocaleDateString('en-AU'), 200, 14, { align:'right' });
  y = 30;

  // KPI row
  doc.setTextColor(...FOREST);
  doc.setFontSize(9); doc.setFont('helvetica','bold');
  const months = fyMonths(fy);
  const propertyBookings = _financeScopedBookings();
  const propertyExpenses = _financeScopedExpenses();
  function mdata(yr, mo) {
    const bs = propertyBookings.filter(b => isRevenueBearingBooking(b) && (function(){ const d=new Date(b.checkin); return d.getFullYear()===yr&&d.getMonth()===mo; })());
    const avail = new Date(yr,mo+1,0).getDate();
    const booked = bs.reduce((s,b)=>s+Number(b.nights||0),0);
    const rev = bs.reduce((s,b)=>s+bookingRevenue(b),0);
    const net = bs.reduce((s,b)=>s+bookingNetPayout(b),0);
    return { bs, avail, booked, rev, net };
  }
  const allM = months.map(({year,month}) => ({ ...mdata(year,month), label:['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][month] }));
  const fyRev = allM.reduce((s,m)=>s+m.rev,0);
  const fyNet = allM.reduce((s,m)=>s+m.net,0);
  const fyNights = allM.reduce((s,m)=>s+m.booked,0);
  const fyAvail = allM.reduce((s,m)=>s+m.avail,0);
  const fyOcc = fyAvail ? (fyNights/fyAvail*100) : 0;
  const allExp = propertyExpenses.filter(e => {
    const d=new Date(e.date); const mo=d.getMonth(); const yr=d.getFullYear();
    return (yr===fy&&mo>=6)||(yr===fy+1&&mo<=5);
  });
  const fyTotalExp = allExp.reduce((s,e)=>s+Number(e.amount||0),0);
  const fyNetInc = fyNet - fyTotalExp;

  const kpis = [
    { label:'Total Revenue', val: fmt2(fyRev) },
    { label:'Owner Payout',  val: fmt2(fyNet) },
    { label:'Net Income',    val: fmt2(Math.abs(fyNetInc)) + (fyNetInc<0?' (Loss)':'') },
    { label:'Occupancy',     val: fyOcc.toFixed(0)+'%' },
  ];
  const kw = fw/4;
  kpis.forEach((k,i) => {
    const x = 10 + i*kw;
    doc.setFillColor(240,246,240);
    doc.roundedRect(x, y, kw-3, 18, 2, 2, 'F');
    doc.setFontSize(14); doc.setFont('helvetica','bold'); doc.setTextColor(...FOREST);
    doc.text(k.val, x + (kw-3)/2, y+11, { align:'center' });
    doc.setFontSize(7); doc.setFont('helvetica','normal'); doc.setTextColor(...SOFT);
    doc.text(k.label.toUpperCase(), x + (kw-3)/2, y+16, { align:'center' });
  });
  y += 25;

  // Revenue by Platform
  doc.setFontSize(11); doc.setFont('helvetica','bold'); doc.setTextColor(...FOREST);
  doc.text('Revenue by Month & Platform', 10, y); y += 4;
  const platforms = ['Airbnb','VRBO','Direct'];
  doc.autoTable({
    startY: y, margin: { left:10, right:10 },
    head: [['Month','Airbnb','VRBO','Direct','Total']],
    body: [
      ...allM.map(m => [
        m.label,
        ...platforms.map(p => { const r=m.bs.filter(b=>_canonicalPlatformName(b.platform)===p).reduce((s,b)=>s+bookingRevenue(b),0); return r?fmt2(r):'—'; }),
        m.rev ? fmt2(m.rev) : '—'
      ]),
      ['Total', ...platforms.map(p=>fmt2(allM.reduce((s,m)=>s+m.bs.filter(b=>_canonicalPlatformName(b.platform)===p).reduce((ss,b)=>ss+bookingRevenue(b),0),0))), fmt2(fyRev)]
    ],
    headStyles: { fillColor: FOREST, textColor:[255,255,255], fontSize:8, fontStyle:'bold' },
    bodyStyles: { fontSize:9 },
    alternateRowStyles: { fillColor:[248,252,248] },
    foot: [], showFoot: 'never',
    didDrawRow: (data) => { if (data.row.index === allM.length) data.row.cells.forEach(c => { c.styles.fontStyle='bold'; c.styles.fillColor=[220,236,220]; }); }
  });
  y = doc.lastAutoTable.finalY + 8;

  // Occupancy & Performance
  doc.setFontSize(11); doc.setFont('helvetica','bold'); doc.setTextColor(...FOREST);
  doc.text('Occupancy & Performance', 10, y); y += 4;
  doc.autoTable({
    startY: y, margin: { left:10, right:10 },
    head: [['Month','Avail','Booked','Occ%','ADR','RevPAR']],
    body: [
      ...allM.map(m => [
        m.label, m.avail, m.booked,
        m.avail ? (m.booked/m.avail*100).toFixed(0)+'%' : '—',
        m.booked ? '$'+Math.round(m.rev/m.booked) : '—',
        m.avail  ? '$'+Math.round(m.rev/m.avail)  : '—',
      ]),
      ['FY Total', fyAvail, fyNights, fyOcc.toFixed(0)+'%', fyNights?'$'+Math.round(fyRev/fyNights):'—', '$'+Math.round(fyRev/fyAvail)]
    ],
    headStyles: { fillColor: FOREST, textColor:[255,255,255], fontSize:8, fontStyle:'bold' },
    bodyStyles: { fontSize:9 },
    alternateRowStyles: { fillColor:[248,252,248] },
  });
  y = doc.lastAutoTable.finalY + 4;
  doc.setFontSize(7); doc.setFont('helvetica','normal'); doc.setTextColor(...SOFT);
  doc.text('ADR = Revenue ÷ Booked Nights   ·   RevPAR = Revenue ÷ All Available Nights   ·   ALOS = Avg Length of Stay', 10, y);
  y += 8;

  // Expenses
  const expCats = getExpenseCats();
  const expByCategory = {};
  expCats.forEach(c => { expByCategory[c] = allExp.filter(e=>e.category===c).reduce((s,e)=>s+Number(e.amount||0),0); });
  if (allExp.length) {
    doc.setFontSize(11); doc.setFont('helvetica','bold'); doc.setTextColor(...FOREST);
    doc.text('Expenses by Category', 10, y); y += 4;
    doc.autoTable({
      startY: y, margin: { left:10, right:10 },
      head: [['Category','Amount','%']],
      body: [
        ...expCats.filter(c=>expByCategory[c]>0).sort((a,b)=>expByCategory[b]-expByCategory[a]).map(c => [
          c, fmt2(expByCategory[c]), fyTotalExp?(expByCategory[c]/fyTotalExp*100).toFixed(0)+'%':'—'
        ]),
        ['Total Expenses', fmt2(fyTotalExp), '100%']
      ],
      headStyles: { fillColor: FOREST, textColor:[255,255,255], fontSize:8 },
      bodyStyles: { fontSize:9 },
      alternateRowStyles: { fillColor:[248,252,248] },
    });
    y = doc.lastAutoTable.finalY + 8;
  }

  // Net Income Summary
  doc.setFontSize(11); doc.setFont('helvetica','bold'); doc.setTextColor(...FOREST);
  doc.text('Net Income Summary', 10, y); y += 4;
  doc.autoTable({
    startY: y, margin: { left:10, right:10 },
    head: [['Item','Amount']],
    body: [
      ['Total Revenue (Gross)', fmt2(fyRev)],
      ['Owner Payout (after fees)', fmt2(fyNet)],
      ['Total Expenses', '- ' + fmt2(fyTotalExp)],
      ['Net Income', (fyNetInc<0?'- ':'')+fmt2(Math.abs(fyNetInc))],
    ],
    headStyles: { fillColor: FOREST, textColor:[255,255,255], fontSize:8 },
    bodyStyles: { fontSize:9 },
    alternateRowStyles: { fillColor:[248,252,248] },
    didDrawRow: data => { if (data.row.index===3) { data.row.cells.forEach(c => { c.styles.fontStyle='bold'; c.styles.fillColor=fyNetInc>=0?[220,236,220]:[254,226,226]; }); } }
  });

  return doc;
}

function exportReportPDF() {
  if (!window.jspdf) { globalThis.showBanner('⟳ PDF library loading, try again in a moment','warn'); return; }
  const doc = _buildReportDoc(reportFY);
  doc.save(`${getCurrentPropertyName()}-${fyLabel(reportFY).replace(' ','_')}.pdf`);
}


function exportReportCSV() {
  const months = fyMonths(reportFY);
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const rows = [[getCurrentPropertyName() + ' Performance Report — ' + fyLabel(reportFY)],[]];
  const propertyBookings = _financeScopedBookings();
  const propertyExpenses = _financeScopedExpenses();

  // Revenue table — excludes cancelled bookings to stay consistent with on-screen reports.
  rows.push(['Revenue by Month & Platform']);
  rows.push(['Month','Airbnb','VRBO','Direct','Total']);
  months.forEach(({year,month}) => {
    const bs = propertyBookings.filter(b => isRevenueBearingBooking(b) && (()=>{ const d=new Date(b.checkin); return d.getFullYear()===year&&d.getMonth()===month; })());
    const rev = p => bs.filter(b=>_canonicalPlatformName(b.platform)===p).reduce((s,b)=>s+bookingRevenue(b),0);
    const total = bs.reduce((s,b)=>s+bookingRevenue(b),0);
    rows.push([mo[month], rev('Airbnb')||'', rev('VRBO')||'', rev('Direct')||'', total||'']);
  });
  rows.push([]);

  // Occupancy table — also excludes cancelled bookings.
  rows.push(['Occupancy & Performance']);
  rows.push(['Month','Available Nights','Booked Nights','Occupancy%','ADR','RevPAR']);
  months.forEach(({year,month}) => {
    const bs = propertyBookings.filter(b => isRevenueBearingBooking(b) && (()=>{ const d=new Date(b.checkin); return d.getFullYear()===year&&d.getMonth()===month; })());
    const avail = new Date(year,month+1,0).getDate();
    const booked = bs.reduce((s,b)=>s+Number(b.nights||0),0);
    const rev = bs.reduce((s,b)=>s+bookingRevenue(b),0);
    rows.push([mo[month], avail, booked,
      avail ? (booked/avail*100).toFixed(1)+'%' : '',
      booked ? (rev/booked).toFixed(2) : '',
      avail  ? (rev/avail).toFixed(2)  : ''
    ]);
  });
  rows.push([]);

  // Expenses
  const allExp = propertyExpenses.filter(e => {
    const d=new Date(e.date); const m=d.getMonth(); const yr=d.getFullYear();
    return (yr===reportFY&&m>=6)||(yr===reportFY+1&&m<=5);
  });
  rows.push(['Expenses by Category']);
  rows.push(['Category','Amount']);
  const expCats = getExpenseCats();
  expCats.forEach(c => {
    const total = allExp.filter(e=>e.category===c).reduce((s,e)=>s+Number(e.amount||0),0);
    if (total) rows.push([c, total.toFixed(2)]);
  });

  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${getCurrentPropertyName()}-${fyLabel(reportFY).replace(' ','_')}.csv`;
  a.click(); URL.revokeObjectURL(url);
  globalThis.showBanner('✅ CSV downloaded','success');
}

/* ────────────────────────────────────────────────────────────────────────────
 *  TAX EXPORT (Phase 4) — ATO-ready PDF & CSV
 * ──────────────────────────────────────────────────────────────────────────── */

let _taxExportFY = (() => {
  const now = new Date();
  return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
})();

function taxExportFYPrev() { _taxExportFY--; showTaxExportView(); }
function taxExportFYNext() { _taxExportFY++; showTaxExportView(); }

/** Expenses scoped to a given FY (July to June). Same logic as renderReport. */
function _taxFYExpenses(fy) {
  const propertyExpenses = _financeScopedExpenses();
  return propertyExpenses.filter(e => {
    const d = new Date(e.date);
    const m = d.getMonth(); const yr = d.getFullYear();
    return (yr === fy && m >= 6) || (yr === fy + 1 && m <= 5);
  });
}

/** Group expenses by ATO field, returning sorted array of { field, label, expenses, total, withReceipt, missingReceipt }. */
function _taxGroupByATO(fyExpenses) {
  const groups = {};
  fyExpenses.forEach(e => {
    const field = getAtoField(e.category);
    const label = ATO_FIELD_LABELS[field] || 'Sundry / Other';
    if (!groups[field]) groups[field] = { field, label, expenses: [], total: 0, withReceipt: 0, missingReceipt: 0 };
    groups[field].expenses.push(e);
    groups[field].total += Number(e.amount || 0);
    if (expenseHasReceiptAttached(e)) groups[field].withReceipt++;
    else groups[field].missingReceipt++;
  });
  return Object.values(groups).sort((a, b) => b.total - a.total);
}

/** Compute host management income across ALL properties for a given FY.
 *  Returns { byProperty: [{ propertyId, propertyName, total }], grandTotal }.
 */
function _hostMgmtIncomeForFY(fy) {
  const allBookings = Array.isArray(bookings) ? bookings : [];
  const months = fyMonths(fy);
  const props = getAllProperties() || [];
  const cloudIds = window._cloudPropertyIds || {};

  // Build a map: cloud property ID -> property name
  const nameMap = {};
  props.forEach(p => {
    const cloudId = p.supabaseId || cloudIds[p.propertyId] || '';
    if (cloudId) nameMap[cloudId] = p.name || 'Unnamed Property';
    // Also map the local propertyId in case bookings use it
    if (p.propertyId) nameMap[p.propertyId] = p.name || 'Unnamed Property';
  });

  // Filter bookings to this FY and accumulate mgmtPayout by property
  const totals = {}; // propertyId -> total
  months.forEach(({ year, month }) => {
    allBookings.forEach(b => {
      if (!isRevenueBearingBooking(b)) return;
      const d = new Date(b.checkin);
      if (d.getFullYear() !== year || d.getMonth() !== month) return;
      const pid = _bookingPropertyId(b) || 'unknown';
      const amt = bookingMgmtPayout(b);
      if (amt <= 0) return;
      totals[pid] = (totals[pid] || 0) + amt;
    });
  });

  const byProperty = Object.entries(totals)
    .map(([pid, total]) => ({ propertyId: pid, propertyName: nameMap[pid] || pid, total }))
    .sort((a, b) => b.total - a.total);
  const grandTotal = byProperty.reduce((s, p) => s + p.total, 0);
  return { byProperty, grandTotal };
}

function showTaxExportView() {
  const el = document.getElementById('finance-tax-export-view');
  if (el) fadeTransition(el, true);

  const fy = _taxExportFY;
  const fyLbl = document.getElementById('tax-export-fy-label');
  if (fyLbl) fyLbl.textContent = fyLabel(fy);

  const allExp = _taxFYExpenses(fy);
  const totalAmt = allExp.reduce((s, e) => s + Number(e.amount || 0), 0);
  const withReceipt = allExp.filter(e => expenseHasReceiptAttached(e)).length;
  const pct = allExp.length ? Math.round(withReceipt / allExp.length * 100) : 0;

  // Depreciation total
  const depTotal = typeof globalThis.getTotalDepreciationForFY === 'function' ? globalThis.getTotalDepreciationForFY(fy) : 0;

  const summaryEl = document.getElementById('tax-export-summary');
  if (summaryEl) {
    summaryEl.textContent = `${allExp.length} expenses \u00B7 $${totalAmt.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} total \u00B7 ${pct}% with receipts \u00B7 $${depTotal.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} depreciation`;
  }

  // Preview: ATO category breakdown
  const groups = _taxGroupByATO(allExp);
  const previewEl = document.getElementById('tax-export-preview');
  if (previewEl) {
    let html = '<div class="card" style="padding:16px">';
    html += '<div style="font-weight:500;font-size:14px;margin-bottom:12px;color:var(--ink-1)">Deductions by ATO Category</div>';
    if (groups.length === 0) {
      html += '<div style="font-size:13px;color:var(--muted-2)">No expenses recorded for this financial year.</div>';
    } else {
      groups.forEach(g => {
        const missingBadge = g.missingReceipt > 0
          ? ` <span style="display:inline-block;background:#D44;color:#fff;font-size:10px;font-weight:600;border-radius:8px;padding:1px 6px;margin-left:4px;vertical-align:middle">${g.missingReceipt} no receipt</span>`
          : '';
        html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:0.5px solid rgba(0,0,0,0.06)">
          <div>
            <div style="font-size:13px;font-weight:500;color:var(--ink-1)">${escHtml(g.label)}${missingBadge}</div>
            <div style="font-size:11px;color:var(--muted-2)">${g.expenses.length} item${g.expenses.length !== 1 ? 's' : ''}</div>
          </div>
          <div style="font-size:14px;font-weight:500;color:#1D9E75">$${g.total.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</div>
        </div>`;
      });
      if (depTotal > 0) {
        html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:0.5px solid rgba(0,0,0,0.06)">
          <div>
            <div style="font-size:13px;font-weight:500;color:var(--ink-1)">Depreciation (Assets)</div>
            <div style="font-size:11px;color:var(--muted-2)">From asset register</div>
          </div>
          <div style="font-size:14px;font-weight:500;color:#1D9E75">$${depTotal.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</div>
        </div>`;
      }
      const grandTotal = totalAmt + depTotal;
      html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0 0">
        <div style="font-size:13px;font-weight:600;color:var(--ink-1)">Total Deductions</div>
        <div style="font-size:15px;font-weight:600;color:#2f5d4e">$${grandTotal.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</div>
      </div>`;
    }
    html += '</div>';
    previewEl.innerHTML = html;
  }

  // ── Host Management Income card ──
  const hostIncome = _hostMgmtIncomeForFY(fy);
  let hostEl = document.getElementById('tax-export-host-income');
  if (!hostEl) {
    hostEl = document.createElement('div');
    hostEl.id = 'tax-export-host-income';
    hostEl.style.fontFamily = "'Plus Jakarta Sans',sans-serif";
    const previewContainer = document.getElementById('tax-export-preview');
    if (previewContainer) previewContainer.parentNode.insertBefore(hostEl, previewContainer.nextSibling);
  }
  if (hostEl) {
    const fmtAU = n => '$' + Number(n).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    let hHtml = '<div class="card" style="padding:16px;margin-top:12px">';
    hHtml += '<div style="font-weight:500;font-size:14px;margin-bottom:4px;color:var(--ink-1)">\uD83D\uDCCA Host Management Income (Your Tax)</div>';
    hHtml += `<div style="font-size:11px;color:var(--muted-2);margin-bottom:12px">${fyLabel(fy)} \u00B7 All properties</div>`;
    if (hostIncome.byProperty.length === 0) {
      hHtml += '<div style="font-size:13px;color:var(--muted-2)">No management fee income recorded for this financial year.</div>';
    } else {
      hostIncome.byProperty.forEach(p => {
        hHtml += `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:0.5px solid rgba(0,0,0,0.06)">
          <div style="font-size:13px;font-weight:500;color:var(--ink-1)">${escHtml(p.propertyName)}</div>
          <div style="font-size:14px;font-weight:500;color:#1D9E75">${fmtAU(p.total)}</div>
        </div>`;
      });
      hHtml += `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0 0">
        <div style="font-size:13px;font-weight:600;color:var(--ink-1)">Total Management Income</div>
        <div style="font-size:15px;font-weight:600;color:#2f5d4e">${fmtAU(hostIncome.grandTotal)}</div>
      </div>`;
    }
    hHtml += '<div style="font-size:11px;color:var(--muted-2);margin-top:10px;font-style:italic">This is your management fee income for your own tax return.</div>';
    hHtml += '</div>';
    hostEl.innerHTML = hHtml;
  }
}

/* ── Tax PDF Export ───────────────────────────────────────────────────────── */

function exportTaxPDF() {
  if (!window.jspdf) { globalThis.showBanner('\u27F3 PDF library loading, try again in a moment', 'warn'); return; }
  const fy = _taxExportFY;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const FOREST = [30, 58, 47];
  const _SAGE   = [143, 175, 133];
  const SOFT   = [120, 120, 120];
  const _fw = 190; // usable width
  let y;

  // ── 1. Header ──
  doc.setFillColor(...FOREST);
  doc.rect(0, 0, 210, 26, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(16); doc.setFont('helvetica', 'bold');
  doc.text(getCurrentPropertyName() + ' \u2014 Tax Summary', 10, 12);
  doc.setFontSize(11); doc.setFont('helvetica', 'normal');
  doc.text(fyLabel(fy), 10, 19);
  doc.setFontSize(9);
  const genDate = 'Generated ' + new Date().toLocaleDateString('en-AU');
  const host = typeof globalThis.getHostProfile === 'function' ? globalThis.getHostProfile() : null;
  const abnLine = host && host.abn ? 'ABN ' + host.abn + '  \u00B7  ' + genDate : genDate;
  doc.text(abnLine, 200, 19, { align: 'right' });
  y = 34;

  // ── 2. Rental Income ──
  const months = fyMonths(fy);
  const propertyBookings = _financeScopedBookings();
  const platforms = ['Airbnb', 'VRBO', 'Direct'];
  const platRevs = {};
  let fyTotalRev = 0;
  platforms.forEach(p => { platRevs[p] = 0; });
  months.forEach(({ year, month }) => {
    const bs = propertyBookings.filter(b => isRevenueBearingBooking(b) && (() => { const d = new Date(b.checkin); return d.getFullYear() === year && d.getMonth() === month; })());
    bs.forEach(b => {
      const amt = bookingRevenue(b);
      fyTotalRev += amt;
      const p = _canonicalPlatformName(b.platform); // normalises "airbnb" -> "Airbnb" etc
      if (platRevs[p] !== undefined) platRevs[p] += amt;
      else platRevs['Direct'] += amt;
    });
  });

  doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.setTextColor(...FOREST);
  doc.text('Rental Income', 10, y); y += 4;
  const incomeBody = platforms.filter(p => platRevs[p] > 0).map(p => [p, fmt2(platRevs[p])]);
  if (incomeBody.length === 0) incomeBody.push(['No bookings recorded', '\u2014']);
  incomeBody.push(['Total Rental Income', fmt2(fyTotalRev)]);
  doc.autoTable({
    startY: y, margin: { left: 10, right: 10 },
    head: [['Platform', 'Total Revenue']],
    body: incomeBody,
    headStyles: { fillColor: FOREST, textColor: [255, 255, 255], fontSize: 8, fontStyle: 'bold' },
    bodyStyles: { fontSize: 9 },
    alternateRowStyles: { fillColor: [248, 252, 248] },
    didDrawRow: data => {
      if (data.row.index === incomeBody.length - 1) {
        Object.values(data.row.cells).forEach(c => { c.styles.fontStyle = 'bold'; c.styles.fillColor = [220, 236, 220]; });
      }
    }
  });
  y = doc.lastAutoTable.finalY + 8;

  // ── 3. Deductions by ATO Category ──
  const allExp = _taxFYExpenses(fy);
  const groups = _taxGroupByATO(allExp);
  const fyTotalExp = allExp.reduce((s, e) => s + Number(e.amount || 0), 0);

  doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.setTextColor(...FOREST);
  doc.text('Deductions by ATO Category', 10, y); y += 4;

  if (groups.length > 0) {
    const deductBody = groups.map(g => [g.label, String(g.expenses.length), fmt2(g.total), String(g.withReceipt), String(g.missingReceipt)]);
    deductBody.push(['Total Expenses', String(allExp.length), fmt2(fyTotalExp), '', '']);
    doc.autoTable({
      startY: y, margin: { left: 10, right: 10 },
      head: [['ATO Category', 'Items', 'Total', 'Receipts', 'Missing']],
      body: deductBody,
      headStyles: { fillColor: FOREST, textColor: [255, 255, 255], fontSize: 8, fontStyle: 'bold' },
      bodyStyles: { fontSize: 9 },
      alternateRowStyles: { fillColor: [248, 252, 248] },
      didDrawRow: data => {
        // Highlight rows with missing receipts in amber
        if (data.row.index < groups.length) {
          const g = groups[data.row.index];
          if (g && g.missingReceipt > 0) {
            Object.values(data.row.cells).forEach(c => { c.styles.fillColor = [255, 248, 230]; });
          }
        }
        // Bold total row
        if (data.row.index === deductBody.length - 1) {
          Object.values(data.row.cells).forEach(c => { c.styles.fontStyle = 'bold'; c.styles.fillColor = [220, 236, 220]; });
        }
      }
    });
    y = doc.lastAutoTable.finalY + 8;
  } else {
    doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(...SOFT);
    doc.text('No expenses recorded for this financial year.', 10, y); y += 8;
  }

  // ── 4. Depreciation Schedule ──
  const depAssets = typeof globalThis.getDepreciationAssets === 'function' ? globalThis.getDepreciationAssets() : [];
  const activePid = getActivePropertyId();
  const filteredAssets = depAssets.filter(a => !a.propertyId || a.propertyId === activePid);
  let depTotal = 0;

  if (filteredAssets.length > 0) {
    // Check if we need a new page
    if (y > 240) { doc.addPage(); y = 15; }
    doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.setTextColor(...FOREST);
    doc.text('Depreciation Schedule', 10, y); y += 4;

    const depBody = filteredAssets.map(a => {
      const depAmt = typeof globalThis.getAssetDepreciationForFY === 'function'
        ? globalThis.getAssetDepreciationForFY(a, fy) : 0;
      depTotal += depAmt;
      return [
        a.name || 'Unnamed',
        fmt2(Number(a.cost || 0)),
        a.method === 'straight_line' ? 'Straight Line' : 'Diminishing',
        (a.usefulLife || '') + ' yr',
        fmt2(depAmt)
      ];
    });
    depBody.push(['Total Depreciation', '', '', '', fmt2(depTotal)]);
    doc.autoTable({
      startY: y, margin: { left: 10, right: 10 },
      head: [['Asset Name', 'Cost', 'Method', 'Life', 'FY Deduction']],
      body: depBody,
      headStyles: { fillColor: FOREST, textColor: [255, 255, 255], fontSize: 8, fontStyle: 'bold' },
      bodyStyles: { fontSize: 9 },
      alternateRowStyles: { fillColor: [248, 252, 248] },
      didDrawRow: data => {
        if (data.row.index === depBody.length - 1) {
          Object.values(data.row.cells).forEach(c => { c.styles.fontStyle = 'bold'; c.styles.fillColor = [220, 236, 220]; });
        }
      }
    });
    y = doc.lastAutoTable.finalY + 8;
  }

  // ── 5. Summary ──
  if (y > 240) { doc.addPage(); y = 15; }
  doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.setTextColor(...FOREST);
  doc.text('Tax Summary', 10, y); y += 4;

  const totalDeductions = fyTotalExp + depTotal;
  const netRentalIncome = fyTotalRev - totalDeductions;
  const withReceipt = allExp.filter(e => expenseHasReceiptAttached(e)).length;
  const receiptPct = allExp.length ? Math.round(withReceipt / allExp.length * 100) : 100;

  const summaryBody = [
    ['Total Rental Income', fmt2(fyTotalRev)],
    ['Total Expense Deductions', '- ' + fmt2(fyTotalExp)],
    ['Total Depreciation Deductions', '- ' + fmt2(depTotal)],
    ['Total Deductions', '- ' + fmt2(totalDeductions)],
    ['Net Rental Income' + (netRentalIncome < 0 ? ' (Loss)' : ''), (netRentalIncome < 0 ? '- ' : '') + fmt2(Math.abs(netRentalIncome))],
    ['Receipt Coverage', withReceipt + ' of ' + allExp.length + ' expenses (' + receiptPct + '%)'],
  ];
  doc.autoTable({
    startY: y, margin: { left: 10, right: 10 },
    head: [['Item', 'Amount']],
    body: summaryBody,
    headStyles: { fillColor: FOREST, textColor: [255, 255, 255], fontSize: 8, fontStyle: 'bold' },
    bodyStyles: { fontSize: 9 },
    alternateRowStyles: { fillColor: [248, 252, 248] },
    didDrawRow: data => {
      if (data.row.index === 4) {
        Object.values(data.row.cells).forEach(c => {
          c.styles.fontStyle = 'bold';
          c.styles.fillColor = netRentalIncome >= 0 ? [220, 236, 220] : [254, 226, 226];
        });
      }
    }
  });

  // ── 6. Host Management Income ──
  y = doc.lastAutoTable.finalY + 8;
  const hostIncome = _hostMgmtIncomeForFY(fy);
  if (hostIncome.byProperty.length > 0) {
    if (y > 240) { doc.addPage(); y = 15; }
    doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.setTextColor(...FOREST);
    doc.text('Host Management Income Summary', 10, y); y += 2;
    doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(...SOFT);
    doc.text('Management fees earned across all properties — for the host\'s own tax return', 10, y); y += 4;

    const hostBody = hostIncome.byProperty.map(p => [p.propertyName, fmt2(p.total)]);
    hostBody.push(['Total Management Income', fmt2(hostIncome.grandTotal)]);
    doc.autoTable({
      startY: y, margin: { left: 10, right: 10 },
      head: [['Property', 'Management Fee Income']],
      body: hostBody,
      headStyles: { fillColor: FOREST, textColor: [255, 255, 255], fontSize: 8, fontStyle: 'bold' },
      bodyStyles: { fontSize: 9 },
      alternateRowStyles: { fillColor: [248, 252, 248] },
      didDrawRow: data => {
        if (data.row.index === hostBody.length - 1) {
          Object.values(data.row.cells).forEach(c => { c.styles.fontStyle = 'bold'; c.styles.fillColor = [220, 236, 220]; });
        }
      }
    });
  }

  doc.save(`${getCurrentPropertyName()}-Tax_Summary-${fyLabel(fy).replace(/ /g, '_')}.pdf`);
  globalThis.showBanner('\u2705 Tax PDF exported', 'success');
}

/* ── Tax CSV Export ───────────────────────────────────────────────────────── */

function exportTaxCSV() {
  const fy = _taxExportFY;
  const allExp = _taxFYExpenses(fy);
  const rows = [];

  // Header row \u2014 extended with the Phase 0 / 2b columns the accountant cares about.
  // Category is now split into Parent + Subcategory so values like
  // "Mortgage > Interest" sort cleanly (interest is deductible, principal isn't).
  rows.push([getCurrentPropertyName() + ' \u2014 Tax Export \u2014 ' + fyLabel(fy)]);
  rows.push([]);
  rows.push([
    'Date',
    'Merchant',
    'Description',
    'Category',
    'Subcategory',
    'ATO Tax Field',
    'Amount',
    'GST',
    'Paid By',
    'Recoverable from Owner',
    'Tax Note',
    'Receipt Status',
    'Bank Reconciled',
  ]);

  // Sort by date ascending
  const sorted = allExp.slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  sorted.forEach(e => {
    const atoField = getAtoFieldLabel(e.category);
    const receiptStatus = expenseHasReceiptAttached(e) ? 'Yes' : 'No';
    const reconciled = e.reconciled ? 'Yes' : 'No';
    // Split "Parent > Sub" into two columns; if there's no subcat, leave it empty
    const catRaw = String(e.category || '');
    const splitIdx = catRaw.indexOf(' > ');
    const categoryParent = splitIdx >= 0 ? catRaw.slice(0, splitIdx) : catRaw;
    const subcategory   = splitIdx >= 0 ? catRaw.slice(splitIdx + 3) : '';
    const gstStr = (e.gst != null && Number.isFinite(Number(e.gst))) ? Number(e.gst).toFixed(2) : '';
    const paidBy = e.paidBy || e.paid_by || 'host';
    const recoverable = (e.recoverableFromOwner === true || e.recoverable_from_owner === true) ? 'Yes' : 'No';
    const taxNote = e.taxNote || e.tax_note || '';
    rows.push([
      e.date || '',
      e.merchant || '',
      e.description || '',
      categoryParent,
      subcategory,
      atoField,
      Number(e.amount || 0).toFixed(2),
      gstStr,
      paidBy,
      recoverable,
      taxNote,
      receiptStatus,
      reconciled
    ]);
  });

  // Depreciation section
  const depAssets = typeof globalThis.getDepreciationAssets === 'function' ? globalThis.getDepreciationAssets() : [];
  const activePid = getActivePropertyId();
  const filteredAssets = depAssets.filter(a => !a.propertyId || a.propertyId === activePid);

  if (filteredAssets.length > 0) {
    rows.push([]);
    rows.push(['Depreciation Schedule']);
    rows.push(['Asset Name', 'Purchase Date', 'Cost', 'Method', 'Useful Life (yr)', 'FY Deduction']);
    let depTotal = 0;
    filteredAssets.forEach(a => {
      const depAmt = typeof globalThis.getAssetDepreciationForFY === 'function'
        ? globalThis.getAssetDepreciationForFY(a, fy) : 0;
      depTotal += depAmt;
      rows.push([
        a.name || '',
        a.purchaseDate || '',
        Number(a.cost || 0).toFixed(2),
        a.method === 'straight_line' ? 'Straight Line' : 'Diminishing Value',
        a.usefulLife || '',
        depAmt.toFixed(2)
      ]);
    });
    rows.push(['Total Depreciation', '', '', '', '', depTotal.toFixed(2)]);
  }

  // Summary section
  const fyTotalExp = allExp.reduce((s, e) => s + Number(e.amount || 0), 0);
  const depTotalAll = filteredAssets.reduce((s, a) => {
    return s + (typeof globalThis.getAssetDepreciationForFY === 'function' ? globalThis.getAssetDepreciationForFY(a, fy) : 0);
  }, 0);
  rows.push([]);
  rows.push(['Summary']);
  rows.push(['Total Expenses', fyTotalExp.toFixed(2)]);
  rows.push(['Total Depreciation', depTotalAll.toFixed(2)]);
  rows.push(['Total Deductions', (fyTotalExp + depTotalAll).toFixed(2)]);

  // Host Management Income section
  const hostIncome = _hostMgmtIncomeForFY(fy);
  if (hostIncome.byProperty.length > 0) {
    rows.push([]);
    rows.push(['HOST MANAGEMENT INCOME']);
    rows.push(['Property', 'Management Fee Income']);
    hostIncome.byProperty.forEach(p => {
      rows.push([p.propertyName, p.total.toFixed(2)]);
    });
    rows.push(['Total Management Income', hostIncome.grandTotal.toFixed(2)]);
    rows.push([]);
    rows.push(['Note: This is management fee income for the host\'s own tax return.']);
  }

  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${getCurrentPropertyName()}-Tax_Export-${fyLabel(fy).replace(/ /g, '_')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  globalThis.showBanner('\u2705 Tax CSV downloaded', 'success');
}

/* ────────────────────────────────────────────────────────────────────────────
 *  RECONCILIATION / TRANSACTION MAP VIEW
 * ──────────────────────────────────────────────────────────────────────────── */

let _reconTxns = [];         // cached list from last fetch
let _reconFilter = 'all';    // current pill filter

function showReconciliationView() {
  const el = document.getElementById('finance-reconciliation-view');
  if (el) fadeTransition(el, true);
  renderReconciliationView();
}

async function renderReconciliationView() {
  const summaryBar = document.getElementById('reconciliation-summary-bar');
  const filtersEl  = document.getElementById('reconciliation-filters');
  const listEl     = document.getElementById('reconciliation-list');
  if (!summaryBar || !filtersEl || !listEl) return;

  // Show loading state
  listEl.innerHTML = '<div style="text-align:center;padding:24px;color:var(--muted-2);font-size:13px;font-family:\'Plus Jakarta Sans\',sans-serif">Loading transactions...</div>';

  const user = await getCurrentSupabaseUser();
  if (!user) {
    listEl.innerHTML = '<div style="text-align:center;padding:24px;color:var(--muted-2);font-size:13px">Sign in to view transactions.</div>';
    summaryBar.innerHTML = '';
    filtersEl.innerHTML = '';
    return;
  }

  _reconTxns = await getAllTransactionsWithStatus(user.id);
  _reconFilter = 'all';

  if (_reconTxns.length === 0) {
    summaryBar.innerHTML = '';
    filtersEl.innerHTML = '';
    listEl.innerHTML = '<div style="text-align:center;padding:24px;color:var(--muted-2);font-size:13px;font-family:\'Plus Jakarta Sans\',sans-serif">No bank transactions imported yet. Use <b>Import bank CSV</b> in the Expenses view to get started.</div>';
    return;
  }

  // Compute totals per status (Phase 2c: matched_payout is the new credit-side
  // status — money in that's tied to a Phase 1 platform_payouts row).
  const totals = { matched: 0, matched_payout: 0, unaccounted: 0, personal: 0, skipped: 0 };
  for (const t of _reconTxns) {
    totals[t.status] = (totals[t.status] || 0) + Math.abs(t.amount);
  }
  const hasAnyCredits = _reconTxns.some(t => t.direction === 'credit');

  // Render summary bar — Payouts tile only shows when there's at least one
  // credit on file, so existing expense-only users keep the same layout.
  const payoutsTile = hasAnyCredits
    ? `<div style="flex:1;min-width:100px;background:#E3F2FD;border-radius:8px;padding:8px 12px;text-align:center">
         <div style="font-size:18px;font-weight:600;color:#1565C0">$${_fmtAud(totals.matched_payout)}</div>
         <div style="font-size:11px;color:#1976D2">Payouts</div>
       </div>`
    : '';
  summaryBar.innerHTML = `
    <div style="display:flex;gap:8px;padding:0 16px;margin:0 auto 12px;max-width:560px;flex-wrap:wrap">
      <div style="flex:1;min-width:100px;background:#E8F5E9;border-radius:8px;padding:8px 12px;text-align:center">
        <div style="font-size:18px;font-weight:600;color:#2E7D32">$${_fmtAud(totals.matched)}</div>
        <div style="font-size:11px;color:#388E3C">Matched</div>
      </div>
      ${payoutsTile}
      <div style="flex:1;min-width:100px;background:#FFF3E0;border-radius:8px;padding:8px 12px;text-align:center">
        <div style="font-size:18px;font-weight:600;color:#E65100">$${_fmtAud(totals.unaccounted)}</div>
        <div style="font-size:11px;color:#F57C00">Unaccounted</div>
      </div>
      <div style="flex:1;min-width:100px;background:#F3E5F5;border-radius:8px;padding:8px 12px;text-align:center">
        <div style="font-size:18px;font-weight:600;color:#7B1FA2">$${_fmtAud(totals.personal)}</div>
        <div style="font-size:11px;color:#9C27B0">Personal</div>
      </div>
    </div>`;

  // Render filter pills
  renderReconciliationFilters(filtersEl);

  // Render list
  renderReconciliationList(listEl);
}

function renderReconciliationFilters(container) {
  // Only surface the Payouts pill when there's at least one credit row,
  // otherwise it's noise for expense-only users.
  const hasAnyCredits = (_reconTxns || []).some(t => t.direction === 'credit');
  const pills = [
    { key: 'all', label: 'All' },
    { key: 'matched', label: 'Matched' },
    ...(hasAnyCredits ? [{ key: 'matched_payout', label: 'Payouts' }] : []),
    { key: 'unaccounted', label: 'Unaccounted' },
    { key: 'personal', label: 'Personal' },
    { key: 'skipped', label: 'Skipped' },
  ];

  container.innerHTML = `<div style="display:flex;gap:6px;flex-wrap:wrap">${pills.map(p => {
    const isActive = _reconFilter === p.key;
    const bg    = isActive ? '#2f5d4e' : '#F5F3EF';
    const color = isActive ? '#fff'    : '#555';
    const bdr   = isActive ? '#2f5d4e' : '#E0DCD5';
    return `<button onclick="filterReconciliation('${p.key}')" style="background:${bg};border:1px solid ${bdr};border-radius:20px;padding:6px 14px;font-size:12px;font-family:'Plus Jakarta Sans',sans-serif;cursor:pointer;color:${color}">${p.label}</button>`;
  }).join('')}</div>`;
}

function filterReconciliation(status) {
  _reconFilter = status;
  const filtersEl = document.getElementById('reconciliation-filters');
  const listEl    = document.getElementById('reconciliation-list');
  if (filtersEl) renderReconciliationFilters(filtersEl);
  if (listEl)    renderReconciliationList(listEl);
}

function renderReconciliationList(container) {
  const filtered = _reconFilter === 'all'
    ? _reconTxns
    : _reconTxns.filter(t => t.status === _reconFilter);

  if (filtered.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:24px;color:var(--muted-2);font-size:13px;font-family:\'Plus Jakarta Sans\',sans-serif">No transactions in this category.</div>';
    return;
  }

  container.innerHTML = filtered.map(t => {
    const dateStr = t.date ? fmt(t.date) : '';
    const desc    = escHtml(t.description || 'No description');
    const amt     = _fmtAud(Math.abs(t.amount));

    let badge;
    let rightInfo;

    if (t.status === 'matched') {
      const merchant = escHtml(t.expenseMerchant || 'Linked expense');
      badge = `<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#2E7D32"><span style="width:6px;height:6px;border-radius:50%;background:#4CAF50;display:inline-block"></span> ${merchant}</span>`;
      rightInfo = badge;
    } else if (t.status === 'matched_payout') {
      // Phase 2c: credit reconciled to a Phase 1 platform_payouts row.
      const p = t.payout || {};
      const platformLabel = escHtml((p.platform || 'platform').replace('_', '.'));
      const refLabel = escHtml(p.payoutReference || 'no ref');
      badge = `<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#1565C0"><span style="width:6px;height:6px;border-radius:50%;background:#2196F3;display:inline-block"></span> ${platformLabel} · ${refLabel}</span>`;
      rightInfo = `<div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px">
        ${badge}
        ${p.payoutDate ? `<span style="font-size:10px;color:var(--muted-2)">Payout ${escHtml(p.payoutDate)}</span>` : ''}
      </div>`;
    } else if (t.status === 'personal') {
      badge = `<span style="display:inline-block;font-size:11px;background:#F3E5F5;color:#9C27B0;border-radius:4px;padding:2px 8px">Personal</span>`;
      rightInfo = `<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">${badge}
        <button onclick="reconRestoreTxn('${t.id}')" style="font-size:11px;color:#78909C;background:none;border:1px solid #B0BEC5;border-radius:6px;padding:3px 10px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;white-space:nowrap">↩ Move back</button></div>`;
    } else if (t.status === 'skipped') {
      badge = `<span style="display:inline-block;font-size:11px;background:#ECEFF1;color:#546E7A;border-radius:4px;padding:2px 8px">Skipped</span>`;
      rightInfo = `<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">${badge}
        <button onclick="reconRestoreTxn('${t.id}')" style="font-size:11px;color:#78909C;background:none;border:1px solid #B0BEC5;border-radius:6px;padding:3px 10px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;white-space:nowrap">↩ Move back</button></div>`;
    } else {
      // Unaccounted — but credits and debits get different match buttons.
      // A credit is a deposit (Airbnb payout etc.); matching to an expense
      // makes no sense, so we route to platform_payouts instead.
      const isCredit = t.direction === 'credit';
      badge = `<span style="display:inline-block;font-size:11px;background:#FFF3E0;color:#E65100;border-radius:4px;padding:2px 8px;margin-bottom:4px">${isCredit ? 'Unmatched deposit' : 'Unaccounted'}</span>`;
      const safeDesc = escapeJsSingleQuotedHtmlAttr(t.description || '');
      const rawAmt = Math.abs(t.amount).toFixed(2);
      const rawDate = t.date || '';
      if (isCredit) {
        rightInfo = `<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">${badge}
          <button onclick="reconMatchPayout('${t.id}','${escapeJsSingleQuotedHtmlAttr(rawDate)}','${rawAmt}','${safeDesc}')" style="font-size:11px;color:#1565C0;background:none;border:1px solid #1565C0;border-radius:6px;padding:3px 10px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;white-space:nowrap">Match Payout</button></div>`;
      } else {
        rightInfo = `<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">${badge}
          <button onclick="reconMatchExpense('${t.id}','${escapeJsSingleQuotedHtmlAttr(rawDate)}','${rawAmt}')" style="font-size:11px;color:#1D9E75;background:none;border:1px solid #1D9E75;border-radius:6px;padding:3px 10px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;white-space:nowrap">Match Expense</button>
          <button onclick="reconCreateExpense('${t.id}','${escapeJsSingleQuotedHtmlAttr(rawDate)}','${rawAmt}','${safeDesc}')" style="font-size:11px;color:#185FA5;background:none;border:1px solid #185FA5;border-radius:6px;padding:3px 10px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;white-space:nowrap">Create New</button>
          <div style="display:flex;gap:4px">
            <button onclick="reconMarkPersonal('${t.id}')" style="font-size:11px;color:#9C27B0;background:none;border:1px solid #9C27B0;border-radius:6px;padding:3px 10px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;white-space:nowrap">Personal</button>
            <button onclick="reconMarkSkipped('${t.id}')" style="font-size:11px;color:#78909C;background:none;border:1px solid #B0BEC5;border-radius:6px;padding:3px 10px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;white-space:nowrap">Skip</button>
          </div></div>`;
      }
    }

    return `<div style="background:#fff;border-radius:10px;padding:12px 14px;margin-bottom:8px;border:0.5px solid rgba(0,0,0,0.06);display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
      <div style="flex:1;min-width:0">
        <div style="font-size:11px;color:var(--muted-2);margin-bottom:2px">${dateStr}</div>
        <div style="font-size:14px;font-weight:500;color:var(--ink-1);font-family:'Plus Jakarta Sans',sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${desc}</div>
        <div style="font-size:15px;font-weight:600;color:var(--ink-1);margin-top:2px">$${amt}</div>
      </div>
      <div style="flex-shrink:0;text-align:right">${rightInfo}</div>
    </div>`;
  }).join('');
}

/** Show nearby expenses to match an unaccounted transaction to */
async function reconMatchExpense(txnId, date, amount) {
  const amt = Number(amount);
  const txnDate = new Date(date + 'T00:00:00');
  if (Number.isNaN(txnDate.getTime())) { globalThis.showBanner('Invalid date', 'warn'); return; }

  // Find expenses within ±7 days and ±50% amount. Already-linked expenses are
  // KEPT in the list (rendered as "Linked", not tappable) instead of hidden, so
  // a matching payment that's already accounted for is visible rather than
  // silently vanishing — avoids "where did that expense go?" and double-linking.
  const nearby = (Array.isArray(expenses) ? expenses : []).filter(e => {
    const eDate = new Date((e.date || '') + 'T00:00:00');
    if (Number.isNaN(eDate.getTime())) return false;
    const dayDiff = Math.abs((eDate - txnDate) / 86400000);
    if (dayDiff > 7) return false;
    const eAmt = Math.abs(Number(e.amount || 0));
    if (eAmt === 0) return false;
    const amtDiff = Math.abs(eAmt - amt);
    if (amtDiff > amt * 0.5 && amtDiff > 5) return false;
    return true;
  }).sort((a, b) => {
    // Unlinked (actionable) first, so linked rows can't push a linkable match
    // out of the top-8 slice below.
    const aLinked = !!(a.reconciled || a.bank_transaction_id);
    const bLinked = !!(b.reconciled || b.bank_transaction_id);
    if (aLinked !== bLinked) return aLinked ? 1 : -1;
    // Then exact amount first, then by date proximity
    const aDiff = Math.abs(Math.abs(Number(a.amount)) - amt);
    const bDiff = Math.abs(Math.abs(Number(b.amount)) - amt);
    if (aDiff < 1 && bDiff >= 1) return -1;
    if (bDiff < 1 && aDiff >= 1) return 1;
    const aDate = Math.abs(new Date((a.date || '') + 'T00:00:00') - txnDate);
    const bDate = Math.abs(new Date((b.date || '') + 'T00:00:00') - txnDate);
    return aDate - bDate;
  }).slice(0, 8);

  if (!nearby.length) {
    globalThis.showBanner('No similar expenses found within 7 days — try Create New instead', 'warn');
    return;
  }

  const linkableCount = nearby.filter(e => !(e.reconciled || e.bank_transaction_id)).length;
  const list = nearby.map(e => {
    const eAmt = Math.abs(Number(e.amount || 0));
    const exactAmt = Math.abs(eAmt - amt) < 0.02;
    const amtBadge = exactAmt ? '<span style="color:#1D9E75;font-weight:600;font-size:10px;margin-left:4px">exact match</span>' : '';
    const isLinked = !!(e.reconciled || e.bank_transaction_id);
    const eid = escapeJsSingleQuotedHtmlAttr(String(e._cloudId || e.id));
    // Linked rows are informational only: dimmed, no tap handler, "Linked" badge.
    const clickAttr = isLinked ? '' : ` onclick="reconLinkToExpense('${escapeJsSingleQuotedHtmlAttr(txnId)}','${eid}')"`;
    const action = isLinked
      ? '<div style="flex-shrink:0;margin-left:8px;color:var(--muted-2);font-size:12px;font-weight:600;display:flex;align-items:center;gap:3px;white-space:nowrap">✓ Linked</div>'
      : '<div style="flex-shrink:0;margin-left:8px;color:var(--moss);font-size:12px;font-weight:600">Link →</div>';
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:0.5px solid rgba(0,0,0,0.06);cursor:${isLinked ? 'default' : 'pointer'}${isLinked ? ';opacity:0.6' : ''}"${clickAttr}>
      <div style="min-width:0;flex:1">
        <div style="font-size:13px;font-weight:500;color:var(--text)">${escHtml(e.merchant || e.description || 'Expense')}${amtBadge}</div>
        <div style="font-size:11px;color:var(--muted-2);margin-top:2px">${fmt(e.date)} · $${_fmtAud(eAmt)} · ${escHtml(e.category || '')}</div>
      </div>
      ${action}
    </div>`;
  }).join('');

  let overlay = document.getElementById('recon-match-overlay');
  if (!overlay) { overlay = document.createElement('div'); overlay.id = 'recon-match-overlay'; document.body.appendChild(overlay); }
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;background:rgba(0,0,0,0.4);display:flex;align-items:flex-end;justify-content:center';
  overlay.innerHTML = `
    <div style="background:white;border-radius:16px 16px 0 0;width:100%;max-width:500px;max-height:70vh;overflow-y:auto;padding:20px 16px 24px;animation:settingsPanelIn 0.28s cubic-bezier(0.32,0.72,0,1)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <div>
          <div style="font-size:15px;font-weight:700;color:var(--primary)">Match to Expense</div>
          <div style="font-size:12px;color:var(--muted-2);margin-top:2px">Transaction: $${_fmtAud(amt)} on ${fmt(date)}</div>
        </div>
        <button onclick="document.getElementById('recon-match-overlay').style.display='none';document.body.style.overflow=''" style="width:28px;height:28px;border-radius:50%;border:none;background:var(--surface2);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--muted-2)">×</button>
      </div>
      <div style="font-size:12px;color:var(--muted-2);margin-bottom:10px">${nearby.length} similar expense${nearby.length !== 1 ? 's' : ''} found${linkableCount ? ' — tap to link' : ''}</div>
      ${list}
      <button onclick="document.getElementById('recon-match-overlay').style.display='none';document.body.style.overflow=''" style="width:100%;margin-top:14px;padding:12px;border-radius:10px;border:none;background:var(--surface2);color:var(--muted-2);font-size:13px;font-weight:600;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif">Cancel</button>
    </div>`;
  document.body.style.overflow = 'hidden';
}
globalThis.reconMatchExpense = reconMatchExpense;

/**
 * Phase 2c: show platform_payouts within ±5 days / ±$1 of an unaccounted
 * bank CREDIT and let the user pick one to link. Mirrors reconMatchExpense.
 */
async function reconMatchPayout(txnId, date, amount, description) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) { globalThis.showBanner('Invalid amount', 'warn'); return; }
  const txnDate = new Date(date + 'T00:00:00');
  if (Number.isNaN(txnDate.getTime())) { globalThis.showBanner('Invalid date', 'warn'); return; }

  const user = await getCurrentSupabaseUser();
  if (!user) { globalThis.showBanner('Sign in to match payouts', 'warn'); return; }

  const matches = await findPayoutMatchesForBankTransaction(
    { id: txnId, date, amount: amt, description: description || '' },
    user.id,
    { includeLinked: true }
  );

  if (!matches.length) {
    globalThis.showBanner('No platform payouts within ±5 days / ±$1 — paste the statement in Finance → Transaction Map first', 'warn');
    return;
  }

  // Actionable (unlinked) payouts first, so a linked row can't push a linkable
  // one out of the top-8 shown; preserve score order within each group.
  matches.sort((a, b) => {
    const aLinked = !!(a.payout && a.payout.bank_transaction_id);
    const bLinked = !!(b.payout && b.payout.bank_transaction_id);
    if (aLinked !== bLinked) return aLinked ? 1 : -1;
    return (b.score || 0) - (a.score || 0);
  });
  const displayMatches = matches.slice(0, 8);
  const linkableCount = displayMatches.filter(m => !(m.payout && m.payout.bank_transaction_id)).length;
  const list = displayMatches.map(m => {
    const p = m.payout;
    const platformLabel = escHtml((p.platform || 'platform').replace('_', '.'));
    const refLabel = escHtml(p.payout_reference || '(no ref)');
    const pAmt = Number(p.net_amount) || 0;
    const exactBadge = Math.abs(pAmt - amt) < 0.02
      ? '<span style="color:#1565C0;font-weight:600;font-size:10px;margin-left:4px">exact match</span>'
      : '';
    const isLinked = !!p.bank_transaction_id;
    const pid = escapeJsSingleQuotedHtmlAttr(String(p.id));
    const txnIdEsc = escapeJsSingleQuotedHtmlAttr(String(txnId));
    // Linked payouts are informational only: dimmed, no tap handler, "Linked" badge.
    const clickAttr = isLinked ? '' : ` onclick="reconLinkToPayout('${txnIdEsc}','${pid}')"`;
    const action = isLinked
      ? '<div style="flex-shrink:0;margin-left:8px;color:var(--muted-2);font-size:12px;font-weight:600;display:flex;align-items:center;gap:3px;white-space:nowrap">✓ Linked</div>'
      : '<div style="flex-shrink:0;margin-left:8px;color:#1565C0;font-size:12px;font-weight:600">Link →</div>';
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:0.5px solid rgba(0,0,0,0.06);cursor:${isLinked ? 'default' : 'pointer'}${isLinked ? ';opacity:0.6' : ''}"${clickAttr}>
      <div style="min-width:0;flex:1">
        <div style="font-size:13px;font-weight:500;color:var(--text)">${platformLabel} · ${refLabel}${exactBadge}</div>
        <div style="font-size:11px;color:var(--muted-2);margin-top:2px">${escHtml(p.payout_date || '?')} · $${_fmtAud(pAmt)} · score ${m.score}</div>
      </div>
      ${action}
    </div>`;
  }).join('');

  let overlay = document.getElementById('recon-match-overlay');
  if (!overlay) { overlay = document.createElement('div'); overlay.id = 'recon-match-overlay'; document.body.appendChild(overlay); }
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;background:rgba(0,0,0,0.4);display:flex;align-items:flex-end;justify-content:center';
  overlay.innerHTML = `
    <div style="background:white;border-radius:16px 16px 0 0;width:100%;max-width:500px;max-height:70vh;overflow-y:auto;padding:20px 16px 24px;animation:settingsPanelIn 0.28s cubic-bezier(0.32,0.72,0,1)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <div>
          <div style="font-size:15px;font-weight:700;color:var(--primary)">Match to Platform Payout</div>
          <div style="font-size:12px;color:var(--muted-2);margin-top:2px">Deposit: $${_fmtAud(amt)} on ${fmt(date)}</div>
        </div>
        <button onclick="document.getElementById('recon-match-overlay').style.display='none';document.body.style.overflow=''" style="width:28px;height:28px;border-radius:50%;border:none;background:var(--surface2);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--muted-2)">×</button>
      </div>
      <div style="font-size:12px;color:var(--muted-2);margin-bottom:10px">${displayMatches.length} candidate${displayMatches.length !== 1 ? 's' : ''} found${linkableCount ? ' — tap to link' : ''}</div>
      ${list}
      <button onclick="document.getElementById('recon-match-overlay').style.display='none';document.body.style.overflow=''" style="width:100%;margin-top:14px;padding:12px;border-radius:10px;border:none;background:var(--surface2);color:var(--muted-2);font-size:13px;font-weight:600;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif">Cancel</button>
    </div>`;
  document.body.style.overflow = 'hidden';
}
globalThis.reconMatchPayout = reconMatchPayout;

/** Link a bank credit row to a platform_payouts row and update UI in place. */
async function reconLinkToPayout(txnId, payoutId) {
  const result = await linkTransactionToPayout(txnId, payoutId);
  if (!result.success) {
    globalThis.showBanner('⚠ Link failed — see console', 'warn');
    return;
  }
  const overlay = document.getElementById('recon-match-overlay');
  if (overlay) overlay.style.display = 'none';
  document.body.style.overflow = '';
  globalThis.showBanner('✓ Deposit linked to payout', 'ok');

  // Patch the in-memory row so the list updates without a full refetch.
  const txn = _reconTxns.find(t => String(t.id) === String(txnId));
  if (txn) {
    txn.status = 'matched_payout';
    // Fetch the payout fields we display so the badge renders correctly
    if (window._sb) {
      const { data } = await window._sb
        .from('platform_payouts')
        .select('id, platform, payout_reference, payout_date, net_amount')
        .eq('id', payoutId)
        .maybeSingle();
      if (data) {
        txn.payout = {
          id: data.id,
          platform: data.platform || null,
          payoutReference: data.payout_reference || null,
          payoutDate: data.payout_date || null,
          netAmount: Number(data.net_amount) || 0,
        };
      }
    }
  }
  // Full re-render so summary tile + filter pills + list all reflect the change
  await renderReconciliationView();
}
globalThis.reconLinkToPayout = reconLinkToPayout;

/** Link a bank transaction to an existing expense */
async function reconLinkToExpense(txnId, expenseId) {
  const sb = window._sb;
  if (!sb) return;
  try {
    // supabase-js does not throw on a failed write — check each result so we
    // never falsely banner "linked" while the link did not persist (report 3.2).
    const w = (typeof globalThis.sbWrite === 'function')
      ? globalThis.sbWrite
      : async (builder, _opts) => { const { error } = await builder; return { ok: !error, error }; };
    const r1 = await w(sb.from('bank_transactions').update({ expense_id: expenseId }).eq('id', txnId), { label: 'reconciliation link' });
    if (!r1.ok) return;
    const r2 = await w(sb.from('expenses').update({ reconciled: true, bank_transaction_id: txnId, payment_status: 'paid' }).eq('id', expenseId), { label: 'reconciliation link' });
    if (!r2.ok) return;
    const overlay = document.getElementById('recon-match-overlay');
    if (overlay) { overlay.style.display = 'none'; }
    document.body.style.overflow = '';
    globalThis.showBanner('✓ Transaction linked to expense', 'ok');

    // Update in-memory and re-render list without full re-fetch (preserves scroll)
    const txn = _reconTxns.find(t => String(t.id) === String(txnId));
    if (txn) {
      txn.status = 'matched';
      txn.expense_id = expenseId;
      const exp = (Array.isArray(expenses) ? expenses : []).find(e => (e._cloudId || e.id) === expenseId);
      if (exp) txn.expenseMerchant = exp.merchant || exp.description || 'Linked';
    }
    // Update summary bar totals
    const summaryBar = document.getElementById('reconciliation-summary-bar');
    if (summaryBar) {
      const totals = { matched: 0, unaccounted: 0, personal: 0, skipped: 0 };
      for (const t of _reconTxns) totals[t.status] = (totals[t.status] || 0) + Math.abs(t.amount);
      summaryBar.innerHTML = `
        <div style="display:flex;gap:8px;padding:0 16px;margin:0 auto 12px;max-width:560px;flex-wrap:wrap">
          <div style="flex:1;min-width:100px;background:#E8F5E9;border-radius:8px;padding:8px 12px;text-align:center">
            <div style="font-size:18px;font-weight:600;color:#2E7D32">$${_fmtAud(totals.matched)}</div>
            <div style="font-size:11px;color:#388E3C">Matched</div>
          </div>
          <div style="flex:1;min-width:100px;background:#FFF3E0;border-radius:8px;padding:8px 12px;text-align:center">
            <div style="font-size:18px;font-weight:600;color:#E65100">$${_fmtAud(totals.unaccounted)}</div>
            <div style="font-size:11px;color:#F57C00">Unaccounted</div>
          </div>
          <div style="flex:1;min-width:100px;background:#F3E5F5;border-radius:8px;padding:8px 12px;text-align:center">
            <div style="font-size:18px;font-weight:600;color:#7B1FA2">$${_fmtAud(totals.personal)}</div>
            <div style="font-size:11px;color:#9C27B0">Personal</div>
          </div>
        </div>`;
    }
    // Re-render just the list, preserving scroll position
    const listEl = document.getElementById('reconciliation-list');
    if (listEl) {
      const scrollY = listEl.parentElement ? listEl.parentElement.scrollTop : window.scrollY;
      renderReconciliationList(listEl);
      if (listEl.parentElement) listEl.parentElement.scrollTop = scrollY;
      else window.scrollTo(0, scrollY);
    }
  } catch (err) {
    globalThis.showBanner('Failed to link: ' + (err.message || err), 'error');
  }
}
globalThis.reconLinkToExpense = reconLinkToExpense;

/** Pre-fill the expense form from an unaccounted transaction, then navigate to expenses. */
let _pendingReconTxnId = null;

function reconCreateExpense(txnId, date, amount, description) {
  _pendingReconTxnId = txnId; // Store txnId to auto-link after expense is saved

  // Navigate to the expenses sub-view
  showFinanceSub('expenses');

  // Open the add form if it's not already open
  const panel = document.getElementById('expense-add-form-panel');
  if (panel && panel.style.display === 'none') {
    toggleExpenseAddForm();
  }

  // Pre-fill form fields
  setTimeout(() => {
    const dateEl   = document.getElementById('exp-date');
    const amountEl = document.getElementById('exp-amount');
    const descEl   = document.getElementById('exp-description');
    const refundEl = document.getElementById('exp-is-refund');
    const numAmount = Number(amount);
    if (dateEl)   dateEl.value   = date;
    if (amountEl) amountEl.value = Number.isFinite(numAmount) ? Math.abs(numAmount) : amount;
    if (descEl)   descEl.value   = description;
    if (refundEl) refundEl.checked = Number.isFinite(numAmount) && numAmount < 0;
  }, 100);
}

/** Mark an unaccounted bank transaction as a personal (non-business) charge. */
async function reconMarkPersonal(txnId) {
  const { success } = await setTransactionClassification(txnId, { isPersonal: true });
  if (!success) { globalThis.showBanner('⚠ Could not update transaction', 'warn'); return; }
  globalThis.showBanner('✓ Marked as personal', 'ok');
  await renderReconciliationView();
}
globalThis.reconMarkPersonal = reconMarkPersonal;

/** Skip an unaccounted bank transaction (dismiss it from reconciliation). */
async function reconMarkSkipped(txnId) {
  const { success } = await setTransactionClassification(txnId, { skipped: true });
  if (!success) { globalThis.showBanner('⚠ Could not update transaction', 'warn'); return; }
  globalThis.showBanner('✓ Skipped', 'ok');
  await renderReconciliationView();
}
globalThis.reconMarkSkipped = reconMarkSkipped;

/** Restore a personal/skipped transaction back to the Unaccounted list. */
async function reconRestoreTxn(txnId) {
  const { success } = await setTransactionClassification(txnId, { isPersonal: false, skipped: false });
  if (!success) { globalThis.showBanner('⚠ Could not update transaction', 'warn'); return; }
  globalThis.showBanner('✓ Moved back to Unaccounted', 'ok');
  await renderReconciliationView();
}
globalThis.reconRestoreTxn = reconRestoreTxn;

/** Called after addExpense() saves — auto-links to pending bank transaction if any */
async function _autoLinkPendingReconTxn(expenseId) {
  const txnId = _pendingReconTxnId;
  _pendingReconTxnId = null;
  if (!txnId || !expenseId || !window._sb) return;
  try {
    await window._sb.from('bank_transactions').update({ expense_id: expenseId }).eq('id', txnId);
    await window._sb.from('expenses').update({ reconciled: true, bank_transaction_id: txnId, payment_status: 'paid' }).eq('id', expenseId);
    globalThis.showBanner('✓ Expense created & linked to bank transaction', 'ok');
  } catch (e) {
    console.warn('[StayOps] Auto-link recon failed:', e);
  }
}
globalThis._autoLinkPendingReconTxn = _autoLinkPendingReconTxn;

// ── MONTHLY STATEMENT VIEW ──────────────────────────────────────────────────
let _statementYear = new Date().getFullYear();
let _statementMonth = new Date().getMonth();

function showStatementView() {
  showFinanceSub('statement');
}

function _renderStatement() {
  const el = document.getElementById('finance-statement-content');
  if (!el) return;
  const y = _statementYear;
  const m = _statementMonth;
  const monthName = new Date(y, m, 1).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
  const propName = typeof getCurrentPropertyName === 'function' ? getCurrentPropertyName() : 'Property';
  const now = new Date();
  const prepared = now.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });

  // Phase 6: detect owner-statement mode for properties the host manages
  // for someone else. Falls back to the existing host view for self-managed
  // properties so nothing regresses for users who don't manage for owners.
  const activeProp = (typeof getAllProperties === 'function' ? getAllProperties() : [])
    .find(p => p && (p.propertyId === (typeof getActivePropertyId === 'function' ? getActivePropertyId() : null))) || null;
  const ownerName = activeProp && activeProp.owner && activeProp.owner.name ? String(activeProp.owner.name).trim() : '';
  const isOwnerManaged = !!(activeProp && activeProp.isSelfManaged === false && ownerName);
  const mgmtFeeRate = Number((window._appConfig && window._appConfig.mgmt_fee_rate) || 0);

  const monthStart = new Date(y, m, 1);
  const monthEnd = new Date(y, m + 1, 0);
  const bk = (globalThis.bookings || []).filter(b => {
    if (!isRevenueBearingBooking(b)) return false;
    const ci = new Date(b.checkin);
    return ci >= monthStart && ci <= monthEnd;
  });
  const exp = (globalThis.expenses || []).filter(e => {
    const d = new Date(e.date);
    return d >= monthStart && d <= monthEnd;
  });

  const totalRevenue = bk.reduce((s, b) => s + bookingRevenue(b), 0);
  const cleaningCollected = bk.reduce((s, b) => s + bookingCleaningFee(b), 0);
  const platformFees = bk.reduce((s, b) => s + Number(b.platformFee || 0), 0);
  const cleanerPay = exp.filter(e => (e.category || '').toLowerCase().includes('clean')).reduce((s, e) => s + Number(e.amount || 0), 0);
  // Owner mode splits expenses into recoverable (owner reimburses) and
  // non-recoverable (host absorbs). Host mode lumps everything as "other".
  const otherExpensesAll = exp.filter(e => !(e.category || '').toLowerCase().includes('clean'));
  const recoverableExpenses = otherExpensesAll
    .filter(e => e.recoverableFromOwner === true || e.recoverable_from_owner === true)
    .reduce((s, e) => s + Number(e.amount || 0), 0);
  const otherExpenses = isOwnerManaged
    ? recoverableExpenses // only deduct what's actually recoverable from owner
    : otherExpensesAll.reduce((s, e) => s + Number(e.amount || 0), 0);

  // Management fee: % of gross revenue collected on the owner's behalf.
  // Only deducted in owner mode (host keeps it).
  const mgmtFee = isOwnerManaged ? Math.round((totalRevenue * mgmtFeeRate) / 100 * 100) / 100 : 0;

  const net = totalRevenue + cleaningCollected - platformFees - cleanerPay - otherExpenses - mgmtFee;

  // Line-item table differs slightly between host vs owner mode.
  const lineItemPairs = isOwnerManaged
    ? [
        ['Bookings (' + bk.length + ') · gross collected', '$' + totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 2 })],
        ['Cleaning fees passed through', '$' + cleaningCollected.toLocaleString(undefined, { minimumFractionDigits: 2 })],
        ['Less: Platform fees', '−$' + platformFees.toLocaleString(undefined, { minimumFractionDigits: 2 })],
        ['Less: Cleaner pay', '−$' + cleanerPay.toLocaleString(undefined, { minimumFractionDigits: 2 })],
        ['Less: Reimbursable expenses', '−$' + otherExpenses.toLocaleString(undefined, { minimumFractionDigits: 2 })],
        ['Less: Management fee' + (mgmtFeeRate ? ' (' + mgmtFeeRate + '%)' : ''), '−$' + mgmtFee.toLocaleString(undefined, { minimumFractionDigits: 2 })],
      ]
    : [
        ['Bookings (' + bk.length + ')', '$' + totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 2 })],
        ['Cleaning fees collected', '$' + cleaningCollected.toLocaleString(undefined, { minimumFractionDigits: 2 })],
        ['Platform fees', '−$' + platformFees.toLocaleString(undefined, { minimumFractionDigits: 2 })],
        ['Cleaner pay', '−$' + cleanerPay.toLocaleString(undefined, { minimumFractionDigits: 2 })],
        ['Other expenses', '−$' + otherExpenses.toLocaleString(undefined, { minimumFractionDigits: 2 })],
      ];
  const lineItems = lineItemPairs.map(([k, v]) =>
    `<div style="display:flex;justify-content:space-between;padding:8px 0;font-size:13px">
      <span style="color:var(--ink-2,#4a5751)">${k}</span>
      <span style="font-family:'JetBrains Mono',monospace;font-weight:600;color:${v.startsWith('−') ? 'var(--warn,#b56a3a)' : 'var(--ink-1,#1c2620)'}">${v}</span>
    </div>`
  ).join('');

  const payouts = bk.map(b => {
    const plat = _canonicalPlatformName(b.platform);
    const d = new Date(b.checkin).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
    const paid = new Date(b.checkout) < now;
    return `<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-top:1px solid var(--hairline-2,#efe9dc)">
      <div style="width:8px;height:8px;border-radius:50%;background:${paid ? 'var(--primary,#2f5d4e)' : 'var(--accent,#d8a657)'}"></div>
      <div style="flex:1">
        <div style="font-size:13px;font-weight:600;color:var(--ink-1,#1c2620)">${plat}</div>
        <div style="font-size:11px;color:var(--muted-2,#8a958f);font-family:'JetBrains Mono',monospace">${d} · ${paid ? 'Settled' : 'Pending'}</div>
      </div>
      <div style="font-family:'Newsreader',serif;font-size:15px;font-weight:600;color:var(--ink-1,#1c2620)">$${bookingRevenue(b).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
    </div>`;
  }).join('');

  // Header / amount-label flip between host vs owner mode.
  const headerChip = isOwnerManaged ? 'OWNER STATEMENT' : 'MONTHLY STATEMENT';
  const subtitle   = isOwnerManaged
    ? `${escHtml(propName)} · for ${escHtml(ownerName)} · prepared ${prepared}`
    : `${escHtml(propName)} · prepared ${prepared}`;
  const bigLabel   = isOwnerManaged ? `PAYABLE TO ${escHtml(ownerName.toUpperCase())}` : 'YOU EARNED';

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <div style="display:inline-block;font-size:11px;font-weight:600;padding:4px 10px;border-radius:999px;background:var(--primary-soft,#dde8e1);color:var(--primary,#2f5d4e);font-family:'JetBrains Mono',monospace;letter-spacing:0.3px">${headerChip}</div>
      <div style="font-size:13px;color:var(--primary,#2f5d4e);font-weight:600;cursor:pointer" onclick="exportReportPDF()">Share</div>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
      <button onclick="_statementPrev()" style="background:none;border:none;cursor:pointer;padding:4px">
        <svg width="14" height="14" viewBox="0 0 14 14"><path d="M9 2L3 7l6 5" stroke="var(--ink-2)" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div style="font-family:'Newsreader',serif;font-size:26px;font-weight:600;color:var(--ink-1,#1c2620);letter-spacing:-0.5px">${monthName}</div>
      <button onclick="_statementNext()" style="background:none;border:none;cursor:pointer;padding:4px">
        <svg width="14" height="14" viewBox="0 0 14 14"><path d="M5 2l6 5-6 5" stroke="var(--ink-2)" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>
    <div style="font-size:13px;color:var(--ink-2,#4a5751);margin-bottom:22px">${subtitle}</div>
    <div style="background:#fff;border-radius:20px;padding:20px;border:1px solid var(--hairline-1,#e8e1d3)">
      <div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--muted-2,#8a958f);letter-spacing:0.6px;text-transform:uppercase">${bigLabel}</div>
      <div style="margin-top:4px;font-family:'Newsreader',serif;font-size:38px;font-weight:600;color:var(--primary,#2f5d4e);letter-spacing:-0.8px">$${net.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
      <div style="height:1px;background:var(--hairline-2,#efe9dc);margin:18px 0"></div>
      ${lineItems}
    </div>
    ${payouts ? `<div style="margin-top:18px">
      <div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--muted-2,#8a958f);letter-spacing:1px;text-transform:uppercase;margin-bottom:10px">PAYOUTS</div>
      <div style="background:#fff;border-radius:16px;padding:14px;border:1px solid var(--hairline-1,#e8e1d3)">${payouts}</div>
    </div>` : ''}
    <button onclick="exportReportPDF()" style="margin-top:18px;width:100%;padding:14px;border-radius:14px;border:none;background:var(--primary,#2f5d4e);color:#fff;font-size:14px;font-weight:600;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif">Download PDF</button>
  `;
}

function _statementPrev() {
  _statementMonth--;
  if (_statementMonth < 0) { _statementMonth = 11; _statementYear--; }
  _renderStatement();
}
function _statementNext() {
  _statementMonth++;
  if (_statementMonth > 11) { _statementMonth = 0; _statementYear++; }
  _renderStatement();
}
globalThis._statementPrev = _statementPrev;
globalThis._statementNext = _statementNext;
globalThis.showStatementView = showStatementView;

export {
  backToFinanceHub,
  toggleExpenseAddForm,
  closeExpenseAddForm,
  showFinanceSub,
  switchReportsSubTab,
  openFinancePanelFromHub,
  switchFinanceTab,
  switchPayoutsSubTab,
  switchMgmtSubTab,
  switchReportSubTab,
  renderMgmtFY,
  renderFinance,
  switchRevTab,
  fyPrev,
  fyNext,
  renderReport,
  revPrev,
  revNext,
  renderRevenue,
  mgmtPrev,
  mgmtNext,
  renderManagement,
  toggleMgmtSelect,
  mgmtCheckboxChange,
  mgmtToggleSelectAll,
  generateInvoice,
  confirmInvoiceClient,
  buildInvoicePDF,
  loadClients,
  saveClients,
  renderClientsList,
  addClient,
  deleteClient,
  saveBankDetails,
  saveInvoiceDetails,
  renderExpenseCatSettings,
  updateExpenseCat,
  addExpenseCat,
  deleteExpenseCat,
  resetExpenseCats,
  populateExpenseCatSelect,
  merchantAutocomplete,
  selectMerchantSuggest,
  hideMerchantSuggest,
  toggleExpenseList,
  toggleExpenseMonth,
  clearExpenseFilters,
  renderExpenses,
  addExpense,
  saveExpenseToDriveAndSheet,
  generateReceiptFileName,
  receiptImageToPDF,
  deleteExpense,
  attachEditExpensePhoto,
  clearEditExpensePhoto,
  openExpenseView,
  openExpenseEdit,
  closeExpenseEdit,
  saveExpenseEdit,
  getExpenseCats,
  populateMgmtFeePanel,
  saveMgmtFeeRate,
  ownerAutoSendToggle,
  saveOwnerReportSettings,
  sendOwnerReport,
  exportReportPDF,
  exportReportCSV,
  _getInvoiceIdentity,
  getAtoField,
  getAtoFieldLabel,
  checkReceiptNudge,
  showReconciliationView,
  renderReconciliationView,
  filterReconciliation,
  showDepreciationView,
  exportTaxPDF,
  exportTaxCSV,
  taxExportFYPrev,
  taxExportFYNext,
  showStatementView,
};

globalThis.reconCreateExpense = reconCreateExpense;
globalThis.filterReconciliation = filterReconciliation;
globalThis.exitBankImportReview = exitBankImportReview;
globalThis.bankImportCancelLoad = bankImportRestoreBackup;
globalThis.bankImportOnPropChange = bankImportOnPropChange;
globalThis.bankImportOnCatChange = bankImportOnCatChange;
globalThis.bankImportSkipRow = bankImportSkipRow;
globalThis.bankImportPersonalRow = bankImportPersonalRow;
globalThis.bankImportConfirmAllSuggested = bankImportConfirmAllSuggested;
globalThis.bankImportRunImport = bankImportRunImport;
globalThis.bankImportPickFile = () => getOrCreateBankCsvFileInput().click();
globalThis.resetFinanceSubViewToHub = resetFinanceSubViewToHub;
globalThis.mgmtCheckboxChange = mgmtCheckboxChange;
globalThis.mgmtToggleSelectAll = mgmtToggleSelectAll;
globalThis._mgmtFYSelectedMonths = _mgmtFYSelectedMonths;
globalThis._mgmtFYToggleMonth = _mgmtFYToggleMonth;
globalThis.toggleInvoiceStatus = _updateInvoiceStatus;
globalThis.viewHistoricalInvoice = _viewHistoricalInvoice;
globalThis.cancelInvoice = _cancelInvoice;
globalThis.toggleInvoiceDetail = function(num) { _expandedInvoiceNum = _expandedInvoiceNum === num ? null : num; renderInvoiceHistory(); };

// Open a receipt by fetching a signed URL on demand (bucket is private).
window.openReceiptViewer = async function (driveLinkValue, btnEl, downloadName) {
  if (!driveLinkValue) return;
  const originalText = btnEl ? btnEl.innerHTML : null;
  if (btnEl) { btnEl.innerHTML = 'Loading…'; btnEl.disabled = true; }
  try {
    const url = await getReceiptViewUrl(driveLinkValue, downloadName);
    if (url) {
      window.open(url, '_blank', 'noopener,noreferrer');
    } else {
      if (typeof globalThis.showBanner === 'function') {
        globalThis.showBanner('⚠ Could not load receipt — file may be missing', 'error');
      }
    }
  } catch (e) {
    console.warn('[StayOps] openReceiptViewer failed', e);
    if (typeof globalThis.showBanner === 'function') {
      globalThis.showBanner('⚠ Could not load receipt', 'error');
    }
  } finally {
    if (btnEl && originalText) { btnEl.innerHTML = originalText; btnEl.disabled = false; }
  }
};

// Expense / finance inline-handler bridges
window.addExpense = addExpense;
window.saveExpense = saveExpenseToDriveAndSheet;
window.openExpenseView = openExpenseView;
window.openExpenseEdit = openExpenseEdit;
window.closeExpenseEdit = closeExpenseEdit;
window.saveExpenseEdit = saveExpenseEdit;
window.triggerSecondReceiptUpload = triggerSecondReceiptUpload;
window.removeEditReceipt = removeEditReceipt;
window.deleteExpense = deleteExpense;
window.addExpenseCat = addExpenseCat;
window.deleteExpenseCat = deleteExpenseCat;
window.updateExpenseCat = updateExpenseCat;
window.fyPrev = fyPrev;
window.fyNext = fyNext;
window.exportReportPDF = exportReportPDF;
window.exportReportCSV = exportReportCSV;
window.exportTaxPDF = exportTaxPDF;
window.exportTaxCSV = exportTaxCSV;
window.taxExportFYPrev = taxExportFYPrev;
window.taxExportFYNext = taxExportFYNext;


// ── PAYOUT PASTE FLOW (Phase 1c) ─────────────────────────────────────────────
//
// User pastes a platform earnings statement (Airbnb, Booking.com, etc.),
// Claude Haiku extracts the line items into structured JSON, we auto-match
// accommodation lines to bookings by confirmation_code, the user reviews,
// then we persist via savePlatformPayout + insertPayoutLines.

let _payoutExtracted = null;     // last AI-parsed payload (state B)
let _payoutMatchOverrides = {};  // user-edited booking matches by line index
let _payoutFileBase64 = null;    // base64 of attached statement file (PDF or image)
let _payoutFileMediaType = null; // 'application/pdf' or 'image/png' / 'image/jpeg' etc.
let _payoutFileName = null;      // for display

function openPayoutPasteModal() {
  document.getElementById('payout-paste-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  resetPayoutPasteModal();
}
window.openPayoutPasteModal = openPayoutPasteModal;

function closePayoutPasteModal() {
  document.getElementById('payout-paste-modal').classList.remove('open');
  if (typeof globalThis._checkModalsClosed === 'function') globalThis._checkModalsClosed();
  _payoutExtracted = null;
  _payoutMatchOverrides = {};
  clearPayoutStatementFile();
}
window.closePayoutPasteModal = closePayoutPasteModal;

function resetPayoutPasteModal() {
  _payoutExtracted = null;
  _payoutMatchOverrides = {};
  document.getElementById('payout-paste-input-section').style.display = 'block';
  document.getElementById('payout-paste-review-section').style.display = 'none';
  const status = document.getElementById('payout-paste-status');
  status.style.display = 'none';
  status.textContent = '';
}
window.resetPayoutPasteModal = resetPayoutPasteModal;

async function attachPayoutStatementFile(input) {
  const file = input?.files?.[0];
  if (!file) return;
  if (file.size > 12 * 1024 * 1024) {
    _payoutPasteStatus('⚠ File is over 12MB — try a smaller PDF, screenshot, or export', 'err');
    input.value = '';
    return;
  }

  const name = (file.name || 'statement').toLowerCase();
  const mime = file.type || '';
  const isNumbers = name.endsWith('.numbers') || mime === 'application/vnd.apple.numbers';
  const isCsvLike = name.endsWith('.csv') || name.endsWith('.tsv') || name.endsWith('.txt')
                 || mime === 'text/csv' || mime === 'text/tab-separated-values' || mime === 'text/plain';
  const isExcel   = name.endsWith('.xlsx') || name.endsWith('.xls')
                 || mime.includes('spreadsheetml') || mime === 'application/vnd.ms-excel';
  const isPdfImg  = mime === 'application/pdf' || mime.startsWith('image/')
                 || name.endsWith('.pdf');

  // Numbers files are a proprietary zip format SheetJS can't open.
  // Apple's Numbers app exports cleanly to CSV or xlsx.
  if (isNumbers) {
    _payoutPasteStatus('⚠ Numbers files aren\'t supported directly. In Numbers: File → Export To → CSV (or Excel), then attach the exported file.', 'err');
    input.value = '';
    return;
  }

  // CSV / TSV / plain text — read as text, drop into the textarea so the
  // user can review/edit before extraction. AI handles structured CSV well.
  if (isCsvLike) {
    try {
      const text = await file.text();
      _appendToPayoutTextarea(file.name, text);
      _clearPayoutFileState();
      _payoutPasteStatus('✓ Loaded ' + file.name + ' as text — click ✨ Extract', 'ok');
    } catch (e) {
      console.warn('[StayOps] CSV read failed', e);
      _payoutPasteStatus('⚠ Could not read that file', 'err');
    }
    input.value = '';
    return;
  }

  // Excel — lazy-load SheetJS from CDN and convert each sheet to CSV text.
  // Only loads the ~700KB library when the user actually uploads xlsx.
  if (isExcel) {
    _payoutPasteStatus('⏳ Reading spreadsheet...');
    try {
      const XLSX = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm');
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      let allText = '';
      for (const sheetName of wb.SheetNames) {
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName]);
        if (!csv.trim()) continue;
        allText += (allText ? '\n\n' : '') + `=== Sheet: ${sheetName} ===\n` + csv;
      }
      if (!allText.trim()) {
        _payoutPasteStatus('⚠ Spreadsheet is empty', 'err');
        input.value = '';
        return;
      }
      _appendToPayoutTextarea(file.name, allText);
      _clearPayoutFileState();
      _payoutPasteStatus('✓ Loaded ' + file.name + ' (' + wb.SheetNames.length + ' sheet' + (wb.SheetNames.length === 1 ? '' : 's') + ') — click ✨ Extract', 'ok');
    } catch (e) {
      console.warn('[StayOps] xlsx read failed', e);
      _payoutPasteStatus('⚠ Could not read Excel file — try File → Save As → CSV in Excel and re-upload', 'err');
    }
    input.value = '';
    return;
  }

  // PDF / image — keep the file as a binary blob, send to Claude vision
  // via document/image content block (existing flow).
  if (isPdfImg) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const result = ev.target.result || '';
      const commaIdx = result.indexOf(',');
      _payoutFileBase64 = commaIdx >= 0 ? result.slice(commaIdx + 1) : '';
      _payoutFileMediaType = mime === 'application/pdf' ? 'application/pdf' : (mime || 'image/jpeg');
      _payoutFileName = file.name || 'statement';
      const previewEl = document.getElementById('payout-paste-file-preview');
      const nameEl = document.getElementById('payout-paste-file-name');
      if (nameEl) {
        const sizeKb = (file.size / 1024).toFixed(0);
        nameEl.textContent = `📎 ${_payoutFileName} (${sizeKb} KB)`;
      }
      if (previewEl) previewEl.style.display = 'flex';
    };
    reader.onerror = () => { _payoutPasteStatus('⚠ Could not read that file', 'err'); };
    reader.readAsDataURL(file);
    return;
  }

  _payoutPasteStatus('⚠ Unsupported file type — use PDF, image, CSV, or Excel', 'err');
  input.value = '';
}
window.attachPayoutStatementFile = attachPayoutStatementFile;

/** Append extracted text-format file content into the textarea, labeled with
 *  the original filename so the user can tell sources apart. */
function _appendToPayoutTextarea(filename, content) {
  const ta = document.getElementById('payout-paste-raw');
  if (!ta) return;
  const header = `--- ${filename} ---\n`;
  ta.value = (ta.value && ta.value.trim())
    ? ta.value.trim() + '\n\n' + header + content
    : header + content;
}

/** Reset the binary-file state used by the PDF/image vision path. */
function _clearPayoutFileState() {
  _payoutFileBase64 = null;
  _payoutFileMediaType = null;
  _payoutFileName = null;
  const previewEl = document.getElementById('payout-paste-file-preview');
  if (previewEl) previewEl.style.display = 'none';
}

function clearPayoutStatementFile() {
  _payoutFileBase64 = null;
  _payoutFileMediaType = null;
  _payoutFileName = null;
  const input = document.getElementById('payout-paste-file-input');
  if (input) input.value = '';
  const previewEl = document.getElementById('payout-paste-file-preview');
  if (previewEl) previewEl.style.display = 'none';
}
window.clearPayoutStatementFile = clearPayoutStatementFile;

function _payoutPasteStatus(msg, kind) {
  const el = document.getElementById('payout-paste-status');
  if (!el) return;
  el.style.display = 'block';
  el.textContent = msg;
  if (kind === 'err') {
    el.style.background = '#FEE2E2';
    el.style.color = '#991B1B';
  } else if (kind === 'ok') {
    el.style.background = '#DCFCE7';
    el.style.color = '#166534';
  } else {
    el.style.background = 'var(--surface2)';
    el.style.color = 'var(--ink-1)';
  }
}

/** Find a booking whose confirmation code matches the line's code (case-insensitive).
 *  Uses the imported `bookings` array from state.js (ES module live binding —
 *  populated by replaceArrayInPlace during hydration). The in-memory field is
 *  `b.confirmCode` (set by loadBookingsFromCloud), NOT `confirmationCode` or
 *  `confirmation_code` — those are DB / AI shapes. */
function _matchPayoutLineToBooking(confirmationCode) {
  if (!confirmationCode) return null;
  const target = String(confirmationCode).trim().toLowerCase();
  if (!target) return null;
  return bookings.find(b => {
    const code = String(b.confirmCode || '').trim().toLowerCase();
    return code && code === target;
  }) || null;
}

async function extractPayoutWithAI() {
  const platform = document.getElementById('payout-platform').value || 'other';
  const rawText = (document.getElementById('payout-paste-raw').value || '').trim();
  const hasFile = !!_payoutFileBase64;

  if (!hasFile && !rawText) {
    _payoutPasteStatus('⚠ Attach a statement file OR paste statement text first', 'err');
    return;
  }
  if (!hasFile && rawText.length < 30) {
    _payoutPasteStatus('⚠ That looks too short — paste the full statement', 'err');
    return;
  }
  if (!AIService || typeof AIService.request !== 'function') {
    _payoutPasteStatus('⚠ AI service not available', 'err');
    return;
  }
  _payoutPasteStatus(hasFile ? '⏳ Reading statement file with AI...' : '⏳ Reading statement with AI...');

  const promptInstructions = `You parse short-term-rental platform payout statements into JSON.
Return ONLY valid JSON. No markdown, no commentary, no prose.

PLATFORM (user-selected hint): ${platform}

The statement may describe ONE payout (a single bank deposit covering one or more bookings — common on Booking.com) OR MULTIPLE payouts (e.g. an Airbnb monthly earnings report where each booking is its own deposit on a separate date). You MUST detect which case this is and return a "payouts" ARRAY with one element per actual bank-transfer event.

DETECTION SIGNALS for multiple payouts (return one element per signal):
- Multiple "Payout" rows in a CSV (each Payout row is one bank transfer)
- Multiple "Transfer to <bank>" lines with distinct dates
- Multiple distinct payout dates in a Date column
- A monthly summary listing several separate bank transfers
- Airbnb format: each Reservation is usually paired with its own Payout row → one payout per reservation

When in doubt, prefer ONE payout per distinct payout date / bank-transfer event. NEVER collapse multiple separate deposits into one payout.

Extract this shape:
{
  "payouts": [
    { /* one element per bank deposit */ }
  ]
}

Each payout object:
- platform: "airbnb" / "booking_com" / "vrbo" / "stayz" / "direct" / "other" — use the user hint unless the statement obviously says otherwise
- payoutReference: platform's own ID (Airbnb "PAY-XXXXXXXX", Booking.com invoice #, or null)
- payoutDate: YYYY-MM-DD — date the platform issued THIS payout (null if not in text)
- expectedArrivalDate: YYYY-MM-DD if a bank arrival ETA is mentioned for THIS payout, else null
- currency: ISO code (default "AUD")
- totalNet: the net deposit amount of THIS payout (number, no commas, no $)
- lines: ordered array of line items for THIS payout only

Each line:
- lineType: "accommodation" / "cleaning_fee" / "host_fee" / "adjustment" / "cancellation" / "resolution" / "tax" / "other"
- description: short human description (e.g. "Kyle Armstrong · 2 nights", "Airbnb host service fee")
- amount: number. POSITIVE for income (accommodation, cleaning_fee). NEGATIVE for fees/deductions (host_fee, tax, cancellation reducing payout, adjustment if it reduces payout). No currency symbols, no commas.
- confirmationCode: the booking/reservation code if visible (e.g. "HMABC123"), else null
- guestName: if visible, else null

RULES
- One bank-transfer event = one payout object in the array
- Inside each payout, sum of lines.amount should approximately equal that payout's totalNet (within ~$1 rounding)
- Host service fees are NEGATIVE
- Cleaning fee charged to guest passing through to host is POSITIVE, lineType "cleaning_fee"
- A guest cancellation refund leaving the host's payout is NEGATIVE
- Resolution Center payouts are POSITIVE, lineType "resolution"
- For Airbnb CSV exports where Gross/Cleaning/Service-fee are columns: emit either (a) one "accommodation" line for gross minus cleaning + one "cleaning_fee" line + one "host_fee" line, OR (b) one "accommodation" line for the full gross + one "host_fee" line. Pick whichever makes the numbers add up cleanest.
- Do not invent values; null fields you cannot read

Return EXACTLY this top-level shape (note the OUTER payouts array):
{"payouts":[{"platform":"...","payoutReference":...,"payoutDate":"YYYY-MM-DD","expectedArrivalDate":...,"currency":"AUD","totalNet":0,"lines":[{"lineType":"accommodation","description":"...","amount":0,"confirmationCode":"...","guestName":"..."}]}]}`;

  // When a file is attached, send it as a vision/document content block.
  // Use Sonnet for vision (Haiku's vision is weaker) and for text-only
  // (multi-line statements need careful parsing). Mirrors receipt-reader.
  let messages;
  if (hasFile) {
    const fileBlock = _payoutFileMediaType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: _payoutFileBase64 } }
      : { type: 'image',    source: { type: 'base64', media_type: _payoutFileMediaType, data: _payoutFileBase64 } };
    const textBlock = { type: 'text', text: rawText
      ? promptInstructions + '\n\nADDITIONAL CONTEXT (pasted by user):\n"""\n' + rawText + '\n"""'
      : promptInstructions };
    messages = [{ role: 'user', content: [fileBlock, textBlock] }];
  } else {
    messages = [{
      role: 'user',
      content: promptInstructions + '\n\nRAW STATEMENT TEXT:\n"""\n' + rawText + '\n"""'
    }];
  }

  try {
    const { response, data } = await AIService.request({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages
    });
    if (!response.ok) throw new Error(data?.error?.message || 'AI service returned HTTP ' + response.status);
    const text = data?.content?.[0]?.text || '';
    if (!text) throw new Error('AI returned an empty response');
    const cleaned = text.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (_e) {
      throw new Error('AI did not return valid JSON — try re-uploading or pasting with more context');
    }
    // Normalize: accept either { payouts: [...] } (new shape) or a legacy
    // single-payout object with .lines. Wrap the latter so downstream code
    // only ever sees the array shape.
    if (!Array.isArray(parsed.payouts) && Array.isArray(parsed.lines)) {
      parsed = { payouts: [parsed] };
    }
    if (!Array.isArray(parsed.payouts) || !parsed.payouts.length) {
      throw new Error('AI did not find any payouts — the statement might be incomplete');
    }
    for (const p of parsed.payouts) {
      if (!Array.isArray(p.lines) || !p.lines.length) {
        throw new Error('AI returned a payout with no line items — re-try with the full statement');
      }
    }
    _payoutExtracted = parsed;
    _payoutMatchOverrides = {};
    _renderPayoutPasteReview(parsed);
  } catch (err) {
    console.warn('[StayOps] extractPayoutWithAI failed', err);
    _payoutPasteStatus('⚠ ' + (err.message || 'AI extraction failed'), 'err');
  }
}
window.extractPayoutWithAI = extractPayoutWithAI;

function _renderPayoutPasteReview(extracted) {
  document.getElementById('payout-paste-input-section').style.display = 'none';
  document.getElementById('payout-paste-review-section').style.display = 'block';
  const status = document.getElementById('payout-paste-status');
  status.style.display = 'none';

  const fmtMoney = (n) => (n < 0 ? '−$' : '$') + Math.abs(Number(n) || 0).toFixed(2);
  const payouts = Array.isArray(extracted.payouts) ? extracted.payouts : [extracted];

  // Build a stable list of selectable bookings once (re-used for every line).
  // Uses imported `bookings` (state.js ES module binding). In-memory field
  // for confirmation code is b.confirmCode.
  const bookingOptions = bookings
    .filter(b => b && isRevenueBearingBooking(b) && b._cloudId)
    .sort((a, b) => String(b.checkin || '').localeCompare(String(a.checkin || '')))
    .map(b => {
      const code = b.confirmCode || '';
      const label = `${b.name || 'Guest'} · ${b.checkin || '?'} → ${b.checkout || '?'}${code ? ' · ' + code : ''}`;
      return { id: b._cloudId, label };
    });

  // Overall summary in the header band: count + total net across all payouts.
  const grandTotalNet = payouts.reduce((s, p) => {
    const sumLines = (p.lines || []).reduce((ss, l) => ss + (Number(l.amount) || 0), 0);
    return s + sumLines; // lines are source of truth
  }, 0);
  const platformsSet = Array.from(new Set(payouts.map(p => p.platform || 'platform')));
  const payoutCount = payouts.length;

  document.getElementById('payout-paste-header').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;font-family:'Plus Jakarta Sans',sans-serif">
      <div style="min-width:0">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;color:var(--muted-2)">${escHtml(platformsSet.join(' / '))}</div>
        <div style="font-size:15px;font-weight:600;color:var(--ink-1);margin-top:2px">${payoutCount} payout${payoutCount === 1 ? '' : 's'} detected</div>
        <div style="font-size:12px;color:var(--muted-2);margin-top:2px">Review each one below — each becomes its own row in the payouts table.</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-size:11px;color:var(--muted-2);text-transform:uppercase;letter-spacing:0.4px">Grand Net</div>
        <div style="font-size:18px;font-weight:600;color:var(--ink-1)">${fmtMoney(grandTotalNet)}</div>
      </div>
    </div>`;

  // Build one card per payout, each with its own header band and line items.
  const cardsHtml = payouts.map((payout, pIdx) => {
    const lines = Array.isArray(payout.lines) ? payout.lines : [];
    const linesSum = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
    const totalNet = Number(payout.totalNet) || 0;
    const variance = Math.abs(linesSum - totalNet);
    const varianceWarn = totalNet && variance > 1
      ? `<div style="margin-top:6px;font-size:11px;color:#A32D2D;font-family:'Plus Jakarta Sans',sans-serif">⚠ Lines sum (${fmtMoney(linesSum)}) doesn't match stated total (${fmtMoney(totalNet)})</div>`
      : '';

    const linesHtml = lines.map((line, lIdx) => {
      const matched = _matchPayoutLineToBooking(line.confirmationCode);
      const matchedId = matched ? matched._cloudId : null;
      const matchedLabel = matched ? `${matched.name || 'Guest'} · ${matched.checkin || '?'}` : null;
      const showsBookingPicker = ['accommodation', 'cleaning_fee', 'cancellation', 'resolution'].includes(line.lineType);
      const amtColor = (Number(line.amount) || 0) < 0 ? '#A32D2D' : '#1D9E75';
      const selectKey = `${pIdx}.${lIdx}`;
      const sel = showsBookingPicker
        ? `<select data-payout-line-match="${escHtml(selectKey)}" style="width:100%;font-size:12px;padding:6px 8px;border-radius:6px;border:1px solid var(--hairline-1);background:#fff;font-family:'Plus Jakarta Sans',sans-serif;margin-top:4px">
            <option value="">— No booking link —</option>
            ${bookingOptions.map(b => `<option value="${escHtml(b.id)}"${matchedId === b.id ? ' selected' : ''}>${escHtml(b.label)}</option>`).join('')}
          </select>`
        : '';
      const matchBadge = matched
        ? `<div style="font-size:11px;color:#1D9E75;margin-top:2px;font-family:'Plus Jakarta Sans',sans-serif">✓ Auto-matched: ${escHtml(matchedLabel)}</div>`
        : (line.confirmationCode && showsBookingPicker
          ? `<div style="font-size:11px;color:#A32D2D;margin-top:2px;font-family:'Plus Jakarta Sans',sans-serif">No booking with code ${escHtml(line.confirmationCode)}</div>`
          : '');
      return `<div style="background:#fff;border:1px solid var(--hairline-1);border-radius:8px;padding:10px 12px;margin-bottom:6px;font-family:'Plus Jakarta Sans',sans-serif">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
          <div style="flex:1;min-width:0">
            <div style="font-size:11px;font-weight:600;color:var(--muted-2);text-transform:uppercase;letter-spacing:0.4px">${escHtml(line.lineType || 'other')}</div>
            <div style="font-size:14px;color:var(--ink-1);font-weight:500;margin-top:2px">${escHtml(line.description || '(no description)')}</div>
            ${line.confirmationCode ? `<div style="font-size:11px;color:var(--muted-2);margin-top:2px">Code: ${escHtml(line.confirmationCode)}</div>` : ''}
            ${matchBadge}
          </div>
          <div style="font-size:14px;font-weight:600;color:${amtColor};flex-shrink:0">${fmtMoney(line.amount)}</div>
        </div>
        ${sel}
      </div>`;
    }).join('');

    return `<div style="background:var(--surface2);border:1px solid var(--hairline-1);border-radius:12px;padding:12px;margin-bottom:14px;font-family:'Plus Jakarta Sans',sans-serif">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:10px">
        <div style="min-width:0">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;color:var(--muted-2)">Payout ${pIdx + 1} of ${payoutCount} · ${escHtml(payout.platform || 'platform')}</div>
          <div style="font-size:14px;font-weight:600;color:var(--ink-1);margin-top:2px">${escHtml(payout.payoutReference || '(no reference)')}</div>
          <div style="font-size:11px;color:var(--muted-2);margin-top:2px">Date: ${escHtml(payout.payoutDate || '?')}${payout.expectedArrivalDate ? ' · arrives ' + escHtml(payout.expectedArrivalDate) : ''}</div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="font-size:10px;color:var(--muted-2);text-transform:uppercase;letter-spacing:0.4px">Net</div>
          <div style="font-size:16px;font-weight:600;color:var(--ink-1)">${fmtMoney(totalNet)}</div>
        </div>
      </div>
      ${varianceWarn}
      ${linesHtml}
    </div>`;
  }).join('');

  document.getElementById('payout-paste-lines').innerHTML = cardsHtml;

  // Track manual booking overrides keyed by "<payoutIdx>.<lineIdx>".
  document.querySelectorAll('[data-payout-line-match]').forEach(sel => {
    sel.addEventListener('change', (ev) => {
      const key = ev.target.getAttribute('data-payout-line-match');
      _payoutMatchOverrides[key] = ev.target.value || null;
    });
  });
}

async function savePayoutFromPasteModal() {
  if (!_payoutExtracted) {
    _payoutPasteStatus('⚠ Nothing to save — extract first', 'err');
    return;
  }
  const payouts = Array.isArray(_payoutExtracted.payouts) ? _payoutExtracted.payouts : [_payoutExtracted];
  if (!payouts.length) {
    _payoutPasteStatus('⚠ Nothing to save — extract first', 'err');
    return;
  }

  const rawText = (document.getElementById('payout-paste-raw').value || '').trim();
  const platformSel = document.getElementById('payout-platform').value || 'other';

  // Save each payout (and its lines) sequentially so we can stop on the first
  // failure and report a precise message. For a typical monthly Airbnb (3-6
  // payouts) this is plenty fast.
  let savedCount = 0;
  let totalLinesInserted = 0;
  let totalMatched = 0;
  const failures = [];

  for (let pIdx = 0; pIdx < payouts.length; pIdx++) {
    const payout = payouts[pIdx];
    _payoutPasteStatus(`⏳ Saving payout ${pIdx + 1} of ${payouts.length}...`);
    const lines = Array.isArray(payout.lines) ? payout.lines : [];

    // Roll up totals from lines (source of truth — even if AI's totalNet is off)
    let gross = 0, platformFee = 0, adjustments = 0;
    for (const l of lines) {
      const amt = Number(l.amount) || 0;
      if (['accommodation', 'cleaning_fee'].includes(l.lineType)) gross += amt;
      else if (l.lineType === 'host_fee' || l.lineType === 'tax') platformFee += amt;
      else adjustments += amt;
    }
    const net = gross + platformFee + adjustments;

    const savedPayout = await savePlatformPayout({
      // Scope payouts to the active property so per-property revenue/reconciliation
      // queries can find them. Without this, payouts land with property_id=NULL
      // and silently disappear from property-filtered reports.
      propertyId: _financeActiveCloudPropertyId() || null,
      platform: payout.platform || platformSel,
      payoutReference: payout.payoutReference || null,
      payoutDate: payout.payoutDate || localDateStr(),
      expectedArrivalDate: payout.expectedArrivalDate || null,
      gross,
      platformFee,
      adjustments,
      net,
      currency: payout.currency || 'AUD',
      source: 'paste_ai',
      // Only attach the raw paste text to the FIRST payout to avoid storing
      // 3+ copies of the same monthly statement.
      rawSourceText: pIdx === 0 ? rawText : null,
    });
    if (!savedPayout) {
      failures.push(`Payout ${pIdx + 1} (${payout.payoutReference || payout.payoutDate || 'no-ref'}) — save failed`);
      continue;
    }

    // Resolve booking matches: per-line override beats auto-match.
    // Override keys are "<pIdx>.<lIdx>".
    const linesToInsert = lines.map((l, lIdx) => {
      const overrideKey = `${pIdx}.${lIdx}`;
      let bookingId, matchedBy, confidence;
      if (overrideKey in _payoutMatchOverrides) {
        bookingId = _payoutMatchOverrides[overrideKey] || null;
        matchedBy = bookingId ? 'manual' : null;
        confidence = bookingId ? 'high' : 'low';
      } else {
        const auto = _matchPayoutLineToBooking(l.confirmationCode);
        bookingId = auto ? auto._cloudId : null;
        matchedBy = bookingId ? 'confirmation_code' : null;
        confidence = bookingId ? 'high' : 'low';
      }
      return {
        lineType: l.lineType || 'other',
        description: l.description || null,
        amount: Number(l.amount) || 0,
        confirmationCode: l.confirmationCode || null,
        bookingId,
        matchedBy,
        confidence,
      };
    });

    const insertedLines = await insertPayoutLines(savedPayout._cloudId, linesToInsert);
    savedCount++;
    totalLinesInserted += insertedLines.length;
    totalMatched += linesToInsert.filter(l => l.bookingId).length;
  }

  if (failures.length && savedCount === 0) {
    _payoutPasteStatus('⚠ ' + failures.join('; '), 'err');
    return;
  }

  if (typeof globalThis.showBanner === 'function') {
    const partial = failures.length ? ` (${failures.length} failed — see console)` : '';
    globalThis.showBanner(
      `✓ ${savedCount} payout${savedCount === 1 ? '' : 's'} saved · ${totalLinesInserted} line${totalLinesInserted === 1 ? '' : 's'} · ${totalMatched} matched${partial}`,
      failures.length ? 'warn' : 'ok'
    );
  }
  if (failures.length) console.warn('[StayOps] partial payout save failures:', failures);

  closePayoutPasteModal();
  // Refresh the reconciliation view if it's visible
  if (typeof globalThis.refreshFinanceReconciliationSummary === 'function') {
    try { globalThis.refreshFinanceReconciliationSummary(); } catch (_e) { /* non-fatal */ }
  }
}
window.savePayoutFromPasteModal = savePayoutFromPasteModal;
