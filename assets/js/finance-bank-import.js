/**
 * StayOps — Bank CSV import review UI. Split out of finance.js (2026-07-08, see
 * the architecture plan): same function + window.* names; finance.js stays the
 * barrel and imports this slice. The circular import with finance.js
 * (renderExpenses, showReconciliationView) is call-time only — safe for hoisted
 * function declarations. `_bankImportReviewActive` is exported (read by the
 * barrel's renderExpenses to suppress a re-render while a review is open).
 */
import { parseCSV, parseBankFileWithAI, categoriseTransactions, checkDuplicates, confirmTransaction, skipTransaction, logImportSession, getBankImportError, resetBankImportError } from './bank-import.js';
import { findMatchesForTransaction, getReconciliationSummary } from './reconciliation.js';
import { expenses } from './state.js';
import { escHtml, fmt } from './utils.js';
import { isPortfolioMode } from './property.js';
import { getAllProperties, getActivePropertyConfig } from './config.js';
import { renderExpenses, showReconciliationView } from './finance.js';

// ── BANK CSV IMPORT (review UI) ───────────────────────────────────────────────
export let _bankImportReviewActive = false;
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
      <div style="font-size:13px;color:var(--muted-2)" id="bank-import-progress">Please wait while we check for duplicates and categorise entries.</div>
    </div>`;
}

/** Live progress for the analysing phase.
 *
 *  That phase is O(rows) sequential network calls — vendor mappings and
 *  duplicate lookups are per row — so a 95-row statement makes a few hundred
 *  round trips and can run for minutes. With a static "Analysing transactions…"
 *  and no counter it reads as a hang, which is exactly how a working import got
 *  reported as "nothing happens". bank-import.js calls this through globalThis
 *  so the parser stays free of UI imports. */
globalThis._bankImportProgress = (text) => {
  const el = document.getElementById('bank-import-progress');
  if (el) el.textContent = text;
};

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

  const renderReviewCard = (row, i) => {
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
  };

  const renderAlreadyLoggedCard = (row, i) => {
    const m = row.dupMatch || {};
    const priorImport = row.reason === 'already imported' || m.kind === 'import';
    const badgeText = priorImport ? 'Imported before' : 'Already logged';
    const badgeBg = priorImport ? '#F1EFE8' : '#EAF3DE';
    const badgeColor = priorImport ? '#5F5E5A' : '#3B6D11';
    const amt = '$' + Number(row.amount || 0).toFixed(2);
    const matchLine = priorImport
      ? (m.date ? `Already imported · ${escHtml(bankImportFmtDayMon(m.date))}` : 'Already on a previous import')
      : (m.label
          ? `Matches your expense · ${escHtml(m.label)} · $${Number(m.amount || 0).toFixed(2)}${m.date ? ' · ' + escHtml(bankImportFmtDayMon(m.date)) : ''}`
          : 'Matches an existing expense');
    return `
      <div class="bank-import-card" style="background:white;border:0.5px solid var(--border-tertiary,var(--hairline-1));border-radius:12px;padding:12px 14px;margin:0 16px 8px">
        <div style="display:flex;align-items:flex-start;gap:10px">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;color:var(--muted-2);text-decoration:line-through;word-break:break-word;line-height:1.4">${escHtml(row.description || '')}</div>
            <div style="font-size:11px;color:var(--muted-2);margin-top:3px">${escHtml(bankImportFmtDayMon(row.date))} · ${amt}</div>
          </div>
          <span style="font-size:11px;font-weight:600;background:${badgeBg};color:${badgeColor};padding:3px 9px;border-radius:8px;white-space:nowrap">${badgeText}</span>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px;padding-top:8px;border-top:0.5px solid var(--hairline-1)">
          <span style="font-size:11.5px;color:var(--muted-2);min-width:0;word-break:break-word">${matchLine}</span>
          <button type="button" onclick="globalThis.bankImportImportAnyway(${i})" style="font-size:11.5px;padding:5px 10px;border-radius:8px;border:1px solid var(--hairline-1);background:white;color:var(--ink-2);cursor:pointer;white-space:nowrap;font-family:'Plus Jakarta Sans',sans-serif">Import anyway</button>
        </div>
      </div>`;
  };

  const dupItems = [];
  const newItems = [];
  _bankImportRows.forEach((row, i) => {
    // Personal rows always render through the normal card (keeping their
    // Personal/Undo treatment) even if also flagged as a duplicate.
    const isPersonalRow = !!(row.skip && row.reason === 'personal');
    (row.isDuplicate && !isPersonalRow ? dupItems : newItems).push({ row, i });
  });

  const dupSection = dupItems.length
    ? `<div style="font-size:12px;font-weight:600;color:var(--muted-2);margin:2px 16px 6px">Already logged — skipped (${dupItems.length})</div>` +
      dupItems.map(({ row, i }) => renderAlreadyLoggedCard(row, i)).join('')
    : '';

  const newImportable = newItems.filter(({ row }) => canBankImportRow(row)).length;
  const newHeader = dupItems.length
    ? `<div style="font-size:12px;font-weight:600;color:var(--muted-2);margin:16px 16px 6px">New — to import (${newImportable})</div>`
    : '';
  const newSection = newHeader + newItems.map(({ row, i }) => renderReviewCard(row, i)).join('');

  container.innerHTML = headerHtml + `<div id="bank-import-list">${dupSection}${newSection}</div>`;

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
      // Prefer the specific reason the parser recorded over the generic advice,
      // so a failed import says WHAT broke instead of leaving the host guessing.
      const why = typeof getBankImportError === 'function' ? getBankImportError() : '';
      globalThis.showBanner(
        why
          ? 'Import failed: ' + why
          : (useAI
            ? 'AI did not find transactions in that file — try a clearer PDF/screenshot, or use a CSV export'
            : 'No expense transactions found — check the file format (CSV or tab-delimited)'),
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

  // Drop any reason recorded by a previous attempt so a fresh failure can't be
  // reported with a stale explanation.
  if (typeof resetBankImportError === 'function') resetBankImportError();

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

// Override an "already logged" flag — treat the row as a fresh line to categorise.
function bankImportImportAnyway(i) {
  const row = _bankImportRows[i];
  if (!row) return;
  row.isDuplicate = false;
  if (row.reason === 'already imported') row.reason = null;
  row.dupMatch = null;
  renderBankImportReview();
}
globalThis.bankImportImportAnyway = bankImportImportAnyway;

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

// ── Consumed directly (not via window) by finance.js, the barrel ─────────────
export {
  ensureBankImportToolbar,
  ensureBankImportToolbarPortfolio,
  refreshFinanceReconciliationSummary,
  bankImportFormatCategoryLabel,   // barrel's expense-category owner/deduct config
  BANK_IMPORT_EXPENSE_CATS,        // ditto
};
// (_bankImportReviewActive is exported at its declaration via `export let`.)

// ── Global bridges relocated here from finance.js's bridge block (names stable).
//    The chapter's own 5 bridges remain inline above. ─────────────────────────
globalThis.exitBankImportReview = exitBankImportReview;
globalThis.bankImportCancelLoad = bankImportRestoreBackup;
globalThis.bankImportOnPropChange = bankImportOnPropChange;
globalThis.bankImportOnCatChange = bankImportOnCatChange;
globalThis.bankImportSkipRow = bankImportSkipRow;
globalThis.bankImportPersonalRow = bankImportPersonalRow;
globalThis.bankImportConfirmAllSuggested = bankImportConfirmAllSuggested;
globalThis.bankImportRunImport = bankImportRunImport;
globalThis.bankImportPickFile = () => getOrCreateBankCsvFileInput().click();
