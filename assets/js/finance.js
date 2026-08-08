/**
 * StayOps — finance, expenses, reports, invoices (Pass 7).
 */
import {
  getCurrentPropertyName,
  getActivePropertyId,
  getActivePropertyConfig,
  savePropertyConfig,
  getAllProperties,
} from './config.js';
import { getAllTransactionsWithStatus, findPayoutMatchesForBankTransaction, linkTransactionToPayout, unlinkPayoutFromTransaction, setTransactionClassification, findMatchesForExpense, linkTransactionToExpense } from './reconciliation.js';
import { bookings, cleans, expenses, replaceArrayInPlace } from './state.js';
import {
  escHtml, fmt, fmt2, fyLabel, fyMonths, escapeJsSingleQuotedHtmlAttr, fadeTransition, localDateStr,
  normalizeExpenseAllocations, expenseAllocations, unallocatedExpenseAmount, evenSplitAmounts,
} from './utils.js';
import { renderPortfolioFinance, isPortfolioMode } from './property.js';
import {
  clearExpensePhoto,
  clearExpensePhoto2,
  getExpensePhotoUploadSnapshot,
  getExpensePhoto2UploadSnapshot,
  isExpensePhotoConverting,
} from './ai.js';
import { uploadReceiptToStorage, getReceiptViewUrl, saveExpenseToCloud, deleteExpenseFromCloud, getCurrentSupabaseUser, loadPlatformPayouts } from './supabase.js';
import { renderMoneyInList, moneyInFiltersHtml } from './finance-money-in.js';
import { planPayoutAutoMatch } from './money-in-model.js';
import {
  bookingRevenue,
  bookingCleaningFee,
  bookingMgmtFee,
  bookingMgmtPayout,
  bookingNetPayout,
  isRevenueBearingBooking,
} from './booking-revenue.js';
import { _financeActiveCloudPropertyId } from './finance-shared.js';
// Slice modules split out of this file (2026-07-08). Each installs its own
// window.* bridges; finance.js stays the barrel main.js loads. Named imports
// (bank-import) are functions/state this barrel still calls directly.
import './finance-payout-paste.js';
import {
  ensureBankImportToolbar,
  ensureBankImportToolbarPortfolio,
  refreshFinanceReconciliationSummary,
  _bankImportReviewActive,
  bankImportFormatCategoryLabel,
  BANK_IMPORT_EXPENSE_CATS,
} from './finance-bank-import.js';
import './finance-invoices.js';
import {
  buildInvoicePDF,
  renderInvoiceHistory,
  _getBookingInvoiceMap,
  _getInvoiceIdentity,
} from './finance-invoices.js';
import './finance-tax-export.js';
// Period reconcile (out-of-balance close). Side-effect import: registers its own
// globalThis bridges for the inline-onclick API, same as the other slices.
import './finance-reconcile.js';
import {
  showTaxExportView,
  exportTaxPDF,
  exportTaxCSV,
  taxExportFYPrev,
  taxExportFYNext,
} from './finance-tax-export.js';

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
    // they don't linger into the next expense. Same reasoning for a half-built
    // stay split, which lives in module state and not in the collapsed markup.
    clearExpensePhoto();
    clearExpensePhoto2();
    _resetExpenseAllocUI('exp');
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
  // Drop any half-built split too: addExpense reads the draft state rather than
  // the DOM, so an abandoned split would leak into the NEXT expense and save
  // silently even though the collapsed form shows no sign of it.
  _resetExpenseAllocUI('exp');
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
  else if (sub === 'reconcile') financeSubView = 'reconcile';
  _financeTab = sub;
  _syncFinanceNav(sub);
  const hub = document.getElementById('finance-hub');
  if (hub) hub.style.display = 'none';
  ['finance-expenses-view', 'finance-reports-view', 'finance-reconciliation-view', 'finance-recurring-view', 'finance-depreciation-view', 'finance-tax-export-view', 'finance-statement-view', 'finance-reconcile-view'].forEach(id => {
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
  } else if (sub === 'reconcile') {
    const rEl = document.getElementById('finance-reconcile-view');
    if (rEl) fadeTransition(rEl, true);
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
  // The DISPLAYED expense figures stay GROSS (that is what the host paid, and
  // what the tax export reports). Net income must not, though: the slice of a
  // cleaning invoice that is allocated to a stay has ALREADY been taken out of
  // the owner payout via that stay's clean cost, so subtracting the gross here
  // would deduct it twice. Only the unallocated remainder is a fresh cost.
  const fyTotalExpForNet = allExp.reduce((s,e)=>s+unallocatedExpenseAmount(e),0);
  const fyExpInPayouts = Math.round((fyTotalExp - fyTotalExpForNet) * 100) / 100;
  const fyNetIncome = fyTotalNet - fyTotalExpForNet;

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
          ${fyExpInPayouts ? `<tr><td style="color:var(--muted-2)">less cleaning already deducted from payouts</td><td style="color:var(--muted-2)">+ ${fmt2(fyExpInPayouts)}</td></tr>` : ''}
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
  // Only the portion NOT tied to a stay is an operational expense here. The
  // allocated portion is already subtracted below via totalCleanCost (the clean's
  // cost is mirrored from this very expense), so counting the gross amount cut
  // the displayed payout by double the bill.
  const totalOperational = operationalExpenses.reduce((s,e) => s + Math.abs(unallocatedExpenseAmount(e)), 0);
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
    // The drawer lists GROSS amounts but the total above is the unallocated part
    // (the rest is already in "Cleaning costs"), so say so rather than leave the
    // rows silently not adding up.
    const _opGross = operationalExpenses.reduce((s,e) => s + Math.abs(Number(e.amount || 0)), 0);
    const _opInCleans = Math.round((_opGross - totalOperational) * 100) / 100;
    const opNoteHtml = _opInCleans >= 0.01
      ? `<div style="font-size:11px;color:var(--muted-2);padding:8px 0 0;line-height:1.4">$${_fmtAud(_opInCleans)} of these is allocated to stays and already counted under Cleaning costs.</div>`
      : '';
    // Model A: operational expenses deducted before payout
    summaryHtml += `
    <div class="finance-row" style="cursor:pointer;border-radius:6px;margin:0 -4px;padding:10px 4px;transition:background 0.15s" onclick="var d=document.getElementById('rev-expense-detail');var open=d.style.display!=='none';d.style.display=open?'none':'block';this.querySelector('.exp-chevron').textContent=open?'▾':'▴'" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background=''">
      <span class="finance-label" style="display:flex;align-items:center;gap:4px">Expenses (${operationalExpenses.length}) <span class="exp-chevron" style="font-size:9px;color:var(--muted-2);transition:transform 0.2s">▾</span></span>
      <span class="finance-val" style="color:#E24B4A;font-weight:500">− $${_fmtAud(totalOperational)}</span>
    </div>
    <div id="rev-expense-detail" style="display:none;padding:10px 14px;margin:2px 0 6px;background:var(--surface2);border-radius:10px">${opDetailHtml}${opNoteHtml}</div>`;
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
    const stayBlock = _expenseStayChip(e);
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
          ${stayBlock}
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
      const stayChipTxt = _expenseStayChipText(e);
      return `<tr onclick="openExpenseView('${escapeJsSingleQuotedHtmlAttr(String(e.id))}')" style="cursor:pointer">
        <td style="white-space:nowrap">${fmt(e.date)}</td>
        <td><strong style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(e.merchant || 'Unknown')}</strong>${descShort ? '<div style="font-size:11px;color:var(--muted-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(descShort) + '</div>' : ''}${stayChipTxt ? '<div style="font-size:11px;color:#185FA5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">🏠 ' + escHtml(stayChipTxt) + '</div>' : ''}</td>
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
  // Empty unless the split editor is open, so the single-stay path above is the
  // one and only source of the link in the normal case.
  const allocations = Array.isArray(opts.allocations)
    ? normalizeExpenseAllocations(opts.allocations)
    : readExpenseAllocations('exp');
  if (!merchant || !amount) { globalThis.showBanner('⚠ Please fill in merchant and amount', 'warn'); return; }
  if (allocations.length) {
    const allocErr = _validateExpenseAllocations(allocations);
    if (allocErr) { globalThis.showBanner('⚠ ' + allocErr, 'warn'); return; }
    // An unallocated remainder is legitimate (invoice = 2 stays + supplies), but
    // it is usually a typo, so confirm once. Re-enters with the same draft — the
    // form is still populated because we return before clearing it.
    const allocSum = _sumExpenseAllocList(allocations);
    if (!opts._allocConfirmed && Math.abs(allocSum - amount) > 0.01) {
      const left = Math.round((amount - allocSum) * 100) / 100;
      globalThis.showAppModal({
        title: 'Unallocated amount',
        msg: 'Allocated $' + Math.abs(allocSum).toFixed(2) + ' of $' + Math.abs(amount).toFixed(2) + ' — $'
             + Math.abs(left).toFixed(2) + (left < 0 ? ' over-allocated' : ' unallocated') + '. Save anyway?',
        confirmText: 'Save'
      }).then(ok => {
        if (ok) addExpense(Object.assign({}, opts, { allocations, _allocConfirmed: true }));
      });
      return;
    }
  }
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
    // bookingAllocations is the source of truth; bookingId stays as the MIRROR of
    // element 0 so the uuid FK column and every legacy single-link reader survive.
    bookingId: allocations.length ? allocations[0].bookingId : (bookingId || null),
    bookingAllocations: allocations,
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

  // Push this expense into every linked stay's clean.cost and trigger the mgmt
  // fee + net payout recompute. Sequential (see _recomputeAllocationTargets) and
  // fire-and-forget, so the form still closes immediately as it always has.
  const _linkedIds = allocations.length
    ? allocations.map(a => a.bookingId)
    : (exp.bookingId ? [exp.bookingId] : []);
  if (_linkedIds.length) {
    _recomputeAllocationTargets(_linkedIds, [])
      .then(_warnMissingCleanRecords)
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
    _resetExpenseAllocUI('exp');
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
  // Match on id OR _cloudId like openExpenseView / openExpenseEdit do — the list
  // rows pass e.id but reconciliation hands us a cloud id, and the old id-only
  // match quietly deleted nothing.
  const _isTarget = (e) => String(e.id) === String(id) || (e._cloudId != null && String(e._cloudId) === String(id));
  const exp = expenses.find(_isTarget);
  // Capture the stay links BEFORE the row leaves the array: the recompute
  // re-sums the LIVE allocations, so it must run against the post-delete state
  // but needs to know which stays to revisit. Without this, deleting an expense
  // left its cost sitting on the clean forever.
  const affectedIds = exp ? expenseAllocations(exp).map(a => String(a.bookingId)).filter(Boolean) : [];
  replaceArrayInPlace(expenses, expenses.filter(e => !_isTarget(e)));
  globalThis.savePropertyData();
  renderExpenses();
  globalThis.showBanner('✓ Expense deleted', 'ok');
  // Sync deletion to Supabase (non-blocking)
  if (exp && typeof deleteExpenseFromCloud === 'function') deleteExpenseFromCloud(exp).catch(e => console.warn("[StayOps] silent error:", e));
  // Unwind the mirror: each stay is re-summed and only cleared when nothing else
  // is allocated to it (other expenses may still point at the same clean).
  if (affectedIds.length) {
    await _recomputeAllocationTargets([], affectedIds);
    renderExpenses();
  }
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

  // ── Stay allocation block ───────────────────────────────────────────────────
  // The detail sheet showed no booking link at all, which made a multi-stay split
  // write-only: the host could never see where a cleaner's invoice landed.
  const viewAllocs = expenseAllocations(e);
  const viewUnalloc = unallocatedExpenseAmount(e);
  const allocBlock = viewAllocs.length ? `
    <div class="card" style="margin-bottom:14px">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:var(--muted-2);margin-bottom:8px">
        ${viewAllocs.length > 1 ? 'Split across ' + viewAllocs.length + ' stays' : 'Linked stay'}
      </div>
      ${viewAllocs.map((a, i) => {
        const b = _expenseAllocFindBooking(a.bookingId);
        const dates = b && b.checkin ? fmt(b.checkin) + ' → ' + fmt(b.checkout) : 'Stay not found';
        const last = i === viewAllocs.length - 1 && Math.abs(viewUnalloc) < 0.01;
        return `<div class="detail-row"${last ? ' style="border-bottom:none"' : ''}>
          <span class="detail-label">${escHtml(b ? (b.name || 'Guest') : 'Unknown stay')}<div style="font-size:11px;color:var(--muted-2);font-weight:400">${escHtml(dates)}</div></span>
          <span class="detail-val">${Number(a.amount) < 0 ? '−' : ''}$${Math.abs(Number(a.amount) || 0).toFixed(2)}</span>
        </div>`;
      }).join('')}
      ${Math.abs(viewUnalloc) >= 0.01 ? `<div class="detail-row" style="border-bottom:none">
        <span class="detail-label">Not allocated to a stay</span>
        <span class="detail-val">${viewUnalloc < 0 ? '−' : ''}$${Math.abs(viewUnalloc).toFixed(2)}</span>
      </div>` : ''}
    </div>` : '';

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

    <!-- ── Stay allocation ── -->
    ${allocBlock}

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
  // expenseAllocations() applies the legacy fallback, so a pre-split row seeds
  // as a single allocation and the editor stays collapsed — one stay is not a
  // split, and forcing the editor open would change the single-stay UX.
  _resetExpenseAllocUI('ee');
  const seededAllocs = seedExpenseAllocations('ee', expenseAllocations(e));
  if (seededAllocs.length > 1) expenseAllocOpenSplit('ee');
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
  // Restores the modal to "edit" shape and, on the cancel path, drops the
  // pending bank link so it can't attach itself to some later expense.
  _exitReconCreateMode();
}
async function saveExpenseEdit() {
  // The same modal doubles as the recon "Create New" form; that path builds a
  // NEW row instead of mutating an existing one, so it never reaches the
  // editingExpenseId lookup below (which would bail on a null id).
  if (_reconCreateMode) return _saveReconNewExpense();
  const e = expenses.find(x => String(x.id) === String(editingExpenseId) || String(x._cloudId) === String(editingExpenseId));
  if (!e) return;
  // Capture the OLD stay links, and validate the split, BEFORE anything is
  // mutated: the recompute at the end has to run over the union of old and new,
  // and bailing out half-way through the field writes would leave the in-memory
  // expense edited but unsaved.
  const prevIds = new Set(expenseAllocations(e).map(a => String(a.bookingId)));
  const editedAllocs = readExpenseAllocations('ee');
  if (editedAllocs.length) {
    const allocErr = _validateExpenseAllocations(editedAllocs);
    if (allocErr) { globalThis.showBanner('⚠ ' + allocErr, 'warn'); return; }
    const newTotal = _expenseAllocTotal('ee');
    const allocSum = _sumExpenseAllocList(editedAllocs);
    if (Math.abs(allocSum - newTotal) > 0.01) {
      const left = Math.round((newTotal - allocSum) * 100) / 100;
      const proceed = await globalThis.showAppModal({
        title: 'Unallocated amount',
        msg: 'Allocated $' + Math.abs(allocSum).toFixed(2) + ' of $' + Math.abs(newTotal).toFixed(2) + ' — $'
             + Math.abs(left).toFixed(2) + (left < 0 ? ' over-allocated' : ' unallocated') + '. Save anyway?',
        confirmText: 'Save'
      });
      if (!proceed) return;
    }
  }

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
  if (editedAllocs.length) {
    e.bookingAllocations = normalizeExpenseAllocations(editedAllocs);
    e.bookingId = e.bookingAllocations.length ? e.bookingAllocations[0].bookingId : null;
  } else {
    // Split mode closed ⇒ the single select is authoritative, exactly as before.
    e.bookingAllocations = [];
    e.bookingId = document.getElementById('ee-booking-link')?.value || null;
  }

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

  // Mirror the expense onto every affected booking's clean cost (and recompute
  // mgmt fee + net payout). Recompute the UNION of the old and new links, not
  // just the ones that appeared or disappeared: a stay that stayed linked but
  // whose ALLOCATED AMOUNT changed still needs its clean.cost rewritten, and the
  // old scalar "prev !== next" guard skipped exactly that case.
  const nextIds = new Set(expenseAllocations(e).map(a => String(a.bookingId)).filter(Boolean));
  const stillLinked = [...nextIds];
  const unlinked = [...prevIds].filter(id => id && !nextIds.has(id));
  _warnMissingCleanRecords(await _recomputeAllocationTargets(stillLinked, unlinked));

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
  // An expense linked months ago points at a stay that has fallen out of the
  // 120-day window, so the assignment below would silently do nothing and the
  // select would read as "— No booking —". Merely opening and saving that
  // expense would then null the link and wipe the stay's clean cost, so put the
  // linked stay back on the list before selecting it.
  if (currentValue) {
    const cur = String(currentValue);
    if (!Array.from(sel.options).some(o => o.value === cur)) {
      const opt = document.createElement('option');
      opt.value = cur;
      opt.textContent = _expenseAllocStayLabel(cur);
      sel.appendChild(opt);
    }
    sel.value = cur;
  }

  // Show / hide based on category
  const cat = (document.getElementById(prefix + '-category')?.value || '').toLowerCase();
  if (wrap) wrap.style.display = cat.includes('cleaning') ? 'block' : 'none';
}
globalThis.renderExpenseBookingPicker = renderExpenseBookingPicker;

// ── EXPENSE → STAY ALLOCATIONS (split editor) ────────────────────────────────
// A cleaner's consolidated invoice covers several stays but is ONE bank line, so
// it stays ONE expense row and the per-stay split lives in bookingAllocations.
//
// Split mode is opt-in and OFF by default: while the editor is closed
// readExpenseAllocations() returns [] and every save path reads
// #<prefix>-booking-link exactly as it did before this feature existed. That is
// what keeps linking a single stay the same number of taps as always.
//
// Draft state lives here rather than in the DOM (same idiom as `mgmtSelected`)
// because addExpense() reads state, not the inputs — which is also why every
// teardown path has to clear it.
const _expenseAllocs = { exp: [], ee: [] };

/** Normalise a caller-supplied prefix to one of the two known form prefixes. */
function _expenseAllocPrefix(prefix) {
  return prefix === 'ee' ? 'ee' : 'exp';
}

function _expenseAllocState(prefix) {
  if (!Array.isArray(_expenseAllocs[prefix])) _expenseAllocs[prefix] = [];
  return _expenseAllocs[prefix];
}

/** True only while the split editor is open — the sentinel the governing rule hangs on. */
function _expenseAllocSplitOpen(prefix) {
  const wrap = document.getElementById(prefix + '-alloc-wrap');
  return !!(wrap && wrap.dataset.splitOpen === '1');
}

/** The SIGNED expense total currently typed into the form (refund ⇒ negative). */
function _expenseAllocTotal(prefix) {
  const raw = parseFloat(document.getElementById(prefix + '-amount')?.value);
  if (!Number.isFinite(raw)) return 0;
  const isRefund = document.getElementById(prefix + '-is-refund')?.checked || false;
  return isRefund ? -Math.abs(raw) : Math.abs(raw);
}

function _expenseAllocFindBooking(bookingId) {
  if (!bookingId) return null;
  const id = String(bookingId);
  const list = Array.isArray(bookings) ? bookings : [];
  return list.find(b => String(b.id) === id || (b._cloudId && String(b._cloudId) === id)) || null;
}

function _expenseAllocBookingLabel(b) {
  return `${b.name || 'Guest'} · ${b.checkin || '?'} → ${b.checkout || '?'}`;
}

/** Human label for an allocation's booking id, for selects and read-only views. */
function _expenseAllocStayLabel(bookingId) {
  const b = _expenseAllocFindBooking(bookingId);
  return b ? _expenseAllocBookingLabel(b) : 'Linked stay';
}

/** Short "Split · 4 stays" / guest-name label for an expense's list row, or ''. */
function _expenseStayChipText(e) {
  const allocs = expenseAllocations(e);
  if (!allocs.length) return '';
  if (allocs.length > 1) return 'Split · ' + allocs.length + ' stays';
  const b = _expenseAllocFindBooking(allocs[0].bookingId);
  return b ? (b.name || 'Guest') : 'Linked stay';
}

/** The chip itself — same small-badge idiom as the receipt / bank chips. */
function _expenseStayChip(e) {
  const txt = _expenseStayChipText(e);
  return txt
    ? `<span style="font-size:11px;color:#185FA5;font-family:'Plus Jakarta Sans',sans-serif">🏠 ${escHtml(txt)}</span>`
    : '';
}

/**
 * <option> markup for one allocation row's stay picker.
 *
 * Same eligibility window as renderExpenseBookingPicker, with two additions the
 * single-stay picker does not need:
 *  · only bookings that already have a _cloudId — booking_allocations[].booking_id
 *    lands in a uuid column, and a local numeric id fails the cast and parks the
 *    whole expense in the retry queue forever;
 *  · the currently-allocated stay is always listed even when its checkout is
 *    outside the window, or re-saving an old expense would drop the link.
 */
function _expenseAllocOptions(selectedId) {
  const todayStr = localDateStr();
  const cutoff = localDateStr(new Date(Date.now() - 120 * 86400000));
  const opts = (Array.isArray(bookings) ? bookings : [])
    .filter(b => b && b._cloudId && isRevenueBearingBooking(b) && b.checkout && b.checkout <= todayStr && b.checkout >= cutoff)
    .sort((a, b) => String(b.checkout).localeCompare(String(a.checkout)))
    .map(b => ({ id: String(b._cloudId), label: _expenseAllocBookingLabel(b) }));

  const sel = selectedId == null ? '' : String(selectedId);
  if (sel && !opts.some(o => o.id === sel)) opts.unshift({ id: sel, label: _expenseAllocStayLabel(sel) });

  return '<option value="">— Select stay —</option>' + opts.map(o =>
    `<option value="${escHtml(o.id)}"${o.id === sel ? ' selected' : ''}>${escHtml(o.label)}</option>`
  ).join('');
}

/** Redraw the allocation rows from state (inputs are re-bound, then the check line). */
function _renderExpenseAllocRows(prefix) {
  prefix = _expenseAllocPrefix(prefix);
  const host = document.getElementById(prefix + '-alloc-rows');
  if (!host) return;
  const rows = _expenseAllocState(prefix);
  host.innerHTML = rows.map((a, i) => {
    // Always 2dp: an even split yields 148.5, which reads as a different figure
    // to the 148.50 sitting in the row the host typed by hand.
    const amtVal = Number.isFinite(Number(a.amount)) ? Number(a.amount).toFixed(2) : '';
    return `<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
      <select class="exp-alloc-booking" data-prefix="${prefix}" data-idx="${i}" style="flex:1;min-width:0;margin-bottom:0">${_expenseAllocOptions(a.bookingId)}</select>
      <input type="number" step="0.01" inputmode="decimal" class="exp-alloc-amount" data-prefix="${prefix}" data-idx="${i}" value="${escHtml(amtVal)}" placeholder="0.00" style="width:96px;flex-shrink:0;margin-bottom:0">
      <button type="button" onclick="expenseAllocRemoveRow('${prefix}', ${i})" title="Remove stay"
        style="flex-shrink:0;background:none;border:none;color:var(--muted-2);font-size:18px;line-height:1;padding:0 4px;cursor:pointer">×</button>
    </div>`;
  }).join('');
  _bindExpenseAllocRowInputs(prefix);
  _refreshExpenseAllocCheck(prefix);
}

/** Wire the generated row inputs back into state (sentinel, not inline onchange). */
function _bindExpenseAllocRowInputs(prefix) {
  const host = document.getElementById(prefix + '-alloc-rows');
  if (!host) return;
  host.querySelectorAll('.exp-alloc-booking').forEach((sel) => {
    if (sel.dataset.bound) return;
    sel.dataset.bound = '1';
    sel.addEventListener('change', (ev) => {
      const t = ev.currentTarget;
      const row = _expenseAllocState(t.dataset.prefix)[Number(t.dataset.idx)];
      if (row) row.bookingId = t.value || '';
      _refreshExpenseAllocCheck(t.dataset.prefix);
    });
  });
  host.querySelectorAll('.exp-alloc-amount').forEach((inp) => {
    if (inp.dataset.bound) return;
    inp.dataset.bound = '1';
    inp.addEventListener('input', (ev) => {
      const t = ev.currentTarget;
      const row = _expenseAllocState(t.dataset.prefix)[Number(t.dataset.idx)];
      // Blank stays NaN rather than collapsing to 0, so the save-time validation
      // can tell "I haven't filled this in yet" from a deliberate $0 row.
      if (row) row.amount = String(t.value).trim() === '' ? NaN : Number(t.value);
      _refreshExpenseAllocCheck(t.dataset.prefix);
    });
  });
}

/**
 * Watch the expense total so the running check stays honest while the host
 * types. Refresh ONLY — re-splitting mid-keystroke would stomp amounts the host
 * has already adjusted by hand.
 */
function _bindExpenseAllocTotalWatcher(prefix) {
  const amt = document.getElementById(prefix + '-amount');
  if (amt && !amt.dataset.allocWatch) {
    amt.dataset.allocWatch = '1';
    amt.addEventListener('input', () => _refreshExpenseAllocCheck(prefix));
  }
  // The refund checkbox flips the sign of the total, so it moves the same line.
  const refund = document.getElementById(prefix + '-is-refund');
  if (refund && !refund.dataset.allocWatch) {
    refund.dataset.allocWatch = '1';
    refund.addEventListener('change', () => _refreshExpenseAllocCheck(prefix));
  }
}

/** "Allocated $X of $Y — $Z left / $Z over", coloured like the payout figure. */
function _refreshExpenseAllocCheck(prefix) {
  prefix = _expenseAllocPrefix(prefix);
  const el = document.getElementById(prefix + '-alloc-check');
  if (!el) return;
  if (!_expenseAllocSplitOpen(prefix)) { el.textContent = ''; return; }
  const rows = _expenseAllocState(prefix);
  const total = _expenseAllocTotal(prefix);
  const allocated = Math.round(rows.reduce((s, a) => s + (Number.isFinite(Number(a.amount)) ? Number(a.amount) : 0), 0) * 100) / 100;
  const left = Math.round((total - allocated) * 100) / 100;
  const money = (n) => '$' + Math.abs(n).toFixed(2);
  let tail;
  let colour;
  if (Math.abs(left) < 0.01) {
    tail = ' — fully allocated';
    colour = '#1D9E75';
  } else if (total >= 0 ? left > 0 : left < 0) {
    // Under-allocated is legitimate: the remainder is a plain operational expense.
    tail = ' — ' + money(left) + ' left';
    colour = 'var(--muted-2)';
  } else {
    tail = ' — ' + money(left) + ' over';
    colour = '#E24B4A';
  }
  el.textContent = 'Allocated ' + money(allocated) + ' of ' + money(total) + tail;
  el.style.color = colour;
}

/**
 * The allocations a save path should persist.
 *
 * THE GOVERNING RULE: [] whenever the split editor is closed, so single-stay
 * saves keep reading #<prefix>-booking-link and behave byte-for-byte as before.
 * Returned raw (blank amounts as NaN) so validation can reject them by name.
 */
function readExpenseAllocations(prefix) {
  prefix = _expenseAllocPrefix(prefix);
  if (!_expenseAllocSplitOpen(prefix)) return [];
  return _expenseAllocState(prefix).map(a => ({ bookingId: String(a.bookingId || ''), amount: Number(a.amount) }));
}

/** Load an expense's stored allocations into the editor's draft state. */
function seedExpenseAllocations(prefix, allocs) {
  prefix = _expenseAllocPrefix(prefix);
  _expenseAllocs[prefix] = normalizeExpenseAllocations(allocs);
  return _expenseAllocs[prefix];
}

/**
 * Collapse the editor and drop the draft WITHOUT touching the single-stay
 * select. Every teardown path has to call this: addExpense reads state rather
 * than the DOM, so a cancelled or abandoned split would otherwise leak into the
 * next expense and be saved silently.
 */
function _resetExpenseAllocUI(prefix) {
  prefix = _expenseAllocPrefix(prefix);
  _expenseAllocs[prefix] = [];
  const wrap = document.getElementById(prefix + '-alloc-wrap');
  if (wrap) { wrap.style.display = 'none'; delete wrap.dataset.splitOpen; }
  const rowsHost = document.getElementById(prefix + '-alloc-rows');
  if (rowsHost) rowsHost.innerHTML = '';
  const check = document.getElementById(prefix + '-alloc-check');
  if (check) { check.textContent = ''; check.style.color = 'var(--muted-2)'; }
  const btn = document.getElementById(prefix + '-alloc-split-btn');
  if (btn) btn.style.display = '';
}

/** Open the split editor, seeding row 0 from whatever the single select holds. */
function expenseAllocOpenSplit(prefix) {
  prefix = _expenseAllocPrefix(prefix);
  const wrap = document.getElementById(prefix + '-alloc-wrap');
  if (!wrap) return;
  const rows = _expenseAllocState(prefix);
  if (!rows.length) {
    // Seed with the FULL signed total so opening the editor never changes what
    // the expense is worth — "Split evenly" is an explicit second step.
    const current = document.getElementById(prefix + '-booking-link')?.value || '';
    rows.push({ bookingId: String(current || ''), amount: _expenseAllocTotal(prefix) });
  }
  wrap.style.display = 'block';
  wrap.dataset.splitOpen = '1';
  const btn = document.getElementById(prefix + '-alloc-split-btn');
  if (btn) btn.style.display = 'none';
  _bindExpenseAllocTotalWatcher(prefix);
  _renderExpenseAllocRows(prefix);
}
globalThis.expenseAllocOpenSplit = expenseAllocOpenSplit;

/** Collapse back to the single-stay control, keeping row 0's stay linked. */
function expenseAllocCloseSplit(prefix) {
  prefix = _expenseAllocPrefix(prefix);
  const rows = _expenseAllocState(prefix);
  const first = rows[0] && rows[0].bookingId ? String(rows[0].bookingId) : '';
  const sel = document.getElementById(prefix + '-booking-link');
  if (sel) {
    // The stay may be outside the picker's 120-day window, so make sure the
    // option exists before assigning or the link would silently vanish.
    if (first && !Array.from(sel.options).some(o => o.value === first)) {
      const opt = document.createElement('option');
      opt.value = first;
      opt.textContent = _expenseAllocStayLabel(first);
      sel.appendChild(opt);
    }
    sel.value = first;
  }
  _resetExpenseAllocUI(prefix);
}
globalThis.expenseAllocCloseSplit = expenseAllocCloseSplit;

/** Add an empty allocation row. */
function expenseAllocAddRow(prefix) {
  prefix = _expenseAllocPrefix(prefix);
  if (!_expenseAllocSplitOpen(prefix)) { expenseAllocOpenSplit(prefix); return; }
  _expenseAllocState(prefix).push({ bookingId: '', amount: NaN });
  _renderExpenseAllocRows(prefix);
}
globalThis.expenseAllocAddRow = expenseAllocAddRow;

/** Remove one allocation row; dropping to a single stay collapses the editor. */
function expenseAllocRemoveRow(prefix, idx) {
  prefix = _expenseAllocPrefix(prefix);
  const rows = _expenseAllocState(prefix);
  const i = Number(idx);
  if (!Number.isInteger(i) || i < 0 || i >= rows.length) return;
  rows.splice(i, 1);
  // One stay is not a split — hand the link back to the plain select so the UI
  // matches what will actually be saved.
  if (rows.length <= 1) { expenseAllocCloseSplit(prefix); return; }
  _renderExpenseAllocRows(prefix);
}
globalThis.expenseAllocRemoveRow = expenseAllocRemoveRow;

/** Pre-fill an even split of the current signed total across the existing rows. */
function expenseAllocSplitEven(prefix) {
  prefix = _expenseAllocPrefix(prefix);
  const rows = _expenseAllocState(prefix);
  if (!rows.length) return;
  const shares = evenSplitAmounts(_expenseAllocTotal(prefix), rows.length);
  rows.forEach((r, i) => { r.amount = shares[i]; });
  _renderExpenseAllocRows(prefix);
}
globalThis.expenseAllocSplitEven = expenseAllocSplitEven;

/**
 * Save-time validation. Returns an error string, or '' when the allocations are
 * safe to persist. Never runs on the single-stay path (the list is empty there).
 */
function _validateExpenseAllocations(allocs) {
  const seen = new Set();
  for (const a of allocs) {
    if (!a.bookingId) return 'Pick a stay for every split row';
    if (seen.has(a.bookingId)) return 'The same stay is listed twice — merge those rows';
    seen.add(a.bookingId);
    if (!Number.isFinite(a.amount)) return 'Enter an amount for every split row';
  }
  return '';
}

/** Signed total of a raw allocation list (validated ⇒ every amount is finite). */
function _sumExpenseAllocList(allocs) {
  return Math.round(allocs.reduce((s, a) => s + (Number.isFinite(Number(a.amount)) ? Number(a.amount) : 0), 0) * 100) / 100;
}

/**
 * One aggregated banner for stays that have no clean record yet. Per the agreed
 * behaviour this WARNS and the expense still saves — a stay can legitimately
 * have no scheduled clean, and auto-creating one would invent work.
 */
function _warnMissingCleanRecords(ids) {
  if (!ids || !ids.length) return;
  const names = ids.map((id) => {
    const b = _expenseAllocFindBooking(id);
    return b ? (b.name || 'Guest') : 'Unknown stay';
  });
  globalThis.showBanner('⚠ Saved — no clean record yet for ' + names.length + ' stay' + (names.length === 1 ? '' : 's') + ': ' + names.join(', '), 'warn');
}

/**
 * Push each allocated amount into its stay's clean.cost, SEQUENTIALLY: two
 * allocations can resolve to the same clean row, and parallel writes to it race.
 * `unlinkedIds` are stays the expense no longer touches — they get re-summed and
 * cleared when nothing else is allocated to them.
 * Returns the ids that had no clean record (for the aggregated warning).
 */
async function _recomputeAllocationTargets(linkedIds, unlinkedIds) {
  const applyFn = typeof globalThis.applyExpenseToBookingClean === 'function' ? globalThis.applyExpenseToBookingClean : null;
  const clearFn = typeof globalThis.clearExpenseFromBookingClean === 'function' ? globalThis.clearExpenseFromBookingClean : null;
  const missing = [];
  for (const bid of (linkedIds || [])) {
    if (!bid || !applyFn) continue;
    try {
      // The amount argument is ignored by design — bookings.js re-sums the live
      // allocations, so passing one expense's total would clobber the others.
      const res = await applyFn(bid, 0);
      if (res && res.ok === false && res.error === 'no clean record for booking') missing.push(bid);
    } catch (err) { console.warn('[StayOps] applyExpenseToBookingClean failed:', err); }
  }
  for (const bid of (unlinkedIds || [])) {
    if (!bid || !clearFn) continue;
    try {
      await clearFn(bid);
    } catch (err) { console.warn('[StayOps] clearExpenseFromBookingClean failed:', err); }
  }
  return missing;
}

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
  // Same de-double-count as renderReport — this PDF is emailed to the owner by
  // sendOwnerReport(), so a wrong net income here leaves the building.
  const fyTotalExpForNet = allExp.reduce((s,e)=>s+unallocatedExpenseAmount(e),0);
  const fyExpInPayouts = Math.round((fyTotalExp - fyTotalExpForNet) * 100) / 100;
  const fyNetInc = fyNet - fyTotalExpForNet;

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
  // Built as a variable so the highlight below can target the LAST row: the
  // reconciliation line is conditional, so a hard-coded index would bold the
  // wrong row whenever an expense is allocated to a stay.
  const netSummaryBody = [
    ['Total Revenue (Gross)', fmt2(fyRev)],
    ['Owner Payout (after fees)', fmt2(fyNet)],
    ['Total Expenses', '- ' + fmt2(fyTotalExp)],
  ];
  if (fyExpInPayouts) netSummaryBody.push(['less cleaning already deducted from payouts', '+ ' + fmt2(fyExpInPayouts)]);
  netSummaryBody.push(['Net Income', (fyNetInc<0?'- ':'')+fmt2(Math.abs(fyNetInc))]);
  const netSummaryLastRow = netSummaryBody.length - 1;
  doc.autoTable({
    startY: y, margin: { left:10, right:10 },
    head: [['Item','Amount']],
    body: netSummaryBody,
    headStyles: { fillColor: FOREST, textColor:[255,255,255], fontSize:8 },
    bodyStyles: { fontSize:9 },
    alternateRowStyles: { fillColor:[248,252,248] },
    didDrawRow: data => { if (data.row.index===netSummaryLastRow) { data.row.cells.forEach(c => { c.styles.fontStyle='bold'; c.styles.fillColor=fyNetInc>=0?[220,236,220]:[254,226,226]; }); } }
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
 *  RECONCILIATION / TRANSACTION MAP VIEW
 * ──────────────────────────────────────────────────────────────────────────── */

let _reconTxns = [];         // cached list from last fetch
let _reconFilter = 'all';    // current pill filter
let _reconTab = 'bank';      // 'bank' (debits → expenses) | 'payout' (credits → payouts)
// Platform statements for the Money In ledger. Loaded alongside the bank rows so
// the join can show a payout that never arrived — the thing a credit-only list
// structurally cannot display.
let _moneyInPayouts = [];

function showReconciliationView() {
  _reconTab = 'bank';
  const el = document.getElementById('finance-reconciliation-view');
  if (el) fadeTransition(el, true);
  renderReconciliationView();
}

async function renderReconciliationView() {
  const listEl = document.getElementById('reconciliation-list');
  if (!listEl) return;

  listEl.innerHTML = '<div style="text-align:center;padding:24px;color:var(--muted-2);font-size:13px;font-family:\'Plus Jakarta Sans\',sans-serif">Loading transactions...</div>';

  const user = await getCurrentSupabaseUser();
  if (!user) {
    listEl.innerHTML = '<div style="text-align:center;padding:24px;color:var(--muted-2);font-size:13px">Sign in to view transactions.</div>';
    const sb = document.getElementById('reconciliation-summary-bar'); if (sb) sb.innerHTML = '';
    const fe = document.getElementById('reconciliation-filters'); if (fe) fe.innerHTML = '';
    return;
  }

  _reconTxns = await getAllTransactionsWithStatus(user.id);
  // loadPlatformPayouts has existed since the payout feature shipped and had no
  // caller at all — the Money In ledger is its first consumer. Non-fatal: a
  // failure just means the ledger shows deposits without their statements.
  try {
    _moneyInPayouts = typeof loadPlatformPayouts === 'function' ? await loadPlatformPayouts() : [];
  } catch (e) {
    console.warn('[StayOps] Money In: could not load platform payouts', e);
    _moneyInPayouts = [];
  }
  _reconFilter = 'all';
  _renderReconFromCache();
}

// The Transaction Map is one bank_transactions feed split by direction: debits
// (money out) belong to the Bank Reconciliation tab, credits (money in) to the
// Payout Match tab. One fetch feeds both; the active tab scopes what's shown.
function _reconScopedTxns() {
  return (_reconTxns || []).filter(t =>
    _reconTab === 'payout' ? t.direction === 'credit' : t.direction !== 'credit'
  );
}

function _renderReconFromCache() {
  const tabsEl     = document.getElementById('reconciliation-tabs');
  const summaryBar = document.getElementById('reconciliation-summary-bar');
  const filtersEl  = document.getElementById('reconciliation-filters');
  const listEl     = document.getElementById('reconciliation-list');
  if (tabsEl) renderReconciliationTabs(tabsEl);
  if (!summaryBar || !filtersEl || !listEl) return;

  // Money In is a different shape of question from Money Out: it joins bank
  // credits to platform statements so a payout that never arrived is visible
  // too. A credit-only list structurally cannot show that.
  if (_reconTab === 'payout') {
    const credits = (_reconTxns || []).filter(t => t && t.direction === 'credit');
    const { summaryHtml } = renderMoneyInList(listEl, {
      payouts: _moneyInPayouts,
      credits,
      filter: _moneyInFilter,
    });
    summaryBar.innerHTML = summaryHtml;
    // The button states its own count, so the host knows exactly what will
    // happen before clicking, and it only appears when there is something to
    // do. Every link it makes is individually reversible via Unlink.
    const plan = planPayoutAutoMatch({ payouts: _moneyInPayouts, creditTxns: credits });
    const matchAllHtml = plan.links.length
      ? `<button onclick="moneyInMatchAll()" style="margin-left:8px;font-size:12px;font-weight:600;padding:6px 12px;border-radius:999px;border:1px solid var(--primary);background:var(--primary);color:#fff;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif">Match ${plan.links.length} deposit${plan.links.length === 1 ? '' : 's'}</button>`
      : '';
    filtersEl.innerHTML = moneyInFiltersHtml(_moneyInFilter) + matchAllHtml;
    return;
  }

  const scoped = _reconScopedTxns();
  const totals = { matched: 0, matched_payout: 0, unaccounted: 0, personal: 0, skipped: 0 };
  for (const t of scoped) {
    totals[t.status] = (totals[t.status] || 0) + Math.abs(t.amount);
  }
  summaryBar.innerHTML = _reconSummaryHtml(totals);
  renderReconciliationFilters(filtersEl);
  renderReconciliationList(listEl);
}

function _reconSummaryHtml(totals) {
  const isBank = _reconTab !== 'payout';
  const tile = (val, label, bg, valColor, labelColor) =>
    `<div style="flex:1;min-width:100px;background:${bg};border-radius:8px;padding:8px 12px;text-align:center">
       <div style="font-size:18px;font-weight:600;color:${valColor}">$${_fmtAud(val)}</div>
       <div style="font-size:11px;color:${labelColor}">${label}</div>
     </div>`;
  // Unaccounted must mean "money still needing a decision", from BOTH sides:
  // bank payments with no expense, and expenses with no payment. Counting only
  // the bank side read as $0.00 — "nothing to do" — while unpaid expenses sat
  // in the list right below it.
  const unpaidTotal = isBank
    ? _unpaidExpenses().actionable.reduce((s, e) => s + Math.abs(Number(e.amount) || 0), 0)
    : 0;
  const tiles = isBank
    ? tile(totals.matched, 'Matched', '#E8F5E9', '#2E7D32', '#388E3C') +
      tile(totals.unaccounted + unpaidTotal, 'Unaccounted', '#FFF3E0', '#E65100', '#F57C00') +
      tile(totals.personal, 'Personal', '#F3E5F5', '#7B1FA2', '#9C27B0')
    : tile(totals.matched_payout, 'Matched', '#E3F2FD', '#1565C0', '#1976D2') +
      tile(totals.unaccounted, 'Unmatched', '#FFF3E0', '#E65100', '#F57C00') +
      tile(totals.personal, 'Personal', '#F3E5F5', '#7B1FA2', '#9C27B0');
  return `<div style="display:flex;gap:8px;padding:0 16px;margin:0 auto 12px;max-width:560px;flex-wrap:wrap">${tiles}</div>`;
}

function renderReconciliationTabs(container) {
  if (!container) return;
  const isBank = _reconTab !== 'payout';
  const tabBtn = (key, label, active) =>
    `<button onclick="switchReconTab('${key}')" style="flex:1;padding:9px 6px;border-radius:10px;font-size:12.5px;font-weight:600;font-family:'Plus Jakarta Sans',sans-serif;cursor:pointer;border:1px solid ${active ? 'var(--primary)' : 'var(--hairline-1)'};background:${active ? 'var(--primary)' : '#fff'};color:${active ? '#fff' : 'var(--muted-2)'}">${label}</button>`;
  const actionBtn = (onclick, label) =>
    `<button type="button" onclick="${onclick}" style="font-size:12px;color:var(--primary);background:transparent;border:1px solid var(--primary);border-radius:8px;padding:6px 12px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;font-weight:600;white-space:nowrap">${label}</button>`;
  container.innerHTML = `
    <div style="display:flex;gap:6px;margin:10px 0 8px">
      ${tabBtn('bank', 'Money Out', isBank)}
      ${tabBtn('payout', 'Money In', !isBank)}
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">
      <p style="margin:0;font-size:12.5px;color:var(--muted-2);font-family:'Plus Jakarta Sans',sans-serif">${isBank ? 'Match each payment to an expense.' : 'Every platform payout and the deposit that settles it.'}</p>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${isBank ? '' : actionBtn('openPayoutPasteModal()', 'Paste Payout')}
        ${actionBtn('bankImportPickFile()', 'Import Statement')}
      </div>
    </div>`;
}

function switchReconTab(tab) {
  _reconTab = tab === 'payout' ? 'payout' : 'bank';
  _reconFilter = 'all';
  _renderReconFromCache();
}

/** Filter for the Money In ledger. Separate from _reconFilter because the row
 *  kinds are different (received / not received / unexplained, not the debit
 *  statuses), so sharing one variable would leave an unreachable filter selected
 *  when switching tabs. */
let _moneyInFilter = 'all';
function moneyInSetFilter(kind) {
  _moneyInFilter = kind || 'all';
  _renderReconFromCache();
}
globalThis.moneyInSetFilter = moneyInSetFilter;

/** Jump from a not-received payout to the deposits that might settle it. There
 *  is no reverse matcher, so this narrows the list to unexplained deposits and
 *  tells the host what to look for. */
function moneyInFindDeposit(payoutId) {
  const p = (_moneyInPayouts || []).find(x => String(x._cloudId) === String(payoutId));
  _moneyInFilter = 'credit_only';
  _renderReconFromCache();
  if (p) {
    globalThis.showBanner(
      `Looking for $${_fmtAud(Math.abs(Number(p.net) || 0))} around ${p.expectedArrivalDate || p.payoutDate || '?'} — tap Match payout on the deposit that matches.`,
      'info'
    );
  }
}
globalThis.moneyInFindDeposit = moneyInFindDeposit;
globalThis.switchReconTab = switchReconTab;

function renderReconciliationFilters(container) {
  const isBank = _reconTab !== 'payout';
  const pills = isBank
    ? [
        { key: 'all', label: 'All' },
        { key: 'matched', label: 'Matched' },
        { key: 'unaccounted', label: 'Unaccounted' },
        { key: 'personal', label: 'Personal' },
        { key: 'skipped', label: 'Skipped' },
      ]
    : [
        { key: 'all', label: 'All' },
        { key: 'matched_payout', label: 'Matched' },
        { key: 'unaccounted', label: 'Unmatched' },
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
  const scoped = _reconScopedTxns();
  const isBank = _reconTab !== 'payout';

  // Computed up front and appended to EVERY path below. Both early returns used
  // to bail before it, which hid these rows exactly when they matter most: with
  // zero unaccounted bank debits, the Unaccounted filter took the early return
  // and showed "no transactions" while unpaid expenses were sitting there.
  const unpaidHtml = _unpaidExpenseRowsHtml();

  if (scoped.length === 0) {
    container.innerHTML = `<div style="text-align:center;padding:24px;color:var(--muted-2);font-size:13px;font-family:'Plus Jakarta Sans',sans-serif">${isBank ? 'No bank debits imported yet. Tap Import Statement to add a bank statement.' : 'No deposits to match yet. Import a bank statement, or tap Paste Payout to add a platform statement.'}</div>` + unpaidHtml;
    return;
  }

  const filtered = _reconFilter === 'all'
    ? scoped
    : scoped.filter(t => t.status === _reconFilter);

  if (filtered.length === 0) {
    container.innerHTML = (unpaidHtml
      ? ''
      : '<div style="text-align:center;padding:24px;color:var(--muted-2);font-size:13px;font-family:\'Plus Jakarta Sans\',sans-serif">No transactions in this filter.</div>') + unpaidHtml;
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
      // Unlink is the only way back from a wrong match; without it the link was
      // permanent (unlinkPayoutFromTransaction shipped with no caller at all).
      const unlinkBtn = p.id
        ? `<button onclick="reconUnlinkPayout('${escapeJsSingleQuotedHtmlAttr(String(p.id))}','${t.id}')" style="font-size:10px;color:#78909C;background:none;border:1px solid #B0BEC5;border-radius:6px;padding:2px 8px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;white-space:nowrap">Unlink</button>`
        : '';
      rightInfo = `<div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px">
        ${badge}
        ${p.payoutDate ? `<span style="font-size:10px;color:var(--muted-2)">Payout ${escHtml(p.payoutDate)}</span>` : ''}
        ${unlinkBtn}
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
          <button onclick="reconMatchPayout('${t.id}','${escapeJsSingleQuotedHtmlAttr(rawDate)}','${rawAmt}','${safeDesc}')" style="font-size:11px;color:#1565C0;background:none;border:1px solid #1565C0;border-radius:6px;padding:3px 10px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;white-space:nowrap">Match Payout</button>
          <div style="display:flex;gap:4px">
            <button onclick="reconMarkPersonal('${t.id}')" style="font-size:11px;color:#9C27B0;background:none;border:1px solid #9C27B0;border-radius:6px;padding:3px 10px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;white-space:nowrap">Personal</button>
            <button onclick="reconMarkSkipped('${t.id}')" style="font-size:11px;color:#78909C;background:none;border:1px solid #B0BEC5;border-radius:6px;padding:3px 10px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;white-space:nowrap">Skip</button>
          </div></div>`;
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
  }).join('') + unpaidHtml;
}

/** Expenses with no bank payment against them.
 *
 *  The list above renders BANK ROWS only, so an expense the host recorded but
 *  that has no matching payment was invisible — you could see a payment with no
 *  expense, never an expense with no payment. Half of reconciliation was simply
 *  not on screen, which is why "I imported the statement, now let me match my
 *  expenses" had nowhere to happen.
 *
 *  Reads the already-hydrated in-memory `expenses` array, so this costs no
 *  queries. Only shown on Money Out, and only under the All/Unaccounted filters
 *  — these are unmatched by definition, so they do not belong under Matched. */
/** Expenses with no bank payment, split into what can be actioned now and what
 *  cannot. Single source of truth for BOTH the Unaccounted tile and the rows
 *  below it — computing them separately is how a summary starts disagreeing
 *  with the list it summarises. */
function _unpaidExpenses() {
  // loadExpensesFromCloud maps this column as snake_case `bank_transaction_id`
  // (supabase-expenses.js:60), NOT bankTransactionId — checking the camelCase
  // name matched nothing, so "has this been paid?" silently answered "no" for
  // every expense. Both spellings are accepted so an optimistically-updated row
  // is treated as paid before the next hydrate.
  const isPaid = e => !!(e.bank_transaction_id || e.bankTransactionId);
  const list = (Array.isArray(expenses) ? expenses : []).filter(e =>
    e && !isPaid(e)
    && String(e.status || 'active') !== 'deleted'
    && Number(e.amount) > 0);

  // Only the imported date range can actually be matched. Outside it there is
  // no bank data to match against, so flagging those as work would be crying
  // wolf — they are counted, not listed as a to-do.
  const dates = (_reconTxns || []).map(t => t && t.date).filter(Boolean).sort();
  const covFrom = dates[0] || null;
  const covTo = dates[dates.length - 1] || null;
  const inRange = e => !covFrom || !covTo || (e.date >= covFrom && e.date <= covTo);
  const actionable = list.filter(inRange).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { actionable, outside: list.length - actionable.length };
}

function _unpaidExpenseRowsHtml() {
  if (_reconTab === 'payout') return '';
  if (_reconFilter !== 'all' && _reconFilter !== 'unaccounted') return '';
  const { actionable, outside } = _unpaidExpenses();
  if (!actionable.length && !outside) return '';

  const rows = actionable.map(e => {
    const id = escapeJsSingleQuotedHtmlAttr(String(e._cloudId || e.id || ''));
    const label = escHtml(e.merchant || e.description || 'Expense');
    return `<div style="background:#fff;border-radius:10px;padding:12px 14px;margin-bottom:8px;border:0.5px solid rgba(0,0,0,0.06);display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
      <div style="flex:1;min-width:0">
        <div style="font-size:11px;color:var(--muted-2);margin-bottom:2px">${escHtml(e.date || '')}</div>
        <div style="font-size:14px;font-weight:500;color:var(--ink-1);font-family:'Plus Jakarta Sans',sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${label}</div>
        <div style="font-size:15px;font-weight:600;color:var(--ink-1);margin-top:2px">$${_fmtAud(Math.abs(Number(e.amount) || 0))}</div>
      </div>
      <div style="flex-shrink:0;text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:4px">
        <span style="display:inline-block;font-size:11px;background:#FFF3E0;color:#E65100;border-radius:4px;padding:2px 8px">No payment</span>
        <button onclick="reconFindPaymentForExpense('${id}')" style="font-size:11px;color:#E65100;background:none;border:1px solid #FFB74D;border-radius:6px;padding:3px 10px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;white-space:nowrap">Find payment</button>
      </div>
    </div>`;
  }).join('');

  const header = `<div style="font-size:11px;font-weight:700;color:var(--muted-2);text-transform:uppercase;letter-spacing:.4px;margin:16px 0 6px">Expenses with no payment · ${actionable.length}</div>`;
  const note = outside
    ? `<div style="font-size:12px;color:var(--muted-2);padding:4px 2px 10px">${outside} more fall outside the dates your statement covers — import those months to match them.</div>`
    : '';
  return header + (rows || `<div style="font-size:12.5px;color:var(--muted-2);padding:4px 2px 10px">All expenses in the imported period have a payment.</div>`) + note;
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

/**
 * Link every payout that has exactly one unambiguous deposit, in one pass.
 *
 * Matching was one-at-a-time only, which is not a workflow anyone finishes
 * across 30-odd payouts — so the money-in view stayed permanently unreconciled
 * even when the deposits were sitting right there. planPayoutAutoMatch does the
 * deciding (and refuses anything ambiguous); this just applies it and reports.
 */
async function moneyInMatchAll() {
  const credits = (_reconTxns || []).filter(t => t && t.direction === 'credit');
  const plan = planPayoutAutoMatch({ payouts: _moneyInPayouts, creditTxns: credits });
  if (!plan.links.length) {
    globalThis.showBanner('Nothing to match automatically — no payout has a single unambiguous deposit', 'warn');
    return;
  }

  const total = plan.links.length;
  let linked = 0;
  const failed = [];
  for (const { payout, credit } of plan.links) {
    globalThis.showBanner(`⏳ Matching ${linked + 1} of ${total}...`, 'ok');
    const res = await linkTransactionToPayout(credit.id, payout._cloudId, { bankDate: credit.date });
    if (res && res.success) {
      linked += 1;
    } else {
      failed.push(`${payout.payoutDate || '?'} $${Math.abs(Number(payout.net) || 0).toFixed(2)}`);
    }
  }

  // Refetch rather than patch: dozens of rows changed, and a stale in-memory
  // view here is exactly how a payout ends up looking settled when it is not.
  await renderReconciliationView();

  // Name what was left behind. Reporting only the successes would present a
  // partial match as a complete one.
  const leftovers = [];
  if (plan.ambiguous.length) leftovers.push(`${plan.ambiguous.length} need a choice (more than one possible deposit)`);
  if (plan.unmatched.length) leftovers.push(`${plan.unmatched.length} have no matching deposit imported`);
  if (failed.length) leftovers.push(`${failed.length} failed to save: ${failed.join(', ')}`);

  globalThis.showBanner(
    `✓ ${linked} of ${total} linked` + (leftovers.length ? ` · ${leftovers.join(' · ')}` : ''),
    failed.length ? 'warn' : 'ok');
}
globalThis.moneyInMatchAll = moneyInMatchAll;

/** Link a bank credit row to a platform_payouts row and update UI in place. */
async function reconLinkToPayout(txnId, payoutId) {
  // Pass the deposit's own date so the payout's attestation date gets filled
  // from evidence rather than staying blank — keeps this view and the booking
  // panel telling the same story.
  const linkTxn = _reconTxns.find(t => String(t.id) === String(txnId));
  const result = await linkTransactionToPayout(txnId, payoutId, { bankDate: linkTxn && linkTxn.date });
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

/** Undo a payout↔deposit link.
 *
 *  unlinkPayoutFromTransaction has existed since the payout feature shipped but
 *  had NO caller anywhere, so a mis-matched deposit was permanent. Deliberately
 *  leaves received_at alone: unlinking removes the evidence, not the host's
 *  claim, so the payout drops from 'settled' to 'attested' rather than back to
 *  'outstanding'. */
async function reconUnlinkPayout(payoutId, txnId) {
  const ok = await globalThis.showAppModal({
    title: 'Unlink this deposit?',
    msg: 'The payout goes back to needing a match. Nothing is deleted.',
    confirmText: 'Unlink',
  });
  if (!ok) return;
  const result = await unlinkPayoutFromTransaction(payoutId);
  if (!result.success) {
    globalThis.showBanner('⚠ Could not unlink — see console', 'warn');
    return;
  }
  const txn = _reconTxns.find(t => String(t.id) === String(txnId));
  if (txn) { txn.status = 'unaccounted'; txn.payout = null; }
  globalThis.showBanner('✓ Deposit unlinked', 'ok');
  _renderReconFromCache();
}
globalThis.reconUnlinkPayout = reconUnlinkPayout;

/** From an EXPENSE, find the bank payment that settles it — the reverse of
 *  reconMatchExpense. findMatchesForExpense has existed since the reconciliation
 *  feature shipped and had no caller anywhere, so this direction was never
 *  reachable from the UI. */
async function reconFindPaymentForExpense(expenseId) {
  const user = await getCurrentSupabaseUser();
  if (!user) { globalThis.showBanner('Sign in first', 'warn'); return; }
  const exp = (Array.isArray(expenses) ? expenses : [])
    .find(e => String(e._cloudId || e.id) === String(expenseId));
  if (!exp) { globalThis.showBanner('⚠ Expense not found', 'warn'); return; }

  const matches = await findMatchesForExpense(exp, user.id);
  if (!matches.length) {
    globalThis.showBanner(
      `No unmatched payment within ±3 days of ${exp.date} for $${_fmtAud(Math.abs(Number(exp.amount) || 0))}. It may have been paid another way, or that month is not imported yet.`,
      'warn');
    return;
  }
  const rows = matches.slice(0, 8).map(m => {
    const t = m.transaction || m.txn || m;
    const amt = _fmtAud(Math.abs(Number(t.amount) || 0));
    const score = m.score != null ? ` · score ${m.score}` : '';
    return `<div onclick="reconLinkExpenseToTxn('${escapeJsSingleQuotedHtmlAttr(String(t.id))}','${escapeJsSingleQuotedHtmlAttr(String(expenseId))}')"
        style="padding:10px 12px;border-bottom:0.5px solid var(--hairline-1);cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif">
        <div style="font-size:13px;font-weight:600;color:var(--ink-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(t.description || 'Payment')}</div>
        <div style="font-size:11.5px;color:var(--muted-2);margin-top:2px">${escHtml(t.date || '')} · $${amt}${escHtml(score)}</div>
      </div>`;
  }).join('');

  let overlay = document.getElementById('recon-match-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'recon-match-overlay';
    document.body.appendChild(overlay);
  }
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.4);display:flex;align-items:flex-end;justify-content:center';
  overlay.innerHTML = `
    <div style="background:#fff;width:100%;max-width:560px;border-radius:16px 16px 0 0;max-height:70vh;overflow-y:auto;padding:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <strong style="font-family:'Plus Jakarta Sans',sans-serif;font-size:15px">Find the payment</strong>
        <button onclick="document.getElementById('recon-match-overlay').style.display='none';document.body.style.overflow=''" style="border:none;background:none;font-size:20px;cursor:pointer;color:var(--muted-2)">×</button>
      </div>
      <div style="font-size:12.5px;color:var(--muted-2);margin-bottom:8px;font-family:'Plus Jakarta Sans',sans-serif">${escHtml(exp.merchant || exp.description || 'Expense')} · $${_fmtAud(Math.abs(Number(exp.amount) || 0))}</div>
      ${rows}
    </div>`;
  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}
globalThis.reconFindPaymentForExpense = reconFindPaymentForExpense;

/** Link the chosen bank payment to the expense, then refresh in place. */
async function reconLinkExpenseToTxn(txnId, expenseId) {
  const result = await linkTransactionToExpense(txnId, expenseId);
  if (!result || !result.success) {
    globalThis.showBanner('⚠ Could not link — see console', 'warn');
    return;
  }
  const overlay = document.getElementById('recon-match-overlay');
  if (overlay) overlay.style.display = 'none';
  document.body.style.overflow = '';
  const exp = (Array.isArray(expenses) ? expenses : [])
    .find(e => String(e._cloudId || e.id) === String(expenseId));
  // Write the snake_case field the cloud mapper actually produces, so the row
  // drops out of the unpaid list immediately rather than only after a hydrate.
  if (exp) { exp.bank_transaction_id = txnId; exp.bankTransactionId = txnId; exp.reconciled = true; exp.paymentStatus = 'paid'; }
  const txn = _reconTxns.find(t => String(t.id) === String(txnId));
  if (txn) { txn.status = 'matched'; txn.expense_id = expenseId; txn.expenseMerchant = (exp && (exp.merchant || exp.description)) || 'Linked'; }
  globalThis.showBanner('✓ Payment matched to expense', 'ok');
  _renderReconFromCache();
}
globalThis.reconLinkExpenseToTxn = reconLinkExpenseToTxn;

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
    // Re-render tab-scoped (tabs + summary + filters + list) preserving scroll, so
    // the summary tiles stay scoped to the active tab instead of summing every row.
    const listEl = document.getElementById('reconciliation-list');
    const scrollY = listEl && listEl.parentElement ? listEl.parentElement.scrollTop : window.scrollY;
    _renderReconFromCache();
    const listEl2 = document.getElementById('reconciliation-list');
    if (listEl2 && listEl2.parentElement) listEl2.parentElement.scrollTop = scrollY;
    else window.scrollTo(0, scrollY);
  } catch (err) {
    globalThis.showBanner('Failed to link: ' + (err.message || err), 'error');
  }
}
globalThis.reconLinkToExpense = reconLinkToExpense;

/** Pre-fill the expense form from an unaccounted transaction. */
let _pendingReconTxnId = null;
// True while #expense-edit-modal is borrowed to CREATE an expense from a bank
// transaction instead of editing an existing one.
let _reconCreateMode = false;

/** Open the shared expense modal ON TOP of the reconciliation list, prefilled
 *  from a bank transaction.
 *
 *  Deliberately does NOT navigate. The inline add-form panel lives inside
 *  #finance-expenses-view, which showFinanceSub hides to show reconciliation, so
 *  it can never float over this list — but #expense-edit-modal is a top-level
 *  .modal-overlay and can. Staying put is what keeps the host's pill filter and
 *  tab alive: nothing re-enters the view, so nothing resets them. */
function reconCreateExpense(txnId, date, amount, description) {
  _pendingReconTxnId = txnId; // auto-linked by _autoLinkPendingReconTxn after save
  _reconCreateMode = true;

  const numAmount = Number(amount);
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('ee-merchant', '');
  set('ee-description', description || '');
  set('ee-amount', Number.isFinite(numAmount) ? Math.abs(numAmount) : amount);
  set('ee-date', date || localDateStr());
  set('ee-receipt-num', '');
  set('ee-tax-note', '');
  const refundEl = document.getElementById('ee-is-refund');
  if (refundEl) refundEl.checked = Number.isFinite(numAmount) && numAmount < 0;
  const catEl = document.getElementById('ee-category');
  if (catEl) catEl.value = '';
  renderExpenseCatPickerFor('ee');
  const typeSel = document.getElementById('ee-receipt-type');
  if (typeSel) typeSel.value = 'missing';
  if (typeof renderExpenseBookingPicker === 'function') renderExpenseBookingPicker('ee', '');
  _resetExpenseAllocUI('ee');

  // No expense row exists yet, so the EDIT receipt controls (which attach to an
  // existing row) are useless here — swap them for the create-mode block, which
  // stages a receipt the same way the inline Add panel does and offers
  // "Read with AI" to fill this form.
  // editingExpenseId must be null so a stale edit target can't be saved over.
  editingExpenseId = null;
  editingExpensePhotoBase64 = null;
  const receiptSection = document.getElementById('ee-receipt-section');
  if (receiptSection) receiptSection.style.display = 'none';
  const createReceipt = document.getElementById('ee-create-receipt-block');
  if (createReceipt) createReceipt.style.display = 'block';
  const aiBtn = document.getElementById('ee-ai-read-btn');
  if (aiBtn) aiBtn.style.display = 'block';
  const exStatus = document.getElementById('ee-extract-status');
  if (exStatus) { exStatus.style.display = 'none'; exStatus.textContent = ''; }
  // Receipt staging is module-global, shared with the inline Add panel. Clear it
  // so a receipt staged there earlier and never saved can't silently ride along
  // on this expense — addExpense uploads whatever is staged, sight unseen.
  if (typeof clearExpensePhoto === 'function') clearExpensePhoto();
  if (typeof clearExpensePhoto2 === 'function') clearExpensePhoto2();
  const titleEl = document.getElementById('ee-modal-title');
  if (titleEl) titleEl.textContent = 'New Expense';
  const saveBtn = document.getElementById('ee-save-btn');
  if (saveBtn) saveBtn.textContent = '💾 Save & Match';
  const suggest = document.getElementById('ee-ai-suggest-card');
  if (suggest) suggest.style.display = 'none';

  document.getElementById('expense-edit-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(globalThis.attachModalHandleDrag, 0);
}

/** Put the shared modal back into plain "edit" shape and drop the pending link.
 *  Clearing _pendingReconTxnId is the important half: abandoning a recon create
 *  used to leave it set, so the NEXT unrelated expense the host saved was
 *  silently matched to that bank transaction and stamped paid/reconciled. */
function _exitReconCreateMode(clearPending = true) {
  if (!_reconCreateMode) return;
  _reconCreateMode = false;
  // On a SUCCESSFUL save the pending id must survive: addExpense links it
  // asynchronously, once saveExpenseToCloud resolves. Only cancelling clears it.
  if (clearPending) _pendingReconTxnId = null;
  const receiptSection = document.getElementById('ee-receipt-section');
  if (receiptSection) receiptSection.style.display = '';
  const createReceipt = document.getElementById('ee-create-receipt-block');
  if (createReceipt) createReceipt.style.display = 'none';
  const exStatus = document.getElementById('ee-extract-status');
  if (exStatus) { exStatus.style.display = 'none'; exStatus.textContent = ''; }
  const titleEl = document.getElementById('ee-modal-title');
  if (titleEl) titleEl.textContent = 'Edit Expense';
  const saveBtn = document.getElementById('ee-save-btn');
  if (saveBtn) saveBtn.textContent = '💾 Save Changes';
  _resetExpenseAllocUI('ee');
}

/** Save the recon-created expense. Reuses addExpense() wholesale — it already
 *  auto-links the pending bank txn once the cloud id returns — passing every
 *  field explicitly so it reads the 'ee' modal rather than the inline 'exp'
 *  form, and silent:true so it leaves that untouched form alone. */
function _saveReconNewExpense() {
  const val = id => (document.getElementById(id)?.value || '').trim();
  const allocations = readExpenseAllocations('ee');
  const created = addExpense({
    merchant: val('ee-merchant'),
    description: val('ee-description'),
    amount: parseFloat(val('ee-amount')),
    isRefund: document.getElementById('ee-is-refund')?.checked || false,
    date: val('ee-date') || localDateStr(),
    category: val('ee-category'),
    receiptType: val('ee-receipt-type') || 'missing',
    receiptNum: val('ee-receipt-num'),
    taxNote: val('ee-tax-note'),
    bookingId: allocations.length ? allocations[0].bookingId : (val('ee-booking-link') || null),
    allocations,
    silent: true,
  });
  // addExpense returns the row on success and undefined on every bail (missing
  // merchant/amount, invalid split, or the async unallocated-remainder confirm).
  // Leave the modal open on those so the host keeps their draft.
  if (!created) return;
  // Exit create mode FIRST, keeping _pendingReconTxnId alive for the pending
  // async link; closeExpenseEdit's own _exitReconCreateMode() then no-ops.
  _exitReconCreateMode(false);
  closeExpenseEdit();
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
    // supabase-js does not throw on a failed write, so check each result instead
    // of bannering "linked" over an RLS-blocked update (mirrors reconLinkToExpense,
    // report 3.2). A half-applied link is worse than none: the bank row would
    // point at an expense that was never marked reconciled.
    const w = (typeof globalThis.sbWrite === 'function')
      ? globalThis.sbWrite
      : async (builder, _opts) => { const { error } = await builder; return { ok: !error, error }; };
    const r1 = await w(window._sb.from('bank_transactions').update({ expense_id: expenseId }).eq('id', txnId), { label: 'reconciliation link' });
    if (!r1.ok) { globalThis.showBanner('⚠ Expense saved, but could not link it to the bank transaction', 'warn'); return; }
    const r2 = await w(window._sb.from('expenses').update({ reconciled: true, bank_transaction_id: txnId, payment_status: 'paid' }).eq('id', expenseId), { label: 'reconciliation link' });
    if (!r2.ok) { globalThis.showBanner('⚠ Matched, but the expense was not marked reconciled', 'warn'); return; }
    globalThis.showBanner('✓ Expense created & linked to bank transaction', 'ok');

    // Patch the cached row and re-render FROM CACHE rather than refetching:
    // _renderReconFromCache leaves _reconFilter and _reconTab untouched, so the
    // host lands back on exactly the filtered list they were working. The row
    // is now 'matched', so it drops out of the Unaccounted filter on its own.
    const txn = (_reconTxns || []).find(t => String(t.id) === String(txnId));
    if (txn) {
      txn.status = 'matched';
      txn.expense_id = expenseId;
      const exp = (Array.isArray(expenses) ? expenses : []).find(e => (e._cloudId || e.id) === expenseId);
      if (exp) txn.expenseMerchant = exp.merchant || exp.description || 'Linked';
    }
    const listEl = document.getElementById('reconciliation-list');
    if (listEl) {
      const scrollY = listEl.parentElement ? listEl.parentElement.scrollTop : window.scrollY;
      _renderReconFromCache();
      const listEl2 = document.getElementById('reconciliation-list');
      if (listEl2 && listEl2.parentElement) listEl2.parentElement.scrollTop = scrollY;
    }
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
  openFinancePanelFromHub,
  switchFinanceTab,
  switchPayoutsSubTab,
  switchMgmtSubTab,
  switchReportSubTab,
  renderMgmtFY,
  _financeScopedBookings,
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
  expenseHasReceiptAttached,
  _financeScopedExpenses,
  ATO_FIELD_LABELS,
  _bookingPropertyId,
  _canonicalPlatformName,
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
globalThis.resetFinanceSubViewToHub = resetFinanceSubViewToHub;
globalThis.mgmtCheckboxChange = mgmtCheckboxChange;
globalThis.mgmtToggleSelectAll = mgmtToggleSelectAll;
globalThis._mgmtFYSelectedMonths = _mgmtFYSelectedMonths;
globalThis._mgmtFYToggleMonth = _mgmtFYToggleMonth;

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


