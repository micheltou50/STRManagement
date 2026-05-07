/**
 * "Since you last opened StayOps" — host-only rundown.
 *
 * Compares the current booking/clean state against a lightweight snapshot
 * saved on the previous app open. If important changes are detected, shows
 * a small dismissable modal. Fails silently on any error.
 *
 * Storage: localStorage key 'gh-host-last-snapshot-<activePropertyId>'.
 * Per-property: the active property id is embedded into the key name, so
 * each property keeps its own snapshot without relying on the
 * Storage.prototype scoping patch in config.js.
 */

import { bookings, cleans } from './state.js';
import { getActivePropertyId } from './config.js';

const SNAPSHOT_KEY_PREFIX = 'gh-host-last-snapshot';
const SNAPSHOT_VERSION = 1;

function _key() {
  const pid = (typeof getActivePropertyId === 'function' && getActivePropertyId()) || 'default';
  return SNAPSHOT_KEY_PREFIX + '-' + pid;
}

function _bookingId(b) {
  if (!b) return null;
  const id = b._cloudId || b.id || b.local_id || null;
  return id == null ? null : String(id);
}

function _findCleanForBooking(bid) {
  if (!Array.isArray(cleans) || !bid) return null;
  return cleans.find(c => {
    if (!c) return false;
    const cb = c.booking_id || c.bookingId || c.bookingLocalId;
    return cb != null && String(cb) === bid;
  }) || null;
}

function _cleanerStatus(clean) {
  if (!clean) return null;
  if (clean.cleanerConfirmed) return 'confirmed';
  if (clean.cleaner_id) return 'awaiting';
  return 'unassigned';
}

/** Build a lightweight per-property snapshot of current bookings. */
export function buildBookingSnapshot(list) {
  const out = { v: SNAPSHOT_VERSION, ts: new Date().toISOString(), b: {} };
  if (!Array.isArray(list)) return out;
  for (const b of list) {
    const id = _bookingId(b);
    if (!id) continue;
    const clean = _findCleanForBooking(id);
    out.b[id] = {
      n: b.name || '',
      ci: b.checkin || '',
      co: b.checkout || '',
      s: b.status || 'confirmed',
      cid: (clean && clean.cleaner_id) ? String(clean.cleaner_id) : null,
      cs: _cleanerStatus(clean),
    };
  }
  return out;
}

export function getHostLastSeenSnapshot() {
  try {
    const raw = localStorage.getItem(_key());
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== SNAPSHOT_VERSION || !parsed.b) return null;
    return parsed;
  } catch (_e) {
    return null;
  }
}

export function markHostSnapshotSeen(snapshot) {
  try {
    if (!snapshot || !snapshot.b) return;
    localStorage.setItem(_key(), JSON.stringify(snapshot));
  } catch (_e) { /* storage quota or disabled — fail silently */ }
}

/** Compare two snapshots; returns null if unchanged or on error. */
export function diffBookingSnapshots(prev, curr) {
  if (!prev || !curr || !prev.b || !curr.b) return null;
  const newBookings = [];
  const cancellations = [];
  const statusChanges = [];
  const cleanerUpdates = [];

  const prevIds = new Set(Object.keys(prev.b));
  const currIds = new Set(Object.keys(curr.b));

  for (const id of currIds) {
    const c = curr.b[id];
    const p = prev.b[id];
    if (!p) {
      // Only count confirmed (active) new bookings as "new"; ignore rows that
      // arrived already-cancelled to avoid noise.
      if (c.s !== 'cancelled') newBookings.push({ id, name: c.n, ci: c.ci, co: c.co });
      continue;
    }
    if (p.s !== 'cancelled' && c.s === 'cancelled') {
      cancellations.push({ id, name: c.n, ci: c.ci, co: c.co });
      continue; // don't double-count as a status change
    }
    if (p.s !== c.s) {
      statusChanges.push({ id, name: c.n, from: p.s, to: c.s });
    }
    if (p.cs !== c.cs || (p.cid || null) !== (c.cid || null)) {
      // Only surface cleaner updates for active bookings.
      if (c.s !== 'cancelled') {
        cleanerUpdates.push({ id, name: c.n, from: p.cs, to: c.cs });
      }
    }
  }

  // Bookings that disappeared entirely (rare — soft-delete keeps them).
  // Treat as cancellations so the host still sees something useful.
  for (const id of prevIds) {
    if (!currIds.has(id)) {
      const p = prev.b[id];
      if (p && p.s !== 'cancelled') {
        cancellations.push({ id, name: p.n, ci: p.ci, co: p.co });
      }
    }
  }

  const total = newBookings.length + cancellations.length + statusChanges.length + cleanerUpdates.length;
  if (total === 0) return null;
  return { newBookings, cancellations, statusChanges, cleanerUpdates };
}

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _line(label) { return '<div style="font-size:13px;color:#3a3a3a;padding:4px 0">' + _esc(label) + '</div>'; }

function _section(title, items, render) {
  if (!items || !items.length) return '';
  return (
    '<div style="margin-top:14px">' +
      '<div style="font-weight:700;font-size:13px;color:#2f5d4e;margin-bottom:4px">' + _esc(title) + '</div>' +
      items.slice(0, 6).map(render).join('') +
      (items.length > 6 ? _line('… and ' + (items.length - 6) + ' more') : '') +
    '</div>'
  );
}

export function showSinceLastOpenedRundown(changes, onDismiss) {
  try {
    if (!changes) { if (typeof onDismiss === 'function') onDismiss(); return; }
    // Avoid duplicate modal if one is already on screen.
    if (document.getElementById('since-last-opened-modal')) return;

    const nb = changes.newBookings || [];
    const cx = changes.cancellations || [];
    const sc = changes.statusChanges || [];
    const cu = changes.cleanerUpdates || [];

    const overlay = document.createElement('div');
    overlay.id = 'since-last-opened-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.45);' +
      'display:flex;align-items:center;justify-content:center;padding:16px';

    const card = document.createElement('div');
    card.style.cssText =
      'background:#fff;border-radius:16px;max-width:420px;width:100%;' +
      'box-shadow:0 12px 40px rgba(0,0,0,0.25);padding:20px 20px 16px;' +
      'max-height:80vh;overflow-y:auto;font-family:inherit';

    const summaryBits = [];
    if (nb.length) summaryBits.push(nb.length + (nb.length === 1 ? ' new booking' : ' new bookings'));
    if (cx.length) summaryBits.push(cx.length + (cx.length === 1 ? ' booking was cancelled' : ' bookings were cancelled'));
    if (cu.length) summaryBits.push(cu.length + (cu.length === 1 ? ' cleaner update' : ' cleaner updates'));
    if (sc.length) summaryBits.push(sc.length + (sc.length === 1 ? ' status change' : ' status changes'));

    card.innerHTML =
      '<div style="font-size:18px;font-weight:800;color:#2f5d4e">Since you last opened StayOps</div>' +
      '<div style="font-size:13px;color:#666;margin-top:4px">' + _esc(summaryBits.join(' · ')) + '</div>' +
      _section('New bookings', nb, x =>
        _line('• ' + (x.name || 'Guest') + (x.ci ? ' — ' + x.ci + (x.co ? ' → ' + x.co : '') : ''))
      ) +
      _section('Cancellations', cx, x =>
        _line('• ' + (x.name || 'Guest') + (x.ci ? ' — ' + x.ci + (x.co ? ' → ' + x.co : '') : ''))
      ) +
      _section('Cleaner updates', cu, x =>
        _line('• ' + (x.name || 'Guest') + ': ' + (x.from || 'unassigned') + ' → ' + (x.to || 'unassigned'))
      ) +
      _section('Other changes', sc, x =>
        _line('• ' + (x.name || 'Guest') + ': ' + (x.from || '—') + ' → ' + (x.to || '—'))
      ) +
      '<div style="margin-top:18px;display:flex;justify-content:flex-end">' +
        '<button id="since-last-opened-dismiss" style="background:#2f5d4e;color:#fff;border:0;border-radius:10px;padding:10px 18px;font-weight:700;font-size:14px;cursor:pointer">Got it</button>' +
      '</div>';

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const close = () => {
      try { overlay.remove(); } catch (_e) { /* already detached */ }
      if (typeof onDismiss === 'function') {
        try { onDismiss(); } catch (_e) { /* dismiss callback is best-effort */ }
      }
    };
    const btn = card.querySelector('#since-last-opened-dismiss');
    if (btn) btn.addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  } catch (_e) {
    // Never let the rundown break the app.
    if (typeof onDismiss === 'function') {
      try { onDismiss(); } catch (_e2) { /* swallow */ }
    }
  }
}

/**
 * Entry point — call after bookings are loaded/synced and renderAll() has run.
 * Runs at most once per app open/session. Host-only (caller is responsible
 * for ensuring this is not invoked in cleaner mode).
 */
export function maybeShowSinceLastOpenedRundown(currentBookings) {
  try {
    if (window.__sinceLastOpenedShown) return;
    window.__sinceLastOpenedShown = true;

    const list = Array.isArray(currentBookings) ? currentBookings : bookings;
    if (!Array.isArray(list)) return; // fail silently

    const current = buildBookingSnapshot(list);
    if (!current || !current.b) return;

    const previous = getHostLastSeenSnapshot();
    if (!previous) {
      // First run on this device for this property — save silently, show nothing.
      markHostSnapshotSeen(current);
      return;
    }

    const changes = diffBookingSnapshots(previous, current);
    if (!changes) {
      // No changes — refresh the snapshot timestamp.
      markHostSnapshotSeen(current);
      return;
    }

    showSinceLastOpenedRundown(changes, () => markHostSnapshotSeen(current));
  } catch (_e) {
    // Never break the app on a rundown failure.
  }
}
