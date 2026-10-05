/**
 * StayOps — Finance → Bank. The one bank screen.
 *
 * Replaces Transaction Map (match debits to expenses, credits to payouts) and
 * Reconcile (tick every row, type a closing balance). One list, one rule:
 * every line gets a KIND and, where one exists, a LINK. The month is done when
 * "To decide" is empty and the statement balance agrees with the lines.
 *
 * Money out is blunt on purpose: every payment IS an expense. The engine books
 * it as one the moment it lands, with its best guess at the category; the host
 * only ever flips the exceptions (owner funds, a transfer, personal).
 *
 * Deciding lives in bank-explain.js (pure, tested). Reading and writing lives
 * in supabase-bank-lines.js. This file is state, rendering and the handlers
 * behind the inline-onclick API. It imports no finance module, so finance.js
 * can import it without a cycle (see finance-shared.js for the split rules).
 */
import { escHtml, fyLabel, fyMonths, fyOfDate, fyBounds, localDateStr, escapeJsSingleQuotedHtmlAttr, fadeTransition } from './utils.js';
import {
  explainLines, kindsForDirection, kindLabel, counterpartyKey, memoryKey, summariseLines,
  BANK_FEES_CATEGORY, NEUTRAL_KINDS,
} from './bank-explain.js';
import { toCents, centsToAmount } from './money-in-model.js';
import { computePeriodReconcile, explainOutOfBalance } from './reconcile-period.js';
import {
  loadBankAccounts, getOrCreateDefaultBankAccount, loadPlatformPayouts,
  loadBankLines, attachBankLineLinks, updateBankLine,
  loadBankMemory, rememberBankDecision, seedBankMemory,
  loadBankImportBatches, updateBankImportBatch,
  loadExpensesInRange, loadBookingsInRange, createExpenseFromBankLine, updateExpenseFields,
  linkBankLineToExpense, unlinkBankLineExpense, markExpensesPaidVia,
  loadBankLocks, lockBankPeriod, unlockBankPeriod,
} from './supabase.js';
import { linkTransactionToPayout, unlinkPayoutFromTransaction } from './reconciliation.js';
import { loadExpensesFromCloud } from './supabase-expenses.js';
import { expenses, replaceArrayInPlace } from './state.js';
import { getAllProperties, getActivePropertyConfig } from './config.js';
import { AIService } from './ai-logic.js';

const FONT = "font-family:'Plus Jakarta Sans',sans-serif";
const money = n => Math.abs(Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const FILTERS = [
  ['decide', 'To decide'],
  ['in', 'Money in'],
  ['out', 'Money out'],
  ['payouts', 'Payouts'],
  ['refunds', 'Refunds'],
  ['owner', 'Owner'],
  ['personal', 'Personal'],
  ['all', 'All'],
];

// ── State ─────────────────────────────────────────────────────────────────────
let _acct = null;
let _accounts = [];
let _fy = null;          // financial year, by starting year
let _month = null;       // 'YYYY-MM' inside the FY, or null for the whole year
let _filter = 'decide';
let _lines = [];         // every line of the FY, newest first, with links
let _payouts = [];       // every platform payout (ghost rows + candidates)
let _memory = new Map();
let _batches = [];       // import batches overlapping the FY
let _locks = [];
let _sheet = null;       // the open "What is this?" sheet
let _busy = false;
let _rawOpen = new Set();
let _lastSummary = null; // last import / explain result, shown once

// ── Small helpers ─────────────────────────────────────────────────────────────

function _banner(msg, kind) {
  if (typeof globalThis.showBanner === 'function') globalThis.showBanner(msg, kind || 'ok');
}

function _properties() {
  let list;
  try { list = getAllProperties() || []; } catch (_) { list = []; }
  return list.filter(p => p && p.supabaseId).map(p => ({ id: String(p.supabaseId), name: p.name || 'Property', ownerName: (p.owner && p.owner.name) || p.ownerName || '' }));
}

function _defaultPropertyId() {
  try {
    const cfg = getActivePropertyConfig && getActivePropertyConfig();
    if (cfg && cfg.supabaseId) return String(cfg.supabaseId);
  } catch (_) { /* fall through */ }
  const props = _properties();
  return props.length ? props[0].id : null;
}

function _propertyName(id) {
  const p = _properties().find(x => x.id === String(id || ''));
  return p ? p.name : '';
}

function _ownerNames() {
  const names = [];
  for (const p of _properties()) if (p.ownerName) names.push(p.ownerName);
  const host = window._hostProfile || {};
  if (host.name) names.push(host.name);
  if (host.company) names.push(host.company);
  return names;
}

function _categories() {
  let cats;
  try { cats = typeof globalThis.getExpenseCats === 'function' ? (globalThis.getExpenseCats() || []) : []; } catch (_) { cats = []; }
  cats = cats.slice();
  if (!cats.includes(BANK_FEES_CATEGORY)) cats.push(BANK_FEES_CATEGORY);
  if (!cats.includes('Other')) cats.push('Other');
  return cats;
}

function _titleCase(s) {
  return String(s || '').toLowerCase().replace(/(^|[\s.-])([a-z])/g, (m, pre, ch) => pre + ch.toUpperCase());
}

/** The visible period as { from, to }. The year branch MUST translate
 *  fyBounds' { start, end } — passing it through unchanged left every line
 *  failing `date >= undefined`, so "Year" showed an empty list over 209 rows. */
function _range() {
  if (_month) {
    const [y, m] = _month.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    return { from: `${y}-${String(m).padStart(2, '0')}-01`, to: `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}` };
  }
  const b = fyBounds(_fy);
  return { from: b.start, to: b.end };
}

function _rangeLabel() {
  if (_month) {
    const [y, m] = _month.split('-').map(Number);
    return MONTH_LONG[m - 1] + ' ' + y;
  }
  return fyLabel(_fy);
}

function _inRange(date, r) {
  return date >= r.from && date <= r.to;
}

function _scopedLines() {
  const r = _range();
  return _lines.filter(l => _inRange(l.date, r));
}

function _lockFor(r) {
  return _locks.find(k => k.periodStart <= r.from && k.periodEnd >= r.to) || null;
}

function _isLocked(line) {
  return _locks.some(k => line.date >= k.periodStart && line.date <= k.periodEnd);
}

function _toDecide(line) {
  return !line.kind || line.needsReview;
}

function _addDaysIso(iso, n) {
  const d = new Date(String(iso) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function _refreshExpensesInMemory() {
  try {
    const rows = await loadExpensesFromCloud();
    if (Array.isArray(rows)) replaceArrayInPlace(expenses, rows);
  } catch (e) { console.warn('[StayOps] Bank: expense refresh failed', e); }
}

// ── Loading ───────────────────────────────────────────────────────────────────

export async function showBankView(opts = {}) {
  // Apply the requested year/month first: showFinanceSub('bank') runs
  // initBankView() itself, so setting state afterwards would load twice.
  if (opts.fy != null) { _fy = Number(opts.fy); _month = opts.month === undefined ? null : opts.month; }
  else if (opts.month !== undefined) _month = opts.month;
  const navigate = globalThis.showFinanceSub;
  if (typeof navigate === 'function') navigate('bank');
  else await initBankView();
}

export async function initBankView(opts = {}) {
  const host = document.getElementById('finance-bank-content');
  if (!host) return;
  host.innerHTML = `<div style="padding:24px;text-align:center;color:var(--muted-2);font-size:13px;${FONT}">Loading…</div>`;
  _accounts = await loadBankAccounts();
  if (!_accounts.length) {
    const created = await getOrCreateDefaultBankAccount();
    if (created) _accounts = [created];
  }
  if (!_accounts.length) {
    host.innerHTML = `<div style="padding:24px;text-align:center;color:var(--muted-2);font-size:13px;${FONT}">Sign in to see your bank lines.</div>`;
    return;
  }
  _acct = _acct && _accounts.find(a => a._cloudId === _acct._cloudId) ? _acct : (_accounts.find(a => a.isDefault) || _accounts[0]);
  if (opts.fy != null) { _fy = Number(opts.fy); _month = opts.month === undefined ? null : opts.month; }
  else if (opts.month !== undefined) _month = opts.month;
  const firstOpen = _fy == null;
  if (firstOpen) {
    _fy = fyOfDate(localDateStr());
    _month = localDateStr().slice(0, 7);
  }
  await _loadYear();
  // On first open, land on the latest month that has lines rather than an
  // empty current month: the statement is usually a few weeks behind today.
  if (firstOpen && _month && !_lines.some(l => l.date.slice(0, 7) === _month)) {
    const latest = _lines.map(l => l.date.slice(0, 7)).sort().pop();
    _month = latest || _month;
  }
  _render();
}

async function _loadYear() {
  const r = fyBounds(_fy);
  const [lines, payouts, memory, batches, locks] = await Promise.all([
    loadBankLines({ accountId: _acct._cloudId, from: r.start, to: r.end }),
    loadPlatformPayouts(),
    loadBankMemory(),
    loadBankImportBatches({ accountId: _acct._cloudId, from: r.start, to: r.end }),
    loadBankLocks(_acct._cloudId),
  ]);
  _lines = lines;
  _payouts = payouts;
  _memory = memory;
  _batches = batches;
  _locks = locks;
  if (!_memory.size) await _seedMemoryFromHistory();
}

/** First run only: the links that existed before kinds did become memory, so
 *  the thirteenth mortgage payment is explained by the first twelve. */
async function _seedMemoryFromHistory() {
  try {
    const all = await loadBankLines({ accountId: _acct._cloudId });
    const agg = new Map();
    for (const l of all) {
      if (!l.kind || l.needsReview) continue;
      if (l.kind === 'expense' && !l.expense) continue;
      const key = l.counterparty || counterpartyKey(l.description);
      if (!key) continue;
      const k = memoryKey(l.direction, key);
      let e = agg.get(k);
      if (!e) { e = { counterpartyKey: key, direction: l.direction, kind: l.kind, cats: new Map(), props: new Map(), platforms: new Map(), timesUsed: 0 }; agg.set(k, e); }
      if (e.kind !== l.kind) continue;
      e.timesUsed += 1;
      if (l.expense) {
        if (l.expense.category) e.cats.set(l.expense.category, (e.cats.get(l.expense.category) || 0) + 1);
        if (l.expense.propertyId) e.props.set(l.expense.propertyId, (e.props.get(l.expense.propertyId) || 0) + 1);
      }
      for (const p of l.payouts) if (p.platform) e.platforms.set(p.platform, (e.platforms.get(p.platform) || 0) + 1);
    }
    const top = m => { let best = null, n = 0; for (const [k, v] of m) if (v > n) { best = k; n = v; } return best; };
    const rows = [...agg.values()].map(e => ({
      counterpartyKey: e.counterpartyKey, direction: e.direction, kind: e.kind,
      category: top(e.cats), propertyId: top(e.props), platform: top(e.platforms), timesUsed: e.timesUsed,
    }));
    if (rows.length) {
      await seedBankMemory(rows);
      _memory = await loadBankMemory();
    }
  } catch (e) { console.warn('[StayOps] Bank: memory seed failed', e); }
}

async function _refreshLine(id) {
  const known = _lines.find(l => String(l.id) === String(id));
  const fresh = await loadBankLines({ accountId: _acct._cloudId, from: known ? known.date : null, to: known ? known.date : null, withLinks: false });
  const row = fresh.find(l => String(l.id) === String(id));
  if (!row) return null;
  await attachBankLineLinks([row]);
  const idx = _lines.findIndex(l => String(l.id) === String(id));
  if (idx >= 0) _lines[idx] = row; else _lines.push(row);
  return row;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function _render() {
  const host = document.getElementById('finance-bank-content');
  if (!host) return;
  const scoped = _scopedLines();
  const s = summariseLines(scoped);
  const r = _range();
  const lock = _lockFor(r);
  host.innerHTML = `
    <div style="padding:0 16px 24px;${FONT}">
      ${_headerHtml()}
      ${_balanceCardHtml(scoped, lock)}
      ${_tilesHtml(s)}
      ${_actionsHtml(scoped, s, lock)}
      ${_filtersHtml(scoped)}
      <div id="bank-list">${_listHtml(scoped)}</div>
    </div>
    ${_sheet ? _sheetHtml() : ''}`;
  const hubCount = document.getElementById('finance-hub-count-bank');
  if (hubCount) hubCount.textContent = s.toDecide ? `${s.toDecide} to decide` : 'All lines explained';
}

function _headerHtml() {
  const acctPicker = _accounts.length > 1
    ? `<select onchange="bankSetAccount(this.value)" style="font-size:12px;margin-bottom:8px">${_accounts.map(a => `<option value="${escHtml(a._cloudId)}" ${a._cloudId === _acct._cloudId ? 'selected' : ''}>${escHtml(a.name)}</option>`).join('')}</select>`
    : '';
  const months = fyMonths(_fy).map(({ year, month }) => {
    const key = `${year}-${String(month + 1).padStart(2, '0')}`;
    const on = _month === key;
    const n = _lines.filter(l => l.date.slice(0, 7) === key && _toDecide(l)).length;
    const has = _lines.some(l => l.date.slice(0, 7) === key);
    return `<button onclick="bankSetMonth('${key}')" style="flex:0 0 auto;font-size:12px;padding:5px 10px;border-radius:999px;cursor:pointer;${FONT};border:1px solid ${on ? 'var(--primary)' : 'var(--hairline-1)'};background:${on ? 'var(--primary)' : '#fff'};color:${on ? '#fff' : has ? 'var(--ink-1)' : 'var(--muted-2)'};position:relative">${MONTH_SHORT[month]}${n ? `<span style="margin-left:4px;font-size:10px;font-weight:700;color:${on ? '#fff' : '#E65100'}">${n}</span>` : ''}</button>`;
  }).join('');
  const allOn = !_month;
  return `
    ${acctPicker}
    <div style="display:flex;align-items:center;justify-content:space-between;margin:6px 0 10px">
      <button onclick="bankSetFY(${_fy - 1})" style="background:none;border:none;cursor:pointer;padding:4px;font-size:16px;color:var(--ink-2)">‹</button>
      <div style="font-family:'Newsreader',serif;font-size:22px;font-weight:600;color:var(--ink-1)">${escHtml(fyLabel(_fy))}</div>
      <button onclick="bankSetFY(${_fy + 1})" style="background:none;border:none;cursor:pointer;padding:4px;font-size:16px;color:var(--ink-2)">›</button>
    </div>
    <div style="display:flex;gap:6px;overflow-x:auto;padding-bottom:6px;margin-bottom:8px;-webkit-overflow-scrolling:touch">
      <button onclick="bankSetMonth('')" style="flex:0 0 auto;font-size:12px;padding:5px 10px;border-radius:999px;cursor:pointer;${FONT};border:1px solid ${allOn ? 'var(--primary)' : 'var(--hairline-1)'};background:${allOn ? 'var(--primary)' : '#fff'};color:${allOn ? '#fff' : 'var(--ink-1)'}">Year</button>
      ${months}
    </div>`;
}

function _balanceCardHtml(scoped, lock) {
  if (!_month) {
    return lock
      ? `<div style="background:#E8F5E9;border:1px solid #C8E6C9;border-radius:12px;padding:10px 12px;margin-bottom:10px;font-size:12.5px;color:#2E7D32">🔒 ${escHtml(fyLabel(_fy))} is closed${lock.notes ? ' · ' + escHtml(lock.notes) : ''}. <a onclick="bankUnlock('${escHtml(lock.id)}')" style="color:#2E7D32;text-decoration:underline;cursor:pointer">Unlock</a></div>`
      : '';
  }
  const r = _range();
  const batches = _batches.filter(b => b.periodStart <= r.to && b.periodEnd >= r.from);
  const first = batches[0] || null;
  const last = batches[batches.length - 1] || null;
  const opening = first && first.openingBalance != null ? first.openingBalance : null;
  const closing = last && last.closingBalance != null ? last.closingBalance : null;
  const credits = scoped.filter(l => l.direction === 'credit').reduce((s, l) => s + toCents(l.amount), 0);
  const debits = scoped.filter(l => l.direction === 'debit').reduce((s, l) => s + toCents(l.amount), 0);
  const lockLine = lock
    ? `<div style="font-size:12px;color:#2E7D32;margin-top:8px">🔒 Locked${lock.closedAt ? ' on ' + escHtml(String(lock.closedAt).slice(0, 10)) : ''} · <a onclick="bankUnlock('${escHtml(lock.id)}')" style="color:#2E7D32;text-decoration:underline;cursor:pointer">Unlock</a></div>`
    : '';
  const movement = `<div style="display:flex;justify-content:space-between;font-size:12.5px;color:var(--muted-2);margin-top:4px"><span>In +$${money(centsToAmount(credits))}</span><span>Out −$${money(centsToAmount(debits))}</span><span>${scoped.length} line${scoped.length === 1 ? '' : 's'}</span></div>`;
  if (opening == null || closing == null) {
    const target = last ? last.id : null;
    return `<div style="background:#fff;border:1px solid var(--hairline-1);border-radius:12px;padding:12px 14px;margin-bottom:10px">
      <div style="font-size:11px;font-weight:700;color:var(--muted-2);text-transform:uppercase;letter-spacing:.4px">Balance check</div>
      ${movement}
      ${target
        ? `<div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap">
             <span style="font-size:12px;color:var(--muted-2)">Statement balances for this month</span>
             <input id="bank-opening-input" type="number" step="0.01" placeholder="Opening" value="${opening == null ? '' : opening.toFixed(2)}" style="width:110px;font-size:12px">
             <input id="bank-closing-input" type="number" step="0.01" placeholder="Closing" value="${closing == null ? '' : closing.toFixed(2)}" style="width:110px;font-size:12px">
             <button onclick="bankSaveBalances('${escHtml(target)}')" style="font-size:12px;padding:5px 10px;border-radius:8px;border:1px solid var(--primary);background:#fff;color:var(--primary);cursor:pointer;${FONT}">Save</button>
           </div>`
        : `<div style="font-size:12px;color:var(--muted-2);margin-top:6px">Load this month's statement to check the balance.</div>`}
      ${lockLine}
    </div>`;
  }
  const res = computePeriodReconcile({
    openingBalanceCents: toCents(opening),
    statementClosingCents: toCents(closing),
    transactions: scoped.map(l => ({ id: l.id, amount: l.amount, direction: l.direction, cleared: true })),
  });
  const ok = res.balanced;
  const hints = ok ? [] : explainOutOfBalance(res.outOfBalanceCents, scoped.map(l => ({ ...l, importBatchId: l.importBatchId })), _payouts.filter(p => !p.bankTransactionId));
  return `<div style="background:${ok ? '#E8F5E9' : '#FFF8E1'};border:1px solid ${ok ? '#C8E6C9' : '#FFE082'};border-radius:12px;padding:12px 14px;margin-bottom:10px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
      <div>
        <div style="font-size:11px;font-weight:700;color:${ok ? '#2E7D32' : '#E65100'};text-transform:uppercase;letter-spacing:.4px">${ok ? 'Balance agrees' : 'Out of balance'}</div>
        <div style="font-size:12.5px;color:var(--ink-1);margin-top:3px">Statement closing $${money(closing)} · from your lines $${money(centsToAmount(res.calculatedClosingCents))}</div>
      </div>
      <div style="font-size:20px;font-weight:800;color:${ok ? '#2E7D32' : '#C62828'}">${ok ? '✓' : '$' + money(centsToAmount(Math.abs(res.outOfBalanceCents)))}</div>
    </div>
    ${movement}
    ${hints.length ? `<div style="font-size:12px;color:#5D4037;margin-top:6px">${escHtml(hints[0].message)}</div>` : ''}
    ${lockLine}
  </div>`;
}

function _tilesHtml(s) {
  const tile = (val, label, bg, color, sub, onclick) =>
    `<div onclick="${onclick}" style="flex:1;min-width:96px;background:${bg};border-radius:10px;padding:8px 10px;text-align:center;cursor:pointer">
       <div style="font-size:17px;font-weight:700;color:${color}">${val}</div>
       <div style="font-size:11px;color:${color};opacity:.85">${label}${sub ? ' · ' + sub : ''}</div>
     </div>`;
  return `<div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
    ${tile(s.toDecide, 'To decide', s.toDecide ? '#FFF3E0' : '#E8F5E9', s.toDecide ? '#E65100' : '#2E7D32', s.toDecide ? '$' + money(centsToAmount(s.toDecideCents)) : 'none', "bankSetFilter('decide')")}
    ${tile('$' + money(centsToAmount(s.inCents)), 'Money in', '#E3F2FD', '#1565C0', s.explainedIn + ' explained', "bankSetFilter('in')")}
    ${tile('$' + money(centsToAmount(s.outCents)), 'Money out', '#F5F3EF', 'var(--ink-1)', s.explainedOut + ' explained', "bankSetFilter('out')")}
  </div>`;
}

function _actionsHtml(scoped, s, lock) {
  const btn = (onclick, label, primary) =>
    `<button onclick="${onclick}" ${_busy ? 'disabled' : ''} style="font-size:12px;font-weight:600;padding:7px 12px;border-radius:999px;cursor:pointer;${FONT};border:1px solid var(--primary);background:${primary ? 'var(--primary)' : '#fff'};color:${primary ? '#fff' : 'var(--primary)'};white-space:nowrap">${label}</button>`;
  const suggested = scoped.filter(l => l.kind && l.needsReview).length;
  const undecided = scoped.filter(l => !l.kind).length;
  const pastYear = !_month && _fy < fyOfDate(localDateStr());
  const out = [];
  out.push(btn('bankLoadStatement()', 'Load statement'));
  out.push(btn('bankPasteStatement()', 'Paste payout statement'));
  if (!lock) {
    if (undecided || suggested) out.push(btn('bankExplainAll()', `Explain ${undecided + suggested} line${undecided + suggested === 1 ? '' : 's'}`));
    if (suggested) out.push(btn('bankConfirmSuggested()', `Confirm ${suggested} suggested`, true));
    if (pastYear) out.push(btn('bankBulkMarkYear()', `Mark ${fyLabel(_fy)} as done`, !s.toDecide));
    else if (_month && !s.toDecide && scoped.length) out.push(btn('bankLockPeriod()', 'Lock ' + _rangeLabel().split(' ')[0], true));
  }
  const summary = _lastSummary ? `<div style="font-size:12.5px;color:#2E7D32;background:#E8F5E9;border-radius:8px;padding:6px 10px;margin-bottom:8px">${escHtml(_lastSummary)}</div>` : '';
  return summary + `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">${out.join('')}</div>`;
}

function _filtersHtml(scoped) {
  const counts = {
    decide: scoped.filter(_toDecide).length,
    in: scoped.filter(l => l.direction === 'credit').length,
    out: scoped.filter(l => l.direction === 'debit').length,
    payouts: scoped.filter(l => l.kind === 'platform_payout').length,
    refunds: scoped.filter(l => l.kind === 'expense_refund' || l.kind === 'guest_refund').length,
    owner: scoped.filter(l => l.kind === 'owner_funds' || l.kind === 'transfer').length,
    personal: scoped.filter(l => l.kind === 'personal').length,
    all: scoped.length,
  };
  return `<div style="display:flex;gap:6px;overflow-x:auto;padding-bottom:6px;margin-bottom:6px;-webkit-overflow-scrolling:touch">` +
    FILTERS.map(([key, label]) => {
      const on = _filter === key;
      return `<button onclick="bankSetFilter('${key}')" style="flex:0 0 auto;font-size:12px;padding:5px 11px;border-radius:999px;cursor:pointer;${FONT};border:1px solid ${on ? 'var(--primary)' : 'var(--hairline-1)'};background:${on ? 'var(--primary)' : '#fff'};color:${on ? '#fff' : 'var(--muted-2)'}">${label}${counts[key] ? ` <span style="opacity:.8">${counts[key]}</span>` : ''}</button>`;
    }).join('') + `</div>`;
}

function _filtered(scoped) {
  switch (_filter) {
    case 'decide': return scoped.filter(_toDecide);
    case 'in': return scoped.filter(l => l.direction === 'credit');
    case 'out': return scoped.filter(l => l.direction === 'debit');
    case 'payouts': return scoped.filter(l => l.kind === 'platform_payout');
    case 'refunds': return scoped.filter(l => l.kind === 'expense_refund' || l.kind === 'guest_refund');
    case 'owner': return scoped.filter(l => l.kind === 'owner_funds' || l.kind === 'transfer');
    case 'personal': return scoped.filter(l => l.kind === 'personal');
    default: return scoped;
  }
}

function _explanationText(l) {
  if (!l.kind) return '';
  const label = kindLabel(l.kind, l.direction);
  if (l.kind === 'expense') {
    if (l.expense) return `${label} → ${l.expense.merchant || l.expense.vendor || 'expense'} · ${l.expense.category || 'no category'}`;
    return label + ' · not booked yet';
  }
  if (l.kind === 'expense_refund') {
    if (l.expense) return `Refund → ${l.expense.merchant || 'credit note'} · ${l.expense.category || ''}`;
    return label;
  }
  if (l.kind === 'platform_payout') {
    if (l.payouts.length) {
      const p = l.payouts[0];
      const more = l.payouts.length > 1 ? ` +${l.payouts.length - 1}` : '';
      return `${(p.platform || 'platform').replace('_', '.')} payout → statement ${p.payoutDate || ''}${p.reference ? ' · ' + p.reference : ''}${more}`;
    }
    return label + ' · no statement pasted';
  }
  if ((l.kind === 'direct_booking' || l.kind === 'guest_refund') && l.booking) {
    return `${label} → ${l.booking.guestName || 'booking'} ${l.booking.checkin || ''}`;
  }
  return label;
}

function _rowHtml(l) {
  const id = escapeJsSingleQuotedHtmlAttr(String(l.id));
  const credit = l.direction === 'credit';
  const decide = _toDecide(l);
  const chipBg = !l.kind ? '#FFF3E0' : decide ? '#FFF8E1' : NEUTRAL_KINDS.has(l.kind) ? '#F3E5F5' : credit ? '#E3F2FD' : '#E8F5E9';
  const chipColor = !l.kind ? '#E65100' : decide ? '#8D6E00' : NEUTRAL_KINDS.has(l.kind) ? '#7B1FA2' : credit ? '#1565C0' : '#2E7D32';
  const chipText = !l.kind ? 'Not decided' : (decide ? (l.kind === 'expense' && l.expense ? 'Check category' : 'Suggested') + ' · ' : '') + _explanationText(l);
  const source = l.kind && !decide
    ? `<span style="font-size:10px;color:var(--muted-2);margin-left:6px">${l.kindSource === 'manual' ? 'you' : l.kindSource === 'bulk' ? 'bulk' : 'auto'}</span>` : '';
  const title = l.counterparty ? _titleCase(l.counterparty) : (l.description || 'No description');
  const raw = _rawOpen.has(String(l.id))
    ? `<div style="font-size:11px;color:var(--muted-2);margin-top:2px;word-break:break-word">${escHtml(l.description)}</div>` : '';
  const locked = _isLocked(l) ? '<span style="font-size:10px;margin-left:4px" title="Locked">🔒</span>' : '';
  return `<div onclick="bankOpenSheet('${id}')" style="background:#fff;border:1px solid var(--hairline-1);border-left:3px solid ${chipColor};border-radius:12px;padding:10px 12px;margin-bottom:8px;cursor:pointer;${FONT}">
    <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
      <div style="min-width:0;flex:1">
        <div style="font-size:11px;color:var(--muted-2)">${escHtml(l.date)}${locked}</div>
        <div style="font-size:13.5px;font-weight:600;color:var(--ink-1);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" onclick="event.stopPropagation();bankToggleRaw('${id}')" title="Tap for the bank's wording">${escHtml(title)}</div>
        ${raw}
      </div>
      <div style="font-size:15px;font-weight:700;color:${credit ? '#2E7D32' : 'var(--ink-1)'};flex-shrink:0">${credit ? '+' : '−'}$${money(l.amount)}</div>
    </div>
    <div style="margin-top:6px;display:flex;align-items:center;flex-wrap:wrap;gap:4px">
      <span style="display:inline-block;font-size:11px;background:${chipBg};color:${chipColor};border-radius:6px;padding:2px 8px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(chipText)}</span>${source}
    </div>
  </div>`;
}

function _ghostPayoutsHtml() {
  if (_filter !== 'payouts') return '';
  const r = _range();
  const ghosts = _payouts.filter(p => !p.bankTransactionId && String(p.status || 'active') !== 'deleted'
    && _inRange(p.expectedArrivalDate || p.payoutDate || '', r));
  if (!ghosts.length) return '';
  return `<div style="font-size:11px;font-weight:700;color:var(--muted-2);text-transform:uppercase;letter-spacing:.4px;margin:14px 0 6px">Statements with no deposit yet · ${ghosts.length}</div>` +
    ghosts.map(p => `<div style="background:#fff;border:1px dashed #FFB74D;border-radius:12px;padding:10px 12px;margin-bottom:8px;${FONT};opacity:.9">
      <div style="display:flex;justify-content:space-between;gap:10px">
        <div style="min-width:0;flex:1">
          <div style="font-size:11px;color:var(--muted-2)">${escHtml(p.expectedArrivalDate || p.payoutDate || '')}</div>
          <div style="font-size:13.5px;font-weight:600;color:var(--ink-1)">${escHtml((p.platform || 'platform').replace('_', '.'))} statement${p.payoutReference ? ' · ' + escHtml(p.payoutReference) : ''}</div>
        </div>
        <div style="font-size:15px;font-weight:700;color:#E65100">$${money(p.net)}</div>
      </div>
      <div style="margin-top:6px"><span style="display:inline-block;font-size:11px;background:#FFF3E0;color:#E65100;border-radius:6px;padding:2px 8px">Not received — no deposit matches yet</span></div>
    </div>`).join('');
}

function _listHtml(scoped) {
  const rows = _filtered(scoped);
  const ghosts = _ghostPayoutsHtml();
  if (!rows.length && !ghosts) {
    const msg = !scoped.length
      ? 'No bank lines for ' + _rangeLabel() + ' yet. Load a statement to begin.'
      : _filter === 'decide' ? 'Nothing to decide — every line in ' + _rangeLabel() + ' is explained.' : 'Nothing under this filter.';
    return `<div style="text-align:center;padding:28px 16px;color:var(--muted-2);font-size:13px">${escHtml(msg)}</div>`;
  }
  return rows.map(_rowHtml).join('') + ghosts;
}

// ── The "What is this?" sheet ─────────────────────────────────────────────────

function _sheetHtml() {
  const s = _sheet;
  const l = s.line;
  const credit = l.direction === 'credit';
  const kinds = kindsForDirection(l.direction);
  const locked = _isLocked(l);
  const kindBtn = k => {
    const on = s.kind === k;
    return `<button onclick="bankSheetPickKind('${k}')" style="font-size:12.5px;font-weight:600;padding:9px 8px;border-radius:10px;cursor:pointer;${FONT};border:1px solid ${on ? 'var(--primary)' : 'var(--hairline-1)'};background:${on ? 'var(--primary)' : '#fff'};color:${on ? '#fff' : 'var(--ink-1)'};text-align:left">${escHtml(kindLabel(k, l.direction))}</button>`;
  };
  const current = l.kind ? `<div style="font-size:12px;color:var(--muted-2);margin-top:2px">Now: ${escHtml(_explanationText(l))}${l.kindSource ? ' · ' + escHtml(l.kindSource) : ''}</div>` : '';
  return `<div id="bank-sheet-overlay" onclick="if(event.target===this)bankCloseSheet()" style="position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.4);display:flex;align-items:flex-end;justify-content:center">
    <div style="background:#fff;border-radius:16px 16px 0 0;width:100%;max-width:560px;max-height:86vh;overflow-y:auto;padding:16px 16px 28px;${FONT};animation:settingsPanelIn .28s cubic-bezier(0.32,0.72,0,1)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <div style="min-width:0">
          <div style="font-size:15px;font-weight:700;color:var(--primary)">What is this?</div>
          <div style="font-size:13px;color:var(--ink-1);margin-top:4px;word-break:break-word"><strong>${credit ? '+' : '−'}$${money(l.amount)}</strong> · ${escHtml(l.date)}</div>
          <div style="font-size:11.5px;color:var(--muted-2);margin-top:2px;word-break:break-word">${escHtml(l.description)}</div>
          ${current}
        </div>
        <button onclick="bankCloseSheet()" style="width:28px;height:28px;border-radius:50%;border:none;background:var(--surface2);font-size:16px;cursor:pointer;color:var(--muted-2);flex-shrink:0">×</button>
      </div>
      ${locked ? `<div style="font-size:12px;color:#2E7D32;background:#E8F5E9;border-radius:8px;padding:6px 10px;margin-top:10px">🔒 This period is locked. Unlock it from the balance card to change this line.</div>` : ''}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:12px">${kinds.map(kindBtn).join('')}</div>
      <div id="bank-sheet-context" style="margin-top:12px">${_sheetContextHtml()}</div>
      <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--ink-1);margin-top:12px;cursor:pointer">
        <input type="checkbox" ${s.remember ? 'checked' : ''} onchange="bankSheetToggleRemember(this.checked)"> Remember this for <strong>${escHtml(_titleCase(l.counterparty || counterpartyKey(l.description)) || 'this payee')}</strong>
      </label>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button onclick="bankSheetApply()" ${(!s.kind || locked || _busy) ? 'disabled' : ''} style="flex:1;padding:12px;border-radius:10px;border:none;background:${(!s.kind || locked) ? 'var(--hairline-1)' : 'var(--primary)'};color:${(!s.kind || locked) ? 'var(--muted-2)' : '#fff'};font-size:13.5px;font-weight:700;cursor:pointer;${FONT}">${s.kind ? 'Save as ' + escHtml(kindLabel(s.kind, l.direction)) : 'Pick a kind'}</button>
        ${l.kind && !locked ? `<button onclick="bankUndoLine('${escapeJsSingleQuotedHtmlAttr(String(l.id))}')" style="padding:12px;border-radius:10px;border:1px solid var(--hairline-1);background:#fff;color:var(--muted-2);font-size:12.5px;cursor:pointer;${FONT}">Undo</button>` : ''}
      </div>
    </div>
  </div>`;
}

function _candidateRow(onclick, selected, title, sub, right) {
  return `<div onclick="${onclick}" style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:9px 10px;border:1px solid ${selected ? 'var(--primary)' : 'var(--hairline-1)'};background:${selected ? 'var(--primary-soft,#dde8e1)' : '#fff'};border-radius:10px;margin-bottom:6px;cursor:pointer">
    <div style="min-width:0;flex:1">
      <div style="font-size:13px;font-weight:600;color:var(--ink-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${title}</div>
      <div style="font-size:11.5px;color:var(--muted-2);margin-top:1px">${sub}</div>
    </div>
    <div style="flex-shrink:0;font-size:12px;font-weight:600;color:${selected ? 'var(--primary)' : 'var(--muted-2)'}">${right}</div>
  </div>`;
}

function _selects() {
  const s = _sheet;
  const cats = _categories();
  const props = _properties();
  const catSel = `<select onchange="bankSheetSetCategory(this.value)" style="flex:1;min-width:140px;font-size:12.5px"><option value="">Category…</option>${cats.map(c => `<option value="${escHtml(c)}" ${s.category === c ? 'selected' : ''}>${escHtml(c)}</option>`).join('')}</select>`;
  const propSel = props.length > 1
    ? `<select onchange="bankSheetSetProperty(this.value)" style="flex:1;min-width:120px;font-size:12.5px">${props.map(p => `<option value="${escHtml(p.id)}" ${String(s.propertyId || '') === p.id ? 'selected' : ''}>${escHtml(p.name)}</option>`).join('')}</select>`
    : '';
  return `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">${catSel}${propSel}</div>
    <input value="${escHtml(s.merchant || '')}" oninput="bankSheetSetMerchant(this.value)" placeholder="Merchant / payee" style="width:100%;margin-top:6px;font-size:12.5px">`;
}

function _sheetContextHtml() {
  const s = _sheet;
  const l = s.line;
  if (!s.kind) return `<div style="font-size:12.5px;color:var(--muted-2)">Pick what this line is. ${l.direction === 'debit' ? 'A payment is an expense unless it went to the owner, to another of your accounts, or was personal.' : 'A deposit is a payout, a refund, owner money, a transfer, interest or something else.'}</div>`;
  if (s.loading) return `<div style="font-size:12.5px;color:var(--muted-2)">Looking for matches…</div>`;
  const head = t => `<div style="font-size:11px;font-weight:700;color:var(--muted-2);text-transform:uppercase;letter-spacing:.4px;margin:4px 0 6px">${t}</div>`;

  if (s.kind === 'expense') {
    const cands = (s.candidates.expenses || []).filter(e => e.amount > 0 && !e.bankTransactionId);
    const list = cands.slice(0, 8).map(e => {
      const gap = Math.abs(toCents(e.amount)) - Math.abs(toCents(l.amount));
      const right = gap === 0 ? 'same amount' : (gap > 0 ? '+' : '−') + '$' + money(centsToAmount(Math.abs(gap)));
      return _candidateRow(`bankSheetPickExpense('${escapeJsSingleQuotedHtmlAttr(String(e.id))}')`, s.expenseId === e.id,
        escHtml(e.merchant || e.vendor || e.description || 'Expense'), `${escHtml(e.date)} · $${money(e.amount)} · ${escHtml(e.category || '')}`, right);
    }).join('');
    return `${head('Pays an expense you already recorded?')}
      ${_candidateRow("bankSheetPickExpense('')", !s.expenseId, 'No — book it as a new expense', 'Created from this line, with the category below', s.expenseId ? '' : '✓')}
      ${list || '<div style="font-size:12px;color:var(--muted-2);margin-bottom:6px">No unpaid expense within 15 days.</div>'}
      ${s.expenseId ? '' : _selects()}`;
  }
  if (s.kind === 'expense_refund') {
    const cands = (s.candidates.expenses || []).filter(e => e.amount > 0 && !e.refundOfExpenseId);
    const list = cands.slice(0, 8).map(e =>
      _candidateRow(`bankSheetPickExpense('${escapeJsSingleQuotedHtmlAttr(String(e.id))}')`, s.expenseId === e.id,
        escHtml(e.merchant || e.vendor || e.description || 'Expense'), `${escHtml(e.date)} · $${money(e.amount)} · ${escHtml(e.category || '')}`,
        Math.abs(toCents(e.amount)) === Math.abs(toCents(l.amount)) ? 'full refund' : 'part refund')).join('');
    return `${head('Which purchase does this refund?')}
      ${list || '<div style="font-size:12px;color:var(--muted-2);margin-bottom:6px">No purchase from this merchant in the last 6 months.</div>'}
      ${_candidateRow("bankSheetPickExpense('')", !s.expenseId, 'None of these — a standalone credit note', 'Reduces the category below', s.expenseId ? '' : '✓')}
      ${_selects()}`;
  }
  if (s.kind === 'platform_payout') {
    const cents = Math.abs(toCents(l.amount));
    const cands = _payouts.filter(p => !p.bankTransactionId && String(p.status || 'active') !== 'deleted'
      && Math.abs(Math.abs(toCents(p.net)) - cents) <= 100
      && Math.abs((new Date(l.date) - new Date(p.expectedArrivalDate || p.payoutDate || l.date)) / 86400000) <= 14);
    const list = cands.slice(0, 8).map(p =>
      _candidateRow(`bankSheetPickPayout('${escapeJsSingleQuotedHtmlAttr(String(p._cloudId))}')`, s.payoutId === p._cloudId,
        `${escHtml((p.platform || 'platform').replace('_', '.'))} statement${p.payoutReference ? ' · ' + escHtml(p.payoutReference) : ''}`,
        `${escHtml(p.payoutDate || '')}${p.expectedArrivalDate ? ' → ' + escHtml(p.expectedArrivalDate) : ''} · $${money(p.net)}`,
        Math.abs(toCents(p.net)) === cents ? 'exact' : 'close')).join('');
    const platSel = `<select onchange="bankSheetSetPlatform(this.value)" style="font-size:12.5px;margin-top:6px"><option value="">Platform…</option>${['airbnb', 'booking_com', 'vrbo', 'stayz', 'direct', 'other'].map(p => `<option value="${p}" ${s.platform === p ? 'selected' : ''}>${p.replace('_', '.')}</option>`).join('')}</select>`;
    return `${head('Which statement does it settle?')}
      ${list || '<div style="font-size:12px;color:var(--muted-2);margin-bottom:6px">No pasted statement within $1 and 14 days. You can paste it later; the deposit is still a payout.</div>'}
      ${_candidateRow("bankSheetPickPayout('')", !s.payoutId, 'No statement yet', 'Kept as a payout; link it when the statement is pasted', s.payoutId ? '' : '✓')}
      ${platSel}`;
  }
  if (s.kind === 'direct_booking' || s.kind === 'guest_refund') {
    const list = (s.candidates.bookings || []).slice(0, 10).map(b =>
      _candidateRow(`bankSheetPickBooking('${escapeJsSingleQuotedHtmlAttr(String(b.id))}')`, s.bookingId === b.id,
        escHtml(b.guestName || 'Booking'), `${escHtml(b.checkin || '')} → ${escHtml(b.checkout || '')} · $${money(b.hostPayout)}${b.platform ? ' · ' + escHtml(b.platform) : ''}`,
        Math.abs(toCents(b.hostPayout)) === Math.abs(toCents(l.amount)) ? 'same amount' : '')).join('');
    return `${head(s.kind === 'direct_booking' ? 'Which booking paid this?' : 'Which booking was refunded?')}
      ${list || '<div style="font-size:12px;color:var(--muted-2)">No bookings around this date.</div>'}`;
  }
  if (s.kind === 'owner_funds') {
    const props = _properties();
    const propSel = props.length > 1
      ? `<select onchange="bankSheetSetProperty(this.value)" style="font-size:12.5px;margin-top:6px"><option value="">Any property</option>${props.map(p => `<option value="${escHtml(p.id)}" ${String(s.propertyId || '') === p.id ? 'selected' : ''}>${escHtml(p.name)}</option>`).join('')}</select>`
      : '';
    return `<div style="font-size:12.5px;color:var(--muted-2)">${l.direction === 'credit' ? 'Money the owner (or you) put into the account. Shows on the owner statement as funds received; never counted as income.' : 'Money paid out to the owner (or drawn by you). Shows on the owner statement as paid to owner; never counted as a cost.'}</div>${propSel}`;
  }
  const notes = {
    transfer: 'Moved between your own accounts. Counts for nothing.',
    interest: l.direction === 'credit' ? 'Interest the bank paid, or an adjustment it made. Counted as other income.' : 'A bank adjustment.',
    other_income: 'Insurance payout, bond claim, rebate. Counted as other income.',
    personal: 'Not business. Left out of everything.',
  };
  return `<div style="font-size:12.5px;color:var(--muted-2)">${escHtml(notes[s.kind] || '')}</div>`;
}

async function _loadSheetCandidates() {
  const s = _sheet;
  const l = s.line;
  s.loading = true;
  _renderSheetContext();
  try {
    if (s.kind === 'expense') {
      const rows = await loadExpensesInRange(_addDaysIso(l.date, -15), _addDaysIso(l.date, 15));
      const cents = Math.abs(toCents(l.amount));
      rows.sort((a, b) => Math.abs(Math.abs(toCents(a.amount)) - cents) - Math.abs(Math.abs(toCents(b.amount)) - cents));
      s.candidates.expenses = rows;
    } else if (s.kind === 'expense_refund') {
      const rows = await loadExpensesInRange(_addDaysIso(l.date, -183), _addDaysIso(l.date, 1));
      const head = (l.counterparty || counterpartyKey(l.description)).split(' ')[0];
      const cents = Math.abs(toCents(l.amount));
      const score = e => {
        const words = `${e.merchant} ${e.vendor} ${e.description}`.toUpperCase();
        return (head && words.includes(head) ? 0 : 1) * 1e9 + (Math.abs(toCents(e.amount)) >= cents ? 0 : 1e8) + Math.abs(Math.abs(toCents(e.amount)) - cents);
      };
      rows.sort((a, b) => score(a) - score(b));
      s.candidates.expenses = rows;
      if (!s.expenseId && rows.length && head && `${rows[0].merchant} ${rows[0].vendor}`.toUpperCase().includes(head) && Math.abs(toCents(rows[0].amount)) >= cents) {
        s.expenseId = rows[0].id;
        s.category = s.category || rows[0].category || '';
        s.propertyId = s.propertyId || rows[0].propertyId || null;
      }
    } else if (s.kind === 'direct_booking' || s.kind === 'guest_refund') {
      s.candidates.bookings = await loadBookingsInRange(_addDaysIso(l.date, -45), _addDaysIso(l.date, 45));
    }
  } catch (e) { console.warn('[StayOps] Bank: candidates failed', e); }
  s.loading = false;
  _renderSheetContext();
}

function _renderSheetContext() {
  const el = document.getElementById('bank-sheet-context');
  if (el && _sheet) el.innerHTML = _sheetContextHtml();
}

// ── Applying a decision ───────────────────────────────────────────────────────

/**
 * Write one decision: links first, then the line, then memory.
 * d: { kind, category, propertyId, platform, expenseId, payoutId, bookingId,
 *      merchant, remember, source, confidence, needsReview }
 */
async function _applyDecision(line, d) {
  const kind = d.kind;
  if (!kind) return false;
  const credit = line.direction === 'credit';
  const isExpenseKind = kind === 'expense' || kind === 'expense_refund';

  // 1. The expense link: keep it only when it still describes this kind.
  const ex = line.expense;
  const sameTarget = !!ex && (
    (kind === 'expense' && ex.amount >= 0 && (!d.expenseId || String(d.expenseId) === String(ex.id))) ||
    (kind === 'expense_refund' && ex.amount < 0 && String(d.expenseId || '') === String(ex.refundOfExpenseId || ''))
  );
  if ((line.expenseId || ex) && !sameTarget) {
    if (!await unlinkBankLineExpense(line)) return false;
    line.expenseId = null; line.expense = null;
  }
  const createdHere = !!(ex && String(ex.localId || '').startsWith('bank-'));
  if (kind === 'expense') {
    if (sameTarget && createdHere) {
      await updateExpenseFields(ex.id, { category: d.category || ex.category || 'Other', propertyId: d.propertyId || ex.propertyId || null, merchant: d.merchant || null });
    } else if (!sameTarget) {
      if (d.expenseId) {
        if (!await linkBankLineToExpense(line.id, d.expenseId)) return false;
      } else {
        const created = await createExpenseFromBankLine(line, {
          category: d.category || 'Other',
          propertyId: d.propertyId || _defaultPropertyId(),
          merchant: d.merchant || _titleCase(line.counterparty || counterpartyKey(line.description)),
          amount: Math.abs(line.amount),
        });
        if (!created) return false;
      }
    }
  } else if (kind === 'expense_refund') {
    if (sameTarget) {
      await updateExpenseFields(ex.id, { category: d.category || ex.category || 'Other', propertyId: d.propertyId || ex.propertyId || null, merchant: d.merchant || null });
    } else {
      const created = await createExpenseFromBankLine(line, {
        category: d.category || 'Other',
        propertyId: d.propertyId || _defaultPropertyId(),
        merchant: d.merchant || _titleCase(line.counterparty || counterpartyKey(line.description)),
        description: 'Refund' + (d.originalLabel ? ' of ' + d.originalLabel : ''),
        amount: -Math.abs(line.amount),
        refundOfExpenseId: d.expenseId || null,
      });
      if (!created) return false;
    }
  }

  // 2. The payout link.
  const keepPayouts = kind === 'platform_payout' && (!d.payoutId || line.payouts.some(p => String(p.id) === String(d.payoutId)));
  if (line.payouts.length && !keepPayouts) {
    for (const p of line.payouts) await unlinkPayoutFromTransaction(p.id);
    line.payouts = [];
  }
  if (kind === 'platform_payout' && d.payoutId && !line.payouts.some(p => String(p.id) === String(d.payoutId))) {
    const res = await linkTransactionToPayout(line.id, d.payoutId, { bankDate: line.date });
    if (!res || !res.success) return false;
    const p = _payouts.find(x => String(x._cloudId) === String(d.payoutId));
    if (p) p.bankTransactionId = line.id;
  }

  // 3. The line itself.
  const key = line.counterparty || counterpartyKey(line.description);
  const needsReview = !!d.needsReview;
  const ok = await updateBankLine(line.id, {
    kind,
    kindSource: d.source || 'manual',
    kindConfidence: d.confidence == null ? 1 : d.confidence,
    needsReview,
    counterparty: key,
    bookingId: (kind === 'direct_booking' || kind === 'guest_refund') ? (d.bookingId || null) : null,
    reviewedAt: needsReview ? null : new Date().toISOString(),
    isPersonal: kind === 'personal',
    skipped: false,
  });
  if (!ok) return false;

  // 4. Memory.
  if (d.remember && key) {
    const platform = kind === 'platform_payout' ? (d.platform || null) : null;
    const entry = { counterpartyKey: key, direction: line.direction, kind, category: isExpenseKind ? (d.category || null) : null, propertyId: d.propertyId || null, platform };
    await rememberBankDecision(entry);
    const prev = _memory.get(memoryKey(line.direction, key));
    _memory.set(memoryKey(line.direction, key), { ...entry, key, timesUsed: prev ? (prev.timesUsed || 1) + 1 : 1, label: key });
  }

  // 5. Local state.
  Object.assign(line, { kind, kindSource: d.source || 'manual', needsReview, counterparty: key, isPersonal: kind === 'personal', skipped: false });
  void credit;
  return true;
}

// ── Bulk explain ──────────────────────────────────────────────────────────────

async function _buildContext(lines) {
  // An import can start from the Expenses screen before Bank has ever opened.
  if (!_memory.size) _memory = await loadBankMemory();
  const dates = lines.map(l => l.date).filter(Boolean).sort();
  const from = dates.length ? _addDaysIso(dates[0], -200) : null;
  const to = dates.length ? _addDaysIso(dates[dates.length - 1], 15) : null;
  const [exp, bookings, payouts] = await Promise.all([
    loadExpensesInRange(from, to),
    loadBookingsInRange(dates.length ? _addDaysIso(dates[0], -60) : null, dates.length ? _addDaysIso(dates[dates.length - 1], 60) : null),
    _payouts.length ? Promise.resolve(_payouts) : loadPlatformPayouts(),
  ]);
  _payouts = payouts;
  return { memory: _memory, ownerNames: _ownerNames(), expenses: exp, bookings, payouts };
}

/** Haiku, for what memory and rules could not answer: a category for a debit,
 *  a kind for a credit. Suggestions only. Fails quietly to "no suggestion". */
async function _aiSuggest(lines) {
  const out = new Map();
  if (!lines.length || !AIService || typeof AIService.request !== 'function') return out;
  const cats = _categories();
  const batches = [];
  for (let i = 0; i < lines.length; i += 20) batches.push(lines.slice(i, i + 20));
  for (const batch of batches) {
    const items = batch.map((l, i) => ({ n: i, date: l.date, amount: (l.direction === 'credit' ? '+' : '-') + Number(l.amount).toFixed(2), description: l.description }));
    const prompt = `You classify bank statement lines for a short-term rental (Airbnb) business in Australia.
Expense categories (use EXACTLY one of these for money out): ${cats.join(' | ')}
Kinds for money IN (amount starts with +): platform_payout, direct_booking, expense_refund, owner_funds, transfer, interest, other_income, personal.
Kinds for money OUT (amount starts with -): expense (almost always), owner_funds, transfer, guest_refund, personal.
Rules: a payment is an expense unless it clearly goes to the owner or between the host's own accounts. Bank fees → "${BANK_FEES_CATEGORY}". Supermarkets, Kmart, Bunnings, Amazon, Temu, IKEA for a rental → supplies or furnishings. Cleaners and gardeners → cleaning/garden. Tradespeople → maintenance. Water/electricity/gas/internet → utilities.
Return ONLY a JSON array, one object per line, no prose: [{"n":0,"kind":"expense","category":"...","confidence":0.0-1.0}]. category is null for money in unless kind is expense_refund.
LINES:
${JSON.stringify(items)}`;
    try {
      const { response, data } = await AIService.request({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1800,
        messages: [{ role: 'user', content: prompt }],
      });
      if (!response.ok) { console.warn('[StayOps] Bank AI: HTTP', response.status); continue; }
      const text = data && data.content && data.content[0] && data.content[0].text ? data.content[0].text : '';
      const a = text.indexOf('['); const b = text.lastIndexOf(']');
      if (a < 0 || b < a) continue;
      const parsed = JSON.parse(text.slice(a, b + 1));
      for (const row of parsed) {
        const l = batch[Number(row.n)];
        if (!l) continue;
        const category = cats.find(c => c.toLowerCase() === String(row.category || '').toLowerCase()) || null;
        out.set(String(l.id), { kind: row.kind || null, category, confidence: Math.max(0, Math.min(1, Number(row.confidence) || 0)) });
      }
    } catch (e) { console.warn('[StayOps] Bank AI batch failed', e); }
  }
  return out;
}

/**
 * Run the engine over `lines` and write the answers.
 *   force=false: certain → applied; suggested → debits booked as expenses
 *                (needs_review stays true), credits stored as a suggestion.
 *   force=true : suggestions are applied as decisions too (bulk-mark a year).
 * @returns {{ explained:number, suggested:number, undecided:number }}
 */
export async function explainAndApplyLines(lines, { force = false, useAi = true, onProgress = null } = {}) {
  const todo = (lines || []).filter(l => l && (!l.kind || l.needsReview));
  const stats = { explained: 0, suggested: 0, undecided: 0 };
  if (!todo.length) return stats;
  const ctx = await _buildContext(todo);
  const results = explainLines(todo, ctx);
  const needAi = useAi ? todo.filter(l => {
    const r = results.get(String(l.id));
    return (l.direction === 'debit' && r.kind === 'expense' && !r.category && !r.expenseId) || (l.direction === 'credit' && !r.kind);
  }) : [];
  const ai = needAi.length ? await _aiSuggest(needAi) : new Map();
  let i = 0;
  for (const line of todo) {
    i += 1;
    if (onProgress) onProgress(i, todo.length);
    const r = results.get(String(line.id));
    const a = ai.get(String(line.id));
    if (a) {
      if (line.direction === 'debit' && r.kind === 'expense' && !r.category && a.category) {
        r.category = a.category; r.source = 'ai'; r.confidence = a.confidence; r.needsReview = a.confidence < 0.8;
      } else if (line.direction === 'credit' && !r.kind && a.kind && kindsForDirection('credit').includes(a.kind)) {
        r.kind = a.kind; r.category = a.category; r.source = 'ai'; r.confidence = a.confidence; r.needsReview = true;
      }
    }
    if (!r.kind) { stats.undecided += 1; continue; }
    const original = r.expenseId && r.kind === 'expense_refund' ? ctx.expenses.find(e => String(e.id) === String(r.expenseId)) : null;
    const decision = {
      kind: r.kind,
      category: r.category || (r.kind === 'expense' || r.kind === 'expense_refund' ? (original && original.category) || 'Other' : null),
      propertyId: r.propertyId || (original && original.propertyId) || null,
      platform: r.platform || null,
      expenseId: r.expenseId || null,
      payoutId: r.payoutId || null,
      bookingId: r.bookingId || null,
      originalLabel: original ? (original.merchant || original.vendor || '') : '',
      remember: false,
      source: force && r.needsReview ? 'bulk' : r.source,
      confidence: r.confidence,
      needsReview: force ? false : r.needsReview,
    };
    if (r.needsReview && !force && r.kind !== 'expense') {
      // A suggested credit: store the kind, keep it in the queue, link nothing yet.
      const key = line.counterparty || counterpartyKey(line.description);
      await updateBankLine(line.id, { kind: r.kind, kindSource: r.source, kindConfidence: r.confidence, needsReview: true, counterparty: key });
      Object.assign(line, { kind: r.kind, kindSource: r.source, needsReview: true, counterparty: key });
      stats.suggested += 1;
      continue;
    }
    const ok = await _applyDecision(line, decision);
    if (!ok) { stats.undecided += 1; continue; }
    if (decision.needsReview) stats.suggested += 1; else stats.explained += 1;
  }
  // Re-read what was written (expense ids, payout links) before re-attaching.
  const dates = todo.map(l => l.date).filter(Boolean).sort();
  const fresh = await loadBankLines({ accountId: _acct ? _acct._cloudId : null, from: dates[0] || null, to: dates[dates.length - 1] || null, withLinks: false });
  const byId = new Map(fresh.map(l => [String(l.id), l]));
  for (const l of todo) {
    const f = byId.get(String(l.id));
    if (f) Object.assign(l, f, { expense: null, payouts: [], booking: null });
  }
  await attachBankLineLinks(todo);
  await _refreshExpensesInMemory();
  return stats;
}

// ── Handlers (inline-onclick API) ─────────────────────────────────────────────

async function bankSetFY(fy) {
  _fy = Number(fy);
  _month = null;
  _sheet = null;
  _lastSummary = null;
  const host = document.getElementById('finance-bank-content');
  if (host) host.innerHTML = `<div style="padding:24px;text-align:center;color:var(--muted-2);font-size:13px;${FONT}">Loading…</div>`;
  await _loadYear();
  _render();
}

function bankSetMonth(key) {
  _month = key || null;
  _sheet = null;
  _lastSummary = null;
  _render();
}

function bankSetFilter(f) {
  _filter = f || 'all';
  _render();
}

async function bankSetAccount(id) {
  _acct = _accounts.find(a => a._cloudId === id) || _acct;
  await bankSetFY(_fy);
}

function bankToggleRaw(id) {
  const k = String(id);
  if (_rawOpen.has(k)) _rawOpen.delete(k); else _rawOpen.add(k);
  _render();
}

function bankOpenSheet(id) {
  const line = _lines.find(l => String(l.id) === String(id));
  if (!line) return;
  const ex = line.expense;
  _sheet = {
    line,
    kind: line.kind || null,
    category: ex ? (ex.category || '') : '',
    propertyId: ex ? ex.propertyId : null,
    platform: line.payouts[0] ? line.payouts[0].platform : null,
    expenseId: ex ? (ex.amount < 0 ? ex.refundOfExpenseId : (String(ex.localId || '').startsWith('bank-') ? null : ex.id)) : null,
    payoutId: line.payouts[0] ? line.payouts[0].id : null,
    bookingId: line.bookingId || null,
    merchant: ex ? (ex.merchant || '') : _titleCase(line.counterparty || counterpartyKey(line.description)),
    remember: true,
    loading: false,
    candidates: {},
  };
  _render();
  document.body.style.overflow = 'hidden';
  if (_sheet.kind) _loadSheetCandidates();
}

function bankCloseSheet() {
  _sheet = null;
  document.body.style.overflow = '';
  _render();
}

function bankSheetPickKind(kind) {
  if (!_sheet) return;
  const l = _sheet.line;
  if (!kindsForDirection(l.direction).includes(kind)) return;
  _sheet.kind = kind;
  if (kind !== 'expense' && kind !== 'expense_refund') { _sheet.expenseId = null; }
  if (kind !== 'platform_payout') _sheet.payoutId = null;
  if (kind !== 'direct_booking' && kind !== 'guest_refund') _sheet.bookingId = null;
  if (kind === 'expense' && !_sheet.category) {
    const mem = _memory.get(memoryKey('debit', l.counterparty || counterpartyKey(l.description)));
    if (mem && mem.kind === 'expense' && mem.category) { _sheet.category = mem.category; _sheet.propertyId = _sheet.propertyId || mem.propertyId || null; }
  }
  if (kind === 'platform_payout' && !_sheet.platform) {
    const mem = _memory.get(memoryKey('credit', l.counterparty || counterpartyKey(l.description)));
    _sheet.platform = (mem && mem.platform) || null;
  }
  if (!_sheet.propertyId) _sheet.propertyId = _defaultPropertyId();
  _render();
  _loadSheetCandidates();
}

function bankSheetPickExpense(id) {
  if (!_sheet) return;
  _sheet.expenseId = id || null;
  if (id && _sheet.kind === 'expense_refund') {
    const e = (_sheet.candidates.expenses || []).find(x => String(x.id) === String(id));
    if (e) { _sheet.category = e.category || _sheet.category; _sheet.propertyId = e.propertyId || _sheet.propertyId; _sheet.merchant = e.merchant || _sheet.merchant; }
  }
  _renderSheetContext();
}

function bankSheetPickPayout(id) {
  if (!_sheet) return;
  _sheet.payoutId = id || null;
  if (id) { const p = _payouts.find(x => String(x._cloudId) === String(id)); if (p) _sheet.platform = p.platform || _sheet.platform; }
  _renderSheetContext();
}

function bankSheetPickBooking(id) {
  if (!_sheet) return;
  _sheet.bookingId = id || null;
  _renderSheetContext();
}

function bankSheetSetCategory(v) { if (_sheet) _sheet.category = v || ''; }
function bankSheetSetProperty(v) { if (_sheet) _sheet.propertyId = v || null; }
function bankSheetSetPlatform(v) { if (_sheet) _sheet.platform = v || null; }
function bankSheetSetMerchant(v) { if (_sheet) _sheet.merchant = v || ''; }
function bankSheetToggleRemember(on) { if (_sheet) _sheet.remember = !!on; }

async function bankSheetApply() {
  if (!_sheet || !_sheet.kind || _busy) return;
  const s = _sheet;
  if (_isLocked(s.line)) { _banner('This period is locked — unlock it first', 'warn'); return; }
  if ((s.kind === 'expense' && !s.expenseId && !s.category) || (s.kind === 'expense_refund' && !s.category)) {
    _banner('Pick a category first', 'warn');
    return;
  }
  _busy = true;
  _render();
  const original = s.kind === 'expense_refund' && s.expenseId ? (s.candidates.expenses || []).find(e => String(e.id) === String(s.expenseId)) : null;
  const ok = await _applyDecision(s.line, {
    kind: s.kind,
    category: s.category || null,
    propertyId: s.propertyId || null,
    platform: s.platform || null,
    expenseId: s.expenseId || null,
    payoutId: s.payoutId || null,
    bookingId: s.bookingId || null,
    merchant: s.merchant || null,
    originalLabel: original ? (original.merchant || original.vendor || '') : '',
    remember: !!s.remember,
    source: 'manual',
    confidence: 1,
    needsReview: false,
  });
  if (ok) {
    await _refreshLine(s.line.id);
    await _refreshExpensesInMemory();
    _banner('✓ Saved as ' + kindLabel(s.kind, s.line.direction), 'ok');
    _sheet = null;
    document.body.style.overflow = '';
  } else {
    _banner('⚠ Could not save — see console', 'warn');
  }
  _busy = false;
  _render();
}

/** Back to the queue: kind cleared, links undone, a bank-created expense removed. */
async function bankUndoLine(id) {
  const line = _lines.find(l => String(l.id) === String(id));
  if (!line || _busy) return;
  if (_isLocked(line)) { _banner('This period is locked — unlock it first', 'warn'); return; }
  _busy = true;
  if (line.expenseId || line.expense) await unlinkBankLineExpense(line);
  for (const p of line.payouts) await unlinkPayoutFromTransaction(p.id);
  await updateBankLine(line.id, { kind: null, kindSource: null, kindConfidence: null, needsReview: true, bookingId: null, reviewedAt: null, isPersonal: false, skipped: false });
  const p = _payouts.filter(x => line.payouts.some(y => String(y.id) === String(x._cloudId)));
  for (const x of p) x.bankTransactionId = null;
  await _refreshLine(line.id);
  await _refreshExpensesInMemory();
  _sheet = null;
  document.body.style.overflow = '';
  _busy = false;
  _banner('Back in the queue', 'ok');
  _render();
}

async function bankExplainAll() {
  if (_busy) return;
  _busy = true;
  _render();
  const scoped = _scopedLines();
  const stats = await explainAndApplyLines(scoped, { force: false, onProgress: (i, n) => _banner(`Explaining ${i} of ${n}…`, 'info') });
  _lastSummary = `${stats.explained} explained · ${stats.suggested} suggested · ${stats.undecided} still to decide`;
  _busy = false;
  _render();
}

async function bankConfirmSuggested() {
  if (_busy) return;
  const scoped = _scopedLines().filter(l => l.kind && l.needsReview);
  if (!scoped.length) return;
  _busy = true;
  _render();
  let n = 0;
  for (const line of scoped) {
    _banner(`Confirming ${n + 1} of ${scoped.length}…`, 'info');
    const ex = line.expense;
    const ok = await _applyDecision(line, {
      kind: line.kind,
      category: ex ? ex.category : null,
      propertyId: ex ? ex.propertyId : null,
      platform: line.payouts[0] ? line.payouts[0].platform : null,
      expenseId: ex ? (ex.amount < 0 ? ex.refundOfExpenseId : ex.id) : null,
      payoutId: line.payouts[0] ? line.payouts[0].id : null,
      bookingId: line.bookingId,
      merchant: ex ? ex.merchant : null,
      remember: false,
      source: line.kindSource || 'bulk',
      confidence: line.kindConfidence == null ? 0.8 : line.kindConfidence,
      needsReview: false,
    });
    if (ok) n += 1;
  }
  const fresh = await loadBankLines({ accountId: _acct._cloudId, from: _range().from, to: _range().to });
  const byId = new Map(fresh.map(l => [String(l.id), l]));
  _lines = _lines.map(l => byId.get(String(l.id)) || l);
  await _refreshExpensesInMemory();
  _lastSummary = `${n} confirmed`;
  _busy = false;
  _render();
}

/** Close a past year in one pass: explain everything, apply suggestions as
 *  decisions, mark unpaid expenses as paid elsewhere, lock. Reversible. */
async function bankBulkMarkYear() {
  if (_busy) return;
  const b = fyBounds(_fy);
  const r = { from: b.start, to: b.end };
  const all = _lines.filter(l => _inRange(l.date, r));
  const open = all.filter(_toDecide).length;
  const ok = await globalThis.showAppModal({
    title: `Mark ${fyLabel(_fy)} as done?`,
    msg: `${open} line${open === 1 ? '' : 's'} will be explained automatically — every payment booked as an expense, refunds as credit notes, known payees as remembered — then the year is locked. Expenses from the year with no bank line are marked as paid from another account. Nothing is deleted and you can unlock later.`,
    confirmText: 'Mark as done',
  });
  if (!ok) return;
  _busy = true;
  _render();
  const stats = await explainAndApplyLines(all, { force: true, onProgress: (i, n) => _banner(`Marking ${i} of ${n}…`, 'info') });
  const marked = await markExpensesPaidVia({ from: r.from, to: r.to, paidVia: 'other_account' });
  const lock = await lockBankPeriod({ accountId: _acct._cloudId, periodStart: r.from, periodEnd: r.to, notes: 'bulk-marked' });
  _locks = await loadBankLocks(_acct._cloudId);
  _lastSummary = `${stats.explained} explained · ${stats.undecided} could not be decided · ${marked} expenses marked paid elsewhere${lock ? ' · year locked' : ' · lock failed'}`;
  _busy = false;
  _render();
}

async function bankLockPeriod() {
  if (_busy || !_month) return;
  const r = _range();
  const scoped = _scopedLines();
  if (scoped.some(_toDecide)) { _banner('Decide every line first', 'warn'); return; }
  const batches = _batches.filter(b => b.periodStart <= r.to && b.periodEnd >= r.from);
  const first = batches[0]; const last = batches[batches.length - 1];
  const opening = first && first.openingBalance != null ? first.openingBalance : null;
  const closing = last && last.closingBalance != null ? last.closingBalance : null;
  const credits = scoped.filter(l => l.direction === 'credit').reduce((s, l) => s + toCents(l.amount), 0);
  const debits = scoped.filter(l => l.direction === 'debit').reduce((s, l) => s + toCents(l.amount), 0);
  const computed = opening == null ? null : centsToAmount(toCents(opening) + credits - debits);
  if (closing != null && computed != null && toCents(closing) !== toCents(computed)) {
    const go = await globalThis.showAppModal({ title: 'Still out of balance', msg: `The statement says $${money(closing)} but your lines come to $${money(computed)}. Lock anyway?`, confirmText: 'Lock anyway' });
    if (!go) return;
  }
  _busy = true;
  const lock = await lockBankPeriod({ accountId: _acct._cloudId, periodStart: r.from, periodEnd: r.to, openingBalance: opening, closingBalance: closing, computedClosing: computed });
  _locks = await loadBankLocks(_acct._cloudId);
  _busy = false;
  _banner(lock ? '🔒 ' + _rangeLabel() + ' locked' : '⚠ Could not lock', lock ? 'ok' : 'warn');
  _render();
}

async function bankUnlock(id) {
  const ok = await globalThis.showAppModal({ title: 'Unlock this period?', msg: 'Its lines can be changed again. Nothing is deleted.', confirmText: 'Unlock' });
  if (!ok) return;
  const res = await unlockBankPeriod(id);
  if (!res || !res.success) { _banner('⚠ Could not unlock', 'warn'); return; }
  _locks = await loadBankLocks(_acct._cloudId);
  _banner('Unlocked', 'ok');
  _render();
}

async function bankSaveBalances(batchId) {
  const o = document.getElementById('bank-opening-input');
  const c = document.getElementById('bank-closing-input');
  const opening = o && o.value !== '' ? Number(o.value) : null;
  const closing = c && c.value !== '' ? Number(c.value) : null;
  const ok = await updateBankImportBatch(batchId, { openingBalance: opening, closingBalance: closing });
  if (!ok) { _banner('⚠ Could not save', 'warn'); return; }
  _batches = await loadBankImportBatches({ accountId: _acct._cloudId, from: fyBounds(_fy).start, to: fyBounds(_fy).end });
  _render();
}

function bankLoadStatement() {
  if (typeof globalThis.bankImportPickFile === 'function') globalThis.bankImportPickFile();
}

function bankPasteStatement() {
  if (typeof globalThis.openPayoutPasteModal === 'function') globalThis.openPayoutPasteModal();
}

/** Called by the import flow once the new lines are saved and explained. */
export async function bankAfterImport({ lines = [], summary = '' } = {}) {
  const latest = lines.map(l => l.date).filter(Boolean).sort().pop();
  const opts = {};
  if (latest) { opts.fy = fyOfDate(latest); opts.month = latest.slice(0, 7); }
  _lastSummary = summary || null;
  _filter = 'decide';
  await showBankView(opts);
}

/** Lines in the Bank screen's memory, so the import flow can explain against
 *  the same account. */
export function bankCurrentAccount() { return _acct; }

// Ensure the view container exists before fading in (showFinanceSub handles the
// hide/show; this is for direct deep links).
export function bankViewElement() {
  const el = document.getElementById('finance-bank-view');
  if (el) fadeTransition(el, true);
  return el;
}

globalThis.showBankView = showBankView;
globalThis.bankSetFY = bankSetFY;
globalThis.bankSetMonth = bankSetMonth;
globalThis.bankSetFilter = bankSetFilter;
globalThis.bankSetAccount = bankSetAccount;
globalThis.bankToggleRaw = bankToggleRaw;
globalThis.bankOpenSheet = bankOpenSheet;
globalThis.bankCloseSheet = bankCloseSheet;
globalThis.bankSheetPickKind = bankSheetPickKind;
globalThis.bankSheetPickExpense = bankSheetPickExpense;
globalThis.bankSheetPickPayout = bankSheetPickPayout;
globalThis.bankSheetPickBooking = bankSheetPickBooking;
globalThis.bankSheetSetCategory = bankSheetSetCategory;
globalThis.bankSheetSetProperty = bankSheetSetProperty;
globalThis.bankSheetSetPlatform = bankSheetSetPlatform;
globalThis.bankSheetSetMerchant = bankSheetSetMerchant;
globalThis.bankSheetToggleRemember = bankSheetToggleRemember;
globalThis.bankSheetApply = bankSheetApply;
globalThis.bankUndoLine = bankUndoLine;
globalThis.bankExplainAll = bankExplainAll;
globalThis.bankConfirmSuggested = bankConfirmSuggested;
globalThis.bankBulkMarkYear = bankBulkMarkYear;
globalThis.bankLockPeriod = bankLockPeriod;
globalThis.bankUnlock = bankUnlock;
globalThis.bankSaveBalances = bankSaveBalances;
globalThis.bankLoadStatement = bankLoadStatement;
globalThis.bankPasteStatement = bankPasteStatement;
