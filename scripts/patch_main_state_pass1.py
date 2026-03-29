#!/usr/bin/env python3
"""Generate assets/js/main.js from main.js.bak — Pass 1: wire state.js only."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BAK = ROOT / "assets/js/main.js.bak"
OUT = ROOT / "assets/js/main.js"

s = BAK.read_text(encoding="utf-8")

# 1) Import state after supabase
needle = "} from './supabase.js';\n\n// ── HTML ESCAPE HELPER"
repl = """} from './supabase.js';
import {
  loadJSON,
  save,
  bookings,
  cleans,
  notes,
  expenses,
  maintenance,
  inventory,
  reloadArraysFromLocalStorage,
  replaceArrayInPlace,
} from './state.js';

// ── HTML ESCAPE HELPER"""
if needle not in s:
    raise SystemExit("Insert point not found (supabase import)")
s = s.replace(needle, repl, 1)

# 2) Remove loadJSON (between bookingFilter vars and getPlanStateLite)
s = re.sub(
    r"\nfunction loadJSON\(key, fallback\) \{\n"
    r"  fallback = fallback !== undefined \? fallback : \[\];\n"
    r"  try \{ return JSON\.parse\(localStorage\.getItem\(key\) \|\| JSON\.stringify\(fallback\)\); \}\n"
    r"  catch\(e\) \{ console\.warn\('loadJSON failed for', key, e\); return fallback; \}\n"
    r"\}\n",
    "\n",
    s,
    count=1,
)

# 3) Remove initial bookings/cleans/notes lets (calYear stays)
s = re.sub(
    r"\nlet bookings = loadJSON\(lsKey\('bookings'\)\);\n"
    r"let cleans   = loadJSON\(lsKey\('cleans'\)\);\n"
    r"let notes    = loadJSON\(lsKey\('notes'\)\);\n",
    "\n",
    s,
    count=1,
)

# 4) reloadInMemoryData
old_reload = (
    "function reloadInMemoryData() {\n"
    "  if (typeof isPortfolioMode === 'function' && isPortfolioMode()) {\n"
    "    return;\n"
    "  }\n"
    "  console.log('[StayOps] reloadInMemoryData: refreshing in-memory arrays from localStorage');\n"
    "  bookings    = loadJSON(lsKey('bookings'));\n"
    "  cleans      = loadJSON(lsKey('cleans'));\n"
    "  notes       = loadJSON(lsKey('notes'));\n"
    "  expenses    = JSON.parse(localStorage.getItem(lsKey('expenses'))    || '[]');\n"
    "  maintenance = JSON.parse(localStorage.getItem(lsKey('maintenance')) || '[]');\n"
    "  inventory   = JSON.parse(localStorage.getItem(lsKey('inventory'))   || '[]');\n"
    "  // Keep clean records in sync with current booking identity data\n"
    "  _normalizeBookingCleanState();\n"
    "}"
)
new_reload = (
    "function reloadInMemoryData() {\n"
    "  if (typeof isPortfolioMode === 'function' && isPortfolioMode()) {\n"
    "    return;\n"
    "  }\n"
    "  console.log('[StayOps] reloadInMemoryData: refreshing in-memory arrays from localStorage');\n"
    "  reloadArraysFromLocalStorage();\n"
    "  // Keep clean records in sync with current booking identity data\n"
    "  _normalizeBookingCleanState();\n"
    "}"
)
if old_reload not in s:
    raise SystemExit("reloadInMemoryData block not found")
s = s.replace(old_reload, new_reload, 1)

# 5) Remove save()
old_save = (
    "function save() {\n"
    "  localStorage.setItem(lsKey('bookings'), JSON.stringify(bookings));\n"
    "  localStorage.setItem(lsKey('cleans'),   JSON.stringify(cleans));\n"
    "  localStorage.setItem(lsKey('notes'),    JSON.stringify(notes));\n"
    "  // AppData sheet sync removed — Supabase is now source of truth\n"
    "  // Sync bookings, cleans and notes to Supabase (non-blocking)\n"
    "  if (typeof saveBookingsToCloud === 'function') saveBookingsToCloud(bookings).catch(() => {});\n"
    "  if (typeof saveCleansToCloud === 'function') saveCleansToCloud(cleans).catch(() => {});\n"
    "  if (typeof saveNotesToCloud === 'function') saveNotesToCloud(notes).catch(() => {});\n"
    "}\n"
)
if old_save not in s:
    raise SystemExit("save() block not found")
s = s.replace(old_save, "", 1)

# 6) Remove PROPERTY DATA let expenses/maintenance/inventory (keep comment + PROPERTY_COLOURS)
old_prop = (
    "// ── PROPERTY DATA ─────────────────────────────────────────────────────────\n"
    "let expenses    = JSON.parse(localStorage.getItem(lsKey('expenses'))    || '[]');\n"
    "let maintenance = JSON.parse(localStorage.getItem(lsKey('maintenance')) || '[]');\n"
    "let inventory   = JSON.parse(localStorage.getItem(lsKey('inventory'))   || '[]');\n\n"
)
if old_prop not in s:
    raise SystemExit("PROPERTY DATA lets not found")
s = s.replace(old_prop, "// ── PROPERTY DATA ─────────────────────────────────────────────────────────\n\n", 1)

# 7) deleteBooking filters
s = s.replace(
    "  bookings=bookings.filter(b=>b.id!==id);\n"
    "  cleans=cleans.filter(c=>String(c.bookingId)!==String(id) && !(deletedBooking && c.guestName===deletedBooking.name));\n"
    "  notes=notes.filter(n=>String(n.bookingId)!==String(id) && !(deletedBooking && n.guestName===deletedBooking.name));",
    "  replaceArrayInPlace(bookings, bookings.filter(b=>b.id!==id));\n"
    "  replaceArrayInPlace(cleans, cleans.filter(c=>String(c.bookingId)!==String(id) && !(deletedBooking && c.guestName===deletedBooking.name)));\n"
    "  replaceArrayInPlace(notes, notes.filter(n=>String(n.bookingId)!==String(id) && !(deletedBooking && n.guestName===deletedBooking.name)));",
)

# 8) deleteExpense / maintenance / inventory filters
s = s.replace(
    "  expenses = expenses.filter(e => String(e.id) !== String(id));",
    "  replaceArrayInPlace(expenses, expenses.filter(e => String(e.id) !== String(id)));",
)
s = s.replace(
    "  maintenance = maintenance.filter(m => m.id !== id);",
    "  replaceArrayInPlace(maintenance, maintenance.filter(m => m.id !== id));",
)
s = s.replace(
    "  inventory = inventory.filter(i => i.id !== id);",
    "  replaceArrayInPlace(inventory, inventory.filter(i => i.id !== id));",
)
s = s.replace(
    "  inventory = inventory.filter(i => i.id !== editingInvId);",
    "  replaceArrayInPlace(inventory, inventory.filter(i => i.id !== editingInvId));",
)

# 9) loadPortfolioData — wrap .map assignments
s = s.replace(
    "    if (allBookings) {\n      bookings = allBookings.map(b => ({",
    "    if (allBookings) {\n      replaceArrayInPlace(bookings, allBookings.map(b => ({",
)
s = s.replace(
    "      }));\n    }\n\n    const { data: allCleans }",
    "      })));\n    }\n\n    const { data: allCleans }",
)

s = s.replace(
    "    if (allCleans) {\n      cleans = allCleans.map(c => ({",
    "    if (allCleans) {\n      replaceArrayInPlace(cleans, allCleans.map(c => ({",
)
s = s.replace(
    "      }));\n    }\n\n    const { data: allExpenses }",
    "      })));\n    }\n\n    const { data: allExpenses }",
)

s = s.replace(
    "    if (allExpenses) {\n      expenses = allExpenses.map(e => ({",
    "    if (allExpenses) {\n      replaceArrayInPlace(expenses, allExpenses.map(e => ({",
)
s = s.replace(
    "      }));\n    }\n\n    _normalizeBookingCleanState();",
    "      })));\n    }\n\n    _normalizeBookingCleanState();",
)

# 10) Poll cleans
s = s.replace(
    "            cleans = cloudCleans;  // keep in-memory in sync so renderAll() uses fresh data",
    "            replaceArrayInPlace(cleans, cloudCleans);  // keep in-memory in sync so renderAll() uses fresh data",
)

# 11) hydrateCleanerFromFunction
s = s.replace(
    "      cleans = data.cleans;",
    "      replaceArrayInPlace(cleans, data.cleans);",
)
s = s.replace(
    "      bookings = data.bookings;",
    "      replaceArrayInPlace(bookings, data.bookings);",
)
s = s.replace(
    "      inventory = data.inventory;",
    "      replaceArrayInPlace(inventory, data.inventory);",
)

OUT.write_text(s, encoding="utf-8")
print("Wrote", OUT, "bytes:", len(s.encode("utf-8")))
