/**
 * StayOps — invoices: business identity, INV<YY><NNN> numbering, the issued-
 * invoice ledger (window._appConfig.invoices), the on-screen invoice overlay,
 * and the downloadable jsPDF document. Split out of finance.js 2026-07-08
 * (slice 3/4; see the architecture plan). finance.js stays the barrel that
 * main.js loads; this module installs its own window.* bridges and is
 * side-effect-imported there.
 *
 * The import of renderManagement/renderMgmtFY/_financeScopedBookings/loadClients
 * from ./finance.js is a deliberate cycle: every use is inside a function body
 * (call-time), never at module-eval, so it resolves safely — same pattern as
 * finance-bank-import.js.
 */
import { getPropertyConfig, getCurrentPropertyName } from './config.js';
import { bookings } from './state.js';
import { escHtml } from './utils.js';
import { saveAppConfigToCloud } from './supabase.js';
import { bookingRevenue, bookingCleaningFee, bookingMgmtPayout } from './booking-revenue.js';
import { renderManagement, renderMgmtFY, _financeScopedBookings, loadClients } from './finance.js';

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

    // No one-size-fits-all — pick what the device can actually do:
    //  • Desktop, Android, and iOS Safari can download a file directly, which is
    //    a real "Save" (lands in Downloads / Files). Use that everywhere we can.
    //  • The full-screen iOS app (Capacitor WebView) and iOS home-screen PWAs
    //    can't trigger a download, so hand the file to the OS save sheet — that's
    //    where iOS/Android expose "Save to Files" / "Save to Downloads".
    const cap = globalThis.Capacitor;
    const isNativeShell = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
    const isIOSStandalone = navigator.standalone === true;
    const canDownloadDirectly = !isNativeShell && !isIOSStandalone;

    if (canDownloadDirectly) {
      doc.save(filename);
      return;
    }

    const blob = doc.output('blob');
    const file = new File([blob], filename, { type: 'application/pdf' });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Invoice ' + invNum });
      } catch (err) {
        // AbortError = user dismissed the sheet; otherwise fall back to a download.
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

// ── window bridges (relocated verbatim from finance.js) ─────────────────────
globalThis.toggleInvoiceStatus = _updateInvoiceStatus;
globalThis.viewHistoricalInvoice = _viewHistoricalInvoice;
globalThis.cancelInvoice = _cancelInvoice;
globalThis.toggleInvoiceDetail = function(num) { _expandedInvoiceNum = _expandedInvoiceNum === num ? null : num; renderInvoiceHistory(); };

// Consumed by the finance.js barrel (management/reports call-sites) + settings.js (_getInvoiceIdentity).
export { buildInvoicePDF, renderInvoiceHistory, _getBookingInvoiceMap, _getInvoiceIdentity };
