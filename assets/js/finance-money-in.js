/**
 * StayOps — the Money In list (Transaction Map → Money In).
 *
 * Replaces the old "Payout Match" list, which showed only bank credits and so
 * could never show a payout that had NOT arrived. That was the whole "two
 * separate lists" problem: platform statements lived in one place, bank
 * deposits in another, and nothing showed them as one story.
 *
 * This renders the single ledger from money-in-model.js — three row kinds:
 *   matched      deposit + statement agree (variance chip, Unlink)
 *   payout_only  statement says paid, no deposit found (Find deposit)
 *   credit_only  money arrived, nothing explains it (Match payout / Paste)
 *
 * Takes its data as arguments and imports no finance module, so the barrel can
 * use it without a cycle (see the split rules in finance-shared.js).
 */
import { escHtml } from './utils.js';
import { buildMoneyInLedger, summariseMoneyIn, centsToAmount } from './money-in-model.js';

const money = cents => centsToAmount(cents).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Summary tiles for money-in. "Matched / Unaccounted / Personal" never
 *  described this side — what a host wants to know is: did it arrive, what is
 *  still owed, and what turned up that I cannot explain. */
export function moneyInSummaryHtml(rows) {
  const s = summariseMoneyIn(rows);
  const tile = (val, label, bg, valColor, labelColor, count) =>
    `<div style="flex:1;min-width:100px;background:${bg};border-radius:8px;padding:8px 12px;text-align:center">
       <div style="font-size:18px;font-weight:600;color:${valColor}">$${money(val)}</div>
       <div style="font-size:11px;color:${labelColor}">${label}${count ? ' · ' + count : ''}</div>
     </div>`;
  return `<div style="display:flex;gap:8px;padding:0 16px;margin:0 auto 12px;max-width:560px;flex-wrap:wrap">
      ${tile(s.receivedCents, 'Received', '#E8F5E9', '#2E7D32', '#388E3C', s.received)}
      ${tile(s.expectedCents, 'Not received', '#FFF3E0', '#E65100', '#F57C00', s.expected)}
      ${tile(s.unexplainedCents, 'Unexplained', '#E3F2FD', '#1565C0', '#1976D2', s.unexplained)}
    </div>`;
}

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'matched', label: 'Received' },
  { key: 'payout_only', label: 'Not received' },
  { key: 'credit_only', label: 'Unexplained' },
];

export function moneyInFiltersHtml(active) {
  return `<div style="display:flex;gap:6px;flex-wrap:wrap;padding:0 16px;margin-bottom:10px">` +
    FILTERS.map(f => {
      const on = (active || 'all') === f.key;
      return `<button onclick="moneyInSetFilter('${f.key}')" style="font-size:12px;padding:5px 12px;border-radius:20px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;border:1px solid ${on ? 'var(--primary)' : 'var(--hairline-1)'};background:${on ? 'var(--primary)' : '#fff'};color:${on ? '#fff' : 'var(--muted-2)'}">${f.label}</button>`;
    }).join('') + `</div>`;
}

function rowHtml(r) {
  const dateStr = escHtml(r.date || '—');
  const amt = `$${money(r.amountCents)}`;
  let badge = '';
  let actions = '';

  if (r.kind === 'matched') {
    const plat = escHtml((r.platform || 'platform').replace('_', '.'));
    const ref = escHtml(r.reference || 'no ref');
    const multi = r.payoutIds.length > 1 ? ` · ${r.payoutIds.length} statements` : '';
    // A non-zero variance is the interesting case: the statements claim a
    // different total than the bank actually paid.
    const varChip = r.varianceCents
      ? `<span style="font-size:10px;background:#FFF3E0;color:#E65100;border-radius:4px;padding:2px 6px;margin-left:6px">${r.varianceCents > 0 ? 'short' : 'over'} $${money(Math.abs(r.varianceCents))}</span>`
      : '';
    badge = `<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#2E7D32"><span style="width:6px;height:6px;border-radius:50%;background:#4CAF50;display:inline-block"></span> ${plat} · ${ref}${multi}</span>${varChip}`;
    actions = `<button onclick="reconUnlinkPayout('${escHtml(r.payoutIds[0])}','${escHtml(r.txnId)}')" style="font-size:10px;color:#78909C;background:none;border:1px solid #B0BEC5;border-radius:6px;padding:2px 8px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif">Unlink</button>`;
  } else if (r.kind === 'payout_only') {
    badge = `<span style="display:inline-block;font-size:11px;background:#FFF3E0;color:#E65100;border-radius:4px;padding:2px 8px">Not received</span>`;
    actions = `<button onclick="moneyInFindDeposit('${escHtml(r.payoutIds[0])}')" style="font-size:11px;color:#E65100;background:none;border:1px solid #FFB74D;border-radius:6px;padding:3px 10px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;white-space:nowrap">Find deposit</button>`;
  } else {
    badge = `<span style="display:inline-block;font-size:11px;background:#E3F2FD;color:#1565C0;border-radius:4px;padding:2px 8px">Unexplained deposit</span>`;
    actions = `<button onclick="reconMatchPayout('${escHtml(r.txnId)}','${escHtml(r.date || '')}','${(r.amountCents / 100).toFixed(2)}','${escHtml(r.description || '')}')" style="font-size:11px;color:#1565C0;background:none;border:1px solid #64B5F6;border-radius:6px;padding:3px 10px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;white-space:nowrap">Match payout</button>
      <button onclick="openPayoutPasteModal()" style="font-size:11px;color:var(--muted-2);background:none;border:1px solid var(--hairline-1);border-radius:6px;padding:3px 10px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;white-space:nowrap">Paste statement</button>`;
  }

  return `
    <div style="background:#fff;border:1px solid var(--hairline-1);border-radius:12px;padding:12px 14px;margin-bottom:8px;font-family:'Plus Jakarta Sans',sans-serif">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
        <div style="min-width:0;flex:1">
          <div style="font-size:11px;color:var(--muted-2)">${dateStr}</div>
          <div style="font-size:13px;font-weight:600;color:var(--ink-1);margin-top:2px;overflow:hidden;text-overflow:ellipsis">${escHtml(r.description || '')}</div>
          <div style="font-size:15px;font-weight:700;color:var(--ink-1);margin-top:4px">${amt}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0">
          ${badge}
          <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">${actions}</div>
        </div>
      </div>
    </div>`;
}

/** @param {HTMLElement} listEl @param {{payouts:Array, credits:Array, filter:string}} data */
export function renderMoneyInList(listEl, { payouts = [], credits = [], filter = 'all' } = {}) {
  if (!listEl) return { rows: [], summaryHtml: '' };
  const rows = buildMoneyInLedger({ payouts, creditTxns: credits });
  const visible = rows.filter(r => {
    if (r.isPersonal || r.skipped) return false;
    return filter === 'all' ? true : r.kind === filter;
  });

  listEl.innerHTML = visible.length
    ? visible.map(rowHtml).join('')
    : `<div style="text-align:center;padding:28px 16px;color:var(--muted-2);font-size:13px;font-family:'Plus Jakarta Sans',sans-serif">
         ${rows.length ? 'Nothing in this filter.' : 'No money-in yet. Import a bank statement, then paste a platform statement to match deposits against it.'}
       </div>`;
  return { rows, summaryHtml: moneyInSummaryHtml(rows) };
}
