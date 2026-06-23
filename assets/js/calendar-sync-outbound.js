/**
 * StayOps — outbound calendar-sync hooks (frontend).
 *
 * Wraps the global mutation functions exposed in main.js so that, after each
 * successful local write, we POST to /.netlify/functions/calendar-push. The
 * server handles every connected provider (Google in PR 1, Outlook in PR 2).
 *
 * Loaded after hydrateFromCloud so the wrapped functions exist.
 */

const PUSH_URL = '/.netlify/functions/calendar-push';
let queue = [];
let flushTimer = null;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flushQueue, 800);
}

async function getAuthToken() {
  try {
    if (window._sb && window._sb.auth) {
      const { data } = await window._sb.auth.getSession();
      return (data && data.session && data.session.access_token) || null;
    }
  } catch (_) { void 0; }
  return null;
}

async function flushQueue() {
  flushTimer = null;
  if (!queue.length) return;
  const batch = queue.splice(0, queue.length);
  const token = await getAuthToken();
  if (!token) return; // not signed in — drop silently

  // Connected check — skip the network round-trip if no calendar is connected.
  const cfg = window._appConfig || {};
  const anyConnected = !!(cfg.gcal_email || cfg.outlook_calendar_email);
  if (!anyConnected) return;

  for (const item of batch) {
    try {
      await fetch((globalThis.apiUrl || (u => u))(PUSH_URL), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(item),
      });
    } catch (e) {
      console.warn('[calendar-push] failed:', e && e.message);
    }
  }
}

function enqueue(table, id, op) {
  if (!table || id == null) return;
  queue.push({ table, id, op });
  scheduleFlush();
}

function wrapOnce() {
  if (window._calendarSyncOutboundWrapped) return;
  window._calendarSyncOutboundWrapped = true;

  const wrap = (name, table, op) => {
    const orig = globalThis[name];
    if (typeof orig !== 'function') return;
    globalThis[name] = async function (arg) {
      const result = await orig.apply(this, arguments);
      try {
        const id = arg && (arg.id != null ? arg.id : (arg.local_id != null ? arg.local_id : arg));
        if (id != null) enqueue(table, id, op);
      } catch (_) { void 0; }
      return result;
    };
  };

  wrap('saveBookingToCloud',     'bookings',    'upsert');
  wrap('deleteBookingFromCloud', 'bookings',    'delete');
  wrap('saveCleanToCloud',       'cleans',      'upsert');
  wrap('deleteCleanFromCloud',   'cleans',      'delete');

  const origSaveBookings = globalThis.saveBookingsToCloud;
  if (typeof origSaveBookings === 'function') {
    globalThis.saveBookingsToCloud = async function (list) {
      const result = await origSaveBookings.apply(this, arguments);
      try {
        if (Array.isArray(list)) {
          list.forEach(b => {
            const id = b && (b.id != null ? b.id : (b.local_id != null ? b.local_id : null));
            if (id != null) enqueue('bookings', id, 'upsert');
          });
        }
      } catch (_) { void 0; }
      return result;
    };
  }
  // deleteCleanFromCloud is wrapped above so removing a clean (e.g. when its
  // booking is cancelled) enqueues a 'cleans' delete push — otherwise the
  // clean's calendar event would be orphaned. A 'done' flag change still goes
  // through saveCleanToCloud → upsert.

  // saveMaintenanceItemToCloud is not exposed globally; saveMaintenanceToCloud takes a list.
  const origM = globalThis.saveMaintenanceToCloud;
  if (typeof origM === 'function') {
    globalThis.saveMaintenanceToCloud = async function (list) {
      const result = await origM.apply(this, arguments);
      try {
        if (Array.isArray(list)) list.forEach(m => m && m.id != null && enqueue('maintenance', m.id, 'upsert'));
      } catch (_) { void 0; }
      return result;
    };
  }
  const origMD = globalThis.deleteMaintenanceFromCloud;
  if (typeof origMD === 'function') {
    globalThis.deleteMaintenanceFromCloud = async function (item) {
      const result = await origMD.apply(this, arguments);
      try {
        if (item && item.id != null) enqueue('maintenance', item.id, 'delete');
      } catch (_) { void 0; }
      return result;
    };
  }
}

export function installCalendarSyncOutbound() {
  wrapOnce();
}

export async function triggerCalendarReconcileNow() {
  const user = window._supabaseUser;
  if (!user) return null;
  try {
    // calendar-sync-reconcile now requires a JWT for the per-uid path.
    const token = await getAuthToken();
    if (!token) return null;
    const res = await fetch((globalThis.apiUrl || (u => u))('/.netlify/functions/calendar-sync-reconcile'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ uid: user.id }),
    });
    return res.ok ? res.json() : null;
  } catch (_) { return null; }
}
