/**
 * StayOps — dashboard, sections, modals, maintenance/inventory, cleaner shell, onboarding.
 */
import {
  lsKey,
  getAllProperties,
  getActivePropertyConfig,
  savePropertyConfig,
  hasValidPropertyConfig,
  getCurrentPropertyName,
  getPropertyConfigGaps,
  migrateConfigFromLegacySettings,
  initPropertyUI,
} from './config.js';
import {
  bookings,
  cleans,
  expenses,
  maintenance,
  inventory,
  reloadArraysFromLocalStorage,
  replaceArrayInPlace,
} from './state.js';
import {
  escHtml,
  parseLocalDayStart,
  fmt,
  isAwaitingCleanerResponse,
  _normName,
  escapeJsSingleQuotedHtmlAttr,
  fyLabel,
  showBannerToast,
} from './utils.js';
import {
  _sendCleanerAssignmentNotifications,
  enableNotificationsManually,
  resetPushOnly,
  updateNotifStatus,
  subscribeToPush,
  sendPushToDevice,
  getCleanerSub,
  getFreshOwnerSub,
  sendCleanerEmail,
  cleanerLinkForId,
  openNotifyModal,
  sendCleanerReminder,
  pickContact,
  sendSMS,
  closeNotifyModal,
  applyPreset,
  loadEmailTemplate,
  saveEmailTemplate,
  resetEmailTemplate,
  insertTemplateVar,
  openEmailTemplatePanel,
  updateEmailPreview,
  testNotificationConfig,
  testCleanerEmail,
} from './notifications.js';
import {
  bookingFilter,
  renderPortfolioDashboard,
  renderPropertySwitcher,
  switchActiveProperty,
  openPropertySettingsMenu,
  openPropertySwitcherSheet,
  closePropertySwitcherSheet,
  switchToPortfolioFromSheet,
  switchPropertyFromSheet,
  backToPropertyHub,
  showPropertySub,
  renderProperty,
  openPropertyAccessRules,
  openPropertyDetailsFromHub,
  openOwnerReportFromHub,
  getPropertyColour,
  getPropertyColourById,
  getPropertyNameById,
  isPortfolioMode,
  enterPortfolioMode,
  exitPortfolioMode,
  showPropertyPicker,
  applyPortfolioModeAfterHostHydrate,
} from './property.js';
import {
  getSmartPricing,
  analyseExpenses,
  renderAIIgnoreList,
  promptIgnore,
  removeAIIgnoreItem,
  attachExpensePhoto,
  attachExpenseFile,
  clearExpensePhoto,
  extractExpenseFromReceipt,
  isExpensePhotoConverting,
  getExpensePhotoUploadSnapshot,
  readBookingScreenshot,
  extractBookingFromScreenshot,
} from './ai.js';
import {
  normalizeBookingCleanState,
  isCleanLinkedToCancelledBooking,
  getBookingCleanerState,
  isCleanerPerson,
  populateSelects,
  populateCleanerSelect,
  renderCleaning,
  quickAssignLastCleaner,
  addClean,
  autoFillCleanDate,
  assignCleanerToBooking,
  jumpToAssignClean,
  toggleCleanAction,
  markCleanDeclined,
  markCleanerConfirmed,
  reassignClean,
  toggleCleanerConfirmed,
  revealCleanerReassign,
  switchCleanView,
  setCleanStatusFilter,
  cleanerAccept,
  cleanerDecline,
  cleanerMarkDone,
} from './cleaning.js';
import {
  backToFinanceHub,
  toggleExpenseAddForm,
  closeExpenseAddForm,
  showFinanceSub,
  switchReportsSubTab,
  openFinancePanelFromHub,
  switchPayoutsSubTab,
  switchMgmtSubTab,
  switchReportSubTab,
  renderMgmtFY,
  renderFinance,
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
  renderClientsList,
  addClient,
  deleteClient,
  saveBankDetails,
  saveInvoiceDetails,
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
} from './finance.js';
import {
  openSettings,
  renderConnectionSummary,
  refreshConnectionSummarySoon,
  connectGmail,
  connectOutlook,
  maybeAutoScanGmail,
  scanGmailBookings,
  maybeAutoScanOutlook,
  scanOutlookBookings,
  populateCalendarFeedPanel,
  copyCalendarFeedUrl,
  _resetSettingsToMenu,
  openSettingsCat,
  openSettingsPanel,
  closeSettingsPanel,
  closeSettingsCat,
  renderSettings,
  clearCacheAndResync,
  saveSMSTemplate,
  saveGeminiKey,
  saveApiKey,
  getApiKey,
  getHostProfile,
  saveHostProfile,
  saveHostProfilePanel,
  renderHostProfileRow,
  loadCleaners,
  saveCleaners,
  addCleaner,
  deleteCleaner,
  renderTeamList,
  openCleanerProfile,
  saveCleanerContact,
  populateContractorSelect,
  renderStorageViewer,
  getFx,
  saveFxSetting,
  initFxSettings,
  initSettingsSwipeBack,
  toggleAutoAssignCleaner,
  resetConnectionCheckerResults,
  openCleanerSettings,
  renderCleanerAccessList,
  saveCleanerPinById,
  clearCleanerPinById,
  saveCleanerPerm,
  copyCleanerLinkById,
} from './settings.js';
import {
  calPrev,
  calNext,
  updateCalStats,
  renderCalendar,
  openCalPreview,
  closeCalPreview,
  renderBookings,
  renderNotes,
  addNote,
  showDetail,
  showEditModal,
  saveEdit,
  editCalcNights,
  editCalcNet,
  filterBookings,
  addBooking,
  deleteBooking,
  importAirbnbCSV,
  importCSV,
  switchModalTab,
  saveCleaningFee,
} from './bookings.js';


// ── STATE ────────────────────────────────────────────────────────────────

function getPlanStateLite() {
  const raw = localStorage.getItem('gh-plan-state') || 'free';
  return raw === 'pro' ? 'pro' : 'free';
}

function getUsageSnapshotLite() {
  const props = (typeof getAllProperties === 'function' ? getAllProperties() : []) || [];
  const propertyCount = props.length;
  const bookingCount = bookings.filter(b => b.status !== 'cancelled').length;
  const cleanerCount = loadCleaners().filter(c => isCleanerPerson(c)).length;
  return { propertyCount, bookingCount, cleanerCount };
}

function getPlanWarningLines(usage, planLimits) {
  const lines = [];
  const pushNudge = (label, count, limit) => {
    if (!Number.isFinite(limit) || limit >= 900) return;
    if (count >= limit) lines.push(`⚠ ${label}: ${count}/${limit} on Free — consider Pro when available.`);
    else if (count >= Math.ceil(limit * 0.8)) lines.push(`↗ ${label}: ${count}/${limit} — nearing the Free plan guide.`);
  };
  pushNudge('Properties', usage.propertyCount, planLimits.properties);
  pushNudge('Bookings', usage.bookingCount, planLimits.bookings);
  pushNudge('Cleaners', usage.cleanerCount, planLimits.cleaners);
  return lines;
}

function renderSettingsPlanUsageCard() {
  const planEl = document.getElementById('settings-plan-nudge');
  if (planEl) planEl.innerHTML = '';
}


function renderOnboardingGuidance(usageSnapshot) {
  const el = document.getElementById('dashboard-product-guidance');
  if (el) el.innerHTML = '';
}

function renderPlanNudges(usageSnapshot, planState) {
  const el = document.getElementById('dashboard-plan-nudges');
  if (el) el.innerHTML = '';
}



// Silent background Gmail scan — runs automatically on boot, throttled to once per 30 min.
// Does not touch button UI; only refreshes data if bookings changed.



function showBanner(msg, type) {
  showBannerToast(msg, type);
  refreshConnectionSummarySoon();
}

// ── PLATFORM ICON ─────────────────────────────────────────────────────────
function platformIcon(platform, size) {
  size = size || 40;
  const s = String(platform || '').toLowerCase();
  const radius = Math.round(size * 0.25);
  const style = `width:${size}px;height:${size}px;border-radius:${radius}px;display:flex;align-items:center;justify-content:center;font-size:${Math.round(size*0.55)}px;flex-shrink:0`;
  if (s.includes('airbnb'))  return `<div style="${style};background:#FF5A5F">🏠</div>`;
  if (s.includes('vrbo') || s.includes('homeaway')) return `<div style="${style};background:#3D5A99">🏡</div>`;
  if (s.includes('booking')) return `<div style="${style};background:#003580">🔵</div>`;
  if (s.includes('direct') || s.includes('owner')) return `<div style="${style};background:#4A7C59">👤</div>`;
  return `<div style="${style};background:#8B9467">🏠</div>`;
}

/**
 * reloadInMemoryData — refresh all in-memory arrays from localStorage.
 * Must be called after hydrateFromCloud() writes cloud data into localStorage,
 * otherwise renderAll() sees the stale (empty) arrays from script parse time.
 */
function reloadInMemoryData() {
  if (typeof isPortfolioMode === 'function' && isPortfolioMode()) {
    return;
  }
  console.log('[StayOps] reloadInMemoryData: refreshing in-memory arrays from localStorage');
  reloadArraysFromLocalStorage();
  // Keep clean records in sync with current booking identity data
  normalizeBookingCleanState();
}


function _hasOpenModal() {
  const modal = document.getElementById('modal');
  const detail = document.getElementById('detail-modal');
  const isOpen = (el) => !!(el && el.style && el.style.display !== 'none' && el.style.display !== '');
  return isOpen(modal) || isOpen(detail);
}

function _isUserEditingField() {
  const el = document.activeElement;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = String(el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

let _pendingUiRefresh = false;

function _refreshAfterDataChange(manual) {
  if (!manual && (_hasOpenModal() || _isUserEditingField())) {
    _pendingUiRefresh = true;
    return;
  }
  _pendingUiRefresh = false;
  renderAll();
}

function _flushPendingUiRefresh() {
  if (!_pendingUiRefresh) return;
  if (_hasOpenModal() || _isUserEditingField()) return;
  _pendingUiRefresh = false;
  render();
}


function renderSetupWarningBanner() {
  const wrap = document.getElementById('setup-warning-banner');
  const titleEl = document.getElementById('setup-warning-title');
  const bodyEl = document.getElementById('setup-warning-body');
  if (!wrap || !titleEl || !bodyEl) return;

  if (typeof isCleanerMode === 'function' && isCleanerMode()) {
    wrap.style.display = 'none';
    return;
  }

  const gaps = (typeof getPropertyConfigGaps === 'function') ? getPropertyConfigGaps() : [];
  if (!gaps.length) {
    wrap.style.display = 'none';
    bodyEl.innerHTML = '';
    return;
  }

  const critical = gaps.filter(g => g.severity === 'critical');
  const heading = critical.length
    ? '⚠️ Setup Required'
    : 'ℹ️ Setup Recommendation';
  titleEl.textContent = heading;

  wrap.style.borderColor = critical.length ? '#F0AA4A' : '#E8D39B';
  wrap.style.background = critical.length ? '#FFF8E8' : '#FFFDF4';

  bodyEl.innerHTML = `
    <div style="margin-bottom:6px">
      Missing for <strong>${escHtml(getCurrentPropertyName())}</strong>:
    </div>
    <ul style="margin:0;padding-left:16px">
      ${gaps.map(g => `<li style="margin:0 0 3px 0"><strong>${escHtml(g.label)}</strong> — ${escHtml(g.detail)}</li>`).join('')}
    </ul>
    <div style="margin-top:8px">Fix in <strong>Settings → Property → Property Configuration</strong>.</div>
  `;

  wrap.style.display = 'block';
}

// ── NAV ───────────────────────────────────────────────────────────────────
let currentSection = 'today';
globalThis.getCurrentSection = () => currentSection;

function showSection(name) {
  if (name === 'dashboard') name = 'today';
  if (name === 'revenue' || name === 'management') name = 'finance';
  currentSection = name;
  document.querySelectorAll('[id^="section-"]').forEach(el => el.classList.add('section-hidden'));
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
  const sec = document.getElementById('section-' + name);
  if (sec) sec.classList.remove('section-hidden');
  const nav = document.getElementById('nav-' + name);
  if (nav) nav.classList.add('active');
  // FAB only on Today tab
  const fab = document.querySelector('.fab');
  if (fab) fab.style.display = name === 'today' ? 'flex' : 'none';
  // Only render what's needed for this section
  if (name === 'today') {
    renderDashboard();
  } else if (name === 'bookings') {
    document.querySelectorAll('#section-bookings .tab-row .tab').forEach(t => t.classList.remove('active'));
    const activeTab = document.querySelector(`#section-bookings .tab-row .tab[onclick*="${bookingFilter}"]`);
    if (activeTab) activeTab.classList.add('active');
    renderBookings();
    renderNotes();
    populateSelects();
  } else if (name === 'cleaning') {
    renderCleaning();
    populateSelects();
  } else if (name === 'finance') {
    renderFinance();
  } else if (name === 'notes') {
    showSection('bookings');
    return;
  } else if (name === 'property') {
    backToPropertyHub();
  } else if (name === 'settings') {
    // Show settings main menu, hide any open cats/panels
    _resetSettingsToMenu();
    renderSettings();
    renderConnectionSummary();
  }
  setTimeout(_flushPendingUiRefresh, 0);
}

function jumpToCleaningActionNeeded() {
  showSection('cleaning');
  setCleanStatusFilter('all');
  switchCleanView('pipeline');
}

function jumpToScheduleClean() {
  showSection('cleaning');
  setCleanStatusFilter('all');
  switchCleanView('timeline');
  setTimeout(() => {
    const card = document.getElementById('clean-add-card');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 80);
}

// ── RENDER ────────────────────────────────────────────────────────────────
function render() {
  // Always update the date badge and shared state
  renderHeaderDateBadge()
  // Set FAB visibility based on current section
  const fab = document.querySelector('.fab');
  const section = currentSection || 'today';
  if (fab) fab.style.display = section === 'today' ? 'flex' : 'none';
  if (section === 'today')        { renderDashboard(); return; }
  if (section === 'bookings')     { renderBookings(); renderNotes(); return; }
  if (section === 'cleaning')     { renderCleaning(); populateSelects(); return; }
  if (section === 'finance')      { renderFinance(); return; }
  if (section === 'notes')        { renderNotes(); populateSelects(); return; }
  if (section === 'property')     { renderProperty(); return; }
  if (section === 'settings')     { renderSettings(); renderConnectionSummary(); return; }
  renderDashboard(); // fallback
}

// Full render — used after major data changes like sheet sync
function renderAll() {
  // Portfolio-specific tab UI: use typeof isPortfolioMode === 'function' && isPortfolioMode() (Cards 2–6).
  if (isCleanerMode()) {
    renderCleanerView();
    return;
  }
  renderHeaderDateBadge()
  renderDashboard();
  renderBookings(); // always refresh booking list after sync
  populateSelects();
  populateExpenseCatSelect();
  const expDate = document.getElementById('exp-date');
  if (expDate && !expDate.value) expDate.value = new Date().toISOString().split('T')[0];
  const maintDate = document.getElementById('maint-date');
  if (maintDate && !maintDate.value) maintDate.value = new Date().toISOString().split('T')[0];
  // Also render whatever section is active
  const section = currentSection || 'today';
  if (section === 'cleaning')   { renderCleaning(); populateCleanerSelect(); }
  if (section === 'finance')    renderFinance();
  if (section === 'notes')      renderNotes();
  if (section === 'property')   renderProperty();
  if (section === 'settings')   { renderSettings(); renderConnectionSummary(); }
  setTimeout(() => { attachButtonPress(); attachLongPress(); }, 50);
}

function renderDashboard() {
  if (isPortfolioMode()) {
    renderPortfolioDashboard();
    return;
  }
  const singleDash = document.getElementById('dashboard-content');
  const portfolioDash = document.getElementById('portfolio-dashboard');
  if (singleDash) singleDash.style.display = '';
  if (portfolioDash) portfolioDash.style.display = 'none';

  const backLink = document.getElementById('back-to-portfolio-link');
  if (backLink) {
    const hasMultiple = typeof getAllProperties === 'function' && getAllProperties().length > 1;
    if (hasMultiple && !isPortfolioMode()) {
      backLink.style.display = '';
      backLink.onclick = () => {
        sessionStorage.setItem('stayops-portfolio-mode', 'true');
        if (typeof enterPortfolioMode === 'function') enterPortfolioMode();
      };
    } else {
      backLink.style.display = 'none';
    }
  }

  const statBookings = document.getElementById('stat-bookings');
  if (statBookings) statBookings.textContent = bookings.filter(b => b.status !== 'cancelled').length;
  renderCalendar();
  updateCalStats();

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(todayStart);
  const dayOfWeek = (weekStart.getDay() + 6) % 7; // Monday=0
  weekStart.setDate(weekStart.getDate() - dayOfWeek);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const next7 = new Date(todayStart); next7.setDate(next7.getDate() + 7);
  const next30 = new Date(todayStart); next30.setDate(next30.getDate() + 30);
  const safeNum = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  const safeDayLabel = (dateKey) => {
    const key = String(dateKey || '').slice(0, 10);
    if (!key) return '—';
    const d = parseLocalDayStart(key);
    return Number.isNaN(d.getTime()) ? key : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  };

  const activeBookings = bookings.filter(b => b.status !== 'cancelled');
  const upcomingBookings = activeBookings.filter(b => parseLocalDayStart(b.checkin) >= todayStart);
  const upcomingBookings7 = upcomingBookings.filter(b => parseLocalDayStart(b.checkin) < next7);
  const upcomingBookings30 = upcomingBookings.filter(b => parseLocalDayStart(b.checkin) < next30);
  const upcomingRevenue7 = upcomingBookings7.reduce((sum, b) => sum + safeNum(b.hostPayout), 0);
  const upcomingRevenue30 = upcomingBookings30.reduce((sum, b) => sum + safeNum(b.hostPayout), 0);
  const upcomingPayoutEstimate = upcomingBookings.reduce((sum, b) => sum + safeNum(b.netPayout), 0);
  const hostPayoutCoverage7 = upcomingBookings7.filter(b => Number.isFinite(Number(b.hostPayout))).length;
  const hostPayoutCoverage30 = upcomingBookings30.filter(b => Number.isFinite(Number(b.hostPayout))).length;
  const netPayoutCoverage = upcomingBookings.filter(b => Number.isFinite(Number(b.netPayout))).length;

  const checkinsThisWeek = activeBookings.filter(b => {
    const ci = new Date(b.checkin);
    return ci >= weekStart && ci < weekEnd;
  });
  const checkoutsThisWeek = activeBookings.filter(b => {
    const co = new Date(b.checkout);
    return co >= weekStart && co < weekEnd;
  });

  const upcomingCleans = cleans.filter(c => !c.done && !c.cleanerDeclined && c.date && parseLocalDayStart(c.date) >= todayStart);
  const cleansThisWeek = upcomingCleans.filter(c => {
    const d = new Date(c.date);
    return d >= weekStart && d < weekEnd;
  });

  const bookedNightsNext30 = activeBookings.reduce((sum, b) => {
    const start = new Date(Math.max(new Date(b.checkin).getTime(), todayStart.getTime()));
    const end = new Date(Math.min(new Date(b.checkout).getTime(), next30.getTime()));
    if (end <= start) return sum;
    return sum + Math.ceil((end - start) / 86400000);
  }, 0);

  // ── Monthly occupancy: booked nights in the current calendar month ────────
  const thisMonth      = now.getMonth();
  const thisYear       = now.getFullYear();
  const daysThisMonth  = new Date(thisYear, thisMonth + 1, 0).getDate();
  const monthStart     = new Date(thisYear, thisMonth, 1);
  const monthEnd       = new Date(thisYear, thisMonth + 1, 1);
  let bookedNightsMonth = 0;
  activeBookings.forEach(b => {
    if (!b.checkin || !b.checkout) return;
    const ci = new Date(Math.max(new Date(b.checkin).getTime(), monthStart.getTime()));
    const co = new Date(Math.min(new Date(b.checkout).getTime(), monthEnd.getTime()));
    if (co > ci) bookedNightsMonth += Math.round((co - ci) / 86400000);
  });
  const occupancyThisMonth = Math.max(0, Math.min(100, Math.round((bookedNightsMonth / daysThisMonth) * 100)));

  const dayLoad = {};
  activeBookings.forEach(b => {
    const ci = new Date(b.checkin);
    const co = new Date(b.checkout);
    if (ci >= weekStart && ci < weekEnd) {
      const ciKey = String(b.checkin || '').slice(0, 10);
      if (ciKey) dayLoad[ciKey] = (dayLoad[ciKey] || 0) + 1;
    }
    if (co >= weekStart && co < weekEnd) {
      const coKey = String(b.checkout || '').slice(0, 10);
      if (coKey) dayLoad[coKey] = (dayLoad[coKey] || 0) + 1;
    }
  });
  cleansThisWeek.forEach(c => {
    const key = String(c.date || '').slice(0, 10);
    if (key) dayLoad[key] = (dayLoad[key] || 0) + 1;
  });
  const busyDays = Object.entries(dayLoad)
    .filter(([, count]) => count >= 3)
    .sort((a, b) => a[0].localeCompare(b[0]));
  const multiCleans = Object.entries(cleansThisWeek.reduce((acc, c) => {
    const key = String(c.date || '').slice(0, 10);
    if (key) acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {})).filter(([, count]) => count > 1);

  const insightsEl = document.getElementById('dashboard-insights-content');
  if (insightsEl) {
    // Forward-looking revenue: lead with the 30-day figure, support with 7-day
    const rev30Str = `$${Math.round(upcomingRevenue30).toLocaleString()}`;
    const rev7Str  = `$${Math.round(upcomingRevenue7).toLocaleString()}`;
    const payoutStr = `$${Math.round(upcomingPayoutEstimate).toLocaleString()}`;
    const coverageNote = (!upcomingBookings7.length && !upcomingBookings30.length)
      ? 'No upcoming bookings in the next 30 days'
      : (hostPayoutCoverage7 < upcomingBookings7.length || hostPayoutCoverage30 < upcomingBookings30.length)
      ? `Partial data (${hostPayoutCoverage30}/${upcomingBookings30.length} bookings have payout figures)`
      : '';
    insightsEl.innerHTML = `
      <div style="font-size:22px;font-weight:700;color:var(--forest);letter-spacing:-0.3px;line-height:1">${rev30Str}</div>
      <div style="font-size:12px;color:var(--text-soft);margin-top:4px;line-height:1.4">Expected payout · next 30 days</div>
      <div style="margin-top:12px;display:flex;flex-direction:column;gap:6px">
        <div style="font-size:12px;color:var(--text-soft);line-height:1.4">Next 7 days <strong style="color:var(--forest)">${rev7Str}</strong> &nbsp;·&nbsp; Est. total payout <strong style="color:var(--forest)">${payoutStr}</strong></div>
        <div style="font-size:12px;color:var(--text-soft);line-height:1.4">${upcomingBookings.length} upcoming booking${upcomingBookings.length!==1?'s':''} &nbsp;·&nbsp; ${upcomingCleans.length} clean${upcomingCleans.length!==1?'s':''} scheduled</div>
        <div style="font-size:12px;color:var(--text-soft);line-height:1.4">Monthly Occ. <strong style="color:var(--forest)">${occupancyThisMonth}%</strong> &nbsp;(${now.toLocaleString('en-AU', {month:'long'})} ${thisYear})</div>
      </div>
      ${coverageNote ? `<div style="margin-top:8px;font-size:11px;color:var(--stone);line-height:1.4">${coverageNote}</div>` : ''}`;
  }

  // ── Cleaner Actions — highest-priority alert, rendered before calendar ────
  const cleanerAlertEl = document.getElementById('dashboard-cleaner-alert');
  if (cleanerAlertEl) cleanerAlertEl.innerHTML = '';

  const weekEl = document.getElementById('dashboard-week-content');
  if (weekEl) {
    const busyText = busyDays.length
      ? busyDays.slice(0, 2).map(([d, c]) => `${safeDayLabel(d)} (${c})`).join(', ')
      : null;
    const multiCleansText = multiCleans.length
      ? multiCleans.map(([d, c]) => `${safeDayLabel(d)} (${c} cleans)`).join(', ')
      : null;
    // Pill-style counts: compact, inline, lighter weight than the stats row
    const pill = (n, label) =>
      `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--mist);border-radius:20px;padding:4px 10px;font-size:12px;font-weight:600;color:var(--forest)">${n} <span style="font-weight:400;color:var(--text-soft)">${label}</span></span>`;
    weekEl.innerHTML = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        ${pill(checkinsThisWeek.length, 'arrival' + (checkinsThisWeek.length !== 1 ? 's' : ''))}
        ${pill(checkoutsThisWeek.length, 'departure' + (checkoutsThisWeek.length !== 1 ? 's' : ''))}
        ${pill(cleansThisWeek.length, 'clean' + (cleansThisWeek.length !== 1 ? 's' : ''))}
      </div>
      ${busyText ? `<div style="font-size:12px;color:var(--text-soft);margin-bottom:3px">⚡ Busy: ${busyText}</div>` : ''}
      ${multiCleansText ? `<div style="font-size:12px;color:var(--text-soft)">🧹 Stacked cleans: ${multiCleansText}</div>` : ''}
      ${!busyText && !multiCleansText ? `<div style="font-size:12px;color:var(--text-soft)">Week looks well balanced</div>` : ''}`;
  }

  const usageSnapshot = getUsageSnapshotLite();
  const planState = getPlanStateLite();
  renderOnboardingGuidance(usageSnapshot);
  renderPlanNudges(usageSnapshot, planState);

  // ── Next Check-in card — tappable shortcut to booking detail ─────────────
  const upcoming = [...bookings]
    .filter(b => b.status !== 'cancelled' && b.checkin && parseLocalDayStart(b.checkin) >= todayStart)
    .sort((a, b) => parseLocalDayStart(a.checkin) - parseLocalDayStart(b.checkin));
  const nc = document.getElementById('next-checkin-content');
  if (nc) {
    if (upcoming.length > 0) {
      const b = upcoming[0];
      const ciDays = Math.ceil((parseLocalDayStart(b.checkin) - todayStart) / 86400000);
      const ciPill = ciDays <= 0 ? 'Today' : ciDays === 1 ? 'Tomorrow' : `In ${ciDays}d`;
      const ciPillColor = ciDays <= 2 ? 'background:#fef3e2;color:#854f0b' : 'background:#e8f4ed;color:#1a4f3a';
      nc.innerHTML = `<div onclick="showDetail('${escapeJsSingleQuotedHtmlAttr(String(b._cloudId || b.id))}')" style="cursor:pointer">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-soft)">Next check-in</div>
          <span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;${ciPillColor}">${ciPill}</span>
        </div>
        <div style="font-size:17px;font-weight:600;color:var(--text);margin-bottom:8px">${escHtml(b.name)}</div>
        <div style="display:flex;gap:16px">
          <div style="display:flex;flex-direction:column">
            <span style="font-size:15px;font-weight:600;color:var(--text)">${fmt(b.checkin)}</span>
            <span style="font-size:11px;color:var(--text-soft);text-transform:uppercase;letter-spacing:0.4px">Arrives</span>
          </div>
          <div style="display:flex;flex-direction:column">
            <span style="font-size:15px;font-weight:600;color:var(--text)">${b.nights}</span>
            <span style="font-size:11px;color:var(--text-soft);text-transform:uppercase;letter-spacing:0.4px">Night${b.nights!==1?'s':''}</span>
          </div>
          <div style="display:flex;flex-direction:column">
            <span style="font-size:15px;font-weight:600;color:var(--text)">${b.guests}</span>
            <span style="font-size:11px;color:var(--text-soft);text-transform:uppercase;letter-spacing:0.4px">Guests</span>
          </div>
        </div>
      </div>`;
    } else {
      nc.innerHTML = '<div style="color:var(--text-soft);font-size:13px;">No upcoming bookings</div>';
    }
  }

  const localNow = new Date();
  const todayStr = localNow.getFullYear() + '-' + String(localNow.getMonth()+1).padStart(2,'0') + '-' + String(localNow.getDate()).padStart(2,'0');

  // ── Next Clean card — carry bookingId so the row can open booking detail ──
  const fromCleans = cleans
    .filter(c => !c.done && c.date && c.date >= todayStr)
    .map(c => ({
      date: c.date,
      name: c.cleaner,
      sub: 'After ' + (c.guestName || ''),
      bookingId: c.bookingId || null
    }));
  const fromBookings = bookings
    .filter(b => b.checkout && b.checkout >= todayStr)
    .map(b => ({ booking: b, state: getBookingCleanerState(b) }))
    .filter(({ state }) => state.key === 'confirmed' || state.key === 'done')
    .filter(({ state }) => !state.clean || !!state.clean.done)
    .map(({ booking, state }) => {
      const cl = state.clean;
      return {
        date: cl ? cl.date : booking.checkout,
        name: cl ? cl.cleaner : '—',
        sub: 'After ' + booking.name,
        bookingId: booking._cloudId || booking.id
      };
    });
  const allNextCleans = [...fromCleans, ...fromBookings]
    .filter((v, i, a) => a.findIndex(x => x.sub === v.sub) === i) // dedupe by guest
    .sort((a, b) => a.date.localeCompare(b.date));

  const ncc = document.getElementById('next-clean-content');

  // ── Alerts: low stock + open maintenance (passive alerts, below calendar) ─
  const alertsEl = document.getElementById('dashboard-alerts');
  const lowStock = inventory.filter(i => i.stock <= i.threshold);
  const openIssues = maintenance.filter(m => m.status === 'open' || m.status === 'inprogress');
  // Match the Cleaning tab's totalActionCount: awaiting responses + unassigned/declined
  const awaitingResponses = cleans.filter(c => isAwaitingCleanerResponse(c, localNow) && !isCleanLinkedToCancelledBooking(c));
  const unassignedOrDeclined = bookings.filter(b => {
    if (b.status === 'cancelled' || new Date(b.checkout) < localNow) return false;
    const st = getBookingCleanerState(b).key;
    return st === 'unassigned' || st === 'declined';
  });
  const totalCleanerActions = awaitingResponses.length + unassignedOrDeclined.length;

  // Cleaner alert: own element, before calendar, hidden when zero
  if (cleanerAlertEl) {
    cleanerAlertEl.innerHTML = totalCleanerActions > 0
      ? `<div class="card" style="border-left:3px solid var(--amber);padding:10px 14px;cursor:pointer" onclick="jumpToCleaningActionNeeded()">
          <div style="font-weight:600;font-size:13px;margin-bottom:4px">⏳ Cleaner Actions Needed (${totalCleanerActions})</div>
          <div style="font-size:12px;color:var(--text-soft)">Tap to open Action tab</div>
        </div>`
      : '';
  }

  let alertsHtml = '';
  if (lowStock.length) alertsHtml += `<div class="card" style="border-left:3px solid var(--amber);padding:10px 14px">
    <div style="font-weight:600;font-size:13px;margin-bottom:6px">📦 Low Stock (${lowStock.length})</div>
    ${lowStock.map(i=>`<div style="font-size:12px;color:var(--text-soft);margin-bottom:2px">⚠ ${i.name} — ${i.stock} ${i.unit||''} left</div>`).join('')}
  </div>`;
  if (openIssues.length) alertsHtml += `<div class="card" style="border-left:3px solid var(--red);padding:10px 14px">
    <div style="font-weight:600;font-size:13px;margin-bottom:6px">🔧 Open Issues (${openIssues.length})</div>
    ${openIssues.map(m=>`<div style="font-size:12px;color:var(--text-soft);margin-bottom:2px">${m.status==='inprogress'?'🔄':'🔴'} ${m.description}</div>`).join('')}
  </div>`;
  if (alertsEl) alertsEl.innerHTML = alertsHtml;

  // ── Next Clean render — tappable shortcut to booking detail if available ──
  if (ncc && allNextCleans.length > 0) {
    const c = allNextCleans[0];
    const days = Math.ceil((new Date(c.date) - localNow) / 86400000);
    const urgClass = days <= 0 ? 'urgent' : days <= 1 ? 'urgent' : days <= 3 ? 'soon' : 'ok';
    const urgText = days <= 0 ? 'Today!' : days === 1 ? 'Tomorrow' : `In ${days} days`;
    // Resolve booking ID: prefer explicit bookingId, fall back to name match
    const linkedBookingId = c.bookingId ||
      (bookings.find(bk => bk.name && c.sub && c.sub.includes(bk.name))
        ? (bk => bk._cloudId || bk.id)(bookings.find(bk => bk.name && c.sub && c.sub.includes(bk.name)))
        : null);
    const clickAttr = linkedBookingId
      ? `onclick="showDetail('${escapeJsSingleQuotedHtmlAttr(String(linkedBookingId))}')" style="cursor:pointer"`
      : `onclick="jumpToCleaningActionNeeded()" style="cursor:pointer"`;
    const csState = linkedBookingId
      ? getBookingCleanerState(bookings.find(bk => (bk._cloudId || String(bk.id)) === String(linkedBookingId)) || {})
      : { key: 'pending', tone: 'warn' };
    // Override: if the allNextCleans entry came from the raw cleans array,
    // read confirmed/declined directly from it rather than via booking lookup.
    const rawClean = c.bookingId
      ? cleans.find(cl => String(cl.bookingId) === String(c.bookingId) && cl.date === c.date)
      : null;
    const effectiveKey = rawClean
      ? (rawClean.done ? 'done' : rawClean.cleanerDeclined ? 'declined' : rawClean.cleanerConfirmed ? 'confirmed' : 'pending')
      : csState.key;
    const effectiveCleanId = rawClean ? rawClean.id : (csState.clean ? csState.clean.id : null);
    const csPillStyle = effectiveKey === 'done' || effectiveKey === 'confirmed'
      ? 'background:#e8f4ed;color:#1a4f3a'
      : effectiveKey === 'declined'
      ? 'background:#fef0f0;color:#993c1d'
      : 'background:#fef3e2;color:#854f0b';
    const csLabel = effectiveKey === 'done' ? '✓ Done'
      : effectiveKey === 'confirmed' ? '✓ Confirmed'
      : effectiveKey === 'declined' ? '✕ Declined'
      : 'Awaiting reply';
    const cleanId = effectiveCleanId;
    const initials = c.name && c.name !== '—'
      ? c.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()
      : '?';
    ncc.innerHTML = `<div style="padding:14px 16px">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-soft);margin-bottom:10px">Next clean</div>
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:34px;height:34px;border-radius:50%;background:#e8f4ed;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#1a4f3a;flex-shrink:0">${initials}</div>
          <div>
            <div style="font-size:15px;font-weight:600;color:var(--text)">${escHtml(c.name)}</div>
            <div style="font-size:12px;color:var(--text-soft)">${fmt(c.date)} · after checkout</div>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
          <span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;${csPillStyle}">${csLabel}</span>
          ${cleanId ? `<button onclick="event.stopPropagation();openNotifyModal('${cleanId}')" style="-webkit-tap-highlight-color:transparent;background:#1a4f3a;color:#fff;border:none;border-radius:8px;padding:5px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">SMS</button>` : ''}
        </div>
      </div>
    </div>`;
  } else if (ncc) {
    ncc.innerHTML = '<div style="color:var(--text-soft);font-size:13px;">No cleans scheduled</div>';
  }
}

function applyStayopsPostSwitchAction() {
  const postAction = sessionStorage.getItem('stayops-post-switch-action');
  if (!postAction) return;
  sessionStorage.removeItem('stayops-post-switch-action');
  if (postAction.startsWith('assign-clean-')) {
    const targetBookingId = postAction.replace('assign-clean-', '');
    showSection('cleaning');
    setTimeout(() => {
      populateSelects();
      const select = document.getElementById('clean-booking-select');
      if (select) {
        select.value = targetBookingId;
        select.dispatchEvent(new Event('change'));
      }
      const addCard = document.getElementById('clean-add-card');
      if (addCard) addCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 300);
    return;
  }
  if (postAction === 'cleaning-action') {
    showSection('cleaning');
    setCleanStatusFilter('all');
    switchCleanView('pipeline');
  }
}




// ── MODALS ────────────────────────────────────────────────────────────────
function openModal(){ document.getElementById('modal').classList.add('open'); document.body.style.overflow='hidden'; }
function closeModal(){ document.getElementById('modal').classList.remove('open'); _checkModalsClosed(); }
function closeDetailModal(){ document.getElementById('detail-modal').classList.remove('open'); _checkModalsClosed(); }
function _checkModalsClosed(){
  const anyOpen = !!document.querySelector('.modal-overlay.open');
  if (!anyOpen) document.body.style.overflow = '';
}

function openQuickAddMenu() {
  document.getElementById('quick-add-overlay').classList.add('open');
  document.getElementById('quick-add-fab').classList.add('qa-open');
}

function closeQuickAddMenu() {
  document.getElementById('quick-add-overlay').classList.remove('open');
  document.getElementById('quick-add-fab').classList.remove('qa-open');
}

async function runFullRefresh() {
  const btn = document.getElementById('header-refresh-btn');
  if (btn) { btn.disabled = true; btn.textContent = '↻ Syncing…'; }

  let cloudOk = false;
  let errors = [];

  try {
    // Step 1: Pull from Supabase (primary source)
    if (typeof globalThis.hydrateFromCloud === 'function') {
      try {
        await globalThis.hydrateFromCloud();
        cloudOk = true;
      } catch (e) {
        console.warn('[Refresh] hydrateFromCloud failed:', e);
        errors.push('cloud sync');
      }
    }

    // Reload in-memory data from localStorage then re-render
    reloadInMemoryData();
    renderAll();

    if (errors.length) {
      showBanner('↻ Refreshed (some sources unavailable)', 'warn');
    } else {
      showBanner('✓ All data refreshed', 'ok');
    }
  } catch (e) {
    console.error('[Refresh] Unexpected error:', e);
    // Still reload from localStorage so UI is not stale
    reloadInMemoryData();
    renderAll();
    showBanner('⚠ Refresh failed — showing cached data', 'warn');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '↻ Refresh'; }
  }
}

function renderHeaderDateBadge() {
  const todayBadge = document.getElementById('todayBadge');
  if (todayBadge) {
    todayBadge.textContent = new Date().toLocaleDateString('en-AU', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    });
  }
}

async function ensureHostIdentityAndRestore() {
  if (isCleanerMode()) return;
  let host = getHostProfile();

  // One-time migration: push inv-* localStorage to host_config in Supabase.
  // Owner fields (owner_name, owner_email) are NOT used here.
  // Host and owner are distinct identities in StayOps.
  const migrationKey = 'gh-host-migrated-v2';
  if (!localStorage.getItem(migrationKey) && typeof globalThis.saveHostConfigToSupabase === 'function') {
    const ls = k => localStorage.getItem(lsKey(k)) || '';
    const invName = ls('inv-name');
    if (invName) {
      const hostId = 'host-' + invName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) + '-' + Date.now().toString().slice(-6);
      const migrated = {
        hostId,
        name:    invName,
        company: ls('inv-company'),
        abn:     ls('inv-abn'),
        acn:     ls('inv-acn'),
        email:   ls('inv-email'),
        address: ls('inv-address'),
        createdAt: new Date().toISOString(),
      };
      saveHostProfile(migrated);
      globalThis.saveHostConfigToSupabase(migrated).then(() => {
        localStorage.setItem(migrationKey, '1');
        console.log('[StayOps] Host identity migrated to Supabase');
      }).catch(e => console.warn('[StayOps] Host migration failed', e));
      host = migrated;
    } else {
      localStorage.setItem(migrationKey, '1');
    }
  }

  // Restore host profile from Supabase if localStorage is empty (private mode / new device).
  if (!host && typeof globalThis.loadHostConfigFromSupabase === 'function') {
    try {
      const cloudHost = await globalThis.loadHostConfigFromSupabase();
      if (cloudHost && cloudHost.hostId) {
        saveHostProfile(cloudHost);
        host = cloudHost;
        console.log('[StayOps] Restored host profile from Supabase (private mode / new device)');
      }
    } catch (e) {
      console.warn('[StayOps] Cloud host profile restore failed', e);
    }
  }

  // Beginner-friendly prompt once, non-blocking if skipped.
  if (!host) {
    const entered = await showAppModal({
      title: 'Welcome',
      msg: "What should we call you? We'll use this to restore your non-sensitive settings on this device.",
      confirmText: 'Continue',
      cancelText: 'Skip',
      hasInput: true,
      inputPlaceholder: 'Your name',
      inputType: 'text'
    });
    if (entered && String(entered).trim()) {
      const name = String(entered).trim();
      const hostId = ('host-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) + '-' + Date.now().toString().slice(-6)).slice(0, 48);
      host = { hostId, name, email: '', createdAt: new Date().toISOString() };
      saveHostProfile(host);
      if (typeof globalThis.saveHostConfigToSupabase === 'function') {
        globalThis.saveHostConfigToSupabase(host).catch(e => console.warn('[StayOps] host config sync failed', e));
      }
      showBanner('Host profile created', 'ok');
    }
  }

  renderHostProfileRow();
}




// ── MAINTENANCE ───────────────────────────────────────────────────────────
function renderMaintenance() {
  const el = document.getElementById('maintenance-list');
  if (!maintenance.length) { el.innerHTML = '<div style="padding:12px 0;color:var(--text-soft);font-size:13px">No issues logged</div>'; return; }
  const order = {open:0,inprogress:1,resolved:2};
  const sorted = [...maintenance].sort((a,b) => (order[a.status]||0)-(order[b.status]||0));
  el.innerHTML = sorted.map(m => `
    <div class="maint-item">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div style="flex:1">
          <span class="maint-status-badge maint-${m.status}">${m.status==='open'?'🔴 Open':m.status==='inprogress'?'🔄 In Progress':'✅ Resolved'}</span>
          <div style="font-weight:600;font-size:14px;margin-top:4px">${m.description}</div>
          ${m.contractor?`<div style="font-size:12px;color:var(--text-soft);margin-top:2px">👤 ${m.contractor}</div>`:''}
          <div style="font-size:12px;color:var(--text-soft);margin-top:1px">${fmt(m.date)}${m.cost?` · $${Number(m.cost).toFixed(2)}`:''}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;flex-shrink:0">
          <button onclick="deleteMaintenance(${m.id})" style="font-size:10px;color:var(--text-soft);background:none;border:none;cursor:pointer">✕</button>
          ${m.status !== 'resolved' ? `
          <button onclick="resolveIssue(${m.id})" style="font-size:11px;background:var(--moss);color:white;border:none;border-radius:8px;padding:5px 10px;cursor:pointer;font-family:'DM Sans',sans-serif">Mark Resolved</button>
          <button onclick="setMaintInProgress(${m.id})" style="font-size:11px;background:var(--forest-light);color:var(--sage);border:none;border-radius:8px;padding:5px 10px;cursor:pointer;font-family:'DM Sans',sans-serif">In Progress</button>
          ` : ''}
        </div>
      </div>
    </div>`).join('');
}

function addMaintenance() {
  const desc = document.getElementById('maint-desc').value.trim();
  const date = document.getElementById('maint-date').value;
  if (!desc || !date) { showBanner('⚠ Please fill in description and date','warn'); return; }
  const contractorSel = document.getElementById('maint-contractor-select');
  maintenance.push({
    id: Date.now(),
    description: desc,
    status: 'open',
    cost: 0,
    contractor: contractorSel ? contractorSel.value : '',
    date
  });
  savePropertyData();
  document.getElementById('maint-desc').value = '';
  renderMaintenance();
  showBanner('✓ Issue logged', 'ok');
}

function setMaintInProgress(id) {
  const m = maintenance.find(m => m.id === id);
  if (m) { m.status = 'inprogress'; savePropertyData(); renderMaintenance(); }
}

async function resolveIssue(id) {
  const m = maintenance.find(m => m.id === id);
  if (!m) return;
  const costStr = await showAppModal({
    title: '✓ Mark Resolved',
    msg: `"${m.description}" — enter cost (leave blank if $0)`,
    confirmText: 'Resolve',
    hasInput: true,
    inputPlaceholder: '0.00',
    inputType: 'number'
  });
  if (costStr === null) return;
  const cost = parseFloat(costStr) || 0;
  m.status = 'resolved';
  m.cost = cost;
  savePropertyData();
  // Auto-create expense entry
  if (cost > 0) {
    const exp = {
      id: Date.now(),
      merchant: m.contractor || 'Contractor',
      description: m.description,
      amount: cost,
      date: new Date().toISOString().split('T')[0],
      category: 'Cleaning & Maintenance',
      receiptType: 'missing',
      receiptNum: '',
      awaitingReceipt: true,
      driveLink: null,
      photo: null
    };
    expenses.push(exp);
    savePropertyData();
    saveExpenseToDriveAndSheet(exp);
    showBanner('✓ Resolved · $' + cost.toFixed(2) + ' added to Expenses (awaiting receipt)', 'ok');
  } else {
    showBanner('✓ Issue resolved', 'ok');
  }
  renderMaintenance();
}

async function deleteMaintenance(id) {
  const _okIssue = await showAppModal({ title: 'Delete Issue', msg: 'Delete this maintenance issue?', confirmText: 'Delete', confirmColor: 'var(--red)' });
  if (!_okIssue) return;
  const removed = maintenance.find(m => m.id === id);
  replaceArrayInPlace(maintenance, maintenance.filter(m => m.id !== id));
  savePropertyData();
  renderMaintenance();
  if (removed && typeof globalThis.deleteMaintenanceFromCloud === 'function') globalThis.deleteMaintenanceFromCloud(removed).catch(() => {});
}

// ── INVENTORY ─────────────────────────────────────────────────────────────
let invView = 'all';
function setInvView(v, btn) {
  invView = v;
  document.querySelectorAll('#prop-inventory .tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  renderInventory();
}

function renderInventory() {
  const listEl = document.getElementById('inventory-list');
  const lowItems = inventory.filter(i => i.stock <= i.threshold);

  if (invView === 'low') {
    // Shopping list — name only, clean checklist feel
    if (!lowItems.length) {
      listEl.innerHTML = '<div class="card" style="text-align:center;color:var(--moss);padding:24px"><div style="font-size:28px;margin-bottom:6px">✅</div><div style="font-weight:600;font-size:15px">All stocked up!</div><div style="font-size:12px;color:var(--text-soft);margin-top:4px">Nothing needs reordering right now</div></div>';
      return;
    }
    listEl.innerHTML = `<div class="card" style="padding:0">
      <div style="padding:10px 16px 6px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-soft);border-bottom:1px solid var(--warm)">${lowItems.length} item${lowItems.length!==1?'s':''} to reorder</div>
      ` + lowItems.map(i => `
      <div onclick="restockItem(${i.id})" style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--warm);cursor:pointer;transition:background 0.15s" onmouseover="this.style.background='var(--mist)'" onmouseout="this.style.background=''">
        <div style="width:22px;height:22px;border-radius:5px;border:2px solid var(--stone);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:14px;color:var(--moss)">+</div>
        <div>
          <div style="font-weight:600;font-size:14px">${i.name}${i.unit?' <span style="font-size:12px;font-weight:400;color:var(--text-soft)">(${i.unit})</span>':''}</div>
          <div style="font-size:11px;color:var(--text-soft);margin-top:2px">Stock: ${i.stock} · Reorder below ${i.threshold}</div>
        </div>
      </div>`).join('') + `</div>`;
    return;
  }

  // All items view
  if (!inventory.length) { listEl.innerHTML = '<div style="color:var(--text-soft);font-size:13px;padding:8px 0">No items added yet</div>'; return; }
  listEl.innerHTML = `<div class="card" style="padding:0">` + inventory.map(i => {
    const isLow = i.stock <= i.threshold;
    return `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--warm);gap:8px">
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:14px;color:${isLow?'var(--red)':'var(--text)'}">${i.name}${isLow?' ⚠':''}</div>
        <div style="font-size:12px;color:var(--text-soft);margin-top:1px">Reorder below ${i.threshold}${i.unit?' '+i.unit:''}</div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
        <button onclick="adjustStock(${i.id},-1)" style="width:30px;height:30px;border-radius:50%;border:1px solid var(--stone);background:white;font-size:17px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;flex-shrink:0">−</button>
        <span style="font-weight:700;font-size:17px;min-width:26px;text-align:center;color:${isLow?'var(--red)':'var(--forest)'}">${i.stock}</span>
        <button onclick="adjustStock(${i.id},1)" style="width:30px;height:30px;border-radius:50%;border:none;background:var(--forest);color:white;font-size:17px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;flex-shrink:0">+</button>
        <button onclick="openInvEdit(${i.id})" style="width:30px;height:30px;border-radius:50%;border:1px solid var(--stone);background:white;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:var(--forest)">ℹ</button>
      </div>
    </div>`;
  }).join('') + `</div>`;
}

function addInventoryItem() {
  const name = document.getElementById('inv-item-name').value.trim();
  if (!name) { showBanner('⚠ Please enter an item name','warn'); return; }
  inventory.push({
    id: Date.now(),
    name,
    stock: parseInt(document.getElementById('inv-item-stock').value) || 0,
    threshold: parseInt(document.getElementById('inv-item-threshold').value) || 0,
    unit: document.getElementById('inv-item-unit').value.trim()
  });
  savePropertyData();
  ['inv-item-name','inv-item-stock','inv-item-threshold','inv-item-unit'].forEach(id => document.getElementById(id).value = '');
  renderInventory();
  showBanner('✓ Item added', 'ok');
}

function updateThreshold(id, val) {
  const item = inventory.find(i => i.id === id);
  if (item) { item.threshold = parseInt(val) || 0; savePropertyData(); renderInventory(); }
}

function adjustStock(id, delta) {
  const item = inventory.find(i => i.id === id);
  if (item) { item.stock = Math.max(0, item.stock + delta); savePropertyData(); renderInventory(); }
}

async function restockItem(id) {
  const item = inventory.find(i => String(i.id) === String(id));
  if (!item) return;
  const input = await showAppModal({
    title: '📦 Restock',
    msg: `How many ${item.unit || 'units'} of "${item.name}" did you buy? (Current: ${item.stock})`,
    confirmText: 'Add Stock',
    hasInput: true,
    inputPlaceholder: '0',
    inputType: 'number'
  });
  if (input === null) return;
  const bought = parseInt(input);
  if (isNaN(bought) || bought < 0) { showBanner('⚠ Please enter a valid number', 'warn'); return; }
  item.stock = item.stock + bought;
  savePropertyData();
  renderInventory();
  showBanner(`✓ ${item.name} updated — new stock: ${item.stock}${item.unit ? ' ' + item.unit : ''}`, 'ok');
}

async function deleteInventoryItem(id) {
  const ok = await showAppModal({ title: 'Remove Item', msg: 'Remove this item from inventory?', confirmText: 'Remove', confirmColor: 'var(--red)' });
  if (!ok) return;
  replaceArrayInPlace(inventory, inventory.filter(i => i.id !== id));
  savePropertyData();
  renderInventory();
}


// ── INVENTORY EDIT ────────────────────────────────────────────────────────────
let editingInvId = null;
function openInvEdit(id) {
  const i = inventory.find(i => i.id === id);
  if (!i) return;
  editingInvId = id;
  document.getElementById('ie-name').value = i.name || '';
  document.getElementById('ie-threshold').value = i.threshold ?? 0;
  document.getElementById('ie-unit').value = i.unit || '';
  document.getElementById('inv-edit-modal').classList.add('open'); document.body.style.overflow='hidden';
}
function closeInvEdit() {
  document.getElementById('inv-edit-modal').classList.remove('open'); _checkModalsClosed();
  editingInvId = null;
}
function saveInvEdit() {
  const i = inventory.find(i => i.id === editingInvId);
  if (!i) return;
  i.name = document.getElementById('ie-name').value.trim() || i.name;
  i.threshold = parseInt(document.getElementById('ie-threshold').value) || 0;
  i.unit = document.getElementById('ie-unit').value.trim();
  savePropertyData();
  closeInvEdit();
  renderInventory();
  showBanner('✓ Item updated', 'ok');
}
async function deleteInventoryItemFromEdit() {
  const _okInvEdit = await showAppModal({ title: 'Remove Item', msg: 'Remove this item from inventory?', confirmText: 'Remove', confirmColor: 'var(--red)' });
  if (!_okInvEdit) return;
  replaceArrayInPlace(inventory, inventory.filter(i => i.id !== editingInvId));
  savePropertyData();
  closeInvEdit();
  renderInventory();
}


function savePropertyData() {
  localStorage.setItem(lsKey('expenses'),    JSON.stringify(expenses));
  localStorage.setItem(lsKey('maintenance'), JSON.stringify(maintenance));
  localStorage.setItem(lsKey('inventory'),   JSON.stringify(inventory));
  // Sync to Supabase (non-blocking)
  if (typeof globalThis.saveInventoryToCloud === 'function') globalThis.saveInventoryToCloud(inventory).catch(() => {});
  if (typeof globalThis.saveMaintenanceToCloud === 'function') globalThis.saveMaintenanceToCloud(maintenance).catch(() => {});
}

// ── CUSTOM MODALS (replace blocked confirm/prompt) ───────────────────────────


async function reassignBookingProperty(gmailMessageId, newPropertyId) {
  if (!window._sb) return;
  const user = window._supabaseUser;
  if (!user) return;
  const { error } = await window._sb
    .from('bookings')
    .update({
      property_id: newPropertyId,
      property_unconfirmed: false,
      updated_at: new Date().toISOString(),
    })
    .eq('gmail_message_id', gmailMessageId)
    .eq('user_id', user.id);
  if (error) console.warn('[StayOps] reassignBookingProperty failed', error);
}

async function processScanNeedsReview(data) {
  if (!data || !data.needs_review || !data.needs_review.length || typeof getAllProperties !== 'function') return;
  const props = getAllProperties().map(p => ({
    id: (window._cloudPropertyIds && window._cloudPropertyIds[p.propertyId])
        || p.supabaseId || p.propertyId,
    name: p.name || p.propertyId,
    subtitle: [p.suburb, p.state].filter(Boolean).join(', '),
  }));
  if (props.length <= 1) return;
  for (const item of data.needs_review) {
    const pickedId = await showPropertyPicker({
      guest: item.guest,
      checkin: item.checkin,
      checkout: item.checkout,
      platform: item.platform,
      properties: props,
    });
    if (pickedId) await reassignBookingProperty(item.gmail_message_id, pickedId);
  }
  if (typeof globalThis.hydrateFromCloud === 'function') await globalThis.hydrateFromCloud();
  reloadInMemoryData();
  renderAll();
}

let _modalResolve = null;

function showAppModal({ title, msg, confirmText='Confirm', confirmColor='var(--forest)', cancelText='Cancel', hasInput=false, inputPlaceholder='', inputDefault='', inputType='number' }) {
  return new Promise(resolve => {
    _modalResolve = resolve;
    document.getElementById('app-modal-title').textContent = title;
    document.getElementById('app-modal-msg').textContent = msg;
    const inp = document.getElementById('app-modal-input');
    if (hasInput) {
      inp.style.display = 'block';
      inp.type = inputType;
      inp.placeholder = inputPlaceholder;
      inp.value = inputDefault;
      setTimeout(() => inp.focus(), 100);
    } else {
      inp.style.display = 'none';
    }
    document.getElementById('app-modal-confirm').textContent = confirmText;
    document.getElementById('app-modal-confirm').style.background = confirmColor;
    document.getElementById('app-modal-cancel').textContent = cancelText;
    const overlay = document.getElementById('app-modal-overlay');
    overlay.style.display = 'flex';
    overlay.style.opacity = '0';
    requestAnimationFrame(() => requestAnimationFrame(() => { overlay.style.opacity = '1'; }));
  });
}

function appModalConfirm() {
  const inp = document.getElementById('app-modal-input');
  const val = inp.style.display !== 'none' ? inp.value : true;
  const overlay = document.getElementById('app-modal-overlay');
  overlay.style.opacity = '0';
  setTimeout(() => { overlay.style.display = 'none'; }, 200);
  if (_modalResolve) { _modalResolve(val); _modalResolve = null; }
}

function appModalCancel() {
  const overlay = document.getElementById('app-modal-overlay');
  overlay.style.opacity = '0';
  setTimeout(() => { overlay.style.display = 'none'; }, 200);
  if (_modalResolve) { _modalResolve(null); _modalResolve = null; }
}


// ── STORAGE VIEWER ────────────────────────────────────────────────────────

// ── INIT ──────────────────────────────────────────────────────────────────


// One-time category migration — runs silently on every load
(function migrateCats() {
  const MAP = {
    // Old app defaults → new
    'Cleaning':                   'Cleaning & Garden',
    'Garden':                     'Cleaning & Garden',
    'Landscaping & Garden':       'Cleaning & Garden',
    'Cleaning & Maintenance':     'Cleaning & Garden',
    'Cleaning/Repairs':           'Cleaning & Garden',
    'Supplies & Equipment':       'Supplies & Consumables',
    'Supplies & Consumables':     'Supplies & Consumables', // already correct
    'Groceries':                  'Supplies & Consumables',
    'Linen & Towels':             'Supplies & Consumables',
    'Appliances':                 'Furnishings & Equipment',
    'Furniture':                  'Furnishings & Equipment',
    'Furnishings & Equipment':    'Furnishings & Equipment', // already correct
    'Repairs':                    'Maintenance & Repairs',
    'Pest Control':               'Maintenance & Repairs',
    'Renovation & Building':      'Renovation',
    'Renovation':                 'Renovation', // already correct
    'Utilities & Services':       'Utilities & Rates',
    'Council Rates':              'Utilities & Rates',
    'Professional & Marketing':   'Professional Services',
    'Professional Services':      'Professional Services', // already correct
    'Professional Fees':          'Professional Services',
    'Administration':             'Professional Services',
    'Admin':                      'Professional Services',
    'Marketing':                  'Professional Services',
  };
  let changed = false;
  expenses.forEach(e => { if (MAP[e.category]) { e.category = MAP[e.category]; changed = true; } });
  if (changed) savePropertyData();
})();

// Cleaner mode class setup (actual hydration happens in DOMContentLoaded boot)
if (isCleanerMode()) {
  if (isCleanerAuthed()) document.body.classList.add('cleaner-mode');
  else document.body.classList.add('cleaner-pin-active');
}

// Google Drive prompts removed — receipts now use Supabase Storage
// Safety net: re-render calendar after 100ms in case layout wasn't settled
setTimeout(renderCalendar, 100);

// Auto-refresh when user returns to app — throttled to once per 5 minutes
let _lastVisibilitySync = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && hasValidPropertyConfig()) {
    const now = Date.now();
    if (now - _lastVisibilitySync > 5 * 60 * 1000) {
      _lastVisibilitySync = now;
      // Supabase is now the source — trigger a silent re-hydrate instead
      if (typeof globalThis.hydrateFromCloud === 'function') globalThis.hydrateFromCloud().then(() => {
        if (typeof reloadInMemoryData === 'function') reloadInMemoryData();
        if (typeof renderAll === 'function') renderAll();
      });
    }
    setTimeout(_flushPendingUiRefresh, 120);
  }
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted && hasValidPropertyConfig()) {
    if (typeof globalThis.hydrateFromCloud === 'function') globalThis.hydrateFromCloud().then(() => {
      if (typeof reloadInMemoryData === 'function') reloadInMemoryData();
      if (typeof renderAll === 'function') renderAll();
    });
  }
  setTimeout(_flushPendingUiRefresh, 120);
});

// Auto-refresh cleaner app when it comes back into focus or on interval
if (isCleanerMode()) {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      // Refresh from Netlify function for cleaner mode
      hydrateCleanerFromFunction().then(ok => {
        if (ok && typeof renderCleanerView === 'function') renderCleanerView();
      }).catch(() => {});
      setTimeout(_flushPendingUiRefresh, 120);
    }
  });
} else {
  // Owner app — poll Supabase every 60 seconds to catch cleaner updates.
  setInterval(() => {
    if (!document.hidden && hasValidPropertyConfig()) {
      if (typeof globalThis.loadCleansFromCloud === 'function') {
        globalThis.loadCleansFromCloud().then(cloudCleans => {
          if (Array.isArray(cloudCleans) && cloudCleans.length) {
            localStorage.setItem(lsKey('cleans'), JSON.stringify(cloudCleans));
            replaceArrayInPlace(cleans, cloudCleans);  // keep in-memory in sync so renderAll() uses fresh data
            if (typeof renderAll === 'function') renderAll();
          }
        }).catch(() => {});
      }
    }
  }, 60000);
}


// ── BUTTON PRESS FEEL ─────────────────────────────────────────────────────────
function attachButtonPress() {
  document.querySelectorAll('button, .settings-cat-item, .booking-item, .expense-item').forEach(el => {
    if (el.dataset.pressAttached) return;
    el.dataset.pressAttached = '1';
    el.addEventListener('touchstart', () => { el.classList.add('btn-press'); }, { passive:true });
    el.addEventListener('touchend',   () => { setTimeout(() => el.classList.remove('btn-press'), 100); });
    el.addEventListener('touchcancel',() => { el.classList.remove('btn-press'); });
  });
}

// ── LIST ENTRANCE ANIMATION ───────────────────────────────────────────────────
function animateList(containerSelector) {
  if (!getFx('listBounce')) return;
  const items = document.querySelectorAll(containerSelector + ' > *');
  items.forEach((el, i) => {
    el.classList.remove('list-animate');
    void el.offsetWidth; // force reflow
    el.style.animationDelay = (i * 40) + 'ms';
    el.classList.add('list-animate');
  });
}

// ── SWIPE TO GO BACK ──────────────────────────────────────────────────────────

// ── ACTION SHEET ──────────────────────────────────────────────────────────────
let longPressTimer = null;
let longPressTarget = null;

function showActionSheet(title, actions) {
  document.getElementById('action-sheet-title').textContent = title;
  const btnsEl = document.getElementById('action-sheet-buttons');
  btnsEl.innerHTML = actions.map(a =>
    `<button class="action-sheet-btn${a.destructive?' destructive':''}" onclick="closeActionSheet();(${a.fn})()">${a.label}</button>`
  ).join('');
  document.getElementById('action-sheet-overlay').classList.add('open');
}
function closeActionSheet() {
  document.getElementById('action-sheet-overlay').classList.remove('open');
}

function attachLongPress() {
  if (!getFx('longPress')) return;

  const clearLP = () => clearTimeout(longPressTimer);

  // Booking items
  document.querySelectorAll('.booking-item').forEach(el => {
    if (el.dataset.lpAttached) return;
    el.dataset.lpAttached = '1';
    const rawId = el.dataset.bookingId;
    const id = isNaN(Number(rawId)) ? rawId : parseInt(rawId);
    if (!id) return;
    let startX = 0, startY = 0;
    el.addEventListener('touchstart', e => {
      if (!e.touches || e.touches.length !== 1) return;
      const t = e.touches[0];
      startX = t.clientX; startY = t.clientY;
      clearLP();
      longPressTimer = setTimeout(() => {
        const b = bookings.find(b => b._cloudId === id || String(b.id) === String(id));
        if (!b) return;
        const safeId = b._cloudId || b.id;
        showActionSheet(b.name, [
          { label: '✏️ Edit Booking',       fn: `() => showEditModal('${safeId}')` },
          { label: '📱 Notify Cleaner',     fn: `() => { showSection('cleaning'); }` },
          { label: '🗑 Delete Booking',      fn: `() => deleteBooking('${safeId}')`, destructive: true },
        ]);
      }, 550);
    }, { passive:true });
    el.addEventListener('touchend', clearLP, { passive:true });
    el.addEventListener('touchcancel', clearLP, { passive:true });
    el.addEventListener('touchmove', e => {
      if (!e.touches || !e.touches.length) { clearLP(); return; }
      const t = e.touches[0];
      if (Math.abs(t.clientX - startX) > 8 || Math.abs(t.clientY - startY) > 8) clearLP();
    }, { passive:true });
  });

  // Expense items
  document.querySelectorAll('.expense-item').forEach(el => {
    if (el.dataset.lpAttached) return;
    el.dataset.lpAttached = '1';
    const id = parseInt(el.dataset.expenseId);
    if (!id) return;
    let startX = 0, startY = 0;
    el.addEventListener('touchstart', e => {
      if (!e.touches || e.touches.length !== 1) return;
      const t = e.touches[0];
      startX = t.clientX; startY = t.clientY;
      clearLP();
      longPressTimer = setTimeout(() => {
        const eItem = expenses.find(x => x.id === id);
        if (!eItem) return;
        showActionSheet(eItem.merchant, [
          { label: '✏️ Edit Expense',  fn: `() => openExpenseEdit(${id})` },
          { label: '🗑 Delete Expense', fn: `() => deleteExpense(${id})`, destructive: true },
        ]);
      }, 550);
    }, { passive:true });
    el.addEventListener('touchend', clearLP, { passive:true });
    el.addEventListener('touchcancel', clearLP, { passive:true });
    el.addEventListener('touchmove', e => {
      if (!e.touches || !e.touches.length) { clearLP(); return; }
      const t = e.touches[0];
      if (Math.abs(t.clientX - startX) > 8 || Math.abs(t.clientY - startY) > 8) clearLP();
    }, { passive:true });
  });
}

// ── MODAL HANDLE DRAG TO DISMISS ─────────────────────────────────────────────
function attachModalHandleDrag() {
  const closeForOverlay = (overlay) => {
    if (!overlay) return;
    if (overlay.id === 'modal') closeModal();
    else if (overlay.id === 'detail-modal') closeDetailModal();
    else if (overlay.id === 'notify-modal') closeNotifyModal();
    else if (overlay.id === 'expense-edit-modal') closeExpenseEdit();
    else if (overlay.id === 'inv-edit-modal') closeInvEdit();
    else { overlay.classList.remove('open'); _checkModalsClosed(); }
  };

  document.querySelectorAll('.modal-drag-zone').forEach(zone => {
    if (zone.dataset.dragAttached) return;
    zone.dataset.dragAttached = '1';

    const modal = zone.closest('.modal');
    const overlay = zone.closest('.modal-overlay');
    if (!modal || !overlay) return;

    let startY = 0;
    let currentY = 0;
    let dragging = false;

    const beginDrag = (clientY) => {
      startY = clientY;
      currentY = 0;
      dragging = true;
      modal.style.transition = 'none';
    };

    const moveDrag = (clientY) => {
      if (!dragging) return;
      const dy = clientY - startY;
      if (dy < 0) return;
      currentY = dy;
      modal.style.transform = `translateY(${dy}px)`;
    };

    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      modal.style.transition = 'transform 0.42s cubic-bezier(0.32,0.72,0,1)';
      if (currentY > 80) {
        modal.style.transform = 'translateY(100%)';
        setTimeout(() => {
          modal.style.transform = '';
          closeForOverlay(overlay);
        }, 280);
      } else {
        modal.style.transform = 'translateY(0)';
        setTimeout(() => { modal.style.transform = ''; }, 320);
      }
    };

    zone.addEventListener('touchstart', e => beginDrag(e.touches[0].clientY), { passive: true });
    zone.addEventListener('touchmove', e => {
      moveDrag(e.touches[0].clientY);
      if (dragging) e.preventDefault();
    }, { passive: false });
    zone.addEventListener('touchend', endDrag, { passive: true });
    zone.addEventListener('touchcancel', endDrag, { passive: true });

    zone.addEventListener('pointerdown', e => beginDrag(e.clientY));
    zone.addEventListener('pointermove', e => { if (dragging) moveDrag(e.clientY); });
    zone.addEventListener('pointerup', endDrag);
    zone.addEventListener('pointercancel', endDrag);
    zone.addEventListener('mouseup', endDrag);
    zone.addEventListener('mouseleave', () => { if (dragging && currentY > 80) endDrag(); });
  });
}

// ── CLEANER MODE ─────────────────────────────────────────────────────────────
function isCleanerMode() {
  const hash = window.location.hash; // e.g. #cleaner/123/ABC
  if (hash.startsWith('#cleaner/')) return true;
  const p = new URLSearchParams(window.location.search);
  if (p.get('role') === 'cleaner') return true;
  // Fallback: cleaner params were saved to localStorage on first auth
  return !!localStorage.getItem('gh-cleaner-session');
}

function getCleanerParams() {
  // Hash format: #cleaner/ID/ENCODEDPIN
  const hash = window.location.hash;
  const p = new URLSearchParams(window.location.search);
  if (hash.startsWith('#cleaner/')) {
    const parts = hash.slice(1).split('/');
    return { id: parts[1] || null, encoded: parts[2] || null, uid: p.get('uid') || null };
  }
  // Fallback: query string format (old links)
  if (p.get('id')) return { id: p.get('id'), encoded: p.get('p'), uid: p.get('uid') || null };
  // Fallback: saved session from home screen launch
  try {
    const saved = JSON.parse(localStorage.getItem('gh-cleaner-session') || 'null');
    if (saved && saved.id) return { id: saved.id, encoded: saved.encoded || null, uid: saved.uid || null };
  } catch (e) {}
  return { id: null, encoded: null, uid: null };
}
globalThis.getCleanerParams = getCleanerParams;

function getActiveCleaner() {
  const { id } = getCleanerParams();
  if (!id) return null;
  return loadCleaners().find(c => String(c.id) === String(id)) || null;
}

/**
 * hydrateCleanerFromFunction — fetches cleaner data from the Netlify function
 * and populates localStorage + in-memory arrays. Used when the home screen PWA
 * has no Supabase auth session (isolated localStorage).
 */
async function hydrateCleanerFromFunction() {
  const { id, uid } = getCleanerParams();
  if (!id || !uid) {
    console.log('[StayOps] hydrateCleanerFromFunction: missing id or uid');
    return false;
  }
  try {
    console.log('[StayOps] hydrateCleanerFromFunction: fetching data…');
    const res = await fetch('/.netlify/functions/cleaner-data?cleanerId=' + encodeURIComponent(id) + '&uid=' + encodeURIComponent(uid));
    if (!res.ok) {
      console.warn('[StayOps] hydrateCleanerFromFunction: HTTP ' + res.status);
      return false;
    }
    const data = await res.json();
    if (!data || !data.cleaner) {
      console.warn('[StayOps] hydrateCleanerFromFunction: no cleaner in response');
      return false;
    }

    // Populate localStorage so loadCleaners/getActiveCleaner work
    const cleanerRecord = data.cleaner;
    // Ensure the cleaner's local_id is a number if it was originally
    if (cleanerRecord.id && !isNaN(Number(cleanerRecord.id))) {
      cleanerRecord.id = Number(cleanerRecord.id);
    }
    localStorage.setItem(lsKey('cleaners'), JSON.stringify([cleanerRecord]));

    // Populate cleans
    if (Array.isArray(data.cleans)) {
      replaceArrayInPlace(cleans, data.cleans);
      localStorage.setItem(lsKey('cleans'), JSON.stringify(cleans));
    }

    // Populate bookings
    if (Array.isArray(data.bookings)) {
      replaceArrayInPlace(bookings, data.bookings);
      localStorage.setItem(lsKey('bookings'), JSON.stringify(bookings));
    }

    // Populate inventory
    if (Array.isArray(data.inventory)) {
      replaceArrayInPlace(inventory, data.inventory);
      localStorage.setItem(lsKey('inventory'), JSON.stringify(inventory));
    }

    // Set property name
    if (data.property && data.property.name) {
      const headerName = document.getElementById('header-property-name');
      if (headerName) headerName.textContent = data.property.name;
    }

    console.log('[StayOps] hydrateCleanerFromFunction: done — ' +
      (data.cleans || []).length + ' cleans, ' +
      (data.bookings || []).length + ' bookings');
    return true;
  } catch (e) {
    console.warn('[StayOps] hydrateCleanerFromFunction failed:', e);
    return false;
  }
}

/**
 * postCleanerAction — sends accept/decline/done to the Netlify function.
 * Used when there's no Supabase auth session (home screen PWA).
 */
function _showCleanerLinkError(msg) {
  // Repurpose the PIN screen to show a clear error instead of a blank cleaner view.
  // Removes cleaner-mode so the cleaner shell is hidden, keeps the PIN screen bg.
  document.body.classList.remove('cleaner-mode');
  document.body.classList.add('cleaner-pin-active');
  const dots = document.getElementById('pin-dots');
  if (dots) dots.style.display = 'none';
  const errEl = document.getElementById('pin-error');
  if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
}

function isCleanerAuthed() {
  const { id } = getCleanerParams();
  return localStorage.getItem('gh-cleaner-authed-' + id) === '1';
}

// ── PIN ENTRY ─────────────────────────────────────────────────────────────────
let cleanerPinEntry = '';
function pinPress(digit) {
  if (cleanerPinEntry.length >= 4) return;
  cleanerPinEntry += digit;
  updatePinDots();
  if (cleanerPinEntry.length === 4) setTimeout(verifyCleanerPin, 120);
}
function pinDelete() {
  cleanerPinEntry = cleanerPinEntry.slice(0, -1);
  updatePinDots();
  document.getElementById('pin-error').style.display = 'none';
}
function updatePinDots() {
  for (let i = 0; i < 4; i++) {
    const dot = document.getElementById('pd-' + i);
    if (dot) dot.classList.toggle('filled', i < cleanerPinEntry.length);
  }
}
async function verifyCleanerPin() {
  const { id, encoded } = getCleanerParams();
  if (!encoded) {
    document.getElementById('pin-error').textContent = 'No PIN in link — ask owner to re-copy link from Settings';
    document.getElementById('pin-error').style.display = 'block';
    cleanerPinEntry = ''; updatePinDots(); return;
  }
  let stored;
  try { stored = atob(encoded); } catch(e) { stored = ''; }
  if (cleanerPinEntry === stored) {
    localStorage.setItem('gh-cleaner-authed-' + id, '1');
    // Save cleaner session so home screen launch preserves cleaner mode
    const { uid } = getCleanerParams();
    localStorage.setItem('gh-cleaner-session', JSON.stringify({ id, encoded, uid: uid || '' }));
    document.body.classList.remove('cleaner-pin-active');
    document.body.classList.add('cleaner-mode');
    // Hydrate cleaner data from Netlify function before rendering
    const hydrateOk = await hydrateCleanerFromFunction();
    if (hydrateOk) {
      renderCleanerView();
      // Subscribe cleaner to push after auth
      setTimeout(() => subscribeToPush('cleaner', id), 1500);
    } else {
      _showCleanerLinkError('Could not load your cleaning data — check your connection and try again.');
    }
  } else {
    document.getElementById('pin-error').textContent = 'Incorrect PIN — try again';
    document.getElementById('pin-error').style.display = 'block';
    const dotsEl = document.getElementById('pin-dots');
    dotsEl.style.transform = 'translateX(-8px)';
    setTimeout(() => { dotsEl.style.transform = 'translateX(8px)'; }, 80);
    setTimeout(() => { dotsEl.style.transform = 'translateX(0)'; }, 160);
    cleanerPinEntry = ''; setTimeout(updatePinDots, 200);
  }
}
async function cleanerRefresh() {
  const btn = document.getElementById('cleaner-refresh-btn');
  if (btn) { btn.textContent = '↻ …'; btn.disabled = true; }
  await hydrateCleanerFromFunction();
  renderCleanerView();
  if (btn) { btn.textContent = '↻ Refresh'; btn.disabled = false; }
  showBanner('✓ Updated', 'ok');
}

async function enableCleanerNotifications() {
  const { id } = getCleanerParams();
  const btn = document.getElementById('cleaner-notif-btn');
  if (btn) { btn.textContent = '…'; btn.disabled = true; }
  const sub = await subscribeToPush('cleaner', id);
  if (sub) {
    if (btn) { btn.textContent = '✅ Notifications On'; btn.style.color = 'rgba(255,255,255,0.9)'; }
    showBanner('✓ Notifications enabled!', 'ok');
  } else {
    if (btn) { btn.textContent = '🔔 Enable Notifications'; btn.disabled = false; }
    const perm = window.Notification && Notification.permission;
    if (perm === 'denied') {
      showBanner('Notifications blocked — check Settings', 'error');
    } else {
      showBanner('Could not enable notifications', 'error');
    }
  }
}

function updateCleanerNotifBtn() {
  const btn = document.getElementById('cleaner-notif-btn');
  const status = document.getElementById('cleaner-notif-status');
  if (!btn) return;
  const { id } = getCleanerParams();
  const sub = getCleanerSub(id);
  const granted = window.Notification && Notification.permission === 'granted';
  if (sub && granted) {
    btn.textContent = '🔔 Notifications On';
    if (status) status.textContent = '✅ Notifications enabled';
  } else {
    if (status) status.textContent = '';
  }
}

function cleanerSignOut() {
  const { id } = getCleanerParams();
  localStorage.removeItem('gh-cleaner-authed-' + id);
  localStorage.removeItem('gh-cleaner-session');
  cleanerPinEntry = ''; updatePinDots();
  document.getElementById('pin-error').style.display = 'none';
  document.body.classList.remove('cleaner-mode');
  document.body.classList.add('cleaner-pin-active');
}

// ── CLEANER TAB SWITCHING ─────────────────────────────────────────────────────
let cleanerTab = 'cleans';
function switchCleanerTab(tab) {
  cleanerTab = tab;
  ['cleans','inventory'].forEach(t => {
    const tabBtn = document.getElementById('ctab-' + t);
    const viewEl = document.getElementById('cleaner-' + t + '-view');
    if (tabBtn) tabBtn.classList.toggle('active', t === tab);
    if (viewEl) viewEl.style.display = t === tab ? 'block' : 'none';
  });
}

// ── CLEANER CLEANS VIEW ───────────────────────────────────────────────────────
let cleanerCleanTab = 'upcoming';

function switchCleanerCleanTab(tab) {
  cleanerCleanTab = tab;
  ['upcoming','new'].forEach(t => {
    const btn = document.getElementById('csubtab-' + t);
    const el = document.getElementById('cleaner-cleans-' + t);
    if (btn) {
      btn.style.color = t === tab ? 'var(--forest)' : 'var(--text-soft)';
      btn.style.fontWeight = t === tab ? '700' : '600';
      btn.style.borderBottomColor = t === tab ? 'var(--forest)' : 'transparent';
      btn.style.background = t === tab ? 'rgba(31,90,67,0.08)' : 'transparent';
      btn.style.borderRadius = '10px 10px 0 0';
    }
    if (el) el.style.display = t === tab ? '' : 'none';
  });
}

function renderCleanerCleans() {
  const cleaner = getActiveCleaner();
  const today = new Date().toISOString().split('T')[0];
  const twoDaysAgo = new Date(Date.now() - 2*24*60*60*1000).toISOString().split('T')[0];
  const perm = (cleaner && cleaner.permissions) ? cleaner.permissions : {};

  const relevant = cleans.filter(c => {
    if (c.done) return false;
    if (c.date < twoDaysAgo) return false;
    if (isCleanLinkedToCancelledBooking(c)) return false;
    if (cleaner) {
      return (c.cleanerId && String(c.cleanerId) === String(cleaner.id)) ||
             (!c.cleanerId && c.cleaner && c.cleaner === cleaner.name);
    }
    return true;
  }).sort((a,b) => a.date.localeCompare(b.date));

  // Badges on both tabs
  const newCount = relevant.filter(c => !c.cleanerConfirmed && !c.cleanerDeclined).length;
  const upcomingCount = relevant.filter(c => c.cleanerConfirmed && !c.cleanerDeclined).length;
  const cleanerView = document.getElementById('cleaner-cleans-view');
  if (cleanerView) {
    let quick = document.getElementById('cleaner-quick-summary');
    if (!quick) {
      quick = document.createElement('div');
      quick.id = 'cleaner-quick-summary';
      quick.className = 'card';
      quick.style.marginBottom = '10px';
      const upcomingEl = document.getElementById('cleaner-cleans-upcoming');
      cleanerView.insertBefore(quick, upcomingEl || null);
    }
    quick.innerHTML = `
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.55px;color:var(--text-soft);margin-bottom:6px">Your jobs today</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <div class="mini-status-chip chip-new">New: <strong>${newCount}</strong></div>
        <div class="mini-status-chip chip-upcoming">Upcoming: <strong>${upcomingCount}</strong></div>
      </div>
      <div style="font-size:11px;color:var(--text-soft);margin-top:7px">${newCount > 0 ? 'Start in New to accept/decline your latest jobs.' : 'No new responses needed right now.'}</div>
    `;
  }
  const newBadge = document.getElementById('csubtab-new-badge');
  const upBadge = document.getElementById('csubtab-upcoming-badge');
  const badgeStyle = 'border-radius:10px;padding:1px 7px;font-size:11px;margin-left:4px;font-weight:700';
  if (newBadge) newBadge.innerHTML = newCount > 0
    ? `<span style="background:var(--red);color:white;${badgeStyle}">${newCount}</span>`
    : `<span style="background:var(--stone);color:white;${badgeStyle}">0</span>`;
  if (upBadge) upBadge.innerHTML = `<span style="background:${upcomingCount > 0 ? 'var(--forest)' : 'var(--stone)'};color:white;${badgeStyle}">${upcomingCount}</span>`;

  const daysUntil = d => {
    const diff = (new Date(d) - new Date(today)) / 86400000;
    if (diff < -0.5) return null;
    if (diff < 0.5) return 'Today';
    if (diff < 1.5) return 'Tomorrow';
    return Math.ceil(diff) + ' days away';
  };

  function buildCard(c) {
    const booking = bookings.find(b => String(b.id) === String(c.bookingId) || _normName(b.name) === _normName(c.guestName));
    const checkinStr = booking ? fmt(booking.checkin) : (c.checkin ? fmt(c.checkin) : '—');
    const checkoutStr = booking ? fmt(booking.checkout) : fmt(c.date);
    const isToday = c.date === today;
    const showFirstName = perm.firstName && booking;
    const showFullName  = perm.fullName  && booking;
    const showGuests    = perm.guests    && booking;
    const showNotes     = perm.notes;
    const showPayout    = perm.payout    && booking;
    const nameDisplay   = showFullName ? booking.name : showFirstName ? (booking.name||'').split(' ')[0] : null;
    const urgency = daysUntil(c.date);

    return `<div class="clean-job-card ${isToday ? 'urgent' : ''}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
        <div>
          <div style="font-family:'DM Serif Display',serif;font-size:17px;color:var(--forest)">${urgency || 'Upcoming'}</div>
          <div style="font-size:12px;color:var(--text-soft);margin-top:2px">${c.date ? fmt(c.date) : '—'}</div>
          ${nameDisplay ? `<div style="font-size:13px;font-weight:600;color:var(--text);margin-top:4px">👤 ${nameDisplay}</div>` : ''}
        </div>
        ${isToday ? '<div style="font-size:11px;font-weight:600;color:var(--amber);background:#FFF5E6;padding:4px 10px;border-radius:20px">Today!</div>' : ''}
      </div>
      <div style="display:grid;grid-template-columns:${showGuests ? '1fr 1fr 1fr' : '1fr 1fr'};gap:8px;margin-bottom:12px">
        <div style="background:var(--mist);border-radius:8px;padding:8px 10px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-soft);margin-bottom:3px">Check-in</div>
          <div style="font-size:12px;font-weight:600">${checkinStr}</div>
        </div>
        <div style="background:var(--mist);border-radius:8px;padding:8px 10px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-soft);margin-bottom:3px">Check-out</div>
          <div style="font-size:12px;font-weight:600">${checkoutStr}</div>
        </div>
        ${showGuests ? `<div style="background:var(--mist);border-radius:8px;padding:8px 10px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-soft);margin-bottom:3px">Guests</div>
          <div style="font-size:12px;font-weight:600">${booking.guests}</div>
        </div>` : ''}
      </div>
      ${showPayout ? `<div style="background:#EDF7ED;border-radius:8px;padding:8px 12px;margin-bottom:10px;font-size:13px;color:var(--forest);font-weight:600">💰 Cleaning fee: $${Number(booking.cleaningFee||0).toLocaleString()}</div>` : ''}
      ${showNotes && c.notes ? `<div style="background:var(--mist);border-radius:8px;padding:8px 12px;margin-bottom:10px;font-size:12px;color:var(--text-soft)">📝 ${c.notes}</div>` : ''}
      BUTTONS_PLACEHOLDER
    </div>`;
  }

  // NEW tab — pending (not yet accepted or declined)
  const newEl = document.getElementById('cleaner-cleans-new');
  const newCleans = relevant.filter(c => !c.cleanerConfirmed && !c.cleanerDeclined);
  if (newEl) {
    if (!newCleans.length) {
      newEl.innerHTML = `<div style="text-align:center;padding:48px 16px">
        <div style="font-size:48px;margin-bottom:12px">✨</div>
        <div style="font-family:'DM Serif Display',serif;font-size:18px;color:var(--forest);margin-bottom:6px">Nothing new!</div>
        <div style="font-size:13px;color:var(--text-soft)">New assignments will appear here</div>
        <div style="font-size:12px;color:var(--text-soft);margin-top:8px">If you were just assigned, tap <strong>↻ Refresh</strong>.</div>
      </div>`;
    } else {
      newEl.innerHTML = newCleans.map(c => {
        const buttons = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <button onclick="cleanerDecline('${c.id}')" style="background:#FDECEA;color:var(--red);border:none;border-radius:var(--radius-sm);padding:13px;font-size:13px;font-weight:600;font-family:'DM Sans',sans-serif;cursor:pointer">✗ Decline</button>
          <button onclick="cleanerAccept('${c.id}')" style="background:var(--forest);color:white;border:none;border-radius:var(--radius-sm);padding:13px;font-size:13px;font-weight:600;font-family:'DM Sans',sans-serif;cursor:pointer">✓ Accept</button>
        </div>`;
        return buildCard(c).replace('BUTTONS_PLACEHOLDER', buttons);
      }).join('');
    }
  }

  // UPCOMING tab — accepted cleans
  const upcomingEl = document.getElementById('cleaner-cleans-upcoming');
  const upcomingCleans = relevant.filter(c => c.cleanerConfirmed && !c.cleanerDeclined);
  if (upcomingEl) {
    if (!upcomingCleans.length) {
      upcomingEl.innerHTML = `<div style="text-align:center;padding:48px 16px">
        <div style="font-size:48px;margin-bottom:12px">🗓</div>
        <div style="font-family:'DM Serif Display',serif;font-size:18px;color:var(--forest);margin-bottom:6px">No upcoming cleans</div>
        <div style="font-size:13px;color:var(--text-soft)">Cleans you've accepted will appear here</div>
        <div style="font-size:12px;color:var(--text-soft);margin-top:8px">Accept a clean from the <strong>New</strong> tab first.</div>
      </div>`;
    } else {
      upcomingEl.innerHTML = upcomingCleans.map(c => {
        const buttons = `<button onclick="cleanerMarkDone('${c.id}')" style="width:100%;background:var(--forest);color:white;border:none;border-radius:var(--radius-sm);padding:13px;font-size:14px;font-weight:600;font-family:'DM Sans',sans-serif;cursor:pointer">✓ Mark as Complete</button>`;
        return buildCard(c).replace('BUTTONS_PLACEHOLDER', buttons);
      }).join('');
    }
  }
}

// ── CLEANER INVENTORY VIEW ────────────────────────────────────────────────────
function renderCleanerInventory() {
  const el = document.getElementById('cleaner-inventory-list');
  if (!el) return;
  const lowItems = inventory.filter(i => i.stock <= i.threshold);
  let html = '';
  if (lowItems.length) {
    html += `<div class="card" style="margin-bottom:12px;border-left:4px solid var(--amber)">
      <div style="font-size:12px;font-weight:600;color:var(--amber);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">⚠ Needs Restocking</div>
      <div style="font-size:13px;color:var(--text-soft)">${lowItems.map(i=>`<strong>${i.name}</strong>`).join(', ')} ${lowItems.length===1?'is':'are'} running low</div>
    </div>`;
  }
  if (!inventory.length) {
    html += '<div style="text-align:center;padding:40px 16px;color:var(--text-soft);font-size:13px">No inventory items added yet</div>';
  } else {
    html += `<div class="card" style="padding:0">` + inventory.map(i => {
      const isLow = i.stock <= i.threshold;
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--warm);gap:8px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:14px;color:${isLow?'var(--red)':'var(--text)'}">${i.name}${isLow?' ⚠':''}</div>
          ${i.unit?`<div style="font-size:11px;color:var(--text-soft);margin-top:2px">${i.unit}</div>`:''}
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
          <button onclick="cleanerAdjustStock(${i.id},-1)" style="width:36px;height:36px;border-radius:50%;border:1.5px solid var(--stone);background:white;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1">−</button>
          <span style="font-weight:700;font-size:18px;min-width:28px;text-align:center;color:${isLow?'var(--red)':'var(--forest)'}">${i.stock}</span>
          <button onclick="cleanerAdjustStock(${i.id},1)" style="width:36px;height:36px;border-radius:50%;border:none;background:var(--forest);color:white;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1">+</button>
        </div>
      </div>`;
    }).join('') + `</div>`;
  }
  el.innerHTML = html;
}
async function cleanerAddInventoryItem() {
  const name = await showAppModal({
    title: '+ Add Inventory Item',
    msg: 'Enter the item name:',
    hasInput: true,
    inputPlaceholder: 'e.g. Toilet paper',
    inputType: 'text',
    confirmText: 'Add',
    cancelText: 'Cancel'
  });
  if (!name || !name.trim()) return;
  const newItem = {
    id: Date.now(),
    name: name.trim(),
    stock: 0,
    threshold: 2,
    unit: ''
  };
  inventory.push(newItem);
  savePropertyData();
  renderCleanerInventory();
  showBanner('✓ Item added', 'ok');
}

function cleanerAdjustStock(id, delta) {
  const item = inventory.find(i => i.id === id);
  if (!item) return;
  item.stock = Math.max(0, item.stock + delta);
  savePropertyData(); renderCleanerInventory();
}
function renderCleanerView() {
  const cleaner = getActiveCleaner();
  const headerSub = document.querySelector('.cleaner-header .header-sub-name');
  if (headerSub && cleaner) headerSub.textContent = 'Hi, ' + cleaner.name.split(' ')[0] + ' 👋';
  renderCleanerCleans();
  renderCleanerInventory();
  updateCleanerNotifBtn();
}

// ── ASSIGN CLEANER TO BOOKING (from detail modal) ─────────────────────────────

// ── AUTO-ASSIGN CLEANER TOGGLE ────────────────────────────────────────────────


// hydrateFromCloud lives in supabase.js (wired via globalThis in main).
/**
 * finishAppInit — runs standard app init after login or session restore.
 */
async function finishAppInit() {
  migrateConfigFromLegacySettings();
  renderPropertySwitcher();
  initFxSettings();
  initSettingsSwipeBack();
  attachButtonPress();
  attachModalHandleDrag();
  document.getElementById('modal').addEventListener('click', function(e) { if (e.target === this) closeModal(); });
  document.getElementById('detail-modal').addEventListener('click', function(e) { if (e.target === this) closeDetailModal(); });
  document.getElementById('notify-modal').addEventListener('click', function(e) { if (e.target === this) closeNotifyModal(); });
  if (isCleanerMode()) {
    const { uid } = getCleanerParams();
    if (!uid) {
      _showCleanerLinkError('Invalid cleaner link — ask the owner to re-send your link from Settings.');
    } else if (isCleanerAuthed()) {
      document.body.classList.add('cleaner-mode');
      const ok = await hydrateCleanerFromFunction();
      if (ok) {
        renderCleanerView();
      } else {
        _showCleanerLinkError('Could not load your cleaning data — check your connection and try again.');
      }
    } else {
      document.body.classList.add('cleaner-pin-active');
    }
  } else {
    await globalThis.showSetupIfNeeded();
  }
}

// ── ONBOARDING FLOW ───────────────────────────────────────────────────────────

const _OB_PLATFORMS = new Set();

function showOnboarding() {
  const el = document.getElementById('stayops-onboarding');
  if (el) el.style.display = 'flex';
  const app   = document.getElementById('main-content');
  const nav   = document.querySelector('.nav');
  const hdr   = document.querySelector('.header');
  if (app) app.style.display = 'none';
  if (nav) nav.style.display = 'none';
  if (hdr) hdr.style.display = 'none';
  _obGoToStep(1);
}

function hideOnboarding() {
  const el = document.getElementById('stayops-onboarding');
  if (el) el.style.display = 'none';
  // Restore app chrome hidden by showOnboarding()
  const app = document.getElementById('main-content');
  const nav = document.querySelector('.nav');
  const hdr = document.querySelector('.header');
  if (app) app.style.display = '';
  if (nav) nav.style.display = '';
  if (hdr) hdr.style.display = '';
}

function _obGoToStep(step) {
  [1, 2, 3].forEach(n => {
    const s = document.getElementById('onboard-step-' + n);
    const d = document.getElementById('onboard-dot-' + n);
    if (s) s.style.display = n === step ? '' : 'none';
    if (d) d.classList.toggle('active', n <= step);
  });
}

// Step 1 — Property details
function onboardStep1Next() {
  const name   = (document.getElementById('ob-prop-name') || {}).value?.trim() || '';
  const suburb = (document.getElementById('ob-suburb')    || {}).value?.trim() || '';
  const state  = (document.getElementById('ob-state')     || {}).value?.trim() || '';
  const beds   = parseFloat((document.getElementById('ob-beds')   || {}).value || '0');
  const baths  = parseFloat((document.getElementById('ob-baths')  || {}).value || '0');
  const guests = parseFloat((document.getElementById('ob-guests') || {}).value || '0');
  const type   = (document.getElementById('ob-type') || {}).value || 'house';
  const errEl  = document.getElementById('ob-step1-error');

  const errors = [];
  if (!name)        errors.push('Property name is required.');
  if (!suburb)      errors.push('Suburb is required.');
  if (!state)       errors.push('State is required.');
  if (!beds || beds < 1)    errors.push('Bedrooms must be at least 1.');
  if (isNaN(baths) || baths < 0) errors.push('Bathrooms cannot be negative.');
  if (!guests || guests < 1) errors.push('Max guests must be at least 1.');

  if (errors.length) {
    if (errEl) errEl.textContent = errors[0];
    return;
  }
  if (errEl) errEl.textContent = '';

  // Save property config
  savePropertyConfig({
    name, suburb, state,
    country: 'Australia',
    property: { bedrooms: beds, bathrooms: baths, maxGuests: guests, type },
    branding: { subtitle: suburb + ' · ' + state, tagline: suburb + ', ' + state },
  });
  localStorage.setItem('gh-setup-complete', '1');

  // Sync property to Supabase
  if (!window._stayOpsHydrating && typeof globalThis.savePropertyToCloud === 'function') {
    globalThis.savePropertyToCloud(getActivePropertyConfig()).catch(() => {});
  }

  _obGoToStep(2);
}

// Step 2 — Connect email
async function onboardConnectGoogle() {
  const user = typeof globalThis.getCurrentSupabaseUser === 'function' ? await globalThis.getCurrentSupabaseUser() : null;
  if (!user) { showBanner('⚠ Please sign in first', 'warn'); return; }
  // Redirect to Netlify OAuth start function, passing user_id as state
  window.location.href = '/.netlify/functions/gmail-oauth-start?state=' + encodeURIComponent(user.id);
}

async function onboardConnectMicrosoft() {
  const user = typeof globalThis.getCurrentSupabaseUser === 'function' ? await globalThis.getCurrentSupabaseUser() : null;
  if (!user) { showBanner('⚠ Please sign in first', 'warn'); return; }
  window.location.href = '/.netlify/functions/outlook-oauth-start?state=' + encodeURIComponent(user.id);
}

// Called by OAuth callback when connection succeeds
function onboardEmailConnected(provider, email) {
  const connectedEl = document.getElementById('ob-email-connected');
  const continueBtn = document.getElementById('ob-step2-continue');
  if (connectedEl) {
    connectedEl.style.display = 'block';
    connectedEl.textContent = '✓ ' + email + ' connected';
  }
  if (continueBtn) {
    continueBtn.disabled = false;
    continueBtn.onclick = () => _obGoToStep(3);
  }
  // Save provider to localStorage for now
  localStorage.setItem('ob-email-provider', provider);
  localStorage.setItem('ob-email-address', email);
}

function onboardStep2Skip() {
  _obGoToStep(3);
}

// Step 3 — Platforms
function onboardTogglePlatform(platform) {
  if (_OB_PLATFORMS.has(platform)) {
    _OB_PLATFORMS.delete(platform);
  } else {
    _OB_PLATFORMS.add(platform);
  }
  // Update UI
  ['airbnb', 'vrbo', 'direct'].forEach(p => {
    const label = document.getElementById('ob-plat-' + p);
    const check = document.getElementById('ob-check-' + p);
    const active = _OB_PLATFORMS.has(p);
    if (label) label.style.borderColor = active ? 'var(--forest,#1E3A2F)' : 'transparent';
    if (check) {
      check.style.background  = active ? 'var(--forest,#1E3A2F)' : 'transparent';
      check.style.borderColor = active ? 'var(--forest,#1E3A2F)' : '#E5E5EA';
      check.innerHTML = active ? '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 7L5.5 10.5L12 3.5" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '';
    }
  });
}

async function onboardFinish() {
  const errEl = document.getElementById('ob-step3-error');
  if (_OB_PLATFORMS.size === 0) {
    if (errEl) errEl.textContent = 'Please select at least one platform.';
    return;
  }
  if (errEl) errEl.textContent = '';

  // Save platforms to property config
  const platforms = Array.from(_OB_PLATFORMS);
  savePropertyConfig({ platforms });

  // Save to Supabase
  if (typeof globalThis.savePropertyToCloud === 'function') {
    await globalThis.savePropertyToCloud(getActivePropertyConfig());
  }

  // No localStorage flag needed — completion is determined by
  // whether the user has a property record in Supabase

  // Boot the app
  hideOnboarding();
  if (typeof globalThis.showLoadingScreen === 'function') globalThis.showLoadingScreen('Setting up your account…');
  if (typeof finishAppInit === 'function') await finishAppInit();
  if (typeof globalThis.hydrateFromCloud === 'function') await globalThis.hydrateFromCloud();
  reloadInMemoryData();
  if (typeof initPropertyUI === 'function') initPropertyUI();
  if (typeof applyPortfolioModeAfterHostHydrate === 'function') await applyPortfolioModeAfterHostHydrate();
  if (typeof globalThis.showAppChrome === 'function') globalThis.showAppChrome();
  if (!(typeof isPortfolioMode === 'function' && isPortfolioMode()) && typeof renderAll === 'function') renderAll();
  setTimeout(() => { if (typeof checkAutoSendReport === 'function') checkAutoSendReport(); }, 1500);
}

// Check if onboarding is needed
function isOnboardingComplete() {
  // A real property must exist in the list before any other flag matters.
  // gh-setup-complete is set by the property setup overlay on submit regardless
  // of whether valid property data was actually saved (e.g. empty name field).
  // Without this guard, an authenticated user with 0 cloud properties lands on
  // a blank "NSW / 0 beds" dashboard instead of the Add Property / onboarding screen.
  try {
    const props = typeof getAllProperties === 'function' ? getAllProperties() : [];
    if (!props.length) return false;
  } catch(e) {}
  if (localStorage.getItem('gh-setup-complete') === '1') return true;
  try {
    const cfg = typeof getActivePropertyConfig === 'function' ? getActivePropertyConfig() : null;
    if (cfg && cfg.name) return true;
  } catch(e) {}
  return false;
}

// ── END ONBOARDING FLOW ───────────────────────────────────────────────────────


/**
 * checkAutoSendReport — called once after hydrateFromCloud + renderAll.
 * If auto-send is on and a report is due, shows a non-intrusive prompt banner.
 */
function checkAutoSendReport() {
  try {
    const owner = (getActivePropertyConfig() || {}).owner || {};
    if (!owner.autoSendReport || !owner.email) return;

    const freq        = owner.reportFrequency || 'monthly';
    const lastSent    = owner.lastReportSentAt ? new Date(owner.lastReportSentAt) : null;
    const now         = new Date();
    const daysSince   = lastSent ? Math.floor((now - lastSent) / 86400000) : Infinity;
    const threshold   = freq === 'quarterly' ? 85 : 28; // ~1 month / ~3 months

    if (daysSince < threshold) return;

    // Determine which FY the due period belongs to
    const dueMonth = lastSent
      ? new Date(lastSent.getFullYear(), lastSent.getMonth() + (freq === 'quarterly' ? 3 : 1), 1)
      : now;
    const fy = dueMonth.getMonth() >= 6 ? dueMonth.getFullYear() : dueMonth.getFullYear() - 1;
    const label = fyLabel(fy);

    showBanner(
      `📊 ${label} report ready — <a href="#" onclick="openSettingsCat('property');openSettingsPanel('owner-report');return false;" style="color:inherit;font-weight:600">Send to owner ›</a>`,
      'info',
      12000
    );
  } catch (e) {
    // Non-critical — silently ignore
  }
}



// ── Calendar swipe navigation + slide animation ───────────────────────────
let _calNavigate;
(function() {
  var _calSwipeX = 0, _calSwipeY = 0;
  var _calAnimating = false;

  function _calReset(grid) {
    grid.style.transition = 'none';
    grid.style.transform  = '';
    grid.style.opacity    = '1';
  }

  _calNavigate = function _calNavigate(direction) {
    var grid = document.getElementById('cal-grid');
    if (!grid || _calAnimating) return;
    _calAnimating = true;

    var outX = direction === 'next' ? '-60%' : '60%';
    var inX  = direction === 'next' ? '60%'  : '-60%';

    // Step 1: fade + slide out
    grid.style.transition = 'transform 0.16s cubic-bezier(0.32,0.72,0,1), opacity 0.16s ease';
    grid.style.transform  = 'translateX(' + outX + ')';
    grid.style.opacity    = '0';

    setTimeout(function() {
      // Step 2: update month data
      if (direction === 'next') calNext(); else calPrev();

      // Step 3: snap to incoming side (no transition)
      grid.style.transition = 'none';
      grid.style.transform  = 'translateX(' + inX + ')';
      grid.style.opacity    = '0';

      // Step 4: double rAF to slide in
      requestAnimationFrame(function() {
        requestAnimationFrame(function() {
          grid.style.transition = 'transform 0.2s cubic-bezier(0.32,0.72,0,1), opacity 0.16s ease';
          grid.style.transform  = 'translateX(0)';
          grid.style.opacity    = '1';
          // Step 5: clean up after animation
          setTimeout(function() {
            _calReset(grid);
            _calAnimating = false;
          }, 220);
        });
      });
    }, 160);
  }

  function attachCalSwipe() {
    var el = document.querySelector('.dashboard-calendar');
    if (!el) return;

    // Ensure grid starts visible
    var grid = document.getElementById('cal-grid');
    if (grid) _calReset(grid);

    el.addEventListener('touchstart', function(e) {
      var t = e.touches[0];
      _calSwipeX = t.clientX;
      _calSwipeY = t.clientY;
    }, { passive: true });

    el.addEventListener('touchend', function(e) {
      var t = e.changedTouches[0];
      var dx = t.clientX - _calSwipeX;
      var dy = t.clientY - _calSwipeY;
      if (Math.abs(dx) < 44 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      _calNavigate(dx < 0 ? 'next' : 'prev');
    }, { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachCalSwipe);
  } else {
    attachCalSwipe();
  }
})();

export {
  showBanner,
  platformIcon,
  reloadInMemoryData,
  showSection,
  jumpToCleaningActionNeeded,
  jumpToScheduleClean,
  render,
  renderAll,
  renderDashboard,
  renderHeaderDateBadge,
  applyStayopsPostSwitchAction,
  openModal,
  closeModal,
  closeDetailModal,
  _checkModalsClosed,
  openQuickAddMenu,
  closeQuickAddMenu,
  runFullRefresh,
  ensureHostIdentityAndRestore,
  renderMaintenance,
  addMaintenance,
  setMaintInProgress,
  resolveIssue,
  deleteMaintenance,
  setInvView,
  renderInventory,
  addInventoryItem,
  updateThreshold,
  adjustStock,
  restockItem,
  deleteInventoryItem,
  openInvEdit,
  closeInvEdit,
  saveInvEdit,
  deleteInventoryItemFromEdit,
  savePropertyData,
  reassignBookingProperty,
  processScanNeedsReview,
  showAppModal,
  appModalConfirm,
  appModalCancel,
  attachButtonPress,
  animateList,
  closeActionSheet,
  attachLongPress,
  attachModalHandleDrag,
  isCleanerMode,
  getCleanerParams,
  hydrateCleanerFromFunction,
  _showCleanerLinkError,
  isCleanerAuthed,
  pinPress,
  pinDelete,
  cleanerRefresh,
  enableCleanerNotifications,
  cleanerSignOut,
  switchCleanerTab,
  switchCleanerCleanTab,
  renderCleanerView,
  cleanerAddInventoryItem,
  cleanerAdjustStock,
  finishAppInit,
  showOnboarding,
  hideOnboarding,
  _obGoToStep,
  onboardStep1Next,
  onboardConnectGoogle,
  onboardConnectMicrosoft,
  onboardEmailConnected,
  onboardStep2Skip,
  onboardTogglePlatform,
  onboardFinish,
  isOnboardingComplete,
  checkAutoSendReport,
  _calNavigate,
};
