/**
 * StayOps — dashboard, sections, modals, maintenance/inventory, cleaner shell, onboarding.
 */
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
  cleanerAccept,
  cleanerDecline,
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
    } catch(e) { return false; }
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
        '<div style="font-weight:700;font-size:15px;color:var(--forest)">Getting Started</div>' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<span style="font-size:12px;color:var(--text-soft)">' + completedCount + '/' + items.length + '</span>' +
          '<span onclick="dismissChecklist()" style="font-size:16px;color:var(--text-soft);cursor:pointer;padding:2px">\u2715</span>' +
        '</div>' +
      '</div>' +
      '<div style="background:var(--warm);border-radius:4px;height:6px;margin-bottom:14px;overflow:hidden">' +
        '<div style="background:var(--forest);height:100%;width:' + pct + '%;border-radius:4px;transition:width .3s"></div>' +
      '</div>' +
      items.map(function(item) {
        var checkStyle = item.done
          ? 'background:var(--forest);border-color:var(--forest);color:#fff'
          : 'background:#fff;border-color:#D1D1D6;color:transparent';
        return '<div style="display:flex;align-items:center;gap:12px;padding:8px 0;' + (item.done ? 'opacity:0.5' : '') + '">' +
          '<div style="width:22px;height:22px;border-radius:50%;border:2px solid;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:11px;' + checkStyle + '">' +
            (item.done ? '\u2713' : '') +
          '</div>' +
          '<div style="flex:1;font-size:13px;' + (item.done ? 'text-decoration:line-through;color:var(--text-soft)' : 'color:var(--text);font-weight:500') + '">' +
            item.icon + ' ' + item.label +
          '</div>' +
          (!item.done && item.action
            ? '<div onclick="' + item.action + '" style="font-size:12px;color:var(--forest);font-weight:600;cursor:pointer;white-space:nowrap">' + item.actionLabel + ' \u2192</div>'
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
  const prevSection = currentSection;
  currentSection = name;
  if (prevSection === 'finance' && name !== 'finance' && name !== 'settings') {
    resetFinanceSubViewToHub();
  }
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
  } else if (name === 'admin') {
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
  const label = raw || 'Other';
  return { label, color, bg };
}

function buildTodayBookingCardHtml(b, options) {
  const { showPropertyStripe, propertyDotHtml } = options;
  const matchedClean = findMatchingCleanForBooking(b);
  const isCancelled = b.status === 'cancelled';
  const id = escapeJsSingleQuotedHtmlAttr(String(b._cloudId || b.id));
  const payout = Number(b.hostPayout ?? b.total_price ?? 0);
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
  const nameSpanStyle = 'font-weight:500;font-size:15px;color:#1a1a1a';
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

globalThis._todayWeekNav = (delta) => {
  if (!_todayWeekStart) _todayWeekStart = _mondayStart(new Date());
  _todayWeekStart.setDate(_todayWeekStart.getDate() + delta * 7);
  console.log('[StayOps] today week navigated', _todayWeekStart.toDateString());
  globalThis.renderDashboard?.();
};

globalThis._todayWeekReset = () => {
  _todayWeekStart = _mondayStart(new Date());
  console.log('[StayOps] today week reset to current');
  globalThis.renderDashboard?.();
};

function _getTodayCalMonthStart() {
  if (!_todayMonthViewStart) {
    const n = new Date();
    _todayMonthViewStart = new Date(n.getFullYear(), n.getMonth(), 1);
  }
  return _todayMonthViewStart;
}

globalThis._todayCalNav = (delta) => {
  const d = _getTodayCalMonthStart();
  d.setMonth(d.getMonth() + delta);
  console.log('[StayOps] today calendar month navigated', d.getFullYear(), d.getMonth());
  globalThis.renderDashboard?.();
};

globalThis._stayopsSetTodayCalView = (v) => {
  if (v !== 'daily' && v !== 'weekly' && v !== 'monthly') return;
  globalThis._stayopsTodayCalView = v;
  console.log('[StayOps] today calendar view', v);
  globalThis.renderDashboard?.();
};

globalThis._stayopsTodayDayNav = (delta) => {
  globalThis._stayopsTodayDayOffset =
    (globalThis._stayopsTodayDayOffset || 0) + delta;
  globalThis.renderDashboard?.();
};

globalThis._stayopsTodayDayReset = () => {
  globalThis._stayopsTodayDayOffset = 0;
  globalThis.renderDashboard?.();
};

globalThis.navigateTodayToClean = navigateTodayToClean;

function computeDedupedTodayAlerts(isPortfolio) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const cloudIds = window._cloudPropertyIds || {};
  const activeBookingsAll = bookings.filter(b => b.status !== 'cancelled');
  const alerts = [];
  const pushAlert = (type, title, subtitle, urgent, cleanId, bookingLocalId) => {
    alerts.push({ type, title, subtitle, urgent, cleanId, bookingLocalId });
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
    if (days < 0 || days > 13) return;
    const clean = findMatchingCleanForBooking(b);
    const propName = isPortfolio ? getPropertyNameById(b._propertyId) : getCurrentPropertyName();
    const hasCleaner = !!(clean && (String(clean.cleaner || '').trim() || clean.cleanerId));

    if (days <= 13 && (!clean || !hasCleaner)) {
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

    if (days <= 6 && clean && !clean.done && hasCleaner) {
      const urg = days <= 3;
      const arrive =
        days <= 0 ? 'today' : days === 1 ? 'in 1 day' : `in ${days} days`;
      pushAlert(
        'a',
        'Clean not done',
        `${propName} · ${b.name} · arrives ${arrive}`,
        urg,
        clean.id,
        b.id
      );
    }
  });

  cleans.forEach(c => {
    if (isCleanLinkedToCancelledBooking(c)) return;
    if (!isPortfolio) {
      const cfg = getActivePropertyConfig();
      const pid = cloudIds[cfg.propertyId] || cfg.supabaseId || '';
      const bid = c.bookingId;
      const bk = bookings.find(
        x =>
          String(x.id) === String(bid) ||
          (x._cloudId && String(x._cloudId) === String(bid))
      );
      if (bk && pid && String(bk._propertyId || '') !== String(pid)) return;
      if (!bk && c._propertyId && pid && String(c._propertyId) !== String(pid)) return;
    }

    const propName = c._propertyId
      ? getPropertyNameById(c._propertyId)
      : isPortfolio && c.bookingId
        ? getPropertyNameById(
            bookings.find(
              x =>
                String(x.id) === String(c.bookingId) ||
                (x._cloudId && String(x._cloudId) === String(c.bookingId))
            )?._propertyId
          )
        : getCurrentPropertyName();

    const assignedAt = c.assignedAt ? new Date(c.assignedAt) : null;
    const ageH = assignedAt && !Number.isNaN(assignedAt.getTime())
      ? (now - assignedAt) / 3600000
      : 0;
    const hasCleaner = !!((c.cleaner && String(c.cleaner).trim()) || c.cleanerId);

    if (
      hasCleaner &&
      !c.cleanerConfirmed &&
      !c.cleanerDeclined &&
      !c.done &&
      ageH > 12
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

    if (c.cleanerDeclined && c.date && inNextDays(c.date, 7)) {
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

    // Review cleaning cost — done cleans in last 7 days with no fee on booking
    if (c.done && c.date) {
      const cd = parseLocalDayStart(c.date);
      const daysSince = Number.isNaN(cd.getTime()) ? 99 : Math.ceil((todayStart - cd) / 86400000);
      if (daysSince >= 0 && daysSince <= 7) {
        const bk = bookings.find(
          x => String(x.id) === String(c.bookingId) || (x._cloudId && String(x._cloudId) === String(c.bookingId))
        );
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
  if (!deduped.length) return '';
  const cards = deduped
    .map(a => {
      const dot = a.urgent ? '#E24B4A' : '#BA7517';
      let onclk;
      if (a.type === 'e' && a.bookingLocalId != null) {
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
      return `<div ${onclk} style="background:white;border-radius:8px;padding:10px 12px;margin-bottom:6px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:10px;touch-action:manipulation;-webkit-tap-highlight-color:rgba(0,0,0,0.06)">
          <div style="display:flex;align-items:flex-start;gap:8px;min-width:0;flex:1">
            <div style="width:6px;height:6px;border-radius:50%;background:${dot};margin-top:5px;flex-shrink:0"></div>
            <div style="min-width:0">
              <div style="font-weight:700;font-size:13px;color:#412402">${escHtml(a.title)}</div>
              <div style="font-size:11px;color:#854F0B;margin-top:2px;line-height:1.35">${escHtml(a.subtitle)}</div>
            </div>
          </div>
          <div style="font-size:18px;color:#854F0B;flex-shrink:0">›</div>
        </div>`;
    })
    .join('');
  const moreCount = deduped.length > 3 ? deduped.length - 3 : 0;
  const moreFooter =
    moreCount > 0
      ? `<div style="text-align:center;font-size:11px;color:#854F0B;margin-top:8px;padding-top:6px;border-top:1px solid rgba(133,79,11,0.12)">${moreCount} more</div>`
      : '';
  return `<div style="background:#FEF3E7;border-left:3px solid #BA7517;padding:12px 14px;margin-bottom:14px">
      <div style="font-size:12px;font-weight:500;color:#854F0B;margin-bottom:10px">Needs attention</div>
      <div style="max-height:200px;overflow-y:auto;-webkit-overflow-scrolling:touch;padding-right:2px">${cards}</div>
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
  const view = globalThis._stayopsTodayCalView || 'weekly';
  const dayOffset = globalThis._stayopsTodayDayOffset || 0;

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

  const segBtn = (v, label) => {
    const on = view === v;
    return `<button type="button" onclick="_stayopsSetTodayCalView('${v}')" style="flex:1;border:none;border-radius:8px;padding:8px 6px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;touch-action:manipulation;color:${on ? primary : tertiary};background:${on ? '#fff' : 'transparent'};box-shadow:${on ? '0 1px 3px rgba(0,0,0,0.12)' : 'none'}">${label}</button>`;
  };

  const bookingUpcoming = (b) => {
    const ci = parseLocalDayStart(b.checkin);
    return !Number.isNaN(ci.getTime()) && ci > todayStart;
  };

  const bookingBarsBlock = (rangeStart, rangeEnd) => {
    const list = activeBookings
      .filter((b) => {
        if (!b.checkin || !b.checkout) return false;
        const ci = parseLocalDayStart(b.checkin);
        const co = parseLocalDayStart(b.checkout);
        if (Number.isNaN(ci.getTime()) || Number.isNaN(co.getTime())) return false;
        return co > rangeStart && ci < rangeEnd;
      })
      .sort((a, b) => parseLocalDayStart(a.checkin) - parseLocalDayStart(b.checkin));
    if (!list.length) return '';
    const rows = list
      .map((b) => {
        const up = bookingUpcoming(b);
        const bg = up ? '#E3F2FD' : '#D4EDDA';
        const co = parseLocalDayStart(b.checkout);
        const ci = parseLocalDayStart(b.checkin);
        let r = fmtShort(b.checkin) + ' \u2013 ' + fmtShort(b.checkout);
        if (ci < rangeStart) r = '\u2190 ' + r;
        if (co > rangeEnd) r += ' \u2192';
        const bidEsc = escapeJsSingleQuotedHtmlAttr(String(b._cloudId || b.id));
        return `<div onclick="showDetail('${bidEsc}')" style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-radius:8px;margin-bottom:6px;background:${bg};cursor:pointer;touch-action:manipulation">
        <span style="font-size:12px;font-weight:500;color:${primary}">${escHtml(b.name)}</span>
        <span style="font-size:11px;color:${tertiary};text-align:right;white-space:nowrap;margin-left:8px">${escHtml(r)}</span>
      </div>`;
      })
      .join('');
    return `<div style="margin-top:12px;padding-top:12px;border-top:0.5px solid rgba(0,0,0,0.1)">${rows}</div>`;
  };

  const svgIn =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 19V5M12 5l4 4M12 5L8 9"/></svg>';
  const svgOut =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M12 19l4-4M12 19l-4-4"/></svg>';
  const svgSpark =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2l2 7h7l-6 4 2 7-5-5-5 5 2-7-6-4h7z"/></svg>';
  const svgWrench =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14.7 6.3a1 1 0 010 1.4l-2.8 2.8a4 4 0 11-5.6 5.6l-.7-.7 3.5-3.5-2.5-2.5 3.5-3.5.7.7a4 4 0 011.9-1.8c.5-.3 1.1-.2 1.5.2z"/></svg>';

  const dailyCard = (bg, border, titleC, iconBg, iconFg, svgEl, title, subHtml) =>
    `<div style="display:flex;gap:10px;align-items:flex-start;padding:12px;border-left:3px solid ${border};border-radius:8px;background:${bg};margin-bottom:8px">
      <div style="width:28px;height:28px;border-radius:8px;background:${iconBg};color:${iconFg};flex-shrink:0;display:flex;align-items:center;justify-content:center">${svgEl}</div>
      <div style="min-width:0;flex:1">
        <div style="font-size:13px;font-weight:600;color:${titleC}">${title}</div>
        ${subHtml ? `<div style="font-size:12px;color:var(--text-soft);margin-top:2px">${subHtml}</div>` : ''}
      </div>
    </div>`;

  let bodyHtml = '';

  if (view === 'daily') {
    const focus = new Date(todayStart);
    focus.setDate(focus.getDate() + dayOffset);
    const ds = _ymd(focus);
    const headLine = `${focus.toLocaleDateString('en-AU', { weekday: 'long' })}, ${focus.getDate()} ${focus.toLocaleDateString('en-AU', { month: 'short' })}`;
    const isFocusToday = ds === _ymd(todayStart);
    const todaySub = isFocusToday
      ? `<div style="font-size:12px;color:var(--text-soft);margin-top:2px;text-align:center">Today</div>`
      : '';

    const curGuest = activeBookings.find((b) => {
      const ci = parseLocalDayStart(b.checkin);
      const co = parseLocalDayStart(b.checkout);
      const d0 = new Date(focus.getFullYear(), focus.getMonth(), focus.getDate());
      return (
        !Number.isNaN(ci.getTime()) &&
        !Number.isNaN(co.getTime()) &&
        d0 >= ci &&
        d0 < co
      );
    });
    let statusPill = '';
    if (curGuest) {
      statusPill = `<span style="display:inline-block;padding:4px 10px;border-radius:999px;background:#E8F5E9;color:#1D9E75;font-size:12px;font-weight:600">${escHtml(curGuest.name)}</span>`;
    } else {
      statusPill = `<span style="display:inline-block;padding:4px 10px;border-radius:999px;background:#F1EFE8;color:#5F5E5A;font-size:12px;font-weight:600">Vacant</span>`;
    }

    const parts = [];
    const cinB = activeBookings.find((b) => String(b.checkin || '').slice(0, 10) === ds);
    if (cinB) {
      parts.push(
        dailyCard(
          '#E8F5E9',
          '#1D9E75',
          'var(--forest, #2D5A3D)',
          '#D4EDDA',
          '#1D9E75',
          svgIn,
          'Check-in',
          escHtml(cinB.name) +
            (cinB.guests
              ? ` \u00b7 ${escHtml(String(cinB.guests))} guest${cinB.guests === 1 ? '' : 's'}`
              : '')
        )
      );
    }
    const coutB = activeBookings.find((b) => String(b.checkout || '').slice(0, 10) === ds);
    if (coutB) {
      parts.push(
        dailyCard(
          '#FEF2F2',
          '#E24B4A',
          '#A32D2D',
          '#FCEBEB',
          '#E24B4A',
          svgOut,
          'Check-out',
          escHtml(coutB.name)
        )
      );
      const mc = findMatchingCleanForBooking(coutB);
      const hasCl = !!(mc && (String(mc.cleaner || '').trim() || mc.cleanerId));
      if (mc && !mc.done) {
        parts.push(
          dailyCard(
            '#FEF2F2',
            '#E24B4A',
            '#A32D2D',
            '#FCEBEB',
            '#E24B4A',
            svgSpark,
            'Clean not done',
            escHtml(mc.cleaner || 'Cleaner') + ' \u00b7 ' + fmtShort(mc.date || coutB.checkout)
          )
        );
      } else if (!hasCl) {
        parts.push(
          dailyCard(
            '#FEF2F2',
            '#E24B4A',
            '#A32D2D',
            '#FCEBEB',
            '#E24B4A',
            svgSpark,
            'Clean needed',
            'No cleaner assigned for departure'
          )
        );
      }
    }

    const clOnly = cleanForPropertyOnDate(ds);
    if (clOnly && (!coutB || findMatchingCleanForBooking(coutB)?.id !== clOnly.id)) {
      const clAssigned = !!((clOnly.cleaner && String(clOnly.cleaner).trim()) || clOnly.cleanerId);
      if (clOnly.done) {
        parts.push(
          dailyCard(
            '#E8F5E9',
            '#1D9E75',
            'var(--forest, #2D5A3D)',
            '#D4EDDA',
            '#1D9E75',
            svgSpark,
            'Clean complete',
            escHtml(clOnly.cleaner || 'Cleaner') + ' \u00b7 ' + fmtShort(clOnly.date)
          )
        );
      } else if (clAssigned) {
        parts.push(
          dailyCard(
            '#E8F5E9',
            '#1D9E75',
            'var(--forest, #2D5A3D)',
            '#D4EDDA',
            '#1D9E75',
            svgSpark,
            'Clean scheduled',
            escHtml(clOnly.cleaner || 'Cleaner') + ' \u00b7 ' + fmtShort(clOnly.date)
          )
        );
      } else {
        parts.push(
          dailyCard(
            '#FEF2F2',
            '#E24B4A',
            '#A32D2D',
            '#FCEBEB',
            '#E24B4A',
            svgSpark,
            'Clean needed',
            'No cleaner assigned \u00b7 ' + fmtShort(clOnly.date)
          )
        );
      }
    }

    if (!cinB && !coutB) {
      const occ = activeBookings.find((b) => {
        const ci = parseLocalDayStart(b.checkin);
        const co = parseLocalDayStart(b.checkout);
        const d0 = new Date(focus.getFullYear(), focus.getMonth(), focus.getDate());
        if (Number.isNaN(ci.getTime()) || Number.isNaN(co.getTime())) return false;
        if (!(d0 >= ci && d0 < co)) return false;
        if (String(b.checkin || '').slice(0, 10) === ds) return false;
        if (String(b.checkout || '').slice(0, 10) === ds) return false;
        return true;
      });
      if (occ) {
        const ci = parseLocalDayStart(occ.checkin);
        const n = Math.max(1, Math.floor((focus.getTime() - ci.getTime()) / 86400000) + 1);
        parts.push(
          dailyCard(
            '#E8F5E9',
            '#92C9A9',
            'var(--sage, #3D6B4F)',
            '#D4EDDA',
            '#1D9E75',
            svgIn,
            'Stay in progress',
            `${escHtml(occ.name)} \u00b7 night ${n}`
          )
        );
      }
    }

    maintListForDate(ds).forEach((mt) => {
      parts.push(
        dailyCard(
          '#FFF8E1',
          '#D4A017',
          '#7A5A00',
          '#FFECB3',
          '#D4A017',
          svgWrench,
          escHtml(mt.description || 'Maintenance'),
          escHtml(fmt(mt.date || mt.scheduledDate || ''))
        )
      );
    });

    const emptyHint =
      !parts.length
        ? `<div style="font-size:13px;color:var(--text-soft);text-align:center;padding:16px 8px">No events today</div>`
        : '';

    const resetDay =
      dayOffset !== 0
        ? `<div style="display:flex;justify-content:flex-end;margin-bottom:8px"><span onclick="_stayopsTodayDayReset()" style="font-size:11px;font-weight:600;color:var(--forest);cursor:pointer">Today</span></div>`
        : '';

    bodyHtml =
      `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px">
        <button type="button" onclick="_stayopsTodayDayNav(-1)" style="background:var(--warm);border:none;border-radius:8px;width:32px;height:32px;font-size:16px;cursor:pointer;color:${primary}">‹</button>
        <div style="text-align:center;flex:1;min-width:0">
          <div style="font-size:14px;font-weight:600;color:${primary}">${headLine}</div>
          ${todaySub}
        </div>
        <button type="button" onclick="_stayopsTodayDayNav(1)" style="background:var(--warm);border:none;border-radius:8px;width:32px;height:32px;font-size:16px;cursor:pointer;color:${primary}">›</button>
      </div>` +
      resetDay +
      `<div style="margin-bottom:12px;text-align:center">${statusPill}</div>` +
      parts.join('') +
      emptyHint;
  } else if (view === 'weekly') {
    if (!_todayWeekStart) _todayWeekStart = _mondayStart(new Date());
    const wkStart = new Date(
      _todayWeekStart.getFullYear(),
      _todayWeekStart.getMonth(),
      _todayWeekStart.getDate()
    );
    const wkEnd = new Date(wkStart);
    wkEnd.setDate(wkEnd.getDate() + 7);
    const wkEndLbl = new Date(wkStart);
    wkEndLbl.setDate(wkEndLbl.getDate() + 6);
    const wkRange =
      wkStart.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) +
      ' \u2014 ' +
      wkEndLbl.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });

    const pillDot = (col) =>
      `<span style="width:6px;height:6px;border-radius:50%;background:${col};flex-shrink:0"></span>`;

    const rows = [];
    for (let i = 0; i < 7; i++) {
      const dayDate = new Date(wkStart);
      dayDate.setDate(dayDate.getDate() + i);
      const dStr = _ymd(dayDate);
      const isTodayRow = dStr === _ymd(todayStart);
      const dnum = dayDate.getDate();
      const dname = dayDate.toLocaleDateString('en-AU', { weekday: 'short' });
      const pills = [];

      const cinBk = activeBookings.find((b) => String(b.checkin || '').slice(0, 10) === dStr);
      const coutBk = activeBookings.find((b) => String(b.checkout || '').slice(0, 10) === dStr);

      if (coutBk) {
        pills.push(
          `<div style="display:flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;font-size:11px;font-weight:500;background:#FEF2F2;color:#A32D2D;margin-bottom:4px">${pillDot('#E24B4A')}Check-out: ${escHtml(coutBk.name)}</div>`
        );
        const mc = findMatchingCleanForBooking(coutBk);
        const hasCl = !!(mc && (String(mc.cleaner || '').trim() || mc.cleanerId));
        if (mc && !mc.done) {
          pills.push(
            `<div style="display:flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;font-size:11px;font-weight:500;background:#FEF2F2;color:#A32D2D;margin-bottom:4px">${pillDot('#E24B4A')}Clean not done</div>`
          );
        } else if (!hasCl) {
          pills.push(
            `<div style="display:flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;font-size:11px;font-weight:500;background:#FAEEDA;color:#BA7517;margin-bottom:4px">${pillDot('#BA7517')}Clean needed</div>`
          );
        }
      }
      if (cinBk) {
        const gc =
          cinBk.guests != null && cinBk.guests !== ''
            ? `<span style="margin-left:6px;font-size:11px;font-weight:600;opacity:0.9">${escHtml(String(cinBk.guests))} guests</span>`
            : '';
        pills.push(
          `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 10px;border-radius:999px;font-size:11px;font-weight:500;background:#E8F5E9;color:#1D9E75;margin-bottom:4px"><span style="display:flex;align-items:center;gap:6px;min-width:0">${pillDot('#1D9E75')}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Check-in: ${escHtml(cinBk.name)}</span></span>${gc}</div>`
        );
      }

      maintListForDate(dStr).forEach((mt) => {
        pills.push(
          `<div style="display:flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;font-size:11px;font-weight:500;background:#FFF8E1;color:#7A5A00;margin-bottom:4px">
            <span style="flex-shrink:0;display:flex;color:#D4A017">${svgWrench}</span>
            <span style="overflow:hidden;text-overflow:ellipsis"><span style="font-weight:600">${escHtml(fmt(mt.date || mt.scheduledDate || ''))}</span> \u00b7 ${escHtml(mt.description || 'Maintenance')}</span>
          </div>`
        );
      });

      if (!cinBk && !coutBk) {
        const occ = activeBookings.find((b) => {
          const ci = parseLocalDayStart(b.checkin);
          const co = parseLocalDayStart(b.checkout);
          const d0 = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate());
          if (Number.isNaN(ci.getTime()) || Number.isNaN(co.getTime())) return false;
          if (!(d0 >= ci && d0 < co)) return false;
          if (String(b.checkin || '').slice(0, 10) === dStr) return false;
          if (String(b.checkout || '').slice(0, 10) === dStr) return false;
          return true;
        });
        if (occ) {
          const ci = parseLocalDayStart(occ.checkin);
          const n = Math.max(1, Math.floor((dayDate.getTime() - ci.getTime()) / 86400000) + 1);
          pills.push(
            `<div style="display:flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;font-size:11px;font-weight:500;background:#E8F5E9;color:#1D9E75;margin-bottom:4px">${pillDot('#1D9E75')}${escHtml(occ.name)} \u00b7 night ${n}</div>`
          );
        }
      }

      const cl = cleanForPropertyOnDate(dStr);
      if (cl && (!coutBk || findMatchingCleanForBooking(coutBk)?.id !== cl.id)) {
        const clAssigned = !!((cl.cleaner && String(cl.cleaner).trim()) || cl.cleanerId);
        if (cl.done) {
          pills.push(
            `<div style="display:flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;font-size:11px;font-weight:500;background:#E8F5E9;color:#1D9E75;margin-bottom:4px">${pillDot('#1D9E75')}Clean done</div>`
          );
        } else if (!clAssigned) {
          pills.push(
            `<div style="display:flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;font-size:11px;font-weight:500;background:#FAEEDA;color:#BA7517;margin-bottom:4px">${pillDot('#BA7517')}Clean needed</div>`
          );
        } else {
          pills.push(
            `<div style="display:flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;font-size:11px;font-weight:500;background:#FEF2F2;color:#A32D2D;margin-bottom:4px">${pillDot('#E24B4A')}Clean not done</div>`
          );
        }
      }

      const rightContent =
        pills.length > 0
          ? pills.join('')
          : `<span style="font-size:12px;color:var(--text-soft)">\u2014</span>`;

      const leftNumStyle = isTodayRow
        ? 'width:26px;height:26px;border-radius:50%;background:#1E3A2F;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700'
        : 'font-size:14px;font-weight:600;color:' + primary;

      const rowBg = isTodayRow ? 'background:var(--warm);' : '';
      const rowBorder = i < 6 ? 'border-bottom:0.5px solid rgba(0,0,0,0.06);' : '';
      rows.push(
        `<div style="display:flex;gap:10px;align-items:flex-start;padding:10px 8px;${rowBg}${rowBorder}">
          <div style="width:52px;flex-shrink:0;text-align:center">
            <div style="font-size:11px;font-weight:600;color:${tertiary};text-transform:capitalize">${dname}</div>
            <div style="margin-top:4px"><span style="${leftNumStyle}">${dnum}</span></div>
          </div>
          <div style="flex:1;min-width:0;display:flex;flex-direction:column;align-items:stretch">${rightContent}</div>
        </div>`
      );
    }

    bodyHtml =
      `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px">
        <button type="button" onclick="_todayWeekNav(-1)" style="background:var(--warm);border:none;border-radius:8px;width:32px;height:32px;font-size:16px;cursor:pointer;color:${primary}">‹</button>
        <div style="font-size:14px;font-weight:600;color:${primary};text-align:center;flex:1">${escHtml(wkRange)}</div>
        <button type="button" onclick="_todayWeekNav(1)" style="background:var(--warm);border:none;border-radius:8px;width:32px;height:32px;font-size:16px;cursor:pointer;color:${primary}">›</button>
      </div>
      <div style="display:flex;justify-content:flex-end;margin-bottom:8px">
        <span onclick="_todayWeekReset()" style="font-size:11px;font-weight:600;color:var(--forest);cursor:pointer">This week</span>
      </div>
      <div style="border-radius:10px;overflow:hidden;border:0.5px solid rgba(0,0,0,0.06)">
        ${rows.join('')}
      </div>` +
      bookingBarsBlock(wkStart, wkEnd);
  } else {
    const calM = _getTodayCalMonthStart();
    const calYear = calM.getFullYear();
    const calMonth = calM.getMonth();
    const calMonthName = calM.toLocaleString('en-AU', { month: 'long', year: 'numeric' });
    const firstJsDow = new Date(calYear, calMonth, 1).getDay();
    const leading = (firstJsDow + 6) % 7;
    const gridStart = new Date(calYear, calMonth, 1 - leading);
    const calHeader = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
      .map(
        (h) =>
          `<div style="text-align:center;font-size:10px;font-weight:600;color:${tertiary};padding:4px 0">${h}</div>`
      )
      .join('');

    const isBookedOnCalDate = (ymdStr) =>
      activeBookings.some((b) => {
        if (!b.checkin || !b.checkout) return false;
        const ci = parseLocalDayStart(b.checkin);
        const co = parseLocalDayStart(b.checkout);
        const d = parseLocalDayStart(ymdStr);
        return !Number.isNaN(ci.getTime()) && !Number.isNaN(co.getTime()) && d >= ci && d < co;
      });

    const firstBookingOnDate = (ymdStr) =>
      activeBookings.find((b) => {
        if (!b.checkin || !b.checkout) return false;
        const ci = parseLocalDayStart(b.checkin);
        const co = parseLocalDayStart(b.checkout);
        const d = parseLocalDayStart(ymdStr);
        return !Number.isNaN(ci.getTime()) && !Number.isNaN(co.getTime()) && d >= ci && d < co;
      });

    let calCells = '';
    for (let c = 0; c < 42; c++) {
      const cellDate = new Date(gridStart);
      cellDate.setDate(gridStart.getDate() + c);
      const inMonth = cellDate.getMonth() === calMonth && cellDate.getFullYear() === calYear;
      const dayNum = cellDate.getDate();
      const ymdStr = _ymd(cellDate);
      const isTodayCell = ymdStr === _ymd(todayStart);
      const booked = inMonth && isBookedOnCalDate(ymdStr);
      const bk = inMonth ? firstBookingOnDate(ymdStr) : null;
      const bidEsc = bk ? escapeJsSingleQuotedHtmlAttr(String(bk._cloudId || bk.id)) : '';
      const onclk = booked && bk ? `onclick="showDetail('${bidEsc}')"` : '';
      const numColor = inMonth ? primary : tertiary;
      const numStyle = isTodayCell
        ? `width:28px;height:28px;border-radius:50%;background:#2D5A3D;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:600`
        : `font-size:12px;color:${numColor};font-weight:500;opacity:${inMonth ? 1 : 0.45}`;
      const dotHtml = booked
        ? `<div style="width:4px;height:4px;border-radius:50%;background:#1D9E75;margin-top:2px"></div>`
        : '<div style="height:6px"></div>';
      calCells += `<div ${onclk} style="text-align:center;padding:6px 2px;min-height:44px;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;cursor:${booked ? 'pointer' : 'default'};touch-action:manipulation;-webkit-tap-highlight-color:rgba(0,0,0,0.06)">
        <span style="${numStyle}">${dayNum}</span>
        ${dotHtml}
      </div>`;
    }

    const monthStartR = new Date(calYear, calMonth, 1);
    const monthEndR = new Date(calYear, calMonth + 1, 1);

    bodyHtml =
      `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px">
        <span style="font-size:14px;font-weight:600;color:${primary}">${escHtml(calMonthName)}</span>
        <div style="display:flex;align-items:center;gap:4px">
          <button type="button" onclick="_todayCalNav(-1)" style="background:var(--warm);border:none;border-radius:8px;width:32px;height:32px;font-size:16px;cursor:pointer;color:${primary}">‹</button>
          <button type="button" onclick="_todayCalNav(1)" style="background:var(--warm);border:none;border-radius:8px;width:32px;height:32px;font-size:16px;cursor:pointer;color:${primary}">›</button>
        </div>
      </div>
      <div style="border-radius:10px;overflow:hidden;padding-bottom:8px">
        <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;margin-bottom:4px">${calHeader}</div>
        <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px">${calCells}</div>
      </div>` +
      bookingBarsBlock(monthStartR, monthEndR);
  }

  return (
    `<div style="background:white;border-radius:12px;border:0.5px solid rgba(0,0,0,0.1);padding:14px;margin-bottom:14px;box-sizing:border-box">` +
    `<div style="display:flex;background:var(--warm);border-radius:10px;padding:3px;margin-bottom:14px;gap:2px">` +
    segBtn('daily', 'Daily') +
    segBtn('weekly', 'Weekly') +
    segBtn('monthly', 'Monthly') +
    `</div>` +
    bodyHtml +
    `</div>`
  );
}

function buildSinglePropertyTodayDashboardMarkup() {
  const tertiary = '#6B6560';
  const primary = '#1a1a1a';
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

  const safeNum = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };

  const next30End = new Date(todayStart);
  next30End.setDate(next30End.getDate() + 30);
  const thisMonth = now.getMonth();
  const thisYear = now.getFullYear();
  const daysThisMonth = new Date(thisYear, thisMonth + 1, 0).getDate();
  const monthStart = new Date(thisYear, thisMonth, 1);
  const monthEnd = new Date(thisYear, thisMonth + 1, 1);
  const pad = n => String(n).padStart(2, '0');
  const monthStartStr = `${thisYear}-${pad(thisMonth + 1)}-01`;
  const nextM = thisMonth === 11 ? 0 : thisMonth + 1;
  const nextY = thisMonth === 11 ? thisYear + 1 : thisYear;
  const monthEndStr = `${nextY}-${pad(nextM + 1)}-01`;

  let bookedNightsMonth = 0;
  activeBookings.forEach(b => {
    if (!b.checkin || !b.checkout) return;
    const ci = new Date(Math.max(new Date(b.checkin).getTime(), monthStart.getTime()));
    const co = new Date(Math.min(new Date(b.checkout).getTime(), monthEnd.getTime()));
    if (co > ci) bookedNightsMonth += Math.round((co - ci) / 86400000);
  });
  const occupancyThisMonth = Math.max(0, Math.min(100, Math.round((bookedNightsMonth / daysThisMonth) * 100)));

  const revenueThisMonth = activeBookings
    .filter(b => {
      const ci = parseLocalDayStart(b.checkin);
      return !Number.isNaN(ci.getTime()) && ci >= monthStart && ci < monthEnd;
    })
    .reduce((s, b) => s + safeNum(b.hostPayout), 0);

  const revenueNext30 = activeBookings
    .filter(b => {
      const ci = parseLocalDayStart(b.checkin);
      return !Number.isNaN(ci.getTime()) && ci >= todayStart && ci < next30End;
    })
    .reduce((s, b) => s + safeNum(b.hostPayout), 0);

  let statusHtml = '';
  const currentGuest = activeBookings.find(b => {
    if (b.status === 'cancelled') return false;
    const ci = parseLocalDayStart(b.checkin);
    const co = parseLocalDayStart(b.checkout);
    return !Number.isNaN(ci.getTime()) && !Number.isNaN(co.getTime()) && ci <= todayStart && co > todayStart;
  });
  if (currentGuest) {
    statusHtml =
      `<div style="background:#E6F1FB;border-radius:8px;padding:8px 14px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">` +
      `<span style="color:#0C447C;font-weight:500">Occupied</span>` +
      `<span style="color:#185FA5;font-size:12px;text-align:right">${escHtml(currentGuest.name)} · checkout ${escHtml(fmtShort(currentGuest.checkout))}</span>` +
      `</div>`;
  } else {
    const upcoming = [...activeBookings]
      .filter(b => parseLocalDayStart(b.checkin) > todayStart)
      .sort((a, b) => parseLocalDayStart(a.checkin) - parseLocalDayStart(b.checkin));
    if (upcoming.length) {
      const u = upcoming[0];
      const days = Math.ceil((parseLocalDayStart(u.checkin) - todayStart) / 86400000);
      statusHtml =
        `<div style="background:#E6F1FB;border-radius:8px;padding:8px 14px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">` +
        `<span style="color:#0C447C;font-weight:500">Vacant</span>` +
        `<span style="color:#185FA5;font-size:12px;text-align:right">Next guest in ${days} day${days === 1 ? '' : 's'} · ${escHtml(u.name)}</span>` +
        `</div>`;
    } else {
      statusHtml =
        `<div style="background:#E6F1FB;border-radius:8px;padding:8px 14px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">` +
        `<span style="color:#0C447C;font-weight:500">Vacant</span>` +
        `<span style="color:#185FA5;font-size:12px">No upcoming bookings</span>` +
        `</div>`;
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

  const statsHtml = `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px">
    <div style="background:white;border-radius:10px;border:0.5px solid rgba(0,0,0,0.1);padding:12px 10px;text-align:center">
      <div style="font-size:18px;font-weight:500;color:${primary}">${occupancyThisMonth}%</div>
      <div style="font-size:11px;color:${tertiary};margin-top:3px">Occupancy</div>
    </div>
    <div style="background:white;border-radius:10px;border:0.5px solid rgba(0,0,0,0.1);padding:12px 10px;text-align:center">
      <div style="font-size:18px;font-weight:500;color:${primary}">$${Math.round(revenueThisMonth).toLocaleString()}</div>
      <div style="font-size:11px;color:${tertiary};margin-top:3px">Revenue this month</div>
    </div>
    <div style="background:white;border-radius:10px;border:0.5px solid rgba(0,0,0,0.1);padding:12px 10px;text-align:center">
      <div style="font-size:18px;font-weight:500;color:${primary}">$${Math.round(revenueNext30).toLocaleString()}</div>
      <div style="font-size:11px;color:${tertiary};margin-top:3px">Revenue next 30 days</div>
    </div>
  </div>`;

  const propExpenses = expenses.filter(e => {
    if (!e.date || e.date < monthStartStr || e.date >= monthEndStr) return false;
    if (!activePid) return true;
    return !e._propertyId || String(e._propertyId) === String(activePid);
  });
  const expSum = propExpenses.reduce((s, e) => s + safeNum(e.amount), 0);
  const openMaint = maintenance.filter(m => {
    if (m.status !== 'open' && m.status !== 'inprogress') return false;
    if (activePid && m._propertyId && String(m._propertyId) !== String(activePid)) return false;
    return true;
  });
  const lowStock = inventory.filter(i => {
    if (i.stock > i.threshold) return false;
    if (activePid && i._propertyId && String(i._propertyId) !== String(activePid)) return false;
    return true;
  });

  const quickRow = (label, right, danger, onclk) =>
    `<div onclick="${onclk}" style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:0.5px solid rgba(0,0,0,0.06);cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:rgba(0,0,0,0.06)">
      <span style="font-size:14px;color:${primary}">${label}</span>
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:13px;font-weight:600;color:${danger ? '#A32D2D' : tertiary}">${right}</span>
        <span style="color:${tertiary};font-size:16px">›</span>
      </div>
    </div>`;

  const quickHtml =
    `<div style="font-size:12px;font-weight:500;color:${tertiary};margin:0 0 6px 2px">Quick links</div>` +
    `<div style="background:white;border-radius:12px;border:0.5px solid rgba(0,0,0,0.12);overflow:hidden;margin-bottom:8px">` +
    quickRow(
      'Expenses this month',
      '$' + Math.round(expSum).toLocaleString(),
      false,
      "showSection('finance');showFinanceSub('expenses')"
    ) +
    quickRow(
      'Maintenance',
      openMaint.length + ' open',
      false,
      "showSection('property');showPropertySub('maintenance')"
    ) +
    quickRow(
      'Low stock',
      lowStock.length ? lowStock.length + ' items' : '0 items',
      lowStock.length > 0,
      "showSection('property');showPropertySub('inventory');setTimeout(function(){var el=document.getElementById('inv-tab-low');if(window.setInvView&&el)window.setInvView('low',el);},50)"
    ) +
    `</div>`;

  // Desktop: 2-column grid layout
  if (window.innerWidth >= 1024) {
    const upcoming = [...activeBookings]
      .filter(b => parseLocalDayStart(b.checkout) >= todayStart)
      .sort((a, b) => parseLocalDayStart(a.checkin) - parseLocalDayStart(b.checkin))
      .slice(0, 8);
    const fmtSh = d => { if (!d) return ''; const dt = new Date(d); return dt.toLocaleDateString('en-AU', { day:'numeric', month:'short' }); };
    const platformCls = p => { const lp = (p||'').toLowerCase(); if (lp.includes('airbnb')) return 'platform-airbnb'; if (lp.includes('vrbo')) return 'platform-vrbo'; return 'platform-direct'; };
    const statusBdg = b => {
      const today = new Date().toISOString().split('T')[0];
      const ci = (b.checkin||'').slice(0,10), co = (b.checkout||'').slice(0,10);
      if (ci === today) return '<span class="dt-badge dt-badge-green">Arriving</span>';
      if (co === today) return '<span class="dt-badge dt-badge-amber">Departing</span>';
      if (ci < today && co > today) return '<span class="dt-badge dt-badge-green">In-house</span>';
      return '<span class="dt-badge dt-badge-blue">Confirmed</span>';
    };
    const tblRows = upcoming.map(b => {
      const bid = escapeJsSingleQuotedHtmlAttr(String(b._cloudId || b.id));
      return `<tr onclick="showDetail('${bid}')" style="cursor:pointer"><td><strong>${escHtml(b.name)}</strong></td><td>${fmtSh(b.checkin)}</td><td>${fmtSh(b.checkout)}</td><td>$${Number(b.hostPayout||0).toLocaleString()}</td><td><span class="dt-platform ${platformCls(b.platform)}">${escHtml(b.platform||'Direct')}</span></td><td>${statusBdg(b)}</td></tr>`;
    }).join('');

    const upcomingTable = `<div class="card" style="padding:0;overflow:hidden">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 16px 12px">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-soft)">Upcoming Bookings</span>
        <span onclick="showSection('bookings')" style="font-size:12px;color:var(--moss);cursor:pointer;font-weight:500">View all &rarr;</span>
      </div>
      <table class="desktop-table"><thead><tr><th>Guest</th><th>Check-in</th><th>Check-out</th><th>Payout</th><th>Platform</th><th>Status</th></tr></thead><tbody>${tblRows || '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--text-soft)">No upcoming bookings</td></tr>'}</tbody></table>
    </div>`;

    // Today's cleans
    const todayCleans = cleans.filter(c => {
      const cd = (c.date||'').slice(0,10);
      const todayStr = todayStart.toISOString().split('T')[0];
      return cd === todayStr && !c.done;
    });
    const cleansHtml = todayCleans.length
      ? todayCleans.map(c => `<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #f0ede8">
          <div style="flex:1"><div style="font-size:13px;font-weight:500">${escHtml(c.guestName||c.name||'Guest')}</div><div style="font-size:11px;color:var(--text-soft)">${escHtml(c.propertyName||'')}</div></div>
          <div style="text-align:right"><div style="font-size:12px;color:var(--moss);font-weight:500">${escHtml(c.cleaner||'Unassigned')}</div><span class="dt-badge ${c.cleanerConfirmed?'dt-badge-green':'dt-badge-amber'}" style="font-size:10px">${c.cleanerConfirmed?'Confirmed':'Pending'}</span></div>
        </div>`).join('')
      : '<div style="text-align:center;padding:16px;color:var(--text-soft);font-size:13px">No cleans scheduled today<br><span onclick="showSection(\'cleaning\')" style="color:var(--moss);cursor:pointer;font-weight:500;font-size:12px">Go to cleaning \u2192</span></div>';

    // Occupancy card
    const occCard = `<div class="card">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-soft);margin-bottom:12px">Monthly Occupancy</div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
        <span style="font-family:'DM Serif Display',serif;font-size:32px;color:var(--forest)">${occupancyThisMonth}%</span>
        <span style="font-size:12px;color:var(--moss)">${bookedNightsMonth}/${daysThisMonth} nights</span>
      </div>
      <div style="height:8px;background:#e8e0d5;border-radius:4px;overflow:hidden"><div style="height:100%;background:var(--moss);border-radius:4px;width:${occupancyThisMonth}%"></div></div>
    </div>`;

    return `<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-bottom:20px">
      <div class="card" style="text-align:center"><div style="font-family:'DM Serif Display',serif;font-size:28px;color:var(--forest)">${occupancyThisMonth}%</div><div style="font-size:10px;color:var(--text-soft);text-transform:uppercase;letter-spacing:0.4px;margin-top:4px">Occupancy</div></div>
      <div class="card" style="text-align:center"><div style="font-family:'DM Serif Display',serif;font-size:28px;color:var(--forest)">$${Math.round(revenueThisMonth).toLocaleString()}</div><div style="font-size:10px;color:var(--text-soft);text-transform:uppercase;letter-spacing:0.4px;margin-top:4px">Revenue</div></div>
      <div class="card" style="text-align:center"><div style="font-family:'DM Serif Display',serif;font-size:28px;color:var(--forest)">${activeBookings.length}</div><div style="font-size:10px;color:var(--text-soft);text-transform:uppercase;letter-spacing:0.4px;margin-top:4px">Bookings</div></div>
      <div class="card" style="text-align:center"><div style="font-family:'DM Serif Display',serif;font-size:28px;color:var(--forest)">$${Math.round(revenueNext30).toLocaleString()}</div><div style="font-size:10px;color:var(--text-soft);text-transform:uppercase;letter-spacing:0.4px;margin-top:4px">Next 30 days</div></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr minmax(300px,380px);gap:20px">
      <div style="display:flex;flex-direction:column;gap:16px">
        ${upcomingTable}
        ${unifiedCalHtml}
      </div>
      <div style="display:flex;flex-direction:column;gap:16px">
        ${needsHtml ? '<div class="card">' + needsHtml + '</div>' : ''}
        <div class="card">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-soft);margin-bottom:12px">Today's Cleaning</div>
          ${cleansHtml}
        </div>
        ${occCard}
        ${quickHtml}
      </div>
    </div>`;
  }

  return (
    statusHtml +
    needsHtml +
    unifiedCalHtml +
    statsHtml +
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

  const usageSnapshot = getUsageSnapshotLite();
  const planState = getPlanStateLite();
  renderOnboardingGuidance(usageSnapshot);
  renderPlanNudges(usageSnapshot, planState);
}

function buildTodayDashboardMarkup(ctx) {
  if (!ctx.portfolio) return buildSinglePropertyTodayDashboardMarkup();
  return buildPortfolioTodayDashboardMarkup();
}

function buildPortfolioTodayDashboardMarkup() {
  const tertiary = '#6B6560';
  const primary = '#1a1a1a';
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

  const safeNum = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };

  let bookedNightsMonth = 0;
  activeBookings.forEach(b => {
    if (!b.checkin || !b.checkout) return;
    const ci = new Date(Math.max(new Date(b.checkin).getTime(), monthStart.getTime()));
    const co = new Date(Math.min(new Date(b.checkout).getTime(), monthEnd.getTime()));
    if (co > ci) bookedNightsMonth += Math.round((co - ci) / 86400000);
  });
  const denomDays = props.length > 1 ? daysThisMonth * props.length : daysThisMonth;
  const occupancyThisMonth = Math.max(0, Math.min(100, Math.round((bookedNightsMonth / denomDays) * 100)));

  const revenueThisMonth = activeBookings
    .filter(b => {
      const ci = parseLocalDayStart(b.checkin);
      return !Number.isNaN(ci.getTime()) && ci >= monthStart && ci < monthEnd;
    })
    .reduce((s, b) => s + safeNum(b.hostPayout), 0);

  const revenueNext30 = activeBookings
    .filter(b => {
      const ci = parseLocalDayStart(b.checkin);
      return !Number.isNaN(ci.getTime()) && ci >= todayStart && ci < next30End;
    })
    .reduce((s, b) => s + safeNum(b.hostPayout), 0);

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
      <button type="button" onclick="_todayWeekNav(-1)" style="background:#F1EFE8;border:none;border-radius:8px;width:32px;height:32px;font-size:16px;cursor:pointer;color:#1a1a1a">‹</button>
      <div style="font-size:13px;font-weight:500;color:${primary};text-align:center;flex:1">${escHtml(weekRangeLabel)}</div>
      <button type="button" onclick="_todayWeekNav(1)" style="background:#F1EFE8;border:none;border-radius:8px;width:32px;height:32px;font-size:16px;cursor:pointer;color:#1a1a1a">›</button>
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

  const statsHtml = `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:4px">
    <div style="background:white;border-radius:10px;border:0.5px solid rgba(0,0,0,0.1);padding:12px 10px;text-align:center">
      <div style="font-size:18px;font-weight:500;color:${primary}">${occupancyThisMonth}%</div>
      <div style="font-size:11px;color:${tertiary};margin-top:3px">Occupancy</div>
    </div>
    <div style="background:white;border-radius:10px;border:0.5px solid rgba(0,0,0,0.1);padding:12px 10px;text-align:center">
      <div style="font-size:18px;font-weight:500;color:${primary}">$${Math.round(revenueThisMonth).toLocaleString()}</div>
      <div style="font-size:11px;color:${tertiary};margin-top:3px">Revenue this month</div>
    </div>
    <div style="background:white;border-radius:10px;border:0.5px solid rgba(0,0,0,0.1);padding:12px 10px;text-align:center">
      <div style="font-size:18px;font-weight:500;color:${primary}">$${Math.round(revenueNext30).toLocaleString()}</div>
      <div style="font-size:11px;color:${tertiary};margin-top:3px">Revenue next 30 days</div>
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
      const today = new Date().toISOString().split('T')[0];
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
      return `<tr onclick="showDetail('${bid}')" style="cursor:pointer"><td><strong>${escHtml(b.name)}</strong></td><td style="font-size:12px;color:var(--text-soft)">${escHtml(propNameFor(b))}</td><td>${fmtSh(b.checkin)}</td><td>${fmtSh(b.checkout)}</td><td>$${Number(b.hostPayout||0).toLocaleString()}</td><td><span class="dt-platform ${platformCls(b.platform)}">${escHtml(b.platform||'Direct')}</span></td><td>${statusBdg(b)}</td></tr>`;
    }).join('');

    const upcomingTable = `<div class="card" style="padding:0;overflow:hidden">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 16px 12px">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-soft)">Upcoming Bookings</span>
        <span onclick="showSection('bookings')" style="font-size:12px;color:var(--moss);cursor:pointer;font-weight:500">View all &rarr;</span>
      </div>
      <table class="desktop-table"><thead><tr><th>Guest</th><th>Property</th><th>Check-in</th><th>Check-out</th><th>Payout</th><th>Platform</th><th>Status</th></tr></thead><tbody>${tblRows || '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text-soft)">No upcoming bookings</td></tr>'}</tbody></table>
    </div>`;

    // Today's cleans for sidebar
    const todayStr = todayStart.toISOString().split('T')[0];
    const todayCleans = cleans.filter(c => (c.date||'').slice(0,10) === todayStr && !c.done);
    const cleansHtml = todayCleans.length
      ? todayCleans.map(c => `<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #f0ede8">
          <div style="flex:1"><div style="font-size:13px;font-weight:500">${escHtml(c.guestName||c.name||'Guest')}</div><div style="font-size:11px;color:var(--text-soft)">${escHtml(c.propertyName||'')}</div></div>
          <div style="text-align:right"><div style="font-size:12px;color:var(--moss);font-weight:500">${escHtml(c.cleaner||'Unassigned')}</div></div>
        </div>`).join('')
      : '<div style="text-align:center;padding:16px;color:var(--text-soft);font-size:13px">No cleans today<br><span onclick="showSection(\'cleaning\')" style="color:var(--moss);cursor:pointer;font-weight:500;font-size:12px">Go to cleaning \u2192</span></div>';

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

    return `<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-bottom:20px">
      <div class="card" style="text-align:center"><div style="font-family:'DM Serif Display',serif;font-size:28px;color:var(--forest)">${occupancyThisMonth}%</div><div style="font-size:10px;color:var(--text-soft);text-transform:uppercase;letter-spacing:0.4px;margin-top:4px">Occupancy</div></div>
      <div class="card" style="text-align:center"><div style="font-family:'DM Serif Display',serif;font-size:28px;color:var(--forest)">$${Math.round(revenueThisMonth).toLocaleString()}</div><div style="font-size:10px;color:var(--text-soft);text-transform:uppercase;letter-spacing:0.4px;margin-top:4px">Revenue</div></div>
      <div class="card" style="text-align:center"><div style="font-family:'DM Serif Display',serif;font-size:28px;color:var(--forest)">${activeBookings.length}</div><div style="font-size:10px;color:var(--text-soft);text-transform:uppercase;letter-spacing:0.4px;margin-top:4px">Bookings</div></div>
      <div class="card" style="text-align:center"><div style="font-family:'DM Serif Display',serif;font-size:28px;color:var(--forest)">$${Math.round(revenueNext30).toLocaleString()}</div><div style="font-size:10px;color:var(--text-soft);text-transform:uppercase;letter-spacing:0.4px;margin-top:4px">Next 30 days</div></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr minmax(300px,380px);gap:20px">
      <div style="display:flex;flex-direction:column;gap:16px">
        ${upcomingTable}
        ${weekCard}
      </div>
      <div style="display:flex;flex-direction:column;gap:16px">
        ${needsHtml ? '<div class="card" style="padding:16px">' + needsHtml + '</div>' : ''}
        <div class="card"><div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-soft);margin-bottom:12px">Today's Cleaning</div>${cleansHtml}</div>
        <div class="card">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-soft);margin-bottom:12px">Occupancy by Property</div>
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
            <span style="font-family:'DM Serif Display',serif;font-size:32px;color:var(--forest)">${occupancyThisMonth}%</span>
            <span style="font-size:12px;color:var(--moss)">${bookedNightsMonth}/${denomDays} nights</span>
          </div>
          <div style="height:8px;background:#e8e0d5;border-radius:4px;overflow:hidden;margin-bottom:12px"><div style="height:100%;background:var(--moss);border-radius:4px;width:${occupancyThisMonth}%"></div></div>
          ${propOccHtml}
        </div>
      </div>
    </div>`;
  }

  return needsHtml + weekCard + next7Html + statsHtml;
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
          <button onclick="deleteMaintenance('${m.id}')" style="font-size:10px;color:var(--text-soft);background:none;border:none;cursor:pointer">✕</button>
          ${m.status !== 'resolved' ? `
          <button onclick="resolveIssue('${m.id}')" style="font-size:11px;background:var(--moss);color:white;border:none;border-radius:8px;padding:5px 10px;cursor:pointer;font-family:'DM Sans',sans-serif">Mark Resolved</button>
          <button onclick="setMaintInProgress('${m.id}')" style="font-size:11px;background:var(--forest-light);color:var(--sage);border:none;border-radius:8px;padding:5px 10px;cursor:pointer;font-family:'DM Sans',sans-serif">In Progress</button>
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
      <div onclick="restockItem('${i.id}')" style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--warm);cursor:pointer;transition:background 0.15s" onmouseover="this.style.background='var(--mist)'" onmouseout="this.style.background=''">
        <div style="width:22px;height:22px;border-radius:5px;border:2px solid var(--stone);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:14px;color:var(--moss)">+</div>
        <div>
          <div style="font-weight:600;font-size:14px">${i.name}${i.unit?` <span style="font-size:12px;font-weight:400;color:var(--text-soft)">(${i.unit})</span>`:''}</div>
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
        <button onclick="adjustStock('${i.id}',-1)" style="width:30px;height:30px;border-radius:50%;border:1px solid var(--stone);background:white;font-size:17px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;flex-shrink:0">−</button>
        <span style="font-weight:700;font-size:17px;min-width:26px;text-align:center;color:${isLow?'var(--red)':'var(--forest)'}">${i.stock}</span>
        <button onclick="adjustStock('${i.id}',1)" style="width:30px;height:30px;border-radius:50%;border:none;background:var(--forest);color:white;font-size:17px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;flex-shrink:0">+</button>
        <button onclick="openInvEdit('${i.id}')" style="width:30px;height:30px;border-radius:50%;border:1px solid var(--stone);background:white;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:var(--forest)">ℹ</button>
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
  replaceArrayInPlace(inventory, inventory.filter(i => i.id !== id));
  savePropertyData();
  renderInventory();
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
    if (el.hasAttribute('data-no-press')) return;
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
  } catch (e) { /* ignore malformed session JSON */ }
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

    const cleanerRecord = data.cleaner;
    // Ensure the cleaner's local_id is a number if it was originally
    if (cleanerRecord.id && !isNaN(Number(cleanerRecord.id))) {
      cleanerRecord.id = Number(cleanerRecord.id);
    }
    // Populate cleans
    if (Array.isArray(data.cleans)) {
      replaceArrayInPlace(cleans, data.cleans);
    }

    // Populate bookings
    if (Array.isArray(data.bookings)) {
      replaceArrayInPlace(bookings, data.bookings);
    }

    // Populate inventory
    if (Array.isArray(data.inventory)) {
      replaceArrayInPlace(inventory, data.inventory);
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
  if (window._cleanerData) {
    const signOutPromise = window._sb ? window._sb.auth.signOut() : Promise.resolve();
    signOutPromise.finally(() => {
      window._cleanerData = null;
      document.body.classList.remove('cleaner-mode');
      const cleanerNav = document.getElementById('cleaner-nav');
      const cleanerContent = document.getElementById('cleaner-content');
      if (cleanerNav) cleanerNav.style.display = 'none';
      if (cleanerContent) cleanerContent.style.display = 'none';
      if (typeof showLoginScreen === 'function') showLoginScreen();
    });
    return;
  }
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
          <div style="font-family:inherit;font-size:16px;font-weight:500;color:#1a1a1a">${urgency || 'Upcoming'}</div>
          <div style="font-size:13px;font-weight:400;color:#999;margin-top:2px">${c.date ? fmt(c.date) : '—'}</div>
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
        <div style="font-family:inherit;font-size:16px;font-weight:500;color:#1a1a1a;margin-bottom:6px">Nothing new!</div>
        <div style="font-size:13px;font-weight:400;color:#999">New assignments will appear here</div>
        <div style="font-size:13px;font-weight:400;color:#999;margin-top:8px">If you were just assigned, tap <strong>↻ Refresh</strong>.</div>
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
        <div style="font-family:inherit;font-size:16px;font-weight:500;color:#1a1a1a;margin-bottom:6px">No upcoming cleans</div>
        <div style="font-size:13px;font-weight:400;color:#999">Cleans you've accepted will appear here</div>
        <div style="font-size:13px;font-weight:400;color:#999;margin-top:8px">Accept a clean from the <strong>New</strong> tab first.</div>
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
          <button onclick="cleanerAdjustStock('${i.id}',-1)" style="width:36px;height:36px;border-radius:50%;border:1.5px solid var(--stone);background:white;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1">−</button>
          <span style="font-weight:700;font-size:18px;min-width:28px;text-align:center;color:${isLow?'var(--red)':'var(--forest)'}">${i.stock}</span>
          <button onclick="cleanerAdjustStock('${i.id}',1)" style="width:36px;height:36px;border-radius:50%;border:none;background:var(--forest);color:white;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1">+</button>
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
  const item = inventory.find(i => String(i.id) === String(id));
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
    // Show admin nav button for owner
    if (typeof globalThis.isAdminSync === 'function' && globalThis.isAdminSync()) {
      const adminNav = document.getElementById('nav-admin');
      if (adminNav) adminNav.style.display = '';
    }
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
    if (s) s.style.display = n === step ? '' : 'none';
  });
  // Only 2 dots now (step 1 and step 3)
  const d1 = document.getElementById('onboard-dot-1');
  const d3 = document.getElementById('onboard-dot-3');
  if (d1) d1.classList.toggle('active', true);
  if (d3) d3.classList.toggle('active', step >= 3);
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

  _obGoToStep(3);  // Skip Step 2 (email connection now in Getting Started checklist)
}

// Step 2 — Connect email (kept for OAuth callback compatibility)
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
  ['airbnb', 'booking', 'stayz', 'vrbo', 'direct'].forEach(p => {
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
  } catch(e) { /* ignore if getAllProperties is not yet defined */ }
  if (localStorage.getItem('gh-setup-complete') === '1') return true;
  try {
    const cfg = typeof getActivePropertyConfig === 'function' ? getActivePropertyConfig() : null;
    if (cfg && cfg.name) return true;
  } catch(e) { /* ignore if getActivePropertyConfig is not yet defined */ }
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

function renderNewCleanerView(data) {
  if (!data) return;
  const { cleanerRecord, myCleans } = data;

  // Hide FAB — cleaners don't need the quick-add button
  const fab = document.querySelector('.fab');
  if (fab) fab.style.display = 'none';
  const qaFab = document.getElementById('quick-add-fab');
  if (qaFab) qaFab.style.display = 'none';

  // Set header date badge (normally only set during host init)
  renderHeaderDateBadge();

  const greeting = document.getElementById('cleaner-greeting');
  if (greeting) greeting.textContent = 'Welcome, ' + (cleanerRecord.name || 'Cleaner');

  // Update header subtitle — show property name instead of location
  const headerSub = document.querySelector('.cleaner-header .header-sub-name');
  if (headerSub) {
    const propName = window._cleanerData && window._cleanerData.property && window._cleanerData.property.name;
    headerSub.textContent = propName || '';
  }

  const container = document.getElementById('cleaner-section-cleans');
  if (!container) return;

  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return days[d.getDay()] + ', ' + d.getDate() + ' ' + months[d.getMonth()];
  }

  function daysUntil(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr + 'T00:00:00');
    const diff = Math.ceil((d - today) / (1000 * 60 * 60 * 24));
    return diff;
  }

  function urgencyPill(days) {
    if (days === null) return '';
    let bg, color, label;
    if (days < 0) {
      bg = '#F1EFE8'; color = '#5F5E5A'; label = 'Past';
    } else if (days === 0) {
      bg = '#FCEBEB'; color = '#A32D2D'; label = 'Today';
    } else if (days === 1) {
      bg = '#FCEBEB'; color = '#A32D2D'; label = 'Tomorrow';
    } else if (days <= 7) {
      bg = '#FCEBEB'; color = '#A32D2D'; label = 'In ' + days + ' days';
    } else if (days <= 30) {
      bg = '#FAEEDA'; color = '#854F0B'; label = 'In ' + days + ' days';
    } else {
      bg = '#E1F5EE'; color = '#0F6E56'; label = 'In ' + days + ' days';
    }
    return '<div style="font-size:11px;font-weight:500;background:' + bg + ';color:' + color + ';padding:3px 10px;border-radius:12px;white-space:nowrap">' + label + '</div>';
  }

  const actionNeeded = myCleans.filter(c => !c.done && !c.cleaner_confirmed && !c.cleaner_declined);
  const upcoming = myCleans.filter(c => !c.done && c.cleaner_confirmed && c.clean_date >= todayStr);
  const completed = myCleans.filter(c => c.done);

  let html = '';

  // Action needed
  if (actionNeeded.length) {
    html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:12px">';
    html += '<div style="width:8px;height:8px;border-radius:50%;background:#E24B4A"></div>';
    html += '<span style="font-size:12px;font-weight:500;color:#A32D2D;text-transform:uppercase;letter-spacing:0.4px">Action needed</span>';
    html += '<span style="font-size:11px;color:#999;margin-left:2px">' + actionNeeded.length + '</span>';
    html += '</div>';

    actionNeeded.forEach(c => {
      const prop = c.properties || {};
      const days = daysUntil(c.clean_date);
      const guests = c.guests || '';
      const guestLine = (c.guest_name || 'Guest') + (guests ? ' · ' + guests + ' guests' : '');

      html += '<div style="background:white;border:0.5px solid #eee;border-left:3px solid #E24B4A;border-radius:0 8px 8px 0;padding:14px 16px;margin-bottom:10px">';
      html += '<div style="display:flex;justify-content:space-between;align-items:flex-start">';
      html += '<div>';
      html += '<div style="font-size:17px;font-weight:500;color:#1a1a1a">' + formatDate(c.clean_date) + '</div>';
      html += '<div style="font-size:13px;color:#888;margin-top:2px">' + guestLine + '</div>';
      html += '</div>';
      html += urgencyPill(days);
      html += '</div>';
      html += '<div style="margin-top:10px;padding:10px 12px;background:#f7f7f5;border-radius:6px">';
      html += '<div style="font-size:13px;font-weight:500;color:#333">' + (prop.name || 'Property') + '</div>';
      html += '<div style="font-size:12px;color:#888;margin-top:1px">' + (prop.address || '') + '</div>';
      html += '</div>';
      html += '<div style="display:flex;gap:8px;margin-top:12px">';
      html += '<button type="button" data-action="accept" data-clean-id="' + String(c.id) + '" style="flex:1;padding:10px;background:#1E3A2F;color:white;border:none;border-radius:8px;font-weight:500;font-size:13px;cursor:pointer">Accept</button>';
      html += '<button type="button" data-action="decline" data-clean-id="' + String(c.id) + '" style="flex:1;padding:10px;background:transparent;color:#A32D2D;border:1px solid #F09595;border-radius:8px;font-weight:500;font-size:13px;cursor:pointer">Decline</button>';
      html += '</div></div>';
    });
  }

  // Upcoming confirmed
  if (upcoming.length) {
    html += '<div style="display:flex;align-items:center;gap:6px;margin:20px 0 12px">';
    html += '<div style="width:8px;height:8px;border-radius:50%;background:#1D9E75"></div>';
    html += '<span style="font-size:12px;font-weight:500;color:#0F6E56;text-transform:uppercase;letter-spacing:0.4px">Confirmed</span>';
    html += '<span style="font-size:11px;color:#999;margin-left:2px">' + upcoming.length + '</span>';
    html += '</div>';

    upcoming.forEach(c => {
      const prop = c.properties || {};
      const days = daysUntil(c.clean_date);
      const checkInInfo = prop.check_in_info || {};
      const guests = c.guests || '';
      const guestLine = (c.guest_name || 'Guest') + (guests ? ' · ' + guests + ' guests' : '');

      html += '<div style="background:white;border:0.5px solid #eee;border-left:3px solid #1D9E75;border-radius:0 8px 8px 0;padding:14px 16px;margin-bottom:10px">';
      html += '<div style="display:flex;justify-content:space-between;align-items:flex-start">';
      html += '<div>';
      html += '<div style="font-size:17px;font-weight:500;color:#1a1a1a">' + formatDate(c.clean_date) + '</div>';
      html += '<div style="font-size:13px;color:#888;margin-top:2px">' + guestLine + '</div>';
      html += '</div>';
      html += urgencyPill(days);
      html += '</div>';
      html += '<div style="margin-top:10px;padding:10px 12px;background:#f7f7f5;border-radius:6px">';
      html += '<div style="font-size:13px;font-weight:500;color:#333">' + (prop.name || 'Property') + '</div>';
      html += '<div style="font-size:12px;color:#888;margin-top:1px">' + (prop.address || '') + '</div>';
      html += '</div>';

      if (checkInInfo.lockbox_code || checkInInfo.instructions) {
        html += '<div style="margin-top:8px;padding:10px 12px;background:#f7f7f5;border-radius:6px;font-size:12px;color:#666">';
        html += '<div style="font-weight:500;margin-bottom:2px;color:#333">Access info</div>';
        let accessParts = [];
        if (checkInInfo.lockbox_code) accessParts.push('Lockbox: ' + checkInInfo.lockbox_code);
        if (checkInInfo.instructions) accessParts.push(checkInInfo.instructions);
        html += accessParts.join(' · ');
        html += '</div>';
      }

      const cleanDateObj = new Date(c.clean_date + 'T00:00:00');
      const isToday = c.clean_date === todayStr;
      const isPast = cleanDateObj < today;
      if (isToday || isPast) {
        html += '<button type="button" data-action="done" data-clean-id="' + String(c.id) + '" style="width:100%;margin-top:10px;padding:10px;background:transparent;color:#1E3A2F;border:1px solid #ccc;border-radius:8px;font-weight:500;font-size:13px;cursor:pointer">Mark as done</button>';
      }
      html += '</div>';
    });
  }

  // Completed
  if (completed.length) {
    html += '<div style="display:flex;align-items:center;gap:6px;margin:20px 0 12px">';
    html += '<div style="width:8px;height:8px;border-radius:50%;background:#999"></div>';
    html += '<span style="font-size:12px;font-weight:500;color:#999;text-transform:uppercase;letter-spacing:0.4px">Completed</span>';
    html += '</div>';

    completed.slice(0, 10).forEach(c => {
      const prop = c.properties || {};
      html += '<div style="background:#f9f9f7;border:0.5px solid #eee;border-radius:8px;padding:12px 16px;margin-bottom:8px;opacity:0.7">';
      html += '<div style="display:flex;justify-content:space-between;align-items:center">';
      html += '<div>';
      html += '<div style="font-size:14px;font-weight:500;color:#555">' + formatDate(c.clean_date) + '</div>';
      html += '<div style="font-size:12px;color:#999;margin-top:1px">' + (c.guest_name || '') + ' · ' + (prop.name || '') + '</div>';
      html += '</div>';
      html += '<div style="font-size:11px;color:#999">Done</div>';
      html += '</div></div>';
    });
  }

  if (!html) {
    html = '<div style="text-align:center;padding:40px 20px;color:#999"><div style="font-size:40px;margin-bottom:12px">✨</div><div style="font-size:15px;font-weight:500">No cleans assigned yet</div><div style="font-size:13px;margin-top:6px">Your host will assign cleans to you here.</div></div>';
  }

  container.innerHTML = html;

  if (!container._cleanerDelegated) {
    container.addEventListener('click', async function (e) {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      e.stopPropagation();
      e.stopImmediatePropagation();
      const action = btn.getAttribute('data-action');
      const cleanId = btn.getAttribute('data-clean-id');
      if (!cleanId) return;
      if (action === 'accept') await cleanerAcceptClean(cleanId);
      else if (action === 'decline') await cleanerDeclineClean(cleanId);
      else if (action === 'done') await cleanerMarkDone(cleanId);
    }, true);
    container._cleanerDelegated = true;
  }
}
window.renderNewCleanerView = renderNewCleanerView;

async function cleanerAcceptClean(cleanId) {
  if (!window._sb) return;
  const { error } = await window._sb
    .from('cleans')
    .update({ cleaner_confirmed: true, confirmed_at: new Date().toISOString() })
    .eq('id', cleanId);
  if (error) { alert('Failed to accept: ' + error.message); return; }
  const data = typeof globalThis.loadCleanerDashboard === 'function'
    ? await globalThis.loadCleanerDashboard()
    : null;
  if (data) {
    try {
      const cleanData = data.myCleans?.find((c) => String(c.id) === String(cleanId));
      const guestName = cleanData?.guest_name || cleanData?.guestName || 'guest';
      const cleanDate = cleanData?.clean_date || cleanData?.date || '';
      const cleanerName = data.cleanerRecord?.name || 'Cleaner';
      const uid = cleanData?.user_id || getCleanerParams().uid;
      if (uid) {
        await fetch('/.netlify/functions/send-push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: uid,
            title: '✅ Clean Confirmed',
            body: cleanerName + ' accepted the clean for ' + guestName + (cleanDate ? ' on ' + cleanDate : ''),
            url: '/',
            tag: 'accept-' + cleanId
          })
        });
      }
    } catch (e) {
      console.warn('[StayOps] Push notify failed:', e);
    }
    window._cleanerData = data;
    renderNewCleanerView(data);
    renderCleanerCalendar();
    renderCleanerProfile();
  }
}
window.cleanerAcceptClean = cleanerAcceptClean;

async function cleanerDeclineClean(cleanId) {
  if (!window._sb) return;
  const { error } = await window._sb
    .from('cleans')
    .update({ cleaner_declined: true })
    .eq('id', cleanId);
  if (error) { alert('Failed to decline: ' + error.message); return; }
  const data = typeof globalThis.loadCleanerDashboard === 'function'
    ? await globalThis.loadCleanerDashboard()
    : null;
  if (data) {
    try {
      const cleanData = data.myCleans?.find((c) => String(c.id) === String(cleanId));
      const guestName = cleanData?.guest_name || cleanData?.guestName || 'guest';
      const cleanDate = cleanData?.clean_date || cleanData?.date || '';
      const cleanerName = data.cleanerRecord?.name || 'Cleaner';
      const uid = cleanData?.user_id || getCleanerParams().uid;
      if (uid) {
        await fetch('/.netlify/functions/send-push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: uid,
            title: '❌ Clean Declined',
            body: cleanerName + ' cannot do the clean for ' + guestName + (cleanDate ? ' on ' + cleanDate : '') + '. Reassign needed.',
            url: '/',
            tag: 'decline-' + cleanId
          })
        });
      }
    } catch (e) {
      console.warn('[StayOps] Push notify failed:', e);
    }
    window._cleanerData = data;
    renderNewCleanerView(data);
    renderCleanerCalendar();
    renderCleanerProfile();
  }
}
window.cleanerDeclineClean = cleanerDeclineClean;

async function cleanerMarkDone(cleanId) {
  if (!window._sb) return;
  const { error } = await window._sb
    .from('cleans')
    .update({ done: true, completed_at: new Date().toISOString() })
    .eq('id', cleanId);
  if (error) { alert('Failed to mark done: ' + error.message); return; }
  const data = typeof globalThis.loadCleanerDashboard === 'function'
    ? await globalThis.loadCleanerDashboard()
    : null;
  if (data) {
    try {
      const cleanData = data.myCleans?.find((c) => String(c.id) === String(cleanId));
      const guestName = cleanData?.guest_name || cleanData?.guestName || 'guest';
      const cleanDate = cleanData?.clean_date || cleanData?.date || '';
      const cleanerName = data.cleanerRecord?.name || 'Cleaner';
      const uid = cleanData?.user_id || getCleanerParams().uid;
      if (uid) {
        await fetch('/.netlify/functions/send-push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: uid,
            title: '🏡 Clean Complete!',
            body: cleanerName + ' has finished the clean for ' + guestName + (cleanDate ? ' on ' + cleanDate : '') + ' — review cleaning cost',
            url: '/',
            tag: 'done-' + cleanId
          })
        });
      }
    } catch (e) {
      console.warn('[StayOps] Push notify failed:', e);
    }
    window._cleanerData = data;
    renderNewCleanerView(data);
    renderCleanerCalendar();
    renderCleanerProfile();
  }
}
window.cleanerMarkDone = cleanerMarkDone;

function renderCleanerCalendar() {
  const container = document.getElementById('cleaner-section-calendar');
  if (!container || !window._cleanerData) return;

  const cleans = window._cleanerData.myCleans || [];
  const today = new Date();
  let viewMonth = window._cleanerCalMonth || today.getMonth();
  let viewYear = window._cleanerCalYear || today.getFullYear();
  window._cleanerCalMonth = viewMonth;
  window._cleanerCalYear = viewYear;

  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  const cleanDates = {};
  cleans.forEach((c) => {
    if (c.clean_date) {
      cleanDates[c.clean_date] = cleanDates[c.clean_date] || [];
      cleanDates[c.clean_date].push(c);
    }
  });

  const firstDay = new Date(viewYear, viewMonth, 1);
  const lastDay = new Date(viewYear, viewMonth + 1, 0);
  let startDay = firstDay.getDay() - 1;
  if (startDay < 0) startDay = 6;

  let html = '';
  html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">';
  html += '<button onclick="cleanerCalNav(-1)" style="background:none;border:none;font-size:20px;cursor:pointer;padding:8px">‹</button>';
  html += '<div style="font-weight:700;font-size:16px;color:var(--forest,#1E3A2F)">' + monthNames[viewMonth] + ' ' + viewYear + '</div>';
  html += '<button onclick="cleanerCalNav(1)" style="background:none;border:none;font-size:20px;cursor:pointer;padding:8px">›</button>';
  html += '</div>';

  html += '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;margin-bottom:12px">';
  dayNames.forEach((d) => {
    html += '<div style="text-align:center;font-size:11px;font-weight:600;color:#999;padding:4px 0">' + d + '</div>';
  });

  for (let i = 0; i < startDay; i++) {
    html += '<div></div>';
  }

  const todayStr = today.toISOString().split('T')[0];

  for (let d = 1; d <= lastDay.getDate(); d++) {
    const dateStr = viewYear + '-' + String(viewMonth + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    const hasCleans = cleanDates[dateStr];
    const isToday = dateStr === todayStr;

    html += '<div onclick="showCleanerDayDetail(\'' + dateStr + '\')" style="text-align:center;padding:8px 2px;border-radius:10px;cursor:' + (hasCleans ? 'pointer' : 'default') + ';' + (isToday ? 'background:var(--forest,#1E3A2F);color:white;font-weight:700;' : '') + '">';
    html += '<div style="font-size:14px">' + d + '</div>';
    if (hasCleans) {
      const dotColor = hasCleans.some((c) => !c.cleaner_confirmed && !c.done) ? '#C0392B' : '#3B6D11';
      html += '<div style="width:6px;height:6px;border-radius:50%;background:' + dotColor + ';margin:3px auto 0"></div>';
    }
    html += '</div>';
  }
  html += '</div>';
  html += '<div id="cleaner-day-detail"></div>';
  container.innerHTML = html;
}
window.renderCleanerCalendar = renderCleanerCalendar;

function cleanerCalNav(dir) {
  window._cleanerCalMonth = (window._cleanerCalMonth || new Date().getMonth()) + dir;
  window._cleanerCalYear = window._cleanerCalYear || new Date().getFullYear();
  if (window._cleanerCalMonth > 11) { window._cleanerCalMonth = 0; window._cleanerCalYear++; }
  if (window._cleanerCalMonth < 0) { window._cleanerCalMonth = 11; window._cleanerCalYear--; }
  renderCleanerCalendar();
}
window.cleanerCalNav = cleanerCalNav;

function showCleanerDayDetail(dateStr) {
  const container = document.getElementById('cleaner-day-detail');
  if (!container || !window._cleanerData) return;

  const cleans = (window._cleanerData.myCleans || []).filter((c) => c.clean_date === dateStr);
  if (!cleans.length) { container.innerHTML = ''; return; }

  let html = '<div style="margin-top:12px;padding-top:12px;border-top:1px solid #eee">';
  html += '<div style="font-weight:700;font-size:13px;color:var(--forest,#1E3A2F);margin-bottom:8px">' + dateStr + '</div>';

  cleans.forEach((c) => {
    const prop = c.properties || {};
    const status = c.done ? 'Done' : c.cleaner_confirmed ? 'Confirmed' : c.cleaner_declined ? 'Declined' : 'Pending';
    const statusColor = c.done ? '#999' : c.cleaner_confirmed ? '#3B6D11' : c.cleaner_declined ? '#C0392B' : '#F5A623';
    html += '<div style="background:white;border-radius:10px;padding:12px;margin-bottom:6px;box-shadow:0 1px 3px rgba(0,0,0,0.05)">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center">';
    html += '<div style="font-weight:600;font-size:14px">' + (prop.name || 'Property') + '</div>';
    html += '<span style="font-size:11px;font-weight:700;color:' + statusColor + ';background:' + statusColor + '15;padding:3px 8px;border-radius:6px">' + status + '</span>';
    html += '</div>';
    html += '<div style="font-size:12px;color:#666;margin-top:3px">' + (c.guest_name || '') + '</div>';
    html += '</div>';
  });

  html += '</div>';
  container.innerHTML = html;
}
window.showCleanerDayDetail = showCleanerDayDetail;

function renderCleanerProfile() {
  const container = document.getElementById('cleaner-section-profile');
  if (!container || !window._cleanerData) return;

  const cr = window._cleanerData.cleanerRecord;

  // Update header subtitle — show property name instead of location
  const headerSub = document.querySelector('.cleaner-header .header-sub-name');
  if (headerSub) {
    const propName = window._cleanerData.property && window._cleanerData.property.name;
    headerSub.textContent = propName || '';
  }

  let html = '';
  html += '<div style="background:white;border-radius:16px;padding:24px;box-shadow:0 1px 4px rgba(0,0,0,0.06)">';
  html += '<div style="text-align:center;margin-bottom:20px">';
  html += '<div style="width:64px;height:64px;border-radius:50%;background:var(--forest,#1E3A2F);color:white;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;margin:0 auto 10px">' + ((cr.name || 'C')[0].toUpperCase()) + '</div>';
  html += '<div style="font-weight:700;font-size:18px;color:var(--forest,#1E3A2F)">' + (cr.name || 'Cleaner') + '</div>';
  html += '</div>';
  html += '<div style="border-top:1px solid #f0f0f0;padding-top:16px">';
  html += '<div style="display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #f5f5f3">';
  html += '<span style="font-size:13px;color:#999">Email</span>';
  html += '<span style="font-size:13px;font-weight:600;color:#333">' + (cr.email || '—') + '</span>';
  html += '</div>';
  html += '<div style="display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #f5f5f3">';
  html += '<span style="font-size:13px;color:#999">Phone</span>';
  html += '<span style="font-size:13px;font-weight:600;color:#333">' + (cr.phone || '—') + '</span>';
  html += '</div>';
  html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid #f5f5f3">';
  html += '<span style="font-size:13px;color:#999">Notifications</span>';
  html += '<span id="cleaner-profile-notif-status" style="font-size:13px;font-weight:600;color:#999"></span>';
  html += '</div>';

  const cleans = window._cleanerData.myCleans || [];
  const completed = cleans.filter((c) => c.done).length;
  const upcoming = cleans.filter((c) => !c.done && c.cleaner_confirmed).length;

  html += '<div style="display:flex;gap:12px;margin-top:20px">';
  html += '<div style="flex:1;background:#f5f5f3;border-radius:12px;padding:14px;text-align:center">';
  html += '<div style="font-size:22px;font-weight:700;color:var(--forest,#1E3A2F)">' + completed + '</div>';
  html += '<div style="font-size:11px;color:#999;margin-top:2px">Completed</div>';
  html += '</div>';
  html += '<div style="flex:1;background:#f5f5f3;border-radius:12px;padding:14px;text-align:center">';
  html += '<div style="font-size:22px;font-weight:700;color:var(--forest,#1E3A2F)">' + upcoming + '</div>';
  html += '<div style="font-size:11px;color:#999;margin-top:2px">Upcoming</div>';
  html += '</div>';
  html += '</div>';
  html += '</div></div>';
  html += '<button onclick="cleanerSignOut()" style="width:100%;margin-top:20px;padding:14px;background:white;color:#C0392B;border:1.5px solid #C0392B;border-radius:12px;font-weight:700;font-size:14px;cursor:pointer">Sign Out</button>';

  container.innerHTML = html;

  // Check notification status — use unique ID to avoid conflict with legacy header element
  const notifEl = document.getElementById('cleaner-profile-notif-status');
  if (notifEl) {
    const enableBtn =
      '<button onclick="window._enableCleanerNotifs()" style="background:var(--forest,#1E3A2F);color:white;border:none;border-radius:8px;padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer">Enable</button>';
    if (typeof Notification === 'undefined' || !('serviceWorker' in navigator)) {
      notifEl.innerHTML = '<span style="color:#C0392B">Not supported</span>';
    } else if (Notification.permission === 'granted') {
      notifEl.innerHTML = '<span style="color:#1D9E75">✓ Enabled</span>';
    } else if (Notification.permission === 'denied') {
      notifEl.innerHTML = '<span style="color:#C0392B">Blocked</span>';
    } else {
      notifEl.innerHTML = enableBtn;
    }
  }
}
window.renderCleanerProfile = renderCleanerProfile;

window._enableCleanerNotifs = async function () {
  const el = document.getElementById('cleaner-profile-notif-status');
  if (el) el.innerHTML = '<span style="color:#999">Enabling…</span>';
  try {
    const cr = window._cleanerData && window._cleanerData.cleanerRecord;
    const cleanerId = cr ? cr.id : null;
    if (typeof globalThis.subscribeToPush === 'function') {
      await globalThis.subscribeToPush('cleaner', cleanerId);
    } else {
      // Fallback: import dynamically
      const { subscribeToPush } = await import('./notifications.js');
      await subscribeToPush('cleaner', cleanerId);
    }
    if (el) el.innerHTML = '<span style="color:#1D9E75">✓ Enabled</span>';
    if (typeof globalThis.showBanner === 'function') {
      globalThis.showBanner('Notifications enabled!', 'success');
    }
  } catch (e) {
    console.warn('[StayOps] Enable notifs failed:', e);
    if (el) el.innerHTML = '<span style="color:#C0392B">Failed — try again</span>';
  }
};

function showCleanerSection(section) {
  ['cleans', 'calendar', 'profile'].forEach((s) => {
    const el = document.getElementById('cleaner-section-' + s);
    if (el) el.style.display = s === section ? '' : 'none';
  });
  document.querySelectorAll('#cleaner-nav .nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.id === 'cnav-' + section);
  });
  const titles = { cleans: 'My Cleans', calendar: 'Calendar', profile: 'Profile' };
  const hdr = document.querySelector('#cleaner-header > div:first-child');
  if (hdr) hdr.textContent = titles[section] || 'My Cleans';

  if (section === 'calendar') renderCleanerCalendar();
  if (section === 'profile') renderCleanerProfile();
}
window.showCleanerSection = showCleanerSection;

function getInviteButtonHtml(cleaner) {
  if (!cleaner.email) {
    return '<span style="font-size:11px;color:#999;font-style:italic">No email - can\'t invite</span>';
  }
  if (cleaner.invitation_status === 'active' || cleaner.auth_user_id) {
    return '<span style="font-size:11px;color:#3B6D11;font-weight:600">✓ Account linked</span>';
  }
  const cloudId = cleaner._cloudId || cleaner.cloud_id;
  if (!cloudId) {
    return '<span style="font-size:11px;color:#999;font-style:italic">Save team to sync cleaner before inviting</span>';
  }
  if (cleaner.invitation_status === 'invited') {
    return '<button id="invite-btn-' + cloudId + '" onclick="inviteCleaner(\'' + (cleaner._cloudId || cleaner.cloud_id) + '\')" style="font-size:12px;padding:6px 12px;background:transparent;color:var(--forest,#1E3A2F);border:1px solid var(--forest,#1E3A2F);border-radius:8px;font-weight:600;cursor:pointer">Resend Invite</button>';
  }
  return '<button id="invite-btn-' + cloudId + '" onclick="inviteCleaner(\'' + (cleaner._cloudId || cleaner.cloud_id) + '\')" style="font-size:12px;padding:6px 12px;background:var(--forest,#1E3A2F);color:white;border:none;border-radius:8px;font-weight:600;cursor:pointer">Invite to App</button>';
}
window.getInviteButtonHtml = getInviteButtonHtml;

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
