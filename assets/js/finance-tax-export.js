/**
 * StayOps — tax export: ATO-ready FY tax summary, the on-screen tax-export
 * view, and the PDF + CSV exporters. Split out of finance.js 2026-07-08
 * (slice 4/4; see the architecture plan). finance.js stays the barrel that
 * main.js loads; this module installs its own window.* bridges and is
 * side-effect-imported there.
 *
 * The imports from ./finance.js (expenseHasReceiptAttached, _financeScopedExpenses,
 * _financeScopedBookings, getAtoField, ATO_FIELD_LABELS, _bookingPropertyId,
 * _canonicalPlatformName) form a deliberate cycle: every use is inside a function
 * body (call-time), never at module-eval, so it resolves safely — same pattern as
 * slices 2 & 3. Depreciation helpers + showBanner are reached via guarded
 * globalThis.* (no import); jsPDF via window.jspdf.
 */
import { bookings } from './state.js';
import { escHtml, fmt2, fyLabel, fyMonths, fadeTransition } from './utils.js';
import { getCurrentPropertyName, getActivePropertyId, getAllProperties } from './config.js';
import { isRevenueBearingBooking, bookingMgmtPayout, bookingRevenue } from './booking-revenue.js';
import {
  expenseHasReceiptAttached,
  _financeScopedExpenses,
  _financeScopedBookings,
  getAtoField,
  getAtoFieldLabel,
  ATO_FIELD_LABELS,
  _bookingPropertyId,
  _canonicalPlatformName,
} from './finance.js';

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

// ── window bridges (relocated verbatim from finance.js) ─────────────────────
window.exportTaxPDF = exportTaxPDF;
window.exportTaxCSV = exportTaxCSV;
window.taxExportFYPrev = taxExportFYPrev;
window.taxExportFYNext = taxExportFYNext;

// Consumed by the finance.js barrel: hub nav calls showTaxExportView; main.js re-imports the 4 exporters.
export { showTaxExportView, exportTaxPDF, exportTaxCSV, taxExportFYPrev, taxExportFYNext };
