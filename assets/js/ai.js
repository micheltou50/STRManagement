/**
 * AI features: smart pricing, expense analysis, ignore list, receipt OCR, booking screenshot import.
 */
import { AIService } from './ai-logic.js';
import { bookings, expenses } from './state.js';
import { calcNights } from './utils.js';
import {
  lsKey,
  getPricingConfig,
  getPropertyStats,
  getCurrentPropertyName,
} from './config.js';
import { saveAppConfigToCloud } from './supabase.js';

// ── SMART PRICING ─────────────────────────────────────────────────────────
export async function getSmartPricing() {
  const status = document.getElementById('pricing-status');
  const result = document.getElementById('pricing-result');
  status.style.display = 'block';
  result.innerHTML = '';

  const period = document.getElementById('pricing-period').value;
  const baseRate = document.getElementById('pricing-base-rate').value;
  if (baseRate) localStorage.setItem(lsKey('base-rate'), baseRate);

  status.style.background = '#FFF8E1'; status.style.color = '#E65100';
  status.textContent = '⟳ Analysing your bookings and seasonal data...';

  const now = new Date();
  const history = bookings.filter(b => b.status !== 'cancelled').map(b => ({
    checkin: b.checkin, checkout: b.checkout, nights: b.nights,
    guests: b.guests, payout: b.hostPayout, platform: b.platform
  }));
  const totalRevenue = bookings.filter(b => b.status !== 'cancelled').reduce((s,b) => s + (b.hostPayout||0), 0);
  const avgPayout = history.length ? Math.round(totalRevenue / history.length) : 0;

  let startDate, endDate;
  if (period.startsWith('month-')) {
    const monthIdx = parseInt(period.split('-')[1]);
    const year = monthIdx < now.getMonth() ? now.getFullYear() + 1 : now.getFullYear();
    startDate = new Date(year, monthIdx, 1);
    endDate = new Date(year, monthIdx + 1, 0);
  } else {
    startDate = new Date(now);
    endDate = new Date(now);
    endDate.setDate(endDate.getDate() + Number(period));
  }

  const periodLabel = period.startsWith('month-')
    ? startDate.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })
    : `next ${period} days`;

  const bookedDates = {};
  bookings.forEach(b => {
    if (!b.checkin || !b.checkout) return;
    const s = new Date(b.checkin), e = new Date(b.checkout);
    for (let d = new Date(s); d < e; d.setDate(d.getDate()+1)) {
      bookedDates[d.toISOString().split('T')[0]] = b.name;
    }
  });

  const pCfg   = getPricingConfig();
  const pStats = getPropertyStats();
  const prompt = `You are a short-term rental pricing expert for ${pCfg.locationContext}. Property: ${getCurrentPropertyName()} — ${pStats.bedrooms}-bedroom, ${pStats.maxGuests}-guest property.

Booking history (${history.length} bookings, avg host payout A$${avgPayout}):
${JSON.stringify(history.slice(-10))}

Base rate: A$${baseRate || pCfg.baseRate || '350'}/night. Today: ${now.toISOString().split('T')[0]}. Forecast: ${periodLabel}.

LOCATION-SPECIFIC DEMAND FACTORS:
${pCfg.locationFactors || '- No specific demand factors configured. Use general STR pricing principles for the location.'}

Return ONLY valid JSON, no markdown:
{
  "summary": "2 sentences on pricing opportunity for the forecast period",
  "tips": ["tip1","tip2","tip3"],
  "periods": [
    { "label": "Period name", "tier": "peak|high|standard|low", "rate": 480, "rule": "weekend|weekday", "months": [6,7,8] }
  ]
}

rule: "weekend" (Fri/Sat/Sun nights) | "weekday" (Mon-Thu) — omit rule if using specific dates
months: array of month numbers, optional — omit for year-round
dates: array of specific YYYY-MM-DD for exact holidays/events, optional
List 8-12 periods. Higher rates on Fri/Sat than Sun. Peak Jan 1, Easter, June festival weeks, school holidays, long weekends.`;

  try {
    const { response, data } = await AIService.request({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    });

    if (!response.ok) {
      const msg = data.error?.message || ('HTTP ' + response.status);
      throw new Error(msg);
    }
    let text = data.content?.[0]?.text || '';
    text = text.replace(/```json/gi,'').replace(/```/g,'').trim();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch(parseErr) {
      status.style.background = '#FDECEA'; status.style.color = '#C0392B';
      status.textContent = '✗ Could not read response. Raw reply: ' + text.substring(0, 200);
      return;
    }

    status.style.background = '#E8F5E9'; status.style.color = '#2E7D32';
    status.textContent = '✓ Recommendations ready';

    const rates = {};
    const tierRank = { peak: 4, high: 3, standard: 2, low: 1 };
    const cur = new Date(startDate);
    while (cur <= endDate) {
      const dateStr = cur.toISOString().split('T')[0];
      const dow = cur.getDay();
      const month = cur.getMonth() + 1;
      const isWeekend = dow === 0 || dow === 5 || dow === 6;
      let best = null;
      for (const p of (parsed.periods || [])) {
        const monthMatch = !p.months || p.months.includes(month);
        const ruleMatch = !p.rule || (p.rule === 'weekend' && isWeekend) || (p.rule === 'weekday' && !isWeekend);
        const dateMatch = !p.dates || p.dates.includes(dateStr);
        if (monthMatch && ruleMatch && dateMatch) {
          if (!best || (tierRank[p.tier]||0) > (tierRank[best.tier]||0)) best = p;
        }
      }
      rates[dateStr] = best
        ? { rate: best.rate, label: best.label, tier: best.tier }
        : { rate: Number(baseRate||350), label: 'Standard', tier: 'standard' };
      cur.setDate(cur.getDate() + 1);
    }

    result.innerHTML = renderPricingCalendar({ ...parsed, rates }, bookedDates, startDate, endDate);

  } catch(err) {
    status.style.background = '#FDECEA'; status.style.color = '#C0392B';
    const msg = err.message || 'Unknown error';
    if (msg.includes('quota') || msg.includes('429') || msg.includes('overloaded')) {
      status.textContent = '✗ API busy — wait a moment and try again';
    } else if (msg.includes('invalid') || msg.includes('401')) {
      status.textContent = '✗ API key invalid — check Settings → AI Tools';
    } else {
      status.innerHTML = '✗ Error: <small style="word-break:break-all">' + msg + '</small>';
    }
  }
}

function renderPricingCalendar(data, bookedDates, startDate, endDate) {
  const tierColors = {
    peak:     { bg:'#FF5A5F', text:'#fff', border:'#e04040' },
    high:     { bg:'#FF9800', text:'#fff', border:'#e08000' },
    standard: { bg:'#E8F5E9', text:'#2E7D32', border:'#c8e6c9' },
    low:      { bg:'#F5F5F5', text:'#757575', border:'#e0e0e0' }
  };
  const tierLabels = { peak:'🔴 Peak', high:'🟠 High', standard:'🟢 Standard', low:'⚪ Low' };

  const months = {};
  const d = new Date(startDate);
  while (d <= endDate) {
    const key = d.toISOString().split('T')[0].substring(0,7);
    if (!months[key]) months[key] = [];
    months[key].push(d.toISOString().split('T')[0]);
    d.setDate(d.getDate()+1);
  }

  let html = '';

  if (data.summary) {
    html += `<div class="card" style="font-size:13px;line-height:1.6;margin-bottom:8px">
      <div style="font-weight:700;font-size:14px;margin-bottom:6px">📊 Pricing Outlook</div>
      ${data.summary}
      <div style="margin-top:8px;padding:8px;background:var(--warm);border-radius:6px;font-size:11px;color:var(--text-soft)">
        💡 <strong>Guest price</strong> = what guests pay per night · <strong>Your payout</strong> = after ~3% Airbnb fee. Cleaning fee is additional.
      </div>
    </div>`;
  }

  html += `<div class="card" style="margin-bottom:8px;padding:10px 14px">
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      ${Object.entries(tierLabels).map(([t,l]) => `
        <div style="display:flex;align-items:center;gap:5px">
          <div style="width:14px;height:14px;border-radius:3px;background:${tierColors[t].bg};border:1px solid ${tierColors[t].border}"></div>
          <span style="font-size:11px;color:var(--text-soft)">${l}</span>
        </div>`).join('')}
      <div style="display:flex;align-items:center;gap:5px">
        <div style="width:14px;height:14px;border-radius:3px;background:#3D67FF"></div>
        <span style="font-size:11px;color:var(--text-soft)">📅 Booked</span>
      </div>
    </div>
  </div>`;

  Object.entries(months).forEach(([monthKey, dates]) => {
    const [year, month] = monthKey.split('-').map(Number);
    const monthName = new Date(year, month-1, 1).toLocaleDateString('en-AU', {month:'long', year:'numeric'});
    const firstDay = new Date(year, month-1, 1).getDay();

    html += `<div class="card" style="margin-bottom:8px;padding:12px">
      <div style="font-weight:700;font-size:14px;margin-bottom:10px">${monthName}</div>
      <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px;margin-bottom:4px">
        ${['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => `<div style="text-align:center;font-size:10px;font-weight:600;color:var(--text-soft);padding:2px">${d}</div>`).join('')}
      </div>
      <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px">`;

    for (let i = 0; i < firstDay; i++) {
      html += `<div></div>`;
    }

    const daysInMonth = new Date(year, month, 0).getDate();
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      const isPast = new Date(dateStr) < new Date(new Date().toISOString().split('T')[0]);
      const isBooked = bookedDates[dateStr];
      const rateData = data.rates?.[dateStr];
      const tier = rateData?.tier || 'standard';
      const rate = rateData?.rate;
      const label = rateData?.label || '';
      const payout = rate ? Math.round(rate * 0.97) : null;

      let bg, textColor, border;
      if (isBooked) { bg='#3D67FF'; textColor='#fff'; border='#2d57ef'; }
      else if (isPast) { bg='#f9f9f9'; textColor='#ccc'; border='#eee'; }
      else { bg=tierColors[tier]?.bg||'#E8F5E9'; textColor=tierColors[tier]?.text||'#333'; border=tierColors[tier]?.border||'#ccc'; }

      const tooltip = isBooked
        ? `Booked: ${bookedDates[dateStr]}`
        : (rate ? `${label}\nGuest pays: $${rate}\nYour payout: ~$${payout}` : label);

      html += `<div title="${tooltip}" style="border-radius:6px;background:${bg};border:1px solid ${border};padding:3px 2px;text-align:center;cursor:default;min-height:52px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px">
        <div style="font-size:11px;font-weight:600;color:${textColor}">${day}</div>
        ${!isPast && !isBooked && rate ? `
          <div style="font-size:9px;color:${textColor};font-weight:700;line-height:1.1">$${rate}</div>
          <div style="font-size:8px;color:${textColor};opacity:0.8;line-height:1.1">~$${payout}</div>
        ` : ''}
        ${isBooked ? `<div style="font-size:8px;color:${textColor};margin-top:1px">✓ Booked</div>` : ''}
      </div>`;
    }

    html += `</div>
    <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:10px;color:var(--text-soft);padding-top:6px;border-top:1px solid var(--warm)">
      <span>Top = guest price</span><span>Bottom = ~your payout (after 3% fee)</span>
    </div>
    </div>`;
  });

  if (data.tips?.length) {
    html += `<div class="card" style="font-size:13px;line-height:1.6">
      <div style="font-weight:700;font-size:14px;margin-bottom:8px">💡 Tips</div>
      ${data.tips.map(t => `<div style="display:flex;gap:8px;margin-bottom:6px"><span style="color:var(--moss);flex-shrink:0">→</span><span>${t}</span></div>`).join('')}
    </div>`;
  }

  return html;
}

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
    hasReceipt: !!(e.receiptUrl || e.driveLink || e.receiptData)
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
  return JSON.parse(localStorage.getItem(lsKey('ai-ignore')) || '[]');
}
export function saveAIIgnoreList(list) {
  localStorage.setItem(lsKey('ai-ignore'), JSON.stringify(list));
  if (typeof saveAppConfigToCloud === 'function') saveAppConfigToCloud({ ai_ignore: list }).catch(() => {});
}
export function addAIIgnoreItem(type, key, label, reason) {
  const list = loadAIIgnoreList();
  const id = Date.now();
  list.push({ id, type, key, label, reason: reason || '', addedDate: new Date().toISOString().split('T')[0] });
  saveAIIgnoreList(list);
  globalThis.showBanner('✓ Added to ignore list — won\'t flag this again', 'ok');
}
export function removeAIIgnoreItem(id) {
  saveAIIgnoreList(loadAIIgnoreList().filter(i => i.id !== id));
  renderAIIgnoreList();
  globalThis.showBanner('✓ Removed from ignore list', 'ok');
}
export function renderAIIgnoreList() {
  const el = document.getElementById('ai-ignore-list-display');
  if (!el) return;
  const list = loadAIIgnoreList();
  if (!list.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--text-soft)">Nothing ignored yet. Tap "Ignore" on any flagged item in the expense analysis.</div>';
    return;
  }
  const typeLabel = { duplicate:'Duplicate', anomaly:'Anomaly', missing:'Missing Receipt', uncategorised:'Uncategorised', recurring:'Recurring' };
  el.innerHTML = list.map(item => `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--warm);gap:8px">
      <div style="flex:1;min-width:0">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-soft);margin-bottom:2px">${typeLabel[item.type]||item.type}</div>
        <div style="font-size:13px;font-weight:500;color:var(--text)">${item.label}</div>
        ${item.reason ? `<div style="font-size:11px;color:var(--text-soft);margin-top:2px;font-style:italic">${item.reason}</div>` : ''}
        <div style="font-size:11px;color:var(--text-soft);margin-top:2px">Added ${item.addedDate}</div>
      </div>
      <button onclick="removeAIIgnoreItem(${item.id})" style="font-size:11px;color:var(--red);background:none;border:1px solid var(--red);border-radius:20px;padding:4px 10px;cursor:pointer;font-family:'DM Sans',sans-serif;white-space:nowrap;flex-shrink:0">Remove</button>
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
      style="font-size:10px;color:var(--text-soft);background:var(--warm);border:none;border-radius:12px;padding:3px 8px;cursor:pointer;font-family:'DM Sans',sans-serif;margin-top:6px;display:inline-block">
      🚫 Ignore this
    </button>`;

  const row = (main, sub, badge, type, key) => `
    <div style="background:white;border-radius:8px;padding:10px 12px;margin-bottom:6px;border-left:3px solid currentColor">
      <div style="font-weight:600;font-size:13px">${main}</div>
      <div style="font-size:12px;color:var(--text-soft);margin-top:2px">${sub}</div>
      ${badge ? `<div style="font-size:11px;margin-top:4px;color:var(--text-soft);font-style:italic">${badge}</div>` : ''}
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
      <div style="font-weight:600;font-size:12px;color:var(--forest);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">💡 Insights</div>`;
    data.insights.forEach(i => {
      html += `<div style="background:white;border-radius:8px;padding:10px 12px;margin-bottom:6px;font-size:13px">${i}</div>`;
    });
    html += '</div>';
  }

  const hasAnything = data.duplicates?.length || data.anomalies?.length ||
    data.missingReceipts?.length || data.uncategorised?.length || data.recurring?.length;
  if (!hasAnything) html += '<div style="color:var(--forest);font-weight:600">✓ No issues found — your expenses look clean!</div>';

  html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
    <button onclick="openSettingsCat('advanced');openSettingsPanel('ai-ignore');"
      style="font-size:11px;color:var(--text-soft);background:none;border:none;cursor:pointer;text-decoration:underline">View ignore list</button>
    <button onclick="document.getElementById('expense-analysis-result').style.display='none'"
      style="font-size:12px;color:var(--text-soft);background:none;border:none;cursor:pointer">✕ Close</button>
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
    const parsed = JSON.parse(data.content?.[0]?.text?.replace(/`/g,'').trim() || '{}');
    if (parsed.merchant) document.getElementById('exp-merchant').value = parsed.merchant;
    if (parsed.description) document.getElementById('exp-description').value = parsed.description;
    if (parsed.amount) document.getElementById('exp-amount').value = parsed.amount;
    if (parsed.date) document.getElementById('exp-date').value = parsed.date;
    if (parsed.receiptNum) document.getElementById('exp-receipt-num').value = parsed.receiptNum;
    if (parsed.category) {
      const sel = document.getElementById('exp-category');
      for (let opt of sel.options) { if (opt.value === parsed.category) { sel.value = parsed.category; break; } }
    }
    status.style.background = '#E8F5E9'; status.style.color = '#2E7D32';
    status.textContent = '✓ Receipt read — saving expense...';
    const merchant = (document.getElementById('exp-merchant') && document.getElementById('exp-merchant').value || '').trim();
    const amount = parseFloat(document.getElementById('exp-amount').value);
    if (merchant && amount && Number.isFinite(amount) && typeof globalThis.addExpense === 'function') {
      globalThis.addExpense({ silent: true });
      globalThis.showBanner('Expense added from receipt: $' + amount, 'ok');
      if (typeof globalThis.renderExpenses === 'function') globalThis.renderExpenses();
      ['exp-merchant', 'exp-description', 'exp-amount', 'exp-receipt-num'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      const expDate = document.getElementById('exp-date');
      if (expDate) expDate.value = new Date().toISOString().split('T')[0];
      const catSel = document.getElementById('exp-category');
      if (catSel) catSel.selectedIndex = 0;
      const typeSel = document.getElementById('exp-receipt-type');
      if (typeSel) typeSel.selectedIndex = 0;
      clearExpensePhoto();
      const panel = document.getElementById('expense-add-form-panel');
      const chevron = document.getElementById('expense-add-chevron');
      if (panel) panel.style.display = 'none';
      if (chevron) chevron.textContent = '›';
      const receiptsCard = document.querySelector('#finance-expenses-view .card:last-of-type');
      if (receiptsCard) receiptsCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      status.textContent = '✓ Receipt read — please review and adjust if needed';
    }
  } catch(err) {
    status.style.background = '#FDECEA'; status.style.color = '#C0392B';
    status.textContent = '✗ Error: ' + (err.message || 'Could not read receipt');
  }
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
    const clean = text.replace(/```json|```/g, '').trim();
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
