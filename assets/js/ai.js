/**
 * AI features: smart pricing, expense analysis, ignore list, receipt OCR, booking screenshot import.
 */
import { AIService } from './ai-logic.js';
import { expenses } from './state.js';
import { calcNights } from './utils.js';
import { getCurrentPropertyName } from './config.js';
import { saveAppConfigToCloud } from './supabase.js';

export { renderSmartPricingPanel, getSmartPricing } from './smart-pricing.js';

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
  list.push({ id, type, key, label, reason: reason || '', addedDate: new Date().toISOString().split('T')[0] });
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
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;color:var(--muted-2);margin-bottom:2px">${typeLabel[item.type]||item.type}</div>
        <div style="font-size:13px;font-weight:500;color:var(--text)">${item.label}</div>
        ${item.reason ? `<div style="font-size:11px;color:var(--muted-2);margin-top:2px;font-style:italic">${item.reason}</div>` : ''}
        <div style="font-size:11px;color:var(--muted-2);margin-top:2px">Added ${item.addedDate}</div>
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

  const ignoreBtn = (type, key, label) =>
    `<button onclick="promptIgnore('${type}','${key.replace(/'/g,"\\'")}','${label.replace(/'/g,"\\'")}');event.stopPropagation()"
      style="font-size:10px;color:var(--muted-2);background:var(--hairline-2);border:none;border-radius:12px;padding:3px 8px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;margin-top:6px;display:inline-block">
      🚫 Ignore this
    </button>`;

  const row = (main, sub, badge, type, key) => `
    <div style="background:white;border-radius:8px;padding:10px 12px;margin-bottom:6px;border-left:3px solid currentColor">
      <div style="font-weight:600;font-size:13px">${main}</div>
      <div style="font-size:12px;color:var(--muted-2);margin-top:2px">${sub}</div>
      ${badge ? `<div style="font-size:11px;margin-top:4px;color:var(--muted-2);font-style:italic">${badge}</div>` : ''}
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
      html += `<div style="background:white;border-radius:8px;padding:10px 12px;margin-bottom:6px;font-size:13px">${i}</div>`;
    });
    html += '</div>';
  }

  const hasAnything = data.duplicates?.length || data.anomalies?.length ||
    data.missingReceipts?.length || data.uncategorised?.length || data.recurring?.length;
  if (!hasAnything) html += '<div style="color:var(--primary);font-weight:600">✓ No issues found — your expenses look clean!</div>';

  html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
    <button onclick="openSettingsCat('advanced');openSettingsPanel('ai-ignore');"
      style="font-size:11px;color:var(--muted-2);background:none;border:none;cursor:pointer;text-decoration:underline">View ignore list</button>
    <button onclick="document.getElementById('expense-analysis-result').style.display='none'"
      style="font-size:12px;color:var(--muted-2);background:none;border:none;cursor:pointer">✕ Close</button>
  </div>`;

  return html;
}

// ── RECEIPT PHOTO READER ──────────────────────────────────────────────────
let expensePhotoBase64 = null;
let expensePhotoMediaType = 'image/jpeg';
let expensePhotoConverting = false;

export function isExpensePhotoConverting() {
  return expensePhotoConverting;
}

export function getExpensePhotoUploadSnapshot() {
  return { base64: expensePhotoBase64, mediaType: expensePhotoMediaType || 'image/jpeg' };
}

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

export function attachExpenseFile(input) {
  const file = input.files[0];
  if (!file) return;
  const isPDF = file.type === 'application/pdf';
  const pdfDiv = document.getElementById('expense-pdf-preview');
  const img = document.getElementById('expense-photo-img');
  const status = document.getElementById('expense-extract-status');

  if (isPDF) {
    const reader = new FileReader();
    reader.onload = function(e) {
      expensePhotoBase64 = e.target.result.split(',')[1];
      expensePhotoMediaType = 'application/pdf';
      img.style.display = 'none';
      pdfDiv.style.display = 'block';
      pdfDiv.textContent = '📄 ' + file.name;
      document.getElementById('expense-photo-preview').style.display = 'block';
      status.style.display = 'none'; status.textContent = '';
    };
    reader.readAsDataURL(file);
  } else {
    const reader = new FileReader();
    reader.onload = function(e) {
      const dataUrl = e.target.result;
      expensePhotoConverting = true;
      pdfDiv.style.display = 'block';
      pdfDiv.textContent = '⟳ Converting to PDF...';
      img.style.display = 'none';
      document.getElementById('expense-photo-preview').style.display = 'block';
      status.style.display = 'none'; status.textContent = '';

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
            expensePhotoBase64 = ev.target.result.split(',')[1];
            expensePhotoMediaType = 'image/jpeg';
            expensePhotoConverting = false;
            pdfDiv.textContent = '📄 Receipt (converted to PDF)';
          };
          fr.readAsDataURL(blob);
        }, 'image/jpeg', 0.92);
      };
      image.onerror = function() {
        expensePhotoConverting = false;
        pdfDiv.textContent = '⚠ Could not load image';
      };
      image.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }
}

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
    const { response, data } = await AIService.request({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          expensePhotoMediaType === 'application/pdf'
            ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: expensePhotoBase64 } }
            : { type: 'image', source: { type: 'base64', media_type: expensePhotoMediaType, data: expensePhotoBase64 } },
          { type: 'text', text: `This is a receipt or invoice. Return ONLY a JSON object with no markdown. Fields: merchant (store name), description (brief), amount (number, no $ sign, negative if refund), date (YYYY-MM-DD), receiptNum (or null), category (best match from: ${cats.join(', ')}). Null for missing.` }
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
      if (typeof globalThis.renderExpenseBookingPicker === 'function') globalThis.renderExpenseBookingPicker('exp', '');
    }
    status.style.background = '#E8F5E9'; status.style.color = '#2E7D32';
    status.textContent = '✓ Receipt read — review details, then tap Save Expense';
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

    const allBookings = Array.isArray(window.bookings) ? window.bookings : [];
    const todayStr = new Date().toISOString().split('T')[0];
    const cutoff = new Date(Date.now() - 120 * 86400000).toISOString().split('T')[0];
    const recentBookings = allBookings
      .filter(b => b && b.status !== 'cancelled' && b.checkout && b.checkout <= todayStr && b.checkout >= cutoff)
      .sort((a, b) => String(b.checkout).localeCompare(String(a.checkout)))
      .slice(0, 15);

    const bookingsCtx = recentBookings.length
      ? '\n\nRecent bookings (id|guest|checkin|checkout|hostPayout|mgmtFee%):\n' +
        recentBookings.map(b => `${b._cloudId || b.id}|${b.name || 'Guest'}|${b.checkin}|${b.checkout}|${b.hostPayout || 0}|${b.mgmtFeeRaw || 0}%`).join('\n')
      : '';

    const { response, data } = await AIService.request({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `You are a JSON API for a short-term rental property expense tracker. Return ONLY valid JSON, no markdown.

Expense: merchant="${merchant}", description="${description}", amount=$${amount}, date=${date || 'unknown'}.
Current category: "${currentCat}"
Available categories: ${cats.join(', ')}${bookingsCtx}

Suggest the best match. Return JSON:
{"bestCategory":"<from the available list>","bestBookingId":"<booking id if this is likely a cleaning or maintenance expense near a checkout, else null>","mgmtNote":"<if bestBookingId has mgmtFee% > 0, write: Linking to [guest] ([X]% fee) will add $${amount} to clean cost. Else null>","confidence":"high or low"}`
      }]
    });

    if (!response.ok) throw new Error('API error');
    const rawText = data.content?.[0]?.text || '{}';
    const cleaned = rawText.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '').trim();
    const result = JSON.parse(cleaned);

    _lastSuggestKey = `${merchant}|${amount}|${date}`;
    renderSuggestionCard(prefix, result, cats, recentBookings, currentCat);
  } catch (_err) {
    cardEl.style.display = 'none';
  } finally {
    _suggestInflight = false;
  }
}

function renderSuggestionCard(prefix, result, cats, recentBookings, currentCat) {
  const cardEl = document.getElementById(prefix + '-ai-suggest-card');
  if (!cardEl) return;

  const validCat = result.bestCategory && cats.includes(result.bestCategory);
  const catDiffers = validCat && result.bestCategory !== currentCat;
  const matchedBooking = result.bestBookingId
    ? recentBookings.find(b => String(b._cloudId || b.id) === String(result.bestBookingId))
    : null;

  if (!catDiffers && !matchedBooking) {
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

  if (matchedBooking) {
    const label = `${matchedBooking.name || 'Guest'} (${matchedBooking.checkin} → ${matchedBooking.checkout})`;
    html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px">
      <span style="font-size:12px;color:var(--ink-2)">Link to: <strong>${label}</strong></span>
      <button onclick="acceptAISuggestBooking('${prefix}','${String(matchedBooking._cloudId || matchedBooking.id).replace(/'/g, "\\'")}')" style="background:var(--primary);color:white;border:none;border-radius:6px;padding:4px 10px;font-size:11px;font-weight:600;cursor:pointer">Apply</button>
    </div>`;
  }

  if (result.mgmtNote && matchedBooking) {
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
    if (typeof globalThis.renderExpenseBookingPicker === 'function') globalThis.renderExpenseBookingPicker(prefix, '');
  }
  const cardEl = document.getElementById(prefix + '-ai-suggest-card');
  if (cardEl) {
    const btn = cardEl.querySelector('[onclick*="acceptAISuggestCategory"]');
    if (btn) { btn.textContent = '✓'; btn.disabled = true; btn.style.background = 'var(--moss)'; }
  }
}

export function acceptAISuggestBooking(prefix, bookingId) {
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
      model: 'claude-sonnet-4-20250514',
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
            text: `This is a booking confirmation screenshot. Return ONLY a valid JSON object with no markdown, no backtick fences, no explanation. Fields: guestName (string), checkin (YYYY-MM-DD), checkout (YYYY-MM-DD), nights (number), guests (number), hostPayout (number no $ sign), cleaningFee (number no $ sign). Use null if not visible. Today's date is ${new Date().toISOString().slice(0,10)}. If a date has no year, use the current year — but if that date has already passed, use next year instead.`,
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
