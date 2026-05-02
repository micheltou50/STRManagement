/* eslint-disable no-unused-vars */
import { SupabaseAdapter } from './adapter.js';
import { showSetupIfNeeded } from './setup.js';
import {
  getAllProperties, getActivePropertyId, setActivePropertyId, getActivePropertyConfig,
  addPropertyConfig, savePropertyConfig, hasValidPropertyConfig, migrateConfigFromLegacySettings, initPropertyUI,
} from './config.js';
import {
  getSupabaseSession, getCurrentSupabaseUser, seedLocalConfigFromCloud, hydrateFromCloud, savePropertyToCloud, saveHostConfigToCloud,
  loadCleansFromCloud, saveCleanToCloud, saveCleansToCloud, saveCleanersToCloud, saveInventoryToCloud, saveMaintenanceToCloud, deleteMaintenanceFromCloud,
  saveBookingToCloud, saveBookingsToCloud, deleteBookingFromCloud, saveHostConfigToSupabase, loadHostConfigFromSupabase, saveAppConfigToCloud, saveExpenseToCloud,
  showLoadingScreen, hideLoadingScreen, setLoadingStatus, showLoginScreen, handleAuthFailure, showAppChrome,
  handleLoginSubmit, handleSignUpSubmit, handleMagicLinkSubmit, handleVerifySubmit, handleResendCode, toggleSignUp, hostSignOut,
  welcomeShowLanding, welcomeShowSignIn, welcomeShowSignUp, welcomeShowVerify, showSuccessToast,
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
  toggleCleanAction, markCleanDeclined, markCleanerConfirmed, reassignClean, toggleCleanerConfirmed, revealCleanerReassign, switchCleanView, setCleanStatusFilter, cleanerAccept, cleanerDecline, cleanerMarkDone,
  findMatchingCleanForBooking
} from './cleaning.js';
import { bookings } from './state.js';
import { maybeShowSinceLastOpenedRundown } from './since-last-opened.js';
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
  handleLogoUpload, removeHostLogo, renderHostProfileRow, loadCleaners, saveCleaners, addCleaner, deleteCleaner, renderTeamList, openCleanerProfile, saveCleanerContact, populateContractorSelect, renderStorageViewer, getFx, saveFxSetting,
  initFxSettings, initSettingsSwipeBack, toggleAutoAssignCleaner, resetConnectionCheckerResults, openCleanerSettings, renderCleanerAccessList, saveCleanerPinById, clearCleanerPinById, saveCleanerPerm, copyCleanerLinkById,
  populateICalFeedsPanel, addICalFeed, removeICalFeed, syncICalFeedsNow, maybeAutoSyncICal
} from './settings.js';
import {
  calPrev, calNext, openCalPreview, closeCalPreview, addNote, showDetail, showEditModal, saveEdit, editCalcNights, editCalcNet, filterBookings, addBooking,
  deleteBooking, importAirbnbCSV, importCSV, switchModalTab, saveCleaningFee, saveCleanCost, renderBookings, switchBookingsView, renderBookingsCalendarView
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
  cleanerAdjustStock, finishAppInit, showOnboarding, hideOnboarding, _obGoToStep, onboardBack, onboardSetPropertyType, onboardStep0Next, onboardStep1Next, onboardStep1SkipAddress, onboardStep2Next, onboardSkipStep, onboardLiveContinue, obStepperAdjust, obSetGuests,
  onboardConnectGoogle, onboardConnectMicrosoft, onboardEmailConnected, onboardStep2Skip,
  onboardTogglePlatform, onboardStep3Next, onboardToggleIntegration, onboardStep4Next, onboardEnableNotifications, onboardFinish, isOnboardingComplete, checkAutoSendReport, _calNavigate, renderOnboardingGuidance,
  dismissChecklist, renderCleanerCleans
} from './render.js';
/* eslint-enable no-unused-vars */

// ── GLOBAL SCOPE ASSIGNMENTS ───────────────────────────────────────────────────
// ES modules are scoped — functions are not automatically global.
// These expose functions that index.html onclick handlers, dynamically generated
// HTML, and cross-module calls depend on.

// finance.js / settings.js import before main body; runtime hooks for cross-module calls
globalThis.savePropertyData = savePropertyData;
globalThis.getHostProfile = getHostProfile;
globalThis.saveHostProfile = saveHostProfile;
globalThis.migrateConfigFromLegacySettings = migrateConfigFromLegacySettings;
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
globalThis.saveCleanToCloud = saveCleanToCloud;
globalThis.saveCleansToCloud = saveCleansToCloud;
globalThis.saveCleanersToCloud = saveCleanersToCloud;
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
globalThis.renderCleanerCleans = renderCleanerCleans;

// Called from index.html onclick/onchange handlers
window.handleLoginSubmit        = handleLoginSubmit;
window.handleSignUpSubmit       = handleSignUpSubmit;
window.handleMagicLinkSubmit    = handleMagicLinkSubmit;
window.handleVerifySubmit       = handleVerifySubmit;
window.handleResendCode         = handleResendCode;
window.toggleSignUp             = toggleSignUp;
window.welcomeShowLanding       = welcomeShowLanding;
window.welcomeShowSignIn        = welcomeShowSignIn;
window.welcomeShowSignUp        = welcomeShowSignUp;
window.welcomeShowVerify        = welcomeShowVerify;
window.showSuccessToast         = showSuccessToast;
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
window.switchBookingsView       = switchBookingsView;
window.renderBookingsCalendarView = renderBookingsCalendarView;
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
window.onboardSetPropertyType   = onboardSetPropertyType;
window.onboardStep0Next         = onboardStep0Next;
window.onboardStep1Next         = onboardStep1Next;
window.onboardStep1SkipAddress  = onboardStep1SkipAddress;
window.onboardStep2Next         = onboardStep2Next;
window.onboardStep3Next         = onboardStep3Next;
window.onboardStep4Next         = onboardStep4Next;
window.onboardSkipStep          = onboardSkipStep;
window.onboardLiveContinue      = onboardLiveContinue;
window.onboardBack              = onboardBack;
window.obStepperAdjust          = obStepperAdjust;
window.obSetGuests              = obSetGuests;
window.onboardTogglePlatform    = onboardTogglePlatform;
window.onboardToggleIntegration = onboardToggleIntegration;
window.onboardEnableNotifications = onboardEnableNotifications;
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
window.handleLogoUpload         = handleLogoUpload;
window.removeHostLogo           = removeHostLogo;
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
window.renderCleaning           = renderCleaning;
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
window.saveCleanCost            = saveCleanCost;
window.editCalcNights           = editCalcNights;
window.editCalcNet              = editCalcNet;
window.saveEdit                 = saveEdit;
window.saveEmailTemplate        = saveEmailTemplate;
window.scanGmailBookings        = scanGmailBookings;
window.scanOutlookBookings      = scanOutlookBookings;
window.selectMerchantSuggest    = selectMerchantSuggest;
window.hideMerchantSuggest      = hideMerchantSuggest;
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
window.maybeAutoSyncICal        = maybeAutoSyncICal;
window.syncICalFeedsNow         = syncICalFeedsNow;
window.addICalFeed              = addICalFeed;
window.removeICalFeed           = removeICalFeed;
window.populateICalFeedsPanel   = populateICalFeedsPanel;
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


// ── HOST / CLEANER ROLE SWITCHER ─────────────────────────────────────────────

function checkRoleSwitcher() {
  try {
    if (typeof isCleanerMode === 'function' && isCleanerMode()) return;
    if (typeof isOnboardingComplete === 'function' && !isOnboardingComplete()) return;

    const user = window._supabaseUser;
    const cleaners = window._cleaners || [];
    if (!user || !user.email || !cleaners.length) return;

    const hostEmail = user.email.toLowerCase().trim();
    const match = cleaners.find(c => c.email && c.email.toLowerCase().trim() === hostEmail);
    if (!match) return;

    window._matchedCleanerRecord = match;
    const container = document.getElementById('role-switcher-container');
    if (container) container.style.display = 'block';
    console.log('[StayOps] Role switcher enabled — host is also cleaner:', match.name);
  } catch (e) {
    console.warn('[StayOps] checkRoleSwitcher failed', e);
  }
}

window.switchToCleanerMode = function () {
  if (!window._matchedCleanerRecord) return;
  console.log('[StayOps] Switching to cleaner mode');

  // Update pill styles
  const hostPill = document.getElementById('role-pill-host');
  const cleanerPill = document.getElementById('role-pill-cleaner');
  if (hostPill) { hostPill.style.background = 'rgba(255,255,255,0.12)'; hostPill.style.color = 'rgba(255,255,255,0.8)'; }
  if (cleanerPill) { cleanerPill.style.background = '#8FAF85'; cleanerPill.style.color = '#1E3A2F'; }

  // Switch to cleaner view (hides host UI, shows cleaner UI, loads data)
  showCleanerApp();

  // Register cleaner push notifications
  const cleanerId = window._matchedCleanerRecord._cloudId || window._matchedCleanerRecord.id;
  setTimeout(() => {
    subscribeToPush('cleaner', cleanerId).then(sub => {
      if (sub) console.log('[StayOps] Cleaner push subscription registered');
    }).catch(() => {});
  }, 1500);

  // After cleaner content loads, add "Back to Host" button to cleaner header
  setTimeout(() => {
    const cleanerHeader = document.getElementById('cleaner-header');
    if (cleanerHeader && !document.getElementById('back-to-host-btn')) {
      const btn = document.createElement('button');
      btn.id = 'back-to-host-btn';
      btn.onclick = window.switchToHostMode;
      btn.style.cssText = 'display:flex;align-items:center;gap:6px;background:rgba(30,58,47,0.1);border:1.5px solid var(--forest,#1E3A2F);border-radius:20px;color:var(--forest,#1E3A2F);font-family:"DM Sans",sans-serif;font-size:12px;font-weight:600;padding:7px 14px;cursor:pointer;margin-top:12px';
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg> Back to Host';
      cleanerHeader.appendChild(btn);
    }
  }, 500);
};

window.switchToHostMode = function () {
  console.log('[StayOps] Switching back to host mode');

  // Clear cleaner data
  window._cleanerData = null;

  // Hide cleaner UI
  const cleanerNav = document.getElementById('cleaner-nav');
  const cleanerContent = document.getElementById('cleaner-content');
  if (cleanerNav) cleanerNav.style.display = 'none';
  if (cleanerContent) cleanerContent.style.display = 'none';

  // Remove back-to-host button
  const backBtn = document.getElementById('back-to-host-btn');
  if (backBtn) backBtn.remove();

  // Show host UI
  showAppChrome();
  renderAll();

  // Reset pill styles
  const hostPill = document.getElementById('role-pill-host');
  const cleanerPill = document.getElementById('role-pill-cleaner');
  if (hostPill) { hostPill.style.background = '#8FAF85'; hostPill.style.color = '#1E3A2F'; }
  if (cleanerPill) { cleanerPill.style.background = 'rgba(255,255,255,0.12)'; cleanerPill.style.color = 'rgba(255,255,255,0.8)'; }
};

// ── CANCELLED BOOKING PROMPT ─────────────────────────────────────────────────
function checkCancelledBookings() {
  try {
    if (typeof isCleanerMode === 'function' && isCleanerMode()) return;
    if (typeof isOnboardingComplete === 'function' && !isOnboardingComplete()) return;

    const cfg = window._appConfig || {};
    const lastSeen = cfg.cancellation_last_seen || null;
    // Default: look back 7 days if never set
    const cutoff = lastSeen || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const cancelled = bookings.filter(b =>
      b.status === 'cancelled' &&
      String(b.updatedAt || '') > cutoff
    );
    if (!cancelled.length) return;

    const fmtD = d => { if (!d) return ''; try { return new Date(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }); } catch (_) { return d; } };

    let cards = '';
    for (const b of cancelled) {
      const clean = findMatchingCleanForBooking(b);
      const propName = typeof getPropertyNameById === 'function' && b._propertyId ? getPropertyNameById(b._propertyId) : '';
      const cleanerName = clean && clean.cleaner ? clean.cleaner : '';
      const notified = clean && clean.cleanerCancelNotified;

      // Look up cleaner email
      let cleanerEmail = '';
      if (cleanerName && !notified) {
        const cleaners = (typeof loadCleaners === 'function' ? loadCleaners() : window._cleaners) || [];
        const cObj = cleaners.find(cl => cl.name === cleanerName || String(cl.id) === String(clean.cleanerId));
        cleanerEmail = cObj && cObj.email ? cObj.email.trim() : '';
      }

      cards += '<div style="background:#FCEBEB;border-radius:10px;padding:14px 16px;margin-bottom:10px">';
      cards += '<div style="font-size:15px;font-weight:600;color:#1a1a1a">' + (b.name || 'Guest') + '</div>';
      if (propName) cards += '<div style="font-size:12px;color:#888;margin-top:2px">' + propName + '</div>';
      cards += '<div style="font-size:13px;color:#A32D2D;margin-top:4px;text-decoration:line-through">' + fmtD(b.checkin) + ' → ' + fmtD(b.checkout) + '</div>';

      if (cleanerName) {
        if (notified) {
          cards += '<div style="display:flex;align-items:center;gap:6px;margin-top:10px;font-size:12px;color:#3B6D11">' +
            '<span>✓</span><span>' + cleanerName + ' was notified</span></div>';
        } else {
          const bId = String(b._cloudId || b.id);
          const cId = clean._cloudId || String(clean.id);
          if (cleanerEmail) {
            cards += '<button onclick="notifyCancelledCleaner(this,\'' + bId.replace(/'/g, '') + '\',\'' + cId.replace(/'/g, '') + '\')" ' +
              'style="margin-top:10px;width:100%;padding:10px;background:#C0392B;color:white;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:\'DM Sans\',sans-serif">' +
              'Notify ' + cleanerName + '</button>';
          } else {
            cards += '<div style="margin-top:10px;font-size:12px;color:#854F0B">' + cleanerName + ' has no email on file</div>';
          }
        }
      }
      cards += '</div>';
    }

    const container = document.getElementById('cancel-prompt-cards');
    const overlay = document.getElementById('cancel-prompt-overlay');
    if (!container || !overlay) return;
    container.innerHTML = cards;
    overlay.style.display = 'flex';
    requestAnimationFrame(() => requestAnimationFrame(() => { overlay.style.opacity = '1'; }));
  } catch (e) {
    console.warn('[StayOps] checkCancelledBookings failed', e);
  }
}

window.dismissCancelPrompt = function () {
  const overlay = document.getElementById('cancel-prompt-overlay');
  if (overlay) {
    overlay.style.opacity = '0';
    setTimeout(() => { overlay.style.display = 'none'; }, 250);
  }
  // Persist last-seen timestamp to cloud
  if (window._appConfig) window._appConfig.cancellation_last_seen = new Date().toISOString();
  if (typeof saveAppConfigToCloud === 'function') {
    saveAppConfigToCloud({ cancellation_last_seen: new Date().toISOString() }).catch(e => console.warn('[StayOps] silent error:', e));
  }
};

window.notifyCancelledCleaner = async function (btn, bookingId, cleanId) {
  try {
    btn.disabled = true;
    btn.textContent = 'Sending…';
    const b = bookings.find(x => String(x._cloudId || x.id) === bookingId);
    const clean = findMatchingCleanForBooking(b);
    if (!clean || !clean.cleaner) { btn.textContent = 'No cleaner'; return; }

    const cleaners = (typeof loadCleaners === 'function' ? loadCleaners() : window._cleaners) || [];
    const cObj = cleaners.find(cl => cl.name === clean.cleaner || String(cl.id) === String(clean.cleanerId));
    const email = cObj && cObj.email ? cObj.email.trim() : '';
    if (!email) { btn.textContent = 'No email'; return; }

    const fmtD = d => { if (!d) return ''; try { return new Date(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }); } catch (_) { return d; } };

    await sendCleanerEmail({
      cleanerName: clean.cleaner,
      cleanerEmail: email,
      guestName: b.name || 'Guest',
      checkin: b.checkin ? fmtD(b.checkin) : '',
      checkout: b.checkout ? fmtD(b.checkout) : '',
      cleanDate: clean.date || (b.checkout ? fmtD(b.checkout) : ''),
      type: 'cancellation',
    });

    // Mark as notified in memory + cloud
    clean.cleanerCancelNotified = true;
    if (window._sb && clean._cloudId) {
      await window._sb.from('cleans').update({ cleaner_cancel_notified: true, updated_at: new Date().toISOString() }).eq('id', clean._cloudId);
    }

    // Update button to confirmed state
    btn.outerHTML = '<div style="display:flex;align-items:center;gap:6px;margin-top:10px;font-size:12px;color:#3B6D11">' +
      '<span>✓</span><span>' + clean.cleaner + ' was notified</span></div>';
  } catch (e) {
    console.warn('[StayOps] notifyCancelledCleaner failed', e);
    btn.textContent = 'Failed — try again';
    btn.disabled = false;
  }
};

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
    // Host-only "Since you last opened StayOps" rundown.
    // Runs once per session; cleaner-mode boot already returned earlier.
    try { maybeShowSinceLastOpenedRundown(bookings); } catch (_e) { /* fail silently */ }
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
    // Check for missed cancellations
    setTimeout(checkCancelledBookings, 2500);
    // Check if host is also a cleaner (show role switcher)
    setTimeout(checkRoleSwitcher, 1000);
    // Auto-sync iCal feeds (per-property calendar imports) — fire early so
    // bookings are fresh by the time the user looks at the calendar.
    setTimeout(maybeAutoSyncICal, 1500);
    // Periodic re-scan every 15 minutes while app is open
    setInterval(maybeAutoScanGmail, 15 * 60 * 1000);
    setInterval(maybeAutoScanOutlook, 15 * 60 * 1000 + 1500);
    setInterval(maybeAutoSyncICal, 15 * 60 * 1000 + 3000);
    // Re-sync when the app returns to the foreground (PWA reopen / tab switch
    // back). Throttle to once per 60s so rapid focus changes don't hammer it.
    let _lastForegroundSync = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - _lastForegroundSync < 60 * 1000) return;
      _lastForegroundSync = now;
      maybeAutoSyncICal();
      maybeAutoScanGmail();
      maybeAutoScanOutlook();
    });
  } catch (e) {
    console.error('[StayOps] Boot failed:', e);
  } finally {
    if (typeof showAppChrome === 'function') showAppChrome();
  }
})();