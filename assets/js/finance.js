/**
 * StayOps — finance, expenses, reports, invoices (Pass 7).
 */
import { lsKey, getPropertyConfig, getCurrentPropertyName, getCurrentPropertyTagline, getActivePropertyConfig, savePropertyConfig } from './config.js';
import { bookings, expenses, replaceArrayInPlace } from './state.js';
import { escHtml, fmt, fyLabel, fyMonths } from './utils.js';
import { renderPortfolioFinance, isPortfolioMode } from './property.js';
import {
  clearExpensePhoto,
  getExpensePhotoUploadSnapshot,
  isExpensePhotoConverting,
} from './ai.js';
import { uploadReceiptToStorage, saveExpenseToCloud, deleteExpenseFromCloud } from './supabase.js';

let financeTab = 'expenses';
// ── FINANCE HUB NAVIGATION ───────────────────────────────────────────────────

/** Show the top-level Finance hub. Called on back-nav from any Finance sub-view. */
function backToFinanceHub() {
  const pfin = document.getElementById('portfolio-finance');
  if (pfin) pfin.style.display = 'none';
  const finc = document.getElementById('finance-content');
  if (finc) finc.style.display = '';
  const hub = document.getElementById('finance-hub');
  if (hub) hub.style.display = 'block';
  ['finance-expenses-view', 'finance-reports-view'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  financeTab = null;
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

/** Navigate into a Finance sub-view (expenses or reports). */
function showFinanceSub(sub) {
  financeTab = sub;
  const hub = document.getElementById('finance-hub');
  if (hub) hub.style.display = 'none';
  ['finance-expenses-view', 'finance-reports-view'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  if (sub === 'expenses') {
    const el = document.getElementById('finance-expenses-view');
    if (el) el.style.display = 'block';
    renderExpenses();
    populateExpenseCatSelect();
  } else if (sub === 'reports') {
    const el = document.getElementById('finance-reports-view');
    if (el) el.style.display = 'block';
    // Default to Owner Reports sub-tab
    switchReportsSubTab('reports', document.getElementById('rpt-tab-reports'));
  }
}

/** Switch sub-tabs within the Reports section (Owner Reports / Payouts / Management). */
function switchReportsSubTab(sub, btn) {
  document.querySelectorAll('#finance-reports-view > .tab-row .tab').forEach(t => t.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const inner   = document.getElementById('finance-reports-inner');
  const payouts = document.getElementById('finance-payouts-view');
  const mgmt    = document.getElementById('finance-mgmt-view');
  if (inner)   inner.style.display   = sub === 'reports'  ? '' : 'none';
  if (payouts) payouts.style.display = sub === 'payouts'  ? '' : 'none';
  if (mgmt)    mgmt.style.display    = sub === 'mgmt'     ? '' : 'none';
  if (sub === 'reports')  renderReport();
  if (sub === 'payouts')  renderRevenue();
  if (sub === 'mgmt')     renderManagement();
}

/**
 * Open a Finance settings panel from the Finance hub.
 * Passes returnSection='finance' so the back button returns to Finance, not Settings.
 */
function openFinancePanelFromHub(panelId) {
  globalThis.openSettingsPanel(panelId, 'finance');
}

/**
 * switchFinanceTab — backward-compat shim.
 * Maps old tab names to the new hub navigation.
 */
function switchFinanceTab(tab, btn) {
  financeTab = tab;
  if (tab === 'expenses') { showFinanceSub('expenses'); return; }
  if (tab === 'reports')  { showFinanceSub('reports');  return; }
  // payouts and mgmt are now sub-tabs inside Reports
  if (tab === 'payouts' || tab === 'mgmt') {
    showFinanceSub('reports');
    switchReportsSubTab(tab, document.getElementById('rpt-tab-' + tab));
    return;
  }
  // fallback — show hub
  backToFinanceHub();
}

function switchPayoutsSubTab(sub, btn) {
  document.querySelectorAll('#finance-payouts-view > .tab-row .tab').forEach(t => t.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.getElementById('pay-monthly-view').style.display = sub === 'monthly' ? '' : 'none';
  document.getElementById('pay-fy-view').style.display      = sub === 'fy'      ? '' : 'none';
  if (sub === 'monthly') renderRevenue();
  if (sub === 'fy')      renderReport();
}

function switchMgmtSubTab(sub, btn) {
  document.querySelectorAll('#finance-mgmt-view > .tab-row .tab').forEach(t => t.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.getElementById('mgmt-monthly-view').style.display = sub === 'monthly' ? '' : 'none';
  document.getElementById('mgmt-fy-view').style.display      = sub === 'fy'      ? '' : 'none';
  if (sub === 'monthly') renderManagement();
  if (sub === 'fy')      renderMgmtFY();
}

// switchReportSubTab removed — Reports tab is now a single FY view with send buttons
function switchReportSubTab(sub, btn) {
  renderReport(); // always render the FY report
}

function renderMgmtFY() {
  const el = document.getElementById('mgmt-fy-content');
  if (!el) return;
  const months = fyMonths(reportFY);
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const mdata = months.map(({year, month}) => {
    const bs = bookings.filter(b => b.status !== 'cancelled' && (()=>{ const d=new Date(b.checkin); return d.getFullYear()===year&&d.getMonth()===month; })());
    return { label: mo[month], total: bs.reduce((s,b)=>s+Number(b.mgmtPayout||0),0), count: bs.length };
  });
  const fyTotal = mdata.reduce((s,m)=>s+m.total, 0);
  el.innerHTML = `
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <button onclick="fyPrev();renderMgmtFY()" style="background:var(--warm);border:none;border-radius:8px;width:32px;height:32px;font-size:16px;cursor:pointer">‹</button>
        <div style="font-family:'DM Serif Display',serif;font-size:18px;color:var(--forest)">${fyLabel(reportFY)} Management</div>
        <button onclick="fyNext();renderMgmtFY()" style="background:var(--warm);border:none;border-radius:8px;width:32px;height:32px;font-size:16px;cursor:pointer">›</button>
      </div>
      <div style="text-align:center;padding:12px;background:var(--forest);border-radius:var(--radius-sm);margin-bottom:12px">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.6px;color:var(--sage);margin-bottom:4px">Total Management Payout</div>
        <div style="font-family:'DM Serif Display',serif;font-size:32px;color:white">$${fyTotal.toLocaleString('en-AU',{minimumFractionDigits:0,maximumFractionDigits:0})}</div>
      </div>
      ${mdata.map(m=>`<div class="revenue-row"><div class="rl">${m.label} <span style="color:var(--text-soft);font-size:11px">${m.count} booking${m.count!==1?'s':''}</span></div><div class="rr">$${m.total.toLocaleString('en-AU',{minimumFractionDigits:0,maximumFractionDigits:0})}</div></div>`).join('')}
    </div>`;
}


function renderFinance() {
  if (isPortfolioMode()) {
    renderPortfolioFinance();
    return;
  }
  const singleFin = document.getElementById('finance-content');
  const portfolioFin = document.getElementById('portfolio-finance');
  if (singleFin) singleFin.style.display = '';
  if (portfolioFin) portfolioFin.style.display = 'none';
  // Finance opens on the hub — user taps a row to enter a sub-section
  backToFinanceHub();
}

// switchRevTab is superseded by switchPayoutsSubTab / switchReportSubTab
function switchRevTab(tab) {
  if (tab === 'report') switchPayoutsSubTab('fy', document.getElementById('pay-tab-fy'));
  else switchPayoutsSubTab('monthly', document.getElementById('pay-tab-monthly'));
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

  // Helper: bookings in a given month
  function monthBookings(year, month) {
    return bookings.filter(b => b.status !== 'cancelled' && (function(){ const d = new Date(b.checkin); return d.getFullYear()===year && d.getMonth()===month; })());
  }
  // Helper: expenses in FY — use live array, not stale localStorage read
  function fyExpenses() {
    return expenses.filter(e => {
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

  const fmt2 = n => '$' + Number(n).toLocaleString('en-AU', {minimumFractionDigits:0, maximumFractionDigits:0});
  const fmtPct = n => n ? (n*100).toFixed(0)+'%' : '—';
  const fmtDec = n => n ? '$'+n.toFixed(0) : '—';

  const html = `
  <div id="print-report">
    <!-- FY Navigator -->
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <button onclick="fyPrev()" style="background:var(--warm);border:none;border-radius:8px;width:32px;height:32px;font-size:16px;cursor:pointer">‹</button>
        <div style="font-family:'DM Serif Display',serif;font-size:18px;color:var(--forest)">${fyLabel(reportFY)}</div>
        <button onclick="fyNext()" style="background:var(--warm);border:none;border-radius:8px;width:32px;height:32px;font-size:16px;cursor:pointer">›</button>
      </div>
      <div style="margin-top:12px" class="report-kpi-grid">
        <div class="report-kpi"><div class="report-kpi-val">${fmt2(fyTotalRev)}</div><div class="report-kpi-label">Total Revenue</div></div>
        <div class="report-kpi"><div class="report-kpi-val">${fmt2(fyTotalNet)}</div><div class="report-kpi-label">Net Payout</div></div>
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
          <tr><td>Total Revenue (Host Payout)</td><td>${fmt2(fyTotalRev)}</td></tr>
          <tr><td>Net Payout (after fees)</td><td>${fmt2(fyTotalNet)}</td></tr>
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

function renderRevenue() {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  document.getElementById('rev-month-title').textContent = months[revMonth] + ' ' + revYear;
  const monthBookings = bookings.filter(b => {
    const d = new Date(b.checkin);
    return b.status !== 'cancelled' && d.getMonth()===revMonth && d.getFullYear()===revYear;
  });
  const totalHost = monthBookings.reduce((s,b)=>s+Number(b.hostPayout||0),0);
  const totalCleaning = monthBookings.reduce((s,b)=>s+Number(b.cleaningFee||0),0);
  const totalMgmt = monthBookings.reduce((s,b)=>s+Number(b.mgmtFee||0),0);
  // Net = (hostPayout - cleaningFee) * mgmtFee% — but mgmtFee is already the dollar amount
  const totalNet = monthBookings.reduce((s,b)=>s+Number(b.netPayout||0),0);
  document.getElementById('total-revenue').textContent = '$' + totalHost.toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2});
  document.getElementById('total-net').textContent = '$' + totalNet.toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2});
  document.getElementById('revenue-sub').textContent = monthBookings.length + ' booking' + (monthBookings.length!==1?'s':'');
  document.getElementById('finance-summary-content').innerHTML = `
    <div class="finance-summary">
      <div class="finance-row"><span class="finance-label">Host Payout</span><span class="finance-val">$${totalHost.toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}</span></div>
      <div class="finance-row"><span class="finance-label">Cleaning Fees</span><span class="finance-val">- $${totalCleaning.toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}</span></div>
      <div class="finance-row"><span class="finance-label">Management Fees</span><span class="finance-val">- $${totalMgmt.toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}</span></div>
      <div class="finance-row finance-total"><span class="finance-label">Net Payout</span><span class="finance-val">$${totalNet.toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}</span></div>
    </div>`;
  document.getElementById('revenue-breakdown').innerHTML = monthBookings.length ? [...monthBookings].sort((a,b)=>new Date(a.checkin)-new Date(b.checkin)).map(b=>`
    <div class="revenue-row">
      <div class="rl"><div style="font-weight:500;font-size:13px">${b.name}</div><div style="font-size:11px;color:var(--text-soft)">${fmt(b.checkin)} · ${b.nights}n</div></div>
      <div style="text-align:right"><div class="rr">$${Number(b.hostPayout||0).toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}</div><div style="font-size:11px;color:var(--moss)">Net: $${Number(b.netPayout||0).toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}</div></div>
    </div>`).join('') : '<div style="color:var(--text-soft);font-size:13px;">No bookings this month.</div>';
}

let mgmtYear = new Date().getFullYear();
let mgmtMonth = new Date().getMonth();
function mgmtPrev() { mgmtMonth--; if(mgmtMonth<0){mgmtMonth=11;mgmtYear--;} mgmtSelected.clear(); renderManagement(); }
function mgmtNext() { mgmtMonth++; if(mgmtMonth>11){mgmtMonth=0;mgmtYear++;} mgmtSelected.clear(); renderManagement(); }

function renderManagement() {
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  document.getElementById('mgmt-month-title').textContent = monthNames[mgmtMonth] + ' ' + mgmtYear;
  const monthBookings = bookings.filter(b => {
    const d = new Date(b.checkin);
    return b.status !== 'cancelled' && d.getMonth()===mgmtMonth && d.getFullYear()===mgmtYear;
  });
  const totalMgmtPayout = monthBookings.reduce((s,b)=>s+Number(b.mgmtPayout||0),0);
  document.getElementById('total-mgmt').textContent = '$' + totalMgmtPayout.toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2});
  document.getElementById('mgmt-sub').textContent = monthBookings.length + ' booking' + (monthBookings.length!==1?'s':'');
  document.getElementById('mgmt-breakdown').innerHTML = monthBookings.length ? [...monthBookings].sort((a,b)=>new Date(a.checkin)-new Date(b.checkin)).map(b=>{
    const mgmtPct = b.mgmtFeeRaw || (b.mgmtFee && b.hostPayout ? Math.round((b.mgmtFee/b.hostPayout)*1000)/10 : 0);
    return `<div class="revenue-row mgmt-sel-row" id="mgmt-row-${b.id}" onclick="toggleMgmtSelect(${b.id})" style="align-items:flex-start;cursor:pointer;border-radius:8px;padding:10px 4px;margin:-2px 0;transition:background 0.15s">
      <div style="display:flex;align-items:center;gap:12px;flex:1">
        <div id="mgmt-cb-${b.id}" style="width:24px;height:24px;border-radius:6px;border:2px solid var(--stone);background:white;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:14px;transition:all 0.15s"></div>
        <div class="rl">
          <div style="font-weight:500;font-size:13px">${b.name}</div>
          <div style="font-size:11px;color:var(--text-soft)">${fmt(b.checkin)} · ${b.nights}n</div>
          <div style="font-size:11px;color:var(--text-soft)">Host: $${Number(b.hostPayout||0).toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})} · Fee: ${mgmtPct}%</div>
        </div>
      </div>
      <div style="text-align:right">
        <div class="rr">$${Number(b.mgmtPayout||0).toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
      </div>
    </div>`;
  }).join('') : '<div style="color:var(--text-soft);font-size:13px;">No bookings this month.</div>';
}

let mgmtSelected = new Set();
function toggleMgmtSelect(id) {
  if (mgmtSelected.has(id)) {
    mgmtSelected.delete(id);
  } else {
    mgmtSelected.add(id);
  }
  const cb = document.getElementById('mgmt-cb-' + id);
  const row = document.getElementById('mgmt-row-' + id);
  if (cb) {
    cb.style.background = mgmtSelected.has(id) ? 'var(--forest)' : 'white';
    cb.style.borderColor = mgmtSelected.has(id) ? 'var(--forest)' : 'var(--stone)';
    cb.textContent = mgmtSelected.has(id) ? '✓' : '';
    cb.style.color = 'white';
  }
  if (row) row.style.background = mgmtSelected.has(id) ? 'rgba(30,58,47,0.06)' : '';
}

function generateInvoice() {
  const selected = bookings.filter(b => mgmtSelected.has(b.id));
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
  const ls   = k => localStorage.getItem(lsKey(k)) || '';
  return {
    name:    host.name    || ls('inv-name'),
    email:   host.email   || ls('inv-email'),
    address: host.address || ls('inv-address'),
    company: host.company || ls('inv-company'),
    abn:     host.abn     || ls('inv-abn'),
    acn:     host.acn     || ls('inv-acn'),
  };
}
function buildInvoicePDF(selected, client) {
  const inv = _getInvoiceIdentity();
  const bank = {
    name: localStorage.getItem(lsKey('bank-name')) || '',
    bsb: localStorage.getItem(lsKey('bank-bsb')) || '',
    acc: localStorage.getItem(lsKey('bank-acc')) || '',
    bank: localStorage.getItem(lsKey('bank-bank')) || ''
  };
  const invNum = 'INV-' + Date.now().toString().slice(-6);
  const today = new Date().toLocaleDateString('en-AU',{day:'numeric',month:'long',year:'numeric'});
  const totalMgmt = selected.reduce((s,b)=>s+Number(b.mgmtPayout||0),0);
  const rows = selected.map(b => {
    const mgmtPct = b.mgmtFeeRaw || (b.mgmtFee && b.hostPayout ? Math.round((b.mgmtFee/b.hostPayout)*1000)/10 : 0);
    return `<tr>
      <td style="padding:10px 8px;border-bottom:1px solid #eee">${b.name}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #eee">${fmt(b.checkin)} — ${fmt(b.checkout)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #eee;text-align:right">$${Number(b.hostPayout||0).toFixed(2)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #eee;text-align:right">$${Number(b.cleaningFee||0).toFixed(2)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #eee;text-align:center">${mgmtPct}%</td>
      <td style="padding:10px 8px;border-bottom:1px solid #eee;text-align:right;font-weight:600">$${Number(b.mgmtPayout||0).toFixed(2)}</td>
    </tr>`;
  }).join('');

  const toBlock = client ? `
    <div style="margin-bottom:28px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#999;margin-bottom:6px">Bill To</div>
      <div style="font-weight:700;font-size:15px">${client.name}</div>
      ${client.contact?`<div style="color:#666;font-size:13px">${client.contact}</div>`:''}
      ${client.email?`<div style="color:#666;font-size:13px">${client.email}</div>`:''}
      ${client.address?`<div style="color:#666;font-size:13px">${client.address}</div>`:''}
    </div>` : '';

  const bankBlock = (bank.bsb && bank.acc) ? `
    <div style="background:#F8F8F8;border-radius:8px;padding:14px 16px;margin-top:28px;font-size:13px">
      <div style="font-weight:700;margin-bottom:8px">Payment Details</div>
      ${bank.name?`<div><span style="color:#666">Account Name:</span> ${bank.name}</div>`:''}
      <div><span style="color:#666">BSB:</span> ${bank.bsb} &nbsp;|&nbsp; <span style="color:#666">Account:</span> ${bank.acc}</div>
      ${bank.bank?`<div style="color:#666;margin-top:2px">${bank.bank}</div>`:''}
    </div>` : '';

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <style>
    body{font-family:'Helvetica Neue',sans-serif;color:#1a1a1a;max-width:700px;margin:40px auto;padding:0 20px}
    h1{font-size:28px;color:#1E3A2F;margin:0;font-weight:800}
    .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px;padding-bottom:20px;border-bottom:2px solid #1E3A2F}
    .inv-meta{text-align:right;font-size:13px;color:#666}
    .inv-meta strong{display:block;font-size:22px;color:#1E3A2F;margin-bottom:4px}
    table{width:100%;border-collapse:collapse;margin-top:20px;font-size:13px}
    th{background:#1E3A2F;color:white;padding:10px 8px;text-align:left;font-weight:600}
    th:last-child,th:nth-child(3),th:nth-child(4),th:nth-child(6){text-align:right}
    th:nth-child(5){text-align:center}
    .total-row td{padding:12px 8px;font-weight:700;font-size:15px;border-top:2px solid #1E3A2F}
    .footer{margin-top:40px;font-size:11px;color:#999;text-align:center;border-top:1px solid #eee;padding-top:16px}
    .property-badge{background:#F0EDE8;border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:13px}
  </style></head><body>
  <div class="header">
    <div>
      <h1>${inv.company || inv.name || getCurrentPropertyName()}</h1>
      ${inv.name && inv.company ? `<div style="color:#666;margin-top:3px;font-size:13px">${inv.name}</div>` : ''}
      ${inv.abn ? `<div style="color:#666;font-size:12px">ABN: ${inv.abn}</div>` : ''}
      ${inv.acn ? `<div style="color:#666;font-size:12px">ACN: ${inv.acn}</div>` : ''}
      ${inv.email ? `<div style="color:#666;font-size:12px">${inv.email}</div>` : ''}
      ${inv.address ? `<div style="color:#666;font-size:12px">${inv.address}</div>` : ''}
    </div>
    <div class="inv-meta">
      <strong>${invNum}</strong>
      <div>Date: ${today}</div>
    </div>
  </div>
  ${toBlock}
  <div class="property-badge">
    🏡 <strong>${getCurrentPropertyName()}</strong> · ${getCurrentPropertyTagline()}<br>
    <span style="color:#666">Management Fee Invoice</span>
  </div>
  <table>
    <thead><tr>
      <th>Guest</th><th>Dates</th><th style="text-align:right">Host Payout</th>
      <th style="text-align:right">Cleaning Fee</th><th style="text-align:center">Mgmt %</th>
      <th style="text-align:right">Management Payout</th>
    </tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr class="total-row">
      <td colspan="5" style="text-align:right;color:#1E3A2F">Total Management Payout</td>
      <td style="text-align:right;color:#C17F3E;font-size:18px">$${totalMgmt.toFixed(2)}</td>
    </tr></tfoot>
  </table>
  ${bankBlock}
  <div class="footer">${getCurrentPropertyName()} Property Management · ${[getPropertyConfig().suburb, getPropertyConfig().state].filter(Boolean).join(' ')} · Generated ${today}</div>
  <div style="text-align:center;margin-top:32px;display:flex;gap:12px;justify-content:center">
    <button onclick="window.print()" style="background:#1E3A2F;color:white;border:none;border-radius:8px;padding:12px 24px;font-size:14px;font-weight:600;cursor:pointer">🖨 Save as PDF</button>
    <button onclick="window.close()" style="background:#F0EDE8;color:#1A1A1A;border:none;border-radius:8px;padding:12px 24px;font-size:14px;font-weight:600;cursor:pointer">← Back to App</button>
  </div>
</body></html>`;
  const w = window.open('','_blank');
  w.document.write(html);
  w.document.close();
}
// ── EXPENSE CATEGORY MANAGEMENT ───────────────────────────────────────────
function renderExpenseCatSettings() {
  const cats = getExpenseCats();
  const el = document.getElementById('expense-cats-list');
  el.innerHTML = cats.map((c, i) => `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <input type="text" value="${c}" id="expcat-${i}" style="flex:1;font-size:13px" onchange="updateExpenseCat(${i},this.value)">
      <button onclick="deleteExpenseCat(${i})" style="background:none;border:none;color:var(--red);font-size:16px;cursor:pointer;padding:4px">✕</button>
    </div>`).join('');
}

function updateExpenseCat(index, newName) {
  const cats = getExpenseCats();
  if (newName.trim()) { cats[index] = newName.trim(); localStorage.setItem(lsKey('expense-cats'), JSON.stringify(cats)); if (typeof saveAppConfigToCloud === 'function') saveAppConfigToCloud({ expense_cats: cats }).catch(() => {}); populateExpenseCatSelect(); }
}

function addExpenseCat() {
  const val = document.getElementById('new-expense-cat').value.trim();
  if (!val) return;
  const cats = getExpenseCats();
  cats.push(val);
  localStorage.setItem(lsKey('expense-cats'), JSON.stringify(cats));
  if (typeof saveAppConfigToCloud === 'function') saveAppConfigToCloud({ expense_cats: cats }).catch(() => {});
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
  localStorage.setItem(lsKey('expense-cats'), JSON.stringify(cats));
  if (typeof saveAppConfigToCloud === 'function') saveAppConfigToCloud({ expense_cats: cats }).catch(() => {});
  renderExpenseCatSettings();
  populateExpenseCatSelect();
}

async function resetExpenseCats() {
  const _okReset = await globalThis.showAppModal({ title: 'Reset Categories', msg: "Reset to default categories? This won't affect existing expenses.", confirmText: 'Reset' });
  if (!_okReset) return;
  localStorage.removeItem(lsKey('expense-cats'));
  renderExpenseCatSettings();
  populateExpenseCatSelect();
  globalThis.showBanner('✓ Categories reset', 'ok');
}
function saveBankDetails() {
  ['name','bsb','acc','bank'].forEach(k => {
    const val = document.getElementById('inv-bank-'+k)?.value?.trim();
    if (val !== undefined) localStorage.setItem(lsKey('bank-')+k, val);
  });
  const el = document.getElementById('inv-bank-confirm');
  el.style.display='block'; setTimeout(()=>el.style.display='none',2000);
  globalThis.showBanner('✓ Settings saved: bank details', 'ok');
}

function loadClients() { return JSON.parse(localStorage.getItem(lsKey('clients'))||'[]'); }
function saveClients(c) { localStorage.setItem(lsKey('clients'), JSON.stringify(c)); }

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
  ['name','company','abn','acn','email','address'].forEach(k => {
    const val = document.getElementById('inv-'+k)?.value?.trim();
    if (val !== undefined) localStorage.setItem(lsKey('inv-')+k, val);
  });
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

let expenseListExpanded = false;
// Tracks per-month collapse state. null = defaults (newest open, rest closed).
// A Set of month-label strings that are currently COLLAPSED.
let _expMonthCollapsed = null;

function toggleExpenseList() {
  // Expand/collapse all months
  if (!_expMonthCollapsed) {
    // Default state (newest open) — collapse all
    _expMonthCollapsed = new Set(_allExpenseMonthKeys());
    expenseListExpanded = false;
  } else if (_expMonthCollapsed.size > 0) {
    // Some collapsed — expand all
    _expMonthCollapsed = new Set();
    expenseListExpanded = true;
  } else {
    // All expanded — reset to default
    _expMonthCollapsed = null;
    expenseListExpanded = false;
  }
  renderExpenses();
}

/** Toggle a single month section open/closed. */
function toggleExpenseMonth(key) {
  if (!_expMonthCollapsed) {
    // First explicit toggle — initialise from default state
    const allKeys = _allExpenseMonthKeys();
    _expMonthCollapsed = new Set(allKeys.slice(1)); // all except newest are closed
  }
  if (_expMonthCollapsed.has(key)) {
    _expMonthCollapsed.delete(key);
  } else {
    _expMonthCollapsed.add(key);
  }
  renderExpenses();
}

/** Returns all month keys (newest first) derived from the current expenses array. */
function _allExpenseMonthKeys() {
  const sorted = [...expenses].sort((a, b) => {
    const da = a.date || ''; const db = b.date || '';
    return db > da ? 1 : db < da ? -1 : 0;
  });
  const keys = [];
  sorted.forEach(e => {
    const key = new Date(e.date || Date.now()).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
    if (!keys.includes(key)) keys.push(key);
  });
  return keys;
}

function clearExpenseFilters() {
  const s = document.getElementById('expense-search'); if (s) s.value = '';
  const c = document.getElementById('expense-filter-cat'); if (c) c.value = '';
  const f = document.getElementById('expense-filter-from'); if (f) f.value = '';
  const t = document.getElementById('expense-filter-to'); if (t) t.value = '';
  expenseListExpanded = false;
  _expMonthCollapsed = null; // reset to defaults on filter clear
  renderExpenses();
}

function renderExpenses() {
  // Set today's date as default if field is empty
  const expDateEl = document.getElementById('exp-date');
  if (expDateEl && !expDateEl.value) expDateEl.value = new Date().toISOString().split('T')[0];

  // ── Read filter values FIRST before any DOM manipulation ──────────────────
  const q     = (document.getElementById('expense-search')?.value || '').toLowerCase().trim();
  const catF  = document.getElementById('expense-filter-cat')?.value || '';
  const fromF = document.getElementById('expense-filter-from')?.value || '';
  const toF   = document.getElementById('expense-filter-to')?.value || '';
  const isFiltering = !!(q || catF || fromF || toF);

  // ── Populate category filter dropdown (preserve selected value) ───────────
  const catFilterEl = document.getElementById('expense-filter-cat');
  if (catFilterEl) {
    const allCats = [...new Set(expenses.map(e => e.category).filter(Boolean))].sort();
    catFilterEl.innerHTML = '<option value="">All Categories</option>' +
      allCats.map(c => `<option value="${c}" ${c===catF?'selected':''}>${c}</option>`).join('');
  }

  // ── Totals summary (always from ALL expenses, ignoring filters) ────────────
  const totals = {};
  let grandTotal = 0;
  expenses.forEach(e => {
    totals[e.category] = (totals[e.category] || 0) + Number(e.amount);
    grandTotal += Number(e.amount);
  });
  const summaryEl = document.getElementById('expense-summary');
  if (summaryEl) summaryEl.innerHTML = `
    <div class="card" style="padding:12px 16px">
      <div style="display:flex;justify-content:space-between;align-items:center;padding-bottom:10px;border-bottom:1px solid var(--warm);margin-bottom:8px">
        <div style="font-weight:700;font-size:15px">Total Expenses</div>
        <div style="font-family:'DM Serif Display',serif;font-size:22px;color:var(--red)">$${grandTotal.toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
      </div>
      ${Object.entries(totals).sort((a,b)=>b[1]-a[1]).map(([c,amt]) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--warm)">
          <div style="font-size:13px;color:var(--text)">${c}</div>
          <div style="font-size:13px;font-weight:600;color:var(--forest)">$${amt.toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
        </div>`).join('')}
    </div>`;

  const listEl = document.getElementById('expenses-list');
  if (!listEl) return;
  if (!expenses.length) { listEl.innerHTML = '<div style="text-align:center;padding:28px 16px"><div style="font-size:36px;margin-bottom:10px">💸</div><div style="font-weight:600;font-size:14px;margin-bottom:4px">No expenses yet</div><div style="font-size:12px;color:var(--text-soft)">Add your first expense below</div></div>'; return; }

  // ── Apply filters ──────────────────────────────────────────────────────────
  let filtered = [...expenses].sort((a,b) => { const da = a.date||''; const db = b.date||''; return db > da ? 1 : db < da ? -1 : 0; });
  if (q)     filtered = filtered.filter(e =>
    (e.merchant||'').toLowerCase().includes(q) ||
    (e.description||'').toLowerCase().includes(q) ||
    String(e.receiptNum||'').toLowerCase().includes(q));
  if (catF)  filtered = filtered.filter(e => e.category === catF);
  if (fromF) filtered = filtered.filter(e => e.date >= fromF);
  if (toF)   filtered = filtered.filter(e => e.date <= toF);

  if (!filtered.length) {
    listEl.innerHTML = '<div style="padding:12px 0;color:var(--text-soft);font-size:13px">No results found</div>';
    const sm = document.getElementById('expenses-show-more'); if (sm) sm.style.display = 'none';
    return;
  }

  const expRow = e => {
    const isRefund = Number(e.amount) < 0;
    const amtColor = isRefund ? '#27AE60' : '#C0392B';
    const amtLabel = isRefund
      ? `<span style="font-size:10px;font-weight:600;color:#27AE60;letter-spacing:0.2px">refund</span>`
      : '';
    // Receipt badge — stopPropagation so link tap doesn't also fire row tap
    const receiptBadge = e.driveLink
      ? `<a href="${e.driveLink}" target="_blank" onclick="event.stopPropagation()" style="font-size:11px;color:var(--moss);font-weight:600;text-decoration:none">📎 receipt</a>`
      : e.awaitingReceipt
        ? `<span style="font-size:11px;color:var(--amber)">⚠ awaiting</span>`
        : (!e.receiptType || e.receiptType === 'missing')
          ? `<span style="font-size:11px;color:var(--red)">✕ no receipt</span>`
          : `<span style="font-size:11px;color:var(--moss)">✓ ${e.receiptType === 'e-receipt' ? 'e-receipt' : 'printed'}</span>`;
    return `
    <div class="expense-item" data-expense-id="${e.id}"
         onclick="openExpenseView(${e.id})"
         style="display:flex;justify-content:space-between;align-items:flex-start;
                padding:9px 0;border-bottom:1px solid var(--warm);
                cursor:pointer;-webkit-tap-highlight-color:transparent;
                -webkit-user-select:none;user-select:none">
      <div style="flex:1;min-width:0;padding-right:12px">
        <div style="display:flex;align-items:baseline;gap:6px">
          <span style="font-weight:600;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px;display:inline-block">${e.merchant||'Unknown'}</span>
          ${e.description ? `<span style="font-size:12px;color:var(--text-soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100px;display:inline-block">${escHtml(e.description)}</span>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:5px;margin-top:3px;flex-wrap:wrap">
          <span style="font-size:10px;color:var(--text-soft)">${e.category||''}</span>
          <span style="font-size:11px;color:var(--text-soft)">· ${fmt(e.date)}</span>
          ${receiptBadge}
        </div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:5px;flex-shrink:0">
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:1px">
          <span style="font-family:'DM Serif Display',serif;font-size:15px;font-weight:700;color:${amtColor}">$${Math.abs(Number(e.amount)).toFixed(2)}</span>
          ${amtLabel}
        </div>
        <div style="display:flex;gap:4px">
          <button onclick="event.stopPropagation();openExpenseEdit(${e.id})"
                  style="font-size:11px;color:var(--forest);background:none;border:none;
                         padding:2px 0;cursor:pointer;font-family:'DM Sans',sans-serif;font-weight:600;
                         text-decoration:underline;text-underline-offset:2px">Edit</button>
          <button onclick="event.stopPropagation();deleteExpense(${e.id})"
                  style="font-size:12px;color:var(--red);background:none;border:none;
                         cursor:pointer;padding:2px 4px;font-family:'DM Sans',sans-serif">✕</button>
        </div>
      </div>
    </div>`;
  };

  // ── Group ALL filtered expenses by calendar month (collapse handled per-month) ──
  const grouped = filtered.reduce((acc, e) => {
    const d = new Date(e.date || Date.now());
    const key = d.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
    if (!acc[key]) acc[key] = { items: [], total: 0 };
    acc[key].items.push(e);
    acc[key].total += Number(e.amount) || 0;
    return acc;
  }, {});

  const monthKeys = Object.keys(grouped); // newest-first from sort above

  listEl.innerHTML = monthKeys.map((monthLabel, idx) => {
    const { items, total } = grouped[monthLabel];
    const count = items.length;
    const monthTotal = total.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    // Default (null): newest month open, all others closed; filter mode: all open
    const collapsed = isFiltering ? false
      : _expMonthCollapsed ? _expMonthCollapsed.has(monthLabel)
      : idx > 0;
    const safeKey = monthLabel.replace(/[^a-zA-Z0-9]/g, '_');
    const chevron = collapsed ? '›' : '∨';
    const escapedLabel = monthLabel.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `
    <div class="exp-month-group" style="margin-bottom:4px">
      <div onclick="toggleExpenseMonth('${escapedLabel}')"
           style="display:flex;justify-content:space-between;align-items:center;
                  padding:11px 0 10px;border-bottom:2px solid var(--warm);
                  cursor:pointer;-webkit-tap-highlight-color:transparent;user-select:none">
        <div style="display:flex;align-items:baseline;gap:0">
          <span style="font-size:15px;font-weight:700;color:var(--text)">${escHtml(monthLabel)}</span>
          <span style="font-size:11px;font-weight:400;color:var(--text-soft);margin-left:7px">${count} expense${count !== 1 ? 's' : ''}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-family:'DM Serif Display',serif;font-size:16px;color:var(--forest)">$${monthTotal}</span>
          <span style="font-size:16px;color:#C7C7CC;font-weight:300;width:14px;text-align:center">${chevron}</span>
        </div>
      </div>
      <div id="exp-month-${safeKey}" style="display:${collapsed ? 'none' : 'block'}">
        ${items.map(expRow).join('')}
      </div>
    </div>`;
  }).join('');

  globalThis.animateList('#expenses-list');
  setTimeout(globalThis.attachLongPress, 60);

  // Show/hide expand-all toggle (repurposes existing expenses-show-more)
  const sm = document.getElementById('expenses-show-more');
  const tb = document.getElementById('expenses-toggle-btn');
  if (sm) {
    const hasMultipleMonths = monthKeys.length > 1;
    sm.style.display = (!isFiltering && hasMultipleMonths) ? 'block' : 'none';
    if (tb) {
      const allExpanded = _expMonthCollapsed !== null && _expMonthCollapsed.size === 0;
      tb.textContent = allExpanded ? 'Collapse months ↑' : 'Expand all months ↓';
    }
  }
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
  expenses.push(exp);
  try { globalThis.savePropertyData(); } catch(storageErr) {
    globalThis.showBanner('⚠ Storage full — expense saved without photo', 'warn');
  }
  // Sync to Supabase (non-blocking)
  if (typeof saveExpenseToCloud === 'function') saveExpenseToCloud(exp).catch(() => {});

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
    const receiptsCard = document.querySelector('#finance-expenses-view .card:last-of-type');
    if (receiptsCard) receiptsCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!exp.photo) globalThis.showBanner('✓ Expense saved', 'ok');
    // receipt handled separately via Supabase Storage
    else globalThis.showBanner('⟳ Uploading receipt...', 'info');
  }
  return exp;
}

async function saveExpenseToDriveAndSheet(exp) {
  // ── Upload receipt to Supabase Storage ──────────────────────────────────────
  let driveLink = null;
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
          const saved = expenses.find(e => e.id === exp.id);
          if (saved) {
            saved.driveLink = driveLink;
            globalThis.savePropertyData();
            renderExpenses();
            if (typeof saveExpenseToCloud === 'function') saveExpenseToCloud(saved).catch(() => {});
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
  return new Promise((resolve, reject) => {
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
      let offset = 0;
      const offsets = [];
      const preXref = parts.slice(0, -1); // everything before xref
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
  if (exp && typeof deleteExpenseFromCloud === 'function') deleteExpenseFromCloud(exp).catch(() => {});
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
  const e = expenses.find(e => e.id === editingExpenseId);
  document.getElementById('ee-receipt-label').textContent = e && e.driveLink ? 'Upload a replacement receipt' : 'Upload receipt photo';
}
function openExpenseView(id) {
  const e = expenses.find(x => x.id === id);
  if (!e) return;
  const isRefund   = Number(e.amount) < 0;
  const amtColor   = isRefund ? '#27AE60' : '#C0392B';
  const amtDisplay = (isRefund ? '−' : '') + '$' + Math.abs(Number(e.amount)).toFixed(2);

  // ── Receipt action block ────────────────────────────────────────────────────
  let receiptBlock;
  if (e.driveLink) {
    receiptBlock = `
      <a href="${e.driveLink}" target="_blank"
         style="display:flex;align-items:center;justify-content:center;gap:8px;
                width:100%;padding:11px;box-sizing:border-box;
                background:var(--mist);border:1.5px solid var(--moss);border-radius:10px;
                color:var(--moss);font-weight:600;font-size:13px;text-decoration:none;
                font-family:'DM Sans',sans-serif">
        📎 View Receipt
      </a>`;
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
          <div style="font-family:'DM Serif Display',serif;font-size:24px;line-height:1.15;
                      word-break:break-word">${escHtml(e.merchant||'Unknown')}</div>
          ${e.description ? `<div style="font-size:13px;color:var(--text-soft);margin-top:4px">${escHtml(e.description)}</div>` : ''}
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
            onclick="globalThis.closeDetailModal();openExpenseEdit(${e.id})">✏️ Edit Expense</button>

    <!-- ── Destructive action (secondary) ── -->
    <button class="btn-secondary" style="width:100%;margin-bottom:8px;background:#FDECEA;color:var(--red);border-color:#FDECEA"
            onclick="globalThis.closeDetailModal();deleteExpense(${e.id})">🗑 Delete Expense</button>
  `;
  document.getElementById('detail-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(globalThis.attachModalHandleDrag, 0);
}

function openExpenseEdit(id) {
  const e = expenses.find(e => e.id === id);
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
    receiptLinkEl.href = e.driveLink;
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
  const e = expenses.find(e => e.id === editingExpenseId);
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
  closeExpenseEdit();
  renderExpenses();
  globalThis.showBanner('✓ Expense updated', 'ok');
}
// ── PROPERTY DATA ─────────────────────────────────────────────────────────


const DEFAULT_EXPENSE_CATS = [
  'Cleaning & Garden','Maintenance & Repairs','Supplies & Consumables',
  'Utilities & Rates','Insurance','Furnishings & Equipment',
  'Renovation','Professional Services','Other'
];
function getExpenseCats() {
  const saved = localStorage.getItem(lsKey('expense-cats'));
  if (!saved) return DEFAULT_EXPENSE_CATS;
  try {
    const parsed = JSON.parse(saved);
    // Validate: must be a non-empty array of non-blank strings.
    // Falls back to defaults if cloud hydration wrote empty/malformed data.
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(c => typeof c === 'string' && c.trim())) {
      return parsed;
    }
  } catch (e) {
    // Malformed JSON — clear it so it doesn't keep failing
    localStorage.removeItem(lsKey('expense-cats'));
  }
  return DEFAULT_EXPENSE_CATS;
}
globalThis.getExpenseCats = getExpenseCats;
// ── OWNER REPORT ──────────────────────────────────────────────────────────────

function populateMgmtFeePanel() {
  const rate = localStorage.getItem(lsKey("mgmt-fee-rate"));
  const el = document.getElementById("settings-mgmt-fee-rate");
  if (el) el.value = rate !== null ? rate : "";
}

async function saveMgmtFeeRate() {
  const el = document.getElementById("settings-mgmt-fee-rate");
  if (!el) return;
  const rate = parseFloat(el.value);
  if (isNaN(rate) || rate < 0 || rate > 100) { globalThis.showBanner("⚠ Enter a valid fee between 0 and 100", "warn"); return; }
  localStorage.setItem(lsKey("mgmt-fee-rate"), String(rate));
  // Save to properties table in Supabase
  if (typeof savePropertyToCloud === "function") {
    const cfg = (typeof getActivePropertyConfig === "function") ? getActivePropertyConfig() : {};
    savePropertyToCloud(cfg).catch(() => {});
  }
  const confirm = document.getElementById("mgmt-fee-confirm");
  if (confirm) { confirm.style.display = "block"; setTimeout(() => { confirm.style.display = "none"; }, 2000); }
  globalThis.showBanner("✓ Management fee rate saved", "ok");
}

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
    const res = await fetch('/.netlify/functions/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
  const SAGE   = [143, 175, 133];
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
  const fmt2 = n => '$' + Number(n).toLocaleString('en-AU',{minimumFractionDigits:0,maximumFractionDigits:0});
  function mdata(yr, mo) {
    const bs = bookings.filter(b => b.status !== 'cancelled' && (function(){ const d=new Date(b.checkin); return d.getFullYear()===yr&&d.getMonth()===mo; })());
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
  const allExp = (JSON.parse(localStorage.getItem(lsKey('expenses'))||'[]')).filter(e => {
    const d=new Date(e.date); const mo=d.getMonth(); const yr=d.getFullYear();
    return (yr===fy&&mo>=6)||(yr===fy+1&&mo<=5);
  });
  const fyTotalExp = allExp.reduce((s,e)=>s+Number(e.amount||0),0);
  const fyNetInc = fyNet - fyTotalExp;

  const kpis = [
    { label:'Total Revenue', val: fmt2(fyRev) },
    { label:'Net Payout',    val: fmt2(fyNet) },
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
      ['Total Revenue (Host Payout)', fmt2(fyRev)],
      ['Net Payout (after platform fees)', fmt2(fyNet)],
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

  // Revenue table
  rows.push(['Revenue by Month & Platform']);
  rows.push(['Month','Airbnb','VRBO','Direct','Total']);
  months.forEach(({year,month}) => {
    const bs = bookings.filter(b => { const d=new Date(b.checkin); return d.getFullYear()===year&&d.getMonth()===month; });
    const rev = p => bs.filter(b=>b.platform===p).reduce((s,b)=>s+Number(b.hostPayout||0),0);
    const total = bs.reduce((s,b)=>s+Number(b.hostPayout||0),0);
    rows.push([mo[month], rev('Airbnb')||'', rev('VRBO')||'', rev('Direct')||'', total||'']);
  });
  rows.push([]);

  // Occupancy table
  rows.push(['Occupancy & Performance']);
  rows.push(['Month','Available Nights','Booked Nights','Occupancy%','ADR','RevPAR']);
  months.forEach(({year,month}) => {
    const bs = bookings.filter(b => { const d=new Date(b.checkin); return d.getFullYear()===year&&d.getMonth()===month; });
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
  const allExp = (JSON.parse(localStorage.getItem(lsKey('expenses'))||'[]')).filter(e => {
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
};
