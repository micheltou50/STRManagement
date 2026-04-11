import { SupabaseAdapter } from './adapter.js';
import { showSetupIfNeeded } from './setup.js';
import {
  getAllProperties, getActivePropertyId, setActivePropertyId, getActivePropertyConfig,
  addPropertyConfig, savePropertyConfig, hasValidPropertyConfig, migrateConfigFromLegacySettings, initPropertyUI,
} from './config.js';
import {
  getSupabaseSession, getCurrentSupabaseUser, seedLocalConfigFromCloud, hydrateFromCloud, savePropertyToCloud, saveHostConfigToCloud,
  loadCleansFromCloud, saveCleansToCloud, saveInventoryToCloud, saveMaintenanceToCloud, deleteMaintenanceFromCloud,
  saveBookingToCloud, saveBookingsToCloud, deleteBookingFromCloud, saveHostConfigToSupabase, loadHostConfigFromSupabase, saveAppConfigToCloud, saveExpenseToCloud,
  showLoadingScreen, hideLoadingScreen, setLoadingStatus, showLoginScreen, handleAuthFailure, showAppChrome,
  handleLoginSubmit, handleSignUpSubmit, handleMagicLinkSubmit, toggleSignUp, hostSignOut,
  detectUserRole, showCleanerApp, loadCleanerDashboard,
} from './supabase.js';
import { calcNights, calcNet } from './utils.js';
import {
  _sendCleanerAssignmentNotifications, enableNotificationsManually, resetPushOnly, updateNotifStatus, subscribeToPush, sendPushToDevice, getCleanerSub, getFreshHostSub, sendCleanerEmail, cleanerLinkForId, openNotifyModal, sendCleanerReminder, pickContact, sendSMS,
  closeNotifyModal, applyPreset, loadEmailTemplate, saveEmailTemplate, resetEmailTemplate, insertTemplateVar, openEmailTemplatePanel, updateEmailPreview, testNotificationConfig, testCleanerEmail
} from './notifications.js';
import {
  switchActiveProperty, openPropertySettingsMenu, openPropertySwitcherSheet, closePropertySwitcherSheet, switchToPortfolioFromSheet, backToPropertyHub, showPropertySub, renderProperty, openPropertyAccessRules, openPropertyDetailsFromHub, openOwnerReportFromHub,
  getPropertyColour, getPropertyColourById, getPropertyNameById, isPortfolioMode, enterPortfolioMode, exitPortfolioMode, applyPortfolioModeAfterHostHydrate
} from './property.js';
import {
  getSmartPricing, analyseExpenses, renderAIIgnoreList, promptIgnore, removeAIIgnoreItem, attachExpensePhoto, attachExpenseFile, clearExpensePhoto, extractExpenseFromReceipt, isExpensePhotoConverting, getExpensePhotoUploadSnapshot, readBookingScreenshot,
  extractBookingFromScreenshot
} from './ai.js';
import {
  normalizeBookingCleanState, isCleanLinkedToCancelledBooking, getBookingCleanerState, isCleanerPerson, populateSelects, populateCleanerSelect, renderCleaning, quickAssignLastCleaner, addClean, autoFillCleanDate, assignCleanerToBooking, jumpToAssignClean,
  toggleCleanAction, markCleanDeclined, markCleanerConfirmed, reassignClean, toggleCleanerConfirmed, revealCleanerReassign, switchCleanView, setCleanStatusFilter, cleanerAccept, cleanerDecline, cleanerMarkDone
} from './cleaning.js';
import {
  resetFinanceSubViewToHub, backToFinanceHub, toggleExpenseAddForm, closeExpenseAddForm, showFinanceSub, switchReportsSubTab, openFinancePanelFromHub, switchPayoutsSubTab, switchMgmtSubTab, switchReportSubTab, renderMgmtFY, renderFinance, fyPrev,
  fyNext, renderReport, revPrev, revNext, renderRevenue, mgmtPrev, mgmtNext, renderManagement, toggleMgmtSelect, mgmtCheckboxChange, mgmtToggleSelectAll, generateInvoice, confirmInvoiceClient, renderClientsList,
  addClient, deleteClient, saveBankDetails, saveInvoiceDetails, updateExpenseCat, addExpenseCat, deleteExpenseCat, resetExpenseCats, populateExpenseCatSelect, merchantAutocomplete, selectMerchantSuggest, hideMerchantSuggest,
  toggleExpenseList, toggleExpenseMonth, clearExpenseFilters, renderExpenses, addExpense, saveExpenseToDriveAndSheet, deleteExpense, attachEditExpensePhoto, clearEditExpensePhoto, openExpenseView, openExpenseEdit, closeExpenseEdit,
  saveExpenseEdit, getExpenseCats, populateMgmtFeePanel, saveMgmtFeeRate, ownerAutoSendToggle, saveOwnerReportSettings, sendOwnerReport, exportReportPDF, exportReportCSV,
  getAtoField, getAtoFieldLabel, checkReceiptNudge,
  showReconciliationView, renderReconciliationView, filterReconciliation,
  showDepreciationView,
  exportTaxPDF, exportTaxCSV, taxExportFYPrev, taxExportFYNext
} from './finance.js';
import {
  getRecurringTemplates, addRecurringTemplate, deleteRecurringTemplate,
  processRecurringTemplates, renderRecurringPanel, toggleRecurringEnabled,
  saveRecurringFromForm, getFrequencyLabel, getFrequencyOptions
} from './recurring.js';
import {
  getDepreciationAssets, addDepreciationAsset, deleteDepreciationAsset,
  getAssetDepreciationForFY, getTotalDepreciationForFY, getAssetSchedule,
  renderDepreciationPanel, showDepreciationDetail, deleteDepreciationAssetUI,
  saveDepreciationFromForm, onDepPresetChange, DEPRECIATION_PRESETS
} from './depreciation.js';
import {
  renderConnectionSummary, refreshConnectionSummarySoon, connectGmail, connectOutlook, maybeAutoScanGmail, scanGmailBookings, maybeAutoScanOutlook, scanOutlookBookings, populateCalendarFeedPanel, copyCalendarFeedUrl, _resetSettingsToMenu, openSettingsCat,
  openSettingsPanel, closeSettingsPanel, closeSettingsCat, renderSettings, clearCacheAndResync, saveSMSTemplate, saveGeminiKey, saveApiKey, getApiKey, getHostProfile, saveHostProfile, saveHostProfilePanel,
  renderHostProfileRow, loadCleaners, saveCleaners, addCleaner, deleteCleaner, renderTeamList, openCleanerProfile, saveCleanerContact, populateContractorSelect, renderStorageViewer, getFx, saveFxSetting,
  initFxSettings, initSettingsSwipeBack, toggleAutoAssignCleaner, resetConnectionCheckerResults, openCleanerSettings, renderCleanerAccessList, saveCleanerPinById, clearCleanerPinById, saveCleanerPerm, copyCleanerLinkById,
  testCMConnection, syncCMBookings, requestCMSetup, disconnectCM, loadCMMapping, saveCMMapping, maybeAutoSyncCM
} from './settings.js';
import {
  calPrev, calNext, openCalPreview, closeCalPreview, addNote, showDetail, showEditModal, saveEdit, editCalcNights, editCalcNet, filterBookings, addBooking,
  deleteBooking, importAirbnbCSV, importCSV, switchModalTab, saveCleaningFee, renderBookings
} from './bookings.js';
import {
  renderAdmin, switchAdminTab, adminHandleToggle, adminToggleTemplate, adminSendTestEmail,
  isAdminSync, getNotificationConfig, isNotifEnabled
} from './admin.js';
import {
  initMessaging, openChat, closeChat, sendMessage, sendAutoMessage,
  getUnreadCount, renderChatBubble, uploadChatPhoto
} from './messaging.js';
import {
  showBanner, platformIcon, reloadInMemoryData, showSection, jumpToCleaningActionNeeded, jumpToScheduleClean, render, renderAll, renderDashboard, renderHeaderDateBadge,
  applyStayopsPostSwitchAction, openModal, closeModal, closeDetailModal, _checkModalsClosed, openQuickAddMenu, closeQuickAddMenu, runFullRefresh, ensureHostIdentityAndRestore, renderMaintenance,
  addMaintenance, setMaintInProgress, resolveIssue, deleteMaintenance, setInvView, renderInventory, addInventoryItem, updateThreshold, adjustStock, restockItem,
  deleteInventoryItem, openInvEdit, closeInvEdit, saveInvEdit, deleteInventoryItemFromEdit, savePropertyData, reassignBookingProperty, processScanNeedsReview, showAppModal, appModalConfirm,
  appModalCancel, attachButtonPress, animateList, closeActionSheet, attachLongPress, attachModalHandleDrag, isCleanerMode, getCleanerParams, hydrateCleanerFromFunction, _showCleanerLinkError,
  isCleanerAuthed, pinPress, pinDelete, cleanerRefresh, enableCleanerNotifications, cleanerSignOut, switchCleanerTab, switchCleanerCleanTab, renderCleanerView, cleanerAddInventoryItem,
  cleanerAdjustStock, finishAppInit, showOnboarding, hideOnboarding, _obGoToStep, onboardStep1Next, onboardConnectGoogle, onboardConnectMicrosoft, onboardEmailConnected, onboardStep2Skip,
  onboardTogglePlatform, onboardFinish, isOnboardingComplete, checkAutoSendReport, _calNavigate, renderOnboardingGuidance,
  dismissChecklist
} from './render.js';

// ── GLOBAL SCOPE ASSIGNMENTS ───────────────────────────────────────────────────
// ES modules are scoped — functions are not automatically global.
// These expose functions that index.html onclick handlers, dynamically generated
// HTML, and cross-module calls depend on.

// finance.js / settings.js import before main body; runtime hooks for cross-module calls
globalThis.savePropertyData = savePropertyData;
globalThis.getHostProfile = getHostProfile;
globalThis._checkModalsClosed = _checkModalsClosed;
globalThis.animateList = animateList;
globalThis.attachLongPress = attachLongPress;
globalThis.attachModalHandleDrag = attachModalHandleDrag;
globalThis.closeDetailModal = closeDetailModal;
globalThis.closeModal = closeModal;
globalThis.hydrateFromCloud = hydrateFromCloud;
globalThis.loadCleanerDashboard = loadCleanerDashboard;
globalThis.processScanNeedsReview = processScanNeedsReview;
globalThis.render = render;
globalThis.renderAll = renderAll;
globalThis.renderOnboardingGuidance = renderOnboardingGuidance;
globalThis.showSection = showSection;
globalThis.reloadInMemoryData = reloadInMemoryData;
globalThis.populateContractorSelect = populateContractorSelect;
globalThis.renderMaintenance = renderMaintenance;
globalThis.showAppModal = showAppModal;
globalThis.loadCleaners = loadCleaners;
globalThis.saveBookingToCloud = saveBookingToCloud;
globalThis.saveBookingsToCloud = saveBookingsToCloud;
globalThis.deleteBookingFromCloud = deleteBookingFromCloud;
globalThis.saveCleansToCloud = saveCleansToCloud;
globalThis.getCurrentSupabaseUser = getCurrentSupabaseUser;
globalThis.getFreshHostSub = getFreshHostSub;
globalThis.sendPushToDevice = sendPushToDevice;
globalThis.renderAdmin = renderAdmin;
globalThis.isAdminSync = isAdminSync;
globalThis.getNotificationConfig = getNotificationConfig;
globalThis.isNotifEnabled = isNotifEnabled;
globalThis.processRecurringTemplates = processRecurringTemplates;
globalThis.renderRecurringPanel = renderRecurringPanel;
globalThis.getRecurringTemplates = getRecurringTemplates;
globalThis.saveAppConfigToCloud = saveAppConfigToCloud;
globalThis.saveExpenseToCloud = saveExpenseToCloud;
globalThis.renderDepreciationPanel = renderDepreciationPanel;
globalThis.getDepreciationAssets = getDepreciationAssets;
globalThis.getTotalDepreciationForFY = getTotalDepreciationForFY;
globalThis.getAssetDepreciationForFY = getAssetDepreciationForFY;
globalThis.getAssetSchedule = getAssetSchedule;
globalThis.DEPRECIATION_PRESETS = DEPRECIATION_PRESETS;
globalThis.sendAutoMessage = sendAutoMessage;

// Called from index.html onclick/onchange handlers
window.handleLoginSubmit        = handleLoginSubmit;
window.handleSignUpSubmit       = handleSignUpSubmit;
window.handleMagicLinkSubmit    = handleMagicLinkSubmit;
window.toggleSignUp             = toggleSignUp;
window.hostSignOut              = hostSignOut;
window.addBooking               = addBooking;
window.addClean                 = addClean;
window.addCleaner               = addCleaner;
window.addExpense               = addExpense;
window.addExpenseCat            = addExpenseCat;
window.updateExpenseCat         = updateExpenseCat;
window.addInventoryItem         = addInventoryItem;
window.addMaintenance           = addMaintenance;
window.addNote                  = addNote;
window.analyseExpenses          = analyseExpenses;
window.appModalCancel           = appModalCancel;
window.appModalConfirm          = appModalConfirm;
window.attachEditExpensePhoto   = attachEditExpensePhoto;
window.attachExpenseFile        = attachExpenseFile;
window.autoFillCleanDate        = autoFillCleanDate;
window.resetFinanceSubViewToHub = resetFinanceSubViewToHub;
window.backToFinanceHub         = backToFinanceHub;
window.backToPropertyHub        = backToPropertyHub;
window.calcNet                  = calcNet;
window.calcNights               = calcNights;
window.cleanerAddInventoryItem  = cleanerAddInventoryItem;
window.cleanerRefresh           = cleanerRefresh;
window.cleanerSignOut           = cleanerSignOut;
window.clearCacheAndResync      = clearCacheAndResync;
window.clearEditExpensePhoto    = clearEditExpensePhoto;
window.clearExpenseFilters      = clearExpenseFilters;
window.clearExpensePhoto        = clearExpensePhoto;
window.closeActionSheet         = closeActionSheet;
window.closeCalPreview          = closeCalPreview;
window.closeDetailModal         = closeDetailModal;
window.closeExpenseEdit         = closeExpenseEdit;
window.closeInvEdit             = closeInvEdit;
window.closeModal               = closeModal;
window.closeNotifyModal         = closeNotifyModal;
window.closePropertySwitcherSheet = closePropertySwitcherSheet;
window.closeQuickAddMenu        = closeQuickAddMenu;
window.openQuickAddMenu         = openQuickAddMenu;
window.closeSettingsCat         = closeSettingsCat;
window.closeSettingsPanel       = closeSettingsPanel;
window.confirmInvoiceClient     = confirmInvoiceClient;
window.deleteInventoryItemFromEdit = deleteInventoryItemFromEdit;
window.enableCleanerNotifications = enableCleanerNotifications;
window.enableNotificationsManually = enableNotificationsManually;
window.extractBookingFromScreenshot = extractBookingFromScreenshot;
window.extractExpenseFromReceipt = extractExpenseFromReceipt;
window.filterBookings           = filterBookings;
window.fyNext                   = fyNext;
window.fyPrev                   = fyPrev;
window.generateInvoice          = generateInvoice;
window.getSmartPricing          = getSmartPricing;
window.importAirbnbCSV          = importAirbnbCSV;
window.importCSV                = importCSV;
window.merchantAutocomplete     = merchantAutocomplete;
window.mgmtNext                 = mgmtNext;
window.mgmtPrev                 = mgmtPrev;
window.onboardConnectGoogle     = onboardConnectGoogle;
window.onboardConnectMicrosoft  = onboardConnectMicrosoft;
window.onboardFinish            = onboardFinish;
window.onboardStep1Next         = onboardStep1Next;
window.onboardTogglePlatform    = onboardTogglePlatform;
window.openFinancePanelFromHub  = openFinancePanelFromHub;
window.openModal                = openModal;
window.openOwnerReportFromHub   = openOwnerReportFromHub;
window.openPropertyAccessRules  = openPropertyAccessRules;
window.openPropertyDetailsFromHub = openPropertyDetailsFromHub;
window.openPropertySettingsMenu = openPropertySettingsMenu;
window.openPropertySwitcherSheet = openPropertySwitcherSheet;
window.openSettingsCat          = openSettingsCat;
window.openSettingsPanel        = openSettingsPanel;
window.ownerAutoSendToggle      = ownerAutoSendToggle;
window.pickContact              = pickContact;
window.pinDelete                = pinDelete;
window.pinPress                 = pinPress;
window.readBookingScreenshot    = readBookingScreenshot;
window.renderAIIgnoreList       = renderAIIgnoreList;
window.renderExpenses           = renderExpenses;
window.renderMgmtFY             = renderMgmtFY;
window.renderReport             = renderReport;
window.renderStorageViewer      = renderStorageViewer;
window.resetExpenseCats         = resetExpenseCats;
window.resetPushOnly            = resetPushOnly;
window.revNext                  = revNext;
window.revPrev                  = revPrev;
window.runFullRefresh           = runFullRefresh;
window.showBanner               = showBanner;
window.refreshConnectionSummarySoon = refreshConnectionSummarySoon;
window.platformIcon             = platformIcon;
window.reassignBookingProperty  = reassignBookingProperty;
window.saveApiKey               = saveApiKey;
window.saveBankDetails          = saveBankDetails;
window.saveExpenseEdit          = saveExpenseEdit;
window.saveHostProfilePanel     = saveHostProfilePanel;
window.saveInvEdit              = saveInvEdit;
window.saveMgmtFeeRate          = saveMgmtFeeRate;
window.saveOwnerReportSettings  = saveOwnerReportSettings;
window.saveSMSTemplate          = saveSMSTemplate;
window.saveFxSetting            = saveFxSetting;
window.sendOwnerReport          = sendOwnerReport;
window.sendSMS                  = sendSMS;
window.setInvView               = setInvView;
window.showFinanceSub           = showFinanceSub;
window.showReconciliationView   = showReconciliationView;
window.renderReconciliationView = renderReconciliationView;
window.filterReconciliation     = filterReconciliation;
window.showPropertySub          = showPropertySub;
window.showSection              = showSection;
window.switchActiveProperty     = switchActiveProperty;
window.switchCleanerCleanTab    = switchCleanerCleanTab;
window.switchCleanerTab         = switchCleanerTab;
window.switchMgmtSubTab         = switchMgmtSubTab;
window.switchModalTab           = switchModalTab;
window.switchPayoutsSubTab      = switchPayoutsSubTab;
window.switchReportsSubTab      = switchReportsSubTab;
window.testCleanerEmail         = testCleanerEmail;
window.testNotificationConfig   = testNotificationConfig;
window.toggleAutoAssignCleaner  = toggleAutoAssignCleaner;
window.toggleExpenseAddForm     = toggleExpenseAddForm;
window.toggleExpenseList        = toggleExpenseList;
window.switchAdminTab           = switchAdminTab;
window.adminHandleToggle        = adminHandleToggle;
window.adminToggleTemplate      = adminToggleTemplate;
window.adminSendTestEmail       = adminSendTestEmail;
window.saveRecurringFromForm    = saveRecurringFromForm;
window.toggleRecurringEnabled   = toggleRecurringEnabled;
window.deleteRecurringTemplate  = deleteRecurringTemplate;
window.saveDepreciationFromForm = saveDepreciationFromForm;
window.deleteDepreciationAssetUI = deleteDepreciationAssetUI;
window.showDepreciationDetail   = showDepreciationDetail;
window.onDepPresetChange        = onDepPresetChange;
window.exportTaxPDF             = exportTaxPDF;
window.exportTaxCSV             = exportTaxCSV;
window.taxExportFYPrev          = taxExportFYPrev;
window.taxExportFYNext          = taxExportFYNext;

// Called from dynamically generated HTML (onclick strings in template literals)
window.adjustStock              = adjustStock;
window.applyPreset              = applyPreset;
window.openEmailTemplatePanel   = openEmailTemplatePanel;
window.assignCleanerToBooking   = assignCleanerToBooking;
window.cleanerAccept            = cleanerAccept;
window.cleanerAdjustStock       = cleanerAdjustStock;
window.cleanerDecline           = cleanerDecline;
window.cleanerMarkDone          = cleanerMarkDone;
window.clearCleanerPinById      = clearCleanerPinById;
window.connectGmail             = connectGmail;
window.connectOutlook           = connectOutlook;
window.copyCalendarFeedUrl      = copyCalendarFeedUrl;
window.copyCleanerLinkById      = copyCleanerLinkById;
window.deleteBooking            = deleteBooking;
window.deleteCleaner            = deleteCleaner;
window.deleteClient             = deleteClient;
window.deleteExpenseCat         = deleteExpenseCat;
window.deleteMaintenance        = deleteMaintenance;
window.exportReportCSV          = exportReportCSV;
window.exportReportPDF          = exportReportPDF;
window.insertTemplateVar        = insertTemplateVar;
window.jumpToAssignClean          = jumpToAssignClean;
window.jumpToCleaningActionNeeded = jumpToCleaningActionNeeded;
window.toggleCleanAction          = toggleCleanAction;
window.markCleanDeclined        = markCleanDeclined;
window.markCleanerConfirmed     = markCleanerConfirmed;
window.openCalPreview           = openCalPreview;
window.openCleanerProfile       = openCleanerProfile;
window.openExpenseView          = openExpenseView;
window.openInvEdit              = openInvEdit;
window.openNotifyModal          = openNotifyModal;
window.promptIgnore             = promptIgnore;
window.quickAssignLastCleaner   = quickAssignLastCleaner;
window.reassignClean            = reassignClean;
window.removeAIIgnoreItem       = removeAIIgnoreItem;
window.resetEmailTemplate       = resetEmailTemplate;
window.resolveIssue             = resolveIssue;
window.restockItem              = restockItem;
window.revealCleanerReassign    = revealCleanerReassign;
window.saveCleanerContact       = saveCleanerContact;
window.saveCleanerPerm          = saveCleanerPerm;
window.saveCleanerPinById       = saveCleanerPinById;
window.saveCleaningFee          = saveCleaningFee;
window.editCalcNights           = editCalcNights;
window.editCalcNet              = editCalcNet;
window.saveEdit                 = saveEdit;
window.saveEmailTemplate        = saveEmailTemplate;
window.scanGmailBookings        = scanGmailBookings;
window.scanOutlookBookings      = scanOutlookBookings;
window.testCMConnection         = testCMConnection;
window.syncCMBookings           = syncCMBookings;
window.requestCMSetup           = requestCMSetup;
window.disconnectCM             = disconnectCM;
window.saveCMMapping            = saveCMMapping;
window.selectMerchantSuggest    = selectMerchantSuggest;
window.sendCleanerReminder      = sendCleanerReminder;
window.setMaintInProgress       = setMaintInProgress;
window.showAppModal             = showAppModal;
window.showDetail               = showDetail;
window.showEditModal            = showEditModal;
globalThis.renderBookings       = renderBookings;
window.switchToPortfolioFromSheet = switchToPortfolioFromSheet;
window.isPortfolioMode          = isPortfolioMode;
window.enterPortfolioMode       = enterPortfolioMode;
window.exitPortfolioMode        = exitPortfolioMode;
window.getPropertyColour        = getPropertyColour;
window.getPropertyColourById    = getPropertyColourById;
window.getPropertyNameById      = getPropertyNameById;
window.toggleCleanerConfirmed   = toggleCleanerConfirmed;
window.toggleExpenseMonth       = toggleExpenseMonth;
window.toggleMgmtSelect         = toggleMgmtSelect;
window.mgmtCheckboxChange       = mgmtCheckboxChange;
window.mgmtToggleSelectAll      = mgmtToggleSelectAll;
window.getAtoField              = getAtoField;
window.getAtoFieldLabel         = getAtoFieldLabel;
window.checkReceiptNudge        = checkReceiptNudge;
window.dismissChecklist         = dismissChecklist;
window.openChat                 = openChat;
window.closeChat                = closeChat;
window.sendMessage              = sendMessage;
window.sendAutoMessage          = sendAutoMessage;
window.uploadChatPhoto          = uploadChatPhoto;

// Called from supabase.js typeof window.X guards (boot sequence)
window.getAllProperties          = getAllProperties;
window.getActivePropertyId      = getActivePropertyId;
window.setActivePropertyId      = setActivePropertyId;
window.getActivePropertyConfig  = getActivePropertyConfig;
window.addPropertyConfig        = addPropertyConfig;
window.savePropertyConfig       = savePropertyConfig;
// lsKey removed (Supabase is source of truth)
window.hasValidPropertyConfig   = hasValidPropertyConfig;
window.ensureHostIdentityAndRestore = ensureHostIdentityAndRestore;
window.finishAppInit            = finishAppInit;
window.reloadInMemoryData       = reloadInMemoryData;
window.normalizeBookingCleanState = normalizeBookingCleanState;
window.isOnboardingComplete     = isOnboardingComplete;
window.showOnboarding           = showOnboarding;
window.renderAll                = renderAll;
window.applyStayopsPostSwitchAction = applyStayopsPostSwitchAction;
window.checkAutoSendReport      = checkAutoSendReport;
window.maybeAutoScanGmail       = maybeAutoScanGmail;
window.maybeAutoScanOutlook     = maybeAutoScanOutlook;
window.maybeAutoSyncCM          = maybeAutoSyncCM;
window._obGoToStep              = _obGoToStep;

// Internal reference used by calendar navigation
window._calNavigate             = _calNavigate;
window.calPrev                  = calPrev;
window.calNext                  = calNext;

// DB adapter instance
window.DB = new SupabaseAdapter();

/**
 * After hydrate + reloadInMemoryData + normalize + initPropertyUI, apply multi-property
 * portfolio mode when appropriate. Used by boot IIFE and post-login (handleLoginSubmit).
 */
window.applyPortfolioModeAfterHostHydrate = applyPortfolioModeAfterHostHydrate;
// Bridges for render.js (ESM load order — render runs before this block)
globalThis.saveHostConfigToSupabase = saveHostConfigToSupabase;
globalThis.loadHostConfigFromSupabase = loadHostConfigFromSupabase;
globalThis.showSetupIfNeeded = showSetupIfNeeded;
globalThis.loadCleansFromCloud = loadCleansFromCloud;
globalThis.savePropertyToCloud = savePropertyToCloud;
globalThis.saveHostConfigToCloud = saveHostConfigToCloud;
globalThis.deleteMaintenanceFromCloud = deleteMaintenanceFromCloud;
globalThis.saveInventoryToCloud = saveInventoryToCloud;
globalThis.saveMaintenanceToCloud = saveMaintenanceToCloud;
globalThis.showLoadingScreen = showLoadingScreen;
globalThis.showAppChrome = showAppChrome;
globalThis.hideLoadingScreen = hideLoadingScreen;
globalThis.setLoadingStatus = setLoadingStatus;
globalThis.showLoginScreen = showLoginScreen;
globalThis.handleAuthFailure = handleAuthFailure;


// Init on load
(async () => {
  // Handle OAuth redirect back from Google/Microsoft
  const urlParams = new URLSearchParams(window.location.search);
  const oauthSuccess = urlParams.get('oauth_success');
  const oauthEmail   = urlParams.get('oauth_email') || urlParams.get('email');
  const oauthError   = urlParams.get('oauth_error');
  if (oauthSuccess && oauthEmail) {
    // Clean URL
    window.history.replaceState({}, '', window.location.pathname);
    // Save Gmail connection for connection summary UI
    if (oauthSuccess === 'google') {
      localStorage.setItem('gh-gmail-email', decodeURIComponent(oauthEmail));
    }
    // Save Outlook connection for connection summary UI
    if (oauthSuccess === 'microsoft') {
      localStorage.setItem('gh-outlook-email', decodeURIComponent(oauthEmail));
    }
    // Show onboarding step 2 connected state after app loads
    window._oauthConnected = { provider: oauthSuccess, email: decodeURIComponent(oauthEmail) };
  }
  if (oauthError) {
    window.history.replaceState({}, '', window.location.pathname);
    window._oauthError = decodeURIComponent(oauthError);
  }

  if (typeof showLoadingScreen === 'function') showLoadingScreen('Checking your session…');

  // Check for active Supabase session (recover from invalid/expired refresh tokens)
  let session = null;
  if (window._sb) {
    try {
      const { data, error } = await window._sb.auth.getSession();
      if (error) {
        console.warn('[StayOps] Boot session error:', error.message);
        if (typeof handleAuthFailure === 'function') handleAuthFailure();
        return;
      }
      session = data?.session || null;
    } catch (e) {
      console.warn('[StayOps] Boot session exception:', e.message);
      if (typeof handleAuthFailure === 'function') handleAuthFailure();
      return;
    }
  } else if (typeof getSupabaseSession === 'function') {
    session = await getSupabaseSession();
  }

  if (!session) {
    // No Supabase session — fall back to legacy cleaner PIN mode if present.
    if (isCleanerMode()) {
      migrateConfigFromLegacySettings();
      initPropertyUI();
      attachButtonPress();
      attachModalHandleDrag();
      // Modal backdrop listeners are registered once in initRenderEngine() — not duplicated here.
      const { uid } = getCleanerParams();
      if (!uid) {
        _showCleanerLinkError('Invalid cleaner link — ask the owner to re-send your link from Settings.');
      } else if (isCleanerAuthed()) {
        document.body.classList.add('cleaner-mode');
        // Hydrate from Netlify function (handles home screen PWA with no Supabase session)
        const ok = await hydrateCleanerFromFunction();
        if (ok) {
          renderCleanerView();
        } else {
          _showCleanerLinkError('Could not load your cleaning data — check your connection and try again.');
        }
      } else {
        document.body.classList.add('cleaner-pin-active');
      }
      return;
    }
    // No session and not in legacy cleaner mode — show login screen and wait.
    console.log('[StayOps] No session — showing login screen');
    if (typeof showLoginScreen === 'function') showLoginScreen();
    else if (typeof hideLoadingScreen === 'function') hideLoadingScreen();
    return;
  }

  // Existing session — init app FIRST (establishes property/storage keys),
  // THEN hydrate from cloud so data lands under the correct scoped keys.
  console.log('[StayOps] Boot step: session found, starting boot');
  console.log('[StayOps] Boot step: detecting user role...');
  try {
    const role = await detectUserRole();
    console.log('[StayOps] Boot step: detected role =', role);
    if (role === 'cleaner') {
      console.log('[StayOps] Boot step: routing to cleaner view');
      showCleanerApp();
      return;
    }
  } catch (e) {
    console.error('[StayOps] Boot step: detectUserRole failed:', e);
  }
  console.log('[StayOps] Boot step: continuing with host boot');
  if (typeof showLoadingScreen === 'function') showLoadingScreen('Signing you in…');

  try {
    migrateConfigFromLegacySettings();
    if (typeof setLoadingStatus === 'function') setLoadingStatus('Checking your account…');
    if (typeof seedLocalConfigFromCloud === 'function') await seedLocalConfigFromCloud();
    console.log('[StayOps] Boot step: seedLocalConfigFromCloud complete');
    await ensureHostIdentityAndRestore();
    console.log('[StayOps] Boot step: ensureHostIdentityAndRestore complete');
    if (typeof setLoadingStatus === 'function') setLoadingStatus('Starting app…');
    await finishAppInit();
    console.log('[StayOps] Boot step: finishAppInit complete');
    if (typeof setLoadingStatus === 'function') setLoadingStatus('Loading your data…');
    if (typeof hydrateFromCloud === 'function') await hydrateFromCloud();
    console.log('[StayOps] Boot step: hydrateFromCloud complete');

    // Refresh in-memory arrays and property UI after cloud hydration
    reloadInMemoryData();
    // Fix: reconcile bookings vs cleans cleaner_confirmed before first render
    // so any divergence that existed in Supabase does not reach the UI.
    normalizeBookingCleanState();
    initPropertyUI();

    await applyPortfolioModeAfterHostHydrate();

    // Check if onboarding is needed (new user on fresh device)
    if (typeof isOnboardingComplete === 'function' && !isOnboardingComplete()) {
      if (typeof showOnboarding === 'function') {
        showOnboarding();
        // If returning from OAuth flow, jump to step 2 and show connected state
        if (window._oauthConnected) {
          _obGoToStep(2);
          onboardEmailConnected(window._oauthConnected.provider, window._oauthConnected.email);
          delete window._oauthConnected;
        }
        if (window._oauthError) {
          _obGoToStep(2);
          const errEl = document.getElementById('ob-step2-error');
          if (errEl) errEl.textContent = '⚠ Connection failed: ' + window._oauthError;
          delete window._oauthError;
        }
      }
      return;
    }

    console.log('[StayOps] Boot step: renderAll called');
    if (!isPortfolioMode()) {
      renderAll();
    }
    initMessaging().catch(e => console.warn('[StayOps] Messaging init failed:', e.message));
    applyStayopsPostSwitchAction();
    // Prompt to enable notifications if not enabled
    setTimeout(() => {
      if ('Notification' in window && Notification.permission === 'default') {
        // Never asked — show a prompt banner
        const existing = document.getElementById('notif-prompt-banner');
        if (existing) existing.remove();
        const banner = document.createElement('div');
        banner.id = 'notif-prompt-banner';
        banner.innerHTML =
          '<div style="position:fixed;bottom:80px;left:16px;right:16px;z-index:998;background:#1E3A2F;color:#fff;border-radius:14px;padding:14px 16px;box-shadow:0 4px 20px rgba(0,0,0,0.2);display:flex;align-items:center;gap:12px">' +
            '<div style="font-size:24px;flex-shrink:0">🔔</div>' +
            '<div style="flex:1"><div style="font-weight:700;font-size:14px">Enable Notifications</div><div style="font-size:12px;opacity:0.7;margin-top:2px">Get alerts for bookings, cleans, and messages</div></div>' +
            '<div onclick="enableNotificationsManually();document.getElementById(\'notif-prompt-banner\').remove()" style="background:#8FAF85;color:#fff;font-weight:700;font-size:12px;padding:8px 14px;border-radius:8px;cursor:pointer;white-space:nowrap">Enable</div>' +
            '<div onclick="document.getElementById(\'notif-prompt-banner\').remove();localStorage.setItem(\'notif-prompt-dismissed\',Date.now())" style="font-size:18px;opacity:0.5;cursor:pointer;padding:4px">✕</div>' +
          '</div>';
        // Don't show if user dismissed in the last 24 hours
        const lastDismissed = parseInt(localStorage.getItem('notif-prompt-dismissed') || '0');
        if (Date.now() - lastDismissed > 24 * 60 * 60 * 1000) {
          document.body.appendChild(banner);
        }
      }
    }, 2000);
    // Prompt if an owner report is due (non-blocking, runs after UI is visible)
    setTimeout(checkAutoSendReport, 1500);
    // Auto-scan Gmail for new booking emails
    setTimeout(maybeAutoScanGmail, 3000);
    // Auto-scan Outlook for new booking emails
    setTimeout(maybeAutoScanOutlook, 4500);
    // Auto-sync channel manager bookings
    setTimeout(maybeAutoSyncCM, 6000);
    // Periodic re-scan every 15 minutes while app is open
    setInterval(maybeAutoScanGmail, 15 * 60 * 1000);
    setInterval(maybeAutoScanOutlook, 15 * 60 * 1000 + 1500);
    setInterval(maybeAutoSyncCM, 4 * 60 * 60 * 1000);
  } catch (e) {
    console.error('[StayOps] Boot failed:', e);
  } finally {
    if (typeof showAppChrome === 'function') showAppChrome();
  }
})();