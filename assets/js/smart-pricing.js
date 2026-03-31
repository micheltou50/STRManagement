/**
 * StayOps — Smart Pricing: rules editor + AI calendar (Finance hub).
 */
import { bookings } from './state.js';
import {
  getActivePropertyConfig,
  getActivePropertyId,
  getPricingConfig,
  getCurrentPropertyName,
} from './config.js';
import { isPortfolioMode } from './property.js';
import {
  getCurrentSupabaseUser,
  fetchPricingRulesForProperty,
  ensureDefaultPricingRules,
  updatePricingRule,
  insertPricingRules,
  deletePricingRuleRow,
} from './supabase.js';
import { AIService } from './ai-logic.js';
import { escHtml } from './utils.js';

const SP_ROOT_ID = 'smart-pricing-root';

/** NSW school holiday periods (approximate; update annually). */
const NSW_SCHOOL_HOLIDAY_RANGES = [
  { start: '2026-04-11', end: '2026-04-26', label: 'NSW Autumn break 2026' },
  { start: '2026-07-04', end: '2026-07-19', label: 'NSW Winter break 2026' },
  { start: '2026-09-19', end: '2026-10-05', label: 'NSW Spring break 2026' },
  { start: '2026-12-21', end: '2027-01-27', label: 'NSW Summer break 2026–27' },
  { start: '2027-04-10', end: '2027-04-25', label: 'NSW Autumn break 2027' },
  { start: '2027-07-03', end: '2027-07-18', label: 'NSW Winter break 2027' },
];

/** Australian national / NSW public holidays (YYYY-MM-DD). */
const AU_PUBLIC_HOLIDAYS = [
  { date: '2026-01-01', name: "New Year's Day" },
  { date: '2026-01-26', name: 'Australia Day' },
  { date: '2026-04-03', name: 'Good Friday' },
  { date: '2026-04-04', name: 'Easter Saturday' },
  { date: '2026-04-05', name: 'Easter Sunday' },
  { date: '2026-04-06', name: 'Easter Monday' },
  { date: '2026-04-25', name: 'Anzac Day' },
  { date: '2026-06-08', name: "King's Birthday (NSW)" },
  { date: '2026-10-05', name: 'Labour Day (NSW)' },
  { date: '2026-12-25', name: 'Christmas Day' },
  { date: '2026-12-26', name: 'Boxing Day' },
  { date: '2026-12-28', name: 'Boxing Day (substitute)' },
  { date: '2027-01-01', name: "New Year's Day" },
  { date: '2027-01-26', name: 'Australia Day' },
  { date: '2027-03-26', name: 'Good Friday' },
  { date: '2027-03-29', name: 'Easter Monday' },
  { date: '2027-04-25', name: 'Anzac Day' },
  { date: '2027-06-14', name: "King's Birthday (NSW)" },
  { date: '2027-10-04', name: 'Labour Day (NSW)' },
  { date: '2027-12-25', name: 'Christmas Day' },
  { date: '2027-12-27', name: 'Christmas (substitute)' },
  { date: '2027-12-28', name: 'Boxing Day (substitute)' },
];

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

function bookingsForProperty(pid) {
  if (!pid) return [];
  return bookings.filter((b) => b.status !== 'cancelled' && String(b._propertyId || '') === String(pid));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function ymd(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseYmd(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function eachNightYmd(checkin, checkout) {
  const out = [];
  const s = parseYmd(String(checkin).slice(0, 10));
  const e = parseYmd(String(checkout).slice(0, 10));
  for (let t = s.getTime(); t < e.getTime(); t += 86400000) {
    out.push(ymd(new Date(t)));
  }
  return out;
}

function buildBookedSetForRange(pid, startYmd, endYmd) {
  const set = new Set();
  const start = parseYmd(startYmd);
  const end = parseYmd(endYmd);
  for (const b of bookingsForProperty(pid)) {
    if (!b.checkin || !b.checkout) continue;
    for (const n of eachNightYmd(b.checkin, b.checkout)) {
      const d = parseYmd(n);
      if (d >= start && d < end) set.add(n);
    }
  }
  return set;
}

function historicalStatsForPrompt(pid) {
  const now = new Date();
  const curM = now.getMonth();
  const curY = now.getFullYear();
  const list = bookingsForProperty(pid).filter((b) => b.checkin && b.status !== 'cancelled');
  const priorYears = [curY - 1, curY - 2];
  const chunks = [];
  for (const yr of priorYears) {
    const inMo = list.filter((b) => {
      const d = parseYmd(String(b.checkin).slice(0, 10));
      return d.getFullYear() === yr && d.getMonth() === curM;
    });
    if (!inMo.length) continue;
    const revenue = inMo.reduce((s, b) => s + (Number(b.hostPayout) || 0), 0);
    const nights = inMo.reduce((s, b) => s + (Number(b.nights) || 0), 0);
    const avg = nights ? Math.round(revenue / nights) : 0;
    chunks.push({ year: yr, month: curM + 1, bookings: inMo.length, avgNightlyHostPayout: avg });
  }
  return chunks;
}

function buildAiPrompt(rules, pid, forecastStart, forecastEnd) {
  const pName = getCurrentPropertyName();
  const today = ymd(new Date());
  const bookList = bookingsForProperty(pid)
    .filter((b) => b.checkin)
    .map((b) => ({
      checkin: String(b.checkin).slice(0, 10),
      checkout: String(b.checkout).slice(0, 10),
      status: b.status || 'confirmed',
      guest: b.name,
      hostPayoutTotal: Number(b.hostPayout) || 0,
      nights: Number(b.nights) || 0,
    }));
  const next90 = bookList.filter((b) => {
    const ci = parseYmd(b.checkin);
    const lim = parseYmd(forecastEnd);
    return ci <= lim;
  });
  const hist = historicalStatsForPrompt(pid);
  const rulesJson = JSON.stringify(
    rules.map((r) => ({
      rule_type: r.rule_type,
      name: r.name,
      value: Number(r.value),
      condition_type: r.condition_type,
      condition_value: r.condition_value,
      is_default: r.is_default,
      meta: r.meta,
    }))
  );

  return `You are a revenue manager for an Australian short-term rental in NSW.

Today is ${today}.
Property: ${pName}.

PRICING RULES (JSON):
${rulesJson}

BOOKINGS (next 90 days relevant, all non-cancelled):
${JSON.stringify(next90.slice(0, 80))}

HISTORICAL SAME-MONTH (prior years): ${JSON.stringify(hist)}

NSW SCHOOL HOLIDAY PERIODS (raise demand — suggest premium vs base):
${JSON.stringify(NSW_SCHOOL_HOLIDAY_RANGES)}

AUSTRALIAN PUBLIC HOLIDAYS:
${JSON.stringify(AU_PUBLIC_HOLIDAYS.filter((h) => h.date >= today && h.date <= forecastEnd))}

TASK: For each calendar night from ${forecastStart} through ${forecastEnd} INCLUSIVE of guest stay nights (date is check-in night through night before checkout — same as standard booking calendar): return suggested AUD nightly RATE the guest should be charged before platform fees (or use 0 and rateType "booked" for booked nights).

Apply:
- Weekday base vs Fri–Sat weekend base from rules
- Discount rules when conditions match (stay length, lead time, last-minute vacancy, gap, etc.)
- Premium hints on NSW school holidays and public holidays from the lists above
- Last-minute / gap logic using condition_value from rules

Respond with ONLY valid JSON, no markdown:
{
  "days": [
    { "date": "2026-04-01", "suggestedRate": 320, "reason": "Weeknight base", "rateType": "base" }
  ],
  "insight": "Two or three sentences summarising main pricing moves for the host."
}

rateType must be one of: "base", "weekend", "peak", "discounted", "booked".
For booked nights use suggestedRate 0, rateType "booked", reason short.`;
}

function parseAiJson(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

function mergeBookedDays(daysArr, bookedSet) {
  const by = Object.create(null);
  for (const d of daysArr) {
    if (d && d.date) by[d.date] = { ...d };
  }
  for (const date of bookedSet) {
    by[date] = {
      date,
      suggestedRate: 0,
      reason: 'Booked',
      rateType: 'booked',
    };
  }
  return Object.keys(by)
    .sort()
    .map((k) => by[k]);
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
    let sub = '';
    let cellBg = 'transparent';
    let cellBorder = '0.5px solid rgba(0,0,0,0.06)';
    let subColor = '#1a1a1a';
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
}

function bindNdForm(root, pid) {
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

async function runGenerate(root) {
  const btn = root.querySelector('#sp-generate');
  const reg = root.querySelector('#sp-regenerate');
  const spin = root.querySelector('#sp-gen-spinner');
  const activeBtn = reg && reg.offsetParent ? reg : btn;
  if (activeBtn) activeBtn.disabled = true;
  if (btn) {
    btn.textContent = 'Generating…';
    btn.style.opacity = '0.85';
  }
  if (reg) reg.textContent = 'Generating…';
  if (spin) spin.style.display = 'block';
  const pid = getActivePropertyUuid();
  try {
    const rules = await fetchPricingRulesForProperty(pid);
    const today = new Date();
    const startD = ymd(today);
    const endDt = new Date(today);
    endDt.setDate(endDt.getDate() + 29);
    const endD = ymd(endDt);
    const prompt = buildAiPrompt(rules, pid, startD, endD);
    const { response, data } = await AIService.request({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }],
    });
    if (!response.ok) {
      const msg = data.error?.message || 'HTTP ' + response.status;
      throw new Error(msg);
    }
    const text = data.content?.[0]?.text || '';
    let parsed;
    try {
      parsed = parseAiJson(text);
    } catch (parseErr) {
      throw new Error('Could not parse AI response as JSON');
    }
    const daysArr = Array.isArray(parsed.days) ? parsed.days : [];
    const booked = buildBookedSetForRange(pid, startD, endD);
    const merged = mergeBookedDays(daysArr, booked);
    const daysMap = Object.create(null);
    for (const d of merged) {
      if (d.date >= startD && d.date <= endD) daysMap[d.date] = d;
    }
    _spState = {
      rules,
      daysMap,
      insight: parsed.insight || '',
      forecastStart: startD,
      forecastEnd: endD,
      calMonth: new Date(today.getFullYear(), today.getMonth(), 1),
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
  renderFullUI(root);
}

/** @deprecated */
export async function getSmartPricing() {
  await renderSmartPricingPanel();
  const btn = document.getElementById('sp-generate');
  if (btn) btn.click();
}
