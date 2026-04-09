/* ═══════════════════════════════════════════════════════════════════════════
   STAYOPS — Depreciation Schedule
   Track depreciating assets and calculate annual deductions.
   ═══════════════════════════════════════════════════════════════════════════ */

import { getActivePropertyId } from './config.js';

// ── ATO COMMON ASSET PRESETS ─────────────────────────────────────────────────

export const DEPRECIATION_PRESETS = [
  { label: 'Furniture (general)',   usefulLife: 13, method: 'diminishing' },
  { label: 'Whitegoods',           usefulLife: 12, method: 'diminishing' },
  { label: 'Electronics / TV',     usefulLife: 5,  method: 'diminishing' },
  { label: 'Carpet / Flooring',    usefulLife: 10, method: 'diminishing' },
  { label: 'Hot Water System',     usefulLife: 12, method: 'diminishing' },
  { label: 'Air Conditioning',     usefulLife: 10, method: 'diminishing' },
  { label: 'Outdoor Furniture',    usefulLife: 5,  method: 'diminishing' },
  { label: 'Dishwasher',           usefulLife: 10, method: 'diminishing' },
  { label: 'Curtains / Blinds',    usefulLife: 10, method: 'diminishing' },
  { label: 'Mattress',             usefulLife: 10, method: 'diminishing' },
  { label: 'Cookware / Utensils',  usefulLife: 5,  method: 'diminishing' },
  { label: 'Custom…',              usefulLife: 0,  method: 'diminishing' },
];

// ── ASSET CRUD ───────────────────────────────────────────────────────────────

export function getDepreciationAssets() {
  return (window._appConfig && window._appConfig.depreciation_assets) || [];
}

function saveDepreciationAssets(assets) {
  window._appConfig = window._appConfig || {};
  window._appConfig.depreciation_assets = assets;
  if (typeof globalThis.saveAppConfigToCloud === 'function') {
    globalThis.saveAppConfigToCloud({ depreciation_assets: assets }).catch(() => {});
  }
}

export function addDepreciationAsset(asset) {
  const assets = getDepreciationAssets().slice();
  asset.id = 'dep-' + Date.now();
  asset.propertyId = asset.propertyId || getActivePropertyId();
  assets.push(asset);
  saveDepreciationAssets(assets);
  return asset;
}

export function updateDepreciationAsset(id, updates) {
  const assets = getDepreciationAssets().slice();
  const idx = assets.findIndex(a => a.id === id);
  if (idx === -1) return null;
  assets[idx] = { ...assets[idx], ...updates };
  saveDepreciationAssets(assets);
  return assets[idx];
}

export function deleteDepreciationAsset(id) {
  const assets = getDepreciationAssets().filter(a => a.id !== id);
  saveDepreciationAssets(assets);
}

// ── CALCULATION ENGINE ───────────────────────────────────────────────────────

/**
 * Calculate the FY start/end dates.
 * Australian FY: 1 July to 30 June. FY2024 = 1 Jul 2024 – 30 Jun 2025.
 */
function fyDates(fy) {
  return {
    start: new Date(fy, 6, 1),   // 1 July
    end:   new Date(fy + 1, 5, 30) // 30 June
  };
}

/**
 * Days an asset was held during a given FY.
 */
function daysHeldInFY(purchaseDateStr, fy) {
  const { start, end } = fyDates(fy);
  const purchased = new Date(purchaseDateStr + 'T00:00:00');

  // Asset purchased after FY end — not held
  if (purchased > end) return 0;

  const holdStart = purchased > start ? purchased : start;
  const holdEnd = end;
  const days = Math.round((holdEnd - holdStart) / (1000 * 60 * 60 * 24)) + 1;
  return Math.max(0, days);
}

/**
 * Total days in an FY (365 or 366 for leap year).
 */
function totalDaysInFY(fy) {
  const { start, end } = fyDates(fy);
  return Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;
}

/**
 * Calculate straight-line depreciation for a given FY.
 */
function straightLineForFY(asset, fy) {
  const cost = Number(asset.cost) || 0;
  const residual = Number(asset.residualValue) || 0;
  const life = Number(asset.usefulLife) || 1;

  const annualDep = (cost - residual) / life;
  const daysTotal = totalDaysInFY(fy);
  const daysHeld = daysHeldInFY(asset.purchaseDate, fy);

  if (daysHeld <= 0) return 0;

  // Check if fully depreciated before this FY
  const purchaseDate = new Date(asset.purchaseDate + 'T00:00:00');
  const endOfLifeDate = new Date(purchaseDate);
  endOfLifeDate.setFullYear(endOfLifeDate.getFullYear() + life);
  const { start: fyStart } = fyDates(fy);

  if (fyStart >= endOfLifeDate) return 0; // Fully depreciated

  return Math.round(annualDep * (daysHeld / daysTotal) * 100) / 100;
}

/**
 * Calculate diminishing value depreciation for a given FY.
 * ATO formula: base value × (days held ÷ 365) × (200% ÷ useful life)
 */
function diminishingValueForFY(asset, fy) {
  const cost = Number(asset.cost) || 0;
  const residual = Number(asset.residualValue) || 0;
  const life = Number(asset.usefulLife) || 1;

  const purchaseDate = new Date(asset.purchaseDate + 'T00:00:00');
  const purchaseYear = purchaseDate.getMonth() >= 6 ? purchaseDate.getFullYear() : purchaseDate.getFullYear() - 1;

  // Calculate base value by subtracting all prior FY deductions
  let baseValue = cost;
  for (let priorFY = purchaseYear; priorFY < fy; priorFY++) {
    const priorDays = daysHeldInFY(asset.purchaseDate, priorFY);
    if (priorDays <= 0) continue;
    const daysTotal = totalDaysInFY(priorFY);
    const dep = baseValue * (priorDays / daysTotal) * (2 / life);
    baseValue -= dep;
    if (baseValue <= residual) { baseValue = residual; break; }
  }

  if (baseValue <= residual) return 0;

  const daysHeld = daysHeldInFY(asset.purchaseDate, fy);
  if (daysHeld <= 0) return 0;

  const daysTotal = totalDaysInFY(fy);
  const dep = baseValue * (daysHeld / daysTotal) * (2 / life);
  const result = Math.min(dep, baseValue - residual);

  return Math.round(result * 100) / 100;
}

/**
 * Get depreciation for an asset for a given FY.
 */
export function getAssetDepreciationForFY(asset, fy) {
  if (asset.method === 'straight_line') {
    return straightLineForFY(asset, fy);
  }
  return diminishingValueForFY(asset, fy);
}

/**
 * Get total depreciation across all assets for a given FY.
 */
export function getTotalDepreciationForFY(fy) {
  const assets = getDepreciationAssets();
  const activePid = getActivePropertyId();
  return assets
    .filter(a => !a.propertyId || a.propertyId === activePid)
    .reduce((sum, a) => sum + getAssetDepreciationForFY(a, fy), 0);
}

/**
 * Get year-by-year depreciation schedule for an asset.
 * Returns array of { fy, deduction, openingValue, closingValue }
 */
export function getAssetSchedule(asset) {
  const cost = Number(asset.cost) || 0;
  const residual = Number(asset.residualValue) || 0;
  const life = Number(asset.usefulLife) || 1;
  const purchaseDate = new Date(asset.purchaseDate + 'T00:00:00');
  const startFY = purchaseDate.getMonth() >= 6 ? purchaseDate.getFullYear() : purchaseDate.getFullYear() - 1;

  const schedule = [];
  let openingValue = cost;

  for (let fy = startFY; fy <= startFY + life + 1; fy++) {
    const dep = getAssetDepreciationForFY(asset, fy);
    if (dep <= 0 && fy > startFY) break;

    const closingValue = Math.max(residual, openingValue - dep);
    schedule.push({
      fy,
      fyLabel: 'FY' + fy + '–' + String(fy + 1).slice(-2),
      deduction: dep,
      openingValue,
      closingValue,
    });
    openingValue = closingValue;
    if (openingValue <= residual) break;
  }

  return schedule;
}

// ── UI RENDERING ─────────────────────────────────────────────────────────────

export function renderDepreciationPanel() {
  const container = document.getElementById('depreciation-list');
  if (!container) return;

  const assets = getDepreciationAssets();
  const activePid = getActivePropertyId();
  const filtered = assets.filter(a => !a.propertyId || a.propertyId === activePid);

  // Current FY
  const now = new Date();
  const currentFY = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  const totalDep = filtered.reduce((s, a) => s + getAssetDepreciationForFY(a, currentFY), 0);

  if (!filtered.length) {
    container.innerHTML = '<div style="text-align:center;padding:32px 16px;color:var(--text-soft);font-family:\'DM Sans\',sans-serif;font-size:14px">' +
      '<div style="font-size:28px;margin-bottom:8px">📉</div>' +
      'No depreciating assets yet.<br>Add furniture, appliances, or equipment below.' +
      '</div>';
    return;
  }

  // Summary
  let html = '<div style="background:#E8F5E9;border-radius:10px;padding:14px 16px;margin-bottom:12px;text-align:center">' +
    '<div style="font-size:11px;color:#388E3C;font-family:\'DM Sans\',sans-serif;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px">FY' + currentFY + ' Total Deduction</div>' +
    '<div style="font-size:22px;font-weight:600;color:#2E7D32;font-family:\'DM Serif Display\',serif">$' + totalDep.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '</div>' +
    '</div>';

  // Asset list
  html += '<div class="card" style="padding:0;overflow:hidden">';
  for (const a of filtered) {
    const fyDep = getAssetDepreciationForFY(a, currentFY);
    const methodLabel = a.method === 'straight_line' ? 'SL' : 'DV';

    html += '<div style="padding:14px 16px;border-bottom:1px solid #F0ECE6;display:flex;align-items:center;justify-content:space-between;cursor:pointer" onclick="showDepreciationDetail(\'' + a.id + '\')">' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-weight:500;font-size:14px;color:#1a1a1a;font-family:\'DM Sans\',sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + _escHtml(a.name) + '</div>' +
        '<div style="font-size:12px;color:var(--text-soft);font-family:\'DM Sans\',sans-serif;margin-top:2px">' +
          '$' + Number(a.cost).toLocaleString() + ' · ' + a.usefulLife + 'yr ' + methodLabel + ' · FY' + currentFY + ': $' + fyDep.toFixed(2) +
        '</div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0">' +
        '<button onclick="event.stopPropagation();deleteDepreciationAssetUI(\'' + a.id + '\')" style="background:none;border:none;font-size:16px;cursor:pointer;padding:4px;color:#D44" title="Delete">✕</button>' +
        '<div style="color:#C7C7CC;font-size:20px;font-weight:300">›</div>' +
      '</div>' +
    '</div>';
  }
  html += '</div>';

  container.innerHTML = html;
}

export function showDepreciationDetail(id) {
  const assets = getDepreciationAssets();
  const asset = assets.find(a => a.id === id);
  if (!asset) return;

  const schedule = getAssetSchedule(asset);
  const container = document.getElementById('depreciation-list');
  if (!container) return;

  let html = '<div class="settings-back" onclick="renderDepreciationPanel()" style="color:#185FA5;margin-bottom:8px">‹ Back to assets</div>';

  html += '<div class="card" style="padding:16px;margin-bottom:12px">' +
    '<div style="font-weight:600;font-size:16px;color:#1a1a1a;font-family:\'DM Sans\',sans-serif;margin-bottom:8px">' + _escHtml(asset.name) + '</div>' +
    '<div style="font-size:13px;color:var(--text-soft);font-family:\'DM Sans\',sans-serif;line-height:1.6">' +
      'Cost: $' + Number(asset.cost).toLocaleString(undefined, {minimumFractionDigits:2}) + '<br>' +
      'Purchased: ' + asset.purchaseDate + '<br>' +
      'Useful life: ' + asset.usefulLife + ' years<br>' +
      'Method: ' + (asset.method === 'straight_line' ? 'Straight Line' : 'Diminishing Value') + '<br>' +
      (asset.notes ? 'Notes: ' + _escHtml(asset.notes) : '') +
    '</div>' +
  '</div>';

  // Schedule table
  html += '<div class="card" style="padding:0;overflow:hidden">' +
    '<table style="width:100%;border-collapse:collapse;font-family:\'DM Sans\',sans-serif;font-size:13px">' +
    '<thead><tr style="background:#F5F3EF">' +
      '<th style="padding:10px 12px;text-align:left;font-weight:500;color:var(--text-soft)">Year</th>' +
      '<th style="padding:10px 12px;text-align:right;font-weight:500;color:var(--text-soft)">Opening</th>' +
      '<th style="padding:10px 12px;text-align:right;font-weight:500;color:var(--text-soft)">Deduction</th>' +
      '<th style="padding:10px 12px;text-align:right;font-weight:500;color:var(--text-soft)">Closing</th>' +
    '</tr></thead><tbody>';

  for (const row of schedule) {
    const fmt = (n) => '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    html += '<tr style="border-bottom:1px solid #F0ECE6">' +
      '<td style="padding:10px 12px;font-weight:500">' + row.fyLabel + '</td>' +
      '<td style="padding:10px 12px;text-align:right">' + fmt(row.openingValue) + '</td>' +
      '<td style="padding:10px 12px;text-align:right;color:#2E7D32;font-weight:500">' + fmt(row.deduction) + '</td>' +
      '<td style="padding:10px 12px;text-align:right">' + fmt(row.closingValue) + '</td>' +
    '</tr>';
  }

  html += '</tbody></table></div>';

  container.innerHTML = html;
}

export async function deleteDepreciationAssetUI(id) {
  if (!(await globalThis.showAppModal({ title: 'Delete Asset', msg: 'Delete this asset? This cannot be undone.', confirmText: 'Delete', confirmColor: 'var(--red)' }))) return;
  deleteDepreciationAsset(id);
  renderDepreciationPanel();
  if (typeof globalThis.showBanner === 'function') {
    globalThis.showBanner('Asset deleted', 'ok');
  }
}

export function saveDepreciationFromForm() {
  const name = (document.getElementById('dep-name') || {}).value?.trim();
  const cost = parseFloat((document.getElementById('dep-cost') || {}).value);
  const purchaseDate = (document.getElementById('dep-purchase-date') || {}).value;
  const usefulLife = parseInt((document.getElementById('dep-useful-life') || {}).value, 10);
  const method = (document.getElementById('dep-method') || {}).value || 'diminishing';
  const notes = (document.getElementById('dep-notes') || {}).value?.trim() || '';
  const residualValue = parseFloat((document.getElementById('dep-residual') || {}).value) || 0;

  if (!name) { globalThis.showBanner('⚠ Asset name is required', 'warn'); return; }
  if (!cost || isNaN(cost)) { globalThis.showBanner('⚠ Valid cost is required', 'warn'); return; }
  if (!purchaseDate) { globalThis.showBanner('⚠ Purchase date is required', 'warn'); return; }
  if (!usefulLife || isNaN(usefulLife)) { globalThis.showBanner('⚠ Useful life is required', 'warn'); return; }

  addDepreciationAsset({
    name,
    cost,
    purchaseDate,
    usefulLife,
    method,
    residualValue,
    notes,
  });

  // Clear form
  ['dep-name', 'dep-cost', 'dep-purchase-date', 'dep-useful-life', 'dep-notes', 'dep-residual'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  globalThis.showBanner('✓ Asset added', 'ok');
  renderDepreciationPanel();
}

export function onDepPresetChange() {
  const sel = document.getElementById('dep-preset');
  const lifeEl = document.getElementById('dep-useful-life');
  const methodEl = document.getElementById('dep-method');
  const nameEl = document.getElementById('dep-name');
  if (!sel) return;
  const idx = parseInt(sel.value, 10);
  if (isNaN(idx) || idx < 0) return;
  const preset = DEPRECIATION_PRESETS[idx];
  if (!preset) return;
  if (preset.usefulLife && lifeEl) lifeEl.value = preset.usefulLife;
  if (preset.method && methodEl) methodEl.value = preset.method;
  if (nameEl && !nameEl.value && preset.label !== 'Custom…') nameEl.value = preset.label;
}

function _escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
