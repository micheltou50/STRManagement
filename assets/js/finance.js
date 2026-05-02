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
  categoriseTransactions,
  checkDuplicates,
  confirmTransaction,
  skipTransaction,
  logImportSession,
} from './bank-import.js';
import { findMatchesForTransaction, getReconciliationSummary, getAllTransactionsWithStatus } from './reconciliation.js';
import { bookings, cleans, expenses, replaceArrayInPlace } from './state.js';
import { escHtml, fmt, fmt2, fyLabel, fyMonths, escapeJsSingleQuotedHtmlAttr, fadeTransition } from './utils.js';
import { renderPortfolioFinance, isPortfolioMode } from './property.js';
import {
  clearExpensePhoto,
  getExpensePhotoUploadSnapshot,
  isExpensePhotoConverting,
} from './ai.js';
import { uploadReceiptToStorage, getReceiptViewUrl, saveExpenseToCloud, deleteExpenseFromCloud, getCurrentSupabaseUser } from './supabase.js';

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
  'Cleaning & Garden':       'cleaning',
  'Maintenance & Repairs':   'repairs',
  'Supplies & Consumables':  'sundry',
  'Utilities & Rates':       'water_rates',
  'Insurance':               'insurance',
  'Furnishings & Equipment': 'depreciation',
  'Renovation':              'capital_works',
  'Professional Services':   'accounting_legal',
  'Other':                   'sundry'
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
  return ATO_CATEGORY_MAP[category] || 'sundry';
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
  input.accept = '.csv,text/csv';
  input.style.display = 'none';
  input.onchange = (ev) => bankImportOnFileSelected(ev);
  document.body.appendChild(input);
  console.log('[StayOps] Bank import: created shared CSV file input');
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
    'margin:10px 0 0;padding:0 16px 8px;font-size:13px;color:var(--text-soft);line-height:1.45;display:none;font-family:\'DM Sans\',sans-serif';
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
    "font-size:12px;color:var(--forest);background:transparent;border:1px solid var(--forest);border-radius:8px;padding:6px 12px;cursor:pointer;font-family:'DM Sans',sans-serif;font-weight:600;white-space:nowrap";
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
    "font-size:12px;color:var(--forest);background:transparent;border:1px solid var(--forest);border-radius:8px;padding:6px 12px;cursor:pointer;font-family:'DM Sans',sans-serif;font-weight:600;white-space:nowrap";
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
      <div style="font-size:15px;font-weight:600;margin-bottom:8px;color:var(--forest)">Analysing transactions…</div>
      <div style="font-size:13px;color:var(--text-soft)">Please wait while we check for duplicates and categorise entries.</div>
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
      <div style="font-family:inherit;font-size:16px;font-weight:500;color:#1a1a1a">Review Transactions</div>
      <div style="font-size:13px;font-weight:400;color:#999;margin-top:4px">${total} transactions · ${autoPersonal} auto-skipped (personal)</div>
    </div>
    <div id="bank-import-sticky-summary" style="position:sticky;top:0;z-index:5;background:var(--color-background-primary,var(--mist));padding:12px 16px;border-bottom:0.5px solid var(--border-tertiary,var(--stone));margin-bottom:8px">
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between">
        <div style="font-size:13px;color:var(--text)">
          <strong>${ready}</strong> ready to import · <strong>${skipped}</strong> skipped · <strong>${dups}</strong> duplicates
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          <button type="button" id="bank-import-run-btn" onclick="globalThis.bankImportRunImport()" style="font-size:12px;padding:8px 14px;border-radius:8px;border:none;background:var(--forest);color:white;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">Import All</button>
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
      let borderLeft = '0.5px solid var(--border-tertiary,var(--stone))';
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
        <div class="bank-import-card" data-idx="${i}" style="background:white;border:0.5px solid var(--border-tertiary,var(--stone));border-radius:12px;padding:14px 16px;margin:0 16px 8px;opacity:${greyed ? 0.5 : 1};border-left:${borderLeft}">
          ${bankImportMatchStripHtml(row)}
          ${dup ? `<div style="font-size:12px;color:#b45309;background:#fff7ed;padding:8px 10px;border-radius:8px;margin-bottom:10px">Possible duplicate</div>` : ''}
          ${isPersonal ? `<div style="font-size:12px;font-weight:600;color:var(--text-soft);margin-bottom:8px">Personal — skipped</div>` : ''}
          <div style="display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:flex-start">
            <div style="flex:1;min-width:140px">
              <div style="font-size:13px;font-weight:600;color:var(--text)">${bankImportFmtDayMon(row.date)}</div>
              <div style="font-size:13px;color:var(--text);margin-top:4px;word-break:break-word;line-height:1.4">${escHtml(row.description || '')}</div>
              <div style="font-size:16px;font-weight:700;margin-top:8px;font-family:'DM Serif Display',serif">${amountStr}</div>
            </div>
            <div style="flex:1;min-width:200px;display:flex;flex-direction:column;gap:8px">
              <select id="bank-import-prop-${i}" onchange="globalThis.bankImportOnPropChange(${i})" ${isPersonal || matchLocked ? 'disabled' : ''}
                style="width:100%;box-sizing:border-box;font-size:13px;padding:8px 10px;border:1px solid var(--stone);border-radius:8px;background:${matchLocked ? 'var(--warm)' : 'var(--mist)'};font-family:'DM Sans',sans-serif;color:${matchLocked ? 'var(--text-soft)' : 'inherit'}">
                ${propOptions}
              </select>
              <select id="bank-import-cat-${i}" onchange="globalThis.bankImportOnCatChange(${i})" ${isPersonal || matchLocked ? 'disabled' : ''}
                style="width:100%;box-sizing:border-box;font-size:13px;padding:8px 10px;border:1px solid var(--stone);border-radius:8px;background:${matchLocked ? 'var(--warm)' : 'var(--mist)'};font-family:'DM Sans',sans-serif;color:${matchLocked ? 'var(--text-soft)' : 'inherit'}">
                <option value="">— Category —</option>
                ${catOptions}
              </select>
              <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-soft)">
                <span style="width:8px;height:8px;border-radius:50%;background:${confDot};flex-shrink:0"></span>
                <span>${confLabel}</span>
              </div>
              <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:4px">
                ${isPersonal || row.userMarkedSkip ? `<button type="button" onclick="globalThis.bankImportUndoSkip(${i})" style="font-size:12px;padding:6px 10px;border-radius:8px;border:1px solid var(--moss);color:var(--moss);background:#f0faf4;cursor:pointer;font-family:'DM Sans',sans-serif">Undo</button>` : `<button type="button" onclick="globalThis.bankImportSkipRow(${i})" style="font-size:12px;padding:6px 10px;border-radius:8px;border:1px solid var(--stone);background:white;cursor:pointer;font-family:'DM Sans',sans-serif">Skip</button>
                <button type="button" onclick="globalThis.bankImportPersonalRow(${i})" style="font-size:12px;padding:6px 10px;border-radius:8px;border:1px solid var(--red);color:var(--red);background:#fff5f5;cursor:pointer;font-family:'DM Sans',sans-serif">Personal</button>`}
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

  const reader = new FileReader();
  reader.onload = async (e) => {
    const fileText = e.target && e.target.result ? String(e.target.result) : '';
    const parsed = await parseCSV(fileText);
    console.log('[StayOps] Bank CSV parsed:', parsed.length, 'rows from', fileText.length, 'chars');
    if (!parsed.length) {
      globalThis.showBanner('No expense transactions found — check the file format (CSV or tab-delimited)', 'warn');
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
      _bankImportFilename = file.name || 'statement.csv';
      _bankImportReviewActive = true;

      renderBankImportReview();
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.error('[StayOps] Bank import failed:', msg, err);
      globalThis.showBanner('Import error: ' + msg.slice(0, 80), 'warn');
      bankImportRestoreBackup();
    }
  };
  reader.onerror = () => {
    globalThis.showBanner('Could not read file', 'warn');
    bankImportRestoreBackup();
  };
  reader.readAsText(file);
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
        const local = {
          id: Date.now() + n,
          _cloudId: row && row.id,
          _propertyId: row && row.property_id,
          merchant: (row && row.vendor) || r.vendor || '',
          description: (row && row.description) || r.description || '',
          amount: Number((row && row.amount) != null ? row.amount : r.amount),
          date: (row && row.date) || r.date,
          category: (row && row.category) || r.category,
          receiptType: 'missing',
          receiptNum: '',
          driveLink: '',
          photo: null,
        };
        expenses.push(local);
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
        <div style="font-size:11px;color:var(--text-soft);margin-top:2px">${e.date ? fmt(e.date) : ''} · ${fmtAmt(e.amount)}</div>
      </div>
      <button onclick="document.getElementById('bank-receipt-prompt-overlay').style.display='none';document.body.style.overflow='';openExpenseEdit('${e.id}')" style="flex-shrink:0;margin-left:10px;padding:6px 12px;border-radius:8px;border:1.5px solid var(--forest);background:white;color:var(--forest);font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">Add Receipt</button>
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
          <div style="font-size:15px;font-weight:700;color:var(--forest)">Add Receipts</div>
          <div style="font-size:12px;color:var(--text-soft);margin-top:2px">${items.length} expense${items.length !== 1 ? 's' : ''} created — attach receipts now or later</div>
        </div>
        <button onclick="document.getElementById('bank-receipt-prompt-overlay').style.display='none';document.body.style.overflow=''" style="width:28px;height:28px;border-radius:50%;border:none;background:var(--mist);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--text-soft)">×</button>
      </div>
      ${list}
      <button onclick="document.getElementById('bank-receipt-prompt-overlay').style.display='none';document.body.style.overflow='';if(typeof showReconciliationView==='function')showReconciliationView()" style="width:100%;margin-top:14px;padding:12px;border-radius:10px;border:none;background:var(--forest);color:white;font-size:13px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">View Transaction Map →</button>
    </div>`;
  document.body.style.overflow = 'hidden';
}

// ── FINANCE HUB NAVIGATION ───────────────────────────────────────────────────

/** Call when leaving the Finance tab (except when opening Settings from Finance). */
export function resetFinanceSubViewToHub() {
  financeSubView = 'hub';
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
    if (expDateEl && !expDateEl.value) expDateEl.value = new Date().toISOString().split('T')[0];
    populateExpenseCatSelect();
    // Scroll the form into view
    setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  }
}

/** Close the Add Expense form panel (called after a successful save). */
function closeExpenseAddForm() {
  const panel   = document.getElementById('expense-add-form-panel');
  const chevron = document.getElementById('expense-add-chevron');
  if (panel)   panel.style.display = 'none';
  if (chevron) chevron.textContent = '›';
}

/** Navigate into a Finance sub-view (expenses, reports, reconciliation, or recurring). */
function showFinanceSub(sub) {
  if (sub === 'expenses') financeSubView = 'expenses';
  else if (sub === 'reports') financeSubView = 'reports';
  else if (sub === 'reconciliation') financeSubView = 'reconciliation';
  else if (sub === 'recurring') financeSubView = 'recurring';
  else if (sub === 'depreciation') financeSubView = 'depreciation';
  else if (sub === 'tax-export') financeSubView = 'tax-export';
  _financeTab = sub;
  const hub = document.getElementById('finance-hub');
  if (hub) hub.style.display = 'none';
  ['finance-expenses-view', 'finance-reports-view', 'finance-reconciliation-view', 'finance-recurring-view', 'finance-depreciation-view', 'finance-tax-export-view'].forEach(id => {
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
  if (panelId === 'expense-cats') financeSubView = 'categories';
  else if (panelId === 'smart-pricing') financeSubView = 'smartpricing';
  else if (panelId === 'bank-details') financeSubView = 'bankdetails';
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

function renderMgmtFY() {
  const el = document.getElementById('mgmt-fy-content');
  if (!el) return;
  const months = fyMonths(reportFY);
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const propertyBookings = _financeScopedBookings();
  const mdata = months.map(({year, month}) => {
    const bs = propertyBookings.filter(b => b.status !== 'cancelled' && (()=>{ const d=new Date(b.checkin); return d.getFullYear()===year&&d.getMonth()===month; })());
    return { label: mo[month], total: bs.reduce((s,b)=>s+Number(b.mgmtPayout||0),0), count: bs.length };
  });
  const fyTotal = mdata.reduce((s,m)=>s+m.total, 0);
  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <button type="button" onclick="fyPrev();renderMgmtFY()" style="background:var(--warm);border:none;border-radius:8px;width:32px;height:32px;font-size:16px;cursor:pointer;font-family:'DM Sans',sans-serif">‹</button>
      <div style="font-size:15px;font-weight:500;color:#1a1a1a;font-family:'DM Sans',sans-serif">${fyLabel(reportFY)}</div>
      <button type="button" onclick="fyNext();renderMgmtFY()" style="background:var(--warm);border:none;border-radius:8px;width:32px;height:32px;font-size:16px;cursor:pointer;font-family:'DM Sans',sans-serif">›</button>
    </div>
    <div style="text-align:center;padding:16px;background:#fff;border-radius:12px;margin-bottom:12px;border:0.5px solid rgba(0,0,0,0.08)">
      <div style="font-size:11px;color:var(--text-soft)">Total management payout</div>
      <div style="font-family:'DM Sans',sans-serif;font-size:28px;font-weight:500;color:#1a1a1a;margin-top:6px">$${fyTotal.toLocaleString('en-AU',{minimumFractionDigits:0,maximumFractionDigits:0})}</div>
    </div>
    <div style="background:#fff;border-radius:12px;padding:0 16px;border:0.5px solid rgba(0,0,0,0.08)">
      ${mdata.map(m=>`<div class="fin-rev-row"><div><div style="font-size:14px;font-weight:500">${m.label}</div><div style="font-size:11px;color:var(--text-soft);margin-top:2px">${m.count} booking${m.count!==1?'s':''}</div></div><div style="font-size:14px;font-weight:500;color:#1D9E75">$${m.total.toLocaleString('en-AU',{minimumFractionDigits:0,maximumFractionDigits:0})}</div></div>`).join('')}
    </div>`;
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
    return propertyBookings.filter(b => b.status !== 'cancelled' && (function(){ const d = new Date(b.checkin); return d.getFullYear()===year && d.getMonth()===month; })());
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
    const revenue = bs.reduce((s,b) => s + Number(b.hostPayout||0), 0);
    const netPayout = bs.reduce((s,b) => s + Number(b.netPayout||0), 0);
    const platformRev = {};
    platforms.forEach(p => { platformRev[p] = bs.filter(b=>b.platform===p).reduce((s,b)=>s+Number(b.hostPayout||0),0); });
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
        <button onclick="fyPrev()" style="background:var(--warm);border:none;border-radius:8px;width:32px;height:32px;font-size:16px;cursor:pointer">‹</button>
        <div style="font-family:inherit;font-size:16px;font-weight:500;color:#1a1a1a">${fyLabel(reportFY)}</div>
        <button onclick="fyNext()" style="background:var(--warm);border:none;border-radius:8px;width:32px;height:32px;font-size:16px;cursor:pointer">›</button>
      </div>
      <div style="margin-top:12px" class="report-kpi-grid">
        <div class="report-kpi"><div class="report-kpi-val">${fmt2(fyTotalRev)}</div><div class="report-kpi-label">Total Revenue</div></div>
        <div class="report-kpi"><div class="report-kpi-val">${fmt2(fyTotalNet)}</div><div class="report-kpi-label">Owner Payout</div></div>
        <div class="report-kpi" style="background:${fyNetIncome>=0?'#EDF7ED':'#FEF2F2'}"><div class="report-kpi-val" style="color:${fyNetIncome>=0?'var(--forest)':'var(--red)'}">${fmt2(Math.abs(fyNetIncome))}</div><div class="report-kpi-label">Net Income ${fyNetIncome<0?'(Loss)':''}</div></div>
        <div class="report-kpi"><div class="report-kpi-val">${fyOccupancy.toFixed(0)}%</div><div class="report-kpi-label">Occupancy</div></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px">
        <button onclick="exportReportPDF()" class="no-print" style="background:var(--forest);color:white;border:none;border-radius:var(--radius-sm);padding:12px;font-size:14px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">⬇ Export PDF</button>
        <button onclick="exportReportCSV()" class="no-print" style="background:var(--mist);color:var(--forest);border:1.5px solid var(--forest);border-radius:var(--radius-sm);padding:12px;font-size:14px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">⬇ Export CSV</button>
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
        <div style="font-size:11px;color:var(--text-soft);background:var(--warm);padding:8px 10px;border-radius:var(--radius-sm)"><b>ALOS</b> ${fyALOS.toFixed(1)} nights avg</div>
        <div style="font-size:11px;color:var(--text-soft);background:var(--warm);padding:8px 10px;border-radius:var(--radius-sm)"><b>Bookings</b> ${fyBookings} total</div>
      </div>
      <div style="margin-top:10px;font-size:11px;color:var(--text-soft);line-height:1.6;border-top:1px solid var(--warm);padding-top:8px">
        <b>ADR</b> Average Daily Rate — revenue ÷ booked nights &nbsp;·&nbsp; <b>RevPAR</b> Revenue Per Available Night — revenue ÷ all available nights &nbsp;·&nbsp; <b>ALOS</b> Average Length of Stay
      </div>
    </div>

    <!-- Expense Breakdown -->
    <div class="card" style="margin-bottom:12px">
      <div class="report-section-title">Expenses by Category</div>
      ${allExp.length === 0 ? '<div style="color:var(--text-soft);font-size:13px">No expenses recorded for this financial year.</div>' : `
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
          <tr class="highlight-row"><td>Net Income</td><td style="color:${fyNetIncome>=0?'var(--forest)':'var(--red)'}">${fyNetIncome<0?'−':''} ${fmt2(Math.abs(fyNetIncome))}</td></tr>
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
  'strata': 'strata', 'strata/body corp': 'strata',
  'mortgage': 'mortgage',
  'advertising': 'advertising',
  'linen': 'linen',
  'pest control': 'pest_control', 'pest_control': 'pest_control',
  'other': 'other',
};
function _normCategoryKey(cat) {
  if (!cat) return 'other';
  const lower = String(cat).trim().toLowerCase();
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
    return b.status !== 'cancelled' && d.getMonth()===revMonth && d.getFullYear()===revYear;
  });
  const totalHost = monthBookings.reduce((s,b)=>s+Number(b.hostPayout||0),0);
  const totalMgmt = monthBookings.reduce((s,b)=>s+Number(b.mgmtFee||0),0);

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
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;font-size:12px;border-bottom:0.5px solid rgba(0,0,0,0.05)"><div style="min-width:0"><div style="color:var(--text);font-weight:500">${escHtml(e.category||'Uncategorised')}${badge}</div><div style="color:var(--text-soft);font-size:11px;margin-top:1px">${escHtml(e.description||'')}${e.date ? ' · ' + fmt(e.date) : ''}</div></div><div style="flex-shrink:0;color:#E24B4A;font-weight:500;margin-left:12px">$${_fmtAud(Math.abs(Number(e.amount||0)))}</div></div>`;
  };
  const opDetailHtml = operationalExpenses.length ? [...operationalExpenses].sort((a,b) => new Date(a.date) - new Date(b.date)).map(_expRow).join('') : '<div style="color:var(--text-soft);font-size:12px;padding:8px 0">No operational expenses this month.</div>';
  const ownerDetailHtml = ownerPaidExpenses.length ? [...ownerPaidExpenses].sort((a,b) => new Date(a.date) - new Date(b.date)).map(_expRow).join('') : '';

  // ── Summary section ──
  // ── Clean cost detail row builder ──
  const _cleanCostRow = (c) => {
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;font-size:12px;border-bottom:0.5px solid rgba(0,0,0,0.05)"><div style="min-width:0"><div style="color:var(--text);font-weight:500">${escHtml(c.cleaner || 'Cleaner')}</div><div style="color:var(--text-soft);font-size:11px;margin-top:1px">${escHtml(c.guestName || '')}${c.date ? ' · ' + fmt(c.date) : ''}</div></div><div style="flex-shrink:0;color:#E24B4A;font-weight:500;margin-left:12px">$${_fmtAud(Number(c.cost||0))}</div></div>`;
  };
  const cleanCostDetailHtml = monthCleanCosts.length ? [...monthCleanCosts].sort((a,b) => new Date(a.date) - new Date(b.date)).map(_cleanCostRow).join('') : '';

  let summaryHtml = `<div class="finance-summary">
    <div class="finance-row"><span class="finance-label">Gross revenue</span><span class="finance-val" style="color:#1a1a1a;font-weight:500">$${_fmtAud(totalHost)}</span></div>
    <div class="finance-row"><span class="finance-label">Management fees</span><span class="finance-val" style="color:#E24B4A;font-weight:500">− $${_fmtAud(totalMgmt)}</span></div>`;

  if (totalCleanCost > 0) {
    summaryHtml += `
    <div class="finance-row" style="cursor:pointer;border-radius:6px;margin:0 -4px;padding:10px 4px;transition:background 0.15s" onclick="var d=document.getElementById('rev-clean-cost-detail');var open=d.style.display!=='none';d.style.display=open?'none':'block';this.querySelector('.cc-chevron').textContent=open?'▾':'▴'" onmouseover="this.style.background='var(--mist)'" onmouseout="this.style.background=''">
      <span class="finance-label" style="display:flex;align-items:center;gap:4px">Cleaning costs (${monthCleanCosts.length}) <span class="cc-chevron" style="font-size:9px;color:var(--text-soft);transition:transform 0.2s">▾</span></span>
      <span class="finance-val" style="color:#E24B4A;font-weight:500">− $${_fmtAud(totalCleanCost)}</span>
    </div>
    <div id="rev-clean-cost-detail" style="display:none;padding:10px 14px;margin:2px 0 6px;background:var(--mist);border-radius:10px">${cleanCostDetailHtml}</div>`;
  }

  if (isDeduct && totalOperational > 0) {
    // Model A: operational expenses deducted before payout
    summaryHtml += `
    <div class="finance-row" style="cursor:pointer;border-radius:6px;margin:0 -4px;padding:10px 4px;transition:background 0.15s" onclick="var d=document.getElementById('rev-expense-detail');var open=d.style.display!=='none';d.style.display=open?'none':'block';this.querySelector('.exp-chevron').textContent=open?'▾':'▴'" onmouseover="this.style.background='var(--mist)'" onmouseout="this.style.background=''">
      <span class="finance-label" style="display:flex;align-items:center;gap:4px">Expenses (${operationalExpenses.length}) <span class="exp-chevron" style="font-size:9px;color:var(--text-soft);transition:transform 0.2s">▾</span></span>
      <span class="finance-val" style="color:#E24B4A;font-weight:500">− $${_fmtAud(totalOperational)}</span>
    </div>
    <div id="rev-expense-detail" style="display:none;padding:10px 14px;margin:2px 0 6px;background:var(--mist);border-radius:10px">${opDetailHtml}</div>`;
  }

  const payoutColor = finalPayout >= 0 ? '#1D9E75' : '#E24B4A';
  summaryHtml += `
    <div class="finance-row finance-total" style="border-top:1.5px solid var(--stone);padding-top:12px;margin-top:4px"><span class="finance-label" style="font-size:14px">Owner payout</span><span class="finance-val" style="color:${payoutColor};font-size:14px">${_fmtPayout(finalPayout)}</span></div>
  </div>`;

  // Owner-paid costs section (shown in both modes when they exist)
  if (ownerPaidExpenses.length > 0) {
    summaryHtml += `
    <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--warm)">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-soft);margin-bottom:8px;cursor:pointer;display:flex;justify-content:space-between;align-items:center" onclick="var d=document.getElementById('rev-owner-cost-detail');var open=d.style.display!=='none';d.style.display=open?'none':'block';this.querySelector('.oc-chevron').textContent=open?'▾':'▴'">
        <span>OWNER COSTS (${ownerPaidExpenses.length}) <span class="oc-chevron" style="font-size:9px;transition:transform 0.2s">▾</span></span>
        <span style="font-size:13px;font-weight:600;color:var(--text-soft);letter-spacing:0;text-transform:none">$${_fmtAud(totalOwnerPaid)}</span>
      </div>
      <div style="font-size:11px;color:var(--text-soft);margin-bottom:8px;line-height:1.4">Not deducted from payout — paid by owner directly</div>
      <div id="rev-owner-cost-detail" style="display:none;padding:10px 14px;background:var(--mist);border-radius:10px">${ownerDetailHtml}</div>
    </div>`;
  }

  if (!isDeduct && monthExpenses.length > 0) {
    // Model B: ALL expenses shown separately below (not just owner-paid)
    const allDetailHtml = [...monthExpenses].sort((a,b) => new Date(a.date) - new Date(b.date)).map(_expRow).join('');
    summaryHtml += `
    <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--warm)">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-soft);margin-bottom:8px;cursor:pointer;display:flex;justify-content:space-between;align-items:center" onclick="var d=document.getElementById('rev-all-expense-detail');var open=d.style.display!=='none';d.style.display=open?'none':'block';this.querySelector('.exp-chevron').textContent=open?'▾':'▴'">
        <span>ALL EXPENSES (${monthExpenses.length}) <span class="exp-chevron" style="font-size:9px;transition:transform 0.2s">▾</span></span>
        <span style="font-size:13px;font-weight:600;color:#E24B4A;letter-spacing:0;text-transform:none">$${_fmtAud(totalOperational + totalOwnerPaid)}</span>
      </div>
      <div id="rev-all-expense-detail" style="display:none;padding:10px 14px;background:var(--mist);border-radius:10px">${allDetailHtml}</div>
    </div>`;
  }

  document.getElementById('finance-summary-content').innerHTML = summaryHtml;

  // ── Per-booking breakdown ──
  document.getElementById('revenue-breakdown').innerHTML = monthBookings.length ? [...monthBookings].sort((a,b)=>new Date(a.checkin)-new Date(b.checkin)).map(b=>`
    <div class="fin-rev-row">
      <div style="min-width:0"><div style="font-weight:500;font-size:14px;color:#1a1a1a">${escHtml(b.name||'')}</div><div style="font-size:11px;color:var(--text-soft);margin-top:2px">${fmt(b.checkin)} · ${b.nights}n</div></div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-size:14px;font-weight:500;color:#1a1a1a;font-family:'DM Sans',sans-serif">$${Number(b.hostPayout||0).toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
        <div style="font-size:11px;color:#1D9E75;margin-top:2px;font-family:'DM Sans',sans-serif">$${Number(b.netPayout||0).toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
      </div>
    </div>`).join('') : '<div style="color:var(--text-soft);font-size:13px;padding:14px 0">No bookings this month.</div>';
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
    return b.status !== 'cancelled' && d.getMonth() === mgmtMonth && d.getFullYear() === mgmtYear;
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
    box.style.background = '#1E3A2F';
    box.style.borderColor = '#1E3A2F';
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
  const totalMgmtPayout = monthBookings.reduce((s,b)=>s+Number(b.mgmtPayout||0),0);
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
    bd.innerHTML = monthBookings.length ? [...monthBookings].sort((a,b)=>new Date(a.checkin)-new Date(b.checkin)).map(b=> {
      const checked = mgmtSelected.has(_mgmtBookingKey(b)) ? 'checked' : '';
      const bookingId = escHtml(_mgmtBookingKey(b));
      return `<label class="fin-mgmt-book-row" style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:0.5px solid rgba(0,0,0,0.08);cursor:pointer;margin:0;text-transform:none">
        <span class="mgmt-booking-check-wrap" style="position:relative;display:inline-flex;width:20px;height:20px;flex-shrink:0">
          <input class="mgmt-booking-check" data-booking-id="${bookingId}" type="checkbox" ${checked}
            style="position:absolute;inset:0;opacity:0;margin:0;cursor:pointer;z-index:2">
          <span class="mgmt-booking-box" style="width:20px;height:20px;border:1.5px solid #C8C6BF;border-radius:4px;background:#fff;display:flex;align-items:center;justify-content:center;box-sizing:border-box">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="display:none">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </span>
        </span>
        <div style="flex:1;min-width:0">
          <div style="font-weight:500;font-size:14px;color:#1a1a1a;text-transform:none">${escHtml(b.name||'')}</div>
          <div style="font-size:11px;color:var(--text-soft);margin-top:2px">${fmt(b.checkin)} · ${b.nights}n · Host $${Number(b.hostPayout||0).toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
        </div>
        <div style="font-size:14px;font-weight:500;color:#1D9E75;font-family:'DM Sans',sans-serif;flex-shrink:0">$${Number(b.mgmtPayout||0).toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
      </label>`;
    }).join('') : '<div style="color:var(--text-soft);font-size:13px;padding:14px 0">No bookings this month.</div>';
  }
  _bindMgmtActionButtons();
  _bindMgmtBookingCheckboxes();
  updateMgmtGenInvoiceBtn();
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
  const monthBookings = _getMgmtMonthBookings();
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
  const sum = sel.reduce((s,b)=>s+Number(b.mgmtPayout||0),0);
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

function _recordIssuedInvoice(record) {
  try {
    if (!record || !record.number) return;
    window._appConfig = window._appConfig || {};
    const list = Array.isArray(window._appConfig.invoices) ? window._appConfig.invoices.slice() : [];
    // Idempotency guard: never store the same number twice.
    if (list.some(r => r && (r.number || r.invoiceNumber) === record.number)) return;
    list.push(record);
    window._appConfig.invoices = list;
    if (typeof saveAppConfigToCloud === 'function') {
      saveAppConfigToCloud({ invoices: list }).catch(e => console.warn('[StayOps] silent error:', e));
    }
  } catch (_e) { /* fail silently — never block invoice generation */ }
}

function buildInvoicePDF(selected, client) {
  const inv = _getInvoiceIdentity();
  const bank = (window._appConfig && window._appConfig.bank_details) || { name:'', bsb:'', acc:'', bank:'' };

  const invDate = new Date();
  const invNum = _getNextInvoiceNumber(_getIssuedInvoices(), invDate);
  const today = invDate.toLocaleDateString('en-AU', { day:'numeric', month:'long', year:'numeric' });
  const dueDate = new Date(invDate.getTime() + 14 * 24 * 60 * 60 * 1000)
    .toLocaleDateString('en-AU', { day:'numeric', month:'long', year:'numeric' });

  // Not registered for GST — no GST column or breakdown.
  let invoiceTotal = 0;
  const rows = selected.map(b => {
    const amt = Number(b.mgmtPayout || 0);
    invoiceTotal += amt;
    const desc = `Management fee — ${b.name || 'Guest'} (${fmt(b.checkin)} → ${fmt(b.checkout)})`;
    return `<tr>
      <td class="cell desc">${desc}</td>
      <td class="cell num">1</td>
      <td class="cell num">$${amt.toFixed(2)}</td>
      <td class="cell num">$${amt.toFixed(2)}</td>
    </tr>`;
  }).join('');

  const reference = (client && (client.reference || client.po)) ? String(client.reference || client.po) : '';

  const billToBlock = client ? `
    <div class="bill-to">
      <div class="meta-label">Bill To</div>
      <div class="bill-to-name">${client.name || ''}</div>
      ${client.contact?`<div class="muted">${client.contact}</div>`:''}
      ${client.email?`<div class="muted">${client.email}</div>`:''}
      ${client.address?`<div class="muted">${client.address}</div>`:''}
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
      ${inv.company ? `<div class="biz-line"><strong>${inv.company}</strong></div>` : ''}
      ${inv.name && inv.name !== inv.company ? `<div class="biz-line">${inv.name}</div>` : ''}
      ${inv.address ? `<div class="biz-line">${inv.address}</div>` : ''}
      ${inv.abn ? `<div class="biz-line">ABN: ${inv.abn}</div>` : ''}
    </div>
    <div class="meta-col">
      <div class="meta-row"><div class="meta-label">Invoice Date</div><div class="meta-val">${today}</div></div>
      <div class="meta-row"><div class="meta-label">Invoice Number</div><div class="meta-val">${invNum}</div></div>
      ${reference ? `<div class="meta-row"><div class="meta-label">Reference / PO</div><div class="meta-val">${reference}</div></div>` : `<div class="meta-row"><div class="meta-label">Reference / PO</div><div class="meta-val">&nbsp;</div></div>`}
    </div>
    <div class="right-block">
      ${inv.logo ? `<div style="margin-bottom:8px"><img src="${inv.logo}" style="max-width:100px;max-height:70px" alt="Logo"></div>` : ''}
      ${inv.company || inv.name ? `<div class="biz-name">${inv.company || inv.name}</div>` : ''}
      ${inv.address ? `<div>${inv.address}</div>` : ''}
      ${inv.phone ? `<div>${inv.phone}</div>` : ''}
      ${inv.email ? `<div>${inv.email}</div>` : ''}
      ${inv.abn ? `<div>A.B.N ${inv.abn}</div>` : ''}
      ${inv.acn ? `<div>ACN: ${inv.acn}</div>` : ''}
    </div>
  </div>

  ${billToBlock}

  <table class="lines">
    <thead><tr>
      <th>Description</th>
      <th class="num">Quantity</th>
      <th class="num">Unit Price</th>
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
  <div class="gst-note">Not registered for GST</div>

  ${bankBlock}

  <div class="footer">${getCurrentPropertyName()} · ${[getPropertyConfig().suburb, getPropertyConfig().state].filter(Boolean).join(' ')} · Generated ${today}</div>
  <div class="actions">
    <button class="primary" onclick="window.print()">Save as PDF</button>
    <button class="secondary" onclick="window.close()">Back to App</button>
  </div>
</body></html>`;

  // Persist the issued number BEFORE opening the popup so the next call
  // increments correctly even if the popup is blocked or closed early.
  _recordIssuedInvoice({
    number: invNum,
    date: invDate.toISOString(),
    total: Number(invoiceTotal.toFixed(2)),
    clientName: (client && client.name) || '',
  });

  const w = window.open('', '_blank');
  if (!w) {
    if (typeof globalThis.showBanner === 'function') {
      globalThis.showBanner('⚠ Popup blocked — allow popups to view invoice', 'warn');
    }
    return;
  }
  w.document.write(html);
  w.document.close();
}
// ── EXPENSE CATEGORY MANAGEMENT ───────────────────────────────────────────
function bindExpenseCatRowHandlers(i, name) {
  const wrap = document.querySelector(`[data-expcat-idx="${i}"]`);
  const inner = document.querySelector(`[data-expcat-inner="${i}"]`);
  const delBtn = document.querySelector(`[data-expcat-del="${i}"]`);
  if (!wrap || !inner) return;
  let sx = 0;
  let revealed = false;
  wrap.addEventListener(
    'touchstart',
    (e) => {
      sx = e.touches[0].clientX;
    },
    { passive: true }
  );
  wrap.addEventListener(
    'touchend',
    (e) => {
      const ex = e.changedTouches[0].clientX;
      if (sx - ex > 55) {
        revealed = true;
        inner.style.transform = 'translateX(-64px)';
        if (delBtn) delBtn.style.transform = 'translateX(0)';
      } else if (ex - sx > 45) {
        revealed = false;
        inner.style.transform = '';
        if (delBtn) delBtn.style.transform = 'translateX(100%)';
      }
    },
    { passive: true }
  );
  let lp = null;
  wrap.addEventListener(
    'touchstart',
    () => {
      lp = setTimeout(() => {
        deleteExpenseCat(i);
      }, 550);
    },
    { passive: true }
  );
  wrap.addEventListener(
    'touchend',
    () => {
      if (lp) clearTimeout(lp);
    },
    { passive: true }
  );
  wrap.addEventListener(
    'touchmove',
    () => {
      if (lp) clearTimeout(lp);
    },
    { passive: true }
  );
  inner.addEventListener('click', () => {
    if (revealed) {
      inner.style.transform = '';
      if (delBtn) delBtn.style.transform = 'translateX(100%)';
      revealed = false;
      return;
    }
    const sp = inner.querySelector(`[data-expcat-txt="${i}"]`);
    if (!sp || inner.querySelector('input')) return;
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = name;
    inp.style.cssText =
      "flex:1;min-width:0;font-size:14px;padding:6px 8px;border-radius:8px;border:0.5px solid rgba(0,0,0,0.15);font-family:'DM Sans',sans-serif";
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
        <button type="button" data-expcat-del="${i}" onclick="event.stopPropagation();deleteExpenseCat(${i})"
          style="position:absolute;right:0;top:0;bottom:0;width:64px;border:none;background:#FEE2E2;color:#991B1B;font-weight:600;font-size:12px;font-family:'DM Sans',sans-serif;transform:translateX(100%);transition:transform 0.2s ease;cursor:pointer">Delete</button>
        <div data-expcat-inner="${i}" style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:0.5px solid rgba(0,0,0,0.08);background:#fff;transition:transform 0.2s ease;cursor:pointer">
          <span data-expcat-txt="${i}" style="font-size:14px;color:#1a1a1a;font-family:'DM Sans',sans-serif">${escHtml(c)}</span>
          <span style="font-size:12px;color:var(--text-soft);font-family:'DM Sans',sans-serif">${counts[c] != null ? counts[c] : 0} expenses</span>
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
  if (!clients.length) { el.innerHTML='<div style="font-size:13px;color:var(--text-soft)">No clients yet</div>'; return; }
  el.innerHTML = clients.map((c,i) => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--warm)">
      <div>
        <div style="font-weight:600;font-size:14px">${c.name}</div>
        ${c.contact?`<div style="font-size:12px;color:var(--text-soft)">${c.contact}</div>`:''}
        ${c.email?`<div style="font-size:12px;color:var(--text-soft)">${c.email}</div>`:''}
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
  const cats = getExpenseCats();
  const sel = document.getElementById('exp-category');
  if (sel) sel.innerHTML = cats.map(c => `<option value="${c}">${c}</option>`).join('');
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
    <div onmousedown="selectMerchantSuggest(${i})" style="padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--warm);display:flex;justify-content:space-between;align-items:center"
      onmouseover="this.style.background='var(--mist)'" onmouseout="this.style.background='white'">
      <div>
        <div style="font-weight:600;font-size:13px">${m.merchant}</div>
        ${m.description ? `<div style="font-size:11px;color:var(--text-soft)">${m.description}</div>` : ''}
      </div>
      <div style="font-size:11px;color:var(--text-soft);text-align:right;flex-shrink:0;margin-left:8px">
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
  // Always fill category — find exact match first, then closest
  const catEl = document.getElementById('exp-category');
  if (catEl && m.category) {
    const opts = [...catEl.options];
    // Try exact match
    const exact = opts.find(o => o.value === m.category);
    if (exact) {
      catEl.value = m.category;
    } else {
      // Try partial match (e.g. old "Cleaning/Repairs" → "Cleaning")
      const partial = opts.find(o =>
        o.value.toLowerCase().includes(m.category.toLowerCase().split(/[/& ]/)[0]) ||
        m.category.toLowerCase().includes(o.value.toLowerCase().split(/[/& ]/)[0])
      );
      if (partial) catEl.value = partial.value;
    }
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

function expenseHasReceiptAttached(e) {
  // Only "attached" if there's an actual file, not just a receipt_type label
  if (e.driveLink && String(e.driveLink).trim()) return true;
  if (e.photo && String(e.photo).trim()) return true;
  return false;
}

/** Show a once-daily banner nudge for expenses older than 7 days without receipts (Phase 1B). */
function checkReceiptNudge() {
  try {
    const todayStr = new Date().toISOString().split('T')[0];
    if (localStorage.getItem('receipt-nudge-last') === todayStr) return;
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
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
        'display:block;width:100%;text-align:left;padding:8px 4px;border:none;border-bottom:0.5px solid rgba(0,0,0,0.08);background:none;font-size:13px;cursor:pointer;font-family:\'DM Sans\',sans-serif;color:#1a1a1a';
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
          `<button type="button" class="exp-dd-rec" data-rec="${val}" style="display:block;width:100%;text-align:left;padding:8px 4px;border:none;border-bottom:0.5px solid rgba(0,0,0,0.08);background:none;font-size:13px;cursor:pointer;font-family:'DM Sans',sans-serif;color:#1a1a1a">${lab}</button>`
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
      el.style.background = '#1E3A2F';
      el.style.color = '#fff';
      el.style.borderColor = '#1E3A2F';
    } else {
      el.style.background = '#fff';
      el.style.color = 'var(--text-soft)';
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
  if (expDateEl && !expDateEl.value) expDateEl.value = new Date().toISOString().split('T')[0];

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
      '<div style="text-align:center;padding:28px 16px;font-family:\'DM Sans\',sans-serif"><div style="font-weight:500;font-size:14px;margin-bottom:4px;color:#1a1a1a">No expenses yet</div><div style="font-size:12px;color:var(--text-soft)">Add your first expense above</div></div>';
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
      '<div style="padding:16px 0;color:var(--text-soft);font-size:13px;text-align:center;font-family:\'DM Sans\',sans-serif">No results match your filters</div>';
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
      + '<div style="font-weight:500;font-size:14px;color:#1a1a1a;font-family:\'DM Sans\',sans-serif">' + _missingReceiptCount + ' expense' + (_missingReceiptCount === 1 ? '' : 's') + ' missing receipts</div>'
      + '<div style="font-size:12px;color:var(--text-soft);font-family:\'DM Sans\',sans-serif">Tap to view</div>'
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
      ? `<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#185FA5;font-family:'DM Sans',sans-serif">${svgClip}Receipt</span>`
      : `<span style="font-size:11px;color:#A32D2D;font-family:'DM Sans',sans-serif">No receipt</span>`;
    const bankBlock = isBankVerified
      ? `<span style="display:inline-flex;align-items:center;gap:3px;font-size:11px;color:#1D9E75;font-family:'DM Sans',sans-serif">${svgBank} Bank verified</span>`
      : '';
    return `<div class="expense-item" data-expense-id="${e.id}" onclick="openExpenseView('${e.id}')"
      style="background:#fff;border-radius:10px;padding:12px 14px;display:flex;gap:12px;align-items:flex-start;cursor:pointer;border:0.5px solid rgba(0,0,0,0.06);
      box-shadow:0 1px 2px rgba(0,0,0,0.02);border-left:3px solid ${catCol};border-top-left-radius:0;border-bottom-left-radius:0;
      -webkit-tap-highlight-color:transparent;-webkit-user-select:none;user-select:none;font-family:'DM Sans',sans-serif">
      <div style="flex:1;min-width:0">
        <div style="font-weight:500;font-size:14px;color:#1a1a1a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(e.merchant || 'Unknown')}</div>
        <div style="font-size:12px;color:var(--text-soft);margin-top:2px">${line2}</div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:4px;flex-wrap:wrap">
          <span style="font-size:11px;font-weight:600;color:${catCol}">${escHtml(e.category || '')}</span>
          ${recBlock}
          ${bankBlock}
        </div>
      </div>
      <div style="font-size:15px;font-weight:500;color:${amtColor};flex-shrink:0;font-family:'DM Sans',sans-serif">${prefix}$${Math.abs(Number(e.amount)).toFixed(2)}</div>
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
        <td style="max-width:200px"><strong>${escHtml(e.merchant || 'Unknown')}</strong>${descShort ? '<div style="font-size:11px;color:var(--text-soft);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(descShort) + '</div>' : ''}</td>
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

    listEl.innerHTML = _missingReceiptCard + '<div style="display:grid;grid-template-columns:1fr minmax(260px,300px);gap:20px">' +
      '<div class="card" style="padding:0;overflow:hidden;overflow-x:auto"><table class="desktop-table"><thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Receipt</th><th style="text-align:right">Amount</th></tr></thead><tbody>' + tblRows + '</tbody></table></div>' +
      '<div style="display:flex;flex-direction:column;gap:16px">' +
        '<div class="card"><div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-soft);margin-bottom:12px">This Month</div>' +
          '<div style="font-family:\'DM Serif Display\',serif;font-size:28px;color:var(--forest)">$' + Math.abs(monthSum).toFixed(0) + '</div>' +
          '<div style="font-size:12px;color:var(--text-soft);margin-top:4px">' + monthCnt + ' expenses</div></div>' +
        '<div class="card"><div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-soft);margin-bottom:12px">By Category</div>' + catBreakdown + '</div>' +
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
  const amount = opts.amount || parseFloat(document.getElementById('exp-amount').value);
  const date = opts.date || document.getElementById('exp-date').value || new Date().toISOString().split('T')[0];
  const category = opts.category || document.getElementById('exp-category').value;
  if (!merchant || !amount) { globalThis.showBanner('⚠ Please fill in merchant and amount', 'warn'); return; }
  if (isExpensePhotoConverting()) { globalThis.showBanner('⟳ Please wait — receipt is still converting...', 'warn'); return; }
  const { base64: photoForUpload, mediaType: mediaTypeForUpload } = getExpensePhotoUploadSnapshot();
  const exp = {
    id: Date.now(),
    merchant,
    description: opts.description || document.getElementById('exp-description').value.trim(),
    amount,
    date,
    category,
    receiptType: opts.receiptType || document.getElementById('exp-receipt-type').value,
    receiptNum: opts.receiptNum || document.getElementById('exp-receipt-num').value.trim(),
    photo: null,  // never store in localStorage — too large, causes silent crash
    awaitingReceipt: photoForUpload ? false : (opts.awaitingReceipt || false),
    driveLink: null
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

  // Try to upload photo to Drive and push to sheet
  const expWithPhoto = Object.assign({}, exp, { photo: photoForUpload, _mediaType: mediaTypeForUpload });
  saveExpenseToDriveAndSheet(expWithPhoto);

  if (!opts.silent) {
    // Clear all form fields
    ['exp-merchant','exp-description','exp-amount','exp-receipt-num'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    document.getElementById('exp-date').value = new Date().toISOString().split('T')[0];
    // Reset dropdowns to first option
    const catSel = document.getElementById('exp-category');
    if (catSel) catSel.selectedIndex = 0;
    const typeSel = document.getElementById('exp-receipt-type');
    if (typeSel) typeSel.selectedIndex = 0;
    clearExpensePhoto();
    // Close the add form and scroll receipts into view
    closeExpenseAddForm();
    renderExpenses();
    document.getElementById('expenses-main-block')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!exp.photo) globalThis.showBanner('✓ Expense saved', 'ok');
    // receipt handled separately via Supabase Storage
    else globalThis.showBanner('⟳ Uploading receipt...', 'info');
  }
  return exp;
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
        const url = await uploadReceiptToStorage(file, exp.id);
        if (url) {
          driveLink = url;
          const saved = expenses.find(e => String(e.id) === String(exp.id));
          if (saved) {
            saved.driveLink = driveLink;
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
  const d = exp.date ? exp.date.replace(/-/g,'').substring(2) : '';
  const merchant = (exp.merchant||'Receipt').replace(/[^a-zA-Z0-9]/g,'_').substring(0,30);
  const uid = String(exp.id || Date.now()).slice(-6);
  return merchant + '_' + d + '_' + uid + '.pdf';
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
  document.getElementById('ee-photo-preview').style.display = 'none';
  document.getElementById('ee-file-input').value = '';
  const e = expenses.find(x => String(x.id) === String(editingExpenseId) || String(x._cloudId) === String(editingExpenseId));
  document.getElementById('ee-receipt-label').textContent = e && e.driveLink ? 'Upload a replacement receipt' : 'Upload receipt photo';
}
function openExpenseView(id) {
  const e = expenses.find(x => String(x.id) === String(id) || String(x._cloudId) === String(id));
  if (!e) return;
  const isRefund   = Number(e.amount) < 0;
  const amtColor   = isRefund ? '#27AE60' : '#C0392B';
  const amtDisplay = (isRefund ? '−' : '') + '$' + Math.abs(Number(e.amount)).toFixed(2);

  // ── Receipt action block ────────────────────────────────────────────────────
  let receiptBlock;
  if (e.driveLink) {
    // Use onclick to fetch a signed URL on demand (bucket is private)
    receiptBlock = `
      <button onclick="openReceiptViewer('${escapeJsSingleQuotedHtmlAttr(String(e.driveLink))}', this)"
         style="display:flex;align-items:center;justify-content:center;gap:8px;
                width:100%;padding:11px;box-sizing:border-box;
                background:var(--mist);border:1.5px solid var(--moss);border-radius:10px;
                color:var(--moss);font-weight:600;font-size:13px;cursor:pointer;
                font-family:'DM Sans',sans-serif">
        📎 View Receipt
      </button>`;
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
          <div style="font-family:inherit;font-size:16px;font-weight:500;color:#1a1a1a;line-height:1.15;
                      word-break:break-word">${escHtml(e.merchant||'Unknown')}</div>
          ${e.description ? `<div style="font-size:13px;font-weight:400;color:#999;margin-top:4px">${escHtml(e.description)}</div>` : ''}
        </div>
        <div style="flex-shrink:0;text-align:right">
          <div style="font-family:'DM Serif Display',serif;font-size:26px;font-weight:700;
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

function openExpenseEdit(id) {
  const e = expenses.find(x => String(x.id) === String(id) || String(x._cloudId) === String(id));
  if (!e) return;
  editingExpenseId = id;
  editingExpensePhotoBase64 = null;
  document.getElementById('ee-merchant').value = e.merchant || '';
  document.getElementById('ee-description').value = e.description || '';
  document.getElementById('ee-amount').value = e.amount || '';
  document.getElementById('ee-date').value = e.date || '';
  document.getElementById('ee-receipt-num').value = e.receiptNum || '';
  const cats = getExpenseCats();
  const sel = document.getElementById('ee-category');
  sel.innerHTML = cats.map(c => `<option value="${c}" ${c===e.category?'selected':''}>${c}</option>`).join('');
  document.getElementById('ee-receipt-type').value = String(e.receiptType || 'missing').toLowerCase().trim();
  // Show existing drive link if present
  const currentReceiptEl = document.getElementById('ee-current-receipt');
  const receiptLinkEl = document.getElementById('ee-receipt-link');
  if (e.driveLink) {
    // Use onclick to fetch signed URL on demand (bucket is private)
    receiptLinkEl.href = '#';
    receiptLinkEl.onclick = (ev) => { ev.preventDefault(); window.openReceiptViewer(e.driveLink); };
    currentReceiptEl.style.display = 'block';
    document.getElementById('ee-receipt-label').textContent = 'Upload a replacement receipt';
  } else {
    currentReceiptEl.style.display = 'none';
    document.getElementById('ee-receipt-label').textContent = 'Upload receipt photo';
  }
  document.getElementById('ee-photo-preview').style.display = 'none';
  document.getElementById('ee-upload-status').style.display = 'none';
  document.getElementById('ee-file-input').value = '';
  document.getElementById('expense-edit-modal').classList.add('open'); document.body.style.overflow='hidden';
}
function closeExpenseEdit() {
  document.getElementById('expense-edit-modal').classList.remove('open'); globalThis._checkModalsClosed();
  editingExpenseId = null;
  editingExpensePhotoBase64 = null;
}
async function saveExpenseEdit() {
  const e = expenses.find(x => String(x.id) === String(editingExpenseId) || String(x._cloudId) === String(editingExpenseId));
  if (!e) return;
  e.merchant = document.getElementById('ee-merchant').value.trim();
  e.description = document.getElementById('ee-description').value.trim();
  e.amount = parseFloat(document.getElementById('ee-amount').value) || 0;
  e.date = document.getElementById('ee-date').value;
  e.category = document.getElementById('ee-category').value;
  e.receiptType = document.getElementById('ee-receipt-type').value;
  e.receiptNum = document.getElementById('ee-receipt-num').value.trim();

  // Upload new receipt photo if one was selected
  if (editingExpensePhotoBase64) {
    const statusEl = document.getElementById('ee-upload-status');
    statusEl.style.display = 'block';
    statusEl.style.color = 'var(--text-soft)';
    statusEl.textContent = '⟳ Uploading receipt...';
    try {
      const fakeExp = Object.assign({}, e, { photo: editingExpensePhotoBase64, _mediaType: editingExpenseMediaType });
      const imgBlob = await receiptImageToPDF(fakeExp);
      const fileName = generateReceiptFileName(e);
      const file = new File([imgBlob], fileName, { type: 'application/pdf' });
      if (typeof uploadReceiptToStorage === 'function') {
        const url = await uploadReceiptToStorage(file, e.id);
        if (url) {
          e.driveLink = url;
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
  }

  globalThis.savePropertyData();
  if (typeof saveExpenseToCloud === 'function') saveExpenseToCloud(e).catch(err => console.warn('[StayOps] saveExpenseToCloud failed:', err));
  closeExpenseEdit();
  renderExpenses();
  globalThis.showBanner('✓ Expense updated', 'ok');
}
// ── PROPERTY DATA ─────────────────────────────────────────────────────────


const DEFAULT_EXPENSE_CATS = [
  'Cleaning & Garden','Maintenance & Repairs','Supplies & Consumables',
  'Utilities & Rates','Insurance','Furnishings & Equipment',
  'Mortgage','Council Rates','Strata',
  'Advertising','Linen','Gardening','Pest Control',
  'Renovation','Professional Services','Other'
];
function getExpenseCats() {
  const cats = window._appConfig && window._appConfig.expense_cats;
  if (Array.isArray(cats) && cats.length > 0 && cats.every(c => typeof c === 'string' && c.trim())) {
    return cats;
  }
  return DEFAULT_EXPENSE_CATS;
}
globalThis.getExpenseCats = getExpenseCats;
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
  if (deductLabel)   deductLabel.style.borderColor   = mode === 'deduct'   ? 'var(--forest)' : 'var(--stone)';
  if (separateLabel) separateLabel.style.borderColor  = mode === 'separate' ? 'var(--forest)' : 'var(--stone)';
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
      <div style="display:flex;gap:0;border-radius:6px;overflow:hidden;border:1px solid var(--stone)">
        <button onclick="toggleExpenseCatMode('${cat}','deduct')" id="ecat-${cat}-deduct" style="padding:5px 10px;font-size:11px;font-weight:600;border:none;cursor:pointer;font-family:'DM Sans',sans-serif;transition:background 0.15s;background:${!isOwner ? 'var(--forest)' : 'white'};color:${!isOwner ? 'white' : 'var(--text-soft)'}">Deduct</button>
        <button onclick="toggleExpenseCatMode('${cat}','owner')" id="ecat-${cat}-owner" style="padding:5px 10px;font-size:11px;font-weight:600;border:none;border-left:1px solid var(--stone);cursor:pointer;font-family:'DM Sans',sans-serif;transition:background 0.15s;background:${isOwner ? '#E24B4A' : 'white'};color:${isOwner ? 'white' : 'var(--text-soft)'}">Owner pays</button>
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
  if (track) track.style.background = on ? 'var(--forest, #1E3A2F)' : 'var(--border, #C7C7CC)';
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

  // Preserve lastReportSentAt — don't overwrite it here
  const existing = getActivePropertyConfig().owner || {};

  savePropertyConfig({
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
  if (status) { status.style.color = 'var(--text-soft)'; status.textContent = 'Building PDF…'; }

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

      if (status) { status.style.color = 'var(--forest)'; status.textContent = '✓ Report sent to ' + ownerEmail; }
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
    const bs = propertyBookings.filter(b => b.status !== 'cancelled' && (function(){ const d=new Date(b.checkin); return d.getFullYear()===yr&&d.getMonth()===mo; })());
    const avail = new Date(yr,mo+1,0).getDate();
    const booked = bs.reduce((s,b)=>s+Number(b.nights||0),0);
    const rev = bs.reduce((s,b)=>s+Number(b.hostPayout||0),0);
    const net = bs.reduce((s,b)=>s+Number(b.netPayout||0),0);
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
        ...platforms.map(p => { const r=m.bs.filter(b=>b.platform===p).reduce((s,b)=>s+Number(b.hostPayout||0),0); return r?fmt2(r):'—'; }),
        m.rev ? fmt2(m.rev) : '—'
      ]),
      ['Total', ...platforms.map(p=>fmt2(allM.reduce((s,m)=>s+m.bs.filter(b=>b.platform===p).reduce((ss,b)=>ss+Number(b.hostPayout||0),0),0))), fmt2(fyRev)]
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

  // Revenue table
  rows.push(['Revenue by Month & Platform']);
  rows.push(['Month','Airbnb','VRBO','Direct','Total']);
  months.forEach(({year,month}) => {
    const bs = propertyBookings.filter(b => { const d=new Date(b.checkin); return d.getFullYear()===year&&d.getMonth()===month; });
    const rev = p => bs.filter(b=>b.platform===p).reduce((s,b)=>s+Number(b.hostPayout||0),0);
    const total = bs.reduce((s,b)=>s+Number(b.hostPayout||0),0);
    rows.push([mo[month], rev('Airbnb')||'', rev('VRBO')||'', rev('Direct')||'', total||'']);
  });
  rows.push([]);

  // Occupancy table
  rows.push(['Occupancy & Performance']);
  rows.push(['Month','Available Nights','Booked Nights','Occupancy%','ADR','RevPAR']);
  months.forEach(({year,month}) => {
    const bs = propertyBookings.filter(b => { const d=new Date(b.checkin); return d.getFullYear()===year&&d.getMonth()===month; });
    const avail = new Date(year,month+1,0).getDate();
    const booked = bs.reduce((s,b)=>s+Number(b.nights||0),0);
    const rev = bs.reduce((s,b)=>s+Number(b.hostPayout||0),0);
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
      if (b.status === 'cancelled') return;
      const d = new Date(b.checkin);
      if (d.getFullYear() !== year || d.getMonth() !== month) return;
      const pid = _bookingPropertyId(b) || 'unknown';
      const amt = Number(b.mgmtPayout || 0);
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
    html += '<div style="font-weight:500;font-size:14px;margin-bottom:12px;color:#1a1a1a">Deductions by ATO Category</div>';
    if (groups.length === 0) {
      html += '<div style="font-size:13px;color:var(--text-soft)">No expenses recorded for this financial year.</div>';
    } else {
      groups.forEach(g => {
        const missingBadge = g.missingReceipt > 0
          ? ` <span style="display:inline-block;background:#D44;color:#fff;font-size:10px;font-weight:600;border-radius:8px;padding:1px 6px;margin-left:4px;vertical-align:middle">${g.missingReceipt} no receipt</span>`
          : '';
        html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:0.5px solid rgba(0,0,0,0.06)">
          <div>
            <div style="font-size:13px;font-weight:500;color:#1a1a1a">${escHtml(g.label)}${missingBadge}</div>
            <div style="font-size:11px;color:var(--text-soft)">${g.expenses.length} item${g.expenses.length !== 1 ? 's' : ''}</div>
          </div>
          <div style="font-size:14px;font-weight:500;color:#1D9E75">$${g.total.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</div>
        </div>`;
      });
      if (depTotal > 0) {
        html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:0.5px solid rgba(0,0,0,0.06)">
          <div>
            <div style="font-size:13px;font-weight:500;color:#1a1a1a">Depreciation (Assets)</div>
            <div style="font-size:11px;color:var(--text-soft)">From asset register</div>
          </div>
          <div style="font-size:14px;font-weight:500;color:#1D9E75">$${depTotal.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</div>
        </div>`;
      }
      const grandTotal = totalAmt + depTotal;
      html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0 0">
        <div style="font-size:13px;font-weight:600;color:#1a1a1a">Total Deductions</div>
        <div style="font-size:15px;font-weight:600;color:#1E3A2F">$${grandTotal.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</div>
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
    hostEl.style.fontFamily = "'DM Sans',sans-serif";
    const previewContainer = document.getElementById('tax-export-preview');
    if (previewContainer) previewContainer.parentNode.insertBefore(hostEl, previewContainer.nextSibling);
  }
  if (hostEl) {
    const fmtAU = n => '$' + Number(n).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    let hHtml = '<div class="card" style="padding:16px;margin-top:12px">';
    hHtml += '<div style="font-weight:500;font-size:14px;margin-bottom:4px;color:#1a1a1a">\uD83D\uDCCA Host Management Income (Your Tax)</div>';
    hHtml += `<div style="font-size:11px;color:var(--text-soft);margin-bottom:12px">${fyLabel(fy)} \u00B7 All properties</div>`;
    if (hostIncome.byProperty.length === 0) {
      hHtml += '<div style="font-size:13px;color:var(--text-soft)">No management fee income recorded for this financial year.</div>';
    } else {
      hostIncome.byProperty.forEach(p => {
        hHtml += `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:0.5px solid rgba(0,0,0,0.06)">
          <div style="font-size:13px;font-weight:500;color:#1a1a1a">${escHtml(p.propertyName)}</div>
          <div style="font-size:14px;font-weight:500;color:#1D9E75">${fmtAU(p.total)}</div>
        </div>`;
      });
      hHtml += `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0 0">
        <div style="font-size:13px;font-weight:600;color:#1a1a1a">Total Management Income</div>
        <div style="font-size:15px;font-weight:600;color:#1E3A2F">${fmtAU(hostIncome.grandTotal)}</div>
      </div>`;
    }
    hHtml += '<div style="font-size:11px;color:var(--text-soft);margin-top:10px;font-style:italic">This is your management fee income for your own tax return.</div>';
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
    const bs = propertyBookings.filter(b => b.status !== 'cancelled' && (() => { const d = new Date(b.checkin); return d.getFullYear() === year && d.getMonth() === month; })());
    bs.forEach(b => {
      const amt = Number(b.hostPayout || 0);
      fyTotalRev += amt;
      const p = b.platform || 'Direct';
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

  // Header row
  rows.push([getCurrentPropertyName() + ' \u2014 Tax Export \u2014 ' + fyLabel(fy)]);
  rows.push([]);
  rows.push(['Date', 'Merchant', 'Description', 'Category', 'ATO Tax Field', 'Amount', 'Receipt Status', 'Reconciled']);

  // Sort by date ascending
  const sorted = allExp.slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  sorted.forEach(e => {
    const atoField = getAtoFieldLabel(e.category);
    const receiptStatus = expenseHasReceiptAttached(e) ? 'Yes' : 'No';
    const reconciled = e.reconciled ? 'Yes' : 'No';
    rows.push([
      e.date || '',
      e.merchant || '',
      e.description || '',
      e.category || '',
      atoField,
      Number(e.amount || 0).toFixed(2),
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
  listEl.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-soft);font-size:13px;font-family:\'DM Sans\',sans-serif">Loading transactions...</div>';

  const user = await getCurrentSupabaseUser();
  if (!user) {
    listEl.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-soft);font-size:13px">Sign in to view transactions.</div>';
    summaryBar.innerHTML = '';
    filtersEl.innerHTML = '';
    return;
  }

  _reconTxns = await getAllTransactionsWithStatus(user.id);
  _reconFilter = 'all';

  if (_reconTxns.length === 0) {
    summaryBar.innerHTML = '';
    filtersEl.innerHTML = '';
    listEl.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-soft);font-size:13px;font-family:\'DM Sans\',sans-serif">No bank transactions imported yet. Use <b>Import bank CSV</b> in the Expenses view to get started.</div>';
    return;
  }

  // Compute totals per status
  const totals = { matched: 0, unaccounted: 0, personal: 0, skipped: 0 };
  for (const t of _reconTxns) {
    totals[t.status] = (totals[t.status] || 0) + Math.abs(t.amount);
  }

  // Render summary bar
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

  // Render filter pills
  renderReconciliationFilters(filtersEl);

  // Render list
  renderReconciliationList(listEl);
}

function renderReconciliationFilters(container) {
  const pills = [
    { key: 'all', label: 'All' },
    { key: 'matched', label: 'Matched' },
    { key: 'unaccounted', label: 'Unaccounted' },
    { key: 'personal', label: 'Personal' },
    { key: 'skipped', label: 'Skipped' },
  ];

  container.innerHTML = `<div style="display:flex;gap:6px;flex-wrap:wrap">${pills.map(p => {
    const isActive = _reconFilter === p.key;
    const bg    = isActive ? '#1E3A2F' : '#F5F3EF';
    const color = isActive ? '#fff'    : '#555';
    const bdr   = isActive ? '#1E3A2F' : '#E0DCD5';
    return `<button onclick="filterReconciliation('${p.key}')" style="background:${bg};border:1px solid ${bdr};border-radius:20px;padding:6px 14px;font-size:12px;font-family:'DM Sans',sans-serif;cursor:pointer;color:${color}">${p.label}</button>`;
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
    container.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-soft);font-size:13px;font-family:\'DM Sans\',sans-serif">No transactions in this category.</div>';
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
    } else if (t.status === 'personal') {
      badge = `<span style="display:inline-block;font-size:11px;background:#ECEFF1;color:#546E7A;border-radius:4px;padding:2px 8px">Personal</span>`;
      rightInfo = badge;
    } else if (t.status === 'skipped') {
      badge = `<span style="display:inline-block;font-size:11px;background:#ECEFF1;color:#546E7A;border-radius:4px;padding:2px 8px">Skipped</span>`;
      rightInfo = badge;
    } else {
      badge = `<span style="display:inline-block;font-size:11px;background:#FFF3E0;color:#E65100;border-radius:4px;padding:2px 8px;margin-bottom:4px">Unaccounted</span>`;
      const safeDesc = escapeJsSingleQuotedHtmlAttr(t.description || '');
      const rawAmt = Math.abs(t.amount).toFixed(2);
      const rawDate = t.date || '';
      rightInfo = `<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">${badge}
        <button onclick="reconMatchExpense('${t.id}','${escapeJsSingleQuotedHtmlAttr(rawDate)}','${rawAmt}')" style="font-size:11px;color:#1D9E75;background:none;border:1px solid #1D9E75;border-radius:6px;padding:3px 10px;cursor:pointer;font-family:'DM Sans',sans-serif;white-space:nowrap">Match Expense</button>
        <button onclick="reconCreateExpense('${t.id}','${escapeJsSingleQuotedHtmlAttr(rawDate)}','${rawAmt}','${safeDesc}')" style="font-size:11px;color:#185FA5;background:none;border:1px solid #185FA5;border-radius:6px;padding:3px 10px;cursor:pointer;font-family:'DM Sans',sans-serif;white-space:nowrap">Create New</button></div>`;
    }

    return `<div style="background:#fff;border-radius:10px;padding:12px 14px;margin-bottom:8px;border:0.5px solid rgba(0,0,0,0.06);display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
      <div style="flex:1;min-width:0">
        <div style="font-size:11px;color:var(--text-soft);margin-bottom:2px">${dateStr}</div>
        <div style="font-size:14px;font-weight:500;color:#1a1a1a;font-family:'DM Sans',sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${desc}</div>
        <div style="font-size:15px;font-weight:600;color:#1a1a1a;margin-top:2px">$${amt}</div>
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

  // Find unreconciled expenses within ±7 days and ±50% amount
  const nearby = (Array.isArray(expenses) ? expenses : []).filter(e => {
    if (e.reconciled || e.bank_transaction_id) return false;
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
    // Sort by: exact amount first, then by date proximity
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

  const list = nearby.map(e => {
    const eAmt = Math.abs(Number(e.amount || 0));
    const exactAmt = Math.abs(eAmt - amt) < 0.02;
    const amtBadge = exactAmt ? '<span style="color:#1D9E75;font-weight:600;font-size:10px;margin-left:4px">exact match</span>' : '';
    const eid = escapeJsSingleQuotedHtmlAttr(String(e._cloudId || e.id));
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:0.5px solid rgba(0,0,0,0.06);cursor:pointer" onclick="reconLinkToExpense('${escapeJsSingleQuotedHtmlAttr(txnId)}','${eid}')">
      <div style="min-width:0;flex:1">
        <div style="font-size:13px;font-weight:500;color:var(--text)">${escHtml(e.merchant || e.description || 'Expense')}${amtBadge}</div>
        <div style="font-size:11px;color:var(--text-soft);margin-top:2px">${fmt(e.date)} · $${_fmtAud(eAmt)} · ${escHtml(e.category || '')}</div>
      </div>
      <div style="flex-shrink:0;margin-left:8px;color:var(--moss);font-size:12px;font-weight:600">Link →</div>
    </div>`;
  }).join('');

  let overlay = document.getElementById('recon-match-overlay');
  if (!overlay) { overlay = document.createElement('div'); overlay.id = 'recon-match-overlay'; document.body.appendChild(overlay); }
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;background:rgba(0,0,0,0.4);display:flex;align-items:flex-end;justify-content:center';
  overlay.innerHTML = `
    <div style="background:white;border-radius:16px 16px 0 0;width:100%;max-width:500px;max-height:70vh;overflow-y:auto;padding:20px 16px 24px;animation:settingsPanelIn 0.28s cubic-bezier(0.32,0.72,0,1)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <div>
          <div style="font-size:15px;font-weight:700;color:var(--forest)">Match to Expense</div>
          <div style="font-size:12px;color:var(--text-soft);margin-top:2px">Transaction: $${_fmtAud(amt)} on ${fmt(date)}</div>
        </div>
        <button onclick="document.getElementById('recon-match-overlay').style.display='none';document.body.style.overflow=''" style="width:28px;height:28px;border-radius:50%;border:none;background:var(--mist);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--text-soft)">×</button>
      </div>
      <div style="font-size:12px;color:var(--text-soft);margin-bottom:10px">${nearby.length} similar expense${nearby.length !== 1 ? 's' : ''} found — tap to link</div>
      ${list}
      <button onclick="document.getElementById('recon-match-overlay').style.display='none';document.body.style.overflow=''" style="width:100%;margin-top:14px;padding:12px;border-radius:10px;border:none;background:var(--mist);color:var(--text-soft);font-size:13px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">Cancel</button>
    </div>`;
  document.body.style.overflow = 'hidden';
}
globalThis.reconMatchExpense = reconMatchExpense;

/** Link a bank transaction to an existing expense */
async function reconLinkToExpense(txnId, expenseId) {
  const sb = window._sb;
  if (!sb) return;
  try {
    await sb.from('bank_transactions').update({ expense_id: expenseId }).eq('id', txnId);
    await sb.from('expenses').update({ reconciled: true, bank_transaction_id: txnId, payment_status: 'paid' }).eq('id', expenseId);
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
    if (dateEl)   dateEl.value   = date;
    if (amountEl) amountEl.value = amount;
    if (descEl)   descEl.value   = description;
  }, 100);
}

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

// Open a receipt by fetching a signed URL on demand (bucket is private).
window.openReceiptViewer = async function (driveLinkValue, btnEl) {
  if (!driveLinkValue) return;
  const originalText = btnEl ? btnEl.innerHTML : null;
  if (btnEl) { btnEl.innerHTML = 'Loading…'; btnEl.disabled = true; }
  try {
    const url = await getReceiptViewUrl(driveLinkValue);
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
