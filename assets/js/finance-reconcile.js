/**
 * StayOps — period reconcile (Finance → Reconcile).
 *
 * The MYOB "Reconcile accounts" close: pick an account and a statement date,
 * enter the statement's closing balance, tick the lines that appear on it, and
 * the app shows
 *
 *     calculated closing = opening + credits − debits      (cleared rows only)
 *     OUT OF BALANCE     = statement closing − calculated
 *
 * You are not done until that reads $0.00. It is the only figure in the app
 * that can PROVE nothing is missing or double-counted — the gap that let an
 * expense be subtracted twice from owner payout with nothing noticing.
 *
 * Arithmetic lives in reconcile-period.js (pure, integer cents, unit-tested).
 * This file is rendering, state and persistence only.
 */
import { escHtml } from './utils.js';
import {
  computePeriodReconcile,
  explainOutOfBalance,
  deriveOpeningBalanceCents,
  toCents,
  centsToAmount,
} from './reconcile-period.js';
import {
  loadBankAccounts,
  getOrCreateDefaultBankAccount,
  loadTransactionsForPeriod,
  loadLastClosedReconciliation,
  saveReconciliation,
  loadReconciliations,
  undoReconciliation,
} from './supabase.js';

const money = c => centsToAmount(c).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let _accounts = [];
let _acctId = null;
let _periodEnd = '';
let _openingCents = 0;
let _statementCents = 0;
let _txns = [];
let _cleared = new Set();
let _history = [];
let _openingLocked = false;

function _monthEnd(d) {
  const dt = d ? new Date(d) : new Date();
  return new Date(dt.getFullYear(), dt.getMonth() + 1, 0).toISOString().slice(0, 10);
}

export async function showReconcileView() {
  // Read the navigator into a local before type-checking it. An inline
  // typeof-check against the global would be miscounted as a bridge
  // declaration by check-finance-split.sh, whose regex ends in `[[:space:]]*=`
  // and so also matches the first `=` of a strict-equality comparison.
  const navigate = globalThis.showFinanceSub;
  if (typeof navigate === 'function') navigate('reconcile');
  await initReconcile();
}
globalThis.showReconcileView = showReconcileView;

async function initReconcile() {
  const host = document.getElementById('finance-reconcile-content');
  if (!host) return;
  host.innerHTML = `<div style="padding:24px;text-align:center;color:var(--muted-2);font-size:13px">Loading…</div>`;
  _accounts = await loadBankAccounts();
  if (!_accounts.length) {
    const created = await getOrCreateDefaultBankAccount();
    if (created) _accounts = [created];
  }
  if (!_accounts.length) {
    host.innerHTML = `<div style="padding:24px;text-align:center;color:var(--muted-2);font-size:13px">Sign in to reconcile.</div>`;
    return;
  }
  _acctId = _acctId || (_accounts.find(a => a.isDefault) || _accounts[0])._cloudId;
  if (!_periodEnd) _periodEnd = _monthEnd();
  await loadPeriod();
}

async function loadPeriod() {
  const acct = _accounts.find(a => a._cloudId === _acctId) || null;
  const prior = await loadLastClosedReconciliation(_acctId);
  // Chain from the previous close so a period cannot be reconciled in isolation
  // against a number nobody checked. Only the very first period is editable.
  _openingCents = deriveOpeningBalanceCents(prior, acct);
  _openingLocked = !!prior;
  _txns = await loadTransactionsForPeriod(_acctId, _periodEnd);
  _history = await loadReconciliations(_acctId);
  // Default: everything already reconciled in an earlier period stays ticked,
  // everything else starts unticked so the host actively confirms each line.
  _cleared = new Set(_txns.filter(t => t.reconciledAt).map(t => String(t.id)));
  render();
}

function currentResult() {
  return computePeriodReconcile({
    openingBalanceCents: _openingCents,
    statementClosingCents: _statementCents,
    transactions: _txns.map(t => ({ ...t, cleared: _cleared.has(String(t.id)) })),
  });
}

function render() {
  const host = document.getElementById('finance-reconcile-content');
  if (!host) return;
  const r = currentResult();
  const oob = r.outOfBalanceCents;
  const balanced = oob === 0;

  const acctOpts = _accounts.map(a =>
    `<option value="${escHtml(a._cloudId)}" ${a._cloudId === _acctId ? 'selected' : ''}>${escHtml(a.name)}</option>`).join('');

  const rows = _txns.map(t => {
    const on = _cleared.has(String(t.id));
    const isCredit = String(t.direction || 'debit') === 'credit';
    return `<label style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:0.5px solid var(--hairline-1);cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif">
        <input type="checkbox" ${on ? 'checked' : ''} onchange="reconcileToggle('${escHtml(String(t.id))}')" style="width:16px;height:16px;flex-shrink:0">
        <span style="font-size:11px;color:var(--muted-2);width:74px;flex-shrink:0">${escHtml(t.date || '')}</span>
        <span style="font-size:12.5px;color:var(--ink-1);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(t.description || '')}</span>
        <span style="font-size:12.5px;font-weight:600;color:${isCredit ? '#2E7D32' : 'var(--ink-1)'};flex-shrink:0">${isCredit ? '+' : '−'}$${money(Math.abs(toCents(t.amount)))}</span>
      </label>`;
  }).join('');

  const hints = balanced ? [] : explainOutOfBalance(oob, _txns, []);
  const hintHtml = hints.length
    ? `<div style="background:#FFF8E1;border:1px solid #FFE082;border-radius:10px;padding:10px 12px;margin-top:10px">
         <div style="font-size:11px;font-weight:700;color:#E65100;text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px">Likely cause</div>
         ${hints.map(h => `<div style="font-size:12.5px;color:#5D4037;margin-bottom:4px">${escHtml(h.message)}</div>`).join('')}
       </div>` : '';

  const historyHtml = _history.length
    ? `<div style="margin-top:20px">
         <div style="font-size:11px;font-weight:700;color:var(--muted-2);text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px">Closed periods</div>
         ${_history.map(h => `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 12px;border-bottom:0.5px solid var(--hairline-1);font-size:12.5px;font-family:'Plus Jakarta Sans',sans-serif">
              <span>${escHtml(h.periodEnd)} · closing $${money(toCents(h.statementClosing))}</span>
              <button onclick="reconcileUndo('${escHtml(h._cloudId)}')" style="font-size:11px;color:#78909C;background:none;border:1px solid #B0BEC5;border-radius:6px;padding:2px 8px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif">Undo</button>
            </div>`).join('')}
       </div>` : '';

  host.innerHTML = `
    <div style="padding:0 16px 24px;font-family:'Plus Jakarta Sans',sans-serif">
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
        <div style="flex:1;min-width:150px">
          <label style="font-size:11px;color:var(--muted-2)">Account</label>
          <select onchange="reconcileSetAccount(this.value)" style="width:100%">${acctOpts}</select>
        </div>
        <div style="flex:1;min-width:150px">
          <label style="font-size:11px;color:var(--muted-2)">Statement date</label>
          <input type="date" value="${escHtml(_periodEnd)}" onchange="reconcileSetPeriodEnd(this.value)" style="width:100%">
        </div>
      </div>

      <!-- Reading the balances off the statement beats typing them: a wrong
           digit here sends the host hunting a phantom out-of-balance. -->
      <div onclick="document.getElementById('reconcile-stmt-input').click()"
           style="border:2px dashed var(--hairline-1);border-radius:12px;padding:14px 12px;text-align:center;cursor:pointer;margin-bottom:12px;background:var(--surface2)">
        <div style="font-size:13.5px;font-weight:700;color:var(--ink-1)">Upload your bank statement</div>
        <div style="font-size:12px;color:var(--muted-2);margin-top:3px">PDF, photo or CSV — reads the opening and closing balance for you</div>
      </div>
      <input type="file" id="reconcile-stmt-input" accept="application/pdf,image/*,.csv,.txt" style="display:none" onchange="reconcileReadStatement(this)">
      <div id="reconcile-stmt-status" style="display:none;font-size:12.5px;padding:8px 10px;border-radius:8px;margin-bottom:12px"></div>

      <div style="background:#fff;border:1px solid var(--hairline-1);border-radius:12px;padding:14px;margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0">
          <span style="color:var(--muted-2)">Opening balance${_openingLocked ? ' (from last close)' : ''}</span>
          ${_openingLocked
            ? `<strong>$${money(_openingCents)}</strong>`
            : `<input type="number" step="0.01" value="${centsToAmount(_openingCents).toFixed(2)}" onchange="reconcileSetOpening(this.value)" style="width:120px;text-align:right">`}
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0">
          <span style="color:var(--muted-2)">Money in (ticked)</span><span style="color:#2E7D32">+$${money(r.creditsCents)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0">
          <span style="color:var(--muted-2)">Money out (ticked)</span><span>−$${money(r.debitsCents)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13px;padding:6px 0;border-top:0.5px solid var(--hairline-1);margin-top:4px">
          <span style="color:var(--muted-2)">Calculated closing</span><strong>$${money(r.calculatedClosingCents)}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;padding:6px 0">
          <span style="color:var(--muted-2)">Statement closing balance</span>
          <input type="number" step="0.01" value="${centsToAmount(_statementCents).toFixed(2)}" onchange="reconcileSetStatement(this.value)" style="width:120px;text-align:right">
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0 2px;border-top:1px solid var(--hairline-1);margin-top:6px">
          <span style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:${balanced ? '#2E7D32' : '#C62828'}">Out of balance</span>
          <span style="font-size:24px;font-weight:800;color:${balanced ? '#2E7D32' : '#C62828'}">$${money(Math.abs(oob))}</span>
        </div>
        ${hintHtml}
        <button onclick="reconcileClosePeriod()" ${balanced ? '' : 'disabled'}
          style="width:100%;margin-top:12px;padding:11px;border:none;border-radius:10px;font-size:13.5px;font-weight:700;cursor:${balanced ? 'pointer' : 'not-allowed'};font-family:'Plus Jakarta Sans',sans-serif;background:${balanced ? 'var(--primary)' : 'var(--hairline-1)'};color:${balanced ? '#fff' : 'var(--muted-2)'}">
          ${balanced ? 'Mark period reconciled' : 'Reconcile to $0.00 to finish'}
        </button>
      </div>

      <div style="font-size:11px;font-weight:700;color:var(--muted-2);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px">
        Transactions to ${escHtml(_periodEnd)} · ${r.clearedCount} of ${_txns.length} ticked
      </div>
      <div style="background:#fff;border:1px solid var(--hairline-1);border-radius:12px;overflow:hidden">
        ${rows || `<div style="padding:20px;text-align:center;color:var(--muted-2);font-size:13px">No transactions on or before this date. Import a bank statement first.</div>`}
      </div>
      ${historyHtml}
    </div>`;
}

/** Read the statement period and balances off the statement itself.
 *
 *  Reuses the same ai-proxy path the bank import uses. Only four numbers are
 *  wanted — period start/end and opening/closing balance — so the prompt is
 *  deliberately narrow and the reply is parsed with the tolerant JSON reader
 *  rather than a bare JSON.parse (the model will happily add a sentence).
 *
 *  Nothing is saved: it fills the fields and the host confirms. A statement that
 *  cannot be read leaves the manual inputs exactly as they were. */
async function reconcileReadStatement(input) {
  const file = input && input.files && input.files[0];
  if (input) input.value = '';
  if (!file) return;
  const status = document.getElementById('reconcile-stmt-status');
  const say = (msg, ok) => {
    if (!status) return;
    status.style.display = 'block';
    status.style.background = ok === true ? '#E8F5E9' : ok === false ? '#FDECEA' : '#FFF8E1';
    status.style.color = ok === true ? '#2E7D32' : ok === false ? '#C0392B' : '#E65100';
    status.textContent = msg;
  };
  if (file.size > 12 * 1024 * 1024) { say('That file is over 12 MB — try a single statement, not a full year.', false); return; }
  say('⟳ Reading your statement…');

  try {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    const isImage = (file.type || '').startsWith('image/');
    let content;
    if (isPdf || isImage) {
      const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(file);
      });
      const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      content = isPdf
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
        : { type: 'image', source: { type: 'base64', media_type: file.type || 'image/jpeg', data: b64 } };
    } else {
      const text = await new Promise((res, rej) => {
        const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsText(file);
      });
      content = { type: 'text', text: 'Bank statement:\n' + text.slice(0, 60000) };
    }

    const { AIService } = await import('./ai-logic.js');
    const { response, data } = await AIService.request({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{ role: 'user', content: [content, { type: 'text', text:
        'This is a bank statement. Return ONLY a JSON object, no markdown, with exactly these fields: '
        + '{"periodStart":"YYYY-MM-DD","periodEnd":"YYYY-MM-DD","openingBalance":number,"closingBalance":number}. '
        + 'openingBalance is the balance brought forward at the START of the statement period. '
        + 'closingBalance is the balance at the END. Both are plain numbers with no currency symbol or commas; '
        + 'use a negative number if the account is overdrawn. Use null for anything you cannot find.' }] }],
    });
    if (!response.ok) throw new Error((data && data.error && (data.error.message || data.error)) || 'API error');

    const { parseAIJson } = await import('./ai.js');
    const parsed = parseAIJson(data.content?.[0]?.text || '{}');

    const open = Number(parsed.openingBalance);
    const close = Number(parsed.closingBalance);
    if (!Number.isFinite(open) && !Number.isFinite(close)) {
      say('Could not find the opening and closing balances on that statement — enter them by hand below.', false);
      return;
    }
    if (parsed.periodEnd && /^\d{4}-\d{2}-\d{2}$/.test(parsed.periodEnd)) _periodEnd = parsed.periodEnd;
    // Load the period FIRST: loadPeriod re-derives the opening balance from the
    // previous close, so setting the balances before it would wipe them.
    await loadPeriod();
    if (Number.isFinite(open)) { _openingCents = toCents(open); _openingLocked = false; }
    if (Number.isFinite(close)) _statementCents = toCents(close);
    render();
    say(`✓ Read ${parsed.periodStart || '?'} → ${parsed.periodEnd || '?'} · opening $${money(_openingCents)} · closing $${money(_statementCents)}. Check they match your statement, then tick the rows.`, true);
  } catch (err) {
    console.warn('[StayOps] reconcileReadStatement failed', err);
    say('Could not read that statement — ' + ((err && err.message) || 'unknown error') + '. You can still enter the balances by hand.', false);
  }
}
globalThis.reconcileReadStatement = reconcileReadStatement;

// ── handlers (inline-onclick API) ────────────────────────────────────────────
function reconcileToggle(id) {
  const k = String(id);
  if (_cleared.has(k)) _cleared.delete(k); else _cleared.add(k);
  render();
}
function reconcileSetOpening(v) { _openingCents = toCents(v); render(); }
function reconcileSetStatement(v) { _statementCents = toCents(v); render(); }
async function reconcileSetAccount(id) { _acctId = id; await loadPeriod(); }
async function reconcileSetPeriodEnd(d) { _periodEnd = d || _monthEnd(); await loadPeriod(); }

async function reconcileClosePeriod() {
  const r = currentResult();
  if (r.outOfBalanceCents !== 0) {
    globalThis.showBanner('⚠ Still out of balance — cannot close', 'warn');
    return;
  }
  const first = _txns.length ? _txns[0].date : _periodEnd;
  const saved = await saveReconciliation({
    bankAccountId: _acctId,
    periodStart: first,
    periodEnd: _periodEnd,
    openingBalance: centsToAmount(_openingCents),
    statementClosing: centsToAmount(_statementCents),
    computedClosing: centsToAmount(r.calculatedClosingCents),
    outOfBalance: 0,
    status: 'closed',
  }, [..._cleared]);
  if (!saved) { globalThis.showBanner('⚠ Could not save the reconciliation', 'warn'); return; }
  globalThis.showBanner('✓ Period reconciled — balanced to $0.00', 'ok');
  await loadPeriod();
}

async function reconcileUndo(id) {
  const ok = await globalThis.showAppModal({
    title: 'Undo this reconciliation?',
    msg: 'The period reopens and its transactions become unreconciled. Nothing is deleted.',
    confirmText: 'Undo',
  });
  if (!ok) return;
  const res = await undoReconciliation(id);
  if (!res.success) { globalThis.showBanner('⚠ Could not undo', 'warn'); return; }
  globalThis.showBanner('✓ Reconciliation undone', 'ok');
  await loadPeriod();
}

globalThis.reconcileToggle = reconcileToggle;
globalThis.reconcileSetOpening = reconcileSetOpening;
globalThis.reconcileSetStatement = reconcileSetStatement;
globalThis.reconcileSetAccount = reconcileSetAccount;
globalThis.reconcileSetPeriodEnd = reconcileSetPeriodEnd;
globalThis.reconcileClosePeriod = reconcileClosePeriod;
globalThis.reconcileUndo = reconcileUndo;
