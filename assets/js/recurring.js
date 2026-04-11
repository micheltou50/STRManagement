/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Recurring Expense Templates
   ═══════════════════════════════════════════════════════════════════════════ */

import { getActivePropertyConfig, getActivePropertyId } from './config.js';
import { expenses } from './state.js';

// ── HELPERS ──────────────────────────────────────────────────────────────────

function todayLocal() {
  return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local tz
}

function advanceDate(dateStr, frequency) {
  const d = new Date(dateStr + 'T00:00:00');
  switch (frequency) {
    case 'weekly':    d.setDate(d.getDate() + 7); break;
    case 'fortnightly': d.setDate(d.getDate() + 14); break;
    case 'monthly':   d.setMonth(d.getMonth() + 1); break;
    case 'quarterly': d.setMonth(d.getMonth() + 3); break;
    case 'annual':    d.setFullYear(d.getFullYear() + 1); break;
    default:          d.setMonth(d.getMonth() + 1); break;
  }
  return d.toLocaleDateString('en-CA');
}

// ── TEMPLATE CRUD ────────────────────────────────────────────────────────────

export function getRecurringTemplates() {
  return (window._appConfig && window._appConfig.recurring_templates) || [];
}

function saveRecurringTemplates(templates) {
  window._appConfig = window._appConfig || {};
  window._appConfig.recurring_templates = templates;
  if (typeof globalThis.saveAppConfigToCloud === 'function') {
    globalThis.saveAppConfigToCloud({ recurring_templates: templates }).catch(e => console.warn("[StayOps] silent error:", e));
  }
}

export function addRecurringTemplate(template) {
  const templates = getRecurringTemplates().slice();
  template.id = 'rec-' + Date.now();
  template.enabled = true;
  template.lastGenerated = null;
  template.propertyId = template.propertyId || getActivePropertyId();
  templates.push(template);
  saveRecurringTemplates(templates);
  return template;
}

export function updateRecurringTemplate(id, updates) {
  const templates = getRecurringTemplates().slice();
  const idx = templates.findIndex(t => t.id === id);
  if (idx === -1) return null;
  templates[idx] = { ...templates[idx], ...updates };
  saveRecurringTemplates(templates);
  return templates[idx];
}

export function deleteRecurringTemplate(id) {
  const templates = getRecurringTemplates().filter(t => t.id !== id);
  saveRecurringTemplates(templates);
}

// ── AUTO-GENERATION ──────────────────────────────────────────────────────────

export async function processRecurringTemplates() {
  const templates = getRecurringTemplates().slice();
  if (!templates.length) return { generated: 0 };

  const today = todayLocal();
  let generated = 0;
  let changed = false;

  for (let i = 0; i < templates.length; i++) {
    const t = templates[i];
    if (!t.enabled || !t.nextDue) continue;

    // Generate all overdue occurrences (handles multiple missed periods)
    let safety = 0;
    while (t.nextDue <= today && safety < 12) {
      safety++;
      // Create expense in the shared expenses array and persist to cloud
      const newExp = {
        id: Date.now() + Math.random().toString(36).slice(2, 6),
        merchant: t.merchant,
        description: t.description || '',
        amount: t.amount,
        date: t.nextDue,
        category: t.category || 'Other',
        receiptType: '',
        receiptNum: '',
        _fromRecurring: t.id,
      };
      expenses.push(newExp);
      if (typeof globalThis.saveExpenseToCloud === 'function') {
        globalThis.saveExpenseToCloud(newExp).catch(e => console.warn("[StayOps] silent error:", e));
      }
      generated++;

      t.lastGenerated = t.nextDue;
      t.nextDue = advanceDate(t.nextDue, t.frequency);
      changed = true;
    }
  }

  if (changed) {
    saveRecurringTemplates(templates);
  }

  if (generated > 0) {
    console.log('[StayOps] Auto-generated', generated, 'recurring expense(s)');
    if (typeof globalThis.showBanner === 'function') {
      globalThis.showBanner('\u{1F504} ' + generated + ' recurring expense' + (generated > 1 ? 's' : '') + ' auto-added', 'ok');
    }
  }

  return { generated };
}

// ── FREQUENCY LABELS ─────────────────────────────────────────────────────────

const FREQUENCY_OPTIONS = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'fortnightly', label: 'Fortnightly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'annual', label: 'Annual' },
];

export function getFrequencyLabel(freq) {
  const f = FREQUENCY_OPTIONS.find(o => o.value === freq);
  return f ? f.label : freq;
}

export function getFrequencyOptions() {
  return FREQUENCY_OPTIONS;
}

// ── UI RENDERING ─────────────────────────────────────────────────────────────

export function renderRecurringPanel() {
  const container = document.getElementById('recurring-list');
  if (!container) return;

  const templates = getRecurringTemplates();
  const activePid = getActivePropertyId();
  // Show templates for active property only
  const filtered = templates.filter(t => !t.propertyId || t.propertyId === activePid);

  if (!filtered.length) {
    container.innerHTML = '<div style="text-align:center;padding:32px 16px;color:var(--text-soft);font-family:\'DM Sans\',sans-serif;font-size:14px">' +
      '<div style="font-size:28px;margin-bottom:8px">\u{1F504}</div>' +
      'No recurring expenses yet.<br>Add one below for things like insurance, rates, or subscriptions.' +
      '</div>';
    return;
  }

  let html = '';
  for (const t of filtered) {
    const freqLabel = getFrequencyLabel(t.frequency);
    const nextDue = t.nextDue || '\u2014';
    const enabledClass = t.enabled ? '' : 'opacity:0.5;';

    html += '<div style="padding:14px 16px;border-bottom:1px solid #F0ECE6;display:flex;align-items:center;justify-content:space-between;' + enabledClass + '" data-rec-id="' + t.id + '">' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-weight:500;font-size:14px;color:#1a1a1a;font-family:\'DM Sans\',sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + _escHtml(t.merchant) + '</div>' +
        '<div style="font-size:12px;color:var(--text-soft);font-family:\'DM Sans\',sans-serif;margin-top:2px">' +
          '$' + Number(t.amount).toFixed(2) + ' \u00B7 ' + freqLabel + ' \u00B7 Next: ' + nextDue +
        '</div>' +
        '<div style="font-size:11px;color:var(--text-soft);font-family:\'DM Sans\',sans-serif;margin-top:1px">' + _escHtml(t.category || '') + '</div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0">' +
        '<button onclick="toggleRecurringEnabled(\'' + t.id + '\')" style="background:none;border:none;font-size:18px;cursor:pointer;padding:4px" title="' + (t.enabled ? 'Pause' : 'Resume') + '">' + (t.enabled ? '\u23F8' : '\u25B6\uFE0F') + '</button>' +
        '<button onclick="deleteRecurringTemplate(\'' + t.id + '\')" style="background:none;border:none;font-size:16px;cursor:pointer;padding:4px;color:#D44" title="Delete">\u2715</button>' +
      '</div>' +
    '</div>';
  }

  container.innerHTML = '<div class="card" style="padding:0;overflow:hidden">' + html + '</div>';
}

export function toggleRecurringEnabled(id) {
  const templates = getRecurringTemplates();
  const t = templates.find(t => String(t.id) === String(id));
  if (!t) return;
  updateRecurringTemplate(id, { enabled: !t.enabled });
  renderRecurringPanel();
}

export function saveRecurringFromForm() {
  const merchant = (document.getElementById('rec-merchant') || {}).value?.trim();
  const amount = parseFloat((document.getElementById('rec-amount') || {}).value);
  const category = (document.getElementById('rec-category') || {}).value;
  const frequency = (document.getElementById('rec-frequency') || {}).value;
  const startDate = (document.getElementById('rec-start-date') || {}).value;
  const description = (document.getElementById('rec-description') || {}).value?.trim() || '';

  if (!merchant) { globalThis.showBanner('\u26A0 Merchant is required', 'warn'); return; }
  if (!amount || isNaN(amount)) { globalThis.showBanner('\u26A0 Valid amount is required', 'warn'); return; }
  if (!frequency) { globalThis.showBanner('\u26A0 Select a frequency', 'warn'); return; }
  if (!startDate) { globalThis.showBanner('\u26A0 Start date is required', 'warn'); return; }

  addRecurringTemplate({
    merchant,
    amount,
    category: category || 'Other',
    frequency,
    nextDue: startDate,
    description,
  });

  // Clear form
  ['rec-merchant', 'rec-amount', 'rec-description', 'rec-start-date'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  globalThis.showBanner('\u2713 Recurring expense added', 'ok');
  renderRecurringPanel();
}

function _escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
