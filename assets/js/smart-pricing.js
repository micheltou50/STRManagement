/**
 * StayOps — Smart Pricing: rules editor + AI calendar (Finance hub).
 * v2 — suggestions are generated and persisted server-side; client reads
 * the latest run from Supabase.
 */
import {
  getActivePropertyConfig,
  getActivePropertyId,
  getPricingConfig,
} from './config.js';
import { isPortfolioMode } from './property.js';
import {
  getCurrentSupabaseUser,
  fetchPricingRulesForProperty,
  ensureDefaultPricingRules,
  updatePricingRule,
  insertPricingRules,
  deletePricingRuleRow,
  fetchLatestPricingRun,
  fetchPricingSuggestionsForRun,
  requestPricingGeneration,
} from './supabase.js';
import { escHtml } from './utils.js';

const SP_ROOT_ID = 'smart-pricing-root';
const FORECAST_DAYS = 60;

const CONDITION_OPTIONS = [
  { value: 'stay_length', label: 'Stay length is at least...', fieldLabel: 'Nights (min)' },
  { value: 'lead_time', label: 'Booked at least X days ahead', fieldLabel: 'Days ahead' },
  { value: 'last_minute', label: 'Vacant within X days', fieldLabel: 'Days' },
  { value: 'gap', label: 'Gap between bookings is...', fieldLabel: 'Max gap nights' },
  { value: 'day_of_week', label: 'Specific days of week', fieldLabel: 'Days mask (1–127)' },
  { value: 'date_range', label: 'Date range / season', fieldLabel: 'Extra in meta' },
];

function getActivePropertyUuid() {
  const cfg = getActivePropertyConfig();
  const cloudIds = window._cloudPropertyIds || {};
  return String(cloudIds[getActivePropertyId()] || cfg.supabaseId || '');
}

function ruleByType(rules, type) {
  return rules.find((r) => r.rule_type === type);
}

function discountRules(rules) {
  return rules.filter((r) => r.rule_type === 'discount');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function daysMapFromSuggestions(suggestions) {
  const byDate = Object.create(null);
  for (const s of suggestions || []) {
    if (!s || !s.date) continue;
    byDate[s.date] = {
      date: s.date,
      suggestedRate: Number(s.suggested_rate) || 0,
      rateType: s.rate_type || 'base',
      reason: s.reason || '',
    };
  }
  return byDate;
}

/** @type {{ rules: any[], daysMap: Record<string, any>, insight: string, forecastStart: string, forecastEnd: string, calMonth: Date } | null} */
let _spState = null;
let _spNewDiscountOpen = false;
let _spLongPressTimer = null;

function cardShell(title, inner) {
  return `<div style="background:white;border-radius:12px;padding:16px;margin-bottom:14px;border:0.5px solid rgba(0,0,0,0.1)">
    <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-soft);margin-bottom:12px">${escHtml(title)}</div>
    ${inner}
  </div>`;
}

function iconBadge(innerHtml, bg, color = '#1a1a1a') {
  return `<div style="width:32px;height:32px;border-radius:8px;background:${bg};color:${color};display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0">${innerHtml}</div>`;
}

function clockSvg() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;
}

function discountRowHtml(r) {
  const isDef = r.is_default;
  let badge;
  if (r.condition_type === 'stay_length' && Number(r.condition_value) >= 28) {
    badge = iconBadge('28+', '#E8F5E9', '#1D9E75');
  } else if (r.condition_type === 'stay_length' && Number(r.condition_value) >= 7) {
    badge = iconBadge('7+', '#E8F5E9', '#1D9E75');
  } else if (r.condition_type === 'last_minute') {
    badge = iconBadge(clockSvg(), '#FEF2F2', '#E24B4A');
  } else {
    badge = iconBadge('%', '#E3F2FD', '#185FA5');
  }
  const sub = subtitleForDiscount(r);
  const del = !isDef
    ? `<span class="sp-discount-del" data-id="${r.id}" style="font-size:11px;color:#A32D2D;margin-left:8px">Remove</span>`
    : '';
  return `<div class="sp-discount-row" data-id="${r.id}" data-swipe="1" style="display:flex;align-items:center;gap:12px;padding:12px 0;border-top:0.5px solid rgba(0,0,0,0.1);touch-action:pan-y">
    ${badge}
    <div style="flex:1;min-width:0">
      <div style="font-size:14px;font-weight:500;color:#1a1a1a">${escHtml(r.name || 'Discount')}</div>
      <div style="font-size:11px;color:var(--text-soft);margin-top:2px">${escHtml(sub)}</div>
    </div>
    <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
      <span style="font-size:16px;font-weight:600;color:#1D9E75">${Number(r.value)}%</span>
      <span style="color:#C7C7CC;font-size:18px">›</span>
      ${del}
    </div>
  </div>`;
}

function subtitleForDiscount(r) {
  if (r.condition_type === 'stay_length') return `${Number(r.condition_value)}+ nights stay`;
  if (r.condition_type === 'last_minute')
    return `Vacant within ${Number(r.condition_value)} days`;
  if (r.condition_type === 'lead_time')
    return `Booked ${Number(r.condition_value)}+ days ahead`;
  if (r.condition_type === 'gap') return `Gap ≤ ${Number(r.condition_value)} nights`;
  if (r.condition_type === 'day_of_week') return 'Specific days of week';
  if (r.condition_type === 'date_range') return 'Season / date range';
  return r.condition_type || 'Custom rule';
}

function newDiscountPanelHtml() {
  const opts = CONDITION_OPTIONS.map(
    (o) => `<option value="${escHtml(o.value)}">${escHtml(o.label)}</option>`
  ).join('');
  const display = _spNewDiscountOpen ? 'block' : 'none';
  return `<div id="sp-new-discount-wrap" style="display:${display};margin-top:12px;padding:14px;background:var(--warm);border-radius:12px;border:0.5px solid rgba(0,0,0,0.08)">
    <div style="font-size:13px;font-weight:600;margin-bottom:10px;color:#1a1a1a">New discount</div>
    <label style="font-size:11px;color:var(--text-soft)">Name</label>
    <input id="sp-nd-name" type="text" placeholder="e.g. Returning guest" style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:0.5px solid rgba(0,0,0,0.15);margin-bottom:10px;font-size:14px">
    <label style="font-size:11px;color:var(--text-soft)">Condition</label>
    <select id="sp-nd-cond" style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:0.5px solid rgba(0,0,0,0.15);margin-bottom:10px;font-size:14px">${opts}</select>
    <div style="display:flex;gap:10px;margin-bottom:12px">
      <div style="flex:1">
        <label style="font-size:11px;color:var(--text-soft)">Discount %</label>
        <input id="sp-nd-pct" type="number" min="0" max="100" step="0.5" value="10" style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:0.5px solid rgba(0,0,0,0.15);font-size:14px">
      </div>
      <div style="flex:1">
        <label id="sp-nd-days-lbl" style="font-size:11px;color:var(--text-soft)">Days / nights</label>
        <input id="sp-nd-days" type="number" min="1" value="7" style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:0.5px solid rgba(0,0,0,0.15);font-size:14px">
      </div>
    </div>
    <div style="display:flex;gap:10px">
      <button type="button" id="sp-nd-cancel" class="btn-secondary" style="flex:1">Cancel</button>
      <button type="button" id="sp-nd-save" style="flex:1;background:#1E3A2F;color:#fff;border:none;border-radius:10px;padding:12px;font-size:14px;font-weight:600">Save discount</button>
    </div>
  </div>`;
}

function part2Html() {
  if (!_spState || !_spState.daysMap) return '';
  const cal = _spState.calMonth || new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const y = cal.getFullYear();
  const m = cal.getMonth();
  const title = cal.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
  const firstDow = new Date(y, m, 1).getDay();
  const lead = (firstDow + 6) % 7;
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const hdr = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
    .map((h) => `<div style="text-align:center;font-size:10px;font-weight:600;color:var(--text-soft);padding:4px">${h}</div>`)
    .join('');
  let cells = '';
  for (let i = 0; i < lead; i++) cells += '<div></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${y}-${pad2(m + 1)}-${pad2(d)}`;
    const dayData = _spState.daysMap[ds];
    const numStyle = 'font-size:11px;color:var(--text-soft)';
    let sub;
    let cellBg = 'transparent';
    let cellBorder = '0.5px solid rgba(0,0,0,0.06)';
    let _subColor = '#1a1a1a';
    if (dayData) {
      const rt = dayData.rateType || 'base';
      if (rt === 'booked') {
        cellBg = '#E8F5E9';
        sub = '<span style="font-size:10px;font-weight:600;color:#1D9E75">Booked</span>';
      } else if (rt === 'weekend') {
        sub = `<span style="font-size:10px;font-weight:600;color:#185FA5">$${Number(dayData.suggestedRate)}</span>`;
      } else if (rt === 'peak') {
        cellBorder = '1px solid #D4A017';
        sub = `<span style="font-size:10px;font-weight:600;color:#D4A017">$${Number(dayData.suggestedRate)}</span>`;
      } else if (rt === 'discounted') {
        sub = `<span style="font-size:10px;font-weight:600;color:#E24B4A">$${Number(dayData.suggestedRate)}</span>`;
      } else {
        sub = `<span style="font-size:10px;font-weight:600;color:#1a1a1a">$${Number(dayData.suggestedRate)}</span>`;
      }
    } else {
      sub = `<span style="font-size:10px;color:#ccc">—</span>`;
    }
    cells += `<div style="min-height:52px;padding:4px 2px;text-align:center;border-radius:8px;background:${cellBg};border:${cellBorder}">
      <div style="${numStyle}">${d}</div>
      ${sub}
    </div>`;
  }
  const legend = [
    ['#E8F5E9', 'Booked'],
    ['transparent', 'Base (dark $)'],
    ['#185FA5', 'Weekend ($)'],
    ['#D4A017', 'Peak / holiday'],
    ['#E24B4A', 'Discounted'],
  ]
    .map(
      ([col, lab]) =>
        `<span style="display:inline-flex;align-items:center;gap:4px;margin:4px 8px 4px 0;font-size:10px;color:var(--text-soft)"><span style="width:10px;height:10px;border-radius:2px;background:${col === 'transparent' ? '#fff' : col};border:0.5px solid rgba(0,0,0,0.15)"></span>${lab}</span>`
    )
    .join('');

  return `<div id="sp-part2" style="margin-top:8px">
    ${cardShell(
      'Pricing calendar',
      `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <button type="button" id="sp-cal-prev" style="background:var(--warm);border:none;border-radius:8px;width:32px;height:32px;cursor:pointer">‹</button>
        <span style="font-size:14px;font-weight:600">${escHtml(title)}</span>
        <button type="button" id="sp-cal-next" style="background:var(--warm);border:none;border-radius:8px;width:32px;height:32px;cursor:pointer">›</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-bottom:6px">${hdr}</div>
      <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-bottom:12px">${cells}</div>
      <div style="display:flex;flex-wrap:wrap;border-top:0.5px solid rgba(0,0,0,0.08);padding-top:10px">${legend}</div>`
    )}
    ${cardShell(
      'AI insight',
      `<div style="display:flex;align-items:flex-start;gap:10px">
        <div style="width:36px;height:36px;border-radius:10px;background:#E8F5E9;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:#1D9E75;font-size:18px">★</div>
        <div style="font-size:13px;line-height:1.55;color:#1a1a1a">${escHtml(_spState.insight || '—')}</div>
      </div>`
    )}
    <button type="button" id="sp-regenerate" style="width:100%;background:#1E3A2F;color:#fff;border:none;border-radius:12px;padding:14px;font-size:14px;font-weight:600;margin-bottom:20px">Regenerate pricing suggestions</button>
  </div>`;
}

function defaultForecastRange() {
  const today = new Date();
  const end = new Date(today);
  end.setDate(end.getDate() + (FORECAST_DAYS - 1));
  const fmt = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return { start: fmt(today), end: fmt(end) };
}

function currentForecastRange() {
  // Prefer the user's picked dates; else the most recently loaded run; else defaults.
  if (_spState?.pickedStart && _spState?.pickedEnd) {
    return { start: _spState.pickedStart, end: _spState.pickedEnd };
  }
  if (_spState?.forecastStart && _spState?.forecastEnd) {
    return { start: _spState.forecastStart, end: _spState.forecastEnd };
  }
  return defaultForecastRange();
}

function dateRangeCardHtml() {
  const { start, end } = currentForecastRange();
  return cardShell(
    'Forecast window',
    `<div style="display:flex;gap:10px;align-items:flex-end">
      <div style="flex:1">
        <label style="font-size:11px;color:var(--text-soft);display:block;margin-bottom:4px">From</label>
        <input id="sp-from" type="date" value="${escHtml(start)}" style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:0.5px solid rgba(0,0,0,0.15);font-size:14px">
      </div>
      <div style="flex:1">
        <label style="font-size:11px;color:var(--text-soft);display:block;margin-bottom:4px">To</label>
        <input id="sp-to" type="date" value="${escHtml(end)}" style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:0.5px solid rgba(0,0,0,0.15);font-size:14px">
      </div>
    </div>
    <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
      <button type="button" class="sp-preset" data-days="30" style="background:var(--warm);border:none;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer">30d</button>
      <button type="button" class="sp-preset" data-days="60" style="background:var(--warm);border:none;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer">60d</button>
      <button type="button" class="sp-preset" data-days="90" style="background:var(--warm);border:none;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer">90d</button>
      <button type="button" class="sp-preset" data-days="180" style="background:var(--warm);border:none;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer">6mo</button>
      <button type="button" class="sp-preset" data-days="365" style="background:var(--warm);border:none;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer">1yr</button>
    </div>
    <div style="font-size:11px;color:var(--text-soft);margin-top:8px">Max 365 days. Longer ranges take longer to generate and cost more tokens.</div>`
  );
}

function renderFullUI(root) {
  const rules = _spState?.rules || [];
  const bn = ruleByType(rules, 'base_nightly');
  const bw = ruleByType(rules, 'base_weekend');
  const mn = ruleByType(rules, 'min_nights');
  const baseCard =
    cardShell(
      'Base rates',
      `<div>
        <div class="sp-row-edit" data-edit="base_nightly" style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-top:none;cursor:pointer">
          <span style="font-size:13px;color:var(--text-soft)">Sun – Thu base price</span>
          <div style="display:flex;align-items:center;gap:8px"><span id="sp-val-base_nightly" style="font-size:16px;font-weight:500">$${bn ? Math.round(Number(bn.value)) : '—'}</span><span style="color:#C7C7CC">›</span></div>
        </div>
        <div class="sp-row-edit" data-edit="base_weekend" style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-top:0.5px solid rgba(0,0,0,0.1);cursor:pointer">
          <span style="font-size:13px;color:var(--text-soft)">Fri – Sat price</span>
          <div style="display:flex;align-items:center;gap:8px"><span id="sp-val-base_weekend" style="font-size:16px;font-weight:500">$${bw ? Math.round(Number(bw.value)) : '—'}</span><span style="color:#C7C7CC">›</span></div>
        </div>
        <div class="sp-row-edit" data-edit="min_nights" style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-top:0.5px solid rgba(0,0,0,0.1);cursor:pointer">
          <span style="font-size:13px;color:var(--text-soft)">Per booking</span>
          <div style="display:flex;align-items:center;gap:8px"><span id="sp-val-min_nights" style="font-size:16px;font-weight:500">${mn ? Math.round(Number(mn.value)) : '—'} nights</span><span style="color:#C7C7CC">›</span></div>
        </div>
      </div>`
    ) +
    cardShell(
      'Discounts',
      `<div>${discountRules(rules).map(discountRowHtml).join('')}</div>
      <div style="text-align:center;margin-top:8px">
        <button type="button" id="sp-add-discount" style="background:none;border:none;display:inline-flex;align-items:center;gap:8px;color:#185FA5;font-size:14px;font-weight:600;cursor:pointer;padding:10px">
          <span style="width:28px;height:28px;border-radius:50%;border:1.5px solid #185FA5;display:flex;align-items:center;justify-content:center;font-size:18px;line-height:1">+</span>
          Add discount
        </button>
      </div>
      ${newDiscountPanelHtml()}`
    ) +
    dateRangeCardHtml() +
    `<button type="button" id="sp-generate" style="width:100%;background:#1E3A2F;color:#fff;border:none;border-radius:12px;padding:14px;font-size:14px;font-weight:600;margin-bottom:8px">Generate pricing calendar</button>
    <div id="sp-gen-spinner" style="display:none;text-align:center;font-size:13px;color:var(--text-soft);margin-bottom:8px">Generating… <span class="sp-spin">⟳</span></div>`;

  const part2 = _spState && _spState.daysMap && Object.keys(_spState.daysMap).length ? part2Html() : '';
  root.innerHTML = baseCard + part2;
  bindRows(root);
}

function bindRows(root) {
  const pid = getActivePropertyUuid();
  root.querySelectorAll('.sp-row-edit').forEach((el) => {
    el.onclick = async () => {
      const key = el.getAttribute('data-edit');
      const rule = ruleByType(_spState.rules, key);
      if (!rule) return;
      const span = root.querySelector(`#sp-val-${key}`);
      if (!span || el.querySelector('input')) return;
      const cur = Number(rule.value) || 0;
      const input = document.createElement('input');
      input.type = 'number';
      input.value = cur;
      input.style.cssText = 'width:100px;padding:6px 8px;border-radius:8px;border:0.5px solid rgba(0,0,0,0.2);font-size:16px;font-weight:500;text-align:right';
      span.replaceWith(input);
      input.focus();
      input.select();
      const save = async () => {
        const v = Number(input.value);
        if (!Number.isFinite(v) || v < 0) return rebuild();
        await updatePricingRule(rule.id, { value: v });
        console.log('[StayOps] pricing rule updated', key, v);
        await rebuild();
      };
      input.onblur = save;
      input.onkeydown = (ev) => {
        if (ev.key === 'Enter') {
          input.blur();
        }
      };
    };
  });

  root.querySelector('#sp-add-discount').onclick = () => {
    _spNewDiscountOpen = !_spNewDiscountOpen;
    renderFullUI(root);
    bindNdForm(root, pid);
  };

  const ndCancel = root.querySelector('#sp-nd-cancel');
  const ndSave = root.querySelector('#sp-nd-save');
  if (ndCancel)
    ndCancel.onclick = () => {
      _spNewDiscountOpen = false;
      renderFullUI(root);
    };
  if (ndSave)
    ndSave.onclick = async () => {
      const name = (root.querySelector('#sp-nd-name') || {}).value || '';
      const cond = (root.querySelector('#sp-nd-cond') || {}).value || 'stay_length';
      const pct = Number((root.querySelector('#sp-nd-pct') || {}).value);
      const days = Number((root.querySelector('#sp-nd-days') || {}).value);
      if (!name.trim()) {
        globalThis.showBanner?.('Enter a discount name', 'warn');
        return;
      }
      await insertPricingRules([
        {
          property_id: pid,
          rule_type: 'discount',
          name: name.trim(),
          value: pct,
          condition_type: cond,
          condition_value: Number.isFinite(days) ? days : null,
          is_default: false,
        },
      ]);
      _spNewDiscountOpen = false;
      console.log('[StayOps] custom discount saved');
      await rebuild();
    };

  bindNdForm(root, pid);

  root.querySelectorAll('.sp-discount-del').forEach((b) => {
    b.onclick = async (ev) => {
      ev.stopPropagation();
      const id = b.getAttribute('data-id');
      if (!id) return;
      await deletePricingRuleRow(id);
      await rebuild();
    };
  });

  root.querySelectorAll('.sp-discount-row[data-swipe="1"]').forEach((row) => {
    let sx = 0;
    row.addEventListener(
      'touchstart',
      (e) => {
        sx = e.touches[0].clientX;
        _spLongPressTimer = setTimeout(() => {
          const id = row.getAttribute('data-id');
          const r = _spState.rules.find((x) => String(x.id) === String(id));
          if (r && !r.is_default && globalThis.confirm?.('Delete this discount?')) {
            deletePricingRuleRow(id).then(rebuild);
          }
        }, 550);
      },
      { passive: true }
    );
    row.addEventListener('touchend', (e) => {
      if (_spLongPressTimer) clearTimeout(_spLongPressTimer);
      const ex = e.changedTouches[0].clientX;
      if (sx - ex > 70) {
        const id = row.getAttribute('data-id');
        const r = _spState.rules.find((x) => String(x.id) === String(id));
        if (r && !r.is_default) deletePricingRuleRow(id).then(rebuild);
      }
    });
    row.addEventListener('touchmove', () => {
      if (_spLongPressTimer) clearTimeout(_spLongPressTimer);
    });
  });

  const gen = root.querySelector('#sp-generate');
  if (gen) gen.onclick = () => runGenerate(root);
  const reg = root.querySelector('#sp-regenerate');
  if (reg) reg.onclick = () => runGenerate(root);

  root.querySelector('#sp-cal-prev')?.addEventListener('click', () => {
    if (!_spState.calMonth) _spState.calMonth = new Date();
    _spState.calMonth = new Date(_spState.calMonth.getFullYear(), _spState.calMonth.getMonth() - 1, 1);
    renderFullUI(root);
  });
  root.querySelector('#sp-cal-next')?.addEventListener('click', () => {
    if (!_spState.calMonth) _spState.calMonth = new Date();
    _spState.calMonth = new Date(_spState.calMonth.getFullYear(), _spState.calMonth.getMonth() + 1, 1);
    renderFullUI(root);
  });

  // Date range inputs + preset buttons.
  const fromEl = root.querySelector('#sp-from');
  const toEl = root.querySelector('#sp-to');
  const syncPicked = () => {
    if (!_spState) return;
    if (fromEl) _spState.pickedStart = fromEl.value || null;
    if (toEl) _spState.pickedEnd = toEl.value || null;
  };
  if (fromEl) fromEl.onchange = syncPicked;
  if (toEl) toEl.onchange = syncPicked;

  root.querySelectorAll('.sp-preset').forEach((btn) => {
    btn.onclick = () => {
      const days = Number(btn.getAttribute('data-days')) || 60;
      const start = fromEl && fromEl.value ? fromEl.value : null;
      const base = start ? new Date(start + 'T00:00:00') : new Date();
      const end = new Date(base);
      end.setDate(end.getDate() + (days - 1));
      const fmt = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      if (fromEl) fromEl.value = fmt(base);
      if (toEl) toEl.value = fmt(end);
      syncPicked();
    };
  });
}

function bindNdForm(root, _pid) {
  const sel = root.querySelector('#sp-nd-cond');
  const lbl = root.querySelector('#sp-nd-days-lbl');
  if (!sel || !lbl) return;
  const sync = () => {
    const o = CONDITION_OPTIONS.find((x) => x.value === sel.value);
    lbl.textContent = o ? o.fieldLabel : 'Days / nights';
  };
  sel.onchange = sync;
  sync();
}

async function rebuild() {
  const root = document.getElementById(SP_ROOT_ID);
  if (!root) return;
  const pid = getActivePropertyUuid();
  let rules = await fetchPricingRulesForProperty(pid);
  if (!rules.length && pid) {
    const pc = getPricingConfig();
    await ensureDefaultPricingRules(pid, {
      baseNightly: pc.baseRate || 280,
      baseWeekend: Math.round((pc.baseRate || 280) * 1.15),
      minNights: 2,
    });
    rules = await fetchPricingRulesForProperty(pid);
  }
  const daysMap = _spState?.daysMap || null;
  const insight = _spState?.insight || '';
  const forecastStart = _spState?.forecastStart || '';
  const forecastEnd = _spState?.forecastEnd || '';
  const calMonth = _spState?.calMonth || new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  _spState = { rules, daysMap, insight, forecastStart, forecastEnd, calMonth };
  renderFullUI(root);
}

async function loadLatestRunFromCloud(pid) {
  const run = await fetchLatestPricingRun(pid);
  if (!run) return null;
  const suggestions = await fetchPricingSuggestionsForRun(run.id);
  return { run, suggestions };
}

async function runGenerate(root) {
  const btn = root.querySelector('#sp-generate');
  const reg = root.querySelector('#sp-regenerate');
  const spin = root.querySelector('#sp-gen-spinner');
  const activeBtn = reg && reg.offsetParent ? reg : btn;

  // Resolve chosen range.
  const fromEl = root.querySelector('#sp-from');
  const toEl = root.querySelector('#sp-to');
  const picked = {
    start: fromEl && fromEl.value ? fromEl.value : null,
    end: toEl && toEl.value ? toEl.value : null,
  };
  if (picked.start && picked.end) {
    if (picked.end < picked.start) {
      globalThis.showBanner?.('"To" date must be on or after "From"', 'warn');
      return;
    }
    const a = new Date(picked.start + 'T00:00:00');
    const b = new Date(picked.end + 'T00:00:00');
    const span = Math.round((b - a) / 86400000) + 1;
    if (span > 365) {
      globalThis.showBanner?.('Max range is 365 days', 'warn');
      return;
    }
  }

  if (activeBtn) activeBtn.disabled = true;
  if (btn) {
    btn.textContent = 'Generating…';
    btn.style.opacity = '0.85';
  }
  if (reg) reg.textContent = 'Generating…';
  if (spin) spin.style.display = 'block';
  const pid = getActivePropertyUuid();
  try {
    const result = await requestPricingGeneration({
      propertyId: pid,
      trigger: 'manual',
      forecastDays: FORECAST_DAYS,
      forecastStart: picked.start,
      forecastEnd: picked.end,
    });
    if (!result.ok) throw new Error(result.error || 'Generation failed');
    const rules = await fetchPricingRulesForProperty(pid);
    const daysMap = Object.create(null);
    for (const d of result.days || []) {
      if (d && d.date) {
        daysMap[d.date] = {
          date: d.date,
          suggestedRate: Number(d.suggestedRate) || 0,
          rateType: d.rateType || 'base',
          reason: d.reason || '',
        };
      }
    }
    // Jump calendar to the forecast's first month so the range is visible.
    let calMonth;
    if (result.forecast_start) {
      const [yy, mm] = result.forecast_start.split('-').map(Number);
      calMonth = new Date(yy, mm - 1, 1);
    } else {
      const t = new Date();
      calMonth = new Date(t.getFullYear(), t.getMonth(), 1);
    }
    _spState = {
      rules,
      daysMap,
      insight: result.insight || '',
      forecastStart: result.forecast_start || '',
      forecastEnd: result.forecast_end || '',
      pickedStart: picked.start || result.forecast_start || '',
      pickedEnd: picked.end || result.forecast_end || '',
      calMonth,
    };
    console.log('[StayOps] smart pricing calendar generated', Object.keys(daysMap).length, 'days');
    renderFullUI(root);
  } catch (e) {
    console.warn('[StayOps] generate pricing failed', e);
    globalThis.showBanner?.(e.message || 'Could not generate pricing', 'warn');
  } finally {
    if (btn) {
      btn.textContent = 'Generate pricing calendar';
      btn.style.opacity = '1';
      btn.disabled = false;
    }
    if (reg) {
      reg.textContent = 'Regenerate pricing suggestions';
      reg.disabled = false;
    }
    if (spin) spin.style.display = 'none';
  }
}

export async function renderSmartPricingPanel() {
  const root = document.getElementById(SP_ROOT_ID);
  if (!root) return;
  if (typeof isPortfolioMode === 'function' && isPortfolioMode()) {
    root.innerHTML =
      '<div style="padding:24px;text-align:center;font-size:14px;color:var(--text-soft)">Select a property from the switcher to edit Smart Pricing.</div>';
    return;
  }
  const user = await getCurrentSupabaseUser();
  if (!user) {
    root.innerHTML =
      '<div style="padding:24px;text-align:center;font-size:14px;color:var(--text-soft)">Sign in to load pricing rules.</div>';
    return;
  }
  const pid = getActivePropertyUuid();
  if (!pid) {
    root.innerHTML =
      '<div style="padding:24px;text-align:center;font-size:14px;color:var(--text-soft)">Property is not linked to the cloud yet.</div>';
    return;
  }
  _spNewDiscountOpen = false;
  _spState = { rules: [], daysMap: null, insight: '', forecastStart: '', forecastEnd: '', calMonth: null };
  let rules = await fetchPricingRulesForProperty(pid);
  if (!rules.length) {
    const pc = getPricingConfig();
    await ensureDefaultPricingRules(pid, {
      baseNightly: pc.baseRate || 280,
      baseWeekend: Math.round((pc.baseRate || 280) * 1.15),
      minNights: 2,
    });
    rules = await fetchPricingRulesForProperty(pid);
  }
  _spState.rules = rules;
  _spState.calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  // Load the most recent persisted run/suggestions so the calendar appears
  // immediately without burning tokens on a fresh AI call.
  try {
    const loaded = await loadLatestRunFromCloud(pid);
    if (loaded && loaded.run) {
      _spState.daysMap = daysMapFromSuggestions(loaded.suggestions);
      _spState.insight = loaded.run.insight || '';
      _spState.forecastStart = loaded.run.forecast_start || '';
      _spState.forecastEnd = loaded.run.forecast_end || '';
    }
  } catch (e) {
    console.warn('[StayOps] loadLatestRun failed', e.message || e);
  }

  renderFullUI(root);
}

/** @deprecated */
export async function getSmartPricing() {
  await renderSmartPricingPanel();
  const btn = document.getElementById('sp-generate');
  if (btn) btn.click();
}
