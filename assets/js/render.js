/**
 * StayOps — dashboard, sections, modals, maintenance/inventory, cleaner shell, onboarding.
 */
/* eslint-disable no-unused-vars */
// Onboarding wizard extracted to render-onboarding.js — side-effect import runs its
// data self-bridges; the named import lets the export block below re-export them so
// main.js's import contract is unchanged. Circular import is call-time only (safe).
import './render-onboarding.js';
import {
  showOnboarding, hideOnboarding, _obGoToStep, onboardBack, onboardSetPropertyType,
  onboardStep0Next, onboardStep1Next, onboardStep1SkipAddress, onboardStep2Next, onboardSkipStep,
  onboardLiveContinue, obStepperAdjust, obSetGuests, onboardConnectGoogle, onboardConnectMicrosoft,
  onboardEmailConnected, onboardStep2Skip, onboardTogglePlatform, onboardStep3Next, onboardToggleIntegration,
  onboardStep4Next, onboardEnableNotifications, onboardFinish, isOnboardingComplete, checkAutoSendReport,
} from './render-onboarding.js';
import './render-cleaner.js';
import { cleanerSignOut } from './render-cleaner.js';
import {
  getAllProperties,
  getActivePropertyId,
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
  replaceArrayInPlace,
} from './state.js';
import {
  escHtml,
  parseLocalDayStart,
  fmt,
  fmtShort,
  _normName,
  escapeJsSingleQuotedHtmlAttr,
  fyLabel,
  showBannerToast,
  localDateStr,
  getTurnoverTimes,
  findTurnoverClashes,
} from './utils.js';
import {
  _sendCleanerAssignmentNotifications,
  enableNotificationsManually,
  resetPushOnly,
  updateNotifStatus,
  subscribeToPush,
  getCleanerSub,
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
  renderPropertySwitcher,
  switchActiveProperty,
  openPropertySettingsMenu,
  openPropertySwitcherSheet,
  closePropertySwitcherSheet,
  switchToPortfolioFromSheet,
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
  buildBookingListCardFromBooking,
  normalizePlatformLabel,
} from './booking-list-card.js';
import { bookingRevenue, isRevenueBearingBooking } from './booking-revenue.js';
import {
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
  findMatchingCleanForBooking,
  prepareCleaningData,
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
} from './cleaning.js';
import {
  resetFinanceSubViewToHub,
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
  saveCleanerPerm,
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
  saveCleanCost,
} from './bookings.js';
/* eslint-enable no-unused-vars */


// ── STATE ────────────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
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

// eslint-disable-next-line no-unused-vars
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

function renderOnboardingGuidance(_usageSnapshot) {
  const el = document.getElementById('dashboard-product-guidance');
  if (!el) return;

  // Determine completion state
  const hasBookings = bookings && bookings.length > 0;
  const hasEmail = !!(window._appConfig && (window._appConfig.gmail_email || window._appConfig.outlook_email));
  const hasCleaners = !!(window._cleaners && window._cleaners.filter(c => c.name && c.name !== 'Unassigned').length > 0);
  const hasPush = !!(window._appConfig && window._appConfig.push_subs && window._appConfig.push_subs.host);
  const hasListingUrl = (() => {
    try {
      const cfg = typeof getActivePropertyConfig === 'function' ? getActivePropertyConfig() : null;
      return !!(cfg && cfg.airbnbListingUrl);
    } catch(_e) { return false; }
  })();

  const items = [
    { done: true,          label: 'Create your property',          icon: '\u{1F3E0}' },
    { done: hasListingUrl, label: 'Add your listing URL',          icon: '\u{1F517}', action: 'reopenPropertySetup()',       actionLabel: 'Add URL' },
    { done: hasBookings,   label: 'Add your first booking',        icon: '\u{1F4C5}', action: 'showSection(\'bookings\')',  actionLabel: 'Add booking' },
    { done: hasEmail,      label: 'Connect email for auto-import', icon: '\u2709\uFE0F', action: 'openSettingsPanel(\'integrations\')', actionLabel: 'Connect' },
    { done: hasCleaners,   label: 'Add a cleaner',                 icon: '\u{1F9F9}', action: 'showSection(\'cleaning\')', actionLabel: 'Add cleaner' },
    { done: hasPush,       label: 'Enable notifications',          icon: '\u{1F514}', action: 'openSettingsPanel(\'notifications\')', actionLabel: 'Enable' },
  ];

  const completedCount = items.filter(i => i.done).length;
  const allDone = completedCount === items.length;

  // Hide if all complete or user has dismissed
  if (allDone || localStorage.getItem('stayops-checklist-dismissed') === '1') {
    el.style.display = 'none';
    return;
  }

  el.style.display = '';
  const pct = Math.round((completedCount / items.length) * 100);

  el.innerHTML =
    '<div class="card" style="margin-bottom:12px;padding:18px 16px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
        '<div style="font-weight:700;font-size:15px;color:var(--primary)">Getting Started</div>' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<span style="font-size:12px;color:var(--muted-2)">' + completedCount + '/' + items.length + '</span>' +
          '<span onclick="dismissChecklist()" style="font-size:16px;color:var(--muted-2);cursor:pointer;padding:2px">\u2715</span>' +
        '</div>' +
      '</div>' +
      '<div style="background:var(--hairline-2);border-radius:4px;height:6px;margin-bottom:14px;overflow:hidden">' +
        '<div style="background:var(--primary);height:100%;width:' + pct + '%;border-radius:4px;transition:width .3s"></div>' +
      '</div>' +
      items.map(function(item) {
        var checkStyle = item.done
          ? 'background:var(--primary);border-color:var(--primary);color:#fff'
          : 'background:#fff;border-color:#D1D1D6;color:transparent';
        return '<div style="display:flex;align-items:center;gap:12px;padding:8px 0;' + (item.done ? 'opacity:0.5' : '') + '">' +
          '<div style="width:22px;height:22px;border-radius:50%;border:2px solid;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:11px;' + checkStyle + '">' +
            (item.done ? '\u2713' : '') +
          '</div>' +
          '<div style="flex:1;font-size:13px;' + (item.done ? 'text-decoration:line-through;color:var(--muted-2)' : 'color:var(--text);font-weight:500') + '">' +
            item.icon + ' ' + item.label +
          '</div>' +
          (!item.done && item.action
            ? '<div onclick="' + item.action + '" style="font-size:12px;color:var(--primary);font-weight:600;cursor:pointer;white-space:nowrap">' + item.actionLabel + ' \u2192</div>'
            : '') +
        '</div>';
      }).join('') +
    '</div>';
}

function dismissChecklist() {
  localStorage.setItem('stayops-checklist-dismissed', '1');
  var el = document.getElementById('dashboard-product-guidance');
  if (el) el.style.display = 'none';
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
  console.log('[StayOps] reloadInMemoryData: no-op (arrays hydrated directly from cloud)');
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


// eslint-disable-next-line no-unused-vars
function renderSetupWarningBanner() {
  const wrap = document.getElementById('setup-warning-banner');
  const titleEl = document.getElementById('setup-warning-title');
  const bodyEl = document.getElementById('setup-warning-body');
  if (!wrap || !titleEl || !bodyEl) return;

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
  const prevSection = currentSection;
  currentSection = name;
  if (prevSection === 'finance' && name !== 'finance' && name !== 'settings') {
    resetFinanceSubViewToHub();
  }
  document.querySelectorAll('[id^="section-"]').forEach(el => el.classList.add('section-hidden'));
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
  const sec = document.getElementById('section-' + name);
  if (sec) {
    sec.classList.remove('section-hidden');
    sec.classList.remove('section-enter');
    void sec.offsetWidth; // force reflow to restart animation
    sec.classList.add('section-enter');
  }
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
  } else if (name === 'admin') {
    if (typeof globalThis.isAdminSync === 'function' && !globalThis.isAdminSync()) { showSection('today'); return; }
    if (typeof globalThis.renderAdmin === 'function') globalThis.renderAdmin();
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
  renderHeaderDateBadge()
  renderDashboard();
  renderBookings(); // always refresh booking list after sync
  populateSelects();
  populateExpenseCatSelect();
  const expDate = document.getElementById('exp-date');
  if (expDate && !expDate.value) expDate.value = localDateStr();
  const maintDate = document.getElementById('maint-date');
  if (maintDate && !maintDate.value) maintDate.value = localDateStr();
  // Also render whatever section is active — but skip finance/settings to avoid resetting scroll, filters, and forms
  const section = currentSection || 'today';
  if (section === 'cleaning')   { renderCleaning(); populateCleanerSelect(); }
  if (section === 'notes')      renderNotes();
  if (section === 'property')   renderProperty();
  setTimeout(() => { attachButtonPress(); attachLongPress(); }, 50);
}

let _todayWeekStart = null;
/** First day of viewed month for single-property Today calendar (navigated with ‹ ›). */
let _todayMonthViewStart = null;

const TODAY_PALETTE = [
  { dot: '#2D5A3D', bg: '#E8F5E9', border: '#2D5A3D', text: '#27500A' },
  { dot: '#378ADD', bg: '#E6F1FB', border: '#378ADD', text: '#0C447C' },
  { dot: '#D85A30', bg: '#FAECE7', border: '#D85A30', text: '#712B13' },
  { dot: '#7B5BB8', bg: '#F0EBF8', border: '#7B5BB8', text: '#3D2A5C' },
  { dot: '#2A9D8F', bg: '#E6F7F5', border: '#2A9D8F', text: '#0D4A42' },
  { dot: '#C45C2A', bg: '#FDF0E8', border: '#C45C2A', text: '#5C2E14' },
];

function _mondayStart(d) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (t.getDay() + 6) % 7;
  t.setDate(t.getDate() - dow);
  return t;
}

function _ymd(d) {
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

function _pidForProperty(p) {
  const cloudIds = window._cloudPropertyIds || {};
  return String(cloudIds[p.propertyId] || p.supabaseId || p.propertyId || '');
}

function _todayCardCleanerMeta(b, matchedClean) {
  if (!b || b.status === 'cancelled') return null;
  const bookingCleanerName = String(b.cleaner || '').trim();
  const cleanCleanerName = String(matchedClean?.cleaner || '').trim();
  const hasAssignedOnClean = !!(matchedClean && (matchedClean.cleanerId || cleanCleanerName));
  const st = String(b.status || '').toLowerCase();
  const done = !!(matchedClean?.done) || st === 'completed' || st === 'complete';
  const cleanerConfirmed = !!(matchedClean?.cleanerConfirmed || b.cleanerConfirmed);
  const cleanerDeclined = !!(matchedClean?.cleanerDeclined || b.cleanerDeclined);
  const C = {
    noCleaner: { color: '#A32D2D', bg: '#FCEBEB', label: 'No cleaner assigned' },
    awaiting: { color: '#BA7517', bg: '#FAEEDA', label: 'Awaiting cleaner' },
    confirmed: { color: '#1D9E75', bg: '#E8F5E9', label: 'Cleaner confirmed' },
    doneBadge: { color: '#5F5E5A', bg: '#F1EFE8', label: 'Clean done' },
  };
  if (done) return C.doneBadge;
  if (cleanerConfirmed) return C.confirmed;
  if (cleanerDeclined) return C.awaiting;
  if (matchedClean && hasAssignedOnClean) return C.awaiting;
  if (!matchedClean && !bookingCleanerName) return C.noCleaner;
  if (!matchedClean && bookingCleanerName) return C.awaiting;
  if (matchedClean && !hasAssignedOnClean) return C.noCleaner;
  return C.awaiting;
}

function _todayPlatformPill(platformRaw) {
  const raw = String(platformRaw || '').trim();
  const p = raw.toLowerCase();
  let color;
  let bg;
  if (p === 'airbnb') {
    color = '#FF5A5F';
    bg = '#FFF0F0';
  } else if (p === 'vrbo' || p === 'booking.com' || p.includes('booking')) {
    color = '#3B5998';
    bg = '#EEF0FF';
  } else if (p === 'direct') {
    color = '#3D6B4F';
    bg = '#E8F5E9';
  } else {
    color = '#5F5E5A';
    bg = '#F1EFE8';
  }
  const label = normalizePlatformLabel(raw);
  return { label, color, bg };
}

function buildTodayBookingCardHtml(b, options) {
  const { showPropertyStripe, propertyDotHtml } = options;
  const matchedClean = findMatchingCleanForBooking(b);
  const isCancelled = b.status === 'cancelled';
  const id = escapeJsSingleQuotedHtmlAttr(String(b._cloudId || b.id));
  const payout = bookingRevenue(b);
  const platformMeta = _todayPlatformPill(b.platform);
  const cleanerMeta = isCancelled ? null : _todayCardCleanerMeta(b, matchedClean);
  const dateLine =
    escHtml(fmtShort(b.checkin)) +
    ' - ' +
    escHtml(fmtShort(b.checkout)) +
    '  ·  ' +
    escHtml(String(b.guests)) +
    ' guests  ·  ' +
    escHtml(String(b.nights)) +
    ' night' +
    (b.nights !== 1 ? 's' : '');
  const stripe = showPropertyStripe ? `box-shadow:inset 4px 0 0 ${showPropertyStripe};` : '';
  const row1WrapOpacity = isCancelled ? ';opacity:0.6' : '';
  const nameSpanStyle = 'font-weight:500;font-size:15px;color:var(--ink-1)';
  const priceSpanStyle = isCancelled
    ? 'font-weight:500;font-size:15px;color:#666;text-decoration:line-through'
    : 'font-weight:500;font-size:15px;color:#1D9E75';
  const row2Style = isCancelled
    ? 'font-size:13px;color:#666;margin-top:3px;opacity:0.6'
    : 'font-size:13px;color:#666;margin-top:3px';
  const platformPill = `<span style="font-size:11px;font-weight:500;padding:1px 7px;border-radius:4px;color:${platformMeta.color};background:${platformMeta.bg}">${escHtml(platformMeta.label)}</span>`;
  const cleanerBadgeHtml =
    !isCancelled && cleanerMeta
      ? `<span style="font-size:12px;font-weight:500;padding:2px 8px;border-radius:4px;color:${cleanerMeta.color};background:${cleanerMeta.bg}">${escHtml(cleanerMeta.label)}</span>`
      : '';
  const row3Left = isCancelled ? platformPill : `${platformPill}${cleanerBadgeHtml}`;
  const row3Right = propertyDotHtml || '';
  const row3 = `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;gap:8px"><div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;min-width:0">${row3Left}</div>${row3Right}</div>`;
  const outerStyle =
    'display:block;background:white;border-radius:12px;border:0.5px solid rgba(0,0,0,0.1);padding:14px 16px;margin-bottom:10px;cursor:pointer;border-bottom:none;touch-action:manipulation;-webkit-tap-highlight-color:rgba(0,0,0,0.06);' +
    stripe;
  return (
    `<div class="booking-item" onclick="showDetail('${id}')" style="${outerStyle}" data-booking-id="${b.id}">` +
    `<div style="display:flex;justify-content:space-between;align-items:baseline${row1WrapOpacity}">` +
    `<span style="${nameSpanStyle}">${escHtml(b.name)}</span>` +
    `<span style="${priceSpanStyle}">$${payout.toLocaleString()}</span>` +
    `</div>` +
    `<div style="${row2Style}">${dateLine}</div>` +
    row3 +
    `</div>`
  );
}

function navigateTodayToClean(cleanId) {
  console.log('[StayOps] navigateTodayToClean', cleanId);
  showSection('cleaning');
  setCleanStatusFilter('all');
  switchCleanView('timeline');
  setTimeout(() => {
    const data = prepareCleaningData();
    const order = [
      ...data.groups.tomorrow,
      ...data.groups.thisWeek,
      ...data.groups.nextWeek,
      ...data.groups.later,
    ];
    let idx = 0;
    for (const item of order) {
      if (item.clean && String(item.clean.id) === String(cleanId)) {
        const c = item.clean;
        const cleanIdEsc = escapeJsSingleQuotedHtmlAttr(String(c.id != null ? c.id : c._cloudId || ''));
        const bookingIdEsc = item.booking
          ? escapeJsSingleQuotedHtmlAttr(String(item.booking._cloudId || item.booking.id || ''))
          : '';
        toggleCleanAction(idx, cleanIdEsc, bookingIdEsc, item.status);
        const row = document.getElementById('clean-row-' + idx);
        if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      idx++;
    }
    console.log('[StayOps] navigateTodayToClean: clean not in timeline list', cleanId);
  }, 150);
}

// Slide transition helper for calendar/dashboard navigation
function _dashSlideTransition(direction, updateFn) {
  const mount = document.getElementById('dashboard-today-mount');
  if (!mount) { updateFn(); globalThis.renderDashboard?.(); return; }
  const outX = direction === 'next' ? '-40px' : direction === 'prev' ? '40px' : '0';
  const inX = direction === 'next' ? '40px' : direction === 'prev' ? '-40px' : '0';
  mount.style.transition = 'opacity 0.14s ease, transform 0.14s ease';
  mount.style.opacity = '0';
  mount.style.transform = 'translateX(' + outX + ')';
  setTimeout(() => {
    updateFn();
    globalThis.renderDashboard?.();
    mount.style.transition = 'none';
    mount.style.transform = 'translateX(' + inX + ')';
    mount.style.opacity = '0';
    requestAnimationFrame(() => {
      mount.style.transition = 'opacity 0.18s ease, transform 0.18s ease';
      mount.style.opacity = '1';
      mount.style.transform = 'translateX(0)';
    });
  }, 140);
}

globalThis._todayWeekNav = (delta) => {
  _dashSlideTransition(delta > 0 ? 'next' : 'prev', () => {
    if (!_todayWeekStart) _todayWeekStart = _mondayStart(new Date());
    _todayWeekStart.setDate(_todayWeekStart.getDate() + delta * 7);
  });
};

globalThis._todayWeekReset = () => {
  _dashSlideTransition('fade', () => {
    _todayWeekStart = _mondayStart(new Date());
  });
};

function _getTodayCalMonthStart() {
  if (!_todayMonthViewStart) {
    const n = new Date();
    _todayMonthViewStart = new Date(n.getFullYear(), n.getMonth(), 1);
  }
  return _todayMonthViewStart;
}

globalThis._todayCalNav = (delta) => {
  const card = document.getElementById('today-cal-card');
  if (!card) {
    const d = _getTodayCalMonthStart();
    d.setMonth(d.getMonth() + delta);
    globalThis.renderDashboard?.();
    return;
  }
  const outX = delta > 0 ? '-40px' : '40px';
  const inX = delta > 0 ? '40px' : '-40px';
  card.style.transition = 'opacity 0.14s ease, transform 0.14s ease';
  card.style.opacity = '0';
  card.style.transform = 'translateX(' + outX + ')';
  setTimeout(() => {
    const d = _getTodayCalMonthStart();
    d.setMonth(d.getMonth() + delta);
    globalThis.renderDashboard?.();
    const newCard = document.getElementById('today-cal-card');
    if (newCard) {
      newCard.style.transition = 'none';
      newCard.style.transform = 'translateX(' + inX + ')';
      newCard.style.opacity = '0';
      requestAnimationFrame(() => {
        newCard.style.transition = 'opacity 0.18s ease, transform 0.18s ease';
        newCard.style.opacity = '1';
        newCard.style.transform = 'translateX(0)';
      });
    }
  }, 140);
};

globalThis._stayopsSetTodayCalView = (v) => {
  if (v !== 'weekly' && v !== 'monthly') return;
  _dashSlideTransition('fade', () => {
    globalThis._stayopsPrevCalView = v;
    globalThis._stayopsTodayCalView = v;
  });
};

globalThis._stayopsOpenDayView = (dayOffset) => {
  globalThis._stayopsCalSelectedDay = dayOffset;
  globalThis.renderDashboard?.();
};

globalThis._stayopsCloseDayView = () => {
  globalThis._stayopsCalSelectedDay = null;
  globalThis.renderDashboard?.();
};

globalThis._stayopsTodayDayNav = (delta) => {
  _dashSlideTransition(delta > 0 ? 'next' : 'prev', () => {
    globalThis._stayopsCalSelectedDay =
      (globalThis._stayopsCalSelectedDay || 0) + delta;
  });
};

globalThis._stayopsTodayDayReset = () => {
  globalThis._stayopsCalSelectedDay = 0;
  globalThis.renderDashboard?.();
};

globalThis.navigateTodayToClean = navigateTodayToClean;

function computeDedupedTodayAlerts(isPortfolio) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const cloudIds = window._cloudPropertyIds || {};
  const activeBookingsAll = bookings.filter(b => b.status !== 'cancelled');
  const alerts = [];
  const pushAlert = (type, title, subtitle, urgent, cleanId, bookingLocalId, extra) => {
    alerts.push({ type, title, subtitle, urgent, cleanId, bookingLocalId, ...(extra || {}) });
  };
  const inNextDays = (d, n) => {
    const t = parseLocalDayStart(d);
    if (Number.isNaN(t.getTime())) return false;
    const end = new Date(todayStart);
    end.setDate(end.getDate() + n);
    return t >= todayStart && t < end;
  };
  const daysUntil = (d) => {
    const t = parseLocalDayStart(d);
    return Math.ceil((t - todayStart) / 86400000);
  };

  activeBookingsAll.forEach(b => {
    if (!isPortfolio) {
      const cfg = getActivePropertyConfig();
      const pid = cloudIds[cfg.propertyId] || cfg.supabaseId || '';
      if (pid && String(b._propertyId || '') !== String(pid)) return;
    }
    const ci = parseLocalDayStart(b.checkin);
    if (Number.isNaN(ci.getTime())) return;
    const days = daysUntil(b.checkin);
    if (days < 0 || days > 60) return;
    const clean = findMatchingCleanForBooking(b);
    const propName = isPortfolio ? getPropertyNameById(b._propertyId) : getCurrentPropertyName();
    const hasCleaner = !!(clean && (String(clean.cleaner || '').trim() || clean.cleanerId));

    if (!clean || !hasCleaner) {
      const urg = days <= 3;
      pushAlert(
        'b',
        'No cleaner assigned',
        `${propName} · ${b.name} · ${fmtShort(b.checkin)}`,
        urg,
        clean && clean.id != null ? clean.id : null,
        b.id
      );
      return;
    }

    // Only show "Clean not done" if:
    // 1. The CLEAN date (not check-in) is today or in the past — can't be done if it hasn't happened yet
    // 2. Max 3 days overdue — after that it was either done and not marked, or a newer guest has come through
    // 3. No newer completed clean exists at the same property (meaning property has been cleaned since)
    if (clean && !clean.done && hasCleaner) {
      const cleanDate = parseLocalDayStart(clean.date || '');
      const cleanDays = Number.isNaN(cleanDate.getTime()) ? 99 : Math.ceil((cleanDate - todayStart) / 86400000);
      if (cleanDays <= 0 && cleanDays >= -3) {
        // Check if a newer clean at same property was already done — if so, skip this stale one
        const propId = b._propertyId || clean._propertyId;
        const newerCleanDone = propId && cleans.some(other =>
          other.done &&
          other !== clean &&
          String(other._propertyId || '') === String(propId) &&
          other.date && clean.date && other.date > clean.date
        );
        if (!newerCleanDone) {
          const label = cleanDays === 0 ? 'due today' : 'overdue';
          pushAlert(
            'a',
            'Clean not done',
            `${propName} · ${b.name} · ${label}`,
            true,
            clean.id,
            b.id
          );
        }
      }
    }
  });

  // ── Turnover clashes: a checkout time that overlaps (or leaves no gap before)
  //    the same day's check-in at the same property. Next 14 days. ──
  {
    const cfg2 = getActivePropertyConfig();
    const pid2 = cloudIds[cfg2.propertyId] || cfg2.supabaseId || '';
    const scope = isPortfolio || !pid2
      ? activeBookingsAll
      : activeBookingsAll.filter(b => String(b._propertyId || '') === String(pid2));
    findTurnoverClashes(scope).forEach(c => {
      const days = daysUntil(c.date);
      if (days < 0 || days > 14) return;
      const propName2 = isPortfolio ? getPropertyNameById(c.out._propertyId) : getCurrentPropertyName();
      const overlap = c.gapMinutes < 0
        ? 'overlaps by ' + Math.abs(c.gapMinutes) + ' min'
        : 'no cleaning window';
      pushAlert(
        'h',
        'Turnover clash',
        `${propName2} · ${fmtShort(c.date)} · ${c.out.name || 'checkout'} → ${c.in.name || 'check-in'} · ${overlap}`,
        true,
        null,
        c.out.id
      );
    });
  }

  cleans.forEach(c => {
    const bid = c.bookingId;
    const bk = bookings.find(
      x =>
        String(x.id) === String(bid) ||
        (x._cloudId && String(x._cloudId) === String(bid))
    );
    const isCancelled = isCleanLinkedToCancelledBooking(c);

    if (!isPortfolio) {
      const cfg = getActivePropertyConfig();
      const pid = cloudIds[cfg.propertyId] || cfg.supabaseId || '';
      if (bk && pid && String(bk._propertyId || '') !== String(pid)) return;
      if (!bk && c._propertyId && pid && String(c._propertyId) !== String(pid)) return;
    }

    const propName = c._propertyId
      ? getPropertyNameById(c._propertyId)
      : isPortfolio && c.bookingId
        ? getPropertyNameById(bk?._propertyId)
        : getCurrentPropertyName();

    const hasCleaner = !!((c.cleaner && String(c.cleaner).trim()) || c.cleanerId);

    // ── Cancellation: cleaner assigned but not notified ──
    if (isCancelled && hasCleaner && !c.cleanerCancelNotified) {
      const guest = c.guestName || bk?.name || 'Guest';
      const bCloudId = bk ? String(bk._cloudId || bk.id) : '';
      pushAlert(
        'f',
        'Cleaner not notified of cancellation',
        `${propName} · ${String(c.cleaner || '—')} · ${guest}`,
        true,
        c.id,
        null,
        { bookingCloudId: bCloudId }
      );
    }

    if (isCancelled) return;

    const assignedAt = c.assignedAt ? new Date(c.assignedAt) : null;
    const ageH = assignedAt && !Number.isNaN(assignedAt.getTime())
      ? (now - assignedAt) / 3600000
      : 0;

    // ── Cleaner assigned but never notified (skip if already confirmed) ──
    if (hasCleaner && !c.notified && !c.cleanerConfirmed && !c.done && c.date && inNextDays(c.date, 14)) {
      const dleft = daysUntil(c.date);
      pushAlert(
        'g',
        'Cleaner not notified',
        `${propName} · ${String(c.cleaner || '—')} · ${fmtShort(c.date)}`,
        dleft <= 3,
        c.id,
        null
      );
    }

    // ── No response from cleaner (>12h, within next 14 days) ──
    if (
      hasCleaner &&
      !c.cleanerConfirmed &&
      !c.cleanerDeclined &&
      !c.done &&
      ageH > 12 &&
      c.date && inNextDays(c.date, 14)
    ) {
      const cd = parseLocalDayStart(c.date);
      const dleft = Number.isNaN(cd.getTime()) ? 99 : Math.ceil((cd - todayStart) / 86400000);
      const urg = dleft <= 3;
      pushAlert(
        'c',
        'No cleaner response',
        `${propName} · ${String(c.cleaner || '—')} · ${fmtShort(c.date)}`,
        urg,
        c.id,
        null
      );
    }

    // ── Cleaner declined — needs reassignment ──
    if (c.cleanerDeclined && !c.done && c.date && inNextDays(c.date, 7)) {
      const guest = c.guestName || 'Guest';
      const urg = daysUntil(c.date) <= 3;
      pushAlert(
        'd',
        'Cleaner declined',
        `${propName} · ${guest} · needs reassignment`,
        urg,
        c.id,
        null
      );
    }

    // ── Review cleaning cost — done cleans in last 7 days with no fee ──
    if (c.done && c.date) {
      const cd = parseLocalDayStart(c.date);
      const daysSince = Number.isNaN(cd.getTime()) ? 99 : Math.ceil((todayStart - cd) / 86400000);
      if (daysSince >= 0 && daysSince <= 7) {
        if (bk && !Number(bk.cleaningFee)) {
          pushAlert(
            'e',
            'Review cleaning cost',
            `${propName} · ${c.guestName || bk.name || 'Guest'} · cleaned ${fmtShort(c.date)}`,
            false,
            c.id,
            bk.id
          );
        }
      }
    }
  });

  const seen = new Set();
  const deduped = [];
  alerts.forEach(a => {
    const k = `${a.type}-${a.cleanId || ''}-${a.bookingLocalId || ''}-${a.title}`;
    if (seen.has(k)) return;
    seen.add(k);
    deduped.push(a);
  });
  deduped.sort((x, y) => (x.urgent === y.urgent ? 0 : x.urgent ? -1 : 1));
  return deduped;
}

function buildNeedsAttentionHtmlFromDeduped(deduped) {
  if (!deduped.length) {
    return `<div style="background:#EFF5EE;border-left:3px solid #4F7A4A;border-radius:6px;padding:10px 14px;margin-bottom:14px;display:flex;align-items:center;gap:8px">
        <div style="width:6px;height:6px;border-radius:50%;background:#4F7A4A;flex-shrink:0"></div>
        <div style="font-size:12px;font-weight:500;color:#2F5A2A">All clear today</div>
      </div>`;
  }
  const cards = deduped
    .map(a => {
      const dot = a.urgent ? '#E24B4A' : '#BA7517';
      let onclk;
      if ((a.type === 'e' || a.type === 'h') && a.bookingLocalId != null) {
        const bk = bookings.find(x => String(x.id) === String(a.bookingLocalId));
        const bidEsc = escapeJsSingleQuotedHtmlAttr(String(bk ? bk._cloudId || bk.id : a.bookingLocalId));
        onclk = `onclick="showDetail('${bidEsc}')"`;
      } else if (a.type === 'b' && a.bookingLocalId != null) {
        const bk = bookings.find(x => String(x.id) === String(a.bookingLocalId));
        const bidEsc = escapeJsSingleQuotedHtmlAttr(String(bk ? bk._cloudId || bk.id : a.bookingLocalId));
        onclk = `onclick="jumpToAssignClean('${bidEsc}')"`;
      } else if (a.cleanId != null) {
        const cid = escapeJsSingleQuotedHtmlAttr(String(a.cleanId));
        onclk = `onclick="navigateTodayToClean('${cid}')"`;
      } else {
        onclk = `onclick="showSection('cleaning')"`;
      }
      // Action button for cancellation alerts
      let actionBtn = '';
      if (a.type === 'f') {
        const bIdEsc = escapeJsSingleQuotedHtmlAttr(a.bookingCloudId);
        const cIdEsc = a.cleanId != null ? escapeJsSingleQuotedHtmlAttr(String(a.cleanId)) : '';
        actionBtn = `<button onclick="event.stopPropagation();notifyCancelledCleaner(this,'${bIdEsc}','${cIdEsc}')" style="flex-shrink:0;background:#C0392B;color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;touch-action:manipulation">Notify</button>`;
      }

      return `<div ${onclk} style="background:white;border-radius:8px;padding:10px 12px;margin-bottom:6px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:10px;touch-action:manipulation;-webkit-tap-highlight-color:rgba(0,0,0,0.06)">
          <div style="display:flex;align-items:flex-start;gap:8px;min-width:0;flex:1">
            <div style="width:6px;height:6px;border-radius:50%;background:${dot};margin-top:5px;flex-shrink:0"></div>
            <div style="min-width:0">
              <div style="font-weight:700;font-size:14px;color:#412402">${escHtml(a.title)}</div>
              <div style="font-size:11px;color:#854F0B;margin-top:2px;line-height:1.35">${escHtml(a.subtitle)}</div>
            </div>
          </div>
          ${actionBtn || '<div style="font-size:18px;color:#854F0B;flex-shrink:0">›</div>'}
        </div>`;
    })
    .join('');
  const moreCount = deduped.length > 3 ? deduped.length - 3 : 0;
  const moreFooter =
    moreCount > 0
      ? `<div style="text-align:center;font-size:11px;color:#854F0B;margin-top:8px;padding-top:6px;border-top:1px solid rgba(133,79,11,0.12)">${moreCount} more</div>`
      : '';
  const badge = `<span style="background:#BA7517;color:#fff;font-size:11px;font-weight:700;border-radius:10px;padding:2px 8px;min-width:18px;text-align:center;line-height:1.4">${deduped.length}</span>`;
  return `<div style="background:#FEF3E7;border-left:4px solid #BA7517;border-radius:6px;padding:12px 14px;margin-bottom:14px;box-shadow:0 1px 3px rgba(186,117,23,0.08)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="font-size:13px;font-weight:700;color:#412402;letter-spacing:0.2px">Needs your attention</div>
        ${badge}
      </div>
      <div style="max-height:400px;overflow-y:auto;-webkit-overflow-scrolling:touch;padding-right:2px">${cards}</div>
      ${moreFooter}
    </div>`;
}

function buildWeeklyTimelineRowsHtml(propertyRows, weekStart, weekEnd, weekMs, tertiary, primary, activeBookings, hidePropertyLabel) {
  return propertyRows
    .map(row => {
      const propBookings = activeBookings.filter(b => {
        if (!b.checkin || !b.checkout) return false;
        if (row.pid && String(b._propertyId || '') !== String(row.pid)) return false;
        const ci = parseLocalDayStart(b.checkin);
        const co = parseLocalDayStart(b.checkout);
        if (Number.isNaN(ci.getTime()) || Number.isNaN(co.getTime())) return false;
        return co > weekStart && ci < weekEnd;
      });

      const isDayOccupied = (dayIndex) => {
        const d = new Date(weekStart);
        d.setDate(d.getDate() + dayIndex);
        for (const b of propBookings) {
          const ci = parseLocalDayStart(b.checkin);
          const co = parseLocalDayStart(b.checkout);
          if (d >= ci && d < co) return true;
        }
        return false;
      };

      const vacantBars = [];
      let vi = 0;
      while (vi < 7) {
        if (isDayOccupied(vi)) {
          vi++;
          continue;
        }
        let vj = vi;
        while (vj < 7 && !isDayOccupied(vj)) vj++;
        const leftPct = (vi / 7) * 100;
        const widthPct = ((vj - vi) / 7) * 100;
        vacantBars.push(
          `<div style="position:absolute;top:0;left:${leftPct}%;width:${Math.max(widthPct, 0.35)}%;height:22px;background:#F1EFE8;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:10px;color:${tertiary};z-index:0;box-sizing:border-box;pointer-events:none">Vacant</div>`
        );
        vi = vj;
      }

      const bars = propBookings
        .map(b => {
          const ci = parseLocalDayStart(b.checkin);
          const co = parseLocalDayStart(b.checkout);
          const stayStart = new Date(Math.max(ci.getTime(), weekStart.getTime()));
          const stayEnd = new Date(Math.min(co.getTime(), weekEnd.getTime()));
          if (stayEnd <= stayStart) return '';
          const leftPct = ((stayStart - weekStart) / weekMs) * 100;
          const widthPct = ((stayEnd - stayStart) / weekMs) * 100;
          const nm = String(b.name || '').trim().split(/\s+/);
          const guestShort = nm.length ? (nm[0].length > 12 ? nm[0].slice(0, 11) + '…' : nm[0]) : 'Guest';
          const bid = escapeJsSingleQuotedHtmlAttr(String(b._cloudId || b.id));
          return `<div onclick="event.stopPropagation();showDetail('${bid}')" style="position:absolute;top:0;height:22px;left:${leftPct}%;width:${Math.max(widthPct, 0.5)}%;background:${row.palette.bg};border-left:3px solid ${row.palette.border};border-radius:4px;display:flex;align-items:center;padding:0 6px;overflow:hidden;box-sizing:border-box;cursor:pointer;pointer-events:auto;z-index:1">
            <span style="font-size:10px;font-weight:500;color:${row.palette.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(guestShort)}</span>
          </div>`;
        })
        .join('');

      const track = `<div style="flex:1;position:relative;min-height:22px">
          <div style="position:absolute;inset:0;z-index:0;pointer-events:none">${vacantBars.join('')}</div>
          <div style="position:absolute;inset:0;z-index:1;pointer-events:none">${bars}</div>
        </div>`;

      if (hidePropertyLabel) {
        return `<div style="display:flex;align-items:stretch;margin-bottom:8px">${track}</div>`;
      }
      return `<div style="display:flex;align-items:stretch;margin-bottom:8px">
        <div style="width:60px;flex-shrink:0;padding-right:6px;display:flex;align-items:center;gap:5px;min-width:0">
          <div style="width:6px;height:6px;border-radius:50%;background:${row.palette.border};flex-shrink:0"></div>
          <span style="font-size:11px;color:${primary};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(row.name)}</span>
        </div>
        ${track}
      </div>`;
    })
    .join('');
}

function buildStayopsUnifiedTodayCalendarHtml({
  activePid,
  activeBookings,
  todayStart,
  tertiary,
  primary,
}) {
  const selectedDay = globalThis._stayopsCalSelectedDay;

  const cleanForPropertyOnDate = (dayStr) =>
    cleans.find((c) => {
      if (c.done || isCleanLinkedToCancelledBooking(c)) return false;
      if (String(c.date || '').slice(0, 10) !== dayStr) return false;
      const bk =
        c.bookingId &&
        bookings.find(
          (x) =>
            String(x.id) === String(c.bookingId) ||
            (x._cloudId && String(x._cloudId) === String(c.bookingId))
        );
      if (bk) return String(bk._propertyId || '') === String(activePid);
      return !c._propertyId || String(c._propertyId) === String(activePid);
    });

  const maintListForDate = (dayStr) =>
    maintenance.filter((m) => {
      if (m.status !== 'open' && m.status !== 'inprogress') return false;
      if (activePid && m._propertyId && String(m._propertyId) !== String(activePid))
        return false;
      const ds = String(m.scheduledDate || m.date || '').slice(0, 10);
      return ds === dayStr;
    });

  // ── Month grid ──
  const calM = _getTodayCalMonthStart();
  const calYear = calM.getFullYear();
  const calMonth = calM.getMonth();
  const calMonthName = calM.toLocaleString('en-AU', { month: 'long', year: 'numeric' });
  const firstJsDow = new Date(calYear, calMonth, 1).getDay();
  const gridStart = new Date(calYear, calMonth, 1 - firstJsDow);
  const calHeader = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
    .map(
      (h) =>
        `<div style="text-align:center;font-size:10px;font-weight:600;color:${tertiary};padding:4px 0">${h}</div>`
    )
    .join('');

  const _calPlatformColor = (platform) => {
    const p = String(platform || '').toLowerCase();
    if (p.includes('airbnb')) return { bg: '#FFDADA', dot: '#E04E52', text: '#C0392B' };
    if (p.includes('vrbo') || p.includes('homeaway')) return { bg: '#D5D8F0', dot: '#6B73B5', text: '#3B5998' };
    if (p.includes('booking')) return { bg: '#C8D8F0', dot: '#4A78B0', text: '#1A3B6E' };
    return { bg: '#C8E6C9', dot: '#4A9A6A', text: '#2D5A3D' };
  };

  const selDate = selectedDay != null ? new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate() + selectedDay) : null;
  const selYmd = selDate ? _ymd(selDate) : null;

  const barH = 18;
  const barGap = 2;
  const pillH = 16;
  const pillGap = 1;
  const barTopBase = 22;

  // Assign booking lanes for vertical stacking
  const sortedBookings = activeBookings
    .filter(b => b.checkin && b.checkout && b.status !== 'cancelled')
    .sort((a, b) => parseLocalDayStart(a.checkin) - parseLocalDayStart(b.checkin));
  const bookingLanes = new Map();
  const laneEnds = [];
  sortedBookings.forEach(b => {
    const ci = parseLocalDayStart(b.checkin);
    let lane = 0;
    while (lane < laneEnds.length && laneEnds[lane] > ci.getTime()) lane++;
    if (lane >= laneEnds.length) laneEnds.push(0);
    laneEnds[lane] = parseLocalDayStart(b.checkout).getTime();
    bookingLanes.set(b, lane);
  });
  const maxLanes = laneEnds.length || 1;

  // Count max per-cell pills (cleans+maintenance) to size cells
  let maxCellPills = 0;
  for (let c = 0; c < 42; c++) {
    const cellDate = new Date(gridStart);
    cellDate.setDate(gridStart.getDate() + c);
    if (cellDate.getMonth() !== calMonth || cellDate.getFullYear() !== calYear) continue;
    const ymd = _ymd(cellDate);
    let count = 0;
    if (cleanForPropertyOnDate(ymd)) count++;
    count += maintListForDate(ymd).length;
    if (count > maxCellPills) maxCellPills = count;
  }
  const pillZoneH = maxCellPills > 0 ? maxCellPills * (pillH + pillGap) + 2 : 0;
  const dynamicCellH = barTopBase + maxLanes * (barH + barGap) + pillZoneH + 6;

  let calCells = '';
  for (let c = 0; c < 42; c++) {
    const cellDate = new Date(gridStart);
    cellDate.setDate(gridStart.getDate() + c);
    const inMonth = cellDate.getMonth() === calMonth && cellDate.getFullYear() === calYear;
    const dayNum = cellDate.getDate();
    const ymdStr = _ymd(cellDate);
    const isTodayCell = ymdStr === _ymd(todayStart);
    const isSelected = ymdStr === selYmd;
    const numColor = inMonth ? primary : tertiary;
    const numStyle = isTodayCell
      ? `width:22px;height:22px;border-radius:50%;background:#2D5A3D;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700`
      : isSelected
        ? `width:22px;height:22px;border-radius:50%;background:#E6F1FB;color:#0C447C;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700`
        : `font-size:11px;color:${numColor};font-weight:500;opacity:${inMonth ? 1 : 0.4}`;

    // Build per-cell event pills for cleans & maintenance (positioned below booking bars)
    let cellPills = '';
    if (inMonth) {
      const pillTop = barTopBase + maxLanes * (barH + barGap);
      const pills = [];
      const cl = cleanForPropertyOnDate(ymdStr);
      if (cl) {
        const clLabel = cl.done ? 'Done' : (cl.cleaner ? escHtml(cl.cleaner.split(' ')[0]) : 'Clean');
        const clDot = cl.done ? '#00897B' : '#1565C0';
        const clBg = cl.done ? '#E0F2F1' : '#E3F2FD';
        const clText = cl.done ? '#00695C' : '#0D47A1';
        pills.push(`<div style="position:absolute;top:${pillTop + pills.length * (pillH + pillGap)}px;left:1px;right:1px;height:${pillH}px;background:${clBg};border-radius:3px;display:flex;align-items:center;gap:3px;padding:0 3px;overflow:hidden;z-index:2"><span style="width:6px;height:6px;border-radius:50%;background:${clDot};flex-shrink:0"></span><span style="font-size:8px;font-weight:600;color:${clText};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${clLabel}</span></div>`);
      }
      maintListForDate(ymdStr).forEach(mt => {
        pills.push(`<div style="position:absolute;top:${pillTop + pills.length * (pillH + pillGap)}px;left:1px;right:1px;height:${pillH}px;background:#FFF3E0;border-radius:3px;display:flex;align-items:center;gap:3px;padding:0 3px;overflow:hidden;z-index:2"><span style="width:6px;height:6px;border-radius:50%;background:#EF6C00;flex-shrink:0"></span><span style="font-size:8px;font-weight:600;color:#E65100;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml((mt.description || 'Maint.').slice(0, 10))}</span></div>`);
      });
      cellPills = pills.join('');
    }

    const dayClickOffset = Math.round((cellDate.getTime() - todayStart.getTime()) / 86400000);
    calCells += `<div onclick="_stayopsOpenDayView(${dayClickOffset})" style="position:relative;text-align:center;padding:2px 0 0;height:${dynamicCellH}px;box-sizing:border-box;cursor:pointer;border-top:0.5px solid rgba(0,0,0,0.06)">
      <span style="${numStyle}">${dayNum}</span>${cellPills}
    </div>`;
  }

  // Continuous booking bars as absolute overlays (iOS-style with dot prefix)
  const gridStartMs = gridStart.getTime();
  const dayMs = 86400000;
  const colW = 100 / 7;
  const bookingOverlays = sortedBookings.map(b => {
    const ci = parseLocalDayStart(b.checkin);
    const co = parseLocalDayStart(b.checkout);
    if (Number.isNaN(ci.getTime()) || Number.isNaN(co.getTime())) return '';
    let startIdx = Math.round((ci.getTime() - gridStartMs) / dayMs);
    const rawEndIdx = Math.round((co.getTime() - gridStartMs) / dayMs);
    // Include checkout day as partial (10am checkout ≈ 42% of cell)
    let endIdx = rawEndIdx + 1;
    if (endIdx <= 0 || startIdx >= 42) return '';
    startIdx = Math.max(0, startIdx);
    endIdx = Math.min(42, endIdx);
    const lane = bookingLanes.get(b) || 0;
    const pc = _calPlatformColor(b.platform);
    const bidEsc = escapeJsSingleQuotedHtmlAttr(String(b._cloudId || b.id));
    const guestLabel = escHtml((b.name || 'Guest').split(' ')[0]);
    const bars = [];
    let idx = startIdx;
    while (idx < endIdx) {
      const row = Math.floor(idx / 7);
      const colStart = idx % 7;
      const colEnd = Math.min(7, colStart + (endIdx - idx));
      const span = colEnd - colStart;
      // Offset first cell to ~63% for 3pm check-in, shrink last cell to ~42% for 10am checkout
      const isFirstSegment = idx === startIdx;
      const isLastSegment = (idx + span) >= endIdx;
      const checkinFraction = 0.63;
      const lastCellFraction = 0.42;
      const leftOffset = (isFirstSegment && idx === startIdx) ? colW * checkinFraction : 0;
      const left = colStart * colW + leftOffset;
      let width = span * colW - leftOffset;
      if (isLastSegment && span > 0) {
        width = span * colW - leftOffset - colW * (1 - lastCellFraction);
      }
      const top = row * dynamicCellH + barTopBase + lane * (barH + barGap);
      const isStart = idx === startIdx;
      const isEnd = isLastSegment;
      const rLeft = isStart ? '4px' : '0';
      const rRight = isEnd ? '4px' : '0';
      bars.push(
        `<div onclick="event.stopPropagation();showDetail('${bidEsc}')" style="position:absolute;top:${top}px;left:calc(${left}% + 1px);width:calc(${width}% - 2px);height:${barH}px;background:${pc.bg};border-radius:${rLeft} ${rRight} ${rRight} ${rLeft};display:flex;align-items:center;gap:3px;padding:0 4px;cursor:pointer;z-index:2;box-sizing:border-box;overflow:hidden">` +
        (isStart ? `<span style="width:7px;height:7px;border-radius:50%;background:${pc.dot};flex-shrink:0"></span>` : '') +
        (isStart ? `<span style="font-size:9px;font-weight:700;color:${pc.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${guestLabel}</span>` : '') +
        `</div>`
      );
      idx += span;
    }
    return bars.join('');
  }).join('');

  // ── Inline day detail (iOS-style timeline with times) ──
  let dayDetailHtml = '';
  if (selDate) {
    const ds = selYmd;
    const headLine = `${selDate.toLocaleDateString('en-AU', { weekday: 'long' })}, ${selDate.getDate()} ${selDate.toLocaleDateString('en-AU', { month: 'long' })}`;

    // Collect events with times for chronological ordering
    const events = []; // { time: 'HH:MM', sortKey: number, html: string }

    const timeRow = (time, color, title, sub, dotColor) =>
      `<div style="display:flex;gap:12px;align-items:flex-start;padding:8px 0;border-bottom:0.5px solid rgba(0,0,0,0.05)">
        <div style="width:48px;flex-shrink:0;text-align:right;padding-top:1px">
          <span style="font-size:12px;font-weight:600;color:${tertiary}">${time}</span>
        </div>
        <div style="width:4px;flex-shrink:0;position:relative;display:flex;flex-direction:column;align-items:center">
          <span style="width:8px;height:8px;border-radius:50%;background:${dotColor};flex-shrink:0;margin-top:4px"></span>
          <span style="width:1px;flex:1;background:rgba(0,0,0,0.08)"></span>
        </div>
        <div style="flex:1;min-width:0;padding-bottom:4px">
          <div style="font-size:13px;font-weight:600;color:${color}">${title}</div>
          ${sub ? `<div style="font-size:12px;color:var(--muted-2);margin-top:2px">${sub}</div>` : ''}
        </div>
      </div>`;

    const coutB = activeBookings.find((b) => String(b.checkout || '').slice(0, 10) === ds);
    if (coutB) {
      events.push({ sortKey: 1000, html: timeRow('10 AM', '#A32D2D', 'Check-out', escHtml(coutB.name), '#E24B4A') });
      const mc = findMatchingCleanForBooking(coutB);
      const hasCl = !!(mc && (String(mc.cleaner || '').trim() || mc.cleanerId));
      if (mc && !mc.done) {
        events.push({ sortKey: 1100, html: timeRow('11 AM', '#A32D2D', 'Clean not done',
          escHtml(mc.cleaner || 'Unassigned'), '#E24B4A') });
      } else if (mc && mc.done) {
        events.push({ sortKey: 1100, html: timeRow('11 AM', '#1D9E75', 'Clean complete',
          escHtml(mc.cleaner || 'Cleaner'), '#1D9E75') });
      } else if (!hasCl) {
        events.push({ sortKey: 1100, html: timeRow('11 AM', '#BA7517', 'Clean needed',
          'No cleaner assigned', '#BA7517') });
      }
    }

    const cinB = activeBookings.find((b) => String(b.checkin || '').slice(0, 10) === ds);
    if (cinB) {
      const guestInfo = cinB.guests ? ` · ${escHtml(String(cinB.guests))} guest${cinB.guests === 1 ? '' : 's'}` : '';
      events.push({ sortKey: 1500, html: timeRow('3 PM', '#1D6B3D', 'Check-in',
        escHtml(cinB.name) + guestInfo, '#1D9E75') });
    }

    const clOnly = cleanForPropertyOnDate(ds);
    if (clOnly && (!coutB || findMatchingCleanForBooking(coutB)?.id !== clOnly.id)) {
      const clAssigned = !!((clOnly.cleaner && String(clOnly.cleaner).trim()) || clOnly.cleanerId);
      if (clOnly.done) {
        events.push({ sortKey: 1100, html: timeRow('11 AM', '#1D9E75', 'Clean complete', escHtml(clOnly.cleaner || 'Cleaner'), '#1D9E75') });
      } else if (clAssigned) {
        events.push({ sortKey: 1100, html: timeRow('11 AM', '#0D47A1', 'Clean scheduled', escHtml(clOnly.cleaner || 'Cleaner'), '#0D47A1') });
      } else {
        events.push({ sortKey: 1100, html: timeRow('11 AM', '#BA7517', 'Clean needed', 'No cleaner assigned', '#BA7517') });
      }
    }

    if (!cinB && !coutB) {
      const occ = activeBookings.find((b) => {
        const ci = parseLocalDayStart(b.checkin);
        const co = parseLocalDayStart(b.checkout);
        const d0 = new Date(selDate.getFullYear(), selDate.getMonth(), selDate.getDate());
        if (Number.isNaN(ci.getTime()) || Number.isNaN(co.getTime())) return false;
        return d0 >= ci && d0 < co;
      });
      if (occ) {
        const ci = parseLocalDayStart(occ.checkin);
        const n = Math.max(1, Math.floor((selDate.getTime() - ci.getTime()) / 86400000) + 1);
        events.push({ sortKey: 0, html: timeRow('all day', '#3D6B4F', 'Stay in progress',
          `${escHtml(occ.name)} · night ${n}`, '#92C9A9') });
      }
    }

    maintListForDate(ds).forEach((mt) => {
      events.push({ sortKey: 900, html: timeRow('9 AM', '#7A5A00', escHtml(mt.description || 'Maintenance'),
        escHtml(fmt(mt.date || mt.scheduledDate || '')), '#D4A017') });
    });

    events.sort((a, b) => a.sortKey - b.sortKey);

    const emptyHint = !events.length
      ? `<div style="font-size:13px;color:var(--muted-2);text-align:center;padding:12px 8px">No events</div>`
      : '';

    dayDetailHtml = `<div style="margin-top:10px;padding-top:10px;border-top:0.5px solid rgba(0,0,0,0.1)">
      <div style="font-size:15px;font-weight:700;color:${primary};margin-bottom:10px">${headLine}</div>
      ${events.map(e => e.html).join('')}${emptyHint}
    </div>`;
  }

  return (
    `<div id="today-cal-card" style="background:white;border-radius:12px;border:0.5px solid rgba(0,0,0,0.1);padding:10px 12px;margin-bottom:14px;box-sizing:border-box">` +
    `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px">` +
    `<span style="font-size:16px;font-weight:700;color:${primary}">${escHtml(calMonthName)}</span>` +
    `<div style="display:flex;align-items:center;gap:4px">` +
    `<button type="button" onclick="_todayCalNav(-1)" style="background:var(--hairline-2);border:none;border-radius:8px;width:32px;height:32px;font-size:16px;cursor:pointer;color:${primary}">‹</button>` +
    `<button type="button" onclick="_todayCalNav(1)" style="background:var(--hairline-2);border:none;border-radius:8px;width:32px;height:32px;font-size:16px;cursor:pointer;color:${primary}">›</button>` +
    `</div></div>` +
    `<div style="border-radius:8px;overflow:hidden">` +
    `<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:0;margin-bottom:2px">${calHeader}</div>` +
    `<div style="position:relative;display:grid;grid-template-columns:repeat(7,1fr);gap:0">${calCells}${bookingOverlays}</div>` +
    `</div>` +
    dayDetailHtml +
    `</div>`
  );
}

function buildSinglePropertyTodayDashboardMarkup() {
  const tertiary = '#6B6560';
  const primary = 'var(--ink-1)';
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const cloudIds = window._cloudPropertyIds || {};
  const cfg = getActivePropertyConfig();
  const activePid = String(
    cloudIds[getActivePropertyId()] || cloudIds[cfg.propertyId] || cfg.supabaseId || ''
  );

  const activeBookingsAll = bookings.filter(b => b.status !== 'cancelled');
  const activeBookings = activePid
    ? activeBookingsAll.filter(b => String(b._propertyId || '') === String(activePid))
    : activeBookingsAll.slice();
  const revenueBookings = activePid
    ? bookings.filter(b => String(b._propertyId || '') === String(activePid))
    : bookings.slice();

  const next30End = new Date(todayStart);
  next30End.setDate(next30End.getDate() + 30);
  const thisMonth = now.getMonth();
  const thisYear = now.getFullYear();
  const daysThisMonth = new Date(thisYear, thisMonth + 1, 0).getDate();
  const monthStart = new Date(thisYear, thisMonth, 1);
  const monthEnd = new Date(thisYear, thisMonth + 1, 1);
  let bookedNightsMonth = 0;
  activeBookings.forEach(b => {
    if (!b.checkin || !b.checkout) return;
    const ci = new Date(Math.max(new Date(b.checkin).getTime(), monthStart.getTime()));
    const co = new Date(Math.min(new Date(b.checkout).getTime(), monthEnd.getTime()));
    if (co > ci) bookedNightsMonth += Math.round((co - ci) / 86400000);
  });
  const occupancyThisMonth = Math.max(0, Math.min(100, Math.round((bookedNightsMonth / daysThisMonth) * 100)));

  const revenueThisMonth = revenueBookings
    .filter(b => {
      const ci = parseLocalDayStart(b.checkin);
      return !Number.isNaN(ci.getTime()) && ci >= monthStart && ci < monthEnd;
    })
    .reduce((s, b) => s + bookingRevenue(b), 0);

  const revenueNext30 = revenueBookings
    .filter(b => {
      const ci = parseLocalDayStart(b.checkin);
      return !Number.isNaN(ci.getTime()) && ci >= todayStart && ci < next30End;
    })
    .reduce((s, b) => s + bookingRevenue(b), 0);

  let statusHtml;
  // Turnover is time-of-day aware AND per-booking: each booking carries its own
  // checkout/check-in time (getTurnoverTimes(booking)) so a guest granted a late
  // checkout is still "in" until their own time. Defaults to 10:00 / 15:00.
  const nowMs = now.getTime();
  const dashTodayStr = localDateStr(now);
  const bookingAt = (dateStr, h, m) => {
    const d = parseLocalDayStart(dateStr);
    if (Number.isNaN(d.getTime())) return null;
    d.setHours(h, m, 0, 0);
    return d;
  };
  const checkoutMoment = b => { const t = getTurnoverTimes(b); return bookingAt(b.checkout, t.checkoutHour, t.checkoutMin); };
  const checkinMoment = b => { const t = getTurnoverTimes(b); return bookingAt(b.checkin, t.checkinHour, t.checkinMin); };
  const occBar = (labelColor, label, detail, tinted) =>
    `<div style="background:${tinted ? 'var(--primary-soft)' : 'var(--surface2)'};border-radius:12px;padding:10px 14px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap${tinted ? '' : ';border:1px solid var(--hairline-1)'}">` +
    `<span style="color:${labelColor};font-weight:600;font-size:13px">${label}</span>` +
    `<span style="color:var(--muted-2);font-size:12px;text-align:right">${detail}</span>` +
    `</div>`;

  // Who is physically in the property right now?
  const occupantNow = activeBookings.find(b => {
    if (b.status === 'cancelled') return false;
    const ci = checkinMoment(b);
    const co = checkoutMoment(b);
    return ci && co && ci.getTime() <= nowMs && nowMs < co.getTime();
  });
  if (occupantNow) {
    const leavesToday = String(occupantNow.checkout || '').slice(0, 10) === dashTodayStr;
    const coLabel = leavesToday ? `checkout today ${getTurnoverTimes(occupantNow).checkoutLabel}` : `checkout ${escHtml(fmtShort(occupantNow.checkout))}`;
    statusHtml = occBar('var(--primary)', 'Occupied', `${escHtml(occupantNow.name)} · ${coLabel}`, true);
  } else {
    const departedToday = activeBookings.some(b =>
      b.status !== 'cancelled' && String(b.checkout || '').slice(0, 10) === dashTodayStr
    );
    const upcoming = [...activeBookings]
      .filter(b => {
        const ci = checkinMoment(b);
        return ci && ci.getTime() > nowMs;
      })
      .sort((a, b) => parseLocalDayStart(a.checkin) - parseLocalDayStart(b.checkin));
    const nextGuest = upcoming[0];
    const arrivesToday = nextGuest && String(nextGuest.checkin || '').slice(0, 10) === dashTodayStr;
    if (departedToday && arrivesToday) {
      // Between checkout and the next check-in on a turnover day.
      statusHtml = occBar('var(--primary)', 'Being cleaned', `ready by ${getTurnoverTimes(nextGuest).checkinLabel} · ${escHtml(nextGuest.name)}`, true);
    } else if (nextGuest) {
      // Round (not ceil) so a DST fall-back day (25h) doesn't read as one day too many.
      const days = Math.round((parseLocalDayStart(nextGuest.checkin) - todayStart) / 86400000);
      const when = arrivesToday ? `arrives ${getTurnoverTimes(nextGuest).checkinLabel}` : `next guest in ${days} day${days === 1 ? '' : 's'}`;
      statusHtml = occBar('var(--ink-2)', 'Vacant', `${when} · ${escHtml(nextGuest.name)}`, false);
    } else {
      statusHtml = occBar('var(--ink-2)', 'Vacant', 'No upcoming bookings', false);
    }
  }

  const deduped = computeDedupedTodayAlerts(false);
  const needsHtml = buildNeedsAttentionHtmlFromDeduped(deduped);

  const unifiedCalHtml = buildStayopsUnifiedTodayCalendarHtml({
    activePid,
    activeBookings,
    todayStart,
    tertiary,
    primary,
  });

  const statsHtml = `
  <div style="margin-top:18px">
    <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px">
      <div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--muted-2);letter-spacing:1px;text-transform:uppercase">Performance</div>
      <div style="font-size:12px;color:var(--primary);font-weight:600">This month</div>
    </div>
    <div class="dashboard-stat-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
      <div style="background:white;border-radius:16px;padding:14px;border:1px solid var(--hairline-1)">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="width:8px;height:8px;border-radius:50%;background:var(--primary-soft);border:1.5px solid var(--hairline-1)"></div>
          <div style="font-size:11px;font-family:'JetBrains Mono',monospace;letter-spacing:0.5px;color:var(--muted-2);text-transform:uppercase">Occupancy</div>
        </div>
        <div style="margin-top:8px;font-size:24px;font-weight:600;font-family:'Newsreader',serif;color:var(--ink-1);letter-spacing:-0.5px">${occupancyThisMonth}%</div>
        <div style="font-size:11px;color:var(--muted-2);margin-top:2px">${bookedNightsMonth}/${daysThisMonth} nights booked</div>
      </div>
      <div style="background:white;border-radius:16px;padding:14px;border:1px solid var(--hairline-1)">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="width:8px;height:8px;border-radius:50%;background:var(--accent-soft);border:1.5px solid var(--hairline-1)"></div>
          <div style="font-size:11px;font-family:'JetBrains Mono',monospace;letter-spacing:0.5px;color:var(--muted-2);text-transform:uppercase">Revenue</div>
        </div>
        <div style="margin-top:8px;font-size:24px;font-weight:600;font-family:'Newsreader',serif;color:var(--ink-1);letter-spacing:-0.5px">$${Math.round(revenueThisMonth).toLocaleString()}</div>
        <div style="font-size:11px;color:var(--muted-2);margin-top:2px">Net of fees</div>
      </div>
    </div>
  </div>`;

  const sparklineHtml = (() => {
    if (!activeBookings.length) return '';
    const weeks = 12;
    const counts = new Array(weeks).fill(0);
    const weekMs = 7 * 86400000;
    const endDate = new Date(todayStart);
    endDate.setDate(endDate.getDate() + 7);
    const startDate = new Date(endDate.getTime() - weeks * weekMs);
    activeBookings.forEach(b => {
      const ci = parseLocalDayStart(b.checkin);
      if (Number.isNaN(ci.getTime())) return;
      const off = ci.getTime() - startDate.getTime();
      if (off < 0 || off >= weeks * weekMs) return;
      counts[Math.floor(off / weekMs)]++;
    });
    const maxC = Math.max(...counts, 1);
    const w = 320, h = 80, pad = 6;
    const pts = counts.map((c, i) => {
      const x = Math.round((i / (weeks - 1)) * w);
      const y = Math.round(pad + (h - pad * 2) * (1 - c / maxC));
      return [x, y];
    });
    const line = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0] + ' ' + p[1]).join(' ');
    const area = line + ' L' + w + ' ' + h + ' L0 ' + h + ' Z';
    const last = pts[pts.length - 1];
    const startLabel = startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
    const endLabel = todayStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
    return `<div style="margin-top:18px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px">
        <div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--muted-2);letter-spacing:1px;text-transform:uppercase">Bookings · 12 weeks</div>
        <span onclick="showSection('bookings')" style="font-size:12px;color:var(--primary);cursor:pointer;font-weight:600">View report</span>
      </div>
      <div style="background:white;border-radius:18px;padding:18px;border:1px solid var(--hairline-1)">
        <svg viewBox="0 0 ${w} ${h + 10}" style="width:100%;height:${h + 10}px;display:block">
          <defs><linearGradient id="sparkG" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--primary)" stop-opacity="0.25"/><stop offset="1" stop-color="var(--primary)" stop-opacity="0"/></linearGradient></defs>
          <path d="${area}" fill="url(#sparkG)"/>
          <path d="${line}" stroke="var(--primary)" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="${last[0]}" cy="${last[1]}" r="4" fill="var(--primary)"/>
        </svg>
        <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:10px;font-family:'JetBrains Mono',monospace;color:var(--muted-2);letter-spacing:0.4px">
          <span>${startLabel}</span><span>${endLabel}</span>
        </div>
      </div>
    </div>`;
  })();

  const quickActionIcon = (svgPath) =>
    `<div style="width:36px;height:36px;border-radius:10px;background:var(--primary-soft);margin:0 auto;display:flex;align-items:center;justify-content:center">
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none">${svgPath}</svg>
    </div>`;

  const quickHtml =
    `<div style="margin-top:18px">` +
    `<div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--muted-2);letter-spacing:1px;text-transform:uppercase;margin-bottom:10px">Quick actions</div>` +
    `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:8px">` +
    `<div onclick="showSection('bookings');setTimeout(function(){var b=document.getElementById('add-booking-btn');if(b)b.click()},100)" style="background:white;border-radius:14px;padding:12px 6px;border:1px solid var(--hairline-1);text-align:center;cursor:pointer">` +
      quickActionIcon('<path d="M11 5v12M5 11h12" stroke="var(--primary)" stroke-width="2" stroke-linecap="round"/>') +
      `<div style="margin-top:6px;font-size:11.5px;font-weight:600;color:var(--ink-1)">Booking</div>` +
    `</div>` +
    `<div onclick="showSection('cleaning')" style="background:white;border-radius:14px;padding:12px 6px;border:1px solid var(--hairline-1);text-align:center;cursor:pointer">` +
      quickActionIcon('<path d="M6 6l5 11 5-11M11 6v6" stroke="var(--primary)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>') +
      `<div style="margin-top:6px;font-size:11.5px;font-weight:600;color:var(--ink-1)">Clean</div>` +
    `</div>` +
    `<div onclick="showSection('finance');showFinanceSub('expenses')" style="background:white;border-radius:14px;padding:12px 6px;border:1px solid var(--hairline-1);text-align:center;cursor:pointer">` +
      quickActionIcon('<path d="M14 6h-4a2 2 0 000 4h2a2 2 0 010 4H8M11 4v2m0 10v2" stroke="var(--primary)" stroke-width="1.8" stroke-linecap="round" fill="none"/>') +
      `<div style="margin-top:6px;font-size:11.5px;font-weight:600;color:var(--ink-1)">Expense</div>` +
    `</div>` +
    `</div></div>`;

  // Desktop: Operations Control Centre
  if (window.innerWidth >= 1024) {
    const host = getHostProfile();
    const firstName = escHtml(String(host?.hostName || host?.name || '').split(' ')[0] || '');
    const hour = now.getHours();
    const greetWord = hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening';
    const dateStr = now.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    const headerHtml = `<div class="dash-control-header">
      <div>
        <div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--muted-2);letter-spacing:1px;text-transform:uppercase">${escHtml(dateStr.toUpperCase())}</div>
        <div style="margin-top:2px;font-family:'Newsreader',serif;font-size:28px;font-weight:600;color:var(--ink-1);letter-spacing:-0.5px">${firstName ? greetWord + ', <em>' + firstName + '</em>' : 'Dashboard'}</div>
      </div>
      <div class="dash-kpi-strip">
        <div class="dash-kpi"><span class="dash-kpi-val" data-animate-number="${occupancyThisMonth}" data-num-suffix="%">0%</span><span class="dash-kpi-label">Occupancy</span></div>
        <div class="dash-kpi-sep"></div>
        <div class="dash-kpi"><span class="dash-kpi-val" data-animate-number="${Math.round(revenueThisMonth)}" data-num-prefix="$">$0</span><span class="dash-kpi-label">Revenue</span></div>
        <div class="dash-kpi-sep"></div>
        <div class="dash-kpi"><span class="dash-kpi-val" data-animate-number="${activeBookings.length}">0</span><span class="dash-kpi-label">Bookings</span></div>
        <div class="dash-kpi-sep"></div>
        <div class="dash-kpi"><span class="dash-kpi-val" data-animate-number="${Math.round(revenueNext30)}" data-num-prefix="$">$0</span><span class="dash-kpi-label">Next 30d</span></div>
      </div>
    </div>`;

    // Today timeline — check-ins, check-outs, cleans
    const todayStr = localDateStr(now);
    const arrivingToday = activeBookings.filter(b => (b.checkin||'').slice(0,10) === todayStr);
    const departingToday = activeBookings.filter(b => (b.checkout||'').slice(0,10) === todayStr);
    const allCleans = window.cleans || [];
    const cleansToday = allCleans.filter(c => (c.date||'').slice(0,10) === todayStr && !isCleanLinkedToCancelledBooking(c));

    const timelineItems = [];
    departingToday.forEach(b => {
      const bid = escapeJsSingleQuotedHtmlAttr(String(b._cloudId || b.id));
      timelineItems.push({ time: getTurnoverTimes(b).checkoutLabel, icon: '↗', color: 'var(--warn)', label: 'Check-out', detail: escHtml(b.name || 'Guest'), onclick: `showDetail('${bid}')` });
    });
    cleansToday.forEach(c => {
      const cleanerName = (window._cleaners || []).find(cl => String(cl.id) === String(c.cleaner_id))?.name || 'Unassigned';
      const bid = c.booking_id ? escapeJsSingleQuotedHtmlAttr(String(c.booking_id)) : '';
      timelineItems.push({ time: '12:00', icon: '✦', color: 'var(--accent)', label: 'Clean', detail: escHtml(cleanerName), onclick: bid ? `showDetail('${bid}')` : '' });
    });
    arrivingToday.forEach(b => {
      const bid = escapeJsSingleQuotedHtmlAttr(String(b._cloudId || b.id));
      timelineItems.push({ time: getTurnoverTimes(b).checkinLabel, icon: '↙', color: 'var(--primary)', label: 'Check-in', detail: escHtml(b.name || 'Guest'), onclick: `showDetail('${bid}')` });
    });

    let timelineHtml = '';
    if (timelineItems.length) {
      const rows = timelineItems.map(t =>
        `<div class="dash-timeline-row" ${t.onclick ? 'onclick="' + t.onclick + '" style="cursor:pointer"' : ''}>
          <div class="dash-tl-time">${t.time}</div>
          <div class="dash-tl-dot" style="background:${t.color}">${t.icon}</div>
          <div class="dash-tl-content"><strong>${t.label}</strong> ${t.detail}</div>
        </div>`
      ).join('');
      timelineHtml = `<div class="card dash-timeline-card">
        <div class="dash-section-hdr"><span>Today's Activity</span><span class="dash-section-count">${timelineItems.length} event${timelineItems.length > 1 ? 's' : ''}</span></div>
        ${rows}
      </div>`;
    } else {
      timelineHtml = `<div class="card dash-timeline-card">
        <div class="dash-section-hdr"><span>Today's Activity</span></div>
        <div style="text-align:center;padding:24px 0;color:var(--muted-2);font-size:13px">No activity scheduled today</div>
      </div>`;
    }

    // Upcoming bookings table
    const upcoming = [...activeBookings]
      .filter(b => parseLocalDayStart(b.checkout) >= todayStart)
      .sort((a, b) => parseLocalDayStart(a.checkin) - parseLocalDayStart(b.checkin))
      .slice(0, 8);
    const fmtSh = d => { if (!d) return ''; const dt = new Date(d); return dt.toLocaleDateString('en-AU', { day:'numeric', month:'short' }); };
    const platformCls = p => { const lp = (p||'').toLowerCase(); if (lp.includes('airbnb')) return 'platform-airbnb'; if (lp.includes('vrbo')) return 'platform-vrbo'; return 'platform-direct'; };
    const statusBdg = b => {
      const ci = (b.checkin||'').slice(0,10), co = (b.checkout||'').slice(0,10);
      if (ci === todayStr) return '<span class="dt-badge dt-badge-green">Arriving</span>';
      if (co === todayStr) return '<span class="dt-badge dt-badge-amber">Departing</span>';
      if (ci < todayStr && co > todayStr) return '<span class="dt-badge dt-badge-green">In-house</span>';
      return '<span class="dt-badge dt-badge-blue">Confirmed</span>';
    };
    const tblRows = upcoming.map(b => {
      const bid = escapeJsSingleQuotedHtmlAttr(String(b._cloudId || b.id));
      return `<tr onclick="showDetail('${bid}')" style="cursor:pointer"><td><strong>${escHtml(b.name)}</strong></td><td>${fmtSh(b.checkin)}</td><td>${fmtSh(b.checkout)}</td><td>$${bookingRevenue(b).toLocaleString()}</td><td><span class="dt-platform ${platformCls(b.platform)}">${escHtml(normalizePlatformLabel(b.platform))}</span></td><td>${statusBdg(b)}</td></tr>`;
    }).join('');

    const upcomingTable = `<div class="card" style="padding:0;overflow:hidden">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 16px 12px">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:var(--muted-2)">Upcoming Bookings</span>
        <span onclick="showSection('bookings')" style="font-size:12px;color:var(--moss);cursor:pointer;font-weight:500">View all &rarr;</span>
      </div>
      <table class="desktop-table"><thead><tr><th>Guest</th><th>Check-in</th><th>Check-out</th><th>Payout</th><th>Platform</th><th>Status</th></tr></thead><tbody>${tblRows || '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--muted-2)">No upcoming bookings</td></tr>'}</tbody></table>
    </div>`;

    // Occupancy + sparkline sidebar
    const occCard = `<div class="card">
      <div class="dash-section-hdr"><span>Monthly Occupancy</span><span style="font-family:'Newsreader',serif;font-size:24px;color:var(--primary)">${occupancyThisMonth}%</span></div>
      <div style="height:8px;background:#e8e0d5;border-radius:4px;overflow:hidden;margin-top:8px"><div style="height:100%;background:var(--moss);border-radius:4px;width:${occupancyThisMonth}%"></div></div>
      <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:11px;color:var(--muted-2)"><span>${bookedNightsMonth} nights booked</span><span>${daysThisMonth - bookedNightsMonth} available</span></div>
    </div>`;

    setTimeout(animateNumbers, 100);
    return `${headerHtml}
    <div class="dash-control-grid">
      <div class="dash-main-col">
        ${timelineHtml}
        ${upcomingTable}
        ${unifiedCalHtml}
      </div>
      <div class="dash-side-col">
        ${needsHtml || ''}
        ${occCard}
        ${sparklineHtml}
        ${quickHtml}
      </div>
    </div>`;
  }

  // Mobile: Upcoming bookings as cards
  const upcomingMobile = [...activeBookings]
    .filter(b => b.status !== 'cancelled' && parseLocalDayStart(b.checkout) >= todayStart)
    .sort((a, b) => parseLocalDayStart(a.checkin) - parseLocalDayStart(b.checkin))
    .slice(0, 5);

  let upcomingCardsHtml = '';
  if (upcomingMobile.length) {
    upcomingCardsHtml =
      `<div style="margin-top:18px">` +
      `<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px">` +
      `<div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--muted-2);letter-spacing:1px;text-transform:uppercase">Upcoming</div>` +
      `<span onclick="showSection('bookings')" style="font-size:12px;color:var(--primary);cursor:pointer;font-weight:600">Calendar</span>` +
      `</div>` +
      upcomingMobile.map(b => buildBookingListCardFromBooking(b)).join('') +
      `</div>`;
  }

  const host = getHostProfile();
  const firstName = escHtml(String(host?.hostName || host?.name || '').split(' ')[0] || '');
  const hour = now.getHours();
  const greetWord = hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening';
  const dateStr = now.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'short' });
  const greetingHtml = firstName
    ? `<div style="margin-bottom:18px">` +
      `<div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--muted-2);letter-spacing:1px;text-transform:uppercase">${escHtml(dateStr.toUpperCase())}</div>` +
      `<div style="margin-top:4px;font-family:'Newsreader',serif;font-size:28px;font-weight:600;color:var(--ink-1);letter-spacing:-0.5px">${greetWord}, <em>${firstName}</em></div>` +
      `</div>`
    : '';

  // Mobile "Today" turnover card — checkout → clean → check-in at a glance.
  const todayStrM = localDateStr(now);
  const departingTodayM = activeBookings.filter(b => b.status !== 'cancelled' && String(b.checkout || '').slice(0, 10) === todayStrM);
  const arrivingTodayM = activeBookings.filter(b => b.status !== 'cancelled' && String(b.checkin || '').slice(0, 10) === todayStrM);
  const cleansTodayM = cleans.filter(c => {
    if (String(c.date || '').slice(0, 10) !== todayStrM) return false;
    if (isCleanLinkedToCancelledBooking(c)) return false;
    // Scope to the active property (mirrors cleanForPropertyOnDate / computeDedupedTodayAlerts);
    // the in-memory `cleans` array can hold other properties' cleans after a portfolio switch.
    if (!activePid) return true;
    const bk = c.bookingId && bookings.find(x =>
      String(x.id) === String(c.bookingId) || (x._cloudId && String(x._cloudId) === String(c.bookingId))
    );
    if (bk) return String(bk._propertyId || '') === String(activePid);
    return !c._propertyId || String(c._propertyId) === String(activePid);
  });
  const todayItemsM = [];
  departingTodayM.forEach(b => {
    const bid = escapeJsSingleQuotedHtmlAttr(String(b._cloudId || b.id));
    todayItemsM.push({ time: getTurnoverTimes(b).checkoutLabel, bg: '#FAEEDA', fg: '#854F0B', icon: '↗', label: 'Check-out', detail: escHtml(b.name || 'Guest'), extra: '', onclick: `showDetail('${bid}')` });
  });
  cleansTodayM.forEach(c => {
    const cleanerName = String(c.cleaner || '').trim() || 'Cleaner';
    const extra = c.cleanerConfirmed
      ? ` <span style="font-size:11px;color:#1D9E75">confirmed</span>`
      : c.cleanerDeclined
        ? ` <span style="font-size:11px;color:#A32D2D">declined</span>`
        : '';
    const bid = c.bookingId ? escapeJsSingleQuotedHtmlAttr(String(c.bookingId)) : '';
    todayItemsM.push({ time: '12:00', bg: '#EFEAF9', fg: '#534AB7', icon: '✦', label: 'Clean', detail: escHtml(cleanerName), extra, onclick: bid ? `showDetail('${bid}')` : '' });
  });
  arrivingTodayM.forEach(b => {
    const bid = escapeJsSingleQuotedHtmlAttr(String(b._cloudId || b.id));
    todayItemsM.push({ time: getTurnoverTimes(b).checkinLabel, bg: '#E7F1E5', fg: '#2F5A2A', icon: '↙', label: 'Check-in', detail: escHtml(b.name || 'Guest'), extra: '', onclick: `showDetail('${bid}')` });
  });
  let todayCardHtml = '';
  if (todayItemsM.length) {
    const rows = todayItemsM.map(t =>
      `<div ${t.onclick ? `onclick="${t.onclick}" ` : ''}style="display:flex;align-items:center;gap:11px;padding:5px 0${t.onclick ? ';cursor:pointer' : ''}">` +
      `<span style="font-size:12px;color:var(--muted-2);font-family:'JetBrains Mono',monospace;width:36px;flex-shrink:0">${t.time}</span>` +
      `<span style="width:22px;height:22px;border-radius:50%;background:${t.bg};color:${t.fg};font-size:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0">${t.icon}</span>` +
      `<span style="font-size:13px;color:var(--ink-1)"><strong style="font-weight:600">${t.label}</strong> · ${t.detail}${t.extra}</span>` +
      `</div>`
    ).join('');
    todayCardHtml =
      `<div style="background:white;border-radius:12px;border:1px solid var(--hairline-1);padding:12px 14px;margin-bottom:14px">` +
      `<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">` +
      `<span style="font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--muted-2);letter-spacing:1px;text-transform:uppercase">Today</span>` +
      `<span style="font-size:11px;color:var(--muted-2)">${todayItemsM.length} event${todayItemsM.length > 1 ? 's' : ''}</span>` +
      `</div>${rows}</div>`;
  }
  // "All clear today" is an alerts empty-state — only show it when there's genuinely
  // nothing on. If there are real alerts, show them; if there's turnover activity, the
  // Today card already covers it.
  const mobileNeedsHtml = deduped.length ? needsHtml : (todayItemsM.length ? '' : needsHtml);

  return (
    greetingHtml +
    statusHtml +
    todayCardHtml +
    mobileNeedsHtml +
    upcomingCardsHtml +
    unifiedCalHtml +
    statsHtml +
    sparklineHtml +
    quickHtml
  );
}

function renderDashboard() {
  if (isPortfolioMode()) {
    const singleDash = document.getElementById('dashboard-content');
    const portfolioDash = document.getElementById('portfolio-dashboard');
    if (singleDash) singleDash.style.display = 'none';
    if (portfolioDash) {
      portfolioDash.style.display = '';
      const isDesktop = window.innerWidth >= 1024;
      const wrapStyle = isDesktop
        ? 'padding:0;min-height:80px'
        : 'background:#f5f5f3;margin-left:-16px;margin-right:-16px;padding:16px;padding-bottom:12px;min-height:80px';
      portfolioDash.innerHTML =
        '<div style="' + wrapStyle + '">' +
        buildTodayDashboardMarkup({ portfolio: true }) +
        '</div>';
    }
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

  const mount = document.getElementById('dashboard-today-mount');
  if (mount) mount.innerHTML = buildTodayDashboardMarkup({ portfolio: false });

  // Attach swipe to dashboard calendar card
  const _calCard = document.getElementById('today-cal-card');
  if (_calCard) {
    let _sx = 0, _sy = 0;
    _calCard.addEventListener('touchstart', (e) => { _sx = e.touches[0].clientX; _sy = e.touches[0].clientY; }, { passive: true });
    _calCard.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - _sx;
      const dy = e.changedTouches[0].clientY - _sy;
      if (Math.abs(dx) < 44 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      globalThis._todayCalNav(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  const usageSnapshot = getUsageSnapshotLite();
  renderOnboardingGuidance(usageSnapshot);
}

function buildTodayDashboardMarkup(ctx) {
  if (!ctx.portfolio) return buildSinglePropertyTodayDashboardMarkup();
  return buildPortfolioTodayDashboardMarkup();
}

function buildPortfolioTodayDashboardMarkup() {
  const tertiary = '#6B6560';
  const primary = 'var(--ink-1)';
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!_todayWeekStart) _todayWeekStart = _mondayStart(new Date());
  const weekStart = new Date(_todayWeekStart.getFullYear(), _todayWeekStart.getMonth(), _todayWeekStart.getDate());
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const weekMs = 7 * 86400000;

  const next7End = new Date(todayStart);
  next7End.setDate(next7End.getDate() + 7);
  const next30End = new Date(todayStart);
  next30End.setDate(next30End.getDate() + 30);

  const thisMonth = now.getMonth();
  const thisYear = now.getFullYear();
  const daysThisMonth = new Date(thisYear, thisMonth + 1, 0).getDate();
  const monthStart = new Date(thisYear, thisMonth, 1);
  const monthEnd = new Date(thisYear, thisMonth + 1, 1);

  const props = typeof getAllProperties === 'function' ? getAllProperties() : [];

  const activeBookingsAll = bookings.filter(b => b.status !== 'cancelled');
  const activeBookings = activeBookingsAll.slice();
  const revenueBookings = bookings.slice();

  let bookedNightsMonth = 0;
  activeBookings.forEach(b => {
    if (!b.checkin || !b.checkout) return;
    const ci = new Date(Math.max(new Date(b.checkin).getTime(), monthStart.getTime()));
    const co = new Date(Math.min(new Date(b.checkout).getTime(), monthEnd.getTime()));
    if (co > ci) bookedNightsMonth += Math.round((co - ci) / 86400000);
  });
  const denomDays = props.length > 1 ? daysThisMonth * props.length : daysThisMonth;
  const occupancyThisMonth = Math.max(0, Math.min(100, Math.round((bookedNightsMonth / denomDays) * 100)));

  const revenueThisMonth = revenueBookings
    .filter(b => {
      const ci = parseLocalDayStart(b.checkin);
      return !Number.isNaN(ci.getTime()) && ci >= monthStart && ci < monthEnd;
    })
    .reduce((s, b) => s + bookingRevenue(b), 0);

  const revenueNext30 = revenueBookings
    .filter(b => {
      const ci = parseLocalDayStart(b.checkin);
      return !Number.isNaN(ci.getTime()) && ci >= todayStart && ci < next30End;
    })
    .reduce((s, b) => s + bookingRevenue(b), 0);

  const propertyRows = props.map((p, i) => ({
    name: p.name || p.propertyId,
    pid: _pidForProperty(p),
    palette: TODAY_PALETTE[i % TODAY_PALETTE.length],
  }));

  const deduped = computeDedupedTodayAlerts(true);
  const needsHtml = buildNeedsAttentionHtmlFromDeduped(deduped);

  const weekEndLabel = new Date(weekStart);
  weekEndLabel.setDate(weekEndLabel.getDate() + 6);
  const weekRangeLabel =
    weekStart.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) +
    ' — ' +
    weekEndLabel.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });

  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const todayCol = (() => {
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      if (d.getTime() === todayStart.getTime()) return i;
    }
    return -1;
  })();

  let headerCols = '';
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    const isToday = i === todayCol;
    const dnStyle = isToday
      ? 'font-size:11px;font-weight:500;color:#2D5A3D'
      : `font-size:11px;color:${tertiary}`;
    const numStyle = isToday
      ? 'font-size:10px;font-weight:500;color:#2D5A3D;margin-top:2px'
      : `font-size:10px;color:${tertiary};margin-top:2px`;
    headerCols += `<div style="text-align:center">
      <div style="${dnStyle}">${dayNames[i]}</div>
      <div style="${numStyle}">${d.getDate()}</div>
    </div>`;
  }

  const timelineRows = buildWeeklyTimelineRowsHtml(
    propertyRows,
    weekStart,
    weekEnd,
    weekMs,
    tertiary,
    primary,
    activeBookingsAll,
    false
  );

  const weekCard = `<div style="background:white;border-radius:12px;border:0.5px solid rgba(0,0,0,0.12);padding:12px;margin-bottom:14px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:8px">
      <button type="button" onclick="_todayWeekNav(-1)" style="background:#F1EFE8;border:none;border-radius:8px;width:32px;height:32px;font-size:16px;cursor:pointer;color:var(--ink-1)">‹</button>
      <div style="font-size:13px;font-weight:500;color:${primary};text-align:center;flex:1">${escHtml(weekRangeLabel)}</div>
      <button type="button" onclick="_todayWeekNav(1)" style="background:#F1EFE8;border:none;border-radius:8px;width:32px;height:32px;font-size:16px;cursor:pointer;color:var(--ink-1)">›</button>
    </div>
    <div style="display:flex;justify-content:flex-end;margin-bottom:8px">
      <span onclick="_todayWeekReset()" style="font-size:11px;font-weight:500;color:#2D5A3D;cursor:pointer">This week</span>
    </div>
    <div style="display:grid;grid-template-columns:60px 1fr;margin-bottom:6px">
      <div></div>
      <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px">${headerCols}</div>
    </div>
    ${timelineRows}
  </div>`;

  let next7Html = `<div style="font-size:12px;font-weight:500;color:${tertiary};margin:0 0 10px 2px">Next 7 days</div>`;
  const next7Bookings = activeBookings
    .filter(b => {
      const ci = parseLocalDayStart(b.checkin);
      return !Number.isNaN(ci.getTime()) && ci >= todayStart && ci < next7End;
    })
    .sort((a, b) => parseLocalDayStart(a.checkin) - parseLocalDayStart(b.checkin));

  props.forEach((p, pi) => {
    const pid = _pidForProperty(p);
    const col = TODAY_PALETTE[pi % TODAY_PALETTE.length];
    const propName = p.name || p.propertyId;
    const list = next7Bookings.filter(b => String(b._propertyId || '') === String(pid));
    const dotHtml = `<div style="display:flex;align-items:center;gap:5px"><div style="width:7px;height:7px;border-radius:50%;background:${col.dot};flex-shrink:0"></div><span style="font-size:11px;color:#666">${escHtml(propName)}</span></div>`;
    if (!list.length) {
      next7Html += `<div style="opacity:0.55;background:white;border-radius:12px;border:0.5px solid rgba(0,0,0,0.1);padding:14px 16px;margin-bottom:10px;display:flex;align-items:center;gap:8px">
          <div style="width:7px;height:7px;border-radius:50%;background:${col.dot};flex-shrink:0"></div>
          <span style="font-size:13px;color:${tertiary}">No ${escHtml(propName)} bookings this week</span>
        </div>`;
    } else {
      list.forEach(b => {
        next7Html += buildTodayBookingCardHtml(b, {
          showPropertyStripe: col.border,
          propertyDotHtml: dotHtml,
        });
      });
    }
  });

  const statsHtml = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:4px">
    <div style="background:white;border-radius:16px;padding:14px;border:1px solid var(--hairline-1)">
      <div style="display:flex;align-items:center;gap:8px">
        <div style="width:8px;height:8px;border-radius:50%;background:var(--primary-soft);border:1.5px solid var(--hairline-1)"></div>
        <div style="font-size:11px;font-family:'JetBrains Mono',monospace;letter-spacing:0.5px;color:var(--muted-2);text-transform:uppercase">Occupancy</div>
      </div>
      <div style="margin-top:8px;font-size:24px;font-weight:600;font-family:'Newsreader',serif;color:var(--ink-1);letter-spacing:-0.5px">${occupancyThisMonth}%</div>
      <div style="font-size:11px;color:var(--muted-2);margin-top:2px">${bookedNightsMonth}/${denomDays} nights booked</div>
    </div>
    <div style="background:white;border-radius:16px;padding:14px;border:1px solid var(--hairline-1)">
      <div style="display:flex;align-items:center;gap:8px">
        <div style="width:8px;height:8px;border-radius:50%;background:var(--accent-soft);border:1.5px solid var(--hairline-1)"></div>
        <div style="font-size:11px;font-family:'JetBrains Mono',monospace;letter-spacing:0.5px;color:var(--muted-2);text-transform:uppercase">Revenue</div>
      </div>
      <div style="margin-top:8px;font-size:24px;font-weight:600;font-family:'Newsreader',serif;color:var(--ink-1);letter-spacing:-0.5px">$${Math.round(revenueThisMonth).toLocaleString()}</div>
      <div style="font-size:11px;color:var(--muted-2);margin-top:2px">Net of fees</div>
    </div>
  </div>`;

  // Desktop: 2-column layout with bookings table + sidebar
  if (window.innerWidth >= 1024) {
    const upcoming = [...activeBookings]
      .filter(b => parseLocalDayStart(b.checkout) >= todayStart)
      .sort((a, b) => parseLocalDayStart(a.checkin) - parseLocalDayStart(b.checkin))
      .slice(0, 10);
    const fmtSh = d => { if (!d) return ''; return new Date(d).toLocaleDateString('en-AU', { day:'numeric', month:'short' }); };
    const platformCls = p => { const lp = (p||'').toLowerCase(); if (lp.includes('airbnb')) return 'platform-airbnb'; if (lp.includes('vrbo')) return 'platform-vrbo'; return 'platform-direct'; };
    const statusBdg = b => {
      const today = localDateStr();
      const ci = (b.checkin||'').slice(0,10), co = (b.checkout||'').slice(0,10);
      if (ci === today) return '<span class="dt-badge dt-badge-green">Arriving</span>';
      if (co === today) return '<span class="dt-badge dt-badge-amber">Departing</span>';
      if (ci < today && co > today) return '<span class="dt-badge dt-badge-green">In-house</span>';
      return '<span class="dt-badge dt-badge-blue">Confirmed</span>';
    };
    const propNameFor = b => {
      const pid = b._propertyId;
      if (!pid) return '';
      const p = props.find(pr => String(_pidForProperty(pr)) === String(pid));
      return p ? (p.name || p.propertyId) : '';
    };
    const tblRows = upcoming.map(b => {
      const bid = escapeJsSingleQuotedHtmlAttr(String(b._cloudId || b.id));
      return `<tr onclick="showDetail('${bid}')" style="cursor:pointer"><td><strong>${escHtml(b.name)}</strong></td><td style="font-size:12px;color:var(--muted-2)">${escHtml(propNameFor(b))}</td><td>${fmtSh(b.checkin)}</td><td>${fmtSh(b.checkout)}</td><td>$${bookingRevenue(b).toLocaleString()}</td><td><span class="dt-platform ${platformCls(b.platform)}">${escHtml(normalizePlatformLabel(b.platform))}</span></td><td>${statusBdg(b)}</td></tr>`;
    }).join('');

    const upcomingTable = `<div class="card" style="padding:0;overflow:hidden">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 16px 12px">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:var(--muted-2)">Upcoming Bookings</span>
        <span onclick="showSection('bookings')" style="font-size:12px;color:var(--moss);cursor:pointer;font-weight:500">View all &rarr;</span>
      </div>
      <table class="desktop-table"><thead><tr><th>Guest</th><th>Property</th><th>Check-in</th><th>Check-out</th><th>Payout</th><th>Platform</th><th>Status</th></tr></thead><tbody>${tblRows || '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--muted-2)">No upcoming bookings</td></tr>'}</tbody></table>
    </div>`;

    // Today's cleans for sidebar
    // Per-property occupancy
    const propOccHtml = props.map((p, i) => {
      const pid = _pidForProperty(p);
      const col = TODAY_PALETTE[i % TODAY_PALETTE.length];
      let pNights = 0;
      activeBookings.filter(b => String(b._propertyId||'') === String(pid)).forEach(b => {
        if (!b.checkin || !b.checkout) return;
        const ci2 = new Date(Math.max(new Date(b.checkin).getTime(), monthStart.getTime()));
        const co2 = new Date(Math.min(new Date(b.checkout).getTime(), monthEnd.getTime()));
        if (co2 > ci2) pNights += Math.round((co2 - ci2) / 86400000);
      });
      const pOcc = Math.round((pNights / daysThisMonth) * 100);
      return `<div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;padding:4px 0"><span style="display:flex;align-items:center;gap:6px"><span style="width:8px;height:8px;border-radius:50%;background:${col.dot}"></span>${escHtml(p.name||p.propertyId)}</span><span style="font-weight:500">${pOcc}%</span></div>`;
    }).join('');

    setTimeout(animateNumbers, 100);
    return `<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-bottom:20px">
      <div class="card" style="text-align:center"><div data-animate-number="${occupancyThisMonth}" data-num-suffix="%" style="font-family:'Newsreader',serif;font-size:28px;color:var(--primary)">0%</div><div style="font-size:10px;color:var(--muted-2);text-transform:uppercase;letter-spacing:0.4px;margin-top:4px">Occupancy</div></div>
      <div class="card" style="text-align:center"><div data-animate-number="${Math.round(revenueThisMonth)}" data-num-prefix="$" style="font-family:'Newsreader',serif;font-size:28px;color:var(--primary)">$0</div><div style="font-size:10px;color:var(--muted-2);text-transform:uppercase;letter-spacing:0.4px;margin-top:4px">Revenue</div></div>
      <div class="card" style="text-align:center"><div data-animate-number="${activeBookings.length}" style="font-family:'Newsreader',serif;font-size:28px;color:var(--primary)">0</div><div style="font-size:10px;color:var(--muted-2);text-transform:uppercase;letter-spacing:0.4px;margin-top:4px">Bookings</div></div>
      <div class="card" style="text-align:center"><div data-animate-number="${Math.round(revenueNext30)}" data-num-prefix="$" style="font-family:'Newsreader',serif;font-size:28px;color:var(--primary)">$0</div><div style="font-size:10px;color:var(--muted-2);text-transform:uppercase;letter-spacing:0.4px;margin-top:4px">Next 30 days</div></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr minmax(300px,380px);gap:20px">
      <div style="display:flex;flex-direction:column;gap:16px">
        ${upcomingTable}
        ${weekCard}
      </div>
      <div style="display:flex;flex-direction:column;gap:16px">
        ${needsHtml ? '<div class="card" style="padding:16px">' + needsHtml + '</div>' : ''}
        <div class="card">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:var(--muted-2);margin-bottom:12px">Occupancy by Property</div>
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
            <span style="font-family:'Newsreader',serif;font-size:32px;color:var(--primary)">${occupancyThisMonth}%</span>
            <span style="font-size:12px;color:var(--moss)">${bookedNightsMonth}/${denomDays} nights</span>
          </div>
          <div style="height:8px;background:#e8e0d5;border-radius:4px;overflow:hidden;margin-bottom:12px"><div style="height:100%;background:var(--moss);border-radius:4px;width:${occupancyThisMonth}%"></div></div>
          ${propOccHtml}
        </div>
      </div>
    </div>`;
  }

  const host = getHostProfile();
  const firstName = escHtml(String(host?.hostName || host?.name || '').split(' ')[0] || '');
  const hour = now.getHours();
  const greetWord = hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening';
  const dateStr = now.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'short' });
  const greetingHtml = firstName
    ? `<div style="margin-bottom:18px">` +
      `<div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--muted-2);letter-spacing:1px;text-transform:uppercase">${escHtml(dateStr.toUpperCase())}</div>` +
      `<div style="margin-top:4px;font-family:'Newsreader',serif;font-size:28px;font-weight:600;color:var(--ink-1);letter-spacing:-0.5px">${greetWord}, <em>${firstName}</em></div>` +
      `</div>`
    : '';

  return greetingHtml + needsHtml + weekCard + next7Html + statsHtml;
}

globalThis.renderDashboard = renderDashboard;

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

  let _cloudOk = false;
  let errors = [];

  try {
    // Step 1: Pull from Supabase (primary source)
    if (typeof globalThis.hydrateFromCloud === 'function') {
      try {
        await globalThis.hydrateFromCloud();
        _cloudOk = true;
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
  let host = getHostProfile();

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
  if (!maintenance.length) { el.innerHTML = '<div style="padding:12px 0;color:var(--muted-2);font-size:13px">No issues logged</div>'; return; }
  const order = {open:0,inprogress:1,resolved:2};
  const sorted = [...maintenance].sort((a,b) => (order[a.status]||0)-(order[b.status]||0));
  el.innerHTML = sorted.map(m => `
    <div class="maint-item">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div style="flex:1">
          <span class="maint-status-badge maint-${m.status}">${m.status==='open'?'🔴 Open':m.status==='inprogress'?'🔄 In Progress':'✅ Resolved'}</span>
          <div style="font-weight:600;font-size:14px;margin-top:4px">${escHtml(m.description)}</div>
          ${m.contractor?`<div style="font-size:12px;color:var(--muted-2);margin-top:2px">👤 ${escHtml(m.contractor)}</div>`:''}
          <div style="font-size:12px;color:var(--muted-2);margin-top:1px">${fmt(m.date)}${m.cost?` · $${Number(m.cost).toFixed(2)}`:''}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;flex-shrink:0">
          <button onclick="deleteMaintenance('${m.id}')" style="font-size:10px;color:var(--muted-2);background:none;border:none;cursor:pointer">✕</button>
          ${m.status !== 'resolved' ? `
          <button onclick="resolveIssue('${m.id}')" style="font-size:11px;background:var(--moss);color:white;border:none;border-radius:8px;padding:5px 10px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif">Mark Resolved</button>
          <button onclick="setMaintInProgress('${m.id}')" style="font-size:11px;background:var(--forest-light);color:var(--sage);border:none;border-radius:8px;padding:5px 10px;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif">In Progress</button>
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
  const m = maintenance.find(m => String(m.id) === String(id));
  if (m) { m.status = 'inprogress'; savePropertyData(); renderMaintenance(); }
}

async function resolveIssue(id) {
  const m = maintenance.find(m => String(m.id) === String(id));
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
      date: localDateStr(),
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
  const removed = maintenance.find(m => String(m.id) === String(id));
  replaceArrayInPlace(maintenance, maintenance.filter(m => String(m.id) !== String(id)));
  savePropertyData();
  renderMaintenance();
  if (removed && typeof globalThis.deleteMaintenanceFromCloud === 'function') globalThis.deleteMaintenanceFromCloud(removed).catch(e => console.warn("[StayOps] silent error:", e));
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
      listEl.innerHTML = '<div class="card" style="text-align:center;color:var(--moss);padding:24px"><div style="font-size:28px;margin-bottom:6px">✅</div><div style="font-weight:600;font-size:15px">All stocked up!</div><div style="font-size:12px;color:var(--muted-2);margin-top:4px">Nothing needs reordering right now</div></div>';
      return;
    }
    listEl.innerHTML = `<div class="card" style="padding:0">
      <div style="padding:10px 16px 6px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;color:var(--muted-2);border-bottom:1px solid var(--hairline-2)">${lowItems.length} item${lowItems.length!==1?'s':''} to reorder</div>
      ` + lowItems.map(i => `
      <div onclick="restockItem('${i.id}')" style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--hairline-2);cursor:pointer;transition:background 0.15s" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background=''">
        <div style="width:22px;height:22px;border-radius:5px;border:2px solid var(--hairline-1);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:14px;color:var(--moss)">+</div>
        <div>
          <div style="font-weight:600;font-size:14px">${escHtml(i.name)}${i.unit?` <span style="font-size:12px;font-weight:400;color:var(--muted-2)">(${escHtml(i.unit)})</span>`:''}</div>
          <div style="font-size:11px;color:var(--muted-2);margin-top:2px">Stock: ${i.stock} · Reorder below ${i.threshold}</div>
        </div>
      </div>`).join('') + `</div>`;
    return;
  }

  // All items view
  if (!inventory.length) { listEl.innerHTML = '<div style="color:var(--muted-2);font-size:13px;padding:8px 0">No items added yet</div>'; return; }
  listEl.innerHTML = `<div class="card" style="padding:0">` + inventory.map(i => {
    const isLow = i.stock <= i.threshold;
    return `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--hairline-2);gap:8px">
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:14px;color:${isLow?'var(--red)':'var(--text)'}">${escHtml(i.name)}${isLow?' ⚠':''}</div>
        <div style="font-size:12px;color:var(--muted-2);margin-top:1px">Reorder below ${i.threshold}${i.unit?' '+escHtml(i.unit):''}</div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
        <button onclick="adjustStock('${i.id}',-1)" style="width:30px;height:30px;border-radius:50%;border:1px solid var(--hairline-1);background:white;font-size:17px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;flex-shrink:0">−</button>
        <span style="font-weight:700;font-size:17px;min-width:26px;text-align:center;color:${isLow?'var(--red)':'var(--primary)'}">${i.stock}</span>
        <button onclick="adjustStock('${i.id}',1)" style="width:30px;height:30px;border-radius:50%;border:none;background:var(--primary);color:white;font-size:17px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;flex-shrink:0">+</button>
        <button onclick="openInvEdit('${i.id}')" style="width:30px;height:30px;border-radius:50%;border:1px solid var(--hairline-1);background:white;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:var(--primary)">ℹ</button>
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
  const item = inventory.find(i => String(i.id) === String(id));
  if (item) { item.threshold = parseInt(val) || 0; savePropertyData(); renderInventory(); }
}

function adjustStock(id, delta) {
  const item = inventory.find(i => String(i.id) === String(id));
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
  const removed = inventory.find(i => String(i.id) === String(id));
  replaceArrayInPlace(inventory, inventory.filter(i => i.id !== id));
  savePropertyData();
  renderInventory();
  // Inventory has no soft-delete trigger — without an explicit cloud delete the
  // row resurrects on next hydration (report 1.26 / 3.2).
  if (removed && typeof globalThis.deleteInventoryFromCloud === 'function') {
    globalThis.deleteInventoryFromCloud(removed).catch(e => console.warn('[StayOps] silent error:', e));
  }
}


// ── INVENTORY EDIT ────────────────────────────────────────────────────────────
let editingInvId = null;
function openInvEdit(id) {
  const i = inventory.find(i => String(i.id) === String(id));
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
  const i = inventory.find(i => String(i.id) === String(editingInvId));
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
  const removed = inventory.find(i => String(i.id) === String(editingInvId));
  replaceArrayInPlace(inventory, inventory.filter(i => String(i.id) !== String(editingInvId)));
  savePropertyData();
  closeInvEdit();
  renderInventory();
  if (removed && typeof globalThis.deleteInventoryFromCloud === 'function') {
    globalThis.deleteInventoryFromCloud(removed).catch(e => console.warn('[StayOps] silent error:', e));
  }
}


function savePropertyData() {
  // Sync to Supabase (non-blocking)
  if (typeof globalThis.saveInventoryToCloud === 'function') globalThis.saveInventoryToCloud(inventory).catch(e => console.warn("[StayOps] silent error:", e));
  if (typeof globalThis.saveMaintenanceToCloud === 'function') globalThis.saveMaintenanceToCloud(maintenance).catch(e => console.warn("[StayOps] silent error:", e));
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

function showAppModal({ title, msg, confirmText='Confirm', confirmColor='var(--primary)', cancelText='Cancel', hasInput=false, inputPlaceholder='', inputDefault='', inputType='number' }) {
  return new Promise(resolve => {
    _modalResolve = resolve;
    const titleEl = document.getElementById('app-modal-title');
    const msgEl = document.getElementById('app-modal-msg');
    const inp = document.getElementById('app-modal-input');
    const confirmEl = document.getElementById('app-modal-confirm');
    const cancelEl = document.getElementById('app-modal-cancel');
    const overlay = document.getElementById('app-modal-overlay');
    if (!overlay) { resolve(null); return; }
    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = msg;
    if (inp) {
      if (hasInput) {
        inp.style.display = 'block';
        inp.type = inputType;
        inp.placeholder = inputPlaceholder;
        inp.value = inputDefault;
        setTimeout(() => inp.focus(), 100);
      } else {
        inp.style.display = 'none';
      }
    }
    if (confirmEl) { confirmEl.textContent = confirmText; confirmEl.style.background = confirmColor; }
    if (cancelEl) cancelEl.textContent = cancelText;
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

// Google Drive prompts removed — receipts now use Supabase Storage
// Safety net: re-render calendar after 100ms in case layout wasn't settled
setTimeout(renderCalendar, 100);

// Auto-refresh when user returns to app — single handler for both owner and cleaner modes
let _lastVisibilitySync = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;

  // Owner mode: throttled Supabase re-hydrate (once per 5 min)
  if (hasValidPropertyConfig()) {
    const now = Date.now();
    if (now - _lastVisibilitySync > 5 * 60 * 1000) {
      _lastVisibilitySync = now;
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

// Owner app — poll Supabase every 60 seconds to catch cleaner updates.
globalThis._ownerPollInterval = setInterval(() => {
  if (!document.hidden && hasValidPropertyConfig()) {
    if (typeof globalThis.loadCleansFromCloud === 'function') {
      globalThis.loadCleansFromCloud().then(cloudCleans => {
        if (Array.isArray(cloudCleans) && cloudCleans.length) {
          replaceArrayInPlace(cleans, cloudCleans);
          // Only re-render dashboard and cleaning — NOT finance/settings (would reset scroll and forms)
          renderDashboard();
          if (currentSection === 'cleaning') { renderCleaning(); populateCleanerSelect(); }
        }
      }).catch(e => console.warn('[StayOps] Poll sync error:', e));
    }
  }
}, 60000);


// ── BUTTON PRESS FEEL ─────────────────────────────────────────────────────────
function attachButtonPress() {
  document.querySelectorAll('button, .settings-cat-item, .booking-item, .expense-item').forEach(el => {
    if (el.hasAttribute('data-no-press')) return;
    if (el.dataset.pressAttached) return;
    el.dataset.pressAttached = '1';
    el.addEventListener('touchstart', () => { el.classList.add('btn-press'); if (navigator.vibrate) navigator.vibrate(8); }, { passive:true });
    el.addEventListener('touchend',   () => { setTimeout(() => el.classList.remove('btn-press'), 100); });
    el.addEventListener('touchcancel',() => { el.classList.remove('btn-press'); });
  });
}

// ── NUMBER COUNT-UP ANIMATION ────────────────────────────────────────────────
function animateNumbers() {
  document.querySelectorAll('[data-animate-number]').forEach(el => {
    const target = parseFloat(el.dataset.animateNumber);
    if (isNaN(target)) return;
    const prefix = el.dataset.numPrefix || '';
    const suffix = el.dataset.numSuffix || '';
    const duration = 500;
    const start = performance.now();
    const from = 0;
    function tick(now) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
      const current = Math.round(from + (target - from) * eased);
      el.textContent = prefix + current.toLocaleString() + suffix;
      if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    el.classList.add('number-animate');
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
let _longPressTarget = null;

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
          { label: '✏️ Edit Booking',       fn: `() => showEditModal('${escapeJsSingleQuotedHtmlAttr(String(safeId))}')` },
          { label: '📱 Notify Cleaner',     fn: `() => { showSection('cleaning'); }` },
          { label: '🗑 Delete Booking',      fn: `() => deleteBooking('${escapeJsSingleQuotedHtmlAttr(String(safeId))}')`, destructive: true },
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
        const eItem = expenses.find(x => String(x.id) === String(id));
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


// ── ASSIGN CLEANER TO BOOKING (from detail modal) ─────────────────────────────

// ── AUTO-ASSIGN CLEANER TOGGLE ────────────────────────────────────────────────


// hydrateFromCloud lives in supabase.js (wired via globalThis in main).
/**
 * finishAppInit — runs standard app init after login or session restore.
 */
async function finishAppInit() {
  // Desktop sidebar branding
  if (window.innerWidth >= 1024) {
    const nav = document.querySelector('.nav');
    if (nav && !document.getElementById('sidebar-brand')) {
      const brand = document.createElement('div');
      brand.id = 'sidebar-brand';
      brand.innerHTML = 'Stay<span>Ops</span>';
      nav.prepend(brand);
    }
  }
  migrateConfigFromLegacySettings();
  renderPropertySwitcher();
  initFxSettings();
  initSettingsSwipeBack();
  attachButtonPress();
  attachModalHandleDrag();
  // Modal backdrop click — use onclick (not addEventListener) to prevent duplicate registration
  const _modal = document.getElementById('modal');
  const _detailModal = document.getElementById('detail-modal');
  const _notifyModal = document.getElementById('notify-modal');
  if (_modal) _modal.onclick = function(e) { if (e.target === this) closeModal(); };
  if (_detailModal) _detailModal.onclick = function(e) { if (e.target === this) closeDetailModal(); };
  if (_notifyModal) _notifyModal.onclick = function(e) { if (e.target === this) closeNotifyModal(); };
  await globalThis.showSetupIfNeeded();
  // Show/hide admin nav button — only for admin role in user_roles table
  const adminNav = document.getElementById('nav-admin');
  if (adminNav) {
    const showAdmin = typeof globalThis.isAdmin === 'function' ? await globalThis.isAdmin() : false;
    adminNav.style.display = showAdmin ? '' : 'none';
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
  animateNumbers,
  closeActionSheet,
  attachLongPress,
  attachModalHandleDrag,
  cleanerSignOut,
  finishAppInit,
  showOnboarding,
  hideOnboarding,
  _obGoToStep,
  onboardBack,
  onboardSetPropertyType,
  onboardStep0Next,
  onboardStep1Next,
  onboardStep1SkipAddress,
  onboardStep2Next,
  onboardSkipStep,
  onboardLiveContinue,
  obStepperAdjust,
  obSetGuests,
  onboardConnectGoogle,
  onboardConnectMicrosoft,
  onboardEmailConnected,
  onboardStep2Skip,
  onboardTogglePlatform,
  onboardStep3Next,
  onboardToggleIntegration,
  onboardStep4Next,
  onboardEnableNotifications,
  onboardFinish,
  isOnboardingComplete,
  checkAutoSendReport,
  _calNavigate,
  dismissChecklist,
  renderOnboardingGuidance,
};
