/**
 * AI features: smart pricing, expense analysis, ignore list, receipt OCR, booking screenshot import.
 */
import { AIService } from './ai-logic.js';
import { expenses, bookings } from './state.js';
import { calcNights, escHtml, localDateStr } from './utils.js';
import { getCurrentPropertyName, getActivePropertyConfig } from './config.js';
import { isRevenueBearingBooking } from './booking-revenue.js';
import { findMatchingCleanForBooking } from './cleaning.js';
import { saveAppConfigToCloud } from './supabase.js';

export { renderSmartPricingPanel } from './smart-pricing.js';

// ── AI EXPENSE ANALYSER ───────────────────────────────────────────────────
export async function analyseExpenses() {
  const resultEl = document.getElementById('expense-analysis-result');

  if (!expenses.length) {
    resultEl.style.display = 'block';
    resultEl.innerHTML = '⚠️ No expenses to analyse.';
    return;
  }

  resultEl.style.display = 'block';
  resultEl.innerHTML = '⟳ Analysing your expenses...';

  const expenseSummary = expenses.map(e => ({
    date: e.date,
    amount: e.amount,
    category: e.category,
    merchant: e.merchant || e.vendor || '',
    description: e.description || '',
    hasReceipt: !!(e.receiptUrl || (Array.isArray(e.driveLink) ? e.driveLink.length : e.driveLink) || e.receiptData)
  }));

  const totalSpend = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const byCategory = {};
  expenses.forEach(e => {
    const cat = e.category || 'Uncategorised';
    byCategory[cat] = (byCategory[cat] || 0) + (Number(e.amount) || 0);
  });

  const ignoreList = loadAIIgnoreList();
  const ignoreContext = ignoreList.length
    ? `\n\nUSER'S IGNORE LIST — do NOT flag these items, the user has reviewed and accepted them:\n${ignoreList.map(i => `- [${i.type}] ${i.label}${i.reason ? ' (reason: ' + i.reason + ')' : ''}`).join('\n')}`
    : '';

  const prompt = `You are an accountant reviewing Airbnb rental property expenses for ${getCurrentPropertyName()}.

Total expenses: A$${totalSpend.toFixed(2)} across ${expenses.length} items.
By category: ${JSON.stringify(byCategory)}
All expenses: ${JSON.stringify(expenseSummary)}${ignoreContext}

Analyse these expenses and identify:
1. DUPLICATES — same vendor + similar amount within 30 days
2. ANOMALIES — amounts way above normal for that category
3. MISSING RECEIPTS — expenses over $50 with no receipt attached
4. UNCATEGORISED — items in "Other" or blank category that should be recategorised
5. RECURRING CHARGES — subscriptions or regular charges (flag if they seem forgotten)
6. INSIGHTS — 2-3 useful observations about spending patterns

Return ONLY valid JSON, no markdown:
{
  "duplicates": [{"date1":"","date2":"","merchant":"","amount":0,"note":""}],
  "anomalies": [{"date":"","merchant":"","amount":0,"category":"","note":""}],
  "missingReceipts": [{"date":"","merchant":"","amount":0}],
  "uncategorised": [{"date":"","merchant":"","amount":0,"suggestedCategory":""}],
  "recurring": [{"merchant":"","frequency":"","totalSpend":0,"note":""}],
  "insights": ["insight1","insight2"]
}
Return empty arrays if nothing found in a category.`;

  try {
    const { response, data } = await AIService.request({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      system: 'You are a JSON API. You must respond with only a valid JSON object. No prose, no markdown, no explanation. Only the raw JSON object.',
      messages: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: '{' }
      ]
    });

    if (!response.ok) {
      throw new Error(data.error?.message || 'HTTP ' + response.status);
    }
    let text = '{' + (data.content?.[0]?.text || '');
    text = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) throw new Error('No JSON found in response');
    text = text.slice(jsonStart, jsonEnd + 1);
    text = text.replace(/,(\s*[}\]])/g, '$1');
    let parsed;
    try { parsed = JSON.parse(text); }
    catch(e) { throw new Error('Parse failed: ' + e.message + '\n\nRaw: ' + text.slice(0, 200)); }

    resultEl.innerHTML = renderExpenseAnalysis(parsed);

  } catch(err) {
    resultEl.innerHTML = '✗ Error: ' + (err.message || 'Unknown error');
  }
}

// ── AI IGNORE LIST ────────────────────────────────────────────────────────────
export function loadAIIgnoreList() {
  const list = (window._appConfig && window._appConfig.ai_ignore) || [];
  return Array.isArray(list) ? list : [];
}
export function saveAIIgnoreList(list) {
  window._appConfig = window._appConfig || {};
  window._appConfig.ai_ignore = Array.isArray(list) ? list : [];
  if (typeof saveAppConfigToCloud === 'function') saveAppConfigToCloud({ ai_ignore: window._appConfig.ai_ignore }).catch(e => console.warn("[StayOps] silent error:", e));
}
export function addAIIgnoreItem(type, key, label, reason) {
  const list = loadAIIgnoreList();
  const id = Date.now();
  list.push({ id, type, key, label, reason: reason || '', addedDate: localDateStr() });
  saveAIIgnoreList(list);
  globalThis.showBanner('✓ Added to ignore list — won\'t flag this again', 'ok');
}
export function removeAIIgnoreItem(id) {
  saveAIIgnoreList(loadAIIgnoreList().filter(i => String(i.id) !== String(id)));
  renderAIIgnoreList();
  globalThis.showBanner('✓ Removed from ignore list', 'ok');
}
export function renderAIIgnoreList() {
  const el = document.getElementById('ai-ignore-list-display');
  if (!el) return;
  const list = loadAIIgnoreList();
  if (!list.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--muted-2)">Nothing ignored yet. Tap "Ignore" on any flagged item in the expense analysis.</div>';
    return;
  }
  const typeLabel = { duplicate:'Duplicate', anomaly:'Anomaly', missing:'Missing Receipt', uncategorised:'Uncategorised', recurring:'Recurring' };
  el.innerHTML = list.map(item => `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--hairline-2);gap:8px">
      <div style="flex:1;min-width:0">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;color:var(--muted-2);margin-bottom:2px">${escHtml(typeLabel[item.type]||item.type)}</div>
        <div style="font-size:13px;font-weight:500;color:var(--text)">${escHtml(item.label)}</div>
        ${item.reason ? `<div style="font-size:11px;color:var(--muted-2);margin-top:2px;font-style:italic">${escHtml(item.reason)}</div>` : ''}
        <div style="font-size:11px;color:var(--muted-2);margin-top:2px">Added ${escHtml(item.addedDate)}</div>
      </div>
      <button onclick="removeAIIgnoreItem('${item.id}')" style="font-size:11px;color:var(--red);background:none;border:1px solid var(--red);border-radius:20px;padding:4px 10px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;white-space:nowrap;flex-shrink:0">Remove</button>
    </div>`).join('');
}
export function promptIgnore(type, key, label) {
  globalThis.showAppModal({
    title: '🚫 Ignore This?',
    msg: `Add a reason why (optional) — this helps Claude understand your spending:`,
    confirmText: 'Ignore',
    cancelText: 'Cancel',
    hasInput: true,
    inputPlaceholder: 'e.g. Two separate orders same day',
    inputType: 'text'
  }).then(reason => {
    if (reason === false || reason === null) return;
    addAIIgnoreItem(type, key, label, typeof reason === 'string' ? reason : '');
  });
}

function renderExpenseAnalysis(data) {
  const fmt = n => '$' + Number(n).toLocaleString('en-AU', {minimumFractionDigits:2, maximumFractionDigits:2});
  let html = '<div style="font-weight:700;font-size:14px;margin-bottom:12px">🔍 Expense Analysis</div>';

  // AI-analysis fields derive from Claude output over expense/merchant text
  // (bank-CSV content) — treat as untrusted. The onclick lands in a
  // double-quoted HTML attribute the browser HTML-decodes before running as JS,
  // so escape for the JS single-quoted string first, then HTML-encode (4.7).
  const _attrJs = (s) => String(s == null ? '' : s)
    .replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const ignoreBtn = (type, key, label) =>
    `<button onclick="promptIgnore('${_attrJs(type)}','${_attrJs(key)}','${_attrJs(label)}');event.stopPropagation()"
      style="font-size:10px;color:var(--muted-2);background:var(--hairline-2);border:none;border-radius:12px;padding:3px 8px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;margin-top:6px;display:inline-block">
      🚫 Ignore this
    </button>`;

  const row = (main, sub, badge, type, key) => `
    <div style="background:white;border-radius:8px;padding:10px 12px;margin-bottom:6px;border-left:3px solid currentColor">
      <div style="font-weight:600;font-size:13px">${escHtml(main)}</div>
      <div style="font-size:12px;color:var(--muted-2);margin-top:2px">${escHtml(sub)}</div>
      ${badge ? `<div style="font-size:11px;margin-top:4px;color:var(--muted-2);font-style:italic">${escHtml(badge)}</div>` : ''}
      ${ignoreBtn(type, key, main)}
    </div>`;

  const section = (icon, title, color, items, renderFn) => {
    if (!items?.length) return '';
    let s = `<div style="margin-bottom:14px">
      <div style="font-weight:600;font-size:12px;color:${color};margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">${icon} ${title} (${items.length})</div>`;
    items.forEach(item => { s += renderFn(item); });
    s += '</div>';
    return s;
  };

  html += section('⚠️', 'Possible Duplicates', '#E65100', data.duplicates,
    d => row(`${d.merchant} — ${fmt(d.amount)}`, `${d.date1} and ${d.date2}`, d.note,
      'duplicate', `${d.merchant}-${d.amount}-${d.date1}`));

  html += section('🚨', 'Anomalies', '#C0392B', data.anomalies,
    d => row(`${d.merchant} — ${fmt(d.amount)}`, `${d.date} · ${d.category}`, d.note,
      'anomaly', `${d.merchant}-${d.amount}-${d.date}`));

  html += section('🧾', 'Missing Receipts', '#7B1FA2', data.missingReceipts,
    d => row(`${d.merchant || 'Unknown'} — ${fmt(d.amount)}`, d.date, '',
      'missing', `${d.merchant}-${d.amount}-${d.date}`));

  html += section('📂', 'Uncategorised', '#1565C0', data.uncategorised,
    d => row(`${d.merchant || 'Unknown'} — ${fmt(d.amount)}`, d.date, `Suggested: ${d.suggestedCategory}`,
      'uncategorised', `${d.merchant}-${d.amount}-${d.date}`));

  html += section('🔄', 'Recurring Charges', '#2E7D32', data.recurring,
    d => row(`${d.merchant}`, `${d.frequency} · Total: ${fmt(d.totalSpend)}`, d.note,
      'recurring', `${d.merchant}-${d.frequency}`));

  if (data.insights?.length) {
    html += `<div style="margin-bottom:8px">
      <div style="font-weight:600;font-size:12px;color:var(--primary);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">💡 Insights</div>`;
    data.insights.forEach(i => {
      html += `<div style="background:white;border-radius:8px;padding:10px 12px;margin-bottom:6px;font-size:13px">${escHtml(i)}</div>`;
    });
    html += '</div>';
  }

  const hasAnything = data.duplicates?.length || data.anomalies?.length ||
    data.missingReceipts?.length || data.uncategorised?.length || data.recurring?.length;
  if (!hasAnything) html += '<div style="color:var(--primary);font-weight:600">✓ No issues found — your expenses look clean!</div>';

  html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
    <button onclick="openSettingsCat('app');openSettingsPanel('ai-ignore');"
      style="font-size:11px;color:var(--muted-2);background:none;border:none;cursor:pointer;text-decoration:underline">View ignore list</button>
    <button onclick="document.getElementById('expense-analysis-result').style.display='none'"
      style="font-size:12px;color:var(--muted-2);background:none;border:none;cursor:pointer">✕ Close</button>
  </div>`;

  return html;
}

// ── RECEIPT PHOTO READER ──────────────────────────────────────────────────
// The Add Expense form supports up to 2 receipts. Slot 0 is the primary one
// (also used by "Read with AI"); slot 1 is the optional second receipt.
let expensePhotoBase64 = null;
let expensePhotoMediaType = 'image/jpeg';
let expensePhotoConverting = false;
let expensePhoto2Base64 = null;
let expensePhoto2MediaType = 'image/jpeg';
let expensePhoto2Converting = false;

export function isExpensePhotoConverting() {
  return expensePhotoConverting || expensePhoto2Converting;
}

export function getExpensePhotoUploadSnapshot() {
  return { base64: expensePhotoBase64, mediaType: expensePhotoMediaType || 'image/jpeg' };
}

export function getExpensePhoto2UploadSnapshot() {
  return { base64: expensePhoto2Base64, mediaType: expensePhoto2MediaType || 'image/jpeg' };
}

/** DOM element ids for each Add-form receipt slot. Slot 1 has no AI-extract status. */
const EXPENSE_PHOTO_SLOTS = {
  0: { preview: 'expense-photo-preview',   img: 'expense-photo-img',   pdf: 'expense-pdf-preview',   input: 'expense-file-input',   status: 'expense-extract-status' },
  1: { preview: 'expense-photo-preview-2', img: 'expense-photo-img-2', pdf: 'expense-pdf-preview-2', input: 'expense-file-input-2', status: null },
};

function _setExpensePhotoSlot(slot, base64, mediaType) {
  if (slot === 1) { expensePhoto2Base64 = base64; expensePhoto2MediaType = mediaType; }
  else { expensePhotoBase64 = base64; expensePhotoMediaType = mediaType; }
}
function _setExpensePhotoConverting(slot, val) {
  if (slot === 1) expensePhoto2Converting = val; else expensePhotoConverting = val;
}

/** Show the "+ Add another receipt" button only when slot 0 has a file and slot 1 is still empty. */
export function updateAddReceiptUI() {
  const addBtn = document.getElementById('expense-add-second-btn');
  if (!addBtn) return;
  const slot0Present = !!expensePhotoBase64 || expensePhotoConverting;
  const slot1Present = !!expensePhoto2Base64 || expensePhoto2Converting;
  addBtn.style.display = (slot0Present && !slot1Present) ? 'inline-block' : 'none';
}

// ── SHARE-TO-EXPENSE (native iOS) ─────────────────────────────────────────────
// When the user shares a receipt PDF/image to StayOps from the iOS share sheet,
// the app launches with a file:// URL. Read it, drop it into Add-Expense receipt
// slot 0, and run AI extraction so the form is prefilled.

/** Feed a shared receipt (base64 + media type) into the Add Expense form. */
export async function receiveSharedReceipt(base64, mediaType, filename) {
  if (!base64) return;
  try {
    if (typeof globalThis.showSection === 'function') globalThis.showSection('finance');
    if (typeof globalThis.showFinanceSub === 'function') globalThis.showFinanceSub('expenses');
    const panel = document.getElementById('expense-add-form-panel');
    if (panel && panel.style.display === 'none' && typeof globalThis.toggleExpenseAddForm === 'function') {
      globalThis.toggleExpenseAddForm();
    }
    const isPDF = mediaType === 'application/pdf';
    _setExpensePhotoSlot(0, base64, isPDF ? 'application/pdf' : (mediaType || 'image/jpeg'));
    const img = document.getElementById('expense-photo-img');
    const pdfDiv = document.getElementById('expense-pdf-preview');
    const preview = document.getElementById('expense-photo-preview');
    if (isPDF) {
      if (img) img.style.display = 'none';
      if (pdfDiv) { pdfDiv.style.display = 'block'; pdfDiv.textContent = '📄 ' + (filename || 'Shared receipt.pdf'); }
    } else {
      if (img) { img.src = 'data:' + (mediaType || 'image/jpeg') + ';base64,' + base64; img.style.display = 'block'; }
      if (pdfDiv) pdfDiv.style.display = 'none';
    }
    if (preview) preview.style.display = 'block';
    updateAddReceiptUI();
    await extractExpenseFromReceipt();
  } catch (e) {
    console.warn('[Share] receiveSharedReceipt failed:', e && e.message ? e.message : e);
  }
}
globalThis.receiveSharedReceipt = receiveSharedReceipt;

let _shareListenerInited = false;
let _lastSharedUrl = '';
/** Listen for receipts shared into the app (native iOS only). */
export function initSharedReceiptListener() {
  if (_shareListenerInited) return;
  const cap = globalThis.Capacitor;
  const isNative = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const App = isNative && cap.Plugins && cap.Plugins.App;
  if (!App) return;
  _shareListenerInited = true;
  const handle = async (data) => {
    try {
      const url = data && data.url;
      if (!url || url === _lastSharedUrl || !/^file:/i.test(url)) return;
      _lastSharedUrl = url;
      const Filesystem = cap.Plugins && cap.Plugins.Filesystem;
      if (!Filesystem) { console.warn('[Share] Filesystem plugin unavailable'); return; }
      const res = await Filesystem.readFile({ path: url });
      const base64 = res && res.data;
      if (!base64) return;
      const lower = url.split('?')[0].toLowerCase();
      const mediaType = lower.endsWith('.png') ? 'image/png'
        : (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) ? 'image/jpeg'
        : 'application/pdf';
      const filename = decodeURIComponent((url.split('/').pop() || 'receipt').split('?')[0]);
      await receiveSharedReceipt(base64, mediaType, filename);
    } catch (e) { console.warn('[Share] handler failed:', e && e.message ? e.message : e); }
  };
  App.addListener('appUrlOpen', handle);
  // Cold start: the launching file URL is available via getLaunchUrl().
  if (typeof App.getLaunchUrl === 'function') {
    App.getLaunchUrl().then(r => { if (r && r.url) handle(r); }).catch(() => {});
  }
}
globalThis.initSharedReceiptListener = initSharedReceiptListener;

export function attachExpensePhoto(input) {
  const file = input.files[0];
  if (!file) return;
  expensePhotoMediaType = 'image/jpeg';
  const reader = new FileReader();
  reader.onload = function(e) {
    const img = new Image();
    img.onload = function() {
      const MAX = 4000;
      let w = img.width, h = img.height;
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
        else { w = Math.round(w * MAX / h); h = MAX; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob(blob => {
        const fr = new FileReader();
        fr.onload = function(ev) {
          expensePhotoBase64 = ev.target.result.split(',')[1];
          document.getElementById('expense-photo-img').src = ev.target.result;
          document.getElementById('expense-photo-preview').style.display = 'block';
          const status = document.getElementById('expense-extract-status');
          status.style.display = 'none'; status.textContent = '';
        };
        fr.readAsDataURL(blob);
      }, 'image/jpeg', 0.92);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function attachExpenseFileSlot(input, slot) {
  const file = input.files[0];
  if (!file) return;
  const dom = EXPENSE_PHOTO_SLOTS[slot] || EXPENSE_PHOTO_SLOTS[0];
  const isPDF = file.type === 'application/pdf';
  const pdfDiv = document.getElementById(dom.pdf);
  const img = document.getElementById(dom.img);
  const status = dom.status ? document.getElementById(dom.status) : null;

  if (isPDF) {
    const reader = new FileReader();
    reader.onload = function(e) {
      _setExpensePhotoSlot(slot, e.target.result.split(',')[1], 'application/pdf');
      img.style.display = 'none';
      pdfDiv.style.display = 'block';
      pdfDiv.textContent = '📄 ' + file.name;
      document.getElementById(dom.preview).style.display = 'block';
      if (status) { status.style.display = 'none'; status.textContent = ''; }
      updateAddReceiptUI();
    };
    reader.readAsDataURL(file);
  } else {
    const reader = new FileReader();
    reader.onload = function(e) {
      const dataUrl = e.target.result;
      _setExpensePhotoConverting(slot, true);
      pdfDiv.style.display = 'block';
      pdfDiv.textContent = '⟳ Converting to PDF...';
      img.style.display = 'none';
      document.getElementById(dom.preview).style.display = 'block';
      if (status) { status.style.display = 'none'; status.textContent = ''; }
      updateAddReceiptUI();

      const image = new Image();
      image.onload = function() {
        const canvas = document.createElement('canvas');
        const pageW = 794, pageH = 1123;
        canvas.width = pageW; canvas.height = pageH;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, pageW, pageH);
        const maxW = pageW - 40, maxH = pageH - 40;
        let w = image.width, h = image.height;
        if (w > maxW) { h = h * maxW / w; w = maxW; }
        if (h > maxH) { w = w * maxH / h; h = maxH; }
        ctx.drawImage(image, (pageW - w) / 2, 20, w, h);
        canvas.toBlob(function(blob) {
          const fr = new FileReader();
          fr.onload = function(ev) {
            _setExpensePhotoSlot(slot, ev.target.result.split(',')[1], 'image/jpeg');
            _setExpensePhotoConverting(slot, false);
            pdfDiv.textContent = '📄 Receipt (converted to PDF)';
            updateAddReceiptUI();
          };
          fr.readAsDataURL(blob);
        }, 'image/jpeg', 0.92);
      };
      image.onerror = function() {
        _setExpensePhotoConverting(slot, false);
        pdfDiv.textContent = '⚠ Could not load image';
        updateAddReceiptUI();
      };
      image.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }
}

export function attachExpenseFile(input) { attachExpenseFileSlot(input, 0); }
export function attachExpenseFile2(input) { attachExpenseFileSlot(input, 1); }

export function clearExpensePhoto() {
  expensePhotoBase64 = null;
  expensePhotoMediaType = 'image/jpeg';
  expensePhotoConverting = false;
  document.getElementById('expense-photo-preview').style.display = 'none';
  const fileInput = document.getElementById('expense-file-input');
  if (fileInput) fileInput.value = '';
  const pdfDiv = document.getElementById('expense-pdf-preview');
  if (pdfDiv) { pdfDiv.style.display = 'none'; pdfDiv.textContent = ''; }
  const img = document.getElementById('expense-photo-img');
  if (img) img.style.display = 'block';
  document.getElementById('expense-extract-status').style.display = 'none';
  updateAddReceiptUI();
}

export function clearExpensePhoto2() {
  expensePhoto2Base64 = null;
  expensePhoto2MediaType = 'image/jpeg';
  expensePhoto2Converting = false;
  const prev = document.getElementById('expense-photo-preview-2');
  if (prev) prev.style.display = 'none';
  const fileInput = document.getElementById('expense-file-input-2');
  if (fileInput) fileInput.value = '';
  const pdfDiv = document.getElementById('expense-pdf-preview-2');
  if (pdfDiv) { pdfDiv.style.display = 'none'; pdfDiv.textContent = ''; }
  const img = document.getElementById('expense-photo-img-2');
  if (img) img.style.display = 'block';
  updateAddReceiptUI();
}

// ── RECEIPT ↔ BOOKING MATCHING ────────────────────────────────────────────
/** Recent revenue-bearing stays (checked out, last 120 days, newest first),
 *  each joined with its clean record. Mirrors renderExpenseBookingPicker's
 *  eligibility filter so every id returned here is selectable in the
 *  booking-link picker. */
function getBookingMatchCandidates() {
  const todayStr = localDateStr();
  const cutoff = localDateStr(new Date(Date.now() - 120 * 86400000));
  return (Array.isArray(bookings) ? bookings : [])
    .filter(b => b && isRevenueBearingBooking(b) && b.checkout && b.checkout <= todayStr && b.checkout >= cutoff)
    .sort((a, b) => String(b.checkout).localeCompare(String(a.checkout)))
    .slice(0, 15)
    .map(b => ({ booking: b, clean: findMatchingCleanForBooking(b) }));
}

function formatBookingCandidatesCtx(cands) {
  if (!cands.length) return '';
  const address = String(getActivePropertyConfig()?.address || '').trim();
  const header = `Recent completed stays at this property ("${getCurrentPropertyName()}"${address ? ', ' + address : ''}) — bookingId | guest | checkin → checkout | host payout | mgmt fee | clean:`;
  const rows = cands.map(({ booking: b, clean: c }) => {
    const id = String(b._cloudId || b.id);
    const cleanInfo = c && c.date
      ? `cleaned ${String(c.date).slice(0, 10)}${c.cleaner ? ' by ' + c.cleaner : ''}`
      : 'no clean recorded';
    return `${id} | ${b.name || 'Guest'} | ${b.checkin} → ${b.checkout} | $${b.hostPayout || 0} | ${b.mgmtFeeRaw || 0}% | ${cleanInfo}`;
  });
  return header + '\n' + rows.join('\n');
}

function _normLoose(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function _dayDiff(a, b) {
  const ta = Date.parse(String(a).slice(0, 10));
  const tb = Date.parse(String(b).slice(0, 10));
  return Number.isFinite(ta) && Number.isFinite(tb) ? Math.abs(ta - tb) / 86400000 : Infinity;
}

/** Deterministic receipt→booking match: the receipt's merchant is the cleaner
 *  who has a clean within 2 days of the receipt date. Returns the booking, or
 *  null when there is no single unambiguous hit. */
function findCleanerReceiptBooking(merchant, dateStr, cands) {
  const m = _normLoose(merchant);
  if (m.length < 3 || !dateStr) return null;
  const hits = cands
    .filter(({ clean: c }) => {
      if (!c || !c.date) return false;
      const cl = _normLoose(c.cleaner);
      if (cl.length < 3) return false;
      if (!m.includes(cl) && !cl.includes(m)) return false;
      return _dayDiff(c.date, dateStr) <= 2;
    })
    .sort((a, b) => _dayDiff(a.clean.date, dateStr) - _dayDiff(b.clean.date, dateStr));
  if (!hits.length) return null;
  // Two cleans by this cleaner equally close to the receipt date → ambiguous.
  if (hits.length > 1 && _dayDiff(hits[0].clean.date, dateStr) === _dayDiff(hits[1].clean.date, dateStr)) return null;
  return hits[0].booking;
}

export async function extractExpenseFromReceipt() {
  const status = document.getElementById('expense-extract-status');
  status.style.display = 'block';
  if (!expensePhotoBase64) {
    status.style.background = '#FFF8E1'; status.style.color = '#E65100';
    status.textContent = '⚠ Please attach a receipt image or PDF first';
    return;
  }
  status.style.background = '#FFF8E1'; status.style.color = '#E65100';
  status.textContent = '⟳ Reading receipt...';
  try {
    const getCats = globalThis.getExpenseCats;
    const cats = typeof getCats === 'function' ? getCats() : [];
    const candidates = getBookingMatchCandidates();
    const bookingCtx = candidates.length
      ? `\n\n${formatBookingCandidatesCtx(candidates)}\n\nbookingId rules: set bookingId ONLY when this receipt is a cleaning or post-stay service charge that clearly belongs to ONE stay above — the merchant is that stay's cleaner and the receipt date is on/near the clean date, or within 5 days after that stay's checkout. If the receipt shows a service address it must match this property — a different address, or no single clear match, means bookingId must be null.`
      : '';
    const { response, data } = await AIService.request({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          expensePhotoMediaType === 'application/pdf'
            ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: expensePhotoBase64 } }
            : { type: 'image', source: { type: 'base64', media_type: expensePhotoMediaType, data: expensePhotoBase64 } },
          { type: 'text', text: `This is a receipt or invoice. Return ONLY a JSON object with no markdown. Fields: merchant (store name), description (brief), amount (number, no $ sign, negative if refund), date (YYYY-MM-DD), receiptNum (or null), category (best match from: ${cats.join(', ')})${candidates.length ? ', bookingId (see rules below, or null)' : ''}. Null for missing.${bookingCtx}` }
        ]
      }]
    });
    if (!response.ok) throw new Error(data.error?.message || 'API error');
    const rawText = data.content?.[0]?.text || '{}';
    // Strip markdown fences: ```json ... ``` or ``` ... ```
    const cleaned = rawText.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned || '{}');
    if (parsed.merchant) document.getElementById('exp-merchant').value = parsed.merchant;
    if (parsed.description) document.getElementById('exp-description').value = parsed.description;
    if (parsed.amount != null) {
      const n = Number(parsed.amount);
      document.getElementById('exp-amount').value = Number.isFinite(n) ? Math.abs(n) : parsed.amount;
      const refundEl = document.getElementById('exp-is-refund');
      if (refundEl) refundEl.checked = Number.isFinite(n) && n < 0;
    }
    if (parsed.date) document.getElementById('exp-date').value = parsed.date;
    if (parsed.receiptNum) document.getElementById('exp-receipt-num').value = parsed.receiptNum;
    if (parsed.category) {
      const sel = document.getElementById('exp-category');
      for (let opt of sel.options) { if (opt.value === parsed.category) { sel.value = parsed.category; break; } }
      if (typeof globalThis.renderExpenseBookingPicker === 'function') globalThis.renderExpenseBookingPicker('exp', document.getElementById('exp-booking-link')?.value || '');
    }
    // Auto-link the receipt to its stay: deterministic cleaner-name +
    // clean-date match first, then the model's pick (validated against the
    // candidate list). Refunds never auto-link — saving a linked expense
    // overwrites the clean's actual cost with the expense amount.
    let linkedBooking = null;
    const amt = Number(parsed.amount);
    if (candidates.length && !(Number.isFinite(amt) && amt < 0)) {
      const matchDate = parsed.date || document.getElementById('exp-date').value || '';
      linkedBooking = findCleanerReceiptBooking(parsed.merchant, matchDate, candidates);
      if (!linkedBooking && parsed.bookingId != null) {
        const hit = candidates.find(({ booking: b }) => String(b._cloudId || b.id) === String(parsed.bookingId));
        if (hit) linkedBooking = hit.booking;
      }
    }
    if (linkedBooking) {
      const linkedId = String(linkedBooking._cloudId || linkedBooking.id);
      if (typeof globalThis.renderExpenseBookingPicker === 'function') globalThis.renderExpenseBookingPicker('exp', linkedId);
      const sel = document.getElementById('exp-booking-link');
      if (sel && sel.value === linkedId) {
        const wrap = document.getElementById('exp-booking-link-wrap');
        if (wrap) wrap.style.display = 'block';
      } else {
        linkedBooking = null; // not selectable in the picker — don't claim a link
      }
    }
    status.style.background = '#E8F5E9'; status.style.color = '#2E7D32';
    status.textContent = linkedBooking
      ? `✓ Receipt read — linked to ${linkedBooking.name || 'Guest'}'s stay (${linkedBooking.checkin} → ${linkedBooking.checkout}). Review, then tap Save Expense`
      : '✓ Receipt read — review details, then tap Save Expense';
    const panel = document.getElementById('expense-add-form-panel');
    const chevron = document.getElementById('expense-add-chevron');
    if (panel) panel.style.display = 'block';
    if (chevron) chevron.textContent = '⌄';
    setTimeout(() => triggerExpenseSuggestion('exp'), 300);
  } catch(err) {
    status.style.background = '#FDECEA'; status.style.color = '#C0392B';
    status.textContent = '✗ Error: ' + (err.message || 'Could not read receipt');
  }
}

// ── INLINE AI SUGGESTIONS ────────────────────────────────────────────────
let _suggestTimer = null;
let _suggestInflight = false;
let _lastSuggestKey = '';

export function triggerExpenseSuggestion(prefix) {
  const merchant = (document.getElementById(prefix + '-merchant')?.value || '').trim();
  const amount = parseFloat(document.getElementById(prefix + '-amount')?.value) || 0;
  if (!merchant || !amount) return;

  const date = document.getElementById(prefix + '-date')?.value || '';
  const key = `${merchant}|${amount}|${date}`;
  if (key === _lastSuggestKey) return;
  if (_suggestInflight) return;

  clearTimeout(_suggestTimer);
  _suggestTimer = setTimeout(() => fetchExpenseSuggestion(prefix, { merchant, amount, date }), 800);
}

async function fetchExpenseSuggestion(prefix, { merchant, amount, date }) {
  const cardEl = document.getElementById(prefix + '-ai-suggest-card');
  if (!cardEl) return;

  _suggestInflight = true;
  cardEl.style.display = 'block';
  cardEl.innerHTML = '<div style="padding:10px 12px;background:linear-gradient(135deg,#f0f7f4 0%,#e8f5e9 100%);border:1px solid var(--primary);border-radius:12px;margin-bottom:10px"><div style="font-size:11px;color:var(--primary)">✨ Getting suggestions...</div></div>';

  try {
    const getCats = globalThis.getExpenseCats;
    const cats = typeof getCats === 'function' ? getCats() : [];
    const currentCat = document.getElementById(prefix + '-category')?.value || '';
    const description = document.getElementById(prefix + '-description')?.value || '';

    const candidates = getBookingMatchCandidates();
    const recentBookings = candidates.map(c => c.booking);
    const bookingsCtx = candidates.length ? '\n\n' + formatBookingCandidatesCtx(candidates) : '';

    const { response, data } = await AIService.request({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `You categorize short-term rental property expenses. Return ONLY valid JSON, no markdown, no commentary.

EXPENSE TO CATEGORIZE
- Merchant: "${merchant}"
- Description: "${description}"
- Amount: $${amount}
- Date: ${date || 'unknown'}
- Currently selected category: "${currentCat || '(none)'}"

AVAILABLE CATEGORIES (you MUST return exactly one of these strings, character-for-character — case, punctuation, spacing all matter):
${cats.map(c => '- ' + c).join('\n')}

MERCHANT → MEANING GUIDE — pick the AVAILABLE CATEGORY whose NAME OR MEANING best matches the merchant's domain. The category names below are SEMANTIC HINTS, not literal targets — the user may have customized their list (e.g. "Utilities & Rates" instead of "Utilities", "Furnishings & Equipment" instead of "Furnishings & Linen", "Repairs" instead of "Maintenance & Repairs"). Map semantically:

- Hardware / repairs / tradie merchants (Bunnings, Mitre 10, hardware stores, plumbers, electricians, handymen, locksmiths, pest control, appliance repair, painters, builders, tile/timber/paint suppliers) → maintenance / repairs / renovation category
- Cleaner names / lawn & garden contractors / pool service / window cleaners / cleaning-product purchases for cleaners → cleaning / garden / cleaner-payment category
- Grocery / general retail / consumables (Woolworths, Coles, Aldi, IGA, Costco, Kmart, Big W, Target, Officeworks, Daiso) → supplies / consumables / guest-supplies category
- Utility & telco providers (AGL, Origin, EnergyAustralia, Red Energy, Sydney Water, Yarra Valley Water, Optus, Telstra, Vodafone, internet/phone/electricity/gas/water bills) → utilities / bills category
- Council / strata / body-corporate / land-tax statements → council / strata / rates category
- Insurance providers (Terri Scheer, NRMA, AAMI, Allianz, QBE, Suncorp landlord insurance) → insurance category
- Bank mortgage statements (ANZ, Commonwealth, NAB, Westpac, ING, Macquarie home-loan repayments) → mortgage category — if subcategories exist for interest/principal/fees, pick the most appropriate one
- Furniture / decor / linen / homeware retailers (IKEA, Temple & Webster, Pillow Talk, Bed Bath N Table, Adairs, Spotlight, Harvey Norman, Harris Scarfe, Beacon Lighting, Fantastic Furniture) → furnishings / furniture / equipment / linen category
- Accountants / lawyers / photographers / property managers / conveyancers / tax agents / bookkeepers → professional services category
- Platform fees & marketing (Airbnb service fees, Booking.com commission, Google/Meta ads, SEO, listing fees) → advertising / marketing / platform-fees category
- Anything you cannot confidently map → the most generic catch-all in the list (usually "Other")${bookingsCtx}

RULES
1. Return ONLY a category that appears verbatim in the AVAILABLE CATEGORIES list above. NEVER invent or paraphrase a category name. If the closest semantic match has different spelling (e.g. you think "Utilities" but the list has "Utilities & Rates"), return the list's spelling.
2. If the currently selected category already matches the merchant correctly, return it as bestCategory (the UI will not show a suggestion).
3. Only suggest a different category when you are confident the current one is wrong based on the merchant name. Do NOT default to a Cleaning-style category — most expenses are NOT cleaning.
4. Set bestBookingId only when this is plausibly a cleaning OR maintenance cost for ONE specific past stay. Strongest signal: the merchant is that stay's cleaner and the expense date is on/near the clean date shown for the stay. Otherwise use checkout-date proximity (max 5 days after checkout). No single clear match → null.

Return EXACTLY this JSON shape:
{"bestCategory":"<exact label from the list above>","bestBookingId":"<id from the bookings list or null>","mgmtNote":"<if bestBookingId set AND its mgmtFee% > 0: 'Linking to [guest] ([X]% fee) will add $${amount} to clean cost', else null>","confidence":"high or low"}`
      }]
    });

    if (!response.ok) throw new Error('API error');
    const rawText = data.content?.[0]?.text || '{}';
    const cleaned = rawText.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '').trim();
    const result = JSON.parse(cleaned);

    _lastSuggestKey = `${merchant}|${amount}|${date}`;
    const currentBookingSel = document.getElementById(prefix + '-booking-link')?.value || '';
    renderSuggestionCard(prefix, result, cats, recentBookings, currentCat, currentBookingSel);
  } catch (_err) {
    cardEl.style.display = 'none';
  } finally {
    _suggestInflight = false;
  }
}

function renderSuggestionCard(prefix, result, cats, recentBookings, currentCat, currentBookingSel) {
  const cardEl = document.getElementById(prefix + '-ai-suggest-card');
  if (!cardEl) return;

  const validCat = result.bestCategory && cats.includes(result.bestCategory);
  const catDiffers = validCat && result.bestCategory !== currentCat;
  const matchedBooking = result.bestBookingId
    ? recentBookings.find(b => String(b._cloudId || b.id) === String(result.bestBookingId))
    : null;
  // Don't re-suggest a booking that's already selected (e.g. auto-linked by the receipt reader).
  const bookingDiffers = !!matchedBooking
    && String(matchedBooking._cloudId || matchedBooking.id) !== String(currentBookingSel || '');

  if (!catDiffers && !bookingDiffers) {
    cardEl.style.display = 'none';
    return;
  }

  let html = `<div style="background:linear-gradient(135deg,#f0f7f4 0%,#e8f5e9 100%);border:1px solid var(--primary);border-radius:12px;padding:12px 14px;margin-bottom:10px;position:relative">
    <button onclick="dismissAISuggest('${prefix}')" style="position:absolute;top:6px;right:8px;background:none;border:none;font-size:14px;cursor:pointer;color:var(--muted-2)">✕</button>
    <div style="font-size:11px;font-weight:600;color:var(--primary);text-transform:uppercase;letter-spacing:0.4px;margin-bottom:8px">✨ AI Suggestion</div>`;

  if (catDiffers) {
    html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px">
      <span style="font-size:12px;color:var(--ink-2)">Category: <strong>${result.bestCategory}</strong></span>
      <button onclick="acceptAISuggestCategory('${prefix}','${result.bestCategory.replace(/'/g, "\\'")}')" style="background:var(--primary);color:white;border:none;border-radius:6px;padding:4px 10px;font-size:11px;font-weight:600;cursor:pointer">Apply</button>
    </div>`;
  }

  if (bookingDiffers) {
    const label = `${matchedBooking.name || 'Guest'} (${matchedBooking.checkin} → ${matchedBooking.checkout})`;
    html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px">
      <span style="font-size:12px;color:var(--ink-2)">Link to: <strong>${label}</strong></span>
      <button onclick="acceptAISuggestBooking('${prefix}','${String(matchedBooking._cloudId || matchedBooking.id).replace(/'/g, "\\'")}')" style="background:var(--primary);color:white;border:none;border-radius:6px;padding:4px 10px;font-size:11px;font-weight:600;cursor:pointer">Apply</button>
    </div>`;
  }

  if (result.mgmtNote && bookingDiffers) {
    html += `<div style="font-size:11px;color:var(--muted-2);margin-top:4px;font-style:italic">ℹ️ ${result.mgmtNote}</div>`;
  }

  html += '</div>';
  cardEl.innerHTML = html;
  cardEl.style.display = 'block';
}

export function acceptAISuggestCategory(prefix, category) {
  const sel = document.getElementById(prefix + '-category');
  if (sel) {
    sel.value = category;
    if (typeof globalThis.renderExpenseBookingPicker === 'function') globalThis.renderExpenseBookingPicker(prefix, document.getElementById(prefix + '-booking-link')?.value || '');
  }
  const cardEl = document.getElementById(prefix + '-ai-suggest-card');
  if (cardEl) {
    const btn = cardEl.querySelector('[onclick*="acceptAISuggestCategory"]');
    if (btn) { btn.textContent = '✓'; btn.disabled = true; btn.style.background = 'var(--moss)'; }
  }
}

export function acceptAISuggestBooking(prefix, bookingId) {
  if (typeof globalThis.renderExpenseBookingPicker === 'function') {
    globalThis.renderExpenseBookingPicker(prefix, bookingId);
  }
  const wrap = document.getElementById(prefix + '-booking-link-wrap');
  if (wrap) wrap.style.display = 'block';
  const sel = document.getElementById(prefix + '-booking-link');
  if (sel) sel.value = bookingId;
  const cardEl = document.getElementById(prefix + '-ai-suggest-card');
  if (cardEl) {
    const btn = cardEl.querySelector('[onclick*="acceptAISuggestBooking"]');
    if (btn) { btn.textContent = '✓'; btn.disabled = true; btn.style.background = 'var(--moss)'; }
  }
}

export function dismissAISuggest(prefix) {
  const cardEl = document.getElementById(prefix + '-ai-suggest-card');
  if (cardEl) cardEl.style.display = 'none';
}

// ── SCREENSHOT TO BOOKING ─────────────────────────────────────────────────
let screenshotBase64 = null;
let screenshotMediaType = 'image/jpeg';

export function readBookingScreenshot(input) {
  const file = input.files[0];
  if (!file) return;
  screenshotMediaType = 'image/jpeg';
  const reader = new FileReader();
  reader.onload = function(e) {
    const img = new Image();
    img.onload = function() {
      const MAX = 4000;
      let w = img.width, h = img.height;
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
        else { w = Math.round(w * MAX / h); h = MAX; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
      screenshotBase64 = dataUrl.split(',')[1];
      const prev = document.getElementById('screenshot-img');
      prev.src = dataUrl;
      document.getElementById('screenshot-preview').style.display = 'block';
      document.getElementById('screenshot-extract-btn').style.display = 'block';
      const status = document.getElementById('screenshot-status');
      status.style.display = 'block';
      status.style.background = '#E8F5E9';
      status.style.color = '#2E7D32';
      status.textContent = '✓ Screenshot loaded — tap Extract to read booking details';
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

export async function extractBookingFromScreenshot() {
  if (!screenshotBase64) { globalThis.showBanner('⚠ Please select a screenshot first', 'warn'); return; }
  const btn = document.getElementById('screenshot-extract-btn');
  const status = document.getElementById('screenshot-status');
  btn.disabled = true;
  btn.textContent = '⟳ Reading screenshot...';
  status.style.display = 'block';
  status.style.background = '#FFF8E1';
  status.style.color = '#E65100';
  status.textContent = '⟳ Analysing booking screenshot...';

  try {
    const { response, data } = await AIService.request({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: screenshotMediaType, data: screenshotBase64 }
          },
          {
            type: 'text',
            text: `This is a booking confirmation screenshot. Return ONLY a valid JSON object with no markdown, no backtick fences, no explanation. Fields: guestName (string), checkin (YYYY-MM-DD), checkout (YYYY-MM-DD), nights (number), guests (number), hostPayout (number no $ sign), cleaningFee (number no $ sign). Use null if not visible. Today's date is ${localDateStr()}. If a date has no year, use the current year — but if that date has already passed, use next year instead.`,
          }
        ]
      }]
    });
    if (!response.ok) {
      throw new Error('API error ' + response.status + ': ' + (data.error?.message || JSON.stringify(data)));
    }
    const text = data.content?.[0]?.text || '';
    const clean = text.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(clean);

    globalThis.switchModalTab('manual', document.querySelectorAll('#modal .tab')[0]);

    if (parsed.guestName) document.getElementById('b-name').value = parsed.guestName;
    if (parsed.guests) document.getElementById('b-guests').value = parsed.guests;
    if (parsed.checkin) document.getElementById('b-checkin').value = parsed.checkin;
    if (parsed.checkout) document.getElementById('b-checkout').value = parsed.checkout;
    if (parsed.hostPayout) document.getElementById('b-hostpayout').value = parsed.hostPayout;
    if (parsed.cleaningFee) document.getElementById('b-cleaningfee').value = parsed.cleaningFee;
    calcNights();

    globalThis.showBanner('✓ Booking details extracted — please review and confirm', 'ok');

  } catch(e) {
    status.style.background = '#FDECEA';
    status.style.color = '#C0392B';
    status.textContent = '✗ Error: ' + (e.message || JSON.stringify(e));
    btn.disabled = false;
    btn.textContent = '✨ Try Again';
  }
}
