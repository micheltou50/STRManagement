#!/usr/bin/env python3
"""Build modular assets/js/*.js from assets/js/main.js.bak (lines 62–10139 body)."""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAIN_PATH = os.path.join(ROOT, "assets/js/main.js.bak")
JS = os.path.join(ROOT, "assets/js")

with open(MAIN_PATH, "r", encoding="utf-8") as f:
    L = f.read().splitlines()

def slice_lines(lo, hi):
    return L[lo - 1 : hi]

def find_line_startswith(lines, prefix, start=0):
    for i in range(start, len(lines)):
        if lines[i].startswith(prefix):
            return i
    raise ValueError(prefix)

def exportify_functions(lines):
    """Prefix export on top-level function/async function (line starts at column 0)."""
    out = []
    for ln in lines:
        if ln.startswith("function ") or ln.startswith("async function "):
            out.append("export " + ln)
        else:
            out.append(ln)
    return out

CONFIG_IMPORT = """import {
  lsKey,
  getAllProperties,
  getActivePropertyId,
  setActivePropertyId,
  getActivePropertyConfig,
  addPropertyConfig,
  getPropertyConfig,
  savePropertyConfig,
  saveAllProperties,
  hasValidPropertyConfig,
  getCurrentPropertyName,
  getCurrentPropertyTagline,
  getCurrentHostEmail,
  getVapidPublicKey,
  getPushFunctionUrl,
  getPropertyStats,
  getPricingConfig,
  getPropertyConfigGaps,
  getPropertyById,
  migrateConfigFromLegacySettings,
  initPropertyUI,
} from './config.js';
"""

SUPABASE_IMPORT = """import {
  getSupabaseSession,
  getCurrentSupabaseUser,
  seedLocalConfigFromCloud,
  hydrateFromCloud,
  savePropertyToCloud,
  saveCleanersToCloud,
  loadCleansFromCloud,
  saveCleanToCloud,
  saveCleansToCloud,
  saveCleaningJobToCloud,
  saveNotesToCloud,
  saveExpenseToCloud,
  deleteExpenseFromCloud,
  saveInventoryToCloud,
  saveMaintenanceToCloud,
  deleteMaintenanceFromCloud,
  saveBookingToCloud,
  saveBookingsToCloud,
  deleteBookingFromCloud,
  uploadReceiptToStorage,
  saveAppConfigToCloud,
  saveHostConfigToSupabase,
  loadHostConfigFromSupabase,
  showLoadingScreen,
  hideLoadingScreen,
  setLoadingStatus,
  showLoginScreen,
  handleAuthFailure,
  showAppChrome,
  handleLoginSubmit,
  handleSignUpSubmit,
  toggleSignUp,
  hostSignOut,
} from './supabase.js';
"""

# ═══ utils.js ═══
utils_lines = exportify_functions(slice_lines(62, 106))
fmt_fn = "\n".join(slice_lines(5026, 5030))

utils_txt = "\n".join(utils_lines) + """

export function _normName(v) {
  return String(v || '').trim().toLowerCase();
}
""" + fmt_fn.replace(
    "function fmt(", "export function fmt(", 1
) + "\n"
with open(os.path.join(JS, "utils.js"), "w", encoding="utf-8") as f:
    f.write(utils_txt)

# ═══ notifications.js ═══
notif_lines = slice_lines(107, 327)
notif_out = []
for ln in notif_lines:
    if ln.startswith("const VAPID_PUBLIC_KEY") or ln.startswith("const PUSH_FUNCTION_URL"):
        notif_out.append("export " + ln)
    elif ln.startswith("function ") or ln.startswith("async function "):
        notif_out.append("export " + ln)
    else:
        notif_out.append(ln)

with open(os.path.join(JS, "notifications.js"), "w", encoding="utf-8") as f:
    f.write(CONFIG_IMPORT + SUPABASE_IMPORT + "\n".join(notif_out) + "\n")

# ═══ state.js ═══
state_lines = slice_lines(328, 1161)

ins_nav = [
    "export let currentSection = 'today';",
    "export let portfolioMode = false;",
]
idx = find_line_startswith(state_lines, "let _expandedCleanIndex = null;")
state_lines[idx + 1 : idx + 1] = ["", *ins_nav, ""]

# Local helper (same logic as bookings.js loadCleaners) — avoids state→bookings cycle
idx = find_line_startswith(state_lines, "function getPlanStateLite()")
state_lines[idx:idx] = [
    "function loadCleaners() {",
    "  return loadJSON(lsKey('cleaners'));",
    "}",
    "",
]

idx = find_line_startswith(state_lines, "let notes    = loadJSON(lsKey('notes'));")
exp_block = [
    "export let expenses    = JSON.parse(localStorage.getItem(lsKey('expenses'))    || '[]');",
    "export let maintenance = JSON.parse(localStorage.getItem(lsKey('maintenance')) || '[]');",
    "export let inventory   = JSON.parse(localStorage.getItem(lsKey('inventory'))   || '[]');",
]
state_lines[idx + 1 : idx + 1] = ["", *exp_block, ""]

block = [
    "export function isPortfolioMode() {",
    "  return portfolioMode && typeof getAllProperties === 'function' && getAllProperties().length > 1;",
    "}",
    "",
    "export function _findMatchingCleanForBooking(booking, preferredDate) {",
    "  if (!booking) return null;",
    "  const byBookingId = cleans.find(c =>",
    "    String(c.bookingId) === String(booking.id) ||",
    "    (booking._cloudId && String(c.bookingId) === String(booking._cloudId))",
    "  );",
    "  if (byBookingId) return byBookingId;",
    "",
    "  const targetDate = String(preferredDate || booking.checkout || '').slice(0, 10);",
    "  const name = _normName(booking.name);",
    "  if (name && targetDate) {",
    "    const byGuestAndDate = cleans.find(c => _normName(c.guestName) === name && String(c.date || '').slice(0, 10) === targetDate);",
    "    if (byGuestAndDate) return byGuestAndDate;",
    "  }",
    "",
    "  return null;",
    "}",
    "",
    "export function _isCleanLinkedToCancelledBooking(clean) {",
    "  if (!clean) return false;",
    "  const byBookingId = bookings.find(b => String(b.id) === String(clean.bookingId));",
    "  if (byBookingId) return byBookingId.status === 'cancelled';",
    "  const byGuestCancelled = bookings.find(b =>",
    "    b.status === 'cancelled' &&",
    "    _normName(b.name) === _normName(clean.guestName) &&",
    "    String(b.checkout || '').slice(0, 10) === String(clean.date || '').slice(0, 10)",
    "  );",
    "  return !!byGuestCancelled;",
    "}",
    "",
    "export function getBookingCleanerState(booking) {",
    "  if (booking && booking.status === 'cancelled') return { key: 'cancelled', label: 'Cancelled — no cleaner required', tone: 'ok' };",
    "  const clean = _findMatchingCleanForBooking(booking);",
    "  if (!clean) return { key: 'unassigned', label: 'Needs cleaner assignment', tone: 'warn' };",
    "  if (clean.done) return { key: 'done', label: 'Clean completed', tone: 'ok', clean };",
    "  if (clean.cleanerDeclined) return { key: 'declined', label: 'Cleaner declined — reassign needed', tone: 'bad', clean };",
    "  if (clean.cleanerConfirmed) return { key: 'confirmed', label: 'Cleaner confirmed', tone: 'ok', clean };",
    "  return { key: 'pending', label: 'Assigned — awaiting cleaner response', tone: 'warn', clean };",
    "}",
    "",
]

idx = next(i for i, l in enumerate(state_lines) if "reloadInMemoryData — refresh" in l)
while idx > 0 and not state_lines[idx].strip().startswith("/**"):
    idx -= 1
state_lines[idx:idx] = block

state_header = CONFIG_IMPORT + SUPABASE_IMPORT + """import { escHtml, parseLocalDayStart, fmtShort, fmt, isAwaitingCleanerResponse, getAwaitingResponseMeta, _normName } from './utils.js';
import { getCleanerSub, sendPushToDevice } from './notifications.js';
import { cleanerLinkForId, sendCleanerEmail, processScanNeedsReview, isCleanerMode } from './property.js';
import {
  renderBookings,
  renderNotes,
  populateSelects,
  renderCleaning,
  renderAll,
} from './render.js';
export { lsKey } from './config.js';
"""

# export remaining top-level functions/lets in state body
state_body = []
for ln in state_lines:
    if ln.startswith("let bookingFilter") or ln.startswith("let cleaningViewMode") or ln.startswith(
        "let cleanStatusFilter"
    ) or ln.startswith("let _expandedCleanIndex"):
        state_body.append("export " + ln)
    elif ln.startswith("function ") or ln.startswith("async function "):
        state_body.append("export " + ln)
    elif ln.startswith("let bookings") or ln.startswith("let cleans") or ln.startswith("let notes"):
        state_body.append("export " + ln)
    elif ln.startswith("let calYear") or ln.startswith("let calMonth"):
        state_body.append("export " + ln)
    else:
        state_body.append(ln)

with open(os.path.join(JS, "state.js"), "w", encoding="utf-8") as f:
    f.write(state_header + "\n" + "\n".join(state_body) + "\n")

# ═══ render.js — merged old render (1162–2905) + finance (2906–4904) to avoid split-cycle ═══
render_lines = slice_lines(1162, 4904)
nav_idx = find_line_startswith(render_lines, "// ── NAV")
del render_lines[nav_idx + 1 : nav_idx + 3]

try:
    i_norm = find_line_startswith(render_lines, "function _normName(")
    del render_lines[i_norm : i_norm + 4]
except ValueError:
    pass

try:
    i_find = find_line_startswith(render_lines, "function _findMatchingCleanForBooking(")
    i_booking_detail = find_line_startswith(render_lines, "// ── BOOKING DETAIL")
    del render_lines[i_find:i_booking_detail]
except ValueError:
    pass

render_header = CONFIG_IMPORT + SUPABASE_IMPORT + """import { AIService } from './ai-logic.js';
import { escHtml, parseLocalDayStart, fmtShort, fmt, _normName } from './utils.js';
import {
  bookingFilter,
  cleanStatusFilter,
  bookings,
  cleans,
  notes,
  expenses,
  maintenance,
  inventory,
  currentSection,
  portfolioMode,
  calYear,
  calMonth,
  reloadInMemoryData,
  save,
  isPortfolioMode,
  getBookingCleanerState,
  _findMatchingCleanForBooking,
  platformIcon,
  getAwaitingResponseMeta,
  isAwaitingCleanerResponse,
  renderConnectionSummary,
} from './state.js';
import { getCleanerSub, sendPushToDevice, getPushSubs, getHostSub } from './notifications.js';
import { loadCleaners } from './bookings.js';
import { processScanNeedsReview, isCleanerMode } from './property.js';
"""

render_body = exportify_functions(render_lines)
with open(os.path.join(JS, "render.js"), "w", encoding="utf-8") as f:
    f.write(render_header + "\n" + "\n".join(render_body) + "\n")

# ═══ property.js ═══
prop_lines = slice_lines(7231, 9415)
p0 = find_line_startswith(prop_lines, "// ── PROPERTY DATA")
del prop_lines[p0 + 1 : p0 + 4]

i_ip = find_line_startswith(prop_lines, "function isPortfolioMode()")
del prop_lines[i_ip : i_ip + 4]

prop_header = CONFIG_IMPORT + SUPABASE_IMPORT + """import { escHtml, parseLocalDayStart, fmtShort, fmt, _normName } from './utils.js';
import {
  bookings,
  cleans,
  notes,
  expenses,
  maintenance,
  inventory,
  portfolioMode,
  isPortfolioMode,
  reloadInMemoryData,
  save,
  getBookingCleanerState,
  platformIcon,
} from './state.js';
import { getCleanerSub, sendPushToDevice } from './notifications.js';
import { loadCleaners } from './bookings.js';
import { AIService } from './ai-logic.js';
"""

prop_body = exportify_functions(prop_lines)
with open(os.path.join(JS, "property.js"), "w", encoding="utf-8") as f:
    f.write(prop_header + "\n" + "\n".join(prop_body) + "\n")

# ═══ bookings, cleaning, ai (finance merged into render.js) ═══
PACKAGES = [
    (
        4905,
        5891,
        "bookings.js",
        CONFIG_IMPORT
        + SUPABASE_IMPORT
        + """import { escHtml, parseLocalDayStart, fmtShort, fmt, _normName } from './utils.js';
import { bookingFilter, cleanStatusFilter, bookings, cleans, notes, save, reloadInMemoryData, currentSection, portfolioMode, isPortfolioMode, getBookingCleanerState, _findMatchingCleanForBooking, platformIcon, getAwaitingResponseMeta, isAwaitingCleanerResponse, renderConnectionSummary } from './state.js';
import { processScanNeedsReview, isCleanerMode } from './property.js';
""",
    ),
    (
        5892,
        7230,
        "cleaning.js",
        CONFIG_IMPORT
        + SUPABASE_IMPORT
        + """import { escHtml, parseLocalDayStart, fmtShort, fmt, _normName } from './utils.js';
import { bookingFilter, cleanStatusFilter, bookings, cleans, notes, save, reloadInMemoryData, currentSection, portfolioMode, isPortfolioMode, getBookingCleanerState, _findMatchingCleanForBooking, platformIcon, getAwaitingResponseMeta, isAwaitingCleanerResponse } from './state.js';
import { loadCleaners } from './bookings.js';
import { processScanNeedsReview, isCleanerMode } from './property.js';
""",
    ),
    (
        9416,
        10139,
        "ai.js",
        CONFIG_IMPORT
        + SUPABASE_IMPORT
        + """import { showSetupIfNeeded } from './setup.js';
import { escHtml, parseLocalDayStart, fmtShort, fmt, _normName } from './utils.js';
import { bookings, cleans, notes, expenses, maintenance, inventory, portfolioMode, isPortfolioMode, reloadInMemoryData, save, getBookingCleanerState } from './state.js';
import { AIService } from './ai-logic.js';
import { renderAll } from './render.js';
""",
    ),
]

for lo, hi, name, extra in PACKAGES:
    body = slice_lines(lo, hi)
    if name == "bookings.js":
        i = find_line_startswith(body, "function fmt(")
        j = find_line_startswith(body, "function renderHeaderDateBadge()")
        del body[i:j]
    body = exportify_functions(body)
    with open(os.path.join(JS, name), "w", encoding="utf-8") as f:
        f.write(extra + "\n" + "\n".join(body) + "\n")

fin_path = os.path.join(JS, "finance.js")
if os.path.isfile(fin_path):
    os.remove(fin_path)

print("OK: wrote modular JS under assets/js/ (finance merged into render.js)")
